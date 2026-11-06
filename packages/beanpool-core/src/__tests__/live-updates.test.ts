import { afterEach, describe, it, expect, vi } from 'vitest';
import {
    livePostChange,
    pushedPostIsStale,
    LIVE_POST_TYPES,
    reconnectDelayMs,
    reconnectSyncDelayMs,
    RECONNECT_CAP_MS,
    RECONNECT_MIN_SPREAD_MS,
    RECONNECT_SYNC_SPREAD_MS,
    WS_NO_ROOM_CLOSE_CODE,
    WS_NO_ROOM_RETRY_SEC,
    WS_NO_ROOM_MIN_SEC,
    WS_NO_ROOM_CAP_MS,
    wsNoRoomReason,
    wsNoRoomRetrySec,
    wsNoRoomDelayMs,
    socketAlive,
    messageBackstopDue,
    MESSAGE_BACKSTOP_ALIVE_MS,
    MESSAGE_BACKSTOP_DOWN_MS,
    MESSAGE_BACKSTOP_TICK_MS,
    WIDE_DOORBELL_TYPES,
    WIDE_SYNC_SPREAD_MS,
    wideSyncDelayMs,
    isWideDoorbell,
    createDeferredSync,
    isOthersListingDoorbell,
    isCrowdDoorbell,
    crowdBellDelayMs,
    homeBellDelayMs,
    createHomeBellSettle,
    HOME_BELL_SETTLE_MS,
    HOME_BELL_CROWD_MAX_MS,
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
        const noScope: Record<string, unknown> = offer();
        delete noScope.audienceScope;
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

describe('the "no room" close: a node with no place for a socket says when to come back', () => {
    it('the reason a node sends reads back as its seconds; any other close is no "no room"', () => {
        expect(WS_NO_ROOM_CLOSE_CODE).toBe(4429);
        expect(wsNoRoomReason(300)).toBe('retry=300');
        expect(wsNoRoomRetrySec(WS_NO_ROOM_CLOSE_CODE, wsNoRoomReason(300))).toBe(300);
        expect(wsNoRoomRetrySec(WS_NO_ROOM_CLOSE_CODE, wsNoRoomReason(42.4))).toBe(42);
        expect(wsNoRoomRetrySec(1000, 'retry=300')).toBeNull();
        expect(wsNoRoomRetrySec(1006, '')).toBeNull();
        expect(wsNoRoomRetrySec(undefined, undefined)).toBeNull();
        expect(new TextEncoder().encode(wsNoRoomReason(999_999)).length).toBeLessThanOrEqual(123);
    });

    it('a "no room" close with a reason that cannot be read asks for the default 5 minutes', () => {
        expect(WS_NO_ROOM_RETRY_SEC).toBe(300);
        for (const reason of ['', 'retry=', 'retry=abc', 'retry=-5', 'come back later', 'retry=1234567', undefined, null, 7]) {
            expect(wsNoRoomRetrySec(WS_NO_ROOM_CLOSE_CODE, reason)).toBe(300);
        }
    });

    it('the first wait is what the node asked, plus up to half again', () => {
        expect(wsNoRoomDelayMs(1, 300, () => 0)).toBe(300_000);
        expect(wsNoRoomDelayMs(1, 300, () => 0.9999)).toBeLessThan(450_000);
        expect(wsNoRoomDelayMs(1, 300, () => 0.9999)).toBeGreaterThan(449_000);
        for (let i = 0; i < 10_000; i++) {
            const d = wsNoRoomDelayMs(1, 300);
            expect(d).toBeGreaterThanOrEqual(300_000);
            expect(d).toBeLessThan(450_000);
        }
    });

    it('each refusal in a row doubles it, never past 30 minutes before the spread', () => {
        expect(wsNoRoomDelayMs(2, 300, () => 0)).toBe(600_000);
        expect(wsNoRoomDelayMs(3, 300, () => 0)).toBe(1_200_000);
        expect(wsNoRoomDelayMs(4, 300, () => 0)).toBe(WS_NO_ROOM_CAP_MS);
        expect(wsNoRoomDelayMs(1e9, 300, () => 0)).toBe(WS_NO_ROOM_CAP_MS);
        expect(wsNoRoomDelayMs(1e9, 300, () => 0.9999)).toBeLessThan(WS_NO_ROOM_CAP_MS * 1.5);
    });

    it('a node asking for almost nothing is waited on for 30 s at least; nonsense counts as a first refusal', () => {
        expect(wsNoRoomDelayMs(1, 0, () => 0)).toBe(WS_NO_ROOM_MIN_SEC * 1000);
        expect(wsNoRoomDelayMs(1, -10, () => 0)).toBe(30_000);
        expect(wsNoRoomDelayMs(1, NaN, () => 0)).toBe(300_000);
        expect(wsNoRoomDelayMs(0, 300, () => 0)).toBe(300_000);
        expect(wsNoRoomDelayMs(NaN, 300, () => 0)).toBe(300_000);
        expect(wsNoRoomDelayMs(-3, 300, () => 0)).toBe(300_000);
    });

    it('is always far longer than an ordinary reconnect, which a dropped socket keeps', () => {
        for (let i = 0; i < 1000; i++) expect(wsNoRoomDelayMs(1, WS_NO_ROOM_RETRY_SEC)).toBeGreaterThan(RECONNECT_CAP_MS);
    });
});

describe('the message backstop (slice L0)', () => {
    const PONG = 75_000;
    const now = 1_000_000;

    it('counts the socket alive only open, signed by the member and answering pings', () => {
        expect(socketAlive(true, true, now - 30_000, now, PONG)).toBe(true);
        expect(socketAlive(false, true, now - 1000, now, PONG)).toBe(false);
        // Signed by nobody: bare doorbells only, never `new_message`.
        expect(socketAlive(true, false, now - 1000, now, PONG)).toBe(false);
        // Let in and closed for want of room, or never answered: no pong.
        expect(socketAlive(true, true, null, now, PONG)).toBe(false);
        // Quiet for the watchdog's limit.
        expect(socketAlive(true, true, now - PONG, now, PONG)).toBe(false);
    });

    it('reads on every tick while the socket is down, and every 120 s while it is alive', () => {
        expect(messageBackstopDue(now - 1, now, false)).toBe(true);
        expect(messageBackstopDue(now - 30_000, now, true)).toBe(false);
        expect(messageBackstopDue(now - 90_000, now, true)).toBe(false);
        expect(messageBackstopDue(now - MESSAGE_BACKSTOP_ALIVE_MS, now, true)).toBe(true);
    });

    it('on a jittered 30 s tick: about every 120 s alive, every tick down', () => {
        for (const tick of [MESSAGE_BACKSTOP_TICK_MS * 0.8, MESSAGE_BACKSTOP_TICK_MS, MESSAGE_BACKSTOP_TICK_MS * 1.2]) {
            for (const alive of [true, false]) {
                let last = 0;
                const gaps: number[] = [];
                for (let t = tick; t <= 3_600_000; t += tick) {
                    if (messageBackstopDue(last, t, alive)) { gaps.push(t - last); last = t; }
                }
                expect(gaps.length).toBeGreaterThan(10);
                for (const gap of gaps.slice(1)) {
                    if (!alive) { expect(gap).toBe(tick); continue; }
                    expect(gap).toBeGreaterThanOrEqual(MESSAGE_BACKSTOP_ALIVE_MS - MESSAGE_BACKSTOP_TICK_MS / 2);
                    expect(gap).toBeLessThan(MESSAGE_BACKSTOP_ALIVE_MS + tick);
                }
            }
        }
        expect(MESSAGE_BACKSTOP_DOWN_MS).toBe(MESSAGE_BACKSTOP_TICK_MS);
    });
});

describe('wide doorbells (capacity REPORT bottleneck 2)', () => {
    const ME = 'a'.repeat(64);
    const OTHER = 'b'.repeat(64);

    it('are the five events the node sends every member socket that only a few screens show', () => {
        expect([...WIDE_DOORBELL_TYPES].sort()).toEqual(['group_created', 'group_updated', 'profile_updated', 'system_announcement', 'user_pruned']);
    });

    it('a group made or changed, and an announcement, are wide for everyone', () => {
        for (const type of ['group_created', 'group_updated', 'system_announcement']) {
            expect(isWideDoorbell({ type }, ME)).toBe(true);
            expect(isWideDoorbell({ type }, null)).toBe(true);
        }
    });

    // Review of #2899 (live-updates.ts:229): the node sends an open group's create or change to every socket, and a
    // private group's only to its members (state-engine.ts createGroup, updateGroup, updateGroupPolicy, afterGroupVote,
    // addPlaceCircleMember). Only the first is the storm; the rest keep their immediate refresh.
    it("a group made or changed is wide only when the group it carries is open", () => {
        const open = { id: 'g1', name: 'Seed swap', joinPolicy: 'open', memberCount: 12 };
        for (const type of ['group_created', 'group_updated']) {
            expect(isWideDoorbell({ type, group: open }, ME)).toBe(true);
            expect(isWideDoorbell({ type, group: open }, null)).toBe(true);
        }
        // updateGroup / updateGroupPolicy on a private group: to its members only.
        for (const joinPolicy of ['invite_only', 'request_to_join']) {
            const group = { id: 'g2', name: 'Kitchen roster', joinPolicy, memberCount: 4 };
            expect(isWideDoorbell({ type: 'group_updated', group }, ME)).toBe(false);
            // createGroup of a group that is not open: to its creator only.
            expect(isWideDoorbell({ type: 'group_created', group }, ME)).toBe(false);
        }
        // A private group closed by vote (afterGroupVote 'closed', no target): group_updated to its members only.
        expect(isWideDoorbell({ type: 'group_updated', group: { id: 'g3', name: 'Old bees', joinPolicy: 'request_to_join', memberCount: 3 } }, ME)).toBe(false);
        // Someone seated in a place circle (addPlaceCircleMember): group_created to that one member. A circle stays invite-only.
        expect(isWideDoorbell({ type: 'group_created', group: { id: 'c1', name: 'Near you', joinPolicy: 'invite_only', kind: 'circle', memberCount: 2 } }, ME)).toBe(false);
        // A group with no policy said is not open.
        expect(isWideDoorbell({ type: 'group_updated', group: { id: 'g4', name: 'Unsaid' } }, ME)).toBe(false);
    });

    it("a card change or removal is wide unless it names the member themself; one naming nobody is wide", () => {
        for (const type of ['profile_updated', 'user_pruned']) {
            expect(isWideDoorbell({ type, publicKey: OTHER }, ME)).toBe(true);
            expect(isWideDoorbell({ type, publicKey: ME }, ME)).toBe(false);
            expect(isWideDoorbell({ type }, ME)).toBe(true);
            expect(isWideDoorbell({ type, publicKey: '' }, ME)).toBe(true);
            // A socket with no member's key: nobody is "themself".
            expect(isWideDoorbell({ type, publicKey: ME }, null)).toBe(true);
        }
    });

    it('nothing else is: a message, a listing, a trade, a join, garbage', () => {
        for (const ev of [{ type: 'new_message' }, { type: 'new_post' }, { type: 'post_removed' }, { type: 'transaction_completed' },
            { type: 'member_joined' }, { type: 'group_member_updated' }, {}, null, 'group_created', [{ type: 'group_created' }]]) {
            expect(isWideDoorbell(ev, ME)).toBe(false);
        }
    });

    it('the deferred sync waits a uniformly random 0 to 5 minutes', () => {
        expect(WIDE_SYNC_SPREAD_MS).toBe(300_000);
        expect(wideSyncDelayMs(() => 0)).toBe(0);
        expect(wideSyncDelayMs(() => 0.5)).toBe(150_000);
        expect(wideSyncDelayMs(() => 0.999999)).toBeLessThan(300_000);
    });

    function harness(random = 0.5) {
        let clock = 1_000_000;
        let startedAt = 0;
        const timers: Array<{ at: number; fn: () => void; id: number }> = [];
        let nextId = 1;
        const run = vi.fn();
        const d = createDeferredSync({
            run,
            lastSyncStartedAt: () => startedAt,
            now: () => clock,
            random: () => random,
            setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: clock + ms, fn, id }); return id; },
            clearTimer: (id) => { const i = timers.findIndex(t => t.id === id); if (i >= 0) timers.splice(i, 1); },
        });
        const advance = (ms: number) => {
            clock += ms;
            for (const t of [...timers].sort((x, y) => x.at - y.at)) {
                if (t.at > clock) continue;
                timers.splice(timers.indexOf(t), 1);
                t.fn();
            }
        };
        return { d, run, advance, timers, syncStarts: () => { startedAt = clock; } };
    }

    it('one ask: one sync, after its random wait, not before', () => {
        const h = harness(0.5);
        h.d.ask();
        expect(h.d.isPending()).toBe(true);
        h.advance(149_999);
        expect(h.run).not.toHaveBeenCalled();
        h.advance(1);
        expect(h.run).toHaveBeenCalledTimes(1);
        expect(h.d.isPending()).toBe(false);
    });

    it('a burst of asks sets one timer and runs one sync', () => {
        const h = harness(0.9);
        for (let i = 0; i < 50; i++) { h.d.ask(); h.advance(1_000); }
        expect(h.timers.length).toBeLessThanOrEqual(1);
        h.advance(300_000);
        expect(h.run).toHaveBeenCalledTimes(1);
    });

    it('a sync started after the last ask takes its place; one started before a later ask does not', () => {
        const h = harness(0.5);
        h.d.ask();
        h.advance(10_000);
        h.syncStarts();
        h.advance(200_000);
        expect(h.run).not.toHaveBeenCalled();

        h.d.ask();
        h.advance(10_000);
        h.syncStarts();
        h.advance(10_000);
        h.d.ask();
        h.advance(200_000);
        expect(h.run).toHaveBeenCalledTimes(1);
    });

    it('a sync started before the ask (already running when the doorbell came) does not take its place', () => {
        const h = harness(0.5);
        h.syncStarts();
        h.advance(1);
        h.d.ask();
        h.advance(200_000);
        expect(h.run).toHaveBeenCalledTimes(1);
    });

    it('cancel drops the owed sync; a later ask sets a new one', () => {
        const h = harness(0.5);
        h.d.ask();
        h.d.cancel();
        expect(h.d.isPending()).toBe(false);
        h.advance(300_000);
        expect(h.run).not.toHaveBeenCalled();
        h.d.ask();
        h.advance(300_000);
        expect(h.run).toHaveBeenCalledTimes(1);
    });
});

