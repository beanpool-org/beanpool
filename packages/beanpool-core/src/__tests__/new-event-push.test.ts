/**
 * The push for a new event (`event.new`; DESIGN-notify-and-backup-asks-fable-amend2.md §9 question 6, §12.3 slice NEa):
 * which new events tell a local community, and which members they tell. One table per rule, each row red without its
 * line: every row changes one fact of a case that tells, and names the reason it must then be silent. Then every
 * combination of the facts, against the rule written out as a plain AND, so no state is left unread.
 */
import { describe, expect, it } from 'vitest';
import {
    NEW_EVENT_PUSH_GAP_SECONDS, NEW_EVENT_PUSH_PREF, newEventPushSent, newEventRecipientRefusal, newEventSilence,
    type NewEventFacts, type NewEventRecipientFacts, type NewEventRecipientRefusal, type NewEventSilence,
} from '../new-event-push.js';
import { NEW_EVENT_PUSH_WORDS, PUSH_NOTICE_KINDS, PUSH_NOTICE_TITLE, isPushNoticeKind, newEventPushOn, pushNoticeWords } from '../push-notice.js';

const NOW_MS = Date.UTC(2026, 10, 21, 9, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);
// The cap's length written out, never read from the constant it checks: a gap edited to hours, minutes or milliseconds
// goes red here (PR #3323's MAX review, F1).
const DAY = 86_400;

/** A new event that tells the community. */
const EVENT: NewEventFacts = {
    type: 'event', status: 'active', audienceScope: 'public', copied: false, createdVia: null, hidden: false,
    overAtMs: NOW_MS + 3 * 86_400_000,
};

/** A member it tells. */
const MEMBER: NewEventRecipientFacts = {
    host: false, status: 'active', visitor: false, enterprise: false, onHoliday: false, blocked: false,
    newEventsSwitch: undefined, marketplaceSwitch: undefined, reachable: true, lastToldAt: null,
};

describe('which new events tell the community (newEventSilence)', () => {
    it('an event for everyone, live, made here by a person, not over, on a local community tells it', () => {
        expect(newEventSilence(EVENT, 'local', NOW_MS)).toBeNull();
        // No status and no audience given are a live event for everyone, as the posts table defaults them.
        expect(newEventSilence({ ...EVENT, status: null, audienceScope: undefined, createdVia: '' }, 'local', NOW_MS)).toBeNull();
    });

    const rows: [string, Partial<NewEventFacts>, unknown, NewEventSilence][] = [
        ['an Offer', { type: 'offer' }, 'local', 'not-an-event'],
        ['a Need', { type: 'need' }, 'local', 'not-an-event'],
        ['a poll', { type: 'poll' }, 'local', 'not-an-event'],
        ['a cancelled event', { status: 'cancelled' }, 'local', 'not-live'],
        ['a paused event', { status: 'paused' }, 'local', 'not-live'],
        ["a group's own event", { audienceScope: 'group' }, 'local', 'not-for-everyone'],
        ['an event for one person', { audienceScope: 'direct' }, 'local', 'not-for-everyone'],
        ['an audience nobody knows', { audienceScope: 'friends' }, 'local', 'not-for-everyone'],
        ["a copy of another community's event", { copied: true }, 'local', 'a-copy'],
        ["an owner's assistant's event", { createdVia: 'assistant:grant-1' }, 'local', 'an-assistant'],
        ['a hidden event', { hidden: true }, 'local', 'hidden'],
        ['an event already over', { overAtMs: NOW_MS - 1 }, 'local', 'over'],
        ['an event over this very moment', { overAtMs: NOW_MS }, 'local', 'over'],
        ['an event with no time', { overAtMs: null }, 'local', 'over'],
        ['an event whose time is not a number', { overAtMs: Number.NaN }, 'local', 'over'],
        ['an event on the global community', {}, 'global', 'not-local'],
        ['an event where the profile is not known', {}, undefined, 'not-local'],
    ];
    for (const [what, change, profile, why] of rows) {
        it(`${what} tells nobody (${why})`, () => {
            expect(newEventSilence({ ...EVENT, ...change }, profile, NOW_MS)).toBe(why);
        });
    }

    it('every combination of the facts: it tells only when each one allows it', () => {
        let seen = 0, telling = 0;
        for (const type of ['event', 'offer'])
            for (const status of ['active', null, 'cancelled'])
                for (const audienceScope of ['public', undefined, 'group', 'direct'])
                    for (const copied of [false, true])
                        for (const createdVia of [null, '', 'assistant:g'])
                            for (const hidden of [false, true])
                                for (const overAtMs of [NOW_MS + 1, NOW_MS, NOW_MS - 1, null])
                                    for (const profile of ['local', 'global']) {
                                        const facts: NewEventFacts = { type, status, audienceScope, copied, createdVia, hidden, overAtMs };
                                        const tells = type === 'event' && (status === 'active' || status === null)
                                            && (audienceScope === 'public' || audienceScope === undefined) && !copied
                                            && !createdVia && !hidden && overAtMs !== null && overAtMs > NOW_MS && profile === 'local';
                                        expect(newEventSilence(facts, profile, NOW_MS) === null, JSON.stringify({ ...facts, profile })).toBe(tells);
                                        seen++;
                                        if (tells) telling++;
                                    }
        expect(seen).toBe(2 * 3 * 4 * 2 * 3 * 2 * 4 * 2);
        expect(telling).toBe(1 * 2 * 2 * 1 * 2 * 1 * 1 * 1);
    });
});

