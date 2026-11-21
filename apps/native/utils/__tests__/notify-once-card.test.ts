/**
 * Home's once card on the phone's side (utils/notification-permission.ts offerOnceCard, turnOnFromOnceCard, onceCardLater;
 * core's notifyAsks `once`; DESIGN-notify-and-backup-asks-fable-amend2.md §7, slice N1h; amend4 §4 for Android 13+).
 *
 * The landing: whether the card shows for each phone and the record the update finds, what a showing keeps (it takes the
 * day; its 7 days start at the first showing), and that deciding it never asks the phone. The taps: Turn on goes through the
 * one door to the phone's pop-up, the phone's yes or no ends the card by its own answer and closes it as the web's does
 * (core's notifyOutcomeEvent on 'once': both apps write the record the same), and anything else is the card's "Later",
 * which puts it away and is never a no. Then the reviewer's three checks (amend2 §8), for the card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const platform = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios', Version: '17.0' as number | string }));
vi.mock('react-native', () => ({
    Platform: platform,
    Alert: { alert: vi.fn() },
    Linking: { openSettings: vi.fn(async () => {}) },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    TurboModuleRegistry: { get: vi.fn(() => null) },
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
const notifications = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'undetermined', canAskAgain: true })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
    setNotificationChannelAsync: vi.fn(async (_id: string, _channel?: unknown): Promise<null> => null),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
}));
vi.mock('expo-notifications', () => ({ default: notifications, ...notifications }));
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: vi.fn(async () => null) }));

import { localDay, markNotifyAsk, notifyAsks, notifyBrowserOutcome, notifyOutcomeEvent, type NotifyAskRecord, type NotifyBrowserResult } from '@beanpool/core';
import {
    ONCE_CARD_WAIT_MS, notifyStep, offerNamedLine, offerOnceCard, onceCardLater, readNotificationPermissionRecord, turnOnFromOnceCard,
    type OsNotificationPermission, type TurnOnOptions, type TurnOnResult,
} from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const UPDATE = new Date(2026, 11, 1, 12, 0).getTime();

const IPHONE_ASK: OsNotificationPermission = { available: true, granted: false, canAskAgain: true };
const IPHONE_NO: OsNotificationPermission = { available: true, granted: false, canAskAgain: false };
const A13 = (flag: boolean, fresh: boolean): OsNotificationPermission => ({ available: true, granted: false, canAskAgain: flag || fresh, cantAskNeedsRecord: true, saidNoOnce: flag });
const A8_ON: OsNotificationPermission = { available: true, granted: true, canAskAgain: true };

const DECLINED = { state: 'declined', updatedAt: UPDATE - 20 * DAY };

/** This phone's record as stored, under the key it always had. */
const stored = (): NotifyAskRecord => JSON.parse(mem.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? '{}');
const store = (r: object) => mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(r));
const at = (t: number) => () => t;
const reads = (os: OsNotificationPermission) => async () => os;

beforeEach(() => {
    mem.clear();
    vi.clearAllMocks();
    platform.OS = 'ios';
    platform.Version = '17.0';
});
afterEach(() => { ONCE_CARD_WAIT_MS.phone = 4000; });

type Landing = { phone: string; os: OsNotificationPermission; record: string; at: object; card: boolean };
const LANDINGS: Landing[] = [
    { phone: 'iPhone', os: IPHONE_ASK, record: 'none (a restore on a new phone)', at: {}, card: true },
    { phone: 'iPhone', os: IPHONE_ASK, record: "1.4.7's Not now", at: DECLINED, card: true },
    { phone: 'iPhone', os: IPHONE_NO, record: "1.4.7 declined, the phone's Don't Allow", at: DECLINED, card: false },
    { phone: 'Android 13+ flag off', os: A13(false, true), record: "1.4.7's Not now (never asked)", at: DECLINED, card: true },
    { phone: 'Android 13+ flag off', os: A13(false, false), record: 'none (a restore: Expo\'s "asked" came along)', at: {}, card: true },
    { phone: 'Android 13+ flag on', os: A13(true, false), record: "1.4.7 declined, the phone's Don't allow once", at: DECLINED, card: false },
    { phone: 'Android 8-12', os: A8_ON, record: "1.4.7's Not now", at: DECLINED, card: false },
    { phone: 'iPhone', os: IPHONE_ASK, record: "the join's screen shown here", at: { state: 'unanswered', updatedAt: 1, joinAt: UPDATE - DAY, laterAt: UPDATE - DAY }, card: false },
];

