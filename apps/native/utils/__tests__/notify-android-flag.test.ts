/**
 * On Android 13+ the phone reads Android's own "one no" flag (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend4.md,
 * finding A of the max re-check of #3335, scratch/reviews/REVIEW-3335-max-r2.md), and the three guards that re-check found
 * unpinned (its findings B, C and D; D is in welcome-notify-never-waits-render.test.ts).
 *
 * - The reader (utils/notification-permission.ts `readOsNotificationPermission`): Android 13+ reads the flag from React
 *   Native's permissions module and passes it on as `saidNoOnce`; a failed read leaves it out; an iPhone and Android 8 to 12
 *   never call it.
 * - `turnOnNotifications` end to end, against Android 13+ modelled flag by flag (expo-modules-core PermissionsService.kt
 *   216-240, 256-257; AOSP's "should show a reason" flag, on after one "Don't allow", off after the second, unmoved by a
 *   pop-up closed with no answer): every row of amend4 §3.2, each with an empty record, 1.4.7's `declined` and a `phoneNoAt`.
 *   The review's two probe rows (a 1.4.7 `declined`, Android's last pop-up) come first.
 * - Finding C: the real AppState watch, with a fake AppState that does or doesn't see the app leave the foreground.
 * - Finding B: one door to the phone's pop-up for notifications, the tool screen's included.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios', Version: 34 as number | string }));
/** AppState as the app sees it: listeners by event, and what fires while Android's pop-up is up. */
const appState = vi.hoisted(() => ({
    listeners: new Map<string, Set<(s?: string) => void>>(),
    emit(event: string, value?: string) { for (const fn of this.listeners.get(event) ?? []) fn(value); },
}));
/** React Native's permissions module: Android's own flag, or a module that throws or isn't there. */
const rnPermissions = vi.hoisted(() => ({ module: 'model' as 'model' | 'throws' | 'missing' | 'not boolean', calls: 0 }));
const alerts = vi.hoisted(() => ({ shown: 0 }));
vi.mock('react-native', () => ({
    Platform: platform,
    Alert: { alert: vi.fn(() => { alerts.shown += 1; }) },
    Linking: { openSettings: vi.fn(async () => {}) },
    AppState: {
        addEventListener: (event: string, fn: (s?: string) => void) => {
            if (!appState.listeners.has(event)) appState.listeners.set(event, new Set());
            appState.listeners.get(event)!.add(fn);
            return { remove: () => appState.listeners.get(event)?.delete(fn) };
        },
    },
    TurboModuleRegistry: {
        get: (name: string) => {
            if (name !== 'PermissionsAndroid' || rnPermissions.module === 'missing') return null;
            return {
                shouldShowRequestPermissionRationale: async (permission: string) => {
                    rnPermissions.calls += 1;
                    if (rnPermissions.module === 'throws') throw new Error('E_INVALID_ACTIVITY');
                    if (rnPermissions.module === 'not boolean') return null;
                    return permission === 'android.permission.POST_NOTIFICATIONS' ? android13.reason : false;
                },
            };
        },
    },
}));
const mem = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.set(k, v); }),
    },
}));
vi.mock('../identity', () => ({ loadIdentity: vi.fn(async () => null) }));
const asks = vi.hoisted(() => ({ count: 0 }));
/** Android 13+, flag by flag: asked (Expo's mark), allowed, Android's flag ("should show a reason"), and refusing for good. */
const android13 = vi.hoisted(() => ({ asked: false, granted: false, reason: false, refuses: false }));
type PopUp = 'allow' | "don't allow" | 'close';
const pending = vi.hoisted(() => ({ does: 'close' as 'allow' | "don't allow" | 'close' }));
function expoRead() {
    if (android13.granted) return { status: 'granted', canAskAgain: true };
    return { status: 'denied', canAskAgain: android13.asked ? android13.reason : true };
}
const notifications = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async (): Promise<{ status: string; canAskAgain: boolean }> => ({ status: 'denied', canAskAgain: true })),
    requestPermissionsAsync: vi.fn(async (): Promise<{ status: string; canAskAgain: boolean }> => ({ status: 'denied', canAskAgain: true })),
    setNotificationChannelAsync: vi.fn(async (): Promise<null> => null),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
}));
vi.mock('expo-notifications', () => ({ default: notifications, ...notifications }));
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: vi.fn(async () => null) }));

import { readAndroidSaidNoOnce, readNotificationPermissionRecord, readOsNotificationPermission, turnOnNotifications, type TurnOnResult } from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';
import { notifyAsks, notifyTurnOn } from '@beanpool/core';

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 21, 12, 0).getTime();

