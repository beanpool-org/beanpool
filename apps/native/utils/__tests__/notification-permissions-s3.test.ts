/**
 * Front doors S3: notification permission at the tap, never at account creation (Fable design §0, §1.9, §3.9, §7).
 *
 * Requirements:
 * - No requestPermissionsAsync in the identity effect (app/_layout.tsx:769-772 removed).
 * - "Turn on notifications?" card at the end of How it Works and on Home until answered.
 * - Words:
 *     Title: "Turn on notifications?"
 *     Body: "So you hear when someone answers you, messages you, or asks to join. Nothing else."
 *     Buttons: "Turn on" · "Not now"
 * - Nothing asked after a restore (lands on Home; card asks only when tapped).
 * - Ask again at the first knock or message if declined, with the app's one-line reason first; never on second knock/message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('react-native', () => ({
    Platform: { OS: 'android' },
    Alert: {
        alert: vi.fn(),
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
    shouldShowNotificationCard,
    turnOnNotifications,
    declineNotifications,
    askNotificationPermissionOnAction,
    type NotificationPermissionRecord,
} from '../notification-permission';

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
        it('starts in unanswered state on a fresh install and shows card until answered', async () => {
            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(shouldShowNotificationCard(record, false)).toBe(true);
        });

        it('does not show card if OS permission was already granted', () => {
            const record: NotificationPermissionRecord = { state: 'unanswered', updatedAt: Date.now() };
            expect(shouldShowNotificationCard(record, true)).toBe(false);
        });

        it('tapping Turn on requests permission, records granted state, and registers push token', async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('test-pubkey');

            const updated = await readNotificationPermissionRecord();
            expect(updated.state).toBe('granted');
            expect(shouldShowNotificationCard(updated, false)).toBe(false);
        });

        it('tapping Turn on without publicKey falls back to stored identity', async () => {
            identityMock.loadIdentity.mockResolvedValueOnce({ publicKey: 'stored-pubkey', privateKey: 'pk' });
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'granted' } as any);

            const result = await turnOnNotifications();
            expect(result).toBe('granted');
            expect(pushServiceMock.registerForPushNotifications).toHaveBeenCalledWith('stored-pubkey');
        });

        it('tapping Turn on when permission is denied records declined state and does not register token', async () => {
            notificationsMock.requestPermissionsAsync.mockResolvedValueOnce({ status: 'denied' } as any);

            const result = await turnOnNotifications('test-pubkey');
            expect(result).toBe('declined');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);
            expect(pushServiceMock.registerForPushNotifications).not.toHaveBeenCalled();

            const updated = await readNotificationPermissionRecord();
            expect(updated.state).toBe('declined');
            expect(shouldShowNotificationCard(updated, false)).toBe(false);
        });

        it('tapping Not now transitions to declined and hides the card', async () => {
            await declineNotifications();

            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('declined');
            expect(shouldShowNotificationCard(record, false)).toBe(false);
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();
        });

        it('after restore, nothing is asked automatically; card is shown on Home until answered', async () => {
            // A restored account has no prior local permission record on this phone
            const record = await readNotificationPermissionRecord();
            expect(record.state).toBe('unanswered');
            expect(notificationsMock.requestPermissionsAsync).not.toHaveBeenCalled();

            // The card is shown on Home until answered
            expect(shouldShowNotificationCard(record, false)).toBe(true);

            // Tapping Turn on on Home asks for permission
            await turnOnNotifications('restored-pubkey');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            const after = await readNotificationPermissionRecord();
            expect(shouldShowNotificationCard(after, false)).toBe(false);
        });

        it('if declined, asks again at the first knock with one-line reason, but not on second knock', async () => {
            await declineNotifications();

            // First knock: should prompt with reason and buttons
            const askPromise = askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: vi.fn(async () => 'turn_on' as const),
            });
            const res1 = await askPromise;
            expect(res1).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            // Record should now have knockRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.knockRetried).toBe(true);

            // Second knock: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('granted');
        });

        it('if declined, asks again at the first message with one-line reason, but not on second message', async () => {
            await declineNotifications();

            // First message: should prompt with reason
            const promptMock1 = vi.fn(async () => 'not_now' as const);
            const res1 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock1,
            });
            expect(promptMock1).toHaveBeenCalledTimes(1);
            expect(res1).toBe('declined');

            // Record should have messageRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.messageRetried).toBe(true);

            // Second message: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('declined');
        });

        it('if unanswered, asks at the first knock with one-line reason, but not on second knock', async () => {
            // Fresh state is unanswered
            const askPromise = askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: vi.fn(async () => 'turn_on' as const),
            });
            const res1 = await askPromise;
            expect(res1).toBe('granted');
            expect(notificationsMock.requestPermissionsAsync).toHaveBeenCalledTimes(1);

            // Record should now have knockRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.knockRetried).toBe(true);

            // Second knock: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('granted');
        });

        it('if unanswered, asks at the first message with one-line reason, but not on second message', async () => {
            // Fresh state is unanswered
            const promptMock1 = vi.fn(async () => 'not_now' as const);
            const res1 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock1,
            });
            expect(promptMock1).toHaveBeenCalledTimes(1);
            expect(res1).toBe('declined');

            // Record should have messageRetried: true
            const rec1 = await readNotificationPermissionRecord();
            expect(rec1.messageRetried).toBe(true);

            // Second message: should not prompt again
            const promptMock2 = vi.fn();
            const res2 = await askNotificationPermissionOnAction('message', 'test-pubkey', {
                promptUser: promptMock2,
            });
            expect(promptMock2).not.toHaveBeenCalled();
            expect(res2).toBe('declined');
        });

        it('if already granted, action never prompts user', async () => {
            await turnOnNotifications('test-pubkey');

            const promptMock = vi.fn();
            const res = await askNotificationPermissionOnAction('knock', 'test-pubkey', {
                promptUser: promptMock,
            });
            expect(promptMock).not.toHaveBeenCalled();
            expect(res).toBe('granted');
        });
    });

    describe('words and copy', () => {
        it('matches the exact copy decided in design §3.9', () => {
            expect(NOTIFICATION_CARD_WORDS.title).toBe('Turn on notifications?');
            expect(NOTIFICATION_CARD_WORDS.body).toBe(
                'So you hear when someone answers you, messages you, or asks to join. Nothing else.'
            );
            expect(NOTIFICATION_CARD_WORDS.turnOn).toBe('Turn on');
            expect(NOTIFICATION_CARD_WORDS.notNow).toBe('Not now');
        });
    });
});
