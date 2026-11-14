// @vitest-environment jsdom
/**
 * Invite from a contact on the phone (DESIGN-private-contacts-fable.md §3.8, §3.9, §11 "Across apps (C5)", slice C5):
 * app/contacts.tsx and components/ContactInviteSheet.tsx rendered for real over the real store and its real sync, with a
 * recording community behind fetch. The reviewer's check: NO contact's name, number or email reaches any request the flow
 * sends (URL, headers, body), the invite included, and the locked copy's save. Each check names the change that turns it red.
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
    shares: [] as Array<{ message: string }>,
    opened: [] as string[],
    copied: [] as string[],
    sent: [] as string[],
    profile: null as null | { profile: string; features: Record<string, unknown> },
    role: null as null | string,
    mine: [] as Array<Record<string, unknown>>,
    generateAnswer: null as null | { status: number; body: unknown },
    // When set, the community lists every invite made so far, unused (the reviewer's probe of #3165), and counts its reads.
    mineIsMade: false,
    mineReads: 0,
}));
const fakes = vi.hoisted(() => {
    const fsFake = {
        documentDirectory: 'file:///docs/',
        cacheDirectory: 'file:///cache/',
        readAsStringAsync: async (u: string) => { if (!mem.files.has(u)) throw new Error('no file'); return mem.files.get(u)!; },
        writeAsStringAsync: async (u: string, t: string) => { mem.files.set(u, t); },
        getInfoAsync: async (u: string) => ({ exists: mem.files.has(u) }),
        makeDirectoryAsync: async () => {},
        deleteAsync: async (u: string) => { mem.files.delete(u); },
        moveAsync: async ({ from, to }: { from: string; to: string }) => { mem.files.set(to, mem.files.get(from)!); mem.files.delete(from); },
    };
    const storage = { getItem: async (k: string) => mem.store.get(k) ?? null, setItem: async (k: string, v: string) => { mem.store.set(k, v); }, removeItem: async (k: string) => { mem.store.delete(k); } };
    const Loader = (process as any).getBuiltinModule('node:module');
    const load = Loader._load;
    Loader._load = function (request: string, ...rest: unknown[]) {
        if (request === 'expo-file-system/legacy') return fsFake;
        if (request === '@react-native-async-storage/async-storage') return { default: storage, __esModule: true };
        return load.call(this, request, ...rest);
    };
    return { fsFake, storage };
});
vi.mock('react-native', () => {
    const el = (tag: string) => (props: Record<string, any>) => {
        const { children, onPress, accessibilityLabel, testID, disabled, value, onChangeText } = props;
        const attrs: Record<string, unknown> = {};
        if (onPress && !disabled) attrs.onClick = (e: Event) => { e.stopPropagation(); onPress(); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (testID) attrs['data-testid'] = testID;
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
        ActivityIndicator: el('span'),
        Linking: { openSettings: async () => {}, openURL: async (u: string) => { mem.opened.push(u); } },
        Share: { share: async (o: { message: string }) => { mem.shares.push(o); return { action: 'sharedAction' }; } },
        Modal: ({ visible, children }: { visible: boolean; children?: ReactNode }) => (visible ? createElement('div', { 'data-modal': 'true' }, children) : null),
        StyleSheet: { create: (s: unknown) => s, absoluteFill: {} },
        DeviceEventEmitter: { addListener: () => ({ remove() {} }), emit: () => {} },
        BackHandler: { addEventListener: () => ({ remove() {} }) },
        useWindowDimensions: () => ({ width: 320, height: 640 }),
    };
});
vi.mock('expo-router', () => ({
    router: { push: () => {}, back: () => {} },
    useNavigation: () => ({ setOptions: () => {}, isFocused: () => true }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: () => {},
    ErrorBoundary: () => null,
}));
vi.mock('react-native-safe-area-context', () => ({
    SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
    useKeyboardState: () => ({ isVisible: false, height: 0 }),
}));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: fakes.storage }));
vi.mock('expo-file-system/legacy', () => fakes.fsFake);
vi.mock('expo-sharing', () => ({ shareAsync: async () => {} }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async (s: string) => { mem.copied.push(s); return true; } }));
vi.mock('../keyboard-alert', () => ({ Alert: { alert: (...a: any[]) => { mem.alerts.push(a as any); } } }));
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    const ctx = { theme: 'light', colors: lightColors, patternEnabled: false };
    return { useTheme: () => ctx, useStyles: (make: (c: typeof ctx) => unknown) => make(ctx) };
});
const ME = vi.hoisted(() => ({ publicKey: '', privateKey: '' }));
vi.mock('../../app/IdentityContext', () => ({ useIdentity: () => ({ identity: ME }) }));
vi.mock('../db', () => ({ createConversationApi: vi.fn(async () => ({ id: 'conv-1' })) }));
vi.mock('../blocklist', () => ({ BLOCKLIST_UPDATED_EVENT: 'blocklist', getBlockedUsers: async () => [], unblockUser: vi.fn(async () => true) }));
vi.mock('../use-communities', () => ({ switchCommunity: vi.fn(async () => {}) }));
vi.mock('../../components/signed-request-lines', () => ({ signedRequestWords: (m: string) => m }));
vi.mock('../use-node-profile', () => ({ useNodeProfile: () => mem.profile }));
vi.mock('../node-admin', () => ({ askNodeRole: async () => ({ role: mem.role }), readPersistedNodeRole: async () => mem.role }));
// A stand-in signature: the member's key, a time and a nonce, as the real one carries. What matters is what else rides along.
vi.mock('../crypto', () => ({
    buildSignedHeaders: async (_m: string, _u: string, _b: string, _priv: string, pub: string) => ({
        'Content-Type': 'application/json', 'X-Public-Key': pub, 'X-Signature': 'ab'.repeat(64), 'X-Timestamp': '1763200000000', 'X-Nonce': 'cd'.repeat(16),
    }),
}));
const RIVERSIDE = 'https://riverside.example';
vi.mock('../nodes', () => ({ getSavedNodes: async () => [{ url: 'https://riverside.example', alias: 'Riverside' }] }));

import { newContactId, putContact, type ContactsList } from '@beanpool/core';
import ContactsScreen from '../../app/contacts';
import { changeContacts, loadContacts, phoneContactsDeps } from '../contacts-store';
import { phoneSyncDeps, syncContacts } from '../contacts-sync';

// A fixed key, checked below to hold none of the needles: a random one could hold "0412" by chance.
const seed = new Uint8Array(32).fill(7);
ME.publicKey = bytesToHex(ed25519.getPublicKey(seed));
ME.privateKey = bytesToHex(seed);
const DEE_KEY = 'd1'.repeat(32);
// What the list holds of Dee and Tom, in every spelling a request could carry it. None may leave the phone.
const NEEDLES = [
    'Dee Walker', 'Walker', '0412 345 678', '0412345678', '412345678', '0412%20345', '0412+345', 'dee@example.org', 'dee%40example.org',
    'Tom Riley', 'Riley', '0499 000 111', '0499000111', 'tom@example.org', 'tom%40example.org',
];
const DEE = { id: newContactId(), name: 'Dee Walker', phones: ['0412 345 678'], emails: ['dee@example.org'], note: 'from the market', links: [], invite: null };
const TOM = { id: newContactId(), name: 'Tom Riley', phones: ['0499 000 111'], emails: ['tom@example.org'], note: '', links: [], invite: null };

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
let seq = 0;
function community(url: string, init: RequestInit = {}): Response {
    const method = init.method ?? 'GET';
    mem.sent.push(`${method} ${url} ${JSON.stringify(init.headers ?? {})} ${typeof init.body === 'string' ? init.body : ''}`);
    const path = url.replace(RIVERSIDE, '');
    if (path === '/api/invite/generate') return mem.generateAnswer ? json(mem.generateAnswer.status, mem.generateAnswer.body) : json(200, { success: true, invite: { code: `INV-TEST-000${mem.sent.filter((s) => s.includes('/api/invite/generate')).length}` } });
    if (path.startsWith('/api/invite/mine/')) {
        mem.mineReads += 1;
        const made = mem.sent.filter((s) => s.includes('/api/invite/generate')).map((_, i) => ({ code: `INV-TEST-000${i + 1}`, createdAt: new Date().toISOString(), usedBy: null }));
        return json(200, { invites: mem.mineIsMade ? made : mem.mine });
    }
    if (method === 'DELETE' && path.startsWith('/api/invite/')) return json(200, { success: true, revoked: 1, returned: 0, promiseEnded: false });
    if (path === '/api/me/unread') return json(200, { contacts: seq ? { seq } : null });
    if (path === '/api/contacts/copy') {
        if (method === 'PUT') { seq = JSON.parse(String(init.body)).header?.seq ?? seq + 1; return json(200, { seq }); }
        return json(404, { code: 'no_copy' });
    }
    return json(404, { error: 'no route' });
}

let root: Root | null = null;
let host: HTMLDivElement;
const settle = async () => { for (let i = 0; i < 15; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
async function render() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(createElement(ContactsScreen) as unknown as Parameters<Root['render']>[0]); });
    await settle();
}
const text = () => host.textContent ?? '';
/** The sheet is loaded when Invite is first tapped (app/contacts.tsx lazy): wait for it, up to two seconds. */
async function sheetOpen() {
    for (let i = 0; i < 100 && !host.querySelector('[data-testid="contact-invite-sheet"]'); i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await settle();
}
const buttons = (label: string) => Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === label || b.getAttribute('aria-label') === label);
async function press(label: string, nth = 0) {
    const b = buttons(label)[nth];
    if (!b) throw new Error(`no button "${label}" in: ${text().slice(0, 600)}`);
    await act(async () => { b.click(); });
    await settle();
}
async function answer(choice: string) {
    const alert = mem.alerts[mem.alerts.length - 1];
    const b = alert?.[2]?.find((x) => x.text === choice);
    if (!b) throw new Error(`no "${choice}" in the last alert: ${JSON.stringify(alert)}`);
    await act(async () => { b.onPress?.(); });
    await settle();
}
const seedList = (fn: (l: ContactsList) => ContactsList) => changeContacts(ME, fn, phoneContactsDeps());
const listNow = async () => {
    const { onPhone } = await loadContacts(ME, phoneContactsDeps());
    return onPhone.kind === 'list' ? onPhone.list : null;
};
const sentText = () => mem.sent.join('\n');
const assertNothingNamed = () => { for (const n of NEEDLES) expect(sentText(), `"${n}" left the phone`).not.toContain(n); };

