/**
 * Linking a sign-in asks the phone's lock first (PR #1205 review 4112404429).
 *
 * Account Protection's "Protect with" Google/Facebook/… (and Connect again) seals the account's private key AND its 12
 * words to whichever sign-in account is used. With no check, anyone holding the unlocked phone could link THEIR OWN
 * Google account, then restore the account on their own phone with it. The global door does the same for the phone's
 * account when it joins with it: the join carries a recovery copy sealed to the door's sign-in.
 *
 * - connectAndDeposit asks the lock it is handed before anything starts: no node, no provider, no read of the words.
 *   The sheet hands it Settings' check (LocalAuth.authenticateUser), so a phone with no screen lock is let through, as
 *   Settings lets it through, and one with a screen PIN but no fingerprint or face is asked for its PIN. A check that
 *   doesn't pass reads as a cancel: the sheet closes, nothing linked.
 * - The only account that skips it is a key the join wizard has just made (the member's own new account).
 * - The global door asks the same check before its sign-in when the key is the phone's own (not one the door made).
 *
 * Nothing here contacts a node or a provider: the `fetch` stub below plays the member's node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

(globalThis as any).__DEV__ = false;

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    DeviceEventEmitter: { addListener: vi.fn(() => ({ remove: vi.fn() })), emit: vi.fn() },
}));
vi.mock('expo-linking', () => ({
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
    openURL: vi.fn(async () => undefined),
}));
vi.mock('expo-web-browser', () => ({
    openAuthSessionAsync: vi.fn(),
    openBrowserAsync: vi.fn(),
    dismissAuthSession: vi.fn(),
    dismissBrowser: vi.fn(async () => undefined),
}));
vi.mock('expo-apple-authentication', () => ({
    isAvailableAsync: vi.fn(async () => false),
    signInAsync: vi.fn(),
    AppleAuthenticationScope: { EMAIL: 0, FULL_NAME: 1 },
}));
vi.mock('expo-crypto', () => ({
    getRandomBytes: vi.fn((len: number) => new Uint8Array(len).fill(9)),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => (key === 'beanpool_anchor_url' ? 'https://test.example' : null)),
        setItem: vi.fn(async () => undefined),
        removeItem: vi.fn(async () => undefined),
    },
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-local-authentication', () => ({
    SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
    getEnrolledLevelAsync: vi.fn(),
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));

/** What happened, in order: the phone's prompt, every read of the words, every request. */
const events: string[] = [];
// The real accessor, watched: a read of the words is a call to it (the deposit seals them).
vi.mock('../identity', async (importOriginal) => {
    const real = await importOriginal<typeof import('../identity')>();
    return {
        ...real,
        getMnemonic: vi.fn(async (identity: Parameters<typeof real.getMnemonic>[0]) => {
            events.push('read');
            return real.getMnemonic(identity);
        }),
    };
});

import * as LocalAuthentication from 'expo-local-authentication';
import * as WebBrowser from 'expo-web-browser';
import { SsoSignInError } from '../sso-signin';
import { connectAndDeposit } from '../sso-sheet-connect';
import { authenticateUser } from '../LocalAuth';
import { getMnemonic } from '../identity';

const NODE = 'https://test.example';
const NONCE = '/api/recovery/sso-nonce';
const DEPOSIT = '/api/recovery/shares/sso';

// Test phrase only (a BIP-39 vector), never a real account's.
const MEMBER = {
    publicKey: 'aa'.repeat(32),
    privateKey: '07'.repeat(32),
    callsign: 'member',
    createdAt: '2026-09-25T00:00:00Z',
    mnemonic: 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' '),
} as any;

type Phone = 'passes' | 'fails' | 'cancelled' | 'prompt throws' | 'no screen lock and no sensor'
    | 'no screen lock and a sensor with nothing enrolled';
/** The lock a prompt asks for: a fingerprint or face, or a screen PIN, pattern or passcode alone. */
type Lock = 'a fingerprint or face' | 'a PIN and no sensor' | 'a PIN and a sensor with nothing enrolled';

