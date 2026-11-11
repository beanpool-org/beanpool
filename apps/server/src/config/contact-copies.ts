/**
 * Whether this community keeps members' locked contact lists (scratch/fable-design/DESIGN-private-contacts-fable.md §4.3,
 * slice C1): the owners' switch "Keep members' locked contact lists", on by default.
 *
 * On, each member may keep one locked copy of their own contacts list here (engine/contact-copies.ts), which this server
 * can't open. Off, it keeps none: the routes refuse (`contacts_off`), /api/community/info says `features.contacts: false`,
 * and the copies it held are deleted as the switch goes off (engine/contact-copies.ts dropEveryContactCopy, in the same
 * transaction as the change), each with a tombstone so a standby deletes its copy too. A member's list stays on their
 * devices and at their other communities: the feature never needs any one community.
 *
 * A node_config row (`contact_copies`), one of the community's own settings (config/community-settings.ts): a standby
 * keeps the main server's, and a take-over installs it. The default is no row, so only an owner's "off" is stored.
 * Changed only under How this community works, by an owner (config/community-shape-write.ts).
 */
import { db } from '../db/db.js';

export const CONTACT_COPIES_KEY = 'contact_copies';

/** Whether a `contact_copies` row's value keeps lists: only `off` doesn't; no row, or anything else, is the default (on). */
export function contactCopiesKeptFromRow(value: string | null): boolean {
    return value !== 'off';
}

/** Whether this community keeps members' locked contact lists. */
export function keepsContactCopies(): boolean {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONTACT_COPIES_KEY) as { value: string | null } | undefined;
    return contactCopiesKeptFromRow(row?.value ?? null);
}

/** Set the switch. On (the default) removes the row, so the record holds only what a community changed. */
export function setKeepContactCopies(on: boolean): void {
    if (on) db.prepare('DELETE FROM node_config WHERE key = ?').run(CONTACT_COPIES_KEY);
    else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CONTACT_COPIES_KEY, 'off');
}
