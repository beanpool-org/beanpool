import { describe, it, expect } from 'vitest';
import {
    livePostChange,
    pushedPostIsStale,
    LIVE_POST_TYPES,
    reconnectDelayMs,
    reconnectSyncDelayMs,
    RECONNECT_CAP_MS,
    RECONNECT_MIN_SPREAD_MS,
    RECONNECT_SYNC_SPREAD_MS,
} from '../live-updates.js';

// The shape the node's `new_post` / `post_updated` broadcasts carry to a member socket: `publicBroadcastPost` of a
// `getPosts` row (apps/server/src/engine/posts.ts).
function offer(extra: Record<string, unknown> = {}) {
    return {
        id: 'post-1',
        type: 'offer',
        category: 'food',
        title: 'Spare lemons',
        description: 'A bag of them',
        credits: 5,
        authorPublicKey: 'a'.repeat(64),
        authorCallsign: 'Ann',
        createdAt: '2026-09-24T01:00:00.000Z',
        updatedAt: '2026-09-24T01:00:00.000Z',
        active: true,
        status: 'active',
        audienceScope: 'public',
        photos: ['/api/marketplace/posts/post-1/photos/0?v=0'],
        ...extra,
    };
}

describe('livePostChange: what an app may apply from a /ws event without fetching', () => {
    it('a new_post carrying a public offer is an upsert, marked as a creation', () => {
        const post = offer();
        expect(livePostChange({ type: 'new_post', post })).toEqual({ kind: 'upsert', post, created: true });
    });

    it('a post_updated carrying a public need is an upsert, not a creation', () => {
        const post = offer({ type: 'need' });
        expect(livePostChange({ type: 'post_updated', post })).toEqual({ kind: 'upsert', post, created: false });
    });

    it('a post_removed naming a public post is a removal', () => {
        expect(livePostChange({ type: 'post_removed', id: 'post-1', audienceScope: 'public' }))
            .toEqual({ kind: 'remove', id: 'post-1' });
    });

    // A socket without a verified member gets `{ type }` only, and pause/resume send `{ type, id }` with no post.
    it.each([
        [{ type: 'new_post' }],
        [{ type: 'post_updated' }],
        [{ type: 'post_updated', id: 'post-1' }],
        [{ type: 'post_removed' }],
        [{ type: 'new_post', post: { id: 'p-1' } }],
    ])('a doorbell or a payload too thin to render (%j) is not applied', (event) => {
        expect(livePostChange(event)).toBeNull();
    });

    // Group and direct posts go to their recipients only (`recipients` in broadcast()); they keep the doorbell.
    it.each(['group', 'direct'])('a %s post is not applied', (scope) => {
        expect(livePostChange({ type: 'new_post', post: offer({ audienceScope: scope, targetGroupId: 'g1' }) })).toBeNull();
        expect(livePostChange({ type: 'post_updated', post: offer({ audienceScope: scope }) })).toBeNull();
        expect(livePostChange({ type: 'post_removed', id: 'post-1', audienceScope: scope })).toBeNull();
    });

    // A node that predates the field says nothing about the audience, and "unknown" must not read as "public".
    it('a payload that does not name its audience is not applied', () => {
        const { audienceScope: _drop, ...noScope } = offer();
        expect(livePostChange({ type: 'new_post', post: noScope })).toBeNull();
        expect(livePostChange({ type: 'post_removed', id: 'post-1' })).toBeNull();
    });

    // An event's broadcast has the host's note, RSVP list and the reader's own RSVP taken off, and a poll's carries
    // the voter's own choice: neither is what every reader's own sync would return, so both keep the doorbell.
    it.each(['event', 'poll', 'something-new'])('a %s post is not applied', (type) => {
        expect(livePostChange({ type: 'new_post', post: offer({ type }) })).toBeNull();
        expect(livePostChange({ type: 'post_updated', post: offer({ type }) })).toBeNull();
    });

    it('only offers and needs are live-applied', () => {
        expect([...LIVE_POST_TYPES].sort()).toEqual(['need', 'offer']);
    });

    it('a post with no timestamp to order it by is not applied', () => {
        expect(livePostChange({ type: 'post_updated', post: offer({ updatedAt: undefined }) })).toBeNull();
        expect(livePostChange({ type: 'post_updated', post: offer({ updatedAt: 'not a date' }) })).toBeNull();
    });

    it.each([
        ['transaction_completed', { type: 'transaction_completed' }],
        ['profile_updated', { type: 'profile_updated', publicKey: 'a'.repeat(64) }],
        ['new_message', { type: 'new_message', conversationId: 'c1', message: {} }],
        ['state_synced', { type: 'state_synced' }],
        ['decision_updated', { type: 'decision_updated', decision: { id: 'd1' } }],
        ['a post under another key', { type: 'post_accepted', postId: 'post-1', post: offer() }],
    ])('%s is not a live post change', (_name, event) => {
        expect(livePostChange(event)).toBeNull();
    });

    it.each([null, undefined, 'new_post', 42, [], { post: offer() }])('garbage (%j) is not a live post change', (event) => {
        expect(livePostChange(event)).toBeNull();
    });
});

