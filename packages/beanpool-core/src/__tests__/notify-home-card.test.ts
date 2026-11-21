/**
 * The Home card while something is live, and the fact line (src/notify-ask.ts; DESIGN-notify-and-backup-asks-fable-amend2.md
 * §12.3 slice N3; the first design §4.3, §4.4; amend1 §4.3).
 *
 * Two tables, each over every combination of its facets, each row's answer worked out here from the design's words, not
 * from the rule; and for each guard, a row where that guard alone says no, so taking any guard out turns a row red.
 *
 * - The card: what is live (none, a listing, a deal, an unanswered line, a marked event) × the phone's answer (allowed,
 *   never asked, "Later" under and over 7 days, the phone's no, an Android pop-up swiped away under and over 7 days) × the
 *   card's × under 30 days × the once card or the way-back card due.
 * - The fact line: opened under a day, a day, two days or more late × the line shown in the last 30 days × the same answers.
 */
import { describe, expect, it } from 'vitest';
import {
    notifyAsks, notifyFactWords, notifyHomeWords, notifyLive, notifyWaitedDays, NOTIFY_WAITING_DAYS,
    type NotifyAskRecord, type NotifyLive, type NotifyLiveInput, type NotifyPhone,
} from '../notify-ask.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Local noon, so "today" and "yesterday" are the same days in every time zone. */
const NOW = new Date(2026, 10, 21, 12, 0).getTime();
const ago = (days: number) => NOW - days * DAY;
const iso = (ms: number) => new Date(ms).toISOString();

/** The phone's answer: what the phone reads and what this phone's record holds. */
/** `asks`: the phone can still be asked and has not said no; `card`: the Home card may show; `fact`: what the fact line's tap does. */
type Answer = { phone: NotifyPhone; record: NotifyAskRecord; asks: boolean; card: boolean; fact: 'ask' | 'settings' | null };
const ANDROID13: Partial<NotifyPhone> = { cantAskNeedsRecord: true };
const ANSWERS: Record<string, Answer> = {
    granted: { phone: { available: true, granted: true, canAskAgain: true }, record: { state: 'granted' }, asks: false, card: false, fact: null },
    undetermined: { phone: { available: true, granted: false, canAskAgain: true }, record: {}, asks: true, card: true, fact: 'ask' },
    'Later 3 days ago': { phone: { available: true, granted: false, canAskAgain: true }, record: { laterAt: ago(3) }, asks: true, card: false, fact: 'ask' },
    'Later 8 days ago': { phone: { available: true, granted: false, canAskAgain: true }, record: { laterAt: ago(8) }, asks: true, card: true, fact: 'ask' },
    "an older app's Not now 3 days ago": { phone: { available: true, granted: false, canAskAgain: true }, record: { state: 'declined', updatedAt: ago(3) }, asks: true, card: false, fact: 'ask' },
    "the iPhone's Don't Allow": { phone: { available: true, granted: false, canAskAgain: false }, record: { phoneNoAt: ago(20) }, asks: false, card: false, fact: 'settings' },
    "Android's first Don't allow": { phone: { available: true, granted: false, canAskAgain: true, ...ANDROID13, saidNoOnce: true }, record: { phoneNoAt: ago(20) }, asks: false, card: false, fact: 'ask' },
    // amend3: a pop-up closed with no answer reads "can't ask again" on Android 13+ and is a "Later", never a no.
    'Android pop-up swiped away 3 days ago': { phone: { available: true, granted: false, canAskAgain: false, ...ANDROID13, saidNoOnce: false }, record: { laterAt: ago(3) }, asks: true, card: false, fact: 'ask' },
    'Android pop-up swiped away 8 days ago': { phone: { available: true, granted: false, canAskAgain: false, ...ANDROID13, saidNoOnce: false }, record: { laterAt: ago(8) }, asks: true, card: true, fact: 'ask' },
    'nothing to turn on here': { phone: { available: false, granted: false, canAskAgain: false }, record: {}, asks: false, card: false, fact: null },
};

const LIVE: Record<string, NotifyLiveInput> = {
    none: { now: NOW },
    listing: { now: NOW, listings: [{ type: 'offer', status: 'active' }] },
    deal: { now: NOW, deals: 1 },
    'unanswered line': { now: NOW, waitingAt: [ago(2)] },
    'marked event': { now: NOW, events: [{ title: 'Saturday market', rsvp: 'going', startsAt: iso(NOW + 2 * DAY), endsAt: null }] },
};

/** The join's screen long ago: the once card is never due. Without it (and never shown), the once card is due on a free day. */
const ONCE_NOT_DUE: NotifyAskRecord = { joinAt: ago(60) };
const AWAY_RECENT: NotifyAskRecord = { homeAwayAt: ago(10), homeAways: 1 };

