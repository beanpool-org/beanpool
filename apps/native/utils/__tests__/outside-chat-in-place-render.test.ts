// @vitest-environment jsdom
/**
 * An across chat opened in place (slice S4, #3310 r3 review F1 and F5): app/outside-chat/[id].tsx rendered for real with
 * `community` naming A, the community whose file and mailbox carry the chat, while the phone is set to B; and the same chat
 * opened while set to A. The context, the rounds (utils/outside-chat-live.ts) and the block list (utils/blocklist.ts) are the
 * real ones, over in-memory storage and a stubbed network; what the mailbox calls send is recorded with the server they name.
 *
 * Close the class: every action the screen offers (Block, Report, mute, unmute, delete, reply) x {in place, set to A} is a
 * row that says which servers are told. Every mailbox request goes to A, and A is told the action. A block is the account's,
 * so the community in use hears it as well (B, in place), but never B alone: A's mailbox holds and rings that key's lines
 * (server engine/relay-mail.ts), so A is told the block and makes the key quiet (review F1).
 *
 * And the screen holds A in place before its first read (review F5, M14), its bell tells A (M15), and a block whose answer
 * from A never came is sent there again at A's next round (F1, offline).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as any).__DEV__ = false;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const A = 'https://riverside.example';
const B = 'https://hilltop.example';
const ME = { publicKey: 'a1'.repeat(32), privateKey: 'c3'.repeat(32) };

/** What the phone asked of each server: every request, by its origin. And the dialogs the screen opened. */
const net = vi.hoisted(() => ({
    asked: [] as Array<{ origin: string; method: string; path: string; body?: any }>,
    /** Origins whose block requests fail as if offline. */
    offlineBlocks: new Set<string>(),
}));
const ui = vi.hoisted(() => ({ alerts: [] as Array<{ title: string; buttons: Array<{ text?: string; onPress?: () => unknown }> }> }));
/** The screen's route params, and what each community's file saw: the copy held in place, its reads and its writes. */
const files = vi.hoisted(() => ({
    params: {} as Record<string, string>,
    events: [] as string[],
    decided: [] as Array<{ community: string; state: string }>,
    meta: new Map<string, string>(),
    chat: null as any,
    lines: [] as any[],
}));
const mem = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('react-native', () => {
    const el = (tag: string) => function Host(props: Record<string, any>) {
        const { children, onPress, accessibilityLabel, accessibilityState, testID, value, onChangeText, disabled, onLayout } = props;
        useEffect(() => { onLayout?.({ nativeEvent: { layout: { x: 0, y: 0, width: 288, height: 40 } } }); }, []);
        const attrs: Record<string, unknown> = {};
        if (testID) attrs['data-testid'] = testID;
        if (onPress && !disabled) attrs.onClick = (e: { stopPropagation(): void }) => { e.stopPropagation(); onPress({ stopPropagation() {}, nativeEvent: {} }); };
        if (onChangeText) { attrs.onChange = (e: { target: { value: string } }) => onChangeText(e.target.value); attrs.value = value ?? ''; }
        if (accessibilityLabel) attrs['aria-label'] = accessibilityLabel;
        if (accessibilityState?.selected !== undefined) attrs['aria-selected'] = String(!!accessibilityState.selected);
        return createElement(tag, attrs, children);
    };
    const FlatList = ({ data, renderItem, keyExtractor, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }: Record<string, any>) => createElement('div', null,
        ListHeaderComponent,
        (data ?? []).length
            ? data.map((item: any, index: number) => createElement(Fragment, { key: keyExtractor ? keyExtractor(item, index) : index }, renderItem({ item, index })))
            : ListEmptyComponent,
        ListFooterComponent);
    const listener = () => ({ remove() {} });
    return {
        Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
        ActivityIndicator: () => createElement('span', { 'data-spinner': 'true' }),
        View: el('div'), Text: el('span'), Pressable: el('button'), ScrollView: el('div'), TextInput: el('input'), FlatList,
        Modal: ({ visible, children }: { visible: boolean; children?: unknown }) => (visible ? createElement('div', { 'data-modal': 'true' }, children as any) : null),
        StyleSheet: { create: (s: unknown) => s, hairlineWidth: 1, absoluteFill: {}, absoluteFillObject: {}, flatten: (s: unknown) => s },
        Alert: { alert: () => {} },
        Keyboard: { addListener: listener, dismiss() {} },
        DeviceEventEmitter: { addListener: listener, emit() {} },
        AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
        Dimensions: { get: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }) },
        useWindowDimensions: () => ({ width: 320, height: 569, scale: 1.5, fontScale: 1.3 }),
        I18nManager: { getConstants: () => ({ localeIdentifier: 'en_US' }), allowRTL: () => {}, forceRTL: () => {} },
        NativeModules: {},
    };
});
vi.mock('expo-router', async () => {
    const { useEffect: effect } = await import('react');
    return {
        router: { push() {}, navigate() {}, replace() {}, back() {}, canGoBack: () => true },
        // Focus comes a moment after the first draw, as on a phone (and outside React's commit).
        useFocusEffect: (cb: () => void | (() => void)) => effect(() => {
            let undo: void | (() => void);
            const timer = setTimeout(() => { undo = cb(); }, 0);
            return () => { clearTimeout(timer); if (typeof undo === 'function') undo(); };
        }, [cb]),
        useLocalSearchParams: () => files.params,
    };
});
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.map.set(k, String(v)); }),
        removeItem: vi.fn(async (k: string) => { mem.map.delete(k); }),
        getAllKeys: vi.fn(async () => [...mem.map.keys()]),
        multiRemove: vi.fn(async (ks: string[]) => { for (const k of ks) mem.map.delete(k); }),
    },
}));
vi.mock('expo-secure-store', () => ({ getItemAsync: async () => null, setItemAsync: async () => {}, deleteItemAsync: async () => {}, WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1 }));
vi.mock('expo-crypto', async () => {
    const { randomBytes, randomUUID } = await import('node:crypto');
    return { getRandomBytes: (n: number) => new Uint8Array(randomBytes(n)), randomUUID };
});
vi.mock('expo-constants', () => ({ default: { expoConfig: undefined } }));
vi.mock('@expo/vector-icons', () => ({ MaterialCommunityIcons: ({ name }: { name: string }) => createElement('i', { 'data-icon': name }) }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
    SafeAreaView: ({ children }: { children?: unknown }) => createElement('div', null, children as any),
}));
vi.mock('react-native-keyboard-controller', () => {
    const pass = ({ children }: { children?: unknown }) => createElement('div', null, children as any);
    return { KeyboardAvoidingView: pass, KeyboardAwareScrollView: pass, KeyboardController: { dismiss: async () => {} }, useKeyboardState: () => false };
});
vi.mock('../../app/ThemeContext', async () => {
    const { lightColors } = await import('../../constants/colors');
    return {
        useTheme: () => ({ theme: 'light', colors: lightColors }),
        useStyles: (make: (t: { theme: string; colors: unknown; patternEnabled: boolean }) => unknown) => make({ theme: 'light', colors: lightColors, patternEnabled: false }),
    };
});
// A dialog the screen opens: kept, so a row presses the button it names.
vi.mock('../keyboard-alert', () => ({
    Alert: { alert: (title: string, _body?: string, buttons?: Array<{ text?: string; onPress?: () => unknown }>) => { ui.alerts.push({ title, buttons: buttons ?? [] }); } },
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => ({ ...ME, callsign: 'Me' })) }));
vi.mock('../crypto', () => ({ buildSignedHeaders: async () => ({}) }));
// Every community here takes messages from other communities.
vi.mock('../node-profile', () => ({
    getCachedNodeProfile: async () => ({ features: { outsideMessages: true } }),
    fetchNodeProfile: async () => ({ features: { outsideMessages: true } }),
    outsideMessagesOn: (f?: { outsideMessages?: boolean }) => !!f?.outsideMessages,
}));
const originOf = (url: string) => new URL(url).origin.toLowerCase();
// The phone holds A and B as a member; each has its own file, named by its address however spelled.
vi.mock('../nodes', () => ({
    getDatabaseFilenameForNode: (url?: string | null) => (url ? `beanpool_${new URL(url).host.toLowerCase()}.db` : 'beanpool.db'),
    getSavedNodes: async () => [{ url: A }, { url: B }],
    isGuestCopy: async () => false,
    isGuestNode: async () => false,
}));
// Each community's file, as the across store reads and writes it: A's carries the chat; B's has none of it.
vi.mock('../db', () => {
    const storeOf = (community: string) => ({
        chat: async () => { files.events.push(`read ${community}`); return community === originOf(A) ? files.chat : null; },
        lines: async () => (community === originOf(A) ? files.lines : []),
        changes: async () => [],
        decide: async (_me: string, _id: string, state: string) => { files.decided.push({ community, state }); },
        getMeta: async (k: string) => files.meta.get(`${community} ${k}`) ?? null,
        setMeta: async (k: string, v: string) => { files.meta.set(`${community} ${k}`, v); },
    });
    return {
        enterChatInPlace: (c: string) => { files.events.push(`enter ${originOf(c)}`); },
        leaveChatInPlace: async (c: string) => { files.events.push(`leave ${originOf(c)}`); },
        outsideStore: (anchor: string) => storeOf(originOf(anchor)),
        outsideStoreOf: (url: string) => storeOf(originOf(url)),
    };
});
// The mailbox calls the screen makes, recorded with the server their context names (what each sends is outside-mail.test.ts's).
// The quiet mark (setOutsideQuiet, outsideQuiet) is the real one: its request goes through the stubbed network.
vi.mock('../outside-mail', async (importOriginal) => {
    const real = await importOriginal<typeof import('../outside-mail')>();
    const told = (ctx: { nodeUrl: string }, method: string, path: string, body?: unknown) => { net.asked.push({ origin: originOf(ctx.nodeUrl), method, path, body }); };
    return {
        ...real,
        sendFromBox: async (ctx: any, _chat: string, words: string, _ms: number, onKept: () => void) => { told(ctx, 'POST', '/api/mail/send', { reply: words }); onKept(); return { kept: true, error: null }; },
        sendOutsideChange: async (ctx: any, _chat: string, c: any) => { told(ctx, 'POST', '/api/mail/send', c); },
        reportOutsideLine: async (ctx: any, lineId: string, reason: string) => { told(ctx, 'POST', '/api/mail/report', { lineId, reason }); },
        syncOutsideMail: async (ctx: any) => { told(ctx, 'GET', '/api/mail'); return { written: 0, requests: 0, ticks: 0 }; },
        failUnsent: async () => 0,
    };
});

