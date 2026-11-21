/**
 * The join's last screen, end to end on the phone's side (utils/notify-join-step.ts, utils/join-steps.ts; core's
 * notifyJoinStep and notifyJoinChoice; DESIGN-notify-and-backup-asks-fable-amend2.md §3.4, §4.2, §4.4, §6, slice N1j).
 *
 * One table over (platform) x (path) x (answer): whether the screen shows, the screen after it, what this phone's record
 * keeps, what the owner's panel is sent, and that the phone's own pop-up came only from the tap on "Turn on notifications"
 * (Android's channels made first). Each row names the line it pins (`pins`): take that line away and the row goes red.
 *
 * Then the reviewer's three checks (amend2 §8): no hard ask without the tap just before it; "Later" is there and not final;
 * nothing else in the join raises a permission.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios', Version: 34 as number | string }));
vi.mock('react-native', () => ({ Platform: platform, Alert: { alert: vi.fn() }, Linking: { openSettings: vi.fn(async () => {}) } }));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
        removeItem: vi.fn(async (k: string) => { mem.delete(k); }),
    },
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
const calls = vi.hoisted(() => ({ order: [] as string[] }));
const notifications = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'undetermined', canAskAgain: true })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted', canAskAgain: true })),
    setNotificationChannelAsync: vi.fn(async (_id: string, _channel?: unknown): Promise<null> => null),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
}));
vi.mock('expo-notifications', () => ({ default: notifications, ...notifications }));
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: vi.fn(async () => null) }));
// The app's own count (utils/db.ts recordOnboardingEvent, a signed POST): the rows below make it hang or fail.
const db = vi.hoisted(() => ({ record: vi.fn(async (_event: string, _variant?: string): Promise<void> => undefined) }));
vi.mock('../db', () => ({ recordOnboardingEvent: db.record }));

import { NOTIFY_CHOICE, NOTIFY_SHOWN, localDay, type NotifyJoinPath } from '@beanpool/core';
import { NOTIFY_JOIN_WAIT_MS, laterFromJoin, notifyJoinDue, notifyJoinPathOf, showNotifyJoin, turnOnFromJoin } from '../notify-join-step';
import { afterNotify, afterWayBack } from '../join-steps';
import { notifyStep, readNotificationPermissionRecord, readOsNotificationPermission, turnOnNotifications, type ForegroundWatch } from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';
import type { OnboardingFlow } from '../onboarding-state';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

type Platform = 'iPhone' | 'Android 13+' | 'Android 8-12';
type Path = 'invite' | 'global door' | 'other door' | 'claim' | 'restore' | 'second community';
type Answer = 'Turn on + Allow' | "Turn on + Don't Allow" | 'Later' | 'swipe away';

/**
 * Android 13+ as Expo really reads it (amend3 §2; expo-modules-core PermissionsService.kt:216-240, 256-257; expo-notifications
 * NotificationPermissionsModule.kt:69-74): the permission is marked asked before the pop-up opens; a phone never asked
 * reads "denied, can ask again" (off by default); once asked and not allowed, "can ask again" is Android's own "should show
 * a reason" flag, set by one explicit "Don't allow" and cleared by the second, after which Android shows no pop-up at all.
 * A pop-up closed with no answer changes nothing (amend2 §11 row 7). So a swipe reads "denied, can't ask again".
 */
const android13 = vi.hoisted(() => ({ asked: false, granted: false, reason: false, refuses: false }));
type PopUp = 'allow' | "don't allow" | 'close';
function android13Read() {
    if (android13.granted) return { status: 'granted', canAskAgain: true };
    return { status: 'denied', canAskAgain: android13.asked ? android13.reason : true };
}
/** The pop-up asked, and what the member does with it (nothing shows where Android already refuses). Then the read. */
function android13Ask(does: PopUp) {
    android13.asked = true;
    if (!android13.refuses) {
        if (does === 'allow') android13.granted = true;
        else if (does === "don't allow") {
            if (android13.reason) { android13.refuses = true; android13.reason = false; } else android13.reason = true;
        }
    }
    return android13Read();
}
function android13Reset(over: Partial<typeof android13> = {}) {
    Object.assign(android13, { asked: false, granted: false, reason: false, refuses: false }, over);
}

