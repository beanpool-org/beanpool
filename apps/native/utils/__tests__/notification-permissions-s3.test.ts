/**
 * Front doors S3: notification permission at the tap, never at account creation (Fable design §0, §1.9, §3.9, §7), as
 * notifications amendment 2 changes it (DESIGN-notify-and-backup-asks-fable-amend2.md §6, §8, slice N1; Marty 21 Nov 2026).
 *
 * Requirements:
 * - No requestPermissionsAsync in the identity effect (app/_layout.tsx:769-772 removed).
 * - The phone's pop-up only after a tap on one of our asks.
 * - The record keeps "Later" and the phone's "no" apart, with dates. "Not now" is a "Later": never final. An older
 *   app's "Not now" ('declined') reads as a "Later", and nothing stored is rewritten.
 * - First steps' line stays through a "Later" and leaves after the phone's "no".
 * - No pop-up of ours at the first post, message or ask to join (slice N2a): a named line at the member's own act
 *   instead (offerNamedLine, by core's rule; its own table is notify-named-lines.test.ts). Nothing after the phone's "no".
 * - Words of the one line before the phone's settings open: "Turn on notifications?" · "Not now" · "Open Settings";
 *   "Turn on" on the bell's line.
 * - Nothing asked by a restore itself (it lands on Home; asks come at a tap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: {
        alert: vi.fn(),
    },
    Linking: {
        openSettings: vi.fn(async () => {}),
    },
}));

const mem = vi.hoisted(() => ({
    async: new Map<string, string>(),
    secure: new Map<string, string>(),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
    default: {
        getItem: vi.fn(async (key: string) => mem.async.get(key) ?? null),
        setItem: vi.fn(async (key: string, value: string) => { mem.async.set(key, value); }),
        removeItem: vi.fn(async (key: string) => { mem.async.delete(key); }),
        getAllKeys: vi.fn(async () => [...mem.async.keys()]),
        multiRemove: vi.fn(async (keys: string[]) => { keys.forEach((k) => mem.async.delete(k)); }),
    },
}));

const identityMock = vi.hoisted(() => ({
    loadIdentity: vi.fn(async () => null as { publicKey: string; privateKey: string } | null),
}));
vi.mock('../identity', () => identityMock);

const notificationsMock = vi.hoisted(() => ({
    getPermissionsAsync: vi.fn(async () => ({ status: 'undetermined' })),
    requestPermissionsAsync: vi.fn(async () => ({ status: 'granted' })),
    getExpoPushTokenAsync: vi.fn(async () => ({ data: 'ExponentPushToken[test-token]' })),
    setNotificationChannelAsync: vi.fn(async () => {}),
    AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3, LOW: 2, MIN: 1, NONE: 0 },
}));

vi.mock('expo-notifications', () => ({
    default: notificationsMock,
    ...notificationsMock,
}));

const pushServiceMock = vi.hoisted(() => ({
    registerForPushNotifications: vi.fn(async () => 'ExponentPushToken[test-token]'),
}));

vi.mock('../../services/push-notifications', () => pushServiceMock);

import {
    NOTIFICATION_CARD_WORDS,
    readNotificationPermissionRecord,
    writeNotificationPermissionRecord,
    markNotificationAsk,
    turnOnNotifications,
    notificationsLater,
    offerNamedLine,
    NOTIFICATIONS_OFF_IN_SETTINGS,
    registerWhenNotificationsAllowed,
    notificationsOffHere,
    notifyStep,
    readOsNotificationPermission,
    type NotificationPermissionRecord,
} from '../notification-permission';
import { NOTIFICATION_PERMISSION_STORE_KEY } from '../storage-keys';
import { notifyAsks } from '@beanpool/core';

/** What core's rule says this phone may draw now, from its record and its own state. */
const asksNow = async (extra: { line?: string; live?: boolean; waited?: boolean } = {}) =>
    notifyAsks({ record: await readNotificationPermissionRecord(), phone: await readOsNotificationPermission(), now: Date.now(), ...extra });
