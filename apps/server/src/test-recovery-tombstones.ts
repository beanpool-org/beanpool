/**
 * Test Suite: a standby deletes the sign-in recovery copies its main server deleted (engine/recovery-shares.ts
 * deleteAllShares, engine/sync.ts applyTombstoneLocally, engine/key-move.ts dropMovedRecoveryCopies).
 *
 * Before this, a member who disconnected their last sign-in, removed every keeper or deleted their account lost the
 * copy on the main server only: no tombstone was written, and a standby drops a copy only when a newer generation
 * arrives. So after a take-over the removed copy was a live row again, and the sign-in (or whoever holds it) could
 * bring the account back.
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts), booted as index.ts boots. Members
 * deposit, disconnect, remove their keepers and delete their account over the main server's real HTTPS server and
 * signature middleware, with a stand-in Google (recovery-seal-test-http.ts). The standby pulls through its real puller
 * (services/backup-puller.ts) from the main server's real backup routes. No other host is reached.
 *
 *  1. A main server: Anna (owner) and members who each deposit a sign-in copy, and Zed, who never does. Its standby copies
 *     it (a force-resync) and holds the take-over keys.
 *  2. Ada disconnects her last sign-in, Ben removes every keeper and Cal deletes his account. The standby's next pull is a
 *     delta, then a whole copy: after each, none of their copies is there, and every copy there is the main server's.
 *  3. Ava, Bo and Cy do the same, and the standby's next pull is a whole copy, then a delta: the same.
 *  4. Between two pulls, Dee disconnects and connects her sign-in again: her new copy is on the standby after each pull,
 *     the main server's, of a newer generation than the one she deleted.
 *  5. Between two pulls, Eli re-deposits (his older generation dropped on the main server) and then disconnects: the
 *     standby, which holds the older generation, has none of his copies after either pull.
 *  6. Between two pulls, Fay disconnects and is then re-keyed: the standby ends as the main server, no copy under either key.
 *  7. Between two pulls, Gus is re-keyed and then disconnects: the same.
 *  8. The main server dies and the standby takes over. A sign-in each of those members removed answers as for Zed, who never
 *     had a copy (the collect routes, /api/recovery/collect/sso among them); Hal's and Dee's sign-ins still bring theirs
 *     back. Ada connects hers again on the new main server: it numbers her copy after the one she deleted.
 *
 * Run:
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-tombstones.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, recoverySealCommands, type NodeProc } from './takeover-test-harness.js';
import { fixtureWords } from './recovery-seal-test-http.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

// Every process of this suite: no host but this machine.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new TypeError(`this suite reaches no host but this machine (${url.host})`);
    return realFetch(input, init);
}) as typeof fetch;

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Recovery-Tombstones-Main-Pw-914!';
const PW_STANDBY = 'Recovery-Tombstones-Standby-Pw-38!';

/** A member's key from their seed, as the apps derive it. */
function pkOf(seedHex: string): string {
    const priv = crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8',
    });
    return (crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
}

// ── The node processes' commands ───────────────────────────────────────────────────────────

