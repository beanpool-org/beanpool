/**
 * The two one-time security notices raised as an Alert wait for the app to show before they are marked shown and raised
 * (utils/app-lock-screen.ts `whenAppShows`, app/_layout.tsx).
 *
 * Found by the deciding review of #1413, 2026-10-01 (NON-BLOCKING): BeanPool's key vault "Is this you?" and "Account
 * recovery reported" are asked at launch and on return, the moment App Lock's lock screen goes up. Each was marked shown
 * and raised at once: the Alert sat over the lock screen, its Review button did nothing (Alert buttons wait for the
 * unlock, components/AppLock.tsx), and it never came back in that run. A sign-in restore the member never reviewed went
 * through after its wait. Now both wait until the launch lock is decided and neither the lock screen nor the cover shows.
 *
 * The Alert is driven through the app's own lock-aware wrapper (lockAwareAlert); the notice's "shown once" mark is a
 * stand-in with takeHoldsToShow's semantics (utils/vault.ts), and app/_layout.tsx is pinned to mark inside the wait.
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    StyleSheet: { create: <T,>(s: T) => s, absoluteFillObject: { position: 'absolute' } },
    View: () => null,
    Text: () => null,
    Pressable: () => null,
}));
vi.mock('../../app/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));

import { lockAwareAlert } from '../../components/AppLock';
import { appLockScreen, setAppCovered, setAppLocked, setAppLockLaunchDecided, whenAppShows } from '../app-lock-screen';

type AlertButton = { text?: string; onPress?: () => void };

/** The phone's Alert: remembers what was raised, and lets a test tap a button. */
function phoneAlert() {
    const raised: Array<{ title: string; buttons: AlertButton[] }> = [];
    const native = (title: string, _message?: string, buttons?: AlertButton[]) => { raised.push({ title, buttons: buttons ?? [] }); };
    // The app calls it with react-native's AlertButton (text, style, onPress); the wrapper only needs onPress.
    const alert = lockAwareAlert(native) as unknown as (title: string, message?: string, buttons?: AlertButton[]) => void;
    const tap = (title: string, text: string) => raised.find((a) => a.title === title)?.buttons.find((b) => b.text === text)?.onPress?.();
    return { raised, alert, tap };
}

/** A one-time notice the way app/_layout.tsx raises them: marked shown, and raised, inside whenAppShows. */
function notice(alert: ReturnType<typeof phoneAlert>['alert'], shownOnce: Set<string>, id: string, review: () => void) {
    return whenAppShows(() => {
        if (shownOnce.has(id)) return;
        shownOnce.add(id);
        alert('Is this you?', 'Someone used a linked sign-in…', [{ text: 'Not now' }, { text: 'Review', onPress: review }]);
    });
}

describe('whenAppShows', () => {
    afterEach(() => {
        setAppLocked(false);
    });

    it('waits for the launch lock to be decided, then runs once', () => {
        const act = vi.fn();
        whenAppShows(act);
        expect(appLockScreen()).toBe('none');
        expect(act).not.toHaveBeenCalled();
        setAppLockLaunchDecided();
        expect(act).toHaveBeenCalledTimes(1);
        setAppLocked(true);
        setAppLocked(false);
        expect(act).toHaveBeenCalledTimes(1);
    });

    it('runs at once while the app shows', () => {
        setAppLockLaunchDecided();
        const act = vi.fn();
        whenAppShows(act);
        expect(act).toHaveBeenCalledTimes(1);
    });

    it('while the lock screen shows: waits for the unlock', () => {
        setAppLockLaunchDecided();
        setAppLocked(true);
        const act = vi.fn();
        whenAppShows(act);
        expect(act).not.toHaveBeenCalled();
        setAppLocked(false);
        expect(act).toHaveBeenCalledTimes(1);
    });

    it('while the cover shows (a return being decided): waits through the lock screen too', () => {
        setAppLockLaunchDecided();
        setAppCovered(true);
        const act = vi.fn();
        whenAppShows(act);
        setAppLocked(true); // the return lock decides to lock
        expect(act).not.toHaveBeenCalled();
        setAppLocked(false);
        expect(act).toHaveBeenCalledTimes(1);
    });

    it('a cancelled wait never runs', () => {
        setAppLockLaunchDecided();
        setAppLocked(true);
        const act = vi.fn();
        const cancel = whenAppShows(act);
        cancel();
        setAppLocked(false);
        expect(act).not.toHaveBeenCalled();
    });
});

describe('a notice that arrives while the lock screen is up', () => {
    beforeAll(() => setAppLockLaunchDecided());
    afterEach(() => setAppLocked(false));

    it('"Is this you?": not marked nor raised behind the lock; after the unlock it is raised once and Review works', () => {
        const { raised, alert, tap } = phoneAlert();
        const shownOnce = new Set<string>();
        const review = vi.fn();
        setAppLocked(true);
        notice(alert, shownOnce, 'hold_1', review);
        notice(alert, shownOnce, 'hold_1', review); // asked again on the next return: still one alert
        expect(shownOnce.has('hold_1')).toBe(false);
        expect(raised).toHaveLength(0);

        setAppLocked(false);
        expect(shownOnce.has('hold_1')).toBe(true);
        expect(raised).toHaveLength(1);
        tap('Is this you?', 'Review');
        expect(review).toHaveBeenCalledTimes(1);
    });

    it('raised at once behind the lock (the old way), Review did nothing: the failure this fixes', () => {
        const { alert, tap } = phoneAlert();
        const review = vi.fn();
        setAppLocked(true);
        alert('Is this you?', '…', [{ text: 'Review', onPress: review }]);
        tap('Is this you?', 'Review');
        expect(review).not.toHaveBeenCalled();
    });
});

describe('app/_layout.tsx', () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it('decides the launch lock before any notice may show', () => {
        expect(layout()).toMatch(/setAppLockChecked\(true\);\s*setAppLockLaunchDecided\(\);/);
    });

    it('"Is this you?" marks its hold shown, and raises it, inside whenAppShows', () => {
        const s = layout();
        expect(s).toMatch(/waits\.add\(whenAppShows\(\(\) => \{\s*if \(!current \|\| takeHoldsToShow\(holds\)\.length === 0\) return;[\s\S]{0,400}?Alert\.alert\(\s*'Is this you\?'/);
        expect(s.match(/takeHoldsToShow\(/g)).toHaveLength(1);
        expect(s).toMatch(/waits\.forEach\(\(cancel\) => cancel\(\)\);/);
    });

    it('"Account recovery reported" is marked, and raised, inside whenAppShows, and its wait goes when recovery does', () => {
        const s = layout();
        expect(s).toMatch(/const cancel = whenAppShows\(\(\) => \{[\s\S]{0,200}?recoveryNavPrompted\.current = true;\s*Alert\.alert\(\s*'Account recovery reported'/);
        expect(s.match(/recoveryNavPrompted\.current = true;/g)).toHaveLength(1);
        expect(s).toMatch(/if \(recognition !== 'recovering'\) \{\s*recoveryNavPrompted\.current = false;\s*recoveryPromptWait\.current\?\.\(\);/);
    });
});
