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
import { getDatabaseFilenameForNode } from './nodes';
import { resetSyncFingerprints } from '../services/pillar-sync';

/** The database file and SQLite's own files beside it: the write-ahead log (db.ts opens every copy in WAL mode), its index, a rollback journal. */
const DATABASE_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

/**
 * Take each community's cached copy off this phone. The copy that is open is closed first: left open, it would go on
 * serving and writing a file that is gone. Best effort per file: a file that can't be removed is logged, and the rest go.
 *
 * The directory is the one expo-sqlite opens them in (`defaultDatabaseDirectory`). Sign Out used to guess it, and on
 * Android guessed `databases/`, where nothing is.
 */
export async function removeCommunityCaches(communities: readonly string[]): Promise<void> {
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
    const names = new Set(communities.map((url) => getDatabaseFilenameForNode(url)));
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
