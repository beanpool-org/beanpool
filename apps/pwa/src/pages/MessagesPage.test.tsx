import { render, screen, act, waitFor, fireEvent, createEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { MessagesPage } from './MessagesPage';
import type { BeanPoolIdentity } from '../lib/identity';
import { getConversationMessages, getEventChat, createConversationApi, sendMessageApi, type Conversation, type ApiMessage } from '../lib/api';

// Polyfill scrollIntoView for jsdom
if (typeof window !== 'undefined' && window.HTMLElement) {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

let syncActivityListeners: Array<() => void | Promise<void>> = [];

vi.mock('../lib/sync', () => ({
    onSyncActivity: vi.fn((cb: () => void | Promise<void>) => {
        syncActivityListeners.push(cb);
        return () => {
            syncActivityListeners = syncActivityListeners.filter(l => l !== cb);
        };
    }),
}));

vi.mock('../lib/blocklist', () => ({
    isUserBlocked: vi.fn(() => false),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getBlockedUsers: vi.fn(() => []),
    onBlocklistUpdated: vi.fn(() => () => {}),
}));

vi.mock('../lib/archetypes', () => ({
    consumeChatPrefill: vi.fn(() => null),
}));

vi.mock('../lib/avatar', () => ({
    resolveAvatarUrl: vi.fn((url) => url),
}));

vi.mock('../lib/e2e-crypto', () => ({
    decodePlaintext: vi.fn((c: string) => c),
    encodePlaintext: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    decryptDM: vi.fn((c: string) => c),
    encryptDM: vi.fn((text: string) => ({ ciphertext: text, nonce: '00000' })),
    isEncryptedNonce: vi.fn(() => false),
}));

vi.mock('../components/ReportModal', () => ({
    ReportModal: () => null,
}));

let mockConversations: Conversation[] = [];
let mockMessagesByConv: Record<string, ApiMessage[]> = {};
let mockConversationDetails: Record<string, Conversation> = {};

vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => ({
        conversations: mockConversations,
        totalUnread: mockConversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0),
    })),
    getConversationMessages: vi.fn(async (convId: string) => ({
        conversation: mockConversationDetails[convId] || {
            id: convId,
            type: 'dm',
            participants: ['my-pubkey', 'peer-pubkey'],
            createdAt: '2026-09-14T00:00:00Z',
            updatedAt: '2026-09-14T00:00:00Z',
        },
        messages: mockMessagesByConv[convId] || [],
    })),
    getMembers: vi.fn(async () => [
        { publicKey: 'peer-pubkey', callsign: 'Bob', role: 'member' },
        { publicKey: 'other-pubkey', callsign: 'Charlie', role: 'member' },
    ]),
    getMyMarketplaceTransactions: vi.fn(async () => []),
    markConversationReadApi: vi.fn(async () => ({ success: true })),
    createConversationApi: vi.fn(),
    getEventChat: vi.fn(),
    postEventChatMessage: vi.fn(),
    removeEventChatMessage: vi.fn(),
    sendMessageApi: vi.fn(),
    editMessageApi: vi.fn(),
    toggleMessageReactionApi: vi.fn(),
    getMessageAttachmentApi: vi.fn(),
    completeMarketplaceTransaction: vi.fn(),
    cancelMarketplaceTransaction: vi.fn(),
}));

const mockIdentity: BeanPoolIdentity = {
    publicKey: 'my-pubkey',
    privateKey: 'my-privkey',
    callsign: 'Alice',
    createdAt: '2026-09-14T00:00:00Z',
};

