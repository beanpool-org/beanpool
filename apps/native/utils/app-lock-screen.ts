/**
 * What App Lock shows over the app, wherever the app draws: the root screen, each sheet screen and each pop-up (Modal).
 *
 * - 'lock': the lock screen, with its Unlock App button (app/_layout.tsx's launch lock, the return lock in
 *   utils/return-lock.ts).
 * - 'cover': a plain cover, while the app is out of the front with App Lock on: the phone's app switcher and recents
 *   show what the app last drew, so it draws nothing of the member's. Taken down when the return lock decides the app
 *   may show again, or replaced by the lock screen when it decides to lock.
 * - 'none': the app.
 *
 * One value for the whole app, not React state in the root layout: a pop-up and an iPhone sheet are each presented in
 * their own window, above the root view, so a lock screen drawn only at the root sat UNDER any pop-up left open
 * (FABLE-sec-native MEDIUM-1, 2026-10-01). Each of them now draws the lock screen inside itself
 * (components/AppLock.tsx), from this.
 */
import { useSyncExternalStore } from 'react';

export type AppLockScreen = 'none' | 'cover' | 'lock';

let screen: AppLockScreen = 'none';
const listeners = new Set<() => void>();
let unlock: (() => void) | null = null;
/** Whether app/_layout.tsx has decided the launch lock yet: until then the lock screen may be about to go up. */
let launchDecided = false;

function show(next: AppLockScreen): void {
    if (next === screen) return;
    screen = next;
    listeners.forEach((l) => l());
}

export function appLockScreen(): AppLockScreen {
    return screen;
}

/** The lock screen up, or down: down shows the app, whatever cover was up. */
export function setAppLocked(locked: boolean): void {
    show(locked ? 'lock' : 'none');
}

/** The cover up, or down. It never takes the lock screen down, and never goes up over it. */
export function setAppCovered(covered: boolean): void {
    if (covered && screen === 'none') show('cover');
    if (!covered && screen === 'cover') show('none');
}

export function subscribeAppLockScreen(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useAppLockScreen(): AppLockScreen {
    return useSyncExternalStore(subscribeAppLockScreen, appLockScreen, appLockScreen);
}

/** Set by app/_layout.tsx once the launch lock has been decided (locked, unlocked, or App Lock off). */
export function setAppLockLaunchDecided(): void {
    if (launchDecided) return;
    launchDecided = true;
    listeners.forEach((l) => l());
}

/**
 * Run `act` once, when the app itself shows: the launch lock decided, and neither the lock screen nor the cover up. At
 * once if it shows now. Returns a cancel.
 *
 * For a one-time notice raised as an Alert (the vault's "Is this you?", "Account recovery reported" in app/_layout.tsx):
 * an Alert can't be covered, and its buttons do nothing while the lock screen or cover shows (components/AppLock.tsx),
 * so one raised behind the lock had its Review button do nothing and was never raised again in that run (deciding
 * review of #1413, 2026-10-01). Marking the notice shown, and showing it, both wait for this.
 */
export function whenAppShows(act: () => void): () => void {
    const shows = () => launchDecided && screen === 'none';
    if (shows()) {
        act();
        return () => {};
    }
    let done = false;
    const unsubscribe = subscribeAppLockScreen(() => {
        if (done || !shows()) return;
        done = true;
        unsubscribe();
        act();
    });
    return () => {
        done = true;
        unsubscribe();
    };
}

/** What Unlock App does, wherever the lock screen is drawn: set by app/_layout.tsx. */
export function setAppUnlockAction(action: (() => void) | null): void {
    unlock = action;
}

export function askToUnlockApp(): void {
    unlock?.();
}