/** The pop-up as Android shows it: it leaves the app's foreground while up (AppState and focus), unless Android refuses. */
function ask(does: PopUp) {
    asks.count += 1;
    android13.asked = true;
    if (android13.refuses) return expoRead();
    appState.emit('change', 'background');
    appState.emit('blur');
    if (does === 'allow') android13.granted = true;
    else if (does === "don't allow") {
        if (android13.reason) { android13.refuses = true; android13.reason = false; } else android13.reason = true;
    }
    appState.emit('focus');
    appState.emit('change', 'active');
    return expoRead();
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    mem.clear();
    appState.listeners.clear();
    Object.assign(android13, { asked: false, granted: false, reason: false, refuses: false });
    Object.assign(platform, { OS: 'android', Version: 34 });
    rnPermissions.module = 'model';
    rnPermissions.calls = 0;
    asks.count = 0;
    alerts.shown = 0;
    notifications.getPermissionsAsync.mockImplementation(async () => expoRead());
    notifications.requestPermissionsAsync.mockImplementation(async () => ask(pending.does));
});

describe("the reader: Android 13+'s own flag, read live", () => {
    it('Android 13+: the flag passed on as it stands, off and on', async () => {
        expect(await readOsNotificationPermission()).toEqual({ available: true, granted: false, canAskAgain: true, cantAskNeedsRecord: true, saidNoOnce: false });
        Object.assign(android13, { asked: true, reason: true });
        expect(await readOsNotificationPermission()).toEqual({ available: true, granted: false, canAskAgain: true, cantAskNeedsRecord: true, saidNoOnce: true });
        expect(await readAndroidSaidNoOnce()).toBe(true);
    });

    for (const module of ['throws', 'missing', 'not boolean'] as const) {
        it(`Android 13+, the module ${module === 'throws' ? 'throws (no screen in front)' : module === 'missing' ? "isn't there" : 'answers no boolean'}: the flag left out, amend3 stands`, async () => {
            rnPermissions.module = module;
            Object.assign(android13, { asked: true, reason: true });
            const read = await readOsNotificationPermission();
            expect(read).toEqual({ available: true, granted: false, canAskAgain: true, cantAskNeedsRecord: true });
            expect('saidNoOnce' in read).toBe(false);
            expect(await readAndroidSaidNoOnce()).toBeUndefined();
        });
    }

    it('an iPhone and Android 8 to 12 never call it', async () => {
        for (const [OS, Version] of [['ios', '17.0'], ['android', 31], ['android', 32]] as const) {
            Object.assign(platform, { OS, Version });
            const read = await readOsNotificationPermission();
            expect(read.saidNoOnce, `${OS} ${Version}`).toBeUndefined();
            expect(read.cantAskNeedsRecord, `${OS} ${Version}`).toBeUndefined();
        }
        expect(rnPermissions.calls).toBe(0);
    });
});

type PhoneState = 'never asked' | 'said no once' | 'said no twice' | 'a pop-up closed before';
const STATES: Record<PhoneState, Partial<typeof android13>> = {
    'never asked': {},
    'said no once': { asked: true, reason: true },
    'said no twice': { asked: true, refuses: true },
    'a pop-up closed before': { asked: true },
};
const RECORDS: Record<string, object> = {
    'empty record': {},
    "1.4.7's declined": { state: 'declined', updatedAt: NOW - 5 * DAY },
    phoneNoAt: { phoneNoAt: NOW - 3 * DAY },
};
type Row = {
    state: PhoneState;
    record: string;
    does: PopUp;
    asked: boolean;
    result: TurnOnResult;
    /** What the record gains: the phone's no (phoneNoAt today), a Later (laterAt today), or nothing new. */
    gains: 'phone no' | 'later' | 'granted' | 'nothing';
    settingsLine: boolean;
};