import OutsideChatScreen from '../../app/outside-chat/[id]';
// Loaded before any screen asks for it (the context reads it by a dynamic import).
import '../db';
import { blockSyncsEndedForTests } from '../blocklist';
import { syncOutsideMailNow } from '../outside-chat-live';

const CHAT = 'aaaaaaaa-0000-4000-8000-000000000001';
const THEIRS = 'bbbbbbbb-0000-4000-8000-000000000001';
const MINE = 'bbbbbbbb-0000-4000-8000-000000000002';
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
let peerN = 0;
/** A fresh person for each row: their key, as every community spells it. */
const freshPeer = () => (++peerN).toString(16).padStart(2, '0').repeat(32);

let host: HTMLDivElement;
let root: Root;
let peer: string;

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    net.asked = [];
    net.offlineBlocks.clear();
    ui.alerts = [];
    files.events = [];
    files.decided = [];
    files.meta.clear();
    mem.map.clear();
    peer = freshPeer();
    files.chat = { id: CHAT, peerKey: peer, peerHome: 'faraway.example', peerName: 'Pia', state: 'open', restored: false, updatedAt: Date.now(), lastText: null, lastAt: null };
    files.lines = [
        { id: THEIRS, chatId: CHAT, author: peer, text: 'Bikes at 3', replyTo: null, at: Date.now() - 2_000, state: null, note: null },
        { id: MINE, chatId: CHAT, author: ME.publicKey, text: 'See you there', replyTo: null, at: Date.now() - 1_000, state: 'delivered', note: null },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        net.asked.push({ origin: url.origin, method: init?.method ?? 'GET', path: url.pathname, body });
        if (url.pathname.startsWith('/api/blocks') && net.offlineBlocks.has(url.origin)) throw new TypeError('Network request failed');
        const answer = url.pathname === '/api/blocks'
            ? { success: true, blocked: [...(body?.targetPubkeys ?? [body?.targetPubkey])].filter(Boolean).map((publicKey: string) => ({ publicKey, blockedAt: 'x' })) }
            : url.pathname === '/api/mail/quiet' ? { quiet: body?.quiet } : {};
        return new Response(JSON.stringify(answer), { status: 200 });
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => { root.unmount(); });
    host.remove();
    await blockSyncsEndedForTests();
    vi.unstubAllGlobals();
});

