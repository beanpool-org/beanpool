/**
 * The member's private contacts as the phone's screens show them (scratch/fable-design/DESIGN-private-contacts-fable.md
 * §3.1, §3.6, slice C2): the list on this phone, the record of its copies, the communities that keep them and their names,
 * the footer's sentence, and the file out. The list is contacts-store.ts, its copies contacts-sync.ts; every change goes
 * through `editContacts` there.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t, timeAgo, writeContactsVcard, type ContactsList } from '@beanpool/core';
import {
    contactsSyncStoreKey, loadContacts, onContactsChanged, readSyncState, type ContactsAccount, type ContactsOnPhone, type ContactsSyncState,
} from './contacts-store';
import { contactsCommunities, contactsKeptAt } from './contacts-sync';
import { communityName } from './community-name';

export interface ContactsView {
    onPhone: ContactsOnPhone;
    state: ContactsSyncState;
    /** The community in use (null for none, or one the phone only looks at), and every one that keeps a copy, that one first. */
    anchor: string | null;
    communities: string[];
    /** Each community's name as the phone shows it (community-name.ts). */
    names: Record<string, string>;
}

/** The people in the list, or none when there is no list or it can't be opened. */
export function contactsOf(view: ContactsView | null): ContactsList['contacts'] {
    return view?.onPhone.kind === 'list' ? view.onPhone.list.contacts : [];
}

async function savedNames(): Promise<Record<string, string>> {
    const { getSavedNodes } = await import('./nodes');
    const names: Record<string, string> = {};
    for (const n of await getSavedNodes().catch(() => [])) names[n.url] = communityName(n);
    return names;
}

/**
 * The account's contacts, read when the screen mounts and again whenever the list or its record changes. Null until read,
 * and with no account. Each read opens the list once.
 */
export function useContacts(account: ContactsAccount | null | undefined): ContactsView | null {
    const [view, setView] = useState<ContactsView | null>(null);
    const key = account?.publicKey ? account.publicKey.toLowerCase() : null;
    useEffect(() => {
        setView(null);
        if (!account?.publicKey || !account.privateKey) return;
        let alive = true;
        const read = async () => {
            const [{ onPhone, state }, kept, names] = await Promise.all([
                loadContacts(account),
                contactsCommunities(AsyncStorage).catch(() => ({ anchor: null, kept: [] as string[] })),
                savedNames(),
            ]);
            const communities = [...new Set([kept.anchor, ...kept.kept].filter((c): c is string => !!c))];
            if (alive) setView({ onPhone, state, anchor: kept.anchor, communities, names });
        };
        void read().catch((e) => console.warn('[Contacts] The list was not read', e));
        const stop = onContactsChanged((pk) => { if (pk.toLowerCase() === key) void read().catch(() => {}); });
        return () => { alive = false; stop(); };
        // The account's key is what matters: a new identity object for the same account reads nothing again.
    }, [key]);
    return view;
}

/**
 * The record kept beside the list (contacts-store.ts), read without opening the list: whether a list was ever kept on this
 * phone, and "Your contacts are back". What the Chat tab needs. Opening a list of 2,000 takes most of a second on an old
 * phone, on the JS thread (measured on the API 26 emulator in the PR that made this), so a tab the member opens all day
 * never opens it. Null until read, with no account, and before a first contact.
 */
export function useContactsRecord(account: Pick<ContactsAccount, 'publicKey'> | null | undefined): ContactsSyncState | null {
    const [state, setState] = useState<ContactsSyncState | null>(null);
    const key = account?.publicKey ? account.publicKey.toLowerCase() : null;
    useEffect(() => {
        setState(null);
        if (!key) return;
        let alive = true;
        const read = () => AsyncStorage.getItem(contactsSyncStoreKey(key))
            .then((raw) => { if (alive) setState(raw === null ? null : readSyncState(raw)); })
            .catch(() => {});
        void read();
        const stop = onContactsChanged((pk) => { if (pk.toLowerCase() === key) void read(); });
        return () => { alive = false; stop(); };
    }, [key]);
    return state;
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
export function communityLabel(view: Pick<ContactsView, 'names'>, url: string): string {
    return view.names[url] ?? hostOf(url);
}

/**
 * The Contacts screen's footer (design §3.6): the truth about where the copies are, the same sentences as the web's with
 * "this phone" for "this device", and each community that keeps no lists named (§4.3).
 */
export function contactsWhereWords(view: ContactsView, now = Date.now()): string {
    const { at, off, savedAt } = contactsKeptAt(view.state, view.onPhone, view.communities);
    const name = (c: string) => communityLabel(view, c);
    const open = view.communities.filter((c) => !off.includes(c));
    const places = (list: string[]) => list.map(name).join(', ');
    let main: string;
    if (open.length === 0) main = t('Kept on this phone only. Save a copy as a file to keep it safe.');
    else if (view.state.dueAt !== null && view.state.dueAt > now) main = t('Kept on this phone. Your latest changes go to {places} within 15 minutes.', { places: places(open) });
    else if (at.length === 0) main = t('Kept on this phone only. BeanPool will try your communities again.');
    else if (savedAt !== null) main = t('Kept on this phone and at: {places} · saved {when}', { places: places(at), when: timeAgo(Math.max(0, now - savedAt)) });
    else main = t('Kept on this phone and at: {places}', { places: places(at) });
    const lines = [main, ...off.map((c) => t("{community} doesn't keep contact lists.", { community: name(c) }))];
    if (Object.values(view.state.refused).some((r) => r.code === 'too_big' && r.until > now)) {
        lines.push(t('Your list is now too big for one locked copy. Remove some people so your communities can keep it.'));
    }
    return lines.join(' ');
}

/** The file modules, loaded when Save is pressed. Tests pass their own. */
export interface ContactsFileModules {
    FileSystem: { cacheDirectory: string | null; writeAsStringAsync(uri: string, text: string): Promise<void>; deleteAsync(uri: string, o: { idempotent: boolean }): Promise<void> };
    Sharing: { shareAsync(uri: string, options?: { mimeType?: string; UTI?: string; dialogTitle?: string }): Promise<unknown> };
}

/**
 * "Save a copy as a file (.vcf)" (design §3.9): the list written as a contacts file and handed to the phone's own share
 * sheet, where the member saves it or sends it to themselves. The file isn't locked, so it never stays in the app's cache:
 * it is removed once the sheet closes, and if writing it fails.
 */
export async function shareContactsFile(list: ContactsList, modules?: ContactsFileModules): Promise<void> {
    const m = modules ?? { FileSystem: require('expo-file-system/legacy'), Sharing: require('expo-sharing') } as ContactsFileModules;
    if (!m.FileSystem.cacheDirectory) throw new Error('This phone has no cache folder.');
    const uri = `${m.FileSystem.cacheDirectory.replace(/\/?$/, '/')}contacts.vcf`;
    try {
        await m.FileSystem.writeAsStringAsync(uri, writeContactsVcard(list.contacts));
        await m.Sharing.shareAsync(uri, { mimeType: 'text/vcard', UTI: 'public.vcard', dialogTitle: t('Save a copy as a file (.vcf)') });
    } finally {
        await m.FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    }
}
