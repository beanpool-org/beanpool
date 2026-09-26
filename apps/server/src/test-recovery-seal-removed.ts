/**
 * A copy a member removed while a rollback past the recovery seal lasted, on a standby running this code throughout
 * (services/recovery-seal-key.ts), with a real standby's puller in a second process and its main server's answers
 * scripted. 1–19 are in test-recovery-seal.ts, 20–25, 27 and 29 in test-recovery-seal-rollback.ts; the three share
 * recovery-seal-test-harness.ts and keep one numbering.
 *
 *  26. (the deciding pass on 4eadf334) a member removes their copy while the rollback lasts, and the standby has spent its
 *      one ask for a whole copy: it still clears at the pull that brings the re-sealed copies, under E2, leaving at most
 *      that one live row in its files, and asks for one more whole copy, which removes it.
 *  28. 26 with a main server that names no epoch: the rule from before the epoch, unchanged.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-recovery-seal-removed.ts
 *
 * The second processes are this file again, with RECOVERY_SEAL_CHILD set (recovery-seal-test-harness.ts runs them);
 * each gets its own data directory and is stopped with this run however it ends.
 */

import { fileURLToPath } from 'node:url';
import {
    CHILD, type History, fakeCopy, tempDir, runChild, resultOf, child, check, section, finish, sealLines, bootParent, epochFixtures,
} from './recovery-seal-test-harness.js';