const ROWS: Row[] = [
    // The review's two probes first: a 1.4.7 phone whose phone said no once, Android's last pop-up.
    { state: 'said no once', record: "1.4.7's declined", does: "don't allow", asked: true, result: 'declined', gains: 'phone no', settingsLine: false },
    { state: 'said no once', record: "1.4.7's declined", does: 'close', asked: true, result: 'unanswered', gains: 'nothing', settingsLine: false },
    ...Object.keys(RECORDS).flatMap((record): Row[] => [
        // Flag on before (row 2 between taps, whatever the record): Android's last pop-up.
        { state: 'said no once', record, does: 'allow', asked: true, result: 'granted', gains: 'granted', settingsLine: false },
        { state: 'said no once', record, does: "don't allow", asked: true, result: 'declined', gains: 'phone no', settingsLine: false },
        { state: 'said no once', record, does: 'close', asked: true, result: 'unanswered', gains: 'nothing', settingsLine: false },
    ]),
    // Flag off before, nothing of the phone's on record (row 4): the pop-up.
    ...['empty record', "1.4.7's declined"].flatMap((record): Row[] => [
        { state: 'never asked', record, does: 'allow', asked: true, result: 'granted', gains: 'granted', settingsLine: false },
        { state: 'never asked', record, does: "don't allow", asked: true, result: 'declined', gains: 'phone no', settingsLine: false },
        { state: 'never asked', record, does: 'close', asked: true, result: 'unanswered', gains: 'later', settingsLine: false },
        { state: 'a pop-up closed before', record, does: "don't allow", asked: true, result: 'declined', gains: 'phone no', settingsLine: false },
        { state: 'a pop-up closed before', record, does: 'close', asked: true, result: 'unanswered', gains: 'later', settingsLine: false },
        // Two nos we never heard: the pop-up never comes (amend4 §3.3; amend3's Settings line, nothing recorded).
        { state: 'said no twice', record, does: 'close', asked: true, result: 'unanswered', gains: 'nothing', settingsLine: true },
    ]),
    // Flag off before beside the phone's own no on record (row 3): final, the Settings line, no ask.
    ...(['never asked', 'said no twice', 'a pop-up closed before'] as const).map((state): Row => (
        { state, record: 'phoneNoAt', does: 'close', asked: false, result: 'unanswered', gains: 'nothing', settingsLine: true }
    )),
];

describe('amend4 §3.2 on the phone: turnOnNotifications reads the flag before the ask and hands core both', () => {
    for (const r of ROWS) {
        it(`${r.state} · ${r.record} · ${r.asked ? r.does : 'no pop-up asked'} → ${r.result}, ${r.gains}${r.settingsLine ? ', the Settings line' : ''}`, async () => {
            Object.assign(android13, STATES[r.state]);
            const before = RECORDS[r.record];
            mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(before));
            pending.does = r.does;
            const confirmSettings = vi.fn(async () => 'not_now' as const);
            const result = await turnOnNotifications(null, undefined, { confirmSettings });
            expect(result, 'what the tap answered').toBe(r.result);
            expect(asks.count, 'the pop-up asked').toBe(r.asked ? 1 : 0);
            expect(confirmSettings.mock.calls.length, 'the Settings line').toBe(r.settingsLine ? 1 : 0);
            const after = await readNotificationPermissionRecord();
            const was = before as { phoneNoAt?: number; laterAt?: number; state?: string };
            expect(after.phoneNoAt, 'phoneNoAt').toBe(r.gains === 'phone no' ? NOW : was.phoneNoAt);
            expect(after.laterAt, 'laterAt').toBe(r.gains === 'later' ? NOW : was.laterAt);
            expect(after.state, 'state').toBe(r.gains === 'granted' ? 'granted' : (was.state ?? 'unanswered'));
        });
    }

    it("the probe on a 1.4.7 phone, the day after: the final Don't allow stops every soft ask and the next tap opens Settings", async () => {
        Object.assign(android13, STATES['said no once']);
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(RECORDS["1.4.7's declined"]));
        pending.does = "don't allow";
        expect(await turnOnNotifications(null, undefined, { confirmSettings: async () => 'not_now' })).toBe('declined');
        const record = await readNotificationPermissionRecord();
        const phone = await readOsNotificationPermission();
        const day = notifyAsks({ record, phone, now: NOW + DAY, line: 'answer', live: true });
        expect([day.join, day.once, day.line, day.home]).toEqual([false, false, false, false]);
        expect(notifyTurnOn(phone, record)).toBe('settings');
    });

    it("the probe's other half: the last pop-up closed keeps the phone's one no; no soft ask, and the next tap brings it again", async () => {
        Object.assign(android13, STATES['said no once']);
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(RECORDS["1.4.7's declined"]));
        pending.does = 'close';
        expect(await turnOnNotifications(null, undefined, { confirmSettings: async () => 'not_now' })).toBe('unanswered');
        const record = await readNotificationPermissionRecord();
        const phone = await readOsNotificationPermission();
        const day = notifyAsks({ record, phone, now: NOW + DAY, line: 'answer', live: true });
        expect([day.join, day.once, day.line, day.home]).toEqual([false, false, false, false]);
        expect(notifyTurnOn(phone, record)).toBe('ask');
    });

    it('the flag unread (no screen in front): the tap reads as amend3 has it, nothing swaps where the record holds the first no', async () => {
        rnPermissions.module = 'throws';
        Object.assign(android13, STATES['said no once']);
        mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(RECORDS.phoneNoAt));
        pending.does = "don't allow";
        expect(await turnOnNotifications(null, undefined, { confirmSettings: async () => 'not_now' })).toBe('declined');
        expect((await readNotificationPermissionRecord()).phoneNoAt).toBe(NOW);
    });
});

