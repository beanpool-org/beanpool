/**
 * On Android 13 and later a closed pop-up is not a no (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend3.md,
 * answering finding 1 of the max review of #3335). Every row of amend3's two tables, for Android 13+, Android 8 to 12 and
 * an iPhone:
 *
 * - §3.2, between taps: what the phone reads and what this phone has on record give whether the phone said no (soft asks
 *   stop), whether the join's screen shows, First steps' line, and what a tap on "Turn on" does.
 * - §3.1, at the tap: what the pop-up read back and what was on record before it give what the tap records.
 *
 * Android 13+'s reads are the ones Expo really gives (expo-modules-core PermissionsService.kt:216-240, 256-257;
 * expo-notifications NotificationPermissionsModule.kt:69-74): never asked, "denied, can ask again"; a first "Don't
 * allow", "denied, can ask again"; a pop-up closed with no answer, the app closed with it up, or a phone restored from a
 * backup, "denied, can't ask again"; a second "Don't allow", the same. Each row names the line it pins (`pins`): take that
 * line away and the row goes red.
 */
import { describe, expect, it } from 'vitest';
import {
    notifyAsks, notifyCanAskAgain, notifyFirstStepsLine, notifyJoinStep, notifyPhoneSaidNo, notifyPopUpAnswer, notifyTurnOn,
    type NotifyAskRecord, type NotifyPhone, type NotifyPopUpRead,
} from '../notify-ask.js';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

type Phone = 'Android 13+' | 'Android 8-12' | 'iPhone';
/** The phone's reader (apps/native/utils/notification-permission.ts readOsNotificationPermission) sets the mark on Android 13+ only. */
const MARK: Record<Phone, Pick<NotifyPhone, 'cantAskNeedsRecord'>> = {
    'Android 13+': { cantAskNeedsRecord: true },
    'Android 8-12': {},
    iPhone: {},
};
const read = (phone: Phone, granted: boolean, canAskAgain: boolean): NotifyPhone => ({ available: true, granted, canAskAgain, ...MARK[phone] });

const NO_ONCE: NotifyAskRecord = { phoneNoAt: NOW - DAY };
const YES_ONCE: NotifyAskRecord = { state: 'granted', updatedAt: NOW - 30 * DAY };
const LATER: NotifyAskRecord = { laterAt: NOW - 2 * DAY };
/** An older app's "Not now": a "Later" (N1), never the phone's no. */
const NOT_NOW: NotifyAskRecord = { state: 'declined', updatedAt: NOW - 5 * DAY };

type Between = {
    phone: Phone;
    reads: 'granted' | 'denied, can ask again' | "denied, can't ask again";
    record: NotifyAskRecord;
    onRecord: string;
    means: string;
    saidNo: boolean;
    join: boolean;
    firstSteps: boolean | null;
    tap: 'ask' | 'settings' | 'none';
    pins: string;
};

