/**
 * Private contacts: the list (scratch/fable-design/DESIGN-private-contacts-fable.md §4.1, §4.5, slice C0). One list per
 * account, the same on every device and in every community, locked by contacts-crypto.ts. Both apps read and write the
 * same JSON, so a change to this model is a change in both apps the same day, or one writes what the other can't open.
 *
 * ## A contact
 *
 * Kept small on purpose (as the names list is): a name, up to 5 numbers as written (never normalised, hashed, or
 * compared with anyone else's), up to 3 emails, a note, up to 5 links to BeanPool members (made by the member's own hand,
 * never by matching), the last invite sent, and a clock. Not kept: photos, addresses, birthdays, companies, groups.
 *
 * ## Merging (done on a device, never on a server)
 *
 * Every change bumps that contact's clock. A removed contact leaves a marker (its id, clock and when) for a year, so it
 * can't come back from a stale copy. For each id the higher clock wins; at the same clock a marker wins over a contact
 * (a removal is meant), and two contacts are ordered by their JSON, so every device picks the same one. The merged list
 * is sorted by id: two devices' offline changes merged in either order give the same bytes. A merge never drops a
 * contact for being over {@link CONTACTS_LIMITS.contacts}: the apps say so, and the member chooses who goes.
 *
 * ## Reading
 *
 * {@link readContactsList} reads a list opened from a box, never trusting it: a field of the wrong shape is dropped, a
 * long one cut, a contact without an id left out. A list from a newer app (`v` above {@link CONTACTS_LIST_VERSION}) is
 * refused whole rather than read in part and saved back without what it held.
 */
import { Buffer } from 'buffer';
import { randomBytes } from '@noble/hashes/utils.js';
import { assertRecoveryCsprngAvailable } from './recovery-split.js';

/** The version a list's JSON carries (`v`). */
export const CONTACTS_LIST_VERSION = 1;

/** The sizes everything is held to (design §4.1). */
export const CONTACTS_LIMITS = {
    contacts: 2000,
    nameChars: 100,
    phones: 5,
    phoneChars: 40,
    emails: 3,
    emailChars: 254,
    noteChars: 300,
    links: 5,
    callsignChars: 64,
    addressChars: 500,
    inviteCodeChars: 64,
} as const;

/** How long a removal's marker is kept: a year (design §4.5). */
export const CONTACTS_MARKER_KEEP_MS = 365 * 24 * 60 * 60 * 1000;

/** How a link to a BeanPool member was made: by hand (a chat or a deal), an invite the member confirmed, or a profile. */
export type ContactLinkHow = 'hand' | 'invite' | 'profile';
const HOWS: readonly ContactLinkHow[] = ['hand', 'invite', 'profile'];

/** A link to a BeanPool member: their key, the community where they were met, their callsign as last seen, how, and when. */
export interface ContactLink {
    key: string;
    community: string;
    callsign: string;
    how: ContactLinkHow;
    at: string;
}

/** The last invite sent to this person: its code, the community it is for, and when. Kept only in the locked list. */
export interface ContactInvite {
    code: string;
    community: string;
    at: string;
}

export interface Contact {
    id: string;
    name: string;
    phones: string[];
    emails: string[];
    note: string;
    links: ContactLink[];
    invite: ContactInvite | null;
    clock: number;
}

/** A removed contact's marker: kept a year, so an older copy can't bring the contact back. */
export interface ContactRemoved {
    id: string;
    clock: number;
    at: string;
}

