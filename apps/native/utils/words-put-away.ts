import { useEffect } from 'react';
import { AppState } from 'react-native';
import { localAuthPromptStretches } from './LocalAuth';
import { appLockNow, clockReadFailures, wallClockSetBacks } from './app-lock-clock';
import { returnLockAction } from './return-lock';

/**
 * An account's 12 words, once on screen behind the phone's lock, put away when the member comes back to the app after
 * 15 seconds or more away, App Lock on or off (#1311's deciding review, 2026-09-29).
 *
 * The screens already put them away on Hide and when the member leaves the step, the section or the tab. But a member
 * who pressed home with the words showing left them there for whoever next opened BeanPool on the unlocked phone: App
 * Lock's lock screen comes up over them after 15 seconds away, and with App Lock off nothing did. Now the next Show asks
 * the phone's lock again after such an absence, whatever App Lock is set to.
 *
 * Away is as the return lock has it (returnLockAction), on App Lock's clock: 15 seconds or more with no prompt of the
 * phone's lock open, and times that can't be trusted (the since-boot clock could not be read, or the wall clock was seen
 * going backwards, since the leave) count as that. The watch starts once the words are on screen, so the leave of the
 * prompt that showed them (the prompt takes the app out of the front) isn't one. On iOS, inactive then background is one
 * leave, timed from the first.
 */
export function wordsLeaveWatcher(putAway: () => void): (next: string) => void {
    let leftAt: number | null = null;
    let setBacksAtLeave = 0;
    let failuresAtLeave = 0;
    return (next) => {
        if (next === 'background' || next === 'inactive') {
            if (leftAt !== null) return;
            leftAt = appLockNow();
            setBacksAtLeave = wallClockSetBacks();
            failuresAtLeave = clockReadFailures();
            return;
        }
        if (next !== 'active' || leftAt === null) return;
        const from = leftAt;
        leftAt = null;
        const activeAt = appLockNow();
        const clockUntrusted = wallClockSetBacks() !== setBacksAtLeave || clockReadFailures() !== failuresAtLeave;
        if (returnLockAction(from, activeAt, localAuthPromptStretches(), clockUntrusted) !== 'none') putAway();
    };
}

/**
 * While `shown`, the screen's words are put away by `putAway` (the screen's own, which moves its turn on, so a check
 * still answering shows nothing) after the app has been left for 15 seconds or more: wordsLeaveWatcher. `putAway` keeps
 * its identity across renders (useCallback).
 */
export function usePutAwayAfterLeave(shown: boolean, putAway: () => void): void {
    useEffect(() => {
        if (!shown) return;
        const sub = AppState.addEventListener('change', wordsLeaveWatcher(putAway));
        return () => sub.remove();
    }, [shown, putAway]);
}
