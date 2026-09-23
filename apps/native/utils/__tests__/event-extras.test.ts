import { describe, it, expect } from 'vitest';
import {
    DEFAULT_REMINDER_OFFSETS, REMINDER_OFFSETS, buildIcs, buildShareText, effectiveEventAudience, eventLink,
    formatReminderChoice, formatReminderOffsets, googleCalendarUrl, icsEscape, icsFileName, icsFold, myEventAsPost,
    normaliseReminderOffsets, parseReminderOffsets, postIdFromLink, sortMyEvents, type MyEvent, type ShareableEvent,
} from '../event-extras';

/**
 * The same expectations as apps/pwa/src/lib/event-extras.test.ts. The two apps share no runtime, so the
 * pieces that must agree — the offsets, the link, the share text and the .ics — are checked on both sides.
 */

const EVENT: ShareableEvent = {
    id: 'ev-1',
    title: 'Working bee at the hall',
    startAt: '2026-09-26T23:00:00.000Z',
    endAt: '2026-09-27T02:00:00.000Z',
    placeName: 'Town hall, Mullumbimby',
    description: 'Bring gloves',
};

describe('the reminder offsets are the shared contract, and nothing else', () => {
    it('offers exactly 1 week, 1 day, 2 hours, 1 hour and 30 minutes', () => {
        expect([...REMINDER_OFFSETS]).toEqual([10080, 1440, 120, 60, 30]);
    });

    it('defaults everyone to the day before', () => {
        expect(DEFAULT_REMINDER_OFFSETS).toEqual([1440]);
    });
});

describe('parseReminderOffsets', () => {
    it('reads a list, a JSON string and a comma string the same way', () => {
        expect(parseReminderOffsets([1440, 30])).toEqual([1440, 30]);
        expect(parseReminderOffsets('[1440,30]')).toEqual([1440, 30]);
        expect(parseReminderOffsets('1440,30')).toEqual([1440, 30]);
    });

    it('sorts largest first, drops duplicates, and drops values the node would refuse', () => {
        expect(parseReminderOffsets([30, 10080, 30, 1440])).toEqual([10080, 1440, 30]);
        expect(parseReminderOffsets([45, 1440, 0, -60, 999999])).toEqual([1440]);
    });

    it('keeps "off" as off, and reads anything it cannot understand as "my default", never as off', () => {
        expect(parseReminderOffsets([])).toEqual([]);
        expect(parseReminderOffsets('[]')).toEqual([]);
        for (const junk of [null, undefined, '', 'later', 42, {}, true, [45]]) {
            expect(parseReminderOffsets(junk)).toBeNull();
        }
    });
});

describe('how a choice reads', () => {
    it('names the default as the default until the member picks for this event', () => {
        expect(formatReminderChoice(null)).toBe('1 day before (your default)');
        expect(formatReminderChoice(null, [120])).toBe('2 hours before (your default)');
        expect(formatReminderChoice(null, [])).toBe('Off (your default)');
    });

    it('states the member’s own choice on its own', () => {
        expect(formatReminderChoice([1440])).toBe('1 day before');
        expect(formatReminderChoice([])).toBe('Off');
    });

    it('joins several with commas and a final "and"', () => {
        expect(formatReminderOffsets([10080, 120])).toBe('1 week and 2 hours before');
        expect(formatReminderOffsets([10080, 1440, 30])).toBe('1 week, 1 day and 30 minutes before');
    });

    it('normalises what is written back to the node', () => {
        expect(normaliseReminderOffsets([30, 45, 10080])).toEqual([10080, 30]);
        expect(normaliseReminderOffsets([])).toEqual([]);
    });
});

