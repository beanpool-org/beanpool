/**
 * Who may manage (or moderate) the node, and where /settings deals with each kind of admin work. Pure: shared by the
 * Settings "Manage <community>" button (node-admin.ts) and the header's 🛡️ needs-you icon (needs-you.ts),
 * which must not pull in the phone-unlock module.
 */

/** Who may open the node's /settings from the app. A moderator's Settings is Reports only (the node enforces it). */
export type ManageRole = 'owner' | 'admin' | 'moderator';

/** /settings sections the node's admin queue links to — mirrors ADMIN_SETTINGS_SECTIONS on the server. */
export const SETTINGS_SECTIONS = ['home', 'moderation', 'disputes', 'decisions'] as const;
export type SettingsSection = typeof SETTINGS_SECTIONS[number];

export function canManageNode(role: unknown): role is ManageRole {
    return role === 'owner' || role === 'admin' || role === 'moderator';
}

/** The button's words: owners and admins manage the community; a moderator moderates it (Reports only). */
export function manageLabel(role: ManageRole, communityName: string): string {
    return role === 'moderator' ? `Moderate ${communityName}` : `Manage ${communityName}`;
}

/** The line under the button: which role, and what pressing it opens. */
export function manageSubtitle(role: ManageRole): string {
    if (role === 'moderator') return "You're a moderator · opens the reports to review, signed in as you";
    return `${role === 'owner' ? "You're an owner" : "You're an admin"} · opens the node's settings, signed in as you`;
}

/** One row of GET /api/node-admin/queue (apps/server/src/engine/admin-queue.ts). */
export interface AdminQueueItem {
    kind: string;
    count: number;
    label: string;
    section: SettingsSection;
    settingsPath: string;
}