describe('the first landing after the update: the card, once, where the phone has to ask and still can', () => {
    for (const l of LANDINGS) {
        it(`${l.phone}, ${l.record} → ${l.card ? 'the card, marked shown (it takes the day)' : 'no card, nothing written'}`, async () => {
            store(l.at);
            const before = mem.get(NOTIFICATION_PERMISSION_STORE_KEY);
            expect(await offerOnceCard(undefined, at(UPDATE), reads(l.os))).toBe(l.card);
            if (l.card) expect(stored()).toMatchObject({ onceAt: UPDATE, askDay: localDay(new Date(UPDATE)), askKind: 'once' });
            else expect(mem.get(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(before);
            // Deciding it never asks the phone.
            expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        });
    }

    it('every landing for 7 days shows it again (its first showing kept), then it folds into First steps\' line', async () => {
        store(DECLINED);
        expect(await offerOnceCard(undefined, at(UPDATE), reads(IPHONE_ASK))).toBe(true);
        expect(await offerOnceCard(undefined, at(UPDATE + 2 * HOUR), reads(IPHONE_ASK))).toBe(true);
        expect(await offerOnceCard(undefined, at(UPDATE + 3 * DAY), reads(IPHONE_ASK))).toBe(true);
        expect(stored().onceAt).toBe(UPDATE);
        expect(await offerOnceCard(undefined, at(UPDATE + 8 * DAY), reads(IPHONE_ASK))).toBe(false);
        const record = await readNotificationPermissionRecord();
        expect(notifyStep(record, IPHONE_ASK)).toBe(false);
    });

    it('one soft ask a day: the card and a named line on the same landing, asked at the same moment, never both take it', async () => {
        store(DECLINED);
        platform.OS = 'ios';
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        const [card, line] = await Promise.all([offerOnceCard(undefined, at(UPDATE)), offerNamedLine('answer', undefined, at(UPDATE))]);
        expect([card, line]).toEqual([true, false]);
        // The next day a named line asked first takes that day; the card is back the day after (still in its 7 days).
        expect(await offerNamedLine('answer', undefined, at(UPDATE + DAY))).toBe(true);
        expect(await offerOnceCard(undefined, at(UPDATE + DAY + HOUR), reads(IPHONE_ASK))).toBe(false);
        expect(await offerOnceCard(undefined, at(UPDATE + 2 * DAY), reads(IPHONE_ASK))).toBe(true);
    });

    it("a phone that doesn't say what it allows: no card that landing, and nothing written; the next landing can", async () => {
        store(DECLINED);
        ONCE_CARD_WAIT_MS.phone = 20;
        const never = () => new Promise<OsNotificationPermission>(() => {});
        expect(await offerOnceCard(undefined, at(UPDATE), never)).toBe(false);
        expect(stored()).toEqual(DECLINED);
        const throws = async (): Promise<OsNotificationPermission> => { throw new Error('no module'); };
        expect(await offerOnceCard(undefined, at(UPDATE), throws)).toBe(false);
        expect(await offerOnceCard(undefined, at(UPDATE), reads(IPHONE_ASK))).toBe(true);
    });
});

describe("the card's taps: Turn on through the one door; Later puts it away and is not a no", () => {
    const shownOn = (os: OsNotificationPermission) => offerOnceCard(undefined, at(Date.now()), reads(os));

    it('iPhone, Turn on + Allow: the phone\'s yes is kept, and the card goes by it, closed for good as on the web', async () => {
        store(DECLINED);
        expect(await shownOn(IPHONE_ASK)).toBe(true);
        notifications.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: true });
        expect(await turnOnFromOnceCard(null, undefined, { readOs: reads(IPHONE_ASK) })).toBe('granted');
        expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(stored()).toMatchObject({ state: 'granted' });
        // Any answer on the card closes it (core's notifyOutcomeEvent on 'once', as the web keeps it), a yes included.
        expect(typeof stored().onceClosedAt).toBe('number');
        expect(stored().laterAt).toBeUndefined();
        expect(notifyAsks({ record: stored(), phone: { available: true, granted: true, canAskAgain: true }, now: Date.now() }).once).toBe(false);
    });

    it("iPhone, Turn on + Don't Allow: the phone's no is kept as the phone's (never as a Later), and the card goes by it, closed for good", async () => {
        store(DECLINED);
        expect(await shownOn(IPHONE_ASK)).toBe(true);
        notifications.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
        expect(await turnOnFromOnceCard(null, undefined, { readOs: reads(IPHONE_ASK) })).toBe('declined');
        expect(typeof stored().phoneNoAt).toBe('number');
        expect(typeof stored().onceClosedAt).toBe('number');
        expect(stored().laterAt).toBeUndefined();
        expect(notifyAsks({ record: stored(), phone: IPHONE_NO, now: Date.now() }).once).toBe(false);
    });

    it("Android 13+, Turn on, then the pop-up closed with no answer: the card's Later (put away), never a no", async () => {
        platform.OS = 'android';
        platform.Version = 34;
        store(DECLINED);
        expect(await shownOn(A13(false, true))).toBe(true);
        notifications.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied', canAskAgain: false });
        const left = { left: () => true, stop: () => {} };
        expect(await turnOnFromOnceCard(null, undefined, { readOs: reads(A13(false, true)), watchForeground: () => left })).toBe('unanswered');
        expect(stored().phoneNoAt).toBeUndefined();
        expect(typeof stored().onceClosedAt).toBe('number');
        expect(typeof stored().laterAt).toBe('number');
        // Not a no: First steps' line is back, unticked, and the phone's question is unspent.
        expect(notifyStep(await readNotificationPermissionRecord(), A13(false, false))).toBe(false);
    });

    it('a tap whose ask throws is a Later, never a no; the card never stays up behind a failed tap', async () => {
        store(DECLINED);
        expect(await shownOn(IPHONE_ASK)).toBe(true);
        const throws = async (): Promise<OsNotificationPermission> => { throw new Error('gone'); };
        expect(await turnOnFromOnceCard(null, undefined, { readOs: throws })).toBe('unanswered');
        expect(stored().phoneNoAt).toBeUndefined();
        expect(typeof stored().onceClosedAt).toBe('number');
    });

    it("Later: put away for good, recorded with its date, not a no; First steps' line is back, and the phone's pop-up never came", async () => {
        store(DECLINED);
        const t0 = Date.now();
        expect(await shownOn(IPHONE_ASK)).toBe(true);
        await onceCardLater();
        expect(stored()).toMatchObject({ onceAt: expect.any(Number), onceClosedAt: expect.any(Number), laterAt: expect.any(Number) });
        expect(stored().phoneNoAt).toBeUndefined();
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        for (const d of [0, 1, 3, 8]) expect(await offerOnceCard(undefined, at(t0 + d * DAY + HOUR), reads(IPHONE_ASK)), `day ${d}`).toBe(false);
        expect(notifyStep(await readNotificationPermissionRecord(), IPHONE_ASK)).toBe(false);
    });
});

