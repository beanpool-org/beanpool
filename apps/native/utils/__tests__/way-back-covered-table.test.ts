/**
 * Every way "a way back is already kept" can be true or false, on every path into a community (review of #3330: the class,
 * not the one row). Tier A: the way-back step may be skipped only where a way back is really kept, and "Later" must bring
 * Home's card.
 *
 * Each row walks a join through the same rules, in the same order, as app/welcome.tsx (its pins are in way-back-step.test.ts):
 * 1. Your name (or the global door): what the phone already knew of its own account (utils/way-back-kept.ts), read for
 *    that account (utils/join-steps.ts `keptBeforeFor`); on the door, the way chosen too (`doorKeepsSignInCopy`). The dots.
 * 2. The join lands: the global door's 12 words start that door's own reminder (`startOneWayBack`, as finishGlobalJoin does);
 *    its sign-in brings the copy that landed, or none.
 * 3. Your photo: read again for the key the join holds; a sign-in's copy counts only when kept (`protectionFrom` covered).
 *    Skipped (`wayBackSkipped`), or shown with its button (`wayBackButton`).
 * 4. The end (handleConfirmSeed): kept starts the reminder put away, else "Later" starts it shown. Home's card on the first
 *    landing is what `oneWayBackPlace` says of the record then.
 *
 * Each row goes red without its line: the vault in wayBackKeptBefore (with a vault copy), the words in it (words noted), the
 * key it is read for (another account's record), `flow !== 'claim'` in wayBackSkipped (every claim row), the covered copy
 * (the door's sign-in rows), the door's way (the door's dots), "Later" over a record marked done (a sign-in with no copy, a
 * failed copy, the words taken back), and no `linked` term in wayBackKeptBefore (the same rows: put it back and they skip).
 *
 * Round 2 of the review: the key vault's knowledge is read for real (utils/vault.ts `vaultSignInCopyKnown`, from what the
 * phone stored), so counting any copy at the vault turns every admins' half row red; and "Later" brings the card over a
 * record put away (the put-away rows go red when Later keeps it). The stored values are what the real deposits and status
 * reads leave, walked against the fake vault in way-back-vault-copies.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KeeperEnrolmentResult } from '../keeper-enrolment';
import type { DoorWay } from '../global-join';
import type { SignInCopies } from '../vault-config';

const store = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('expo-secure-store', () => ({ WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6, getItemAsync: vi.fn(async () => null), setItemAsync: vi.fn(async () => undefined), deleteItemAsync: vi.fn(async () => undefined) }));
// one-way-back.ts signs its asks of the node; nothing here asks one.
vi.mock('../node-post', () => ({ signedGet: vi.fn(async () => { throw new Error('no node in this test'); }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => store.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { store.map.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { store.map.delete(k); }),
    },
}));
// What the phone knows of a copy at the key vault is read by vault.ts itself, from the value stored per key (seed below).
// Its keys come from crypto.ts, which asks expo-crypto for randomness: node's own here.
vi.mock('expo-crypto', async () => {
    const { randomBytes } = await import('node:crypto');
    return { getRandomBytes: vi.fn((len: number) => new Uint8Array(randomBytes(len))) };
});
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

import { afterWayBack, doorKeepsSignInCopy, joinSteps, keptBeforeFor, stepDot, wayBackButton, wayBackKept, wayBackSkipped } from '../join-steps';
import { oneWayBackPlace, putAwayRecord, readOneWayBack, startOneWayBack, startOneWayBackPutAway, startOneWayBackShown, type OneWayBack } from '../one-way-back';
import { wayBackKeptBefore } from '../way-back-kept';
import { protectionFrom } from '../protection-state';
import { oneWayBackStoreKey, vaultCopyKnownStoreKey, wordsWrittenDownStoreKey } from '../storage-keys';
import { vaultSignInCopyKnown } from '../vault';
import { GLOBAL_NODE_URL } from '../node-profile';

const KEY = 'cd'.repeat(32);
const OTHER = 'ef'.repeat(32);
const JOINED_URL = 'https://riverside.example';
const OPEN_URL = 'https://open.riverbend.example';
const BEFORE = Date.UTC(2026, 9, 1, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 21, 9, 0, 0);

beforeEach(() => {
    store.map.clear();
});

// ── What the phone already knew, as each earlier step left it ─────────────────────────────────────────────────────────

/**
 * What an account's earlier steps left on the phone: what it knows of the key vault (vault.ts `noteVaultCopy`: `signIn` a
 * sign-in's copy, `community` community copies only, `none` a status read listing none), the "one way back" record, the
 * words noted.
 */
