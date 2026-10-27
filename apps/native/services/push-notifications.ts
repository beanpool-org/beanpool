import * as Device from 'expo-device';
import { Platform, AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { Notification, NotificationResponse } from 'expo-notifications';
import { loadIdentity, KEY_ITEM_OPTIONS } from '../utils/identity';
import { registerAccountForPush, retryDueRegistrations } from '../utils/push-registrations';
import { checkWhileOpen, followTap, verifiedNotice, type IncomingNotice } from '../utils/push-notice-check';
import { openNoticeIn } from '../utils/push-notice-switch';
import { countNotice, watchNoticeCounts } from '../utils/notice-counts';
import { postAllNoticesFromSync, type LocalNotice } from '../utils/sync-notices';
import { notificationChannels } from '../utils/notification-channels';
import { PUSH_TOKEN_STORE_KEY } from '../utils/storage-keys';
import { toolReminderRoute } from '../tools/reminders';

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

/**
 * A notice its own community signed for this account, counted for that community unless it is the one in use (the
 * numbers on the BeanPool sheet's rows: utils/notice-counts.ts). Checked on the phone; nothing is asked of any community.
 * Never throws.
 */
async function countForItsCommunity(n: IncomingNotice, recipient: string | null): Promise<void> {
    const notice = await verifiedNotice(n, { storage: AsyncStorage, recipient });
    if (notice) await countNotice(AsyncStorage, notice.community, notice.id);
}

/**
 * The notices waiting in the phone's notification list, counted for their communities: pushes that came while the app was
 * closed, which no app code saw. Never throws.
 */
async function countWaitingNotices(): Promise<void> {
    if (!Notifications) return;
    try {
        const waiting = await Notifications.getPresentedNotificationsAsync();
        const recipient = (await loadIdentity().catch(() => null))?.publicKey ?? null;
        for (const n of waiting) await countForItsCommunity(incoming(n), recipient);
    } catch (e) {
        console.warn('[Push] Could not count the notices waiting on the phone', e);
    }
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
        // (utils/push-notice-check.ts). The app's own notices show as they are. Each one its own community signed is
        // counted for that community, unless it is the one in use (utils/notice-counts.ts).
        Notifications?.setNotificationHandler({
            handleNotification: async (notification) => {
                const recipient = (await loadIdentity().catch(() => null))?.publicKey ?? null;
                const decision = await checkWhileOpen(incoming(notification), { storage: AsyncStorage, recipient });
                void countForItsCommunity(incoming(notification), recipient);
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
 * The member picked another language (components/LanguageProvider.tsx `onPicked`): the community the phone is set to is
 * told at once, on the push registration's `lang`, so its next push is written in that language rather than after the
 * next app start. Never asks for permission; nothing without an account on the phone or a token. Never throws.
 */
export function registerPushInPickedLanguage(): void {
    void (async () => {
        const identity = await loadIdentity().catch(() => null);
        if (identity?.publicKey) await registerAccountForPush(identity.publicKey, () => phonePushToken(false), Platform.OS);
    })().catch(() => { /* registerAccountForPush never throws; a load that did leaves the next start to tell it */ });
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
    await SecureStore.setItemAsync(PUSH_TOKEN_STORE_KEY, token, KEY_ITEM_OPTIONS);

    try {
        // Set up Android notification channel
        if (Platform.OS === 'android') {
            // Named in the member's language (utils/notification-channels.ts): set again with each token, so a language
            // change renames them in the phone's settings too.
            for (const { id, importance, ...channel } of notificationChannels()) {
                await Notifications.setNotificationChannelAsync(id, { ...channel, importance: Notifications.AndroidImportance[importance] });
            }
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

/** What the root layout lends the taps. */
export interface NotificationTapOptions {
    /** Its recognition, asked again for the community now in use (app/NodeStatusContext.tsx `recheck`). */
    recheck(): Promise<unknown>;
}

/**
 * A tap on a notification, followed once (utils/push-notice-check.ts `followTap`): a notice its own community signed
 * for this account opens where the community says, through a fixed list of routes, and one from another community this
 * phone keeps moves the phone there first, as that community's row on the BeanPool sheet does, unless a join or another
 * switch is under way (utils/push-notice-switch.ts); the key vault's opens Settings, where the RecoveryAlertBanner reads
 * what is waiting and offers Stop (and "Yes, it's me"); one the phone can't trust opens nothing and shows the warning line
 * (components/PushNoticeWarning.tsx). Never throws.
 */
async function followNotificationTap(response: NotificationResponse, options: NotificationTapOptions): Promise<void> {
    const id = response.notification.request.identifier;
    if (followedTaps.has(id)) return;
    followedTaps.add(id);
    try {
        // A tool's own reminder (tools/reminders.ts), which only this app posts: it opens the tool.
        const activeAnchor = await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
        const { communityKey } = await import('../tools/community');
        const toolRoute = toolReminderRoute(incoming(response.notification), communityKey(activeAnchor));
        if (toolRoute) {
            router.push(toolRoute as never);
            return;
        }
        const account = await loadIdentity().catch(() => null);
        await followTap(incoming(response.notification), {
            storage: AsyncStorage,
            account,
            openIn: async (community, id, route) => {
                if (!account) return;
                const [{ switchCommunity, communitySwitchUnderWay }, { getPendingOnboarding }] = await Promise.all([
                    import('../utils/use-communities'), import('../utils/onboarding-state'),
                ]);
                await openNoticeIn(community, id, route, {
                    storage: AsyncStorage,
                    publicKey: account.publicKey,
                    // A record that can't be read holds the phone where it is, as the root guard routes nowhere until it reads.
                    joinUnderWay: () => getPendingOnboarding().then((p) => !!p, () => true),
                    switchUnderWay: communitySwitchUnderWay,
                    switchTo: switchCommunity,
                    recheck: options.recheck,
                });
            },
        }, (route) => router.push(route));
    } catch (e) {
        console.warn('[Push] Could not follow a tapped notification', e);
    }
}

/**
 * Follows taps on notifications, and the tap that launched the app; and keeps the BeanPool sheet's counts (utils/
 * notice-counts.ts): the community in use cleared now and at every switch, the notices waiting in the phone's list counted
 * now and each time the app comes back. Call this in the root layout, once the navigator is there. Returns a subscription
 * that should be cleaned up on unmount.
 */
export function setupNotificationResponseHandler(options: NotificationTapOptions) {
    if (isExpoGo || !Notifications) {
        return { remove: () => {} };
    }
    const notifications = Notifications;

    const subscription = notifications.addNotificationResponseReceivedListener((response: NotificationResponse) => {
        void followNotificationTap(response, options);
    });
    try {
        const launched = notifications.getLastNotificationResponse();
        if (launched) {
            notifications.clearLastNotificationResponse();
            void followNotificationTap(launched, options);
        }
    } catch (e) {
        console.warn('[Push] Could not read the notification that opened the app', e);
    }

    const stopCounting = watchNoticeCounts(AsyncStorage);
    void countWaitingNotices();
    const appState = AppState.addEventListener('change', (next) => {
        if (next === 'active') void countWaitingNotices();
    });

    return {
        remove: () => {
            subscription.remove();
            stopCounting();
            appState.remove();
        },
    };
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
        // The unseen notices, the answers to this phone's requests to join, and new requests for an owner or admin with
        // no push here, all at once under one deadline (utils/sync-notices.ts), inside the task's ~30 seconds.
        return await postAllNoticesFromSync({ storage: AsyncStorage, account: await loadIdentity(), post: postLocalNotice });
    } catch (e) {
        console.warn('[Notices] The sync\'s notices were not posted', e);
        return 0;
    }
}
