/**
 * GitHub is no longer a sign-in (Marty, 2026-09-29): what a server still holds of it goes, at every start.
 *
 * ## Why
 *
 * GitHub's `sub` is the account's public, sequential user id: anyone reads it from GitHub's API with the account's
 * name. So a recovery copy sealed to it is locked to nothing its owner controls, and the hashes made from it (a copy's
 * lookup hash, sso.ts ssoLookupHash, with its salt in the same row; an open-door record's, engine/open-join.ts
 * openJoinHash, with its key in node_config) tell anyone holding a copy of this server's data which GitHub account is
 * which member. Google's and Apple's are not public. So GitHub left the provider table (packages/beanpool-signin), and
 * what a server stored while it was a sign-in is removed here, not kept.
 *
 * ## What goes
 *
 * - Every GitHub recovery copy (`recovery_shares`, holder `sso`/`github`): a linked sign-in (the whole account, sealed
 *   to the `sub`) or a two-layer sign-in piece. The member keeps every other copy, the same bytes, in the next
 *   generation, or, with no other sign-in copy, loses them all with a tombstone, exactly as a disconnect of GitHub
 *   would have left them (engine/recovery-shares.ts removeSignInCopiesAsStored). Either reaches a standby by the normal
 *   path. Their 12 words always work, and Google or Apple still link.
 * - Every released copy of one (`recovery_releases`): what a recovering device was handed, kept as history, and a copy
 *   of the same GitHub-sealed account. Deleted with a tombstone each, as a member's own account deletion deletes theirs
 *   (state-engine.ts deleteReplicatedRows), so a standby deletes them too. Told apart by what it holds: its copy, opened
 *   with this server's key, is the very copy a GitHub row here holds. Not by the share row it names: a server that took
 *   over numbers its rows itself, so that id may be another row's there. A released copy whose GitHub row no server
 *   holds any more (disconnected before this) cannot be told from a Google one and stays, locked with the server's key
 *   like every released copy.
 * - Every GitHub open-door record (`open_joins`, provider `github`). The member stays a member: `invited_by` still says
 *   how they joined (db.ts NO_RECORD_OF_JOINING). No deletion of this table reaches a standby, so every server removes
 *   its own, standby included, and engine/open-join.ts writeOpenJoinRecord refuses one arriving from a main server or a
 *   take-over's keys.
 *
 * ## When
 *
 * At every start: state-engine.ts initStateEngine, and index.ts again once the role is settled (a take-over finished at
 * that start makes a standby the main server). Idempotent: a start that finds nothing writes nothing and says nothing.
 * A main server removes all three; a standby only its open-door records, and takes its main server's removal of the
 * rest by the normal path. A standby that takes over restarts as the main server, so whatever GitHub row it still held
 * goes then. One transaction, the deleted bytes zeroed (secure_delete) and the WAL truncated after, as the recovery
 * seal's migration does. The log line counts, and names nobody.
 */
import { db, writeTombstone } from '../db/db.js';
import { removeSignInCopiesAsStored } from './recovery-shares.js';
import {
    openRecoveryFields,
    releaseRowAad,
    shareRowAad,
    RecoverySealKeyMissing,
    RecoverySealUnopenable,
    type RecoverySealFields,
} from '../services/recovery-seal-key.js';

/** The provider that is no longer a sign-in, as its rows name it. */
const GITHUB = 'github';

export interface GithubRemoval {
    /** GitHub recovery copies removed. */
    copies: number;
    /** Members who had one. */
    members: number;
    /** Of those, members left with no sign-in copy (every copy of theirs went). */
    leftWithout: number;
    /** Released copies of a GitHub copy removed. */
    releases: number;
    /** GitHub open-door records removed. */
    joins: number;
}

/** One copy's client fields, as one string: two stored rows hold the same copy exactly when these match. */
const fingerprint = (f: RecoverySealFields) => JSON.stringify([f.encryptedShare, f.shareIv, f.shareTag, f.kdfParams ?? null]);

/**
 * The released copies here that hold one of the GitHub copies here: each opened with this server's key and compared
 * with every GitHub copy's. One the key does not open (locked with a key this server has not got), or every one when
 * this server has no key at all, cannot be checked and stays: the GitHub copies still go, and the log says how many
 * released copies went unchecked.
 */
