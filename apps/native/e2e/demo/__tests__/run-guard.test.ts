/**
 * The capture run's time box and its one cleanup (e2e/demo/run-guard.mjs, used by capture.mjs; PR #2998 round 2). No emulator.
 *
 * The scenario the deciding review measured: the budget's stop starts the cleanup, which waits for the emulator to exit; the run,
 * woken by its failing adb call, reaches its `finally` and asks for the cleanup too; the top level then calls `process.exit`.
 * With a flag-guarded cleanup the second caller returned at once and the exit cut the first one off before Metro and the demo
 * node were killed, the temp folders removed and the report written. `mainLike` below is built the way capture.mjs main() is.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetStop, createRunGuard } from '../run-guard.mjs';

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A cleanup shaped like capture.mjs's: the phone first, then a wait for the emulator to exit (held open until the test opens
 * `gate`, so the order does not depend on how fast the machine is), then Metro and the node, the folders, the report.
 */
const gated = () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cleanup = (log: string[]) => async () => {
        log.push('phone put back');
        await gate; // the emulator taking its time to exit
        log.push('emulator gone');
        log.push('metro and node killed');
        log.push('folders removed');
        log.push('report written');
    };
    return { cleanup, release };
};
const WHOLE = ['phone put back', 'emulator gone', 'metro and node killed', 'folders removed', 'report written'];

describe('createRunGuard: the one cleanup', () => {
    it('runs the cleanup once however many ask, and a late caller waits for the early caller\'s to finish', async () => {
        const log: string[] = [];
        let runs = 0;
        const { cleanup, release } = gated();
        const guard = createRunGuard({ budgetMs: 60_000, cleanup: async () => { runs++; await cleanup(log)(); }, exit: () => {} });
        const first = guard.done();
        let lateReturned = false;
        const late = guard.done().then(() => { lateReturned = true; });
        await wait(20); // the first is still waiting for the emulator
        expect(log).toEqual(['phone put back']);
        expect(lateReturned).toBe(false); // a flag-guarded cleanup returned here at once, with only the first step done
        release();
        await late;
        expect(log).toEqual(WHOLE);
        await first;
        expect(runs).toBe(1);
    });

    it('the budget stops the run mid-cleanup race: the run\'s `finally` and the exit both come after the whole cleanup', async () => {
        const log: string[] = [];
        const exits: { code: number; seen: string[] }[] = [];
        const { cleanup, release } = gated();
        const guard = createRunGuard({
            budgetMs: 40,
            cleanup: cleanup(log),
            onBudget: () => log.push('budget spent'),
            exit: (code: number) => exits.push({ code, seen: [...log] }),
        });
        // main() as capture.mjs has it: steps made of waits, a `finally` that waits for the cleanup
        const mainLike = async () => {
            try {
                await guard.sleep(10);
                log.push('step 1');
                // across the budget (40 ms): the stop lands in this wait, and the run wakes at ~100 ms, while the cleanup it started
                // is still waiting for the emulator to exit
                await guard.sleep(90);
                log.push('step 2 (must not happen)');
            } catch (e) {
                log.push(e instanceof BudgetStop ? 'run stopped at its checkpoint' : `run failed: ${(e as Error).message}`);
            } finally {
                await guard.done();
                log.push('run finally done');
            }
        };
        const running = mainLike();
        await vi.waitFor(() => expect(log).toContain('run stopped at its checkpoint'));
        await wait(20);
        // the run is in its `finally`, the cleanup is still waiting for the emulator: the run must not have gone on (and so not exited)
        expect(log).not.toContain('run finally done');
        release();
        await running;
        // the top level of capture.mjs: `await main(); process.exit(...)`: nothing may be left undone at this point
        expect(log).toEqual(['step 1', 'budget spent', 'phone put back', 'run stopped at its checkpoint', ...WHOLE.slice(1), 'run finally done']);
        await vi.waitFor(() => expect(exits).toHaveLength(1));
        // the budget's own exit, after the cleanup too, with code 2
        expect(exits[0].code).toBe(2);
        expect(exits[0].seen).toContain('report written');
    });

    it('does not let a failing note or a failing cleanup keep the process alive: the exit still comes, and the run\'s finally sees the failure', async () => {
        const exits: number[] = [];
        const guard = createRunGuard({
            budgetMs: 20,
            cleanup: async () => { await wait(10); throw new Error('rm failed'); },
            onBudget: () => { throw new Error('log failed'); },
            exit: (code: number) => exits.push(code),
        });
        await vi.waitFor(() => expect(exits).toEqual([2]));
        await expect(guard.done()).rejects.toThrow('rm failed');
    });
});

describe('createRunGuard: the budget', () => {
    it('lets the run go on while the budget lasts, and ends the time box when the run is done', async () => {
        const exits: number[] = [];
        let runs = 0;
        const guard = createRunGuard({ budgetMs: 300, cleanup: () => { runs++; }, exit: (code: number) => exits.push(code) });
        await guard.sleep(5);
        expect(() => guard.halt()).not.toThrow();
        expect(guard.stopped).toBe(false);
        await guard.done(); // finished well inside the budget
        await wait(350); // the budget would have been spent by now
        expect(exits).toEqual([]);
        expect(runs).toBe(1);
        expect(guard.stopped).toBe(false);
    });

    it('stops every checkpoint once the budget is spent: halt() and a sleep that ends after it', async () => {
        const guard = createRunGuard({ budgetMs: 20, cleanup: () => {}, exit: () => {} });
        await wait(50);
        expect(guard.stopped).toBe(true);
        expect(() => guard.halt()).toThrow(BudgetStop);
        await expect(guard.sleep(1)).rejects.toBeInstanceOf(BudgetStop);
    });
});

describe('capture.mjs uses it', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../capture.mjs'), 'utf8');

    it('has no flag-guarded cleanup, and its cleanup waits are the ones nothing cuts short', () => {
        expect(src).not.toMatch(/let cleaned\b/);
        expect(src).toContain('await runGuard.done()');
        const cleanup = src.slice(src.indexOf('const cleanup = async () => {'), src.indexOf('runGuard = createRunGuard('));
        expect(cleanup.length).toBeGreaterThan(100);
        expect(cleanup).not.toMatch(/\bsleep\(/);
        const teardown = src.slice(src.indexOf('async teardown() {'), src.indexOf('// ─── The iOS simulator'));
        expect(teardown).not.toMatch(/\bsleep\(/);
    });

    // A source check: main() needs an emulator to run, so the only way to see this from a test is the text of the explore block.
    it('--explore ends after its look: the block returns before the capture loop begins', () => {
        const from = src.indexOf('if (EXPLORE) {');
        const to = src.indexOf('for (const scheme of SCHEMES) {');
        expect(from).toBeGreaterThan(0);
        expect(to).toBeGreaterThan(from);
        const block = src.slice(from, to).trimEnd();
        // the block's last statement before its closing brace is a return (not a log line that falls through into the capture)
        expect(block).toMatch(/\breturn;[^\n]*\n\s*\}$/);
    });
});
