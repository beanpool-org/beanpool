/**
 * App Lock asks once: the return lock (utils/return-lock.ts, app/_layout.tsx's AppState listener) and the prompt marker
 * it reads (LocalAuth.phoneLockPrompt, which authenticateUser and node-admin's requireDeviceUnlock both open through).
 *
 * Found by #1290's deciding review, 2026-09-29. The phone's own lock prompt takes the app out of the front while it is
 * open: Android 8-10's PIN screen backgrounds it, iOS's passcode prompt makes it inactive. The return lock read that as
 * the member leaving, so a prompt that took 15 seconds or more (five wrong PINs on Android bring a 30-second wait) was
 * followed, the moment it closed, by a second prompt. Any prompt did it: App Lock's own, the launch lock's, Unlock App's,
 * every "behind the phone lock" door (View Recovery Phrase, pairing a computer, linking a sign-in, taking the account
 * off the phone), and the fail-closed gate in front of Manage community, sign in on a computer and take over with this
 * phone (requireDeviceUnlock).
 *
 * - Time a prompt was open is not time away. A prompt that passed brings nothing more, whichever order the app's return
 *   and the prompt's answer arrive in.
 * - A real leave (no prompt open) of 15 seconds or more still locks and asks once; under 15 seconds it doesn't.
 * - A prompt that did not pass after the app was away 15 seconds or more leaves the app locked, and asks nothing more:
 *   Unlock App asks. A member can leave while the prompt is open, and whoever cancels it later must not find the app open.
 * - The return lock never opens a prompt while one is open.
 * - Back after 15 seconds or more while a prompt is still open, the lock screen is up at once, before the answer: the app
 *   is never shown unlocked while the return lock waits. A pass takes it down with no second prompt.
 * - The time away is the phone's since-boot clock's (utils/app-lock-clock.ts), not the wall clock's: whoever holds an
 *   unlocked phone could set the wall clock back and come back to an open app (#1307's confirmation review, 2026-09-29).
 * - A phone whose since-boot clock can't be read asks after every leave: the wall clock is App Lock's clock only in the web
 *   build (#1309's deciding review, inline 4129453720, 2026-09-29).
 * - One prompt that passed covers at most PROMPT_COVER_MAX_MS (two minutes) of the time away: Android 8-10 holds a pass
 *   given just before the member pressed home until BeanPool is next opened, by whoever has the phone (a cold check of
 *   #1309, 2026-09-29). A prompt opened before a return the return lock locked for can't take the lock screen down
 *   (unlockWithPhoneLock): its pass arrived too late to count.
 *
 * Screens can't be rendered here (see vitest.config.ts): the listener is driven the way AppState drives it, with the
 * phone's prompt mocked at expo-local-authentication and time faked. The since-boot clock is a fake native module on
 * globalThis.expo.modules, where the app reads it, counting with the faked timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const phoneState = vi.hoisted(() => ({
    appLock: 'true' as string | null,
    appLockRead: null as null | (() => Promise<string | null>),
    /** Platform.OS. */
    os: 'android' as string,
    /** Whether the app has the phone's since-boot clock (modules/boot-clock). false: the web build, an old dev client. */
    bootClock: true,
    /** What the since-boot clock reads when the phone is set up. null: what the wall clock reads. */
    bootClockStart: null as number | null,
    /** The since-boot clock reads bootBase + performance.now(). */
    bootBase: 0,
    /** While set, the since-boot clock's elapsedMs answers this instead (throws, or answers something not a time). */
    bootClockFault: null as null | (() => unknown),
}));