describe('the Home card while something is live (slice N3)', () => {
    type Case = { live: string; answer: string; away: boolean; due: 'none' | 'once' | 'wayBack' };
    const cases: Case[] = [];
    for (const live of Object.keys(LIVE)) for (const answer of Object.keys(ANSWERS)) for (const away of [false, true])
        for (const due of ['none', 'once', 'wayBack'] as const) cases.push({ live, answer, away, due });

    /** Why the card is not drawn, from the design's words alone; empty: it is drawn. */
    const reasons = (c: Case): string[] => {
        const why: string[] = [];
        if (c.live === 'none') why.push('nothing live');
        if (!ANSWERS[c.answer].card) why.push('the answer');
        if (c.away) why.push('× under 30 days');
        // The once card goes first; it is only due where the phone can still be asked and has not said no.
        if (c.due === 'once' && ANSWERS[c.answer].asks) why.push('the once card');
        if (c.due === 'wayBack') why.push('the way-back card');
        return why;
    };

    const run = (c: Case) => {
        const a = ANSWERS[c.answer];
        const record: NotifyAskRecord = { ...(c.due === 'once' ? {} : ONCE_NOT_DUE), ...a.record, ...(c.away ? AWAY_RECENT : {}) };
        const live = notifyLive(LIVE[c.live]);
        return notifyAsks({ record, phone: a.phone, now: NOW, live: live !== null, wayBack: c.due === 'wayBack' });
    };

    it.each(cases.map((c) => [`${c.live} · ${c.answer} · ${c.away ? '× 10 days ago' : 'no ×'} · ${c.due} due`, c] as const))('%s', (_n, c) => {
        expect(run(c).home).toBe(reasons(c).length === 0);
    });

    it('every guard is, in some row, the only reason there is no card (so each row goes red without its guard)', () => {
        const alone = new Set(cases.map(reasons).filter((r) => r.length === 1).map((r) => r[0]));
        expect([...alone].sort()).toEqual(['nothing live', 'the answer', 'the once card', 'the way-back card', '× under 30 days'].sort());
    });

    it('the once card and the Home card are never both drawn', () => {
        for (const c of cases) {
            const got = run(c);
            expect(got.once && got.home).toBe(false);
        }
    });
});

describe('the fact line (slice N3)', () => {
    const LATE = { 'under a day': NOW - 3 * HOUR, 'a day': NOW - 25 * HOUR, 'two days': NOW - 50 * HOUR, 'nine days': ago(9) };
    type Case = { late: keyof typeof LATE; shown: boolean; answer: string };
    const cases: Case[] = [];
    for (const late of Object.keys(LATE) as (keyof typeof LATE)[]) for (const shown of [false, true])
        for (const answer of Object.keys(ANSWERS)) cases.push({ late, shown, answer });

    const reasons = (c: Case): string[] => {
        const why: string[] = [];
        if (c.late === 'under a day') why.push('under a day');
        if (c.shown) why.push('shown in the last 30 days');
        if (ANSWERS[c.answer].fact === null) why.push('nothing to turn on');
        return why;
    };
    const DAYS = { 'under a day': null, 'a day': 1, 'two days': 2, 'nine days': 9 } as const;

    it.each(cases.map((c) => [`${c.late} late · ${c.shown ? 'shown 10 days ago' : 'not shown'} · ${c.answer}`, c] as const))('%s', (_n, c) => {
        const a = ANSWERS[c.answer];
        const days = notifyWaitedDays(LATE[c.late], NOW);
        expect(days).toBe(DAYS[c.late]);
        const record: NotifyAskRecord = { ...ONCE_NOT_DUE, ...a.record, ...(c.shown ? { factAt: ago(10) } : {}) };
        const got = notifyAsks({ record, phone: a.phone, now: NOW, waited: days !== null });
        const want = reasons(c).length === 0;
        expect(got.fact).toBe(want);
        if (want) {
            const words = notifyFactWords(days!, a.phone, record);
            expect(words).toEqual({
                line: days === 1 ? 'This waited 1 day for you.' : `This waited ${days} days for you.`,
                // After the phone's final no a tap opens the one line before the phone's settings; else the phone's pop-up.
                link: a.fact === 'settings' ? 'Turn on ›' : 'Tell me next time ›',
            });
        }
    });

    it('every guard is, in some row, the only reason there is no line', () => {
        const alone = new Set(cases.map(reasons).filter((r) => r.length === 1).map((r) => r[0]));
        expect([...alone].sort()).toEqual(['nothing to turn on', 'shown in the last 30 days', 'under a day']);
    });

    it('a time it cannot read, or one after the opening, waited for nothing', () => {
        expect(notifyWaitedDays(null, NOW)).toBeNull();
        expect(notifyWaitedDays(undefined, NOW)).toBeNull();
        expect(notifyWaitedDays('not a date', NOW)).toBeNull();
        expect(notifyWaitedDays(NOW + DAY, NOW)).toBeNull();
        expect(notifyWaitedDays(iso(NOW - 2 * DAY), NOW)).toBe(2);
        expect(notifyWaitedDays(NOW - DAY, NOW)).toBe(1);
        expect(notifyWaitedDays(NOW - DAY + 1, NOW)).toBeNull();
    });

    it('no words where a tap has nothing to do', () => {
        expect(notifyFactWords(2, ANSWERS.granted.phone, {})).toBeNull();
        expect(notifyFactWords(2, ANSWERS['nothing to turn on here'].phone, {})).toBeNull();
    });
});

