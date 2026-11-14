/**
 * Import on the phone (scratch/fable-design/DESIGN-private-contacts-fable.md §3.4, §5.4, §7, slice C3): the phone's own
 * contacts (expo-contacts, permission asked at the tap) or a contacts file (expo-document-picker, no permission), then the
 * same review and the same one change as the web's ContactsPage (apps/pwa, slice C4).
 *
 * **Asked only at the tap** (memory `permissions-only-when-asked`). Nothing here runs on its own: {@link askForPhoneContacts}
 * is called from the "From this phone's contacts" row's press, and the native modules are loaded only then. Read only: the
 * app never asks to write contacts (app.json blocks WRITE_CONTACTS, which expo-contacts' plugin would add).
 *
 * **Names, numbers and emails, nothing more.** {@link PHONE_CONTACT_FIELDS} is passed on every read: without `fields`,
 * expo-contacts returns everything (notes, which iOS guards with an entitlement we don't hold, and pictures).
 *
 * **Nothing leaves the phone** here. A file is read on the phone and the picker's copy removed at once; the people chosen
 * become one locked change ({@link importChosen}: the list opened once and written once, however many are chosen), which
 * leaves the phone only as the locked copy, after the usual wait (contacts-store.ts). No number is matched with anyone (§5.4).
 */
import {
    CONTACTS_FILE_MAX_BYTES, CONTACTS_FILE_WORDS, CONTACTS_LIMITS, CONTACTS_READ_MAX, cleanContactName, contactPhoneDigits,
    contactsFromCandidates, emptyContactsList, mergeContactsLists, readContactsFile, type ContactCandidate, type ContactsList, type WordKey,
} from '@beanpool/core';
import type { ContactsAccount } from './contacts-store';
import { editContacts, phoneSyncDeps, type ContactsSyncDeps } from './contacts-sync';

/** The fields read from the phone's contacts: names, numbers, emails. Never notes, pictures, addresses or birthdays. */
export const PHONE_CONTACT_FIELDS = ['name', 'firstName', 'lastName', 'phoneNumbers', 'emails'] as const;
/** How many are read at a time, so a big address book never holds the screen. */
export const PHONE_CONTACTS_PAGE = 500;

/** A person as expo-contacts gives one, with the fields asked for. */
export interface PhoneContact {
    name?: string;
    firstName?: string;
    lastName?: string;
    phoneNumbers?: { number?: string }[];
    emails?: { email?: string }[];
}

/** The parts of expo-contacts used here. Tests pass their own. */
export interface PhoneContactsModule {
    requestPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean; status: string; accessPrivileges?: 'all' | 'limited' | 'none' }>;
    getContactsAsync(q: { fields: readonly string[]; pageSize: number; pageOffset: number }): Promise<{ data: PhoneContact[]; hasNextPage: boolean }>;
}

/**
 * expo-contacts, or null in an app built without it (a dev client older than this slice: the row is then not offered).
 * Loaded only when asked: requiring it registers nothing and asks nothing.
 */
export function phoneContactsModule(): PhoneContactsModule | null {
    const { requireOptionalNativeModule } = require('expo-modules-core') as { requireOptionalNativeModule(name: string): unknown };
    if (!requireOptionalNativeModule('ExpoContacts')) return null;
    return require('expo-contacts') as PhoneContactsModule;
}

/**
 * The phone's answer to "may BeanPool read your contacts" (design §3.4): asked now, at the member's tap. `granted` (an
 * iPhone on selected contacts only is a yes: the list shows those), `denied` (said no; the phone may ask again), `blocked`
 * (the phone won't ask again: Settings is the way). A library that fails is a no for now.
 */
export async function askForPhoneContacts(m: PhoneContactsModule): Promise<'granted' | 'denied' | 'blocked'> {
    try {
        const r = await m.requestPermissionsAsync();
        if (r.granted) return 'granted';
        return r.canAskAgain ? 'denied' : 'blocked';
    } catch (e) {
        console.warn('[Contacts] The phone did not answer the contacts question', e);
        return 'denied';
    }
}

/** One person from the phone as an import offers them; null with nothing to call them by. Held to core's limits. */
export function candidateOfPhoneContact(c: PhoneContact): ContactCandidate | null {
    const name = cleanContactName(c.name) || cleanContactName([c.firstName, c.lastName].filter(Boolean).join(' '));
    const phones: string[] = [];
    const digits = new Set<string>();
    for (const p of c.phoneNumbers ?? []) {
        const n = typeof p?.number === 'string' ? p.number.trim() : '';
        const d = contactPhoneDigits(n);
        if (!d || digits.has(d)) continue;
        digits.add(d);
        phones.push(n.slice(0, CONTACTS_LIMITS.phoneChars));
        if (phones.length >= CONTACTS_LIMITS.phones) break;
    }
    const emails: string[] = [];
    for (const e of c.emails ?? []) {
        const v = typeof e?.email === 'string' ? e.email.trim() : '';
        if (!v.includes('@') || emails.some((x) => x.toLowerCase() === v.toLowerCase())) continue;
        emails.push(v);
        if (emails.length >= CONTACTS_LIMITS.emails) break;
    }
    if (!name && phones.length === 0 && emails.length === 0) return null;
    return { name, phones, emails, note: '' };
}

/**
 * The phone's contacts, read once, now (design §3.4: "It doesn't watch them"), a page at a time with a breath between
 * pages, at most {@link CONTACTS_READ_MAX}. Call only after {@link askForPhoneContacts} said yes. Throws what the library throws.
 */
