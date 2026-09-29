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
 *
 * Screens can't be rendered here (see vitest.config.ts): the listener is driven the way AppState drives it, with the
 * phone's prompt mocked at expo-local-authentication and time faked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';

const phoneState = vi.hoisted(() => ({ appLock: 'true' as string | null, appLockRead: null as null | (() => Promise<string | null>) }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('expo-secure-store', () => ({
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

/**
 * A phone with a PIN and App Lock on, BeanPool open on it with an account, and the return lock listening. Fresh modules
 * each time: the prompt marker is module state.
 */
async function phoneWithAppLock() {
    vi.resetModules();
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
            void LocalAuth.authenticateUser('Unlock BeanPool').then(ok => { if (ok) setLocked(false); });
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(START);
    phoneState.appLock = 'true';
    phoneState.appLockRead = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
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

/** The opener's prompt takes the app out of the front for `ms`, then is answered, in the given order. */
async function slowPrompt(phone: Phone, leave: AppStateStatus, order: 'answer first' | 'active first', ms: number, passes: boolean) {
    phone.change(leave);
    phone.wait(ms);
    if (order === 'answer first') {
        phone.answer(passes);
        await flush();
        phone.change('active');
    } else {
        phone.change('active');
        await flush();
        phone.answer(passes);
    }
    await flush();
}

describe.each(Object.keys(OPENERS) as Array<keyof typeof OPENERS>)('a 20-second prompt from %s', (opener) => {
    describe.each(SHAPES)('%s', (_shape, leave) => {
        it.each(ORDERS)('passed, when %s: no second prompt, and the app is open', async (_order, order) => {
            const phone = await phoneWithAppLock();
            await OPENERS[opener](phone);
            expect(phone.prompts()).toBe(1);

            await slowPrompt(phone, leave, order, 20 * SEC, true);

            expect(phone.prompts()).toBe(1);
            expect(phone.locked()).toBe(false);
            expect(phone.LocalAuth.isLocalAuthPromptOpen()).toBe(false);
        });

        it.each(ORDERS)('cancelled, when %s: no second prompt, and the app stays behind the lock screen', async (_order, order) => {
            const phone = await phoneWithAppLock();
            await OPENERS[opener](phone);

            await slowPrompt(phone, leave, order, 20 * SEC, false);

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
    it.each(SHAPES)('%s', async (_shape, leave) => {
        const phone = await phoneWithAppLock();
        await OPENERS["Settings' View Recovery Phrase"](phone);

        await slowPrompt(phone, leave, 'answer first', 5 * SEC, false);

        expect(phone.prompts()).toBe(1);
        expect(phone.locked()).toBe(LOCKED_BY_OPENER["Settings' View Recovery Phrase"]);
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

    it.each([
        [false, 'the app stays behind the lock screen, nothing more asked', true],
        [true, 'the app is open: whoever is holding the phone just gave its lock', false],
    ] as const)('Android, the member goes home with the PIN screen open, and an hour later it is answered (passed: %s): %s', async (passes, _outcome, locked) => {
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

        expect(phone.prompts()).toBe(1);
        expect(phone.locked()).toBe(locked);
    });

    it('a prompt whose answer never comes cannot hold the lock off: locked after a short wait, and no prompt over it', async () => {
        const phone = await phoneWithAppLock();
        void phone.viewRecoveryPhrase();
        await flush();
        phone.change('background');
        phone.wait(3600 * SEC);
        phone.change('active');
        await flush();
        expect(phone.locked()).toBe(false);

        phone.wait(phone.ReturnLock.PROMPT_SETTLE_MS);
        await flush();

        expect(phone.locked()).toBe(true);
        expect(phone.prompts()).toBe(1);
        phone.answer(false);
        await flush();
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
});

describe("app/_layout.tsx listens with it", () => {
    const layout = () => fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf-8');

    it('every AppState change goes to the return lock, with whether there is an account', () => {
        const s = layout();
        expect(s).toContain("import { createReturnLock } from '../utils/return-lock';");
        expect(s).toContain('if (!returnLock.current) returnLock.current = createReturnLock(setIsLocked);');
        expect(s).toMatch(/AppState\.addEventListener\('change', \(next\) => \{\s*onChange\(next, !!identity\);\s*\}\);/);
    });

    it('no second copy of the rule is left in the screen', () => {
        const s = layout();
        expect(s).not.toContain('gracePeriodMs');
        expect(s).not.toContain('lastBackgroundTime');
    });
});
