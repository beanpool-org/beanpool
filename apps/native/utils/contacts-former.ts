/**
 * Private contacts after a re-key (scratch/fable-design/DESIGN-private-contacts-fable.md §6.2, slice C6). A member who lost
 * their phone, their 12 words, any sign-in copy and anyone who could bring them back is re-keyed by an admin: a NEW key, so
 * the list their old key locked opens for nobody. Each community keeps that old locked copy a year beside the new key
 * (apps/server engine/contact-copies.ts, GET/DELETE /api/contacts/former), and two things soften the loss here:
 *
 *   1. **The old 12 words, if they turn up** ({@link openFormerWithWords}, on the old-words screen): they make the old key's
 *      seed, which opens the old copy (core's openContactsCopy checks that the copy names that key, that the key signed it,
 *      and opens the box with it). Its people are merged into the new list (core's merge, as two devices' lists are), and
 *      saved under the new key after the usual wait (contacts-sync.ts editContacts). The words and the seed live in memory
 *      for the one run: never sent, never stored. Nothing about the list is sent either: the requests are a GET and, if the
 *      member asks, a DELETE.
 *   2. **"Add people I've chatted with and my friends"** ({@link peopleToAdd}, {@link withPeopleAdded}): a re-key moves the
 *      member's chats and friends to the new key, so every BeanPool person comes back in two taps, each linked by hand to the
 *      community in use under their callsign. Never by matching: these are people the member already talks to here.
 *
 * What is truly gone, said as it is: the links confirmed by hand and the notes, unless the old words turn up.
 */
import {
    CONTACTS_LIMITS, cleanContactName, mergeContactsLists, newContactId, openContactsCopy, readContactsCopy, readContactsList,
    type ContactsCopyWire, type ContactsList, type FormerOutcome,
} from '@beanpool/core';
import { bytesToHex } from '@noble/hashes/utils.js';
import { editContacts, phoneSyncDeps, type ContactsSyncDeps } from './contacts-sync';
import type { ContactsAccount, ContactsKv } from './contacts-store';
import { oldKeyFromWords } from './old-key-from-words';

export const CONTACTS_FORMER_PATH = '/api/contacts/former';

/**
 * Said (DeviceEventEmitter) once the old-words screen has tried the old list: the Contacts screen's notice asks again, so a
 * merge turns it to its merged form even when it added nobody new (no list changed to tell it).
 */
export const CONTACTS_FORMER_CHANGED_EVENT = 'beanpool_contacts_former_changed';