const PLATFORMS: Record<Platform, { os: 'ios' | 'android'; version: number | string; start: { status: string; canAskAgain: boolean } | null }> = {
    iPhone: { os: 'ios', version: '17.0', start: { status: 'undetermined', canAskAgain: true } },
    // Read from the model above (null).
    'Android 13+': { os: 'android', version: 33, start: null },
    // Notifications are on from the start: expo-notifications reads them as allowed (amend2 §3.4, M).
    'Android 8-12': { os: 'android', version: 31, start: { status: 'granted', canAskAgain: true } },
};
/** The join each path is, and the record the phone already has on it. A second community: an earlier join's "Later", yesterday. */
const PATHS: Record<Path, { flow: OnboardingFlow; global: boolean; record: object }> = {
    invite: { flow: 'invite', global: false, record: {} },
    'global door': { flow: 'global', global: true, record: {} },
    'other door': { flow: 'global', global: false, record: {} },
    claim: { flow: 'claim', global: false, record: {} },
    restore: { flow: 'invite', global: false, record: {} },
    'second community': { flow: 'invite', global: false, record: { joinAt: NOW - DAY - 60_000, laterAt: NOW - DAY, askDay: localDay(new Date(NOW - DAY)), askKind: 'join', updatedAt: 0 } },
};
/**
 * What the member does with the phone's pop-up. On Android 13+ the model above gives the read: a swipe reads "denied, can't
 * ask again" (review of #3335, finding 1). An iPhone's alert can't be swiped away: its 'swipe away' is the app closed with
 * it up, which the system keeps as not answered. An iPhone's Don't Allow: never again.
 */
const ANSWERS: Record<Answer, PopUp | null> = {
    'Turn on + Allow': 'allow',
    "Turn on + Don't Allow": "don't allow",
    Later: null,
    'swipe away': 'close',
};
const IPHONE_READS: Record<PopUp, { status: string; canAskAgain: boolean }> = {
    allow: { status: 'granted', canAskAgain: true },
    "don't allow": { status: 'denied', canAskAgain: false },
    close: { status: 'undetermined', canAskAgain: true },
};

const pathOf = (p: Path): NotifyJoinPath => (p === 'restore' ? 'restore' : notifyJoinPathOf(PATHS[p].flow, PATHS[p].global));

// The phone's record is dated by the clock (notification-permission.ts markNotificationAsk): pinned, so every date is NOW.
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mem.clear();
    calls.order.length = 0;
    vi.clearAllMocks();
    notifications.setNotificationChannelAsync.mockImplementation(async (id: string) => { calls.order.push(`channel:${id}`); return null; });
    platform.Version = 34;
    android13Reset();
});

async function run(pl: Platform, p: Path, a: Answer) {
    platform.OS = PLATFORMS[pl].os;
    platform.Version = PLATFORMS[pl].version;
    android13Reset();
    const start = PLATFORMS[pl].start;
    notifications.getPermissionsAsync.mockImplementation(async () => start ?? android13Read());
    const does = ANSWERS[a] ?? 'close';
    notifications.requestPermissionsAsync.mockImplementation(async () => {
        calls.order.push('ask');
        if (pl === 'Android 13+') return android13Ask(does);
        if (pl === 'iPhone') return IPHONE_READS[does];
        return start ?? android13Read();
    });
    mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(PATHS[p].record));
    const count = vi.fn(async () => undefined);
    const deps = { now: () => NOW, count };

    const shown = await notifyJoinDue(pathOf(p), deps);
    // Reading whether it shows never asks.
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    let next: string;
    if (shown) {
        await showNotifyJoin(deps);
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        if (a === 'Later') await laterFromJoin(deps);
        else await turnOnFromJoin('ab'.repeat(32), deps);
        next = afterNotify(PATHS[p].flow);
    } else {
        next = p === 'restore' ? 'home' : afterWayBack(PATHS[p].flow, false);
    }
    return { shown, next, record: await readNotificationPermissionRecord(), counts: count.mock.calls };
}

