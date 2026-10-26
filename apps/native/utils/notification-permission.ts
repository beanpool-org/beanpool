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
 * - Ask at the first knock or message if unanswered or declined; never on subsequent knocks or messages.
 */
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as ExpoNotifications from 'expo-notifications';
import { t, word } from '@beanpool/core';
import { NOTIFICATION_PERMISSION_STORE_KEY } from './storage-keys';
// services/push-notifications (which require()s expo-notifications as it loads) and ./identity are loaded inside the
// functions that need them, never here: Home and How it Works import this file, and six screen suites that don't mock
// either failed to load when they were static (#2524 deciding review).

async function getNotificationsModule(): Promise<typeof ExpoNotifications | null> {
    try {
        const mod = await import('expo-notifications');
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

/** What the phone itself says about notifications for BeanPool. */
export interface OsNotificationPermission {
    /** expo-notifications loaded: false on a build or runner without it, where nothing can be asked or delivered. */
    available: boolean;
    granted: boolean;
    /** Whether the system dialog can still be shown. False after iOS's Don't Allow, a second denial on Android 13+,
     *  or notifications switched off in the phone's settings: only the phone's settings can turn them on then. */
    canAskAgain: boolean;
}

/** Reads the phone's own notification permission. Never throws and never asks. */
export async function readOsNotificationPermission(): Promise<OsNotificationPermission> {
    try {
        const notif = await getNotificationsModule();
        if (!notif?.getPermissionsAsync) return { available: false, granted: false, canAskAgain: false };
        const res = await notif.getPermissionsAsync();
        return { available: true, granted: res?.status === 'granted', canAskAgain: res?.canAskAgain !== false };
    } catch {
        return { available: false, granted: false, canAskAgain: false };
    }
}

/** Checks whether notifications are granted at the OS level. */
export async function checkOsNotificationPermission(): Promise<boolean> {
    return (await readOsNotificationPermission()).granted;
}

/**
 * Registers this phone's push token for the account (the key given, else the one stored), without waiting for it.
 * Only called once the phone allows notifications, so it never brings up the system dialog itself.
 */
async function registerPushToken(publicKey?: string | null): Promise<void> {
    try {
        let activeKey = publicKey || null;
        if (!activeKey) {
            const { loadIdentity } = await import('./identity');
            activeKey = (await loadIdentity().catch(() => null))?.publicKey ?? null;
        }
        if (!activeKey) return;
        const { registerForPushNotifications } = await import('../services/push-notifications');
        registerForPushNotifications(activeKey).catch((e) => {
            console.warn('[Push] Error registering push notifications after permission granted:', e);
        });
    } catch (e) {
        console.warn('[Push] Could not load push registration:', e);
    }
}

export type TurnOnResult = 'granted' | 'declined' | 'settings';

export interface TurnOnOptions {
    /** The one-line reason before the phone's settings open (tests inject it; the app shows an Alert). */
    confirmSettings?: () => Promise<'turn_on' | 'not_now'>;
    /** Opens BeanPool's page in the phone's settings (tests inject it; the app uses Linking.openSettings). */
    openSettings?: () => Promise<void>;
    /** The member already answered a prompt that said notifications are off in the phone's settings. */
    skipSettingsConfirm?: boolean;
}

async function defaultOpenSettings(): Promise<void> {
    await Linking.openSettings().catch((e: unknown) => console.warn('[Push] Could not open the phone settings:', e));
}

/**
 * Tapping "Turn on" on the card: requests system permission, saves the state, and if granted registers the push token.
 * When the phone won't show its dialog again (`canAskAgain: false`: iOS after Don't Allow, Android 13+ after a second
 * denial, or notifications switched off in the phone's settings), requesting would return "denied" with nothing shown,
 * so "Turn on" says why in one line and opens BeanPool's page in the phone's settings instead. Nothing is stored then
 * ('settings'): the card stays until the phone allows notifications or the member says Not now.
 */
export async function turnOnNotifications(
    publicKey?: string | null,
    storage: StorageLike = AsyncStorage,
    options: TurnOnOptions = {},
): Promise<TurnOnResult> {
    const os = await readOsNotificationPermission();
    let status = 'denied';
    if (os.granted) {
        status = 'granted';
    } else if (os.available && !os.canAskAgain) {
        const choice = options.skipSettingsConfirm
            ? 'turn_on'
            : await (options.confirmSettings ?? (() => defaultAlertPrompt('settings-after-card')))();
        if (choice === 'turn_on') {
            await (options.openSettings ?? defaultOpenSettings)();
            return 'settings';
        }
        await declineNotifications(storage);
        return 'declined';
    } else {
        try {
            const notif = await getNotificationsModule();
            if (notif?.requestPermissionsAsync) {
                const res = await notif.requestPermissionsAsync();
                status = res.status;
            }
        } catch {
            status = 'denied';
        }
    }

    const existing = await readNotificationPermissionRecord(storage);
    if (status === 'granted') {
        await writeNotificationPermissionRecord({ ...existing, state: 'granted', updatedAt: Date.now() }, storage);
        await registerPushToken(publicKey);
        return 'granted';
    } else {
        await writeNotificationPermissionRecord({ ...existing, state: 'declined', updatedAt: Date.now() }, storage);
        return 'declined';
    }
}

/**
 * Tapping "Not now" on the card: marks the state as declined, unless the phone already allows notifications (Android 8–12
 * always does; so does a member who allowed the old boot prompt): then nothing is stored, as their token keeps
 * registering and "declined" would be untrue.
 */
export async function declineNotifications(storage: StorageLike = AsyncStorage): Promise<void> {
    if ((await readOsNotificationPermission()).granted) return;
    const existing = await readNotificationPermissionRecord(storage);
    await writeNotificationPermissionRecord({ ...existing, state: 'declined', updatedAt: Date.now() }, storage);
}

export interface ActionPromptOptions {
    /** 'ask' when the phone can still show its dialog; 'settings' when only its settings can turn notifications on. */
    promptUser?: (kind: 'ask' | 'settings') => Promise<'turn_on' | 'not_now'>;
    openSettings?: () => Promise<void>;
    storage?: StorageLike;
}

/** The one line said before the phone's settings open, when the phone won't show its own dialog again. */
export const NOTIFICATIONS_OFF_IN_SETTINGS = word("Notifications are off for BeanPool in your phone's settings. Open Settings to turn them on.");

/**
 * Prompt helper using React Native Alert when promptUser is not injected.
 * 'ask': the reason, then Turn on (the system dialog follows). 'settings': the reason and that notifications are off in
 * the phone's settings, then Open Settings. 'settings-after-card': only the settings line, as the card above has just
 * given the reason.
 */
function defaultAlertPrompt(kind: 'ask' | 'settings' | 'settings-after-card' = 'ask'): Promise<'turn_on' | 'not_now'> {
    const reason = t('So you hear when someone answers you, messages you, or asks to join. Nothing else.');
    const off = t("Notifications are off for BeanPool in your phone's settings. Open Settings to turn them on.");
    const body = kind === 'ask' ? reason : kind === 'settings' ? `${reason}\n\n${off}` : off;
    return new Promise((resolve) => {
        Alert.alert(
            t('Turn on notifications?'),
            body,
            [
                { text: t('Not now'), style: 'cancel', onPress: () => resolve('not_now') },
                { text: kind === 'ask' ? t('Turn on') : t('Open Settings'), onPress: () => resolve('turn_on') },
            ],
            { cancelable: false },
        );
    });
}

/**
 * At the first knock or message:
 * If notifications are unanswered or previously declined, ask with the one-line reason first;
 * never ask on subsequent knocks or messages.
 * The phone is read first: where it already allows notifications (every Android 8–12 phone, and members who allowed the
 * old boot prompt), the token is registered silently and nothing is shown. Where expo-notifications can't load (no
 * native module in this build), there is nothing to turn on, so nothing is asked either. Where the phone won't show its
 * dialog again, the one prompt says so and its button opens the phone's settings.
 */
export async function askNotificationPermissionOnAction(
    action: 'knock' | 'message',
    publicKey?: string | null,
    options?: ActionPromptOptions,
): Promise<'granted' | 'declined' | 'unanswered'> {
    const storage = options?.storage ?? AsyncStorage;
    const record = await readNotificationPermissionRecord(storage);

    if (record.state === 'granted') return 'granted';

    const alreadyRetried = action === 'knock' ? record.knockRetried : record.messageRetried;
    if (alreadyRetried) return record.state;

    const os = await readOsNotificationPermission();
    if (os.granted) {
        await registerPushToken(publicKey);
        return 'granted';
    }
    if (!os.available) return record.state;

    const kind = os.canAskAgain ? 'ask' : 'settings';
    const prompter = options?.promptUser ?? defaultAlertPrompt;
    const choice = await prompter(kind);

    const updated = await readNotificationPermissionRecord(storage);
    if (choice === 'turn_on') {
        const res = await turnOnNotifications(publicKey, storage, { skipSettingsConfirm: true, openSettings: options?.openSettings });
        const latest = await readNotificationPermissionRecord(storage);
        await writeNotificationPermissionRecord({
            ...latest,
            [action === 'knock' ? 'knockRetried' : 'messageRetried']: true,
        }, storage);
        return res === 'settings' ? latest.state : res;
    } else {
        await writeNotificationPermissionRecord({
            ...updated,
            state: 'declined',
            [action === 'knock' ? 'knockRetried' : 'messageRetried']: true,
        }, storage);
        return 'declined';
    }
}