vi.mock('react-native', () => ({ Platform: { get OS() { return phoneState.os; } } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('expo-secure-store', () => ({
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
    getItemAsync: vi.fn(async (key: string) => {
        if (key !== 'beanpool_app_lock_enabled') return null;
        return phoneState.appLockRead ? phoneState.appLockRead() : phoneState.appLock;
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

type AppStateStatus = 'active' | 'background' | 'inactive';
type Answer = { success: boolean; error?: string };

const SEC = 1000;
const START = new Date('2026-09-29T09:00:00Z');
// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const ACCOUNT = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kim', createdAt: '', mnemonic: WORDS };
const VIEW_RECOVERY_PHRASE = 'Confirm your security to view your recovery phrase.';
const MANAGE_COMMUNITY = "Confirm it's you to manage Mullum";

/** Every promise chain the listener and the prompt start has run. setImmediate is left real for this. */
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

type ExpoGlobalForTests = { expo?: { modules: Record<string, { elapsedMs(): number }> } };

/**
 * A phone with a PIN and App Lock on, BeanPool open on it with an account, and the return lock listening. Fresh modules
 * each time: the prompt marker is module state.
 */
async function phoneWithAppLock() {
    vi.resetModules();
    // The phone's since-boot clock (modules/boot-clock), where the app reads it. It counts with the faked timers
    // (performance.now), and setting the wall clock (vi.setSystemTime) doesn't move it. Unless bootClockStart says otherwise
    // it starts out reading what the wall clock reads, so every time reads the same on either until someone moves the wall
    // clock. On a phone the two differ by decades: bootClockStart.
    phoneState.bootBase = (phoneState.bootClockStart ?? Date.now()) - performance.now();
    if (phoneState.bootClock) {
        (globalThis as ExpoGlobalForTests).expo = {
            modules: {
                BeanPoolBootClock: {
                    elapsedMs: () => (phoneState.bootClockFault ? phoneState.bootClockFault() : phoneState.bootBase + performance.now()) as number,
                },
            },
        };
    }
    const LA = await import('expo-local-authentication');
    const LocalAuth = await import('../LocalAuth');
    const ReturnLock = await import('../return-lock');
    const { readWordsBehindLock } = await import('../words-behind-lock');
    const { requireDeviceUnlock } = await import('../node-admin');

    const open: Array<(answer: Answer) => void> = [];
    vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.SECRET);
    vi.mocked(LA.hasHardwareAsync).mockResolvedValue(false);
    vi.mocked(LA.isEnrolledAsync).mockResolvedValue(false);
    vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise<Answer>(resolve => open.push(resolve)) as never);

    let locked = false;
    const setLocked = (v: boolean) => { locked = v; };
    const onChange = ReturnLock.createReturnLock(setLocked);

    return {
        LocalAuth,
        ReturnLock,
        /** An AppState change. AppState doesn't wait for its listeners, so neither does this. */
        change(next: AppStateStatus, hasIdentity = true) {
            void onChange(next, hasIdentity);
        },
        wait(ms: number) {
            vi.advanceTimersByTime(ms);
        },
        /** Someone moves the phone's date and time in its Settings (automatic time off): the wall clock only. */
        setWallClock(byMs: number) {
            vi.setSystemTime(Date.now() + byMs);
        },
        /** The phone restarts: its since-boot clock starts again from nothing. */
        restartBootClock() {
            phoneState.bootBase = -performance.now();
        },
        locked: () => locked,
        /** How many times the phone's prompt was shown. */
        prompts: () => vi.mocked(LA.authenticateAsync).mock.calls.length,
        reasons: () => vi.mocked(LA.authenticateAsync).mock.calls.map(c => c[0]?.promptMessage),
        /** The member answers the oldest prompt still open. */
        answer(passes: boolean) {
            const resolve = open.shift();
            expect(resolve, 'no prompt is open to answer').toBeDefined();
            resolve!(passes ? { success: true } : { success: false, error: 'user_cancel' });
        },
        /** The launch lock and the Unlock App button (app/_layout.tsx): the lock screen up, the phone's lock asked. */
        unlockApp() {
            setLocked(true);
            void ReturnLock.unlockWithPhoneLock('Unlock BeanPool').then(ok => { if (ok) setLocked(false); });
        },
        /** Settings' View Recovery Phrase. */
        viewRecoveryPhrase() {
            return readWordsBehindLock(ACCOUNT, VIEW_RECOVERY_PHRASE);
        },
        /** Manage / Moderate community, Settings sign-in on a computer, Take over with this phone: the same gate. */
        manageCommunity() {
            return requireDeviceUnlock('Mullum');
        },
    };
}
type Phone = Awaited<ReturnType<typeof phoneWithAppLock>>;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(START);
    phoneState.appLock = 'true';
    phoneState.appLockRead = null;
    phoneState.os = 'android';
    phoneState.bootClock = true;
    phoneState.bootClockStart = null;
    phoneState.bootClockFault = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    delete (globalThis as ExpoGlobalForTests).expo;
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** A real leave: the member switches app or locks the phone, with no prompt open, and comes back. */
async function leaveAndReturn(phone: Phone, awayMs: number) {
    phone.change('background');
    phone.wait(awayMs);
    phone.change('active');
    await flush();
}

const OPENERS = {
    "App Lock's own prompt, after a real leave of a minute": async (phone: Phone) => {
        await leaveAndReturn(phone, 60 * SEC);
        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
    },
    'the Unlock App button (and the launch lock, which asks the same way)': async (phone: Phone) => {
        phone.unlockApp();
        await flush();
    },
    "Settings' View Recovery Phrase": async (phone: Phone) => {
        void phone.viewRecoveryPhrase();
        await flush();
        expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE]);
    },
    'Manage community, sign in on a computer or take over with this phone (requireDeviceUnlock)': async (phone: Phone) => {
        void phone.manageCommunity();
        await flush();
        expect(phone.reasons()).toEqual([MANAGE_COMMUNITY]);
    },
};
/** Whether the lock screen is up once the opener's own prompt has closed, as it was before the prompt. */
const LOCKED_BY_OPENER: Record<keyof typeof OPENERS, boolean> = {
    "App Lock's own prompt, after a real leave of a minute": true,
    'the Unlock App button (and the launch lock, which asks the same way)': true,
    "Settings' View Recovery Phrase": false,
    'Manage community, sign in on a computer or take over with this phone (requireDeviceUnlock)': false,
};
const SHAPES = [
    ["Android 8-10: the PIN screen backgrounds the app", 'background'],
    ["iOS: the passcode prompt makes the app inactive", 'inactive'],
] as const;
const ORDERS = [
    ['the answer arrives before the app is active again', 'answer first'],
    ['the app is active again before the answer arrives', 'active first'],
] as const;

/**
 * The opener's prompt takes the app out of the front for `ms`, then is answered, in the given order. Active first: whether
 * the lock screen was up between the app's return and the answer.
 */
async function slowPrompt(phone: Phone, leave: AppStateStatus, order: 'answer first' | 'active first', ms: number, passes: boolean) {
    phone.change(leave);
    phone.wait(ms);
    let lockedBeforeAnswer: boolean | null = null;
    if (order === 'answer first') {
        phone.answer(passes);
        await flush();
        phone.change('active');
    } else {
        phone.change('active');
        await flush();
        lockedBeforeAnswer = phone.locked();
        phone.answer(passes);
    }
    await flush();
    return { lockedBeforeAnswer };
}

describe.each(Object.keys(OPENERS) as Array<keyof typeof OPENERS>)('a 20-second prompt from %s', (opener) => {
    describe.each(SHAPES)('%s', (_shape, leave) => {
        it.each(ORDERS)('passed, when %s: no second prompt, and the app is open', async (_order, order) => {
            const phone = await phoneWithAppLock();
            await OPENERS[opener](phone);
            expect(phone.prompts()).toBe(1);

            const { lockedBeforeAnswer } = await slowPrompt(phone, leave, order, 20 * SEC, true);

            // Back 20 seconds later with the prompt still open: the app isn't shown until the answer.
            if (order === 'active first') expect(lockedBeforeAnswer).toBe(true);
            expect(phone.prompts()).toBe(1);
            expect(phone.locked()).toBe(false);
            expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        });

        it.each(ORDERS)('cancelled, when %s: no second prompt, and the app stays behind the lock screen', async (_order, order) => {
            const phone = await phoneWithAppLock();
            await OPENERS[opener](phone);

            const { lockedBeforeAnswer } = await slowPrompt(phone, leave, order, 20 * SEC, false);

            if (order === 'active first') expect(lockedBeforeAnswer).toBe(true);
            expect(phone.prompts()).toBe(1);
            // Unlock App asks when the member is ready. The Settings prompt was 20 seconds with the app out of sight:
            // whoever cancelled it gets the lock screen, not the app (see the Android leave below).
            expect(phone.locked()).toBe(true);
        });
    });
});

describe('requireDeviceUnlock answers as before through the marker', () => {
    it.each([
        [true, 'ok'],
        [false, 'failed'],
    ] as const)('a 20-second prompt, passed %s: %s, and the marker has closed', async (passes, result) => {
        const phone = await phoneWithAppLock();
        const unlocked = phone.manageCommunity();
        await flush();
        expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(true);

        phone.wait(20 * SEC);
        phone.answer(passes);

        expect(await unlocked).toBe(result);
        expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        expect(phone.LocalAuth.localAuthPromptStretches()).toEqual([
            { openedAt: START.getTime(), closedAt: START.getTime() + 20 * SEC, passed: passes },
        ]);
    });

    it('a throwing prompt: failed (it fails closed), and the marker has closed', async () => {
        const phone = await phoneWithAppLock();
        const LA = await import('expo-local-authentication');
        vi.mocked(LA.authenticateAsync).mockRejectedValueOnce(new Error('prompt failed'));

        expect(await phone.manageCommunity()).toBe('failed');
        expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        expect(phone.LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: START.getTime(), passed: false }]);
    });
});

describe('every phone-lock prompt in the app opens through the marker', () => {
    const NATIVE = path.resolve(__dirname, '../..');
    function sources(dir: string): string[] {
        return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
            return /\.(ts|tsx|js|jsx)$/.test(e.name) ? [p] : [];
        });
    }

    it('authenticateAsync is called in one place only: LocalAuth.phoneLockPrompt', () => {
        const callers = ['app', 'components', 'constants', 'services', 'utils', 'plugins']
            .flatMap(d => sources(path.join(NATIVE, d)))
            .filter(f => /authenticateAsync\s*\(/.test(fs.readFileSync(f, 'utf-8')))
            .map(f => path.relative(NATIVE, f));
        expect(callers).toEqual([path.join('utils', 'LocalAuth.ts')]);
        const localAuth = fs.readFileSync(path.join(NATIVE, 'utils', 'LocalAuth.ts'), 'utf-8');
        expect(localAuth.match(/authenticateAsync\s*\(/g)).toHaveLength(1);
        expect(localAuth).toMatch(/export async function phoneLockPrompt\([\s\S]*?promptOpened\(\);[\s\S]*?LocalAuthentication\.authenticateAsync\(options\)[\s\S]*?finally \{\s*promptClosed\(passed\);/);
    });

    it("node-admin's requireDeviceUnlock asks through it, and Manage, sign in on a computer and take over use that gate", () => {
        const read = (f: string) => fs.readFileSync(path.join(NATIVE, 'utils', f), 'utf-8');
        expect(read('node-admin.ts')).toMatch(/export async function requireDeviceUnlock[\s\S]*?await phoneLockPrompt\(\{/);
        expect(read('node-admin.ts')).toContain('await requireDeviceUnlock(opts.communityName)');
        expect(read('settings-signin.ts')).toContain('await requireDeviceUnlock(opts.communityName)');
        expect(read('takeover-unlock.ts')).toContain('await requireDeviceUnlock(opts.communityName)');
    });
});

describe('a short prompt that is cancelled changes nothing, as before', () => {
    describe.each(SHAPES)('%s', (_shape, leave) => {
        it.each(ORDERS)('when %s', async (_order, order) => {
            const phone = await phoneWithAppLock();
            await OPENERS["Settings' View Recovery Phrase"](phone);

            const { lockedBeforeAnswer } = await slowPrompt(phone, leave, order, 5 * SEC, false);

            // Under 15 seconds: no lock screen while the answer is awaited either.
            if (order === 'active first') expect(lockedBeforeAnswer).toBe(false);
            expect(phone.prompts()).toBe(1);
            expect(phone.locked()).toBe(LOCKED_BY_OPENER["Settings' View Recovery Phrase"]);
        });
    });
});

describe('back after 20 seconds while the prompt is still open: the lock screen until the answer, never the app', () => {
    const UNLOCKED_OPENERS = [
        "Settings' View Recovery Phrase",
        'Manage community, sign in on a computer or take over with this phone (requireDeviceUnlock)',
    ] as const;
    describe.each(UNLOCKED_OPENERS)('%s', (opener) => {
        describe.each(SHAPES)('%s', (_shape, leave) => {
            it('passed just before the wait runs out: the lock screen until then, then the app, with one prompt in all', async () => {
                const phone = await phoneWithAppLock();
                await OPENERS[opener](phone);
                phone.change(leave);
                phone.wait(20 * SEC);
                phone.change('active');
                await flush();
                expect(phone.locked()).toBe(true);

                phone.wait(phone.ReturnLock.PROMPT_SETTLE_MS - 1);
                await flush();
                expect(phone.locked()).toBe(true);
                phone.answer(true);
                await flush();

                expect(phone.locked()).toBe(false);
                expect(phone.prompts()).toBe(1);
            });

            it('cancelled: the lock screen stays, and nothing more is asked', async () => {
                const phone = await phoneWithAppLock();
                await OPENERS[opener](phone);
                phone.change(leave);
                phone.wait(20 * SEC);
                phone.change('active');
                await flush();
                expect(phone.locked()).toBe(true);

                phone.wait(1 * SEC);
                phone.answer(false);
                await flush();
                phone.wait(phone.ReturnLock.PROMPT_SETTLE_MS);
                await flush();

                expect(phone.locked()).toBe(true);
                expect(phone.prompts()).toBe(1);
            });
        });
    });

    it('App Lock off: no lock screen while the answer is awaited, and none after', async () => {
        phoneState.appLock = 'false';
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.change('background');
        phone.wait(20 * SEC);
        phone.change('active');
        await flush();
        expect(phone.locked()).toBe(false);

        phone.answer(false);
        await flush();

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });

    it('the app leaves again before the answer: the lock screen stays up, and the pass does not take it down', async () => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.change('background');
        phone.wait(20 * SEC);
        phone.change('active');
        await flush();
        expect(phone.locked()).toBe(true);

        phone.change('background');
        phone.answer(true);
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });
});

describe('a real leave, with no prompt open, locks exactly as before', () => {
    it.each([15 * SEC, 60 * SEC, 3600 * SEC])('away %s ms: locked and asked once', async (away) => {
        const phone = await phoneWithAppLock();

        await leaveAndReturn(phone, away);

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
        phone.answer(true);
        await flush();
        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });

    it('iOS: inactive, then background, then back after 15 seconds: locked and asked once', async () => {
        const phone = await phoneWithAppLock();
        phone.change('inactive');
        phone.change('background');
        phone.wait(15 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });

    it.each([0, 14 * SEC, 15 * SEC - 1])('away %s ms: nothing', async (away) => {
        const phone = await phoneWithAppLock();

        await leaveAndReturn(phone, away);

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(0);
    });

    it('a cancelled return prompt leaves the lock screen up, and asks nothing more', async () => {
        const phone = await phoneWithAppLock();
        await leaveAndReturn(phone, 60 * SEC);
        phone.answer(false);
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });

    it('the lock screen is up after a cancelled return prompt: a short leave and return does not take it down', async () => {
        const phone = await phoneWithAppLock();
        await leaveAndReturn(phone, 60 * SEC);
        phone.answer(false);
        await flush();
        expect(phone.locked()).toBe(true);

        await leaveAndReturn(phone, 5 * SEC);

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });

    it('App Lock off: nothing', async () => {
        phoneState.appLock = 'false';
        const phone = await phoneWithAppLock();

        await leaveAndReturn(phone, 60 * SEC);

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(0);
    });

    it('no account on the phone: nothing', async () => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(60 * SEC);
        phone.change('active', false);
        await flush();

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(0);
    });

    it('the first return after a launch in the background (no leave seen): locked and asked, as before', async () => {
        const phone = await phoneWithAppLock();
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });
});

describe('leaving while a prompt is open', () => {
    it.each([
        ['iOS cancels it and the app goes to the background', 'cancel first'],
        ['the app goes to the background and iOS cancels it', 'background first'],
    ] as const)('iOS, the member swipes home during the prompt (%s) and comes back an hour later: locked and asked once', async (_name, order) => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.change('inactive');
        phone.wait(2 * SEC);
        if (order === 'cancel first') {
            phone.answer(false);
            await flush();
            phone.change('background');
        } else {
            phone.change('background');
            phone.answer(false);
        }
        await flush();
        phone.wait(3600 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
    });

    // Until the cold check of #1309 (2026-09-29) a pass here opened the app: "whoever is holding the phone just gave its
    // lock". The app can't tell it from a pass given an hour ago and held by Android 8-10 until BeanPool resumed (see
    // PROMPT_COVER_MAX_MS below), so a pass after an hour away is asked once more, as any hour away is.
    it.each([
        [false, 'the app stays behind the lock screen, nothing more asked', true, [VIEW_RECOVERY_PHRASE]],
        [true, 'the lock screen, asked once more: one prompt covers at most PROMPT_COVER_MAX_MS', true, [VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']],
    ] as const)('Android, the member goes home with the PIN screen open, and an hour later it is answered (passed: %s): %s', async (passes, _outcome, locked, reasons) => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        // Android keeps the PIN screen over the app; the member goes home, and the app stays in the background.
        phone.change('background');
        phone.wait(3600 * SEC);
        // Back in the app, the PIN screen is on top again, and is answered.
        phone.answer(passes);
        await flush();
        phone.change('active');
        await flush();

        expect(phone.reasons()).toEqual(reasons);
        expect(phone.locked()).toBe(locked);
    });

    it('a prompt whose answer never comes cannot hold the lock off: locked at once, still locked after the wait, and no prompt over it', async () => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.change('active');
        await flush();
        expect(phone.locked()).toBe(true);

        phone.wait(phone.ReturnLock.PROMPT_SETTLE_MS - 1);
        await flush();
        expect(phone.locked()).toBe(true);
        phone.wait(1);
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
        phone.answer(false);
        await flush();
    });
});

describe('a pass given before a long absence but delivered after it: one prompt covers at most PROMPT_COVER_MAX_MS of it', () => {
    // A cold check of #1309, 2026-09-29 (on main since #1307). A stretch closes when the answer reaches the app, not when the
    // member gave it. Android 8-10 holds the confirm-credential result until BeanPool resumes: the member passes the PIN,
    // presses home during the ~300 ms transition, and whoever opens BeanPool an hour later on the still-unlocked phone got
    // the held pass just before the app's return, and the app opened with no prompt. The app can't tell that pass from
    // one given just now, so no prompt counts for more than PROMPT_COVER_MAX_MS of the time away.
    it('a pass given before a 1 h absence but delivered after it does not open the app', async () => {
        const phone = await phoneWithAppLock();
        phone.unlockApp(); await flush();
        phone.change('background');   // Android 8-10: the PIN screen
        phone.wait(1 * SEC);          // PIN entered here; Android holds the result
        phone.wait(3600 * SEC);       // home pressed during the transition; away an hour
        phone.answer(true); await flush();
        phone.change('active'); await flush();
        expect(phone.locked()).toBe(true);
    });

    describe.each(Object.keys(OPENERS) as Array<keyof typeof OPENERS>)('the prompt from %s', (opener) => {
        describe.each(SHAPES)('%s', (_shape, leave) => {
            it.each(ORDERS)('passed and held an hour, when %s: the lock screen and one prompt more; cancelling it leaves the app locked', async (_order, order) => {
                const phone = await phoneWithAppLock();
                await OPENERS[opener](phone);
                const before = phone.reasons();

                const { lockedBeforeAnswer } = await slowPrompt(phone, leave, order, 3601 * SEC, true);
                await flush();

                if (order === 'active first') expect(lockedBeforeAnswer).toBe(true);
                expect(phone.locked()).toBe(true);
                expect(phone.reasons()).toEqual([...before, 'Unlock BeanPool']);
                expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(true);

                // Whoever opened it can't give the phone's lock and cancels.
                phone.answer(false);
                await flush();
                expect(phone.locked()).toBe(true);
                expect(phone.prompts()).toBe(before.length + 1);
            });

            it.each(ORDERS)('passed and held an hour, when %s: the member passes the prompt that follows, and the app is open', async (_order, order) => {
                const phone = await phoneWithAppLock();
                await OPENERS[opener](phone);
                const before = phone.prompts();

                await slowPrompt(phone, leave, order, 3601 * SEC, true);
                await flush();
                phone.answer(true);
                await flush();

                expect(phone.locked()).toBe(false);
                expect(phone.prompts()).toBe(before + 1);
            });

            it.each(ORDERS)('a 40-second prompt (Android waits 30 seconds after five wrong PINs) that passes, when %s: no second prompt', async (_order, order) => {
                const phone = await phoneWithAppLock();
                await OPENERS[opener](phone);
                const before = phone.prompts();

                await slowPrompt(phone, leave, order, 40 * SEC, true);
                await flush();

                expect(phone.locked()).toBe(false);
                expect(phone.prompts()).toBe(before);
            });
        });
    });

    it('covers two minutes: ten wrong PINs on Android (two 30-second waits) or four on iOS (a minute) are asked once', async () => {
        const { PROMPT_COVER_MAX_MS, RETURN_LOCK_GRACE_MS } = await import('../return-lock');
        expect(PROMPT_COVER_MAX_MS).toBe(120 * SEC);
        expect(RETURN_LOCK_GRACE_MS).toBe(15 * SEC);
    });

    describe.each(SHAPES)('the edge, %s', (_shape, leave) => {
        const cap = () => 120 * SEC;
        it.each(ORDERS)('a prompt that passes after the cap and 15 seconds less 1 ms, when %s: no second prompt', async (_order, order) => {
            const phone = await phoneWithAppLock();
            expect(phone.ReturnLock.PROMPT_COVER_MAX_MS).toBe(cap());
            void phone.viewRecoveryPhrase();
            await flush();

            await slowPrompt(phone, leave, order, cap() + 15 * SEC - 1, true);
            await flush();

            expect(phone.locked()).toBe(false);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE]);
        });

        it.each(ORDERS)('a prompt that passes after the cap and 15 seconds, when %s: the lock screen, asked once more', async (_order, order) => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();

            await slowPrompt(phone, leave, order, cap() + 15 * SEC, true);
            await flush();

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
        });

        it.each(ORDERS)('a prompt cancelled after an hour, when %s: the lock screen, nothing more asked (Unlock App asks)', async (_order, order) => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();

            await slowPrompt(phone, leave, order, 3601 * SEC, false);
            await flush();

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE]);
        });
    });

    describe.each(SHAPES)('after the held pass, %s', (_shape, leave) => {
        it.each(ORDERS)("the return lock's prompt is cancelled, then Unlock App is tapped and passes, when %s: the app is open", async (_order, order) => {
            const phone = await phoneWithAppLock();
            phone.unlockApp();
            await flush();
            await slowPrompt(phone, leave, order, 3601 * SEC, true);
            await flush();
            phone.answer(false);
            await flush();
            expect(phone.locked()).toBe(true);

            phone.unlockApp();
            await flush();
            phone.answer(true);
            await flush();

            expect(phone.locked()).toBe(false);
            expect(phone.reasons()).toEqual(['Unlock BeanPool', 'Unlock BeanPool', 'Unlock BeanPool']);
        });
    });
});