type Row = { platform: Platform; path: Path; answer: Answer; shown: boolean; next: 'home' | 'ownerCard'; record: 'granted' | 'phone no' | 'later' | 'as before'; count: string | null; pins: string };

const ROWS: Row[] = [];
for (const pl of Object.keys(PLATFORMS) as Platform[]) {
    for (const p of Object.keys(PATHS) as Path[]) {
        for (const a of Object.keys(ANSWERS) as Answer[]) {
            const shown = pl !== 'Android 8-12' && p !== 'restore';
            const record = !shown ? 'as before' : a === 'Turn on + Allow' ? 'granted' : a === "Turn on + Don't Allow" ? 'phone no' : 'later';
            ROWS.push({
                platform: pl, path: p, answer: a, shown,
                next: PATHS[p].flow === 'claim' ? 'ownerCard' : 'home',
                record,
                count: !shown ? null : record === 'granted' ? 'on' : record === 'phone no' ? 'no' : 'later',
                pins: !shown ? (p === 'restore' ? "notifyJoinStep: path !== 'restore'" : 'notifyAsks.join: canAsk (granted)')
                    : a === 'Later' ? 'laterFromJoin: notificationsLater, never a no'
                        : a === 'swipe away' ? (pl === 'Android 13+' ? "notifyPopUpAnswer: denied, can't ask again, nothing on record: a Later" : "notifyPopUpAnswer: not denied is no answer")
                        : 'turnOnFromJoin: notifyJoinChoice',
            });
        }
    }
}

describe('the join\'s last screen: (platform) x (path) x (answer)', () => {
    it('the table covers 3 platforms x 6 paths x 4 answers', () => {
        expect(ROWS).toHaveLength(3 * 6 * 4);
    });

    for (const r of ROWS) {
        it(`${r.platform} · ${r.path} · ${r.answer} → ${r.shown ? 'shown' : 'not shown'}, then ${r.next} [${r.pins}]`, async () => {
            const out = await run(r.platform, r.path, r.answer);
            expect(out.shown, 'shown').toBe(r.shown);
            expect(out.next, 'next').toBe(r.next);
            // The phone's pop-up only from the tap on Turn on notifications, on a screen that showed.
            const asked = r.shown && r.answer !== 'Later';
            expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(asked ? 1 : 0);
            // Android's channels made before it asks (Android 13's pop-up needs one); never on an iPhone.
            if (asked && PLATFORMS[r.platform].os === 'android') {
                expect(calls.order.indexOf('channel:default')).toBeGreaterThanOrEqual(0);
                expect(calls.order.indexOf('channel:default')).toBeLessThan(calls.order.indexOf('ask'));
            } else {
                expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
            }
            // The record: "Later" and the phone's "no" apart, each with its date; a Later never a no.
            const rec = out.record;
            if (r.record === 'granted') expect(rec.state).toBe('granted');
            if (r.record === 'phone no') { expect(rec.phoneNoAt).toBe(NOW); expect(rec.state).not.toBe('granted'); }
            if (r.record === 'later') {
                expect(rec.laterAt).toBe(NOW);
                expect(rec.phoneNoAt).toBeUndefined();
                expect(rec.state).not.toBe('declined');
            }
            if (r.shown) { expect(rec.askKind).toBe('join'); expect(rec.joinAt).toBe(NOW); }
            else expect(rec.joinAt ?? null).toBe(r.path === 'second community' ? NOW - DAY - 60_000 : null);
            // The owner's counts: shown once, then the answer once; nothing where the screen never showed.
            expect(out.counts).toEqual(r.count ? [[NOTIFY_SHOWN, undefined], [NOTIFY_CHOICE, r.count]] : []);
        });
    }
});

