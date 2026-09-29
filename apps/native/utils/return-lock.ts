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
 * How long after it opened one prompt that passed can cover time away: only the time away within this long of the prompt
 * opening counts as open, and the rest as away. The cover counts from the opening, not from the leave, so the part of a
 * prompt before the leave (an earlier absence or return included) uses it up first. A prompt's answer reaches the app
 * when the phone hands it over, not when the member gave it: Android 8-10 holds the PIN screen's result until BeanPool is
 * back in front, so a member who passes it and presses home during the moment it closes leaves a pass that arrives
 * whenever BeanPool is next opened, an hour later, by whoever has the phone. The app can't tell that pass from one given
 * just now.
 *
 * Two minutes, so such a pass opens the app only for whoever opens it within two minutes and 15 seconds of the prompt
 * opening (RETURN_LOCK_GRACE_MS on top). Long enough for the slowest prompts a member gives: Android's lock (AOSP
 * gatekeeper, ComputeRetryTimeout) makes the 5th and the 10th wrong PIN in a row wait 30 seconds each, so ten tries with
 * both waits come to about a minute and a half; iOS's first passcode wait, after the 4th wrong one, is a minute (Apple
 * Platform Security; the 5th brings five). A prompt longer than that is asked once more after it passes, as every prompt
 * of 15 seconds or more was before #1307: one more prompt, never a way in. A prompt that did not pass covers the whole
 * time it was open: it opens nothing, and the app stays behind the lock screen ('lock').
 */
export const PROMPT_COVER_MAX_MS = 120000;

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
 * - Otherwise, a prompt was open while the app was away and it did not pass, and the app was away 15 seconds or more:
 *   'lock', never 'ask'. A member can leave while the prompt is open (Android keeps its PIN screen over the app), and
 *   whoever cancels it later must not find the app open.
 * - Otherwise it passed: 'none'. Whoever is holding the phone just gave its lock, which is all the return lock would
 *   ask. But a pass reaches the app when the phone hands it over, which on Android 8-10 can be an hour after the member
 *   gave it (PROMPT_COVER_MAX_MS), so each prompt covers only the time away within PROMPT_COVER_MAX_MS of its opening:
 *   15 seconds or more away beyond that asks ('ask').
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
    const openWhileAway = (s: LocalAuthPromptStretch) => Math.max(0, Math.min(s.closedAt ?? activeAt, activeAt) - Math.max(s.openedAt, leftAt));
    const prompted = during.reduce((sum, s) => sum + openWhileAway(s), 0);
    if (away - prompted >= RETURN_LOCK_GRACE_MS) return 'ask';
    if (!passed) return away >= RETURN_LOCK_GRACE_MS ? 'lock' : 'none';
    // A prompt's cover counts from when it opened, not from the leave (PROMPT_COVER_MAX_MS).
    const covered = during.reduce((sum, s) => sum + Math.min(openWhileAway(s), Math.max(0, PROMPT_COVER_MAX_MS - Math.max(0, leftAt - s.openedAt))), 0);
    return away - covered >= RETURN_LOCK_GRACE_MS ? 'ask' : 'none';
}

/**
 * The returns ('active' with an account on the phone) the return lock has seen, and the last of them it kept the lock
 * screen up for. A pass to a prompt opened before that return doesn't take the lock screen down for its opener: see
 * unlockWithPhoneLock.
 */
let returnsSeen = 0;
let lockedForReturn = 0;

/**
 * The phone's lock, asked to take App Lock's lock screen down: the launch lock and the Unlock App button (app/_layout.tsx),
 * and the return lock's own prompt. True when the prompt passed and the return lock has not, since the prompt opened, kept
 * the lock screen up for a return: a prompt that was open across that return passed too late to count (a pass held while
 * the app was away, PROMPT_COVER_MAX_MS). Without this, the pass that closed such a prompt took the lock screen down
 * behind the return lock's next prompt when the app's return came before the answer, and cancelling that prompt left the
 * app open. Whichever of the pass and the return lock's decision comes first, this pass doesn't take the lock screen down.
 * The return lock's own takedown, for a later return, follows its rule instead (returnLockAction): after a leave, a pass
 * opens the app only for a return within PROMPT_COVER_MAX_MS and RETURN_LOCK_GRACE_MS (2 min 15 s) of the prompt opening.
 */
export async function unlockWithPhoneLock(reason: string): Promise<boolean> {
    const openedAtReturn = returnsSeen;
    const passed = await authenticateUser(reason);
    return passed && lockedForReturn <= openedAtReturn;
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
 * it put it up for a prompt that then passed. Once it keeps the lock screen up for a return, a prompt opened before that
 * return never takes it down through its opener (unlockWithPhoneLock), and through the listener only for a later return
 * the rule answers 'none' for: after a leave, one within 2 min 15 s of the prompt opening (PROMPT_COVER_MAX_MS).
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
        const thisReturn = ++returnsSeen;
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
        lockedForReturn = Math.max(lockedForReturn, thisReturn);
        setLocked(true);
        // The app left again while this was deciding: locked, and Unlock App asks. A prompt is open: it isn't asked twice.
        if (action !== 'ask' || change !== changes || isLocalAuthPromptOpen()) return;
        if (await unlockWithPhoneLock('Unlock BeanPool')) setLocked(false);
    };
}
