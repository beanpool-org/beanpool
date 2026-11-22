// @vitest-environment jsdom
/**
 * The phone's Contacts screen (app/contacts.tsx, DESIGN-private-contacts-fable.md §3.2, §3.6, §3.9, slice C2) rendered for
 * real over the real store (utils/contacts-store.ts, its lock and its file) on an in-memory disk and AsyncStorage. React
 * Native's host components are plain tags (as members-on-demand-screens-render.test.ts). The communities are never asked:
 * checkContactsHere and syncContacts are spies. Each check names the change that turns it red.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mem = vi.hoisted(() => ({
    // After a re-key (slice C6): whether the community in use keeps an old list (and whether this phone merged it), the old
    // copies "Delete it" removed, what the next Delete answers, and the people this phone has chats of two with, and friends.
    former: false as false | 'open' | 'merged',
    formerDeleted: 0,
    deleteAnswer: { here: true, complete: true },
    chats: [] as Array<{ publicKey: string; callsign: string }>,
    friends: [] as Array<{ publicKey: string; callsign: string }>,
    // DeviceEventEmitter's listeners, by event (the old-words screen tells Contacts it tried the old list).
    events: new Map<string, Set<() => void>>(),
    store: new Map<string, string>(),
    files: new Map<string, string>(),
    alerts: [] as Array<[string, string | undefined, Array<{ text: string; onPress?: () => void }> | undefined]>,
    shared: [] as Array<{ uri: string; options: any; text: string | undefined }>,
    blocked: [] as string[],
    pushed: [] as unknown[],
    reads: 0,
    // Android's hardware Back (BackHandler's listeners, newest first, as React Native asks them) and the route's options (iOS swipe-back).
    back: [] as Array<() => boolean>,
    focused: true,
    options: [] as Array<Record<string, unknown>>,
    // Import (slice C3): the route's params, the native parts this build carries, the phone's contacts question and its
    // answer, the address book, the file the picker hands back, and Settings opened.
    params: {} as Record<string, string>,
    native: { ExpoContacts: true, ExpoDocumentPicker: true } as Record<string, boolean>,
    asked: 0,
    answer: { granted: true, canAskAgain: true } as { granted: boolean; canAskAgain: boolean },
    book: [] as Array<{ name?: string; phoneNumbers?: { number: string }[]; emails?: { email: string }[] }>,
    queries: [] as Array<{ fields: readonly string[] }>,
    picked: null as null | { uri: string; size: number; text: string },
    settings: 0,
    // Message anyone (S5 part 2, utils/message-anyone.ts): the chats this phone has (here, in a held community, across, by
    // file), the across context, the community's switch, the cards an across chat was made from, and a block across.
    // As db.ts getConversations RETURNS them (its type, utils/message-anyone.ts HereChat), never its SQL row (#3354 review).
    chatsHere: [] as import('../message-anyone').HereChat[],
    heldDirect: {} as Record<string, any[]>,
    acrossHere: [] as any[],
    heldAcross: {} as Record<string, any[]>,
    noAcrossContext: false,
    outsideOn: true,
    acrossBlocked: false,
    cards: [] as Array<{ key: string; home: string; name: string | null }>,
    // The block lists Message asks first (#3354 review; blocklist.ts readBlockLists): blocked on this phone is `blocked`;
    // these are a held community's own list as last read, and blocked once and unblocked since. Unreadable: null.
    seenThere: [] as string[],
    once: [] as string[],
    listsUnreadable: false,
    // The held handles closed again (db.ts closeHeldCopies), #3302 review F3.
    closes: 0,
    // What the community in use says of its addresses, asked now (#3354 review round 4); and each other one, by its address.
    saysNow: {} as { addresses?: string[]; primaryAddress?: string; formerAddresses?: string[]; formerExcludesLost?: true; noHome?: true },
    saysThere: {} as Record<string, { addresses?: string[]; primaryAddress?: string; formerAddresses?: string[] }>,
    // A held community's answer to the membership probe: status and body. Not said: the account is a member there.
    standing: {} as Record<string, [number, unknown]>,
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
        if (request === 'expo-modules-core') return { requireOptionalNativeModule: (name: string) => (mem.native[name] ? {} : null) };
        if (request === 'expo-contacts') {
            return {
                requestPermissionsAsync: async () => { mem.asked++; return { ...mem.answer, status: mem.answer.granted ? 'granted' : 'denied' }; },
                getContactsAsync: async (q: { fields: readonly string[]; pageSize: number; pageOffset: number }) => {
                    mem.queries.push(q);
                    return { data: mem.book.slice(q.pageOffset, q.pageOffset + q.pageSize), hasNextPage: q.pageOffset + q.pageSize < mem.book.length };
                },
            };
        }
        if (request === 'expo-document-picker') {
            return {
                getDocumentAsync: async () => {
                    if (!mem.picked) return { canceled: true, assets: null };
                    mem.files.set(mem.picked.uri, mem.picked.text);
                    return { canceled: false, assets: [{ uri: mem.picked.uri, size: mem.picked.size }] };
                },
            };
        }
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
        ActivityIndicator: el('span'), Linking: { openSettings: async () => { mem.settings++; } },
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        DeviceEventEmitter: {
            addListener: (name: string, fn: () => void) => {
                const set = mem.events.get(name) ?? new Set<() => void>();
                set.add(fn);
                mem.events.set(name, set);
                return { remove() { set.delete(fn); } };
            },
            emit: (name: string) => { for (const fn of [...(mem.events.get(name) ?? [])]) fn(); },
        },
        BackHandler: {
            addEventListener: (_: string, fn: () => boolean) => {
                mem.back.unshift(fn);
                return { remove() { mem.back.splice(mem.back.indexOf(fn), 1); } };
            },
        },
    };
});
const NAV = vi.hoisted(() => ({ setOptions: (o: Record<string, unknown>) => { mem.options.push(o); }, isFocused: () => mem.focused }));
vi.mock('expo-router', () => ({
    router: { push: (to: unknown) => mem.pushed.push(to), back: () => mem.pushed.push('back') },
    useNavigation: () => NAV,
    useLocalSearchParams: () => mem.params,
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
/** Each hold of a chat in place Contacts takes and lets go (db.ts enterChatInPlace, leaveChatInPlace; #3305 review), in order. */
const holds = vi.hoisted(() => ({ log: [] as string[] }));
vi.mock('../db', () => ({
    createConversationApi: vi.fn(async (...args: unknown[]) => { holds.log.push(`start ${String(args[5] ?? '')}`); return { id: 'conv-1' }; }),
    getChattedWithMembers: async () => mem.chats,
    getFriendsLocal: async () => mem.friends,
    // db.ts's refusal of a chat in place with no copy of that community to open (slice S2): tagged here as `noCopy`.
    isNoCopyInPlace: (e: unknown) => !!(e as { noCopy?: boolean } | null)?.noCopy,
    enterChatInPlace: (community: string) => { holds.log.push(`enter ${community}`); },
    leaveChatInPlace: async (community: string) => { holds.log.push(`leave ${community}`); },
    // The chats Message weighs (utils/message-anyone.ts knownChatsWith).
    getConversations: async () => mem.chatsHere,
    getHeldConversations: async (_me: string, community: string) => mem.heldDirect[community] ?? [],
    getHeldOutsideChats: async (_me: string, community: string) => mem.heldAcross[community] ?? [],
    closeHeldCopies: async () => { mem.closes++; },
}));
vi.mock('../outside-chat-live', () => ({
    outsideContext: async () => (mem.noAcrossContext ? null : {
        nodeUrl: 'https://riverside.example', identity: ME, store: { chats: async () => mem.acrossHere }, isBlocked: async (k: string) => mem.blocked.includes(k),
    }),
    outsideMessagesHere: async () => mem.outsideOn,
    // What a community answers now (#3354 review round 4): its switch, and its addresses.
    answerNow: async (at: string) => (at === 'https://riverside.example' || mem.saysThere[at]
        ? (await import('../node-profile')).readNodeProfile({ profile: 'local', features: { outsideMessages: mem.outsideOn }, ...(mem.saysThere[at] ?? mem.saysNow) }) : null),
}));
// How the account stands in a held community Message would go to (utils/message-anyone.ts standingNow).
vi.mock('../membership-probe', () => ({
    fetchMembership: async (community: string) => {
        const [status, body] = mem.standing[community] ?? [200, { isMember: true, callsign: 'me' }];
        return new Response(JSON.stringify(body), { status });
    },
}));
// The real outside-mail.ts loads for its chatsShown: its signing (utils/crypto.ts) needs expo-crypto, never asked here.
vi.mock('expo-crypto', async () => ({ randomUUID: (await import('node:crypto')).randomUUID, getRandomBytes: (n: number) => new Uint8Array(n) }));
vi.mock('../outside-mail', async (importOriginal) => ({
    // What Chat lists of the across chats here: the real one (#3354 review: Message reads only what the list shows).
    chatsShown: (await importOriginal<typeof import('../outside-mail')>()).chatsShown,
    openChatFromCard: async (_ctx: unknown, card: { key: string; home: string; name: string | null }) => {
        if (mem.acrossBlocked) return null;
        mem.cards.push(card);
        return `across-${card.key.slice(0, 4)}`;
    },
}));
/** What db.ts throws when that community's copy can't be opened in place (not on the phone yet, a move or a delete under way). */
const NO_COPY_IN_PLACE = Object.assign(new Error('This phone has switched community since this chat was opened.'), { noCopy: true });
// The old copy's requests (utils/contacts-former.ts, its own suite contacts-former.test.ts): no network here.
vi.mock('../contacts-former', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    formerNoticeHere: vi.fn(async () => (mem.former ? { community: 'https://riverside.example', merged: mem.former === 'merged' } : null)),
    deleteFormerCopies: vi.fn(async () => {
        mem.formerDeleted++;
        if (mem.deleteAnswer.here) mem.former = false;
        return { deleted: mem.deleteAnswer.here ? 1 : 0, ...mem.deleteAnswer };
    }),
}));
vi.mock('../blocklist', () => ({
    BLOCKLIST_UPDATED_EVENT: 'blocklist', getBlockedUsers: async () => mem.blocked, unblockUser: vi.fn(async () => true),
    isUserBlocked: async (k: string) => mem.blocked.includes(k),
    // "Add people I've chatted with" leaves out anyone blocked (slice S7b; its own table is let-in-once's, on the real lists).
    withoutBlockedPeople: async (_me: string, people: Array<{ key: string }>) => people.filter((p) => !mem.blocked.includes(p.key)),
    // Message's block rule (#3354 review): the lists as blocklist.ts reads them, judged by the real rule (block-rules.ts blockedAnywhere).
    readBlockLists: async () => (mem.listsUnreadable ? null : { onPhone: new Set(mem.blocked), once: new Set(mem.once), seenThere: new Set(mem.seenThere) }),
}));
vi.mock('../use-communities', () => ({ switchCommunity: vi.fn(async () => {}), communitySwitchUnderWay: () => false }));
// The root layout's recognition, asked again before a move (Message on a contact in a held community: S0).
vi.mock('../../app/NodeStatusContext', () => ({ useNodeStatus: () => ({ recheck: async () => 'member' }) }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('../contacts-sync', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    checkContactsHere: vi.fn(async () => {}),
    syncContacts: vi.fn(async () => {}),
}));
const RIVERSIDE = 'https://riverside.example';
const RIVERBEND = 'https://riverbend.example';
vi.mock('../nodes', () => ({
    getSavedNodes: async () => [{ url: 'https://riverside.example', alias: 'Riverside' }, { url: 'https://riverbend.example', alias: 'Riverbend' }],
    // What held-chats.ts reads to list another community's chats (Message reads through it: #3354 review).
    getDatabaseFilenameForNode: (url: string | null) => `beanpool_${String(url ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')}.db`,
    isGuestNode: async (url: string) => (JSON.parse(mem.store.get('beanpool_guest_nodes') ?? '[]') as string[]).includes(url),
    isGuestCopy: async (url: string) => (JSON.parse(mem.store.get('beanpool_guest_nodes') ?? '[]') as string[]).includes(url),
}));