describe('which members a new event tells (newEventRecipientRefusal)', () => {
    it('the daily cap is a day of whole seconds: 86,400', () => {
        expect(NEW_EVENT_PUSH_GAP_SECONDS).toBe(86_400);
    });

    it('a member here, reachable, with both switches on and not told today is told', () => {
        expect(newEventRecipientRefusal(MEMBER, NOW)).toBeNull();
        expect(newEventRecipientRefusal({ ...MEMBER, newEventsSwitch: 'true', marketplaceSwitch: 'true' }, NOW)).toBeNull();
        expect(newEventRecipientRefusal({ ...MEMBER, lastToldAt: NOW - DAY }, NOW)).toBeNull();
        expect(newEventRecipientRefusal({ ...MEMBER, lastToldAt: NOW - 30 * DAY }, NOW)).toBeNull();
    });

    const rows: [string, Partial<NewEventRecipientFacts>, NewEventRecipientRefusal][] = [
        ['its host, or the member who posted it for an enterprise', { host: true }, 'host'],
        ['a suspended member', { status: 'suspended' }, 'not-active'],
        ["a paused member (an admin's pause)", { status: 'disabled' }, 'not-active'],
        ['a pruned account', { status: 'pruned' }, 'not-active'],
        ['a row with no status', { status: null }, 'not-active'],
        ["a visitor's row", { visitor: true }, 'visitor'],
        ["an enterprise's account", { enterprise: true }, 'enterprise'],
        ['a member on holiday', { onHoliday: true }, 'on-holiday'],
        ['a member with a block either way between them and the host', { blocked: true }, 'blocked'],
        ['a member who turned this switch off', { newEventsSwitch: 'false' }, 'switch-off'],
        ['a member who turned Marketplace Activity off', { marketplaceSwitch: 'false' }, 'marketplace-off'],
        ['a member with no phone or browser here', { reachable: false }, 'no-device'],
        ['a member told of a new event a moment ago', { lastToldAt: NOW }, 'told-today'],
        ['a member told a second short of a day ago', { lastToldAt: NOW - DAY + 1 }, 'told-today'],
        ['a member told 23 hours ago', { lastToldAt: NOW - 23 * 3600 }, 'told-today'],
        ['a member told 2 hours ago', { lastToldAt: NOW - 2 * 3600 }, 'told-today'],
        ['a member whose stamp is ahead of the clock', { lastToldAt: NOW + 600 }, 'told-today'],
    ];
    for (const [what, change, why] of rows) {
        it(`never ${what} (${why})`, () => {
            expect(newEventRecipientRefusal({ ...MEMBER, ...change }, NOW)).toBe(why);
        });
    }

    it('every combination of the facts: a member is told only when each one allows it', () => {
        let seen = 0, told = 0;
        for (const host of [false, true])
            for (const status of ['active', 'suspended', null])
                for (const visitor of [false, true])
                    for (const enterprise of [false, true])
                        for (const onHoliday of [false, true])
                            for (const blocked of [false, true])
                                for (const newEventsSwitch of [undefined, 'true', 'false'])
                                    for (const marketplaceSwitch of [undefined, 'true', 'false'])
                                        for (const reachable of [true, false])
                                            for (const lastToldAt of [null, NOW - DAY - 1, NOW - DAY, NOW - DAY + 1, NOW, NOW + 60]) {
                                                const facts: NewEventRecipientFacts = {
                                                    host, status, visitor, enterprise, onHoliday, blocked, newEventsSwitch, marketplaceSwitch, reachable, lastToldAt,
                                                };
                                                const tells = !host && status === 'active' && !visitor && !enterprise && !onHoliday && !blocked
                                                    && newEventsSwitch !== 'false' && marketplaceSwitch !== 'false' && reachable
                                                    && (lastToldAt === null || lastToldAt <= NOW - DAY);
                                                expect(newEventRecipientRefusal(facts, NOW) === null, JSON.stringify(facts)).toBe(tells);
                                                seen++;
                                                if (tells) told++;
                                            }
        expect(seen).toBe(2 * 3 * 2 * 2 * 2 * 2 * 3 * 3 * 2 * 6);
        expect(told).toBe(1 * 1 * 1 * 1 * 1 * 1 * 2 * 2 * 1 * 3);
    });
});

describe('the kind, its words and its switch', () => {
    it('is a kind of its own, landing on the Market, whose sentence names nothing', () => {
        expect(isPushNoticeKind('event.new')).toBe(true);
        expect(PUSH_NOTICE_KINDS['event.new'].tab).toBe('market');
        expect(pushNoticeWords('event.new')).toEqual({ title: PUSH_NOTICE_TITLE, body: 'There is a new event in your community.' });
    });

    it('is spelled as a phone from before it takes an unknown kind, so a 1.4.7 phone still checks its signature', () => {
        // apps/native utils/push-notice-check.ts UNKNOWN_KIND, unchanged since v1.4.7: a kind that fails it is dropped as
        // not a notice on a phone that doesn't know it; one that passes is shown with the general words.
        expect(/^(?=.{1,64}$)[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test('event.new')).toBe(true);
    });

    it('has its own switch, on until turned off, said only where a community says newEventPush', () => {
        expect(NEW_EVENT_PUSH_PREF).toBe('notify_new_events');
        expect(newEventPushSent('local')).toBe(true);
        for (const profile of ['global', undefined, null, 'Local', '']) expect(newEventPushSent(profile)).toBe(false);
        expect(newEventPushOn({ newEventPush: true })).toBe(true);
        for (const features of [undefined, null, {}, { newEventPush: false }, { newEventPush: 'true' }, { askedPush: true }]) {
            expect(newEventPushOn(features as object | null | undefined)).toBe(false);
        }
        expect(NEW_EVENT_PUSH_WORDS.switchName).toBe('When someone posts a new event');
        expect(NEW_EVENT_PUSH_WORDS.switchLine).toBe('At most once a day, and only for events open to everyone here');
    });
});