describe("an 'active' with no leave seen while a prompt is open: the lock screen is up at once, before the answer", () => {
    it.each([
        [true, 'the app, with one prompt', false],
        [false, 'the lock screen stays, with one prompt', true],
    ] as const)("View Recovery Phrase's prompt, answered (passed: %s): %s", async (passes, _outcome, lockedAfter) => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        expect(phone.locked()).toBe(false);

        phone.change('active');
        await flush();
        expect(phone.locked()).toBe(true);

        phone.answer(passes);
        await flush();
        expect(phone.locked()).toBe(lockedAfter);
        expect(phone.prompts()).toBe(1);
    });
});

describe("the wall clock set back while the app is away: the phone's since-boot clock times the absence", () => {
    // #1307's confirmation review (inline 4129238858): whoever holds an unlocked phone while BeanPool is in the background
    // turns off automatic time in the phone's Settings and sets the clock back (most phones ask no PIN for that). The wall
    // clock then read an hour away as seconds, or as less than nothing, and the app opened with no prompt.
    it.each([3600, 3595, 7200])('away an hour, the wall clock set back %s s before the return: locked and asked once', async (backS) => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.setWallClock(-backS * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
        phone.answer(true);
        await flush();
        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });

    it('iOS, inactive then background, away an hour, the wall clock set back an hour: locked and asked once', async () => {
        const phone = await phoneWithAppLock();
        phone.change('inactive');
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.setWallClock(-3600 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
    });

    it('the wall clock set forward two hours during a 5-second leave: nothing, as for any short leave', async () => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(2 * SEC);
        phone.setWallClock(2 * 3600 * SEC);
        phone.wait(3 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(0);
    });

    it('the wall clock set back a minute during a 5-second leave: locked and asked once, as after 15 seconds away', async () => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(2 * SEC);
        phone.setWallClock(-60 * SEC);
        phone.wait(3 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
    });

    it('the phone restarts while the app is away (its since-boot clock reads less on the return than at the leave): locked and asked once', async () => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(2 * SEC);
        phone.restartBootClock();
        phone.wait(3 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
    });

    it('a set-back while the app is in front (automatic time correcting it) does not count against the next leave', async () => {
        const phone = await phoneWithAppLock();
        await leaveAndReturn(phone, 60 * SEC);
        phone.answer(true);
        await flush();
        expect(phone.locked()).toBe(false);

        phone.setWallClock(-30 * SEC);
        await leaveAndReturn(phone, 5 * SEC);

        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });
});

describe('a prompt open across a wall clock change', () => {
    it('the stretch is timed on the since-boot clock: open 20 seconds, whatever the wall clock did meanwhile', async () => {
        const phone = await phoneWithAppLock();
        const { LocalAuth } = phone;
        const asked = LocalAuth.authenticateUser(VIEW_RECOVERY_PHRASE);
        await flush();
        phone.wait(10 * SEC);
        phone.setWallClock(-3600 * SEC);
        phone.wait(10 * SEC);
        phone.answer(true);
        expect(await asked).toBe(true);

        const [stretch] = LocalAuth.localAuthPromptStretches();
        expect(stretch.closedAt! - stretch.openedAt).toBe(20 * SEC);
        expect(stretch.passed).toBe(true);
    });

    describe.each(SHAPES)('%s', (_shape, leave) => {
        it('the PIN screen is left open an hour; someone sets the wall clock back an hour, cancels it and opens the app: locked', async () => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();
            phone.change(leave);
            phone.wait(3600 * SEC);
            phone.setWallClock(-3600 * SEC);
            phone.answer(false);
            await flush();
            phone.change('active');
            await flush();

            // Every wall reading since the leave says no time passed. The since-boot clock says an hour, and the prompt did
            // not pass: the lock screen, and Unlock App asks when the member is ready.
            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE]);
        });

        it('the same, the wall clock set back two hours: locked, and asked, as the times cannot be trusted', async () => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();
            phone.change(leave);
            phone.wait(3600 * SEC);
            phone.setWallClock(-7200 * SEC);
            phone.answer(false);
            await flush();
            phone.change('active');
            await flush();

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
        });

        it('the wall clock goes back while a prompt that passes is open: locked and asked once more, as the times cannot be trusted', async () => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();
            phone.change(leave);
            phone.wait(10 * SEC);
            phone.setWallClock(-60 * SEC);
            phone.wait(10 * SEC);
            phone.answer(true);
            await flush();
            phone.change('active');
            await flush();

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
        });
    });
});

