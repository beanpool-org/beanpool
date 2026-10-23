import { render, screen, act, waitFor, cleanup, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { toEd25519Pkcs8 } from '@beanpool/core';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import type { ApiMessage } from '../lib/api';
import { decideMessageRequest, ignoreAllMessageRequests, getMessageAttachmentApi, sendMessageApi, toggleMessageReactionApi, createConversationApi } from '../lib/api';
import { blockUser } from '../lib/blocklist';
import { lockForDm } from '../lib/dm-lock';
import { memoryIndexedDB } from '../lib/memory-indexeddb';
import { resetGroupChatLockStoreForTest } from '../lib/group-chat-lock-store';
import { forgetGroupKeys } from '../lib/group-chat-keys';

// Message requests in the web app (DESIGN-message-a-friend-fable.md §4, slice S3), against the server's answers as PR #2392
// gives them at 7d20c62d: every listing, read and refusal below was captured from that server on localhost (an open, a first
// line, both people's lists and reads, accept, ignore, ignore all, the refusals) and only its keys, ids and times are this
// suite's own. Real encryption, no crypto mocks: each line is sealed by this app's lib/dm-lock.ts as MessagesPage sends one.

if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}
const doorbell = vi.hoisted(() => ({ listeners: [] as Array<() => void | Promise<void>> }));
vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => void | Promise<void>) => {
        doorbell.listeners.push(cb);
        return () => { doorbell.listeners = doorbell.listeners.filter(l => l !== cb); };
    }),
}));
vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(async () => true),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));
vi.mock('../lib/archetypes', () => ({ consumeChatPrefill: vi.fn(() => null) }));
vi.mock('../components/ReportModal', () => ({
    ReportModal: ({ targetName }: { targetName: string }) => <div data-testid="report-modal">{targetName}</div>,
}));
vi.mock('../lib/avatar', () => ({ resolveAvatarUrl: vi.fn((url) => url) }));

/** The node: each member's list, and each conversation as GET /api/messages/:id reads it. */
const node = vi.hoisted(() => ({ list: null as any, reads: {} as Record<string, { conversation: any; messages: any[] }>, gates: {} as Record<string, Promise<void> | undefined> }));
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => node.list),
    getConversationMessages: vi.fn(async (id: string) => {
        if (node.gates[id]) await node.gates[id];
        const read = node.reads[id];
        if (!read) throw Object.assign(new Error('Conversation not found'), { status: 404 });
        return read;
    }),
    getGroupChat: vi.fn(async () => { throw Object.assign(new Error('Not found'), { status: 404 }); }),
    getGroupMembers: vi.fn(async () => []),
    groupKeysNet: {
        get: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
        post: async () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }),
    },
    getMembers: vi.fn(async () => []),
    getFriends: vi.fn(async () => []),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(async () => { throw new Error('a photo in a request must not be fetched'); }),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
    decideMessageRequest: vi.fn(),
    ignoreAllMessageRequests: vi.fn(),
}));

function person(name: string) {
    const seed = ed25519.utils.randomSecretKey();
    return { name, seed, publicKey: bytesToHex(ed25519.getPublicKey(seed)), privateKey: bytesToHex(toEd25519Pkcs8(seed)) };
}
const ann = person('Ann');   // the person messaged
const bo = person('Bo');     // a stranger to her, who wrote first
const idOf = (p: typeof ann): BeanPoolIdentity => ({ publicKey: p.publicKey, privateKey: p.privateKey, callsign: p.name, createdAt: '2026-09-01T00:00:00Z' });

const CONV = '4c84e75a-0d3f-4a0e-99f1-dd9dfc2c19fc';
const OPENED_AT = '2026-10-23T01:31:26.614Z';
const REQUESTED_AT = '2026-10-23T01:31:26.627Z';   // the request is made by Bo's line (#2392: the 30 days run from it)
const LINE_AT = '2026-10-23T01:31:26.628Z';
const chat = { id: CONV, type: 'dm', participants: [ann.publicKey, bo.publicKey] };
const pending = (from = bo.publicKey) => ({ state: 'pending', from, at: REQUESTED_AT });
/** Bo's own view of his request: the node says whether his next line is its line, by its own count (PR #2404 review 4356625513). */
const mine = (nextLineIsRequest: boolean) => ({ ...pending(), nextLineIsRequest });
const picture = () => new File([new Uint8Array(1)], 'shot.png', { type: 'image/png' });
const clipboardWith = (file: File) => ({ files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }], types: ['Files'] });

