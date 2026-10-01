import * as Device from 'expo-device';
import { Platform, AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { Notification, NotificationResponse } from 'expo-notifications';
import { loadIdentity } from '../utils/identity';
import { registerAccountForPush, retryDueRegistrations } from '../utils/push-registrations';
import { checkWhileOpen, followTap, type IncomingNotice } from '../utils/push-notice-check';
import { postNoticesFromSync, type LocalNotice } from '../utils/sync-notices';
import { PUSH_TOKEN_STORE_KEY } from '../utils/storage-keys';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
let Notifications: typeof import('expo-notifications') | null = null;

/** A notification as utils/push-notice-check.ts reads it: a push the phone's push service delivered has trigger `push`. */
function incoming(notification: Notification): IncomingNotice {
    const { identifier, content, trigger } = notification.request;
    return {
        identifier,
        remote: (trigger as { type?: unknown } | null)?.type === 'push',
        title: content.title ?? null,
        body: content.body ?? null,
        data: content.data,
    };
}

/** Post a notice on this phone, now: one shown in a push's place, or the sync's (utils/sync-notices.ts). */
async function postLocalNotice(notice: LocalNotice): Promise<void> {
    if (!Notifications) return;
    await Notifications.scheduleNotificationAsync({ content: { title: notice.title, body: notice.body, data: notice.data }, trigger: null });
}

if (!isExpoGo) {
    try {
        Notifications = require('expo-notifications');
        // While the app is open, a push shows only when its own community signed it for this account and it is new;
        // an unsigned one from a community that signs nothing yet shows with fixed words; anything else is dropped
        // (utils/push-notice-check.ts). The app's own notices show as they are.
        Notifications?.setNotificationHandler({
            handleNotification: async (notification) => {
                const decision = await checkWhileOpen(incoming(notification), {
                    storage: AsyncStorage,
                    recipient: (await loadIdentity().catch(() => null))?.publicKey ?? null,
                });
                if (decision.kind === 'replace') {
                    postLocalNotice(decision).catch((e) => console.warn('[Push] Could not show a notification in its own words', e));
                }
                const show = decision.kind === 'show';
                return { shouldShowAlert: show, shouldPlaySound: show, shouldSetBadge: show, shouldShowBanner: show, shouldShowList: show };
            },
        });
    } catch (e) {
        console.warn('Failed to load expo-notifications', e);
    }
}

/**
 * Registers for Expo Push Notifications and transmits the token to the BeanPool server.
 * Should be called once the user is logged in and has an identity.
 *
 * With the community the phone is set to, which the phone records first: as the account leaves the phone, only the
 * communities it sent the token to are asked to drop it. One that doesn't land, the token not to be had yet included
 * (no connection), stays due and is tried again as the app comes back ({@link retryPushRegistrations};
 * utils/push-registrations.ts `registerAccountForPush`).
 */
export async function registerForPushNotifications(publicKey: string): Promise<string | null> {
    return registerAccountForPush(publicKey, () => phonePushToken(true), Platform.OS);
}

/**
 * The registrations the account on the phone still needs, tried again as the app comes back and with the 5-minute sync
 * (app/_layout.tsx; utils/push-registrations.ts `retryDueRegistrations`). Never asks for permission. Never throws.
 */
export function retryPushRegistrations(): Promise<void> {
    return retryDueRegistrations(() => phonePushToken(false), Platform.OS);
}

/**
 * This phone's Expo push token, fetched afresh and kept for the account's Sign Out (PUSH_TOKEN_STORE_KEY), then
 * Android's notification channels set up. Null where push can't work here: Expo Go, a simulator, or permission not
 * granted (asked for only when `ask`). Throws when the token can't be had, with no connection most often.
 */
async function phonePushToken(ask: boolean): Promise<string | null> {
    if (isExpoGo || !Notifications) {
        console.log('[Push] Push notifications are not available in Expo Go');
        return null;
    }

    // Push notifications only work on physical devices
    if (!Device.isDevice) {
        console.log('[Push] Push notifications are not available on simulator/emulator');
        return null;
    }

    // Check existing permission
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    // Request permission if not already granted
    if (existingStatus !== 'granted' && ask) {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
    }

    if (finalStatus !== 'granted') {
        console.log('[Push] Push notification permission denied');
        return null;
    }

    // Get the Expo Push Token
    const projectId = Constants.expoConfig?.extra?.eas?.projectId;
    const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: projectId || '17a2a61a-9cbe-457e-bb10-84d8a666e6eb',
    });
    const token = tokenData.data;

    // Store locally
    await SecureStore.setItemAsync(PUSH_TOKEN_STORE_KEY, token);

    try {
        // Set up Android notification channel
        if (Platform.OS === 'android') {
            await Notifications.setNotificationChannelAsync('default', {
                name: 'BeanPool',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#8b5cf6',
            });

            await Notifications.setNotificationChannelAsync('escrow', {
                name: 'Held in Trust Alerts',
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 500, 250, 500],
                lightColor: '#059669',
                description: 'Alerts for trust events (credits locked, released, cancelled)',
            });

            await Notifications.setNotificationChannelAsync('chat', {
                name: 'Direct Messages',
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 250],
                lightColor: '#3b82f6',
                description: 'Notifications for new messages',
            });

            await Notifications.setNotificationChannelAsync('marketplace', {
                name: 'Marketplace',
                importance: Notifications.AndroidImportance.DEFAULT,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#8b5cf6',
                description: 'Requests and offers on your marketplace posts',
            });

            // Recovery alerts are high-priority and must not be silenced by muting
            // deal/marketplace notifications. Separate channel means separate control.
            await Notifications.setNotificationChannelAsync('recovery', {
                name: 'Account Recovery Alerts',
                importance: Notifications.AndroidImportance.MAX,
                vibrationPattern: [0, 500, 500, 500],
                lightColor: '#ef4444',
                description: 'Urgent alerts when someone tries to recover your account',
            });
        }
    } catch (e) {
        // The token is had: the registration goes all the same.
        console.warn('[Push] Could not set up the notification channels', e);
    }
    return token;
}

