/**
 * Slice N2a (DESIGN-notify-and-backup-asks-fable-amend2.md §6, §12.3): the named line at the member's own moment, as the
 * phone decides it (utils/notification-permission.ts offerNamedLine: this phone's record, read from its key, and the
 * phone's own answer, through core's rule).
 *
 * One table: (moment) × (never asked, Later today on the join's screen, Later today on Home's once card, Later yesterday, an
 * older app's "Not now", the phone said no on Android, the phone said no on an iPhone, allowed, Android 8 to 12, nothing to
 * turn on) → the line shown or not. In every row the old pop-up is never shown and the phone's own pop-up never comes:
 * offering asks nothing; only a tap on Tell me does (turnOnNotifications, its own suite). A shown line takes the day.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NOTIFY_LINE_KINDS, localDay, type NotifyLineKind } from '@beanpool/core';

const rn = vi.hoisted(() => ({ alert: vi.fn(), openSettings: vi.fn(async () => {}) }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' }, Alert: { alert: rn.alert }, Linking: { openSettings: rn.openSettings } }));

const mem = vi.hoisted(() => ({ map: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (k: string) => mem.map.get(k) ?? null),
        setItem: vi.fn(async (k: string, v: string) => { mem.map.set(k, v); }),
    },
}));

/** The phone's own answer: null = notifications can't be had here (its read fails, as on a build without them). */
const phone = vi.hoisted(() => ({ now: null as null | { status: string; canAskAgain: boolean } }));
const notif = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => { if (!phone.now) throw new Error('no notifications on this build'); return phone.now; }),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
}));
vi.mock('expo-notifications', () => ({ default: notif, ...notif }));
vi.mock('../../services/push-notifications', () => ({ registerForPushNotifications: vi.fn(async () => null) }));

import { offerNamedLine, readNotificationPermissionRecord } from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Local noon, so today and yesterday are the same days in every time zone. */
const NOW = new Date(2026, 10, 21, 12, 0).getTime();
const TODAY = localDay(new Date(NOW));
const YESTERDAY = localDay(new Date(NOW - DAY));

const ASK = { status: 'undetermined', canAskAgain: true };
const ANDROID_NO = { status: 'denied', canAskAgain: true };
const IPHONE_NO = { status: 'denied', canAskAgain: false };
const ON = { status: 'granted', canAskAgain: true };

const MOMENTS: Record<NotifyLineKind, string> = {
    answer: 'a first message sent',
    again: 'a first message read, or a request accepted',
    listing: 'a first listing',
    offer: 'a first offer or request on a listing',
    join: 'an ask to join',
};

/** [state, what the phone says, what this phone's record holds (as stored), shown?] */
const STATES: Array<[string, typeof ASK | null, Record<string, unknown> | null, boolean]> = [
    ['never asked', ASK, null, true],
    ["Later today on the join's screen (its day still allows one line)", ASK, { state: 'unanswered', updatedAt: 0, askDay: TODAY, askKind: 'join', joinAt: NOW - 2 * HOUR, laterAt: NOW - HOUR }, true],
    ["Later today on Home's once card (the day is taken)", ASK, { state: 'unanswered', updatedAt: 0, askDay: TODAY, askKind: 'once', onceAt: NOW - 2 * HOUR, onceClosedAt: NOW - HOUR, laterAt: NOW - HOUR }, false],
    ['Later yesterday', ASK, { state: 'unanswered', updatedAt: 0, askDay: YESTERDAY, askKind: 'join', joinAt: NOW - DAY, laterAt: NOW - DAY }, true],
    ["an older app's Not now (read as a Later)", ASK, { state: 'declined', updatedAt: NOW - 20 * DAY }, true],
    ["the phone said no (Android's first no, recorded)", ANDROID_NO, { state: 'unanswered', updatedAt: 0, phoneNoAt: NOW - DAY }, false],
    ["the phone said no (an iPhone's Don't Allow)", IPHONE_NO, null, false],
    ['allowed through one of our asks', ON, { state: 'granted', updatedAt: NOW - DAY }, false],
    ['Android 8 to 12 (allowed without asking)', ON, null, false],
    ['nothing to turn on here', null, null, false],
];

beforeEach(() => {
    mem.map.clear();
    rn.alert.mockClear();
    rn.openSettings.mockClear();
    notif.requestPermissionsAsync.mockClear();
    phone.now = ASK;
});

const stored = () => JSON.parse(mem.map.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? 'null');

describe('the named line at the member\'s own moment, as the phone decides it (slice N2a)', () => {
    for (const kind of NOTIFY_LINE_KINDS) {
        for (const [state, said, record, shown] of STATES) {
            it(`${MOMENTS[kind]} × ${state}: ${shown ? 'shown' : 'not shown'}; the old pop-up never`, async () => {
                phone.now = said;
                if (record) mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
                const before = mem.map.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? null;

                expect(await offerNamedLine(kind, undefined, () => NOW)).toBe(shown);

                // Offering asks nothing: no pop-up of ours, not the phone's, not its settings.
                expect(rn.alert).not.toHaveBeenCalled();
                expect(notif.requestPermissionsAsync).not.toHaveBeenCalled();
                expect(rn.openSettings).not.toHaveBeenCalled();
                if (shown) {
                    // Shown: it takes the day, and its kind is spent on this phone; the rest of the record is kept.
                    expect(stored()).toMatchObject({ ...(record ?? {}), askDay: TODAY, askKind: 'line', lines: [kind] });
                    expect(await offerNamedLine(kind, undefined, () => NOW + HOUR)).toBe(false);
                    const other = NOTIFY_LINE_KINDS.find((k) => k !== kind)!;
                    expect(await offerNamedLine(other, undefined, () => NOW + HOUR)).toBe(false);
                } else {
                    // Not shown: nothing written.
                    expect(mem.map.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? null).toBe(before);
                }
            });
        }
    }

    it('a kind shown before stays spent; another kind may show on another day', async () => {
        mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'unanswered', updatedAt: 0, askDay: YESTERDAY, askKind: 'line', lines: ['answer'] }));
        expect(await offerNamedLine('answer', undefined, () => NOW)).toBe(false);
        expect(await offerNamedLine('join', undefined, () => NOW)).toBe(true);
        expect((await readNotificationPermissionRecord()).lines).toEqual(['answer', 'join']);
    });

    it('a record that cannot be read is a new phone: the line shows, and nothing throws', async () => {
        mem.map.set(NOTIFICATION_PERMISSION_STORE_KEY, '{not json');
        expect(await offerNamedLine('listing', undefined, () => NOW)).toBe(true);
    });

    it('a storage that fails: no line, and nothing throws', async () => {
        const broken = { getItem: async () => null, setItem: async () => { throw new Error('disk full'); } };
        expect(await offerNamedLine('offer', broken, () => NOW)).toBe(false);
        // The next decision still runs (the queue is not stuck on the failure).
        expect(await offerNamedLine('offer', undefined, () => NOW)).toBe(true);
    });
});
