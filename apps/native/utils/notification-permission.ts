/**
 * Front doors S3: notification permission at the tap, never at account creation (Fable design §0, §1.9, §3.9, §7).
 *
 * Requirements:
 * - A device permission is asked at the tap that needs it, with the app's own one-line reason first.
 * - Never at install, sign-up or right after an account exists (the identity effect in _layout.tsx is removed).
 * - "Turn on notifications?" card at the end of How it Works and on Home until answered.
 * - Words (design §3.9):
 *     Title: "Turn on notifications?"
 *     Body: "So you hear when someone answers you, messages you, or asks to join. Nothing else."
 *     Buttons: "Turn on" · "Not now"
 * - Nothing asked after a restore (the restored member lands on Home; the notifications card asks only when tapped).
 * - Ask again at the first knock or message if declined; never on subsequent knocks or messages.
 */
import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as ExpoNotifications from 'expo-notifications';
import { t, word } from '@beanpool/core';
import { NOTIFICATION_PERMISSION_STORE_KEY } from './storage-keys';
import { registerForPushNotifications } from '../services/push-notifications';

function getNotificationsModule(): typeof ExpoNotifications | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('expo-notifications');
        return mod?.default ?? mod;
    } catch {
        return null;
    }
}

export const NOTIFICATION_CARD_WORDS = {
    title: word('Turn on notifications?'),
    body: word('So you hear when someone answers you, messages you, or asks to join. Nothing else.'),
    turnOn: word('Turn on'),
    notNow: word('Not now'),
} as const;

export type NotificationPermissionState = 'unanswered' | 'granted' | 'declined';

export interface NotificationPermissionRecord {
    state: NotificationPermissionState;
    knockRetried?: boolean;
    messageRetried?: boolean;
    updatedAt: number;
}

type StorageLike = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

/** Reads the current notification permission record from storage. */
export async function readNotificationPermissionRecord(storage: StorageLike = AsyncStorage): Promise<NotificationPermissionRecord> {
    try {
        const raw = await storage.getItem(NOTIFICATION_PERMISSION_STORE_KEY);
        if (!raw) return { state: 'unanswered', updatedAt: 0 };
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            return {
                state: parsed.state === 'granted' || parsed.state === 'declined' ? parsed.state : 'unanswered',
                knockRetried: !!parsed.knockRetried,
                messageRetried: !!parsed.messageRetried,
                updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
            };
        }
    } catch {
        // Fall back to default unanswered
    }
    return { state: 'unanswered', updatedAt: 0 };
}

/** Writes the notification permission record to storage. */
export async function writeNotificationPermissionRecord(record: NotificationPermissionRecord, storage: StorageLike = AsyncStorage): Promise<void> {
    await storage.setItem(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
}

/**
 * Checks whether the "Turn on notifications?" card should be displayed.
 * Shown at the end of How it Works and on Home until answered (and only when OS permission is not already granted).
 */
export function shouldShowNotificationCard(record: NotificationPermissionRecord | null, osGranted: boolean): boolean {
    if (osGranted) return false;
    if (!record) return true;
    return record.state === 'unanswered';
}

/** Checks whether notifications are granted at the OS level. */
export async function checkOsNotificationPermission(): Promise<boolean> {
    try {
        const notif = getNotificationsModule();
        if (!notif?.getPermissionsAsync) return false;
        const { status } = await notif.getPermissionsAsync();
        return status === 'granted';
    } catch {
        return false;
    }
}

/**
 * Tapping "Turn on" on the card: requests system permission, saves the state, and if granted registers the push token.
 */
export async function turnOnNotifications(publicKey?: string | null, storage: StorageLike = AsyncStorage): Promise<'granted' | 'declined'> {
    let status = 'denied';
    try {
        const notif = getNotificationsModule();
        if (notif?.requestPermissionsAsync) {
            const res = await notif.requestPermissionsAsync();
            status = res.status;
        }
    } catch {
        status = 'denied';
    }

    const existing = await readNotificationPermissionRecord(storage);
    if (status === 'granted') {
        await writeNotificationPermissionRecord({ ...existing, state: 'granted', updatedAt: Date.now() }, storage);
        if (publicKey) {
            registerForPushNotifications(publicKey).catch((e) => {
                console.warn('[Push] Error registering push notifications after permission granted:', e);
            });
        }
        return 'granted';
    } else {
        await writeNotificationPermissionRecord({ ...existing, state: 'declined', updatedAt: Date.now() }, storage);
        return 'declined';
    }
}

/** Tapping "Not now" on the card: marks the state as declined. */
export async function declineNotifications(storage: StorageLike = AsyncStorage): Promise<void> {
    const existing = await readNotificationPermissionRecord(storage);
    await writeNotificationPermissionRecord({ ...existing, state: 'declined', updatedAt: Date.now() }, storage);
}

export interface ActionPromptOptions {
    promptUser?: () => Promise<'turn_on' | 'not_now'>;
    storage?: StorageLike;
}

/**
 * Prompt helper using React Native Alert when promptUser is not injected.
 */
function defaultAlertPrompt(): Promise<'turn_on' | 'not_now'> {
    return new Promise((resolve) => {
        Alert.alert(
            t('Turn on notifications?'),
            t('So you hear when someone answers you, messages you, or asks to join. Nothing else.'),
            [
                { text: t('Not now'), style: 'cancel', onPress: () => resolve('not_now') },
                { text: t('Turn on'), onPress: () => resolve('turn_on') },
            ],
            { cancelable: false },
        );
    });
}

/**
 * At the first knock or message:
 * If the member previously declined notifications, ask again with the one-line reason first;
 * never ask on subsequent knocks or messages.
 */
export async function askNotificationPermissionOnAction(
    action: 'knock' | 'message',
    publicKey?: string | null,
    options?: ActionPromptOptions,
): Promise<'granted' | 'declined' | 'unanswered'> {
    const storage = options?.storage ?? AsyncStorage;
    const record = await readNotificationPermissionRecord(storage);

    if (record.state === 'granted') return 'granted';
    if (record.state === 'unanswered') return 'unanswered';

    // State is declined
    const alreadyRetried = action === 'knock' ? record.knockRetried : record.messageRetried;
    if (alreadyRetried) return 'declined';

    const prompter = options?.promptUser ?? defaultAlertPrompt;
    const choice = await prompter();

    const updated = await readNotificationPermissionRecord(storage);
    if (choice === 'turn_on') {
        const res = await turnOnNotifications(publicKey, storage);
        const latest = await readNotificationPermissionRecord(storage);
        await writeNotificationPermissionRecord({
            ...latest,
            [action === 'knock' ? 'knockRetried' : 'messageRetried']: true,
        }, storage);
        return res;
    } else {
        await writeNotificationPermissionRecord({
            ...updated,
            state: 'declined',
            [action === 'knock' ? 'knockRetried' : 'messageRetried']: true,
        }, storage);
        return 'declined';
    }
}
