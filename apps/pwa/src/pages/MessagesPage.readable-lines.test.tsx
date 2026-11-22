/**
 * Readable words on the screens (lib/readable-line-table.test.ts has the check itself): a chat opened while this browser
 * knows nothing of a lock, then something of one, then Send or Save. Real lib/api.ts sends over a stubbed fetch, real group
 * crypto against the fake node, real lock store. Whatever happened between, no words reach the node readable; with nothing
 * of a lock they go as they always did.
 */
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import { encodePlaintext } from '../lib/e2e-crypto';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';
import { indexedDbGroupLockStore as store, resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, noteAnsweredLocked, resetAnsweredLockedForTest, GROUP_KEY_STORE_UNREAD_TEXT } from '../lib/group-chat-keys';
import { GROUP_CHAT_LOCK_LOST_TEXT, GROUP_CHAT_OLD_NODE_NOTICE } from '../lib/group-chat-lines';
import { GROUP_HOLD_EVENT_TEXT, readableLineTo } from '../lib/group-hold';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';
import { resetPendingChatLinesForTest } from '../lib/pending-chat-lines';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const ana = person(true);
const ben = person();
let node: FakeGroupNode;
let mem: MemoryIndexedDB;
let chatLocked = false;
let nodeType = 'group_thread';
/** Run at each read of the account: the check's own, then the request's signing. */
let onIdentity: () => void = () => {};
vi.mock('../lib/identity', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/identity')>()),
    loadIdentity: vi.fn(async () => { onIdentity(); return { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' }; }),
}));

const now = () => new Date().toISOString();
const conv = () => ({ id: G, type: nodeType, name: 'Garden crew', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 });
/** One readable line of mine, editable. */
const mine = { id: 'mine-1', conversationId: G, authorPubkey: ana.publicKey, ...encodePlaintext('my first words'), type: 'text', timestamp: now(), editedAt: null };
const eventView = () => ({
    conversation: { ...conv(), type: 'event_thread' }, messages: [{ ...mine, authorCallsign: 'Ana' }], readOnly: false, readOnlyReason: null, canPost: true, isHost: false,
    title: 'Garden crew', eventEndAt: null, eventState: 'upcoming', privateNote: null, notice: '',
});

vi.mock('../lib/api', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../lib/api')>()),
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: { get: (p: string) => node.as(ana.publicKey).get(p), post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b) },
}));

let posts: { path: string; body: string }[] = [];
/** The lines the group's chat route serves. */
let chatLines: unknown[] = [];
/** The group's chat answer, held back until let go (null: at once). */
let chatAnswerHeld: Promise<void> | null = null;

const me = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };
const LOCK_DB = 'beanpool-group-chat-locks';
let readsFail = false;
let commitsFail = false;

function browserStorage() {
    return {
        open(name: string, v?: number) {
            if (name !== LOCK_DB) return mem.open(name, v);
            if (readsFail) {
                const req: any = { result: undefined, error: new DOMException('The lock store did not open.', 'UnknownError'), onsuccess: null, onerror: null };
                setTimeout(() => req.onerror?.({ target: req }), 0);
                return req;
            }
            const req = mem.open(name, v) as any;
            const outer: any = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
            const wrap = (db: any) => ({
                createObjectStore: (n: string) => db.createObjectStore(n), close: () => db.close(),
                transaction: (s: string, mode?: IDBTransactionMode) => { if (mode === 'readwrite' && commitsFail) mem.failNextCommit(); return db.transaction(s, mode); },
            });
            req.onupgradeneeded = (ev: any) => { outer.result = wrap(req.result); outer.onupgradeneeded?.(ev); };
            req.onsuccess = (ev: any) => { outer.result = wrap(req.result); outer.onsuccess?.(ev); };
            return outer;
        },
        deleteDatabase: (n: string) => mem.deleteDatabase(n),
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetPendingChatLinesForTest();
    mem = memoryIndexedDB();
    readsFail = false; commitsFail = false; chatLocked = false; nodeType = 'group_thread'; posts = []; chatAnswerHeld = null; chatLines = [mine];
    onIdentity = () => {};
    vi.stubGlobal('indexedDB', browserStorage());
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts: RequestInit = {}) => {
        const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (opts.method === 'POST') { posts.push({ path: url, body: String(opts.body ?? '') }); return json({ success: true, message: {} }); }
        if (url.startsWith(`/api/groups/${G}/chat`)) {
            const at = chatLocked;
            if (chatAnswerHeld) await chatAnswerHeld;
            return json({ conversation: conv(), messages: chatLines, canPost: true, ...(at ? { encryption: { current: node.current(), stale: false, fromEpoch: 1 } } : {}) });
        }
        if (url.startsWith(`/api/marketplace/posts/${G}/chat`)) return json(eventView());
        if (url.startsWith(`/api/messages/${G}`)) return json({ conversation: conv(), messages: [mine] });
        return json({});
    }));
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    resetAnsweredLockedForTest();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const WORDS = 'the key is under the third pot';
const B64 = encodePlaintext(WORDS).ciphertext;
/** Every body the node was sent, by either way out. */
const wordsWent = () => [...posts.map((p) => p.body), ...node.calls.map((c) => JSON.stringify(c.body ?? ''))].filter((b) => b.includes(WORDS) || b.includes(B64));
const settle = (ms = 150) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function openIt(type: string) {
    nodeType = type;
    render(<MessagesPage identity={me} openConversationId={G} />);
    await screen.findByText('my first words', {}, { timeout: 5000 });
    await settle(30);
    return (type === 'event_thread' ? screen.getByLabelText('Message everyone going') : screen.getByPlaceholderText('Message...')) as HTMLTextAreaElement;
}