/**
 * The card's answer on the phone, beside the web's for the same answer (apps/pwa lib/web-push.ts turnOnFromAsk: core's
 * notifyBrowserOutcome, then notifyOutcomeEvent on 'once'). Each row: the tap on the phone, what it ends in, and the web's
 * answer that matches it; the two records must say the same (the phone's yes or no, a Later, the card closed). The web has
 * no Settings line: a Settings opened from the card is the card's Later on the phone, as the web's Later is. The yes and the
 * no rows go red if the phone records its answer without saying it came from the card (only its Later would close it then).
 */
type Tap = {
    tap: string;
    os: OsNotificationPermission;
    /** The phone's own read at the tap, when it differs from the landing's (switched off in its settings meanwhile). */
    atTap?: OsNotificationPermission;
    pop?: { status: string; canAskAgain: boolean };
    options?: Partial<TurnOnOptions>;
    result: TurnOnResult;
    /** The web's answer that matches: what turnOnWebPush ends in, or its Later. */
    web: NotifyBrowserResult | 'later';
};
const TAPS: Tap[] = [
    { tap: 'iPhone, Allow', os: IPHONE_ASK, pop: { status: 'granted', canAskAgain: true }, result: 'granted', web: 'ok' },
    { tap: "iPhone, Don't Allow", os: IPHONE_ASK, pop: { status: 'denied', canAskAgain: false }, result: 'declined', web: 'blocked' },
    { tap: "Android 13+, Don't allow (the flag goes on)", os: A13(false, true), pop: { status: 'denied', canAskAgain: true }, result: 'declined', web: 'blocked' },
    {
        tap: 'Android 13+, the pop-up closed with no answer', os: A13(false, true), pop: { status: 'denied', canAskAgain: false },
        options: { watchForeground: () => ({ left: () => true, stop: () => {} }) }, result: 'unanswered', web: 'dismissed',
    },
    {
        tap: "iPhone switched off since the landing: the Settings line's Open Settings", os: IPHONE_ASK, atTap: IPHONE_NO,
        options: { confirmSettings: async () => 'turn_on', openSettings: async () => {} }, result: 'settings', web: 'later',
    },
    {
        tap: "iPhone switched off since the landing: the Settings line's Not now", os: IPHONE_ASK, atTap: IPHONE_NO,
        options: { confirmSettings: async () => 'not_now', openSettings: async () => {} }, result: 'unanswered', web: 'later',
    },
];

