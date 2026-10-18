/**
 * group-chat-store — where a group chat's keys are kept on the phone between sessions: the node's own SQLite file
 * (utils/db.ts getDb, one file per node), tables group_chat_epochs, group_chat_key_state, group_line_verdicts and
 * group_line_signers. Records and wraps are stored exactly as the node served them: ciphertext, nothing an outsider could
 * open without this member's seed (design §4: "cache nothing secret"). The opened keys are never written. Rows are kept
 * under "<identity>/<group>" (GroupKeyring's key), so another identity on this phone starts on its own. A Force Resync or
 * a Wipe keeps the four tables (the sticky lock and the highest epoch are security facts). When the identity leaves (Sign
 * Out, the self-delete purge, Replace) clearDB({ identityLeaves }) drops them in the open file, and every community file
 * on the phone goes, a Wipe's unlisted one too (community-cache.ts `everyCopy`).
 */
import type { GroupKeyStore, StoredGroupEpoch } from './group-chat-keys';

/** The few calls of an expo-sqlite handle this store makes (db.ts hands its own in). */
export interface SqliteLike {
    getAllAsync<T>(sql: string, params?: any[]): Promise<T[]>;
    getFirstAsync<T>(sql: string, params?: any[]): Promise<T | null>;
    runAsync(sql: string, params?: any[]): Promise<unknown>;
}

/** Verdicts kept per group: the newest this many (a verdict that falls out is simply verified again). */
const VERDICTS_KEPT = 5000;

/**
 * The four tables, in every copy's schema (utils/db.ts), and made by {@link addGroupKeyState} in a copy that lacks them.
 * Each epoch's record as the node served it and MY wrap, exactly as sent (ciphertext, nothing secret); the highest epoch
 * verified or made (never falls); verified line signatures (hashes) and the first signer seen per line. Opened keys are
 * never written anywhere.
 */
export const GROUP_KEY_TABLES_SQL = `
        CREATE TABLE IF NOT EXISTS group_chat_epochs (
            group_id TEXT NOT NULL,
            epoch INTEGER NOT NULL,
            record TEXT NOT NULL,
            wrap TEXT,
            PRIMARY KEY (group_id, epoch)
        );
        CREATE TABLE IF NOT EXISTS group_chat_key_state (
            group_id TEXT PRIMARY KEY,
            highest INTEGER NOT NULL DEFAULT 0,
            after INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS group_line_verdicts (
            group_id TEXT NOT NULL,
            k TEXT NOT NULL,
            PRIMARY KEY (group_id, k)
        );
        CREATE TABLE IF NOT EXISTS group_line_signers (
            group_id TEXT NOT NULL,
            message_id TEXT NOT NULL,
            signer TEXT NOT NULL,
            PRIMARY KEY (group_id, message_id)
        );
`;

/**
 * Add what one copy of a community keeps of its groups' keys to another copy of the same community, add-only: a community
 * followed to an address this phone already has a copy for (utils/community-copy-carry.ts). Each group's highest epoch
 * becomes the higher of the two; each epoch and each line's first signer `into` lacks is added; an epoch `into` holds only
 * the node's record of (no wrap) takes `from`'s row with its wrap. So the sticky lock (an epoch verified, opened or made:
 * group-chat-keys.ts seenLocked) holds in `into` when it held in either, and nothing `into` held is lost or lowered. The
 * line verdicts stay behind: one missing is simply verified again. In one transaction; throws when a step fails.
 */