describe('the event’s link', () => {
    it('is the community’s own address with ?post=, the path this app’s links claim', () => {
        expect(eventLink('https://mullum.beanpool.org', 'ev-1')).toBe('https://mullum.beanpool.org/?post=ev-1');
        expect(eventLink('https://mullum.beanpool.org/', 'ev-1')).toBe('https://mullum.beanpool.org/?post=ev-1');
        expect(eventLink('https://n.example', 'a b&c')).toBe('https://n.example/?post=a%20b%26c');
    });

    it('is read back off an incoming link', () => {
        expect(postIdFromLink('https://mullum.beanpool.org/?post=ev-1')).toBe('ev-1');
        expect(postIdFromLink('/?post=ev-1')).toBe('ev-1');
        expect(postIdFromLink('https://n.example/?invite=INV-1&post=ev%2F2')).toBe('ev/2');
    });

    it('leaves every other link alone — an invite, a callback, a bare host', () => {
        for (const other of [
            null, undefined, '', '/', 'https://mullum.beanpool.org/?invite=INV-ABCD-EFGH',
            'beanpool://auth/github?code=abc', 'https://beanpool.org/auth/facebook#state=1', '/?post=',
        ]) {
            expect(postIdFromLink(other)).toBeNull();
        }
    });
});

describe('buildShareText', () => {
    it('gives the title, when, where and the link, one to a line', () => {
        expect(buildShareText(EVENT, 'SUN 27 SEP · 9:00–12:00', 'https://mullum.beanpool.org/?post=ev-1')).toBe(
            'Working bee at the hall\nSUN 27 SEP · 9:00–12:00\nTown hall, Mullumbimby\nhttps://mullum.beanpool.org/?post=ev-1'
        );
    });

    it('leaves out a place the host did not name, rather than an empty line', () => {
        expect(buildShareText({ ...EVENT, placeName: null }, 'SUN 27 SEP', 'https://n.example/?post=ev-1')).toBe(
            'Working bee at the hall\nSUN 27 SEP\nhttps://n.example/?post=ev-1'
        );
    });
});

