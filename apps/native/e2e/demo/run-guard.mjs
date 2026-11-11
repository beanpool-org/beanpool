/* global process, setTimeout, clearTimeout */
/**
 * A capture run's time box and its ONE cleanup (capture.mjs; PR #2998, round 2).
 *
 * The budget's stop and the run's own `finally` both clean up, and they arrive together: the stop tears the phone down (and
 * kills the emulator), the run's next adb call fails, and its `finally` asks for the cleanup while the stop's is still waiting
 * for the emulator to exit. A cleanup guarded by a flag lets that second caller return at once, and the run's `process.exit`
 * then cuts the first one off before Metro (detached, it keeps its port) and the demo node are killed, the temp folders are
 * removed and the report is written. So the cleanup is ONE promise that every caller waits for.
 *
 * And once the budget is spent the run must not touch the phone again: `halt()` throws at the run's next checkpoint (every
 * `sleep` is one), so it cannot relaunch the app or take a picture, after the screen size was put back, over a good raw one.
 */

/** Thrown at a checkpoint once the budget is spent. */
export class BudgetStop extends Error {
    constructor(message = 'the budget is spent') {
        super(message);
        this.name = 'BudgetStop';
    }
}

/**
 * @param {object} opts
 * @param {number} opts.budgetMs   the time the run is given
 * @param {() => Promise<void>|void} opts.cleanup   put everything back (called at most once, however many ask)
 * @param {() => void} [opts.onBudget]   called when the budget is spent, before the cleanup (log, note it in the report)
 * @param {(code: number) => void} [opts.exit]   how the run ends after a budget stop (the process exits with 2)
 */
export function createRunGuard({ budgetMs, cleanup, onBudget = () => {}, exit = (code) => process.exit(code) }) {
    let stopped = false;
    let cleaning = null;
    /** The cleanup: started by whoever asks first, awaited by everyone who asks. */
    const finish = () => (cleaning ??= (async () => cleanup())());
    const timer = setTimeout(async () => {
        stopped = true; // first, so the run's next checkpoint already refuses
        try { onBudget(); } catch { /* a note that cannot be written must not stop the cleanup */ }
        // A cleanup that fails is seen by the run's own `finally`, which waits for this same promise.
        try { await finish(); } catch { /* seen there */ }
        exit(2);
    }, budgetMs);
    return {
        get stopped() { return stopped; },
        /** A checkpoint: throws once the budget is spent. */
        halt() { if (stopped) throw new BudgetStop(); },
        /** A wait that is also a checkpoint: it ends in a BudgetStop if the budget ran out while the run slept. */
        async sleep(ms) {
            await new Promise((resolve) => setTimeout(resolve, ms));
            if (stopped) throw new BudgetStop();
        },
        /** The run is over (finished, failed or stopped): end the time box, and wait for the one cleanup. */
        done() {
            clearTimeout(timer);
            return finish();
        },
    };
}