/** The phone set to `setTo`; the chat opened from Chats, in place (with `community`) when that is not A. */
async function open(setTo: string): Promise<void> {
    mem.map.set('beanpool_anchor_url', setTo);
    files.params = setTo === A ? { id: CHAT } : { id: CHAT, community: A };
    await act(async () => { root.render(createElement(OutsideChatScreen)); });
    await settle();
    expect(host.textContent, 'the chat is drawn from A\'s file').toContain('Bikes at 3');
    net.asked = [];
}
const byTest = (id: string) => Array.from(host.querySelectorAll(`[data-testid="${id}"]`)) as HTMLElement[];
const click = async (el: Element | null | undefined) => {
    expect(el, 'the button is there').toBeTruthy();
    await act(async () => { (el as HTMLElement).click(); });
    await settle();
};
/** Presses the button named `text` on the newest dialog. */
const press = async (text: string) => {
    const button = ui.alerts.at(-1)?.buttons.find((b) => b.text === text);
    expect(button, `the dialog offers ${text}`).toBeTruthy();
    await act(async () => { await button!.onPress?.(); });
    await settle();
};
const setBox = async (words: string) => {
    const box = byTest('outside-chat-input')[0] as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => { set.call(box, words); box.dispatchEvent(new Event('input', { bubbles: true })); });
};