describe('the web build (no since-boot clock, and App Lock asks nothing there): the wall clock, as before', () => {
    // Until #1309's deciding review these ran with Platform.OS 'android' and covered "a dev client built before the
    // module" too. On a phone that is the hole the review found (inline 4129453720): a phone that can't read its
    // since-boot clock now asks after every leave, below. The phone's prompt is mocked as on the other tests, so the
    // rule's answer shows; the web build's own has nothing to ask.
    beforeEach(() => {
        phoneState.os = 'web';
        phoneState.bootClock = false;
        const stored = new Map<string, string>();
        vi.stubGlobal('localStorage', {
            getItem: (k: string) => (k === 'beanpool_app_lock_enabled' ? phoneState.appLock : stored.get(k) ?? null),
            setItem: (k: string, v: string) => { stored.set(k, v); },
            removeItem: (k: string) => { stored.delete(k); },
        });
    });

    it('App Lock reads the wall clock there', async () => {
        vi.resetModules();
        const { appLockNow, clockReadFailures } = await import('../app-lock-clock');
        expect(appLockNow()).toBe(START.getTime());
        expect(clockReadFailures()).toBe(0);
    });

    it.each([
        [60 * SEC, true, 1],
        [5 * SEC, false, 0],
    ])('away %s ms: locked %s, prompts %s', async (away, locked, prompts) => {
        const phone = await phoneWithAppLock();

        await leaveAndReturn(phone, away);

        expect(phone.locked()).toBe(locked);
        expect(phone.prompts()).toBe(prompts);
    });

    it('a 20-second prompt that passes: no second prompt, and the app is open', async () => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();

        await slowPrompt(phone, 'background', 'answer first', 20 * SEC, true);

        expect(phone.prompts()).toBe(1);
        expect(phone.locked()).toBe(false);
    });

    it('away an hour, the wall clock set back two hours (the return reads earlier than the leave): locked and asked once', async () => {
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.setWallClock(-7200 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
    });
});

