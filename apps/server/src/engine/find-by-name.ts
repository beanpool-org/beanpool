/**
 * Finding someone in another community by their exact name, when they said yes (slice N1: scratch/fable-design/
 * DESIGN-cross-chat-voice-fable.md §3.6, §3.7, §11 row F1, renamed N1 in DESIGN-forums-messaging-joint-fable.md §1 item 13).
 * The shared parts (the typed-name rule, the one "nobody" answer, the words) are @beanpool/core find-by-name.ts; the routes,
 * routes/find-by-name.ts and routes/relay.ts.
 *
 * **The switch.** A member here turns on "People in other communities can find me by name" by handing this server their
 * address card (core outside-chat.ts), signed by their key, naming one of this server's homes and the name they use here (the
 * server's one name rule, @beanpool/engine foldName). It is kept as their member preference FIND_BY_NAME_PREF, so it goes to
 * a standby with their row and moves with a re-key (where the card, signed by the old key, then finds nobody until their
 * app hands a new one). Off deletes it. Off until they turn it on.
 *
 * **Asking (the asker's community).** A member here asks for a name at another community: refused at once for this
 * community itself, an address that is no community's, a name no card could carry, or past FIND_BY_NAME_PER_DAY today (429,
 * counted before the other community is asked, so a look-up it never answers still counts). Then this server asks the other
 * one, `POST https://<home>/api/relay/find { v: 1, asker, name }`, in a request it signs (engine/node-key.ts, X1, through
 * the relay's transport: public addresses only, no redirect). The card that comes back is passed on only when it verifies,
 * is not the asker's own, and carries the name asked by the name rule; anything else is "nobody". An answer that is no
 * answer, or none at all, is 502: that community could not be asked.
 *
 * **Answering (the other community).** The request passed the server signature door (engine/node-signature.ts: unsigned,
 * stale, replayed, signed for another server, a key its origin doesn't name are refused there, before this runs). Then
 * every look-up takes the same steps in the same order, whatever is found (FIND_STEPS; the suite reads them back):
 * count it against the asking server (FIND_PER_ORIGIN_DAY) and then against the asker (FIND_BY_NAME_PER_DAY, by origin and
 * key; read, not counted, once the server is past its day), the one indexed read by the name rule, the member check, the
 * block check, the card check (a placeholder card of the same shape, its signature checked too, when nothing was found),
 * the owner's switch. Only then the answer: the card when
 * every one of them says yes, else FIND_NOBODY_BODY in its exact bytes, for no such member, one who didn't say yes, one who
 * blocked the asker, one who left or was removed, the asker themselves, and an asker or a server past its day. This file
 * writes no log line at all: nothing found or typed, no key, no name, no community. (A look-up this server sends that
 * cannot reach the other community goes through the relay's own warning, relay-outbox.ts, which may name that community's
 * address, never a member or a name typed.)
 *
 * The card's home is the one its owner signed (a community answers at more than one name); the asker's app shows it as it
 * is, as for a scanned card.
 *
 * **The day's counts**, kept in this process by UTC day (a restart forgets them), in two stores, so no outside party can use
 * up a count that is someone else's. Asking: one count a member here, and only members add to it. Answering: one entry an
 * origin, its askers inside it, counted only while that origin is within its day, so one origin holds at most
 * FIND_PER_ORIGIN_DAY askers and a flood past its day adds nothing. At most FIND_ORIGINS_KEPT origins: a new one past that
 * makes room by forgetting the origin that asked least recently, which then only starts its day again; a full store
 * refuses nobody.
 */
import {
    FIND_BAD_COMMUNITY, FIND_BAD_NAME, FIND_BY_NAME_PER_DAY, FIND_DAY_USED, FIND_NOBODY_BODY, FIND_NOT_REACHED, FIND_OWN_COMMUNITY,
    RELAY_FIND_PATH, addressCardVerifies, findTypedName, isNodeHost, nodeHomeOf, readFindAnswer, signAddressCard, word,
    type AddressCard,
} from '@beanpool/core';
import crypto from 'node:crypto';
import { foldName } from '@beanpool/engine';
import { ed25519 } from '@noble/curves/ed25519.js';
import { db } from '../db/db.js';
import { isNodeMember, readsAsMember } from '../state-engine.js';
import { hasBlocked } from './member-blocks.js';
import { isOwnNodeHome } from './node-key.js';
import { outsideMessagesOn } from './relay-mail.js';
import { OUTSIDE_OFF_ERROR, forwardSignedForAnswer } from './relay-outbox.js';

