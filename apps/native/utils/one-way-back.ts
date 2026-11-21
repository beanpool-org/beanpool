/**
 * "Your account has one way back" (two-doors design §2.5): a member who joined the global community with 12 words has
 * ONE way back, the 12 words, and no copy anywhere else. The app says so plainly, and never as a gate (memory
 * `onboarding-no-hard-gates`):
 *
 * - A plain card on the landing screen and in Settings until one of two things is done: the member says they checked
 *   they still have their 12 words, or they add a sign-in (utils/join-link.ts).
 * - Dismissible. When it comes back is core's schedule (@beanpool/core way-back-schedule.ts, slice B1 of
 *   DESIGN-notify-and-backup-asks-fable-amend2.md §12.3; Marty's pick 10, 21 Nov 2026): once at the first Beans, once 30
 *   days after joining, then every 90 days while there is something to lose; between showings it lives in Settings and
 *   in the bell's last line. A record from 1.4.7 keeps its old flags (`postReturnUsed`, `weekReturnUsed`): read as nothing.
 *
 * Kept on the phone per account ({@link oneWayBackStoreKey}): times and two flags, nothing secret. Kept when the account
 * leaves the phone, as its block list is: the same account restored here carries on where it was.
 *
 * ## Who it is for is the node's word (#1454 review, finding 2)
 *
 * The join writes the record, but only on the phone it was made on. So the card asks the community itself
 * ({@link askOneWayBackStanding}, `GET /api/community/me`, signed by the account): `probation.rules: 'words'` is a member
 * who came in with 12 words and has added no sign-in, on any phone, as the web app reads it. {@link oneWayBackFromNode}
 * makes the record agree: started on a phone that restored the account, done once a sign-in was added anywhere. With no
 * word from the node (offline, an older node), the phone's own record decides, as before.
 *
 * ## Every member whose 12 words are their only way back (DESIGN-home-default-fable.md §2.5, slice D2)
 *
 * Who the reminder is for is what the account HAS, not how it joined: Home's answer says `me.wayBack` (`words`: no
 * sign-in's copy is linked there), for a member who came by invite, the community's first owner, anyone. Their record is
 * marked `by: 'wayBack'`: only Home's word moves it (`/api/community/me`'s `rules` says how they joined, so its
 * `ordinary` is no sign-in added). Sign-up counts as the first showing, so it starts put away ({@link startOneWayBackPutAway},
 * at an invite sign-up, or from Home's word at its join date): day one is First steps' line only, then the card on core's
 * schedule (above). Its card offers only what works for the member: "Add a
 * sign-in" only where the node takes one from them (Home's `cards.safety`, the 12-words door's rule,
 * routes/open-join.ts `linkState`), else "Show my 12 words" and "I still have my 12 words", which is kept on the account
 * (utils/words-kept.ts, `words_kept`) so the phone and the web agree.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { oneWayBackAskedStoreKey, oneWayBackStoreKey, wordsWrittenDownStoreKey } from './storage-keys';
import { signedGet } from './node-post';
import { GLOBAL_NODE_URL } from './node-profile';
import type { BeanPoolIdentity } from './identity';
import { wayBackBeansSeen, wayBackSchedule, type WayBackSchedule } from '@beanpool/core';

export const ONE_WAY_BACK_TEXT = {
    body: 'If this phone is lost, this is how you get back in.',
    addSignIn: 'Add a sign-in',
    checkWords: 'Show my 12 words',
    checked: 'I still have my 12 words',
    notNow: 'Not now',
} as const;

export interface OneWayBack {
    /** The community this is about (the global community, the one the member joined with 12 words). */
    url: string;
    /** When the 12-words join landed (the phone's clock). */
    joinedAt: number;
    /** Done, and never shown again: a sign-in was added, or the member said they still have their 12 words. */
    done?: 'linked' | 'checked';
    /** The last time the card was put away. */
    dismissedAt?: number;
    /** When this phone first saw a balance above zero on the account: the card comes back once for it (core `wayBackBeansSeen`). */
    beansAt?: number;
    /**
     * `wayBack`: a reminder for a member whose words are their only way back however they joined (§2.5 above), moved by
     * Home's `me.wayBack` alone and started put away. Absent: the 12-words door's own record (global or an open door).
     */
    by?: 'wayBack';
}

/** Where it shows now: the landing screen's card (and Settings), Settings only, or nowhere. */
export type OneWayBackPlace = 'card' | 'settings' | 'none';

