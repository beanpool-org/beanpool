/**
 * Notifications on the phone: the phone's own pop-up only ever follows a tap on one of our asks.
 *
 * The rule (Marty, 26 Oct 2026): ask for a device permission at the moment the member taps the action that needs it,
 * with the app's own one-line reason first; never at install, sign-up or first launch.
 *
 * Notifications are the one exception (Marty, 21 Nov 2026). The join's last screen may carry one soft ask for
 * notifications: our own screen, with the reason, a "Turn on notifications" button and a "Later" that is not final. The
 * hard ask (the phone's pop-up) still comes only after the member taps that button, never by itself. Members who are
 * already in see the same soft ask once on Home. The reason for the exception: a notification takes nothing from the
 * phone, and it is the only way BeanPool can reach a member. This is not a pattern. Photos, camera, location, contacts
 * and every other permission keep the rule above with no exception, and no other permission may be raised in the join.
 *
 * (scratch/fable-design/DESIGN-notify-and-backup-asks-fable-amend2.md §8, slice N1.) What may be drawn, and when, is
 * @beanpool/core notify-ask.ts, one rule for both apps. This file is the phone's side of it:
 *
 * - The record, under the key it always had, keeps "Later" and the phone's "no" apart, with their dates, and the day of
 *   the last soft ask. "Later" is never final. An older app's "Not now" ('declined') is read as a "Later"; nothing
 *   stored is rewritten.
 * - After the phone's "no" we raise nothing: First steps' line leaves; the bell's line and Settings stay, at a tap.
 * - No pop-up of ours at a first post, message or ask to join (slice N2a): a named line at the member's own act instead
 *   ("Hear when Asha answers." [Tell me], components/NotifyLine.tsx), one line with no "Not now", by core's rule
 *   (`offerNamedLine` below). Only its Tell me brings the phone's pop-up.
 * - A restore asks nothing by itself: the once card on Home (slice N1h) is to be its one soft ask.
 */
import { Alert, Linking } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as ExpoNotifications from 'expo-notifications';
import {
    t, word, markNotifyAsk, notifyAskRecordFrom, notifyAsks, notifyFirstStepsLine, notifyTurnOn,
    type NotifyAskEvent, type NotifyAskRecord, type NotifyAskSurface, type NotifyLineKind,
} from '@beanpool/core';
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

/** "Turn on" (the bell's line), and the one line said before the phone's settings open: its title and its "Not now". */
export const NOTIFICATION_CARD_WORDS = {
    title: word('Turn on notifications?'),
    turnOn: word('Turn on'),
    notNow: word('Not now'),
} as const;

export type NotificationPermissionState = 'unanswered' | 'granted' | 'declined';

/** This phone's record: core's {@link NotifyAskRecord}, under the key it always had. */
export interface NotificationPermissionRecord extends NotifyAskRecord {
    /** 'declined' is only ever an older app's "Not now"; this app writes 'unanswered' or 'granted'. */
    state: NotificationPermissionState;
    updatedAt: number;
}

type StorageLike = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

/** Reads this phone's record. Never throws: anything unreadable is a new record. */
export async function readNotificationPermissionRecord(storage: StorageLike = AsyncStorage): Promise<NotificationPermissionRecord> {
    let parsed: unknown = null;
    try {
        const raw = await storage.getItem(NOTIFICATION_PERMISSION_STORE_KEY);
        parsed = raw ? JSON.parse(raw) : null;
    } catch {
        // A new record
    }
    const record = notifyAskRecordFrom(parsed);
    return { ...record, state: record.state ?? 'unanswered', updatedAt: record.updatedAt ?? 0 };
}

/** Writes the notification permission record to storage. */
export async function writeNotificationPermissionRecord(record: NotificationPermissionRecord, storage: StorageLike = AsyncStorage): Promise<void> {
    await storage.setItem(NOTIFICATION_PERMISSION_STORE_KEY, JSON.stringify(record));
}