interface Before { vault?: 'signIn' | 'community' | 'none'; record?: OneWayBack; words?: '1' | '0' }

const STATES: Record<string, Before> = {
    neither: {},
    // "I still have my 12 words" on the card: the record is done, checked.
    'words confirmed on the card': { record: { url: OPEN_URL, joinedAt: BEFORE, done: 'checked' } },
    // "Where your account can be brought back from": the words noted as written down, no record.
    'words noted in Ways back': { words: '1' },
    // Noted, then taken back ("0"), over an old "I still have them": not kept.
    'words taken back': { record: { url: OPEN_URL, joinedAt: BEFORE, done: 'checked' }, words: '0' },
    // A sign-in added at another community with its copy at the key vault: the record linked, the vault copy known.
    'sign-in linked with a vault copy': { vault: 'signIn', record: { url: OPEN_URL, joinedAt: BEFORE, done: 'linked' } },
    // In by 12 words where the community keeps no copies, a sign-in added only to lift the limits (LinkSignInSheet writes
    // `linked` for it: noCopies), or a community's `ordinary` that says only a sign-in was added.
    'sign-in linked with no copy (noCopies)': { record: { url: OPEN_URL, joinedAt: BEFORE, done: 'linked' } },
    // A sign-in added whose copy failed (enrolment null): `linked` all the same, and no vault copy known.
    'sign-in linked with a failed copy': { record: { url: OPEN_URL, joinedAt: BEFORE, dismissedAt: BEFORE, done: 'linked' } },
    both: { vault: 'signIn', record: { url: OPEN_URL, joinedAt: BEFORE, done: 'linked' }, words: '1' },

    // ── The key vault's copies (round 2, finding 1), as the real deposits and status reads leave them ──
    // A sign-in's copy there, learnt by a status read (made on another phone): a way back in every community.
    "a sign-in's copy at the vault": { vault: 'signIn' },
    // The sign-in's copy failed (no signed receipt: nothing noted), then a status read listed none.
    "a sign-in's copy that failed": { vault: 'none' },
    // "Your community's admins" turned on, the vault's half kept, the community's never: Not finished (it was unreachable).
    "admins' half alone: the turn-on not finished": { vault: 'community' },
    // The same, the community refusing its half (409 not_offered).
    "admins' half alone: the community refused its half": { vault: 'community' },
    // Both halves once, then the community's lost (it closed, was rebuilt, or can't open it): the vault still lists its half.
    "admins' half alone: the community closed": { vault: 'community' },
    // Both halves kept: a way back through those admins, but the phone can't tell it from a lone half, so not counted: the safe way.
    "admins' copy, both halves, no sign-in's copy": { vault: 'community' },
    // A sign-in's copy and an admins' half: the sign-in's copy counts, and a half deposited after it never takes its place.
    "a sign-in's copy and an admins' half": { vault: 'signIn' },

    // ── A reminder the account already has, not done (round 2, finding 2): "Later" brings the card all the same ──
    // An earlier invite join's, which started put away (startOneWayBackPutAway, and D2's word from Home).
    "an earlier join's reminder, put away": { record: putAwayRecord(OPEN_URL, BEFORE) },
    // The same long ago, its week's return already seen and put away again.
    "an earlier join's reminder, put away long ago, its week's return used": { record: { ...putAwayRecord(OPEN_URL, BEFORE), dismissedAt: BEFORE + 10 * DAY, weekReturnUsed: true } },
    // The 12-words door's own record (global or an open door), put away with its ✕.
    "the 12-words door's own record, put away": { record: { url: OPEN_URL, joinedAt: BEFORE, dismissedAt: BEFORE + DAY } },
};