/**
 * The phone's since-boot clock read wrong, from phoneWithAppLock on: the module missing (bootClock false), or elapsedMs
 * throwing or answering something that isn't a time.
 */
const UNREADABLE = [
    ['the module missing (a phone app built before it)', () => { phoneState.bootClock = false; }],
    ['elapsedMs throwing', () => { phoneState.bootClockFault = () => { throw new Error('native'); }; }],
    ['elapsedMs answering NaN', () => { phoneState.bootClockFault = () => Number.NaN; }],
    ['elapsedMs answering Infinity', () => { phoneState.bootClockFault = () => Number.POSITIVE_INFINITY; }],
    ['elapsedMs answering a string', () => { phoneState.bootClockFault = () => '123456'; }],
] as const;
const FAULT = () => { throw new Error('native'); };
/** Where the since-boot clock starts: as the harness has it, and as on a phone (the wall clock reads decades more). */
const BOOT_STARTS = [
    ['the since-boot clock reading what the wall clock reads', null],
    ['the phone started three days ago', 3 * 24 * 3600 * SEC],
] as const;

describe("a phone whose since-boot clock can't be read: the time away can't be told, so App Lock asks", () => {
    // #1309's deciding review (inline 4129453720): with no since-boot reading, App Lock went back to the wall clock with no
    // sign, and away an hour with the clock set back 3595 s opened the app. The wall clock is App Lock's clock only in the
    // web build now; a phone that can't read its since-boot clock at the leave, at the return, or at a prompt's open or
    // close between them treats the time away as 15 seconds or more, as for any time that can't be trusted.
    it.each(UNREADABLE)('%s, away an hour, the wall clock set back 3595 s: locked and asked once', async (_name, breakClock) => {
        breakClock();
        const phone = await phoneWithAppLock();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.setWallClock(-3595 * SEC);
        phone.change('active');
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
        phone.answer(true);
        await flush();
        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });

    it.each(UNREADABLE)('%s, a 5-second leave: locked and asked once (a dev client built before the module asks after every leave)', async (_name, breakClock) => {
        breakClock();
        const phone = await phoneWithAppLock();

        await leaveAndReturn(phone, 5 * SEC);

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
    });

    it.each(UNREADABLE)('%s, a 20-second prompt that passes while the app is out of the front: asked once more', async (_name, breakClock) => {
        breakClock();
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();

        await slowPrompt(phone, 'background', 'answer first', 20 * SEC, true);

        expect(phone.locked()).toBe(true);
        expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
    });

    // #1309's deciding review (inline 4129818251), kept by decision: fail-closed. The phone's own prompt is itself a leave
    // (Android 8-10's PIN screen backgrounds the app, iOS's passcode prompt makes it inactive), and with no since-boot
    // reading every leave asks. So on a build without the module (or a dev client built before it) App Lock's own prompt
    // brings the next one, passed or cancelled, however quick: a member with App Lock on can't get in, even to turn it off,
    // until the app is rebuilt with the module. A build with it can't get here: elapsedRealtime and mach_continuous_time
    // don't fail. Trusting the order of events alone to break the loop would reopen a window (see the review).
    describe.each(UNREADABLE)('an unreadable since-boot clock fails closed: every prompt is a leave, so it asks again until the app is rebuilt with the module (%s)', (_name, breakClock) => {
        describe.each(SHAPES)('%s', (_shape, leave) => {
            describe.each(ORDERS)('%s', (_order, order) => {
                it.each([
                    ['passes', true],
                    ['cancels', false],
                ] as const)('the launch lock asks, the member %s two 1-second prompts: a third prompt is open', async (_answers, passes) => {
                    breakClock();
                    const phone = await phoneWithAppLock();
                    phone.unlockApp();
                    await flush();
                    expect(phone.prompts()).toBe(1);

                    for (let answered = 1; answered <= 2; answered++) {
                        await slowPrompt(phone, leave, order, 1 * SEC, passes);
                        await flush();
                        expect(phone.prompts()).toBe(answered + 1);
                    }

                    expect(phone.reasons()).toEqual(['Unlock BeanPool', 'Unlock BeanPool', 'Unlock BeanPool']);
                    expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(true);
                    // Passes too, since unlockWithPhoneLock: when the app is active before the answer, the pass that closed
                    // one prompt used to take the lock screen down after the return lock had asked again and opened the
                    // next. A prompt opened before a return the return lock locked for no longer takes it down.
                    expect(phone.locked()).toBe(true);
                });
            });
        });
    });

    describe.each(SHAPES)('the same prompts with the since-boot clock working (%s): asked once, no loop', (_shape, leave) => {
        it.each(ORDERS)('passed when %s: one prompt, and the app is open', async (_order, order) => {
            const phone = await phoneWithAppLock();
            phone.unlockApp();
            await flush();

            await slowPrompt(phone, leave, order, 1 * SEC, true);
            await flush();

            expect(phone.prompts()).toBe(1);
            expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
            expect(phone.locked()).toBe(false);
        });

        it.each(ORDERS)('cancelled when %s: one prompt, and the lock screen stays', async (_order, order) => {
            const phone = await phoneWithAppLock();
            phone.unlockApp();
            await flush();

            await slowPrompt(phone, leave, order, 1 * SEC, false);
            await flush();

            expect(phone.prompts()).toBe(1);
            expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
            expect(phone.locked()).toBe(true);
        });
    });

    describe.each(BOOT_STARTS)('%s', (_start, bootClockStart) => {
        beforeEach(() => {
            phoneState.bootClockStart = bootClockStart;
        });

        /** Leaves, and comes back awayMs later with the wall clock moved by wallMs; the since-boot clock fails at `at` only. */
        async function leaveAndReturnFailingAt(phone: Phone, at: 'leave' | 'return', awayMs: number, wallMs = 0) {
            if (at === 'leave') phoneState.bootClockFault = FAULT;
            phone.change('background');
            phoneState.bootClockFault = null;
            phone.wait(awayMs);
            phone.setWallClock(wallMs);
            if (at === 'return') phoneState.bootClockFault = FAULT;
            // The return lock reads the time as the change arrives, before anything it waits on.
            phone.change('active');
            phoneState.bootClockFault = null;
            await flush();
        }

        it.each(['leave', 'return'] as const)('only the reading at the %s fails, a 5-second leave: locked and asked once', async (at) => {
            const phone = await phoneWithAppLock();

            await leaveAndReturnFailingAt(phone, at, 5 * SEC);

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual(['Unlock BeanPool']);
        });

        it.each(['leave', 'return'] as const)('only the reading at the %s fails, away an hour, the wall clock set back 3595 s: locked and asked once', async (at) => {
            const phone = await phoneWithAppLock();

            await leaveAndReturnFailingAt(phone, at, 3600 * SEC, -3595 * SEC);

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual(['Unlock BeanPool']);
            phone.answer(true);
            await flush();
            expect(phone.prompts()).toBe(1);
        });

        it.each(SHAPES)("only the reading at a prompt's answer while the app is away fails (%s), 5 s away: locked and asked once more", async (_shape, leave) => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();
            phone.change(leave);
            phone.wait(5 * SEC);
            phoneState.bootClockFault = FAULT;
            phone.answer(true);
            await flush();
            phoneState.bootClockFault = null;
            phone.change('active');
            await flush();

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual([VIEW_RECOVERY_PHRASE, 'Unlock BeanPool']);
        });

        it("the reading at a prompt's answer before the leave fails: that prompt never covers a later hour away", async () => {
            const phone = await phoneWithAppLock();
            phone.unlockApp();
            await flush();
            phoneState.bootClockFault = FAULT;
            phone.answer(true);
            await flush();
            phoneState.bootClockFault = null;
            expect(phone.locked()).toBe(false);

            await leaveAndReturn(phone, 3600 * SEC);

            expect(phone.locked()).toBe(true);
            expect(phone.reasons()).toEqual(['Unlock BeanPool', 'Unlock BeanPool']);
        });

        it('a reading that failed while the app was in front does not count against the next leave: 5 s away, nothing', async () => {
            const phone = await phoneWithAppLock();
            void phone.viewRecoveryPhrase();
            await flush();
            phoneState.bootClockFault = FAULT;
            phone.answer(true);
            await flush();
            phoneState.bootClockFault = null;

            await leaveAndReturn(phone, 5 * SEC);

            expect(phone.locked()).toBe(false);
            expect(phone.prompts()).toBe(1);
        });

        it('with the since-boot clock working, a 5-second leave: nothing, as before', async () => {
            const phone = await phoneWithAppLock();

            await leaveAndReturn(phone, 5 * SEC);

            expect(phone.locked()).toBe(false);
            expect(phone.prompts()).toBe(0);
        });
    });
});