import { newContactId, nodeHomeOf, putContact, removeEveryContact, emptyContactsList, type ContactsList } from '@beanpool/core';
import ContactsScreen from '../../app/contacts';
import type { HereChat } from '../message-anyone';
import { readNodeProfile } from '../node-profile';
import { makeCommunityRecord, resetCommunityIndexForTests, setCommunityIndex } from '../community-index';
import { changeContacts, emptySyncState, loadContacts, phoneContactsDeps } from '../contacts-store';
import { syncContacts } from '../contacts-sync';
import { switchCommunity } from '../use-communities';
import { contactsWhereWords, sweepContactsFile, useContactsRecord, type ContactsView } from '../use-contacts';
import { CONTACTS_FORMER_CHANGED_EVENT } from '../contacts-former';
import { DeviceEventEmitter } from 'react-native';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const seed = ed25519.utils.randomSecretKey();
ME.publicKey = bytesToHex(ed25519.getPublicKey(seed));
ME.privateKey = bytesToHex(seed);
const FILE = `file:///docs/contacts/${ME.publicKey}.json`;
const SAM = 'a1'.repeat(32);
const ANA = 'b2'.repeat(32);
const BLOCKED = 'c3'.repeat(32);
// Ana's key in Riverside, beside ANA in Riverbend (a contact keeps one link a key: S5 part 2's path rows).
const ANA_HERE = 'd4'.repeat(32);
/** A community this phone shares none with. */
const FARAWAY = 'https://faraway.example';
/** A direct chat here as db.ts getConversations returns it (typed by it: a renamed field is a type error here and a red row). */
const hereDm = (id: string, key: string): HereChat => ({ id, type: 'dm', peerPubkey: key, peerKeys: [key] });
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

// Message's readers load on first use (utils/message-anyone.ts imports them lazily): loaded once here, so no row's settle()
// is spent loading them and a first tap never lands in the next row.
beforeAll(async () => {
    await Promise.all([import('../held-chats'), import('../outside-mail'), import('../block-rules'), import('../dm-blocked'), import('../outside-chat-live'), import('../membership-probe')]);
});
beforeEach(() => {
    mem.former = false; mem.formerDeleted = 0; mem.deleteAnswer = { here: true, complete: true }; mem.chats = []; mem.friends = []; mem.events.clear();
    mem.store.clear(); mem.files.clear(); mem.alerts.length = 0; mem.shared.length = 0; mem.blocked = []; mem.pushed.length = 0;
    mem.back.length = 0; mem.options.length = 0; mem.focused = true;
    mem.params = {}; mem.native = { ExpoContacts: true, ExpoDocumentPicker: true }; mem.asked = 0; mem.answer = { granted: true, canAskAgain: true };
    mem.book = []; mem.queries.length = 0; mem.picked = null; mem.settings = 0;
    mem.chatsHere = []; mem.heldDirect = {}; mem.acrossHere = []; mem.heldAcross = {}; mem.noAcrossContext = false; mem.outsideOn = true;
    mem.acrossBlocked = false; mem.cards = [];
    mem.seenThere = []; mem.once = []; mem.listsUnreadable = false; mem.closes = 0; mem.saysNow = {}; mem.saysThere = {}; mem.standing = {};
    resetCommunityIndexForTests();
    mem.store.set('beanpool_anchor_url', RIVERSIDE);
    vi.mocked(syncContacts).mockClear();
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
});