/** Bo's line as this app sends it (lib/dm-lock.ts), as the node stores and serves it (#2392's GET /api/messages/:id row). */
function line(from: typeof ann, text: string, at = LINE_AT, extra: Partial<ApiMessage> = {}): ApiMessage {
    const id = crypto.randomUUID();
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...lockForDm(text, chat, from, { messageId: id, after: null }),
        type: 'text', systemType: null, metadata: null, timestamp: at, editedAt: null, updatedAt: at, ...extra,
    } as unknown as ApiMessage;
}
/** A photo with its caption, sealed as MessagesPage's handleSendImage seals one. */
function photo(from: typeof ann, caption: string): ApiMessage {
    const id = crypto.randomUUID();
    return {
        id, conversationId: CONV, authorPubkey: from.publicKey, ...lockForDm(caption, chat, from, { messageId: id, part: 'body', after: null }),
        type: 'image', systemType: null, metadata: null, timestamp: LINE_AT, editedAt: null, updatedAt: LINE_AT,
    } as unknown as ApiMessage;
}

/** Ann's list with Bo's request waiting (#2392 annList), and `extra` more requests after it. */
function annListWith(entries: any[], count = entries.length) {
    return { conversations: [], totalUnread: 0, deletedAccounts: [], requests: { count, conversations: entries } };
}
function requestEntry(from: typeof ann, conv: string, extra: Record<string, unknown> = {}) {
    return {
        id: conv, type: 'dm', postId: null, postTitle: null, postStatus: 'active', postPhoto: null, lastMsgType: 'text', lastSysType: null,
        name: null, createdBy: from.publicKey, createdAt: OPENED_AT, participants: [ann.publicKey, from.publicKey],
        peerCallsign: from.name, peerAvatar: null, peerLastReadAt: null, myLastReadAt: null,
        request: { state: 'pending', from: from.publicKey, at: REQUESTED_AT }, addedYou: false, unreadCount: 1, mute: null, ...extra,
    };
}
/** A conversation as GET /api/messages/:id reads it to `reader` (#2392 annReadsRequest / openerReads). */
function readOf(request: any, messages: ApiMessage[]) {
    return {
        conversation: {
            id: CONV, type: 'dm', postId: null, postTitle: null, postStatus: 'active', name: null, createdBy: bo.publicKey, createdAt: OPENED_AT,
            participants: [ann.publicKey, bo.publicKey],
            readCursors: [{ publicKey: ann.publicKey, lastReadAt: null }, { publicKey: bo.publicKey, lastReadAt: null }],
            request,
        },
        messages,
    };
}
/** Bo's own list with his request in it (#2392 openerList): an ordinary row, marked with its request. */
function boList(request: any) {
    return {
        conversations: [{
            id: CONV, type: 'dm', postId: null, postTitle: null, postStatus: 'active', postPhoto: null, lastMsgType: 'text', lastSysType: null,
            name: null, createdBy: bo.publicKey, createdAt: OPENED_AT, participants: [ann.publicKey, bo.publicKey],
            peerCallsign: 'Ann', peerAvatar: null, peerLastReadAt: null, myLastReadAt: null, request, unreadCount: 0, mute: null,
        }],
        totalUnread: 0, deletedAccounts: [], requests: { count: 0, conversations: [] },
    };
}

const ACCEPTED = { success: true, request: { state: 'accepted', from: bo.publicKey, at: REQUESTED_AT } };
const IGNORED = { success: true, request: { state: 'ignored', from: bo.publicKey, at: REQUESTED_AT } };
const WAITING_WORDS = 'Your first message is waiting for Ann. You can write more once they accept it.';
const STANDBY_WORDS = 'This server is a standby copy of the community, not its main server. Message requests are answered on the main server.';
const OFFLINE = 'Connect to your community to accept or ignore.';

async function ringDoorbell(): Promise<void> {
    await act(async () => { await Promise.all(doorbell.listeners.map(l => l())); });
}
const chips = () => screen.findByTestId('conversation-filter-chips');
async function openRequests(): Promise<HTMLElement> {
    fireEvent.click(await within(await chips()).findByRole('button', { name: /Requests/ }));
    return screen.findByTestId('message-requests');
}

