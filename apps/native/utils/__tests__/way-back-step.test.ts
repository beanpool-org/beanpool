/**
 * The join's way back (slice S4, scratch/fable-design/DESIGN-onboarding-home-landing-fable.md §3.1 E). Tier A: the way back must
 * stay reachable, and nothing may say it is kept when it isn't.
 *
 * - The rules (utils/join-steps.ts): kept only by a sign-in's copy, the tick (or Yes after the kit), or what the phone already
 *   knew; skipped only then, and never on a claim; the button "Later" until kept, then "Next" where a screen follows, else
 *   "Let's go"; the dots one fewer where it is skipped, per path.
 * - "Later" is true to its word: Home's "Your way back in" card shows from the first landing (utils/one-way-back.ts
 *   startOneWayBackShown); a way back kept starts it put away, as before.
 * - What the phone already knew (utils/way-back-kept.ts): a vault copy, a sign-in the community said was added, the words
 *   noted as written down; "taken back" counts as not.
 * - welcome.tsx wires these: one place decides the skip, the button, the record and what follows the way back (N1j's hook).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
// one-way-back.ts signs its asks of the node; nothing here asks one.
vi.mock('../node-post', () => ({ signedGet: vi.fn(async () => { throw new Error('no node in this test'); }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
const vault = vi.hoisted(() => ({ kept: false }));
vi.mock('../vault', () => ({ vaultCopyKnown: vi.fn(async () => vault.kept) }));
vi.mock('../ways-back', async () => {
    const { readOneWayBack } = await import('../one-way-back');
    const { wordsWrittenDownStoreKey } = await import('../storage-keys');
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    // The real rule, without ways-back.ts's network imports: '1' or '0' said, else "I still have my 12 words" on the card.
    return {
        wordsWrittenDown: async (publicKey: string) => {
            const v = await AsyncStorage.getItem(wordsWrittenDownStoreKey(publicKey));
            if (v === '1') return true;
            if (v === '0') return false;
            return (await readOneWayBack(publicKey))?.done === 'checked';
        },
    };
});

import { afterWayBack, joinSteps, stepDot, wayBackButton, wayBackKept, wayBackSkipped } from '../join-steps';
import { oneWayBackPlace, readOneWayBack, startOneWayBack, startOneWayBackPutAway, startOneWayBackShown } from '../one-way-back';
import { wayBackKeptBefore } from '../way-back-kept';
import { oneWayBackStoreKey, wordsWrittenDownStoreKey } from '../storage-keys';
import type { OnboardingFlow } from '../onboarding-state';

const KEY = 'cd'.repeat(32);
const URL = 'https://riverside.example';
const DAY = 24 * 60 * 60 * 1000;
const JOINED = Date.UTC(2026, 10, 21, 9, 0, 0);

beforeEach(() => {
    store.map.clear();
    vault.kept = false;
});

describe('the rules: kept, skipped, the button, what follows', () => {
    it('kept only by a sign-in\'s copy, the tick, or what the phone already knew', () => {
        const rows: Array<[{ signIn: boolean; wordsTicked: boolean; before: boolean }, boolean]> = [
            [{ signIn: false, wordsTicked: false, before: false }, false],
            [{ signIn: true, wordsTicked: false, before: false }, true],
            [{ signIn: false, wordsTicked: true, before: false }, true],
            [{ signIn: false, wordsTicked: false, before: true }, true],
            [{ signIn: true, wordsTicked: true, before: true }, true],
        ];
        for (const [k, want] of rows) expect(wayBackKept(k), JSON.stringify(k)).toBe(want);
    });

    it('skipped only where a way back is already kept, and never on a claim (the owner\'s way back is the community\'s)', () => {
        const flows: OnboardingFlow[] = ['invite', 'global', 'claim'];
        for (const flow of flows) {
            expect(wayBackSkipped(flow, false), `${flow}, nothing kept`).toBe(false);
            expect(wayBackSkipped(flow, true), `${flow}, kept`).toBe(flow !== 'claim');
        }
    });

    it('"Later" until kept; then "Next" where a screen follows (the owner\'s card), else "Let\'s go" into Home', () => {
        expect(afterWayBack('invite')).toBe('home');
        expect(afterWayBack('global')).toBe('home');
        expect(afterWayBack('claim')).toBe('ownerCard');
        expect(wayBackButton(false, 'home')).toBe('later');
        expect(wayBackButton(false, 'ownerCard')).toBe('later');
        expect(wayBackButton(true, 'home')).toBe('letsGo');
        expect(wayBackButton(true, 'ownerCard')).toBe('next');
    });

    // The dots per path the brief names: one per screen the member will actually see. Skipped, the way back has no dot, and
    // the photo is the last of two. The restore and the front door are no join (join-steps.test.ts).
    it('the dots per path, with the way back shown and skipped', () => {
        const rows: Array<{ path: string; flow: OnboardingFlow; wayBack: boolean; name: string | null; photo: string; wayBackDot: string | null }> = [
            { path: 'an invite found on the phone', flow: 'invite', wayBack: true, name: '1/3', photo: '2/3', wayBackDot: '3/3' },
            { path: 'an invite typed on Your invite', flow: 'invite', wayBack: true, name: '1/3', photo: '2/3', wayBackDot: '3/3' },
            { path: 'an invite, the phone\'s account already kept a way back', flow: 'invite', wayBack: false, name: '1/2', photo: '2/2', wayBackDot: null },
            { path: 'look around, then the global door in by 12 words', flow: 'global', wayBack: true, name: '1/3', photo: '2/3', wayBackDot: '3/3' },
            { path: 'look around, then the global door by a sign-in whose copy was kept', flow: 'global', wayBack: false, name: '1/2', photo: '2/2', wayBackDot: null },
            { path: 'a claim, never skipped', flow: 'claim', wayBack: true, name: null, photo: '1/2', wayBackDot: '2/2' },
        ];
        const at = (d: { at: number; of: number } | null) => (d ? `${d.at}/${d.of}` : null);
        for (const r of rows) {
            const steps = joinSteps(r.flow, { wayBack: r.wayBack });
            expect(at(stepDot(steps, 'name')), `${r.path}: name`).toBe(r.name);
            expect(at(stepDot(steps, 'photo')), `${r.path}: photo`).toBe(r.photo);
            expect(at(stepDot(steps, 'wayBack')), `${r.path}: way back`).toBe(r.wayBackDot);
        }
        // Left out, the list is as before: N1j adds its step after the way back in one place.
        expect(joinSteps('invite')).toEqual(['name', 'photo', 'wayBack']);
        expect(joinSteps('invite', { wayBack: true })).toEqual(['name', 'photo', 'wayBack']);
    });
});

describe('"Later" brings Home\'s card from day one; a way back kept starts it put away', () => {
    it('Later: the card on the first landing, and after it is put away it comes back on its schedule, never gone for good', async () => {
        await startOneWayBackShown(KEY, URL, JOINED);
        const record = await readOneWayBack(KEY);
        expect(record).toEqual({ url: URL, joinedAt: JOINED, by: 'wayBack' });
        expect(oneWayBackPlace(record, JOINED + 60_000, false), 'the first landing').toBe('card');
        expect(oneWayBackPlace(record, JOINED + 3 * DAY, false), 'day three, not put away').toBe('card');
    });

    it('kept: put away from the start, as before S4', async () => {
        await startOneWayBackPutAway(KEY, URL, JOINED);
        expect(oneWayBackPlace(await readOneWayBack(KEY), JOINED + 60_000, false)).toBe('settings');
    });

    it('a record already there stands: the 12-words door\'s own, or one a Yes after the kit finished', async () => {
        await startOneWayBack(KEY, 'https://open.riverbend.example', JOINED);
        await startOneWayBackShown(KEY, URL, JOINED + 1);
        expect((await readOneWayBack(KEY))?.url).toBe('https://open.riverbend.example');

        store.map.clear();
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL, joinedAt: JOINED, dismissedAt: JOINED, by: 'wayBack', done: 'checked' }));
        await startOneWayBackShown(KEY, URL, JOINED + 1);
        expect((await readOneWayBack(KEY))?.done).toBe('checked');
        expect(oneWayBackPlace(await readOneWayBack(KEY), JOINED + 60_000, false)).toBe('none');
    });
});

describe('what the phone already knew of the account: storage only, and only what is true', () => {
    it('nothing known: not kept, so the step shows', async () => {
        expect(await wayBackKeptBefore(KEY)).toBe(false);
    });
    it('a copy at the key vault: kept', async () => {
        vault.kept = true;
        expect(await wayBackKeptBefore(KEY)).toBe(true);
    });
    it('the community said a sign-in was added: kept', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL, joinedAt: JOINED, done: 'linked' }));
        expect(await wayBackKeptBefore(KEY)).toBe(true);
    });
    it('"I still have my 12 words", or the words noted as written down: kept', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL, joinedAt: JOINED, done: 'checked' }));
        expect(await wayBackKeptBefore(KEY)).toBe(true);
        store.map.clear();
        store.map.set(wordsWrittenDownStoreKey(KEY), '1');
        expect(await wayBackKeptBefore(KEY)).toBe(true);
    });
    it('the words taken back ("0"), over an old "I still have them": not kept', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL, joinedAt: JOINED, done: 'checked' }));
        store.map.set(wordsWrittenDownStoreKey(KEY), '0');
        expect(await wayBackKeptBefore(KEY)).toBe(false);
    });
    it('a reminder still running (not done, not put away): not kept', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: URL, joinedAt: JOINED, by: 'wayBack' }));
        expect(await wayBackKeptBefore(KEY)).toBe(false);
    });
});

describe('welcome.tsx wires them in one place each', () => {
    const welcome = fs.readFileSync(path.join(__dirname, '..', '..', 'app/welcome.tsx'), 'utf8');
    const between = (from: string, to: string) => {
        const a = welcome.indexOf(from);
        expect(a, from).toBeGreaterThan(-1);
        const b = welcome.indexOf(to, a + from.length);
        expect(b, to).toBeGreaterThan(a);
        return welcome.slice(a, b);
    };
    const step = () => between("if (mode === 'seedBackup' && pendingIdentity)", "if (mode === 'ownerCard' && pendingIdentity)");

    it('kept and skipped from the same facts; the words ticked count only once the step is open', () => {
        expect(welcome).toContain("const signInKept = protection.state === 'covered';");
        expect(welcome).toContain('const skipWayBack = wayBackSkipped(joinFlow, wayBackKept({ signIn: signInKept, wordsTicked: false, before: keptBefore }));');
        expect(welcome).toContain('const wayBackIsKept = wayBackKept({ signIn: signInKept, wordsTicked: seedConfirmed, before: keptBefore });');
        // Read from storage for the account the join holds, false until read and for a new one: never a guess that skips.
        expect(between('const [keptBefore, setKeptBefore] = useState(false);', '}, [pendingKey]);')).toMatch(/setKeptBefore\(false\);\s*if \(!pendingKey\) return;/);
    });

    it('the photo goes on to the way back, or past it to Home only where one is kept', () => {
        const to = between('async function toWayBack() {', '\n    }\n');
        expect(to).toContain('if (skipWayBack) return handleConfirmSeed();');
        expect(to).toContain("setMode('seedBackup');");
        const profile = between('async function handleCompleteProfile() {', '\n    }\n');
        expect(profile.match(/await toWayBack\(\);/g)).toHaveLength(2);
        expect(profile).not.toContain("setMode('seedBackup')");
    });

    it('the record at the end: put away only when a way back is kept, else the card from day one', () => {
        const confirm = between('async function handleConfirmSeed() {', '\n    }\n');
        expect(confirm).toContain('const startReminder = wayBackIsKept ? startOneWayBackPutAway : startOneWayBackShown;');
        expect(confirm.match(/startOneWayBackPutAway\(/g)).toBeNull();
    });

    it('the button\'s words from the rule, and what follows from afterWayBack: N1j hangs off one place', () => {
        const s = step();
        expect(s).toContain('const next = afterWayBack(joinFlow);');
        expect(s).toContain('const button = wayBackButton(wayBackIsKept, next);');
        expect(s).toContain("{button === 'later' ? t('Later') : button === 'next' ? t('Next') : t(\"Let's go\")}");
        expect(s).toContain("if (next === 'ownerCard') {");
        // A choice is counted as what it was: a sign-in's copy, the words, or Later.
        expect(s).toContain("recordOnboardingEvent('protection_choice', signInKept ? 'sso' : seedConfirmed ? 'words' : 'skip');");
    });

    it('two tiles; the vault\'s sentences open at Link a sign-in, before any Protect button; the words at their tile', () => {
        const s = step();
        const tile = s.indexOf("title={t('Link a sign-in')}");
        const panel = s.indexOf('<KeeperProtectionPanel');
        const words = s.indexOf("title={t('Write down 12 words')}");
        expect(tile).toBeGreaterThan(-1);
        expect(panel).toBeGreaterThan(-1);
        expect(words).toBeGreaterThan(tile);
        // The panel only once opened, kept, or where the community keeps none (its row says why no sign-in is offered).
        expect(s).toContain("{backupCopiesAt === 'none' || signInKept || signInOpen || Platform.OS === 'web' ? (");
        expect(s).toContain('waysBack={!signInKept}');
        // The sentence Marty approved, 21 Nov; "your account goes too" is not true where an admin can set a member up again.
        expect(s).toContain("t('If this phone is lost, this is how you get back in.')");
        expect(s).not.toContain('Lose this phone');
    });

    it('the recovery truth stays beside the words, and the Yes after the kit ticks the box', () => {
        const s = step();
        expect(s).toContain("t('Nobody can reset them: not us, not this community.')");
        expect(between('const keptFromKit = () => {', '};')).toContain('setSeedConfirmed(true);');
    });
});
