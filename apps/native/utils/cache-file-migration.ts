/**
 * Moving a phone's community copies to the names that give every community a file of its own (multi-community review
 * F1, utils/nodes.ts `getDatabaseFilenameForNode`).
 *
 * The old name blotted every character but a letter or digit to `_`, so `mullum.beanpool.org` and `mullum-beanpool.org`
 * shared one SQLite file, one set of sync cursors and one identity epoch. The new name can't collide, and nothing a
 * member had may be lost on the way, nor may they be signed out: so once, before any copy is opened (db.ts `getDb`) or
 * any cursor read (pillar-sync.ts `getSyncCursorKey`), each saved community's file moves to its new name with its
 * cursors, and the sync carries on from where it was, as if nothing happened.
 *
 * For each community the phone knows (the one it is on first, then the saved ones, most recently used first):
 *   1. No file under the old name, or one already under the new name: nothing moves (a new name is never overwritten).
 *   2. Its write-ahead log is folded into the file first (a checkpoint), so the move is one rename of one self-contained
 *      file: never a log arriving at the new name without its database, or a database without its last writes.
 *   3. The file is renamed; the old name's leftover log files go.
 *   4. Its sync cursors (`pillar_sync_<old name>_*`) move to the new name. Only after the file: a cursor without its file
 *      would make the next sync skip everything older than it into an empty copy. A file without its cursors only
 *      costs one whole sync.
 * Two communities that shared one old file (the collision itself, or the two old Beanpool addresses that shared
 * `beanpool.db` on purpose): the file goes to the first of them in that order, the one the phone is on, whose rows it
 * was last written with; the other starts a fresh copy and syncs it whole.
 *
 * Done once per phone (DONE_KEY), and again on the next start if anything failed part way: each step is safe to
 * repeat. Never throws: a copy that can't be moved is synced again under its new name, which is what a new phone does.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { getDatabaseFilenameForNode, getSavedNodes, legacyDatabaseFilenameForNode } from './nodes';

/** Set once every saved community's copy has its new name. */
export const CACHE_NAMES_DONE_KEY = 'beanpool_cache_names_v2';

/** SQLite's own files beside a database (db.ts opens every copy in WAL mode). */
const SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

/** expo-sqlite's directory, without the scheme or a trailing slash; '' where there is none (community-cache.ts). */
function databaseDirectory(): string {
    try {
        const dir: unknown = SQLite.defaultDatabaseDirectory;
        return typeof dir === 'string' ? dir.replace(/^file:\/\//, '').replace(/\/+$/, '') : '';
    } catch {
        return '';
    }
}

function fileUri(directory: string, name: string): string {
    return encodeURI(`file://${directory}/${name}`);
}

async function exists(uri: string): Promise<boolean> {
    return (await FileSystem.getInfoAsync(uri)).exists;
}

/** The communities whose copies may sit under an old name, the first claim to a shared old file first. */
async function communitiesInClaimOrder(): Promise<string[]> {
    const anchor = await AsyncStorage.getItem('beanpool_anchor_url');
    const saved = (await getSavedNodes())
        .filter((n) => typeof n?.url === 'string' && n.url)
        .sort((a, b) => String(b.lastConnected ?? '').localeCompare(String(a.lastConnected ?? '')))
        .map((n) => n.url);
    return [...new Set([...(anchor ? [anchor] : []), ...saved])];
}

/** Move one community's copy and its cursors. Throws when a step fails, leaving what is done safe to repeat. */
async function moveCopy(directory: string, from: string, to: string, keys: readonly string[]): Promise<void> {
    if (!(await exists(fileUri(directory, from)))) {
        // Cut off after the rename but before the cursors moved (the app stopped, or a write threw): the file is at its
        // new name and this copy's cursors are still under the old one. Only this copy's keys can be there, because a
        // shared old file's second claimant never gets here. Finish them, never overwriting one the new name has.
        if (await exists(fileUri(directory, to))) await moveCursors(from, to, keys, false);
        return;
    }
    if (await exists(fileUri(directory, to))) return;

    // Fold the log into the file. Opened under its old name, which nothing else opens any more, and closed again.
    let unfolded = false;
    for (const side of SIDE_FILES) {
        if (await exists(fileUri(directory, `${from}${side}`))) unfolded = true;
    }
    if (unfolded) {
        const old = await SQLite.openDatabaseAsync(from, { useNewConnection: true });
        try {
            await old.execAsync('PRAGMA wal_checkpoint(TRUNCATE);');
        } finally {
            await old.closeAsync();
        }
    }
    // Nothing of another copy's may be read into this one as its log.
    for (const side of SIDE_FILES) {
        await FileSystem.deleteAsync(fileUri(directory, `${to}${side}`), { idempotent: true });
    }
    await FileSystem.moveAsync({ from: fileUri(directory, from), to: fileUri(directory, to) });
    for (const side of SIDE_FILES) {
        await FileSystem.deleteAsync(fileUri(directory, `${from}${side}`), { idempotent: true });
    }

    await moveCursors(from, to, keys, true);
}

/** Move `pillar_sync_<from>_*` to `pillar_sync_<to>_*`, old key removed after the new one is written; safe to repeat. */
async function moveCursors(from: string, to: string, keys: readonly string[], overwrite: boolean): Promise<void> {
    const prefix = `pillar_sync_${from}_`;
    for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const target = `pillar_sync_${to}_${key.slice(prefix.length)}`;
        const value = await AsyncStorage.getItem(key);
        if (value !== null && (overwrite || (await AsyncStorage.getItem(target)) === null)) {
            await AsyncStorage.setItem(target, value);
        }
        await AsyncStorage.removeItem(key);
    }
}

/** Run the move (see the file's comment). Resolves true once every copy has its new name. Never throws. */
export async function renameCommunityCaches(): Promise<boolean> {
    const directory = databaseDirectory();
    if (!directory) return false;
    try {
        if (await AsyncStorage.getItem(CACHE_NAMES_DONE_KEY)) return true;

        const keys = await AsyncStorage.getAllKeys();
        const claimed = new Set<string>();
        let complete = true;
        for (const url of await communitiesInClaimOrder()) {
            const from = legacyDatabaseFilenameForNode(url);
            const to = getDatabaseFilenameForNode(url);
            if (from === to || claimed.has(from)) continue;
            claimed.add(from);
            try {
                await moveCopy(directory, from, to, keys);
            } catch (e) {
                complete = false;
                console.warn(`[DB] Could not move the copy ${from} to ${to}; it is tried again on the next start`, e);
            }
        }
        if (complete) await AsyncStorage.setItem(CACHE_NAMES_DONE_KEY, '1');
        return complete;
    } catch (e) {
        console.warn('[DB] Could not move the community copies to their new names; tried again on the next start', e);
        return false;
    }
}

let renamed: Promise<boolean> | null = null;

/** The move, run once per app start; everything that opens a copy or reads a cursor waits for it. */
export function communityCachesRenamed(): Promise<boolean> {
    return (renamed ??= renameCommunityCaches());
}

/** Tests only: forget that this run moved anything, to play the next app start. */
export function resetCommunityCachesRenamedForTests(): void {
    renamed = null;
}
