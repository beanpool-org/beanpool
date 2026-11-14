// @vitest-environment jsdom
/**
 * The phone's Contacts screen (app/contacts.tsx, DESIGN-private-contacts-fable.md §3.2, §3.6, §3.9, slice C2) rendered for
 * real over the real store (utils/contacts-store.ts, its lock and its file) on an in-memory disk and AsyncStorage. React
 * Native's host components are plain tags (as members-on-demand-screens-render.test.ts). The communities are never asked:
 * checkContactsHere and syncContacts are spies. Each check names the change that turns it red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mem = vi.hoisted(() => ({
    store: new Map<string, string>(),
    files: new Map<string, string>(),
    alerts: [] as Array<[string, string | undefined, Array<{ text: string; onPress?: () => void }> | undefined]>,
    shared: [] as Array<{ uri: string; options: any; text: string | undefined }>,
    blocked: [] as string[],
    pushed: [] as unknown[],
    reads: 0,
    // Android's hardware Back (BackHandler's listeners, newest first, as React Native asks them) and the route's options (iOS swipe-back).
    back: [] as Array<() => boolean>,
    options: [] as Array<Record<string, unknown>>,
}));
// The store loads Expo's file system, AsyncStorage and the share sheet with require() (utils/contacts-store.ts
// phoneContactsDeps, use-contacts.ts shareContactsFile), which vi.mock doesn't reach: Node's loader hands these out instead.
const fakes = vi.hoisted(() => {
    const fsFake = {
        documentDirectory: 'file:///docs/',
        cacheDirectory: 'file:///cache/',
        readAsStringAsync: async (u: string) => { mem.reads++; if (!mem.files.has(u)) throw new Error('no file'); return mem.files.get(u)!; },
        writeAsStringAsync: async (u: string, t: string) => { mem.files.set(u, t); },
        getInfoAsync: async (u: string) => ({ exists: mem.files.has(u) }),
        makeDirectoryAsync: async () => {},
        deleteAsync: async (u: string) => { mem.files.delete(u); },
        moveAsync: async ({ from, to }: { from: string; to: string }) => { mem.files.set(to, mem.files.get(from)!); mem.files.delete(from); },
    };
    const storage = { getItem: async (k: string) => mem.store.get(k) ?? null, setItem: async (k: string, v: string) => { mem.store.set(k, v); }, removeItem: async (k: string) => { mem.store.delete(k); } };
    const sharing = { shareAsync: async (uri: string, options: unknown) => { mem.shared.push({ uri, options, text: mem.files.get(uri) }); } };
    const Loader = (process as any).getBuiltinModule('node:module');
    const load = Loader._load;
    Loader._load = function (request: string, ...rest: unknown[]) {
        if (request === 'expo-file-system/legacy') return fsFake;
        if (request === '@react-native-async-storage/async-storage') return { default: storage, __esModule: true };
        if (request === 'expo-sharing') return sharing;
        return load.call(this, request, ...rest);
    };
    return { fsFake, storage, sharing };
});
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText, placeholder } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
        if (placeholder) attrs.placeholder = placeholder;
        return createElement(tag, attrs, children);
    };
    const node = (c: unknown): ReactNode => (typeof c === 'function' ? createElement(c as any) : (c as ReactNode));
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent }: Record<string, any>) =>
        createElement('div', null, node(ListHeaderComponent),
            (data ?? []).length ? (data as unknown[]).map((item, i) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, i) : String(i) }, renderItem({ item, index: i }))) : node(ListEmptyComponent),
            node(ListFooterComponent));
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), FlatList,
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: () => {} },
        BackHandler: {
            addEventListener: (_: string, fn: () => boolean) => {
                mem.back.unshift(fn);
                return { remove() { mem.back.splice(mem.back.indexOf(fn), 1); } };
            },
        },
    };
});
const NAV = vi.hoisted(() => ({ setOptions: (o: Record<string, unknown>) => { mem.options.push(o); } }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => mem.pushed.push(to), back: () => mem.pushed.push('back') },
    useNavigation: () => NAV,
    ErrorBoundary: () => null,
}));
vi.mock('react-native-safe-area-context', () => ({ SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('react-native-keyboard-controller', () => ({ KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children) }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: fakes.storage }));
vi.mock('expo-file-system/legacy', () => fakes.fsFake);
vi.mock('expo-sharing', () => fakes.sharing);
vi.mock('../keyboard-alert', () => ({ Alert: { alert: (...a: any[]) => { mem.alerts.push(a as any); } } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors, patternEnabled: false };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
const ME = vi.hoisted(() => ({ publicKey: '', privateKey: '' }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../db', () => ({ createConversationApi: vi.fn(async () => ({ id: 'conv-1' })) }));
vi.mock('../blocklist', () => ({ BLOCKLIST_UPDATED_EVENT: 'blocklist', getBlockedUsers: async () => mem.blocked, unblockUser: vi.fn(async () => true) }));
vi.mock('../use-communities', () => ({ switchCommunity: vi.fn(async () => {}) }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('../contacts-sync', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    checkContactsHere: vi.fn(async () => {}),
    syncContacts: vi.fn(async () => {}),
}));
const RIVERSIDE = 'https://riverside.example';
const RIVERBEND = 'https://riverbend.example';
vi.mock('../nodes', () => ({ getSavedNodes: async () => [{ url: 'https://riverside.example', alias: 'Riverside' }, { url: 'https://riverbend.example', alias: 'Riverbend' }] }));

import { newContactId, putContact, emptyContactsList, type ContactsList } from '@beanpool/core';
import ContactsScreen from '../../app/contacts';
import { changeContacts, emptySyncState, loadContacts, phoneContactsDeps } from '../contacts-store';
import { syncContacts } from '../contacts-sync';
import { switchCommunity } from '../use-communities';
import { contactsWhereWords, sweepContactsFile, useContactsRecord, type ContactsView } from '../use-contacts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const seed = ed25519.utils.randomSecretKey();
ME.publicKey = bytesToHex(ed25519.getPublicKey(seed));
ME.privateKey = bytesToHex(seed);
const FILE = `file:///docs/contacts/${ME.publicKey}.json`;
const SAM = 'a1'.repeat(32);
const ANA = 'b2'.repeat(32);
const BLOCKED = 'c3'.repeat(32);
const link = (key: string, community: string, callsign: string) => ({ key, community, callsign, how: 'profile' as const, at: '2026-11-12T01:00:00.000Z' });
const person = (name: string, more: Partial<{ phones: string[]; emails: string[]; note: string; links: ReturnType<typeof link>[] }> = {}) =>
    ({ id: newContactId(), name, phones: [], emails: [], note: '', links: [], invite: null, ...more });

let root: Root | null = null;
let host: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ContactsScreen) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const text = () => host.textContent ?? '';
const button = (label: string) => Array.from(host.querySelectorAll('button')).find((b) => b.textContent === label || b.getAttribute('aria-label') === label);
async function press(label: string) {
    const b = button(label);
    if (!b) throw new Error(`no button "${label}" in: ${text().slice(0, 400)}`);
    await act(async () => { b.click(); });
    await settle();
}
/** Android's Back key: React Native asks each listener, newest first, until one says it handled it; else the stack pops the route. */
async function pressBack() {
    let handled = false;
    await act(async () => { handled = mem.back.some((fn) => fn()); });
    if (!handled) mem.pushed.push('back');
    await settle();
}
/** Whether iOS's swipe from the edge may close the route now (the last gestureEnabled the screen set; on unless it turned it off). */
const swipeCloses = () => [...mem.options].reverse().find((o) => 'gestureEnabled' in o)?.gestureEnabled !== false;
async function answer(choice: string) {
    const alert = mem.alerts[mem.alerts.length - 1];
    const b = alert?.[2]?.find((x) => x.text === choice);
    if (!b) throw new Error(`no "${choice}" in the last alert: ${JSON.stringify(alert)}`);
    await act(async () => { b.onPress?.(); });
    await settle();
}
const seedList = (list: (l: ContactsList) => ContactsList) => changeContacts(ME, list, phoneContactsDeps());
const onPhone = async () => (await loadContacts(ME, phoneContactsDeps())).onPhone;