describe('MessagesPage Stage 5: Chat Over Push & Backstop Polling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        syncActivityListeners = [];

        mockConversations = [
            {
                id: 'conv-1',
                type: 'dm',
                name: null,
                participants: ['my-pubkey', 'peer-pubkey'],
                createdBy: 'my-pubkey',
                peerCallsign: 'Bob',
                unreadCount: 0,
                createdAt: '2026-09-14T00:00:00Z',
            },
            {
                id: 'conv-2',
                type: 'dm',
                name: null,
                participants: ['my-pubkey', 'other-pubkey'],
                createdBy: 'my-pubkey',
                peerCallsign: 'Charlie',
                unreadCount: 0,
                createdAt: '2026-09-14T00:00:00Z',
            },
        ];

        mockConversationDetails = {
            'conv-1': mockConversations[0],
            'conv-2': mockConversations[1],
        };

        mockMessagesByConv = {
            'conv-1': [
                {
                    id: 'msg-1',
                    conversationId: 'conv-1',
                    authorPubkey: 'peer-pubkey',
                    ciphertext: 'Hello Alice!',
                    nonce: '00000',
                    timestamp: '2026-09-14T00:00:00.000Z',
                },
            ],
            'conv-2': [],
        };

        vi.mocked(getConversationMessages).mockImplementation(async (convId: string) => ({
            conversation: mockConversationDetails[convId] || {
                id: convId,
                type: 'dm',
                participants: ['my-pubkey', 'peer-pubkey'],
                createdAt: '2026-09-14T00:00:00Z',
                updatedAt: '2026-09-14T00:00:00Z',
            },
            messages: mockMessagesByConv[convId] || [],
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.mocked(getConversationMessages).mockImplementation(async (convId: string) => ({
            conversation: mockConversationDetails[convId] || {
                id: convId,
                type: 'dm',
                participants: ['my-pubkey', 'peer-pubkey'],
                createdAt: '2026-09-14T00:00:00Z',
                updatedAt: '2026-09-14T00:00:00Z',
            },
            messages: mockMessagesByConv[convId] || [],
        }));
    });

    it('1. an arriving message appears without waiting for the backstop', async () => {
        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Initial message renders
        await waitFor(() => {
            expect(screen.getByText('Hello Alice!')).toBeInTheDocument();
        });

        // New message arrives on server
        mockMessagesByConv['conv-1'] = [
            ...mockMessagesByConv['conv-1'],
            {
                id: 'msg-2',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Push broadcast message arrived!',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:05.000Z',
            },
        ];

        // Trigger onSyncActivity (simulating WebSocket doorbell push event)
        // Note: No timer advancement by 30s is needed!
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Message appears immediately via push listener
        expect(screen.getByText('Push broadcast message arrived!')).toBeInTheDocument();
    });

    it('2. no duplicate render when identical message id is received or refetched', async () => {
        // Mock returning the exact same message twice in the server response
        mockMessagesByConv['conv-1'] = [
            {
                id: 'msg-dup-1',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Unique content test',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:00.000Z',
            },
            {
                id: 'msg-dup-1', // Same ID!
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Unique content test',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:00.000Z',
            },
        ];

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Unique content test')).toBeInTheDocument();
        });

        // Verify deduplication: only 1 element rendered in DOM
        const matches = screen.getAllByText('Unique content test');
        expect(matches.length).toBe(1);

        // Even after another onSyncActivity push, it stays deduplicated
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        expect(screen.getAllByText('Unique content test').length).toBe(1);
    });

    it('3. the backstop still recovers when no broadcast arrives (silently dead socket)', async () => {
        vi.useFakeTimers();

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Flush initial load promises
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100);
        });

        expect(screen.getByText('Hello Alice!')).toBeInTheDocument();

        // A new message is sent on server, but socket is dead so NO broadcast / onSyncActivity fires
        mockMessagesByConv['conv-1'] = [
            ...mockMessagesByConv['conv-1'],
            {
                id: 'msg-recovered',
                conversationId: 'conv-1',
                authorPubkey: 'peer-pubkey',
                ciphertext: 'Recovered via 30s backstop poll',
                nonce: '00000',
                timestamp: '2026-09-14T00:00:10.000Z',
            },
        ];

        // Message should NOT be rendered yet (before backstop fires)
        expect(screen.queryByText('Recovered via 30s backstop poll')).not.toBeInTheDocument();

        // Advance past 30s (with ±20% jitter, max interval is 36s = 36000ms)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(36000);
        });

        // Backstop poll executed and recovered the message
        expect(screen.getByText('Recovered via 30s backstop poll')).toBeInTheDocument();
    });

    it('4. unread counts update for a conversation that is not open', async () => {
        // Render conversation list view (no open conversation)
        render(
            <MessagesPage
                identity={mockIdentity}
            />
        );

        // Initial list renders Bob and Charlie
        await waitFor(() => {
            expect(screen.getByText('Bob')).toBeInTheDocument();
            expect(screen.getByText('Charlie')).toBeInTheDocument();
        });

        // Initially no unread badge '5'
        expect(screen.queryByText('5')).not.toBeInTheDocument();

        // Message arrives for conv-2 (unopened conversation)
        mockConversations = [
            {
                ...mockConversations[0],
                unreadCount: 0,
            },
            {
                ...mockConversations[1],
                unreadCount: 5,
            },
        ];

        // Trigger onSyncActivity (conversation list sync)
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Unread badge for conv-2 updates to 5
        await waitFor(() => {
            const badge = screen.getByText('5');
            expect(badge).toBeInTheDocument();
        });

        // conv-1 has unreadCount 0 (no unread badge)
        expect(screen.queryByText('1')).not.toBeInTheDocument();
    });

    it('5. out-of-order race protection: an older in-flight load cannot overwrite newer messages', async () => {
        let resolveFirstCall: ((val: any) => void) | null = null;
        const firstCallPromise = new Promise((resolve) => {
            resolveFirstCall = resolve;
        });

        let firstCallStartedResolve: (() => void) | null = null;
        const firstCallStartedPromise = new Promise<void>((resolve) => {
            firstCallStartedResolve = resolve;
        });

        const { getConversationMessages } = await import('../lib/api');
        const originalMock = vi.mocked(getConversationMessages);

        let callCount = 0;
        originalMock.mockImplementation(async (convId: string) => {
            callCount++;
            if (callCount === 1) {
                // Signal that first call has started
                firstCallStartedResolve?.();
                // First call stalls waiting for promise
                await firstCallPromise;
                return {
                    conversation: mockConversationDetails[convId],
                    messages: [
                        {
                            id: 'msg-old',
                            conversationId: convId,
                            authorPubkey: 'peer-pubkey',
                            ciphertext: 'Old Stale Message',
                            nonce: '00000',
                            timestamp: '2026-09-14T00:00:00.000Z',
                        },
                    ],
                };
            }
            // Second call completes immediately with newer message
            return {
                conversation: mockConversationDetails[convId],
                messages: [
                    {
                        id: 'msg-new',
                        conversationId: convId,
                        authorPubkey: 'peer-pubkey',
                        ciphertext: 'Fresh Push Message',
                        nonce: '00000',
                        timestamp: '2026-09-14T00:00:05.000Z',
                    },
                ],
            };
        });

        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        // Wait until first loadMessages call is in-flight
        await firstCallStartedPromise;

        // While first call is stalled, push broadcast arrives and starts second load
        await act(async () => {
            for (const listener of syncActivityListeners) {
                await listener();
            }
        });

        // Second call completed and rendered the fresh message
        await waitFor(() => {
            expect(screen.getByText('Fresh Push Message')).toBeInTheDocument();
        });

        // Now first call finally resolves later
        await act(async () => {
            resolveFirstCall!({} as any);
        });

        // The older out-of-order response was discarded and did not overwrite the fresh message!
        expect(screen.getByText('Fresh Push Message')).toBeInTheDocument();
        expect(screen.queryByText('Old Stale Message')).not.toBeInTheDocument();
    });

    it('6. listeners return promises so sync coordinator can await them', async () => {
        render(
            <MessagesPage
                identity={mockIdentity}
                openConversationId="conv-1"
            />
        );

        await waitFor(() => {
            expect(screen.getByText('Hello Alice!')).toBeInTheDocument();
        });

        expect(syncActivityListeners.length).toBeGreaterThan(0);
        for (const listener of syncActivityListeners) {
            let ret: any;
            await act(async () => {
                ret = listener();
            });
            // Each listener must return a Promise (or undefined when paused/hidden)
            if (ret !== undefined) {
                expect(ret).toBeInstanceOf(Promise);
            }
        }
    });
});