describe("App Lock's clock is the phone's since-boot clock", () => {
    const NATIVE = path.resolve(__dirname, '../..');
    const read = (f: string) => fs.readFileSync(path.join(NATIVE, f), 'utf-8');
    const MODULE = 'modules/boot-clock';
    const KOTLIN = `${MODULE}/android/src/main/java/org/beanpool/bootclock/BootClockModule.kt`;
    const SWIFT = `${MODULE}/ios/BootClockModule.swift`;

    it('the return lock and the prompt marker read it, never the wall clock', () => {
        const returnLock = read('utils/return-lock.ts');
        const localAuth = read('utils/LocalAuth.ts');
        expect(returnLock).not.toMatch(/Date\.now\(/);
        expect(localAuth).not.toMatch(/Date\.now\(/);
        expect(returnLock).toContain('leftAt = appLockNow();');
        expect(returnLock).toContain('const activeAt = appLockNow();');
        expect(localAuth).toContain('promptStretches.push({ openedAt: appLockNow(), closedAt: null, passed: false });');
        expect(localAuth).toContain('current.closedAt = appLockNow();');
    });

    it('one native module under one name: Android reads elapsedRealtime, iOS mach_continuous_time', () => {
        const config = JSON.parse(read(`${MODULE}/expo-module.config.json`));
        expect(config.platforms).toEqual(['apple', 'android']);
        expect(config.apple.modules).toEqual(['BootClockModule']);
        expect(config.android.modules).toEqual(['org.beanpool.bootclock.BootClockModule']);
        for (const source of [read(KOTLIN), read(SWIFT)]) {
            expect(source).toContain('Name("BeanPoolBootClock")');
            expect(source).toContain('Function("elapsedMs")');
        }
        expect(read(KOTLIN)).toContain('SystemClock.elapsedRealtime().toDouble()');
        expect(read(SWIFT)).toContain('Double(mach_continuous_time())');
        expect(read(`${MODULE}/index.ts`)).toContain("export const BOOT_CLOCK_MODULE = 'BeanPoolBootClock';");
    });

    it("a phone build packs the module's native code: the repo's .easignore, the one EAS reads, leaves it in", () => {
        // eas-cli (vcs/clients/git.js) drops the files `git ls-files --exclude-from <git root>/.easignore --ignored --cached`
        // lists from what it builds. A bare `android/` or `ios/` line there would drop these too, and the app would fall
        // back to the wall clock without a word.
        const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: NATIVE, encoding: 'utf-8' }).trim();
        const listed = (...args: string[]) => execFileSync('git', ['ls-files', '--cached', ...args, '--', `apps/native/${MODULE}`], { cwd: root, encoding: 'utf-8' })
            .split('\n')
            .filter(Boolean);
        expect(listed()).toEqual(expect.arrayContaining([
            `apps/native/${MODULE}/android/build.gradle`,
            `apps/native/${KOTLIN}`,
            `apps/native/${MODULE}/ios/BeanPoolBootClock.podspec`,
            `apps/native/${SWIFT}`,
        ]));
        expect(listed('--ignored', `--exclude-from=${path.join(root, '.easignore')}`)).toEqual([]);
    });
});