/** The phone's lock, as expo-local-authentication reports it. */
function phone(kind: Phone, lock: Lock = 'a fingerprint or face') {
    const noLock = kind === 'no screen lock and no sensor' || kind === 'no screen lock and a sensor with nothing enrolled';
    vi.mocked(LocalAuthentication.getEnrolledLevelAsync).mockResolvedValue((noLock ? 0 : lock === 'a fingerprint or face' ? 3 : 1) as never);
    vi.mocked(LocalAuthentication.hasHardwareAsync).mockResolvedValue(kind !== 'no screen lock and no sensor' && lock !== 'a PIN and no sensor');
    vi.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(!noLock && lock === 'a fingerprint or face');
    vi.mocked(LocalAuthentication.authenticateAsync).mockImplementation(async () => {
        events.push('prompt');
        if (kind === 'prompt throws') throw new Error('prompt failed');
        if (kind === 'passes') return { success: true };
        return { success: false, error: kind === 'cancelled' ? 'user_cancel' : 'authentication_failed' } as never;
    });
}

function answer(status: number, body: unknown = {}): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Headers(),
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

/** The member's node, through a Facebook sign-in and a deposit. Every request is an event, and so is the provider. */
function installNode(): void {
    globalThis.fetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (!url.startsWith(`${NODE}/`)) throw new TypeError(`Network request failed: the app contacted ${url}`);
        const p = url.slice(NODE.length);
        events.push(p);
        if (p === NONCE) return answer(200, { nonce: 'n-1', expiresInSeconds: 600, providers: ['facebook'] });
        if (p === DEPOSIT) return answer(200, { generation: 1, enrolledSso: ['facebook'], threshold: 1 });
        return answer(404, { error: 'Not Found' });
    }) as any;
    // Facebook's dialog, answering with an id_token bound to the nonce it was asked with.
    vi.mocked(WebBrowser.openAuthSessionAsync).mockImplementation(async (authUrl: string) => {
        events.push('provider');
        const nonce = new URL(authUrl).searchParams.get('nonce') ?? '';
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const idToken = `${b64({ alg: 'RS256' })}.${b64({ sub: '10229876543210987', nonce })}.c2ln`;
        return { type: 'success', url: `https://beanpool.org/auth/facebook#${new URLSearchParams({ id_token: idToken, state: nonce })}` } as any;
    });
}

const REASON = 'Confirm authentication to link a sign-in to your account.';

/** The sheet's connect, handed the lock the sheet hands it. */
async function connect(phoneLock: (() => Promise<boolean>) | null, signal = new AbortController().signal) {
    const outcome = connectAndDeposit({
        provider: 'facebook',
        url: NODE,
        identity: MEMBER,
        phoneLock,
        onSignedIn: () => {},
        signal,
    }).then((value) => ({ value, error: undefined as unknown }), (error) => ({ value: undefined, error }));
    await vi.advanceTimersByTimeAsync(20_000);
    return outcome;
}
const settingsCheck = () => authenticateUser(REASON);

let originalFetch: typeof fetch;
beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    originalFetch = globalThis.fetch;
    installNode();
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
});