describe('the .ics is a calendar file, not a best guess', () => {
    const ics = buildIcs(EVENT, 'https://mullum.beanpool.org/?post=ev-1', Date.parse('2026-09-20T01:02:03.000Z'));
    const lines = ics.split('\r\n');

    it('opens and closes a VCALENDAR holding one VEVENT, with CRLF throughout', () => {
        expect(lines[0]).toBe('BEGIN:VCALENDAR');
        expect(lines).toContain('VERSION:2.0');
        expect(lines).toContain('BEGIN:VEVENT');
        expect(lines).toContain('END:VEVENT');
        expect(lines).toContain('END:VCALENDAR');
        expect(ics.endsWith('\r\n')).toBe(true);
        expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    });

    it('carries a UID that is this event at this community', () => {
        expect(lines).toContain('UID:ev-1@mullum.beanpool.org');
    });

    it('writes DTSTAMP, DTSTART and DTEND in UTC', () => {
        expect(lines).toContain('DTSTAMP:20260920T010203Z');
        expect(lines).toContain('DTSTART:20260926T230000Z');
        expect(lines).toContain('DTEND:20260927T020000Z');
    });

    it('runs two hours when the host named no end, as the node defaults it', () => {
        const open = buildIcs({ ...EVENT, endAt: null }, 'https://n.example/?post=ev-1').split('\r\n');
        expect(open).toContain('DTEND:20260927T010000Z');
    });

    it('carries the place, and the link in both URL and DESCRIPTION', () => {
        expect(lines).toContain('LOCATION:Town hall\\, Mullumbimby');
        expect(ics).toContain('URL:https://mullum.beanpool.org/?post=ev-1');
        expect(ics).toContain('DESCRIPTION:Bring gloves\\n\\nhttps://mullum.beanpool.org/?post=ev-1');
    });

    it('escapes the characters that would otherwise end a property', () => {
        expect(icsEscape('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
        const tricky = buildIcs({ ...EVENT, title: 'Bees; jam, and a back\\slash' }, 'https://n.example/?post=ev-1').split('\r\n');
        expect(tricky).toContain('SUMMARY:Bees\\; jam\\, and a back\\\\slash');
    });

    it('folds a long line at 75 octets, and never splits a character in half', () => {
        const long = buildIcs({ ...EVENT, title: 'W'.repeat(200) }, 'https://n.example/?post=ev-1');
        for (const line of long.split('\r\n')) {
            expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
        }
        expect(long).toContain('\r\n ');

        const folded = icsFold(`SUMMARY:${'日'.repeat(60)}`);
        for (const line of folded.split('\r\n')) {
            expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
        }
        expect(folded.replace(/\r\n /g, '')).toBe(`SUMMARY:${'日'.repeat(60)}`);
        expect(folded).not.toContain('�');
    });

    it('names the file after the event', () => {
        expect(icsFileName(EVENT)).toBe('working-bee-at-the-hall.ics');
        expect(icsFileName({ ...EVENT, title: '   ' })).toBe('event.ics');
    });
});

describe('googleCalendarUrl — what Android gets', () => {
    it('pre-fills a Google Calendar entry with the same UTC times as the .ics', () => {
        const url = new URL(googleCalendarUrl(EVENT, 'https://n.example/?post=ev-1'));
        expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
        expect(url.searchParams.get('action')).toBe('TEMPLATE');
        expect(url.searchParams.get('text')).toBe('Working bee at the hall');
        expect(url.searchParams.get('dates')).toBe('20260926T230000Z/20260927T020000Z');
        expect(url.searchParams.get('location')).toBe('Town hall, Mullumbimby');
        expect(url.searchParams.get('details')).toContain('https://n.example/?post=ev-1');
    });
});

describe('"Your events" rows', () => {
    const row = (postId: string, startAt: string, over: Partial<MyEvent> = {}): MyEvent =>
        ({ postId, title: postId, startAt, endAt: null, placeName: null, rsvp: 'going', photo: null, reminderOffsets: null, ...over });

    it('puts the soonest first whatever order the node sent', () => {
        const sorted = sortMyEvents([row('c', '2026-10-05T00:00:00Z'), row('a', '2026-09-27T00:00:00Z'), row('b', '2026-09-28T00:00:00Z')]);
        expect(sorted.map(r => r.postId)).toEqual(['a', 'b', 'c']);
    });

    it('drops a row with no usable start rather than showing it undated', () => {
        expect(sortMyEvents([row('a', 'whenever'), row('b', '2026-09-28T00:00:00Z')]).map(r => r.postId)).toEqual(['b']);
    });

    it('reads onto the feed card in the shape the cards use', () => {
        const post = myEventAsPost(row('ev-1', '2026-09-27T00:00:00Z', {
            title: 'Working bee', endAt: '2026-09-27T02:00:00Z', placeName: 'The hall', rsvp: 'interested', photo: 'https://n/p.jpg',
        }));
        expect(post).toMatchObject({
            id: 'ev-1', type: 'event', title: 'Working bee', event_start_at: '2026-09-27T00:00:00Z',
            event_end_at: '2026-09-27T02:00:00Z', event_place_name: 'The hall', myRsvp: 'interested',
            photos: ['https://n/p.jpg'], status: 'active', event_state: 'scheduled',
        });
    });

    it('never claims nobody is going: this route carries no counts, so the row has none', () => {
        const post = myEventAsPost(row('ev-1', '2026-09-27T00:00:00Z'));
        expect(post.goingCount).toBeUndefined();
        expect(post.interestedCount).toBeUndefined();
        expect(post.event_going_count).toBeUndefined();
        expect(post.event_interested_count).toBeUndefined();
    });
});

// #1054's leftover: an enterprise event aimed at a group was refused by the node, with a confusing message
// about signatures. The pair can no longer be chosen in either form, nor sent from one.
describe('effectiveEventAudience — who can see an event', () => {
    const me = { key: 'me', groupId: null };
    const enterprise = { key: 'ent:ent-pubkey', groupId: null };
    const group = { key: 'grp:grp-1', groupId: 'grp-1' };

    it('an enterprise host clears a group audience: it hosts for the whole community', () => {
        expect(effectiveEventAudience(enterprise, 'grp-1')).toBeNull();
        expect(effectiveEventAudience(enterprise, null)).toBeNull();
    });

    it('a group host posts to its own group, whatever else was picked', () => {
        expect(effectiveEventAudience(group, null)).toBe('grp-1');
        expect(effectiveEventAudience(group, 'grp-2')).toBe('grp-1');
    });

    it('anyone else gets the audience they chose', () => {
        expect(effectiveEventAudience(me, 'grp-1')).toBe('grp-1');
        expect(effectiveEventAudience(me, null)).toBeNull();
    });
});