export interface ContactsList {
    v: typeof CONTACTS_LIST_VERSION;
    contacts: Contact[];
    removed: ContactRemoved[];
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const ADDRESS = /^https?:\/\/[^\s|]{1,500}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const CLOCK_MAX = Number.MAX_SAFE_INTEGER;
/**
 * Removed from every text kept: control characters but a line break and a tab (a line break only in the note), lone
 * surrogates, and the marks that reorder text where it is shown (bidi embeddings, overrides, isolates and the direction
 * marks: design §7, "hidden direction marks"). Joiners stay: some scripts and emoji need them.
 */
const CONTROL = /(?![\n\t])\p{Cc}|\p{Cs}|[؜‎‏‪-‮⁦-⁩]/gu;

/** An empty list. */
export function emptyContactsList(): ContactsList {
    return { v: CONTACTS_LIST_VERSION, contacts: [], removed: [] };
}

/** A new contact id: 16 random bytes in hex, made on the device. */
export function newContactId(): string {
    assertRecoveryCsprngAvailable();
    return Buffer.from(randomBytes(16)).toString('hex');
}

/** `s` cut to `max` characters (whole code points), never splitting a surrogate pair. */
function cut(s: string, max: number): string {
    const cps = Array.from(s);
    return cps.length > max ? cps.slice(0, max).join('') : s;
}

/** A name as kept: control and direction marks out, on one line, trimmed, cut to the limit. */
export function cleanContactName(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return cut(raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), CONTACTS_LIMITS.nameChars).trim();
}

/** A note as kept: control and direction marks out (line breaks stay), trimmed, cut to the limit. */
export function cleanContactNote(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    return cut(raw.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim(), CONTACTS_LIMITS.noteChars).trim();
}

/** A number as written, on one line: only empty when there is nothing of a number in it. */
function cleanPhone(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const s = cut(raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim(), CONTACTS_LIMITS.phoneChars).trim();
    return /\d/.test(s) ? s : '';
}

function cleanEmail(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const s = raw.replace(CONTROL, '').trim();
    return s.length <= CONTACTS_LIMITS.emailChars && /^[^\s@]+@[^\s@]+$/.test(s) ? s : '';
}

/** The first `max` distinct non-empty values of `raw`, each through `clean`. */
function list(raw: unknown, clean: (v: unknown) => string, max: number, same: (v: string) => string = (v) => v): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of raw) {
        const c = clean(v);
        if (!c || seen.has(same(c))) continue;
        seen.add(same(c));
        out.push(c);
        if (out.length >= max) break;
    }
    return out;
}

/** The digits of a number, for telling two of the member's own numbers apart: never sent, never compared with anyone else's. */
export function contactPhoneDigits(phone: string): string {
    return phone.replace(/\D/g, '');
}

function readLink(raw: unknown): ContactLink | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === 'string' ? r.key.toLowerCase() : '';
    if (!HEX_KEY.test(key) || typeof r.community !== 'string' || !ADDRESS.test(r.community)) return null;
    if (!HOWS.includes(r.how as ContactLinkHow) || typeof r.at !== 'string' || !ISO.test(r.at)) return null;
    const callsign = typeof r.callsign === 'string' ? cut(r.callsign.replace(CONTROL, '').trim(), CONTACTS_LIMITS.callsignChars) : '';
    return { key, community: r.community, callsign, how: r.how as ContactLinkHow, at: r.at };
}

function readInvite(raw: unknown): ContactInvite | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.code !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(r.code)) return null;
    if (typeof r.community !== 'string' || !ADDRESS.test(r.community) || typeof r.at !== 'string' || !ISO.test(r.at)) return null;
    return { code: r.code, community: r.community, at: r.at };
}

function readClock(raw: unknown): number | null {
    return Number.isSafeInteger(raw) && (raw as number) >= 0 && (raw as number) <= CLOCK_MAX ? (raw as number) : null;
}

/**
 * A contact from anything (a list opened from a box, an edit, an import), in the one shape kept, with its keys in a fixed
 * order (so its JSON is the same on every device). Null without an id, a clock, or anything to call the person by.
 */
