import { describe, expect, it } from 'vitest';
import { MARKET_SEEN_KEY, NEW_SINCE_LINE, RELIST_BEFORE_MS, daySections, listedAt, marketOrder, newSinceIndex, newestListed, parseSeenListed } from '../market-order.js';

const H = 60 * 60 * 1000;
// Tuesday 3 Nov 2026, 17:00 in the machine's own time zone: the headings are LOCAL days.
const NOW = new Date(2026, 10, 3, 17, 0, 0).getTime();
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();
const ahead = (hours: number) => new Date(NOW + hours * H).toISOString();

const post = (id: string, hoursAgo: number, extra: Record<string, any> = {}) => ({
    id, type: 'offer', status: 'active', author_pubkey: `k-${id}`, created_at: at(hoursAgo), ...extra,
});
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

describe('listedAt', () => {
    it('is the creation time of an ordinary post, and an edit or an RSVP does not move it', () => {
        const p = post('a', 5, { updated_at: at(0.1) });
        expect(listedAt(p, NOW)).toBe(NOW - 5 * H);
    });

    it('lists an event again 24 hours before it starts, not before', () => {
        const created = 24 * 35; // posted five weeks ago
        const before = post('ev', created, { type: 'event', event_start_at: ahead(25) });
        const on = post('ev', created, { type: 'event', event_start_at: ahead(24) });
        const after = post('ev', created, { type: 'event', event_start_at: ahead(10) });
        expect(listedAt(before, NOW)).toBe(NOW - created * H);
        expect(listedAt(on, NOW)).toBe(NOW);
        expect(listedAt(after, NOW)).toBe(NOW - 14 * H);
        expect(RELIST_BEFORE_MS).toBe(24 * H);
    });

    it('keeps an event that has started and not ended at its second listing, and a finished one at its first', () => {
        const running = post('ev', 24 * 30, { type: 'event', event_start_at: at(2), event_end_at: ahead(2) });
        const over = post('ev', 24 * 30, { type: 'event', event_start_at: at(5), event_end_at: at(1) });
        const noEnd = post('ev', 24 * 30, { type: 'event', event_start_at: at(5) });
        expect(listedAt(running, NOW)).toBe(NOW - 26 * H);
        expect(listedAt(over, NOW)).toBe(NOW - 24 * 30 * H);
        expect(listedAt(noEnd, NOW)).toBe(NOW - 24 * 30 * H);
    });

    it('does not bring back a cancelled or paused event', () => {
        const cancelled = post('c', 24 * 30, { type: 'event', event_start_at: ahead(5), event_state: 'cancelled' });
        const paused = post('p', 24 * 30, { type: 'event', event_start_at: ahead(5), status: 'paused' });
        expect(listedAt(cancelled, NOW)).toBe(NOW - 24 * 30 * H);
        expect(listedAt(paused, NOW)).toBe(NOW - 24 * 30 * H);
    });

    it('never lists an event before it was created', () => {
        // Posted 3 hours ago for an event in 10 hours: the 24-hour mark is 14 hours ago, earlier than its creation.
        const p = post('ev', 3, { type: 'event', event_start_at: ahead(10) });
        expect(listedAt(p, NOW)).toBe(NOW - 3 * H);
    });

    it('a series is one row at its next date: it is listed again for that date, and again for the next one', () => {
        const week1 = post('s', 24 * 60, { type: 'event', event_start_at: ahead(20), repeatable: 1 });
        const week2 = { ...week1, event_start_at: ahead(20 + 7 * 24) };
        expect(listedAt(week1, NOW)).toBe(NOW - 4 * H);
        expect(listedAt(week2, NOW)).toBe(NOW - 24 * 60 * H);
    });

    it('lists an open poll again 24 hours before it closes, and a closed poll at its first listing', () => {
        const closing = post('po', 24 * 6, { type: 'poll', poll_closes_at: ahead(6) });
        const closed = post('po', 24 * 6, { type: 'poll', poll_closes_at: at(6), status: 'completed' });
        const farOff = post('po', 24 * 6, { type: 'poll', poll_closes_at: ahead(72) });
        const noClose = post('po', 24 * 6, { type: 'poll' });
        expect(listedAt(closing, NOW)).toBe(NOW - 18 * H);
        expect(listedAt(closed, NOW)).toBe(NOW - 24 * 6 * H);
        expect(listedAt(farOff, NOW)).toBe(NOW - 24 * 6 * H);
        expect(listedAt(noClose, NOW)).toBe(NOW - 24 * 6 * H);
    });

    it('never puts a post from a clock that is ahead above now', () => {
        expect(listedAt(post('f', -48), NOW)).toBe(NOW);
    });

    it('reads a row with no creation time as the oldest', () => {
        expect(listedAt({ id: 'x', type: 'offer' }, NOW)).toBe(0);
    });

    it('gives the same answer for the phone row and the web row', () => {
        const phone = { id: 'e', type: 'event', status: 'active', created_at: at(900), event_start_at: ahead(8), event_end_at: ahead(10), event_state: 'scheduled' };
        const web = { id: 'e', type: 'event', status: 'active', createdAt: at(900), eventStartAt: ahead(8), eventEndAt: ahead(10), eventState: 'scheduled' };
        expect(listedAt(web, NOW)).toBe(listedAt(phone, NOW));
        const pollPhone = { id: 'p', type: 'poll', status: 'active', created_at: at(100), poll_closes_at: ahead(3) };
        const pollWeb = { id: 'p', type: 'poll', status: 'active', createdAt: at(100), pollClosesAt: ahead(3) };
        expect(listedAt(pollWeb, NOW)).toBe(listedAt(pollPhone, NOW));
    });
});

