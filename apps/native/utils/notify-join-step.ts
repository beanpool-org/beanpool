/**
 * The join's last screen on the phone (DESIGN-notify-and-backup-asks-fable-amend2.md §4, slice N1j): whether it shows, its
 * showing, and its two answers. The screen itself is components/welcome/NotifyStep.tsx; where it sits is app/welcome.tsx
 * (after the way back, before Home or a claim's owner's card); the rule is core's `notifyJoinStep`.
 *
 * - Whether it shows reads this phone's record and the phone's own state, and never asks (the phone's state is read with
 *   `getPermissionsAsync`). An iPhone and Android 13+ that still can ask: yes. Android 8 to 12 (allowed without asking), a
 *   phone that said no, or one that already allows: no. A second community's join after a "Later": yes, on another day.
 * - The phone's own pop-up comes only from "Turn on notifications" (utils/notification-permission.ts
 *   `turnOnNotifications`, which makes Android's channels first). "Later", or the pop-up closed with no answer, records a
 *   "Later" with its date, never a no. The phone's no is recorded apart, with its date.
 * - Counted for the owner's Onboarding panel (N1c: shown; then on, later or no), each once per person per community
 *   (utils/db.ts `recordOnboardingEvent`). A community on an older server refuses the names: that is swallowed there.
 *   Sent and never waited on (amend2 §4.2: the screen waits on no network): each count is a signed POST that a slow
 *   community can hold for 12 s, so the pop-up and the way on never stand behind one. Sent once, never again on a failure.
 * - Never throws and never holds the join: whatever fails, the caller goes on to Home. The phone's own answers are waited
 *   for at most {@link NOTIFY_JOIN_WAIT_MS} (its notification state read; Android's channels, utils/notification-permission.ts):
 *   a phone that never answers reads as nothing to ask, or at the tap as a "Later".
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOTIFY_CHOICE, NOTIFY_SHOWN, markNotifyAsk, notifyJoinChoice, notifyJoinStep, type NotifyJoinPath } from '@beanpool/core';
import {
    notificationsLater, readNotificationPermissionRecord, readOsNotificationPermission, turnOnNotifications,
    writeNotificationPermissionRecord, type OsNotificationPermission, type TurnOnOptions,
} from './notification-permission';
import type { OnboardingFlow } from './onboarding-state';

type StorageLike = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

export interface NotifyJoinDeps {
    storage?: StorageLike;
    readOs?: () => Promise<OsNotificationPermission>;
    now?: () => number;
    /** The owner's count (tests inject it; the app sends utils/db.ts `recordOnboardingEvent`). */
    count?: (event: string, variant?: string) => Promise<void>;
}

/** Which way the join came in by, for core's rule: a claim, the global community's door, another community's, an invite. */
export function notifyJoinPathOf(flow: OnboardingFlow, globalCommunity: boolean): NotifyJoinPath {
    if (flow === 'claim') return 'claim';
    if (flow === 'global') return globalCommunity ? 'global' : 'door';
    return 'invite';
}

async function defaultCount(event: string, variant?: string): Promise<void> {
    const { recordOnboardingEvent } = await import('./db');
    await recordOnboardingEvent(event, variant);
}

/**
 * The owner's count, sent and not waited on: the screen moves on at once, and a count that fails is dropped (never sent
 * again, so it is never counted twice; db.ts counts each once per person per community).
 */
function count(deps: NotifyJoinDeps, event: string, variant?: string): void {
    void Promise.resolve()
        .then(() => (deps.count ?? defaultCount)(event, variant))
        .catch(() => undefined);
}

/**
 * How long the join waits on the phone's own notification module before it goes on without it (ms): its state read
 * (`getPermissionsAsync`) and Android's channels before the pop-up. Never the pop-up itself, which waits on the member.
 * An object, so a test can shorten it.
 */
export const NOTIFY_JOIN_WAIT_MS = { phone: 4000 };

/** Settles with what `work` gives, or rejects once the phone has had {@link NOTIFY_JOIN_WAIT_MS} without answering. */
function phoneAnswers<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the phone did not answer')), NOTIFY_JOIN_WAIT_MS.phone);
        Promise.resolve()
            .then(work)
            .then(
                (v) => { clearTimeout(timer); resolve(v); },
                (e) => { clearTimeout(timer); reject(e); },
            );
    });
}

/**
 * Whether the join's last screen shows on this phone now (core's `notifyJoinStep`). Never asks; false when unreadable, or
 * when the phone hasn't said within {@link NOTIFY_JOIN_WAIT_MS} (the join goes on, never held on a spinner).
 */
export async function notifyJoinDue(path: NotifyJoinPath, deps: NotifyJoinDeps = {}): Promise<boolean> {
    try {
        const record = await readNotificationPermissionRecord(deps.storage ?? AsyncStorage);
        const phone = await phoneAnswers(deps.readOs ?? readOsNotificationPermission);
        return notifyJoinStep(path, { record, phone, now: (deps.now ?? Date.now)() });
    } catch {
        return false;
    }
}

/**
 * The screen is drawn: it takes the day's soft ask (a join stopped on it resumes on it), and is counted once. Resolves once
 * the record is written; the count goes on its own.
 */
export async function showNotifyJoin(deps: NotifyJoinDeps = {}): Promise<void> {
    try {
        const storage = deps.storage ?? AsyncStorage;
        const record = await readNotificationPermissionRecord(storage);
        await writeNotificationPermissionRecord(markNotifyAsk(record, { type: 'shown', surface: 'join' }, (deps.now ?? Date.now)()), storage);
    } catch {
        // Not kept: the screen shows all the same.
    }
    count(deps, NOTIFY_SHOWN);
}

/**
 * "Turn on notifications": the phone's own pop-up (its channels made first), its answer recorded, and counted: 'on', 'no',
 * or 'later' where the pop-up was closed with no answer. Resolves with the phone's answer, never after the count. A phone
 * that doesn't say what it allows within {@link NOTIFY_JOIN_WAIT_MS}, or channels it doesn't make in that time, never hold
 * the pop-up: the first is a "Later" (nothing to ask with), the second asks all the same.
 */
export async function turnOnFromJoin(
    publicKey: string | null,
    deps: NotifyJoinDeps & { turnOn?: TurnOnOptions } = {},
): Promise<'on' | 'later' | 'no'> {
    const storage = deps.storage ?? AsyncStorage;
    const readOs = deps.readOs ?? readOsNotificationPermission;
    let choice: 'on' | 'later' | 'no';
    try {
        choice = notifyJoinChoice(await turnOnNotifications(publicKey, storage, {
            readOs: () => phoneAnswers(readOs),
            channelWaitMs: NOTIFY_JOIN_WAIT_MS.phone,
            ...deps.turnOn,
        }));
    } catch {
        // No answer to read: a "Later", never a no.
        await notificationsLater(storage, 'join').catch(() => undefined);
        choice = 'later';
    }
    count(deps, NOTIFY_CHOICE, choice);
    return choice;
}

/** "Later": recorded with its date, never as a no, and counted (not waited on). The phone's question stays unspent. */
export async function laterFromJoin(deps: NotifyJoinDeps = {}): Promise<'later'> {
    await notificationsLater(deps.storage ?? AsyncStorage, 'join').catch(() => undefined);
    count(deps, NOTIFY_CHOICE, notifyJoinChoice('later'));
    return 'later';
}