/** First steps' line as Home reads it today (`notifyStep`; slice N1h hides it while the once card is up). */
const stepNow = async () => notifyStep(await readNotificationPermissionRecord(), await readOsNotificationPermission());
/** Our record as stored, raw. */
const stored = () => JSON.parse(mem.async.get(NOTIFICATION_PERMISSION_STORE_KEY) ?? 'null');

describe('S3: notification permission at the tap, never at account creation', () => {
    beforeEach(() => {
        mem.async.clear();
        mem.secure.clear();
        vi.clearAllMocks();
        notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'undetermined' } as any);
        notificationsMock.requestPermissionsAsync.mockResolvedValue({ status: 'granted' } as any);
    });

    describe('no requestPermissionsAsync in the identity effect', () => {
        it('_layout.tsx must not register for push notifications or call requestPermissionsAsync on identity set', () => {
            const layoutPath = path.resolve(__dirname, '../../app/_layout.tsx');
            const layoutSource = fs.readFileSync(layoutPath, 'utf8');

            // The old effect at lines 769-772 registered for push notifications as soon as identity.publicKey existed.
            // S3 requires removing this effect so nothing is prompted at account set.
            const hasIdentityPushEffect = /useEffect\(\s*\(\)\s*=>\s*\{[^}]*registerForPushNotifications\(identity\.publicKey\)[^}]*\}\s*,\s*\[\s*identity\?\.publicKey\s*\]\s*\)/.test(layoutSource);
            expect(hasIdentityPushEffect).toBe(false);
        });
    });

    describe("the card's state machine", () => {
        it('starts in unanswered state on a fresh install, and the rule lets the join or Home ask once', async () => {
            const record = await readNotificationPermissionRecord();
            expect(record).toEqual({ state: 'unanswered', updatedAt: 0 });
            expect(await asksNow()).toMatchObject({ join: true, once: true, bell: true });
        });

        it('asks nothing if OS permission was already granted', async () => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            expect(await asksNow({ line: 'answer', live: true, waited: true })).toEqual({
                join: false, once: false, line: false, home: false, fact: false, firstSteps: null, bell: false,
            });
        });

        it('tapping Turn on requests permission, records granted state, and registers push token', async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('test-pubkey');

            const updated = await readNotificationPermissionRecord();
            expect(updated.state).toBe('granted');
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            expect(await asksNow()).toMatchObject({ join: false, once: false, firstSteps: true });
        });

        it('tapping Turn on without publicKey falls back to stored identity', async () => {
            identityMock.loadIdentity.mockResolvedValueOnce({ publicKey: 'stored-pubkey', privateKey: 'pk' });
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications();
            expect(result).toBe('granted');
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('stored-pubkey');
        });

        it("tapping Turn on when the phone says no records the phone's no with its date, and registers no token", async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);

            const before = Date.now();
            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('declined');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).not.toHaveBeenCalled();

            const updated = await readNotificationPermissionRecord();
            expect(updated.phoneNoAt).toBeGreaterThanOrEqual(before);
            expect(updated.laterAt).toBeUndefined();
            expect(updated.state).toBe('unanswered');
            // Android can still ask once more (canAskAgain), but nothing of ours asks: only the bell's line and Settings stay.
            expect(await asksNow({ line: 'answer', live: true })).toMatchObject({ join: false, once: false, line: false, home: false, firstSteps: null, bell: true });
        });

        for (const [what, answer] of [['closes with no answer', { status: 'undetermined' }], ['fails', null]] as const) {
            it(`the phone's pop-up ${what}: a Later, never a no`, async () => {
                if (answer) notificationsMock.requestPermissionsAsync.mockResolvedValueOnce(answer as any);
                else notificationsMock.requestPermissionsAsync.mockRejectedValueOnce(new Error('no answer'));
                expect(await turnOnNotifications('test-pubkey')).toBe('unanswered');
                const rec = await readNotificationPermissionRecord();
                expect(rec.phoneNoAt).toBeUndefined();
                expect(rec.laterAt).toEqual(expect.any(Number));
                expect(notifyStep(rec, await readOsNotificationPermission())).toBe(false);
            });
        }

        it('Later is recorded with its date, not as a no; First steps keeps its line', async () => {
            const before = Date.now();
            await notificationsLater();

            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(record.laterAt).toBeGreaterThanOrEqual(before);
            expect(record.phoneNoAt).toBeUndefined();
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            expect(await stepNow()).toBe(false);
        });

        it('Later on the once card also puts the card away; the rest of the record is kept', async () => {
            await writeNotificationPermissionRecord({ state: 'unanswered', updatedAt: 0, lines: ['answer'], onceAt: Date.now() - 1000 });
            await notificationsLater(undefined, 'once');
            const rec = await readNotificationPermissionRecord();
            expect(rec).toMatchObject({ lines: ['answer'], onceClosedAt: rec.laterAt });
            expect((await asksNow()).once).toBe(false);
        });

        it('after restore, nothing is asked automatically; the record is unanswered until a tap', async () => {
            // A restored account has no prior local permission record on this phone
            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            // The rule's once card is for it (drawn by slice N1h); nothing here asks by itself.
            expect((await asksNow()).once).toBe(true);

            // A tap on Turn on (First steps' line, the bell's line) asks for permission
            await turnOnNotifications('restored-pubkey');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect((await readNotificationPermissionRecord()).state).toBe('granted');
        });

        // Amendment 2 §6 (Marty, 21 Nov 2026) reverses 13 Nov's pick 3: a "Not now" is a "Later", never final. Slice N2a: the
        // pop-up at the first post, message and ask to join is gone; a named line at the member's own act takes its place.
        for (const kind of ['answer', 'listing', 'join'] as const) {
            it(`after a Later yesterday a named line still shows (${kind}), and showing it asks nothing`, async () => {
                await writeNotificationPermissionRecord({ state: 'unanswered', updatedAt: 0, laterAt: Date.now() - 86_400_000 });
                expect(await offerNamedLine(kind)).toBe(true);
                expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
                expect((await import('react-native')).Alert.alert).not.toHaveBeenCalled();
                expect(await readNotificationPermissionRecord()).toMatchObject({ lines: [kind], askKind: 'line' });
            });

            it(`after the phone's no nothing of ours asks: no named line (${kind}), nothing shown, nothing written`, async () => {
                notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);
                await turnOnNotifications('test-pubkey');
                notificationsMock.requestPermissionsAsync.mockClear();
                const before = stored();
                expect(await offerNamedLine(kind)).toBe(false);
                expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
                expect((await import('react-native')).Alert.alert).not.toHaveBeenCalled();
                expect(stored()).toEqual(before);
            });
        }

        it('each kind once, and one named line a day: the second kind waits for another day', async () => {
            expect(await offerNamedLine('answer')).toBe(true);
            expect(await offerNamedLine('answer')).toBe(false);
            expect(await offerNamedLine('listing')).toBe(false);
            const rec = await readNotificationPermissionRecord();
            await writeNotificationPermissionRecord({ ...rec, askDay: '2026-01-01' });
            expect(await offerNamedLine('answer')).toBe(false);
            expect(await offerNamedLine('listing')).toBe(true);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });

        it('two screens offering at once: one decision at a time, so only one takes the day', async () => {
            const got = await Promise.all([offerNamedLine('answer'), offerNamedLine('join'), offerNamedLine('listing')]);
            expect(got.filter(Boolean)).toHaveLength(1);
            expect((await readNotificationPermissionRecord()).lines).toHaveLength(1);
        });

        it('if already granted, no named line asks', async () => {
            await turnOnNotifications('test-pubkey');
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            notificationsMock.requestPermissionsAsync.mockClear();
            for (const kind of ['answer', 'again', 'listing', 'offer', 'join'] as const) expect(await offerNamedLine(kind)).toBe(false);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });
    });

    // #2524 deciding review, finding 2: every Android 8–12 phone, and every member who allowed the old boot prompt, has a
    // phone that already allows notifications while this record is new (unanswered). They are never asked; the token is
    // registered at start and on each return (registerWhenNotificationsAllowed, below), not at a first post or message.
    describe('the phone already allows notifications', () => {
        for (const state of ['unanswered', 'declined'] as const) {
            it(`record ${state}: no named line, nothing asked, the record's state not rewritten`, async () => {
                // 'declined': an older app's record of its "Not now", as that app stored it.
                if (state === 'declined') mem.async.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'declined', updatedAt: 5 }));
                notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
                for (const kind of ['answer', 'again', 'listing', 'offer', 'join'] as const) expect(await offerNamedLine(kind)).toBe(false);
                expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
                expect((await readNotificationPermissionRecord()).state).toBe(state);
            });
        }

        // A Later is never a no: it writes its date and nothing else, whatever the phone says.
        for (const status of ['granted', 'denied'] as const) {
            it(`Later stores its date and never 'declined' (phone: ${status})`, async () => {
                notificationsMock.getPermissionsAsync.mockResolvedValue({ status, canAskAgain: true } as any);
                await notificationsLater();
                expect(stored()).toEqual({ state: 'unanswered', updatedAt: 0, laterAt: expect.any(Number) });
            });
        }
    });

    // Slice N1: no conversion code. The record keeps its key and gains fields; an older app's record is read as it is.
    describe("the phone's record across versions", () => {
        it("an older app's \"Not now\" reads as a Later: First steps' line comes back, and the once card is for it", async () => {
            mem.async.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'declined', actionAsked: false, updatedAt: 1_700_000_000_000 }));
            const rec = await readNotificationPermissionRecord();
            expect(rec).toEqual({ state: 'declined', updatedAt: 1_700_000_000_000 });
            expect(notifyStep(rec, await readOsNotificationPermission())).toBe(false);
            expect(await asksNow({ line: 'answer' })).toMatchObject({ once: true, join: true, line: true });
            // Read, never rewritten: the stored text is the older app's.
            expect(stored()).toEqual({ state: 'declined', actionAsked: false, updatedAt: 1_700_000_000_000 });
        });

        // The old pop-up's once-in-all mark (`actionAsked`, slice N1) is read by nothing since N2a: an event keeps every field
        // of the record and leaves that one out. Nothing reads it, so nothing moves.
        it('an event adds its own fields and keeps the record\'s own', async () => {
            mem.async.set(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify({ state: 'declined', actionAsked: true, updatedAt: 5, laterAt: 4, lines: ['join'] }));
            await markNotificationAsk({ type: 'shown', surface: 'line', line: 'answer' });
            expect(stored()).toMatchObject({ state: 'declined', updatedAt: 5, laterAt: 4, lines: ['join', 'answer'], askKind: 'line' });
            expect(stored()).not.toHaveProperty('actionAsked');
        });

        for (const junk of ['not json', '"text"', '42', 'null', '[1,2]', '{"state":"maybe","laterAt":"soon","lines":"answer"}']) {
            it(`unreadable or odd storage is a new record: ${junk}`, async () => {
                mem.async.set(NOTIFICATION_PERMISSION_STORE_KEY, junk);
                expect(await readNotificationPermissionRecord()).toEqual({ state: 'unanswered', updatedAt: 0 });
            });
        }
    });

    // #2524 deciding review, finding 3: once the phone won't show its dialog again (iOS after Don't Allow, Android 13+
    // after a second denial, notifications off in the phone's settings), requestPermissionsAsync returns "denied" with
    // nothing shown. Turn on then says why in one line and opens BeanPool's page in the phone's settings.
    describe("the phone won't ask again (canAskAgain: false)", () => {
        beforeEach(() => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false } as any);
            notificationsMock.requestPermissionsAsync.mockResolvedValue({ status: 'denied', canAskAgain: false } as any);
        });

        it("Turn on gives the one-line reason, then opens the phone's settings; nothing is recorded", async () => {
            const confirmSettings = vi.fn(async () => 'turn_on' as const);
            const openSettings = vi.fn(async () => {});

            const res = await turnOnNotifications('test-pubkey', undefined, { confirmSettings, openSettings });

            expect(res).toBe('settings');
            expect(confirmSettings).toHaveBeenCalledTimes(1);
            expect(openSettings).toHaveBeenCalledTimes(1);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            expect(mem.async.has(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(false);
            // The phone said no: no ask of ours, First steps' line gone, the bell's line and the fact line stay.
            expect(await asksNow({ live: true, waited: true })).toEqual({
                join: false, once: false, line: false, home: false, fact: true, firstSteps: null, bell: true,
            });
        });

        it('the default Turn on shows the reason in an Alert, and its Open Settings opens Linking.openSettings', async () => {
            const rn = await import('react-native');
            const alert = vi.mocked(rn.Alert.alert);
            alert.mockImplementationOnce((_title, _body, buttons) => { buttons?.[1]?.onPress?.(); });

            const res = await turnOnNotifications('test-pubkey');

            expect(res).toBe('settings');
            expect(alert).toHaveBeenCalledTimes(1);
            const [title, body, buttons] = alert.mock.calls[0];
            expect(title).toBe('Turn on notifications?');
            expect(body).toBe(NOTIFICATIONS_OFF_IN_SETTINGS);
            expect(buttons?.map((b) => b.text)).toEqual(['Not now', 'Open Settings']);
            expect(rn.Linking.openSettings).toHaveBeenCalledTimes(1);
            expect((await readNotificationPermissionRecord()).state).toBe('unanswered');
        });

        it("Not now at that line records nothing and opens nothing: the phone's no already stands", async () => {
            const openSettings = vi.fn(async () => {});
            const res = await turnOnNotifications('test-pubkey', undefined, {
                confirmSettings: vi.fn(async () => 'not_now' as const), openSettings,
            });
            expect(res).toBe('unanswered');
            expect(openSettings).not.toHaveBeenCalled();
            expect(mem.async.has(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(false);
        });

        it('once the phone allows them, nothing asks (back from settings)', async () => {
            await turnOnNotifications('test-pubkey', undefined, { confirmSettings: async () => 'turn_on', openSettings: async () => {} });
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'granted', canAskAgain: true } as any);
            expect(await asksNow({ line: 'answer', live: true, waited: true })).toEqual({
                join: false, once: false, line: false, home: false, fact: false, firstSteps: null, bell: false,
            });
        });

        // Amendment 2 §6: after the phone's no, nothing of ours raises it, and we never put the phone's settings in front of
        // anyone by ourselves; the bell's line opens them at the member's own tap. The old pop-up used to say "off in settings".
        it('no named line: nothing shown, no settings opened, nothing written', async () => {
            const rn = await import('react-native');
            for (const kind of ['answer', 'again', 'listing', 'offer', 'join'] as const) expect(await offerNamedLine(kind)).toBe(false);
            expect(rn.Alert.alert).not.toHaveBeenCalled();
            expect(rn.Linking.openSettings).not.toHaveBeenCalled();
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
            expect(mem.async.has(NOTIFICATION_PERMISSION_STORE_KEY)).toBe(false);
        });

        it("while the phone can still ask, the named line shows, and showing it shows nothing of the phone's", async () => {
            notificationsMock.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', canAskAgain: true } as any);
            const rn = await import('react-native');
            expect(await offerNamedLine('answer')).toBe(true);
            expect(rn.Alert.alert).not.toHaveBeenCalled();
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });
    });

    // #2524 deciding review, finding 4, as slice N2a ends it: every DM start passes createConversationApi, which now asks
    // nothing; the named line comes under the first message sent, in the chat. No screen or util raises the phone's pop-up
    // but turnOnNotifications, which only a tap calls.
    describe('no pop-up of ours at a first post, message or ask to join (slice N2a)', () => {
        const root = path.resolve(__dirname, '../..');
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
            return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
        });
        const sources = ['app', 'components', 'utils', 'services', 'tools'].flatMap((d) => walk(path.join(root, d)));
        const read = (f: string) => fs.readFileSync(f, 'utf8');

        it('createConversationApi is the only place a DM is made, and it asks nothing about notifications', () => {
            const makers = sources.filter((f) => /\/api\/messages\/conversation[`'"]/.test(read(f)));
            expect(makers.map((f) => path.relative(root, f))).toEqual(['utils/db.ts']);
            const db = read(path.join(root, 'utils/db.ts'));
            const start = db.indexOf('export async function createConversationApi(');
            const body = db.slice(start, db.indexOf('\n}\n', start));
            expect(body.length).toBeGreaterThan(200);
            expect(body).not.toMatch(/import\(['"]\.\/notification-permission|askNotification|turnOnNotifications|requestPermissionsAsync/);
            // Nor at a post: db.ts loads nothing of notifications at all.
            expect(db).not.toMatch(/import[^\n]*notification-permission/);
        });

        it('every DM start in the app goes through createConversationApi', () => {
            const starts = sources.filter((f) => /createConversationApi\('dm'/.test(read(f)))
                .map((f) => path.relative(root, f)).sort();
            // The starts the deciding review counted (post/[id] has six of them).
            expect(starts).toEqual(expect.arrayContaining([
                'app/(tabs)/people.tsx', 'app/new-message.tsx', 'app/post/[id].tsx', 'app/public-profile.tsx',
                'app/shop/[id].tsx', 'app/treasury-detail.tsx',
            ]));
        });

        it('the old pop-up and its callers are gone: nothing names it, and an ask to join asks nothing before it goes', () => {
            expect(sources.filter((f) => /askNotificationPermissionOnAction|defaultAlertPrompt|ActionPromptOptions/.test(read(f))).map((f) => path.relative(root, f))).toEqual([]);
            for (const screen of ['app/find-community.tsx', 'app/community-card.tsx']) {
                const src = read(path.join(root, screen));
                const start = src.indexOf('const send = async');
                const send = src.slice(start, src.indexOf('sendKnock(', start));
                expect(send.length, screen).toBeGreaterThan(100);
                expect(send, screen).not.toMatch(/otification|offer\(/);
            }
        });

        it("only turnOnNotifications raises the phone's pop-up for notifications", () => {
            const src = read(path.join(root, 'utils/notification-permission.ts'));
            expect(src.match(/requestPermissionsAsync\(/g)).toHaveLength(1);
            const turnOn = src.slice(src.indexOf('export async function turnOnNotifications('), src.indexOf('export async function notificationsLater('));
            expect(turnOn).toContain('requestPermissionsAsync(');
            // Contacts, the camera and the rest have their own asks at their own taps; this is about notifications only.
            const elsewhere = sources.filter((f) => /\bnotif\w*\??\.requestPermissionsAsync\(/i.test(read(f))
                && !f.endsWith(`${path.sep}utils${path.sep}notification-permission.ts`)
                && !f.endsWith(`${path.sep}services${path.sep}push-notifications.ts`));
            expect(elsewhere.map((f) => path.relative(root, f))).toEqual([]);
        });
    });

    // #2524 deciding review, non-blocking polish.
    describe('the cards read right and take one tap at a time', () => {
        const root = path.resolve(__dirname, '../..');
        const welcome = fs.readFileSync(path.join(root, 'app/welcome.tsx'), 'utf8');
        const card = welcome.slice(welcome.indexOf('testID="guide-notification-card"'), welcome.indexOf('testID="guide-notification-not-now"') + 40);
        const home = fs.readFileSync(path.join(root, 'app/(tabs)/index.tsx'), 'utf8');
        const bellLine = fs.readFileSync(path.join(root, 'components/NotificationsOffLine.tsx'), 'utf8');

        // How it Works left the join in slice S5 (DESIGN-onboarding-home-landing-fable.md §2: "Turn on notifications?" became
        // First steps' "Hear when someone answers you", asked at that tap), and its card went with it: the join asks nothing.
        it("How it Works' card left the join with How it Works: no notification card in the join, and nothing asked there", () => {
            expect(welcome).not.toContain('testID="guide-notification-card"');
            expect(welcome).not.toContain('setNotifVisible');
            expect(welcome).not.toMatch(/turnOnNotifications\(|notificationsLater\(|requestPermissionsAsync/);
            expect(card).toBe('');
        });

        // DESIGN-home-default-fable.md §2.5 (Marty's pick 3): no card at the top of Home; the card component is gone.
        it('Home draws no notifications card', () => {
            // No card and no card rule; the phone's own question only at First steps' tap (turnOnNotifications in onStep).
            expect(home).not.toMatch(/NotificationPermissionCard|shouldShowNotificationCard|notificationsLater|markNotificationAsk/);
            expect(home.match(/turnOnNotifications\(/g)).toHaveLength(1);
            // Through the one-tap guard (utils/one-ask.ts, max re-check of #3340): a double tap is one ask.
            expect(home).toMatch(/else if \(step === 'notify'\) \{\s*void notifyAsk\(\(\) => turnOnNotifications\(/);
            expect(fs.existsSync(path.join(root, 'components/NotificationPermissionCard.tsx'))).toBe(false);
        });

        it("the bell's line: Turn on says it is busy, and shows only where notifications can load and are off", () => {
            expect(bellLine).toContain('accessibilityState={{ busy, disabled: busy }}');
            expect(notificationsOffHere({ available: true, granted: false, canAskAgain: true })).toBe(true);
            expect(notificationsOffHere({ available: true, granted: false, canAskAgain: false })).toBe(true);
            expect(notificationsOffHere({ available: true, granted: true, canAskAgain: true })).toBe(false);
            expect(notificationsOffHere({ available: false, granted: false, canAskAgain: false })).toBe(false);
        });


        // §2.4: First steps' line "Hear when someone answers you", from this phone alone; amendment 2 §6: it stays through a
        // Later and leaves after the phone's no.
        it("First steps' notifications line: on a phone that has to ask, through a Later; ticked when allowed through it; gone after the phone's no", () => {
            const os = (granted: boolean, available = true, canAskAgain = true) => ({ available, granted, canAskAgain });
            const rec = (state: NotificationPermissionRecord['state'], more: Partial<NotificationPermissionRecord> = {}): NotificationPermissionRecord => ({ state, updatedAt: 1, ...more });
            expect(notifyStep(rec('unanswered'), os(false))).toBe(false);
            expect(notifyStep(rec('granted'), os(true))).toBe(true);
            // Android 8 to 12: allowed without asking, so no line at all.
            expect(notifyStep(rec('unanswered'), os(true))).toBeNull();
            // A Later, and an older app's Not now: the line stays.
            expect(notifyStep(rec('unanswered', { laterAt: 5 }), os(false))).toBe(false);
            expect(notifyStep(rec('declined'), os(false))).toBe(false);
            // The phone's no, recorded (Android could still ask once more) or read from the phone (an iPhone's Don't Allow).
            expect(notifyStep(rec('unanswered', { phoneNoAt: 5 }), os(false))).toBeNull();
            expect(notifyStep(rec('declined'), os(false, true, false))).toBeNull();
            expect(notifyStep(rec('unanswered'), os(false, false))).toBeNull();
        });

        // Amendment 2 §8: the file's own words carry the rule's new sentence, word for word, and no longer the old finality.
        it("the file's header carries the 26 Oct rule and the 21 Nov exception, word for word", () => {
            const src = fs.readFileSync(path.join(root, 'utils/notification-permission.ts'), 'utf8');
            const header = src.slice(0, src.indexOf('*/')).replace(/\n \* ?/g, ' ').replace(/\s+/g, ' ');
            expect(header).toContain('Notifications are the one exception (Marty, 21 Nov 2026). The join\'s last screen may carry one soft ask for notifications: our own screen, with the reason, a "Turn on notifications" button and a "Later" that is not final. The hard ask (the phone\'s pop-up) still comes only after the member taps that button, never by itself. Members who are already in see the same soft ask once on Home. The reason for the exception: a notification takes nothing from the phone, and it is the only way BeanPool can reach a member. This is not a pattern. Photos, camera, location, contacts and every other permission keep the rule above with no exception, and no other permission may be raised in the join.');
            expect(header).toContain('never at install, sign-up or first launch');
            expect(src).not.toMatch(/Not now is final|nothing asks again|Never at install, sign-up or right after an account exists/i);
        });
    });

    // #2524 deciding review: Turn on → Open Settings → allow → back hid the card but registered no token until the next
    // cold start.
    describe('a phone that starts allowing notifications registers when the member comes back', () => {
        const allows = (granted: boolean) => async () => ({ available: true, granted, canAskAgain: !granted });

        it('registers at start when the phone already allows them, and not again while it still does', async () => {
            const registerIfAllowed = registerWhenNotificationsAllowed('member-key', allows(true));
            expect(await registerIfAllowed()).toBe(true);
            expect(await registerIfAllowed()).toBe(false);
            await vi.waitFor(() => expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledTimes(1));
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('member-key');
        });

        it('registers on the return after the phone settings turned them on; nothing while they are off', async () => {
            let granted = false;
            const registerIfAllowed = registerWhenNotificationsAllowed('member-key', () => allows(granted)());
            expect(await registerIfAllowed()).toBe(false);
            expect(await registerIfAllowed()).toBe(false);
            expect(pushServiceMock.registerForPushNotifications).not.toHaveBeenCalled();
            granted = true; // allowed in the phone's settings, then back to BeanPool
            expect(await registerIfAllowed()).toBe(true);
            await vi.waitFor(() => expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledTimes(1));
            granted = false; // off again, then on again: registered again
            expect(await registerIfAllowed()).toBe(false);
            granted = true;
            expect(await registerIfAllowed()).toBe(true);
            await vi.waitFor(() => expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledTimes(2));
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });

        it('_layout.tsx looks again each time the app comes back, for the account on the phone', () => {
            const layoutSource = fs.readFileSync(path.resolve(__dirname, '../../app/_layout.tsx'), 'utf8');
            const effect = layoutSource.slice(layoutSource.indexOf('registerWhenNotificationsAllowed(identity.publicKey)'));
            expect(effect.length).toBeLessThan(layoutSource.length);
            expect(effect.slice(0, 400)).toMatch(/AppState\.addEventListener\('change', \(next\) => \{\s*if \(next === 'active'\) void registerIfAllowed\(\);/);
            expect(effect.slice(0, 400)).toContain('return () => sub.remove();');
        });
    });

    describe('words and copy', () => {
        it("the one line before the phone's settings open, and the bell's Turn on; the pop-up's reason left with the pop-up", () => {
            expect(NOTIFICATION_CARD_WORDS).toEqual({ title: 'Turn on notifications?', turnOn: 'Turn on', notNow: 'Not now' });
            expect(fs.readFileSync(path.resolve(__dirname, '../notification-permission.ts'), 'utf8')).not.toContain('So you hear when someone answers you');
        });
    });
});