describe('marketOrder', () => {
    it('is newest listed first, then newest created, then id', () => {
        const a = post('a', 6);
        const b = post('b', 2);
        const tie1 = post('m', 4, { created_at: at(4) });
        const tie2 = post('z', 4, { created_at: at(4) });
        expect(ids(marketOrder([a, tie1, b, tie2], NOW))).toEqual(['b', 'z', 'm', 'a']);
    });

    it('breaks a tie of listing time by creation: an event that came back sits below a post made at that moment', () => {
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(24) }); // listed exactly now
        const fresh = post('fresh', 0);
        expect(ids(marketOrder([ev, fresh], NOW))).toEqual(['fresh', 'ev']);
    });

    it("brings an event back among that day's posts, then lets it sink", () => {
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(17) }); // listed 7 hours ago
        const newer = post('n', 2);
        const older = post('o', 11);
        expect(ids(marketOrder([older, ev, newer], NOW))).toEqual(['n', 'ev', 'o']);
        expect(ids(marketOrder([older, ev, newer, post('later', 0)], NOW))).toEqual(['later', 'n', 'ev', 'o']);
    });

    it('does not put an event five weeks old on top while it is days away', () => {
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(24 * 4) });
        expect(ids(marketOrder([ev, post('a', 30), post('b', 3)], NOW))).toEqual(['b', 'a', 'ev']);
    });

    it("puts a named author's third post of a day after everyone else's of that day, in their order", () => {
        const ana = (id: string, h: number) => post(id, h, { author_pubkey: 'ana' });
        const rows = [ana('a1', 1), ana('a2', 2), ana('a3', 3), post('lee', 4), ana('a4', 5), post('jo', 6)];
        expect(ids(marketOrder(rows, NOW))).toEqual(['a1', 'a2', 'lee', 'jo', 'a3', 'a4']);
    });

    it("counts the allowance per local day, so Ana's two of yesterday are not used up by today", () => {
        const ana = (id: string, h: number) => post(id, h, { author_pubkey: 'ana' });
        // 17:00 now: 0 to 16 hours ago is today, 17 to 40 hours ago is yesterday.
        const rows = [ana('t1', 1), ana('t2', 2), ana('t3', 3), post('lee', 4), ana('y1', 20), ana('y2', 21), ana('y3', 22), post('jo', 23)];
        expect(ids(marketOrder(rows, NOW))).toEqual(['t1', 't2', 'lee', 't3', 'y1', 'y2', 'jo', 'y3']);
    });

    it('does not count or sink copies, which share one hidden author', () => {
        const copy = (id: string, h: number, extra = {}) => post(id, h, { author_pubkey: '', shownCopy: true, ...extra });
        const phoneCopy = (id: string, h: number) => post(id, h, { author_pubkey: null, shown_from: '{"name":"Mullum"}' });
        const rows = [copy('c1', 1), copy('c2', 2), phoneCopy('c3', 3), copy('c4', 4), post('lee', 5)];
        expect(ids(marketOrder(rows, NOW))).toEqual(['c1', 'c2', 'c3', 'c4', 'lee']);
        // Even a copy that carries a key (it takes questions) is a copy.
        const keyed = [1, 2, 3].map(h => post(`k${h}`, h, { author_pubkey: 'same', shownCopy: true }));
        expect(ids(marketOrder([...keyed, post('lee', 4)], NOW))).toEqual(['k1', 'k2', 'k3', 'lee']);
    });

    it('does not count a row with no author key', () => {
        const rows = [1, 2, 3].map(h => post(`n${h}`, h, { author_pubkey: undefined })).concat([post('lee', 4)]);
        expect(ids(marketOrder(rows, NOW))).toEqual(['n1', 'n2', 'n3', 'lee']);
    });

    it("reads the web's author key too", () => {
        const web = (id: string, h: number) => ({ id, type: 'offer', status: 'active', createdAt: at(h), authorPublicKey: 'ana' });
        expect(ids(marketOrder([web('a', 1), web('b', 2), web('c', 3), post('lee', 4)], NOW))).toEqual(['a', 'b', 'lee', 'c']);
    });

    it('never hides a post, never changes its input, and gives the same order for the same posts in any input order', () => {
        const rows = [post('a', 9), post('b', 2, { author_pubkey: 'a' }), post('c', 3, { author_pubkey: 'a' }), post('d', 4, { author_pubkey: 'a' }),
            post('ev', 24 * 20, { type: 'event', event_start_at: ahead(12) }), post('f', -5)];
        const copy = [...rows];
        const out = marketOrder(rows, NOW);
        expect(rows).toEqual(copy);
        expect(out.length).toBe(rows.length);
        expect(ids(marketOrder([...rows].reverse(), NOW))).toEqual(ids(out));
    });

    it('gives the same order for the phone row shape and the web row shape', () => {
        const phone = [
            { id: 'a', type: 'offer', status: 'active', author_pubkey: 'x', created_at: at(3) },
            { id: 'e', type: 'event', status: 'active', author_pubkey: 'y', created_at: at(900), event_start_at: ahead(8) },
            { id: 'p', type: 'poll', status: 'active', author_pubkey: 'z', created_at: at(70), poll_closes_at: ahead(2) },
            { id: 'b', type: 'need', status: 'active', author_pubkey: 'x', created_at: at(30) },
        ];
        const web = [
            { id: 'a', type: 'offer', status: 'active', authorPublicKey: 'x', createdAt: at(3) },
            { id: 'e', type: 'event', status: 'active', authorPublicKey: 'y', createdAt: at(900), eventStartAt: ahead(8) },
            { id: 'p', type: 'poll', status: 'active', authorPublicKey: 'z', createdAt: at(70), pollClosesAt: ahead(2) },
            { id: 'b', type: 'need', status: 'active', authorPublicKey: 'x', createdAt: at(30) },
        ];
        expect(ids(marketOrder(web, NOW))).toEqual(ids(marketOrder(phone, NOW)));
        expect(ids(marketOrder(phone, NOW))).toEqual(['a', 'e', 'p', 'b']); // event listed 16 h ago (starts in 8), poll 22 h ago (closes in 2)
    });
});

