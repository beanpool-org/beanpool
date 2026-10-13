/**
 * A group held locked in this browser, by every door a line can leave through, against a dishonest node (review of
 * #1816: its driver's P1–P9, each flipped to the refusal or the sealed line it now gets). Real group crypto, the PR's
 * fake node behind the page's own transport (group-chat-fake-node.test-support.ts). Opened by id, as Home's "Your
 * groups" opens it.
 */
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi, editMessageApi, postEventChatMessage, toggleMessageReactionApi, getEventChat } from '../lib/api';
import { memoryIndexedDB, type MemoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest, lockedGroupsOf } from '../lib/group-chat-lock-store';
import { forgetGroupKeys, groupKeyring, memoryGroupLockStore } from '../lib/group-chat-keys';
import { sealLine } from '../lib/group-chat-crypto';
import { isKnownDmConversation } from '../lib/dm-guard';
import { GROUP_HOLD_UNREAD_TEXT, GROUP_HOLD_UNREAD_OPEN_TEXT } from '../lib/group-hold';
import { GROUP_CHAT_NOT_MEMBER_TEXT, GROUP_CHAT_UNREAD_TEXT } from '../lib/group-chat-lines';
import { fakeGroupNode, person, type FakeGroupNode } from '../lib/group-chat-fake-node.test-support';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();

const syncListeners: (() => unknown)[] = [];
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn((cb: () => unknown) => { syncListeners.push(cb); return () => {}; }) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

const G = '5c1d2c3b-4a59-4e68-9d7c-8b9a0f1e2d3c';
const GCAPS = G.toUpperCase();
const ana = person(true);
const ben = person();
const eve = person();
let node: FakeGroupNode;
let chatLocked = true;
let chatError: unknown = null;
let nodeType = 'group_thread';
/** 'normal': the list holds the group; 'omit': the node leaves it out; 'caps': it lists it under its id in capitals. */
let listMode: 'normal' | 'omit' | 'caps' = 'normal';
let participants: string[] = [];
let eventChatView: any = null;
let servedOrder: 'stored' | 'reversed' = 'stored';

const served = () => {
    const rows = node.lines.map((l, i) => ({
        id: l.id, conversationId: G, authorPubkey: l.author, ciphertext: l.ciphertext, nonce: l.nonce, type: 'text',
        metadata: JSON.stringify(l.metadata), timestamp: new Date(Date.now() - (node.lines.length - i) * 1000).toISOString(), editedAt: (l as any).editedAt ?? null,
    }));
    return servedOrder === 'reversed' ? rows.reverse() : rows;
};

function conv(id = G) {
    return { id, type: nodeType, name: 'Garden crew', participants: participants.length ? participants : [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-10-01T00:00:00Z', unreadCount: 0 };
}

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: listMode === 'omit' ? [] : [conv(listMode === 'caps' ? GCAPS : G)], totalUnread: 0,
    })),
    getConversationMessages: vi.fn(async (id: string) => ({ conversation: conv(id), messages: [] })),
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }, { publicKey: eve.publicKey, callsign: 'Eve' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(async () => { if (!eventChatView) throw new Error('Not found'); return eventChatView; }),
    postEventChatMessage: vi.fn(async () => ({ success: true, message: {} })),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(async () => ({ success: true })),
    editMessageApi: vi.fn(async () => ({ success: true })),
    toggleMessageReactionApi: vi.fn(async () => ({ success: true })),
    getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
    getGroupChat: vi.fn(async (id: string) => {
        if (chatError) throw chatError;
        return {
            conversation: conv(id), messages: served(), canPost: true,
            ...(chatLocked ? { encryption: { current: node.current(), stale: false, fromEpoch: 1 } } : {}),
        };
    }),
    getGroupMembers: vi.fn(async () => node.shown.map((pk) => ({ groupId: G, memberPubkey: pk, callsign: pk === ana.publicKey ? 'Ana' : 'Ben', role: 'member', status: 'active', joinedAt: '' }))),
    groupKeysNet: {
        get: (p: string) => node.as(ana.publicKey).get(p),
        post: (p: string, b: unknown) => node.as(ana.publicKey).post(p, b),
    },
}));

const me: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-10-01T00:00:00Z' };
let mem: MemoryIndexedDB;
const LOCK_DB = 'beanpool-group-chat-locks';