export async function addGroupKeyState(from: SqliteLike, into: SqliteLike & { execAsync(source: string): Promise<unknown> }): Promise<void> {
    const tables = new Set((await from.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((r) => r.name));
    const rows = <T>(table: string, sql: string) => (tables.has(table) ? from.getAllAsync<T>(sql) : Promise.resolve([] as T[]));
    const epochs = await rows<{ group_id: string; epoch: number; record: string; wrap: string | null }>('group_chat_epochs', 'SELECT group_id, epoch, record, wrap FROM group_chat_epochs');
    const states = await rows<{ group_id: string; highest: number; after: number }>('group_chat_key_state', 'SELECT group_id, highest, after FROM group_chat_key_state');
    const signers = await rows<{ group_id: string; message_id: string; signer: string }>('group_line_signers', 'SELECT group_id, message_id, signer FROM group_line_signers');
    await into.execAsync(GROUP_KEY_TABLES_SQL);
    await into.execAsync('BEGIN');
    try {
        for (const e of epochs) {
            await into.runAsync(`INSERT INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES (?, ?, ?, ?)
                                 ON CONFLICT(group_id, epoch) DO UPDATE SET record = excluded.record, wrap = excluded.wrap
                                 WHERE group_chat_epochs.wrap IS NULL AND excluded.wrap IS NOT NULL`, [e.group_id, e.epoch, e.record, e.wrap]);
        }
        for (const st of states) {
            await into.runAsync(`INSERT INTO group_chat_key_state (group_id, highest, after) VALUES (?, ?, ?)
                                 ON CONFLICT(group_id) DO UPDATE SET highest = MAX(highest, excluded.highest)`, [st.group_id, st.highest, st.after]);
        }
        for (const r of signers) {
            await into.runAsync('INSERT OR IGNORE INTO group_line_signers (group_id, message_id, signer) VALUES (?, ?, ?)', [r.group_id, r.message_id, r.signer]);
        }
        await into.execAsync('COMMIT');
    } catch (e) {
        await into.execAsync('ROLLBACK').catch(() => {});
        throw e;
    }
}

export function sqliteGroupKeyStore(getDb: () => Promise<SqliteLike>): GroupKeyStore {
    return {
        async load(groupId) {
            const db = await getDb();
            const rows = await db.getAllAsync<{ epoch: number; record: string; wrap: string | null }>(
                'SELECT epoch, record, wrap FROM group_chat_epochs WHERE group_id = ? ORDER BY epoch', [groupId]);
            const epochs: StoredGroupEpoch[] = [];
            for (const r of rows) {
                try { epochs.push({ epoch: r.epoch, record: JSON.parse(r.record), wrap: r.wrap ? JSON.parse(r.wrap) : null }); } catch { /* a row this version can't read: fetched again */ }
            }
            const st = await db.getFirstAsync<{ highest: number; after: number }>('SELECT highest, after FROM group_chat_key_state WHERE group_id = ?', [groupId]);
            return { epochs, highest: st?.highest ?? 0, after: st?.after ?? 0 };
        },
        async putEpochs(groupId, epochs) {
            const db = await getDb();
            for (const e of epochs) {
                await db.runAsync('INSERT OR REPLACE INTO group_chat_epochs (group_id, epoch, record, wrap) VALUES (?, ?, ?, ?)',
                    [groupId, e.epoch, JSON.stringify(e.record), e.wrap ? JSON.stringify(e.wrap) : null]);
            }
        },
        async setCursor(groupId, after) {
            const db = await getDb();
            await db.runAsync(`INSERT INTO group_chat_key_state (group_id, after) VALUES (?, ?)
                               ON CONFLICT(group_id) DO UPDATE SET after = MAX(after, excluded.after)`, [groupId, after]);
        },
        async raiseHighest(groupId, epoch) {
            const db = await getDb();
            await db.runAsync(`INSERT INTO group_chat_key_state (group_id, highest) VALUES (?, ?)
                               ON CONFLICT(group_id) DO UPDATE SET highest = MAX(highest, excluded.highest)`, [groupId, epoch]);
        },
        async dropWrap(groupId, epoch) {
            const db = await getDb();
            await db.runAsync('UPDATE group_chat_epochs SET wrap = NULL WHERE group_id = ? AND epoch = ?', [groupId, epoch]);
        },
        async loadVerdicts(groupId) {
            const db = await getDb();
            const rows = await db.getAllAsync<{ k: string }>('SELECT k FROM group_line_verdicts WHERE group_id = ? ORDER BY rowid DESC LIMIT ?', [groupId, VERDICTS_KEPT]);
            return rows.map((r) => r.k);
        },
        async addVerdict(groupId, k) {
            const db = await getDb();
            await db.runAsync('INSERT OR IGNORE INTO group_line_verdicts (group_id, k) VALUES (?, ?)', [groupId, k]);
        },
        async loadSigners(groupId) {
            const db = await getDb();
            const rows = await db.getAllAsync<{ message_id: string; signer: string }>('SELECT message_id, signer FROM group_line_signers WHERE group_id = ?', [groupId]);
            return rows.map((r) => [r.message_id, r.signer] as [string, string]);
        },
        async putSigner(groupId, messageId, signer) {
            const db = await getDb();
            await db.runAsync('INSERT OR IGNORE INTO group_line_signers (group_id, message_id, signer) VALUES (?, ?, ?)', [groupId, messageId, signer]);
        },
    };
}