/**
 * Finding C (N10 survived): the real watch, `watchAppForeground`, which every other test injects. Android's pop-up takes the
 * app out of the foreground (AppState `change` to background, the window's `blur`); a pop-up that never comes takes neither.
 */
describe("the real foreground watch: whether Android's pop-up came", () => {
    const run = async (fires: Array<[string, string?]>) => {
        Object.assign(android13, STATES['a pop-up closed before']);
        notifications.requestPermissionsAsync.mockImplementation(async () => {
            asks.count += 1;
            for (const [event, value] of fires) appState.emit(event, value);
            return expoRead();
        });
        const confirmSettings = vi.fn(async () => 'not_now' as const);
        const result = await turnOnNotifications(null, undefined, { confirmSettings });
        return { result, settingsLine: confirmSettings.mock.calls.length, record: await readNotificationPermissionRecord() };
    };

    it('the app goes to the background while the ask is out: the pop-up came and was closed, a Later', async () => {
        const r = await run([['change', 'background'], ['change', 'active']]);
        expect([r.result, r.settingsLine, r.record.laterAt]).toEqual(['unanswered', 0, NOW]);
    });

    it("only the window's focus goes: the pop-up came, a Later", async () => {
        const r = await run([['blur'], ['focus']]);
        expect([r.result, r.settingsLine, r.record.laterAt]).toEqual(['unanswered', 0, NOW]);
    });

    it('nothing fires: the pop-up never came, the Settings line, nothing recorded', async () => {
        const r = await run([]);
        expect([r.result, r.settingsLine, r.record.laterAt, r.record.phoneNoAt]).toEqual(['unanswered', 1, undefined, undefined]);
    });

    it("'active' alone is not leaving, and the watch lets go of AppState when the ask is done", async () => {
        const r = await run([['change', 'active']]);
        expect(r.settingsLine).toBe(1);
        expect([...appState.listeners.values()].every((set) => set.size === 0), 'every listener removed').toBe(true);
    });
});

/**
 * Finding B (N9 survived): one door to the phone's notifications pop-up, so every answer it gives is heard and kept. Outside
 * tests, expo-notifications' `requestPermissionsAsync` is called only by utils/notification-permission.ts and by
 * services/push-notifications.ts, whose ask (`registerForPushNotifications`) is called only by notification-permission.ts
 * once the phone already allows. The tool screen's own switch goes through `turnOnNotifications`.
 */
describe('one door to the pop-up, the tool screen included', () => {
    const ROOT = path.resolve(__dirname, '..', '..');
    const sources = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : sources(p);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
    });
    const files = ['app', 'components', 'tools', 'services', 'utils', 'modules'].filter((d) => fs.existsSync(path.join(ROOT, d))).flatMap((d) => sources(path.join(ROOT, d)));
    const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

    it("requestPermissionsAsync for notifications: only notification-permission.ts and push registration's ask", () => {
        const callers = files.filter((f) => /\brequestPermissionsAsync\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
        // contacts-import.ts asks expo-contacts for the address book, a permission of its own (at its own tap).
        expect(callers).toEqual(['services/push-notifications.ts', 'utils/contacts-import.ts', 'utils/notification-permission.ts']);
        expect(fs.readFileSync(path.join(ROOT, 'utils/contacts-import.ts'), 'utf8')).not.toMatch(/expo-notifications/);
    });

    it('push registration that asks is reached only from notification-permission.ts, after the phone allows', () => {
        const callers = files.filter((f) => /\bregisterForPushNotifications\s*\(/.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
        expect(callers).toEqual(['services/push-notifications.ts', 'utils/notification-permission.ts']);
        const src = fs.readFileSync(path.join(ROOT, 'utils/notification-permission.ts'), 'utf8');
        const calls = src.split('\n').filter((l) => /registerPushToken\(/.test(l) && !/function registerPushToken/.test(l));
        // Each follows a yes: the 'none' way (already allowed), a granted answer, or a turn-on seen in the phone's settings.
        expect(calls.length).toBe(3);
    });

    it("the tool screen's switch asks through turnOnNotifications and nothing else", () => {
        const src = fs.readFileSync(path.join(ROOT, 'app/tool/[id].tsx'), 'utf8');
        expect(src).toMatch(/const \{ turnOnNotifications \} = await import\('\.\.\/\.\.\/utils\/notification-permission'\);/);
        expect(src).toMatch(/await turnOnNotifications\(\)/);
        expect(src).not.toMatch(/requestPermissionsAsync/);
        expect(src).not.toMatch(/registerForPushNotifications/);
    });
});
