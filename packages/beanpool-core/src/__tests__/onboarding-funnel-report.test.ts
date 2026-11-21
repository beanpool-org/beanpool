import { describe, it, expect } from 'vitest';
import {
    CLIENT_FUNNEL_EVENTS,
    FUNNEL_VARIANT_MAX,
    NOTIFY_CHOICE,
    NOTIFY_CHOICES,
    NOTIFY_SHOWN,
    clientFunnelReport,
    oncePerPersonVariant,
} from '../onboarding-funnel.js';

/**
 * What the server counts for one report from a member's app (POST /api/funnel-event), slice N1c of
 * DESIGN-notify-and-backup-asks-fable-amend2.md §4.4: the join's notifications screen adds two steps, `notify_shown`
 * and `notify_choice` (on, later, no), counted once per person as `protection_choice` is.
 *
 * ONE table over every kind of report: each step an app may send, in every variant form it could arrive in, and the
 * steps it may not send. `null` is a refusal (the server answers 400; the apps swallow it).
 */
type Row = [label: string, event: unknown, variant: unknown, expected: { event: string; variant: string } | null];

const LONG = 'x'.repeat(40);

const TABLE: Row[] = [
    // ── the notifications screen drawn: the per-person form only ──
    ['shown, once per person', 'notify_shown', 'once', { event: 'notify_shown', variant: 'once' }],
    ['shown, the old one-per-showing form', 'notify_shown', '', null],
    ['shown, with no variant at all', 'notify_shown', undefined, null],
    ['shown, carrying an answer', 'notify_shown', 'once:on', null],
    ['shown, a stray sub-type', 'notify_shown', 'once:A', null],
    ['shown, padded', 'notify_shown', ' once', null],
    ['shown, a number for a variant', 'notify_shown', 1, null],

    // ── the notifications screen answered: one of the three, per person ──
    ['answered: turned on', 'notify_choice', 'once:on', { event: 'notify_choice', variant: 'once:on' }],
    ['answered: later', 'notify_choice', 'once:later', { event: 'notify_choice', variant: 'once:later' }],
    ['answered: the phone said no', 'notify_choice', 'once:no', { event: 'notify_choice', variant: 'once:no' }],
    ['answered, with no answer', 'notify_choice', 'once', null],
    ['answered, an answer that is not one of the three', 'notify_choice', 'once:yes', null],
    ['answered, "Not now" from 1.4.7 words', 'notify_choice', 'once:not_now', null],
    ['answered, upper case', 'notify_choice', 'once:ON', null],
    ['answered, not per person', 'notify_choice', 'on', null],
    ['answered, empty', 'notify_choice', '', null],
    ['answered, not a string', 'notify_choice', { sub: 'on' }, null],
    ['answered, longer than the bound', 'notify_choice', `once:later${LONG}`, null],

    // ── the three older steps: as sent, cut to the bound, '' when not a string (older apps send these) ──
    ['protection shown, per person', 'protection_shown', 'once', { event: 'protection_shown', variant: 'once' }],
    ['protection shown, an older app\'s variant', 'protection_shown', 'A', { event: 'protection_shown', variant: 'A' }],
    ['protection shown, no variant', 'protection_shown', undefined, { event: 'protection_shown', variant: '' }],
    ['protection answered, per person', 'protection_choice', 'once:words', { event: 'protection_choice', variant: 'once:words' }],
    ['protection answered, too long', 'protection_choice', LONG, { event: 'protection_choice', variant: LONG.slice(0, FUNNEL_VARIANT_MAX) }],
    ['protection answered, not a string', 'protection_choice', 7, { event: 'protection_choice', variant: '' }],
    ['way back done, per person', 'guide_complete', 'once', { event: 'guide_complete', variant: 'once' }],
    ['way back done, an older app\'s variant', 'guide_complete', 'sw', { event: 'guide_complete', variant: 'sw' }],

    // ── steps an app may not send ──
    ['an invite outcome: the server counts those itself', 'invite_failed', 'invalid', null],
    ['an invite attempt', 'invite_attempt', '', null],
    ['an open-door outcome', 'open_join_failed', 'sign_in', null],
    ['a derived step', 'member_created', '', null],
    ['a first photo: the server sees that itself', 'avatar_published', 'once', null],
    ['a step name in the wrong case', 'NOTIFY_SHOWN', 'once', null],
    ['a step name with a space', 'notify_shown ', 'once', null],
    ['a prototype key', '__proto__', 'once', null],
    ['a prototype key, hasOwnProperty', 'hasOwnProperty', 'once', null],
    ['no step', undefined, 'once', null],
    ['a step that is not a string', ['notify_shown'], 'once', null],
];

describe('clientFunnelReport: what the server counts from a member\'s app', () => {
    it.each(TABLE)('%s', (_label, event, variant, expected) => {
        expect(clientFunnelReport(event, variant)).toEqual(expected);
    });

    it('the table covers every step an app may send, and at least one refusal of each notifications step', () => {
        const accepted = new Set(TABLE.filter(r => r[3]).map(r => r[1]));
        for (const step of CLIENT_FUNNEL_EVENTS) expect(accepted.has(step)).toBe(true);
        for (const step of [NOTIFY_SHOWN, NOTIFY_CHOICE]) {
            expect(TABLE.some(r => r[1] === step && r[3] === null)).toBe(true);
        }
    });

    it('takes each of the three answers, exactly these three, and nothing else for the answer', () => {
        expect([...NOTIFY_CHOICES]).toEqual(['on', 'later', 'no']);
        for (const choice of NOTIFY_CHOICES) {
            expect(clientFunnelReport(NOTIFY_CHOICE, oncePerPersonVariant(choice))).toEqual({ event: NOTIFY_CHOICE, variant: `once:${choice}` });
        }
    });

    it('every variant it stores fits the server\'s bound', () => {
        for (const [, event, variant, expected] of TABLE) {
            const got = clientFunnelReport(event, variant);
            if (got) expect(got.variant.length).toBeLessThanOrEqual(FUNNEL_VARIANT_MAX);
            expect(got).toEqual(expected);
        }
    });

    it('the steps an app may send are the three older ones and the two new ones, in that order', () => {
        expect([...CLIENT_FUNNEL_EVENTS]).toEqual(['protection_shown', 'protection_choice', 'guide_complete', 'notify_shown', 'notify_choice']);
    });
});
