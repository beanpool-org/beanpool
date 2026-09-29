import {
    authenticateUser,
    getAppLockEnabled,
    isLocalAuthPromptOpen,
    localAuthPromptStretches,
    whenLocalAuthPromptsClose,
    type LocalAuthPromptStretch,
} from './LocalAuth';
import { appLockNow, clockReadFailures, wallClockSetBacks } from './app-lock-clock';

/** App Lock asks again when the member comes back after this long away. */
export const RETURN_LOCK_GRACE_MS = 15000;

/**
 * How long the return lock waits, when the app is back in front while a prompt is still open, for that prompt to close.
 * The prompt's answer and the app's return arrive within moments of each other on both platforms, in either order. After
 * 15 seconds or more away the lock screen is already up while it waits, so this only bounds how late a passing answer can
 * come and still open the app without a second prompt; one that never comes leaves the lock screen up.
 */
export const PROMPT_SETTLE_MS = 10000;

/**
 * What the return lock does when the app is back in front:
 * - 'ask': lock the app and ask the phone's lock, as it always has after 15 seconds away.
 * - 'lock': lock the app and leave the asking to its Unlock App button: the phone's lock was asked while the app was
 *   away and did not pass, so the app is not shown, and the member who just cancelled is not asked again straight away.
 * - 'none'.
 */
export type ReturnLockAction = 'none' | 'lock' | 'ask';

/**
 * The return lock's rule.
 *
 * The phone's own lock prompt takes the app out of the front while it is open (Android 8-10's PIN screen backgrounds it,
 * iOS's passcode prompt makes it inactive), so a prompt of 15 seconds or more used to look like 15 seconds away and bring
 * a second prompt as soon as the first one closed. Time a prompt was open is not time away:
 * - Away with no prompt open for 15 seconds or more (the member switched app or locked the phone): 'ask', as before.
 * - Otherwise, a prompt was open while the app was away and it passed: 'none'. Whoever is holding the phone just gave
 *   its lock, which is all the return lock would ask.
 * - It did not pass, and the app was away 15 seconds or more: 'lock', never 'ask'. A member can leave while the prompt
 *   is open (Android keeps its PIN screen over the app), and whoever cancels it later must not find the app open.
 * - Before all of these: times that ran backwards, or that aren't times, can't say how long the app was away, so they
 *   count as 15 seconds or more away with no prompt open: 'ask'. On the phone's since-boot clock that is a restart while
 *   away (it starts again from zero); clockUntrusted says the wall clock was seen going backwards, or the since-boot
 *   clock could not be read, since the leave (utils/app-lock-clock.ts); in the web build, which has only the wall clock,
 *   a return or a prompt's close that reads earlier than the moment before it; and a leave or a return that is not a
 *   finite number (NaN: App Lock's clock could not be read then). A prompt stretch with a time that isn't a finite
 *   number covers none of the time away.
 *
 * leftAt is when the app last left the front (null: no leave seen, the first return after a launch in the background,
 * which asks as before); activeAt is when it came back. Every time here is on App Lock's clock (appLockNow), as the
 * stretches' are. A prompt still open (closedAt null) counts as open until activeAt and as not passed, whatever its
 * passed says: only the answer that closes a stretch counts.
 */
export function returnLockAction(
    leftAt: number | null,
    activeAt: number,
    stretches: readonly LocalAuthPromptStretch[],
    clockUntrusted = false,
): ReturnLockAction {
    // NaN >= RETURN_LOCK_GRACE_MS is false: a time that isn't one would otherwise read as no time away.
    if (!Number.isFinite(activeAt) || (leftAt !== null && !Number.isFinite(leftAt))) return 'ask';
    const from = leftAt ?? activeAt;
    const ranBackwards = activeAt < from || stretches.some(s => s.openedAt >= from && s.closedAt !== null && s.closedAt < s.openedAt);
    if (clockUntrusted || ranBackwards) return 'ask';
    const readable = (s: LocalAuthPromptStretch) => Number.isFinite(s.openedAt) && (s.closedAt === null || Number.isFinite(s.closedAt));
    const during = stretches.filter(s => readable(s) && s.openedAt <= activeAt && (s.closedAt === null || s.closedAt >= from));
    const passed = during.every(s => s.closedAt !== null && s.passed);
    if (leftAt === null) {
        if (during.length === 0) return 'ask';
        return passed ? 'none' : 'lock';
    }
    const away = activeAt - leftAt;
    if (during.length === 0) return away >= RETURN_LOCK_GRACE_MS ? 'ask' : 'none';
    // Stretches never overlap each other (overlapping prompts make one), so their clipped lengths add up.
    const prompted = during.reduce((sum, s) => sum + Math.max(0, Math.min(s.closedAt ?? activeAt, activeAt) - Math.max(s.openedAt, leftAt)), 0);
    if (away - prompted >= RETURN_LOCK_GRACE_MS) return 'ask';
    if (!passed && away >= RETURN_LOCK_GRACE_MS) return 'lock';
    return 'none';
}

