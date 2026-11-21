/**
 * Home's once card (src/notify-ask.ts `once`; DESIGN-notify-and-backup-asks-fable-amend2.md §7, slice N1h; amend4 §4 for
 * Android 13+): the join's ask, once, as a card on Home, for a member who never met the join's screen on this phone (after
 * the update from 1.4.7, after a restore on a new phone).
 *
 * The table: platform × the record the update finds × days since the update. Each (platform, record) row says, in its own
 * words, whether the card is due and which guard of the rule decides it (`pins`); the days are walked through the record as
 * the phone keeps it (markNotifyAsk): the first landing after the update shows the card and marks it shown, and on day 3 it
 * is still up, on day 8 it has folded into First steps' line. A row goes red when its guard goes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    markNotifyAsk, notifyAsks, notifyOnceWords, NOTIFY_ONCE_CARD_DAYS,
    type NotifyAskRecord, type NotifyPhone,
} from '../notify-ask.js';
import { localDay } from '../home-tips.js';
import { LANGS, PSEUDO_LANG, pseudoLocalise, setLanguage, type Catalog } from '../words.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Local noon on the day of the update, so every day below is the same day in every time zone. */
const UPDATE = new Date(2026, 11, 1, 12, 0).getTime();

// What each phone reads, as utils/notification-permission.ts readOsNotificationPermission gives it.
/** An iPhone not asked yet (or after our own "Not now": the system was never asked). */
const IPHONE_ASK: NotifyPhone = { available: true, granted: false, canAskAgain: true };
/** An iPhone after its own Don't Allow, or switched off in its settings: the pop-up never comes again. */
const IPHONE_NO: NotifyPhone = { available: true, granted: false, canAskAgain: false };
const IPHONE_ON: NotifyPhone = { available: true, granted: true, canAskAgain: true };
/** Android 13+ with Android's own "one no" flag read (amend4): `fresh` = Expo has never asked on this phone. */
const a13 = (o: { flag: boolean; fresh: boolean }): NotifyPhone => ({
    available: true, granted: false, canAskAgain: o.flag || o.fresh, cantAskNeedsRecord: true, saidNoOnce: o.flag,
});
const A13_ON: NotifyPhone = { available: true, granted: true, canAskAgain: true, cantAskNeedsRecord: true, saidNoOnce: false };
/** Android 8 to 12: on from the start; or switched off in its settings (no pop-up exists there). */
const A8_ON: NotifyPhone = { available: true, granted: true, canAskAgain: true };
const A8_OFF: NotifyPhone = { available: true, granted: false, canAskAgain: false };

// What the update finds on the phone's record (the key it always had, utils/storage-keys.ts).
const NONE: NotifyAskRecord = {};
/** 1.4.7 wrote 'declined' for our "Not now" and for the phone's own no alike (amend4 §2). */
const DECLINED: NotifyAskRecord = { state: 'declined', updatedAt: UPDATE - 20 * DAY };
const UNANSWERED: NotifyAskRecord = { state: 'unanswered', updatedAt: UPDATE - 20 * DAY };
/** A "Later" said before, with no join's screen and no once card on this phone (a pop-up closed at First steps' line). */
const LATER: NotifyAskRecord = { state: 'unanswered', updatedAt: UPDATE - 20 * DAY, laterAt: UPDATE - 2 * DAY };
const PHONE_NO: NotifyAskRecord = { state: 'unanswered', updatedAt: UPDATE - 20 * DAY, phoneNoAt: UPDATE - 2 * DAY };
const GRANTED: NotifyAskRecord = { state: 'granted', updatedAt: UPDATE - 20 * DAY };

type Row = { platform: string; phone: NotifyPhone; record: string; at: NotifyAskRecord; card: boolean; pins: string };