describe('daySections', () => {
    it('heads the list by the local day of listing: Today, Yesterday, This Week, Older Listings, empty ones left out', () => {
        const ordered = marketOrder([post('t', 1), post('y', 20), post('w', 24 * 3), post('o', 24 * 9)], NOW);
        const s = daySections(ordered, NOW);
        expect(s.map(x => [x.id, x.title, ids(x.posts)])).toEqual([
            ['today', 'Today', ['t']], ['yesterday', 'Yesterday', ['y']], ['thisweek', 'This Week', ['w']], ['older', 'Older Listings', ['o']],
        ]);
        expect(daySections([post('t', 1)], NOW).map(x => x.title)).toEqual(['Today']);
        expect(daySections([], NOW)).toEqual([]);
    });

    it('uses calendar days, not 24-hour blocks: 11 pm last night is Yesterday at 9 am, and 00:30 today is Today', () => {
        const morning = new Date(2026, 10, 3, 9, 0, 0).getTime();
        const lastNight = { id: 'n', type: 'offer', created_at: new Date(2026, 10, 2, 23, 0, 0).toISOString() };
        const earlyToday = { id: 'e', type: 'offer', created_at: new Date(2026, 10, 3, 0, 30, 0).toISOString() };
        expect(daySections([earlyToday, lastNight], morning).map(x => x.id)).toEqual(['today', 'yesterday']);
        expect(daySections([earlyToday], NOW).map(x => x.id)).toEqual(['today']);
    });

    it('puts an event that came back under Today, and under Yesterday the next morning', () => {
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(24) });
        expect(daySections([ev], NOW).map(x => x.id)).toEqual(['today']);
        const wednesdayMorning = new Date(2026, 10, 4, 9, 0, 0).getTime(); // the event starts at 17:00 that day
        expect(daySections([ev], wednesdayMorning).map(x => x.id)).toEqual(['yesterday']);
    });

    it('puts the 6th day back under This Week and the 7th under Older Listings', () => {
        const dayAgo = (d: number) => ({ id: `d${d}`, type: 'offer', created_at: new Date(2026, 10, 3 - d, 12, 0, 0).toISOString() });
        const s = daySections([dayAgo(6), dayAgo(7)], NOW);
        expect(s.map(x => [x.id, ids(x.posts)])).toEqual([['thisweek', ['d6']], ['older', ['d7']]]);
    });
});