describe('what is live (notifyLive)', () => {
    const rows: { name: string; input: Omit<NotifyLiveInput, 'now'>; want: NotifyLive | null }[] = [
        { name: 'nothing', input: {}, want: null },
        { name: 'one Offer up', input: { listings: [{ type: 'offer', status: 'active' }] }, want: { kind: 'offers', n: 1 } },
        { name: 'an Offer with a deal under way counts', input: { listings: [{ type: 'offer', status: 'pending' }] }, want: { kind: 'offers', n: 1 } },
        { name: 'two Offers and a Need: listings', input: { listings: [{ type: 'offer', status: 'active' }, { type: 'need', status: 'active' }, { type: 'offer', status: 'active' }] }, want: { kind: 'listings', n: 3 } },
        { name: 'a Need alone: a listing', input: { listings: [{ type: 'need', status: 'active' }] }, want: { kind: 'listings', n: 1 } },
        { name: 'done, paused or an event: no listing up', input: { listings: [{ type: 'offer', status: 'completed' }, { type: 'offer', status: 'paused' }, { type: 'event', status: 'active' }] }, want: null },
        { name: 'two open deals', input: { deals: 2 }, want: { kind: 'deals', n: 2 } },
        { name: 'no open deal', input: { deals: 0 }, want: null },
        { name: 'a listing names the card before a deal', input: { deals: 1, listings: [{ type: 'offer', status: 'active' }] }, want: { kind: 'offers', n: 1 } },
        { name: 'a line of theirs 2 days old', input: { waitingAt: [iso(ago(2))] }, want: { kind: 'waiting' } },
        { name: `a line of theirs ${NOTIFY_WAITING_DAYS} days old no longer waits`, input: { waitingAt: [ago(NOTIFY_WAITING_DAYS)] }, want: null },
        { name: 'a line dated ahead, or unreadable', input: { waitingAt: [NOW + HOUR, 'x', null] }, want: null },
        { name: 'a deal names the card before a line', input: { deals: 1, waitingAt: [ago(1)] }, want: { kind: 'deals', n: 1 } },
        { name: 'Going to an event still to come', input: { events: [{ title: ' Saturday market ', rsvp: 'going', startsAt: iso(NOW + DAY) }] }, want: { kind: 'event', title: 'Saturday market', going: true } },
        { name: 'Interested in one under way', input: { events: [{ title: 'Repair café', rsvp: 'interested', startsAt: iso(NOW - HOUR), endsAt: iso(NOW + HOUR) }] }, want: { kind: 'event', title: 'Repair café', going: false } },
        { name: 'an event over, or not answered, or with no title', input: { events: [{ title: 'Past', rsvp: 'going', startsAt: iso(ago(1)) }, { title: 'Open', rsvp: null, startsAt: iso(NOW + DAY) }, { title: '', rsvp: 'going', startsAt: iso(NOW + DAY) }] }, want: null },
        { name: 'a line names the card before an event', input: { waitingAt: [ago(1)], events: [{ title: 'Market', rsvp: 'going', startsAt: iso(NOW + DAY) }] }, want: { kind: 'waiting' } },
    ];
    it.each(rows.map((r) => [r.name, r] as const))('%s', (_n, r) => {
        expect(notifyLive({ ...r.input, now: NOW })).toEqual(r.want);
    });
});

describe("the Home card's words", () => {
    it('says what is live, then what this phone will not do', () => {
        expect(notifyHomeWords({ kind: 'offers', n: 1 })).toMatchObject({ band: 'Notifications', fact: 'You have 1 offer up.', wont: "This phone won't tell you when someone answers.", turnOn: 'Turn on' });
        expect(notifyHomeWords({ kind: 'offers', n: 3 }).fact).toBe('You have 3 offers up.');
        expect(notifyHomeWords({ kind: 'listings', n: 1 }).fact).toBe('You have 1 listing up.');
        expect(notifyHomeWords({ kind: 'listings', n: 2 }).fact).toBe('You have 2 listings up.');
        expect(notifyHomeWords({ kind: 'deals', n: 1 }).fact).toBe('You have 1 deal open.');
        expect(notifyHomeWords({ kind: 'deals', n: 4 }).fact).toBe('You have 4 deals open.');
        expect(notifyHomeWords({ kind: 'waiting' })).toMatchObject({ fact: "You're waiting for an answer.", wont: "This phone won't tell you when someone answers." });
        expect(notifyHomeWords({ kind: 'event', title: 'Saturday market', going: true })).toMatchObject({ fact: "You're going to Saturday market.", wont: "This phone won't remind you." });
        expect(notifyHomeWords({ kind: 'event', title: 'Saturday market', going: false }).fact).toBe("You're interested in Saturday market.");
        expect(notifyHomeWords({ kind: 'waiting' }).away).toBe('Put this card away');
    });
});
