/**
 * Who may manage the node, and where /settings deals with each kind of admin work. Pure: shared by the
 * Settings "Manage <community>" button (node-admin.ts) and the header's 🛡️ needs-you icon (needs-you.ts),
 * which must not pull in the phone-unlock module.
 */

export type ManageRole = 'owner' | 'admin';

/** /settings sections the node's admin queue links to — mirrors ADMIN_SETTINGS_SECTIONS on the server. */
export const SETTINGS_SECTIONS = ['home', 'moderation', 'disputes', 'decisions'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export function canManageNode(role: unknown): role is ManageRole {
    return role === 'owner' || role === 'admin';
}

/** One row of GET /api/node-admin/queue (apps/server/src/engine/admin-queue.ts). */
export interface AdminQueueItem {
    kind: string;
    count: number;
    label: string;
    section: SettingsSection;
    settingsPath: string;
}