describe('New since you last looked (slice 4)', () => {
    const board = () => marketOrder([post('a', 1), post('b', 3), post('c', 30), post('d', 100)], NOW);

    it('stamps the newest listed time on screen, and none for an empty board', () => {
        expect(newestListed(board(), NOW)).toBe(NOW - 1 * H);
        expect(newestListed([], NOW)).toBeNull();
        // an event that came back counts at its second listing, not its creation
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(24) });
        expect(newestListed([ev, post('x', 2)], NOW)).toBe(NOW);
    });

    it('puts the line above the first post listed at or before the stamp, and an equal time is already seen', () => {
        // b set the stamp when the Market was last left; a arrived since. The line is above b (index 1), not above a.
        expect(newSinceIndex(board(), NOW - 3 * H, NOW)).toBe(1);
        expect(newSinceIndex(board(), NOW - 2 * H, NOW)).toBe(1);
        expect(newSinceIndex(board(), NOW - 31 * H, NOW)).toBe(3);
    });

    it('has no line on the first visit, when nothing is newer, or when nothing is at or before the stamp', () => {
        expect(newSinceIndex(board(), null, NOW)).toBe(-1);
        expect(newSinceIndex(board(), NOW - 1 * H, NOW)).toBe(-1); // the newest is the stamp: nothing newer
        expect(newSinceIndex(board(), NOW + H, NOW)).toBe(-1); // a stamp ahead of everything
        expect(newSinceIndex(board(), 5, NOW)).toBe(-1); // everything is newer than a stamp from long ago
        expect(newSinceIndex([], NOW, NOW)).toBe(-1);
    });

    it('lists a post that arrived after the stamp, and an event that came back, above the line', () => {
        const stamp = NOW - 6 * H;
        const ev = post('ev', 24 * 35, { type: 'event', event_start_at: ahead(23) }); // listed again 1 h ago
        const ordered = marketOrder([post('old', 9), ev, post('mid', 5)], NOW);
        const at = newSinceIndex(ordered, stamp, NOW);
        expect(at).toBe(2);
        expect(ids(ordered.slice(0, at))).toEqual(['ev', 'mid']);
        expect(ordered[at].id).toBe('old');
    });

    it('reads a stored stamp tolerantly: a number or a digit string, else none', () => {
        expect(parseSeenListed(String(NOW))).toBe(NOW);
        expect(parseSeenListed(NOW)).toBe(NOW);
        for (const bad of [null, undefined, '', 'x', '-5', '0', 0, -1, NaN, '1.5e3', '{}', {}]) expect(parseSeenListed(bad)).toBeNull();
    });

    it('keeps its key beside the fresh banner and its words as one catalog key', () => {
        expect(MARKET_SEEN_KEY).toBe('bp_market_seen_listed');
        expect(NEW_SINCE_LINE).toBe('New since you last looked');
    });
});