beforeEach(() => {
    vi.stubGlobal('indexedDB', memoryIndexedDB());
    resetGroupChatLockStoreForTest();
    forgetGroupKeys();
    doorbell.listeners = [];
    node.reads = {};
    node.gates = {};
    vi.mocked(decideMessageRequest).mockReset();
    vi.mocked(ignoreAllMessageRequests).mockReset();
    vi.mocked(blockUser).mockClear();
    vi.mocked(getMessageAttachmentApi).mockClear();
    vi.mocked(sendMessageApi).mockReset();
    vi.mocked(toggleMessageReactionApi).mockReset();
    vi.mocked(createConversationApi).mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the Requests pill', () => {
    it('shows how many people want to message you, apart from the unread counts', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        render(<MessagesPage identity={idOf(ann)} />);
        const pill = await within(await chips()).findByRole('button', { name: /Requests/ });
        expect(pill).toHaveTextContent('Requests');
        expect(within(pill).getByTestId('conversation-filter-count-requests')).toHaveTextContent('1');
        expect(pill).toHaveAccessibleName('Requests, 1 person wants to message you');
    });

    it('counts every request the node has, not just the ones it named', async () => {
        node.list = annListWith([requestEntry(bo, CONV)], 120);
        render(<MessagesPage identity={idOf(ann)} />);
        await waitFor(() => expect(screen.getByTestId('conversation-filter-count-requests')).toHaveTextContent('99+'));
    });

    it('is not there where requests are off (no `requests` in the list), nor when none are waiting', async () => {
        node.list = { conversations: [], totalUnread: 0, deletedAccounts: [] };
        const { unmount } = render(<MessagesPage identity={idOf(ann)} />);
        expect(Array.from((await chips()).querySelectorAll('button')).map(b => b.textContent)).toEqual(['All', 'Transactions', 'Direct', 'Groups']);
        unmount();
        node.list = annListWith([]);
        render(<MessagesPage identity={idOf(ann)} />);
        await act(async () => {});
        expect(within(await chips()).queryByRole('button', { name: /Requests/ })).toBeNull();
    });

    it('goes when requests are turned off while it is open, and the list is back on All, never on no chip at all', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        render(<MessagesPage identity={idOf(ann)} />);
        await openRequests();
        // The operator turns requests off: the next list read has no `requests`.
        node.list = { conversations: [], totalUnread: 0, deletedAccounts: [] };
        await ringDoorbell();
        const bar = await chips();
        await waitFor(() => expect(within(bar).queryByRole('button', { name: /Requests/ })).toBeNull());
        expect(within(bar).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByTestId('message-requests')).toBeNull();
    });
});

