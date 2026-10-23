/**
 * The one store of every tool on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.2): its document,
 * one row of `tool_docs` (tools/schema.ts) in the community's SQLite file, and its photos, files under the app's own
 * document directory at `tools/<community>/<owner>/<tool>/<ref>.jpg` (800 px, the Offer form's downsize), never inside the document
 * and never on the node. Beside them, the host's own settings for each tool (the backup toggle, which reminders are on,
 * which door the member took, whether the Home card was offered) in app storage under `beanpool_tool:`. The row's
 * `synced_at` and the backup toggle are the node copy's (tools/node-copy.ts, slice T0.4).
 *
 * All data is kept per community, owner and tool (PR #2267 findings 2 + 3). "Remove my data" in one community removes only
 * that community's document, photos, reminders and settings. Leaving or deleting at a community removes all its documents, photos,
 * reminders and settings. An account leaving the phone takes all of it (wipeToolDataOnThisPhone).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { toolDocBytes, toolDocMaxBytes, type ToolLocalCopy, type ToolManifest } from '@beanpool/core';
import { getDb } from '../utils/db';
import { cancelToolReminders, type ToolNotifications } from './reminders';
import { TOOL_DOCS_TABLE, TOOL_SETTINGS_PREFIX } from './schema';
import { communityKey } from './community';

export { TOOL_SETTINGS_PREFIX, communityKey };

/** The host's own settings for one tool, for one owner. Absent fields are the defaults. */
export interface ToolSettings {
    /**
     * "Keep a private copy on your community's server": on by default everywhere (Marty, 19 Oct), for a tool that asks
     * for `node-copy`. The member's choice is the node's; this is the phone's copy of it, written only once the node has
     * answered (tools/node-copy.ts), never by a whole-settings save.
     */
    nodeCopy?: boolean;
    /**
     * The most the community's server said it keeps of this tool's document (its GET's or PUT's `max`), written only by
     * the node copy (tools/node-copy.ts heardMax). The document's bound is never past it (core toolDocMaxBytes), so a
     * newer app on an older server says the truth. Absent: never heard, and the tool's own bound.
     */
    nodeMax?: number;
    /** Each reminder's switch, by its id; absent is the manifest's `defaultOn`. */
    reminders?: Record<string, boolean>;
    /** Which of the empty state's two doors the member took. */
    door?: 'doing' | 'starting';
    /** The tool's Home card has been offered (once, from inside the tool; never added by itself). */
    homeOffered?: boolean;
}

/** A document over its tool's bound: the write is refused, and the tool says why in its own words. */
export class ToolDocTooBigError extends Error {
    constructor(public readonly bytes: number, public readonly max: number) {
        super(`The document is ${bytes} bytes, over its ${max}.`);
        this.name = 'ToolDocTooBigError';
    }
}

export const settingsKey = (community: string, owner: string, tool: string) => `${TOOL_SETTINGS_PREFIX}${community}:${owner}:${tool}`;

export async function readToolSettings(owner: string, tool: string, url?: string | null): Promise<ToolSettings> {
    try {
        const anchorUrl = url ?? await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
        const community = communityKey(anchorUrl);
        const raw = await AsyncStorage.getItem(settingsKey(community, owner, tool));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v === 'object' && !Array.isArray(v) ? v as ToolSettings : {};
    } catch {
        return {};
    }
}

export async function writeToolSettings(owner: string, tool: string, next: ToolSettings, url?: string | null): Promise<void> {
    const anchorUrl = url ?? await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    const community = communityKey(anchorUrl);
    await AsyncStorage.setItem(settingsKey(community, owner, tool), JSON.stringify(next));
}

/** The settings with `patch` over what is stored now: two writers (the screen's, the node copy's) never undo each other. */
export async function patchToolSettings(owner: string, tool: string, patch: ToolSettings, url?: string | null): Promise<ToolSettings> {
    const next = { ...await readToolSettings(owner, tool, url), ...patch };
    await writeToolSettings(owner, tool, next, url);
    return next;
}

/** Whether a reminder is on: the member's switch, else the manifest's default. */
export const reminderOn = (settings: ToolSettings, reminder: { id: string; defaultOn: boolean }): boolean =>
    settings.reminders?.[reminder.id] ?? reminder.defaultOn;

// ── Store change subscriptions ───────────────────────────────────────────────────────────────────────────────────

type ToolStoreListener = (owner: string, tool: string) => void;
const listeners = new Set<ToolStoreListener>();

/** Subscribe to writes and removals in the tool store. */
export function subscribeToolStore(listener: ToolStoreListener): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyToolStore(owner: string, tool: string): void {
    for (const listener of [...listeners]) {
        try { listener(owner, tool); } catch (e) { console.warn('[Tools] Listener failed', e); }
    }
}

// ── The document ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tool's document as this build reads it (`doc.read`, which never throws), and whether one is stored at all. A row
 * that can't be parsed reads as whatever `read` makes of nothing: the empty document.
 */
export async function readToolDoc<D>(owner: string, manifest: ToolManifest<D>): Promise<{ doc: D; stored: boolean }> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM tool_docs WHERE owner = ? AND tool = ?', [owner, manifest.id]);
    if (!row) return { doc: manifest.doc.empty(), stored: false };
    let raw: unknown;
    try {
        raw = JSON.parse(row.body);
    } catch {
        raw = null;
    }
    return { doc: manifest.doc.read(raw), stored: true };
}