describe('pushedPostIsStale: a late push never overwrites a newer copy', () => {
    it('is stale only when the local copy is strictly newer', () => {
        expect(pushedPostIsStale('2026-09-24T01:00:00.001Z', '2026-09-24T01:00:00.000Z')).toBe(true);
        expect(pushedPostIsStale('2026-09-24T01:00:00.000Z', '2026-09-24T01:00:00.000Z')).toBe(false);
        expect(pushedPostIsStale('2026-09-24T00:59:59.999Z', '2026-09-24T01:00:00.000Z')).toBe(false);
    });

    it('a local copy with no usable timestamp never blocks a push', () => {
        expect(pushedPostIsStale(null, '2026-09-24T01:00:00.000Z')).toBe(false);
        expect(pushedPostIsStale(undefined, '2026-09-24T01:00:00.000Z')).toBe(false);
        expect(pushedPostIsStale('garbage', '2026-09-24T01:00:00.000Z')).toBe(false);
    });

    // SQLite's strftime and JavaScript's toISOString write the same instant differently when one drops the ms.
    it('compares instants, not strings', () => {
        expect(pushedPostIsStale('2026-09-24T01:00:01Z', '2026-09-24T01:00:00.500Z')).toBe(true);
        expect(pushedPostIsStale('2026-09-24T01:00:00Z', '2026-09-24T01:00:00.500Z')).toBe(false);
    });
});

describe('reconnectDelayMs: full jitter, so a restarted edge does not get every phone back in the same second', () => {
    const draws = (n: number) => Array.from({ length: n }, (_, i) => (i + 0.5) / n);

    it('the first retry is spread over the whole 0–5 s window', () => {
        const delays = draws(1000).map(r => reconnectDelayMs(0, () => r));
        expect(Math.min(...delays)).toBeGreaterThanOrEqual(0);
        expect(Math.max(...delays)).toBeLessThanOrEqual(RECONNECT_MIN_SPREAD_MS);
        // Spread, not bunched: the draws fill the window rather than sitting in the old 1–2 s band.
        expect(Math.min(...delays)).toBeLessThan(500);
        expect(Math.max(...delays)).toBeGreaterThan(4500);
        expect(RECONNECT_MIN_SPREAD_MS).toBe(5000);
    });

    it('with Math.random, 10 000 first retries all land in [0, 5 s]', () => {
        for (let i = 0; i < 10_000; i++) {
            const d = reconnectDelayMs(0);
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(5000);
        }
    });

    it('the window doubles per attempt from 1 s and never passes the 30 s cap', () => {
        const ceiling = (attempt: number) => reconnectDelayMs(attempt, () => 1 - Number.EPSILON);
        expect(ceiling(0)).toBeLessThanOrEqual(5000);
        expect(ceiling(3)).toBeGreaterThan(7000);
        expect(ceiling(3)).toBeLessThanOrEqual(8000);
        expect(ceiling(4)).toBeGreaterThan(15_000);
        expect(ceiling(4)).toBeLessThanOrEqual(16_000);
        for (const attempt of [5, 6, 10, 50, 1000, Number.MAX_SAFE_INTEGER]) {
            expect(ceiling(attempt)).toBeLessThanOrEqual(RECONNECT_CAP_MS);
            expect(ceiling(attempt)).toBeGreaterThan(29_000);
        }
        expect(RECONNECT_CAP_MS).toBe(30_000);
    });

    it('with Math.random, no attempt ever waits more than 30 s', () => {
        for (let attempt = 0; attempt < 40; attempt++) {
            for (let i = 0; i < 500; i++) {
                const d = reconnectDelayMs(attempt);
                expect(d).toBeGreaterThanOrEqual(0);
                expect(d).toBeLessThanOrEqual(30_000);
            }
        }
    });

    it('a nonsense attempt count is treated as the first attempt, never as NaN or a negative wait', () => {
        for (const attempt of [-1, NaN, Infinity, -Infinity]) {
            const d = reconnectDelayMs(attempt, () => 0.5);
            expect(Number.isFinite(d)).toBe(true);
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(30_000);
        }
    });
});

describe('reconnectSyncDelayMs: the catch-up sync after a reconnect is spread too', () => {
    it('lands in [0, 3 s]', () => {
        expect(RECONNECT_SYNC_SPREAD_MS).toBe(3000);
        for (let i = 0; i < 10_000; i++) {
            const d = reconnectSyncDelayMs();
            expect(d).toBeGreaterThanOrEqual(0);
            expect(d).toBeLessThanOrEqual(3000);
        }
        expect(reconnectSyncDelayMs(() => 0)).toBe(0);
        expect(reconnectSyncDelayMs(() => 1 - Number.EPSILON)).toBeGreaterThan(2900);
    });
});
