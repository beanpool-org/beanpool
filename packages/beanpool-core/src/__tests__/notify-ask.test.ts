/**
 * The notifications rule (src/notify-ask.ts; DESIGN-notify-and-backup-asks-fable-amend2.md §6, §7, slice N1).
 *
 * Two halves. The table: one row per guard in the rule, each red when that guard goes (the row's `pins` names it). The
 * sweep: every combination of phone, record and day, checked against the design's invariants (nothing after the
 * phone's "no" but the fact and bell lines; one soft ask a day; "Later" is never final; an older app's "Not now" reads
 * as a "Later").
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, it, expect } from 'vitest';
import {
    markNotifyAsk, notifyAskRecordFrom, notifyAsks, notifyEventLineWords, notifyFirstStepsLine, notifyInterestsPromise, notifyLaterAt, notifyLineWords, notifyPhoneSaidNo,
    notifyRemindersOff, notifyTurnOn, NOTIFY_TRUE_WORDS, NOTIFY_FACT_DAYS, NOTIFY_HOME_AFTER_LATER_DAYS, NOTIFY_HOME_AWAY_DAYS, NOTIFY_HOME_AWAYS, NOTIFY_LINE_KINDS, NOTIFY_ONCE_CARD_DAYS,
    type NotifyAskInput, type NotifyAskRecord, type NotifyAsks, type NotifyAskSurface, type NotifyLineKind, type NotifyPhone,
} from '../notify-ask.js';
import { localDay } from '../home-tips.js';
import { LANGS, PSEUDO_LANG, pseudoLocalise, setLanguage, type Catalog } from '../words.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Local noon, so "today" and "yesterday" are the same days in every time zone. */
const NOW = new Date(2026, 10, 21, 12, 0).getTime();
const TODAY = localDay(new Date(NOW));
const ago = (days: number) => NOW - days * DAY;

const NONE: NotifyPhone = { available: false, granted: false, canAskAgain: false };
const ON: NotifyPhone = { available: true, granted: true, canAskAgain: true };
const ASK: NotifyPhone = { available: true, granted: false, canAskAgain: true };
const SETTINGS: NotifyPhone = { available: true, granted: false, canAskAgain: false };
const PHONES = { NONE, ON, ASK, SETTINGS };

const SOFT: readonly NotifyAskSurface[] = ['join', 'once', 'line', 'home', 'fact'];
/** Every input on, so a row shows every ask the rule allows it. */
const ALL = { line: 'answer', live: true, waited: true } as const;

const asksOf = (a: NotifyAsks) => SOFT.filter((s) => a[s]);

type Row = {
    name: string;
    pins: string;
    phone: NotifyPhone;
    record: NotifyAskRecord;
    input?: Partial<Pick<NotifyAskInput, 'line' | 'live' | 'waited'>>;
    asks: NotifyAskSurface[];
    steps: boolean | null;
    bell: boolean;
};

const today = (kind: NotifyAskSurface) => ({ askDay: TODAY, askKind: kind });