/**
 * What the member has here beside the record, for core's schedule: the balance now (whole hundredths; null where it isn't
 * known: Beans off, the worldwide community, no Your Beans card asked), something else to lose (a live listing, an open
 * deal, a role), a way back kept that the record doesn't say (a sign-in's copy at the key vault, the words said written
 * down), and the notifications card holding Home's one slot.
 */
export interface WayBackHolding {
    balance_c?: number | null;
    holds?: boolean;
    kept?: boolean;
    slotTaken?: boolean;
}

/** Core's schedule for this record, or null where there is no reminder (none, or done). */
export function oneWayBackSchedule(record: OneWayBack | null | undefined, now: number, holding: WayBackHolding = {}): WayBackSchedule | null {
    if (!record || record.done) return null;
    return wayBackSchedule({
        joinedAt: record.joinedAt, now, kept: !!holding.kept, putAwayAt: record.dismissedAt ?? null,
        beansAt: record.beansAt ?? null, balance_c: holding.balance_c ?? null, holds: !!holding.holds, slotTaken: !!holding.slotTaken,
    });
}

export function oneWayBackPlace(record: OneWayBack | null | undefined, now: number, holding: WayBackHolding = {}): OneWayBackPlace {
    const schedule = oneWayBackSchedule(record, now, holding);
    return !schedule ? 'none' : schedule.show ? 'card' : 'settings';
}

/** Put the card away: every return waiting now is answered by it (core's schedule counts from the last put-away). */
export function dismissedOneWayBack(record: OneWayBack, now: number): OneWayBack {
    return { ...record, dismissedAt: now };
}

/**
 * The first Beans seen on the account: the record keeps when, once (core `wayBackBeansSeen`), so the card comes back for
 * them. Nothing is written for a record that is done, or that already has its date, or while the balance isn't above zero.
 */
export async function noteOneWayBackBeans(publicKey: string, balance_c: number | null | undefined, now: number = Date.now()): Promise<OneWayBack | null> {
    const record = await readOneWayBack(publicKey);
    if (!record || record.done || typeof record.beansAt === 'number') return record;
    const seen = wayBackBeansSeen(null, balance_c, now);
    if (seen === null) return record;
    const noted: OneWayBack = { ...record, beansAt: seen };
    await write(publicKey, noted);
    return noted;
}

/**
 * Whether the member said, in Ways back ("Where your account can be brought back from"), that the 12 words are written
 * down: '1' only (utils/ways-back.ts `wordsWrittenDown` reads the same key, the one S4's way-back step counts as kept).
 */
export async function wordsSaidWrittenDown(publicKey: string): Promise<boolean> {
    try {
        return (await AsyncStorage.getItem(wordsWrittenDownStoreKey(publicKey))) === '1';
    } catch {
        return false;
    }
}

export async function readOneWayBack(publicKey: string | null | undefined): Promise<OneWayBack | null> {
    if (!publicKey) return null;
    try {
        const raw = await AsyncStorage.getItem(oneWayBackStoreKey(publicKey));
        const parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object' || typeof parsed.joinedAt !== 'number' || typeof parsed.url !== 'string') return null;
        return parsed as OneWayBack;
    } catch {
        return null;
    }
}

async function write(publicKey: string, record: OneWayBack): Promise<void> {
    try {
        await AsyncStorage.setItem(oneWayBackStoreKey(publicKey), JSON.stringify(record));
    } catch {
        // Not written: the card shows as it did. It never gates anything.
    }
}

/** A 12-words join landed for this account at `url`: the card starts. One that is done or already running is kept. */
export async function startOneWayBack(publicKey: string, url: string, now: number = Date.now()): Promise<void> {
    if (await readOneWayBack(publicKey)) return;
    await write(publicKey, { url, joinedAt: now });
}

/**
 * The record of a member whose words are their only way back, started put away (§2.5: sign-up counts as the first
 * showing): the card then comes on core's schedule (the first Beans, 30 days after `joinedAt`, every 90 days while there
 * is something to lose), and lives in Settings between.
 */
export const putAwayRecord = (url: string, joinedAt: number): OneWayBack => ({ url, joinedAt, dismissedAt: joinedAt, by: 'wayBack' });

/**
 * An invite sign-up ended (app/welcome.tsx): the reminder starts put away. One that is done or already running is kept
 * (a Yes after the recovery kit during sign-up has already marked it done).
 */
