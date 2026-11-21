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
 * - The join's last screen (slice N1j, utils/notify-join-step.ts, components/welcome/NotifyStep.tsx) is the join's one
 *   soft ask: "Turn on notifications" brings the phone's pop-up through {@link turnOnNotifications}; "Later" is
 *   {@link notificationsLater}, never a no. Nothing else in the join raises a permission.
 * - Members already in, and a restore on a new phone, never pass the join's screen: Home's once card (slice N1h,
 *   components/home/NotifyAskCard.tsx, {@link offerOnceCard}) is their one soft ask, the join's words once, where the phone
 *   has to ask and still can. Its "Turn on notifications" is this file's one door ({@link turnOnFromOnceCard}); its
 *   "Later" ({@link onceCardLater}) puts it away and is not a no. A restore itself asks nothing.
 */
import { Alert, AppState, Linking, Platform, TurboModuleRegistry, type TurboModule } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type * as ExpoNotifications from 'expo-notifications';
import {
    t, word, markNotifyAsk, notifyAskRecordFrom, notifyAsks, notifyFactWords, notifyFirstStepsLine, notifyOutcomeEvent, notifyPopUpAnswer, notifyTurnOn,
    type NotifyAskEvent, type NotifyAskRecord, type NotifyAskSurface, type NotifyLineKind, type NotifyPopUpRead,
} from '@beanpool/core';
import { NOTIFICATION_PERMISSION_STORE_KEY } from './storage-keys';
import { setNotificationChannels, type ChannelMaker } from './notification-channels';
// services/push-notifications (which require()s expo-notifications as it loads) and ./identity are loaded inside the
// functions that need them, never here: Home and the screens with a notifications line import this file, and six screen suites that don't mock
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
     *  or notifications switched off in the phone's settings: only the phone's settings can turn them on then. On
     *  Android 13+ also after a pop-up closed with no answer: see `cantAskNeedsRecord`. */
    canAskAgain: boolean;
    /** Android 13 and later: "can't ask again" needs this phone's record to mean the phone's no (core's `NotifyPhone`, amend3 §3). */
    cantAskNeedsRecord?: boolean;
    /**
     * Android 13 and later: Android's own "should show a reason" flag, read live (core's `NotifyPhone`, amend4 §3): on once
     * the phone has said "Don't allow" one time and its last pop-up is still to come. Left out where the read fails.
     */
    saidNoOnce?: boolean;
}

/**
 * Android 13 (API 33) and later, where the pop-up exists: Expo marks the permission asked before the pop-up opens, and
 * then reads "denied, can't ask again" for a pop-up closed with no answer as for a second "Don't allow" (amend3 §2).
 */
function androidPopUpPhone(): boolean {
    return Platform?.OS === 'android' && Number(Platform?.Version) >= 33;
}

/** React Native's own permissions module on Android: the one call this file makes of it. */
interface AndroidPermissionsModule extends TurboModule {
    shouldShowRequestPermissionRationale: (permission: string) => Promise<boolean>;
}

const POST_NOTIFICATIONS = 'android.permission.POST_NOTIFICATIONS';

/**
 * Android's own "should show a reason" flag for notifications (amend4 §3), straight from React Native's permissions module
 * (PermissionsModule.kt `shouldShowRequestPermissionRationale`; its public JS has no reader of its own): true once the
 * phone has said "Don't allow" one time and will still show its pop-up. Undefined where it can't be read (no module, no
 * screen in front, a failed call): the rule then reads as amend3 has it. Never throws and never asks.
 */