/** What a record says of the answers, without the times: the phone's (or browser's) yes or no, a Later, the card closed. */
const says = (r: NotifyAskRecord) => ({
    state: r.state, phoneNo: typeof r.phoneNoAt === 'number', later: typeof r.laterAt === 'number', closed: typeof r.onceClosedAt === 'number',
});

describe("the card's answer, phone beside web: both apps write the record the same (core's notifyOutcomeEvent on 'once')", () => {
    for (const row of TAPS) {
        it(`${row.tap} → ${row.result}, the same record as the web's ${row.web}`, async () => {
            if (row.os.cantAskNeedsRecord) { platform.OS = 'android'; platform.Version = 34; }
            store(DECLINED);
            expect(await offerOnceCard(undefined, at(Date.now()), reads(row.os))).toBe(true);
            const shown = stored();
            if (row.pop) notifications.requestPermissionsAsync.mockResolvedValueOnce(row.pop);
            expect(await turnOnFromOnceCard(null, undefined, { readOs: reads(row.atTap ?? row.os), ...row.options })).toBe(row.result);
            const outcome = row.web === 'later' ? 'later' : notifyBrowserOutcome(row.web);
            expect(outcome).not.toBeNull();
            const web = markNotifyAsk(shown, notifyOutcomeEvent(outcome!, 'once'), Date.now());
            expect(says(stored())).toEqual(says(web));
            // Every answer on the card closes it, on both apps, and it is never back.
            expect(says(stored()).closed).toBe(true);
            expect(notifyAsks({ record: stored(), phone: IPHONE_ASK, now: Date.now() + DAY }).once).toBe(false);
        });
    }
});