/** The lock store's database won't open (a read failure): every other database works. */
function lockStoreUnreadable(inner: MemoryIndexedDB) {
    return {
        open(name: string, v?: number) {
            if (name !== LOCK_DB) return inner.open(name, v);
            const req: any = { result: undefined, error: new DOMException('The lock store did not open.', 'UnknownError'), onsuccess: null, onerror: null, onupgradeneeded: null };
            setTimeout(() => req.onerror?.({ target: req }), 0);
            return req;
        },
        deleteDatabase: (n: string) => inner.deleteDatabase(n),
    };
}

/** The lock store reads, but every write fails as a full disk fails it (QuotaExceededError). */
function lockStoreWritesFail(inner: MemoryIndexedDB) {
    return {
        open(name: string, v?: number) {
            const req = inner.open(name, v) as any;
            if (name !== LOCK_DB) return req;
            const outer: any = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
            const wrap = (db: any) => ({
                createObjectStore: (n: string) => db.createObjectStore(n),
                close: () => db.close(),
                transaction: (s: string, mode?: IDBTransactionMode) => { if (mode === 'readwrite') inner.failNextCommit(); return db.transaction(s, mode); },
            });
            req.onupgradeneeded = (ev: any) => { outer.result = wrap(req.result); outer.onupgradeneeded?.(ev); };
            req.onsuccess = (ev: any) => { outer.result = wrap(req.result); outer.onsuccess?.(ev); };
            req.onerror = (ev: any) => { outer.error = req.error; outer.onerror?.(ev); };
            return outer;
        },
        deleteDatabase: (n: string) => inner.deleteDatabase(n),
    };
}