export async function readAndroidSaidNoOnce(): Promise<boolean | undefined> {
    try {
        const mod = TurboModuleRegistry.get<AndroidPermissionsModule>('PermissionsAndroid');
        if (typeof mod?.shouldShowRequestPermissionRationale !== 'function') return undefined;
        const flag = await mod.shouldShowRequestPermissionRationale(POST_NOTIFICATIONS);
        return typeof flag === 'boolean' ? flag : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Reads the phone's own notification permission. Never throws and never asks. On Android 13+ it also reads Android's own
 * "one no" flag (amend4), so core can tell "said no once" from "never asked", which Expo reads alike.
 */
export async function readOsNotificationPermission(): Promise<OsNotificationPermission> {
    try {
        const notif = await getNotificationsModule();
        if (!notif?.getPermissionsAsync) return { available: false, granted: false, canAskAgain: false };
        const res = await notif.getPermissionsAsync();
        const read: OsNotificationPermission = { available: true, granted: res?.status === 'granted', canAskAgain: res?.canAskAgain !== false };
        if (!androidPopUpPhone()) return read;
        const saidNoOnce = await readAndroidSaidNoOnce();
        return { ...read, cantAskNeedsRecord: true, ...(saidNoOnce === undefined ? {} : { saidNoOnce }) };
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
    /** Reads the phone's state first (the join's screen bounds it, utils/notify-join-step.ts); a throw is the caller's. */
    readOs?: () => Promise<OsNotificationPermission>;
    /** How long Android's channels may take before the pop-up is asked without them (ms); unbounded when not given. */
    channelWaitMs?: number;
    /** Watches whether the app leaves the foreground while Android 13+ asks (tests inject it; the app uses AppState). */
    watchForeground?: () => ForegroundWatch;
}

/** Whether the app left the foreground since the watch began, and its end. */
export interface ForegroundWatch {
    left: () => boolean;
    stop: () => void;
}

/**
 * Android's pop-up is a window of its own: the app leaves the foreground under it (AppState goes to the background, and
 * the window loses focus). Where nothing can be watched, it reads as left: the pop-up is taken to have come (a "Later").
 */
function watchAppForeground(): ForegroundWatch {
    let left = false;
    const subs: Array<{ remove: () => void }> = [];
    try {
        subs.push(AppState.addEventListener('change', (state) => { if (state !== 'active') left = true; }));
        subs.push(AppState.addEventListener('blur', () => { left = true; }));
    } catch {
        left = true;
    }
    return {
        left: () => left,
        stop: () => subs.forEach((sub) => { try { sub.remove(); } catch { /* gone */ } }),
    };
}

/** Waits for `work`, or for `ms` (when given), whichever is first; never rejects. */
async function atMost(work: Promise<unknown>, ms: number | undefined): Promise<void> {
    const settled = work.then(() => undefined, () => undefined);
    if (ms === undefined) return settled;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
    clearTimeout(timer);
}

async function defaultOpenSettings(): Promise<void> {
    await Linking.openSettings().catch((e: unknown) => console.warn('[Push] Could not open the phone settings:', e));
}

/**
 * A tap on "Turn on" (First steps' line, the bell's line, a named line's Tell me, the join's screen, a tool's own switch):
 * the one door to the phone's own pop-up, where it can still show it, so every answer the phone gives is heard and kept.
 * Its yes is recorded and registers the push token. Its no is recorded as the phone's no, with its date ('declined').
 * Closed with no answer, it is a "Later", never a no ('unanswered').
 *
 * What the pop-up answered is read from the ask's own answer, its status and its "can ask again", beside what this phone
 * had on record before it (core's `notifyPopUpAnswer`, amend3 §3.1): on Android 13+ a first "Don't allow" reads back
 * "can ask again", and a pop-up swiped away, backed out of or tapped outside reads "can't ask again" with no answer of the
 * phone's on record: that is a "Later". A second "Don't allow" is the phone's final no.
 *
 * On Android 13+ the phone's read before the tap (`readOs`) carries Android's own "one no" flag, and the ask's own "can ask
 * again" is that flag after it: core takes both (amend4 §3.2), so the last pop-up's two answers can't swap on a phone whose
 * first "Don't allow" isn't on record (1.4.7 wrote it as 'declined'). A flag that couldn't be read leaves amend3's rule.
 *
 * Where the phone won't show its pop-up again (core's `notifyTurnOn` 'settings': iOS after Don't Allow, Android 13+ after
 * a second no or a yes switched off, any phone switched off in its settings), asking would return "denied" with nothing
 * shown, so one line says why and its button opens BeanPool's page in the phone's settings ('settings'); "Not now" there
 * records nothing, as the phone's no already stands. On Android 13+ the same line follows an ask whose pop-up never came
 * up (the app never left the foreground, amend3 §3.3): the phone refused by itself, and nothing is recorded from it.
 */
export async function turnOnNotifications(
    publicKey?: string | null,
    storage: StorageLike = AsyncStorage,
    options: TurnOnOptions = {},
): Promise<TurnOnResult> {
    const os = await (options.readOs ?? readOsNotificationPermission)();
    const before = await readNotificationPermissionRecord(storage);
    const way = notifyTurnOn(os, before);
    const toSettings = async (): Promise<TurnOnResult> => {
        const choice = await (options.confirmSettings ?? settingsPrompt)();
        if (choice !== 'turn_on') return 'unanswered';
        await (options.openSettings ?? defaultOpenSettings)();
        return 'settings';
    };
    if (way === 'settings') return toSettings();
    if (way === 'none') {
        if (!os.granted) return 'unanswered';
        await markNotificationAsk({ type: 'granted' }, storage);
        await registerPushToken(publicKey);
        return 'granted';
    }
    let read: NotifyPopUpRead = { status: 'unanswered', canAskAgain: true };
    const watch = os.cantAskNeedsRecord ? (options.watchForeground ?? watchAppForeground)() : null;
    try {
        const notif = await getNotificationsModule();
        // Android's channels first (slice N1j, amend2 §4.2): Android 13's pop-up shows only once the app has a channel,
        // and a new phone has none before its first token. A channel that can't be made, or (where the caller bounds
        // it) one the phone doesn't make in time, never stops the ask.
        if (notif) await atMost(setNotificationChannels(notif as unknown as ChannelMaker, Platform?.OS === 'android'), options.channelWaitMs);
        if (notif?.requestPermissionsAsync) {
            const res = await notif.requestPermissionsAsync();
            read = { status: res?.status ?? 'unanswered', canAskAgain: res?.canAskAgain !== false };
        }
    } catch {
        // No answer
    } finally {
        watch?.stop();
    }
    const answer = notifyPopUpAnswer(before, os, read);
    if (answer === 'granted') {
        await markNotificationAsk({ type: 'granted' }, storage);
        await registerPushToken(publicKey);
        return 'granted';
    }
    if (answer === 'phone-no') {
        await markNotificationAsk({ type: 'phone-no' }, storage);
        return 'declined';
    }
    if (answer === 'none') return 'unanswered';
    if (read.status === 'denied' && watch && !watch.left()) return toSettings();
    await notificationsLater(storage);
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
 * The fact line over something that waited `days` (a day or more) for the member (slice N3; the first design §4.4, amend1
 * §4.3): whether it may show now, by core's rule (`notifyAsks` `fact`: at most once in 30 days, one soft ask a day, also
 * after a "Later" and after the phone's no), and if it may, marked shown now and its words: "This waited 2 days for you."
 * with "Tell me next time ›", or "Turn on ›" where a tap opens the one line before the phone's settings. Null: no line.
 * Never asks, never throws; one decision at a time with the other soft asks.
 */
export function offerFactLine(days: number, storage: StorageLike = AsyncStorage, now: () => number = Date.now): Promise<{ line: string; link: string } | null> {
    const decided = offering.then(async () => {
        if (!(days >= 1)) return null;
        const record = await readNotificationPermissionRecord(storage);
        const phone = await readOsNotificationPermission();
        const at = now();
        if (!notifyAsks({ record, phone, now: at, waited: true }).fact) return null;
        const words = notifyFactWords(days, phone, record);
        if (!words) return null;
        await writeNotificationPermissionRecord(markNotifyAsk(record, { type: 'shown', surface: 'fact' }, at), storage);
        return words;
    }).catch(() => null);
    offering = decided;
    return decided;
}

/** How long Home waits on the phone's own read before it decides the once card without it (ms): no card that landing. */
export const ONCE_CARD_WAIT_MS = { phone: 4000 };

/** What `read` gives, or null once the phone has had {@link ONCE_CARD_WAIT_MS} without answering, or on a throw. */
function readWithin<T>(read: () => Promise<T>): Promise<T | null> {
    return new Promise<T | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), ONCE_CARD_WAIT_MS.phone);
        Promise.resolve().then(read).then(
            (v) => { clearTimeout(timer); resolve(v); },
            () => { clearTimeout(timer); resolve(null); },
        );
    });
}