describe('the record the pop-up keeps is never put back by a landing read before it', () => {
    it('a return to the app the day the card was marked (back from the pop-up) writes nothing', async () => {
        store(DECLINED);
        expect(await offerOnceCard(undefined, at(UPDATE), reads(IPHONE_ASK))).toBe(true);
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as { setItem: ReturnType<typeof vi.fn> };
        AsyncStorage.setItem.mockClear();
        expect(await offerOnceCard(undefined, at(UPDATE + HOUR), reads(IPHONE_ASK))).toBe(true);
        expect(AsyncStorage.setItem).not.toHaveBeenCalled();
    });

    it("the phone's answer kept while the landing waits on the phone's read survives: the record is read after the phone", async () => {
        store(DECLINED);
        let release: ((os: OsNotificationPermission) => void) | null = null;
        const slow = () => new Promise<OsNotificationPermission>((r) => { release = r; });
        const offered = offerOnceCard(undefined, at(UPDATE), slow);
        // The landing is waiting on the phone's own read.
        while (!release) await new Promise((r) => setTimeout(r, 0));
        // Meanwhile the pop-up's answer is kept (turnOnNotifications' own write).
        store({ ...DECLINED, phoneNoAt: UPDATE - 1000 });
        (release as unknown as (os: OsNotificationPermission) => void)(A13(false, false));
        // A "Don't allow" now on record beside "can't ask": final, so no card, and the answer stays.
        expect(await offered).toBe(false);
        expect(stored().phoneNoAt).toBe(UPDATE - 1000);
    });
});

describe("the reviewer's three checks (amend2 §8), for the once card", () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8');
    const card = read('components/home/NotifyAskCard.tsx');
    const home = read('app/(tabs)/index.tsx');

    it('(1) no hard ask without a tap on the card just before it: the card asks nothing itself; Home asks only from Turn on', () => {
        expect(card).not.toMatch(/requestPermissionsAsync|turnOnNotifications|turnOnFromOnceCard|expo-notifications|PermissionsAndroid/);
        // Home's only call of the card's door is inside its Turn on handler, and the card's Turn on is that handler.
        const calls = home.split('turnOnFromOnceCard(').length - 1;
        expect(calls).toBe(1);
        const handler = home.slice(home.indexOf('const onceTurnOn = useCallback('), home.indexOf('const onceLater = useCallback('));
        expect(handler).toContain('turnOnFromOnceCard(identityRef.current?.publicKey)');
        expect(home).toContain('onTurnOn={onceTurnOn}');
        // Deciding the card (each landing) reads, and never asks.
        const src = read('utils/notification-permission.ts');
        const offer = src.slice(src.indexOf('export function offerOnceCard('), src.indexOf('export async function turnOnFromOnceCard('));
        expect(offer).not.toMatch(/requestPermissionsAsync|turnOnNotifications\(/);
    });

    it('(2) "Later" is there and is not final: a button of its own, recorded as a Later (onceCardLater), never as the phone\'s no', () => {
        expect(card).toContain('testID="notify-once-later"');
        expect(card).toContain('onPress={onLater}');
        expect(home).toContain('onLater={onceLater}');
        const handler = home.slice(home.indexOf('const onceLater = useCallback('), home.indexOf('// Read at each landing'));
        expect(handler).toContain('onceCardLater()');
        expect(handler).not.toMatch(/phone-no|declined/);
    });

    it('(3) nothing else raises a permission: the card and Home\'s once code ask for no other permission', () => {
        expect(card).not.toMatch(/Location|Camera|Contacts|ImagePicker|MediaLibrary|requestPermission/);
        const onceCode = home.slice(home.indexOf("Home's once card (slice N1h; DESIGN"), home.indexOf('// Read at each landing'));
        expect(onceCode).not.toMatch(/Location|Camera|Contacts|ImagePicker|MediaLibrary|requestPermission/);
    });
});

// Last in the file on purpose: it leaves the one-at-a-time chain behind a read that never answers.
describe('Home is never held by a decision stuck ahead of the card', () => {
    // Without the card's own give-up the await below never settles, and the test's own timeout reds it (no clock measured here).
    it("a named line's phone read that never answers: the card's answer is still given (no card), and nothing is written", async () => {
        store(DECLINED);
        ONCE_CARD_WAIT_MS.phone = 20;
        notifications.getPermissionsAsync.mockImplementationOnce(() => new Promise(() => {}));
        void offerNamedLine('answer', undefined, at(UPDATE));
        expect(await offerOnceCard(undefined, at(UPDATE), reads(IPHONE_ASK))).toBe(false);
        expect(stored()).toEqual(DECLINED);
    });
});