const SCRIPT = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
    console.log('\nRecovery seal: a copy a member removed while a rollback lasted\n');
    // This process's key stands in for the main server's, which the standby never holds (as in 18).
    await bootParent();
    const {
        eOwners, eGen2, eGen3, eWrapped, eClientForm, E1, E2, epochOf, briefE, vacuumsOf, jsonFile, runStandby, T7, REMOVER, allBut,
        asksAgain, removedOne,
    } = await epochFixtures(SCRIPT);

    // ── 26–28: a copy a member removed while the rollback lasted (the deciding pass on 4eadf334) ──────
    // A deletion the older code makes reaches no standby (it writes no tombstone), so that member's copy stays here in the
    // client's form after its main server seals again, and only a whole copy removes it. A standby asks for one once a
    // process, and may have spent that ask already. It still clears at the import that brings the wrapped copies (the rest of what the rollback sent would
    // otherwise stay in its files until a restart), and asks for one more whole copy, which removes that member's.
    const T8 = '2026-06-08T00:00:00.000Z', T9 = '2026-06-09T00:00:00.000Z', T10 = '2026-06-10T00:00:00.000Z';

    /**
     * 26 and 28: one process of this code throughout (the reviewer's S10 and S10n). The standby starts with its clear
     * recorded beside 3 copies its main server deleted before the seal, so its boot spends its ask: the whole copy removes
     * them. Then the rollback's copies, the re-deposits, and the re-sealed copies without the member who removed theirs.
     */
    const removedWhileRolledBack = async (label: string, epoch: string | null, next: string | null) => {
        const deleted = [0, 1, 2];
        const kept = allBut(deleted);
        const keptNow = kept.filter(i => i !== REMOVER);
        const eGen4 = eOwners.map(() => fakeCopy());
        const watch = [...eGen2, ...eGen3, ...eGen4];
        const dir = tempDir(label);
        const h: History = { owners: eOwners, gen1: eGen2, gen2: eGen3, deleted, real: [] };
        resultOf(await runChild([SCRIPT], dir, { RECOVERY_SEAL_CHILD: 'pre-seal-history', SEAL_HISTORY: jsonFile(`${label}-history`, h), SEAL_SIDE: 'standby' }));
        const sealed = eWrapped(eGen3, 2, T7, kept);
        const o1 = await runStandby(dir, `${label}-seal`, {
            resyncFirst: false, since: '2026-06-03T00:00:00.000Z', reconcileMinutes: 0, pulls: 1, watch: [], steps: [sealed],
            ...(epoch ? { epochs: [epoch] } : {}),
        });
        const t1 = resultOf(o1);
        check(epochOf(t1.final?.cleared) === (epoch ?? 'none') && t1.final?.unwrapped === deleted.length,
            `control: its clear is recorded ${epoch ? 'under E1' : 'under no epoch'}, beside the ${deleted.length} copies its main server deleted before the seal (${briefE(t1.final)})`);

        const r = await runStandby(dir, `${label}-rollback`, {
            resyncFirst: false, reconcileMinutes: 0, pulls: 5, watch,
            steps: [
                sealed,                                           // the whole copy its boot asks for
                eClientForm(eGen3, 2, T8, kept),                  // the rollback command unwraps and stamps every copy
                eClientForm(eGen4, 3, T9, kept),                  // the older code stores the re-deposits as the app sealed them
                eWrapped(eGen4, 3, T10, keptNow),                 // sealed again; member 3 removed theirs while it lasted
                eWrapped(eGen4, 3, T10, keptNow),                 // what the next pull brings
            ],
            ...(epoch ? { epochs: [epoch, null, null, next] } : {}),
        });
        const s = resultOf(r);
        const [afterWhole, afterRollback, afterRedeposits, afterReseal] = (s.pulls ?? []).slice(1).map((x: any) => x.before);
        const routes = (s.pulls ?? []).map((p: any) => p.route);
        check(routes[0] === 'snapshot' && /removed 3 sign-in recovery copies its main server deleted before the seal/.test(r.stdout)
            && epochOf(afterWhole?.cleared) === (epoch ?? 'none') && afterWhole?.unwrapped === 0,
            `control: its boot spends its ask: the first pull is the whole copy, which removes the ${deleted.length}, and its clear stays (${JSON.stringify(routes)}; ${briefE(afterWhole)})`);
        check(afterRollback?.cleared === null && afterRollback.unwrapped === kept.length,
            `control: the rollback's copies make it forget its clear (${briefE(afterRollback)})`);
        check(afterRedeposits?.cleared === null && afterRedeposits.inFiles > 0,
            `control: after the re-deposits it still waits, and its files hold ${afterRedeposits?.inFiles} of the ${watch.length} copies`);
        check(typeof afterReseal?.cleared === 'string' && epochOf(afterReseal.cleared) === (next ?? 'none') && afterReseal.unwrapped === 1,
            `the import that brings the re-sealed copies clears again, recorded ${next ? 'under E2' : 'under no epoch'}, though member ${REMOVER}'s copy is still here in the client's form (${briefE(afterReseal)})`);
        check((afterReseal?.inFiles ?? 99) <= 1,
            `...after which its running files hold at most that one live row of the ${watch.length} copies sent in the client's form (found ${afterReseal?.inFiles})`);
        check(routes[4] === 'snapshot' && asksAgain.test(r.stdout) && removedOne.test(r.stdout),
            `...and it asks for one more whole copy, which removes that row (${JSON.stringify(routes)}; ${sealLines(r)})`);
        check(s.final?.unwrapped === 0 && s.final?.rows === keptNow.length && s.final?.inFiles === 0 && s.final?.cleared === afterReseal?.cleared,
            `...after which none of the ${watch.length} is left in its files, and its clear stands (${briefE(s.final)})`);
        check(vacuumsOf(r) === 1, `it cleared once (${vacuumsOf(r)})`);
    };

    // ── 26. one process, a main server that names its epoch ───────────────────────────────────────
    await section('26. a member removes their copy while the rollback lasts, and the standby has spent its ask: it clears at the re-sealed pull under E2, and a whole copy removes that copy', async () => {
        await removedWhileRolledBack('epoch-removed', E1, E2);
    });

    // ── 28. one process, a main server that names no epoch ─────────────────────────────────────────
    await section('28. the same with a main server that names no epoch: it clears at the re-sealed pull, as before the epoch, and a whole copy removes the removed copy', async () => {
        await removedWhileRolledBack('epoch-removed-none', null, null);
    });

    finish('⭐️ Recovery seal: a copy removed while a rollback lasted leaves a standby once a whole copy comes, and it clears once.');
}

if (CHILD) {
    child(CHILD).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error('❌ Test failed:', e); process.exit(1); });
}