describe('a second community on the same phone (amend2 §3.4)', () => {
    async function due(record: object, phone = { status: 'undetermined', canAskAgain: true }) {
        platform.OS = 'android';
        notifications.getPermissionsAsync.mockResolvedValue(phone);
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
        return notifyJoinDue('invite', { now: () => NOW });
    }
    const today = localDay(new Date(NOW));

    it('after an earlier join\'s Later today: not twice in a day', async () => {
        expect(await due({ joinAt: NOW - 3_600_000, laterAt: NOW - 3_500_000, askDay: today, askKind: 'join' })).toBe(false);
    });
    it('after the phone allowed (it registers by itself) or said no: nothing asked', async () => {
        expect(await due({ state: 'granted', updatedAt: NOW - DAY }, { status: 'granted', canAskAgain: true })).toBe(false);
        expect(await due({ phoneNoAt: NOW - DAY })).toBe(false);
        // Android 13+ "can't ask again" is the phone's no beside an answer of its own on record (amend3 §3.2) ...
        expect(await due({ phoneNoAt: NOW - DAY }, { status: 'denied', canAskAgain: false })).toBe(false);
        expect(await due({ state: 'granted', updatedAt: NOW - 30 * DAY }, { status: 'denied', canAskAgain: false })).toBe(false);
        // ... and on an iPhone or Android 8 to 12 by the read alone.
        platform.Version = 31;
        expect(await due({}, { status: 'denied', canAskAgain: false })).toBe(false);
    });
    it("Android 13+: \"can't ask again\" with no answer of the phone's on record is not a no: the screen shows (amend3 §3.2)", async () => {
        expect(await due({}, { status: 'denied', canAskAgain: false })).toBe(true);
        expect(await due({ laterAt: NOW - DAY }, { status: 'denied', canAskAgain: false })).toBe(true);
    });
    it('a 1.4.7 "Not now" reads as a Later: the screen shows on a later day (no conversion code)', async () => {
        expect(await due({ state: 'declined', updatedAt: NOW - 5 * DAY })).toBe(true);
    });
    it('a join stopped on the screen, unanswered, resumes on it the same day', async () => {
        expect(await due({ joinAt: NOW - 60_000, askDay: today, askKind: 'join' })).toBe(true);
    });
    it('a phone that can\'t load notifications, or a record that can\'t be read: no screen, never a stop', async () => {
        notifications.getPermissionsAsync.mockRejectedValueOnce(new Error('no module'));
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, '{}');
        expect(await notifyJoinDue('invite', { now: () => NOW })).toBe(false);
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, 'not json');
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        expect(await notifyJoinDue('invite', { now: () => NOW })).toBe(true);
    });
});

/**
 * Android 13+: a closed pop-up is a "Later", never the phone's no (amend3, review of #3335 finding 1). Each row walks the
 * model phone above through the real code (notifyJoinDue, showNotifyJoin, turnOnFromJoin; turnOnNotifications from the
 * bell's line) and checks what is recorded, counted and drawn next. Each names the line it pins.
 */