export async function startOneWayBackPutAway(publicKey: string, url: string, now: number = Date.now()): Promise<void> {
    if (await readOneWayBack(publicKey)) return;
    await write(publicKey, putAwayRecord(url, now));
}

/**
 * A join ended on the way-back step's "Later" (app/welcome.tsx, slice S4 of DESIGN-onboarding-home-landing-fable.md §3.1 E):
 * "Later" is true to its word, so Home's card shows from the first landing until a way back is kept or the card is put
 * away. A member's own reminder (`by: 'wayBack'`, about the community just joined, moved by Home's word there), not put away.
 *
 * Whatever record the account already has, the card shows on the first landing (review of #3330, round 2):
 * - one showing now (not put away) is kept as it is: the 12-words door's own record, written as that join landed, or a
 *   reminder already up;
 * - the 12-words door's own record, put away with its ✕: brought back up, still the door's (its community, its asks, its
 *   returns already used);
 * - a member's reminder put away (an earlier join's, which started put away, or one put away on Home): started again about
 *   the community just joined, where Home's word moves it;
 * - one marked done: started again too. "Later" is reached only when the phone knows of no way back kept (utils/way-back-
 *   kept.ts), and `done` says no more than that a sign-in was added somewhere, with no copy too, or that the words were
 *   noted and then taken back. Kept, it would hide the card the member was just promised (review of #3330).
 */
export async function startOneWayBackShown(publicKey: string, url: string, now: number = Date.now()): Promise<void> {
    const record = await readOneWayBack(publicKey);
    if (record && !record.done) {
        if (record.dismissedAt === undefined) return;
        if (record.by !== 'wayBack') {
            const shown: OneWayBack = { ...record };
            delete shown.dismissedAt;
            await write(publicKey, shown);
            return;
        }
    }
    await write(publicKey, { url, joinedAt: now, by: 'wayBack' });
}

/** The card was put away (it comes back as {@link oneWayBackPlace} says). */
export async function dismissOneWayBack(publicKey: string, now: number = Date.now()): Promise<void> {
    const record = await readOneWayBack(publicKey);
    if (record && !record.done) await write(publicKey, dismissedOneWayBack(record, now));
}

/**
 * One of the two was done: a sign-in was added, or the member checked their 12 words. Never shown again. A sign-in wins
 * over "I still have my 12 words": Settings' quiet offer to add one goes too (PR #1452 re-review, finding 1).
 */
export async function finishOneWayBack(publicKey: string, how: 'linked' | 'checked'): Promise<void> {
    const record = await readOneWayBack(publicKey);
    if (!record || record.done === 'linked' || (record.done && how === 'checked')) return;
    await write(publicKey, { ...record, done: how });
}

/** What the community says of this account: came in with 12 words and has no sign-in (`words`), and when it joined. */
export interface OneWayBackStanding {
    words: boolean;
    /** When it joined there, from the end of its new-account limits; null when the node doesn't say. */
    joinedAt: number | null;
    /**
     * Home's word only (utils/home-cards.ts `safetyWord`): false when the words are the only way back but the node takes no
     * sign-in from this member (an invite, the first owner, a sign-in joiner with no copy there: `linkState` refuses them),
     * so the card offers none and its record is `by: 'wayBack'`. Absent: the 12-words door's word, as before.
     */
    door?: boolean;
    /** Home's word only: the member said they still have their 12 words (on the card, or Yes after the kit), on any device (`words_kept`). */
    kept?: boolean;
}

/** How long the card waits for the node's word before the phone's own record decides. */
export const ONE_WAY_BACK_ASK_MS = 10_000;

/**
 * The community's word on this account (`GET /api/community/me`, signed by it, as the web app asks): its standing,
 * `not_member` when the node refuses to say (403: a guest there, or no account), or null when there is no word at all
 * (offline, no answer in time, or an older node that doesn't say which rules).
 */
