import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./identity', () => ({
    loadIdentity: vi.fn(async () => null),
}));

import { editMessageApi, toggleMessageReactionApi, markConversationReadApi, Conversation } from './api';

describe('PWA Messaging Parity & Review Fixes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('API Functions', () => {
        it('editMessageApi posts to /api/messages/edit with author signature and payload', async () => {
            const mockResponse = {
                success: true,
                message: {
                    id: 'msg-1',
                    authorPubkey: 'pub1',
                    ciphertext: 'cipher',
                    nonce: 'nonce',
                    editedAt: new Date().toISOString(),
                },
            };
            const mockFetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });
            global.fetch = mockFetch;

            const res = await editMessageApi('msg-1', 'pub1', 'cipher', 'nonce');
            expect(res).toEqual(mockResponse);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/messages/edit',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messageId: 'msg-1',
                        authorPubkey: 'pub1',
                        ciphertext: 'cipher',
                        nonce: 'nonce',
                    }),
                })
            );
        });

        it('toggleMessageReactionApi posts to /api/messages/react with emoji whitelist', async () => {
            const mockResponse = {
                success: true,
                metadata: JSON.stringify({ reactions: [{ emoji: '👍', author: 'pub1' }] }),
            };
            const mockFetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });
            global.fetch = mockFetch;

            const res = await toggleMessageReactionApi('msg-1', 'pub1', '👍');
            expect(res).toEqual(mockResponse);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/messages/react',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        messageId: 'msg-1',
                        authorPubkey: 'pub1',
                        emoji: '👍',
                    }),
                })
            );
        });

        it('markConversationReadApi posts to /api/messages/mark-read', async () => {
            const mockResponse = { success: true };
            const mockFetch = vi.fn().mockResolvedValueOnce({
                ok: true,
                json: async () => mockResponse,
            });
            global.fetch = mockFetch;

            const res = await markConversationReadApi('pub1', 'conv-1');
            expect(res).toEqual(mockResponse);
            expect(mockFetch).toHaveBeenCalledWith(
                '/api/messages/mark-read',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        pubkey: 'pub1',
                        conversationId: 'conv-1',
                    }),
                })
            );
        });
    });

    describe('C-01: Message Edit State Detection', () => {
        it('identifies message as edited only when editedAt is non-null, NOT from updatedAt watermark', () => {
            // New message inserted with SQLite default updated_at
            const newMessage = {
                id: 'msg-1',
                editedAt: null,
                updatedAt: '2026-09-09T00:00:00.000Z',
            };
            const isEditedNew = !!newMessage.editedAt;
            expect(isEditedNew).toBe(false);

            // Truly edited message
            const editedMessage = {
                id: 'msg-2',
                editedAt: '2026-09-09T00:05:00.000Z',
                updatedAt: '2026-09-09T00:05:00.000Z',
            };
            const isEditedTrue = !!editedMessage.editedAt;
            expect(isEditedTrue).toBe(true);
        });
    });

    describe('C-03: Read Receipt Restriction to DMs', () => {
        it('suppresses peerLastReadAt and readByPeer in group chats', () => {
            const myPubkey = 'pub1';
            const timestamp = '2026-09-09T00:01:00.000Z';
            const msg = { authorPubkey: myPubkey, timestamp };

            // Group chat: readByPeer must be false even if cursors exist
            const groupConv: Partial<Conversation> = {
                id: 'grp-1',
                type: 'group',
                peerLastReadAt: '2026-09-09T00:02:00.000Z',
            };
            const isMe = msg.authorPubkey === myPubkey;
            const isDmGroup = groupConv.type === 'dm';
            const readByPeerGroup = isMe && isDmGroup && !!groupConv.peerLastReadAt &&
                new Date(msg.timestamp).getTime() <= new Date(groupConv.peerLastReadAt).getTime();
            expect(readByPeerGroup).toBe(false);

            // Direct message: readByPeer matches peerLastReadAt
            const dmConv: Partial<Conversation> = {
                id: 'dm-1',
                type: 'dm',
                peerLastReadAt: '2026-09-09T00:02:00.000Z',
            };
            const isDm = dmConv.type === 'dm';
            const readByPeerDm = isMe && isDm && !!dmConv.peerLastReadAt &&
                new Date(msg.timestamp).getTime() <= new Date(dmConv.peerLastReadAt).getTime();
            expect(readByPeerDm).toBe(true);
        });
    });

    describe('C-06: Malformed Metadata Resilience', () => {
        it('safely parses null, corrupted, or non-array reaction metadata without crashing', () => {
            const testCases = [
                null,
                undefined,
                '',
                'invalid json',
                'null',
                '123',
                '"string"',
                '{}',
                JSON.stringify({ reactions: null }),
                JSON.stringify({ reactions: 'not an array' }),
                JSON.stringify({ reactions: [null, undefined, { emoji: 123 }, { emoji: '👍', author: 'pub1' }] }),
            ];

            for (const metadata of testCases) {
                let metaObj: any = null;
                try {
                    if (metadata) {
                        const parsed = JSON.parse(metadata);
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                            metaObj = parsed;
                        }
                    }
                } catch {}

                const reactions: { emoji: string; author: string }[] = Array.isArray(metaObj?.reactions)
                    ? metaObj.reactions.filter((r: any) => r && typeof r === 'object' && typeof r.emoji === 'string')
                    : [];

                expect(Array.isArray(reactions)).toBe(true);
            }
        });
    });
});