function githubReleaseIds(): { ids: number[]; unchecked: number } {
    const copies = db.prepare(`SELECT owner_pubkey, holder_type, encrypted_share, share_iv, share_tag, kdf_params
                               FROM recovery_shares WHERE holder_type = 'sso' AND holder_ref = ?`).all(GITHUB) as Record<string, string | null>[];
    if (copies.length === 0) return { ids: [], unchecked: 0 };
    const releases = db.prepare(`SELECT id, collection_id, share_id, holder_type, payload, payload_iv, payload_tag, kdf_params
                                 FROM recovery_releases WHERE holder_type = 'sso'`).all() as Record<string, string | number | null>[];
    if (releases.length === 0) return { ids: [], unchecked: 0 };
    const held = new Set<string>();
    let unchecked = 0;
    try {
        for (const c of copies) {
            try {
                held.add(fingerprint(openRecoveryFields(
                    { encryptedShare: c.encrypted_share!, shareIv: c.share_iv!, shareTag: c.share_tag!, kdfParams: c.kdf_params },
                    shareRowAad(String(c.owner_pubkey), String(c.holder_type)),
                )));
            } catch (e) {
                if (!(e instanceof RecoverySealUnopenable)) throw e;
            }
        }
        const ids: number[] = [];
        for (const r of releases) {
            try {
                const opened = openRecoveryFields(
                    { encryptedShare: String(r.payload), shareIv: String(r.payload_iv), shareTag: String(r.payload_tag), kdfParams: r.kdf_params as string | null },
                    releaseRowAad(String(r.collection_id), Number(r.share_id), String(r.holder_type)),
                );
                if (held.has(fingerprint(opened))) ids.push(Number(r.id));
            } catch (e) {
                if (!(e instanceof RecoverySealUnopenable)) throw e;
                unchecked++;
            }
        }
        return { ids, unchecked };
    } catch (e) {
        if (e instanceof RecoverySealKeyMissing) return { ids: [], unchecked: releases.length };
        throw e;
    }
}

/**
 * Remove every GitHub row this server holds (see the file's header): on a main server its recovery copies, their
 * released copies and its open-door records; on a standby its open-door records only. One transaction. Throws on a
 * database error, having changed nothing.
 */
export function removeGithubSignIns(opts: { standby: boolean }): GithubRemoval & { releasesUnchecked: number } {
    const result = { copies: 0, members: 0, leftWithout: 0, releases: 0, joins: 0, releasesUnchecked: 0 };
    const owners = opts.standby ? [] : db.prepare(`SELECT DISTINCT owner_pubkey FROM recovery_shares
                                                   WHERE holder_type = 'sso' AND holder_ref = ? ORDER BY owner_pubkey`).pluck().all(GITHUB) as string[];
    const hasJoins = !!db.prepare('SELECT 1 FROM open_joins WHERE provider = ? LIMIT 1').get(GITHUB);
    if (owners.length === 0 && !hasJoins) return result;

    // Worked out before anything is deleted: the GitHub copies are what a released copy is compared with.
    const releases = opts.standby ? { ids: [], unchecked: 0 } : githubReleaseIds();
    result.releasesUnchecked = releases.unchecked;

    const priorSecureDelete = Number(db.pragma('secure_delete', { simple: true })) || 0;
    db.pragma('secure_delete = ON');
    try {
        db.transaction(() => {
            const dropRelease = db.prepare('DELETE FROM recovery_releases WHERE id = ?');
            for (const id of releases.ids) {
                writeTombstone('recovery_releases', String(id));
                result.releases += dropRelease.run(id).changes;
            }
            for (const owner of owners) {
                const r = removeSignInCopiesAsStored(owner, GITHUB);
                // A GitHub copy only in an older generation (none, on a main server: every write drops the older ones) is
                // no copy a member could use, and goes as it lies.
                const stale = db.prepare(`DELETE FROM recovery_shares WHERE owner_pubkey = ? AND holder_type = 'sso' AND holder_ref = ?`)
                    .run(owner, GITHUB).changes;
                if (r.removed + stale === 0) continue;
                result.copies += r.removed + stale;
                result.members++;
                if (!r.signInLeft) result.leftWithout++;
            }
            result.joins = db.prepare('DELETE FROM open_joins WHERE provider = ?').run(GITHUB).changes;
        })();
    } finally {
        db.pragma(`secure_delete = ${priorSecureDelete}`);
    }
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort: the next checkpoint writes over them */ }
    return result;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The role this start last removed as, so index.ts's second call removes again only when a take-over changed it. */
let ranAs: 'main' | 'standby' | null = null;

/**
 * At a server's start (state-engine.ts initStateEngine; index.ts again once the role is settled). Does nothing when
 * it already ran for this role. Never throws: the server starts, and the next start tries again.
 */
export function removeGithubSignInsAtBoot(opts: { standby: boolean }): void {
    const as = opts.standby ? 'standby' : 'main';
    if (ranAs === as) return;
    ranAs = as;
    try {
        const r = removeGithubSignIns(opts);
        if (r.copies || r.releases || r.joins) {
            console.log(`🔐 GitHub is no longer a sign-in: removed ${plural(r.copies, 'GitHub recovery copy', 'GitHub recovery copies')} `
                + `(${plural(r.members, 'member', 'members')}, ${r.leftWithout} of them left with no sign-in copy), `
                + `${plural(r.releases, 'released copy', 'released copies')} and ${plural(r.joins, 'open-door join record', 'open-door join records')}. `
                + 'Members\' 12 words still work, and Google or Apple still link.');
        }
        if (r.releasesUnchecked) {
            console.warn(`⚠️ GitHub sign-in removal: ${plural(r.releasesUnchecked, 'released copy', 'released copies')} could not be opened to check `
                + 'whether it held a GitHub copy (this server has not got the key that locked it), and stayed.');
        }
    } catch (e) {
        ranAs = null;
        console.warn(`⚠️ GitHub sign-in removal failed: ${(e as Error)?.message || e}. Nothing was removed; the next start tries again.`);
    }
}