/** An old copy one of the member's communities keeps for their key now. */
export interface FormerCopyAt {
    community: string;
    copy: ContactsCopyWire;
    /** The key the server says it is locked with. Never trusted: opening it is the check. */
    formerKey: string;
    keptUntil: string;
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** A former copy from a server's answer, or null when it isn't one (a copy's header, signed, with its key and last day). */
function formerOf(community: string, body: unknown): FormerCopyAt | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const read = readContactsCopy(b);
    if (!read.ok || typeof b.formerKey !== 'string' || !HEX_KEY.test(b.formerKey) || typeof b.keptUntil !== 'string') return null;
    return { community, copy: { header: read.copy.header, signature: read.copy.signature, nonce: read.copy.nonce, sealed: read.copy.sealed }, formerKey: b.formerKey, keptUntil: b.keptUntil };
}

/** A server's error, or "slow down": no answer about the old copy, never "it keeps none". */
const noAnswerStatus = (status: number): boolean => status >= 500 || status === 429 || status === 408;

/**
 * The old copy `community` keeps for the member's key now: the copy, null when it keeps none (or keeps no lists), and
 * undefined when it didn't answer (no reply, or a server error or "slow down" in place of one).
 */
export async function formerCopyAt(account: ContactsAccount, community: string, deps: Pick<ContactsSyncDeps, 'net'>): Promise<FormerCopyAt | null | undefined> {
    const answer = await deps.net.call(community, account, 'GET', CONTACTS_FORMER_PATH);
    if (!answer || noAnswerStatus(answer.status)) return undefined;
    if (answer.status !== 200) return null;
    return formerOf(community, answer.body);
}

/**
 * Every old copy the member's communities keep (one GET each); whether any community answered at all; the ones that
 * didn't; and the community in use (the anchor), which the Contacts notice is about.
 */
export async function findFormerCopies(account: ContactsAccount, deps: ContactsSyncDeps): Promise<{ found: FormerCopyAt[]; answered: boolean; silent: string[]; anchor: string | null }> {
    const { anchor, kept } = await deps.communities();
    const order = [...new Set([anchor, ...kept].filter((c): c is string => !!c))];
    const found: FormerCopyAt[] = [];
    const silent: string[] = [];
    let answered = false;
    for (const c of order) {
        const f = await formerCopyAt(account, c, deps);
        if (f === undefined) silent.push(c);
        else answered = true;
        if (f) found.push(f);
    }
    return { found, answered, silent, anchor: anchor ?? null };
}

/** Where the phone notes the old copies it has merged in, so the Contacts notice offers only their Delete. Per account. */
export function formerMergedStoreKey(publicKey: string): string {
    return `beanpool_contacts:former-merged:${publicKey.toLowerCase()}`;
}

/** An old copy's own mark: the digest its signed header names. */
const digestOf = (copy: ContactsCopyWire): string => copy.header.split('\n')[4] ?? '';

async function mergedDigests(kv: Pick<ContactsKv, 'getItem'>, publicKey: string): Promise<string[]> {
    try {
        const parsed = JSON.parse((await kv.getItem(formerMergedStoreKey(publicKey))) ?? '[]');
        return Array.isArray(parsed) ? parsed.filter((d): d is string => typeof d === 'string') : [];
    } catch {
        return [];
    }
}

/** Whether the phone already merged this old copy in. */
export async function formerAlreadyMerged(account: ContactsAccount, f: FormerCopyAt, kv: Pick<ContactsKv, 'getItem'>): Promise<boolean> {
    return (await mergedDigests(kv, account.publicKey)).includes(digestOf(f.copy));
}

/** The Contacts notice's old copy, and whether this phone has merged it in already. */
export interface FormerNotice extends FormerCopyAt {
    merged: boolean;
}

/**
 * The Contacts screen's notice (design §6.2): the old copy the community in use keeps. Before this phone merged it in, the
 * notice offers the old words and Delete it; after, only "Delete the old copy" (`merged`), since the community keeps the copy
 * until it is deleted or its year is up, and this is the phone's one way to delete it (#3170 round 2, director's call: no
 * automatic delete). One GET, as the screen opens. Never throws: no answer is no notice.
 */
export async function formerNoticeHere(account: ContactsAccount, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<FormerNotice | null> {
    try {
        const { anchor } = await deps.communities();
        if (!anchor) return null;
        const f = await formerCopyAt(account, anchor, deps);
        if (!f) return null;
        return { ...f, merged: await formerAlreadyMerged(account, f, deps.kv) };
    } catch {
        return null;
    }
}

export type { FormerOutcome };

/**
 * The old 12 words open the member's old list, and its people are merged into the list on this phone (see the header).
 * `typed` is held for this call only. Throws what editContacts throws (a list on this phone that can't be opened is never
 * written over).
 */
export async function openFormerWithWords(typed: string | readonly string[], account: ContactsAccount, deps: ContactsSyncDeps): Promise<FormerOutcome> {
    const old = oldKeyFromWords(typed);
    if (!old) return { kind: 'not_the_key' };
    // The seed's hex can't be wiped in JS: it lives in this call only and is never written anywhere.
    const seedHex = bytesToHex(old.seed);
    old.seed.fill(0);
    if (old.publicKey === account.publicKey.toLowerCase()) return { kind: 'not_the_key' };
    const { found, answered } = await findFormerCopies(account, deps);
    if (!answered) return { kind: 'no_answer' };
    if (found.length === 0) return { kind: 'none' };
    const lists: ContactsList[] = [];
    const opened: string[] = [];
    for (const f of found) {
        const o = openContactsCopy(f.copy, { publicKey: old.publicKey, privateKey: seedHex });
        if (!o.ok) continue;
        const read = readContactsList(o.json);
        if (!read.ok) continue;
        lists.push(read.list);
        opened.push(digestOf(f.copy));
    }
    if (lists.length === 0) return { kind: 'not_the_key' };
    const theirs = lists.reduce((a, b) => mergeContactsLists(a, b));
    let before = 0;
    const after = await editContacts(account, (mine) => {
        before = mine.contacts.length;
        return mergeContactsLists(mine, theirs);
    }, deps);
    const seen = await mergedDigests(deps.kv, account.publicKey);
    await deps.kv.setItem(formerMergedStoreKey(account.publicKey), JSON.stringify([...new Set([...seen, ...opened])]));
    return { kind: 'merged', added: Math.max(0, after.contacts.length - before), people: theirs.contacts.length };
}

/**
 * "Delete it": every old copy the member's communities keep goes (a signed DELETE each, where one was found). Returns how
 * many went; `here`, whether the community in use (the one the notice is about) confirmed: it answered that it keeps none,
 * or its DELETE answered 200; and `complete`, whether that holds for every community. A community that didn't answer may
 * still hold one, so it is never counted as done.
 */
export async function deleteFormerCopies(account: ContactsAccount, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<{ deleted: number; here: boolean; complete: boolean }> {
    const { found, silent, anchor } = await findFormerCopies(account, deps);
    const unconfirmed = new Set(silent);
    let deleted = 0;
    for (const f of found) {
        const answer = await deps.net.call(f.community, account, 'DELETE', CONTACTS_FORMER_PATH);
        if (answer?.status === 200) deleted++;
        else unconfirmed.add(f.community);
    }
    const here = anchor !== null && !unconfirmed.has(anchor);
    return { deleted, here, complete: here && unconfirmed.size === 0 };
}

// ── "Add people I've chatted with and my friends" (§6.2, item 2) ───────────────────────────────────────────────────

/** A BeanPool member the member has chatted with or added as a friend here. */
export interface BeanPoolPerson {
    key: string;
    callsign: string;
}

/**
 * The people to add: each key once, never the member's own, nobody the list already links to (by key, in any community),
 * and nobody past the list's limit. In the order given.
 */
export function peopleToAdd(list: ContactsList, people: readonly BeanPoolPerson[], me: string): BeanPoolPerson[] {
    const linked = new Set(list.contacts.flatMap((c) => c.links.map((l) => l.key.toLowerCase())));
    const room = Math.max(0, CONTACTS_LIMITS.contacts - list.contacts.length);
    const out: BeanPoolPerson[] = [];
    for (const p of people) {
        const key = typeof p?.key === 'string' ? p.key.toLowerCase() : '';
        if (!HEX_KEY.test(key) || key === me.toLowerCase() || linked.has(key)) continue;
        linked.add(key);
        out.push({ key, callsign: p.callsign });
    }
    return out.slice(0, room);
}

/**
 * The list with each of `people` added as a contact: named by their callsign (the member renames them as they like), linked
 * by hand to `community`, where they were met. Run {@link peopleToAdd} on the list as it is then, so nobody is added twice.
 */
export function withPeopleAdded(list: ContactsList, people: readonly BeanPoolPerson[], me: string, community: string, now: Date = new Date(), newId: () => string = newContactId): ContactsList {
    const add = peopleToAdd(list, people, me);
    if (add.length === 0) return list;
    const at = now.toISOString();
    const contacts = add.map((p) => {
        // Core cuts a link's callsign to its limit by characters (contacts-list.ts readLink), never by halves of one.
        const callsign = cleanContactName(p.callsign);
        return { id: newId(), name: callsign || `@${p.key.slice(0, 8)}`, phones: [], emails: [], note: '', links: [{ key: p.key, community, callsign, how: 'hand' as const, at }], invite: null, clock: 0 };
    });
    return mergeContactsLists(list, { v: list.v, contacts, removed: [] });
}

// The words (design §6.2) are core's contacts-former-words.ts: this file turns the old 12 words into a key, so it reaches
// no words layer (core __tests__/recovery-path-files.test.ts), and the web says the same sentences.
