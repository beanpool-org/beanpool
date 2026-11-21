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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
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

import { NOTIFY_CHOICE, NOTIFY_SHOWN, localDay, type NotifyJoinPath } from '@beanpool/core';
import { laterFromJoin, notifyJoinDue, notifyJoinPathOf, showNotifyJoin, turnOnFromJoin } from '../notify-join-step';
import { afterNotify, afterWayBack } from '../join-steps';
import { readNotificationPermissionRecord } from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';
import type { OnboardingFlow } from '../onboarding-state';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

type Platform = 'iPhone' | 'Android 13+' | 'Android 8-12';
type Path = 'invite' | 'global door' | 'other door' | 'claim' | 'restore' | 'second community';
type Answer = 'Turn on + Allow' | "Turn on + Don't Allow" | 'Later' | 'swipe away';

const PLATFORMS: Record<Platform, { os: 'ios' | 'android'; start: { status: string; canAskAgain: boolean } }> = {
    iPhone: { os: 'ios', start: { status: 'undetermined', canAskAgain: true } },
    'Android 13+': { os: 'android', start: { status: 'undetermined', canAskAgain: true } },
    // Notifications are on from the start: expo-notifications reads them as allowed (amend2 §3.4, M).
    'Android 8-12': { os: 'android', start: { status: 'granted', canAskAgain: true } },
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
/** What the phone's pop-up answers. Android's swiped away: its state doesn't change (V). An iPhone's Don't Allow: never again. */
const ANSWERS: Record<Answer, { status: string; canAskAgain: boolean } | null> = {
    'Turn on + Allow': { status: 'granted', canAskAgain: true },
    "Turn on + Don't Allow": { status: 'denied', canAskAgain: true },
    Later: null,
    'swipe away': { status: 'undetermined', canAskAgain: true },
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
});

async function run(pl: Platform, p: Path, a: Answer) {
    platform.OS = PLATFORMS[pl].os;
    notifications.getPermissionsAsync.mockResolvedValue(PLATFORMS[pl].start);
    const answer = ANSWERS[a];
    notifications.requestPermissionsAsync.mockImplementation(async () => { calls.order.push('ask'); return answer ?? { status: 'undetermined', canAskAgain: true }; });
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
                        : a === 'swipe away' ? "turnOnNotifications: 'unanswered' is a Later" : 'turnOnFromJoin: notifyJoinChoice',
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
        expect(await due({}, { status: 'denied', canAskAgain: false })).toBe(false);
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