async function seed(key: string, b: Before): Promise<void> {
    if (b.vault) store.map.set(vaultCopyKnownStoreKey(key), b.vault === 'signIn' ? '1' : b.vault === 'community' ? 'c' : `0:${NOW - DAY}`);
    if (b.record) store.map.set(oneWayBackStoreKey(key), JSON.stringify(b.record));
    if (b.words) store.map.set(wordsWrittenDownStoreKey(key), b.words);
}

// ── The join's own sign-in (the global door), as global-join.ts hands it over ─────────────────────────────────────────

/** A copy at the key vault (depositDoorCopy → enrolmentFromVault), or kept by the community (enrolmentFromJoin). */
const vaultCopy: KeeperEnrolmentResult = { enrolled: ['sso'], generation: null, skipped: [], available: 1, enrolledSso: ['google'], threshold: 1, isSingleBlob: true };
const communityCopy: KeeperEnrolmentResult = { ...vaultCopy, generation: 1, wordsSealed: true, keptAt: 'community' };

interface Door { way: DoorWay; copies: SignInCopies; landed: KeeperEnrolmentResult | null }

// ── The walk ──────────────────────────────────────────────────────────────────────────────────────────────────────────

type Flow = 'invite' | 'global' | 'claim';
interface Outcome { name: string | null; photo: string; step: 'skipped' | 'later' | 'next' | 'letsGo'; homeCard: boolean }

const dots = (d: { at: number; of: number } | null) => (d ? `${d.at}/${d.of}` : null);

async function walk(flow: Flow, opts: { door?: Door; wordsTicked?: boolean } = {}): Promise<Outcome> {
    const door: Door = opts.door ?? { way: 'words', copies: 'vault', landed: null };
    // 1. Your name, or the door: the phone's own account read before the join holds a key (welcome.tsx's keptFor).
    const nameRead = { key: KEY, kept: await wayBackKeptBefore(KEY) };
    const atName = keptBeforeFor(nameRead, null);
    const nameSkips = flow === 'global'
        ? wayBackSkipped('global', wayBackKept({ signIn: doorKeepsSignInCopy(door.way, door.copies), wordsTicked: false, before: atName }))
        : wayBackSkipped(flow, wayBackKept({ signIn: false, wordsTicked: false, before: atName }));
    const name = dots(stepDot(joinSteps(flow, { wayBack: !nameSkips }), 'name'));

    // 2. The join lands. The door's 12 words start its own reminder; its sign-in brings the copy that landed, or none.
    let enrolment: KeeperEnrolmentResult | null = null;
    let joinedAt = JOINED_URL;
    if (flow === 'global') {
        joinedAt = GLOBAL_NODE_URL;
        if (door.way === 'words') await startOneWayBack(KEY, GLOBAL_NODE_URL, NOW);
        enrolment = door.landed;
    }

    // 3. Your photo: the read in hand speaks for the join's key only; then read again for it.
    const stale = keptBeforeFor(nameRead, KEY);
    const before = keptBeforeFor({ key: KEY, kept: await wayBackKeptBefore(KEY) }, KEY);
    expect(stale, 'the read in hand and the read again agree for the same account').toBe(before);
    const signInKept = protectionFrom(enrolment).state === 'covered';
    const skip = wayBackSkipped(flow, wayBackKept({ signIn: signInKept, wordsTicked: false, before }));
    const photo = dots(stepDot(joinSteps(flow, { wayBack: !skip }), 'photo'))!;

    // 4. The step, or past it; then the end: put away when kept, else "Later" shows Home's card.
    const kept = wayBackKept({ signIn: signInKept, wordsTicked: !skip && !!opts.wordsTicked, before });
    const step = skip ? 'skipped' : wayBackButton(kept, afterWayBack(flow));
    await (kept ? startOneWayBackPutAway : startOneWayBackShown)(KEY, joinedAt, NOW);
    // Home's card: where the record says, and not quiet (components/OneWayBackCard.tsx: quiet on a sign-in's copy at the vault).
    const quiet = await vaultSignInCopyKnown(KEY);
    const homeCard = oneWayBackPlace(await readOneWayBack(KEY), NOW + 60_000, false) === 'card' && !quiet;
    return { name, photo, step, homeCard };
}