describe("Android 13+: a pop-up closed with no answer is a Later; the asks stop only after the phone's own no", () => {
    const KEY = 'ab'.repeat(32);
    beforeEach(() => {
        platform.OS = 'android';
        platform.Version = 33;
        android13Reset();
        notifications.getPermissionsAsync.mockImplementation(async () => android13Read());
    });
    /** The member's hand on the pop-up, for the next ask. */
    const popUp = (does: PopUp) => notifications.requestPermissionsAsync.mockImplementation(async () => { calls.order.push('ask'); return android13Ask(does); });
    /** Never left the foreground (the pop-up never came up) or left it (it did). */
    const watched = (left: boolean) => (): ForegroundWatch => ({ left: () => left, stop: () => {} });
    const bell = (extra: Parameters<typeof turnOnNotifications>[2] = {}) =>
        turnOnNotifications(KEY, undefined, { confirmSettings: async () => 'not_now', watchForeground: watched(true), ...extra });

    it("swiped away at the join: counted later, a Later on record, no phone's no; the next day every ask goes on and the bell's line brings the pop-up [notifyPopUpAnswer: nothing on record: 'later']", async () => {
        const count = vi.fn(async () => undefined);
        expect(await notifyJoinDue('invite', { now: () => NOW, count })).toBe(true);
        await showNotifyJoin({ now: () => NOW, count });
        popUp('close');
        expect(await turnOnFromJoin(KEY, { now: () => NOW, count, turnOn: { watchForeground: watched(true) } })).toBe('later');
        expect(count.mock.calls).toEqual([[NOTIFY_SHOWN, undefined], [NOTIFY_CHOICE, 'later']]);
        const rec = await readNotificationPermissionRecord();
        expect(rec.laterAt).toBe(NOW);
        expect(rec.phoneNoAt).toBeUndefined();
        // What Android reads now, and what the rule makes of it the next day.
        const phone = await readOsNotificationPermission();
        expect(phone).toEqual({ available: true, granted: false, canAskAgain: false, cantAskNeedsRecord: true });
        vi.setSystemTime(NOW + DAY);
        expect(await notifyJoinDue('invite', { now: () => NOW + DAY })).toBe(true);
        expect(notifyStep(await readNotificationPermissionRecord(), phone)).toBe(false);
        const confirmSettings = vi.fn(async () => 'not_now' as const);
        popUp('allow');
        expect(await bell({ confirmSettings })).toBe('granted');
        expect(confirmSettings).not.toHaveBeenCalled();
        expect(calls.order.filter((c) => c === 'ask')).toHaveLength(2);
    });

    it('the app closed with the pop-up up: the join resumes on its screen, and its tap asks again [notifyCanAskAgain: cantAskNeedsRecord]', async () => {
        expect(await notifyJoinDue('invite', { now: () => NOW })).toBe(true);
        await showNotifyJoin({ now: () => NOW });
        // Expo marks the permission asked before the pop-up opens; the app is gone before any answer comes back.
        android13.asked = true;
        expect(await readOsNotificationPermission()).toMatchObject({ granted: false, canAskAgain: false });
        // Opened again later the same day: the screen shown today, unanswered, shows again.
        vi.setSystemTime(NOW + 3_600_000);
        expect(await notifyJoinDue('invite', { now: () => NOW + 3_600_000 })).toBe(true);
        popUp("don't allow");
        expect(await turnOnFromJoin(KEY, { now: () => NOW + 3_600_000, count: async () => undefined })).toBe('no');
        expect((await readNotificationPermissionRecord()).phoneNoAt).toBe(NOW + 3_600_000);
    });

    it("a phone restored from a backup (Expo's \"asked\" carried over, our record not): the screen shows and its tap asks [notifyCanAskAgain: cantAskNeedsRecord]", async () => {
        android13Reset({ asked: true });
        expect(await notifyJoinDue('invite', { now: () => NOW })).toBe(true);
        popUp('allow');
        expect(await turnOnFromJoin(KEY, { now: () => NOW, count: async () => undefined })).toBe('on');
        expect(calls.order).toContain('ask');
    });

    it("Don't allow twice: the first is a no that stops the soft asks and keeps the pop-up for a tap; the second is final and the bell's line opens Settings [notifyPopUpAnswer: phoneAnswerOnRecord]", async () => {
        const count = vi.fn(async () => undefined);
        await showNotifyJoin({ now: () => NOW, count });
        popUp("don't allow");
        expect(await turnOnFromJoin(KEY, { now: () => NOW, count })).toBe('no');
        expect((await readNotificationPermissionRecord()).phoneNoAt).toBe(NOW);
        vi.setSystemTime(NOW + DAY);
        expect(await notifyJoinDue('invite', { now: () => NOW + DAY })).toBe(false);
        expect(notifyStep(await readNotificationPermissionRecord(), await readOsNotificationPermission())).toBeNull();
        // The bell's line: Android's second pop-up, at their own tap.
        popUp("don't allow");
        expect(await bell()).toBe('declined');
        expect((await readNotificationPermissionRecord()).phoneNoAt).toBe(NOW + DAY);
        expect(calls.order.filter((c) => c === 'ask')).toHaveLength(2);
        // Now final: the one Settings line, and no pop-up asked.
        const confirmSettings = vi.fn(async () => 'turn_on' as const);
        const openSettings = vi.fn(async () => {});
        expect(await bell({ confirmSettings, openSettings })).toBe('settings');
        expect(openSettings).toHaveBeenCalledTimes(1);
        expect(calls.order.filter((c) => c === 'ask')).toHaveLength(2);
    });

    it("the second pop-up closed with no answer: nothing new is recorded, the first no stands and is not final [notifyPopUpAnswer: can ask again with phoneNoAt: 'none']", async () => {
        android13Reset({ asked: true, reason: true });
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ phoneNoAt: NOW - DAY, updatedAt: 0 }));
        popUp('close');
        expect(await bell()).toBe('unanswered');
        const rec = await readNotificationPermissionRecord();
        expect(rec.phoneNoAt).toBe(NOW - DAY);
        expect(rec.laterAt).toBeUndefined();
        popUp('allow');
        expect(await bell()).toBe('granted');
    });

    it("the pop-up that never comes (Android refused twice unheard, nothing on record): the Settings line at once, nothing recorded [turnOnNotifications: never left the foreground]", async () => {
        android13Reset({ asked: true, refuses: true });
        popUp("don't allow");
        const confirmSettings = vi.fn(async () => 'turn_on' as const);
        const openSettings = vi.fn(async () => {});
        expect(await bell({ confirmSettings, openSettings, watchForeground: watched(false) })).toBe('settings');
        expect(openSettings).toHaveBeenCalledTimes(1);
        const rec = await readNotificationPermissionRecord();
        expect(rec.phoneNoAt).toBeUndefined();
        expect(rec.laterAt).toBeUndefined();
        // Not now there: nothing recorded either, and the next tap simply tries again.
        expect(await bell({ confirmSettings: async () => 'not_now', watchForeground: watched(false) })).toBe('unanswered');
        expect(calls.order.filter((c) => c === 'ask')).toHaveLength(2);
        expect((await readNotificationPermissionRecord()).laterAt).toBeUndefined();
    });

    it('the same read where the pop-up did come up (the app left the foreground) is a Later, never the Settings line [turnOnNotifications: watch.left()]', async () => {
        android13Reset();
        popUp('close');
        const confirmSettings = vi.fn(async () => 'turn_on' as const);
        expect(await bell({ confirmSettings, watchForeground: watched(true) })).toBe('unanswered');
        expect(confirmSettings).not.toHaveBeenCalled();
        expect((await readNotificationPermissionRecord()).laterAt).toBe(NOW);
    });

    it('a watch that cannot be had (no AppState) takes the pop-up as come: a Later', async () => {
        android13Reset();
        popUp('close');
        const confirmSettings = vi.fn(async () => 'turn_on' as const);
        expect(await turnOnNotifications(KEY, undefined, { confirmSettings })).toBe('unanswered');
        expect(confirmSettings).not.toHaveBeenCalled();
    });

    it('iPhone and Android 8 to 12 are unchanged: no mark, no watch; "denied" is the phone\'s no', async () => {
        for (const [os, version] of [['ios', '17.0'], ['android', 31]] as const) {
            mem.clear();
            platform.OS = os;
            platform.Version = version;
            notifications.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: true } as never);
            notifications.requestPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false } as never);
            const watch = vi.fn(watched(false));
            expect((await readOsNotificationPermission()).cantAskNeedsRecord).toBeUndefined();
            expect(await turnOnNotifications(KEY, undefined, { watchForeground: watch })).toBe('declined');
            expect(watch).not.toHaveBeenCalled();
            expect((await readNotificationPermissionRecord()).phoneNoAt).toBe(NOW);
        }
    });
});

