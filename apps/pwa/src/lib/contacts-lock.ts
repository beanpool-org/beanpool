/**
 * The web app's lock for the member's private contacts list (scratch/fable-design/DESIGN-private-contacts-fable.md §4.2,
 * slice C4): core's lock and list (contacts-crypto.ts, contacts-list.ts), handed this browser's key as it keeps it (PKCS8;
 * core's toEd25519Seed reads it, so a list locked here opens on the phone and back). Nothing here keeps or sends anything:
 * lib/contacts-store.ts does.
 *
 * The functions the frozen vectors exercise are re-exported from here, and lib/contacts-vectors.test.ts runs the vectors
 * through THIS module, so if the web ever wraps one of them differently, the vectors say whether the phone can still open
 * what the web locks.
 */
import {
    contactsKey, makeContactsCopy, openContactsBox, openContactsCopy, readContactsCopy, readContactsList, sealContactsBox,
    writeContactsList, contactsCopyWire, dropOldContactMarkers, type ContactsCopyWire, type ContactsList, type ContactsSigner,
} from '@beanpool/core';

export { contactsKey, makeContactsCopy, openContactsBox, openContactsCopy, readContactsCopy, sealContactsBox, writeContactsList };

/** What the lock needs of an identity: its public key and its private key (hex, PKCS8 or bare seed). */
export type ContactsKeys = ContactsSigner & { privateKey: string };

/** The list locked as copy `seq` for `me`, markers older than a year dropped first (design §4.5). */
export function lockContactsList(list: ContactsList, me: ContactsKeys, seq: number, now: Date = new Date()): ContactsCopyWire {
    return contactsCopyWire(makeContactsCopy({ json: writeContactsList(dropOldContactMarkers(list, now)), me, seq, savedAt: now }));
}

/**
 * A copy opened for `me`: the list and its number, or why not. `newer`: a newer app wrote it (never read in part, so it
 * is never saved back without what it held); `refused`: not `me`'s, not signed, or its box doesn't open.
 */
export function openContactsList(raw: unknown, me: ContactsKeys):
    { ok: true; list: ContactsList; seq: number; savedAt: string } | { ok: false; reason: 'refused' | 'newer' | 'unreadable' } {
    const opened = openContactsCopy(raw, me);
    if (!opened.ok) return { ok: false, reason: 'refused' };
    const read = readContactsList(opened.json);
    if (!read.ok) return { ok: false, reason: read.reason };
    return { ok: true, list: read.list, seq: opened.copy.seq, savedAt: opened.copy.savedAt };
}