const ROWS: Row[] = [
    // iPhone: the read is the system's own; nothing on the record ever overrides it.
    { platform: 'iPhone', phone: IPHONE_ASK, record: 'none (a restore on a new phone)', at: NONE, card: true, pins: 'the card, never shown here' },
    { platform: 'iPhone', phone: IPHONE_ASK, record: "1.4.7 declined (our Not now)", at: DECLINED, card: true, pins: 'an old Not now is not a no' },
    { platform: 'iPhone', phone: IPHONE_NO, record: "1.4.7 declined (then the phone's Don't Allow)", at: DECLINED, card: false, pins: "canAskAgain: the phone's no" },
    { platform: 'iPhone', phone: IPHONE_ASK, record: 'unanswered', at: UNANSWERED, card: true, pins: 'the card, never shown here' },
    { platform: 'iPhone', phone: IPHONE_ASK, record: 'laterAt', at: LATER, card: true, pins: 'a Later is never final' },
    { platform: 'iPhone', phone: IPHONE_NO, record: 'phoneNoAt', at: PHONE_NO, card: false, pins: "phoneNoAt: the phone's no" },
    { platform: 'iPhone', phone: IPHONE_ON, record: 'granted', at: GRANTED, card: false, pins: 'granted: nothing to ask' },
    { platform: 'iPhone', phone: IPHONE_NO, record: "granted (switched off in its settings)", at: GRANTED, card: false, pins: 'canAskAgain over the record' },

    // Android 13+, its own flag ON: the phone said "Don't allow" once, whatever the record holds (amend4 §4 row 4).
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: 'none (a restore on a new phone)', at: NONE, card: false, pins: 'the flag: said no once' },
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: "1.4.7 declined (the phone's Don't allow)", at: DECLINED, card: false, pins: 'the flag: said no once' },
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: 'unanswered', at: UNANSWERED, card: false, pins: 'the flag: said no once' },
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: 'laterAt', at: LATER, card: false, pins: 'the flag: said no once' },
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: 'phoneNoAt', at: PHONE_NO, card: false, pins: 'phoneNoAt' },
    { platform: 'Android 13+ flag on', phone: a13({ flag: true, fresh: false }), record: 'granted (switched off, then one no)', at: GRANTED, card: false, pins: 'the flag: said no once' },

    // Android 13+, its own flag OFF (amend4 §4 rows 1, 2, 3, 5; amend3 §3.2 last row).
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: true }), record: 'none (never asked)', at: NONE, card: true, pins: 'the card, never shown here' },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: false }), record: 'none (a restore; Expo\'s "asked" came along)', at: NONE, card: true, pins: "can't ask with no answer on file: it can" },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: true }), record: '1.4.7 declined (our Not now; never asked)', at: DECLINED, card: true, pins: 'an old Not now is not a no' },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: false }), record: '1.4.7 declined (Turn on, then the pop-up closed)', at: DECLINED, card: true, pins: "can't ask with no answer on file: it can" },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: true }), record: 'unanswered', at: UNANSWERED, card: true, pins: 'the card, never shown here' },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: false }), record: 'laterAt', at: LATER, card: true, pins: 'a Later is never final' },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: false }), record: 'phoneNoAt (said no twice)', at: PHONE_NO, card: false, pins: "phoneNoAt beside can't ask: final" },
    { platform: 'Android 13+ flag off', phone: A13_ON, record: 'granted', at: GRANTED, card: false, pins: 'granted: nothing to ask' },
    { platform: 'Android 13+ flag off', phone: a13({ flag: false, fresh: false }), record: 'granted (switched off in its settings)', at: GRANTED, card: false, pins: 'a yes on record beside can\'t ask: final' },

    // Android 8 to 12: on from the start, never asked; off only in the phone's settings.
    { platform: 'Android 8-12', phone: A8_ON, record: 'none', at: NONE, card: false, pins: 'granted: nothing to ask' },
    { platform: 'Android 8-12', phone: A8_ON, record: '1.4.7 declined', at: DECLINED, card: false, pins: 'granted: nothing to ask' },
    { platform: 'Android 8-12', phone: A8_ON, record: 'unanswered', at: UNANSWERED, card: false, pins: 'granted: nothing to ask' },
    { platform: 'Android 8-12', phone: A8_ON, record: 'laterAt', at: LATER, card: false, pins: 'granted: nothing to ask' },
    { platform: 'Android 8-12', phone: A8_OFF, record: 'phoneNoAt', at: PHONE_NO, card: false, pins: 'switched off: the settings line, never a card' },
    { platform: 'Android 8-12', phone: A8_OFF, record: 'granted (switched off in its settings)', at: GRANTED, card: false, pins: 'switched off: the settings line, never a card' },
];