const BETWEEN: Between[] = [
    // Android 13+: amend3 §3.2, row by row.
    { phone: 'Android 13+', reads: 'granted', record: {}, onRecord: 'anything', means: 'on', saidNo: false, join: false, firstSteps: null, tap: 'none', pins: 'notifyTurnOn: granted' },
    { phone: 'Android 13+', reads: 'granted', record: YES_ONCE, onRecord: 'a yes', means: 'on, through our ask', saidNo: false, join: false, firstSteps: true, tap: 'none', pins: 'notifyFirstStepsLine: state granted' },
    { phone: 'Android 13+', reads: 'denied, can ask again', record: {}, onRecord: "no Don't allow", means: 'never answered', saidNo: false, join: true, firstSteps: false, tap: 'ask', pins: 'notifyCanAskAgain: p.canAskAgain' },
    { phone: 'Android 13+', reads: 'denied, can ask again', record: NO_ONCE, onRecord: "a Don't allow", means: 'said no once', saidNo: true, join: false, firstSteps: null, tap: 'ask', pins: 'notifyPhoneSaidNo: phoneNoAt' },
    { phone: 'Android 13+', reads: "denied, can't ask again", record: NO_ONCE, onRecord: "a Don't allow", means: 'said no twice: final', saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'phoneAnswerOnRecord: phoneNoAt' },
    { phone: 'Android 13+', reads: "denied, can't ask again", record: YES_ONCE, onRecord: 'a yes', means: "was on, switched off in the phone's settings", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: "phoneAnswerOnRecord: state 'granted'" },
    { phone: 'Android 13+', reads: "denied, can't ask again", record: {}, onRecord: 'neither', means: 'no answer on file: a closed pop-up, the app closed with it up, a restored phone', saidNo: false, join: true, firstSteps: false, tap: 'ask', pins: 'notifyCanAskAgain: cantAskNeedsRecord' },
    { phone: 'Android 13+', reads: "denied, can't ask again", record: LATER, onRecord: 'a Later (a closed pop-up, kept as one)', means: 'no answer on file', saidNo: false, join: true, firstSteps: false, tap: 'ask', pins: 'notifyCanAskAgain: a Later is not an answer of the phone' },
    { phone: 'Android 13+', reads: "denied, can't ask again", record: NOT_NOW, onRecord: "an older app's Not now", means: 'no answer on file', saidNo: false, join: true, firstSteps: false, tap: 'ask', pins: "phoneAnswerOnRecord: 'declined' is ours, not the phone's" },
    // Android 8 to 12: no pop-up at all; off can only come from the phone's settings, and the read alone says so (unchanged).
    { phone: 'Android 8-12', reads: 'granted', record: {}, onRecord: 'anything', means: 'on from the start', saidNo: false, join: false, firstSteps: null, tap: 'none', pins: 'notifyTurnOn: granted' },
    { phone: 'Android 8-12', reads: "denied, can't ask again", record: {}, onRecord: 'neither', means: "switched off in the phone's settings", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyCanAskAgain: no mark, the flag alone' },
    { phone: 'Android 8-12', reads: "denied, can't ask again", record: LATER, onRecord: 'a Later', means: "switched off in the phone's settings", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyCanAskAgain: no mark, the flag alone' },
    // iPhone: the read is the system's own; "denied" is always a real Don't Allow or a switch-off (unchanged).
    { phone: 'iPhone', reads: 'granted', record: {}, onRecord: 'anything', means: 'on', saidNo: false, join: false, firstSteps: null, tap: 'none', pins: 'notifyTurnOn: granted' },
    { phone: 'iPhone', reads: 'denied, can ask again', record: {}, onRecord: 'neither', means: 'never asked', saidNo: false, join: true, firstSteps: false, tap: 'ask', pins: 'notifyCanAskAgain: p.canAskAgain' },
    { phone: 'iPhone', reads: "denied, can't ask again", record: {}, onRecord: 'neither (never recorded here)', means: "Don't Allow", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyCanAskAgain: no mark, the flag alone' },
    { phone: 'iPhone', reads: "denied, can't ask again", record: NO_ONCE, onRecord: "a Don't Allow", means: "Don't Allow", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyPhoneSaidNo: phoneNoAt' },
    { phone: 'iPhone', reads: "denied, can't ask again", record: YES_ONCE, onRecord: 'a yes', means: "switched off in the iPhone's settings", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyCanAskAgain: no mark, the flag alone' },
    { phone: 'iPhone', reads: "denied, can't ask again", record: LATER, onRecord: 'a Later', means: "Don't Allow, never recorded here", saidNo: true, join: false, firstSteps: null, tap: 'settings', pins: 'notifyCanAskAgain: no mark, the flag alone' },
];

const phoneRead = (b: Between): NotifyPhone => read(b.phone, b.reads === 'granted', b.reads !== "denied, can't ask again");

describe('amend3 §3.2: between taps, what the phone reads beside what is on record', () => {
    for (const b of BETWEEN) {
        it(`${b.phone} · reads ${b.reads} · ${b.onRecord} → ${b.means} [${b.pins}]`, () => {
            const p = phoneRead(b);
            expect(notifyPhoneSaidNo(b.record, p), 'the phone said no').toBe(b.saidNo);
            expect(notifyTurnOn(p, b.record), 'a tap on Turn on').toBe(b.tap);
            expect(notifyJoinStep('invite', { record: b.record, phone: p, now: NOW }), "the join's screen").toBe(b.join);
            expect(notifyFirstStepsLine(b.record, p), "First steps' line").toBe(b.firstSteps);
            // The other soft asks follow the same "said no": none after it; with no answer on file, a named line may show.
            const asks = notifyAsks({ record: b.record, phone: p, now: NOW, line: 'answer', live: true });
            if (b.saidNo || b.tap === 'none') expect([asks.join, asks.once, asks.line, asks.home], 'soft asks').toEqual([false, false, false, false]);
            else expect(asks.line, 'a named line').toBe(true);
            expect(asks.bell, "the bell's line").toBe(b.tap !== 'none');
        });
    }

    it('the mark changes only the last row: "can\'t ask again" with no answer of the phone\'s on record', () => {
        const records: NotifyAskRecord[] = [{}, LATER, NOT_NOW, NO_ONCE, YES_ONCE];
        for (const record of records) {
            for (const canAskAgain of [true, false]) {
                const plain = read('iPhone', false, canAskAgain);
                const marked = read('Android 13+', false, canAskAgain);
                const differs = notifyCanAskAgain(record, plain) !== notifyCanAskAgain(record, marked);
                const lastRow = !canAskAgain && typeof record.phoneNoAt !== 'number' && record.state !== 'granted';
                expect(differs, JSON.stringify({ record, canAskAgain })).toBe(lastRow);
            }
        }
    });
});

type AtTap = {
    phone: Phone;
    did: string;
    reads: NotifyPopUpRead;
    before: NotifyAskRecord;
    onRecord: string;
    answer: 'granted' | 'phone-no' | 'later' | 'none';
    pins: string;
};

const ALLOWED: NotifyPopUpRead = { status: 'granted', canAskAgain: true };
const DENIED_CAN: NotifyPopUpRead = { status: 'denied', canAskAgain: true };
const DENIED_CANT: NotifyPopUpRead = { status: 'denied', canAskAgain: false };
const NOT_ANSWERED: NotifyPopUpRead = { status: 'undetermined', canAskAgain: true };

const AT_TAP: AtTap[] = [
    // Android 13+: amend3 §3.1, row by row.
    { phone: 'Android 13+', did: 'Allow', reads: ALLOWED, before: {}, onRecord: 'anything', answer: 'granted', pins: "notifyPopUpAnswer: status 'granted'" },
    { phone: 'Android 13+', did: "first Don't allow", reads: DENIED_CAN, before: {}, onRecord: "no Don't allow", answer: 'phone-no', pins: 'notifyPopUpAnswer: can ask again, no phoneNoAt' },
    { phone: 'Android 13+', did: 'closed with no answer (swipe, back, tap outside)', reads: DENIED_CANT, before: {}, onRecord: "no Don't allow, no yes", answer: 'later', pins: "notifyPopUpAnswer: can't ask again, nothing on record" },
    { phone: 'Android 13+', did: 'closed with no answer, after a Later', reads: DENIED_CANT, before: LATER, onRecord: 'a Later', answer: 'later', pins: "notifyPopUpAnswer: can't ask again, nothing on record" },
    { phone: 'Android 13+', did: "closed with no answer, after an older app's Not now", reads: DENIED_CANT, before: NOT_NOW, onRecord: 'a Not now', answer: 'later', pins: "phoneAnswerOnRecord: 'declined' is ours" },
    { phone: 'Android 13+', did: 'the second pop-up closed with no answer', reads: DENIED_CAN, before: NO_ONCE, onRecord: "a Don't allow", answer: 'none', pins: "notifyPopUpAnswer: can ask again with phoneNoAt: 'none'" },
    { phone: 'Android 13+', did: "second Don't allow", reads: DENIED_CANT, before: NO_ONCE, onRecord: "a Don't allow", answer: 'phone-no', pins: 'notifyPopUpAnswer: phoneAnswerOnRecord' },
    { phone: 'Android 13+', did: "Don't allow, once allowed before", reads: DENIED_CANT, before: YES_ONCE, onRecord: 'a yes', answer: 'phone-no', pins: 'notifyPopUpAnswer: phoneAnswerOnRecord' },
    // Android 8 to 12: no pop-up; the read is the phone's settings (unchanged: "denied" is the phone's no).
    { phone: 'Android 8-12', did: 'on from the start', reads: ALLOWED, before: {}, onRecord: 'anything', answer: 'granted', pins: "notifyPopUpAnswer: status 'granted'" },
    { phone: 'Android 8-12', did: "off in the phone's settings", reads: DENIED_CANT, before: {}, onRecord: 'neither', answer: 'phone-no', pins: 'notifyPopUpAnswer: no mark, denied is a no' },
    // iPhone: its alert can't be closed without an answer (unchanged).
    { phone: 'iPhone', did: 'Allow', reads: ALLOWED, before: {}, onRecord: 'anything', answer: 'granted', pins: "notifyPopUpAnswer: status 'granted'" },
    { phone: 'iPhone', did: "Don't Allow", reads: DENIED_CANT, before: {}, onRecord: 'neither', answer: 'phone-no', pins: 'notifyPopUpAnswer: no mark, denied is a no' },
    { phone: 'iPhone', did: "Don't Allow, after a Later", reads: DENIED_CANT, before: LATER, onRecord: 'a Later', answer: 'phone-no', pins: 'notifyPopUpAnswer: no mark, denied is a no' },
    { phone: 'iPhone', did: 'the app closed with the alert up (nothing recorded by the system)', reads: NOT_ANSWERED, before: {}, onRecord: 'neither', answer: 'later', pins: "notifyPopUpAnswer: not 'denied' is no answer" },
];

describe('amend3 §3.1: at the tap, what the pop-up read back beside what was on record before it', () => {
    for (const r of AT_TAP) {
        it(`${r.phone} · ${r.did} · reads ${r.reads.status}${r.reads.status === 'denied' ? (r.reads.canAskAgain ? ', can ask again' : ", can't ask again") : ''} · ${r.onRecord} → ${r.answer} [${r.pins}]`, () => {
            expect(notifyPopUpAnswer(r.before, MARK[r.phone], r.reads)).toBe(r.answer);
        });
    }

    it('a closed pop-up on Android 13+ leaves every soft ask going: the Later it records is never the phone\'s no', () => {
        // The swipe, as Android reads it the next day: "denied, can't ask again", with the Later the tap kept.
        const after = { laterAt: NOW - DAY };
        const p = read('Android 13+', false, false);
        expect(notifyPopUpAnswer({}, p, DENIED_CANT)).toBe('later');
        expect(notifyPhoneSaidNo(after, p)).toBe(false);
        expect(notifyJoinStep('invite', { record: after, phone: p, now: NOW })).toBe(true);
        expect(notifyTurnOn(p, after)).toBe('ask');
        expect(notifyFirstStepsLine(after, p)).toBe(false);
    });

    it("two Don't allows on Android 13+: the first stops the soft asks and keeps the pop-up for a tap; the second is final", () => {
        const first = notifyPopUpAnswer({}, MARK['Android 13+'], DENIED_CAN);
        expect(first).toBe('phone-no');
        const once = { phoneNoAt: NOW - DAY };
        expect(notifyPhoneSaidNo(once, read('Android 13+', false, true))).toBe(true);
        expect(notifyTurnOn(read('Android 13+', false, true), once)).toBe('ask');
        expect(notifyPopUpAnswer(once, MARK['Android 13+'], DENIED_CANT)).toBe('phone-no');
        expect(notifyTurnOn(read('Android 13+', false, false), once)).toBe('settings');
    });
});