// The listing doorbell: a new listing by someone else must not send every nearby phone to read its chats and its groups
// (scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md §8 fix 2), and Home's wait after a crowd's bell is a
// random turn, not the same 3 s on every phone.
describe('isOthersListingDoorbell: a new public listing by someone else', () => {
    const ME = 'm'.repeat(64);
    const event = (extra: Record<string, unknown> = {}) => ({ type: 'new_post', post: offer({ type: 'event', ...extra }) });

    it.each([['an event', 'event'], ['a poll', 'poll'], ['an offer', 'offer'], ['a need', 'need']])('%s by someone else is one', (_n, type) => {
        expect(isOthersListingDoorbell({ type: 'new_post', post: offer({ type }) }, ME)).toBe(true);
    });

    it('the member\'s own listing, or one they took, is not (it is theirs: their chats and groups may change)', () => {
        expect(isOthersListingDoorbell(event({ authorPublicKey: ME }), ME)).toBe(false);
        expect(isOthersListingDoorbell(event({ acceptedBy: ME }), ME)).toBe(false);
    });

    it('a group or direct listing is not (it reached its recipients only), nor one that does not say it is public', () => {
        expect(isOthersListingDoorbell(event({ audienceScope: 'group' }), ME)).toBe(false);
        expect(isOthersListingDoorbell(event({ audienceScope: 'direct' }), ME)).toBe(false);
        expect(isOthersListingDoorbell(event({ audienceScope: undefined }), ME)).toBe(false);
    });

    it('only a creation is: an update or a removal can change a chat the member is in, so they read as before', () => {
        expect(isOthersListingDoorbell({ type: 'post_updated', post: offer() }, ME)).toBe(false);
        expect(isOthersListingDoorbell({ type: 'post_removed', id: 'post-1', audienceScope: 'public' }, ME)).toBe(false);
    });

    it('a chat, a group, a trade or a bare doorbell is not, and nothing is when the member is not known', () => {
        for (const type of ['new_message', 'group_member_invited', 'transaction_completed', 'profile_updated']) {
            expect(isOthersListingDoorbell({ type }, ME)).toBe(false);
        }
        expect(isOthersListingDoorbell({ type: 'new_post' }, ME)).toBe(false);
        expect(isOthersListingDoorbell({ type: 'new_post', post: 'x' }, ME)).toBe(false);
        expect(isOthersListingDoorbell(null, ME)).toBe(false);
        expect(isOthersListingDoorbell(event(), null)).toBe(false);
        expect(isOthersListingDoorbell(event(), undefined)).toBe(false);
    });
});

