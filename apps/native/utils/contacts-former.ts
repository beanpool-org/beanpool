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
    CONTACTS_LIMITS, cleanContactName, mergeContactsLists, newContactId, openContactsCopy, readContactsCopy, readContactsList, t, tn,
    type ContactsCopyWire, type ContactsList,
} from '@beanpool/core';
import { bytesToHex } from '@noble/hashes/utils.js';
import { editContacts, phoneSyncDeps, type ContactsSyncDeps } from './contacts-sync';
import type { ContactsAccount, ContactsKv } from './contacts-store';
import { oldKeyFromWords } from './old-key-from-words';

export const CONTACTS_FORMER_PATH = '/api/contacts/former';

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

/**
 * The old copy `community` keeps for the member's key now: the copy, null when it keeps none (or keeps no lists), and
 * undefined when it didn't answer.
 */
export async function formerCopyAt(account: ContactsAccount, community: string, deps: Pick<ContactsSyncDeps, 'net'>): Promise<FormerCopyAt | null | undefined> {
    const answer = await deps.net.call(community, account, 'GET', CONTACTS_FORMER_PATH);
    if (!answer) return undefined;
    if (answer.status !== 200) return null;
    return formerOf(community, answer.body);
}

/** Every old copy the member's communities keep (one GET each), and whether any community answered at all. */
export async function findFormerCopies(account: ContactsAccount, deps: ContactsSyncDeps): Promise<{ found: FormerCopyAt[]; answered: boolean }> {
    const { anchor, kept } = await deps.communities();
    const order = [...new Set([anchor, ...kept].filter((c): c is string => !!c))];
    const found: FormerCopyAt[] = [];
    let answered = false;
    for (const c of order) {
        const f = await formerCopyAt(account, c, deps);
        if (f !== undefined) answered = true;
        if (f) found.push(f);
    }
    return { found, answered };
}

/** Where the phone notes the old copies it has merged in, so the Contacts screen stops offering them. Per account. */
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

/**
 * The Contacts screen's notice (design §6.2): the old copy the community in use keeps, while this phone hasn't merged it in.
 * One GET, as the screen opens. Never throws: no answer is no notice.
 */
export async function formerNoticeHere(account: ContactsAccount, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<FormerCopyAt | null> {
    try {
        const { anchor } = await deps.communities();
        if (!anchor) return null;
        const f = await formerCopyAt(account, anchor, deps);
        if (!f || await formerAlreadyMerged(account, f, deps.kv)) return null;
        return f;
    } catch {
        return null;
    }
}

/** What the old words did. */
export type FormerOutcome =
    /** No community answered: try again when connected. */
    | { kind: 'no_answer' }
    /** No community keeps an old list for this account. */
    | { kind: 'none' }
    /** Not 12 listed words, or not the key any old list is locked with. */
    | { kind: 'not_the_key' }
    /** The old list's people merged into the list: `added` new to it, of `people` in the old one. */
    | { kind: 'merged'; added: number; people: number };

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
 * many went, and whether every community holding one answered.
 */
export async function deleteFormerCopies(account: ContactsAccount, deps: ContactsSyncDeps = phoneSyncDeps()): Promise<{ deleted: number; complete: boolean }> {
    const { found, answered } = await findFormerCopies(account, deps);
    let deleted = 0;
    let complete = answered;
    for (const f of found) {
        const answer = await deps.net.call(f.community, account, 'DELETE', CONTACTS_FORMER_PATH);
        if (answer?.status === 200) deleted++;
        else complete = false;
    }
    return { deleted, complete };
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

// ── The words (design §6.2) ─────────────────────────────────────────────────────────────────────────────────────────

/** The Contacts screen's notice, and the old-words screen opened for the old list. */
export const formerContactsWords = {
    notice: () => t('Your contacts are locked with your old key. If you ever find your old 12 words, you can open them here.'),
    open: () => t('Open with my old 12 words'),
    remove: () => t('Delete it', undefined, 'button: delete the old locked contacts list'),
    removeTitle: () => t('Delete your old contacts list?'),
    removeAsk: () => t("Only your old 12 words can open it. Once it's deleted, nobody can ever open it again."),
    removeFailed: () => t("Some of your communities didn't answer. Your old contacts list is still kept there. Try again later."),
    title: () => t('Your old contacts list'),
    body: () => t('Type the 12 words of the key this account used before. They open your old contacts list on this phone and are never sent or kept.'),
    button: () => t('Open my old contacts'),
    busy: () => t('Opening your old contacts...'),
};

/** What the old-words screen says when it is done with the old list. */
export function formerContactsEndWords(r: FormerOutcome): { text: string; ok: boolean } {
    switch (r.kind) {
        case 'merged':
            if (r.added === 0) return { text: t('Done. Everyone in your old contacts list was already in your contacts.'), ok: true };
            return {
                text: tn(r.added, 'Done. {n} person from your old contacts list is back in your contacts.', 'Done. {n} people from your old contacts list are back in your contacts.'),
                ok: true,
            };
        case 'not_the_key':
            return { text: t("These words don't open your old contacts list. Check each word, and that they are the words of the key you had before."), ok: false };
        case 'none':
            return { text: t('None of your communities keeps an old contacts list for you.'), ok: true };
        case 'no_answer':
            return { text: t("Your communities didn't answer. Try again when you're connected."), ok: false };
    }
}

/** "Add people I've chatted with and my friends" (design §3.6's ⋯, §6.2). */
export const addPeopleWords = {
    row: () => t("Add people I've chatted with and my friends"),
    ask: (n: number, community: string) => tn(n,
        "Add {n} person you've chatted with or added as a friend in {community}? Only you see your contacts, and nobody is told.",
        "Add {n} people you've chatted with or added as friends in {community}? Only you see your contacts, and nobody is told.",
        { community }),
    yes: (n: number) => tn(n, 'Add {n} person', 'Add {n} people'),
    none: () => t("Everyone you've chatted with or added as a friend here is already in your contacts."),
    unread: () => t("Couldn't read your chats on this phone. Try again."),
};