interface Row {
    /** What the member does on the screen. */
    act: () => Promise<void>;
    /** What A must be told: method and path. */
    toA: string[];
    /** What A's file must hold after: the chat's state, the quiet mark. */
    declined?: boolean;
    quiet?: boolean;
}
const ROWS: Record<string, Row> = {
    Block: {
        act: async () => { await click(host.querySelector(`[aria-label="Block Pia"]`)); await press('Block'); await blockSyncsEndedForTests(); },
        toA: ['POST /api/blocks', 'POST /api/mail/quiet'], declined: true, quiet: true,
    },
    Report: {
        act: async () => {
            await click(byTest('outside-line-theirs')[0]);
            await click(byTest('outside-line-report')[0]);
            const sheet = host.querySelector('[data-modal="true"]') as HTMLElement;
            await click(Array.from(sheet.querySelectorAll('button')).find((b) => b.textContent === 'Spam or scam'));
            await click(sheet.querySelector('[aria-label="Submit report"]'));
            await blockSyncsEndedForTests();
        },
        toA: ['POST /api/mail/report', 'POST /api/blocks', 'POST /api/mail/quiet'], declined: true, quiet: true,
    },
    mute: { act: async () => { await click(byTest('outside-chat-quiet')[0]); }, toA: ['POST /api/mail/quiet'], quiet: true },
    unmute: {
        act: async () => { await click(byTest('outside-chat-quiet')[0]); await click(byTest('outside-chat-quiet')[0]); },
        toA: ['POST /api/mail/quiet', 'POST /api/mail/quiet'], quiet: false,
    },
    delete: { act: async () => { await click(byTest('outside-line-mine')[0]); await click(byTest('outside-line-delete')[0]); await press('Delete'); }, toA: ['POST /api/mail/send'] },
    reply: { act: async () => { await setBox('from wherever I am'); await click(byTest('outside-chat-send')[0]); }, toA: ['POST /api/mail/send'] },
};

