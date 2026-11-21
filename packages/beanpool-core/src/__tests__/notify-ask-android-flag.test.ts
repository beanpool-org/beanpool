/**
 * On Android 13 and later the phone's own "one no" flag decides (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend4.md,
 * answering finding A of the max re-check of #3335, scratch/reviews/REVIEW-3335-max-r2.md). Android's "should show a reason"
 * flag, read live by the phone (`saidNoOnce`), is on once the phone has said "Don't allow" one time and its last pop-up is
 * still to come. Our record is not asked about that, so an old 1.4.7 `declined` (which held the phone's "Don't allow" and
 * our "Not now" alike) can no longer swap the last pop-up's two answers.
 *
 * Every row of amend4's tables, each with an empty record, an old `declined` and a `phoneNoAt` (and a yes, where the table
 * names one):
 *
 * - §3.1, between taps: the phone's state and its flag beside the record give whether the phone said no (soft asks stop),
 *   whether the join's screen shows, First steps' line, Home's once card and what a tap on "Turn on" does.
 * - §3.2, at the tap: the flag before the ask and after it (the ask's own "can ask again", which is the flag as it now
 *   stands once Expo has asked) give what the tap records.
 * - §4, N1h's once card for members updating from 1.4.7.
 * - §3.4 and the other phones: where the flag is not read (absent), amend3's rule stands; an iPhone and Android 8 to 12 are
 *   unchanged. notify-ask-android13.test.ts keeps amend3's rows, all without the flag.
 *
 * The review's two probe rows (a 1.4.7 `declined` record, Android's last pop-up: "Don't allow", then closed) are first in
 * §3.2's table; they were red before this change.
 */
import { describe, expect, it } from 'vitest';
import {
    notifyAsks, notifyCanAskAgain, notifyFirstStepsLine, notifyJoinStep, notifyPhoneSaidNo, notifyPopUpAnswer, notifyTurnOn,
    type NotifyAskRecord, type NotifyPhone, type NotifyPopUpRead,
} from '../notify-ask.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

/** The three records every row runs with, and a yes where the table names one. */
const EMPTY: NotifyAskRecord = {};
/** 1.4.7 wrote this for any answer that was not a yes: our "Not now", a closed pop-up, the phone's own "Don't allow". */
const OLD_DECLINED: NotifyAskRecord = { state: 'declined', updatedAt: NOW - 5 * DAY };
const PHONE_NO: NotifyAskRecord = { phoneNoAt: NOW - DAY };
const YES: NotifyAskRecord = { state: 'granted', updatedAt: NOW - 30 * DAY };
const RECORDS: Record<string, NotifyAskRecord> = { 'empty record': EMPTY, "1.4.7's declined": OLD_DECLINED, phoneNoAt: PHONE_NO };

/** Android 13+ as the phone's reader gives it: the mark, Expo's read, and Android's own flag (`saidNoOnce`). */
const android13 = (granted: boolean, canAskAgain: boolean, saidNoOnce: boolean | undefined): NotifyPhone => ({
    available: true, granted, canAskAgain, cantAskNeedsRecord: true, ...(saidNoOnce === undefined ? {} : { saidNoOnce }),
});

type Between = {
    state: string;
    phone: NotifyPhone[];
    record: string | NotifyAskRecord;
    means: string;
    saidNo: boolean;
    tap: 'ask' | 'settings' | 'none';
    pins: string;
};

/**
 * amend4 §3.1. Each phone state lists every read Expo can give with it: with the flag off, Expo reads "can ask again" on a
 * phone it never asked and "can't" once it has (the flag then); the flag decides either way.
 */
const ALLOWED = [android13(true, true, false)];
const FLAG_ON = [android13(false, true, true)];
const FLAG_OFF = [android13(false, true, false), android13(false, false, false)];