/** The first landing after the update shows the card (if due) and marks it shown, as Home does (offerOnceCard). */
function afterFirstLanding(r: Row): NotifyAskRecord {
    const due = notifyAsks({ record: r.at, phone: r.phone, now: UPDATE }).once;
    return due ? markNotifyAsk(r.at, { type: 'shown', surface: 'once' }, UPDATE) : r.at;
}

describe('the once card: platform × the record the update finds × days since the update', () => {
    for (const r of ROWS) {
        for (const days of [0, 3, 8]) {
            const shows = r.card && days < NOTIFY_ONCE_CARD_DAYS;
            it(`${r.platform}, ${r.record}, day ${days} → ${shows ? 'the card' : r.card ? 'folded into First steps' : 'no card'} (${r.pins})`, () => {
                const now = UPDATE + days * DAY + HOUR;
                // Day 0 is the first landing itself; days 3 and 8 come after it was shown (and marked) on day 0.
                const record = days === 0 ? r.at : afterFirstLanding(r);
                // Something of theirs is live, so the Home card would be due too: never on one landing with the once card.
                const got = notifyAsks({ record, phone: r.phone, now, live: true });
                expect(got.once).toBe(shows);
                // Never with the Home card; First steps' line waits while it is up, and is back (unticked) once it folds.
                if (got.once) expect(got).toMatchObject({ home: false, firstSteps: null });
                if (r.card && days === 8) expect(got.firstSteps).toBe(false);
            });
        }
    }

    it('a first landing 8 days after the update still shows it: its 7 days start at its first showing, not at the update', () => {
        const phone = IPHONE_ASK;
        const late = UPDATE + 8 * DAY;
        expect(notifyAsks({ record: DECLINED, phone, now: late }).once).toBe(true);
        const shown = markNotifyAsk(DECLINED, { type: 'shown', surface: 'once' }, late);
        expect(notifyAsks({ record: shown, phone, now: late + 6 * DAY }).once).toBe(true);
        expect(notifyAsks({ record: shown, phone, now: late + 7 * DAY + HOUR }).once).toBe(false);
    });
});

describe('the once card: one showing per phone, Later not final, one soft ask a day', () => {
    const phone = IPHONE_ASK;
    const shown = markNotifyAsk(DECLINED, { type: 'shown', surface: 'once' }, UPDATE);

    it('Later puts it away for good, and is not a no: First steps\' line is back and a named line comes the next day', () => {
        const later = markNotifyAsk(shown, { type: 'later', surface: 'once' }, UPDATE + HOUR);
        expect(notifyAsks({ record: later, phone, now: UPDATE + 2 * HOUR })).toMatchObject({ once: false, firstSteps: false, line: false, bell: true });
        expect(notifyAsks({ record: later, phone, now: UPDATE + DAY, line: 'answer' })).toMatchObject({ once: false, line: true });
        for (const d of [1, 3, 8, 40]) expect(notifyAsks({ record: later, phone, now: UPDATE + d * DAY }).once, `day ${d}`).toBe(false);
    });

    it("the phone's yes or no takes it away by the phone's own answer", () => {
        const yes = markNotifyAsk(shown, { type: 'granted' }, UPDATE + HOUR);
        expect(notifyAsks({ record: yes, phone: IPHONE_ON, now: UPDATE + 2 * HOUR }).once).toBe(false);
        const no = markNotifyAsk(shown, { type: 'phone-no' }, UPDATE + HOUR);
        expect(notifyAsks({ record: no, phone: IPHONE_NO, now: UPDATE + 2 * HOUR }).once).toBe(false);
        // Android 13+'s first "Don't allow": the flag goes on, and the card goes with it.
        expect(notifyAsks({ record: no, phone: a13({ flag: true, fresh: false }), now: UPDATE + 2 * HOUR }).once).toBe(false);
    });

    it('it takes its day: a named line waits for the next day, and a later landing the same day still shows the card', () => {
        expect(notifyAsks({ record: shown, phone, now: UPDATE + HOUR, line: 'answer' })).toMatchObject({ once: true, line: false });
        expect(notifyAsks({ record: shown, phone, now: UPDATE + DAY, line: 'answer' })).toMatchObject({ once: true, line: true });
    });

    it('not first shown on a day another soft ask took, nor on a day a Later was said; the next day it is', () => {
        const lineToday: NotifyAskRecord = { ...DECLINED, askDay: localDay(new Date(UPDATE)), askKind: 'line', lines: ['answer'] };
        expect(notifyAsks({ record: lineToday, phone, now: UPDATE + HOUR }).once).toBe(false);
        expect(notifyAsks({ record: lineToday, phone, now: UPDATE + DAY }).once).toBe(true);
        // A pop-up closed at First steps' line an hour ago: that is the day's answer; the card comes tomorrow.
        const closedToday: NotifyAskRecord = { ...UNANSWERED, laterAt: UPDATE };
        expect(notifyAsks({ record: closedToday, phone, now: UPDATE + HOUR }).once).toBe(false);
        expect(notifyAsks({ record: closedToday, phone, now: UPDATE + DAY }).once).toBe(true);
        // A 1.4.7 Not now said the day of the update reads as that day's Later, the same.
        const notNowToday: NotifyAskRecord = { state: 'declined', updatedAt: UPDATE };
        expect(notifyAsks({ record: notNowToday, phone, now: UPDATE + HOUR }).once).toBe(false);
        expect(notifyAsks({ record: notNowToday, phone, now: UPDATE + DAY }).once).toBe(true);
    });

    it("never where the join's screen was shown on this phone: that was its ask", () => {
        const joined: NotifyAskRecord = { joinAt: UPDATE - 3 * DAY, laterAt: UPDATE - 3 * DAY };
        for (const d of [0, 3, 8]) expect(notifyAsks({ record: joined, phone, now: UPDATE + d * DAY }).once, `day ${d}`).toBe(false);
    });
});

