/**
 * A rollback past the recovery seal, in each order the two servers can be updated in (recovery seal S2 and the seal
 * epoch: services/recovery-seal-key.ts), with a real standby's puller in a second process and its main server's
 * answers scripted. 1–19 are in test-recovery-seal.ts, 26 and 28 in test-recovery-seal-removed.ts; the three share
 * recovery-seal-test-harness.ts and keep one numbering.
 *
 *  20. (S2, the deciding pass on 45ee304a) 18 in a FLEET rollback, where the standby runs the older code too while it
 *      lasts, so this code never sees a copy in the client's form arrive: at its next boot on this code it forgets its
 *      clear, and clears again after the delta that brings the wrapped copies back, after which its running files hold
 *      none of them. The copies its main server deleted before the seal, still rows here when it recorded its clear,
 *      never make it forget, at any boot, whichever way the two servers' clocks differ.
 *  21. (the seal epoch) a main server names a seal epoch when it records its clear, and a delta and a whole copy both
 *      carry it; a later boot keeps it; after the rollback command the next seal names a new one; a clear recorded
 *      before epochs is named one at the next boot, with no second VACUUM.
 *  22. a rollback where the main server is updated first: the standby's OLDER code pulls the re-sealed copies itself, so
 *      nothing here is in the client's form when this code boots. Its first pull names the new epoch, and it clears again
 *      at once, recorded under that epoch, after which its running files hold none of the copies sent in the client's form.
 *  23. a rollback where the standby runs this code before any wrapped pull: it waits while its main server is rolled back,
 *      and clears after the pull that brings the wrapped copies and the new epoch, recorded under it; files clean.
 *  24. a clear that fails for disk room after a forget is tried again at the next boot, which clears before any pull.
 *  25. copies its main server deleted before the seal (rows until a whole copy removes them) never make a standby forget
 *      or clear again across boots; a new epoch clears once, at the whole copy it asks for; one VACUUM per epoch, not
 *      per boot; a pull from a main server that names no epoch changes nothing.
 *  27. 26 (test-recovery-seal-removed.ts) in the fleet order, where this code boots while its main server is still
 *      rolled back and spends its ask there (beside a wrapped copy its main server no longer holds).
 *  29. a standby promoted before it pulls the new epoch (order B, then its main server dies): its first boot as a main
 *      server forgets the clear it recorded as a standby and clears once, under a new epoch; later boots run none; the
 *      same when the take-over finishes within the boot.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-seal-rollback.ts
 *
 * The second processes are this file again, with RECOVERY_SEAL_CHILD set (recovery-seal-test-harness.ts runs them);
 * each gets its own data directory and is stopped with this run however it ends.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import {
    CHILD, SEAL_CLI, KEY_FILE, CLEARED_KEY, type Sealed, type History, type StandbyScript, type ChildResult, fakeCopy, copiesFoundIn,
    exportRow, tempDir, runChild, resultOf, child, check, section, finish, sealLines, bootParent, epochFixtures,
} from './recovery-seal-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
    console.log('\nRecovery seal: a rollback past the seal, whichever server is updated first\n');
    const { keyPath } = await bootParent();

    // ── 20. a fleet rollback: the standby runs the older code too ───────────────────────────────
    await section('20. a fleet rollback, the standby on the older code too: at its next boot on this code it forgets its clear and clears again once the wrapped copies return; copies deleted before the seal never make it forget', async () => {
        const seal = await import('./services/recovery-seal-key.js');
        const brief = (x: any) => JSON.stringify(x && { cleared: !!x.cleared, rows: x.rows, unwrapped: x.unwrapped, inFiles: x.inFiles });
        const forgetsAtBoot = /at this boot holds \d+ sign-in recovery cop(y|ies) in the client's form that (was|were) not here when it cleared .* So it forgets that clear/;
        const vacuums = (r: ChildResult) => (r.stdout.match(/one VACUUM/g) ?? []).length;
        const N = 12;
        const owners = Array.from({ length: N }, () => crypto.randomBytes(32).toString('hex'));
        const gen2 = owners.map(() => fakeCopy());
        const gen3 = owners.map(() => fakeCopy());
        // As in 18: this process's key stands in for the main server's, which the standby never holds.
        const wrapped = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) =>
            exportRow(o, i, seal.sealRecoveryFields(copiesOf[i], seal.shareRowAad(o, 'sso')), generation, at));
        const clientForm = (copiesOf: Sealed[], generation: number, at: string) => owners.map((o, i) => exportRow(o, i, copiesOf[i], generation, at));
        const watch = [...gen2, ...gen3];
        const standbyDir = tempDir('fleet-standby');
        const scriptFile = (label: string, script: StandbyScript) => {
            const f = path.join(tempDir(label), 'script.json');
            fs.writeFileSync(f, JSON.stringify(script));
            return f;
        };

        // (1) This code: seeded with its main server's wrapped copies, the standby records its clear.
        const r1 = await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-seed', { resyncFirst: true, reconcileMinutes: 0, pulls: 2, watch, steps: [wrapped(gen2, 2, '2026-06-02T00:00:00.000Z')] }),
        });
        const s1 = resultOf(r1);
        const afterSeed = s1.pulls?.[1]?.before;
        check(s1.resync?.ok === true && typeof afterSeed?.cleared === 'string' && afterSeed.unwrapped === 0 && afterSeed.inFiles === 0,
            `control: seeded with its main server's wrapped copies, the standby records its clear (${brief(afterSeed)})`);

        // (2) The rollback, on both servers. The main server's rollback command unwraps and stamps every copy, the older
        // code there stores the re-deposits as the app sealed them, and the standby, on the older code too, imports both.
        // The main server's clock is behind the standby's: every stamp is before the clear the standby recorded.
        const batches = path.join(tempDir('fleet-batches'), 'batches.json');
        fs.writeFileSync(batches, JSON.stringify([clientForm(gen2, 2, '2026-06-05T00:00:00.000Z'), clientForm(gen3, 3, '2026-06-06T00:00:00.000Z')]));
        const older = resultOf(await runChild([SCRIPT], standbyDir, { RECOVERY_SEAL_CHILD: 'older-standby-import', NODE_ROLE: 'backup', SEAL_BATCHES: batches }));
        const olderInFiles = copiesFoundIn(standbyDir, watch);
        check(older.cleared === afterSeed?.cleared && older.rows === N && older.unwrapped === N && olderInFiles > 0,
            `control: after the rollback on the older code the standby still records its clear, beside ${older.unwrapped} copies in the client's form, and its files hold ${olderInFiles} of the ${watch.length}`);

        // (3) This code again, on both. The main server wrapped every copy at its own boot, before it served anything, so
        // every pull this standby now makes is wrapped: no import shows it a copy in the client's form.
        const r3 = await runChild([SCRIPT], standbyDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 3, watch, steps: [wrapped(gen3, 3, '2026-06-07T00:00:00.000Z')] }),
        });
        const s3 = resultOf(r3);
        const [atWrapped, afterWrapped] = (s3.pulls ?? []).map((x: any) => x.before);
        check(s3.atBoot?.cleared === null && s3.atBoot?.unwrapped === N,
            `at its boot on this code it forgets its clear: ${N} copies in the client's form are here that were not when it cleared (${brief(s3.atBoot)})`);
        check(forgetsAtBoot.test(r3.stdout + r3.stderr), `...and says why (${sealLines(r3)})`);
        check(atWrapped?.cleared === null && (s3.pulls ?? [])[0]?.route === 'delta',
            `...and waits until its main server's wrapped copies come (${brief(atWrapped)}; ${JSON.stringify((s3.pulls ?? []).map((p: any) => p.route))})`);
        check(typeof afterWrapped?.cleared === 'string' && afterWrapped.cleared !== afterSeed?.cleared && afterWrapped.unwrapped === 0,
            `the delta that brings the wrapped copies back is when it clears again, and records it (${brief(afterWrapped)})`);
        check(afterWrapped?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${watch.length} copies it was sent in the client's form (found ${afterWrapped?.inFiles})`);
        check(s3.final?.inFiles === 0 && s3.final?.cleared === afterWrapped?.cleared, `...nor after the next pull (found ${s3.final?.inFiles})`);
        check(vacuums(r3) === 1, `it cleared once, after the wrapped copies came back (${vacuums(r3)})`);

        // Control: a standby whose main server deleted copies before the seal still holds those as rows, in the client's
        // form, when it records its clear (a delta cannot show which ones; the next whole copy removes them). Here that
        // whole copy has not come yet, and the main server's clock runs a day ahead of the standby's, so every stamp is
        // after the clear. None of that is a copy that arrived after the clear: no boot forgets it.
        const ahead = (ms: number) => new Date(Date.now() + 86_400_000 + ms).toISOString();
        const h: History = { owners, gen1: gen2, gen2: gen3, deleted: [0, 1, 2], real: [], at: [ahead(0), ahead(1000)] };
        const historyFile = path.join(tempDir('fleet-orphans-history'), 'history.json');
        fs.writeFileSync(historyFile, JSON.stringify(h));
        const orphanDir = tempDir('fleet-orphans');
        resultOf(await runChild([SCRIPT], orphanDir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: historyFile, SEAL_SIDE: 'standby' }));
        const keptOwners = owners.map((_, i) => i).filter(i => !h.deleted.includes(i));
        const delta = keptOwners.map(i => exportRow(owners[i], i, seal.sealRecoveryFields(gen3[i], seal.shareRowAad(owners[i], 'sso')), 2, ahead(5000)));
        const o1 = await runChild([SCRIPT], orphanDir, {
            RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
            SEAL_SCRIPT: scriptFile('fleet-orphans-seal', { resyncFirst: false, since: ahead(2000), reconcileMinutes: 0, pulls: 1, watch: [], steps: [delta] }),
        });
        const t1 = resultOf(o1);
        check((t1.pulls ?? [])[0]?.route === 'delta' && typeof t1.final?.cleared === 'string' && t1.final.unwrapped === h.deleted.length,
            `control: the delta that brings the wrapped copies records its clear, with the ${h.deleted.length} copies its main server deleted before the seal still rows here (${brief(t1.final)})`);
        for (const n of [1, 2]) {
            const ob = await runChild([SCRIPT], orphanDir, {
                RECOVERY_SEAL_CHILD: 'standby-script', NODE_ROLE: 'backup',
                SEAL_SCRIPT: scriptFile(`fleet-orphans-boot-${n}`, { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: [], steps: [] }),
            });
            const tb = resultOf(ob);
            check(tb.atBoot?.cleared === t1.final?.cleared && tb.atBoot?.unwrapped === h.deleted.length && !forgetsAtBoot.test(ob.stdout + ob.stderr) && vacuums(ob) === 0,
                `boot ${n} after it: the clear stays recorded beside those ${h.deleted.length}, with no VACUUM (${brief(tb.atBoot)}; ${sealLines(ob)})`);
        }
    });

    // ── 21–25: the seal epoch ─────────────────────────────────────────────────────────────────────
    // What every rollback order has in common: the main server names a new epoch when it records its clear after sealing
    // again, and a standby that cleared under another one clears again, whichever code imported what in between.
    const {
        sealLib, EPOCH_RE, EN, eOwners, eGen2, eGen3, eWatch, eWrapped, eClientForm, E1, E2, epochOf, briefE, epochForgets, vacuumsOf,
        jsonFile, runStandby, olderImport, copyOfDir, T2, T5, T6, T7, REMOVER, allBut, asksAgain, removedOne,
    } = await epochFixtures(SCRIPT);
    // The standby, seeded (22) with its main server's wrapped copies under E1; 23 and 24 start from copies of it.
    let seededUnderE1 = '';
    let seededRecord: string | null = null;
    // 23's standby after its older code imported the rollback's copies; 24 starts from a copy of it.
    let rolledBackUnderOlderCode = '';
    // 22's standby after its older code pulled the re-sealed copies, before this code ran on it; 29 promotes a copy of it.
    let orderBBeforeThisCode = '';

    // ── 21. the main server's seal epoch ───────────────────────────────────────────────────────────
    await section('21. a main server names a seal epoch when it records its clear, in every payload; a later boot keeps it, and the rollback command makes the next seal name a new one', async () => {
        const dir = tempDir('epoch-main');
        const owners = eOwners.slice(0, 4);
        const h: History = { owners, gen1: owners.map(() => fakeCopy()), gen2: owners.map(() => fakeCopy()), deleted: [], real: [] };
        resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: jsonFile('epoch-main-history', h), SEAL_SIDE: 'main' }));
        const exportOf = async () => {
            const r = await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: '2026-06-03T00:00:00.000Z' });
            return { r, o: resultOf(r) };
        };
        const a = await exportOf();
        check(typeof a.o.epoch === 'string' && EPOCH_RE.test(a.o.epoch) && a.o.deltaEpoch === a.o.epoch && epochOf(a.o.cleared) === a.o.epoch && vacuumsOf(a.r) === 1,
            `after its seal the main server records its clear under a new epoch, and a whole copy and a delta both name it (epoch ${a.o.epoch}, delta ${a.o.deltaEpoch}, record ${epochOf(a.o.cleared)})`);
        const b = await exportOf();
        check(b.o.epoch === a.o.epoch && b.o.cleared === a.o.cleared && vacuumsOf(b.r) === 0,
            `a later boot keeps the same epoch and runs no VACUUM (${b.o.epoch === a.o.epoch ? 'same' : `${a.o.epoch} → ${b.o.epoch}`})`);
        const rollback = await runChild([SEAL_CLI, '--unwrap-recovery-rows'], dir, {});
        check(rollback.code === 0, `the rollback command runs (exit ${rollback.code}: ${rollback.stderr.slice(-300)})`);
        const c = await exportOf();
        check(typeof c.o.epoch === 'string' && EPOCH_RE.test(c.o.epoch) && c.o.epoch !== a.o.epoch && epochOf(c.o.cleared) === c.o.epoch && vacuumsOf(c.r) === 1,
            `back on this code after the rollback, the main server seals and clears again, under a new epoch (${a.o.epoch} → ${c.o.epoch})`);
        // A clear recorded before clears named an epoch (the first code with the seal).
        const raw = new Database(path.join(dir, 'state.db'));
        const record = JSON.parse(raw.prepare('SELECT value FROM node_config WHERE key = ?').pluck().get(CLEARED_KEY) as string);
        delete record.epoch;
        raw.prepare('UPDATE node_config SET value = ? WHERE key = ?').run(JSON.stringify(record), CLEARED_KEY);
        raw.close();
        const d = await exportOf();
        check(typeof d.o.epoch === 'string' && EPOCH_RE.test(d.o.epoch) && d.o.epoch !== c.o.epoch && JSON.parse(d.o.cleared).at === record.at && vacuumsOf(d.r) === 0,
            `a clear recorded before epochs is named one at the next boot, the same clear, with no second VACUUM (${d.o.epoch})`);
    });

    // ── 22. the main server updated first ──────────────────────────────────────────────────────────
    await section('22. the main server updated first: the standby\'s older code pulls the re-sealed copies itself, and this code, booting after, clears again at its first pull, under the new epoch', async () => {
        seededUnderE1 = tempDir('epoch-seed');
        const seed = await runStandby(seededUnderE1, 'epoch-seed', { resyncFirst: true, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [eWrapped(eGen2, 2, T2)], epochs: [E1] });
        const s1 = resultOf(seed);
        seededRecord = s1.final?.cleared ?? null;
        check(s1.resync?.ok === true && epochOf(seededRecord) === E1 && s1.final?.unwrapped === 0 && s1.final?.inFiles === 0 && s1.ownEpoch === null,
            `control: seeded with its main server's wrapped copies, which name E1, the standby records its clear under E1, and names no epoch of its own (${briefE(s1.final)}, own ${s1.ownEpoch})`);

        // The rollback on both servers; then the main server comes back to this code first. Its wrap stamps every copy, and
        // the standby, still on the older code, pulls them too: every row here is wrapped again.
        const dir = copyOfDir(seededUnderE1, 'epoch-order-b');
        const older = resultOf(await olderImport(dir, 'epoch-order-b-batches', [eClientForm(eGen2, 2, T5), eClientForm(eGen3, 3, T6), eWrapped(eGen3, 3, T7)]));
        const olderInFiles = copiesFoundIn(dir, eWatch);
        check(older.cleared === seededRecord && older.rows === EN && older.unwrapped === 0 && olderInFiles > 0,
            `control: on the older code it imported the rollback's copies, the re-deposits and the re-sealed copies: every row is wrapped, its clear is still recorded under E1, and its files hold ${olderInFiles} of the ${eWatch.length} copies sent in the client's form`);
        orderBBeforeThisCode = copyOfDir(dir, 'epoch-order-b-older');

        // This code on the standby. The main server has nothing new to send, and names E2.
        const r = await runStandby(dir, 'epoch-order-b-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [[]], epochs: [E2] });
        const s = resultOf(r);
        check(s.atBoot?.unwrapped === 0 && s.atBoot?.rows === EN,
            `control: at its boot on this code no copy here is in the client's form, so none shows it anything (${briefE(s.atBoot)})`);
        check(epochForgets.test(r.stdout + r.stderr), `its first pull names E2: it forgets its clear under E1, and says why (${sealLines(r)})`);
        check(epochOf(s.final?.cleared) === E2 && s.final?.unwrapped === 0,
            `...and clears again at once, recorded under E2: no copy it holds is in the client's form (${briefE(s.final)})`);
        check(s.final?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${eWatch.length} copies it was sent in the client's form (found ${s.final?.inFiles}; ${olderInFiles} before)`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    });

    // ── 23. the standby on this code before any wrapped pull ───────────────────────────────────────
    await section('23. the standby on this code before any wrapped pull: it waits while its main server is rolled back, and clears after the pull that brings the wrapped copies, under the new epoch', async () => {
        const dir = copyOfDir(seededUnderE1, 'epoch-order-a');
        const older = resultOf(await olderImport(dir, 'epoch-order-a-batches', [eClientForm(eGen2, 2, T5), eClientForm(eGen3, 3, T6)]));
        check(older.cleared === seededRecord && older.unwrapped === EN,
            `control: on the older code while the rollback lasts it imports the rollback's copies and the re-deposits, and keeps its clear under E1 (${older.unwrapped} in the client's form)`);
        rolledBackUnderOlderCode = copyOfDir(dir, 'epoch-rolled-back');

        // This code on the standby while its main server is still rolled back (its pull names no epoch), then the pull from
        // the main server back on this code: the wrapped copies, naming E2.
        const r = await runStandby(dir, 'epoch-order-a-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 2, watch: eWatch, steps: [[], eWrapped(eGen3, 3, T7)], epochs: [null, E2] });
        const s = resultOf(r);
        const whileRolledBack = s.pulls?.[1]?.before;
        check(s.atBoot?.cleared === null && s.atBoot?.unwrapped === EN,
            `at its boot on this code it forgets its clear: copies in the client's form are here that were not when it cleared (${briefE(s.atBoot)})`);
        check(whileRolledBack?.cleared === null && whileRolledBack.unwrapped === EN && (s.pulls ?? []).every((p: any) => p.route === 'delta'),
            `...and while its main server is still rolled back it waits (${briefE(whileRolledBack)})`);
        check(epochOf(s.final?.cleared) === E2 && s.final?.unwrapped === 0,
            `the pull that brings the wrapped copies and E2 is when it clears again, recorded under E2 (${briefE(s.final)})`);
        check(s.final?.inFiles === 0,
            `...after which its running state.db, -wal and -shm hold none of the ${eWatch.length} copies it was sent in the client's form (found ${s.final?.inFiles})`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    });

    // ── 24. a clear that fails for room is tried again at the next boot ────────────────────────────
    await section('24. a clear that fails for disk room after a forget is tried again at the next boot, and succeeds', async () => {
        const dir = copyOfDir(rolledBackUnderOlderCode, 'epoch-room');
        const tight = await runStandby(dir, 'epoch-room-tight', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: eWatch, steps: [eWrapped(eGen3, 3, T7)], epochs: [E2] },
            { SEAL_FREE_BYTES: String(1024 * 1024) });
        const t = resultOf(tight);
        check(t.final?.cleared === null && t.final?.unwrapped === 0 && vacuumsOf(tight) === 0
            && /needs about \d+ MB free in .*, which has 1 MB\. The server runs; the next boot tries again/.test(tight.stderr),
            `with no room when the wrapped copies arrive, it records nothing and says the next boot tries again (${briefE(t.final)}; ${sealLines(tight)})`);
        check((t.final?.inFiles ?? 0) > 0, `control: its files still hold ${t.final?.inFiles} of the ${eWatch.length} copies sent in the client's form`);
        const next = await runStandby(dir, 'epoch-room-boot', { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: eWatch, steps: [] });
        const n = resultOf(next);
        check(epochOf(n.atBoot?.cleared) === E2 && vacuumsOf(next) === 1,
            `the next boot, with room, clears before any pull, recorded under E2, the epoch it last imported (${briefE(n.atBoot)}; ${sealLines(next)})`);
        check(n.atBoot?.inFiles === 0, `...after which its running files hold none of them (found ${n.atBoot?.inFiles})`);
    });

    // ── 25. copies deleted before the seal; one VACUUM per epoch; a main server with no epoch ──────
    await section('25. copies deleted before the seal never make a standby clear again across boots; a new epoch clears once, at the whole copy; a main server that names no epoch changes nothing', async () => {
        const deleted = [0, 1, 2];
        const kept = eOwners.map((_, i) => i).filter(i => !deleted.includes(i));
        const h: History = { owners: eOwners, gen1: eGen2, gen2: eGen3, deleted, real: [] };
        const dir = tempDir('epoch-orphans');
        resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: jsonFile('epoch-orphans-history', h), SEAL_SIDE: 'standby' }));
        const sealed = eWrapped(eGen3, 2, T7, kept);
        const o1 = await runStandby(dir, 'epoch-orphans-seal', { resyncFirst: false, since: '2026-06-03T00:00:00.000Z', reconcileMinutes: 0, pulls: 1, watch: [], steps: [sealed], epochs: [E1] });
        const t1 = resultOf(o1);
        check(t1.pulls?.[0]?.route === 'delta' && epochOf(t1.final?.cleared) === E1 && t1.final?.unwrapped === deleted.length && vacuumsOf(o1) === 1,
            `control: the delta that brings the wrapped copies under E1 records its clear under E1, with the ${deleted.length} copies deleted before the seal still rows here (${briefE(t1.final)})`);
        for (const n of [1, 2]) {
            const ob = await runStandby(dir, `epoch-orphans-boot-${n}`, { resyncFirst: false, reconcileMinutes: 0, pulls: 0, watch: [], steps: [] });
            const tb = resultOf(ob);
            check(tb.atBoot?.cleared === t1.final?.cleared && tb.atBoot?.unwrapped === deleted.length && vacuumsOf(ob) === 0 && !/forgets that clear/.test(ob.stdout + ob.stderr),
                `boot ${n}: beside those ${deleted.length}, its clear under E1 stays, with no VACUUM (${briefE(tb.atBoot)}; ${sealLines(ob)})`);
        }
        // The main server rolled back and sealed again: E2. The pull after the boot is the whole copy the standby asks for.
        const o2 = await runStandby(dir, 'epoch-orphans-again', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: [], steps: [sealed], epochs: [E2] });
        const t2 = resultOf(o2);
        check(t2.pulls?.[0]?.route === 'snapshot' && /removed 3 sign-in recovery copies its main server deleted before the seal/.test(o2.stdout),
            `under E2, its first pull is the whole copy it asks for, which removes the ${deleted.length} (${JSON.stringify((t2.pulls ?? []).map((p: any) => p.route))}; ${sealLines(o2)})`);
        check(epochForgets.test(o2.stdout + o2.stderr) && epochOf(t2.final?.cleared) === E2 && t2.final?.unwrapped === 0 && t2.final?.rows === kept.length && vacuumsOf(o2) === 1,
            `...and it clears again once, recorded under E2, with no copy left in the client's form (${briefE(t2.final)})`);
        // A later boot, and a pull from a main server that names no epoch (one from before it, or rolled back again).
        const o3 = await runStandby(dir, 'epoch-orphans-none', { resyncFirst: false, reconcileMinutes: 0, pulls: 1, watch: [], steps: [[]] });
        const t3 = resultOf(o3);
        check(t3.atBoot?.cleared === t2.final?.cleared && t3.final?.cleared === t2.final?.cleared && vacuumsOf(o3) === 0
            && !/forgets that clear/.test(o3.stdout + o3.stderr) && (t3.pulls ?? []).length === 1,
            `a later boot, and a pull that names no epoch, change nothing: the clear under E2 stays, with no VACUUM (${briefE(t3.final)}; ${sealLines(o3)})`);
    });

    // 26 and 28, the same in one process of this code, are in test-recovery-seal-removed.ts.
    // ── 27. the fleet order, the ask spent on the rolled-back main server ─────────────────────────
    await section('27. the standby boots this code while its main server is still rolled back and spends its ask there: it still clears at the re-sealed pull under E2, and a whole copy removes the removed copy', async () => {
        // The standby seeded under E1 (22) also holds a wrapped copy its main server deleted after the seal (no deletion
        // reaches a standby), so at its boot on this code its copies in the client's form are beside a wrapped one.
        const dir = copyOfDir(seededUnderE1, 'epoch-fleet-removed');
        const gone = crypto.randomBytes(32).toString('hex');
        const goneRow = exportRow(gone, 99, sealLib.sealRecoveryFields(fakeCopy(), sealLib.shareRowAad(gone, 'sso')), 1, T2);
        const older = resultOf(await olderImport(dir, 'epoch-fleet-removed-batches', [[goneRow], eClientForm(eGen2, 2, T5), eClientForm(eGen3, 3, T6)]));
        check(older.cleared === seededRecord && older.rows === EN + 1 && older.unwrapped === EN,
            `control: on the older code it imported the rollback's copies and the re-deposits beside one wrapped copy its main server no longer holds; its clear is still under E1 (${older.unwrapped} of ${older.rows} in the client's form)`);

        const keptNow = allBut([REMOVER]);
        const r = await runStandby(dir, 'epoch-fleet-removed-again', {
            resyncFirst: false, reconcileMinutes: 0, pulls: 3, watch: eWatch,
            steps: [
                eClientForm(eGen3, 3, T6),                         // the whole copy it asks for, from its main server still rolled back
                eWrapped(eGen3, 3, T7, keptNow),                   // sealed again; member 3 removed theirs while it lasted
                eWrapped(eGen3, 3, T7, keptNow),                   // what the next pull brings
            ],
            epochs: [null, E2],
        });
        const s = resultOf(r);
        const [afterWhole, afterReseal] = (s.pulls ?? []).slice(1).map((x: any) => x.before);
        const routes = (s.pulls ?? []).map((p: any) => p.route);
        check(s.atBoot?.cleared === null && s.atBoot?.unwrapped === EN && /that (was|were) not here when it cleared .* So it forgets that clear/.test(r.stdout + r.stderr),
            `control: at its boot on this code it forgets its clear (${briefE(s.atBoot)})`);
        check(routes[0] === 'snapshot' && afterWhole?.cleared === null && afterWhole.unwrapped === EN && afterWhole.rows === EN + 1,
            `control: its first pull is the whole copy it asked for at boot, from its main server still rolled back, which removes nothing (${JSON.stringify(routes)}; ${briefE(afterWhole)})`);
        check(epochOf(afterReseal?.cleared) === E2 && afterReseal?.unwrapped === 1,
            `the pull that brings the re-sealed copies and E2 clears again, recorded under E2, though member ${REMOVER}'s copy is still here in the client's form (${briefE(afterReseal)})`);
        check((afterReseal?.inFiles ?? 99) <= 1,
            `...after which its running files hold at most that one live row of the ${eWatch.length} copies sent in the client's form (found ${afterReseal?.inFiles})`);
        check(routes[2] === 'snapshot' && asksAgain.test(r.stdout) && removedOne.test(r.stdout)
            && s.final?.unwrapped === 0 && s.final?.inFiles === 0 && s.final?.cleared === afterReseal?.cleared,
            `...and the one more whole copy it asks for removes that row: none of the ${eWatch.length} is left in its files (${JSON.stringify(routes)}; ${briefE(s.final)})`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    });

    // ── 29. a standby promoted before its first pull of the new epoch ──────────────────────────────
    await section('29. a standby promoted before it pulls the new epoch (order B, then its main server dies): its first boot as a main server clears once, under a new epoch; later boots run none', async () => {
        const watchFile = jsonFile('epoch-promoted-watch', eWatch);
        const promote = (label: string) => {
            // A take-over writes the main server's key here (S2) and makes this server the main one.
            const dir = copyOfDir(orderBBeforeThisCode, label);
            fs.copyFileSync(keyPath, path.join(dir, KEY_FILE));
            fs.chmodSync(path.join(dir, KEY_FILE), 0o600);
            return dir;
        };
        const dir = promote('epoch-promoted');
        const before = copiesFoundIn(dir, eWatch);
        check(before > 0, `control: before the take-over its files hold ${before} of the ${eWatch.length} copies sent in the client's form`);
        const exportOf = async () => {
            const r = await runChild([SCRIPT], dir, {
                RECOVERY_SEAL_CHILD: 'main-export', NODE_ROLE: 'primary', SEAL_SINCE: '2026-06-03T00:00:00.000Z', SEAL_WATCH: watchFile,
            });
            return { r, o: resultOf(r) };
        };
        const a = await exportOf();
        const record = (() => { try { return JSON.parse(a.o.cleared); } catch { return null; } })();
        check(typeof a.o.epoch === 'string' && EPOCH_RE.test(a.o.epoch) && a.o.epoch !== E1 && epochOf(a.o.cleared) === a.o.epoch
            && record?.standby === undefined && a.o.mainEpochKept === false && vacuumsOf(a.r) === 1,
            `its first boot as a main server forgets the clear it recorded as a standby and clears once, under a new epoch of its own, which it names (${JSON.stringify({ epoch: a.o.epoch === E1 ? 'E1' : a.o.epoch, standby: record?.standby, mainEpochKept: a.o.mainEpochKept, vacuums: vacuumsOf(a.r) })})`);
        check(/recorded its clear of state\.db while it was a standby/.test(a.r.stdout), `...and says why (${sealLines(a.r)})`);
        check(a.o.inFiles === 0, `...after which its running files hold none of the ${eWatch.length} copies (found ${a.o.inFiles}; ${before} before)`);
        const b = await exportOf();
        check(b.o.epoch === a.o.epoch && b.o.cleared === a.o.cleared && vacuumsOf(b.r) === 0,
            `a later boot keeps that epoch and runs no VACUUM (${b.o.epoch === a.o.epoch ? 'same' : `${a.o.epoch} → ${b.o.epoch}`}, ${vacuumsOf(b.r)})`);

        // A take-over step that finishes at the boot itself (index.ts step 2.65): the server boots as a standby, and then
        // as the main server, in one process.
        const late = promote('epoch-promoted-late');
        const l = await runChild([SCRIPT], late, { RECOVERY_SEAL_CHILD: 'boot', NODE_ROLE: 'backup', SEAL_THEN_MAIN: '1', SEAL_WATCH: watchFile });
        const lo = resultOf(l);
        check(lo.booted === true && typeof epochOf(lo.cleared) === 'string' && epochOf(lo.cleared) !== E1 && vacuumsOf(l) === 1 && lo.inFiles === 0,
            `promoted within the boot, it clears once as the main server, under a new epoch, and its running files hold none of them (${JSON.stringify({ booted: lo.booted, epoch: epochOf(lo.cleared) === E1 ? 'E1' : epochOf(lo.cleared), vacuums: vacuumsOf(l), inFiles: lo.inFiles })})`);
    });

    finish('⭐️ Recovery seal: after a rollback past the seal, a standby clears again, whichever order the servers are updated in.');
}

if (CHILD) {
    child(CHILD).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