const BETWEEN: Between[] = [
    // Row 1: allowed, whatever is on record.
    ...Object.keys(RECORDS).map((record): Between => ({ state: 'allowed', phone: ALLOWED, record, means: 'on', saidNo: false, tap: 'none', pins: 'notifyTurnOn: granted' })),
    // Row 2: not allowed, flag on, whatever is on record: the phone said no once; its last pop-up waits for their own tap.
    ...Object.keys(RECORDS).map((record): Between => ({ state: 'not allowed, flag on', phone: FLAG_ON, record, means: 'said no once', saidNo: true, tap: 'ask', pins: 'notifyPhoneSaidNo: the flag on' })),
    // Row 3: not allowed, flag off, a "Don't allow" or a yes on record: final.
    { state: 'not allowed, flag off', phone: FLAG_OFF, record: 'phoneNoAt', means: "final: said no twice", saidNo: true, tap: 'settings', pins: 'notifyCanAskAgain: flag off beside an answer of the phone' },
    { state: 'not allowed, flag off', phone: FLAG_OFF, record: YES, means: 'final: on, then switched off', saidNo: true, tap: 'settings', pins: "notifyCanAskAgain: flag off beside state 'granted'" },
    // Row 4: not allowed, flag off, neither (an old declined included): no answer on file; the soft asks go on.
    { state: 'not allowed, flag off', phone: FLAG_OFF, record: 'empty record', means: 'no answer on file', saidNo: false, tap: 'ask', pins: 'notifyCanAskAgain: flag off, nothing on record' },
    { state: 'not allowed, flag off', phone: FLAG_OFF, record: "1.4.7's declined", means: "no answer on file (an old declined is a Later)", saidNo: false, tap: 'ask', pins: "phoneAnswerOnRecord: 'declined' is ours" },
];

const recordOf = (r: string | NotifyAskRecord): NotifyAskRecord => (typeof r === 'string' ? RECORDS[r] : r);
const recordName = (r: string | NotifyAskRecord): string => (typeof r === 'string' ? r : 'a yes');
const expoRead = (p: NotifyPhone): string => (p.granted ? 'granted' : p.canAskAgain ? 'denied, can ask again' : "denied, can't ask again");

describe('amend4 §3.1: between taps on Android 13+, the phone and its own flag beside what is on record', () => {
    for (const b of BETWEEN) {
        for (const p of b.phone) {
            it(`${b.state} · Expo reads ${expoRead(p)} · ${recordName(b.record)} → ${b.means} [${b.pins}]`, () => {
                const record = recordOf(b.record);
                expect(notifyPhoneSaidNo(record, p), 'the phone said no').toBe(b.saidNo);
                expect(notifyTurnOn(p, record), 'a tap on Turn on').toBe(b.tap);
                const canAsk = b.tap !== 'none' && !b.saidNo;
                expect(notifyJoinStep('invite', { record, phone: p, now: NOW }), "the join's screen (a second community's included)").toBe(canAsk);
                expect(notifyFirstStepsLine(record, p), "First steps' line").toBe(b.tap === 'none' ? (record.state === 'granted' ? true : null) : b.saidNo ? null : false);
                const asks = notifyAsks({ record, phone: p, now: NOW, line: 'answer', live: true });
                expect([asks.join, asks.once, asks.line], 'the soft asks').toEqual([canAsk, canAsk, canAsk]);
                expect(asks.bell, "the bell's line").toBe(b.tap !== 'none');
            });
        }
    }

    it('row 2 needs no record: a flag on reads the same for every record, a lost write included', () => {
        for (const record of [EMPTY, OLD_DECLINED, PHONE_NO, YES, { laterAt: NOW - DAY }]) {
            const p = android13(false, true, true);
            expect([notifyPhoneSaidNo(record, p), notifyCanAskAgain(record, p), notifyTurnOn(p, record)], JSON.stringify(record)).toEqual([true, true, 'ask']);
        }
    });

    it("a second community's join on a 1.4.7 phone whose phone said no once: no screen (amend4 §4, last line)", () => {
        const record = { ...OLD_DECLINED, joinAt: NOW - 2 * DAY, laterAt: NOW - 2 * DAY };
        expect(notifyJoinStep('invite', { record, phone: android13(false, true, true), now: NOW })).toBe(false);
        expect(notifyJoinStep('invite', { record, phone: android13(false, true, false), now: NOW })).toBe(true);
    });
});

type AtTap = {
    did: string;
    before: boolean;
    reads: NotifyPopUpRead;
    record: string;
    answer: 'granted' | 'phone-no' | 'later' | 'none';
    pins: string;
};