export async function askOneWayBackStanding(
    url: string, identity: BeanPoolIdentity, options: { timeoutMs?: number } = {},
): Promise<OneWayBackStanding | 'not_member' | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), options.timeoutMs ?? ONE_WAY_BACK_ASK_MS);
    try {
        const res = await signedGet(url, '/api/community/me', identity, stop.signal);
        if (res.status === 403) return 'not_member';
        if (!res.ok) return null;
        const p = ((await res.json().catch(() => null)) as { probation?: { rules?: unknown; ageEndsAt?: unknown; endsWhen?: { hours?: unknown } } } | null)?.probation;
        if (p?.rules !== 'words' && p?.rules !== 'ordinary') return null;
        const ends = typeof p.ageEndsAt === 'string' ? Date.parse(p.ageEndsAt) : NaN;
        const hours = typeof p.endsWhen?.hours === 'number' ? p.endsWhen.hours : NaN;
        const joinedAt = p.rules === 'words' && Number.isFinite(ends) && Number.isFinite(hours) ? ends - hours * 60 * 60 * 1000 : null;
        return { words: p.rules === 'words', joinedAt };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The record, made to agree with the node's word, and kept:
 * - the node says 12 words and this phone has no record (the account restored here): started, unless the key vault
 *   keeps a copy of the key (`vaultCopy`), which is a way back in every community: then nothing is written, and the
 *   card offers a sign-in quietly in Settings only (join-global.tsx skips the card for the same reason). `vaultCopy` is
 *   what the phone knows of a sign-in's copy there (vault.ts `vaultSignInCopyKnown`; a community's half is not one): a
 *   deposit and a status read keep it, and so does a removal
 *   (vault rethink VR1: Remove everything records "none", and the list read after removing one copy says what is left),
 *   so once the last vault copy is removed the card is back where a 12-words account with no copy has it;
 * - the phone thought a sign-in was added and the node says not: opened again;
 * - the node says the account has a sign-in (added anywhere): done for good, over "I still have my 12 words" too, and
 *   written even with no record yet, so the phone stops asking (PR #1452 re-review, findings 1-3).
 * No word: the record as it is.
 */
export async function oneWayBackFromNode(
    publicKey: string, url: string, standing: OneWayBackStanding | null, now: number = Date.now(),
    options: { vaultCopy?: boolean } = {},
): Promise<OneWayBack | null> {
    const record = await readOneWayBack(publicKey);
    if (!standing) return record;
    if (!standing.words) {
        if (record?.done === 'linked') return record;
        const done: OneWayBack = { ...(record ?? { url, joinedAt: now }), done: 'linked' };
        await write(publicKey, done);
        return done;
    }
    // "I still have my 12 words" said on another device, or Yes after the kit there (kept on the account): done here too.
    if (standing.kept && record?.done !== 'linked') {
        if (record?.done === 'checked') return record;
        const checked: OneWayBack = { ...(record ?? (standing.door === false ? putAwayRecord(url, standing.joinedAt ?? now) : { url, joinedAt: standing.joinedAt ?? now })), done: 'checked' };
        await write(publicKey, checked);
        return checked;
    }
    if (!record) {
        // Every other member whose words are their only way back: put away from the start (sign-up was its first showing).
        const started: OneWayBack = standing.door === false ? putAwayRecord(url, standing.joinedAt ?? now) : { url, joinedAt: standing.joinedAt ?? now };
        if (!options.vaultCopy) await write(publicKey, started);
        return started;
    }
    if (record.done === 'linked') {
        const reopened: OneWayBack = { ...record };
        delete reopened.done;
        await write(publicKey, reopened);
        return reopened;
    }
    return record;
}

/** At most one ask of the node per account in this long (PR #1452 re-review, finding 3). */
export const ONE_WAY_BACK_ASK_EVERY_MS = 30 * 60 * 1000;

/** The last ask of the node for an account, kept on the phone: when, and what it said (`none`: no word came). */
export interface OneWayBackAsked {
    at: number;
    answer: 'words' | 'ordinary' | 'not_member' | 'none';
    joinedAt?: number | null;
}

/**
 * Every ask this run of the app, per account, beside the phone's storage: a phone whose storage refuses every write
 * would otherwise never record an ask, and ask the node at every focus. The newer of the two is the one kept.
 */
const askedThisRun = new Map<string, OneWayBackAsked>();

export async function readOneWayBackAsked(publicKey: string): Promise<OneWayBackAsked | null> {
    const inMemory = askedThisRun.get(publicKey.toLowerCase()) ?? null;
    let stored: OneWayBackAsked | null = null;
    try {
        const raw = await AsyncStorage.getItem(oneWayBackAskedStoreKey(publicKey));
        const parsed = raw ? JSON.parse(raw) : null;
        stored = parsed && typeof parsed.at === 'number' && typeof parsed.answer === 'string' ? parsed as OneWayBackAsked : null;
    } catch {
        stored = null;
    }
    if (!inMemory) return stored;
    return stored && stored.at > inMemory.at ? stored : inMemory;
}

export async function noteOneWayBackAsked(publicKey: string, asked: OneWayBackAsked): Promise<void> {
    askedThisRun.set(publicKey.toLowerCase(), asked);
    try {
        await AsyncStorage.setItem(oneWayBackAskedStoreKey(publicKey), JSON.stringify(asked));
    } catch {
        // Not kept on the phone: this run still remembers it (askedThisRun). Never a gate.
    }
}

/** The asks under way, per account and community: overlapping refreshes (a focus and a re-render that meet) share one. */
const askingNow = new Map<string, Promise<OneWayBackStanding | 'not_member' | null>>();

/** {@link askOneWayBackStanding}, one request for every caller that asks while it is out. */
export function askOneWayBackStandingShared(
    url: string, identity: BeanPoolIdentity, options: { timeoutMs?: number } = {},
): Promise<OneWayBackStanding | 'not_member' | null> {
    const key = `${identity.publicKey.toLowerCase()}|${url.trim().replace(/\/+$/, '').toLowerCase()}`;
    const out = askingNow.get(key);
    if (out) return out;
    const ask = askOneWayBackStanding(url, identity, options).finally(() => { askingNow.delete(key); });
    askingNow.set(key, ask);
    return ask;
}

/** For the tests: forget this run's asks. */
export function resetOneWayBackAsksForTests(): void {
    askedThisRun.clear();
    askingNow.clear();
}

/**
 * The record with the account's own dismissal (Home's `home.layout` `dismissed.safety`, design §3.1), when it is newer
 * than the phone's: the card was put away on another phone or in the web app. It counts as put away then: every return
 * whose moment came before it is answered (core's schedule), so a dismissal anywhere never brings the card back beyond
 * the stated schedule, and the first Beans seen after it still bring it once.
 */
export function withAccountDismissal(record: OneWayBack | null, dismissedIso: string | null | undefined): OneWayBack | null {
    if (!record || record.done || !dismissedIso) return record;
    const at = Date.parse(dismissedIso);
    if (!Number.isFinite(at) || (record.dismissedAt !== undefined && record.dismissedAt >= at)) return record;
    return dismissedOneWayBack(record, at);
}

/**
 * Whether the card asks the node now (`ask`), uses its last answer (`kept`), or never asks (`never`):
 * - never for a record that is linked (a sign-in was added: nothing left to offer);
 * - never from another community's screens once the member has said they still have their 12 words (only the quiet
 *   offer is left, and it can wait until the phone is using the global community);
 * - never with no record and no global community in use (the card is about the global community alone);
 * - otherwise at most once every {@link ONE_WAY_BACK_ASK_EVERY_MS}, whatever the answer was (a guest's 403 and
 *   `ordinary` included), unless `now` is forced (just after a link).
 */
export function oneWayBackAskNow(
    record: OneWayBack | null, globalInUse: boolean, asked: OneWayBackAsked | null, now: number, force = false,
): 'ask' | 'kept' | 'never' {
    if (record?.done === 'linked') return 'never';
    if (!globalInUse && (!record || record.done)) return 'never';
    if (force) return 'ask';
    return asked && now >= asked.at && now - asked.at < ONE_WAY_BACK_ASK_EVERY_MS ? 'kept' : 'ask';
}

/** The node's word from what was asked: a standing, or null (no word, or not a member there). */
export function standingFromAsked(asked: OneWayBackAsked | null): OneWayBackStanding | null {
    if (asked?.answer === 'words') return { words: true, joinedAt: asked.joinedAt ?? null };
    if (asked?.answer === 'ordinary') return { words: false, joinedAt: null };
    return null;
}

/**
 * Where to ask: the community the record is about, or the global community when it is the one this phone is using (an
 * account restored there). Nowhere else: a phone in another community never asks global about itself.
 */
export function oneWayBackCommunity(record: OneWayBack | null | undefined, inUse: string | null | undefined): string | null {
    if (record?.url) return record.url;
    return isGlobalInUse(inUse) ? GLOBAL_NODE_URL : null;
}

/** Whether `inUse` (the phone's community now) is the global community. */
export function isGlobalInUse(inUse: string | null | undefined): boolean {
    return (inUse ? inUse.trim().replace(/\/+$/, '').toLowerCase() : '') === GLOBAL_NODE_URL;
}