describe("the once card's words: the join's, with a neighbour for the name", () => {
    it('a community: "Hear from Riverside", the reason, what arrives with "a neighbour", Never ads, the two buttons, the band', () => {
        setLanguage('en');
        expect(notifyOnceWords({ global: false, community: 'Riverside' })).toEqual({
            title: 'Hear from Riverside',
            never: 'BeanPool never emails or texts you.',
            only: 'Notifications are the only way it can reach you.',
            arrives: "When a neighbour writes, someone answers you, or an event you're going to changes.",
            ads: 'Never ads.',
            turnOn: 'Turn on notifications',
            confirm: 'Your phone will ask you to confirm.',
            later: 'Later',
            band: 'Notifications',
        });
        expect(notifyOnceWords({ global: false, community: '  ' }).title).toBe('Hear from your community');
    });

    it("the global community: the global join's line, and no community's name", () => {
        setLanguage('en');
        const w = notifyOnceWords({ global: true, community: 'Anything' });
        expect(w.title).toBe('Hear from your community');
        expect(w.arrives).toBe('When someone writes to you, or a community answers your request to join.');
    });

    const catalog = (lang: string): Catalog => JSON.parse(readFileSync(new URL(`../../words/${lang}.json`, import.meta.url), 'utf8')) as Catalog;
    it.each(LANGS.filter((l) => l !== 'en'))('%s: every word of the card is a catalog line (a machine draft at least), none left in English by a missing key', (lang) => {
        setLanguage('en');
        const keys = Object.values(notifyOnceWords({ global: false, community: '{community}' })).concat(notifyOnceWords({ global: true }).arrives);
        const c = catalog(lang) as Record<string, unknown>;
        // The English of each line, the community's name given as its own slot: the catalog's own key.
        for (const key of keys) expect(typeof c[key], `${lang} ${key}`).toBe('string');
        setLanguage(lang, [catalog(lang)]);
        const w = notifyOnceWords({ global: false, community: 'Riverside' });
        expect(w.title, lang).toContain('Riverside');
        setLanguage('en');
    });

    it('the pseudo language marks every word, so none is drawn outside the words layer', () => {
        setLanguage(PSEUDO_LANG);
        const w = notifyOnceWords({ global: false, community: 'Riverside' });
        expect(w.band).toBe(pseudoLocalise('Notifications'));
        expect(w.later).toBe(pseudoLocalise('Later'));
        expect(w.arrives).toBe(pseudoLocalise("When a neighbour writes, someone answers you, or an event you're going to changes."));
        setLanguage('en');
    });
});