/** Resolves when no prompt is open, or after PROMPT_SETTLE_MS. */
function promptsSettled(): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, PROMPT_SETTLE_MS);
        whenLocalAuthPromptsClose().then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/**
 * App Lock's return lock, as app/_layout.tsx listens to AppState with it: returns the listener, which keeps when the app
 * last left the front. Pass it every AppState change and whether there is an account on the phone.
 *
 * When the app is back in front while a prompt is still open (the AppState change can arrive before or after the
 * prompt's answer), it waits for the prompt to close before deciding. When the rule would lock if that prompt did not
 * pass (15 seconds or more away, no leave seen, or times that ran backwards) it puts the lock screen up first, so the app
 * is never shown unlocked while it waits, and takes it down after only if the rule then says 'none': the answer that
 * closed the prompt passed. It never opens a prompt while one is open: the launch lock's, its own or the Unlock App
 * button's. setLocked(true) puts the lock screen up; the listener takes it down only when its own prompt passes, or when
 * it put it up for a prompt that then passed.
 *
 * Times are read on App Lock's clock (utils/app-lock-clock.ts), which setting the phone's date and time can't move. A
 * phone that can't read it asks after every leave.
 */
export function createReturnLock(setLocked: (locked: boolean) => void): (next: string, hasIdentity: boolean) => Promise<void> {
    let leftAt: number | null = null;
    let setBacksAtLeave = 0;
    let failuresAtLeave = 0;
    let changes = 0;
    return async (next, hasIdentity) => {
        const change = ++changes;
        if (next === 'background' || next === 'inactive') {
            leftAt = appLockNow();
            setBacksAtLeave = wallClockSetBacks();
            failuresAtLeave = clockReadFailures();
            return;
        }
        if (next !== 'active' || !hasIdentity) return;
        const activeAt = appLockNow();
        const from = leftAt;
        const setBacksFrom = setBacksAtLeave;
        const failuresFrom = failuresAtLeave;
        leftAt = null;
        // Whether the wall clock was seen going backwards, or App Lock's clock could not be read (the return's own reading
        // included), since the app left; a leave that could not be read is NaN, which the rule asks for. Asked again after
        // the wait: the prompt's answer reads the clock too.
        const clockUntrusted = () => from !== null && (wallClockSetBacks() !== setBacksFrom || clockReadFailures() !== failuresFrom);
        let raised = false;
        if (isLocalAuthPromptOpen()) {
            // The rule counts the open prompt as not passed: if that locks, up now, not after the wait, in case the answer
            // is slow or never comes.
            const ifNotPassed = returnLockAction(from, activeAt, localAuthPromptStretches(), clockUntrusted());
            if (ifNotPassed !== 'none' && (await getAppLockEnabled())) {
                setLocked(true);
                raised = true;
            }
            await promptsSettled();
        }
        const action = returnLockAction(from, activeAt, localAuthPromptStretches(), clockUntrusted());
        if (action === 'none') {
            // The prompt passed: whoever is holding the phone just gave its lock. Unless the app has left again since.
            if (raised && change === changes) setLocked(false);
            return;
        }
        if (!raised && !(await getAppLockEnabled())) return;
        setLocked(true);
        // The app left again while this was deciding: locked, and Unlock App asks. A prompt is open: it isn't asked twice.
        if (action !== 'ask' || change !== changes || isLocalAuthPromptOpen()) return;
        if (await authenticateUser('Unlock BeanPool')) setLocked(false);
    };
}
