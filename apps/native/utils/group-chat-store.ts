/**
 * group-chat-store — where a group chat's keys are kept on the phone between sessions: the node's own SQLite file
 * (utils/db.ts getDb, one file per node), tables group_chat_epochs, group_chat_key_state, group_line_verdicts and
 * group_line_signers. Records and wraps are stored exactly as the node served them: ciphertext, nothing an outsider could
 * open without this member's seed (design §4: "cache nothing secret"). The opened keys are never written.
 */
import type { GroupKeyStore, StoredGroupEpoch } from './group-chat-keys';

interface SqliteLike {
    getAllAsync<T>(sql: string, params?: any[]): Promise<T[]>;
    getFirstAsync<T>(sql: string, params?: any[]): Promise<T | null>;
    runAsync(sql: string, params?: any[]): Promise<unknown>;
}

/** Verdicts kept per group: the newest this many (a verdict that falls out is simply verified again). */
const VERDICTS_KEPT = 5000;

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