export async function readPhoneContacts(m: PhoneContactsModule): Promise<ContactCandidate[]> {
    const out: ContactCandidate[] = [];
    for (let offset = 0; out.length < CONTACTS_READ_MAX; offset += PHONE_CONTACTS_PAGE) {
        const page = await m.getContactsAsync({ fields: PHONE_CONTACT_FIELDS, pageSize: PHONE_CONTACTS_PAGE, pageOffset: offset });
        for (const p of page.data) {
            const c = candidateOfPhoneContact(p);
            if (c && out.length < CONTACTS_READ_MAX) out.push(c);
        }
        if (!page.hasNextPage || page.data.length === 0) break;
        await new Promise((r) => setTimeout(r, 0));
    }
    return out;
}

/** The modules a file import uses. Tests pass their own. */
export interface ContactsPickerModules {
    DocumentPicker: { getDocumentAsync(o: { type: string; copyToCacheDirectory: boolean; multiple: boolean }): Promise<{ canceled: boolean; assets: { uri: string; size?: number }[] | null }> };
    FileSystem: { readAsStringAsync(uri: string): Promise<string>; deleteAsync(uri: string, o: { idempotent: boolean }): Promise<void> };
}

/** expo-document-picker and the file system, or null in an app built without the picker. */
export function contactsPickerModules(): ContactsPickerModules | null {
    const { requireOptionalNativeModule } = require('expo-modules-core') as { requireOptionalNativeModule(name: string): unknown };
    if (!requireOptionalNativeModule('ExpoDocumentPicker')) return null;
    return { DocumentPicker: require('expo-document-picker'), FileSystem: require('expo-file-system/legacy') } as ContactsPickerModules;
}

export type PickedFile =
    | { kind: 'cancelled' }
    | { kind: 'refused'; words: WordKey }
    | { kind: 'read'; candidates: ContactCandidate[]; more: number; cutOff: boolean };

/**
 * A contacts file from the phone's own file picker (design §3.4: no permission). Any file may be picked (other apps label a
 * .vcf in several ways); one over 25 MB is refused before it is read, one that isn't a contacts file says so. The picker
 * copies the file into the app's cache; that copy is not locked, so it is removed as soon as it is read, whatever happens
 * (and at the next start, should the app be ended first: use-contacts.ts `sweepContactsFile`).
 */
export async function pickContactsFile(m: ContactsPickerModules): Promise<PickedFile> {
    const picked = await m.DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
    const asset = picked.canceled ? null : picked.assets?.[0];
    if (!asset) return { kind: 'cancelled' };
    try {
        if ((asset.size ?? 0) > CONTACTS_FILE_MAX_BYTES) return { kind: 'refused', words: CONTACTS_FILE_WORDS.tooBig };
        let text: string;
        try {
            text = await m.FileSystem.readAsStringAsync(asset.uri);
        } catch {
            return { kind: 'refused', words: CONTACTS_FILE_WORDS.notVcard };
        }
        const r = readContactsFile(text);
        if (!r.ok) return { kind: 'refused', words: r.words };
        if (r.candidates.length === 0) return { kind: 'refused', words: CONTACTS_FILE_WORDS.notVcard };
        return { kind: 'read', candidates: r.candidates, more: r.more, cutOff: r.cutOff };
    } finally {
        await m.FileSystem.deleteAsync(asset.uri, { idempotent: true }).catch(() => {});
    }
}

/** One row of "Choose who to bring": the person, the name shown, already in the list, and with no number or email. */
export interface ReviewRow {
    i: number;
    c: ContactCandidate;
    name: string;
    had: boolean;
    bare: boolean;
}

/**
 * The review's rows (design §3.4), as the web's ReviewView makes them: someone is already in the list by the same number,
 * the same email, or, with neither, the same name (core's `contactAlreadyInList`, the same rule), found through one index of
 * the list rather than the whole list once per person: 2,000 against 2,000 is 4,000 lookups, not 4,000,000 comparisons.
 */
export function reviewRows(list: ContactsList, candidates: readonly ContactCandidate[]): ReviewRow[] {
    const digits = new Set<string>();
    const emails = new Set<string>();
    const bareNames = new Set<string>();
    for (const c of list.contacts) {
        for (const p of c.phones) { const d = contactPhoneDigits(p); if (d) digits.add(d); }
        for (const e of c.emails) emails.add(e.toLowerCase());
        if (c.phones.length === 0 && c.emails.length === 0) bareNames.add(c.name.toLowerCase());
    }
    return candidates.map((c, i) => {
        const ds = c.phones.map(contactPhoneDigits).filter((d) => d.length > 0);
        const name = cleanContactName(c.name);
        const had = ds.some((d) => digits.has(d)) || c.emails.some((e) => emails.has(e.toLowerCase()))
            || (ds.length === 0 && c.emails.length === 0 && !!name && bareNames.has(name.toLowerCase()));
        return { i, c, name: name || c.phones[0] || c.emails[0] || '', had, bare: c.phones.length === 0 && c.emails.length === 0 };
    });
}

/**
 * The people chosen, in the list: one change (the list opened once and written once, whoever is chosen; a change per person
 * would open the list 2,000 times, most of a second each on an old phone), saved after its wait as every change is.
 * Returns how many were added. Throws what `editContacts` throws.
 */
export async function importChosen(account: ContactsAccount, chosen: readonly ContactCandidate[], deps: ContactsSyncDeps = phoneSyncDeps()): Promise<number> {
    const contacts = contactsFromCandidates(chosen);
    await editContacts(account, (l) => mergeContactsLists(l, { ...emptyContactsList(), contacts }), deps);
    return contacts.length;
}