/**
 * Home's once card (slice N1h, amend2 §7): whether it shows on this landing, by core's rule (`notifyAsks` `once`: a phone that
 * has to ask and still can, the join's screen never shown here, not after the card's "Later" or its 7 days, one soft ask a
 * day), and if it does, marked shown now, so it takes the day (its 7 days start at its first showing). One decision at a
 * time with the named lines, so a line and the card never take the same day. Never asks, never shows anything itself, never
 * throws; a phone that doesn't say what it allows within {@link ONCE_CARD_WAIT_MS} gets no card that landing, and Home is
 * answered within twice that whatever waits ahead of it.
 *
 * The record is read after the phone (the slow read), and written only where the showing changes it: a return to the app on
 * the day it was marked (back from the phone's pop-up) writes nothing, so it can never put back a record read before the
 * pop-up's answer was kept.
 */
export function offerOnceCard(
    storage: StorageLike = AsyncStorage,
    now: () => number = Date.now,
    readOs: () => Promise<OsNotificationPermission> = readOsNotificationPermission,
): Promise<boolean> {
    let gaveUp = false;
    const decided = offering.then(async () => {
        if (gaveUp) return false;
        const phone = await readWithin(readOs);
        if (!phone || gaveUp) return false;
        const record = await readNotificationPermissionRecord(storage);
        const at = now();
        if (!notifyAsks({ record, phone, now: at }).once) return false;
        const shown = markNotifyAsk(record, { type: 'shown', surface: 'once' }, at);
        const marked = record.askDay === shown.askDay && record.askKind === 'once' && record.onceAt === shown.onceAt;
        if (!marked && !gaveUp) await writeNotificationPermissionRecord(shown, storage);
        return !gaveUp;
    }).catch(() => false);
    offering = decided;
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { gaveUp = true; resolve(false); }, 2 * ONCE_CARD_WAIT_MS.phone);
        void decided.then((v) => { clearTimeout(timer); resolve(v); });
    });
}

