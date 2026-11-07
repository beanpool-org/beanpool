/**
 * Home's listing card, kept per place and listings version (load rehearsal 7 Nov 2026, §8 fix 1:
 * scratch/global-node/REPORT-global-load-rehearsal-2026-11-07.md). The Market card's read (home-answer.ts marketCard) was a
 * third of the node's busy time in the launch mix: every nearby phone re-reads Home on a new listing's doorbell, and each
 * Home ranked the same listings from the same point again. Here the read is made once and kept for the next reader it is
 * the same for.
 *
 * ## Whose read is kept
 *
 * Only a read made for nobody: a visitor's (the visitors' view, coarse, guestPost) or a member's read made with no viewer at
 * all, which holds the public board alone: no group's or direct listing, nothing hidden by reports, every place to its
 * neighbourhood where the node reads places that way. A member's own read differs from that one only through listings that
 * are theirs to see in their own way (engine getPostsRankedBy: the audience scopes, a post hidden by reports reaching its
 * author, exactPlacesFor), so a member is given the kept read only while nothing on the node is theirs in such a way
 * (readsListingsAsAnyone): no post of theirs, none for them or assigned to them, no group's post in a group they are in or
 * were in, and no enterprise kept. Anyone else is read for themselves as before, and that read is never kept. So no member's
 * private card can be in what another member is given: what is kept was read for nobody.
 *
 * ## When it is read again
 *
 * The kept read is the answer while the listings are as they were: the posts version (engine/versions.ts, bumped by every
 * write that changes a listing read, which the board's 304 already relies on) and the members version are unchanged, and
 * on a node with the directory the directory's stamp (a copy's from-line). As a backstop for anything that moves with the
 * clock (a copy's door that stops being shown), a kept read is never older than KEPT_MAX_MS. The key holds everything
 * else the read is made of: who it is for (a visitor, a member), the point exactly as given, and the switches that order or
 * place it.
 *
 * ## Memory
 *
 * When the listings move, every kept read goes at once (none could be given again); one past KEPT_MAX_MS goes at the next
 * read; and at most KEPT_MAX_ENTRIES are held, the oldest going first. In the launch mix (a new listing every 5 s) that is a
 * few dozen reads of about 40 listings each.
 */
import { getMembersVersion, getPostsVersion } from '../engine/versions.js';
import { directoryStamp } from '../engine/directory-cache.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { db } from '../db/db.js';

/** A kept read is read again after this long whatever else holds (the module's header). */
export const KEPT_MAX_MS = 10_000;
/**
 * The most reads kept at once: one per point and kind of reader, each at most a Market card's pool (about 40 listings), so
 * a few megabytes at most. Only reads of the listings as they are now are kept (a new version drops them all), and none
 * older than KEPT_MAX_MS.
 */
export const KEPT_MAX_ENTRIES = 256;

interface Kept<T> { at: number; value: T }
/** In the order they were made, so the oldest is first: what goes when the cap or the age is reached. */
const kept = new Map<string, Kept<unknown>>();
/** The listings' stamp every kept read was made at (stampNow). */
let keptStamp = '';

/** Reads made and reads given from what was kept, counted for the suite. */
export const homeListingReads = { made: 0, kept: 0 };

/** Everything kept goes (the suite, between worlds). */
export function forgetHomeListings(): void {
    kept.clear();
    keptStamp = '';
    peerAuthors = null;
}

/** How many reads are kept now (the suite). */
export function keptListingCount(): number {
    return kept.size;
}

function stampNow(): string {
    return `${getPostsVersion()}:${getMembersVersion()}:${getProfileSwitches().directoryMirror ? directoryStamp() : ''}`;
}

/**
 * The read for `key`: the kept one while the listings are as they were and it is younger than KEPT_MAX_MS, else `read()`,
 * kept. `key` must hold everything the read is made of but the listings themselves.
 */
export function keptListingRead<T>(key: string, read: () => T, now = Date.now()): T {
    const stamp = stampNow();
    // The listings moved: no read kept can be given again, so none is held on to.
    if (stamp !== keptStamp) {
        kept.clear();
        keptStamp = stamp;
    }
    // The oldest first: those past their age go (a clock set back makes every one too old).
    for (const [k, v] of kept) {
        if (now - v.at >= 0 && now - v.at < KEPT_MAX_MS) break;
        kept.delete(k);
    }
    const hit = kept.get(key);
    if (hit && now - hit.at >= 0 && now - hit.at < KEPT_MAX_MS) {
        homeListingReads.kept++;
        return hit.value as T;
    }
    const versions = `${getPostsVersion()}:${getMembersVersion()}`;
    const value = read();
    homeListingReads.made++;
    // A write while it was read (none happens: a listing read only reads) would leave this read older than its stamp: it is
    // kept only if the versions are still the ones it was asked at.
    if (`${getPostsVersion()}:${getMembersVersion()}` !== versions) return value;
    kept.delete(key);
    kept.set(key, { at: now, value });
    while (kept.size > KEPT_MAX_ENTRIES) {
        const oldest = kept.keys().next().value;
        if (oldest === undefined) break;
        kept.delete(oldest);
    }
    return value;
}

/**
 * The authors of the copies held from other nodes (origin_node set), which no index finds by author: read once per posts
 * version, and never kept longer than KEPT_MAX_MS.
 */
let peerAuthors: { stamp: number; at: number; authors: Set<string> } | null = null;
function authorsOfPeerCopies(now: number): Set<string> {
    const v = getPostsVersion();
    if (!peerAuthors || peerAuthors.stamp !== v || now - peerAuthors.at >= KEPT_MAX_MS || now < peerAuthors.at) {
        const rows = db.prepare('SELECT DISTINCT author_pubkey AS a FROM posts WHERE origin_node IS NOT NULL').all() as { a: string }[];
        peerAuthors = { stamp: v, at: now, authors: new Set(rows.map(r => r.a)) };
    }
    return peerAuthors.authors;
}

let anyoneStmt: ReturnType<typeof db.prepare> | null = null;
let anyoneDb: typeof db | null = null;

/**
 * Whether `member`'s listing read is the read made for nobody (the module's header): nothing on the node is theirs to see
 * in their own way. Any post of theirs (any type, any status, here or a copy from elsewhere), any post for them or assigned
 * to them (whatever its scope), any group's or direct post in a group they have any row in (whatever its status), or a
 * keeper's row for any enterprise (engine enterprisesKeptBy, without its active-member condition) makes it false. Wider than the read's own rules on purpose: a false here only costs the member's
 * read being made for them, as before.
 */
export function readsListingsAsAnyone(member: string, now = Date.now()): boolean {
    if (!anyoneStmt || anyoneDb !== db) {
        anyoneDb = db;
        anyoneStmt = db.prepare(`SELECT
                EXISTS(SELECT 1 FROM posts WHERE author_pubkey = @me AND origin_node IS NULL)
             OR EXISTS(SELECT 1 FROM posts WHERE target_pubkey = @me)
             OR EXISTS(SELECT 1 FROM posts WHERE assigned_to = @me)
             OR EXISTS(SELECT 1 FROM group_members gm JOIN posts p ON p.target_group_id = gm.group_id
                        WHERE gm.member_pubkey = @me AND COALESCE(p.audience_scope, 'public') != 'public')
             OR EXISTS(SELECT 1 FROM treasury_operators WHERE member_pubkey = @me) AS own`);
    }
    if ((anyoneStmt.get({ me: member }) as { own: number }).own) return false;
    return !authorsOfPeerCopies(now).has(member);
}