/** The member preference that holds a member's card while they can be found by name (member_preferences.pref_value). */
export const FIND_BY_NAME_PREF = 'find_by_name';
/** Look-ups one other community's server may bring here in a day, all its askers together. */
export const FIND_PER_ORIGIN_DAY = 200;
/**
 * The most origins counted in a day (as many as the door keeps keys for, engine/node-signature.ts NODE_KEYS_KEPT). Each holds
 * at most FIND_PER_ORIGIN_DAY askers, so the answering store holds about 100,000 keys at the most.
 */
export const FIND_ORIGINS_KEPT = 512;
/** The steps every answer takes, in order (the suite checks each look-up took exactly these). */
export const FIND_STEPS = ['count-origin', 'count-asker', 'read-name', 'check-member', 'check-block', 'check-card', 'check-switch'] as const;

export const FIND_BAD_CARD = word("Your card doesn't match your name here. Open your card again and try once more.");

const DAY_MS = 24 * 60 * 60_000;
const KEY_HEX = /^[0-9a-f]{64}$/;
/** Read when nothing was found, so the member and block checks still run (no member has this key). */
const NOBODY_KEY = '0'.repeat(64);

export class FindError extends Error {
    constructor(readonly status: 400 | 403 | 429 | 502, readonly code: string, message: string) {
        super(message);
        this.name = 'FindError';
    }
}

// ── The day's counts ────────────────────────────────────────────────────────────────────────
// Two stores, so nothing one party sends can use up a count that is someone else's.

let countedDay = -1;
/** Asking: each member here who looked someone up today, by key (only a member who reads as one asks: routes/find-by-name.ts). */
const askedByMembers = new Map<string, number>();
/** One other community's server's day here: its look-ups, and its askers, counted only while it is within its day. */
interface OriginDay { looked: number; askers: Map<string, number> }
/** Answering: each origin that brought look-ups today, the one that asked least recently first. */
const answeredForOrigins = new Map<string, OriginDay>();

function sameDay(now: number): void {
    const day = Math.floor(now / DAY_MS);
    if (day === countedDay) return;
    askedByMembers.clear();
    answeredForOrigins.clear();
    countedDay = day;
}

/** One more for `who` in `counts`, held at `max` + 1, and whether it is within `max`, this one included. */
function countOne(counts: Map<string, number>, who: string, max: number): boolean {
    const n = (counts.get(who) ?? 0) + 1;
    counts.set(who, Math.min(n, max + 1));
    return n <= max;
}

/**
 * `origin`'s day, moved to the most recent end. A new origin past FIND_ORIGINS_KEPT makes room by forgetting the one that
 * asked least recently: a full store refuses nobody, and the origin forgotten only starts its day again.
 */
function originDay(origin: string): OriginDay {
    const had = answeredForOrigins.get(origin);
    if (had) answeredForOrigins.delete(origin);
    const day = had ?? { looked: 0, askers: new Map<string, number>() };
    answeredForOrigins.set(origin, day);
    if (answeredForOrigins.size > FIND_ORIGINS_KEPT) answeredForOrigins.delete(answeredForOrigins.keys().next().value!);
    return day;
}

/** Tests: forget the day's counts. */
export function forgetFindCounts(): void {
    askedByMembers.clear();
    answeredForOrigins.clear();
    countedDay = -1;
}

/** Tests: what the day's counts hold: members asking, origins answered, their askers in all and one origin's. */
export function heldFindCounts(): { members: number; origins: number; askers: number; askersOf: (origin: string) => number | undefined } {
    let askers = 0;
    for (const d of answeredForOrigins.values()) askers += d.askers.size;
    return { members: askedByMembers.size, origins: answeredForOrigins.size, askers, askersOf: (o) => answeredForOrigins.get(o)?.askers.size };
}

/** Tests: today's answering store holding `origins` made-up origins, each at its most (past its day, FIND_PER_ORIGIN_DAY askers). */
export function __seedFindCountsForTests(origins: number, now = Date.now()): void {
    sameDay(now);
    for (let o = 0; o < origins; o++) {
        const day = originDay(`seed-${o}.example`);
        day.looked = FIND_PER_ORIGIN_DAY + 1;
        for (let a = 0; a < FIND_PER_ORIGIN_DAY; a++) day.askers.set(a.toString(16).padStart(64, '0'), 1);
    }
}