describe('every way off the screen goes on, also when the phone fails', () => {
    it('the pop-up throws: a Later, counted later, never a no', async () => {
        platform.OS = 'android';
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        notifications.requestPermissionsAsync.mockRejectedValueOnce(new Error('boom'));
        const count = vi.fn(async () => undefined);
        expect(await turnOnFromJoin(null, { now: () => NOW, count })).toBe('later');
        const rec = await readNotificationPermissionRecord();
        expect(rec.phoneNoAt).toBeUndefined();
        expect(typeof rec.laterAt).toBe('number');
        expect(count).toHaveBeenCalledWith(NOTIFY_CHOICE, 'later');
    });
    it('a channel that can\'t be made never stops the ask', async () => {
        platform.OS = 'android';
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        notifications.setNotificationChannelAsync.mockRejectedValue(new Error('no channel'));
        notifications.requestPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true });
        expect(await turnOnFromJoin(null, { now: () => NOW, count: async () => undefined })).toBe('on');
    });
    it('a count an older server refuses is swallowed: the answer stands', async () => {
        platform.OS = 'ios';
        const refused = vi.fn(async () => { throw new Error('400 Unknown onboarding event'); });
        await expect(showNotifyJoin({ now: () => NOW, count: refused })).resolves.toBeUndefined();
        await expect(laterFromJoin({ now: () => NOW, count: refused })).resolves.toBe('later');
    });
    it('the counts go through recordOnboardingEvent, once per person per community', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../notify-join-step.ts'), 'utf8');
        expect(src).toMatch(/const \{ recordOnboardingEvent \} = await import\('\.\/db'\);\s*await recordOnboardingEvent\(event, variant\);/);
        const db = fs.readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8');
        expect(db).toMatch(/const alreadyCounted = onboardingEventKey\(anchorUrl, identity\.publicKey, event\);\s*if \(await AsyncStorage\.getItem\(alreadyCounted\)\) return;/);
    });
});

