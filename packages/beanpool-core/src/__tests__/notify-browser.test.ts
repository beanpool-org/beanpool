/**
 * The web's notifications ask in core (src/notify-ask.ts `notifyBrowserPhone`, `notifyBrowserPrompter`,
 * `notifyBrowserOutcome`, `notifyOutcomeEvent`, `notifyJoinWords` with a prompter; DESIGN-notify-and-backup-asks-fable-amend2.md
 * §10, slice N5a). The web reads its browser into the phone's rule, so the phone and the web cannot drift.
 *
 * One table over every state: (browser) x (path: an invite join, a member already in) x (record) -> the join's screen,
 * Home's once card, or nothing; and whether the line under the button promises a prompt. Each row's `pins` names the
 * guard it holds: take it away and the row goes red.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
    markNotifyAsk, notifyAsks, notifyBrowserOutcome, notifyBrowserPhone, notifyBrowserPrompter, notifyJoinStep, notifyJoinWords, notifyOutcomeEvent,
    type NotifyAskRecord, type NotifyBrowser, type NotifyBrowserResult,
} from '../notify-ask.js';
import { localDay } from '../home-tips.js';
import { PSEUDO_LANG, setLanguage } from '../words.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 22, 12, 0).getTime();
const TODAY = localDay(new Date(NOW));

afterEach(() => setLanguage('en'));

type Browser = { b: NotifyBrowser; asks: boolean; prompt: boolean; pins: string };
const BROWSERS: Record<string, Browser> = {
    'web push here, never asked': { b: { push: true, permission: 'default', on: false }, asks: true, prompt: true, pins: 'canAskAgain: default' },
    "web push here, a prompt closed with no answer ('default' again)": { b: { push: true, permission: 'default', on: false }, asks: true, prompt: true, pins: 'default is never a no' },
    'no web push (Safari on an iPhone outside the Home Screen, a private window, http)': { b: { push: false, permission: null, on: false }, asks: false, prompt: false, pins: 'push' },
    'no web push, though Notification says default': { b: { push: false, permission: 'default', on: false }, asks: false, prompt: false, pins: 'push before permission' },
    "already granted, and this account's notifications on here": { b: { push: true, permission: 'granted', on: true }, asks: false, prompt: false, pins: 'granted = on' },
    'already granted for the site, this account not on here (a Tell me kept)': { b: { push: true, permission: 'granted', on: false }, asks: true, prompt: false, pins: 'on, not permission' },
    'denied: the browser blocks this site': { b: { push: true, permission: 'denied', on: false }, asks: false, prompt: false, pins: 'denied' },
};

const RECORDS: Record<string, { record: NotifyAskRecord; join: boolean; once: boolean; pins: string }> = {
    'a new account here': { record: {}, join: true, once: true, pins: 'free day' },
    'met the join here, Later yesterday': { record: { joinAt: NOW - DAY - 1, laterAt: NOW - DAY, askDay: localDay(new Date(NOW - DAY)), askKind: 'join' }, join: true, once: false, pins: 'once only for a member who never met the join' },
    'once card shown 3 days ago, not answered': { record: { onceAt: NOW - 3 * DAY, askDay: localDay(new Date(NOW - 3 * DAY)), askKind: 'once' }, join: true, once: true, pins: 'onceOpen' },
    'once card put away with Later': { record: { onceAt: NOW - 3 * DAY, onceClosedAt: NOW - 2 * DAY, laterAt: NOW - 2 * DAY }, join: true, once: false, pins: 'Later puts the card away' },
    'once card shown 8 days ago, never answered': { record: { onceAt: NOW - 8 * DAY, askDay: localDay(new Date(NOW - 8 * DAY)), askKind: 'once' }, join: true, once: false, pins: '7 days' },
    'a named line today': { record: { askDay: TODAY, askKind: 'line', lines: ['answer'] }, join: false, once: false, pins: 'one soft ask a day' },
    "the browser's no, recorded": { record: { phoneNoAt: NOW - DAY }, join: false, once: false, pins: 'notifyPhoneSaidNo' },
};

describe('the web: (browser) x (path) x (record) -> screen, card or nothing', () => {
    for (const [bName, br] of Object.entries(BROWSERS)) {
        for (const [rName, r] of Object.entries(RECORDS)) {
            const phone = notifyBrowserPhone(br.b);
            const screen = br.asks && r.join;
            const card = br.asks && r.once;
            it(`invite join · ${bName} · ${rName} → ${screen ? 'the screen' : 'nothing'} [${br.asks ? r.pins : br.pins}]`, () => {
                expect(notifyJoinStep('invite', { record: r.record, phone, now: NOW })).toBe(screen);
            });
            it(`member already in · ${bName} · ${rName} → ${card ? 'the once card' : 'nothing'} [${br.asks ? r.pins : br.pins}]`, () => {
                expect(notifyAsks({ record: r.record, phone, now: NOW }).once).toBe(card);
            });
        }
        it(`${bName}: the line under the button ${br.prompt ? 'says the browser will ask' : 'promises no prompt'} [prompter]`, () => {
            const words = notifyJoinWords({ kind: 'community', community: 'Riverside', prompter: notifyBrowserPrompter(br.b) });
            // Where the screen can show at all, its line is the browser's, or nothing where the browser already allows.
            if (br.asks) expect(words.confirm).toBe(br.prompt ? 'Your browser will ask you to confirm.' : '');
        });
    }

    it('a restore never meets the join, on the web as on the phone', () => {
        expect(notifyJoinStep('restore', { record: {}, phone: notifyBrowserPhone(BROWSERS['web push here, never asked'].b), now: NOW })).toBe(false);
    });
});

describe("the browser's answer at Turn on (N5a)", () => {
    const ROWS: Array<{ r: NotifyBrowserResult; outcome: ReturnType<typeof notifyBrowserOutcome> }> = [
        { r: 'ok', outcome: 'granted' },
        { r: 'blocked', outcome: 'declined' },
        // Browsers report "default" when the prompt is closed with no answer: a Later, never a no.
        { r: 'dismissed', outcome: 'unanswered' },
        { r: 'cannot', outcome: 'unanswered' },
        { r: 'failed', outcome: null },
    ];
    for (const row of ROWS) it(`${row.r} → ${row.outcome ?? 'nothing recorded'}`, () => expect(notifyBrowserOutcome(row.r)).toBe(row.outcome));

    it('a dismissed prompt records a Later with its date and never the no; the join can come again on another day', () => {
        const shown = markNotifyAsk<NotifyAskRecord>({}, { type: 'shown', surface: 'join' }, NOW - DAY);
        const after = markNotifyAsk(shown, notifyOutcomeEvent(notifyBrowserOutcome('dismissed')!, 'join'), NOW - DAY + 1000);
        expect(after.laterAt).toBe(NOW - DAY + 1000);
        expect(after.phoneNoAt).toBeUndefined();
        expect(notifyJoinStep('invite', { record: after, phone: notifyBrowserPhone({ push: true, permission: 'default', on: false }), now: NOW })).toBe(true);
    });
    it("the browser's no is recorded apart, with its date", () => {
        expect(markNotifyAsk({}, notifyOutcomeEvent('declined', 'join'), NOW)).toEqual({ phoneNoAt: NOW });
    });
    it('a yes is the record’s granted; on the once card it also closes the card for good (review of d2a4734f)', () => {
        expect(markNotifyAsk({}, notifyOutcomeEvent('granted', 'join'), NOW)).toEqual({ state: 'granted', updatedAt: NOW });
        expect(markNotifyAsk({}, notifyOutcomeEvent('granted', 'once'), NOW)).toEqual({ state: 'granted', updatedAt: NOW, onceClosedAt: NOW });
    });
    it("the browser's no on the once card closes it too; an earlier close keeps its date", () => {
        expect(markNotifyAsk({}, notifyOutcomeEvent('declined', 'once'), NOW)).toEqual({ phoneNoAt: NOW, onceClosedAt: NOW });
        expect(markNotifyAsk({ onceClosedAt: NOW - DAY }, notifyOutcomeEvent('granted', 'once'), NOW).onceClosedAt).toBe(NOW - DAY);
    });
    it('Later on the once card puts it away', () => {
        const r = markNotifyAsk<NotifyAskRecord>({ onceAt: NOW - DAY }, notifyOutcomeEvent('unanswered', 'once'), NOW);
        expect(r.onceClosedAt).toBe(NOW);
        expect(notifyAsks({ record: r, phone: notifyBrowserPhone({ push: true, permission: 'default', on: false }), now: NOW + DAY }).once).toBe(false);
    });
});

describe("the once card closed for good (review of d2a4734f: it came back after Settings' Turn off)", () => {
    // The browser still allows the site, and this account is off here: it reads as able to ask.
    const OFF_HERE = notifyBrowserPhone({ push: true, permission: 'granted', on: false });
    const once = (record: NotifyAskRecord, at: number) => notifyAsks({ record, phone: OFF_HERE, now: at }).once;

    it("a yes on the card, then off here (the browser still allows the site): no card on any later landing [closesOnce on 'granted']", () => {
        let r = markNotifyAsk<NotifyAskRecord>({}, { type: 'shown', surface: 'once' }, NOW);
        r = markNotifyAsk(r, notifyOutcomeEvent('granted', 'once'), NOW + 60_000);
        for (const at of [NOW + 3_600_000, NOW + DAY, NOW + 6 * DAY]) expect(once(r, at)).toBe(false);
    });
    it("Turn off in Settings ('off') closes it, drawn or not, and keeps the first close's date [closesOnce on 'off']", () => {
        expect(markNotifyAsk<NotifyAskRecord>({}, { type: 'off' }, NOW)).toEqual({ onceClosedAt: NOW });
        expect(markNotifyAsk<NotifyAskRecord>({ onceClosedAt: NOW - DAY }, { type: 'off' }, NOW)).toEqual({ onceClosedAt: NOW - DAY });
        const drawn = markNotifyAsk(markNotifyAsk<NotifyAskRecord>({}, { type: 'shown', surface: 'once' }, NOW - DAY), { type: 'off' }, NOW);
        expect(once(drawn, NOW + DAY)).toBe(false);
    });
    it("never drawn, then Turn off in Settings: never the card, though no onceAt is on record [once: onceClosedAt alone]", () => {
        const r = markNotifyAsk<NotifyAskRecord>({}, { type: 'off' }, NOW);
        for (const at of [NOW + 3_600_000, NOW + DAY, NOW + 8 * DAY]) expect(once(r, at)).toBe(false);
    });
    it("'off' is no no: the join's screen on a later join and the bell's line still read the browser", () => {
        const r = markNotifyAsk<NotifyAskRecord>({}, { type: 'off' }, NOW - DAY);
        expect(notifyAsks({ record: r, phone: OFF_HERE, now: NOW })).toMatchObject({ join: true, once: false, bell: true });
        expect(r.phoneNoAt).toBeUndefined();
    });
});

describe('notifyJoinWords: who will ask', () => {
    it('the phone by default, as before', () => {
        expect(notifyJoinWords({ kind: 'community' }).confirm).toBe('Your phone will ask you to confirm.');
    });
    it('the browser on the web; none where it asks nothing', () => {
        expect(notifyJoinWords({ kind: 'community', prompter: 'browser' }).confirm).toBe('Your browser will ask you to confirm.');
        expect(notifyJoinWords({ kind: 'community', prompter: 'none' }).confirm).toBe('');
    });
    it("the browser's line goes through t()", () => {
        setLanguage(PSEUDO_LANG);
        expect(notifyJoinWords({ kind: 'community', prompter: 'browser' }).confirm).toMatch(/~/);
    });
});