beforeEach(() => {
    mem.store.clear(); mem.files.clear(); mem.alerts.length = 0; mem.shared.length = 0; mem.blocked = []; mem.pushed.length = 0;
    mem.back.length = 0; mem.options.length = 0;
    mem.store.set('beanpool_anchor_url', RIVERSIDE);
    vi.mocked(syncContacts).mockClear();
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
});

describe('the Contacts screen (the web ContactsPage\'s words and order)', () => {
    it('On BeanPool first, then Not on BeanPool yet, each by name; Message here, Open <community> › elsewhere, Blocked + Unblock; the footer', async () => {
        mem.blocked = [BLOCKED];
        await seedList((l) => [
            person('Tom', { emails: ['tom@example.org'] }),
            person('Sam Jones', { links: [link(SAM, RIVERSIDE, 'sam_j')] }),
            person('Dee Walker', { phones: ['0412 345 678'] }),
            person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] }),
            person('Mal', { links: [link(BLOCKED, RIVERSIDE, 'mal')] }),
        ].reduce(putContact, l));
        await render();
        const t = text();
        expect(t).toContain("Private to you. Locked with your account's key.");
        const order = ['On BeanPool', 'Ana Li', 'Mal', 'Sam Jones', 'Not on BeanPool yet', 'Dee Walker', 'Tom'].map((s) => t.indexOf(s));
        expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
        expect(t).toContain('@sam_j · Riverside');
        expect(t).toContain('0412 345 678');
        expect(button('Message')).toBeDefined();
        expect(button('Open Riverbend ›')).toBeDefined();
        expect(t).toContain('Blocked');
        expect(button('Unblock')).toBeDefined();
        // The phone keeps only Riverside here (its anchor; nothing in its saved list): the change in its wait goes there.
        expect(host.querySelector('[data-testid="contacts-where"]')?.textContent).toBe('Kept on this phone. Your latest changes go to Riverside within 15 minutes.');
        // No Import yet: the phone can't import until slice C3.
        expect(button('Import')).toBeUndefined();
        // Mutation: one list sorted by name, no sections → Dee Walker before Sam Jones, and the order check fails.
    });

    it('Message opens the chat with that member; Open <community> › asks before switching', async () => {
        await seedList((l) => putContact(putContact(l, person('Sam Jones', { links: [link(SAM, RIVERSIDE, 'sam_j')] })), person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        await press('Message');
        expect(mem.pushed).toContain('/chat/conv-1');
        await press('Open Riverbend ›');
        expect(mem.alerts.at(-1)?.[1]).toBe('Ana Li is in Riverbend. Switch to Riverbend to message them?');
    });

    it('a switch that fails says so, in the Communities list\'s words, and never does nothing', async () => {
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        vi.mocked(switchCommunity).mockRejectedValueOnce(new Error(''));
        await press('Open Riverbend ›');
        await answer('Switch');
        expect(switchCommunity).toHaveBeenCalledWith(RIVERBEND);
        expect(mem.alerts.at(-1)?.slice(0, 2)).toEqual(["Couldn't switch community", 'Please try again.']);
        // Mutation: switchCommunity(...).catch(() => {}) → the tap does nothing, and the last alert is still the question.
    });

    it('Add by hand: nothing typed says what is needed; a name and a number are kept, locked, on the phone', async () => {
        await render();
        expect(text()).toContain('No contacts yet. Add someone by hand.');
        await press('＋ Add');
        await press('Add');
        expect(text()).toContain('Type a name, a number or an email.');
        const field = (label: string) => host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
        await act(async () => {
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
            set.call(field('Name'), 'Dee Walker'); field('Name').dispatchEvent(new Event('input', { bubbles: true }));
            set.call(field('Phone number'), '0412 345 678'); field('Phone number').dispatchEvent(new Event('input', { bubbles: true }));
        });
        await press('Add');
        const got = await onPhone();
        expect(got.kind === 'list' && got.list.contacts.map((c) => [c.name, c.phones])).toEqual([['Dee Walker', ['0412 345 678']]]);
        expect(mem.files.get(FILE)).not.toContain('Dee Walker');
        expect(text()).toContain('Not on BeanPool yet');
        // Mutation: onAdd without editContacts → the list on the phone stays empty.
    });

    it('Android\'s Back and iOS\'s swipe from "Add a contact" or a contact\'s page return to the list, as the arrow does; from the list they leave', async () => {
        await seedList((l) => putContact(l, person('Dee Walker', { phones: ['0412 345 678'] })));
        await render();
        await press('＋ Add');
        expect(text()).toContain('Phone number');
        expect(swipeCloses()).toBe(false);
        await pressBack();
        expect(mem.pushed).toEqual([]);
        expect(text()).toContain('Not on BeanPool yet');
        expect(swipeCloses()).toBe(true);
        await press('Dee Walker0412 345 678');
        expect(host.querySelector('[data-testid="contact-detail"]')).not.toBeNull();
        expect(swipeCloses()).toBe(false);
        await pressBack();
        expect(mem.pushed).toEqual([]);
        expect(host.querySelector('[data-testid="contact-detail"]')).toBeNull();
        expect(text()).toContain('Dee Walker');
        // On the list nothing holds Back: it leaves Contacts, as any screen does.
        await pressBack();
        expect(mem.pushed).toEqual(['back']);
        // Mutation: drop the BackHandler listener → Back from Add pops the whole route ('back') and what was typed is lost.
        // Mutation: drop setOptions({ gestureEnabled }) → swipeCloses() stays true on Add, and an edge swipe closes Contacts.
    });

    it('a contact: Remove asks first, in the design\'s words, then the contact is gone from the phone', async () => {
        await seedList((l) => putContact(l, person('Dee Walker', { phones: ['0412 345 678'], note: 'Seedlings' })));
        await render();
        await press('Dee Walker0412 345 678');
        expect(text()).toContain('Seedlings');
        await press('Remove from contacts');
        expect(mem.alerts.at(-1)?.[1]).toBe('Remove Dee Walker from your contacts? Nobody is told. Your chats, and your friendship in Riverside if you have one, stay as they are.');
        await answer('Remove');
        const got = await onPhone();
        expect(got.kind === 'list' && got.list.contacts).toEqual([]);
        // Mutation: remove without asking → no alert, and the first expectation on the alert fails.
    });

    it('⋯ Remove everyone asks, offering Save a file first, and leaves nobody on the phone', async () => {
        await seedList((l) => putContact(putContact(l, person('Dee Walker')), person('Tom')));
        await render();
        await press('More');
        await press('Remove everyone');
        const asked = mem.alerts.at(-1)!;
        expect(asked[1]).toBe("Remove all 2 contacts from every device and every community's copy? You can't undo this. Save a copy as a file first if you might want them.");
        expect(asked[2]?.map((b) => b.text)).toEqual(['Save a file', 'Cancel', 'Remove everyone']);
        await answer('Remove everyone');
        const got = await onPhone();
        expect(got.kind === 'list' && got.list.contacts.length).toBe(0);
        expect(got.kind === 'list' && got.list.removed.length).toBe(2);
    });

    it('Save a copy as a file: warned it isn\'t locked; a vCard goes to the share sheet and never stays in the app\'s cache', async () => {
        await seedList((l) => putContact(l, person('Dee Walker', { phones: ['0412 345 678'], emails: ['dee@example.org'] })));
        await render();
        await press('More');
        await press('Save a copy as a file (.vcf)');
        expect(mem.alerts.at(-1)?.[1]).toBe('This file is not locked. Anyone who has it can read it. Keep it somewhere safe.');
        await answer('Save');
        await settle();
        expect(mem.shared).toHaveLength(1);
        expect(mem.shared[0].options.mimeType).toBe('text/vcard');
        expect(mem.shared[0].text).toMatch(/BEGIN:VCARD[\s\S]*Dee Walker[\s\S]*0412 345 678[\s\S]*END:VCARD/);
        expect(mem.files.has(mem.shared[0].uri)).toBe(false);
        // Mutation: drop the delete in shareContactsFile's finally → the unlocked file stays in the cache.
    });

    it('a contacts file left in the cache (the app ended while the share sheet was open) is removed at the next start', async () => {
        mem.files.set('file:///cache/contacts.vcf', 'BEGIN:VCARD\nFN:Dee Walker\nEND:VCARD');
        mem.files.set('file:///cache/other.txt', 'kept');
        await sweepContactsFile();
        expect(mem.files.has('file:///cache/contacts.vcf')).toBe(false);
        expect(mem.files.get('file:///cache/other.txt')).toBe('kept');
        // Nothing there: nothing to remove, and it never throws.
        await expect(sweepContactsFile()).resolves.toBeUndefined();
        await expect(sweepContactsFile({ cacheDirectory: null, deleteAsync: async () => { throw new Error('no'); } })).resolves.toBeUndefined();
        // The app's start runs it, beside the recovery kit's sweep.
        expect(readFileSync(join(__dirname, '../../app/_layout.tsx'), 'utf8')).toMatch(/sweepPrintedPdfs\(\);\s*void import\('\.\.\/utils\/use-contacts'\)\.then\(\(m\) => m\.sweepContactsFile\(\)\)/);
        // Mutation: drop the call in _layout.tsx → the file a killed share left stays in the cache, unlocked, until the next Save.
    });

    it('a list on this phone that can\'t be opened says so; Set it aside moves it aside, as it is, and asks the communities', async () => {
        await seedList((l) => putContact(l, person('Dee Walker')));
        mem.files.set(FILE, '{"broken":');
        await render();
        expect(text()).toContain("The contacts list on this phone can't be opened.");
        await press('Set it aside');
        expect(mem.files.get(`${FILE}.damaged`)).toBe('{"broken":');
        expect(mem.files.has(FILE)).toBe(false);
        expect(syncContacts).toHaveBeenCalledTimes(1);
        expect(text()).toContain('No contacts yet. Add someone by hand.');
        // Mutation: no Set it aside → the screen is a dead end, as PR #3073's review found.
    });

    it('the ⓘ: the five lines, with the true sentence about encryption and never "all messages"', async () => {
        await render();
        await press('About your private contacts');
        const sheet = host.querySelector('[data-testid="contacts-info"]')?.textContent ?? '';
        expect(sheet).toContain('Your private contacts');
        expect(sheet).toContain("Chats between two people and group chats are end-to-end encrypted, always: there is nothing to turn on. Event chats and enterprise chats are not: the community's server can read those.");
        expect(sheet).not.toMatch(/all messages|everything is encrypted|by default/i);
    });
});