const GRANTED: NotifyPopUpRead = { status: 'granted', canAskAgain: true };
/** The ask's own answer: "can ask again" there is Android's flag as it stands after the ask (Expo has marked it asked). */
const AFTER_ON: NotifyPopUpRead = { status: 'denied', canAskAgain: true };
const AFTER_OFF: NotifyPopUpRead = { status: 'denied', canAskAgain: false };

/** amend4 §3.2, each row with every record. */
const AT_TAP: AtTap[] = [
    // The review's two probe rows first: a 1.4.7 declined, Android's last pop-up.
    { did: "the final Don't allow (review probe 1)", before: true, reads: AFTER_OFF, record: "1.4.7's declined", answer: 'phone-no', pins: 'notifyPopUpAnswer: flag on → off' },
    { did: 'the last pop-up closed with no answer (review probe 2)', before: true, reads: AFTER_ON, record: "1.4.7's declined", answer: 'none', pins: 'notifyPopUpAnswer: flag on → on' },
    ...Object.keys(RECORDS).flatMap((record): AtTap[] => [
        { did: 'Allow, flag off before', before: false, reads: GRANTED, record, answer: 'granted', pins: "notifyPopUpAnswer: status 'granted'" },
        { did: 'Allow, flag on before', before: true, reads: GRANTED, record, answer: 'granted', pins: "notifyPopUpAnswer: status 'granted'" },
        { did: "a first Don't allow", before: false, reads: AFTER_ON, record, answer: 'phone-no', pins: 'notifyPopUpAnswer: flag off → on' },
        { did: "the final Don't allow", before: true, reads: AFTER_OFF, record, answer: 'phone-no', pins: 'notifyPopUpAnswer: flag on → off' },
        { did: 'the last pop-up closed with no answer', before: true, reads: AFTER_ON, record, answer: 'none', pins: 'notifyPopUpAnswer: flag on → on' },
        { did: 'a pop-up closed with no answer (or one that never came: the phone, §3.3)', before: false, reads: AFTER_OFF, record, answer: 'later', pins: 'notifyPopUpAnswer: flag off → off' },
    ]),
];

describe('amend4 §3.2: at the tap on Android 13+, the flag before the ask and after it', () => {
    for (const r of AT_TAP) {
        const after = r.reads.status === 'granted' ? 'allowed' : r.reads.canAskAgain ? 'on' : 'off';
        it(`${r.did} · flag ${r.before ? 'on' : 'off'} → ${after} · ${r.record} → ${r.answer} [${r.pins}]`, () => {
            expect(notifyPopUpAnswer(RECORDS[r.record], android13(false, true, r.before), r.reads)).toBe(r.answer);
        });
    }

    it("the review's probe on a 1.4.7 phone, end to end: the final Don't allow stops the asks; the last pop-up closed keeps the one no", () => {
        const before = android13(false, true, true);
        // Before the tap: the phone said no once, so no soft ask, and the tap brings Android's last pop-up.
        expect([notifyPhoneSaidNo(OLD_DECLINED, before), notifyTurnOn(before, OLD_DECLINED)]).toEqual([true, 'ask']);
        // "Don't allow": recorded as the phone's no; from now the Settings line.
        expect(notifyPopUpAnswer(OLD_DECLINED, before, AFTER_OFF)).toBe('phone-no');
        const after = { ...OLD_DECLINED, phoneNoAt: NOW };
        const off = android13(false, false, false);
        expect([notifyPhoneSaidNo(after, off), notifyTurnOn(off, after), notifyAsks({ record: after, phone: off, now: NOW + DAY }).once]).toEqual([true, 'settings', false]);
        // Closed instead: nothing new; the phone's one no stands, and the tap still brings the last pop-up.
        expect(notifyPopUpAnswer(OLD_DECLINED, before, AFTER_ON)).toBe('none');
        expect([notifyPhoneSaidNo(OLD_DECLINED, before), notifyTurnOn(before, OLD_DECLINED)]).toEqual([true, 'ask']);
    });
});

type Once = {
    did: string;
    record: NotifyAskRecord;
    phone: NotifyPhone;
    card: boolean;
    tap: 'ask' | 'settings' | 'none';
};

