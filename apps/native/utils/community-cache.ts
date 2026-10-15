/**
 * The copy of each community this phone keeps: one SQLite file per community (db.ts `getDb`, named by nodes.ts
 * `getDatabaseFilenameForNode`) in expo-sqlite's own directory. It goes with the account whose copy it is
 * (utils/account-leaves-phone.ts).
 *
 * Loaded only from there, and only as an account leaves, so the modules that restore an account (and their tests)
 * never load the database.
 */
import { defaultDatabaseDirectory } from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import { closeDB } from './db';
import { getDatabaseFilenameForNode, legacyDatabaseFilenameForNode } from './nodes';
import { resetSyncFingerprints } from '../services/pillar-sync';

/**
 * SQLite's own files beside each database: the write-ahead log (db.ts opens every copy in WAL mode), its index, a
 * rollback journal. They go before the database file: one left behind by an interrupted removal would be replayed
 * into the next copy opened under that name, the next account's, with this account's rows in it.
 */
const DATABASE_FILE_SUFFIXES = ['-wal', '-shm', '-journal', ''] as const;

/**
 * A community copy's file, under any name nodes.ts has given one (getDatabaseFilenameForNode, legacyDatabaseFilenameForNode,
 * the no-community file), or one of its side files. Group 1 is the database's own name.
 */
const COMMUNITY_COPY_FILE = /^(community_[a-z0-9._-]{0,40}_[0-9a-f]{32}\.db|beanpool_[A-Za-z0-9_]+\.db|beanpool\.db)(?:-wal|-shm|-journal)?$/;

/**
 * Take each community's cached copy off this phone. The copy that is open is closed first: left open, it would go on
 * serving and writing a file that is gone. Best effort per file: a file that can't be removed is logged, and the rest go.
 *
 * The directory is the one expo-sqlite opens them in (`defaultDatabaseDirectory`). Sign Out used to guess it, and on
 * Android guessed `databases/`, where nothing is.
 *
 * `everyCopy`: the account is leaving this phone (Sign Out, the self-delete purge at its last community, Replace), so
 * every community copy in that directory goes, listed or not. A community a Wipe left is no longer listed, and its file
 * keeps what that identity knew of its groups' keys: a Wipe keeps the identity, so it keeps them (director, NB3 of the
 * #1788 confirmation). Removing every copy as the identity leaves, rather than a record each Wipe would have to keep,
 * also takes a copy left by any other path or an older build (confirmation 2 of #1788, finding 5).
 *
 * `beforeRemoving`: run with the copies that listing found, after the open one is closed and before any goes (Sign Out
 * keeps the account's DM memory of each: db.ts `seedDmPinsBeforeLeaving`). Its failure is logged; the copies go anyway.
 */
export async function removeCommunityCaches(
    communities: readonly string[],
    opts: { everyCopy?: boolean; beforeRemoving?: (copies: string[]) => Promise<void> } = {},
): Promise<void> {
    // What the sync last applied belonged to the copies going now: the next account's sync must not skip a payload
    // because it matches one of them (pillar-sync.ts).
    resetSyncFingerprints();
    await closeDB();

    const directory = typeof defaultDatabaseDirectory === 'string'
        ? defaultDatabaseDirectory.replace(/^file:\/\//, '').replace(/\/+$/, '')
        : '';
    if (!directory) {
        console.warn('[Account] No database directory: the cached community copies stay');
        return;
    }
    // And each one's name from before every community had a file of its own (nodes.ts), in case it never moved
    // (cache-file-migration.ts): the account's copy goes with it either way.
    const names = new Set(communities.flatMap((url) => [getDatabaseFilenameForNode(url), legacyDatabaseFilenameForNode(url)]));
    const found = new Set<string>();
    if (opts.everyCopy) {
        try {
            for (const f of await FileSystem.readDirectoryAsync(encodeURI(`file://${directory}`))) {
                const copy = COMMUNITY_COPY_FILE.exec(f);
                if (copy) found.add(copy[1]);
            }
        } catch (e) {
            console.warn('[Account] Could not list the cached community copies: only the listed ones go', e);
        }
        for (const name of found) names.add(name);
    }
    if (opts.beforeRemoving && found.size > 0) {
        try {
            await opts.beforeRemoving([...found]);
        } catch (e) {
            console.warn('[Account] Could not finish with the cached community copies before they go', e);
        }
    }
    for (const name of names) {
        for (const suffix of DATABASE_FILE_SUFFIXES) {
            try {
                await FileSystem.deleteAsync(encodeURI(`file://${directory}/${name}${suffix}`), { idempotent: true });
            } catch (e) {
                console.warn(`[Account] Could not remove the cached copy ${name}${suffix}`, e);
            }
        }
    }
}