// ── The name rule ───────────────────────────────────────────────────────────────────────────

/** Whether two names are the same name here: as a card writes them (core findTypedName), then the server's name rule. */
function sameName(a: string, b: string): boolean {
    const x = findTypedName(a), y = findTypedName(b);
    return x !== null && y !== null && foldName(x) === foldName(y);
}

// ── The switch ──────────────────────────────────────────────────────────────────────────────

function keptCardOf(member: string): AddressCard | null {
    const row = db.prepare('SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?').get(member, FIND_BY_NAME_PREF) as
        { pref_value: string } | undefined;
    return parseCard(row?.pref_value);
}

function parseCard(text: string | null | undefined): AddressCard | null {
    if (!text) return null;
    try {
        const c = JSON.parse(text) as AddressCard;
        return c && typeof c === 'object' && !Array.isArray(c) ? c : null;
    } catch {
        return null;
    }
}

/** Whether `member` can be found by name here now: a card is kept for them, under the key they hold. */
export function isFindable(member: string): boolean {
    const card = keptCardOf(member);
    return !!card && card.key === member && addressCardVerifies(card);
}

/** A member's row stamped, so delta sync takes the change of their preference to a standby (as holiday does). */
function stampMember(member: string): void {
    db.prepare(`UPDATE members SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE public_key = ?`).run(member);
}

/**
 * The switch: on with `card` (the member's own, signed by them, naming a home of this server's and the name they use here),
 * or off. Throws FindError for a card that isn't that, or on while this community takes nothing from other communities.
 * Answers whether they can be found now.
 */
export function setFindable(member: string, on: boolean, card: unknown): boolean {
    if (!on) {
        db.transaction(() => {
            const gone = db.prepare('DELETE FROM member_preferences WHERE public_key = ? AND pref_key = ?').run(member, FIND_BY_NAME_PREF).changes;
            if (gone > 0) stampMember(member);
        })();
        return false;
    }
    if (!outsideMessagesOn()) throw new FindError(403, 'outside_off', OUTSIDE_OFF_ERROR);
    const callsign = (db.prepare('SELECT callsign FROM members WHERE public_key = ?').get(member) as { callsign: string | null } | undefined)?.callsign ?? '';
    if (!addressCardVerifies(card) || card.key !== member || !isOwnNodeHome(card.home) || !sameName(card.name, callsign)) {
        throw new FindError(400, 'bad_card', FIND_BAD_CARD);
    }
    const kept = JSON.stringify({ v: 1, key: card.key, home: card.home, name: card.name, sig: card.sig });
    db.transaction(() => {
        const was = db.prepare('SELECT pref_value FROM member_preferences WHERE public_key = ? AND pref_key = ?').get(member, FIND_BY_NAME_PREF) as
            { pref_value: string } | undefined;
        if (was?.pref_value === kept) return;
        db.prepare('INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?)').run(member, FIND_BY_NAME_PREF, kept);
        stampMember(member);
    })();
    return true;
}

// ── Asking another community ────────────────────────────────────────────────────────────────

export type FindResult = { found: false } | { found: true; card: AddressCard };

/** `asker` (a member here) asks community `home` for `name`. Throws FindError for what is refused here, or 502 for no answer. */
export async function findByName(asker: string, input: { home?: unknown; name?: unknown } | null | undefined, now = Date.now()): Promise<FindResult> {
    if (!outsideMessagesOn()) throw new FindError(403, 'outside_off', OUTSIDE_OFF_ERROR);
    const home = typeof input?.home === 'string' ? nodeHomeOf(input.home) : null;
    if (!home || !isNodeHost(home)) throw new FindError(400, 'bad_home', FIND_BAD_COMMUNITY);
    if (isOwnNodeHome(home)) throw new FindError(400, 'own_community', FIND_OWN_COMMUNITY);
    const name = findTypedName(input?.name);
    if (!name) throw new FindError(400, 'bad_name', FIND_BAD_NAME);
    sameDay(now);
    if (!countOne(askedByMembers, asker, FIND_BY_NAME_PER_DAY)) throw new FindError(429, 'find_day_used', FIND_DAY_USED);
    const answer = await forwardSignedForAnswer(`https://${home}${RELAY_FIND_PATH}`, JSON.stringify({ v: 1, asker, name }));
    if (answer.status !== 200 || (answer.body as { v?: unknown } | null | undefined)?.v !== 1) throw new FindError(502, 'not_reached', FIND_NOT_REACHED);
    const card = readFindAnswer(answer.body);
    if (!card || card.key === asker || !sameName(card.name, name)) return { found: false };
    return { found: true, card };
}