/**
 * Nothing between a tap and the next screen waits on the network or on a phone that doesn't answer (review of #3335 at
 * 95336d22, finding 1; amend2 §4.2 "The screen waits on no network"). One row per wait on the way: the owner's two counts
 * (each a signed POST a slow community holds for up to 12 s), the phone's state read, Android's channels. Each row hangs or
 * fails that one call and checks the step still settles at once (well inside the bound), the pop-up still comes only from
 * the tap, and each count is still sent once. The screen's own side (the pop-up at the tap, Later straight to Home, a
 * failed end's message) is welcome-notify-never-waits-render.test.ts.
 */
describe('nothing on the way off the screen waits on the network or a silent phone', () => {
    const never = <T,>() => new Promise<T>(() => {});
    /** 'settled' if `p` settles within `ms`, else 'waiting'. */
    const within = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('waiting'), ms))]);
    const wait = NOTIFY_JOIN_WAIT_MS.phone;
    beforeEach(() => {
        platform.OS = 'android';
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        notifications.requestPermissionsAsync.mockImplementation(async () => { calls.order.push('ask'); return { status: 'granted', canAskAgain: true }; });
        db.record.mockReset();
        NOTIFY_JOIN_WAIT_MS.phone = 40;
    });
    afterEach(() => { NOTIFY_JOIN_WAIT_MS.phone = wait; });

    const COUNTS: Array<{ name: string; count: () => Promise<void> }> = [
        { name: 'hangs', count: () => never() },
        { name: 'fails', count: async () => { throw new Error('502'); } },
    ];
    for (const c of COUNTS) {
        it(`the app's count ${c.name}: the showing, Turn on (pop-up asked) and Later each settle at once, each count sent once`, async () => {
            db.record.mockImplementation(c.count);
            expect(await within(showNotifyJoin({ now: () => NOW }), 20), 'the showing').toBe('settled');
            expect(await within(turnOnFromJoin('ab'.repeat(32), { now: () => NOW }), 20), 'Turn on').toBe('settled');
            expect(calls.order).toContain('ask');
            expect(await within(laterFromJoin({ now: () => NOW }), 20), 'Later').toBe('settled');
            await new Promise((r) => setTimeout(r, 0));
            expect(db.record.mock.calls).toEqual([[NOTIFY_SHOWN, undefined], [NOTIFY_CHOICE, 'on'], [NOTIFY_CHOICE, 'later']]);
        });
    }

    it('an injected count that throws before it returns a promise is swallowed too', async () => {
        const count = vi.fn((): Promise<void> => { throw new Error('sync'); });
        await expect(laterFromJoin({ now: () => NOW, count })).resolves.toBe('later');
        await new Promise((r) => setTimeout(r, 0));
        expect(count).toHaveBeenCalledTimes(1);
    });

    it('the phone never says what it allows: no screen (the join goes on), within the bound', async () => {
        notifications.getPermissionsAsync.mockImplementation(() => never());
        const due = notifyJoinDue('invite', { now: () => NOW });
        expect(await within(due, 400)).toBe('settled');
        expect(await due).toBe(false);
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('the phone stops answering at the tap: a "Later" (never a no), no pop-up, counted once, within the bound', async () => {
        notifications.getPermissionsAsync.mockImplementation(() => never());
        const count = vi.fn(async () => undefined);
        const answer = turnOnFromJoin(null, { now: () => NOW, count });
        expect(await within(answer, 400)).toBe('settled');
        expect(await answer).toBe('later');
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        const rec = await readNotificationPermissionRecord();
        expect(rec.laterAt).toBe(NOW);
        expect(rec.phoneNoAt).toBeUndefined();
        expect(count.mock.calls).toEqual([[NOTIFY_CHOICE, 'later']]);
    });

    it('Android never finishes making a channel: the pop-up is asked all the same, within the bound', async () => {
        notifications.setNotificationChannelAsync.mockImplementation((id: string) => { calls.order.push(`channel:${id}`); return never(); });
        const count = vi.fn(async () => undefined);
        const answer = turnOnFromJoin(null, { now: () => NOW, count });
        expect(await within(answer, 400)).toBe('settled');
        expect(await answer).toBe('on');
        expect(calls.order).toEqual(['channel:default', 'ask']);
        expect(count.mock.calls).toEqual([[NOTIFY_CHOICE, 'on']]);
    });
});