describe('the Contacts screen (the web ContactsPage\'s words and order)', () => {
    it('On BeanPool first, then Not on BeanPool yet, each by name; Message here and elsewhere (S5 part 2: no Open <community> ›), Blocked + Unblock; the footer', async () => {
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
        // Riverbend is not held here (nothing saved but the anchor): Message too, which goes across (S5 part 2).
        expect(Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'Message')).toHaveLength(2);
        expect(button('Open Riverbend ›')).toBeUndefined();
        expect(t).toContain('Blocked');
        expect(button('Unblock')).toBeDefined();
        // The phone keeps only Riverside here (its anchor; nothing in its saved list): the change in its wait goes there.
        expect(host.querySelector('[data-testid="contacts-where"]')?.textContent).toBe('Kept on this phone. Your latest changes go to Riverside within 15 minutes.');
        // Import beside Add, as the web's (slice C3; C2 pinned it absent until then).
        expect(button('Import')).toBeDefined();
        // Mutation: one list sorted by name, no sections → Dee Walker before Sam Jones, and the order check fails.
    });

    it('Message here opens the chat; Message on someone in a community the phone shares none with opens a chat across from their link, with no question and no switch (S5 part 2)', async () => {
        await seedList((l) => putContact(l, person('Sam Jones', { links: [link(SAM, RIVERSIDE, 'sam_j')] })));
        await render();
        await press('Message');
        expect(mem.pushed).toContain('/chat/conv-1');
        await act(async () => { root?.unmount(); });
        host.remove();
        await seedList((l) => putContact(removeEveryContact(l), person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        mem.pushed.length = 0;
        vi.mocked(switchCommunity).mockClear();
        await render();
        await press('Message');
        expect(mem.cards).toEqual([{ key: ANA, home: nodeHomeOf(RIVERBEND), name: 'Ana Li' }]);
        expect(mem.pushed).toEqual([`/outside-chat/across-${ANA.slice(0, 4)}`]);
        expect(mem.alerts).toEqual([]);
        expect(switchCommunity).not.toHaveBeenCalled();
        // Mutation: the switch question kept for a community the phone doesn't hold -> an alert, no card, nothing pushed.
    });

    it.each([
        { name: 'this community takes no messages from other communities', set: () => { mem.outsideOn = false; }, says: "This community doesn't take messages from other communities." },
        { name: 'this community knows no address of its own to send from (round 5)', set: () => { mem.saysNow = { noHome: true }; }, says: "This community's server knows none of its own names yet, so it can't send to another community." },
        { name: 'someone the account blocked', set: () => { mem.acrossBlocked = true; }, says: 'You have blocked this user. Messaging is disabled.' },
        { name: 'no community in use', set: () => { mem.noAcrossContext = true; }, says: 'Connect to your community to start a chat.' },
    ])('across refused ($name): says why, makes nothing, moves nowhere', async ({ set, says }) => {
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        set();
        await press('Message');
        expect(mem.alerts.at(-1)?.[1]).toBe(says);
        expect(mem.cards).toEqual([]);
        expect(mem.pushed).toEqual([]);
        expect(switchCommunity).not.toHaveBeenCalled();
    });

    it('a contact in another community this phone holds: Message starts the chat there and opens it in place, with no question and no switch (S2, Marty 19 Nov 2026)', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: `${RIVERBEND}/` }]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        vi.mocked(switchCommunity).mockClear();
        const { createConversationApi } = await import('../db');
        vi.mocked(createConversationApi).mockClear();
        holds.log.length = 0;
        expect(button('Open Riverbend ›')).toBeUndefined();
        await press('Message');
        expect(mem.alerts).toEqual([]);
        expect(switchCommunity).not.toHaveBeenCalled();
        // Started in Riverbend by the address its saved list gives (this file's nodes stand-in), and opened there in place.
        expect(vi.mocked(createConversationApi).mock.calls).toEqual([['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]]);
        expect(mem.pushed).toEqual([{ pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } }]);
        // Held in place while it starts there, and let go once (#3305 review): a chat of Riverbend left a moment ago doesn't
        // refuse it, and the chat it opens holds the copy from its own focus.
        expect(holds.log).toEqual([`enter ${RIVERBEND}`, `start ${RIVERBEND}`, `leave ${RIVERBEND}`]);
        // Mutation: the S0 move kept for held communities -> switchCommunity is called and nothing is pushed.
    });

    it('a contact whose link spells that community otherwise (a trailing slash): the chat starts and opens there by the address the phone saved (#3305 review F3, C3)', async () => {
        const SPELT = `${RIVERBEND}/`;
        // Contacts knows Riverbend as held (its saved list in storage); the nodes stand-in saved it with no slash.
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: SPELT }]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, SPELT, 'ana')] })));
        await render();
        const { createConversationApi } = await import('../db');
        vi.mocked(createConversationApi).mockClear();
        holds.log.length = 0;
        await press('Message');
        // Held, started and opened by the saved address (this file's nodes stand-in: https://riverbend.example), never the link's.
        expect(holds.log).toEqual([`enter ${RIVERBEND}`, `start ${RIVERBEND}`, `leave ${RIVERBEND}`]);
        expect(vi.mocked(createConversationApi).mock.calls.map((c) => c[5])).toEqual([RIVERBEND]);
        expect((mem.pushed.at(-1) as any)?.params?.community).toBe(RIVERBEND);
        // Mutation (C3): messageThere using the contact's own spelling -> every entry above reads https://riverbend.example/.
    });

    it('that community\'s copy can\'t be opened in place (not on the phone yet): Message moves there with no question, and the chat opens where it lands (S0, Marty 19 Nov 2026)', async () => {
        // The phone holds Riverbend too (saved, and not a guest's look), under a spelling with a slash.
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: `${RIVERBEND}/` }]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        vi.mocked(switchCommunity).mockClear();
        const { createConversationApi } = await import('../db');
        vi.mocked(createConversationApi).mockClear();
        vi.mocked(createConversationApi).mockRejectedValueOnce(NO_COPY_IN_PLACE);
        holds.log.length = 0;
        await press('Message');
        // The try in place held Riverbend and let it go before the move (#3305 review): no hold is left behind.
        expect(holds.log).toEqual([`enter ${RIVERBEND}`, `leave ${RIVERBEND}`]);
        // No question: the one switch, to the address the phone saved, and no chat started anywhere but the one try in place.
        expect(mem.alerts).toEqual([]);
        expect(vi.mocked(switchCommunity).mock.calls.map((c) => c[0])).toEqual([`${RIVERBEND}/`]);
        expect(vi.mocked(createConversationApi).mock.calls).toEqual([['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]]);
        vi.mocked(createConversationApi).mockClear();
        // The phone is in Riverbend now, and Contacts opens over the tabs where the guard lands, naming Ana: her chat opens, once.
        mem.store.set('beanpool_anchor_url', RIVERBEND);
        mem.params = { message: ANA };
        await act(async () => { root?.unmount(); });
        host.remove();
        await render();
        expect(vi.mocked(createConversationApi).mock.calls).toEqual([['dm', [ME.publicKey, ANA], ME.publicKey]]);
        expect(mem.pushed).toContain('/chat/conv-1');
        await act(async () => { root?.unmount(); });
        host.remove();
        await render();
        expect(createConversationApi).toHaveBeenCalledTimes(1);
        // Mutation: the Alert kept for held communities → mem.alerts has the question and nothing moves.
    });

    it('a contact the member blocked in the community the phone lands in: no chat opens; their row says Blocked there (S0)', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        const { createConversationApi } = await import('../db');
        vi.mocked(createConversationApi).mockRejectedValueOnce(NO_COPY_IN_PLACE);
        await press('Message');
        vi.mocked(createConversationApi).mockClear();
        mem.store.set('beanpool_anchor_url', RIVERBEND);
        mem.params = { message: ANA };
        mem.blocked = [ANA];
        await act(async () => { root?.unmount(); });
        host.remove();
        await render();
        expect(createConversationApi).not.toHaveBeenCalled();
        expect(text()).toContain('Blocked');
    });

    it('Contacts opened by hand in that community, while a move\'s person waits, opens no chat: only the landing names them (S0)', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        const { createConversationApi } = await import('../db');
        vi.mocked(createConversationApi).mockRejectedValueOnce(NO_COPY_IN_PLACE);
        await press('Message');
        vi.mocked(createConversationApi).mockClear();
        // The guard held the member elsewhere (no landing), and they open Contacts themselves: no `message` named.
        mem.store.set('beanpool_anchor_url', RIVERBEND);
        await act(async () => { root?.unmount(); });
        host.remove();
        await render();
        expect(createConversationApi).not.toHaveBeenCalled();
    });

    it('a community the phone only looks at as a guest is not held: Message goes across, with no question (S5 part 2)', async () => {
        mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        mem.store.set('beanpool_guest_nodes', JSON.stringify([RIVERBEND]));
        await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
        await render();
        await press('Message');
        expect(mem.alerts).toEqual([]);
        expect(mem.cards.map((c) => c.key)).toEqual([ANA]);
        expect(mem.pushed).toEqual([`/outside-chat/across-${ANA.slice(0, 4)}`]);
    });

    /**
     * Which chat Message opens (S5 part 2, core messagePathFor through utils/message-anyone.ts), drawn on the real screen: an
     * existing chat wins (here, then in a held community in place, then across), else the community shared (here, then
     * held, in place), else across. Each row is red without its rule (core's own table names the mutants).
     */
    describe('the path table: which chat Message opens', () => {
        const HELD = () => mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        const ROWS: Array<{ name: string; links: Array<ReturnType<typeof link>>; set: () => void; pushed: unknown; started?: unknown[] }> = [
            { name: 'existing direct chat here, though they are in a held community too', links: [link(ANA, RIVERBEND, 'ana'), link(ANA, RIVERSIDE, 'ana')],
                set: () => { HELD(); mem.chatsHere = [hereDm('d-here', ANA)]; mem.heldDirect[RIVERBEND] = [{ id: 'd-held', type: 'dm', peerPubkey: ANA, peerKeys: [ANA] }]; },
                pushed: '/chat/d-here', started: [] },
            { name: 'existing direct chat in a held community: opened in place', links: [link(ANA, RIVERSIDE, 'ana')],
                set: () => { HELD(); mem.heldDirect[RIVERBEND] = [{ id: 'd-held', type: 'dm', peerPubkey: ANA, peerKeys: [ANA] }]; },
                pushed: { pathname: '/chat/[id]', params: { id: 'd-held', community: RIVERBEND, communityName: 'Riverbend' } }, started: [] },
            { name: 'a held group chat is no direct chat: the shared community instead', links: [link(ANA, RIVERSIDE, 'ana')],
                set: () => { HELD(); mem.heldDirect[RIVERBEND] = [{ id: 'g-held', type: 'group', peerPubkey: ANA, peerKeys: [ANA] }]; },
                pushed: '/chat/conv-1', started: [['dm', [ME.publicKey, ANA], ME.publicKey]] },
            { name: 'existing chat across, though they share this community', links: [link(ANA, RIVERSIDE, 'ana')],
                set: () => { mem.acrossHere = [{ id: 'x-here', peerKey: ANA, state: 'open' }]; },
                pushed: '/outside-chat/x-here', started: [] },
            { name: 'existing chat across kept in a held community\'s file', links: [link(ANA, 'https://faraway.example', 'ana')],
                set: () => { HELD(); mem.heldAcross[RIVERBEND] = [{ id: 'x-held', peerKey: ANA, state: 'open' }]; },
                pushed: `/outside-chat/x-held?community=${encodeURIComponent(RIVERBEND)}`, started: [] },
            { name: 'no chat: the community in use first', links: [link(ANA, RIVERBEND, 'ana'), link(ANA_HERE, RIVERSIDE, 'ana')],
                set: () => { HELD(); },
                pushed: '/chat/conv-1', started: [['dm', [ME.publicKey, ANA_HERE], ME.publicKey]] },
            { name: 'no chat: a held community, in place', links: [link(ANA, RIVERBEND, 'ana')],
                set: () => { HELD(); },
                pushed: { pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } }, started: [['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]] },
            { name: 'no chat, no community shared: across', links: [link(ANA, 'https://faraway.example', 'ana')],
                set: () => { HELD(); },
                pushed: `/outside-chat/across-${ANA.slice(0, 4)}`, started: [] },
        ];
        it.each(ROWS)('$name', async ({ links, set, pushed, started }) => {
            set();
            await seedList((l) => putContact(l, person('Ana Li', { links })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            mem.pushed.length = 0;
            await press('Message');
            expect(mem.pushed).toEqual([pushed]);
            expect(vi.mocked(createConversationApi).mock.calls).toEqual(started);
            expect(mem.alerts).toEqual([]);
        });

        it('the held copies Message read are closed again as it ends (#3302 review F3: Chat is not in view)', async () => {
            HELD();
            mem.heldDirect[RIVERBEND] = [{ id: 'd-held', type: 'dm', peerPubkey: ANA, peerKeys: [ANA] }];
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, FARAWAY, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.pushed).toEqual([{ pathname: '/chat/[id]', params: { id: 'd-held', community: RIVERBEND, communityName: 'Riverbend' } }]);
            expect(mem.closes).toBeGreaterThan(0);
            // Mutation: heldChatsWith without its finally -> no close, and this goes red.
        });

        it('block lists that cannot be read: nothing opens, and it says so (never a tap that does nothing)', async () => {
            mem.listsUnreadable = true;
            mem.acrossHere = [{ id: 'x-here', peerKey: ANA, state: 'open' }];
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, FARAWAY, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.pushed).toEqual([]);
            expect(mem.cards).toEqual([]);
            expect(mem.alerts.map((a) => a.slice(0, 2))).toEqual([['Message', 'Please try again.']]);
        });
    });

    /**
     * A chat across counts as the existing chat only while Chat lists it (#3354 review, round 3: a declined one, which Chat
     * lists nowhere and whose thread has no composer and no Accept, was opened as "the existing chat", so Contacts lost the
     * direct chat here it opened before): (state: open / request / declined) x (path). Open and request open that chat; a
     * declined one falls through to the community shared (here, or a held one in place), or across, which makes the chat
     * from the link again (outside-mail.ts openChatFromCard reopens a declined one, as the address card does). Mutation (PR
     * body): either reader counting every state (message-anyone.ts knownChatsWith, held-chats.ts heldChatsWith) -> its
     * declined rows open the dead thread and go red.
     */
    describe('a chat across, by its state: what Message opens', () => {
        const HELD = () => mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        const HERE_FILE = (state: string) => () => { HELD(); mem.acrossHere = [{ id: 'x-here', peerKey: ANA, state }]; };
        const HELD_FILE = (state: string) => () => { HELD(); mem.heldAcross[RIVERBEND] = [{ id: 'x-held', peerKey: ANA, state }]; };
        const ACROSS_MADE = `/outside-chat/across-${ANA.slice(0, 4)}`;
        const PATHS: Array<{ name: string; links: Array<ReturnType<typeof link>>; file: (state: string) => () => void; listed: unknown;
            declined: { pushed: unknown; started?: unknown[]; card?: boolean } }> = [
            { name: 'kept here, they are in the community in use', links: [link(ANA, RIVERSIDE, 'ana')], file: HERE_FILE, listed: '/outside-chat/x-here',
                declined: { pushed: '/chat/conv-1', started: [['dm', [ME.publicKey, ANA], ME.publicKey]] } },
            { name: 'kept here, they are in a held community', links: [link(ANA, RIVERBEND, 'ana')], file: HERE_FILE, listed: '/outside-chat/x-here',
                declined: { pushed: { pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } },
                    started: [['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]] } },
            { name: 'kept here, no community shared', links: [link(ANA, FARAWAY, 'ana')], file: HERE_FILE, listed: '/outside-chat/x-here',
                declined: { pushed: ACROSS_MADE, card: true } },
            { name: 'kept in a held community\'s file, no community shared', links: [link(ANA, FARAWAY, 'ana')], file: HELD_FILE,
                listed: `/outside-chat/x-held?community=${encodeURIComponent(RIVERBEND)}`, declined: { pushed: ACROSS_MADE, card: true } },
        ];
        const ROWS = PATHS.flatMap((path) => (['open', 'request', 'declined'] as const).map((state) => ({ ...path, state, row: `${path.name} x ${state}` })));
        it.each(ROWS)('$row', async ({ links, file, listed, declined, state }) => {
            file(state)();
            await seedList((l) => putContact(l, person('Ana Li', { links })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            mem.pushed.length = 0;
            await press('Message');
            expect(mem.alerts).toEqual([]);
            if (state === 'declined') {
                expect(mem.pushed).toEqual([declined.pushed]);
                expect(vi.mocked(createConversationApi).mock.calls).toEqual(declined.started ?? []);
                expect(mem.cards.map((c) => c.key)).toEqual(declined.card ? [ANA] : []);
            } else {
                expect(mem.pushed).toEqual([listed]);
                expect(vi.mocked(createConversationApi).mock.calls).toEqual([]);
                expect(mem.cards).toEqual([]);
            }
        });
    });

    /**
     * On a guest's look (the phone set to a community it only visits as a guest) there is no community in use (#3354 review,
     * round 3: Message across made its chat in the guest's copy, whose server refuses the line, and Chat never listed it).
     * Nothing in that copy is weighed, nothing is made in it, and a community the phone holds as a member still opens in
     * place. Mutations (PR body): message-anyone.ts communityInUse as the raw anchor -> the across rows make a chat (a card)
     * and the copy's own across chat opens; openAcrossChat without its guest check -> the across row makes a card.
     */
    describe('on a guest\'s look: no community in use', () => {
        const GUEST_ANCHOR = () => {
            mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
            mem.store.set('beanpool_guest_nodes', JSON.stringify([RIVERSIDE]));
        };
        it('no community shared: no chat across is made in the guest\'s copy, and it says to connect to your community', async () => {
            GUEST_ANCHOR();
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, FARAWAY, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.cards).toEqual([]);
            expect(mem.pushed).toEqual([]);
            expect(mem.alerts.map((a) => a.slice(0, 2))).toEqual([['Message', 'Connect to your community to start a chat.']]);
        });
        it('a chat across in the guest\'s copy is not the existing chat', async () => {
            GUEST_ANCHOR();
            mem.acrossHere = [{ id: 'x-guest', peerKey: ANA, state: 'open' }];
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, FARAWAY, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.pushed).toEqual([]);
            expect(mem.cards).toEqual([]);
            expect(mem.alerts.map((a) => a.slice(0, 2))).toEqual([['Message', 'Connect to your community to start a chat.']]);
        });
        it('a community held as a member still opens, in place; a chat across kept in its file too', async () => {
            GUEST_ANCHOR();
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            await press('Message');
            expect(mem.alerts).toEqual([]);
            expect(mem.pushed).toEqual([{ pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } }]);
            expect(vi.mocked(createConversationApi).mock.calls).toEqual([['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]]);
        });
        it('a chat across kept in a held member community\'s file still opens there', async () => {
            GUEST_ANCHOR();
            mem.heldAcross[RIVERBEND] = [{ id: 'x-held', peerKey: ANA, state: 'open' }];
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, FARAWAY, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.alerts).toEqual([]);
            expect(mem.pushed).toEqual([`/outside-chat/x-held?community=${encodeURIComponent(RIVERBEND)}`]);
            expect(mem.cards).toEqual([]);
        });
    });

    /**
     * Message never opens, picks or makes a chat the member can't write in now (#3354 review, round 4), on the real screen: the
     * exhaustive table is message-target-table.test.ts; these are its rows as Contacts draws them, each the review's finding.
     * Mutations (PR body): one spelling per community -> the "another address" rows make a chat across; openAcrossChat without
     * its own-address check -> the "its info says so only now" row makes one; the dead chat counted -> its row opens it.
     */
    describe('never a chat the member cannot write in', () => {
        const OLD_MAIN = 'https://oldriver.example';
        const ALIAS = 'https://river.example';
        const HELD_OLD = 'https://oldbend.example';
        const HELD = () => mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        // The phone met each community at its older address and followed it (addresses S4): the record holds both.
        const MOVED = () => setCommunityIndex([
            { ...makeCommunityRecord(OLD_MAIN), using: RIVERSIDE }, { ...makeCommunityRecord(HELD_OLD), using: RIVERBEND },
        ]);
        // ... and each answers now that the older one is its own still (a real server lists every name it answers as).
        const MOVED_AND_SAYS_SO = () => {
            MOVED();
            mem.saysNow = { addresses: ['riverside.example', 'oldriver.example'], primaryAddress: 'riverside.example' };
            mem.saysThere[RIVERBEND] = { addresses: ['riverbend.example', 'oldbend.example'], primaryAddress: 'riverbend.example' };
        };
        /** What a community says, as this phone keeps it (node-profile.ts). */
        const keptOf = (more: Record<string, unknown>) => readNodeProfile({ profile: 'local', features: { outsideMessages: true }, ...more });
        const SAYS = (more: Record<string, unknown>, community = RIVERSIDE) => mem.store.set('beanpool_node_profiles', JSON.stringify({ [community]: keptOf(more) }));
        const OFF = () => { SAYS({ features: { outsideMessages: false } }); mem.outsideOn = false; };
        const DIRECT_HERE = { pushed: '/chat/conv-1', started: [['dm', [ME.publicKey, ANA], ME.publicKey]] };
        const IN_PLACE = { pushed: { pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } }, started: [['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]] };
        const ROWS: Array<{ name: string; link: string; set: () => void; pushed?: unknown; started?: unknown[]; alert?: string }> = [
            { name: 'a contact at the older main address of the community in use: the direct chat here', link: OLD_MAIN, set: MOVED_AND_SAYS_SO, ...DIRECT_HERE },
            { name: 'another of its addresses, by its info: the direct chat here', link: ALIAS, set: () => { mem.saysNow = { addresses: ['riverside.example', 'river.example'] }; SAYS(mem.saysNow); }, ...DIRECT_HERE },
            { name: 'a name it had before, by its info: the direct chat here', link: OLD_MAIN, set: () => { mem.saysNow = { addresses: ['riverside.example'], formerAddresses: ['oldriver.example'], formerExcludesLost: true }; SAYS(mem.saysNow); }, ...DIRECT_HERE },
            { name: 'its info says so only now (a move this phone has not heard of): nothing made, the direct chat here', link: ALIAS,
                set: () => { SAYS({ addresses: ['riverside.example'] }); mem.saysNow = { addresses: ['riverside.example', 'river.example'], primaryAddress: 'river.example' }; }, ...DIRECT_HERE },
            { name: 'a dead chat across from before (its home is an older main): the direct chat here, never that chat', link: OLD_MAIN,
                set: () => { MOVED_AND_SAYS_SO(); mem.acrossHere = [{ id: 'x-dead', peerKey: ANA, peerHome: 'oldriver.example', state: 'open' }]; }, ...DIRECT_HERE },
            { name: 'the same, the contact at its main address now', link: RIVERSIDE,
                set: () => { MOVED_AND_SAYS_SO(); mem.acrossHere = [{ id: 'x-dead', peerKey: ANA, peerHome: 'oldriver.example', state: 'open' }]; }, ...DIRECT_HERE },
            { name: 'a contact at the older main address of a held community: the direct chat there, in place', link: HELD_OLD, set: () => { HELD(); MOVED_AND_SAYS_SO(); }, ...IN_PLACE },
            { name: 'a chat across to a held community: the direct chat there, in place', link: RIVERBEND,
                set: () => { HELD(); MOVED_AND_SAYS_SO(); mem.acrossHere = [{ id: 'x-held', peerKey: ANA, peerHome: 'oldbend.example', state: 'open' }]; }, ...IN_PLACE },
            { name: 'the community in use takes no messages across any more: the direct chat here, not the open chat across', link: RIVERSIDE,
                set: () => { OFF(); mem.acrossHere = [{ id: 'x-open', peerKey: ANA, peerHome: 'faraway.example', state: 'open' }]; }, ...DIRECT_HERE },
            { name: 'the same, with no community shared: refused, and says why', link: FARAWAY,
                set: () => { OFF(); mem.acrossHere = [{ id: 'x-open', peerKey: ANA, peerHome: 'faraway.example', state: 'open' }]; }, alert: "This community doesn't take messages from other communities." },
            { name: 'on a guest\'s look, a direct chat the member already has there opens', link: RIVERSIDE,
                set: () => { HELD(); mem.store.set('beanpool_guest_nodes', JSON.stringify([RIVERSIDE])); mem.chatsHere = [hereDm('d-guest', ANA)]; }, pushed: '/chat/d-guest' },
            { name: 'on a guest\'s look, no chat there: none is started or made', link: RIVERSIDE,
                set: () => { HELD(); mem.store.set('beanpool_guest_nodes', JSON.stringify([RIVERSIDE])); }, alert: 'Connect to your community to start a chat.' },
        ];
        it.each(ROWS)('$name', async ({ link: at, set, pushed, started = [], alert }) => {
            set();
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, at, 'ana')] })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            mem.pushed.length = 0;
            await press('Message');
            expect(mem.alerts.map((a) => a[1])).toEqual(alert ? [alert] : []);
            expect(mem.pushed).toEqual(pushed === undefined ? [] : [pushed]);
            expect(vi.mocked(createConversationApi).mock.calls).toEqual(started);
            expect(mem.cards).toEqual([]);
        });

        /**
         * Whose the address is can't be said for certain (round 6): nothing opens, starts or is made. The question Contacts
         * asked before this slice comes back for it, and Switch goes to the contact's own address. Mutations (PR body): the
         * uncertain name taken as here / as nobody's -> a chat is started / a card is made.
         */
        const UNSURE: Array<{ name: string; link: string; community: string; set: () => void }> = [
            { name: 'the community in use, which answers nothing of its names; its record alone holds it', link: OLD_MAIN, community: 'oldriver.example', set: MOVED },
            { name: 'a held one, which does not answer; its record alone holds it', link: HELD_OLD, community: 'oldbend.example', set: () => { HELD(); MOVED(); } },
            { name: 'both answer that it is theirs', link: ALIAS, community: 'river.example',
                set: () => { HELD(); mem.saysNow = { addresses: ['riverside.example', 'river.example'] }; mem.saysThere[RIVERBEND] = { addresses: ['riverbend.example', 'river.example'] };
                    mem.store.set('beanpool_node_profiles', JSON.stringify({ [RIVERSIDE]: keptOf({ addresses: ['river.example'] }), [RIVERBEND]: keptOf({ addresses: ['river.example'] }) })); } },
            { name: 'an older server lists it as one it had before, and doesn\'t say the lost ones are left out', link: OLD_MAIN, community: 'oldriver.example',
                set: () => { mem.saysNow = { addresses: ['riverside.example'], formerAddresses: ['oldriver.example'] }; SAYS(mem.saysNow); } },
            { name: 'said only as the chat across is made, of an address that answered this phone as something else', link: ALIAS, community: 'river.example',
                set: () => { setCommunityIndex([{ ...makeCommunityRecord(RIVERSIDE), refused: { [ALIAS]: { at: 1, why: 'key' } } }]); mem.saysNow = { addresses: ['riverside.example', 'river.example'] }; } },
        ];
        it.each(UNSURE)('not certain whose the address is ($name): asks to switch to it, and opens nothing', async ({ link: at, community, set }) => {
            set();
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, at, 'ana')] })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            vi.mocked(switchCommunity).mockClear();
            mem.pushed.length = 0;
            await press('Message');
            expect(mem.alerts.map((a) => a.slice(0, 2))).toEqual([['Switch to this community', `Ana Li is in ${community}. Switch to ${community} to message them?`]]);
            expect(mem.pushed).toEqual([]);
            expect(vi.mocked(createConversationApi).mock.calls).toEqual([]);
            expect(mem.cards).toEqual([]);
            expect(switchCommunity).not.toHaveBeenCalled();
            await answer('Switch');
            expect(vi.mocked(switchCommunity).mock.calls.map((c) => c[0])).toEqual([at]);
        });

        /**
         * A held community that removed the member stays on the phone, its chats too, and refuses the account everything: Message
         * goes on as for a community the phone doesn't hold. Mutation (PR body): never asked -> the chat there opens.
         */
        it.each([
            { name: 'the direct chat there', set: () => { mem.heldDirect[RIVERBEND] = [{ id: 'd-held', type: 'dm', peerPubkey: ANA, peerKeys: [ANA] }]; } },
            { name: 'a chat across kept in its file', set: () => { mem.heldAcross[RIVERBEND] = [{ id: 'x-held', peerKey: ANA, state: 'open' }]; } },
            { name: 'no chat there yet', set: () => {} },
        ])('removed from the held community the contact is in ($name): a chat across to them, nothing opened or started there', async ({ set }) => {
            HELD();
            set();
            mem.standing[RIVERBEND] = [403, { error: 'closed', code: 'account_closed' }];
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, RIVERBEND, 'ana')] })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            mem.pushed.length = 0;
            await press('Message');
            expect(mem.alerts).toEqual([]);
            expect(mem.cards).toEqual([{ key: ANA, home: 'riverbend.example', name: 'Ana Li' }]);
            expect(mem.pushed).toEqual([`/outside-chat/across-${ANA.slice(0, 4)}`]);
            expect(vi.mocked(createConversationApi).mock.calls).toEqual([]);
        });

        it('a name it lost, still on its record: its community answers without it, so across to the one that has it now', async () => {
            MOVED();
            mem.saysNow = { addresses: ['riverside.example'], primaryAddress: 'riverside.example' };
            await seedList((l) => putContact(l, person('Ana Li', { links: [link(ANA, OLD_MAIN, 'ana')] })));
            await render();
            await press('Message');
            expect(mem.alerts).toEqual([]);
            expect(mem.cards).toEqual([{ key: ANA, home: 'oldriver.example', name: 'Ana Li' }]);
        });
    });

    /**
     * Every path Message takes asks one block rule first (#3354 review: Message on a blocked contact in another community opened
     * their hidden chat across, composer and all): (path) x (blocked here / in another held community / unblocked since /
     * none). Blocked on this phone's own list is refused on every path in the same words (a block seen only on another
     * community's list is not: Marty 22 Nov, S7 Q2), and
     * nothing opens, starts or is made; unblocked since and none open what the path opens. Mutations (PR body): no block asked
     * -> the blocked rows open; seenThere counted too (blockedAnywhere) -> the "only on another community's own list" rows are refused; `once` asked
     * (neverLetInQuietly) -> the "unblocked since" rows are refused; existing chats from the raw stores, not Chat's list ->
     * with the block left out too, the hidden chats reopen.
     */
    describe('one block rule on every path', () => {
        const HELD = () => mem.store.set('beanpool_saved_nodes', JSON.stringify([{ url: RIVERSIDE }, { url: RIVERBEND }]));
        const REFUSED = [['Message', 'You have blocked this user. Messaging is disabled.']];
        const BLOCKS = [
            { name: 'blocked here', set: () => { mem.blocked = [ANA]; }, refused: true },
            // Marty 22 Nov (S7 Q2 kept): a block seen only on another community's own list doesn't refuse Message, as Chats.
            { name: 'blocked only on another community\'s own list', set: () => { mem.seenThere = [ANA]; }, refused: false },
            { name: 'unblocked since', set: () => { mem.once = [ANA]; }, refused: false },
            { name: 'none', set: () => {}, refused: false },
        ];
        const PATHS: Array<{ name: string; links: Array<ReturnType<typeof link>>; set: () => void; pushed: unknown; started?: unknown[]; card?: boolean; screenBlocks?: boolean }> = [
            { name: 'existing direct chat here', links: [link(ANA, RIVERBEND, 'ana')], set: () => { HELD(); mem.chatsHere = [hereDm('d-here', ANA)]; }, pushed: '/chat/d-here' },
            { name: 'existing direct chat in a held community (in place)', links: [link(ANA, FARAWAY, 'ana')],
                set: () => { HELD(); mem.heldDirect[RIVERBEND] = [{ id: 'd-held', type: 'dm', peerPubkey: ANA, peerKeys: [ANA] }]; },
                pushed: { pathname: '/chat/[id]', params: { id: 'd-held', community: RIVERBEND, communityName: 'Riverbend' } } },
            { name: 'a held community, no chat yet (started in place)', links: [link(ANA, RIVERBEND, 'ana')], set: () => { HELD(); },
                pushed: { pathname: '/chat/[id]', params: { id: 'conv-1', community: RIVERBEND, communityName: 'Riverbend' } }, started: [['dm', [ME.publicKey, ANA], ME.publicKey, undefined, undefined, RIVERBEND]] },
            { name: 'existing chat across', links: [link(ANA, FARAWAY, 'ana')], set: () => { mem.acrossHere = [{ id: 'x-here', peerKey: ANA, state: 'open' }]; }, pushed: '/outside-chat/x-here' },
            { name: 'existing chat across in a held community\'s file', links: [link(ANA, FARAWAY, 'ana')], set: () => { HELD(); mem.heldAcross[RIVERBEND] = [{ id: 'x-held', peerKey: ANA, state: 'open' }]; },
                pushed: `/outside-chat/x-held?community=${encodeURIComponent(RIVERBEND)}` },
            { name: 'a new chat across', links: [link(ANA, FARAWAY, 'ana')], set: () => {}, pushed: `/outside-chat/across-${ANA.slice(0, 4)}`, card: true },
            // A link here that is on this phone's list shows Blocked + Unblock, not Message (the screen's own row, as before).
            { name: 'the community in use, no chat yet', links: [link(ANA, RIVERSIDE, 'ana')], set: () => {}, pushed: '/chat/conv-1', started: [['dm', [ME.publicKey, ANA], ME.publicKey]], screenBlocks: true },
        ];
        const ROWS = PATHS.flatMap((path) => BLOCKS.map((block) => ({ ...path, block, row: `${path.name} x ${block.name}` })));
        it.each(ROWS)('$row', async ({ links, set, pushed, started = [], card, screenBlocks, block }) => {
            set();
            block.set();
            await seedList((l) => putContact(l, person('Ana Li', { links })));
            await render();
            const { createConversationApi } = await import('../db');
            vi.mocked(createConversationApi).mockClear();
            mem.pushed.length = 0;
            if (block.refused && screenBlocks && block.name === 'blocked here') {
                expect(button('Message')).toBeUndefined();
                expect(text()).toContain('Blocked');
                return;
            }
            await press('Message');
            if (block.refused) {
                expect(mem.alerts.map((a) => a.slice(0, 2))).toEqual(REFUSED);
                expect(mem.pushed).toEqual([]);
                expect(vi.mocked(createConversationApi).mock.calls).toEqual([]);
                expect(mem.cards).toEqual([]);
            } else {
                expect(mem.alerts).toEqual([]);
                expect(mem.pushed).toEqual([pushed]);
                expect(vi.mocked(createConversationApi).mock.calls).toEqual(started);
                expect(mem.cards.map((c) => c.key)).toEqual(card ? [ANA] : []);
            }
        });
    });

    it('Add by hand: nothing typed says what is needed; a name and a number are kept, locked, on the phone', async () => {
        await render();
        expect(text()).toContain('No contacts yet. Import them from this phone or a contacts file, or add someone by hand.');
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

    it('Back belongs to Contacts only while it is on top: a screen pushed over "Add a contact" keeps its own Back (review 2)', async () => {
        await render();
        await press('＋ Add');
        expect(text()).toContain('Phone number');
        // A notification tap pushes another screen over Contacts: this one is no longer focused.
        mem.focused = false;
        await pressBack();
        expect(mem.pushed).toEqual(['back']);
        expect(text()).toContain('Phone number');
        // Mutation: drop the isFocused() guard → Back is swallowed here (pushed stays []) and the Add form is discarded.
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
        // And the file picker's copy from an import the app was ended in (slice C3): its whole folder (only Import picks files).
        const gone: string[] = [];
        await sweepContactsFile({ cacheDirectory: 'file:///c', deleteAsync: async (u: string) => { gone.push(u); } });
        // Mutation: drop the folder's removal → an unlocked contacts file a killed import left stays in the cache.
        expect(gone).toEqual(['file:///c/contacts.vcf', 'file:///c/DocumentPicker/']);
        // The app's start runs it, beside the recovery kit's sweep.
        expect(readFileSync(join(__dirname, '../../app/_layout.tsx'), 'utf8')).toMatch(/useEffect\(\(\) => \{ void import\('\.\.\/utils\/use-contacts'\)\.then\(\(m\) => m\.sweepContactsFile\(\)\)/);
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
        expect(text()).toContain('No contacts yet. Import them from this phone or a contacts file, or add someone by hand.');
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

describe('Import on the phone (slice C3): asked at the tap, the three answers, Choose who to bring, Done', () => {
    const book = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Person ${i}`, phoneNumbers: [{ number: `0412 ${String(i).padStart(6, '0')}` }] }));
    const byTest = (id: string) => Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('data-testid') === id);
    const pressTest = async (id: string) => {
        const b = byTest(id);
        if (!b) throw new Error(`no button ${id} in: ${text().slice(0, 400)}`);
        await act(async () => { b.click(); });
        await settle();
    };

    it('opened from Chat it starts on Import and asks nothing; the tap asks once; everyone found is ticked; one Import adds them all', async () => {
        mem.params = { start: 'import' };
        mem.book = [...book(3), { name: 'No Number' }];
        await render();
        const t = text();
        expect(t).toContain("Choose where your contacts are. WhatsApp uses your phone's contacts, so this brings those too.");
        expect(t).toContain("From this phone's contacts");
        expect(t).toContain("Contacts you saved only inside WhatsApp aren't in your phone's contacts. Save them to your phone in WhatsApp first.");
        expect(t).toContain('From a contacts file (.vcf)');
        expect(t).toContain('Type one in');
        // Mutation: ask in an effect on open (or at Chat) -> asked is 1 before any tap.
        expect(mem.asked).toBe(0);
        await pressTest('import-from-phone');
        expect(mem.asked).toBe(1);
        expect(mem.queries.every((q) => q.fields.join() === 'name,firstName,lastName,phoneNumbers,emails')).toBe(true);
        expect(text()).toContain('Found 4 contacts. Nothing has left your phone yet.');
        expect(text()).toContain('(no number or email)');
        // Nothing is in the list before the button (design §3.4).
        expect((await onPhone()).kind).toBe('none');
        await press('Import 3 contacts');
        expect(text()).toContain("3 contacts added. They're locked with your key and will be kept at: Riverside.");
        expect(text()).toContain("BeanPool read your phone's contacts once, just now. It doesn't watch them. To bring new ones later, tap Import again.");
        const kept = await onPhone();
        expect(kept.kind === 'list' && kept.list.contacts.map((c) => c.name).sort()).toEqual(['Person 0', 'Person 1', 'Person 2']);
        await press('Done');
        expect(text()).toContain('Not on BeanPool yet');
    });

    it('no: the design\'s sentence with Pick a file and Back; no for good: Open Settings and Pick a file instead; nothing is read', async () => {
        mem.params = { start: 'import' };
        mem.book = book(2);
        mem.answer = { granted: false, canAskAgain: true };
        await render();
        await pressTest('import-from-phone');
        expect(text()).toContain("No problem. BeanPool can't see your phone's contacts. You can pick a contacts file instead, or add people by hand.");
        // Above the row it answers (the API 26 walk at 320 dp and 1.3x: under it, its buttons started below the fold).
        expect(text().indexOf('No problem.')).toBeLessThan(text().indexOf("From this phone's contacts"));
        expect(button('Pick a file')).toBeTruthy();
        expect(button('Back')).toBeTruthy();
        mem.answer = { granted: false, canAskAgain: false };
        await pressTest('import-from-phone');
        expect(text()).toContain("Your phone is set not to let BeanPool see contacts. To change it, open your phone's Settings, then BeanPool, then Contacts.");
        expect(text()).not.toContain('No problem.');
        await press('Open Settings');
        expect(mem.settings).toBe(1);
        expect(button('Pick a file instead')).toBeTruthy();
        // Mutation: read the address book whatever the answer -> queries made.
        expect(mem.queries).toHaveLength(0);
        mem.answer = { granted: false, canAskAgain: true };
        await pressTest('import-from-phone');
        // Back from Import, with no list yet, goes back to Chat.
        await press('Back');
        expect(mem.pushed.at(-1)).toBe('back');
    });

    it('a contacts file: the people in it to choose from, the picker\'s copy removed; a file that isn\'t one says so', async () => {
        mem.params = { start: 'import' };
        mem.picked = { uri: 'file:///cache/DocumentPicker/x.vcf', size: 120, text: 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dee Walker\r\nTEL:0412 345 678\r\nEND:VCARD\r\n' };
        await render();
        await pressTest('import-from-file');
        expect(text()).toContain('Found 1 contact. Nothing has left your phone yet.');
        expect(mem.files.has('file:///cache/DocumentPicker/x.vcf')).toBe(false);
        expect(mem.asked).toBe(0);
        // Android's Back from Choose who to bring returns to Import.
        await pressBack();
        expect(text()).toContain('From a contacts file (.vcf)');
        mem.picked = { uri: 'file:///cache/DocumentPicker/y.jpg', size: 10, text: 'not a card' };
        await pressTest('import-from-file');
        expect(text()).toContain('That file isn’t a contacts file BeanPool can read. Export it again as vCard (.vcf).');
        expect(mem.files.has('file:///cache/DocumentPicker/y.jpg')).toBe(false);
    });

    it('an app built without the two native parts offers neither row, and Type one in still works; the empty list has Import contacts', async () => {
        mem.native = {};
        mem.params = { start: 'import' };
        await render();
        expect(byTest('import-from-phone')).toBeUndefined();
        expect(byTest('import-from-file')).toBeUndefined();
        await press('Type one inAdd a person by hand.');
        expect(text()).toContain('Phone number');
        await pressBack();
        expect(button('Import contacts')).toBeTruthy();
        await press('Import contacts');
        expect(text()).toContain('Type one in');
    });
});

describe('after a re-key (slice C6): the old list, and the people chatted with', () => {
    it('while the community in use keeps an old list: the notice, Open with my old 12 words, and Delete it after its question', async () => {
        await seedList((l) => putContact(l, person('Ana Li')));
        await render();
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeNull();
        await act(async () => { root?.unmount(); });
        mem.former = 'open';
        await render();
        expect(text()).toContain('Your contacts are locked with your old key. If you ever find your old 12 words, you can open them here.');
        await press('Open with my old 12 words');
        expect(mem.pushed).toContain('/old-words-unlock?for=contacts');
        await press('Delete it');
        expect(mem.alerts[mem.alerts.length - 1]?.[0]).toBe('Delete your old contacts list?');
        expect(mem.formerDeleted).toBe(0);
        await answer('Delete it');
        expect(mem.formerDeleted).toBe(1);
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeNull();
        // Mutation: drop the question → Delete it removes the copy on the first tap (formerDeleted 1 before the answer).
    });

    it('the old-words screen merged the old list (nobody in it new, so no list changed): the notice turns to its merged form, with Delete the old copy only', async () => {
        await seedList((l) => putContact(l, person('Ana Li')));
        mem.former = 'open';
        await render();
        expect(text()).toContain('Open with my old 12 words');
        // The old-words screen (over Contacts) merged it in, so this phone has it now; the list itself is as it was. The
        // community still keeps the old copy, so the one way to delete it stays (director's call, #3170 round 2).
        mem.former = 'merged';
        await act(async () => { DeviceEventEmitter.emit(CONTACTS_FORMER_CHANGED_EVENT); });
        await settle();
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeTruthy();
        expect(text()).toContain('Your old contacts list is in your contacts now. Its old locked copy is still kept here.');
        expect(text()).not.toContain('Open with my old 12 words');
        expect(text()).not.toContain('Your contacts are locked with your old key.');
        expect(text()).toContain('Ana Li');
        await press('Delete the old copy');
        expect(mem.alerts[mem.alerts.length - 1]?.[0]).toBe('Delete your old contacts list?');
        expect(mem.formerDeleted).toBe(0);
        await answer('Delete it');
        expect(mem.formerDeleted).toBe(1);
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeNull();
        // Mutation: drop FormerNotice's listener → the notice keeps Open with my old 12 words until Contacts is opened again.
        // The old-words screen says so after each try of the old list: opened from Contacts, and from a group chat.
        const words = readFileSync(join(__dirname, '../../app/old-words-unlock.tsx'), 'utf8');
        expect(words.match(/DeviceEventEmitter\.emit\(CONTACTS_FORMER_CHANGED_EVENT\);/g)).toHaveLength(2);
    });

    it('"Delete it" the community in use did not confirm: the notice stays, and the member is told the copy is still kept', async () => {
        await seedList((l) => putContact(l, person('Ana Li')));
        mem.former = 'open';
        mem.deleteAnswer = { here: false, complete: false };
        await render();
        await press('Delete it');
        await answer('Delete it');
        expect(mem.formerDeleted).toBe(1);
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeTruthy();
        expect(mem.alerts[mem.alerts.length - 1]?.slice(0, 2)).toEqual(['Not deleted', "Some of your communities didn't answer. Your old contacts list is still kept there. Try again later."]);
        // Gone here but another community silent: the notice goes, and the member is still told.
        mem.alerts.length = 0;
        mem.deleteAnswer = { here: true, complete: false };
        await press('Delete it');
        await answer('Delete it');
        expect(host.querySelector('[data-testid="contacts-former"]')).toBeNull();
        expect(mem.alerts[mem.alerts.length - 1]?.slice(0, 2)).toEqual(['Not deleted', "Some of your communities didn't answer. Your old contacts list is still kept there. Try again later."]);
        // Mutation: hide on `complete` alone → the second Delete leaves the notice up for a copy that is gone here.
    });

    it('"Add people I\'ve chatted with and my friends": counted, asked once, added linked by hand here, nobody twice', async () => {
        await seedList((l) => putContact(l, person('Sam Jones', { links: [link(SAM, RIVERSIDE, 'sam_j')] })));
        mem.chats = [{ publicKey: SAM, callsign: 'sam_j' }, { publicKey: ANA, callsign: 'ana' }];
        mem.friends = [{ publicKey: ANA, callsign: 'ana' }, { publicKey: BLOCKED, callsign: 'cy' }, { publicKey: ME.publicKey, callsign: 'me' }];
        await render();
        await press('More');
        await press("Add people I've chatted with and my friends");
        const asked = mem.alerts[mem.alerts.length - 1];
        expect(asked?.[1]).toBe("Add 2 people you've chatted with or added as friends in Riverside? Only you see your contacts, and nobody is told.");
        await answer('Add 2 people');
        const now = await onPhone();
        const contacts = now.kind === 'list' ? now.list.contacts : [];
        expect(contacts.map((c) => c.name).sort()).toEqual(['Sam Jones', 'ana', 'cy']);
        expect(contacts.find((c) => c.name === 'ana')?.links.map((l) => [l.key, l.community, l.how])).toEqual([[ANA, RIVERSIDE, 'hand']]);
        // Again: everyone is in already, and nothing is added.
        await press('More');
        await press("Add people I've chatted with and my friends");
        expect(mem.alerts[mem.alerts.length - 1]?.[1]).toBe("Everyone you've chatted with or added as a friend here is already in your contacts.");
        // Mutation: skip peopleToAdd's linked check → Sam Jones twice, and the ask says 3.
    });
});