beforeEach(() => {
    mem.store.clear(); mem.files.clear(); mem.alerts.length = 0; mem.shares.length = 0; mem.opened.length = 0; mem.copied.length = 0; mem.sent.length = 0;
    mem.profile = { profile: 'local', features: { invites: true, door: 'members' } };
    mem.role = null; mem.mine = []; mem.generateAnswer = null; mem.mineIsMade = false; mem.mineReads = 0; seq = 0;
    mem.store.set('beanpool_anchor_url', RIVERSIDE);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => community(String(url), init)));
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host?.remove();
    vi.unstubAllGlobals();
});

describe('Invite from a contact on the phone', () => {
    it('the key used to sign holds none of the needles (so a hit below is the flow, not chance)', () => {
        for (const n of NEEDLES) expect(ME.publicKey).not.toContain(n);
    });

    it('the whole flow (invite, Text message, Copy, "Is this Dee?", Yes, cancel on Remove, the locked copy saved): no name, number or email in any request', async () => {
        await seedList((l) => putContact(putContact(l, DEE), TOM));
        await render();
        // Every row not on BeanPool yet has Invite.
        expect(buttons('Invite').length).toBe(2);

        // Dee: the sheet, in the design's words.
        await press('Invite', 0);
        await sheetOpen();
        expect(text()).toContain('Invite Dee Walker to Riverside');
        expect(text()).toContain('One invite, for one person. It works once, for 30 days.');
        expect(text()).toContain("Dee Walker's name and number are not sent to the server.");
        expect(mem.sent.filter((s) => s.includes('/api/invite/generate'))).toEqual([]); // nothing made before a tap
        await press('Text message');
        // The phone's own text app, with the number (digits only) and today's invite message.
        expect(mem.opened).toHaveLength(1);
        expect(mem.opened[0]).toMatch(/^sms:0412345678\?body=Join%20my%20BeanPool%20community%2C%20Riverside/);
        expect(decodeURIComponent(mem.opened[0])).toContain(`${RIVERSIDE}/?invite=INV-TEST-0001`);
        // The invite's body is the maker's key alone: no note.
        const generate = mem.sent.find((s) => s.includes('/api/invite/generate'))!;
        expect(generate.endsWith(JSON.stringify({ publicKey: ME.publicKey }))).toBe(true);
        // The code is kept in the locked list, and the row reads "invited <date>" with Invite again.
        const list = await listNow();
        expect(list?.contacts.find((c) => c.name === 'Dee Walker')?.invite).toMatchObject({ code: 'INV-TEST-0001', community: RIVERSIDE });
        expect(text()).toMatch(/invited \d{1,2} [A-Z][a-z]{2}/);
        expect(buttons('Invite again').length).toBe(1);

        // Tom: Copy puts the whole message on the clipboard and says so.
        await press('Invite', 0);
        await sheetOpen();
        await press('Copy');
        expect(mem.copied[0]).toContain('INV-TEST-0002');
        expect(text()).toContain('Copied. Paste it in your own message.');
        await press('Close');

        // The community says Dee's code was used by @dee_w: the row asks; Yes links Dee to that member.
        mem.mine = [
            { code: 'INV-TEST-0001', createdAt: new Date().toISOString(), usedBy: DEE_KEY, usedByCallsign: 'dee_w', usedAt: new Date().toISOString() },
            { code: 'INV-TEST-0002', createdAt: new Date().toISOString(), usedBy: null },
        ];
        await act(async () => { root?.unmount(); });
        host.remove();
        await render();
        expect(text()).toContain('Someone joined Riverside with the invite you sent Dee Walker: @dee_w. Is this Dee Walker?');
        await press("Yes, that's Dee Walker");
        const linked = (await listNow())?.contacts.find((c) => c.name === 'Dee Walker');
        expect(linked?.links).toEqual([expect.objectContaining({ key: DEE_KEY, community: RIVERSIDE, callsign: 'dee_w', how: 'invite' })]);
        expect(text()).not.toContain('Is this Dee Walker?');
        expect(text()).toContain('@dee_w · Riverside');

        // Tom: his invite is still out, so Remove offers to cancel it; ticked, the revoke goes first, then he goes.
        const tomRow = Array.from(host.querySelectorAll('[data-testid="contact-row"]')).find((r) => r.textContent?.includes('Tom Riley'))!;
        await act(async () => { (tomRow.querySelector('button') as HTMLButtonElement).click(); });
        await settle();
        expect(text()).toContain('Also cancel the invite I sent');
        await act(async () => { (host.querySelector('[data-testid="contact-cancel-invite"]') as HTMLButtonElement).click(); });
        await settle();
        await press('Remove from contacts');
        await answer('Remove');
        expect(mem.sent.some((s) => s.startsWith(`DELETE ${RIVERSIDE}/api/invite/INV-TEST-0002 `))).toBe(true);
        expect((await listNow())?.contacts.map((c) => c.name)).toEqual(['Dee Walker']);

        // The locked list goes to the community once its wait is over: a save, through the real sync.
        await syncContacts(ME, { ...phoneSyncDeps(), now: () => Date.now() + 20 * 60_000 });
        expect(mem.sent.some((s) => s.startsWith(`PUT ${RIVERSIDE}/api/contacts/copy`))).toBe(true);

        assertNothingNamed();
        // Mutation: send the contact's name as `intendedFor` (utils/invite-and-share.ts askForInvite) → "Dee Walker" in a body, red.
    });

    it('a refusal (the daily limit) is the server\'s own sentence; nothing is shared and nothing kept', async () => {
        mem.generateAnswer = { status: 429, body: { error: 'You have made 20 invites today. Try again tomorrow.' } };
        await seedList((l) => putContact(l, DEE));
        await render();
        await press('Invite');
        await sheetOpen();
        await press('Share…');
        expect(text()).toContain('You have made 20 invites today. Try again tomorrow.');
        expect(mem.shares).toEqual([]);
        expect((await listNow())?.contacts[0].invite).toBeNull();
        assertNothingNamed();
    });

    it('admins-only door, a member: the existing words, and the existing ask opened empty with its one added line; no invite made', async () => {
        mem.profile = { profile: 'local', features: { invites: true, door: 'admins' } };
        mem.role = null;
        await seedList((l) => putContact(l, DEE));
        await render();
        await press('Invite');
        await sheetOpen();
        expect(text()).toContain('In this community only its admins invite people. Ask an admin to bring them in.');
        await press('Ask an admin to invite Dee Walker');
        expect(host.querySelector('[data-testid="invite-ask-sheet"]')).not.toBeNull();
        expect(text()).toContain('The admins will see the first name you type here.');
        // Nothing of Dee is filled in for the member: the admins see only what they type.
        expect((host.querySelector('[data-testid="invite-ask-first-name"]') as HTMLInputElement).value).toBe('');
        expect(mem.sent.filter((s) => s.includes('/api/invite/generate'))).toEqual([]);
        assertNothingNamed();
        // Mutation: drop mayInviteHere from the sheet → Share… is offered and the door's words are gone.
    });

    it('a community with no invites (the global one): its existing words, and its plain link shared; nothing made, nobody linked', async () => {
        mem.profile = { profile: 'global', features: { invites: false } };
        await seedList((l) => putContact(l, DEE));
        await render();
        await press('Invite');
        await sheetOpen();
        expect(text()).toContain('This community doesn’t use invites');
        await press('📤 Share the link');
        expect(mem.shares).toEqual([{ message: `Join me on BeanPool: ${RIVERSIDE}` }]);
        expect(mem.sent.filter((s) => s.includes('/api/invite/'))).toEqual([]);
        expect((await listNow())?.contacts[0].invite).toBeNull();
    });

    it('Copy then Share hands over the same invite: one code made for one person', async () => {
        await seedList((l) => putContact(l, DEE));
        await render();
        await press('Invite');
        await sheetOpen();
        await press('Copy');
        await press('Share…');
        expect(mem.sent.filter((s) => s.includes('/api/invite/generate'))).toHaveLength(1);
        expect(mem.shares[0].message).toBe(mem.copied[0]);
        // Mutation: make the invite on every tap (drop the sheet's `made`) → two generates, red.
    });

    it('"Also cancel the invite I sent" ticked on one contact is not ticked on the next one opened', async () => {
        const at = new Date().toISOString();
        await seedList((l) => putContact(putContact(l, { ...DEE, invite: { code: 'INV-TEST-0001', community: RIVERSIDE, at } }), { ...TOM, invite: { code: 'INV-TEST-0002', community: RIVERSIDE, at } }));
        mem.mine = [{ code: 'INV-TEST-0001', createdAt: at, usedBy: null }, { code: 'INV-TEST-0002', createdAt: at, usedBy: null }];
        await render();
        const open = async (name: string) => {
            const row = Array.from(host.querySelectorAll('[data-testid="contact-row"]')).find((r) => r.textContent?.includes(name))!;
            await act(async () => { (row.querySelector('button') as HTMLButtonElement).click(); });
            await settle();
        };
        await open('Dee Walker');
        await act(async () => { (host.querySelector('[data-testid="contact-cancel-invite"]') as HTMLButtonElement).click(); });
        await settle();
        expect(host.querySelector('[data-testid="contact-cancel-invite"] i')?.getAttribute('data-icon')).toBe('checkbox-marked');
        await press('Go back');
        await open('Tom Riley');
        expect(host.querySelector('[data-testid="contact-cancel-invite"] i')?.getAttribute('data-icon')).toBe('checkbox-blank-outline');
        // Mutation: drop the reset on opening a contact → Tom's tick is already on, red.
    });

    it('two invites on this screen, then Invite again, with no re-render: each one\'s Remove offers to cancel its own invite', async () => {
        mem.mineIsMade = true;
        await seedList((l) => putContact(putContact(l, DEE), TOM));
        await render();
        const inviteBy = async (button: 'Invite' | 'Invite again') => {
            await press(button, 0);
            await sheetOpen();
            await press('Copy');
            expect(text()).toContain('Copied. Paste it in your own message.');
            await press('Close');
        };
        const open = async (name: string) => {
            const row = Array.from(host.querySelectorAll('[data-testid="contact-row"]')).find((r) => r.textContent?.includes(name))!;
            await act(async () => { (row.querySelector('button') as HTMLButtonElement).click(); });
            await settle();
        };
        await inviteBy('Invite'); // Dee
        await inviteBy('Invite'); // Tom: Dee's row now reads Invite again
        expect(mem.mineReads).toBe(2);
        // Tom's invite, the second made on this screen, is in the read: his Remove offers the tick.
        await open('Tom Riley');
        expect(host.querySelector('[data-testid="contact-cancel-invite"]')).not.toBeNull();
        await press('Go back');
        await open('Dee Walker');
        expect(host.querySelector('[data-testid="contact-cancel-invite"]')).not.toBeNull();
        await press('Go back');
        // Invite again on Dee: a new code, read again; ticked, Remove cancels that new code (not the first one).
        await inviteBy('Invite again');
        expect(mem.mineReads).toBe(3);
        await open('Dee Walker');
        await act(async () => { (host.querySelector('[data-testid="contact-cancel-invite"]') as HTMLButtonElement).click(); });
        await settle();
        await press('Remove from contacts');
        await answer('Remove');
        expect(mem.sent.filter((s) => s.startsWith('DELETE')).map((s) => s.split(' ')[1].replace(`${RIVERSIDE}/api/invite/`, ''))).toEqual(['INV-TEST-0003']);
        expect((await listNow())?.contacts.map((c) => c.name)).toEqual(['Tom Riley']);
        assertNothingNamed();
        // Mutation: key the read on "someone holds an invite here" (a boolean) → mineReads stays 1 and Tom has no tick, red.
    });

    it('No: the contact stays unlinked, the invite is forgotten (not asked again), and the member is told what it means', async () => {
        await seedList((l) => putContact(l, { ...DEE, invite: { code: 'INV-TEST-0009', community: RIVERSIDE, at: new Date().toISOString() } }));
        mem.mine = [{ code: 'INV-TEST-0009', createdAt: new Date().toISOString(), usedBy: DEE_KEY, usedByCallsign: 'someone_else' }];
        await render();
        expect(text()).toContain('Is this Dee Walker?');
        await press('No');
        expect(mem.alerts.at(-1)?.[0]).toBe("Then someone else used it. If that's a problem, tell an admin.");
        const dee = (await listNow())?.contacts[0];
        expect(dee?.links).toEqual([]);
        expect(dee?.invite).toBeNull();
        expect(text()).not.toContain('Is this Dee Walker?');
        // Mutation: link on No → links holds someone_else's key, red.
    });
});