describe('MessagesPage conversation filters at 320px with 1.3x text', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConversations = [];
    });

    it('wraps All / Transactions / Direct onto a second line instead of hiding Direct behind a scrollbar', async () => {
        render(<MessagesPage identity={mockIdentity} />);

        const row = await screen.findByTestId('conversation-filter-chips');
        expect(row).toHaveStyle({ flexWrap: 'wrap' });
        expect(row).toHaveClass('scrollbar-none');
        expect(Array.from(row.querySelectorAll('button')).map(b => b.textContent)).toEqual(['All', 'Transactions', 'Direct']);
    });
});

describe('MessagesPage: event chat (docs/events-on-the-map.md §2.2, §3)', () => {
    const EVENT_ID = '8f14e45f-ceea-467a-9d3c-1a2b3c4d5e6f';
    const PUBKEY = 'a'.repeat(64);

    const chatView = {
        conversation: { id: EVENT_ID, type: 'event_thread', name: 'Working bee', participants: [], createdBy: 'host-pk', createdAt: '' },
        messages: [],
        readOnly: false,
        readOnlyReason: null,
        canPost: true,
        isHost: true,
        title: 'Working bee',
        eventEndAt: null,
        eventState: 'scheduled',
        privateNote: 'Gate code 1234',
        notice: "Visible to the host, everyone going, and this node's operator.",
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConversations = [];
        mockConversationDetails = {};
        mockMessagesByConv = {};
    });

    it('opens an event chat by the event id, and never starts a DM with an id that is not a public key', async () => {
        // A host who has not tapped Going has no conversation row yet, so the id is not in the list.
        vi.mocked(getEventChat).mockResolvedValue(chatView as any);
        render(<MessagesPage identity={mockIdentity} openConversationId={EVENT_ID} />);

        expect(await screen.findByTestId('event-chat')).toBeInTheDocument();
        expect(await screen.findByTestId('event-chat-pinned-note')).toHaveTextContent('Gate code 1234');
        expect(createConversationApi).not.toHaveBeenCalled();
    });

    it('still starts a DM when the id IS a public key', async () => {
        vi.mocked(getEventChat).mockRejectedValue(new Error('Event not found'));
        render(<MessagesPage identity={mockIdentity} openConversationId={PUBKEY} />);

        await waitFor(() => expect(createConversationApi).toHaveBeenCalledWith('dm', ['my-pubkey', PUBKEY], 'my-pubkey'));
        expect(getEventChat).not.toHaveBeenCalled();
    });

    it("lists an event chat under the event's title", async () => {
        mockConversations = [{
            id: EVENT_ID, type: 'event_thread' as any, name: 'Working bee', participants: ['my-pubkey'],
            createdBy: 'host-pk', unreadCount: 2, createdAt: '2026-09-14T00:00:00Z',
        }];
        render(<MessagesPage identity={mockIdentity} />);
        expect(await screen.findByText('Working bee')).toBeInTheDocument();
    });
});

