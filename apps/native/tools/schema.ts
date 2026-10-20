/**
 * The tools' one table on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.2): one JSON document
 * per tool per owner, in the community's SQLite file beside its cached copy. utils/db.ts runs it with its schema at every
 * open (CREATE TABLE IF NOT EXISTS: additive, idempotent, no existing row touched), and tools/store.ts reads and writes it.
 *
 * Not a cache: a plain `clearDB()` (Settings' re-sync) keeps it; only an account leaving the phone drops it
 * (clearDB({ identityLeaves }), and Sign Out's tools/store.ts wipeToolDataOnThisPhone). No imports, so db.ts can take it
 * without a cycle, and utils/identity.ts the settings' prefix.
 */
export const TOOL_DOCS_TABLE = `
        CREATE TABLE IF NOT EXISTS tool_docs (
            owner TEXT NOT NULL,
            tool TEXT NOT NULL,
            body TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            synced_at TEXT,
            PRIMARY KEY (owner, tool)
        );`;

/** App storage keys of the host's settings for a tool: `beanpool_tool:<community>:<owner>:<tool>`. Sign Out removes the prefix. */
export const TOOL_SETTINGS_PREFIX = 'beanpool_tool:';