describe('a request card', () => {
    it('names who wants to message you and shows their first line, opened with your own key', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, "Hi, it's Bo from the egg stall")]);
        render(<MessagesPage identity={idOf(ann)} />);
        const list = await openRequests();
        const card = within(list).getByTestId('request-card');
        expect(card).toHaveTextContent('Bo wants to message you');
        expect(await within(card).findByText("Hi, it's Bo from the egg stall")).toBeInTheDocument();
        for (const b of ['Accept', 'Ignore', 'Block']) expect(within(card).getByRole('button', { name: b })).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'Report Bo' })).toBeInTheDocument();
        expect(within(card).queryByText('Bo added you')).toBeNull();
        expect(within(list).getByText('1 person wants to message you')).toBeInTheDocument();
    });

    it('says when the sender has added you', async () => {
        node.list = annListWith([requestEntry(bo, CONV, { addedYou: true })]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        render(<MessagesPage identity={idOf(ann)} />);
        expect(within(await openRequests()).getByText('Bo added you')).toBeInTheDocument();
    });

    it('keeps a photo closed: a placeholder and its caption, and the picture is never fetched', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [photo(bo, 'my hens')]);
        render(<MessagesPage identity={idOf(ann)} />);
        const card = within(await openRequests()).getByTestId('request-card');
        expect(await within(card).findByText('Photo: shown when you accept')).toBeInTheDocument();
        expect(within(card).getByText('my hens')).toBeInTheDocument();
        await act(async () => {});
        expect(getMessageAttachmentApi).not.toHaveBeenCalled();
    });

    it('never shows a line in the sender\'s name that does not open as theirs', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        // Sealed by Ann, served in Bo's name: it opens as nobody's.
        node.reads[CONV] = readOf(pending(), [{ ...line(ann, 'Send me 500 Beans first'), authorPubkey: bo.publicKey }]);
        render(<MessagesPage identity={idOf(ann)} />);
        const card = within(await openRequests()).getByTestId('request-card');
        expect(await within(card).findByText("🔒 This message couldn't be verified, so it isn't shown.")).toBeInTheDocument();
        expect(within(card).queryByText('Send me 500 Beans first')).toBeNull();
    });

    it('opens the sender\'s profile from their name', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        const onOpenProfile = vi.fn();
        render(<MessagesPage identity={idOf(ann)} onOpenProfile={onOpenProfile} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: "Bo, see Bo's profile" }));
        expect(onOpenProfile).toHaveBeenCalledWith(bo.publicKey);
    });

    it('Accept tells the node and opens the chat, where Ann can write', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockImplementation(async () => {
            // #2392 annListAfterAccept: the chat moves to her chats, accepted.
            const { addedYou: _, ...accepted } = requestEntry(bo, CONV, { request: ACCEPTED.request });
            node.list = { conversations: [accepted], totalUnread: 1, deletedAccounts: [], requests: { count: 0, conversations: [] } };
            node.reads[CONV] = readOf(ACCEPTED.request, node.reads[CONV].messages);
            return ACCEPTED as never;
        });
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Accept' }));
        expect(await screen.findByPlaceholderText('Message...')).toBeInTheDocument();
        expect(decideMessageRequest).toHaveBeenCalledWith(CONV, 'accept');
        expect(await screen.findByText('Hello')).toBeInTheDocument();
    });

    it('Ignore tells the node and the card goes; the sender is told nothing by this app either', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockImplementation(async () => { node.list = annListWith([]); return IGNORED as never; });
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Ignore' }));
        await waitFor(() => expect(screen.queryByTestId('request-card')).toBeNull());
        expect(decideMessageRequest).toHaveBeenCalledWith(CONV, 'ignore');
        expect(screen.getByText("No requests. A first message from someone you haven't added or talked to arrives here.")).toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('Block asks first, then blocks through the community\'s list', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        const confirm = vi.fn(() => true);
        vi.stubGlobal('confirm', confirm);
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Block' }));
        await waitFor(() => expect(blockUser).toHaveBeenCalledWith(bo.publicKey, ann.publicKey, expect.any(String)));
        expect(confirm).toHaveBeenCalledWith('Block Bo?\n\nThis will hide their messages and posts, and notify moderation.');
        expect(decideMessageRequest).not.toHaveBeenCalled();
    });

    it('Report opens the report form for the sender', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Report Bo' }));
        expect(await screen.findByTestId('report-modal')).toHaveTextContent('Bo');
    });

    it('offline: says so, keeps the card and its buttons, and changes nothing', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockRejectedValue(new TypeError('Failed to fetch'));
        render(<MessagesPage identity={idOf(ann)} />);
        const card = within(await openRequests()).getByTestId('request-card');
        fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
        expect(await within(card).findByText(OFFLINE)).toBeInTheDocument();
        for (const b of ['Accept', 'Ignore', 'Block']) expect(within(card).getByRole('button', { name: b })).toBeEnabled();
        expect(screen.queryByPlaceholderText('Message...')).toBeNull();
    });

    it('a request that is gone by the time Ann decides (ignored on another device) leaves the list', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockImplementation(async () => {
            node.list = annListWith([]);
            throw Object.assign(new Error('There is no message request for you in this chat.'), { status: 404, code: 'request_not_found' });
        });
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Accept' }));
        await waitFor(() => expect(screen.queryByTestId('request-card')).toBeNull());
        expect(screen.queryByPlaceholderText('Message...')).toBeNull();
    });

    it('a card still reads its line when the list changes while that line is being read', async () => {
        const cy = person('Cy');
        const CY = crypto.randomUUID();
        let open!: () => void;
        node.gates[CY] = new Promise<void>((r) => { open = r; });
        node.list = annListWith([requestEntry(bo, CONV), requestEntry(cy, CY)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        node.reads[CY] = { ...readOf(pending(cy.publicKey), []), messages: [] };
        const cyChat = { id: CY, type: 'dm', participants: [ann.publicKey, cy.publicKey] };
        const id = crypto.randomUUID();
        node.reads[CY].conversation = { ...node.reads[CY].conversation, id: CY, participants: [ann.publicKey, cy.publicKey], createdBy: cy.publicKey };
        node.reads[CY].messages = [{ id, conversationId: CY, authorPubkey: cy.publicKey, ...lockForDm('Cy here', cyChat, cy, { messageId: id, after: null }),
            type: 'text', systemType: null, metadata: null, timestamp: LINE_AT, editedAt: null, updatedAt: LINE_AT }];
        vi.mocked(decideMessageRequest).mockImplementation(async () => { node.list = annListWith([requestEntry(cy, CY)]); return IGNORED as never; });
        render(<MessagesPage identity={idOf(ann)} />);
        const list = await openRequests();
        await within(list).findByText('Hello');
        fireEvent.click(within(within(list).getAllByTestId('request-card')[0]).getByRole('button', { name: 'Ignore' }));
        await waitFor(() => expect(screen.getAllByTestId('request-card')).toHaveLength(1));
        await act(async () => { open(); });
        expect(await screen.findByText('Cy here')).toBeInTheDocument();
    });

    it('a refusal from the node is said in its own words (a standby)', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockRejectedValue(Object.assign(new Error(STANDBY_WORDS), { status: 503, code: 'standby' }));
        render(<MessagesPage identity={idOf(ann)} />);
        const card = within(await openRequests()).getByTestId('request-card');
        fireEvent.click(within(card).getByRole('button', { name: 'Ignore' }));
        expect(await within(card).findByText(STANDBY_WORDS)).toBeInTheDocument();
    });
});

