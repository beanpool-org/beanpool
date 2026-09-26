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
 * - Every other way the account leaves the phone or comes off it asks the same check (the last describe lists them).
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
            // Safety Backup, only for a key this join made (the member's own new words). A key the phone already had is
            // read through readWordsBehindLock instead (join-words-behind-lock.test.ts; review 4112404374).
            'welcome.tsx:getMnemonic(pendingIdentity)': 1,
            // Confirm & Link Device sends the account (key and words) to a computer: read only after the phone's lock
            // (pair-device-behind-lock.test.ts).
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

describe("every way the account leaves this phone, or comes off it, asks the phone's lock first", () => {
    // The rule (2026-09-27, from Settings, where Sign Out and View Recovery Phrase already ask it): showing or copying the
    // 12 words, sending the account to a computer, linking a sign-in that can restore it, deleting it from the phone and
    // replacing it all ask LocalAuth.authenticateUser first. A check that doesn't pass does nothing and reads nothing.
    const ROOT = path.resolve(__dirname, '../..');
    /** Every .ts/.tsx under app/ and components/, as code. */
    function screens(): { rel: string; src: string }[] {
        const out: { rel: string; src: string }[] = [];
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry.name)) out.push({ rel: path.relative(ROOT, full), src: code(fs.readFileSync(full, 'utf-8')) });
            }
        };
        walk(path.join(ROOT, 'app'));
        walk(path.join(ROOT, 'components'));
        return out;
    }

    it('every door is one of these, and each is pinned to the check before it by the test named beside it', () => {
        const DOOR = /readWordsBehindLock\(|signOutOfThisPhone\(|deleteAccountFromThisPhone\(|answerReplace\(true\)|signInAtDoor\(|submitJoin\(|encryptPairingPayload\(|connectAndDeposit\(/g;
        const doors: Record<string, number> = {
            // View Recovery Phrase and Account Protection's Show (above; settings-words-put-away.test.ts).
            'app/(tabs)/settings.tsx:readWordsBehindLock(': 2,
            // Sign Out (Device Only) and Permanent Node Purge: authenticateUser first, as they always have.
            'app/(tabs)/settings.tsx:signOutOfThisPhone(': 2,
            // The replace screen's Show (above); Safety Backup's Show for the phone's own key (join-words-behind-lock.test.ts).
            'app/welcome.tsx:readWordsBehindLock(': 2,
            // Replace Account (account-removal-behind-lock.test.ts).
            'app/welcome.tsx:answerReplace(true)': 1,
            // The global door's sign-in with the phone's own key, and the join it signs in for (sign-in-link-behind-lock.test.ts).
            'app/welcome.tsx:signInAtDoor(': 1,
            'app/welcome.tsx:submitJoin(': 1,
            // Delete this account from this phone (account-removal-behind-lock.test.ts).
            'app/node-mismatch.tsx:readWordsBehindLock(': 1,
            'app/node-mismatch.tsx:deleteAccountFromThisPhone(': 1,
            // Confirm & Link Device (pair-device-behind-lock.test.ts).
            'app/pair-device.tsx:encryptPairingPayload(': 1,
            // Protect with / Connect again / Try again (sign-in-link-behind-lock.test.ts).
            'components/SsoEnrolSheet.tsx:connectAndDeposit(': 1,
        };
        const found: Record<string, number> = {};
        for (const { rel, src } of screens()) {
            for (const m of src.matchAll(DOOR)) {
                const key = `${rel}:${m[0]}`;
                found[key] = (found[key] ?? 0) + 1;
            }
        }
        expect(found).toEqual(doors);
    });

    it("the global door's join is sent only with a sign-in the door's own sign-in step made (after its check)", () => {
        const s = source('welcome.tsx');
        const join = slice(s, 'async function handleGlobalJoin() {', '\n    }\n');
        expect(join).toMatch(/const signin = doorSignIn;\s*if \(!key \|\| !signin\) \{/);
        expect(s.match(/setDoorSignIn\((?!null\))/g)).toEqual(['setDoorSignIn(']);
        expect(slice(s, 'async function handleGlobalSignIn(provider: SsoProvider) {', '\n    }\n')).toContain('setDoorSignIn(result.signin);');
    });

    it("Sign Out and Permanent Node Purge ask the check before anything goes, as they always have", () => {
        const s = source('(tabs)/settings.tsx');
        for (const [start, reason] of [
            ['async function handleLocalWipe() {', 'Confirm authentication to sign out of this device.'],
            ['async function handleNodePurge() {', 'Confirm authentication to permanently purge your account from the node.'],
        ] as const) {
            const body = slice(s, start, '\n    }\n');
            const asked = body.indexOf(`const success = await authenticateUser('${reason}');`);
            const refused = body.indexOf('if (!success) return;');
            expect(asked).toBeGreaterThan(-1);
            expect(refused).toBeGreaterThan(asked);
            expect(body.indexOf('await signOutOfThisPhone(identity);')).toBeGreaterThan(refused);
        }
    });

    it("every check is Settings' own (LocalAuth.authenticateUser): no screen asks the phone's lock its own way", () => {
        const own = screens().filter(({ src }) => src.includes('expo-local-authentication')).map(({ rel }) => rel);
        expect(own).toEqual([]);
    });
});