describe('isCrowdDoorbell and crowdBellDelayMs: Home\'s turn after a bell that reached a crowd', () => {
    const ME = 'm'.repeat(64);

    it('a listing by someone else, a decision vote and a wide doorbell are a crowd', () => {
        expect(isCrowdDoorbell({ type: 'new_post', post: offer({ type: 'event' }) }, ME)).toBe(true);
        expect(isCrowdDoorbell({ type: 'decision_vote_cast' }, ME)).toBe(true);
        expect(isCrowdDoorbell({ type: 'profile_updated', publicKey: 'x'.repeat(64) }, ME)).toBe(true);
        expect(isCrowdDoorbell({ type: 'group_updated', group: { joinPolicy: 'open' } }, ME)).toBe(true);
    });

    it('a notice is not: the alert shows it at once and the Notices card on Home follows 3 s on, as before', () => {
        expect(isCrowdDoorbell({ type: 'system_announcement' }, ME)).toBe(false);
        expect(homeBellDelayMs({ type: 'system_announcement' }, ME, () => 0.5)).toBe(3_000);
    });

    it('the member\'s own post, their own card, a private group and a deal\'s step are not: they read in 3 s as before', () => {
        expect(isCrowdDoorbell({ type: 'new_post', post: offer({ authorPublicKey: ME }) }, ME)).toBe(false);
        expect(isCrowdDoorbell({ type: 'profile_updated', publicKey: ME }, ME)).toBe(false);
        expect(isCrowdDoorbell({ type: 'group_updated', group: { joinPolicy: 'invite' } }, ME)).toBe(false);
        expect(isCrowdDoorbell({ type: 'transaction_completed' }, ME)).toBe(false);
        expect(isCrowdDoorbell({ type: 'new_post', post: offer({ audienceScope: 'group' }) }, ME)).toBe(false);
    });

    it('the delay is a whole number of ms from 3 s to 15 s, the ends included, whatever the random source says', () => {
        expect(crowdBellDelayMs(() => 0)).toBe(HOME_BELL_SETTLE_MS);
        expect(crowdBellDelayMs(() => 0.9999999)).toBe(HOME_BELL_CROWD_MAX_MS);
        expect(crowdBellDelayMs(() => 1)).toBe(HOME_BELL_CROWD_MAX_MS);
        expect(crowdBellDelayMs(() => 0.5)).toBe(9_000);
        expect(crowdBellDelayMs(() => -3)).toBe(HOME_BELL_SETTLE_MS);
        expect(crowdBellDelayMs(() => 7)).toBe(HOME_BELL_CROWD_MAX_MS);
        expect(crowdBellDelayMs(() => NaN)).toBe(HOME_BELL_SETTLE_MS);
        expect(HOME_BELL_SETTLE_MS).toBe(3_000);
        expect(HOME_BELL_CROWD_MAX_MS).toBe(15_000);
    });

    it('with the real random source the delays are spread over the whole window, never outside it', () => {
        const seen = new Set<number>();
        for (let i = 0; i < 2_000; i++) {
            const d = crowdBellDelayMs();
            expect(Number.isInteger(d)).toBe(true);
            expect(d).toBeGreaterThanOrEqual(3_000);
            expect(d).toBeLessThanOrEqual(15_000);
            seen.add(Math.floor(d / 1_000));
        }
        // 2,000 draws over twelve whole seconds: every second of the window shows up (a flat 3 s would show one).
        expect(seen.size).toBeGreaterThanOrEqual(12);
    });

    it('homeBellDelayMs: a crowd waits its random turn, anything else 3 s', () => {
        expect(homeBellDelayMs({ type: 'new_post', post: offer() }, ME, () => 0.5)).toBe(9_000);
        expect(homeBellDelayMs({ type: 'new_post', post: offer({ authorPublicKey: ME }) }, ME, () => 0.5)).toBe(3_000);
        expect(homeBellDelayMs({ type: 'transaction_completed' }, ME, () => 0.5)).toBe(3_000);
    });
});