describe('the return lock never opens a prompt while one is open', () => {
    it("the launch lock's prompt is open when an 'active' arrives with no leave seen: no second prompt", async () => {
        const phone = await phoneWithAppLock();
        phone.unlockApp();
        await flush();
        phone.change('active');
        await flush();
        expect(phone.prompts()).toBe(1);

        phone.answer(true);
        await flush();

        expect(phone.prompts()).toBe(1);
        expect(phone.locked()).toBe(false);
    });

    it('Unlock App is tapped while the return lock is deciding to ask: only that prompt is shown', async () => {
        let appLockRead!: (v: string) => void;
        phoneState.appLockRead = () => new Promise<string>(resolve => { appLockRead = resolve; });
        const phone = await phoneWithAppLock();
        await leaveAndReturn(phone, 60 * SEC);
        expect(phone.prompts()).toBe(0);

        phone.unlockApp();
        await flush();
        appLockRead('true');
        await flush();

        expect(phone.reasons()).toEqual(['Unlock BeanPool']);
        phone.answer(true);
        await flush();
        expect(phone.locked()).toBe(false);
        expect(phone.prompts()).toBe(1);
    });
});

describe("the prompt marker (LocalAuth.authenticateUser): open exactly while the phone's prompt is", () => {
    it('open while the prompt is, closed once it is answered; the stretch says whether it passed', async () => {
        const phone = await phoneWithAppLock();
        const { LocalAuth } = phone;
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(false);

        const asked = LocalAuth.authenticateUser(VIEW_RECOVERY_PHRASE);
        await flush();
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(true);
        expect(LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: null, passed: false }]);

        phone.wait(20 * SEC);
        phone.answer(true);
        expect(await asked).toBe(true);
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        expect(LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: START.getTime() + 20 * SEC, passed: true }]);
    });

    it('two overlapping calls: open until both have ended, one stretch, passed only if the last to close passed', async () => {
        const phone = await phoneWithAppLock();
        const { LocalAuth } = phone;
        const first = LocalAuth.authenticateUser('first');
        await flush();
        phone.wait(1 * SEC);
        const second = LocalAuth.authenticateUser('second');
        await flush();
        expect(phone.prompts()).toBe(2);

        // The first passes while the second keeps the stretch open: not passed yet, and not passed once the second fails.
        phone.answer(true);
        expect(await first).toBe(true);
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(true);
        expect(LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: null, passed: false }]);

        phone.wait(1 * SEC);
        phone.answer(false);
        expect(await second).toBe(false);
        expect(LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        expect(LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: START.getTime() + 2 * SEC, passed: false }]);
    });

    // expo-local-authentication answers a second call while one is open with app_cancel: 55.0.18 answers the new call at
    // once and the first closes the stretch; 55.0.15 answers the first and the second takes over the prompt. The member's
    // one answer closes the stretch either way.
    it.each([
        ['55.0.18: the second call is refused at once, the first carries the answer', 'second refused'],
        ['55.0.15: the first call is refused, the second takes over the prompt and carries the answer', 'first refused'],
    ] as const)('%s: the stretch says what the member answered', async (_name, shape) => {
        for (const passes of [true, false]) {
            const phone = await phoneWithAppLock();
            const LA = await import('expo-local-authentication');
            const answers: Array<(a: Answer) => void> = [];
            vi.mocked(LA.authenticateAsync).mockImplementation(() => new Promise<Answer>(resolve => answers.push(resolve)) as never);
            const { LocalAuth } = phone;
            const first = LocalAuth.authenticateUser('first');
            await flush();
            const second = LocalAuth.authenticateUser('second');
            await flush();
            const [refused, carrier] = shape === 'second refused' ? [answers[1], answers[0]] : [answers[0], answers[1]];
            refused({ success: false, error: 'app_cancel' });
            await flush();
            expect(LocalAuth.isLocalAuthPromptOpen()).toBe(true);
            phone.wait(20 * SEC);
            carrier(passes ? { success: true } : { success: false, error: 'user_cancel' });
            await Promise.all([first, second]);

            expect(LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: START.getTime() + 20 * SEC, passed: passes }]);
            vi.setSystemTime(START);
        }
    });

    it('the first of two overlapping prompts passes, the member leaves, and an hour later the second is cancelled: locked', async () => {
        const phone = await phoneWithAppLock();
        const { LocalAuth } = phone;
        void LocalAuth.authenticateUser('first');
        await flush();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.wait(1 * SEC);
        phone.answer(true);
        await flush();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.answer(false);
        await flush();
        phone.change('active');
        await flush();

        expect(phone.prompts()).toBe(2);
        expect(phone.locked()).toBe(true);
    });

    it('a prompt that throws closes the marker, and the call is refused without throwing', async () => {
        const phone = await phoneWithAppLock();
        const LA = await import('expo-local-authentication');
        vi.mocked(LA.authenticateAsync).mockRejectedValueOnce(new Error('prompt failed'));

        expect(await phone.LocalAuth.authenticateUser(VIEW_RECOVERY_PHRASE)).toBe(false);

        expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        expect(phone.LocalAuth.localAuthPromptStretches()).toEqual([{ openedAt: START.getTime(), closedAt: START.getTime(), passed: false }]);
    });

    it('a phone with no screen lock opens no prompt, so there is no stretch', async () => {
        const phone = await phoneWithAppLock();
        const LA = await import('expo-local-authentication');
        vi.mocked(LA.getEnrolledLevelAsync).mockResolvedValue(LA.SecurityLevel.NONE);

        expect(await phone.LocalAuth.authenticateUser(VIEW_RECOVERY_PHRASE)).toBe(true);

        expect(phone.prompts()).toBe(0);
        expect(phone.LocalAuth.localAuthPromptStretches()).toEqual([]);
    });

    it('whenLocalAuthPromptsClose resolves at once with none open, and when the last one closes', async () => {
        const phone = await phoneWithAppLock();
        const { LocalAuth } = phone;
        await LocalAuth.whenLocalAuthPromptsClose();

        void LocalAuth.authenticateUser(VIEW_RECOVERY_PHRASE);
        await flush();
        let closed = false;
        void LocalAuth.whenLocalAuthPromptsClose().then(() => { closed = true; });
        await flush();
        expect(closed).toBe(false);

        phone.answer(false);
        await flush();
        expect(closed).toBe(true);
    });
});

