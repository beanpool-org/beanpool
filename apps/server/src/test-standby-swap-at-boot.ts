/**
 * Test Suite: the swap at boot, and a standby or a promoted server killed in it or started with a database moved away
 * (steps 17-25 of P2 of scratch/global-node/DESIGN-paged-copies-fable.md; steps 1-16, the copies themselves, are
 * test-standby-paged-copies.ts, and both build M, its community and S the same way, standby-pair-test-harness.ts).
 *
 * A main server M and a standby S, each its own process with its own data dir (takeover-test-harness.ts), S reaching M
 * through a proxy in this process and pulling through its real puller. M's page bounds are scaled to 64 KB and 200 rows,
 * so M's community takes many pages. A standby that makes a whole copy ready restarts to swap it in, and the harness
 * starts it again as Docker would. S takes its first copy before step 17. Nothing leaves this machine.
 *
 * 17. A whole copy swapped in, the start's puller reading its marker, then S restarted before any copy landed: the database
 *     the swap replaced goes at the first delta after. (Before: only the start that read the marker deleted it, so it
 *     stayed for good, holding rows members deleted since.)
 * 18. S killed between the swap's two renames (state.db already state.previous.db, the staging database not yet state.db):
 *     the next start finishes the swap, S's copy row for row as it was, the old database kept; the first delta deletes it.
 * 19. A take-over whose audit finds trouble (a balance planted on the standby): the promoted server keeps the database its
 *     last swap replaced, saying the date it goes, 30 days from the audit; a start past that date deletes it. (Before: kept
 *     for good, a warning nobody on a stranger's install acts on.)
 * 20. S killed in the middle of deleting the database its last swap replaced, right before its `-wal` (where the review
 *     killed it): after a restart, the next delta leaves no file of it. And a `-wal` and `-shm` left on their own, as an older
 *     build's delete stopped part way left them, go at a main server's start. (Before: the WAL stayed for good, holding the
 *     rows it held.)
 * 21. S killed at boot between the swap's two renames (the review's kill point), its staged copy then torn, and started as
 *     a main server by hand: the staging is discarded and state.previous.db, S's own copy, is state.db again; the server runs
 *     on every member and message it had. (Before: it started on a new, empty database and deleted that copy as "the
 *     database the last swap replaced".)
 * 22. A main server a take-over promoted (its audit found trouble, so state.previous.db is kept), its state.db moved away by
 *     hand, then emptied: each start refuses, saying what is missing and what to do, and nothing is lost; the state.db put
 *     back, it runs on it. (Before: it ran as the main server on the older database, unaudited, and said nothing.)
 * 23. A standby whose state.db is moved away by hand: it puts state.previous.db back and the next delta brings it level
 *     with M.
 * 24. Step 21's torn staging on a server started as a main server, killed again right after the discard deleted the
 *     staging: the next start runs on its own copy. (Before: the discard deleted the staging first and put the copy back
 *     after, so that kill left no staging and no state.db, which a main server now refuses to start on.)
 * 25. A standby whose state.db is gone, and whose put-back of state.previous.db fails (every rename of its -wal refused):
 *     it stops before opening any database, changing nothing; the next start puts it back, and a delta brings it level.
 *     (Before: it started on a new, empty database beside its copy.)
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-swap-at-boot.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, type NodeProc } from './takeover-test-harness.js';
import { runPagedCopyChild } from './paged-copies-test-harness.js';
import {
    PW_STANDBY, assert, require_, step, sleep, until, snapDiff, first,
    newPair, startMain, startStandby, pairHelpers, closeLeftCopy, closePair, auditCommand,
} from './standby-pair-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
    const pair = newPair(SCRIPT);
    const { dir, nodes, envS, ann, bo } = pair;

    try {
        // ── M, and S set up against it through the proxy, its first copy taken ──
        const { main } = await startMain(pair);
        let standby!: NodeProc;
        let standbyDir = '';
        const { snapS, exactNow, pullAndSwap, wholeCopy } = pairHelpers(() => ({ main, standby }));
        /** M's recovery code, made at the first take-over (step 19; a second would replace it). */
        let recoveryCode: string | null = null;
        /** Kill S and start it again on its data dir, as a crash and Docker would. */
        const restartS = async (opts: { maxFileBytes?: number } = {}) => {
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, standbyDir, envS, opts);
            nodes.push(standby);
        };
        /** A new standby on data dir `name`, set up from nothing, its first copy taken. */
        const newStandby = async (name: string, opts: { maxFileBytes?: number } = {}) => {
            standby = await startStandby(pair, name, main, opts);
            standbyDir = dir(name);
            await closeLeftCopy(pair, main); // a copy the standby before it left open on M closes first
            const p = await pullAndSwap(false);
            require_(p.ok === true && p.staged === true && (await exactNow()).length === 0, `a new standby's first copy lands (${JSON.stringify(p)})`);
            return name;
        };
        await newStandby('standby');

        await step('17. S restarted between a swap and the first copy on it: the database the swap replaced goes at the first copy after', async () => {
            const w17 = await wholeCopy();
            const st17 = await standby.send('staging');
            require_(w17.ok === true && w17.staged === true && st17.previous, `a whole copy swapped in, the old database kept beside it (${JSON.stringify({ w17, st17 })})`);
            await standby.send('boot-puller'); // the start's puller, as index.ts starts it: it reads the swap's marker, and deletes it
            await restartS();
            const marker = await standby.send('rows', { sql: `SELECT key FROM node_config WHERE key = 'standby_swapped_copy'` });
            const st17b = await standby.send('staging');
            require_(marker.length === 0 && st17b.previous, `S started again before any copy landed: the swap's marker read, the old database still there (${JSON.stringify(st17b)})`);
            const deltas: { ok: boolean; mode: string }[] = [];
            const left: boolean[] = [];
            for (let i = 0; i < 2; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit 17.${i}`, ann.pk] });
                deltas.push(await standby.send('pull', {}));
                left.push((await standby.send('staging')).previous);
            }
            assert(deltas.every((d) => d.ok && d.mode === 'delta') && left.every((p) => !p) && (await exactNow()).length === 0,
                `the first delta after the restart lands and deletes the database the swap replaced (${JSON.stringify({ deltas: deltas.map((d) => d.mode), previousAfterEach: left })}; `
                + 'before: only the start that read the marker deleted it, so it stayed for good)');
        });

        await step('18. S killed between the swap\'s two renames: the next start finishes the swap, and the first delta deletes the old database', async () => {
            await standby.send('pull', {}); // S is M's
            await standby.send('checkpoint');
            const before = await snapS();
            await standby.kill('SIGKILL');
            // The swap killed between its renames (db/swap-at-boot.ts): state.db (and its WAL) is state.previous.db, and a
            // staging database made ready, S's own copy here, is not yet state.db.
            const f = (n: string) => path.join(standbyDir, n);
            fs.rmSync(f('staging'), { recursive: true, force: true });
            fs.mkdirSync(f('staging'));
            for (const s of ['', '-wal']) if (fs.existsSync(f(`state.db${s}`))) fs.copyFileSync(f(`state.db${s}`), f(`staging/state.db${s}`));
            fs.writeFileSync(f('staging/READY'), JSON.stringify({ pages: 1, generatedAt: new Date().toISOString() }));
            for (const s of ['', '-wal', '-shm']) {
                fs.rmSync(f(`state.previous.db${s}`), { force: true });
                if (fs.existsSync(f(`state.db${s}`))) fs.renameSync(f(`state.db${s}`), f(`state.previous.db${s}`));
            }
            require_(!fs.existsSync(f('state.db')) && fs.existsSync(f('state.previous.db')) && fs.existsSync(f('staging/state.db')), 'S stopped between the two renames');
            standby = await spawnNode(SCRIPT, standbyDir, envS);
            nodes.push(standby);
            const st18 = await standby.send('staging');
            const after = await snapS();
            assert(!st18.staging && st18.previous && snapDiff(before, after).length === 0 && (await exactNow()).length === 0,
                `the next start finishes the swap: no staging, S's copy row for row as it was, the old database kept (${JSON.stringify(st18)}; differences ${first(snapDiff(before, after))})`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 18', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            const d18 = await standby.send('pull', {});
            const st18b = await standby.send('staging');
            assert(d18.ok === true && d18.mode === 'delta' && !st18b.previous && (await exactNow()).length === 0,
                `the first delta lands on it and deletes the old database (${JSON.stringify({ d18, previous: st18b.previous })}; before: kept for good, the copy carrying no marker of the swap)`);
        });

        await step('19. a take-over whose audit finds trouble: the old database kept 30 days from the audit, then deleted', async () => {
            const name = await newStandby('standby4');
            const st19 = await standby.send('staging');
            require_(st19.previous, `S4's first copy swapped in, the old database beside it (${JSON.stringify(st19)})`);
            recoveryCode ??= (await main.send('make-envelope')).code;
            const code19 = recoveryCode;
            require_(await standby.send('envelope') === 'stored', 'S4 holds M\'s take-over envelope');
            // A balance M never had: the take-over's audit finds the ledger isn't the main server's.
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] });
            await standby.send('takeover-restart-off');
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: code19 }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            require_(confirmT.status === 200, `the take-over is confirmed (${confirmT.status} ${JSON.stringify(confirmT.body).slice(0, 160)})`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, dir(name), envS);
            nodes.push(standby);
            const audit = await standby.send('audit');
            const kept = await standby.send('staging');
            const out = standby.output();
            const goes = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
            assert(await standby.send('role') === 'primary' && audit?.ok === false && kept.previous
                && new RegExp(`state\\.previous\\.db, the database this server's last swap as a standby replaced, is kept until ${goes}`).test(out),
                `the audit found trouble: the promoted server keeps the old database and says it goes on ${goes} (${JSON.stringify({ audit, previous: kept.previous })})`);
            // 31 days on: the journal's audit stamped that long ago, and the next start.
            await standby.kill('SIGKILL');
            const journalFile = path.join(dir(name), 'takeover-journal.json');
            const journal = JSON.parse(fs.readFileSync(journalFile, 'utf-8'));
            journal.steps.audit.at = new Date(Date.now() - 31 * 86_400_000).toISOString();
            fs.writeFileSync(journalFile, JSON.stringify(journal));
            standby = await spawnNode(SCRIPT, dir(name), envS);
            nodes.push(standby);
            const gone = await standby.send('staging');
            assert(await standby.send('role') === 'primary' && !gone.previous && /kept 30 days after the take-over's audit found trouble/.test(standby.output()),
                `a start more than 30 days after the audit deletes it (${JSON.stringify({ previous: gone.previous })}; before: kept for good)`);
        });

        await step('20. a delete of the old database stopped part way: no WAL of it stays; one left on its own goes', async () => {
            const name = await newStandby('standby5');
            const d = dir(name);
            const prev = (s: string) => fs.existsSync(path.join(d, `state.previous.db${s}`));
            const prevFiles = () => ['', '-wal', '-shm'].filter(prev);
            const secret = `OLD-WORDS-${crypto.randomBytes(6).toString('hex')}`;
            const bio = (text: string) => main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [text, ann.pk] });
            await bio(secret);
            await standby.send('pull', {}); // S holds Ann's words
            const w20 = await wholeCopy(); // and the database holding them becomes state.previous.db
            const inPrevious = () => ['', '-wal'].filter((s) => prev(s) && fs.readFileSync(path.join(d, `state.previous.db${s}`)).includes(secret));
            require_(w20.ok === true && w20.staged === true && prev('') && prev('-wal') && inPrevious().length > 0,
                `the database the swap replaced, with its WAL, holds Ann's words (${JSON.stringify({ w20, files: prevFiles(), inPrevious: inPrevious() })})`);
            // Ann changes her words on M; the delta that brings it deletes the old database, and S is killed right before the WAL.
            await bio('nothing here now');
            await standby.send('kill-before-rm', { suffix: 'state.previous.db-wal' });
            const dying = standby;
            const killed = await Promise.race([dying.send('pull', {}).then(() => false), dying.exited.then(() => true)]);
            require_(killed, 'S is killed in the middle of the delete');
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const atStart = prevFiles();
            for (let i = 0; i < 2; i++) {
                await main.send('sql', { sql: `UPDATE members SET bio = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [`edit 20.${i}`, bo.pk] });
                await standby.send('pull', {});
            }
            assert(prevFiles().length === 0,
                `after the restart, the next delta leaves no file of the old database (${JSON.stringify({ afterKill: atStart, now: prevFiles(), wordsIn: inPrevious() })}; before: its WAL stayed for good, Ann's old words in it)`);

            // A -wal and -shm on their own, as an older build's delete left them (the database gone, the kill before the WAL).
            const w20b = await wholeCopy();
            require_(w20b.ok === true && prev('') && prev('-wal'), `another whole copy swapped in, the old database and its WAL beside it (${JSON.stringify(prevFiles())})`);
            await standby.kill('SIGKILL');
            fs.rmSync(path.join(d, 'state.previous.db'));
            standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' }); // its main server gone: promoted by hand
            nodes.push(standby);
            assert(standby.ready.role === 'primary' && prevFiles().length === 0,
                `a main server's start deletes a -wal and -shm left on their own (${JSON.stringify({ role: standby.ready.role, left: prevFiles() })}; before: nothing looked for them without the database)`);
        });

        await step('21. a swap stopped between its renames, its staged copy torn, then a start as a main server: it runs on its own copy', async () => {
            const name = await newStandby('standby6');
            const d = dir(name);
            const w21 = await wholeCopy(); // S's copy is a whole copy of M
            const count = async () => ({
                members: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM members' }))[0].n as number,
                messages: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM messages' }))[0].n as number,
            });
            const c0 = await count();
            require_(w21.ok === true && w21.staged === true && c0.messages > 0, `S holds a whole copy of M (${JSON.stringify({ w21, c0 })})`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 21', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            // The next start SIGKILLs itself right before it renames the staged copy into place: after the first rename.
            const arm = `${d}.kill-at`;
            fs.writeFileSync(arm, JSON.stringify({ op: 'renameSync', suffix: '/staging/state.db' }));
            const p21 = await standby.send('pull', { whole: true });
            const f = (n: string) => fs.existsSync(path.join(d, n));
            const stopped = await until('S killed between the swap\'s renames', () => !fs.existsSync(arm) && f('staging/state.db') && !f('state.db') && f('state.previous.db'), 60_000);
            await sleep(1000);
            require_(p21.ok === true && p21.staged === true && stopped, `S is killed between the swap's two renames (${JSON.stringify(p21)})`);
            // The staged copy torn: its second half never reached the disk.
            const staged = path.join(d, 'staging/state.db');
            fs.truncateSync(staged, Math.floor(fs.statSync(staged).size / 2));
            for (const x of ['-wal', '-shm']) fs.rmSync(staged + x, { force: true });
            standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' }); // its main server gone: promoted by hand
            nodes.push(standby);
            const c1 = await count();
            const out = standby.output();
            assert(standby.ready.role === 'primary' && c1.members === c0.members && c1.messages === c0.messages && !f('state.previous.db') && !f('staging')
                && /is state\.db again/.test(out),
                `the torn copy is discarded and S's own copy is state.db again: the main server runs on its ${c1.members} members and ${c1.messages} messages `
                + `(${JSON.stringify({ before: c0, after: c1, previous: f('state.previous.db') })}; before: a new, empty database, and S's copy deleted)`);
        });

        await step('22. a main server a take-over promoted, its state.db moved away or emptied: it refuses to start, and loses nothing', async () => {
            const name = await newStandby('standby8');
            const d = dir(name);
            const f = (n: string) => path.join(d, n);
            const w22 = await wholeCopy();
            require_(w22.ok === true && fs.existsSync(f('state.previous.db')), `S8 holds a whole copy, the old database beside it (${JSON.stringify(w22)})`);
            const code22 = recoveryCode ?? (await main.send('make-envelope')).code;
            require_(await standby.send('envelope') === 'stored', 'S8 holds M\'s take-over envelope');
            await standby.send('sql', { sql: 'UPDATE accounts SET balance = balance + 7 WHERE public_key = ?', args: [ann.pk] }); // the audit finds trouble
            await standby.send('takeover-restart-off');
            const pw = { 'X-Admin-Password': PW_STANDBY };
            const openT = await post(standby.base, '/api/local/admin/takeover/open', { code: code22 }, pw);
            const confirmT = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openT.body?.preview?.sessionId, confirm: true }, pw);
            require_(confirmT.status === 200, `the take-over is confirmed (${confirmT.status})`);
            await standby.kill('SIGKILL');
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const audit = await standby.send('audit');
            require_(standby.ready.role === 'primary' && audit?.ok === false && fs.existsSync(f('state.previous.db')), `promoted, the audit found trouble, the old database kept (${JSON.stringify(audit)})`);
            // Written on the promoted server: in its state.db only.
            await standby.send('sql', { sql: `UPDATE members SET bio = 'AFTER-22' WHERE public_key = ?`, args: [ann.pk] });
            const look = async () => ({
                bio: (await standby.send('rows', { sql: 'SELECT bio FROM members WHERE public_key = ?', args: [ann.pk] }))[0]?.bio ?? null,
                balance: (await standby.send('rows', { sql: 'SELECT balance FROM accounts WHERE public_key = ?', args: [ann.pk] }))[0]?.balance ?? null,
                messages: (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM messages' }))[0].n as number,
            });
            const before = await look();
            await standby.kill('SIGKILL');
            // An operator moves state.db away (to look at it, or to "start fresh").
            const aside = f('moved-away');
            fs.mkdirSync(aside);
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(f(`state.db${x}`))) fs.renameSync(f(`state.db${x}`), path.join(aside, `state.db${x}`));
            const startRefused = async (): Promise<string | null> => {
                try {
                    const n = await spawnNode(SCRIPT, d, envS);
                    nodes.push(n);
                    standby = n;
                    return null;
                } catch (e: any) { return String(e?.output ?? e?.message ?? e); }
            };
            const missing = await startRefused();
            const kept = () => fs.existsSync(f('state.previous.db')) && fs.existsSync(path.join(aside, 'state.db'));
            assert(missing !== null && /FATAL: .*state\.db is missing, and .*state\.previous\.db is there/.test(missing) && /rename state\.previous\.db/.test(missing)
                && kept() && !fs.existsSync(f('state.db')),
                `with state.db moved away, the main server refuses to start, says what is missing and what to do, and changes no file `
                + `(${missing === null ? 'it started' : JSON.stringify(missing.split('\n').find((l) => /FATAL/.test(l)) ?? '').slice(0, 300)}; before: it ran as the main server on the older database, unaudited)`);
            fs.writeFileSync(f('state.db'), ''); // emptied
            const empty = await startRefused();
            assert(empty !== null && /FATAL: .*state\.db is empty, and .*state\.previous\.db is there/.test(empty) && kept(),
                `with state.db emptied, it refuses too (${empty === null ? 'it started' : 'refused'}; before: it served an empty community, and the next start deleted the older database)`);
            fs.rmSync(f('state.db'));
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(path.join(aside, `state.db${x}`))) fs.renameSync(path.join(aside, `state.db${x}`), f(`state.db${x}`));
            require_(await startRefused() === null, 'with state.db put back, it starts');
            const after = await look();
            assert(standby.ready.role === 'primary' && JSON.stringify(after) === JSON.stringify(before),
                `it runs on the database it had, as it was (${JSON.stringify({ before, after })})`);
        });

        await step('23. a standby whose state.db is moved away: it puts state.previous.db back, and the next delta brings it level', async () => {
            const name = await newStandby('standby9');
            const d = dir(name);
            const f = (n: string) => path.join(d, n);
            const w23 = await wholeCopy();
            require_(w23.ok === true && fs.existsSync(f('state.previous.db')), `S9 holds a whole copy, the old database beside it (${JSON.stringify(w23)})`);
            await standby.kill('SIGKILL');
            const aside = f('moved-away');
            fs.mkdirSync(aside);
            for (const x of ['', '-wal', '-shm']) if (fs.existsSync(f(`state.db${x}`))) fs.renameSync(f(`state.db${x}`), path.join(aside, `state.db${x}`));
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 23', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            standby = await spawnNode(SCRIPT, d, envS);
            nodes.push(standby);
            const back = /state\.previous\.db was there: it is this server's copy, and is state\.db again/.test(standby.output());
            const d23 = await standby.send('pull', {});
            const diff23 = await exactNow();
            assert(back && !fs.existsSync(f('state.previous.db')) && d23.ok === true && diff23.length === 0,
                `S9 starts on its previous database, put back, and the next pull brings it level with M (${JSON.stringify({ back, pull: d23 })}; differences ${first(diff23)})`);
        });

        await step('24. a start killed inside the discard of a torn staging, right after it deleted the staging: the next runs on its own copy', async () => {
            const name = await newStandby('standby10');
            const d = dir(name);
            const f = (n: string) => fs.existsSync(path.join(d, n));
            const w24 = await wholeCopy();
            const count = async () => (await standby.send('rows', { sql: 'SELECT COUNT(*) AS n FROM messages' }))[0].n as number;
            const c0 = await count();
            require_(w24.ok === true && c0 > 0, `S10 holds a whole copy of M (${JSON.stringify(w24)})`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 24', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            const arm = `${d}.kill-at`;
            fs.writeFileSync(arm, JSON.stringify({ op: 'renameSync', suffix: '/staging/state.db' }));
            const p24 = await standby.send('pull', { whole: true });
            const stopped = await until('S10 killed between the swap\'s renames', () => !fs.existsSync(arm) && f('staging/state.db') && !f('state.db') && f('state.previous.db'), 60_000);
            await sleep(1000);
            require_(p24.ok === true && p24.staged === true && stopped, 'S10 is killed between the swap\'s two renames');
            const staged = path.join(d, 'staging/state.db');
            fs.truncateSync(staged, Math.floor(fs.statSync(staged).size / 2));
            for (const x of ['-wal', '-shm']) fs.rmSync(staged + x, { force: true });
            // The next start, as a main server, is killed right after the discard deletes the staging.
            fs.writeFileSync(arm, JSON.stringify({ op: 'rmSync', suffix: '/staging', when: 'after' }));
            let died = false;
            try { nodes.push(standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' })); } catch { died = true; }
            require_(died && !fs.existsSync(arm) && !f('staging'), `that start is killed with the staging gone (${JSON.stringify({ died, staging: f('staging'), db: f('state.db'), previous: f('state.previous.db') })})`);
            let runs = true;
            try { nodes.push(standby = await spawnNode(SCRIPT, d, { ...envS, NODE_ROLE: 'primary' })); } catch { runs = false; }
            const c1 = runs ? await count() : null;
            assert(runs && c1 === c0 && !f('state.previous.db'),
                `the next start runs as the main server on its own copy, all ${c1} messages (${JSON.stringify({ runs, before: c0, after: c1, previous: f('state.previous.db') })}; before: no staging and no state.db, and it refused to start)`);
        });

        await step('25. a put-back that fails: the server stops before opening any database, and the next start puts it back', async () => {
            const name = await newStandby('standby11');
            const d = dir(name);
            const f = (n: string) => fs.existsSync(path.join(d, n));
            const w25 = await wholeCopy();
            require_(w25.ok === true && f('state.previous.db') && f('state.previous.db-wal'), `S11 holds a whole copy, the old database and its WAL beside it (${JSON.stringify(w25)})`);
            await standby.kill('SIGKILL');
            const aside = path.join(d, 'moved-away');
            fs.mkdirSync(aside);
            for (const x of ['', '-wal', '-shm']) if (f(`state.db${x}`)) fs.renameSync(path.join(d, `state.db${x}`), path.join(aside, `state.db${x}`));
            // Every rename of the previous database's WAL refused at the next start: the put-back fails.
            const arm = `${d}.kill-at`;
            fs.writeFileSync(arm, JSON.stringify({ op: 'renameSync', suffix: 'state.previous.db-wal', action: 'throw' }));
            let out: string | null = null;
            try { nodes.push(standby = await spawnNode(SCRIPT, d, envS)); } catch (e: any) { out = String(e?.output ?? e); }
            assert(out !== null && /could not be put back/.test(out) && /FATAL: .*state\.db is missing, and .*state\.previous\.db, this server's copy, could not be put back/.test(out)
                && !f('state.db') && f('state.previous.db') && f('state.previous.db-wal'),
                `the put-back fails and the standby stops before opening any database, changing nothing (${out === null ? 'it started, on a new, empty database' : 'stopped'}; before: it ran on a new, empty database)`);
            await main.send('sql', { sql: `UPDATE members SET bio = 'edit 25', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`, args: [ann.pk] });
            let runs = true;
            try { nodes.push(standby = await spawnNode(SCRIPT, d, envS)); } catch { runs = false; }
            const d25 = runs ? await standby.send('pull', {}) : null;
            const diff25 = runs ? await exactNow() : ['not running'];
            assert(runs && !f('state.previous.db') && d25?.ok === true && diff25.length === 0,
                `the next start puts it back, and the next pull brings it level with M (${JSON.stringify({ runs, pull: d25 })}; differences ${first(diff25)})`);
        });

        const blocked = [...(await main.send('fetches')).blocked, ...(await standby.send('fetches')).blocked];
        assert(blocked.length === 0, `nothing tried to leave this machine (${JSON.stringify(blocked)})`);
    } finally {
        await closePair(pair);
    }
}

/** Step 20: this process SIGKILLs itself right before it deletes a file whose path ends in `suffix`, as a power cut would. */
const killCommands: Record<string, (args: any) => Promise<unknown>> = {
    'kill-before-rm': async (a: { suffix: string }) => {
        const real = fs.rmSync;
        (fs as any).rmSync = (p: fs.PathLike, ...rest: any[]) => {
            if (String(p).endsWith(a.suffix)) process.kill(process.pid, 'SIGKILL');
            return (real as any)(p, ...rest);
        };
        return true;
    },
};

if (process.argv.includes('--child')) {
    // Steps 21, 24 and 25: armed by a file beside the data dir, read once at this start, this process SIGKILLs itself right
    // before the named fs call on a path ending in `suffix`, as a power cut would (before the swap at boot, which
    // runPagedCopyChild runs).
    const arm = `${process.env.BEANPOOL_DATA_DIR}.kill-at`;
    if (fs.existsSync(arm)) {
        const { op, suffix, action = 'kill', when = 'before' } = JSON.parse(fs.readFileSync(arm, 'utf-8')) as {
            op: 'renameSync' | 'rmSync'; suffix: string; action?: 'kill' | 'throw'; when?: 'before' | 'after';
        };
        fs.rmSync(arm);
        const real = (fs as any)[op];
        const act = (p: string) => {
            if (action === 'kill') process.kill(process.pid, 'SIGKILL');
            throw Object.assign(new Error(`test: ${op}(${p}) refused`), { code: 'EACCES' });
        };
        (fs as any)[op] = (p: fs.PathLike, ...rest: any[]) => {
            const hit = String(p).endsWith(suffix);
            if (hit && when === 'before') act(String(p));
            const r = real(p, ...rest);
            if (hit && when === 'after') act(String(p));
            return r;
        };
    }
    runPagedCopyChild({ ...auditCommand, ...killCommands }).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}
