/**
 * A tool's reminders on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.2 `reminders`, §0 row 9; slice T0.2):
 * the manifest's pure `due(doc, now)` says what is due; the host schedules each as a phone-local notification with a
 * date trigger (expo-notifications) and cancels the rest. No push, no server: nothing about it leaves the phone. A tool
 * calls nothing (the `reminders` permission grants no host function); the host schedules after every write of the
 * document and whenever the tool opens, and cancels every one as the account leaves the phone (tools/store.ts).
 *
 * Android keeps a date-triggered notification across an app restart and a reboot (expo-notifications reschedules its
 * alarms at boot); the API 26 emulator check of T0.2 is the director's (the PR says what to check). Each notification
 * names the tool in its data, so a tap opens the tool ({@link toolReminderRoute}): only the app posts a local one.
 */
import { Platform } from 'react-native';
import { t, TOOL_LIMITS, type ToolDue, type ToolManifest } from '@beanpool/core';
import { phoneTool } from './index';

/** Android's channel for every tool's reminders: its own, so a member can quieten them without the community's alerts. */
export const TOOL_REMINDER_CHANNEL = 'tools';
/** Every tool reminder's identifier starts so: `bp-tool:<tool>:<reminder>:<at>`. */
export const TOOL_REMINDER_PREFIX = 'bp-tool:';

/** The part of expo-notifications this needs, so a test hands in its own. */
export interface ToolNotifications {
    getAllScheduledNotificationsAsync(): Promise<Array<{ identifier: string }>>;
    cancelScheduledNotificationAsync(identifier: string): Promise<void>;
    scheduleNotificationAsync(request: {
        identifier: string;
        content: { title: string; body: string; data: Record<string, unknown> };
        trigger: { type: 'date'; date: Date; channelId?: string };
    }): Promise<string>;
    setNotificationChannelAsync?(id: string, channel: { name: string; importance: number; description?: string }): Promise<unknown>;
    AndroidImportance?: { DEFAULT: number };
}

let loaded: ToolNotifications | null | undefined;
/** expo-notifications, or null where it can't load (Expo Go, a test that gives none). */
function deviceNotifications(): ToolNotifications | null {
    if (loaded !== undefined) return loaded;
    try {
        // Loaded on first use, as services/push-notifications.ts does: Expo Go has no local notifications of ours.
        const { default: Constants, ExecutionEnvironment } = require('expo-constants');
        loaded = Constants.executionEnvironment === ExecutionEnvironment.StoreClient ? null : require('expo-notifications');
    } catch {
        loaded = null;
    }
    return loaded ?? null;
}

export const toolReminderId = (tool: string, reminder: string, at: number) => `${TOOL_REMINDER_PREFIX}${tool}:${reminder}:${at}`;

/**
 * What to schedule for one tool now: due() on its document, only the reminders the member has on, only in the future,
 * one per identifier, soonest first, at most TOOL_LIMITS.due. A due() that throws schedules nothing (never a crash).
 */
export function remindersToSchedule<D>(manifest: ToolManifest<D>, doc: D, isOn: (reminderId: string) => boolean, now: number): ToolDue[] {
    if (!manifest.reminders || !manifest.permissions.includes('reminders')) return [];
    const known = new Set(manifest.reminders.list.map((r) => r.id));
    let due: ToolDue[];
    try {
        due = manifest.reminders.due(doc, now);
    } catch {
        return [];
    }
    const seen = new Set<string>();
    return (Array.isArray(due) ? due : [])
        .filter((d) => d && known.has(d.reminder) && isOn(d.reminder) && Number.isFinite(d.at) && d.at > now)
        .sort((a, b) => a.at - b.at)
        .filter((d) => {
            const id = toolReminderId(manifest.id, d.reminder, d.at);
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        })
        .slice(0, TOOL_LIMITS.due);
}

/** Cancel the tool's scheduled reminders, or every tool's with no id. Never throws. */
export async function cancelToolReminders(tool?: string, n: ToolNotifications | null = deviceNotifications()): Promise<void> {
    if (!n) return;
    const prefix = tool ? `${TOOL_REMINDER_PREFIX}${tool}:` : TOOL_REMINDER_PREFIX;
    try {
        for (const s of await n.getAllScheduledNotificationsAsync()) {
            if (s.identifier.startsWith(prefix)) await n.cancelScheduledNotificationAsync(s.identifier);
        }
    } catch (e) {
        console.warn('[Tools] Could not cancel the reminders', e instanceof Error ? e.message : e);
    }
}

/**
 * The tool's reminders made what due() says now: every one scheduled before is cancelled, then each due one scheduled
 * on its date in the tool's channel, titled with the tool's name and saying the manifest's sentence in the member's
 * language. Returns what was scheduled. Never throws.
 */
export async function scheduleToolReminders<D>(
    manifest: ToolManifest<D>, doc: D, isOn: (reminderId: string) => boolean, now: number = Date.now(),
    n: ToolNotifications | null = deviceNotifications(), os: string = Platform.OS,
): Promise<ToolDue[]> {
    if (!n) return [];
    await cancelToolReminders(manifest.id, n);
    const due = remindersToSchedule(manifest, doc, isOn, now);
    if (due.length === 0) return [];
    try {
        if (os === 'android' && n.setNotificationChannelAsync) {
            await n.setNotificationChannelAsync(TOOL_REMINDER_CHANNEL, {
                name: t('Tool reminders'),
                importance: n.AndroidImportance?.DEFAULT ?? 3,
                description: t('Reminders your tools set on this phone. Nothing about them leaves it.'),
            });
        }
        for (const d of due) {
            await n.scheduleNotificationAsync({
                identifier: toolReminderId(manifest.id, d.reminder, d.at),
                content: {
                    title: t(manifest.name),
                    body: t(d.key, d.values),
                    data: { bpLocal: 1, bpTool: manifest.id, ...(d.screen ? { screen: d.screen } : {}) },
                },
                trigger: { type: 'date', date: new Date(d.at), ...(os === 'android' ? { channelId: TOOL_REMINDER_CHANNEL } : {}) },
            });
        }
        return due;
    } catch (e) {
        console.warn('[Tools] Could not schedule the reminders', e instanceof Error ? e.message : e);
        return [];
    }
}

/**
 * Where a tap on a tool's reminder opens: the tool, at the screen due() named when this build has it, else its first.
 * Null for anything else: a push from outside (only the app posts a local notification), a tool this build doesn't have.
 */
export function toolReminderRoute(n: { remote: boolean; data: unknown }): string | null {
    if (n.remote || !n.data || typeof n.data !== 'object') return null;
    const { bpTool, screen } = n.data as { bpTool?: unknown; screen?: unknown };
    if (typeof bpTool !== 'string') return null;
    const tool = phoneTool(bpTool);
    if (!tool) return null;
    const known = typeof screen === 'string' && tool.manifest.screens.includes(screen) && screen !== tool.manifest.screens[0];
    return `/tool/${encodeURIComponent(tool.manifest.id)}${known ? `?screen=${encodeURIComponent(screen as string)}` : ''}`;
}
