import { describe, it, expect, vi, beforeEach } from 'vitest';

(globalThis as any).__DEV__ = true;

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(),
    setItemAsync: vi.fn(),
    deleteItemAsync: vi.fn(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn().mockResolvedValue(null),
        setItem: vi.fn().mockResolvedValue(undefined),
        removeItem: vi.fn().mockResolvedValue(undefined),
    },
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as LocalAuth from '../LocalAuth';
import { authenticateUser, getAppLockEnabled, setAppLockEnabled } from '../LocalAuth';

describe('LocalAuth - getAppLockEnabled & setAppLockEnabled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns true when SecureStore has "true"', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('true');
        const enabled = await getAppLockEnabled();
        expect(enabled).toBe(true);
        expect(SecureStore.getItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });

    it('returns false when SecureStore has "false"', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce('false');
        const enabled = await getAppLockEnabled();
        expect(enabled).toBe(false);
    });

    it('migrates from legacy AsyncStorage if SecureStore is empty', async () => {
        vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
        vi.mocked(AsyncStorage.getItem).mockResolvedValueOnce('true');

        const enabled = await getAppLockEnabled();

        expect(enabled).toBe(true);
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled', 'true');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });

    it('saves setting to SecureStore in setAppLockEnabled', async () => {
        await setAppLockEnabled(true);
        expect(SecureStore.setItemAsync).toHaveBeenCalledWith('beanpool_app_lock_enabled', 'true');
        expect(AsyncStorage.removeItem).toHaveBeenCalledWith('beanpool_app_lock_enabled');
    });
});

/**
 * The phone's lock (authenticateUser), as every "behind the phone lock" door asks it: the 12 words, pairing a computer,
 * linking a sign-in, taking the account off the phone, and App Lock.
 *
 * A phone with a screen PIN, pattern or passcode but no fingerprint or face (none enrolled, or no sensor at all) used to
 * pass every one of them without being asked: the check read "no fingerprint or face" as "no lock". It now asks whatever
 * lock the phone has. Only a phone with no screen lock at all passes unasked, so a member is never locked out by their
 * phone.
 */
type Level = 0 | 1 | 2 | 3;
/** A phone as expo-local-authentication reports it: its screen lock (getEnrolledLevelAsync), and its fingerprint or
 *  face sensor (hasHardwareAsync) with what is enrolled on it (isEnrolledAsync). */
type Phone = { level: Level | 'throws'; sensor: boolean | 'throws'; enrolled: boolean | 'throws' };
type Prompt = 'passes' | 'fails' | 'cancelled' | 'throws';

const REASON = 'Confirm your security to view your recovery phrase.';

const LOCKED: Record<string, Phone> = {
    'a PIN and no fingerprint or face sensor': { level: 1, sensor: false, enrolled: false },
    'a PIN and a sensor with nothing enrolled': { level: 1, sensor: true, enrolled: false },
    'a fingerprint or face (Android weak)': { level: 2, sensor: true, enrolled: true },
    'a fingerprint or face (strong)': { level: 3, sensor: true, enrolled: true },
};
const NO_LOCK: Record<string, Phone> = {
    'no screen lock and no sensor': { level: 0, sensor: false, enrolled: false },
    'no screen lock and a sensor with nothing enrolled': { level: 0, sensor: true, enrolled: false },
};

function answer<T>(v: T | 'throws'): () => Promise<T> {
    return async () => {
        if (v === 'throws') throw new Error('native module unavailable');
        return v;
    };
}
function phone(p: Phone, prompt: Prompt = 'passes') {
    vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockImplementation(answer(p.level) as never);
    vi.mocked(LocalAuthentication.hasHardwareAsync).mockImplementation(answer(p.sensor));
    vi.mocked(LocalAuthentication.isEnrolledAsync).mockImplementation(answer(p.enrolled));
    vi.mocked(LocalAuthentication.authenticateAsync).mockImplementation(async () => {
        if (prompt === 'throws') throw new Error('prompt failed');
        if (prompt === 'passes') return { success: true };
        return { success: false, error: prompt === 'cancelled' ? 'user_cancel' : 'authentication_failed' } as never;
    });
}