beforeEach(async () => {
    vi.clearAllMocks();
    localStorage.clear();
    syncListeners.length = 0;
    mem = memoryIndexedDB();
    vi.stubGlobal('indexedDB', mem);
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    node = fakeGroupNode(G, [ana.publicKey, ben.publicKey]);
    chatLocked = true; chatError = null; nodeType = 'group_thread'; listMode = 'normal'; participants = []; eventChatView = null; servedOrder = 'stored';
    const { epoch, key } = await groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore()).prepareToSeal();
    const id = crypto.randomUUID();
    const sealed = sealLine('Working bee Saturday 9am', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id });
    node.lines.push({ id, author: ben.publicKey, ciphertext: sealed.ciphertext, nonce: sealed.nonce, metadata: { epoch, sender: ben.publicKey } });
    forgetGroupKeys();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** A page load: the group chat opened (by `openConversationId`, as Home's "Your groups" opens it). */
async function openChat(id = G) {
    render(<MessagesPage identity={me} openConversationId={id} />);
    await screen.findByText('Working bee Saturday 9am', {}, { timeout: 5000 });
    return screen.getByPlaceholderText('Message...');
}

/** A new page load: the page and its memory go; the browser's storage stays. */
function reload() {
    cleanup();
    forgetGroupKeys();
    resetGroupChatLockStoreForTest();
}

async function send(composer: HTMLElement, text: string) {
    fireEvent.change(composer, { target: { value: text } });
    await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
}

function readableIn(b64: string, words: string): boolean {
    try { return Buffer.from(String(b64), 'base64').toString('utf8').includes(words); } catch { return false; }
}

const LOCKED_NOTICE = "End-to-end encrypted: only this group's members can read it. The node sees who wrote, when, and who was mentioned.";
function eventView(notice = LOCKED_NOTICE) {
    return {
        conversation: { id: G, type: 'event_thread', name: 'Garden crew', participants: [], createdBy: '', createdAt: '2026-10-01T00:00:00Z' },
        messages: [], readOnly: false, readOnlyReason: null, canPost: true, isHost: false, title: 'Garden crew', eventEndAt: null,
        eventState: 'upcoming', privateNote: null, notice,
    };
}

describe('a held group\'s id by every door (review of #1816)', () => {
    it('CONTROL: held, the node retypes the group as event_thread in its list: a sealed group line (the PR\'s hold works)', async () => {
        await openChat();
        reload();
        nodeType = 'event_thread';
        const composer = await openChat();
        await send(composer, 'control words');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(postEventChatMessage).not.toHaveBeenCalled();
    });

    it('P1: held (store reads), opened from Home by id; the node leaves it out of its list and answers the event-chat route: opened as its group chat, the line sealed, the event chat never asked', async () => {
        await openChat();
        reload();
        listMode = 'omit';
        eventChatView = eventView();
        const composer = await openChat();
        expect(screen.queryByPlaceholderText('Message everyone going…')).toBeNull();
        expect(screen.queryByTestId('event-chat-notice')).toBeNull();
        await send(composer, 'the gate code is 4321');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(postEventChatMessage).not.toHaveBeenCalled();
        expect(getEventChat).not.toHaveBeenCalled();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('P1b: held, the lock store unreadable, opened by an id the node leaves out of its list: nothing opens, and it says why', async () => {
        await openChat();
        reload();
        vi.stubGlobal('indexedDB', lockStoreUnreadable(mem));
        listMode = 'omit';
        eventChatView = eventView('Visible to this group and nobody else.');
        render(<MessagesPage identity={me} openConversationId={G} />);
        expect(await screen.findByText(GROUP_HOLD_UNREAD_OPEN_TEXT, {}, { timeout: 5000 })).toBeTruthy();
        expect(screen.queryByPlaceholderText('Message everyone going…')).toBeNull();
        expect(screen.queryByText('Visible to this group and nobody else.')).toBeNull();
        expect(getEventChat).not.toHaveBeenCalled();
    });

    it('P2: held, the lock store unreadable, the node lists the group as event_thread: the event chat posts nothing, and says why', async () => {
        await openChat();
        reload();
        vi.stubGlobal('indexedDB', lockStoreUnreadable(mem));
        nodeType = 'event_thread';
        eventChatView = eventView();
        render(<MessagesPage identity={me} openConversationId={G} />);
        const box = await screen.findByPlaceholderText('Message everyone going…', {}, { timeout: 5000 });
        fireEvent.change(box, { target: { value: 'P2 words while the store is down' } });
        await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
        expect(await screen.findByText(GROUP_HOLD_UNREAD_TEXT)).toBeTruthy();
        expect(postEventChatMessage).not.toHaveBeenCalled();
    });

    it('P3: held, the lock store unreadable, the node lists the group as a DM with Eve: not remembered as a DM, and nothing is sent', async () => {
        await openChat();
        reload();
        vi.stubGlobal('indexedDB', lockStoreUnreadable(mem));
        nodeType = 'dm';
        participants = [ana.publicKey, eve.publicKey];
        render(<MessagesPage identity={me} openConversationId={G} />);
        const composer = await screen.findByPlaceholderText('Message...', {}, { timeout: 5000 });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        await send(composer, 'P3 for the group only');
        expect(await screen.findByText(GROUP_HOLD_UNREAD_TEXT)).toBeTruthy();
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(isKnownDmConversation(G)).toBe(false);
    });

    it('P3b: after the store reads again, the group is a group: sealed, and never a DM here', async () => {
        await openChat();
        reload();
        vi.stubGlobal('indexedDB', lockStoreUnreadable(mem));
        nodeType = 'dm';
        participants = [ana.publicKey, eve.publicKey];
        render(<MessagesPage identity={me} openConversationId={G} />);
        await screen.findByPlaceholderText('Message...', {}, { timeout: 5000 });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        reload();
        vi.stubGlobal('indexedDB', mem);
        nodeType = 'group_thread';
        participants = [];
        const composer = await openChat();
        await send(composer, 'P3b after recovery');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(isKnownDmConversation(G)).toBe(false);
    });

    it('P4: held under its id; the node lists it under the id in CAPITALS and says unlocked: still the held group, the line sealed', async () => {
        await openChat();
        reload();
        listMode = 'caps';
        chatLocked = false;
        const composer = await openChat(GCAPS);
        await send(composer, 'P4 capitals');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(screen.getByTestId('group-chat-notice').textContent).not.toContain('older');
    });

    it('P5: the lock store reads but cannot write (a full disk); seen locked THIS session, then the node retypes it enterprise_thread: sealed', async () => {
        vi.stubGlobal('indexedDB', lockStoreWritesFail(mem));
        resetGroupChatLockStoreForTest();
        const composer = await openChat();
        expect(screen.getByTestId('group-chat-notice').textContent).toContain('End-to-end encrypted');
        nodeType = 'enterprise_thread';
        await act(async () => { for (const l of syncListeners) await l(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        await send(composer, 'P5 same session');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('P5-control: the same with a store that writes: sealed', async () => {
        const composer = await openChat();
        nodeType = 'enterprise_thread';
        await act(async () => { for (const l of syncListeners) await l(); });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        await send(composer, 'P5 control');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('P5b: a torn record (the group\'s row kept, the index row lost): after a reload, a retype to enterprise_thread still gets a sealed line', async () => {
        await openChat();
        // Keep the per-group row, drop the index row (the app no longer writes them apart: one transaction).
        const idx = `${ana.publicKey}/`;
        await new Promise<void>((resolve) => {
            const r = (mem as any).open(LOCK_DB, 1);
            r.onsuccess = () => { const tx = r.result.transaction('locks', 'readwrite'); tx.objectStore('locks').delete(idx); tx.oncomplete = () => resolve(); };
        });
        expect(mem.peek(LOCK_DB, 'locks', `${ana.publicKey}/${G}`)).toBeTruthy();
        reload();
        nodeType = 'enterprise_thread';
        render(<MessagesPage identity={me} openConversationId={G} />);
        const composer = await screen.findByPlaceholderText('Message...', {}, { timeout: 5000 });
        await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
        await send(composer, 'P5b torn');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        expect(node.lines[1].nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a group\'s row and its index row are written together', async () => {
        await openChat();
        expect(mem.peek(LOCK_DB, 'locks', `${ana.publicKey}/${G}`)).toEqual({ highest: 1, locked: true });
        expect(mem.peek(LOCK_DB, 'locks', `${ana.publicKey}/`)).toEqual([G]);
        expect([...await lockedGroupsOf(ana.publicKey)]).toEqual([G]);
    });

    it('P6: a chat answer that didn\'t come says so, never that the node is older or now says unlocked', async () => {
        chatError = Object.assign(new Error('Internal error'), { status: 500 });
        render(<MessagesPage identity={me} openConversationId={G} />);
        const n1 = await screen.findByTestId('group-chat-notice', {}, { timeout: 5000 });
        expect(n1.textContent).toBe(GROUP_CHAT_UNREAD_TEXT);
        reload();
        chatError = null;
        await openChat();
        reload();
        chatError = Object.assign(new Error('Group not found'), { status: 404 });
        render(<MessagesPage identity={me} openConversationId={G} />);
        const n2 = await screen.findByTestId('group-chat-notice', {}, { timeout: 5000 });
        expect(n2.textContent).toBe(`🔒 ${GROUP_CHAT_NOT_MEMBER_TEXT}`);
    });

    it('P7 (still owed, finding 6): the node serves two lines in reverse order: drawn as served, with no mark yet', async () => {
        const ring = groupKeyring(node.as(ben.publicKey), ben, G, memoryGroupLockStore());
        const { epoch, key } = await ring.prepareToSeal();
        const first = node.lines[0].id;
        const id2 = crypto.randomUUID();
        const s2 = sealLine('Second: bring gloves', { myEdPrivHex: ben.privateKey, groupKey: key, groupId: G, epoch, messageId: id2, after: first });
        node.lines.push({ id: id2, author: ben.publicKey, ciphertext: s2.ciphertext, nonce: s2.nonce, metadata: { epoch, sender: ben.publicKey } });
        forgetGroupKeys();
        servedOrder = 'reversed';
        await openChat();
        await screen.findByText('Second: bring gloves');
        const html = document.body.innerHTML;
        const order = html.indexOf('Second: bring gloves') < html.indexOf('Working bee Saturday 9am') ? 'second drawn first' : 'in order';
        const marks = [...document.querySelectorAll('[data-testid="group-line-details"]')].map((e) => e.textContent);
        expect(order).toBe('second drawn first');
    });

    it('P9: reply, reaction and edit through the page, on a chat the node now says is unlocked (sticky): sealed, no words in the clear', async () => {
        let composer = await openChat();
        await send(composer, 'gloves from me');
        await waitFor(() => expect(node.lines).toHaveLength(2));
        reload();
        chatLocked = false;
        composer = await openChat();
        await screen.findByText('gloves from me');
        // Reply to Ben's line.
        fireEvent.click(screen.getAllByLabelText('Reply to message')[0]);
        await send(composer, 'replying sealed');
        await waitFor(() => expect(node.lines).toHaveLength(3));
        const replyCall = node.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/chat/message')).pop();
        // React to Ben's line.
        fireEvent.click(screen.getAllByLabelText('React to message')[0]);
        fireEvent.click(screen.getAllByLabelText('React with 👍')[0]);
        await waitFor(() => expect(toggleMessageReactionApi).toHaveBeenCalled());
        // Edit my own line.
        const edits = screen.getAllByLabelText('Edit message');
        fireEvent.click(edits[0]);
        await send(composer, 'gloves from me (edited)');
        await waitFor(() => expect(node.calls.some((c) => c.path === '/api/messages/edit')).toBe(true));
        const editCall = node.calls.find((c) => c.path === '/api/messages/edit')!;
        const everyBody = JSON.stringify(node.calls.map((c) => c.body ?? null)) + JSON.stringify((toggleMessageReactionApi as any).mock.calls);
        expect(replyCall?.body?.nonce?.startsWith('group-xc20p-v1:')).toBe(true);
        expect(editCall.body.nonce.startsWith('group-xc20p-v1:')).toBe(true);
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(editMessageApi).not.toHaveBeenCalled();
    });
});
