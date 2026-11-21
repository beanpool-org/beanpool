/**
 * Home's card while something is live and the fact line, on the phone's side (utils/notification-permission.ts offerHomeCard,
 * homeCardAway, turnOnFromHomeCard, offerFactLine; core's notifyAsks `home` and `fact`; amend2 §12.3 slice N3).
 *
 * Deciding either never asks the phone. A showing takes the day and is written once; × puts the card away for 30 days; the
 * fact line is marked when shown and says "Turn on ›" after the phone's no. Then the reviewer's three checks (amend2 §8):
 * no hard ask without a tap just before it; nothing here is a "Later" that is final; nothing raises another permission.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { localDay, type NotifyAskRecord } from '@beanpool/core';
import { homeCardAway, offerFactLine, offerHomeCard, turnOnFromHomeCard, type OsNotificationPermission } from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';

const DAY = 86_400_000;
const NOW = new Date(2026, 11, 1, 12, 0).getTime();
const ASK: OsNotificationPermission = { available: true, granted: false, canAskAgain: true };
const NO: OsNotificationPermission = { available: true, granted: false, canAskAgain: false };
const ON: OsNotificationPermission = { available: true, granted: true, canAskAgain: true };

const stored = (): NotifyAskRecord => JSON.parse(mem.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? '{}');
const store = (r: object) => mem.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(r));
const reads = (os: OsNotificationPermission) => async () => os;
const at = (t: number) => () => t;
/** The join's screen long ago: no once card, so the Home card's own rule is what is read. */
const JOINED = { joinAt: NOW - 60 * DAY };

beforeEach(() => {
    mem.clear();
    vi.clearAllMocks();
    platform.OS = 'ios';
});

describe("Home's card while something is live, on the phone", () => {
    it('something live, a phone that can still ask: shown, the day taken, and nothing asked of the phone', async () => {
        store(JOINED);
        expect(await offerHomeCard({ live: true, wayBack: false }, undefined, at(NOW), reads(ASK))).toBe(true);
        expect(stored()).toMatchObject({ askDay: localDay(new Date(NOW)), askKind: 'home' });
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it('a later landing the same day: shown again, nothing written', async () => {
        store({ ...JOINED, askDay: localDay(new Date(NOW)), askKind: 'home' });
        const before = mem.get(NOTIFICATION_PERMISSION_STORE_KEY);
        expect(await offerHomeCard({ live: true, wayBack: false }, undefined, at(NOW + 3_600_000), reads(ASK))).toBe(true);
        expect(mem.get(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(before);
    });

    for (const [why, o, os, record] of [
        ['nothing live', { live: false, wayBack: false }, ASK, JOINED],
        ['the way-back card is up', { live: true, wayBack: true }, ASK, JOINED],
        ["the phone's no", { live: true, wayBack: false }, NO, JOINED],
        ['on already', { live: true, wayBack: false }, ON, JOINED],
        ['a "Later" 3 days ago', { live: true, wayBack: false }, ASK, { ...JOINED, laterAt: NOW - 3 * DAY }],
        ['× 10 days ago', { live: true, wayBack: false }, ASK, { ...JOINED, homeAwayAt: NOW - 10 * DAY, homeAways: 1 }],
    ] as const) {
        it(`not shown: ${why}; nothing written`, async () => {
            store(record);
            const before = mem.get(NOTIFICATION_PERMISSION_STORE_KEY);
            expect(await offerHomeCard(o, undefined, at(NOW), reads(os))).toBe(false);
            expect(mem.get(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(before);
            expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
        });
    }

    it('× puts it away 30 days, counted; the third is for good (a "Later" is never written by it)', async () => {
        store(JOINED);
        await homeCardAway();
        expect(stored()).toMatchObject({ homeAways: 1, homeAwayAt: expect.any(Number) });
        expect(stored().laterAt).toBeUndefined();
        expect(stored().phoneNoAt).toBeUndefined();
    });

    it("Turn on is the phone's pop-up, and a yes is kept", async () => {
        notifications.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted', canAskAgain: true });
        expect(await turnOnFromHomeCard(null)).toBe('granted');
        expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
        expect(stored()).toMatchObject({ state: 'granted' });
    });
});

describe('the fact line, on the phone', () => {
    it('waited 2 days, a phone that can ask: its words, marked shown, nothing asked', async () => {
        store(JOINED);
        expect(await offerFactLine(2, undefined, at(NOW))).toEqual({ line: 'This waited 2 days for you.', link: 'Tell me next time ›' });
        expect(stored()).toMatchObject({ factAt: NOW, askKind: 'fact' });
        expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    });

    it("after the iPhone's Don't Allow: the line still shows, its link is Turn on ›", async () => {
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false });
        store(JOINED);
        expect(await offerFactLine(3, undefined, at(NOW))).toEqual({ line: 'This waited 3 days for you.', link: 'Turn on ›' });
        notifications.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true });
    });

    it('under a day, or shown 10 days ago: no line, nothing written', async () => {
        store(JOINED);
        expect(await offerFactLine(0, undefined, at(NOW))).toBeNull();
        store({ ...JOINED, factAt: NOW - 10 * DAY });
        const before = mem.get(NOTIFICATION_PERMISSION_STORE_KEY);
        expect(await offerFactLine(5, undefined, at(NOW))).toBeNull();
        expect(mem.get(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(before);
    });
});

describe("the reviewer's three checks (amend2 §8), for the Home card and the fact line", () => {
    const read = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', f), 'utf8');
    it('(1) the phone is asked only from a tap: the card and the line draw, and hand their taps on', () => {
        const card = read('components/home/NotifyHomeCard.tsx');
        expect(card).not.toMatch(/requestPermissionsAsync|turnOnNotifications|notification-permission/);
        // Home's Turn on is the card's onTurnOn, and only it calls the door.
        const home = read('app/(tabs)/index.tsx');
        expect(home.match(/turnOnFromHomeCard\(/g)).toHaveLength(1);
        expect(home).toMatch(/const homeTurnOn = useCallback\(\(\) => \{\s*setHomeBusy\(true\);\s*void turnOnFromHomeCard\(/);
    });
    it('(2) nothing on the card or the line is a final "Later": × is 30 days, and the record keeps no no from it', () => {
        // No Later or Not now button of its own (the render test: none drawn), and nothing on it writes a "Later".
        expect(read('components/home/NotifyHomeCard.tsx')).not.toMatch(/onLater|notificationsLater|markNotificationAsk/);
    });
    it('(3) nothing here raises another permission', () => {
        for (const f of ['components/home/NotifyHomeCard.tsx', 'components/NotifyLine.tsx']) {
            expect(read(f)).not.toMatch(/Camera|Location|Contacts|MediaLibrary|requestForegroundPermissions/);
        }
    });
});