describe('returnLockAction: the rule', () => {
    const T = START.getTime();
    const stretch = (from: number, to: number | null, passed: boolean) => ({ openedAt: T + from, closedAt: to === null ? null : T + to, passed });
    let returnLockActionOf: typeof import('../return-lock').returnLockAction;
    beforeEach(async () => {
        returnLockActionOf = (await import('../return-lock')).returnLockAction;
    });

    it.each([
        ['no prompt, away 15 s', 'ask', 0, 15 * SEC, []],
        ['no prompt, away just under 15 s', 'none', 0, 15 * SEC - 1, []],
        ['a prompt passed before the leave does not count', 'ask', 10 * SEC, 70 * SEC, [stretch(0, 5 * SEC, true)]],
        ['a 20 s prompt covering the away, passed', 'none', 1, 20 * SEC, [stretch(0, 20 * SEC, true)]],
        ['a 20 s prompt covering the away, not passed', 'lock', 1, 20 * SEC, [stretch(0, 20 * SEC, false)]],
        ['a prompt still open (never answered)', 'lock', 1, 20 * SEC, [stretch(0, null, false)]],
        ['a prompt still open counts as not passed, whatever passed says', 'lock', 2 * SEC, 3600 * SEC, [stretch(0, null, true)]],
        ['a prompt, then 15 s away with none open', 'ask', 1, 40 * SEC, [stretch(0, 25 * SEC, true)]],
        ['a prompt, then 14 s away with none open', 'none', 1, 39 * SEC, [stretch(0, 25 * SEC, true)]],
        ['a short prompt not passed, away under 15 s', 'none', 1, 5 * SEC, [stretch(0, 5 * SEC, false)]],
        ['a prompt opened after the return does not count', 'ask', 0, 60 * SEC, [stretch(61 * SEC, 70 * SEC, true)]],
        ['a passed prompt covering an hour away covers two minutes of it', 'ask', 1, 3600 * SEC, [stretch(0, 3600 * SEC, true)]],
        ['a passed prompt covering 2 min 15 s less 1 ms away', 'none', 0, 135 * SEC - 1, [stretch(0, 135 * SEC - 1, true)]],
        ['a passed prompt covering 2 min 15 s away', 'ask', 0, 135 * SEC, [stretch(0, 135 * SEC, true)]],
        ['a passed prompt of 3 min, 10 s of it before the leave', 'ask', 10 * SEC, 180 * SEC, [stretch(0, 180 * SEC, true)]],
        ['a passed prompt of 2 min 20 s, 10 s of it before the leave', 'none', 10 * SEC, 140 * SEC, [stretch(0, 140 * SEC, true)]],
        ['a prompt covering an hour away, not passed: the whole hour, locked, not asked', 'lock', 1, 3600 * SEC, [stretch(0, 3600 * SEC, false)]],
        ['a prompt still open after an hour away', 'lock', 1, 3600 * SEC, [stretch(0, null, true)]],
    ] as const)('%s: %s', (_name, action, left, active, stretches) => {
        expect(returnLockActionOf(T + left, T + active, stretches)).toBe(action);
    });

    it.each([
        ['no prompt open', 'ask', []],
        ['the launch prompt open, passed', 'none', [stretch(0, 30 * SEC, true)]],
        ['the launch prompt open, not passed', 'lock', [stretch(0, 30 * SEC, false)]],
    ] as const)('no leave seen, %s: %s', (_name, action, stretches) => {
        expect(returnLockActionOf(null, T + 10 * SEC, stretches)).toBe(action);
    });

    it.each([
        ['the return reads earlier than the leave (the phone restarted)', 'ask', 60 * SEC, 5 * SEC, [], false],
        ['the wall clock seen going back, 5 s away', 'ask', 0, 5 * SEC, [], true],
        ['the wall clock seen going back, a prompt that passed covering the away', 'ask', 1, 20 * SEC, [stretch(0, 20 * SEC, true)], true],
        ['the wall clock seen going back, a prompt that did not pass', 'ask', 1, 20 * SEC, [stretch(0, 20 * SEC, false)], true],
        ['a prompt since the leave closed before it opened, 14 s away', 'ask', 0, 14 * SEC, [stretch(10 * SEC, 5 * SEC, true)], false],
        ['a prompt that ran backwards before the leave does not count', 'none', 30 * SEC, 35 * SEC, [stretch(10 * SEC, 5 * SEC, true)], false],
        ['the wall clock not seen going back: as before', 'none', 1, 20 * SEC, [stretch(0, 20 * SEC, true)], false],
    ] as const)('times that ran backwards, %s: %s', (_name, action, left, active, stretches, wallClockSetBack) => {
        expect(returnLockActionOf(T + left, T + active, stretches, wallClockSetBack)).toBe(action);
    });

    // App Lock's clock answers NaN for a reading it couldn't take (utils/app-lock-clock.ts). A time that isn't a number
    // can't say how long the app was away: NaN >= 15 s is false, and the rule used to answer 'none' for it.
    const passedCovering = [stretch(0, 20 * SEC, true)];
    it.each([
        ['the leave unread', 'ask', Number.NaN, T + 5 * SEC, []],
        ['the return unread', 'ask', T, Number.NaN, []],
        ['both unread', 'ask', Number.NaN, Number.NaN, []],
        ['the return unread, a prompt that passed covering the away', 'ask', T + 1, Number.NaN, passedCovering],
        ['the leave unread, a prompt that passed covering the away', 'ask', Number.NaN, T + 20 * SEC, passedCovering],
        ['the leave infinitely far back', 'ask', Number.NEGATIVE_INFINITY, T + 5 * SEC, []],
        ['the return infinitely far on', 'ask', T, Number.POSITIVE_INFINITY, passedCovering],
        ['no leave seen, the return unread, a prompt that passed', 'ask', null, Number.NaN, passedCovering],
        ["a prompt passed before the leave, its close unread: it doesn't cover the away", 'ask', T + 10 * SEC, T + 3600 * SEC, [{ openedAt: T, closedAt: Number.NaN, passed: true }]],
        ["a prompt whose open was unread: it doesn't cover the away", 'ask', T + 1, T + 20 * SEC, [{ openedAt: Number.NaN, closedAt: T + 20 * SEC, passed: true }]],
    ] as const)('a time that is not a number, %s: %s', (_name, action, left, active, stretches) => {
        expect(returnLockActionOf(left, active, stretches)).toBe(action);
    });
});

describe("app/_layout.tsx listens with it", () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it('every AppState change goes to the return lock, with whether there is an account', () => {
        const s = layout();
        expect(s).toContain("import { createReturnLock, unlockWithPhoneLock } from '../utils/return-lock';");
        expect(s).toContain('if (!returnLock.current) returnLock.current = createReturnLock(setIsLocked);');
        expect(s).toMatch(/AppState\.addEventListener\('change', \(next\) => \{\s*onChange\(next, !!identity\);\s*\}\);/);
    });

    it('the launch lock and the Unlock App button take the lock screen down through unlockWithPhoneLock, never on a bare pass', () => {
        const s = layout();
        expect(s).toContain("import { createReturnLock, unlockWithPhoneLock } from '../utils/return-lock';");
        expect(s.match(/await unlockWithPhoneLock\('Unlock BeanPool'\)/g)).toHaveLength(2);
        expect(s).not.toMatch(/authenticateUser\(/);
        const returnLock = fs.readFileSync(path.resolve(__dirname, '../return-lock.ts'), 'utf-8');
        expect(returnLock).toContain("if (await unlockWithPhoneLock('Unlock BeanPool')) setLocked(false);");
        expect(returnLock.match(/authenticateUser\(/g)).toHaveLength(1);
    });

    it('no second copy of the rule is left in the screen', () => {
        const s = layout();
        expect(s).not.toContain('gracePeriodMs');
        expect(s).not.toContain('lastBackgroundTime');
    });
});