describe('createHomeBellSettle: how Home waits after its doorbells, on the phone and on the web', () => {
    const device = (draw: () => number) => {
        vi.useFakeTimers();
        const run = vi.fn();
        const settle = createHomeBellSettle({ run, crowdDelayMs: () => crowdBellDelayMs(draw) });
        return { run, settle };
    };
    afterEach(() => { vi.useRealTimers(); });

    it('a bell about the member is read 3 s after the last, each one pushing it back', () => {
        const { run, settle } = device(() => 0.9);
        settle.ring(false);
        vi.advanceTimersByTime(2_000);
        settle.ring(false);
        vi.advanceTimersByTime(2_999);
        expect(run).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(1);
        expect(settle.isPending()).toBe(false);
    });

    it('a crowd\'s bell is read at this device\'s own draw from 3 s to 15 s, once, however many ring after it', () => {
        for (const [draw, ms] of [[0, 3_000], [0.5, 9_000], [1, 15_000]] as const) {
            const { run, settle } = device(() => draw);
            settle.ring(true);
            for (let i = 0; i < 5; i++) { vi.advanceTimersByTime(Math.floor((ms - 1) / 5)); settle.ring(true); }
            expect(run).not.toHaveBeenCalled();
            vi.advanceTimersByTime(ms);
            expect(run).toHaveBeenCalledTimes(1);
            vi.advanceTimersByTime(60_000);
            expect(run).toHaveBeenCalledTimes(1);
            vi.useRealTimers();
        }
    });

    it('two devices that draw differently read at different moments for the same bell', () => {
        vi.useFakeTimers();
        const early = vi.fn();
        const late = vi.fn();
        createHomeBellSettle({ run: early, crowdDelayMs: () => crowdBellDelayMs(() => 0.1) }).ring(true);
        createHomeBellSettle({ run: late, crowdDelayMs: () => crowdBellDelayMs(() => 0.9) }).ring(true);
        vi.advanceTimersByTime(4_500);
        expect(early).toHaveBeenCalledTimes(1);
        expect(late).not.toHaveBeenCalled();
        vi.advanceTimersByTime(10_000);
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('whichever is read first covers the other, and cancel drops both', () => {
        const { run, settle } = device(() => 0);
        settle.ring(false);
        vi.advanceTimersByTime(1_000);
        settle.ring(true);                // due at 4 s; the member\'s own is due at 3 s
        vi.advanceTimersByTime(2_000);
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(60_000);
        expect(run).toHaveBeenCalledTimes(1);
        settle.ring(true);
        settle.ring(false);
        expect(settle.isPending()).toBe(true);
        settle.cancel();
        expect(settle.isPending()).toBe(false);
        vi.advanceTimersByTime(60_000);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('each burst draws again once it has been read', () => {
        const draws = [0, 0.5];
        const { run, settle } = device(() => draws.shift() ?? 0.5);
        settle.ring(true);
        vi.advanceTimersByTime(3_000);
        expect(run).toHaveBeenCalledTimes(1);
        settle.ring(true);
        vi.advanceTimersByTime(8_999);
        expect(run).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('with no deps but the read, it uses real timers and the 3 s to 15 s draw', () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const settle = createHomeBellSettle({ run });
        settle.ring(true);
        vi.advanceTimersByTime(15_000);
        expect(run).toHaveBeenCalledTimes(1);
        settle.ring(false);
        vi.advanceTimersByTime(HOME_BELL_SETTLE_MS);
        expect(run).toHaveBeenCalledTimes(2);
    });
});