describe('Ignore all', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => requestEntry(person(`P${i}`), crypto.randomUUID()));

    it('is offered when more than five wait, asks first, then ignores them all', async () => {
        node.list = annListWith(many(6));
        const confirm = vi.fn(() => true);
        vi.stubGlobal('confirm', confirm);
        vi.mocked(ignoreAllMessageRequests).mockImplementation(async () => { node.list = annListWith([]); return { success: true, ignored: 6 }; });
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Ignore all' }));
        expect(confirm).toHaveBeenCalledWith("Ignore all 6 requests? They won't be told.");
        await waitFor(() => expect(screen.queryAllByTestId('request-card')).toHaveLength(0));
        expect(ignoreAllMessageRequests).toHaveBeenCalledTimes(1);
    });

    it('is not offered for five or fewer; and nothing is ignored when the member says no', async () => {
        node.list = annListWith(many(5));
        const { unmount } = render(<MessagesPage identity={idOf(ann)} />);
        expect(within(await openRequests()).queryByRole('button', { name: 'Ignore all' })).toBeNull();
        unmount();
        node.list = annListWith(many(7));
        vi.stubGlobal('confirm', vi.fn(() => false));
        render(<MessagesPage identity={idOf(ann)} />);
        fireEvent.click(within(await openRequests()).getByRole('button', { name: 'Ignore all' }));
        expect(ignoreAllMessageRequests).not.toHaveBeenCalled();
        expect(screen.getAllByTestId('request-card')).toHaveLength(7);
    });

    it('shows 50 cards and says how many more there are', async () => {
        node.list = annListWith(many(60), 130);
        render(<MessagesPage identity={idOf(ann)} />);
        const list = await openRequests();
        expect(within(list).getAllByTestId('request-card')).toHaveLength(50);
        expect(within(list).getByText('and 80 more')).toBeInTheDocument();
    });
});