describe("connectAndDeposit: the phone's lock before a sign-in is linked", () => {
    it('asks first, before the node, the provider or the words, then links once it passes', async () => {
        phone('passes');

        const { value, error } = await connect(settingsCheck);

        expect(error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
        expect(events[0]).toBe('prompt');
        expect(events.filter((e) => e === 'prompt')).toHaveLength(1);
        expect(events).toContain(DEPOSIT);
        expect(events.indexOf('read')).toBeGreaterThan(0);
        expect(vi.mocked(LocalAuthentication.authenticateAsync).mock.calls[0][0]).toMatchObject({ promptMessage: REASON });
    });

    it.each(['fails', 'cancelled', 'prompt throws'] as const)(
        'a check that %s links nothing, asks nothing of the node and reads nothing, and reads as a cancel',
        async (kind) => {
            phone(kind);

            const { value, error } = await connect(settingsCheck);

            expect(value).toBeUndefined();
            expect(error).toBeInstanceOf(SsoSignInError);
            expect((error as SsoSignInError).reason).toBe('cancelled');
            expect(events).toEqual(['prompt']);
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(getMnemonic).not.toHaveBeenCalled();
        },
    );

    // A screen PIN, pattern or passcode is a lock: no fingerprint or face is not "nothing to ask with".
    it.each(['a PIN and no sensor', 'a PIN and a sensor with nothing enrolled'] as const)(
        'a phone with %s is asked for its PIN: a cancel links nothing and reads nothing, a pass links',
        async (lock) => {
            phone('cancelled', lock);
            const refused = await connect(settingsCheck);

            expect((refused.error as SsoSignInError).reason).toBe('cancelled');
            expect(events).toEqual(['prompt']);
            expect(globalThis.fetch).not.toHaveBeenCalled();
            expect(getMnemonic).not.toHaveBeenCalled();

            vi.clearAllMocks();
            events.length = 0;
            phone('passes', lock);
            const { value, error } = await connect(settingsCheck);

            expect(error).toBeUndefined();
            expect(value?.enrolledSso).toEqual(['facebook']);
            expect(events[0]).toBe('prompt');
            expect(vi.mocked(LocalAuthentication.authenticateAsync).mock.calls[0][0]).toMatchObject({
                promptMessage: REASON,
                disableDeviceFallback: false,
            });
        },
    );

    it.each(['no screen lock and no sensor', 'no screen lock and a sensor with nothing enrolled'] as const)(
        'a phone with %s has nothing to ask with and is let through, as Settings lets it through',
        async (kind) => {
            phone(kind);
            const settingsLetsThrough = await authenticateUser(REASON);

            const { value, error } = await connect(settingsCheck);

            expect(settingsLetsThrough).toBe(true);
            expect(error).toBeUndefined();
            expect(value?.enrolledSso).toEqual(['facebook']);
            expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
        },
    );

    it('a sheet closed while the check was up starts nothing', async () => {
        phone('passes');
        const abort = new AbortController();

        const { error } = await connect(async () => {
            const passed = await settingsCheck();
            abort.abort();
            return passed;
        }, abort.signal);

        expect((error as SsoSignInError).reason).toBe('cancelled');
        expect(events).toEqual(['prompt']);
    });

    it('no lock is asked only when the caller says so (a key the join wizard has just made)', async () => {
        phone('fails');

        const { value, error } = await connect(null);

        expect(error).toBeUndefined();
        expect(value?.enrolledSso).toEqual(['facebook']);
        expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}

describe('components/SsoEnrolSheet.tsx: Protect with / Connect again / Try again', () => {
    const sheet = () => read('components/SsoEnrolSheet.tsx');

    it("hands connectAndDeposit Settings' check unless told this is a key the join wizard just made", () => {
        const s = sheet();
        expect(s).toContain("import { authenticateUser } from '../utils/LocalAuth';");
        expect(s).toMatch(/askPhoneLock = true,/);
        expect(s).toContain(`phoneLock: askPhoneLock ? () => authenticateUser('${REASON}') : null,`);
    });

    it('a check that did not pass closes the sheet, as a cancelled sign-in does', () => {
        const connectBody = slice(sheet(), 'const handleConnect = async () => {', '\n    };\n');
        expect(connectBody).toMatch(/if \(e\.reason === 'cancelled'\) \{\s*onClose\(\);\s*return;\s*\}/);
    });

    it("Settings' sheet (the phone's own account) always asks", () => {
        const settingsSheet = slice(read('app/(tabs)/settings.tsx'), '<SsoEnrolSheet', '/>');
        expect(settingsSheet).not.toContain('askPhoneLock');
    });

    it("the join wizard's sheet skips it only for a key this join made", () => {
        const welcomeSheet = slice(read('app/welcome.tsx'), '<SsoEnrolSheet', '/>');
        expect(welcomeSheet).toContain('askPhoneLock={!pendingWordsAreNew}');
    });
});

describe("welcome.tsx: the global door's sign-in with the phone's own key", () => {
    it('asks the lock before the sign-in starts, unless the door made the key; a check that does not pass starts nothing', () => {
        const s = read('app/welcome.tsx');
        expect(s).toContain("import { authenticateUser } from '../utils/LocalAuth';");
        const body = slice(s, 'async function handleGlobalSignIn(provider: SsoProvider) {', '\n    }\n');
        const key = body.indexOf('const key = await joinKeyForThisPhone(globalKey);');
        const asked = body.indexOf(`if (!key.createdHere && !(await authenticateUser('${REASON}'))) return;`);
        const signIn = body.indexOf('await signInAtDoor(');
        expect(key).toBeGreaterThan(-1);
        expect(asked).toBeGreaterThan(key);
        expect(signIn).toBeGreaterThan(asked);
    });
});
