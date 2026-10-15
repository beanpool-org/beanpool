import { describe, it, expect } from 'vitest';
import { releaseLineTradeId, type PhoneTradeRow } from '../release-line-trade';

// Alice bought Bob's repeatable offer twice; Carol bought it once. As the phone's table holds them, newest first.
const rows: PhoneTradeRow[] = [
    { id: 't2', post_id: 'post-1', buyer_pubkey: 'alice', seller_pubkey: 'bob', completed_at: '2026-09-20T00:00:00.000Z' },
    { id: 'tc', post_id: 'post-1', buyer_pubkey: 'carol', seller_pubkey: 'bob', completed_at: '2026-09-15T00:00:00.000Z' },
    { id: 't1', post_id: 'post-1', buyer_pubkey: 'alice', seller_pubkey: 'bob', completed_at: '2026-09-10T00:00:00.000Z' },
];
const oldMeta = { postId: 'post-1', buyerPubkey: 'alice', sellerPubkey: 'bob' };

describe('releaseLineTradeId: the phone reads a release line as the web does (review #1980 B1)', () => {
    it('a line with its transactionId is that trade', () => {
        expect(releaseLineTradeId(rows, { ...oldMeta, transactionId: 't1' }, '2026-09-20T00:00:00Z', 'alice', 'bob')).toBe('t1');
    });

    it('an old line (no id) is the trade on its post between its two people that finished with it', () => {
        expect(releaseLineTradeId(rows, oldMeta, '2026-09-10T00:00:00.120Z', 'alice', 'bob')).toBe('t1');
        expect(releaseLineTradeId(rows, oldMeta, '2026-09-20T00:00:00.080Z', 'alice', 'bob')).toBe('t2');
    });

    it('never another buyer\'s trade on the same post, even nearest in time', () => {
        expect(releaseLineTradeId(rows, oldMeta, '2026-09-15T00:00:00Z', 'alice', 'bob')).not.toBe('tc');
        // Bob's chat with Carol: her line is her trade.
        expect(releaseLineTradeId(rows, { postId: 'post-1', buyerPubkey: 'carol', sellerPubkey: 'bob' }, '2026-09-20T00:00:00Z', 'bob', 'carol')).toBe('tc');
    });

    it('a line that names nobody: me and this chat\'s peer; with no peer known, no answer', () => {
        expect(releaseLineTradeId(rows, { postId: 'post-1' }, '2026-09-10T00:00:00Z', 'bob', 'alice')).toBe('t1');
        expect(releaseLineTradeId(rows, { postId: 'post-1' }, '2026-09-15T00:00:00Z', 'bob', 'carol')).toBe('tc');
        expect(releaseLineTradeId(rows, { postId: 'post-1' }, '2026-09-10T00:00:00Z', 'bob', null)).toBeNull();
    });

    it('a trade the phone does not hold, or a line without a post: no answer', () => {
        expect(releaseLineTradeId(rows, { postId: 'post-2', buyerPubkey: 'alice', sellerPubkey: 'bob' }, '2026-09-10T00:00:00Z', 'alice', 'bob')).toBeNull();
        expect(releaseLineTradeId(rows, {}, '2026-09-10T00:00:00Z', 'alice', 'bob')).toBeNull();
        expect(releaseLineTradeId(rows, null, '2026-09-10T00:00:00Z', 'alice', 'bob')).toBeNull();
    });
});