describe('MessagesPage: paste or drop a picture into a chat', () => {
    const GROUP_ID = 'group-1';

    /**
     * The photo path runs a picked file through an <img> and a <canvas>, neither of
     * which jsdom decodes. These stand in for them so the test exercises our code
     * rather than the browser's, and are restored after each test.
     */
    let restoreBrowserStubs: Array<() => void> = [];

    function stubImagePipeline() {
        const originalImage = window.Image;
        class FakeImage {
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            width = 800;
            height = 600;
            set src(_value: string) {
                setTimeout(() => this.onload?.(), 0);
            }
        }
        (window as any).Image = FakeImage;
        restoreBrowserStubs.push(() => { (window as any).Image = originalImage; });

        const originalGetContext = window.HTMLCanvasElement.prototype.getContext;
        const originalToDataUrl = window.HTMLCanvasElement.prototype.toDataURL;
        (window.HTMLCanvasElement.prototype as any).getContext = () => ({ drawImage: () => {} });
        (window.HTMLCanvasElement.prototype as any).toDataURL = () => 'data:image/jpeg;base64,resized';
        restoreBrowserStubs.push(() => {
            (window.HTMLCanvasElement.prototype as any).getContext = originalGetContext;
            (window.HTMLCanvasElement.prototype as any).toDataURL = originalToDataUrl;
        });

        const originalCreate = (URL as any).createObjectURL;
        const originalRevoke = (URL as any).revokeObjectURL;
        (URL as any).createObjectURL = () => 'blob:preview';
        (URL as any).revokeObjectURL = () => {};
        restoreBrowserStubs.push(() => {
            (URL as any).createObjectURL = originalCreate;
            (URL as any).revokeObjectURL = originalRevoke;
        });
    }

    function pictureFile(name = 'screenshot.png', type = 'image/png', size = 4096): File {
        const file = new File([new Uint8Array(1)], name, { type });
        Object.defineProperty(file, 'size', { value: size });
        return file;
    }

    /** A clipboard carrying a screenshot, as Chrome and Firefox present one. */
    function imageClipboard(file: File) {
        return {
            files: [file],
            items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
            types: ['Files'],
        };
    }

    async function openDm() {
        render(<MessagesPage identity={mockIdentity} openConversationId="conv-1" />);
        return await screen.findByPlaceholderText('Message...');
    }

    beforeEach(() => {
        vi.clearAllMocks();
        restoreBrowserStubs = [];
        stubImagePipeline();
        window.alert = vi.fn();

        mockConversations = [
            {
                id: 'conv-1', type: 'dm', name: null,
                participants: ['my-pubkey', 'peer-pubkey'], createdBy: 'my-pubkey',
                peerCallsign: 'Bob', unreadCount: 0, createdAt: '2026-09-14T00:00:00Z',
            },
            {
                id: GROUP_ID, type: 'group_thread' as any, name: 'Garden crew',
                participants: ['my-pubkey', 'peer-pubkey', 'other-pubkey'], createdBy: 'my-pubkey',
                unreadCount: 0, createdAt: '2026-09-14T00:00:00Z',
            },
        ];
        mockConversationDetails = { 'conv-1': mockConversations[0], [GROUP_ID]: mockConversations[1] };
        mockMessagesByConv = { 'conv-1': [], [GROUP_ID]: [] };

        vi.mocked(getConversationMessages).mockImplementation(async (convId: string) => ({
            conversation: mockConversationDetails[convId],
            messages: mockMessagesByConv[convId] || [],
        }));
    });

    afterEach(() => {
        for (const restore of restoreBrowserStubs) restore();
        restoreBrowserStubs = [];
    });

    it('a pasted picture opens the preview, and Send puts it down the photo path with the typed caption', async () => {
        const composer = await openDm();
        const file = pictureFile();

        fireEvent.change(composer, { target: { value: 'the back fence' } });
        fireEvent.paste(composer, { clipboardData: imageClipboard(file) });

        const preview = await screen.findByTestId('chat-image-preview');
        expect(preview).toHaveTextContent('caption');

        fireEvent.click(screen.getByRole('button', { name: 'Send' }));

        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        expect(sendMessageApi).toHaveBeenCalledWith(
            'conv-1', 'my-pubkey',
            'the back fence', '00000',        // the caption, encrypted into the message body
            'image',
            { data: 'data:image/jpeg;base64,resized', nonce: '00000', mime: 'image/jpeg' },
            undefined,
        );

        // Sent: the preview closes and the draft is cleared, as an ordinary send does.
        await waitFor(() => expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument());
        expect((composer as HTMLTextAreaElement).value).toBe('');
    });

    it('a text-only paste is left alone: nothing is prevented and no preview appears', async () => {
        const composer = await openDm();

        const paste = createEvent.paste(composer, {
            clipboardData: {
                files: [],
                items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
                types: ['text/plain'],
            },
        });
        fireEvent(composer, paste);

        expect(paste.defaultPrevented).toBe(false);
        expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a dropped picture opens the same preview', async () => {
        const composer = await openDm();

        fireEvent.drop(composer, { dataTransfer: imageClipboard(pictureFile('dropped.jpg', 'image/jpeg')) });

        expect(await screen.findByTestId('chat-image-preview')).toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a dropped file that is not a picture is still swallowed, not opened by the browser', async () => {
        const composer = await openDm();
        const pdf = pictureFile('minutes.pdf', 'application/pdf');

        // The chat asked for this drop in onDragOver, so it owes it a
        // preventDefault. Without one the browser navigates the tab to the file
        // and the whole session — chat, unsent draft — goes with it.
        const drop = createEvent.drop(composer, {
            dataTransfer: {
                files: [pdf],
                items: [{ kind: 'file', type: 'application/pdf', getAsFile: () => pdf }],
                types: ['Files'],
            },
        });
        fireEvent(composer, drop);

        expect(drop.defaultPrevented).toBe(true);
        expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('a dropped picture prevents the browser default too', async () => {
        const composer = await openDm();

        const drop = createEvent.drop(composer, {
            dataTransfer: imageClipboard(pictureFile('dropped.jpg', 'image/jpeg')),
        });
        fireEvent(composer, drop);

        expect(drop.defaultPrevented).toBe(true);
        expect(await screen.findByTestId('chat-image-preview')).toBeInTheDocument();
    });

    it('a text-only drop is left to the composer: nothing is prevented', async () => {
        const composer = await openDm();

        const drop = createEvent.drop(composer, {
            dataTransfer: {
                files: [],
                items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }],
                types: ['text/plain'],
            },
        });
        fireEvent(composer, drop);

        expect(drop.defaultPrevented).toBe(false);
        expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument();
    });

    it('in a group chat a pasted picture gets one line of explanation and nothing is sent', async () => {
        render(<MessagesPage identity={mockIdentity} openConversationId={GROUP_ID} />);
        const composer = await screen.findByPlaceholderText('Message...');

        fireEvent.paste(composer, { clipboardData: imageClipboard(pictureFile()) });

        const notice = await screen.findByTestId('chat-image-notice');
        expect(notice).toHaveTextContent('Photos can only be sent in direct messages');
        expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
        expect(window.alert).not.toHaveBeenCalled();
    });

    it('Cancel closes the preview and sends nothing', async () => {
        const composer = await openDm();
        fireEvent.paste(composer, { clipboardData: imageClipboard(pictureFile()) });
        await screen.findByTestId('chat-image-preview');

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument());
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('Escape closes the preview and sends nothing', async () => {
        const composer = await openDm();
        fireEvent.paste(composer, { clipboardData: imageClipboard(pictureFile()) });
        await screen.findByTestId('chat-image-preview');

        fireEvent.keyDown(composer, { key: 'Escape' });

        await waitFor(() => expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument());
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('Enter sends the previewed picture instead of the text underneath it', async () => {
        const composer = await openDm();
        fireEvent.change(composer, { target: { value: 'look at this' } });
        fireEvent.paste(composer, { clipboardData: imageClipboard(pictureFile()) });
        await screen.findByTestId('chat-image-preview');

        fireEvent.keyDown(composer, { key: 'Enter' });

        await waitFor(() => expect(sendMessageApi).toHaveBeenCalledTimes(1));
        expect(vi.mocked(sendMessageApi).mock.calls[0][4]).toBe('image');
        expect(vi.mocked(sendMessageApi).mock.calls[0][2]).toBe('look at this');
    });

    it('refuses a picture past the size limit, in plain words, without opening the preview', async () => {
        const composer = await openDm();
        const huge = pictureFile('raw.tiff', 'image/tiff', 21 * 1024 * 1024);

        fireEvent.paste(composer, { clipboardData: imageClipboard(huge) });

        const notice = await screen.findByTestId('chat-image-notice');
        expect(notice).toHaveTextContent('20 MB');
        expect(screen.queryByTestId('chat-image-preview')).not.toBeInTheDocument();
        expect(sendMessageApi).not.toHaveBeenCalled();
    });

    it('shows a drop highlight while a file is being dragged over the chat', async () => {
        const composer = await openDm();

        fireEvent.dragEnter(composer, { dataTransfer: { files: [], items: [], types: ['Files'] } });
        expect(await screen.findByTestId('chat-drop-hint')).toBeInTheDocument();

        fireEvent.dragLeave(composer, { dataTransfer: { files: [], items: [], types: ['Files'] } });
        await waitFor(() => expect(screen.queryByTestId('chat-drop-hint')).not.toBeInTheDocument());
    });

    it('a photo carrying a caption shows it under the picture, as the phone does', async () => {
        mockMessagesByConv['conv-1'] = [{
            id: 'img-1', conversationId: 'conv-1', authorPubkey: 'peer-pubkey',
            ciphertext: 'the back fence', nonce: '00000', type: 'image',
            timestamp: '2026-09-14T00:00:00.000Z',
        } as ApiMessage];

        render(<MessagesPage identity={mockIdentity} openConversationId="conv-1" />);

        expect(await screen.findByText('the back fence')).toBeInTheDocument();
    });
});
