/**
 * The one store of every tool on the phone (scratch/tools/DESIGN-tool-template-fable.md §1.6, slice T0.2): its document,
 * one row of `tool_docs` (tools/schema.ts) in the community's SQLite file, and its photos, files under the app's own
 * document directory at `tools/<owner>/<tool>/<ref>.jpg` (800 px, the Offer form's downsize), never inside the document
 * and never on the node. Beside them, the host's own settings for each tool (the backup toggle, which reminders are on,
 * which door the member took, whether the Home card was offered) in app storage under `beanpool_tool:`.
 *
 * Nothing here leaves the phone. The private copy on the node (member_tool_state) is slice T0.4; until it lands the
 * backup line says the document is on this phone only. An account leaving the phone takes all of it
 * ({@link wipeToolDataOnThisPhone}, from utils/identity.ts wipeIdentity): no row, no file, no reminder, no setting.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { TOOL_LIMITS, toolDocBytes, type ToolManifest, type ToolPhoto } from '@beanpool/core';
import { getDb } from '../utils/db';
import { cancelToolReminders, type ToolNotifications } from './reminders';
import { TOOL_DOCS_TABLE, TOOL_SETTINGS_PREFIX } from './schema';

export { TOOL_SETTINGS_PREFIX };

/** The folder of every tool's photos, under the app's document directory. */
export const TOOL_FILES_DIR = 'tools/';

/** The host's own settings for one tool, for one owner. Absent fields are the defaults. */
export interface ToolSettings {
    /** "Keep a private copy on your community's server": on by default everywhere (Marty, 19 Oct). Used from T0.4. */
    nodeCopy?: boolean;
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

const settingsKey = (owner: string, tool: string) => `${TOOL_SETTINGS_PREFIX}${owner}:${tool}`;

export async function readToolSettings(owner: string, tool: string): Promise<ToolSettings> {
    try {
        const raw = await AsyncStorage.getItem(settingsKey(owner, tool));
        const v = raw ? JSON.parse(raw) : null;
        return v && typeof v === 'object' && !Array.isArray(v) ? v as ToolSettings : {};
    } catch {
        return {};
    }
}

export async function writeToolSettings(owner: string, tool: string, next: ToolSettings): Promise<void> {
    await AsyncStorage.setItem(settingsKey(owner, tool), JSON.stringify(next));
}

/** Whether a reminder is on: the member's switch, else the manifest's default. */
export const reminderOn = (settings: ToolSettings, reminder: { id: string; defaultOn: boolean }): boolean =>
    settings.reminders?.[reminder.id] ?? reminder.defaultOn;

// ── The document ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The tool's document as this build reads it (`doc.read`, which never throws), and whether one is stored at all. A row
 * that can't be parsed reads as whatever `read` makes of nothing: the empty document.
 */
export async function readToolDoc<D>(owner: string, manifest: ToolManifest<D>): Promise<{ doc: D; stored: boolean }> {
    const db = await getDb();
    const row = await db.getFirstAsync<{ body: string }>('SELECT body FROM tool_docs WHERE owner = ? AND tool = ?', [owner, manifest.id]);
    if (!row) return { doc: manifest.doc.empty(), stored: false };
    let raw: unknown = null;
    try {
        raw = JSON.parse(row.body);
    } catch {
        raw = null;
    }
    return { doc: manifest.doc.read(raw), stored: true };
}

/**
 * The document written whole (§1.6: one writer, last write wins). Over its bound it is refused with
 * {@link ToolDocTooBigError}, never cut. `synced_at` (the node copy's, T0.4) is kept as it was.
 */
export async function writeToolDoc<D>(owner: string, manifest: ToolManifest<D>, doc: D, now: number = Date.now()): Promise<void> {
    const max = Math.min(manifest.doc.maxBytes ?? TOOL_LIMITS.docBytes, TOOL_LIMITS.docBytes);
    const bytes = toolDocBytes(doc);
    if (bytes > max) throw new ToolDocTooBigError(bytes, max);
    const db = await getDb();
    await db.runAsync(
        `INSERT INTO tool_docs (owner, tool, body, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(owner, tool) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        [owner, manifest.id, JSON.stringify(doc), new Date(now).toISOString()],
    );
}

// ── Photos ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A path segment from a key or id: letters, digits, `_` and `-` only, so no owner key or ref can climb out. */
const segment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96) || '_';
const toolsRoot = () => `${FileSystem.documentDirectory ?? ''}${TOOL_FILES_DIR}`;
const toolDir = (owner: string, tool: string) => `${toolsRoot()}${segment(owner)}/${segment(tool)}/`;

/** Where a photo's file is: what an Image draws. */
export const toolPhotoUri = (owner: string, tool: string, ref: string) => `${toolDir(owner, tool)}${segment(ref)}.jpg`;

/**
 * A picked or taken image kept for a tool: already downsized to 800 px JPEG by the caller (`uri`), copied into the
 * tool's folder under a new ref. The document keeps the ref only.
 */
export async function keepToolPhoto(owner: string, tool: string, image: { uri: string; width: number; height: number }, ref: string): Promise<ToolPhoto> {
    const dir = toolDir(owner, tool);
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    await FileSystem.copyAsync({ from: image.uri, to: toolPhotoUri(owner, tool, ref) });
    return { ref: segment(ref), width: image.width, height: image.height };
}

export async function removeToolPhoto(owner: string, tool: string, ref: string): Promise<void> {
    await FileSystem.deleteAsync(toolPhotoUri(owner, tool, ref), { idempotent: true });
}

/** A kept photo as a `data:` URI, for the Offer composer's draft (its photos are data URIs). Null when it can't be read. */
export async function toolPhotoDataUri(owner: string, tool: string, ref: string): Promise<string | null> {
    try {
        const b64 = await FileSystem.readAsStringAsync(toolPhotoUri(owner, tool, ref), { encoding: 'base64' });
        return b64 ? `data:image/jpeg;base64,${b64}` : null;
    } catch {
        return null;
    }
}

// ── Taking it off the phone ──────────────────────────────────────────────────────────────────────────────────────

/**
 * "Remove my data from this phone" in a tool's menu: its document, its photos, its reminders and its settings, for
 * this owner. (The node copy's tombstone is T0.4's: until it lands nothing of the tool is on the node.)
 */
export async function removeToolDataHere(owner: string, tool: string): Promise<void> {
    const db = await getDb();
    await db.runAsync('DELETE FROM tool_docs WHERE owner = ? AND tool = ?', [owner, tool]);
    await FileSystem.deleteAsync(toolDir(owner, tool), { idempotent: true });
    await cancelToolReminders(tool);
    await AsyncStorage.removeItem(settingsKey(owner, tool));
}

/**
 * The account leaves this phone (Sign Out, Replace, the purge: utils/identity.ts wipeIdentity): every tool's every
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
    await step(() => FileSystem.deleteAsync(toolsRoot(), { idempotent: true }));
    await step(async () => {
        const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(TOOL_SETTINGS_PREFIX));
        if (keys.length) await AsyncStorage.multiRemove(keys);
    });
    if (failed) throw failed;
}