describe('the reviewer\'s three checks (amend2 §8)', () => {
    const root = path.resolve(__dirname, '../..');
    const welcome = fs.readFileSync(path.join(root, 'app/welcome.tsx'), 'utf8');
    const step = fs.readFileSync(path.join(root, 'components/welcome/NotifyStep.tsx'), 'utf8');

    it('1: no hard ask without a tap on the soft ask just before it', () => {
        // The screen itself never asks; welcome's one call is the Turn on handler, wired to the button.
        expect(step).not.toMatch(/requestPermissionsAsync|turnOnNotifications|expo-notifications/);
        expect(welcome).not.toMatch(/requestPermissionsAsync/);
        expect(welcome.match(/turnOnFromJoin\(/g)).toHaveLength(1);
        const handler = welcome.slice(welcome.indexOf('async function handleNotifyTurnOn('), welcome.indexOf('async function handleNotifyLater('));
        expect(handler).toContain('await turnOnFromJoin(');
        expect(welcome).toContain('onTurnOn={() => void handleNotifyTurnOn()}');
        // The screen's showing marks and counts only.
        const show = fs.readFileSync(path.resolve(__dirname, '../notify-join-step.ts'), 'utf8');
        const showFn = show.slice(show.indexOf('export async function showNotifyJoin('), show.indexOf('export async function turnOnFromJoin('));
        expect(showFn).not.toMatch(/turnOn|request/);
    });

    it('2: "Later" is there and not final', async () => {
        expect(step).toContain('onPress={onLater}');
        expect(welcome).toContain('onLater={() => void handleNotifyLater()}');
        // Later records a Later (never the phone's no), and the rule asks again on another day (the table above: second community).
        mem.clear();
        await laterFromJoin({ now: () => NOW, count: async () => undefined });
        const rec = await readNotificationPermissionRecord();
        expect(rec.laterAt).toBe(NOW);
        expect(rec.phoneNoAt).toBeUndefined();
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
        expect(await notifyJoinDue('invite', { now: () => NOW + DAY })).toBe(true);
    });

    it('3: nothing else in the join raises a permission', () => {
        const join = welcome + step + fs.readFileSync(path.join(root, 'components/welcome/StepDots.tsx'), 'utf8');
        expect(join).not.toMatch(/request\w*Permission\w*Async|useCameraPermissions|requestForegroundPermissions|requestMediaLibraryPermissions/);
    });
});