/**
 * "Turn on notifications" on Home's once card: the phone's own pop-up through the one door ({@link turnOnNotifications}),
 * so its answer is heard and kept as at every other tap. Then the card's answer is kept as the web keeps its own (core's
 * notifyOutcomeEvent on 'once', apps/pwa lib/web-push.ts turnOnFromAsk), so both apps write the record the same: a yes, or
 * the phone's no, closes the card for good by that answer (`onceClosedAt`, a yes too); anything else (the pop-up closed
 * with no answer, the one Settings line's "Not now", Settings opened) is the card's "Later": put away, never a no.
 * Never throws.
 */
export async function turnOnFromOnceCard(
    publicKey?: string | null,
    storage: StorageLike = AsyncStorage,
    options: TurnOnOptions = {},
): Promise<TurnOnResult> {
    let result: TurnOnResult = 'unanswered';
    try {
        result = await turnOnNotifications(publicKey, storage, options);
    } catch {
        // No answer to read: a "Later", never a no.
    }
    // 'settings' is no answer of the card's: the phone's no already stands, or (Android 13+) its pop-up never came up and
    // nothing is recorded from it (turnOnNotifications); so it is the card's Later here, never a no written from the card.
    const answer = result === 'granted' || result === 'declined' ? result : 'later';
    await markNotificationAsk(notifyOutcomeEvent(answer, 'once'), storage).catch(() => undefined);
    return result;
}

/**
 * Home's card while something of the member's is live (slice N3; the first design §4.3): whether it shows on this landing, by
 * core's rule (`notifyAsks` `home`: a phone that has to ask and still can, not within 7 days of a "Later", not 30 days after
 * its ×, never after the third, never with the once card or the way-back card, one soft ask a day), and if it does, marked
 * shown now, so it takes the day. `live`: core's `notifyLive` found something; `wayBack`: Home's way-back card is up. One
 * decision at a time with the named lines and the once card. Never asks, never shows anything itself, never throws; a phone
 * that doesn't say what it allows within {@link ONCE_CARD_WAIT_MS} gets no card that landing.
 *
 * Written only where the showing changes the record, as the once card's: a later landing on the day it was marked writes
 * nothing, so it can never put back a record read before an answer was kept.
 */
export function offerHomeCard(
    o: { live: boolean; wayBack: boolean },
    storage: StorageLike = AsyncStorage,
    now: () => number = Date.now,
    readOs: () => Promise<OsNotificationPermission> = readOsNotificationPermission,
): Promise<boolean> {
    let gaveUp = false;
    const decided = offering.then(async () => {
        if (gaveUp || !o.live) return false;
        const phone = await readWithin(readOs);
        if (!phone || gaveUp) return false;
        const record = await readNotificationPermissionRecord(storage);
        const at = now();
        if (!notifyAsks({ record, phone, now: at, live: o.live, wayBack: o.wayBack }).home) return false;
        const shown = markNotifyAsk(record, { type: 'shown', surface: 'home' }, at);
        const marked = record.askDay === shown.askDay && record.askKind === 'home';
        if (!marked && !gaveUp) await writeNotificationPermissionRecord(shown, storage);
        return !gaveUp;
    }).catch(() => false);
    offering = decided;
    return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { gaveUp = true; resolve(false); }, 2 * ONCE_CARD_WAIT_MS.phone);
        void decided.then((v) => { clearTimeout(timer); resolve(v); });
    });
}

/** × on Home's card: away for 30 days, and for good at the third (core's rule). Not a no: the named lines go on. Never throws. */
export function homeCardAway(storage: StorageLike = AsyncStorage): Promise<void> {
    return markNotificationAsk({ type: 'away' }, storage).catch(() => undefined);
}

/**
 * Turn on on Home's card while something is live (slice N3): the phone's own pop-up through the one door
 * ({@link turnOnNotifications}), which keeps its answer as at every other tap (a yes, the phone's no, or a pop-up closed with no
 * answer as a "Later", so no Home card for 7 days); where the phone can't ask again, the one line before its settings.
 * Never throws: no answer to read is 'unanswered'.
 */
export async function turnOnFromHomeCard(publicKey?: string | null, storage: StorageLike = AsyncStorage, options: TurnOnOptions = {}): Promise<TurnOnResult> {
    try {
        return await turnOnNotifications(publicKey, storage, options);
    } catch {
        return 'unanswered';
    }
}

/** "Later" on Home's once card: put away for good, recorded with its date, never a no (First steps' line is back). */
export function onceCardLater(storage: StorageLike = AsyncStorage): Promise<void> {
    return notificationsLater(storage, 'once');
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
export const notificationsOffHere = (os: OsNotificationPermission): boolean => notifyTurnOn(os, {}) !== 'none';