const ROWS: Row[] = [
    // The phone
    { name: 'nothing to turn on here', pins: 'available', phone: NONE, record: {}, asks: [], steps: null, bell: false },
    { name: 'Android 8 to 12: on without asking', pins: 'granted', phone: ON, record: {}, asks: [], steps: null, bell: false },
    { name: 'allowed through one of our asks: First steps ticks', pins: "state 'granted'", phone: ON, record: { state: 'granted' }, asks: [], steps: true, bell: false },
    { name: 'allowed again in the phone settings after its no', pins: 'granted beats phoneNoAt', phone: ON, record: { phoneNoAt: ago(5) }, asks: [], steps: null, bell: false },
    { name: "the phone's no on Android, recorded (it could ask once more)", pins: 'phoneNoAt', phone: ASK, record: { phoneNoAt: ago(1), joinAt: ago(2) }, asks: ['fact'], steps: null, bell: true },
    { name: "an iPhone's Don't Allow, never recorded here", pins: 'canAskAgain', phone: SETTINGS, record: {}, asks: ['fact'], steps: null, bell: true },
    { name: "allowed once, then switched off in the iPhone's settings", pins: 'canAskAgain over state', phone: SETTINGS, record: { state: 'granted', joinAt: ago(30) }, asks: ['fact'], steps: null, bell: true },
    { name: "allowed once, then switched off in Android's settings (it can ask)", pins: 'the phone, not the record', phone: ASK, record: { state: 'granted', joinAt: ago(30) }, input: { line: 'answer' }, asks: ['join', 'line'], steps: false, bell: true },

    // The join's screen and the once card on a new phone
    { name: 'a new phone in the join', pins: 'join, once on a free day', phone: ASK, record: {}, input: { line: 'answer', waited: true }, asks: ['join', 'once', 'line', 'fact'], steps: null, bell: true },
    { name: 'the join: shown today, killed before an answer, resumes on it', pins: 'join unanswered', phone: ASK, record: { ...today('join'), joinAt: NOW - HOUR }, asks: ['join', 'line'], steps: false, bell: true },
    { name: "the join: shown today, a Later from before it doesn't answer it", pins: 'laterAt >= joinAt', phone: ASK, record: { ...today('join'), joinAt: NOW - HOUR, laterAt: ago(3) }, asks: ['join', 'line'], steps: false, bell: true },
    { name: "the join: Later today; one named line is still allowed, nothing else", pins: 'join answered; the join-day line', phone: ASK, record: { ...today('join'), joinAt: NOW - 2 * HOUR, laterAt: NOW - HOUR }, asks: ['line'], steps: false, bell: true },
    { name: 'the join day: its one named line already shown', pins: 'one line on the join day', phone: ASK, record: { ...today('line'), joinAt: NOW - 2 * HOUR, laterAt: NOW - 2 * HOUR, lines: ['answer'] }, input: { line: 'writes', live: true, waited: true }, asks: [], steps: false, bell: true },
    { name: "a second community's join the next day, after a Later", pins: 'join after a Later', phone: ASK, record: { askDay: localDay(new Date(ago(1))), askKind: 'join', joinAt: ago(1), laterAt: ago(1) }, asks: ['join', 'line', 'fact'], steps: false, bell: true },

    // Inputs
    { name: 'no line asked about, nothing live, nothing waited', pins: 'line, live, waited inputs', phone: ASK, record: { joinAt: ago(60) }, input: {}, asks: ['join'], steps: false, bell: true },
    { name: 'a named line kind shown before', pins: 'each kind once', phone: ASK, record: { joinAt: ago(60), lines: ['answer'] }, input: { line: 'answer' }, asks: ['join'], steps: false, bell: true },
    { name: 'another named line kind', pins: 'kinds apart', phone: ASK, record: { joinAt: ago(60), lines: ['answer'] }, input: { line: 'writes' }, asks: ['join', 'line'], steps: false, bell: true },

    // The Home card
    { name: 'Home card: 8 days after a Later, something live', pins: 'Later 7 days (over)', phone: ASK, record: { joinAt: ago(8), laterAt: ago(8) }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
    { name: 'Home card: 6 days after a Later', pins: 'Later 7 days', phone: ASK, record: { joinAt: ago(6), laterAt: ago(6) }, asks: ['join', 'line', 'fact'], steps: false, bell: true },
    { name: "Home card: an older app's Not now 3 days ago is a Later", pins: 'old declined = Later', phone: ASK, record: { state: 'declined', updatedAt: ago(3), joinAt: ago(30) }, asks: ['join', 'line', 'fact'], steps: false, bell: true },
    { name: 'Home card: × 29 days ago', pins: '× 30 days', phone: ASK, record: { joinAt: ago(60), homeAwayAt: ago(29), homeAways: 1 }, asks: ['join', 'line', 'fact'], steps: false, bell: true },
    { name: 'Home card: × 31 days ago, the second ×', pins: '× 30 days (over)', phone: ASK, record: { joinAt: ago(60), homeAwayAt: ago(31), homeAways: 2 }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
    { name: 'Home card: after the third ×, for good', pins: 'three ×', phone: ASK, record: { joinAt: ago(90), homeAwayAt: ago(40), homeAways: 3 }, asks: ['join', 'line', 'fact'], steps: false, bell: true },
    { name: 'Home card: already shown today, a later landing', pins: 'home keeps its day', phone: ASK, record: { ...today('home'), joinAt: ago(30) }, asks: ['home'], steps: false, bell: true },

    // The once card (members already in)
    { name: "the friend: an older app's Not now, the phone can still ask", pins: 'once ignores a Later', phone: ASK, record: { state: 'declined', updatedAt: ago(20) }, asks: ['join', 'once', 'line', 'fact'], steps: null, bell: true },
    { name: 'once card: shown 3 days ago, untouched', pins: 'once open 7 days', phone: ASK, record: { onceAt: ago(3), askDay: localDay(new Date(ago(3))), askKind: 'once' }, asks: ['join', 'once', 'line', 'fact'], steps: null, bell: true },
    { name: 'once card: shown an hour ago, a later landing today', pins: 'once keeps its day', phone: ASK, record: { ...today('once'), onceAt: NOW - HOUR }, asks: ['once'], steps: null, bell: true },
    { name: 'once card: 8 days untouched, folded into First steps', pins: 'once 7 days', phone: ASK, record: { onceAt: ago(8) }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
    { name: 'once card: Later yesterday', pins: 'onceClosedAt', phone: ASK, record: { onceAt: ago(1), onceClosedAt: ago(1), laterAt: ago(1) }, asks: ['join', 'line', 'fact'], steps: false, bell: true },
    { name: "once card: never where the join's screen was shown", pins: 'joinAt', phone: ASK, record: { joinAt: ago(30), laterAt: ago(30) }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
    { name: "once card: not first shown on a day a named line took", pins: 'once on a free day', phone: ASK, record: { ...today('line'), lines: ['answer'] }, input: { line: 'writes', live: true, waited: true }, asks: [], steps: false, bell: true },

    // The fact line, and one a day
    { name: 'fact line: shown 29 days ago', pins: 'fact 30 days', phone: ASK, record: { joinAt: ago(60), factAt: ago(29) }, asks: ['join', 'line', 'home'], steps: false, bell: true },
    { name: 'fact line: shown 31 days ago', pins: 'fact 30 days (over)', phone: ASK, record: { joinAt: ago(60), factAt: ago(31) }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
    { name: 'fact line: shown today, nothing else today', pins: 'fact takes its day', phone: ASK, record: { ...today('fact'), joinAt: ago(60), factAt: NOW - HOUR }, asks: [], steps: false, bell: true },
    { name: 'fact line: a day taken by another ask', pins: 'fact on a free day', phone: SETTINGS, record: { ...today('line'), factAt: ago(40) }, asks: [], steps: null, bell: true },
    { name: 'a day stamped with no kind counts as taken', pins: "askKind ?? 'line'", phone: ASK, record: { askDay: TODAY, joinAt: ago(60) }, asks: [], steps: false, bell: true },
    { name: "yesterday's ask leaves today free", pins: 'askDay is a day', phone: ASK, record: { askDay: localDay(new Date(ago(1))), askKind: 'line', joinAt: ago(60), lines: ['writes'] }, asks: ['join', 'line', 'home', 'fact'], steps: false, bell: true },
];

describe('the table: one row per guard', () => {
    for (const row of ROWS) {
        it(`${row.name} (${row.pins})`, () => {
            const got = notifyAsks({ record: row.record, phone: row.phone, now: NOW, ...(row.input ?? ALL) });
            expect({ asks: asksOf(got), steps: got.firstSteps, bell: got.bell }).toEqual({ asks: row.asks, steps: row.steps, bell: row.bell });
        });
    }

    it('the constants are the design\'s', () => {
        expect([NOTIFY_ONCE_CARD_DAYS, NOTIFY_HOME_AFTER_LATER_DAYS, NOTIFY_HOME_AWAY_DAYS, NOTIFY_HOME_AWAYS, NOTIFY_FACT_DAYS]).toEqual([7, 7, 30, 3, 30]);
    });
});

describe('the parts', () => {
    it("notifyLaterAt: the record's own Later, else an older app's Not now; never a phone's no", () => {
        expect(notifyLaterAt({})).toBeNull();
        expect(notifyLaterAt({ state: 'unanswered', updatedAt: 5 })).toBeNull();
        expect(notifyLaterAt({ laterAt: 7, state: 'declined', updatedAt: 5 })).toBe(7);
        expect(notifyLaterAt({ state: 'declined', updatedAt: 5 })).toBe(5);
        expect(notifyLaterAt({ state: 'declined' })).toBe(0);
        expect(notifyLaterAt({ state: 'declined', updatedAt: 5, phoneNoAt: 5 })).toBeNull();
        expect(notifyLaterAt({ state: 'granted', updatedAt: 5 })).toBeNull();
    });

    it("notifyPhoneSaidNo and notifyTurnOn read the phone first", () => {
        expect(notifyPhoneSaidNo({ phoneNoAt: 1 }, ON)).toBe(false);
        expect(notifyPhoneSaidNo({ phoneNoAt: 1 }, NONE)).toBe(false);
        expect(notifyPhoneSaidNo({ phoneNoAt: 1 }, ASK)).toBe(true);
        expect(notifyPhoneSaidNo({}, ASK)).toBe(false);
        expect(notifyPhoneSaidNo({}, SETTINGS)).toBe(true);
        expect([NONE, ON, ASK, SETTINGS].map(notifyTurnOn)).toEqual(['none', 'none', 'ask', 'settings']);
    });

    it("notifyFirstStepsLine stays through a Later and leaves after the phone's no", () => {
        expect(notifyFirstStepsLine({ laterAt: NOW }, ASK)).toBe(false);
        expect(notifyFirstStepsLine({ state: 'declined', updatedAt: 1 }, ASK)).toBe(false);
        expect(notifyFirstStepsLine({ phoneNoAt: NOW }, ASK)).toBeNull();
        expect(notifyFirstStepsLine({}, SETTINGS)).toBeNull();
        expect(notifyFirstStepsLine({ state: 'granted' }, ON)).toBe(true);
        expect(notifyFirstStepsLine({}, ON)).toBeNull();
        expect(notifyFirstStepsLine({ state: 'granted' }, NONE)).toBeNull();
    });

    it('notifyAskRecordFrom keeps only well-typed fields, and reads an older app\'s record as it is', () => {
        for (const junk of [null, undefined, 'x', 3, true]) expect(notifyAskRecordFrom(junk)).toEqual({});
        // An older phone's record: its 'declined' stays, nothing is rewritten.
        expect(notifyAskRecordFrom({ state: 'declined', actionAsked: true, updatedAt: 123 })).toEqual({ state: 'declined', updatedAt: 123 });
        expect(notifyAskRecordFrom({
            state: 'maybe', updatedAt: 'then', laterAt: 'yesterday', phoneNoAt: Number.NaN, askDay: 'Tuesday', askKind: 'popup',
            lines: ['answer', 3, null], joinAt: 9, homeAways: 2,
        })).toEqual({ state: 'unanswered', updatedAt: 0, lines: ['answer'], joinAt: 9, homeAways: 2 });
        const full = {
            state: 'granted', updatedAt: 1, laterAt: 2, phoneNoAt: 3, askDay: '2026-11-21', askKind: 'home', joinAt: 4, onceAt: 5,
            onceClosedAt: 6, lines: ['a'], homeAwayAt: 7, homeAways: 1, factAt: 8,
        };
        expect(notifyAskRecordFrom(full)).toEqual(full);
    });

    it('markNotifyAsk: each event writes only its own fields, and keeps the rest', () => {
        const r = { state: 'unanswered' as const, updatedAt: 1, actionAsked: true, lines: ['answer'] };
        expect(markNotifyAsk(r, { type: 'shown', surface: 'join' }, NOW)).toEqual({ ...r, askDay: TODAY, askKind: 'join', joinAt: NOW });
        expect(markNotifyAsk(r, { type: 'shown', surface: 'once' }, NOW)).toEqual({ ...r, askDay: TODAY, askKind: 'once', onceAt: NOW });
        expect(markNotifyAsk({ ...r, onceAt: 5 }, { type: 'shown', surface: 'once' }, NOW).onceAt).toBe(5);
        expect(markNotifyAsk(r, { type: 'shown', surface: 'fact' }, NOW)).toEqual({ ...r, askDay: TODAY, askKind: 'fact', factAt: NOW });
        expect(markNotifyAsk(r, { type: 'shown', surface: 'home' }, NOW)).toEqual({ ...r, askDay: TODAY, askKind: 'home' });
        expect(markNotifyAsk(r, { type: 'shown', surface: 'line', line: 'writes' }, NOW).lines).toEqual(['answer', 'writes']);
        expect(markNotifyAsk(r, { type: 'shown', surface: 'line', line: 'answer' }, NOW).lines).toEqual(['answer']);
        expect(markNotifyAsk(r, { type: 'shown', surface: 'line' }, NOW)).toEqual({ ...r, askDay: TODAY, askKind: 'line' });
        expect(markNotifyAsk(r, { type: 'later' }, NOW)).toEqual({ ...r, laterAt: NOW });
        expect(markNotifyAsk(r, { type: 'later', surface: 'once' }, NOW)).toEqual({ ...r, laterAt: NOW, onceClosedAt: NOW });
        expect(markNotifyAsk(r, { type: 'away' }, NOW)).toEqual({ ...r, homeAwayAt: NOW, homeAways: 1 });
        expect(markNotifyAsk({ ...r, homeAways: 2 }, { type: 'away' }, NOW).homeAways).toBe(3);
        expect(markNotifyAsk(r, { type: 'granted' }, NOW)).toEqual({ ...r, state: 'granted', updatedAt: NOW });
        // The phone's no leaves `state` alone: an older app's 'declined' is only ever its Not now.
        expect(markNotifyAsk(r, { type: 'phone-no' }, NOW)).toEqual({ ...r, phoneNoAt: NOW });
    });

    it('the friend after the update: the once card, Later, then the named lines from the next day', () => {
        let rec: NotifyAskRecord = { state: 'declined', updatedAt: ago(30) };
        const at = (now: number, extra: Partial<NotifyAskInput> = {}) => notifyAsks({ record: rec, phone: ASK, now, ...extra });
        expect(at(NOW).once).toBe(true);
        rec = markNotifyAsk(rec, { type: 'shown', surface: 'once' }, NOW);
        rec = markNotifyAsk(rec, { type: 'later', surface: 'once' }, NOW + HOUR);
        expect(at(NOW + 2 * HOUR, { line: 'answer' })).toMatchObject({ once: false, line: false, firstSteps: false });
        expect(at(NOW + DAY, { line: 'answer' })).toMatchObject({ once: false, line: true, home: false, firstSteps: false });
        expect(at(NOW + 8 * DAY, { live: true }).home).toBe(true);
    });
});

describe('the sweep: every phone, record and day against the invariants', () => {
    const states: NotifyAskRecord[] = [{}, { state: 'granted', updatedAt: ago(40) }, { state: 'declined', updatedAt: ago(20) }];
    const laters: NotifyAskRecord[] = [{}, { laterAt: NOW - HOUR }, { laterAt: ago(3) }, { laterAt: ago(8) }];
    const phoneNos: NotifyAskRecord[] = [{}, { phoneNoAt: ago(2) }];
    const todays: NotifyAskRecord[] = [{}, { ...today('join'), joinAt: NOW - 2 * HOUR }, { ...today('once'), onceAt: NOW - 2 * HOUR },
        { ...today('line') }, { ...today('home') }, { ...today('fact'), factAt: NOW - 2 * HOUR }];
    const joins: NotifyAskRecord[] = [{}, { joinAt: ago(30) }];
    const onces: NotifyAskRecord[] = [{}, { onceAt: ago(3) }, { onceAt: ago(3), onceClosedAt: ago(2) }, { onceAt: ago(8) }];
    const lines: NotifyAskRecord[] = [{}, { lines: ['answer'] }];
    const aways: NotifyAskRecord[] = [{}, { homeAwayAt: ago(10), homeAways: 1 }, { homeAwayAt: ago(40), homeAways: 3 }];
    const facts: NotifyAskRecord[] = [{}, { factAt: ago(10) }];
    // Later facets after earlier ones, so `today`'s joinAt/onceAt/factAt win over the older ones.
    const records: NotifyAskRecord[] = [];
    for (const a of states) for (const b of laters) for (const c of phoneNos) for (const d of joins) for (const e of onces)
        for (const f of lines) for (const g of aways) for (const h of facts) for (const i of todays)
            records.push({ ...a, ...b, ...c, ...d, ...e, ...f, ...g, ...h, ...i });
    const inputs: Partial<NotifyAskInput>[] = [ALL, {}];
    const each = (fn: (r: NotifyAskRecord, p: NotifyPhone, input: Partial<NotifyAskInput>, got: NotifyAsks) => void) => {
        for (const r of records) for (const p of Object.values(PHONES)) for (const input of inputs) {
            fn(r, p, input, notifyAsks({ record: r, phone: p, now: NOW, ...input }));
        }
    };
    const fail = (r: NotifyAskRecord, p: NotifyPhone, input: object, got: NotifyAsks, why: string) =>
        expect.fail(`${why}\nrecord ${JSON.stringify(r)}\nphone ${JSON.stringify(p)}\ninput ${JSON.stringify(input)}\ngot ${JSON.stringify(got)}`);

    it(`covers ${records.length} records × 4 phones × 2 inputs`, () => {
        expect(records.length).toBe(3 * 4 * 2 * 6 * 2 * 4 * 2 * 3 * 2);
    });

    it('nothing to turn on, or already on: no ask and no bell line; First steps only ticks', () => {
        each((r, p, input, got) => {
            if (p.available && !p.granted) return;
            if (asksOf(got).length || got.bell) fail(r, p, input, got, 'an ask or the bell where nothing can be turned on');
            const steps = p.available && r.state === 'granted' ? true : null;
            if (got.firstSteps !== steps) fail(r, p, input, got, 'First steps');
        });
    });

    it("after the phone's no: no join, once card, named line or Home card; First steps leaves; the bell's line stays", () => {
        each((r, p, input, got) => {
            if (!notifyPhoneSaidNo(r, p)) return;
            if (got.join || got.once || got.line || got.home) fail(r, p, input, got, "an ask after the phone's no");
            if (got.firstSteps !== null || !got.bell) fail(r, p, input, got, "First steps or the bell after the phone's no");
        });
    });

    it('one soft ask a day: a day already taken allows only its own ask, and a named line after the join\'s screen', () => {
        each((r, p, input, got) => {
            if (r.askDay !== TODAY) return;
            const others = asksOf(got).filter((s) => s !== r.askKind && !(s === 'line' && r.askKind === 'join'));
            if (others.length) fail(r, p, input, got, `asked ${r.askKind} today, and also ${others.join(', ')}`);
            if (got.line && r.askKind === 'line') fail(r, p, input, got, 'two named lines in a day');
            if (got.fact && r.askKind === 'fact') fail(r, p, input, got, 'two fact lines in a day');
        });
    });

    it('the once card is alone: never with the Home card, and First steps waits while it is up', () => {
        each((r, p, input, got) => {
            if (got.once && (got.home || got.firstSteps !== null)) fail(r, p, input, got, 'the once card with another');
        });
    });

    it('with nothing to name, nothing live and nothing waiting: no named line, Home card or fact line', () => {
        each((r, p, input, got) => {
            if (input === ALL) return;
            if (got.line || got.home || got.fact) fail(r, p, input, got, 'an ask with no reason for it');
        });
    });

    it('"Later" is never final: a Later 8 days ago asks as if there had been none', () => {
        for (const r of records) {
            if (r.laterAt !== ago(8) || r.state === 'declined') continue;
            const without = { ...r };
            delete without.laterAt;
            for (const p of Object.values(PHONES)) for (const input of inputs) {
                expect(notifyAsks({ record: r, phone: p, now: NOW, ...input })).toEqual(notifyAsks({ record: without, phone: p, now: NOW, ...input }));
            }
        }
    });

    it('an older app\'s "Not now" reads as a "Later" at its date', () => {
        for (const r of records) {
            if (r.state !== 'declined' || r.laterAt !== undefined || r.phoneNoAt !== undefined) continue;
            const asLater: NotifyAskRecord = { ...r, state: 'unanswered', laterAt: r.updatedAt };
            for (const p of Object.values(PHONES)) for (const input of inputs) {
                expect(notifyAsks({ record: r, phone: p, now: NOW, ...input })).toEqual(notifyAsks({ record: asLater, phone: p, now: NOW, ...input }));
            }
        }
    });

    it('an ask, once marked shown, takes the day from every other', () => {
        for (const r of records) {
            if (r.askDay === TODAY) continue;
            for (const p of Object.values(PHONES)) {
                const before = notifyAsks({ record: r, phone: p, now: NOW, ...ALL });
                for (const s of asksOf(before)) {
                    const after = notifyAsks({ record: markNotifyAsk(r, { type: 'shown', surface: s, line: ALL.line }, NOW), phone: p, now: NOW + HOUR, ...ALL });
                    const others = asksOf(after).filter((o) => o !== s && !(o === 'line' && s === 'join'));
                    if (others.length || (s === 'line' && after.line) || (s === 'fact' && after.fact)) {
                        fail(r, p, { shown: s }, after, `after ${s} was shown`);
                    }
                }
            }
        }
    });
});

// Slice N2a (amend2 §12.3): the named lines at the member's own acts. Which kind may show is the rule above (`line`); here,
// one row per (moment, phone and record) as the slice's brief names them, and the words each kind says.
describe('the named lines (slice N2a)', () => {
    afterEach(() => setLanguage('en'));
    const MOMENTS: Record<NotifyLineKind, string> = {
        answer: 'a first message sent', again: 'a first message read, or a request accepted', listing: 'a first listing',
        offer: 'a first offer or request on a listing', join: 'an ask to join',
        // Slice N2b's four (their own block below).
        going: 'Going on an event', interested: 'Interested in an event', star: 'a starred interest', follow: 'a forum topic followed',
    };
    const YESTERDAY = localDay(new Date(ago(1)));
    const STATES: Array<[string, NotifyPhone, NotifyAskRecord, boolean]> = [
        ['never asked', ASK, {}, true],
        ["Later today on the join's screen (its day still allows one line)", ASK, { ...today('join'), joinAt: NOW - 2 * HOUR, laterAt: NOW - HOUR }, true],
        ['Later today on the once card (the day is taken)', ASK, { ...today('once'), onceAt: NOW - 2 * HOUR, onceClosedAt: NOW - HOUR, laterAt: NOW - HOUR }, false],
        ['Later yesterday', ASK, { askDay: YESTERDAY, askKind: 'join', joinAt: ago(1), laterAt: ago(1) }, true],
        ["an older app's Not now (a Later)", ASK, { state: 'declined', updatedAt: ago(20) }, true],
        ["the phone said no (Android's first, recorded)", ASK, { phoneNoAt: ago(1) }, false],
        ["the phone said no (an iPhone's Don't Allow)", SETTINGS, {}, false],
        ['allowed through one of our asks', ON, { state: 'granted' }, false],
        ['Android 8 to 12 (allowed without asking)', ON, {}, false],
        ['notifications cannot load here', NONE, {}, false],
        ['this kind shown before', ASK, { askDay: localDay(new Date(ago(9))), askKind: 'line', lines: [...NOTIFY_LINE_KINDS] }, false],
        ['another named line shown today', ASK, { ...today('line'), lines: ['some-other-kind'] }, false],
    ];

    it("the kinds are the moments the design names: N2a's five, then N2b's four", () => {
        expect([...NOTIFY_LINE_KINDS]).toEqual(Object.keys(MOMENTS));
    });

    for (const kind of NOTIFY_LINE_KINDS) {
        for (const [state, phone, record, shown] of STATES) {
            it(`${MOMENTS[kind]} × ${state}: ${shown ? 'shown' : 'not shown'}`, () => {
                const got = notifyAsks({ record, phone, now: NOW, line: kind });
                expect(got.line).toBe(shown);
                // A named line is the only ask a moment brings: never the join's screen, the once card or the Home card for it.
                if (shown) {
                    const after = notifyAsks({ record: markNotifyAsk(record, { type: 'shown', surface: 'line', line: kind }, NOW), phone, now: NOW + HOUR, line: kind });
                    expect(after.line).toBe(false);
                }
            });
        }
    }

    const WORDS: Array<[NotifyLineKind, string | null | undefined, string, string]> = [
        ['answer', 'Asha', 'Hear when Asha answers.', "You'll hear when Asha answers."],
        ['again', 'Asha', 'Hear when Asha writes again.', "You'll hear when Asha writes again."],
        ['offer', 'Asha', 'Hear when Asha says yes.', "You'll hear when Asha says yes."],
        ['join', 'Riverside', 'Hear when Riverside answers.', "You'll hear when Riverside answers."],
        ['listing', 'Asha', 'Hear when someone answers.', "You'll hear when someone answers."],
        ['listing', null, 'Hear when someone answers.', "You'll hear when someone answers."],
        ['answer', null, 'Hear when someone answers.', "You'll hear when someone answers."],
        ['again', undefined, 'Hear when someone answers.', "You'll hear when someone answers."],
        ['offer', '   ', 'Hear when someone answers.', "You'll hear when someone answers."],
        ['join', ' Riverside ', 'Hear when Riverside answers.', "You'll hear when Riverside answers."],
    ];
    it.each(WORDS)('%s, named %j: "%s"', (kind, name, line, done) => {
        expect(notifyLineWords(kind, name)).toEqual({ line, done, button: 'Tell me' });
    });

    it('every word comes through t(): nothing outside the pseudo-locale\'s brackets', () => {
        setLanguage(PSEUDO_LANG);
        for (const kind of NOTIFY_LINE_KINDS) {
            for (const name of ['Asha', null]) {
                const w = notifyLineWords(kind, name);
                for (const text of [w.line, w.done, w.button]) expect(text.replace(/\[[^\]]*\]/g, '').replace(/Asha/g, ''), text).not.toMatch(/[A-Za-z]/);
            }
        }
        expect(notifyLineWords('answer', 'Asha').line).toBe(pseudoLocalise('Hear when {name} answers.').replace('{name}', 'Asha'));
    });

    const catalog = (lang: string): Catalog => JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
    const SENTENCES = [
        'Tell me', 'Hear when someone answers.', "You'll hear when someone answers.",
        'Hear when {name} answers.', "You'll hear when {name} answers.", 'Hear when {name} writes again.', "You'll hear when {name} writes again.",
        'Hear when {name} says yes.', "You'll hear when {name} says yes.",
    ];
    it.each(LANGS.filter((l) => l !== 'en'))('%s: a machine draft for every sentence, its name kept', (lang) => {
        const c = catalog(lang) as Record<string, unknown>;
        for (const key of SENTENCES) {
            expect(typeof c[key], `${lang} ${key}`).toBe('string');
            if (key.includes('{name}')) expect(c[key], `${lang} ${key}`).toContain('{name}');
        }
    });
});

// Slice N2b (amend2 §12.3): the named lines at Going, Interested, a starred interest and a followed topic, and the two true
// lines. One table: (moment) × (phone and record) → the line or not; the true lines over the same states, whatever the record.
describe('the named lines at events, interests and the forum, and the two true lines (slice N2b)', () => {
    afterEach(() => setLanguage('en'));
    const MOMENTS: Array<[NotifyLineKind, string]> = [
        ['going', 'Going on an event'], ['interested', 'Interested in an event'], ['star', 'a starred interest'], ['follow', 'a forum topic followed'],
    ];
    const YESTERDAY = localDay(new Date(ago(1)));
    /** [state, the phone, this phone's record, a named line shown?] */
    const STATES: Array<[string, NotifyPhone, NotifyAskRecord, boolean]> = [
        ['never asked', ASK, {}, true],
        ['Later today (on a named line of another kind: the day is taken)', ASK, { ...today('line'), lines: ['answer'], laterAt: NOW - HOUR }, false],
        ["Later today on the join's screen (its day still allows one line)", ASK, { ...today('join'), joinAt: NOW - 2 * HOUR, laterAt: NOW - HOUR }, true],
        ['Later today on the once card (the day is taken)', ASK, { ...today('once'), onceAt: NOW - 2 * HOUR, onceClosedAt: NOW - HOUR, laterAt: NOW - HOUR }, false],
        ['Later yesterday', ASK, { askDay: YESTERDAY, askKind: 'join', joinAt: ago(1), laterAt: ago(1) }, true],
        ["an older app's Not now (a Later)", ASK, { state: 'declined', updatedAt: ago(20) }, true],
        ["the phone said no (Android 13+'s first, recorded)", ASK, { phoneNoAt: ago(1) }, false],
        ["the phone said no (an iPhone's Don't Allow, or Android's second)", SETTINGS, { phoneNoAt: ago(3) }, false],
        ['allowed through one of our asks', ON, { state: 'granted' }, false],
        ['Android 8 to 12 (allowed without asking)', ON, {}, false],
        ['notifications cannot load here', NONE, {}, false],
    ];

    it("the kinds are N2b's four moments, after N2a's five", () => {
        expect(NOTIFY_LINE_KINDS.slice(5)).toEqual(MOMENTS.map(([k]) => k));
    });

    for (const [kind, moment] of MOMENTS) {
        for (const [state, phone, record, shown] of STATES) {
            it(`${moment} × ${state}: ${shown ? 'the line' : 'no line'}`, () => {
                expect(notifyAsks({ record, phone, now: NOW, line: kind }).line).toBe(shown);
                if (!shown) return;
                // Shown: it takes the day and its kind is spent; the other N2b moments wait for another day, and this one never returns.
                const after = markNotifyAsk(record, { type: 'shown', surface: 'line', line: kind }, NOW);
                expect(after.lines).toContain(kind);
                for (const [other] of MOMENTS) expect(notifyAsks({ record: after, phone, now: NOW + HOUR, line: other }).line, other).toBe(false);
                expect(notifyAsks({ record: { ...after, askDay: localDay(new Date(NOW + 2 * DAY)) }, phone, now: NOW + 3 * DAY, line: kind }).line).toBe(false);
            });
        }
    }

    // The true lines are states, not asks: in every row, whatever the record holds (a Later, the phone's no, the day taken).
    for (const [state, phone, record] of STATES) {
        const off = phone.available && !phone.granted;
        it(`the true lines × ${state}: ${off ? 'Reminders need notifications on; no promise' : phone.granted ? 'Remind me; the promise where the community sends it' : 'Remind me; no promise'}`, () => {
            expect(notifyRemindersOff(phone)).toBe(off);
            expect(notifyInterestsPromise(true, phone)).toBe(phone.available && phone.granted);
            // Never where the community sends no such push (global, Beans off, a server from before cold start N3).
            expect(notifyInterestsPromise(false, phone)).toBe(false);
            // Neither takes the day nor needs it: the record is not an input.
            expect(notifyAsks({ record, phone, now: NOW }).bell).toBe(off);
        });
    }

    it('the true lines before the phone has been read: Remind me as it was, and no promise', () => {
        for (const p of [null, undefined]) {
            expect(notifyRemindersOff(p)).toBe(false);
            expect(notifyInterestsPromise(true, p)).toBe(false);
        }
    });

    const WORDS: Array<[NotifyLineKind, string, string]> = [
        ['going', 'Get a reminder the day before, and hear if it changes.', "You'll get a reminder the day before, and hear if it changes."],
        ['interested', 'Get a reminder the day before.', "You'll get a reminder the day before."],
        ['star', 'Hear when a neighbour asks for one of these.', "You'll hear when a neighbour asks for one of these."],
        ['follow', 'Hear when someone replies here.', "You'll hear when someone replies here."],
    ];
    it.each(WORDS)('%s: "%s", then "%s"; a name given changes nothing', (kind, line, done) => {
        expect(notifyLineWords(kind)).toEqual({ line, done, button: 'Tell me' });
        expect(notifyLineWords(kind, 'Asha')).toEqual({ line, done, button: 'Tell me' });
    });

    it("the reminder's true line is a whole sentence through the words layer", () => {
        expect(NOTIFY_TRUE_WORDS.reminders).toBe('⏰ Reminders need notifications on.');
    });

    // The line at an answer to an event names only what will come (the phone reads that by the node's rule:
    // apps/native/utils/event-extras.ts eventNoticesComing). Each row red if its words go or a false part comes back.
    const CHANGE_ONLY = { line: 'Hear if it changes.', done: "You'll hear if it changes.", button: 'Tell me' };
    const EVENT_LINES: Array<[string, { dayBefore: boolean; changes: boolean }, { line: string; done: string; button: string } | null]> = [
        ['the day before still to come, and Going (a change is told)', { dayBefore: true, changes: true }, { ...notifyLineWords('going') }],
        ['the day before still to come, no change told (Interested)', { dayBefore: true, changes: false }, { ...notifyLineWords('interested') }],
        ['no reminder the day before, Going (an event today, a choice of none)', { dayBefore: false, changes: true }, CHANGE_ONLY],
        ['nothing coming (Interested today, the Marketplace switch off)', { dayBefore: false, changes: false }, null],
    ];
    it.each(EVENT_LINES)('an event: %s', (_name, coming, words) => {
        expect(notifyEventLineWords(coming)).toEqual(words);
        const said = notifyEventLineWords(coming);
        // Never the reminder without the day-before reminder coming; never a change without one told.
        if (!coming.dayBefore) expect(`${said?.line} ${said?.done}`).not.toMatch(/reminder/);
        if (!coming.changes) expect(`${said?.line} ${said?.done}`).not.toMatch(/changes/);
    });
    it('the event lines with the reminder are the kinds\' own words, so the catalogs carry each once', () => {
        expect(notifyEventLineWords({ dayBefore: true, changes: true })?.line).toBe(WORDS[0][1]);
        expect(notifyEventLineWords({ dayBefore: true, changes: false })?.done).toBe(WORDS[1][2]);
    });

    const catalog = (lang: string): Catalog => JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
    const SENTENCES = [...WORDS.flatMap(([, line, done]) => [line, done]), CHANGE_ONLY.line, CHANGE_ONLY.done, NOTIFY_TRUE_WORDS.reminders as string];
    it.each(LANGS.filter((l) => l !== 'en'))('%s: a machine draft for every sentence, the clock kept on the reminder line', (lang) => {
        const c = catalog(lang) as Record<string, unknown>;
        for (const key of SENTENCES) expect(typeof c[key], `${lang} ${key}`).toBe('string');
        expect(c[NOTIFY_TRUE_WORDS.reminders], lang).toMatch(/^⏰ /);
    });
});