describe("authenticateUser: the phone's lock", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    describe.each(Object.entries(LOCKED))('a phone with %s', (_name, p) => {
        it('is asked, with its PIN, pattern or passcode allowed, and passes once the prompt passes', async () => {
            phone(p, 'passes');

            expect(await authenticateUser(REASON)).toBe(true);

            expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
            const options = vi.mocked(LocalAuthentication.authenticateAsync).mock.calls[0][0];
            expect(options).toMatchObject({ promptMessage: REASON, disableDeviceFallback: false });
            // Android offers the device credential beside WEAK biometrics on every version; beside STRONG it cannot on
            // Android 9 and 10 (androidx.biometric), so the check never asks for strong biometrics only.
            expect(options?.biometricsSecurityLevel).toBeUndefined();
        });

        it.each(['cancelled', 'fails', 'throws'] as const)('is refused when the prompt %s', async (prompt) => {
            phone(p, prompt);

            expect(await authenticateUser(REASON)).toBe(false);
            expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        });
    });

    it.each(Object.entries(NO_LOCK))('a phone with %s has nothing to ask with and passes unasked, as before', async (_name, p) => {
        phone(p, 'fails');

        expect(await authenticateUser(REASON)).toBe(true);
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    });

    describe("a phone that can't say what screen lock it has keeps the check it had before", () => {
        it('a fingerprint or face enrolled: asked, and a cancel is refused', async () => {
            phone({ level: 'throws', sensor: true, enrolled: true }, 'cancelled');

            expect(await authenticateUser(REASON)).toBe(false);
            expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        });

        it('a fingerprint or face enrolled: asked, and passes once the prompt passes', async () => {
            phone({ level: 'throws', sensor: true, enrolled: true }, 'passes');

            expect(await authenticateUser(REASON)).toBe(true);
            expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        });

        it.each([
            ['no sensor', { level: 'throws', sensor: false, enrolled: false }],
            ['nothing enrolled', { level: 'throws', sensor: true, enrolled: false }],
            ['nothing answering at all', { level: 'throws', sensor: 'throws', enrolled: 'throws' }],
        ] as const)('%s: passes unasked, never a lockout', async (_name, p) => {
            phone(p, 'fails');

            expect(await authenticateUser(REASON)).toBe(true);
            expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
        });
    });
});

describe('getScreenLock: what the phone has to ask with', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each([
        [0, 'none'],
        [1, 'set'],
        [2, 'set'],
        [3, 'set'],
    ] as const)('level %s is %s', async (level, lock) => {
        phone({ level, sensor: false, enrolled: false });
        expect(await LocalAuth.getScreenLock()).toBe(lock);
    });

    it("a phone that can't say is unknown, never none", async () => {
        phone({ level: 'throws', sensor: false, enrolled: false });
        expect(await LocalAuth.getScreenLock()).toBe('unknown');
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}

describe('Settings: App Lock', () => {
    const settings = () => code(fs.readFileSync(path.resolve(__dirname, '../../app/(tabs)/settings.tsx'), 'utf-8'));
    const toggle = () => slice(settings(), 'const handleToggleAppLock = async () => {', '\n    };\n');

    it("turning it on or off asks the phone's lock first, so a phone with only a PIN can turn it on", () => {
        const body = toggle();
        const asked = body.indexOf('const success = await authenticateUser(');
        const passed = body.indexOf('if (success) {');
        expect(asked).toBeGreaterThan(-1);
        expect(passed).toBeGreaterThan(asked);
        expect(body.indexOf('await setAppLockEnabled(newValue);')).toBeGreaterThan(passed);
    });

    it('on a phone with no screen lock, turning it on says so and leaves it off, instead of "App Lock enabled" and nothing asked', () => {
        const body = toggle();
        const checked = body.indexOf("if (!appLockEnabled && (await getScreenLock()) === 'none') {");
        const told = body.indexOf("Alert.alert('Set a screen lock first', APP_LOCK_NEEDS_SCREEN_LOCK);");
        const left = body.indexOf('return;', told);
        expect(checked).toBeGreaterThan(-1);
        expect(told).toBeGreaterThan(checked);
        expect(left).toBeGreaterThan(told);
        expect(body.indexOf('await authenticateUser(')).toBeGreaterThan(left);
        expect(body.indexOf('setAppLockEnabled(')).toBeGreaterThan(left);
    });

    it('the row says what it asks for', () => {
        expect(settings()).toContain("<Text style={styles.menuSub}>Asks for your phone's screen lock when BeanPool opens</Text>");
        expect(settings()).not.toContain('Require security passcode on app launch');
    });

    it('the message names every kind of screen lock and the one thing to do', () => {
        const m = LocalAuth.APP_LOCK_NEEDS_SCREEN_LOCK;
        expect(m).toMatch(/PIN, pattern, password, fingerprint or face/);
        expect(m).toMatch(/no screen lock/);
        expect(m).toMatch(/Set one in your phone.s settings/);
    });
});
