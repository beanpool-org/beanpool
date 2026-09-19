/**
 * The node's admin queue: what is waiting on an owner or admin right now.
 *
 * One count per kind of reactive work the admin surface holds (docs/admin-surface.md §3.1), each with the
 * /settings section that deals with it. The app's header "needs you" badge reads the total; tapping an
 * item opens /settings at its section through the key sign-in link.
 *
 * Counts only — no names, no report text — because the answer goes to a phone and is cached there.
 */

import { db } from '../db/db.js';
import { getShutdownStatus } from './shutdown-recovery.js';

/**
 * Where an item is handled in /settings. The manager maps each id to a tab (and sub-tab); the id is
 * carried in the URL fragment (`/settings#section=<id>`), so anything not on this list is ignored there.
 */
export const ADMIN_SETTINGS_SECTIONS = ['home', 'moderation', 'disputes', 'decisions'] as const;
export type AdminSettingsSection = typeof ADMIN_SETTINGS_SECTIONS[number];

export type AdminQueueKind = 'reports' | 'disputes' | 'suspensions' | 'removals' | 'unclean_shutdown';

export interface AdminQueueItem {
    kind: AdminQueueKind;
    count: number;
    label: string;
    section: AdminSettingsSection;
    settingsPath: string;
}

export interface AdminQueue {
    total: number;
    items: AdminQueueItem[];
}

/** Escrows this old with no completion are listed for a ruling — the /settings disputes panel's default. */
export const DISPUTE_MIN_DAYS = 7;

export function settingsPathFor(section: AdminSettingsSection): string {
    return `/settings#section=${section}`;
}

function count(sql: string, ...params: unknown[]): number {
    return Number((db.prepare(sql).get(...params) as { c: number } | undefined)?.c ?? 0);
}

export function getAdminQueue(): AdminQueue {
    const shutdown = getShutdownStatus();
    const raw: Array<Omit<AdminQueueItem, 'settingsPath'>> = [
        {
            kind: 'reports',
            count: count("SELECT COUNT(*) AS c FROM abuse_reports WHERE status = 'pending' OR status IS NULL"),
            label: 'Reports to review',
            section: 'moderation',
        },
        {
            kind: 'disputes',
            count: count(
                `SELECT COUNT(*) AS c FROM marketplace_transactions
                 WHERE status = 'pending' AND (julianday('now') - julianday(created_at)) >= ?`,
                DISPUTE_MIN_DAYS,
            ),
            label: 'Stalled trades awaiting a ruling',
            section: 'disputes',
        },
        {
            kind: 'suspensions',
            count: count("SELECT COUNT(*) AS c FROM decisions WHERE effect = 'keep_suspension' AND status = 'open'"),
            label: 'Emergency suspensions the community is voting on',
            section: 'decisions',
        },
        {
            kind: 'removals',
            count: count("SELECT COUNT(*) AS c FROM decisions WHERE status = 'execution_pending_grace'"),
            label: 'Removals in their 7-day grace period',
            section: 'decisions',
        },
        {
            kind: 'unclean_shutdown',
            count: shutdown?.uncleanShutdown && !shutdown.acknowledged ? 1 : 0,
            label: 'The node restarted after an unclean shutdown',
            section: 'home',
        },
    ];
    const items = raw
        .filter(i => i.count > 0)
        .map(i => ({ ...i, settingsPath: settingsPathFor(i.section) }));
    return { total: items.reduce((n, i) => n + i.count, 0), items };
}
