/**
 * The mailbox's tables (engine/relay-mail.ts, engine/relay-outbox.ts; db/schema.sql §32), which no copy of this database
 * keeps: `local` in engine/replication-manifest.ts, so never sent to a standby, and emptied in every snapshot and backup
 * file here. Its own small file so the copy's maker (services/address-retention.ts) imports nothing of the mailbox's.
 */
import type Database from 'better-sqlite3';

export const RELAY_MAIL_TABLES = ['relay_mail', 'relay_mail_seen', 'relay_mail_devices', 'relay_mail_got', 'relay_outbox'] as const;

/**
 * Every row of the mailbox out of a copy of the database (a snapshot or a backup file: services/address-retention.ts
 * forgetAddressesInCopy, inside its transaction with secure_delete on, so what goes is zeroed): no copy holds mail waiting,
 * mail sent, the ids seen, or a member's devices and what each has. A copy of a database from before the mailbox has no such table, and is left as it is.
 */
export function forgetRelayMailInCopy(copy: Database.Database): void {
    for (const table of RELAY_MAIL_TABLES) {
        if (copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) copy.prepare(`DELETE FROM ${table}`).run();
    }
}
