/**
 * The phone's lock before an account's 12 words (utils/words-behind-lock.ts).
 *
 * Settings' View Recovery Phrase has always asked the phone's biometric or passcode check before it drew the words.
 * "Replace this phone's account?" (welcome.tsx) drew the OUTGOING account's words with no check at all, and had read
 * them the moment the screen opened; anyone holding an unlocked phone reaches that screen by starting a restore with
 * another account's words. Account Protection's "Show My 12 Recovery Words" and node-mismatch's "Delete this account
 * from this phone" drew them with no check too.
 *
 * - Every screen that shows or copies an account's words reads them through readWordsBehindLock, whose check IS
 *   Settings' check (LocalAuth.authenticateUser), so it behaves the same everywhere, including on a phone with no
 *   biometric or passcode set up: let through, as Settings lets it through.
 * - A failed, cancelled or broken check reads nothing.
 * - The replace screen reads the outgoing account's words only when Show passes the check, never as it opens.
 *
 * The screens cannot be rendered here (see vitest.config.ts): their wiring is read from their source.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webcrypto } from 'node:crypto';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-crypto', () => ({
    getRandomBytes: (n: number) => webcrypto.getRandomValues(new Uint8Array(n)),
}));
vi.mock('expo-secure-store', () => ({
    getItemAsync: vi.fn(async () => null),
    setItemAsync: vi.fn(async () => undefined),
    deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(), removeItem: vi.fn() },
}));

/** What happened, in order: the phone's prompt, and every read of the words. */
const events: string[] = [];
vi.mock('expo-local-authentication', () => ({
    hasHardwareAsync: vi.fn(),
    isEnrolledAsync: vi.fn(),
    authenticateAsync: vi.fn(),
}));
// The real accessor, watched: a read of the words is a call to it.
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
import { getMnemonic, type BeanPoolIdentity } from '../identity';
import { authenticateUser } from '../LocalAuth';

// Test phrase only (a BIP-39 vector), never a real account's.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow'.split(' ');
const ACCOUNT: BeanPoolIdentity = { publicKey: 'ab'.repeat(32), privateKey: 'cd'.repeat(32), callsign: 'Kim', createdAt: '', mnemonic: WORDS };
const NO_WORDS: BeanPoolIdentity = { ...ACCOUNT, mnemonic: undefined };
const SETTINGS_REASON = 'Confirm your security to view your recovery phrase.';

/** Imported at the test, not the top: on a tree without it, only the tests that use it fail. */
const gate = async () => (await import('../words-behind-lock')).readWordsBehindLock;

type Phone = 'passes' | 'fails' | 'cancelled' | 'prompt throws' | 'no hardware' | 'nothing enrolled' | 'hardware check throws';

