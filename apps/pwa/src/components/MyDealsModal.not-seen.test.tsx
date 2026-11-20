/**
 * "Not seen yet" on a deal request in Your deals (DESIGN-notify-and-backup-asks-fable §4.5; amendment 2 §12.3, slice N4):
 * my request still waiting, and the other person's read cursor in our one chat from before it. Core decides
 * (not-seen.test.ts); this holds that the modal hands it the cursor, and nothing else of theirs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { Conversation, MarketplaceTransaction } from '../lib/api';

const api = vi.hoisted(() => ({ conversations: [] as unknown[], calls: 0 }));
vi.mock('../lib/api', () => ({
    getConversations: vi.fn(async () => { api.calls++; return { conversations: api.conversations, totalUnread: 0 }; }),
}));

import { MyDealsModal, peerCursorsFrom } from './MyDealsModal';

const ME = 'me-pubkey';
const ASHA = 'asha-pubkey';
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** My request on Asha's offer, made `age` ago and still waiting for her answer. */
const asked = (age: number, over: Partial<MarketplaceTransaction> = {}): MarketplaceTransaction => ({
    id: 'tx-1', postId: 'post-1', postTitle: 'Ladder', buyerPublicKey: ME, buyerCallsign: 'Me', sellerPublicKey: ASHA,
    sellerCallsign: 'Asha', postAuthorPublicKey: ASHA, postType: 'offer', amount_c: 500, status: 'requested', createdAt: ago(age), ...over,
} as MarketplaceTransaction);
const dm = (peerLastReadAt: string | null, participants = [ME, ASHA]): Conversation => ({
    id: 'conv-1', type: 'dm', name: null, participants, createdBy: ME, createdAt: ago(30 * D), peerLastReadAt,
} as Conversation);

beforeEach(() => { api.conversations = []; api.calls = 0; });
afterEach(() => cleanup());

async function show(txs: MarketplaceTransaction[]) {
    render(<MyDealsModal visible identity={{ publicKey: ME }} onClose={vi.fn()} transactions={txs} initialTab="pending" />);
    await act(async () => {});
}

describe('Your deals: a request that sits unseen', () => {
    it('4 days, Asha not in our chat since: the days and the other way, named', async () => {
        api.conversations = [dm(ago(6 * D))];
        await show([asked(4 * D)]);
        expect(screen.getByTestId('deal-not-seen-tx-1').textContent).toBe('Not seen in 4 days. You could try Asha another way.');
    });

    it('25 hours, chat never read: "Not seen yet."', async () => {
        api.conversations = [dm(null)];
        await show([asked(25 * H)]);
        expect(screen.getByTestId('deal-not-seen-tx-1').textContent).toBe('Not seen yet.');
    });

    it('she has been in our chat since the request: nothing', async () => {
        api.conversations = [dm(ago(D))];
        await show([asked(4 * D)]);
        expect(screen.queryByTestId('deal-not-seen-tx-1')).toBeNull();
    });

    it('no chat between us: no tick to go by, nothing', async () => {
        api.conversations = [dm(null, [ME, 'someone-else'])];
        await show([asked(4 * D)]);
        expect(screen.queryByTestId('deal-not-seen-tx-1')).toBeNull();
    });

    it('a request on MY listing (mine to answer): nothing, and no conversations read', async () => {
        api.conversations = [dm(null)];
        await show([asked(4 * D, { buyerPublicKey: ASHA, buyerCallsign: 'Asha', sellerPublicKey: ME, sellerCallsign: 'Me', postAuthorPublicKey: ME })]);
        expect(screen.queryByTestId('deal-not-seen-tx-1')).toBeNull();
        expect(api.calls).toBe(0);
    });

    it('a deal under way (held): nothing', async () => {
        api.conversations = [dm(null)];
        await show([asked(4 * D, { status: 'pending' })]);
        expect(screen.queryByTestId('deal-not-seen-tx-1')).toBeNull();
    });
});

describe('peerCursorsFrom', () => {
    it('only DMs with me in them; a group chat or someone else\'s chat is not a tick', () => {
        const got = peerCursorsFrom([
            dm('2026-11-01T00:00:00Z'),
            { ...dm('2026-11-20T00:00:00Z'), id: 'g', type: 'group_thread' } as Conversation,
            { ...dm('2026-11-20T00:00:00Z', ['x', ASHA]), id: 'other' } as Conversation,
        ], ME, [ASHA]);
        expect([...got]).toEqual([[ASHA, '2026-11-01T00:00:00Z']]);
    });
    it('never read is kept as null (a chat, no cursor); a peer not asked for is left out', () => {
        const got = peerCursorsFrom([dm(null), { ...dm('2026-11-02T00:00:00Z', [ME, 'bob']), id: 'b' } as Conversation], ME, [ASHA]);
        expect([...got]).toEqual([[ASHA, null]]);
    });
    it('two DMs with one person (should not happen): the newest cursor', () => {
        const got = peerCursorsFrom([dm('2026-11-01T00:00:00Z'), { ...dm('2026-11-05T00:00:00Z'), id: 'c2' } as Conversation, { ...dm(null), id: 'c3' } as Conversation], ME, [ASHA]);
        expect(got.get(ASHA)).toBe('2026-11-05T00:00:00Z');
    });
});