// Unregistering is the leaving account's (utils/account-leaves-phone.ts `unregisterPushToken`): on each community the
// phone sent the token to, signed by its own key, before Sign Out, a replace or a delete takes the key off the phone.

/** The taps this run has followed, by notification: the one that launched the app can arrive twice. */
const followedTaps = new Set<string>();

/**
 * A tap on a notification, followed once (utils/push-notice-check.ts `followTap`): a notice its own community signed
 * for this account opens where the community says, through a fixed list of routes; the key vault's opens Settings,
 * where the RecoveryAlertBanner reads what is waiting and offers Stop (and "Yes, it's me"); one the phone can't trust
 * opens nothing and shows the warning line (components/PushNoticeWarning.tsx). Never throws.
 */
async function followNotificationTap(response: NotificationResponse): Promise<void> {
    const id = response.notification.request.identifier;
    if (followedTaps.has(id)) return;
    followedTaps.add(id);
    try {
        await followTap(incoming(response.notification), {
            storage: AsyncStorage,
            account: await loadIdentity().catch(() => null),
        }, (route) => router.push(route));
    } catch (e) {
        console.warn('[Push] Could not follow a tapped notification', e);
    }
}

/**
 * Follows taps on notifications, and the tap that launched the app. Call this in the root layout, once the navigator is
 * there. Returns a subscription that should be cleaned up on unmount.
 */
export function setupNotificationResponseHandler() {
    if (isExpoGo || !Notifications) {
        return { remove: () => {} };
    }
    const notifications = Notifications;

    const subscription = notifications.addNotificationResponseReceivedListener((response: NotificationResponse) => {
        void followNotificationTap(response);
    });
    try {
        const launched = notifications.getLastNotificationResponse();
        if (launched) {
            notifications.clearLastNotificationResponse();
            void followNotificationTap(launched);
        }
    } catch (e) {
        console.warn('[Push] Could not read the notification that opened the app', e);
    }

    return subscription;
}

/**
 * The background sync's notices (utils/sync-notices.ts): the community the phone is set to asked for its member's
 * unseen notices, and one posted on the phone for each recent one not shown before. Only while the app is not open
 * (the socket's alerts show them then), and only when the phone lets the app notify. Returns how many were posted.
 * Never throws.
 */
export async function postNoticesAfterSync(): Promise<number> {
    if (isExpoGo || !Notifications) return 0;
    try {
        if (AppState.currentState === 'active') return 0;
        if ((await Notifications.getPermissionsAsync()).status !== 'granted') return 0;
        return await postNoticesFromSync({ storage: AsyncStorage, account: await loadIdentity(), post: postLocalNotice });
    } catch (e) {
        console.warn('[Notices] The sync\'s notices were not posted', e);
        return 0;
    }
}
