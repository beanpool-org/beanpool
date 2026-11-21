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
 * - Never throws and never holds the join: whatever fails, the caller goes on to Home.
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

async function count(deps: NotifyJoinDeps, event: string, variant?: string): Promise<void> {
    await (deps.count ?? defaultCount)(event, variant).catch(() => undefined);
}

/** Whether the join's last screen shows on this phone now (core's `notifyJoinStep`). Never asks; false when unreadable. */
export async function notifyJoinDue(path: NotifyJoinPath, deps: NotifyJoinDeps = {}): Promise<boolean> {
    try {
        const record = await readNotificationPermissionRecord(deps.storage ?? AsyncStorage);
        const phone = await (deps.readOs ?? readOsNotificationPermission)();
        return notifyJoinStep(path, { record, phone, now: (deps.now ?? Date.now)() });
    } catch {
        return false;
    }
}

/** The screen is drawn: it takes the day's soft ask (a join stopped on it resumes on it), and is counted once. */
export async function showNotifyJoin(deps: NotifyJoinDeps = {}): Promise<void> {
    try {
        const storage = deps.storage ?? AsyncStorage;
        const record = await readNotificationPermissionRecord(storage);
        await writeNotificationPermissionRecord(markNotifyAsk(record, { type: 'shown', surface: 'join' }, (deps.now ?? Date.now)()), storage);
    } catch {
        // Not kept: the screen shows all the same.
    }
    await count(deps, NOTIFY_SHOWN);
}

/**
 * "Turn on notifications": the phone's own pop-up (its channels made first), its answer recorded, and counted: 'on', 'no',
 * or 'later' where the pop-up was closed with no answer.
 */
export async function turnOnFromJoin(
    publicKey: string | null,
    deps: NotifyJoinDeps & { turnOn?: TurnOnOptions } = {},
): Promise<'on' | 'later' | 'no'> {
    const storage = deps.storage ?? AsyncStorage;
    let choice: 'on' | 'later' | 'no';
    try {
        choice = notifyJoinChoice(await turnOnNotifications(publicKey, storage, deps.turnOn));
    } catch {
        // No answer to read: a "Later", never a no.
        await notificationsLater(storage, 'join').catch(() => undefined);
        choice = 'later';
    }
    await count(deps, NOTIFY_CHOICE, choice);
    return choice;
}

/** "Later": recorded with its date, never as a no, and counted. The phone's question stays unspent. */
export async function laterFromJoin(deps: NotifyJoinDeps = {}): Promise<'later'> {
    await notificationsLater(deps.storage ?? AsyncStorage, 'join').catch(() => undefined);
    await count(deps, NOTIFY_CHOICE, notifyJoinChoice('later'));
    return 'later';
}