/** The row as the node copy reconciles it (tools/node-copy.ts): its body as kept, its write time and its last sync. */
export async function readToolCopy(owner: string, tool: string): Promise<ToolLocalCopy | null> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ body: string; updated_at: string; synced_at: string | null }>(
        'SELECT body, updated_at, synced_at FROM tool_docs WHERE owner = ? AND tool = ?', [owner, tool]);
    return row ? { body: row.body, updatedAt: row.updated_at, syncedAt: row.synced_at ?? null } : null;
}

/**
 * The most the tool's document may take on this phone now: its own bound, and while the server's copy is on, never past
 * what this community's server said it keeps (the settings' `nodeMax`; core toolDocMaxBytes). With the copy off the
 * server holds none of it, so its bound holds nothing; switching on asks the server again and says so if it is more
 * (core turnToolCopyOn, `too-big`). What the host's doc.maxBytes() says, and the write holds to.
 */
export const toolDocMaxHere = (manifest: Pick<ToolManifest, 'doc'>, settings: ToolSettings): number =>
    toolDocMaxBytes(manifest, settings.nodeCopy === false ? undefined : settings.nodeMax);

/**
 * The document written whole (§1.6: one writer, last write wins). Over its bound (toolDocMaxHere, with this community's
 * settings) it is refused with {@link ToolDocTooBigError}, never cut, unless it is no bigger than the row it replaces: one
 * already past the bound (kept before the server said it keeps less) can still be made smaller. `synced_at` (the node
 * copy's, T0.4) is kept as it was.
 */
export async function writeToolDoc<D>(owner: string, manifest: ToolManifest<D>, doc: D, now: number = Date.now()): Promise<void> {
    const max = toolDocMaxHere(manifest, await readToolSettings(owner, manifest.id));
    const bytes = toolDocBytes(doc);
    const db = await getDb();
    if (bytes > max) {
        // The row's body in UTF-8 bytes, as toolDocBytes counts them.
        const held = await db.getFirstAsync<{ bytes: number }>(
            'SELECT length(CAST(body AS BLOB)) AS bytes FROM tool_docs WHERE owner = ? AND tool = ?', [owner, manifest.id]);
        if (bytes > Number(held?.bytes ?? 0)) throw new ToolDocTooBigError(bytes, max);
    }
    await db.runAsync(
        `INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, tool) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        [owner, manifest.id, JSON.stringify(doc), new Date(now).toISOString()],
    );
    notifyToolStore(owner, manifest.id);
}

// ── Taking it off the phone ──────────────────────────────────────────────────────────────────────────────────────

/**
 * "Remove my data from this phone" in a tool's menu: its document, its photos, its reminders and its settings, for
 * this community and owner. Leaves other communities' documents, photos and reminders untouched.
 */
export async function removeToolDataHere(owner: string, tool: string, url?: string | null, notifications?: ToolNotifications | null): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM tool_docs WHERE owner = ? AND tool = ?', [owner, tool]);
    const anchorUrl = url ?? await AsyncStorage.getItem('beanpool_anchor_url').catch(() => null);
    const community = communityKey(anchorUrl);
    await (await import('./photos')).removeToolFolder(community, owner, tool);
    await cancelToolReminders({ community, tool }, notifications);
    await AsyncStorage.removeItem(settingsKey(community, owner, tool));
    notifyToolStore(owner, tool);
}

/**
 * A community is left or deleted: removes all photos, settings and cancels all reminders for this community.
 * (The SQLite file containing tool_docs is removed by community-cache.ts removeCommunityCaches).
 */
export async function removeCommunityToolData(url: string | null, notifications?: ToolNotifications | null): Promise<void> {
    const community = communityKey(url);
    try {
        await (await import('./photos')).removeCommunityPhotos(community);
    } catch (e) {
        console.warn('[Tools] Could not remove community photos', e);
    }
    try {
        await cancelToolReminders({ community }, notifications);
    } catch (e) {
        console.warn('[Tools] Could not cancel community reminders', e);
    }
    try {
        const prefix = `${TOOL_SETTINGS_PREFIX}${community}:`;
        const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
        if (keys.length) await AsyncStorage.multiRemove(keys);
    } catch (e) {
        console.warn('[Tools] Could not remove community tool settings', e);
    }
    notifyToolStore('*', '*');
}

/**
 * The account leaves this phone (Sign Out, Replace, the purge: utils/account-leaves-phone.ts releaseAccountFromPhone;
 * the node-mismatch delete: utils/identity.ts wipeIdentity, which Sign Out reaches too): every tool's every
 * reminder is cancelled, every row of the open community file goes, and the whole tools folder with every photo in it.
 * The other community files go whole with the account's cached copies (utils/community-cache.ts `everyCopy`), and
 * clearDB({ identityLeaves }) drops the table in the open one. Each step is tried even when one before it fails, so a
 * stuck file never keeps a reminder alive; the first failure is thrown at the end, for the caller to log.
 */
export async function wipeToolDataOnThisPhone(notifications?: ToolNotifications | null): Promise<void> {
    let failed: unknown = null;
    const step = async (f: () => Promise<unknown>) => { try { await f(); } catch (e) { failed ??= e; } };
    await step(() => cancelToolReminders(undefined, notifications));
    await step(async () => {
        const db = await getDb();
        // The table first: a file opened since clearDB dropped it has it again, empty; one that never had it gets it.
        if (db) await db.execAsync(`${TOOL_DOCS_TABLE}\n        DELETE FROM tool_docs;`);
    });
    await step(async () => (await import('./photos')).removeEveryToolFolder());
    await step(async () => {
        const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(TOOL_SETTINGS_PREFIX));
        if (keys.length) await AsyncStorage.multiRemove(keys);
    });
    notifyToolStore('*', '*');
    if (failed) throw failed;
}