/** The phone's lock, as expo-local-authentication reports it. */
function phone(kind: Phone) {
    vi.mocked(LocalAuthentication.hasHardwareAsync).mockImplementation(async () => {
        if (kind === 'hardware check throws') throw new Error('no module');
        return kind !== 'no hardware';
    });
    vi.mocked(LocalAuthentication.isEnrolledAsync).mockResolvedValue(kind !== 'nothing enrolled');
    vi.mocked(LocalAuthentication.authenticateAsync).mockImplementation(async () => {
        events.push('prompt');
        if (kind === 'prompt throws') throw new Error('prompt failed');
        if (kind === 'passes') return { success: true };
        return { success: false, error: kind === 'cancelled' ? 'user_cancel' : 'authentication_failed' } as never;
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    events.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('readWordsBehindLock', () => {
    it("asks the phone's lock first, with the screen's reason, and reads the words only once it passes", async () => {
        phone('passes');
        const read = await gate();

        expect(await read(ACCOUNT, "Confirm your security to view Kim's recovery phrase.")).toEqual(WORDS);

        expect(events).toEqual(['prompt', 'read']);
        expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
        expect(vi.mocked(LocalAuthentication.authenticateAsync).mock.calls[0][0]).toMatchObject({
            promptMessage: "Confirm your security to view Kim's recovery phrase.",
        });
    });

    it.each(['fails', 'cancelled', 'prompt throws'] as const)('a check that %s reads nothing and gives nothing', async (kind) => {
        phone(kind);
        const read = await gate();

        expect(await read(ACCOUNT, SETTINGS_REASON)).toBeNull();

        expect(events).toEqual(['prompt']);
        expect(getMnemonic).not.toHaveBeenCalled();
    });

    it.each(['no hardware', 'nothing enrolled'] as const)(
        'a phone with %s has nothing to ask with and is let through, as Settings lets it through',
        async (kind) => {
            phone(kind);
            const read = await gate();

            expect(await read(ACCOUNT, SETTINGS_REASON)).toEqual(WORDS);
            expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
            expect(events).toEqual(['read']);
        },
    );

    it.each(['passes', 'fails', 'cancelled', 'prompt throws', 'no hardware', 'nothing enrolled', 'hardware check throws'] as const)(
        "gives the same answer as Settings' check (LocalAuth.authenticateUser) when the phone %s",
        async (kind) => {
            phone(kind);
            const settingsLetsThrough = await authenticateUser(SETTINGS_REASON);
            vi.clearAllMocks();
            events.length = 0;
            phone(kind);
            const read = await gate();

            const words = await read(ACCOUNT, SETTINGS_REASON);

            expect(words !== null).toBe(settingsLetsThrough);
            expect(getMnemonic).toHaveBeenCalledTimes(settingsLetsThrough ? 1 : 0);
        },
    );

    it('an account with no words gives null after the check, as Settings does', async () => {
        phone('passes');
        const read = await gate();

        expect(await read(NO_WORDS, SETTINGS_REASON)).toBeNull();
        expect(events).toEqual(['prompt', 'read']);
    });
});

/** Code only: what a comment says is not what the screen does. */
const code = (s: string) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const source = (rel: string) => code(fs.readFileSync(path.resolve(__dirname, '../../app', rel), 'utf-8'));
/** From `start` to the first `end` after it. */
function slice(s: string, start: string, end: string): string {
    const from = s.indexOf(start);
    expect(from, `missing: ${start}`).toBeGreaterThan(-1);
    const to = s.indexOf(end, from + start.length);
    expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
    return s.slice(from, to);
}
const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('"Replace this phone\'s account?" (welcome.tsx)', () => {
    const welcome = () => source('welcome.tsx');
    const screen = () => slice(welcome(), "if (mode === 'confirmReplace' && outgoingIdentity) {", "if (mode === 'recover') {");
    const show = () => slice(welcome(), 'async function handleShowOutgoingSeed() {', '\n    }\n');

    it('Show goes through the check: the button calls the handler, which asks the lock before it reads or shows', () => {
        expect(screen()).toContain('onPress={handleShowOutgoingSeed}');
        expect(screen()).not.toContain('setShowOutgoingSeed(true)');

        const body = show();
        const asked = body.indexOf('await readWordsBehindLock(account,');
        const refused = body.indexOf('if (!words ');
        const kept = body.indexOf('setOutgoingWords(words)');
        const shown = body.indexOf('setShowOutgoingSeed(true)');
        expect(asked).toBeGreaterThan(-1);
        expect(refused).toBeGreaterThan(asked);
        expect(kept).toBeGreaterThan(refused);
        expect(shown).toBeGreaterThan(refused);
    });

    it('the words are shown, and put in state, nowhere but after that check', () => {
        const s = welcome();
        expect(count(s, 'setShowOutgoingSeed(true)')).toBe(1);
        expect(count(s, 'setOutgoingWords(words)')).toBe(1);
        // Every other write puts them away.
        expect(s.match(/setOutgoingWords\((?!words\)|null\))/g)).toBeNull();
    });

    it('the outgoing account\'s words are never read as the screen opens, nor by Copy', () => {
        const s = welcome();
        expect(s).not.toMatch(/getMnemonic\(\s*outgoingIdentity/);
        expect(s).not.toMatch(/getMnemonic\(\s*account/);
        // Copy is only drawn once they are shown, and copies what the check let through.
        const copy = slice(s, 'async function handleCopyOutgoingSeed() {', '\n    }\n');
        expect(copy).toContain('const words = outgoingWords;');
        expect(copy).not.toContain('getMnemonic');
    });

    it('a check still answering when the screen moves to another account, or off it, shows nothing', () => {
        const body = show();
        expect(body).toContain('const account = outgoingIdentity;');
        expect(body).toMatch(/if \(!words \|\| outgoingIdentityRef\.current !== account\) return;/);
        expect(welcome()).toMatch(/useEffect\(\(\) => \{\s*setOutgoingWords\(null\);\s*\}, \[outgoingIdentity\]\);/);
    });
});

describe('every other screen that draws an account\'s words', () => {
    it("Settings: View Recovery Phrase and Account Protection's Show ask the same check with the same words", () => {
        const s = source('(tabs)/settings.tsx');
        expect(count(s, `await readWordsBehindLock(identity, '${SETTINGS_REASON}')`)).toBe(2);
        expect(slice(s, 'const handleRevealWords = async () => {', '\n    };\n')).toContain('await readWordsBehindLock(identity,');
        // Copy Words copies what was shown, not a fresh read.
        expect(slice(s, 'const handleCopySeed = async () => {', '\n    };\n')).toContain('const words = seedWords;');
        expect(s).not.toContain('getMnemonic(');
    });

    it("node-mismatch: the words drawn before its delete are behind the check, and a refused check opens nothing", () => {
        const s = source('node-mismatch.tsx');
        const start = slice(s, 'async function handleStartWipe() {', '\n    }\n');
        expect(start).toContain('await readWordsBehindLock(identity,');
        expect(start).toMatch(/if \(!w\) return;/);
        expect(s).not.toContain('getMnemonic(');
    });

    it('no screen reads the words any other way', () => {
        // Walk app/: every getMnemonic( left is one of these, and each is not a way to see someone else's words.
        const allowed: Record<string, number> = {
            // The member's OWN new words, on onboarding's Safety Backup step (and its Copy), before the account exists.
            'welcome.tsx:getMnemonic(pendingIdentity)': 2,
            // Sends the account (key and words) to a desktop the member pairs with; draws nothing. See the PR.
            'pair-device.tsx:getMnemonic(identity)': 1,
        };
        const found: Record<string, number> = {};
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) {
                    const rel = path.relative(path.resolve(__dirname, '../../app'), full);
                    for (const m of code(fs.readFileSync(full, 'utf-8')).matchAll(/getMnemonic\([^)]*\)/g)) {
                        const key = `${rel}:${m[0]}`;
                        found[key] = (found[key] ?? 0) + 1;
                    }
                }
            }
        };
        walk(path.resolve(__dirname, '../../app'));
        expect(found).toEqual(allowed);
    });
});