describe('every action on an across chat tells A, the community that carries it, wherever the phone is set (#3310 r3 F1, F5)', () => {
    const PLACES: Array<[string, string]> = [['opened in place, the phone set to B', B], ['the phone set to A', A]];
    const cases = Object.keys(ROWS).flatMap((name) => PLACES.map(([place, setTo]) => [name, place, setTo] as const));
    it.each(cases)('%s, %s', async (name, _place, setTo) => {
        const row = ROWS[name];
        await open(setTo);
        await row.act();
        const a = originOf(A);
        const b = originOf(B);
        const toA = net.asked.filter((r) => r.origin === a).map((r) => `${r.method} ${r.path}`);
        // A is told the action.
        for (const want of row.toA) expect(toA, `${name}: A told ${want}`).toContain(want);
        // Every mailbox request went to A: none to B, the community in use.
        for (const r of net.asked.filter((x) => x.path.startsWith('/api/mail'))) expect(r.origin, `${r.method} ${r.path}`).toBe(a);
        // B hears only the account's block (in place), never instead of A.
        for (const r of net.asked.filter((x) => x.origin === b)) expect(`${r.method} ${r.path}`, 'B hears the block only').toBe('POST /api/blocks');
        expect(net.asked.every((r) => r.origin === a || r.origin === b), 'no other server').toBe(true);
        // A block names the person and the key quiet there is theirs.
        for (const r of net.asked.filter((x) => x.path === '/api/blocks')) expect(r.body?.targetPubkey ?? r.body?.targetPubkeys?.[0]).toBe(peer);
        for (const r of net.asked.filter((x) => x.path === '/api/mail/quiet')) expect(r.body?.key).toBe(peer);
        // What A's file holds after; B's file is never written.
        if (row.declined) expect(files.decided).toEqual([{ community: a, state: 'declined' }]);
        else expect(files.decided).toEqual([]);
        if (row.quiet !== undefined) expect(files.meta.get(`${a} quiet:${ME.publicKey}:${peer}`)).toBe(row.quiet ? '1' : '0');
        expect([...files.meta.keys()].some((k) => k.startsWith(`${b} `)), 'nothing written in B\'s file').toBe(false);
    });
});

describe('the screen in place holds A, and its own rounds go to A (#3310 r3 F5, M14)', () => {
    it('opened in place: A is held before the chat\'s first read, its round asks A, and A is let go as the screen goes', async () => {
        mem.map.set('beanpool_anchor_url', B);
        files.params = { id: CHAT, community: A };
        await act(async () => { root.render(createElement(OutsideChatScreen)); });
        await settle();
        const a = originOf(A);
        const firstRead = files.events.indexOf(`read ${a}`);
        expect(firstRead, 'the chat was read from A\'s file').toBeGreaterThanOrEqual(0);
        expect(files.events.slice(0, firstRead), 'A held in place before its first read').toContain(`enter ${a}`);
        expect(files.events.some((e) => e.startsWith('read ') && e !== `read ${a}`), 'no other file read').toBe(false);
        expect(net.asked.some((r) => r.origin === a && r.path === '/api/mail'), 'the screen\'s round asked A').toBe(true);
        expect(net.asked.filter((r) => r.path === '/api/mail').every((r) => r.origin === a)).toBe(true);
        await act(async () => { root.unmount(); });
        await settle();
        const enters = files.events.filter((e) => e === `enter ${a}`).length;
        const leaves = files.events.filter((e) => e === `leave ${a}`).length;
        expect(leaves, 'every hold of A let go').toBe(enters);
        root = createRoot(host);
    });

    it('opened while set to A: nothing is held in place', async () => {
        await open(A);
        expect(files.events.some((e) => e.startsWith('enter ')), 'nothing held in place').toBe(false);
    });
});

describe('a block in place whose answer from A never came is sent to A again at A\'s next round (#3310 r3 F1, offline)', () => {
    it('Block while A can\'t be reached for it: A\'s round sends it; a round with nothing owed sends nothing', async () => {
        await open(B);
        net.offlineBlocks.add(originOf(A));
        await click(host.querySelector(`[aria-label="Block Pia"]`));
        await press('Block');
        await blockSyncsEndedForTests();
        const a = originOf(A);
        const triedA = net.asked.filter((r) => r.origin === a && r.path === '/api/blocks').length;
        expect(triedA, 'the block went to A, and got no answer').toBe(1);
        // Back online: A's next round (Chat as it opens, the background task, a ring) sends it again.
        net.offlineBlocks.clear();
        net.asked = [];
        await syncOutsideMailNow(10_000, A);
        await settle();
        await blockSyncsEndedForTests();
        const again = net.asked.filter((r) => r.origin === a && r.path === '/api/blocks');
        expect(again.map((r) => r.body?.targetPubkey ?? r.body?.targetPubkeys?.[0]), 'sent to A again').toEqual([peer]);
        // Answered now: the next round of A sends no block.
        net.asked = [];
        await syncOutsideMailNow(10_000, A);
        await settle();
        await blockSyncsEndedForTests();
        expect(net.asked.filter((r) => r.path === '/api/blocks'), 'nothing owed, nothing sent').toEqual([]);
    });
});