// ── The table ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Shown and not kept: "Later", Home's card. Kept and shown (a claim, never skipped): "Next" to the owner's card, no Home card.
 * Skipped: one dot fewer, no Home card. The global door's 12 words keep that door's own card (two-doors design §2.5), which
 * only "I still have my 12 words" or a sign-in ends: so a skip there still lands on it, unless a record already said done.
 */
const SHOWN_INVITE: Outcome = { name: '1/3', photo: '2/3', step: 'later', homeCard: true };
const SKIPPED_INVITE: Outcome = { name: '1/2', photo: '2/2', step: 'skipped', homeCard: false };
const SHOWN_CLAIM: Outcome = { name: null, photo: '1/2', step: 'later', homeCard: true };
const KEPT_CLAIM: Outcome = { name: null, photo: '1/2', step: 'next', homeCard: false };

const TABLE: Array<{ state: keyof typeof STATES; invite: Outcome; globalByWords: Outcome; claim: Outcome }> = [
    { state: 'neither', invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: 'words confirmed on the card', invite: SKIPPED_INVITE, globalByWords: SKIPPED_INVITE, claim: KEPT_CLAIM },
    { state: 'words noted in Ways back', invite: SKIPPED_INVITE, globalByWords: { ...SKIPPED_INVITE, homeCard: true }, claim: KEPT_CLAIM },
    { state: 'words taken back', invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: 'sign-in linked with a vault copy', invite: SKIPPED_INVITE, globalByWords: SKIPPED_INVITE, claim: KEPT_CLAIM },
    { state: 'sign-in linked with no copy (noCopies)', invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: 'sign-in linked with a failed copy', invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: 'both', invite: SKIPPED_INVITE, globalByWords: SKIPPED_INVITE, claim: KEPT_CLAIM },
    // The global door by 12 words starts its own card as it lands, and a sign-in's copy at the vault keeps it quiet.
    { state: "a sign-in's copy at the vault", invite: SKIPPED_INVITE, globalByWords: SKIPPED_INVITE, claim: KEPT_CLAIM },
    { state: "a sign-in's copy that failed", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "admins' half alone: the turn-on not finished", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "admins' half alone: the community refused its half", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "admins' half alone: the community closed", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "admins' copy, both halves, no sign-in's copy", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "a sign-in's copy and an admins' half", invite: SKIPPED_INVITE, globalByWords: SKIPPED_INVITE, claim: KEPT_CLAIM },
    { state: "an earlier join's reminder, put away", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "an earlier join's reminder, put away long ago, its week's return used", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
    { state: "the 12-words door's own record, put away", invite: SHOWN_INVITE, globalByWords: SHOWN_INVITE, claim: SHOWN_CLAIM },
];

describe('what the phone already knew of the account x invite, the global door by 12 words, a claim', () => {
    for (const row of TABLE) {
        for (const [flow, want] of [['invite', row.invite], ['global', row.globalByWords], ['claim', row.claim]] as Array<[Flow, Outcome]>) {
            it(`${row.state}, ${flow === 'global' ? 'the global door by 12 words' : flow === 'invite' ? 'an invite join' : 'a claim'}`, async () => {
                await seed(KEY, STATES[row.state]);
                expect(await walk(flow)).toEqual(want);
            });
        }
    }

    // Another account's earlier steps (it left the phone; its records stay, keyed to it): they never speak for this one.
    for (const [state, before] of Object.entries(STATES)) {
        if (state === 'neither') continue;
        for (const [flow, want] of [['invite', SHOWN_INVITE], ['global', SHOWN_INVITE], ['claim', SHOWN_CLAIM]] as Array<[Flow, Outcome]>) {
            it(`a different account's record (${state}), ${flow}`, async () => {
                await seed(OTHER, before);
                expect(await walk(flow)).toEqual(want);
            });
        }
    }

    it('a read kept for one account never speaks for the key the join holds; before it holds one, it is the phone\'s own', () => {
        expect(keptBeforeFor(null, null)).toBe(false);
        expect(keptBeforeFor(null, KEY)).toBe(false);
        expect(keptBeforeFor({ key: KEY, kept: true }, null)).toBe(true);
        expect(keptBeforeFor({ key: KEY, kept: true }, KEY)).toBe(true);
        expect(keptBeforeFor({ key: OTHER, kept: true }, KEY)).toBe(false);
        expect(keptBeforeFor({ key: KEY, kept: false }, KEY)).toBe(false);
    });
});

describe('the global door\'s own sign-in: kept only by the copy that landed; the door\'s dots by the way chosen', () => {
    const rows: Array<{ path: string; door: Door; want: Outcome }> = [
        { path: 'a sign-in, its copy at the key vault', door: { way: 'sign-in', copies: 'vault', landed: vaultCopy }, want: SKIPPED_INVITE },
        { path: 'a sign-in, its copy kept by the community', door: { way: 'sign-in', copies: 'community', landed: communityCopy }, want: SKIPPED_INVITE },
        // The global community keeps no copies: the sign-in only keeps out fake accounts. No way back: the step and Later's card.
        { path: 'a sign-in where the community keeps no copies (noCopies)', door: { way: 'sign-in', copies: 'none', landed: null }, want: SHOWN_INVITE },
        // The copy failed after the join (depositDoorCopy → null): the door drew 1 of 2 for the way chosen, the photo draws the
        // step it now needs. One dot more than forecast, never one fewer: the step is never skipped on the door's guess.
        { path: 'a sign-in whose copy failed', door: { way: 'sign-in', copies: 'vault', landed: null }, want: { ...SHOWN_INVITE, name: '1/2' } },
        { path: 'a sign-in whose copy came back saying it failed (nothing enrolled)', door: { way: 'sign-in', copies: 'vault', landed: { enrolled: [], generation: null, skipped: [], available: 0, error: 'vault_unreachable' } }, want: { ...SHOWN_INVITE, name: '1/2' } },
        // In by 12 words: the door's own reminder card, whatever the step says.
        { path: 'the 12 words', door: { way: 'words', copies: 'vault', landed: null }, want: SHOWN_INVITE },
    ];
    for (const r of rows) {
        it(r.path, async () => {
            expect(await walk('global', { door: r.door })).toEqual(r.want);
        });
    }

    it('a sign-in at the door with no copy, after an earlier sign-in with no copy: still the step and Later\'s card', async () => {
        await seed(KEY, STATES['sign-in linked with no copy (noCopies)']);
        expect(await walk('global', { door: { way: 'sign-in', copies: 'none', landed: null } })).toEqual(SHOWN_INVITE);
    });

    it('the door\'s dots: a sign-in where copies are kept goes past the way back; the 12 words, or no copies, show it', () => {
        expect(doorKeepsSignInCopy('sign-in', 'vault')).toBe(true);
        expect(doorKeepsSignInCopy('sign-in', 'community')).toBe(true);
        expect(doorKeepsSignInCopy('sign-in', 'none')).toBe(false);
        expect(doorKeepsSignInCopy('words', 'vault')).toBe(false);
        expect(doorKeepsSignInCopy('words', 'none')).toBe(false);
    });
});

describe('the words ticked on the step: kept by now, never a skip', () => {
    it('an invite: Let\'s go, no Home card', async () => {
        expect(await walk('invite', { wordsTicked: true })).toEqual({ name: '1/3', photo: '2/3', step: 'letsGo', homeCard: false });
    });
    it('a claim: Next to the owner\'s card, no Home card', async () => {
        expect(await walk('claim', { wordsTicked: true })).toEqual({ name: null, photo: '1/2', step: 'next', homeCard: false });
    });
    it('after a sign-in with no copy: Let\'s go, and the record marked done stands (a way back is kept now)', async () => {
        await seed(KEY, STATES['sign-in linked with no copy (noCopies)']);
        expect(await walk('invite', { wordsTicked: true })).toEqual({ name: '1/3', photo: '2/3', step: 'letsGo', homeCard: false });
        expect((await readOneWayBack(KEY))?.done).toBe('linked');
    });
});

describe('"Later" over a record marked done: the card about the community just joined, moved by Home\'s word there', () => {
    it('the record is replaced by the member\'s own reminder, shown from the first landing', async () => {
        await seed(KEY, STATES['sign-in linked with no copy (noCopies)']);
        await walk('invite');
        expect(await readOneWayBack(KEY)).toEqual({ url: JOINED_URL, joinedAt: NOW, by: 'wayBack' });
    });
    // Until round 2 this row said a put-away record "stands" (kept as it was, dismissedAt and all): that pinned the bug the
    // review found (finding 2: Later brought no card on the first landing). Later now brings it up, as the rows below say.
    it('the 12-words door\'s own record, put away with its ✕: brought back up, still the door\'s', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify({ url: OPEN_URL, joinedAt: BEFORE, dismissedAt: BEFORE + 1, postReturnUsed: true }));
        await startOneWayBackShown(KEY, JOINED_URL, NOW);
        expect(await readOneWayBack(KEY)).toEqual({ url: OPEN_URL, joinedAt: BEFORE, postReturnUsed: true });
        expect(oneWayBackPlace(await readOneWayBack(KEY), NOW + 60_000, true)).toBe('card');
    });
    it('a member\'s reminder put away (an earlier join\'s): started again about the community just joined, shown', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify(putAwayRecord(OPEN_URL, NOW - 2 * DAY)));
        await startOneWayBackShown(KEY, JOINED_URL, NOW);
        expect(await readOneWayBack(KEY)).toEqual({ url: JOINED_URL, joinedAt: NOW, by: 'wayBack' });
    });
    it('a reminder showing now stands as it is (the 12-words door\'s own, written as that join landed, or one already up)', async () => {
        for (const up of [{ url: OPEN_URL, joinedAt: BEFORE }, { url: OPEN_URL, joinedAt: BEFORE, by: 'wayBack' as const, weekReturnUsed: true }]) {
            store.map.set(oneWayBackStoreKey(KEY), JSON.stringify(up));
            await startOneWayBackShown(KEY, JOINED_URL, NOW);
            expect(await readOneWayBack(KEY)).toEqual(up);
        }
    });
    it('kept: the end brings nothing up, and a put-away record stays put away (startOneWayBackPutAway keeps every record)', async () => {
        store.map.set(oneWayBackStoreKey(KEY), JSON.stringify(putAwayRecord(OPEN_URL, NOW - 2 * DAY)));
        await startOneWayBackPutAway(KEY, JOINED_URL, NOW);
        expect(await readOneWayBack(KEY)).toEqual(putAwayRecord(OPEN_URL, NOW - 2 * DAY));
    });
});