export function readContact(raw: unknown): Contact | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
    const clock = readClock(r.clock);
    if (!ID.test(id) || clock === null) return null;
    const name = cleanContactName(r.name);
    const phones = list(r.phones, cleanPhone, CONTACTS_LIMITS.phones, contactPhoneDigits);
    const emails = list(r.emails, cleanEmail, CONTACTS_LIMITS.emails, (e) => e.toLowerCase());
    if (!name && phones.length === 0 && emails.length === 0) return null;
    const links: ContactLink[] = [];
    if (Array.isArray(r.links)) {
        for (const l of r.links) {
            const link = readLink(l);
            if (link && !links.some((k) => k.key === link.key)) links.push(link);
            if (links.length >= CONTACTS_LIMITS.links) break;
        }
    }
    return {
        id, name: name || phones[0] || emails[0], phones, emails, note: cleanContactNote(r.note), links, invite: readInvite(r.invite), clock,
    };
}

/**
 * The list from an opened box's JSON. `{ ok: false, reason: 'newer' }` for a list a newer app wrote (never read in part),
 * `'unreadable'` for anything that isn't a list. Contacts that don't read are left out; a marker beats a contact under
 * the same id as a merge would.
 */
export function readContactsList(json: string): { ok: true; list: ContactsList } | { ok: false; reason: 'unreadable' | 'newer' } {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return { ok: false, reason: 'unreadable' }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'unreadable' };
    const p = parsed as Record<string, unknown>;
    if (typeof p.v !== 'number') return { ok: false, reason: 'unreadable' };
    if (p.v > CONTACTS_LIST_VERSION) return { ok: false, reason: 'newer' };
    if (p.v !== CONTACTS_LIST_VERSION || !Array.isArray(p.contacts) || !Array.isArray(p.removed)) return { ok: false, reason: 'unreadable' };
    const contacts = p.contacts.map(readContact).filter((c): c is Contact => c !== null);
    const removed: ContactRemoved[] = [];
    for (const m of p.removed) {
        if (!m || typeof m !== 'object') continue;
        const r = m as Record<string, unknown>;
        const id = typeof r.id === 'string' ? r.id.toLowerCase() : '';
        const clock = readClock(r.clock);
        if (ID.test(id) && clock !== null && typeof r.at === 'string' && ISO.test(r.at)) removed.push({ id, clock, at: r.at });
    }
    // Read as a merge with nothing: one version per id, the canonical order.
    return { ok: true, list: mergeContactsLists({ v: CONTACTS_LIST_VERSION, contacts, removed }, emptyContactsList()) };
}

/** The list's JSON, as it is locked: keys in a fixed order, contacts and markers by id. */
export function writeContactsList(list: ContactsList): string {
    const merged = mergeContactsLists(list, emptyContactsList());
    return JSON.stringify({ v: CONTACTS_LIST_VERSION, contacts: merged.contacts, removed: merged.removed });
}

type Version = { kind: 'contact'; c: Contact; json: string } | { kind: 'removed'; m: ContactRemoved };

/** Which of two versions of one id is kept: the higher clock; at the same clock a marker, then the larger JSON. */
function newer(a: Version, b: Version): Version {
    const ca = a.kind === 'contact' ? a.c.clock : a.m.clock;
    const cb = b.kind === 'contact' ? b.c.clock : b.m.clock;
    if (ca !== cb) return ca > cb ? a : b;
    if (a.kind === 'removed' && b.kind === 'removed') return a.m.at >= b.m.at ? a : b;
    if (a.kind === 'removed') return a;
    if (b.kind === 'removed') return b;
    return a.json >= b.json ? a : b;
}

/**
 * The two lists made one (design §4.5): for each id the newer version (see {@link newer}), contacts and markers sorted
 * by id. Commutative and associative, so any number of devices and copies, merged in any order, end the same.
 */
export function mergeContactsLists(a: ContactsList, b: ContactsList): ContactsList {
    const best = new Map<string, Version>();
    const take = (v: Version, id: string) => {
        const had = best.get(id);
        best.set(id, had ? newer(had, v) : v);
    };
    for (const l of [a, b]) {
        for (const c of l.contacts) {
            const read = readContact(c);
            if (read) take({ kind: 'contact', c: read, json: JSON.stringify(read) }, read.id);
        }
        for (const m of l.removed) take({ kind: 'removed', m: { id: m.id, clock: m.clock, at: m.at } }, m.id);
    }
    const ids = [...best.keys()].sort();
    const contacts: Contact[] = [];
    const removed: ContactRemoved[] = [];
    for (const id of ids) {
        const v = best.get(id)!;
        if (v.kind === 'contact') contacts.push(v.c);
        else removed.push(v.m);
    }
    return { v: CONTACTS_LIST_VERSION, contacts, removed };
}

