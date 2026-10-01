/**
 * With App Lock on, the app covers itself as it leaves the front, and an App Lock setting that can't be read locks
 * (utils/return-lock.ts, utils/LocalAuth.ts `appLockLocks`, utils/app-lock-screen.ts).
 *
 * Found by FABLE-sec-native, 2026-10-01:
 * - LOW-4: the phone's app switcher and recents show the screen the app drew as it left. A member with App Lock on who
 *   left BeanPool on a chat or their Beans showed it to whoever held the unlocked phone, and App Lock never ran for that.
 *   Now the cover goes up the moment the app leaves (the same AppState change, before anything is awaited: the phone
 *   takes its picture straight after), stays while the return is decided, and gives way to the app or the lock screen.
 *   Every screen and pop-up draws it (app-lock-covers-pop-ups.test.ts).
 * - LOW-2: a setting that couldn't be read read as off, so a keychain briefly unavailable after a restart showed the app
 *   unlocked for that launch. Now the launch lock and the return lock lock on it; Settings' switch still shows off.
 *
 * The return lock is driven the way AppState drives it, with the phone's prompt mocked at expo-local-authentication and
 * time faked, as in return-lock.test.ts. What is drawn is the app-wide value every surface draws from.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const phone = vi.hoisted(() => ({
    appLock: 'true' as string | null,
    appLockUnreadable: false,
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => {
        if (key !== 'beanpool_app_lock_enabled') return null;
        if (phone.appLockUnreadable) throw new Error('Keystore unavailable');
        return phone.appLock;
    }),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined), removeItem: vi.fn(async () => undefined) },
}));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

type Answer = { success: boolean; error?: string };
type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };

const SEC = 1000;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

/** A phone with a PIN and an account, BeanPool open on it (its launch read of App Lock made), and the return lock listening. */
async function phoneWithBeanPoolOpen() {
    vi.resetModules();
    const bootBase = Date.now() - performance.now();
    (globalThis as ExpoGlobalForTests).expo = { modules: { BeanPoolBootClock: { elapsedMs: () => bootBase + performance.now() } } };
    const LA = await import('expo-local-authentication');
    const LocalAuth = await import('../LocalAuth');
    const ReturnLock = await import('../return-lock');
    const Screen = await import('../app-lock-screen');

    const open: Array<(answer: Answer) => void> = [];
    vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
    vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
    vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
    vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise<Answer>(resolve => open.push(resolve)) as never);

    // app/_layout.tsx's launch read, before anything leaves.
    const launchLocks = await LocalAuth.appLockLocks();
    const onChange = ReturnLock.createReturnLock(Screen.setAppLocked, Screen.setAppCovered);
    return {
        LocalAuth,
        launchLocks,
        change(next: 'active' | 'background' | 'inactive', hasIdentity = true) {
            void onChange(next, hasIdentity);
        },
        wait(ms: number) {
            vi.advanceTimersByTime(ms);
        },
        shows: () => Screen.appLockScreen(),
        prompts: () => vi.mocked(LA.authenticateAsync).mock.calls.length,
        answer(passes: boolean) {
            const resolve = open.shift();
            expect(resolve, 'no prompt is open to answer').toBeDefined();
            resolve!(passes ? { success: true } : { success: false, error: 'user_cancel' });
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(new Date('2026-10-01T09:00:00Z'));
    phone.appLock = 'true';
    phone.appLockUnreadable = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    delete (globalThis as ExpoGlobalForTests).expo;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('the app switcher sees a cover, never the member\'s screen, with App Lock on', () => {
    it.each(['inactive', 'background'] as const)('it goes up as the app goes %s, before anything is awaited', async (leave) => {
        const p = await phoneWithBeanPoolOpen();
        expect(p.shows()).toBe('none');

        p.change(leave);

        // Synchronously: the phone takes its picture straight after the app leaves.
        expect(p.shows()).toBe('cover');
    });

    it('back within 15 seconds: the cover comes down once the return is decided, and nothing is asked', async () => {
        const p = await phoneWithBeanPoolOpen();
        p.change('inactive');
        p.change('background');
        p.wait(5 * SEC);
        p.change('active');

        expect(p.shows()).toBe('cover');
        await flush();
        expect(p.shows()).toBe('none');
        expect(p.prompts()).toBe(0);
    });

    it('back after 15 seconds or more: the lock screen takes the cover\'s place, never the app in between', async () => {
        const p = await phoneWithBeanPoolOpen();
        p.change('background');
        p.wait(60 * SEC);
        p.change('active');

        const seen: string[] = [p.shows()];
        for (let i = 0; i < 5; i++) {
            await flush();
            seen.push(p.shows());
        }
        expect(seen).not.toContain('none');
        expect(p.shows()).toBe('lock');
        expect(p.prompts()).toBe(1);

        p.answer(true);
        await flush();
        await flush();
        expect(p.shows()).toBe('none');
    });

    it('a cancelled prompt leaves the lock screen, not the cover and not the app', async () => {
        const p = await phoneWithBeanPoolOpen();
        p.change('background');
        p.wait(60 * SEC);
        p.change('active');
        await flush();
        await flush();

        p.answer(false);
        await flush();
        await flush();
        expect(p.shows()).toBe('lock');
    });

    it('gone again while the return is decided: the cover stays for that leave', async () => {
        const p = await phoneWithBeanPoolOpen();
        p.change('background');
        p.wait(5 * SEC);
        p.change('active');
        p.change('background');
        await flush();
        await flush();

        expect(p.shows()).toBe('cover');
    });

    it('App Lock off: no cover, and the app shows on return', async () => {
        phone.appLock = 'false';
        const p = await phoneWithBeanPoolOpen();
        p.change('inactive');
        expect(p.shows()).toBe('none');
        p.wait(60 * SEC);
        p.change('active');
        await flush();
        expect(p.shows()).toBe('none');
    });

    it('turned on in Settings during this run: the next leave is covered without another read', async () => {
        phone.appLock = 'false';
        const p = await phoneWithBeanPoolOpen();
        await p.LocalAuth.setAppLockEnabled(true);

        p.change('inactive');
        expect(p.shows()).toBe('cover');
    });

    it('no account on the phone: nothing to cover', async () => {
        const p = await phoneWithBeanPoolOpen();
        p.change('background', false);
        expect(p.shows()).toBe('none');
    });
});

describe("an App Lock setting that can't be read locks, and asks the phone's lock", () => {
    it('the launch lock reads it as on; Settings\' switch still shows it off', async () => {
        phone.appLockUnreadable = true;
        const p = await phoneWithBeanPoolOpen();

        expect(p.launchLocks).toBe(true);
        expect(await p.LocalAuth.getAppLockEnabled()).toBe(false);
    });

    it('a return after 15 seconds or more locks and asks, where it used to show the app', async () => {
        phone.appLock = 'false';
        const p = await phoneWithBeanPoolOpen();
        phone.appLockUnreadable = true;
        p.change('background');
        p.wait(60 * SEC);
        p.change('active');
        await flush();
        await flush();

        expect(p.shows()).toBe('lock');
        expect(p.prompts()).toBe(1);
    });

    it('read again once the keychain answers: off is off', async () => {
        phone.appLockUnreadable = true;
        const p = await phoneWithBeanPoolOpen();
        phone.appLockUnreadable = false;
        phone.appLock = 'false';

        expect(await p.LocalAuth.appLockLocks()).toBe(false);
        expect(p.LocalAuth.appLockWasOn()).toBe(false);
    });
});