describe('the chat in request mode, for the person it is for', () => {
    async function openFromCard(): Promise<void> {
        const card = within(await openRequests()).getByTestId('request-card');
        fireEvent.click(await within(card).findByText('Hello'));
        await screen.findByTestId('request-mode');
    }

    it('reads the lines, with Accept, Ignore and Block in place of the composer, and nothing else to tap in a line', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        render(<MessagesPage identity={idOf(ann)} />);
        await openFromCard();
        expect(screen.queryByPlaceholderText('Message...')).toBeNull();
        const bar = screen.getByTestId('request-mode');
        expect(bar).toHaveTextContent('Bo wants to message you');
        for (const b of ['Accept', 'Ignore', 'Block']) expect(within(bar).getByRole('button', { name: b })).toBeInTheDocument();
        expect(screen.getAllByText('Hello').length).toBeGreaterThan(0);
        expect(screen.queryByRole('button', { name: 'React to message' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Reply to message' })).toBeNull();
        expect(decideMessageRequest).not.toHaveBeenCalled();
    });

    it('a photo stays closed in the chat too', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [photo(bo, 'Hello')]);
        render(<MessagesPage identity={idOf(ann)} />);
        await openFromCard();
        expect(screen.getAllByText('Photo: shown when you accept').length).toBeGreaterThan(0);
        await act(async () => {});
        expect(getMessageAttachmentApi).not.toHaveBeenCalled();
    });

    it('the sender\'s name in the header opens their profile', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        const onOpenProfile = vi.fn();
        render(<MessagesPage identity={idOf(ann)} onOpenProfile={onOpenProfile} />);
        await openFromCard();
        fireEvent.click(screen.getByTestId('request-header-profile'));
        expect(onOpenProfile).toHaveBeenCalledWith(bo.publicKey);
    });

    it('Accept brings the composer back in the same chat, and a list read asked before it doesn\'t take it away', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockImplementation(async () => {
            // node.list is left as it was: the list the page reads next still names the request waiting, as a read asked
            // before the accept landed would. The node never takes an acceptance back.
            node.reads[CONV] = readOf(ACCEPTED.request, node.reads[CONV].messages);
            return ACCEPTED as never;
        });
        render(<MessagesPage identity={idOf(ann)} />);
        await openFromCard();
        fireEvent.click(within(screen.getByTestId('request-mode')).getByRole('button', { name: 'Accept' }));
        expect(await screen.findByPlaceholderText('Message...')).toBeInTheDocument();
        expect(screen.queryByTestId('request-mode')).toBeNull();
    });

    it('Ignore goes back to the requests', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockImplementation(async () => { node.list = annListWith([]); return IGNORED as never; });
        render(<MessagesPage identity={idOf(ann)} />);
        await openFromCard();
        fireEvent.click(within(screen.getByTestId('request-mode')).getByRole('button', { name: 'Ignore' }));
        expect(await screen.findByTestId('message-requests')).toBeInTheDocument();
        expect(screen.queryByTestId('request-mode')).toBeNull();
    });

    it('offline: the bar says so and keeps its buttons', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        vi.mocked(decideMessageRequest).mockRejectedValue(new TypeError('Failed to fetch'));
        render(<MessagesPage identity={idOf(ann)} />);
        await openFromCard();
        const bar = screen.getByTestId('request-mode');
        fireEvent.click(within(bar).getByRole('button', { name: 'Accept' }));
        expect(await within(bar).findByText(OFFLINE)).toBeInTheDocument();
        expect(within(bar).getByRole('button', { name: 'Accept' })).toBeEnabled();
    });

    it('a request opened by its id (a push) opens in request mode, never as a new chat', async () => {
        node.list = annListWith([requestEntry(bo, CONV)]);
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hello')]);
        render(<MessagesPage identity={idOf(ann)} openConversationId={CONV} />);
        expect(await screen.findByTestId('request-mode')).toBeInTheDocument();
        expect(createConversationApi).not.toHaveBeenCalled();
    });
});

