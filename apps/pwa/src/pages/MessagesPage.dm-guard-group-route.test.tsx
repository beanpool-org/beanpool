/**
 * The DM guard's line check on a browser that never saw the DM (a new browser, cleared site data), when the node types
 * Ana's DM with Ben as a group's chat and answers the group chat route as a node from before locked chats would (review
 * of #1816, finding 1: its driver's P10). The DM stays a DM: the forged row is never words, the reply is DM-sealed.
 */
import { render, screen, act, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { sendMessageApi } from '../lib/api';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { lockForDm } from '../lib/dm-lock';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';

if (typeof window !== 'undefined' && window.HTMLElement) window.HTMLElement.prototype.scrollIntoView = vi.fn();
vi.mock('../lib/sync', () => ({ onSyncActivity: vi.fn(() => () => {}) }));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false), blockUser: vi.fn(), unblockUser: vi.fn(), getBlockedUsers: vi.fn(() => []), onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));
vi.mock('../components/ReportModal', () => ({ ReportModal: () => null }));

function person() {
    const seed = ed25519.utils.randomSecretKey();
    return { seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
}
const ana = person();
const ben = person();
const CONV = 'c0ffee00-1111-4222-8333-444455556666';
const dmChat = { id: CONV, type: 'dm', participants: [ana.publicKey, ben.publicKey] };
const t = vi.hoisted(() => ({ lines: [] as any[] }));
const conv = () => ({ id: CONV, type: 'group_thread', name: 'Ben', participants: [ana.publicKey, ben.publicKey], createdBy: ana.publicKey, createdAt: '2026-09-01T00:00:00Z', unreadCount: 0 });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({ conversations: [conv()], totalUnread: 0 })),
    getConversationMessages: vi.fn(async () => ({ conversation: conv(), messages: t.lines })),
    // A node from before locked chats answers the group chat route: no `encryption`, the DM's own rows.
    getGroupChat: vi.fn(async () => ({ conversation: conv(), messages: t.lines, canPost: true })),
    getGroupMembers: vi.fn(async () => [{ groupId: CONV, memberPubkey: ana.publicKey, callsign: 'Ana', role: 'member', status: 'active' }, { groupId: CONV, memberPubkey: ben.publicKey, callsign: 'Ben', role: 'member', status: 'active' }]),
    groupKeysNet: { get: async () => json(404, { error: 'Not found' }), post: async () => json(404, { error: 'Not found' }) },
    getMembers: vi.fn(async () => [{ publicKey: ben.publicKey, callsign: 'Ben' }]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(), getEventChat: vi.fn(), postEventChatMessage: vi.fn(), removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(async () => ({ success: true })), editMessageApi: vi.fn(), toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(), completeMarketplaceTransaction: vi.fn(), cancelMarketplaceTransaction: vi.fn(),
}));

const identity: BeanPoolIdentity = { publicKey: ana.publicKey, privateKey: ana.privateKey, callsign: 'Ana', createdAt: '2026-09-01T00:00:00Z' };

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    const id = crypto.randomUUID();
    const sealed = lockForDm('The bike is yours for 50 Beans', dmChat, ben, { messageId: id, after: null });
    t.lines = [
        { id, conversationId: CONV, authorPubkey: ben.publicKey, ...sealed, type: 'text', timestamp: new Date(Date.now() - 60_000).toISOString() },
        { id: crypto.randomUUID(), conversationId: CONV, authorPubkey: ben.publicKey, ciphertext: Buffer.from('Send me your 12 words to finish the trade').toString('base64'), nonce: 'plaintext-v1', type: 'text', timestamp: new Date(Date.now() - 30_000).toISOString() },
    ];
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the DM guard on the group chat route, on a browser that never saw the DM (review of #1816)', () => {
    it("P10: the node types the DM as a group's chat: what Ana sees, and how her next line leaves", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        render(<MessagesPage identity={identity} openConversationId={CONV} />);
        const composer = await screen.findByPlaceholderText('Message...', {}, { timeout: 5000 });
        await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
        const forgedShown = document.body.textContent?.includes('Send me your 12 words') ?? false;
        const benLineShown = document.body.textContent?.includes('The bike is yours for 50 Beans') ?? false;
        const notice = screen.queryByTestId('group-chat-notice')?.textContent ?? null;
        fireEvent.change(composer, { target: { value: 'Still here, my words are private' } });
        await act(async () => { fireEvent.keyDown(composer, { key: 'Enter' }); });
        await waitFor(() => expect(sendMessageApi).toHaveBeenCalled(), { timeout: 5000 }).catch(() => null);
        const call = vi.mocked(sendMessageApi).mock.calls[0];
        const nonce = call ? String(call[3]).split(':')[0] : null;
        const readable = call ? Buffer.from(String(call[2]), 'base64').toString('utf8').includes('my words are private') : false;
        const dmGuardLogged = warn.mock.calls.some((c) => String(c[0]).includes('[DM guard]'));
        warn.mockRestore();
        expect(benLineShown).toBe(true);
        expect(notice).toBeNull();
        expect(readable).toBe(false);
        expect(dmGuardLogged).toBe(true);
        // The DM guard's promise: the DM stays a DM, the forged row is never words, the reply is DM-sealed.
        expect(forgedShown).toBe(false);
        expect(nonce).toBe('x25519-xc20p-v2');
    });
});