/** The words written and Enter: a new line, or, with Edit open, the edit saved. */
async function write(box: HTMLTextAreaElement) {
    fireEvent.change(box, { target: { value: WORDS } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
}
const ACTIONS = ['line', 'edit'] as const;

/** `seals`: a group's new line then goes, sealed as the group's: this tab learns of the lock, it doesn't only refuse. */
const HAPPENED: { name: string; sent: boolean; seals?: boolean; then: () => unknown }[] = [
    { name: 'nothing', sent: true, then: () => {} },
    { name: 'another tab marked it locked', sent: false, seals: true, then: () => store.markLocked(`${ana.publicKey}/${G}`) },
    { name: 'another tab held a key of it', sent: false, then: () => store.raiseHighest(`${ana.publicKey}/${G}`, 1) },
    { name: 'seen locked here, the mark refused', sent: false, seals: true, then: async () => { commitsFail = true; await groupKeyring(node.as(ana.publicKey), ana, G, store).noteLocked(); } },
    { name: 'the record stopped reading', sent: false, then: () => { readsFail = true; resetGroupChatLockStoreForTest(); } },
    { name: 'answered locked as the request is signed', sent: false, then: () => { let n = 0; onIdentity = () => { n += 1; if (n >= 2) noteAnsweredLocked(G); }; } },
];

describe('a chat open on screen, then something of a lock, then the words', () => {
    const KINDS = ['group_thread', 'enterprise_thread', 'event_thread'];
    let rows = 0;
    for (const kind of KINDS) {
        for (const action of ACTIONS) {
            // An event's chat has no edit on the web.
            if (kind === 'event_thread' && action === 'edit') continue;
            for (const h of HAPPENED) {
                rows += 1;
                it(`${kind} | ${action} | ${h.name} | ${h.sent ? 'sent readable, as ever' : 'never readable'}`, async () => {
                    const box = await openIt(kind);
                    if (action === 'edit') fireEvent.click(screen.getAllByLabelText('Edit message')[0]);
                    await act(async () => { await h.then(); });
                    await write(box);
                    if (h.sent) {
                        await waitFor(() => expect(wordsWent()).toHaveLength(1));
                        expect(posts.at(-1)!.path).toBe(kind === 'event_thread' ? `/api/marketplace/posts/${G}/chat/message` : action === 'edit' ? '/api/messages/edit' : '/api/messages/send');
                        return;
                    }
                    await settle();
                    expect(wordsWent()).toEqual([]);
                    expect(window.alert).not.toHaveBeenCalled();
                    // Sealed as the group's, or refused with the words kept where they were written.
                    const sealed = node.calls.some((c) => c.method === 'POST' && c.body?.nonce?.startsWith('group-xc20p-v1:'));
                    expect(sealed).toBe(!!h.seals && action === 'line' && kind !== 'event_thread');
                    if (!sealed) expect(box.value).toBe(WORDS);
                });
            }
        }
    }
    it('the rows are whole', () => expect(rows).toBe(30));
});

describe('what the member is told', () => {
    for (const kind of ['group_thread', 'enterprise_thread']) {
        for (const action of ACTIONS) {
            it(`${kind} | ${action}: stopped as it left: the sentence in place, the words kept, no alert; a Retry asks again`, async () => {
                const box = await openIt(kind);
                if (action === 'edit') fireEvent.click(screen.getAllByLabelText('Edit message')[0]);
                let n = 0;
                onIdentity = () => { n += 1; if (n >= 2) noteAnsweredLocked(G); };
                await write(box);
                expect(await screen.findByText(GROUP_CHAT_LOCK_LOST_TEXT)).toBeTruthy();
                expect(box.value).toBe(WORDS);
                expect(window.alert).not.toHaveBeenCalled();
                expect(wordsWent()).toEqual([]);
                // A refused line keeps its Retry, as every refused line does; the check is asked again for it.
                if (action === 'line') {
                    await act(async () => { fireEvent.click(screen.getByText('Retry')); });
                    await settle();
                    expect(wordsWent()).toEqual([]);
                    expect(screen.getByText(GROUP_CHAT_LOCK_LOST_TEXT)).toBeTruthy();
                }
            });
        }
    }

    it("an event's chat: the event's sentence, the words kept", async () => {
        const box = await openIt('event_thread');
        let n = 0;
        onIdentity = () => { n += 1; if (n >= 2) noteAnsweredLocked(G); };
        await write(box);
        expect(await screen.findByText(GROUP_HOLD_EVENT_TEXT)).toBeTruthy();
        expect(box.value).toBe(WORDS);
        expect(wordsWent()).toEqual([]);
    });

    it('a chat only seen locked: "has seen it locked", never "has held its keys"', async () => {
        await store.markLocked(`${ana.publicKey}/${G}`);
        await openItLocked();
        const notice = screen.getByTestId('group-chat-notice').textContent!;
        expect(notice).toBe(`🔒 ${GROUP_CHAT_LOCK_LOST_TEXT}`);
        expect(notice).toContain('This browser has seen it locked');
        expect(notice).not.toContain('held');
    });

    it('the record unread, the node saying unlocked: it says it couldn\'t check, never that it has seen it locked', async () => {
        readsFail = true;
        await openItLocked();
        expect(screen.getByTestId('group-chat-notice').textContent).toBe(GROUP_KEY_STORE_UNREAD_TEXT);
    });

    it('nothing of a lock: an older node, as ever', async () => {
        await openIt('group_thread');
        expect(screen.getByTestId('group-chat-notice').textContent).toBe(GROUP_CHAT_OLD_NODE_NOTICE);
    });

    /** Opened locked: the readable line is nobody's, so the notice is what says the chat is up. */
    async function openItLocked() {
        render(<MessagesPage identity={me} openConversationId={G} />);
        await screen.findByTestId('group-chat-notice', {}, { timeout: 5000 });
    }
});

describe('a locked answer is kept as seen', () => {
    it('one that lands after the member left the chat: marked, so nothing readable goes to it after a reload either', async () => {
        let letGo = () => {};
        chatAnswerHeld = new Promise<void>((r) => { letGo = r; });
        chatLocked = true;
        const { unmount } = render(<MessagesPage identity={me} openConversationId={G} />);
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith(`/api/groups/${G}/chat`))).toBe(true), { timeout: 5000 });
        // Left: the chat list is in front, and the answer is still on its way.
        await act(async () => { fireEvent.click(screen.getByLabelText('Back to chats')); });
        letGo();
        await settle();
        expect(await store.load(`${ana.publicKey}/${G}`)).toEqual({ highest: 0, locked: true });
        unmount();
    });

    it('one that lands after a Sign Out: nothing of the account that left is written back, and nothing readable goes to it', async () => {
        let letGo = () => {};
        chatAnswerHeld = new Promise<void>((r) => { letGo = r; });
        chatLocked = true;
        render(<MessagesPage identity={me} openConversationId={G} />);
        await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith(`/api/groups/${G}/chat`))).toBe(true), { timeout: 5000 });
        cleanup();
        forgetGroupKeys();
        letGo();
        await settle();
        expect(mem.dump(LOCK_DB, 'locks')).toEqual({});
        await expect(readableLineTo(G)).rejects.toMatchObject({ code: 'refused' });
    });

    it('a mark the store refused is put again while the chat is open on a node that now says unlocked', async () => {
        commitsFail = true;
        await groupKeyring(node.as(ana.publicKey), ana, G, store).noteLocked();
        expect((await store.load(`${ana.publicKey}/${G}`)).locked).toBe(false);
        commitsFail = false;
        render(<MessagesPage identity={me} openConversationId={G} />);
        await screen.findByTestId('group-chat-notice', {}, { timeout: 5000 });
        expect((await store.load(`${ana.publicKey}/${G}`)).locked).toBe(true);
    });

    it('never for a DM the node calls a locked group (its line is a DM\'s): no mark, which would keep it a group here', async () => {
        chatLocked = true;
        chatLines = [{ ...mine, ciphertext: 'AAAA', nonce: 'x25519-xc20p-v2:AAAA' }];
        render(<MessagesPage identity={me} openConversationId={G} />);
        await waitFor(() => expect(JSON.parse(localStorage.getItem('beanpool_dm_conversations_seen') ?? '[]')).toEqual([G]), { timeout: 5000 });
        await settle();
        expect(await store.load(`${ana.publicKey}/${G}`)).toEqual({ highest: 0, locked: false });
        expect(screen.queryByTestId('group-chat-notice')).toBeNull();
    });
});