describe('the Chat tab', () => {
    it('reads only the record beside the list (a list kept, "Your contacts are back"), never the list itself', async () => {
        await seedList((l) => putContact(l, person('Dee Walker')));
        mem.reads = 0;
        const seen: Array<ReturnType<typeof useContactsRecord>> = [];
        function Probe() { seen.push(useContactsRecord(ME)); return null; }
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        await act(async () => { root!.render(createElement(Probe) as unknown as Parameters<Root['render']>[0]); });
        await settle();
        expect(seen.at(-1)?.fileSeq).toBeGreaterThan(0);
        expect(mem.reads).toBe(0);
        // Mutation: read it through loadContacts → the list's file is read (and unlocked: most of a second at 2,000 on API 26).
    });
});

describe('the footer: where the list is kept (design §3.6)', () => {
    const view = (over: Partial<ContactsView['state']>, communities = [RIVERSIDE, RIVERBEND]): ContactsView => {
        const list = putContact(emptyContactsList(), person('Dee'));
        return {
            onPhone: { kind: 'list', list, seq: 3, copy: {} as any },
            state: { ...emptySyncState(), fileSeq: 3, ...over },
            anchor: RIVERSIDE, communities, names: { [RIVERSIDE]: 'Riverside', [RIVERBEND]: 'Riverbend' },
        };
    };
    const now = 1_800_000_000_000;
    it('names the communities holding exactly this copy, and when it was saved', () => {
        expect(contactsWhereWords(view({ heard: { [RIVERSIDE]: 3, [RIVERBEND]: 2 }, merged: { [RIVERSIDE]: 3, [RIVERBEND]: 2 }, savedAt: now - 5 * 60_000 }), now))
            .toMatch(/^Kept on this phone and at: Riverside · saved 5 min/);
    });
    it('a change in its wait: where it goes within 15 minutes', () => {
        expect(contactsWhereWords(view({ dueAt: now + 60_000 }), now)).toBe('Kept on this phone. Your latest changes go to Riverside, Riverbend within 15 minutes.');
    });
    it('none holds it and none refused: BeanPool tries again', () => {
        expect(contactsWhereWords(view({ dueAt: now - 1 }), now)).toBe('Kept on this phone only. BeanPool will try your communities again.');
    });
    it('every community keeps no lists: a file is the way to keep it safe, and each is named', () => {
        const off = { code: 'contacts_off' as const, until: now + 1 };
        expect(contactsWhereWords(view({ refused: { [RIVERSIDE]: off, [RIVERBEND]: off } }), now))
            .toBe("Kept on this phone only. Save a copy as a file to keep it safe. Riverside doesn't keep contact lists. Riverbend doesn't keep contact lists.");
        // Mutation: count a refused community as one that may take it → "will try again", a promise nothing keeps.
    });
});