async function child(): Promise<void> {
    const { runNodeChild } = await import('./takeover-test-harness.js');
    await runNodeChild({
        ...recoverySealCommands,
        'setup-primary': async (a: { ownerSeedHex: string; replicationToken: string }) => {
            const se = await import('./state-engine.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
            const owner = pkOf(a.ownerSeedHex);
            se.seedGenesisMember(owner, 'Anna');
            setReplicationToken(a.replicationToken);
            return { owner, code: (await makeRecoveryCode()).code };
        },
        // A member with no copy at all: what every answer below is compared with.
        'add-member': async (a: { pk: string; callsign: string }) => {
            const { db } = await import('./db/db.js');
            db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'recovery-tombstones-test', 'TEST')`).run(a.pk, a.callsign);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.pk);
            return true;
        },
        // A request to this node's own HTTPS server, signed by the member as the apps sign one.
        signed: async (a: { seedHex: string; method: 'POST' | 'DELETE'; path: string; body?: unknown }) => {
            const { startRecoveryHttps } = await import('./recovery-seal-test-http.js');
            const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
            const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
            const { base } = await startRecoveryHttps();
            resetGatewayRateLimit();
            pruneAuthAttempts(Date.now() + 120_000);
            const priv = crypto.createPrivateKey({
                key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(a.seedHex, 'hex')]), format: 'der', type: 'pkcs8',
            });
            const bodyString = JSON.stringify(a.body ?? {});
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            const res = await fetch(`${base}${a.path}`, {
                method: a.method,
                headers: {
                    'Content-Type': 'application/json',
                    'X-Public-Key': pkOf(a.seedHex),
                    'X-Signature': crypto.sign(null, Buffer.from(`${a.method}\n${a.path}\n${ts}\n${nonce}\n${bodyString}`), priv).toString('base64'),
                    'X-Timestamp': String(ts),
                    'X-Nonce': nonce,
                },
                body: bodyString,
            });
            let parsed: any;
            try { parsed = await res.json(); } catch { parsed = undefined; }
            return { status: res.status, body: parsed };
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        // Every recovery copy here, by what identifies it, with a print of its bytes (never the bytes), and its stamp.
        copies: async () => {
            const { db } = await import('./db/db.js');
            const rows = db.prepare(`SELECT owner_pubkey, holder_type, holder_ref, generation, share_index, encrypted_share, updated_at
                                     FROM recovery_shares ORDER BY owner_pubkey, generation, holder_type, holder_ref`).all() as any[];
            return rows.map((r) => ({
                owner: r.owner_pubkey, type: r.holder_type, ref: r.holder_ref, generation: r.generation, index: r.share_index,
                print: crypto.createHash('sha256').update(String(r.encrypted_share)).digest('hex').slice(0, 16), stamp: r.updated_at,
            }));
        },
        'recovery-tombstones': async () => {
            const { db } = await import('./db/db.js');
            return db.prepare("SELECT row_key, deleted_at FROM tombstones WHERE table_name = 'recovery_shares' ORDER BY row_key").all();
        },
        reseal: async () => {
            const { flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            return (await flushTakeoverChecks()).envelopeId;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        envelope: async () => {
            const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return pullTakeoverEnvelopeNow();
        },
        // The puller's next pull, of the kind it chooses; `whole` forces a routine whole copy (the reconcile timer, due).
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            await new Promise((r) => setTimeout(r, 5));
            if (a.whole) process.env.BACKUP_RECONCILE_EVERY_MS = '1';
            try {
                const result = await pullNow();
                return { ...result, whole: getBackupStatus().lastFullReconcileAt !== before };
            } finally {
                delete process.env.BACKUP_RECONCILE_EVERY_MS;
            }
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
/** For a step the rest of the suite cannot run without. */
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Member { name: string; seedHex: string; words: string[]; pk: string }
let fixture = 0;
function member(name: string): Member {
    const { words, seedHex } = fixtureWords(++fixture);
    return { name, seedHex, words, pk: pkOf(seedHex) };
}

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dirs = { main: path.join(root, 'main'), standby: path.join(root, 'standby') };
    const nodes: NodeProc[] = [];
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const pw = (p: string) => ({ 'X-Admin-Password': p });

    const anna = member('Anna');
    const [ada, ben, cal, ava, bo, cy, dee, eli, fay, gus, hal] =
        ['Ada', 'Ben', 'Cal', 'Ava', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'].map(member);
    const fay2 = member('Fay (new phone)'), gus2 = member('Gus (new phone)');
    const zed = member('Zed');
    const names = new Map([anna, ada, ben, cal, ava, bo, cy, dee, eli, fay, gus, hal, fay2, gus2, zed].map((m) => [m.pk, m.name]));
    const named = (rows: any[]) => rows.map((r) => `${names.get(r.owner) ?? r.owner.slice(0, 8)}:${r.type}/${r.ref}#${r.generation}`);

    let main: NodeProc;
    let standby: NodeProc;
    const disconnect = (m: Member) => main.send('signed', { seedHex: m.seedHex, method: 'DELETE', path: '/api/recovery/shares/sso/google' });
    const removeKeepers = (m: Member) => main.send('signed', {
        seedHex: m.seedHex, method: 'DELETE', path: '/api/recovery/shares', body: { confirm: 'delete-my-recovery-keepers' },
    });
    const purge = (m: Member) => main.send('signed', { seedHex: m.seedHex, method: 'POST', path: '/api/member/purge' });
    const deposit = async (node: NodeProc, m: Member, addMember: boolean) => {
        const r = await node.send('recovery-deposit', { seedHex: m.seedHex, words: m.words, callsign: m.name, addMember });
        require_(r.status === 200 && r.pk === m.pk, `${m.name} connects their Google sign-in (${r.status} ${JSON.stringify(r.body?.error ?? r.body?.generation)})`);
        return r;
    };
    /** The standby pulls, of the kind asked for. */
    const pull = async (whole: boolean, what: string) => {
        const r = await standby.send('pull', whole ? { whole: true } : {});
        require_(r.ok === true && r.whole === whole, `the standby's next pull is ${whole ? 'a whole copy' : 'a delta'}, ${what} (${JSON.stringify({ ok: r.ok, error: r.error, whole: r.whole })})`);
    };
    /** Every copy on the standby is the main server's, and those members have none on either. */
    const agree = async (when: string, gone: Member[]) => {
        const m = await main.send('copies');
        const s = await standby.send('copies');
        const keys = new Set(gone.map((g) => g.pk));
        if (gone.length > 0) {
            assert(!m.some((r: any) => keys.has(r.owner)) && !s.some((r: any) => keys.has(r.owner)),
                `${when}: ${gone.map((g) => g.name).join(', ')} ${gone.length === 1 ? 'has' : 'have'} no copy on the main server or the standby (standby: ${JSON.stringify(named(s.filter((r: any) => keys.has(r.owner))))})`);
        }
        assert(same(s, m), `${when}: every copy on the standby is the main server's, as it holds it (${named(s).length} / ${named(m).length}; only on the standby: ${JSON.stringify(named(s.filter((r: any) => !m.some((x: any) => same(x, r)))))})`);
        return { m, s };
    };

    try {
        // ── 1. A main server and its standby ──
        console.log('\n— 1. a main server, whose members connect their sign-in; and its standby —');
        main = await spawnNode(SCRIPT, dirs.main, { ADMIN_PASSWORD: PW_MAIN, NODE_ROLE: 'primary' });
        nodes.push(main);
        const { owner, code } = await main.send('setup-primary', { ownerSeedHex: anna.seedHex, replicationToken });
        require_(owner === anna.pk, 'Anna owns the main server');
        for (const m of [ada, ben, cal, ava, bo, cy, dee, eli, fay, gus, hal]) await deposit(main, m, true);
        await main.send('add-member', { pk: zed.pk, callsign: 'Zed' });

        await main.send('reseal');
        fs.mkdirSync(dirs.standby, { recursive: true });
        fs.copyFileSync(path.join(dirs.main, 'genesis.json'), path.join(dirs.standby, 'genesis.json'));
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const seeded = await standby.send('resync');
        require_(seeded.ok, `the standby copies the main server (${JSON.stringify(seeded)})`);
        require_(await standby.send('envelope') === 'stored', 'and holds its take-over keys');
        const first = await agree('after its first copy', []);
        require_(first.s.length === 11, `the standby holds the 11 members' copies (${first.s.length})`);

        // ── 2. Each delete path, then a delta and a whole copy ──
        console.log('\n— 2. Ada disconnects her last sign-in, Ben removes every keeper, Cal deletes his account; a delta, then a whole copy —');
        const adaOff = await disconnect(ada);
        require_(adaOff.status === 200 && adaOff.body?.generation === 0, `Ada disconnects Google, her last sign-in (${adaOff.status} ${JSON.stringify(adaOff.body)})`);
        const benOff = await removeKeepers(ben);
        require_(benOff.status === 200 && benOff.body?.removed === 1, `Ben removes every keeper (${benOff.status} ${JSON.stringify(benOff.body)})`);
        const calOff = await purge(cal);
        require_(calOff.status === 200 && calOff.body?.ok === true, `Cal deletes his account (${calOff.status} ${JSON.stringify(calOff.body)})`);
        const written = (await main.send('recovery-tombstones')).map((t: any) => t.row_key);
        assert(same(written, [ada, ben, cal].map((m) => `${m.pk}|1`).sort()),
            `the main server writes one tombstone for each: the member and the generation deleted (${JSON.stringify(written.map((k: string) => `${names.get(k.split('|')[0])}|${k.split('|')[1]}`))})`);
        await pull(false, 'after those three');
        await agree('after the delta', [ada, ben, cal]);
        await pull(true, 'then');
        await agree('after the whole copy', [ada, ben, cal]);

        // ── 3. Each delete path, then a whole copy and a delta ──
        console.log('\n— 3. Ava, Bo and Cy do the same; a whole copy, then a delta —');
        require_((await disconnect(ava)).status === 200, 'Ava disconnects her last sign-in');
        require_((await removeKeepers(bo)).status === 200, 'Bo removes every keeper');
        require_((await purge(cy)).body?.ok === true, 'Cy deletes his account');
        await pull(true, 'after those three');
        await agree('after the whole copy', [ava, bo, cy]);
        await pull(false, 'then');
        await agree('after the delta', [ava, bo, cy]);

        // ── 4. A delete and a re-deposit between two pulls ──
        console.log('\n— 4. between two pulls, Dee disconnects and connects her sign-in again —');
        require_((await disconnect(dee)).status === 200, 'Dee disconnects her last sign-in');
        const again = await deposit(main, dee, false);
        assert(again.body?.generation === 2, `the main server numbers her new copy after the one she deleted (generation ${again.body?.generation})`);
        await pull(false, 'after that');
        const deeDelta = await agree('after the delta', []);
        const deeRows = (rows: any[]) => rows.filter((r: any) => r.owner === dee.pk).map((r: any) => `${r.type}/${r.ref}#${r.generation}`);
        assert(same(deeRows(deeDelta.s), ['sso/google#2']), `her new copy is on the standby, and only that one (${JSON.stringify(deeRows(deeDelta.s))})`);
        await pull(true, 'then');
        const deeWhole = await agree('after the whole copy', []);
        assert(same(deeRows(deeWhole.s), ['sso/google#2']), `and it is still there after the whole copy (${JSON.stringify(deeRows(deeWhole.s))})`);

        // ── 5. A re-deposit and a delete between two pulls ──
        console.log('\n— 5. between two pulls, Eli connects his sign-in again (a newer generation) and then disconnects it —');
        const eliAgain = await deposit(main, eli, false);
        require_(eliAgain.body?.generation === 2, `Eli's copy is generation 2 on the main server, which drops generation 1 (${eliAgain.body?.generation})`);
        require_((await disconnect(eli)).status === 200, 'Eli disconnects it');
        const eliTomb = (await main.send('recovery-tombstones')).find((t: any) => t.row_key.startsWith(`${eli.pk}|`));
        assert(eliTomb?.row_key === `${eli.pk}|2`, `the tombstone names generation 2, the one deleted (${eliTomb?.row_key?.split('|')[1]})`);
        await pull(false, 'after that');
        await agree('after the delta', [eli]);
        await pull(true, 'then');
        await agree('after the whole copy', [eli]);

        // ── 6. A delete, then a re-key, between two pulls ──
        console.log('\n— 6. between two pulls, Fay disconnects her sign-in and is then re-keyed —');
        require_((await disconnect(fay)).status === 200, 'Fay disconnects her last sign-in');
        require_(await main.send('rekey', { oldPk: fay.pk, newPk: fay2.pk, operator: owner }), 'Fay is re-keyed to her new phone\'s key');
        await pull(false, 'after that');
        await agree('after the delta', [fay, fay2]);
        await pull(true, 'then');
        await agree('after the whole copy', [fay, fay2]);

        // ── 7. A re-key, then a delete, between two pulls ──
        console.log('\n— 7. between two pulls, Gus is re-keyed and then disconnects his sign-in —');
        require_(await main.send('rekey', { oldPk: gus.pk, newPk: gus2.pk, operator: owner }), 'Gus is re-keyed to his new phone\'s key');
        const moved = (await main.send('copies')).filter((r: any) => r.owner === gus2.pk).length;
        require_(moved === 1, `the main server moves his copy to the new key (${moved})`);
        require_((await disconnect(gus2)).status === 200, 'Gus disconnects Google, from his new phone');
        await pull(false, 'after that');
        await agree('after the delta', [gus, gus2]);
        await pull(true, 'then');
        await agree('after the whole copy', [gus, gus2]);

        // ── 8. The take-over ──
        console.log('\n— 8. the main server dies and the standby takes over —');
        await main.send('reseal');
        const envelope = await standby.send('envelope');
        require_(envelope === 'stored' || envelope === 'unchanged', `the standby holds the main server's latest take-over keys (${envelope})`);
        await main.kill('SIGKILL');
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code }, pw(PW_STANDBY));
        require_(opened.status === 200, `the recovery code opens the keys (${opened.status} ${opened.body?.error ?? ''})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, pw(PW_STANDBY));
        require_(confirmed.status === 200, `confirmed (${confirmed.status})`);
        const exit = await standby.exited;
        assert(exit === 0, `the standby restarts itself (exit ${exit})`);
        standby = await spawnNode(SCRIPT, dirs.standby, { ADMIN_PASSWORD: PW_STANDBY, NODE_ROLE: 'backup' });
        nodes.push(standby);
        require_(standby.ready.role === 'primary', 'it is the main server');

        /** What a device with only the Google sign-in gets, through every collect route, with no bytes of a copy in it. */
        const answer = (r: any) => ({
            opened: r.opened, released: r.released.status, releasedBody: r.released.body, fragments: r.fragments.status,
            fragmentsBody: r.fragments.body, seed: r.seedHex !== null, error: r.error,
        });
        const none = answer(await standby.send('recovery-recover', { callsign: 'Zed' }));
        require_(none.opened !== 200 && !none.seed, `Zed, who never had a copy, gets none (${JSON.stringify(none)})`);
        for (const [m, callsign] of [[ada, 'Ada'], [ben, 'Ben'], [ava, 'Ava'], [bo, 'Bo'], [eli, 'Eli'], [fay, 'Fay'], [gus, 'Gus'], [cal, 'Cal'], [cy, 'Cy'], [cal, 'Deleted Member']] as [Member, string][]) {
            const r = answer(await standby.send('recovery-recover', { callsign }));
            assert(same(r, none), `${m.name}'s removed sign-in (asked for as "${callsign}") answers as for no copy (${JSON.stringify(r)})`);
        }
        for (const m of [hal, dee]) {
            const r = await standby.send('recovery-recover', { callsign: m.name });
            assert(r.released.status === 200 && r.seedHex === m.seedHex, `${m.name}'s sign-in still brings their account back (${r.released.status} ${r.error ?? 'opened'})`);
        }
        const adaBack = await deposit(standby, ada, false);
        assert(adaBack.body?.generation === 2, `Ada connects Google again on the new main server, which numbers it after the one she deleted there (generation ${adaBack.body?.generation})`);
        const adaNow = await standby.send('recovery-recover', { callsign: 'Ada' });
        assert(adaNow.released.status === 200 && adaNow.seedHex === ada.seedHex, `and it brings her account back (${adaNow.released.status} ${adaNow.error ?? 'opened'})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby deletes the sign-in recovery copies its main server deleted, and a server that takes over brings none of them back.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