/** Writes one event into this phone's record (core's markNotifyAsk), keeping the rest of it. */
export async function markNotificationAsk(event: NotifyAskEvent, storage: StorageLike = AsyncStorage): Promise<void> {
    const record = await readNotificationPermissionRecord(storage);
    await writeNotificationPermissionRecord(markNotifyAsk(record, event, Date.now()), storage);
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

/**
 * Registers this phone's push token for the account each time the phone is seen to allow notifications when it didn't
 * at the last look: at start (Android 8–12, or a restored account on a phone that already allowed them) and on each
 * return to the app (app/_layout.tsx), so a member who turned them on in the phone's settings (Turn on → Open Settings →
 * allow → back) is registered then, not at the next cold start (#2524 deciding review). Never asks. Resolves whether it
 * registered.
 */
export function registerWhenNotificationsAllowed(
    publicKey: string,
    read: () => Promise<OsNotificationPermission> = readOsNotificationPermission,
): () => Promise<boolean> {
    let allowed = false;
    return async () => {
        const now = (await read()).granted;
        const turnedOn = now && !allowed;
        allowed = now;
        if (turnedOn) await registerPushToken(publicKey);
        return turnedOn;
    };
}

/** 'declined': the phone said no. 'unanswered': nothing was answered, and nothing is recorded as a no. */
export type TurnOnResult = 'granted' | 'declined' | 'settings' | 'unanswered';

export interface TurnOnOptions {
    /** The one-line reason before the phone's settings open (tests inject it; the app shows an Alert). */
    confirmSettings?: () => Promise<'turn_on' | 'not_now'>;
    /** Opens BeanPool's page in the phone's settings (tests inject it; the app uses Linking.openSettings). */
    openSettings?: () => Promise<void>;
}

async function defaultOpenSettings(): Promise<void> {
    await Linking.openSettings().catch((e: unknown) => console.warn('[Push] Could not open the phone settings:', e));
}

/**
 * A tap on "Turn on" (First steps' line, the bell's line, a named line's Tell me): the phone's own pop-up, where it can
 * still show it. Its yes is recorded and registers the push token. Its no is recorded as the phone's no, with its date
 * ('declined'). Closed with no answer, it is a "Later", never a no ('unanswered'). Where the phone won't show its pop-up
 * again (`canAskAgain: false`: iOS after Don't Allow, Android 13+ after a second no, or switched off in the phone's
 * settings), asking would return "denied" with nothing shown, so one line says why and its button opens BeanPool's page
 * in the phone's settings ('settings'); "Not now" there records nothing, as the phone's no already stands.
 */
export async function turnOnNotifications(
    publicKey?: string | null,
    storage: StorageLike = AsyncStorage,
    options: TurnOnOptions = {},
): Promise<TurnOnResult> {
    const os = await readOsNotificationPermission();
    const way = notifyTurnOn(os);
    let status = os.granted ? 'granted' : 'unanswered';
    if (way === 'settings') {
        const choice = await (options.confirmSettings ?? settingsPrompt)();
        if (choice !== 'turn_on') return 'unanswered';
        await (options.openSettings ?? defaultOpenSettings)();
        return 'settings';
    }
    if (way === 'ask') {
        try {
            const notif = await getNotificationsModule();
            if (notif?.requestPermissionsAsync) status = (await notif.requestPermissionsAsync()).status;
        } catch {
            // No answer
        }
    }
    if (status === 'granted') {
        await markNotificationAsk({ type: 'granted' }, storage);
        await registerPushToken(publicKey);
        return 'granted';
    }
    if (status === 'denied') {
        await markNotificationAsk({ type: 'phone-no' }, storage);
        return 'declined';
    }
    if (way === 'ask') await notificationsLater(storage);
    return 'unanswered';
}

/**
 * "Later" on one of our asks (the join's screen and Home's once card, slices N1j and N1h), or the phone's pop-up closed
 * with no answer: recorded with its date, never as a no, and never final. On the once card it also puts the card away.
 */
export async function notificationsLater(storage: StorageLike = AsyncStorage, surface?: NotifyAskSurface): Promise<void> {
    await markNotificationAsk({ type: 'later', surface }, storage);
}

/** The one line said before the phone's settings open, when the phone won't show its own dialog again. */
export const NOTIFICATIONS_OFF_IN_SETTINGS = word("Notifications are off for BeanPool in your phone's settings. Open Settings to turn them on.");

/**
 * The one line before the phone's settings open, when the phone won't show its own pop-up again: that notifications are
 * off in the phone's settings, then Open Settings (the tap's own line gave the reason).
 */
function settingsPrompt(): Promise<'turn_on' | 'not_now'> {
    return new Promise((resolve) => {
        Alert.alert(
            t('Turn on notifications?'),
            t("Notifications are off for BeanPool in your phone's settings. Open Settings to turn them on."),
            [
                { text: t('Not now'), style: 'cancel', onPress: () => resolve('not_now') },
                { text: t('Open Settings'), onPress: () => resolve('turn_on') },
            ],
            { cancelable: false },
        );
    });
}

let offering: Promise<unknown> = Promise.resolve();

/**
 * A named line at the member's own act (slice N2a): whether it may show now, by core's rule, and if it may, marked shown
 * now, so it takes the day. Each kind once on a phone; one soft ask a day, the join's day allowing one; nothing where the
 * phone allows notifications without asking (Android 8 to 12), can't load them, or said no. Never asks, never shows
 * anything itself, never throws. One decision at a time, so two screens can't both take the same day.
 */
export function offerNamedLine(kind: NotifyLineKind, storage: StorageLike = AsyncStorage, now: () => number = Date.now): Promise<boolean> {
    const decided = offering.then(async () => {
        const record = await readNotificationPermissionRecord(storage);
        const phone = await readOsNotificationPermission();
        const at = now();
        if (!notifyAsks({ record, phone, now: at, line: kind }).line) return false;
        await writeNotificationPermissionRecord(markNotifyAsk(record, { type: 'shown', surface: 'line', line: kind }, at), storage);
        return true;
    }).catch(() => false);
    offering = decided;
    return decided;
}

/**
 * First steps' line "Hear when someone answers you", from this phone alone (core's notifyFirstStepsLine): null where it
 * has no place (the phone can't load notifications, allows them without being asked, as Android 8 to 12 does, or said
 * no: the line leaves then); false while the phone has to ask, a "Later" included; true once allowed through one of our
 * asks.
 */
export function notifyStep(record: NotificationPermissionRecord, os: OsNotificationPermission): boolean | null {
    return notifyFirstStepsLine(record, os);
}

/** Whether the bell's sheet says notifications are off here: the phone can have them and doesn't allow them now. */
export const notificationsOffHere = (os: OsNotificationPermission): boolean => notifyTurnOn(os) !== 'none';