/** The list with `contact` added or changed: its clock one past the newest this list holds for its id. */
export function putContact(list: ContactsList, contact: Omit<Contact, 'clock'> & { clock?: number }): ContactsList {
    const held = list.contacts.find((c) => c.id === contact.id)?.clock ?? -1;
    const marker = list.removed.find((m) => m.id === contact.id)?.clock ?? -1;
    const read = readContact({ ...contact, clock: Math.max(held, marker) + 1 });
    if (!read) throw new Error('A contact needs an id and a name, a number or an email.');
    return mergeContactsLists({ ...list, contacts: list.contacts.filter((c) => c.id !== read.id), removed: list.removed.filter((m) => m.id !== read.id) }, { v: CONTACTS_LIST_VERSION, contacts: [read], removed: [] });
}

/** The list with the contact `id` removed: a marker one past its clock, kept a year. */
export function removeContact(list: ContactsList, id: string, now: Date = new Date()): ContactsList {
    const held = list.contacts.find((c) => c.id === id);
    if (!held) return list;
    return mergeContactsLists(list, { v: CONTACTS_LIST_VERSION, contacts: [], removed: [{ id, clock: held.clock + 1, at: now.toISOString() }] });
}

/** "Remove everyone": every contact a marker (design §4.5), so no older copy brings anyone back. */
export function removeEveryContact(list: ContactsList, now: Date = new Date()): ContactsList {
    const at = now.toISOString();
    return mergeContactsLists(list, { v: CONTACTS_LIST_VERSION, contacts: [], removed: list.contacts.map((c) => ({ id: c.id, clock: c.clock + 1, at })) });
}

/** The list without markers older than a year (design §4.5). Run before a save. */
export function dropOldContactMarkers(list: ContactsList, now: Date = new Date()): ContactsList {
    const since = now.getTime() - CONTACTS_MARKER_KEEP_MS;
    return { ...list, removed: list.removed.filter((m) => Date.parse(m.at) >= since) };
}

/** What an import offers: a person as read from a file or the phone, before they are in the list. */
export interface ContactCandidate {
    name: string;
    phones: string[];
    emails: string[];
    note: string;
}

/**
 * Whether `candidate` is already in `list` (design §3.4): the same number (by its digits), the same email, or, with
 * neither, the same name. The review screen shows them unticked.
 */
export function contactAlreadyInList(list: ContactsList, candidate: ContactCandidate): boolean {
    const digits = new Set(candidate.phones.map(contactPhoneDigits).filter((d) => d.length > 0));
    const emails = new Set(candidate.emails.map((e) => e.toLowerCase()));
    const name = cleanContactName(candidate.name).toLowerCase();
    return list.contacts.some((c) => {
        if (c.phones.some((p) => digits.has(contactPhoneDigits(p)))) return true;
        if (c.emails.some((e) => emails.has(e.toLowerCase()))) return true;
        return digits.size === 0 && emails.size === 0 && c.phones.length === 0 && c.emails.length === 0 && !!name && c.name.toLowerCase() === name;
    });
}

/** Candidates made contacts with new ids, ready for {@link mergeContactsLists}; the ones that don't read are left out. */
export function contactsFromCandidates(candidates: readonly ContactCandidate[], newId: () => string = newContactId): Contact[] {
    const out: Contact[] = [];
    for (const c of candidates) {
        const read = readContact({ id: newId(), name: c.name, phones: c.phones, emails: c.emails, note: c.note, links: [], invite: null, clock: 0 });
        if (read) out.push(read);
    }
    return out;
}