// ── Answering another community ─────────────────────────────────────────────────────────────

/** A card of the right shape, signed, of no member: checked in place of a kept one when nothing was found. */
let placeholder: AddressCard | null = null;
async function placeholderCard(): Promise<AddressCard> {
    if (placeholder) return placeholder;
    const seed = crypto.randomBytes(32);
    const key = Buffer.from(ed25519.getPublicKey(seed)).toString('hex');
    placeholder = await signAddressCard({ key, home: 'nobody.example', name: 'Nobody' }, (b) => ed25519.sign(b, seed));
    return placeholder;
}

let lastSteps: string[] = [];
/** The steps the last answer took (the suite: every look-up takes FIND_STEPS, whatever it finds). */
export function stepsOfLastAnswer(): readonly string[] {
    return lastSteps;
}

export interface FindAnswered { status: 200 | 400; body: string }

/** The answer to a look-up `origin` (another community's server, its signature checked) brought here. */
export async function answerFind(origin: string, body: unknown, now = Date.now()): Promise<FindAnswered> {
    const b = body as { v?: unknown; asker?: unknown; name?: unknown } | null | undefined;
    const name = findTypedName(b?.name);
    if (!b || b.v !== 1 || typeof b.asker !== 'string' || !KEY_HEX.test(b.asker) || !name) {
        return { status: 400, body: JSON.stringify({ error: 'A look-up is { v: 1, asker, name }.', code: 'not_a_lookup' }) };
    }
    const asker = b.asker;
    const steps: string[] = [];
    sameDay(now);
    steps.push('count-origin');
    const day = originDay(origin);
    day.looked = Math.min(day.looked + 1, FIND_PER_ORIGIN_DAY + 1);
    const originWithin = day.looked <= FIND_PER_ORIGIN_DAY;
    steps.push('count-asker');
    // Counted only while the origin is within its day; past it, read, so the steps are the same and the origin adds nothing.
    const askerWithin = originWithin ? countOne(day.askers, asker, FIND_BY_NAME_PER_DAY) : (day.askers.get(asker) ?? 0) < FIND_BY_NAME_PER_DAY;
    steps.push('read-name');
    // One indexed read (idx_members_callsign_fold) by the name rule, the name as typed and as a card writes it.
    const row = db.prepare(`
        SELECT m.public_key AS key, m.callsign AS callsign, p.pref_value AS card
        FROM members m
        LEFT JOIN member_preferences p ON p.public_key = m.public_key AND p.pref_key = ?
        WHERE m.callsign_fold IN (?, ?) AND m.status NOT IN ('migrated', 'pruned')
        ORDER BY p.pref_value IS NULL
        LIMIT 1
    `).get(FIND_BY_NAME_PREF, foldName(String(b.name).trim()), foldName(name)) as { key: string; callsign: string | null; card: string | null } | undefined;
    const key = row?.key ?? NOBODY_KEY;
    // From here every check runs whatever came before (no && between them): the same work for every answer.
    steps.push('check-member');
    const memberHere = isNodeMember(key);
    const readsHere = readsAsMember(key);
    steps.push('check-block');
    const blocked = hasBlocked(key, asker);
    steps.push('check-card');
    const kept = parseCard(row?.card);
    const card = kept ?? await placeholderCard();
    const signed = addressCardVerifies(card);
    const homeHere = isOwnNodeHome(card.home);
    const nameHere = sameName(card.name, row?.callsign ?? '');
    steps.push('check-switch');
    const outsideOn = outsideMessagesOn();
    lastSteps = steps;
    const found = [askerWithin, originWithin, outsideOn, !!row, !!kept, memberHere, readsHere, !blocked, key !== asker, signed, card.key === key, homeHere, nameHere]
        .every(Boolean);
    return { status: 200, body: found ? JSON.stringify({ v: 1, card: { v: 1, key: card.key, home: card.home, name: card.name, sig: card.sig } }) : FIND_NOBODY_BODY };
}