describe('the sender\'s side', () => {
    const ANN_PEER = { ...boList(pending()).conversations[0] };

    it('before the first line, the composer says the message goes as a request', async () => {
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), []);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByPlaceholderText('Message...')).toBeEnabled();
        // Said once the chat's lines are read, and none of Bo's is in it (until then it isn't known).
        expect(await screen.findByTestId('request-first-line')).toHaveTextContent('Your first message goes to Ann as a request. You can write more once they accept.');
        expect(ANN_PEER.peerCallsign).toBe('Ann');
    });

    it('after it, the composer waits, honestly, and says why', async () => {
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByTestId('request-waiting')).toHaveTextContent('Sent as a request. Ann will see it under Requests. You can write more once they accept.');
        expect(screen.queryByPlaceholderText('Message...')).toBeNull();
        expect(screen.queryByRole('button', { name: 'React to message' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Reply to message' })).toBeNull();
        // Nothing beyond what the node said: no "seen", no "ignored".
        expect(screen.queryByText(/ignored|blocked|seen/i)).toBeNull();
    });

    it('while the chat is still being read, it says neither: a line already sent is never offered as the first', async () => {
        // A slow connection: Bo's line is in, and his read of the chat hasn't come back yet.
        let open!: () => void;
        node.gates[CONV] = new Promise<void>((r) => { open = r; });
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByPlaceholderText('Message...')).toBeInTheDocument();
        expect(screen.queryByTestId('request-first-line')).toBeNull();
        expect(screen.queryByTitle('Send photo')).toBeNull();
        await act(async () => { open(); });
        expect(await screen.findByTestId('request-waiting')).toHaveTextContent('Sent as a request. Ann will see it under Requests. You can write more once they accept.');
        expect(screen.queryByTestId('request-first-line')).toBeNull();
    });

    it('a dragged photo is taken before the first line, and not while the chat is still being read (its 📎 is hidden then too)', async () => {
        const dragged = { dataTransfer: { files: [], items: [], types: ['Files'] } };
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), []);
        const { unmount } = render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        await screen.findByTestId('request-first-line');
        fireEvent.dragEnter(screen.getByPlaceholderText('Message...'), dragged);
        expect(await screen.findByTestId('chat-drop-hint')).toBeInTheDocument();
        unmount();

        let open!: () => void;
        node.gates[CONV] = new Promise<void>((r) => { open = r; });
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        const composer = await screen.findByPlaceholderText('Message...');
        expect(screen.queryByTitle('Send photo')).toBeNull();
        fireEvent.dragEnter(composer, dragged);
        await act(async () => {});
        expect(screen.queryByTestId('chat-drop-hint')).toBeNull();
        await act(async () => { open(); });
        await screen.findByTestId('request-waiting');
    });

    it('a pasted photo is taken before the first line, and not while the chat is still being read: no preview, nor once it is', async () => {
        node.list = boList(mine(true));
        node.reads[CONV] = readOf(mine(true), []);
        const { unmount } = render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        await screen.findByTestId('request-first-line');
        fireEvent.paste(screen.getByPlaceholderText('Message...'), { clipboardData: clipboardWith(picture()) });
        expect(await screen.findByTestId('chat-image-preview')).toBeInTheDocument();
        unmount();

        let open!: () => void;
        node.gates[CONV] = new Promise<void>((r) => { open = r; });
        node.list = boList(mine(false));
        node.reads[CONV] = readOf(mine(false), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        const composer = await screen.findByPlaceholderText('Message...');
        fireEvent.paste(composer, { clipboardData: clipboardWith(picture()) });
        await act(async () => {});
        expect(screen.queryByTestId('chat-image-preview')).toBeNull();
        await act(async () => { open(); });
        await screen.findByTestId('request-waiting');
        expect(screen.queryByTestId('chat-image-preview')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    });

    it('after a block is lifted, the line kept during it is no request\'s: the node says the next line is, and the composer is back', async () => {
        // Bo's line kept for him alone while Ann blocked him is in his read; it never reached her, and once she lifts the
        // block the node takes his next line as the request (#2392 review 4354388176). The page can't tell which line was
        // kept, and doesn't: it reads the node's word.
        node.list = boList(mine(true));
        node.reads[CONV] = readOf(mine(true), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByTestId('request-first-line')).toHaveTextContent('Your first message goes to Ann as a request. You can write more once they accept.');
        expect(screen.getByPlaceholderText('Message...')).toBeEnabled();
        expect(screen.queryByTestId('request-waiting')).toBeNull();
        expect(await screen.findByText('Hi Ann')).toBeInTheDocument();
    });

    it('once the node takes that line, the composer waits, before the chat is read again or if that read fails', async () => {
        node.list = boList(mine(true));
        node.reads[CONV] = readOf(mine(true), [line(bo, 'Hi Ann')]);
        vi.mocked(sendMessageApi).mockResolvedValue({ success: true } as never);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        await screen.findByTestId('request-first-line');
        // The read after the send never comes back (a dropped connection).
        node.gates[CONV] = new Promise<void>(() => {});
        fireEvent.change(screen.getByPlaceholderText('Message...'), { target: { value: 'Hello again' } });
        fireEvent.click(screen.getByTitle('Send message'));
        expect(await screen.findByTestId('request-waiting')).toHaveTextContent('Sent as a request. Ann will see it under Requests. You can write more once they accept.');
        expect(sendMessageApi).toHaveBeenCalledTimes(1);
        expect(screen.queryByPlaceholderText('Message...')).toBeNull();
    });

    it('their own line can still be edited while it waits', async () => {
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hi Ann', new Date(Date.now() - 60_000).toISOString())]);
        // The line's time is a minute ago; the request is made by it.
        node.reads[CONV].conversation.request = { ...pending(), at: new Date(Date.now() - 61_000).toISOString() };
        node.list.conversations[0].request = node.reads[CONV].conversation.request;
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        await screen.findByTestId('request-waiting');
        fireEvent.click(screen.getByRole('button', { name: 'Edit message' }));
        expect(await screen.findByPlaceholderText('Edit message...')).toBeInTheDocument();
    });

    it('when Ann accepts, the doorbell brings the composer back', async () => {
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        await screen.findByTestId('request-waiting');
        node.list = boList(ACCEPTED.request);
        node.reads[CONV] = readOf(ACCEPTED.request, node.reads[CONV].messages);
        await ringDoorbell();
        expect(await screen.findByPlaceholderText('Message...')).toBeEnabled();
        expect(screen.queryByTestId('request-waiting')).toBeNull();
    });

    it('30 days on (expired), the next line is a new request: the composer is back, saying so', async () => {
        const expired = { state: 'expired', from: bo.publicKey, at: REQUESTED_AT };
        node.list = boList(expired);
        node.reads[CONV] = readOf(expired, [line(bo, 'Hi Ann')]);
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByPlaceholderText('Message...')).toBeEnabled();
        expect(screen.getByTestId('request-first-line')).toBeInTheDocument();
    });

    it('a second line the node refuses is said in its words in place, not in an alert', async () => {
        node.list = boList(pending());
        node.reads[CONV] = readOf(pending(), []);
        const alert = vi.fn();
        vi.stubGlobal('alert', alert);
        vi.mocked(sendMessageApi).mockRejectedValue(Object.assign(new Error(WAITING_WORDS), { status: 403, code: 'dm_request_pending' }));
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        const box = await screen.findByPlaceholderText('Message...');
        fireEvent.change(box, { target: { value: 'Are you there?' } });
        fireEvent.click(screen.getByTitle('Send message'));
        expect(await screen.findByTestId('chat-refusal')).toHaveTextContent(WAITING_WORDS);
        expect(alert).not.toHaveBeenCalled();
    });

    it('their chat row carries a small request tag while it waits, and none once accepted', async () => {
        node.list = boList(pending());
        const { unmount } = render(<MessagesPage identity={idOf(bo)} />);
        expect(await screen.findByTestId('request-tag')).toHaveTextContent('request');
        unmount();
        node.list = boList(ACCEPTED.request);
        render(<MessagesPage identity={idOf(bo)} />);
        await screen.findByText('Ann');
        expect(screen.queryByTestId('request-tag')).toBeNull();
    });

    it('a chat opened but never written in carries no tag: nobody has been asked anything yet', async () => {
        // The node makes the request's row at the open, before a line (#2392: "the request is made by that line, not by the
        // open"), and lists the chat with no last line: `last_msg_type` from a LEFT JOIN on messages, null.
        node.list = boList(pending());
        node.list.conversations[0].lastMsgType = null;
        render(<MessagesPage identity={idOf(bo)} />);
        await screen.findByText('Ann');
        expect(screen.queryByTestId('request-tag')).toBeNull();
    });
});

describe('where requests are off', () => {
    it('a chat with no `request` is an ordinary chat on both sides', async () => {
        const plain = { ...boList(null), requests: undefined };
        delete (plain.conversations[0] as any).request;
        node.list = plain;
        node.reads[CONV] = readOf(undefined, [line(bo, 'Hi Ann')]);
        delete (node.reads[CONV].conversation as any).request;
        render(<MessagesPage identity={idOf(bo)} openConversationId={CONV} />);
        expect(await screen.findByPlaceholderText('Message...')).toBeEnabled();
        expect(screen.queryByTestId('request-waiting')).toBeNull();
        expect(screen.queryByTestId('request-first-line')).toBeNull();
        expect(await screen.findByRole('button', { name: 'React to message' })).toBeInTheDocument();
    });
});