/** amend4 §4: N1h's once card on Home for members updating from 1.4.7 on Android 13+ (no join's screen on this phone). */
const ONCE: Once[] = [
    { did: "tapped our Not now; the phone was never asked", record: OLD_DECLINED, phone: android13(false, true, false), card: true, tap: 'ask' },
    { did: 'passed the card without answering', record: { state: 'unanswered', updatedAt: NOW - 5 * DAY }, phone: android13(false, true, false), card: true, tap: 'ask' },
    { did: "Turn on, then closed the phone's pop-up", record: OLD_DECLINED, phone: android13(false, false, false), card: true, tap: 'ask' },
    { did: "Turn on, then the phone's Don't allow", record: OLD_DECLINED, phone: android13(false, true, true), card: false, tap: 'ask' },
    { did: "Don't allow twice (the app can't tell them from row 1 until they tap)", record: OLD_DECLINED, phone: android13(false, false, false), card: true, tap: 'ask' },
    { did: 'allowed', record: YES, phone: android13(true, true, false), card: false, tap: 'none' },
];

describe('amend4 §4: Home\'s once card for members updating from 1.4.7 on Android 13+', () => {
    for (const o of ONCE) {
        it(`${o.did} → ${o.card ? 'the card, once' : 'no card'}; Turn on: ${o.tap}`, () => {
            expect(notifyAsks({ record: o.record, phone: o.phone, now: NOW }).once).toBe(o.card);
            expect(notifyTurnOn(o.phone, o.record)).toBe(o.tap);
        });
    }
});

describe('amend4 §3.4 and the other phones: where the flag is not read, nothing changes', () => {
    const records = [EMPTY, OLD_DECLINED, PHONE_NO, YES, { laterAt: NOW - DAY }];
    const reads: Array<[boolean, boolean]> = [[true, true], [false, true], [false, false]];
    const popUps = [GRANTED, AFTER_ON, AFTER_OFF, { status: 'undetermined', canAskAgain: true }];

    it('an iPhone, Android 8 to 12 or a browser (no mark): a flag given anyway changes no answer', () => {
        for (const record of records) {
            for (const [granted, canAskAgain] of reads) {
                const plain: NotifyPhone = { available: true, granted, canAskAgain };
                for (const saidNoOnce of [true, false]) {
                    const flagged: NotifyPhone = { ...plain, saidNoOnce };
                    const tag = JSON.stringify({ record, granted, canAskAgain, saidNoOnce });
                    expect(notifyPhoneSaidNo(record, flagged), tag).toBe(notifyPhoneSaidNo(record, plain));
                    expect(notifyTurnOn(flagged, record), tag).toBe(notifyTurnOn(plain, record));
                    for (const read of popUps) expect(notifyPopUpAnswer(record, flagged, read), tag).toBe(notifyPopUpAnswer(record, plain, read));
                }
            }
        }
    });

    it('Android 13+ with the flag not read (no screen in front, a failed call): amend3, as before', () => {
        // amend3's answers, restated: the flag absent reads exactly as the mark alone did.
        expect(notifyCanAskAgain(EMPTY, android13(false, false, undefined))).toBe(true);
        expect(notifyCanAskAgain(PHONE_NO, android13(false, false, undefined))).toBe(false);
        expect(notifyPhoneSaidNo(OLD_DECLINED, android13(false, true, undefined))).toBe(false);
        expect(notifyPopUpAnswer(OLD_DECLINED, android13(false, true, undefined), AFTER_OFF)).toBe('later');
        expect(notifyPopUpAnswer(OLD_DECLINED, android13(false, true, undefined), AFTER_ON)).toBe('phone-no');
        expect(notifyPopUpAnswer(PHONE_NO, android13(false, true, undefined), AFTER_ON)).toBe('none');
        expect(notifyPopUpAnswer(PHONE_NO, android13(false, true, undefined), AFTER_OFF)).toBe('phone-no');
    });

    it('the flag changes only what amend4 changes: with it, no answer reads the record for "said no once"', () => {
        for (const record of records) {
            // Flag on: every record reads "said no once, the last pop-up to come".
            expect(notifyCanAskAgain(record, android13(false, false, true)), JSON.stringify(record)).toBe(true);
            // Flag off: final only beside an answer of the phone's on record.
            const answered = typeof record.phoneNoAt === 'number' || record.state === 'granted';
            for (const canAskAgain of [true, false]) expect(notifyCanAskAgain(record, android13(false, canAskAgain, false)), JSON.stringify(record)).toBe(!answered);
        }
    });
});
