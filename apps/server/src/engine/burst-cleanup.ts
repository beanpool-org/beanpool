/**
 * Clean-up by burst (global two-doors design §4.4, slice S9): from one account, the moderators see the others that joined
 * through the open door from the same connection within a day of it, and hide all their posts, or remove them, together.
 * A spam wave from one network is then undone in one action instead of one post at a time.
 *
 * ## "The same connection within a day", and all anyone is shown of it
 *
 * The door gives each join a connection label (`open_joins.join_cohort`, engine/open-join.ts joinCohortFor): a random
 * label shared by the joins from one internet address (an IPv6 /64) within a day of the first of them. Never the address,
 * and not derived from it. A burst is the accounts that share one. Nothing here reads the address hash, and no answer
 * carries the label or anything about the network: only which accounts share one, which the screens say as "joined from
 * the same connection within a day". A member who deleted their own account has no label any more (releaseOpenJoin), so
 * they are in nobody's burst; a member who came by invite, or joined before labels, has none either.
 *
 * ## Who
 *
 * It exists where the door does (`openJoin`, the global profile's): elsewhere every route is 404. Owners, admins and
 * moderators see a burst, hide its posts and undo a hide. A moderator, whose screen is the reports and nothing else, sees
 * the burst of an account with an open report (about them, or one of their posts) or of one in a burst the digest lists
 * (`BURST.digestMinAccounts` or more, the first of them in the last `BURST.digestDays` days); owners and admins see any
 * account's, as they see the members. Removing is the removal there already is (state-engine adminPruneUser, the caller's
 * `prune`), with its rules: owners and admins only, as for one member; the removed key is refused from then on, and the
 * sign-in it joined with can't join again (engine/open-join.ts openJoinTaken keeps the row of a removed member).
 *
 * ## The guard: one click can't take out a real crowd
 *
 * A carrier's shared address can put real people in one burst. So an action names exactly the accounts it acts on and
 * says how many (`count`), and the screens show each one's standing before asking. Every account named must be in the
 * burst and still here; none may hold a node role (which also keeps out whoever is acting: they hold one, or act with the
 * password and are no account). An established account (standing `BURST.establishedStanding` or more:
 * engine/auto-moderation.ts standingParts) is named only with `includeEstablished`, which the screens send only after
 * saying so. A refusal does nothing at all. An account that joined after the list was read is never reached: it was not
 * named.
 *
 * ## A hide, and its undo
 *
 * A hide sets `posts.hidden_by_reports_at`, one stamp for the whole action, on every post of the named accounts that is
 * not already hidden or cancelled: the hidden-for-review state reports put a post in, so everything that keeps such a post
 * from everyone but its author and the moderators applies (the listings, search, the map, the feed, a standby's copy),
 * and a moderator can still restore or remove each one as it is. Each author is told once, without why or by whom. The
 * action is recorded (`burst_actions`, `burst_action_posts`). Its undo un-hides each of its posts that still carries its
 * stamp, unless reports from enough independent circles would hide it now (engine/auto-moderation.ts hideTally), and
 * tells each author once. A post restored, removed or re-hidden on its own meanwhile is left as it is. The record is this
 * server's (a standby never copies it): after a take-over the posts stay hidden, and are restored one at a time. Records
 * go after `BURST.keepActionsDays` days, and a member who deletes their own account, and so their label, leaves them
 * (`forgetBurstActionsOf`).
 *
 * ## The digest
 *
 * `burstDigest`: one line per recent burst of `BURST.digestMinAccounts` or more (how many, how many are still here, how
 * many were removed or reported, how many of their posts are hidden), and one per action taken in the last
 * `BURST.keepActionsDays` days. The moderators' signal; it refuses nobody.
 */
import crypto from 'node:crypto';
import { db } from '../db/db.js';
import { getProfileSwitches } from '../config/node-profile.js';
import { provenKeySpelling } from './member-key.js';
import { bumpActivityVersion, bumpPostsVersion } from './versions.js';
import { AUTO_HIDE, hideTally, standingParts } from './auto-moderation.js';
import { notifyPostsBack, notifyPostsHiddenForReview, type ModerationNoticeCallbacks } from './moderation-notices.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

export const BURST = {
    /** Standing (points: engine/auto-moderation.ts) from which an account is established: a month as a member, or a week and kept posts. */
    establishedStanding: 4,
    /** The digest lists a burst of at least this many accounts... */
    digestMinAccounts: 5,
    /** ...whose first join was within this many days. */
    digestDays: 7,
    /** The most bursts the digest lists, newest first. */
    digestMaxLines: 50,
    /** One action names at most this many accounts. */
    maxAccountsPerAction: 500,
    /** An action's record (and so a hide's undo) is kept this long. */
    keepActionsDays: 30,
} as const;

/** Where the door labels joins. Everywhere else every burst route is 404. */
export function burstCleanupOn(): boolean {
    return getProfileSwitches().openJoin;
}

export type BurstActorRole = 'owner' | 'admin' | 'moderator';

export interface BurstAccount {
    publicKey: string;
    callsign: string | null;
    /** When they joined through the door. */
    joinedAt: string;
    status: 'active' | 'suspended' | 'removed';
    standing: number;
    standingParts: { weeks: number; keptPosts: number; dealPartners: number };
    /** Standing BURST.establishedStanding or more: an action names them only with `includeEstablished`. */
    established: boolean;
    /** Their posts up for everyone (not hidden, not cancelled). */
    postsUp: number;
    /** Their posts hidden for review, by reports or a moderator. */
    postsHidden: number;
    /** Open reports about them or one of their posts. */
    openReports: number;
    /** They hold a node role (owner, admin, moderator): never named in an action. */
    holdsRole: boolean;
}

export interface Burst {
    account: BurstAccount;
    /** False for a member who came another way (an invite, the genesis) or joined before the door labelled joins. */
    joinedThroughDoor: boolean;
    /** The rest of the burst still here (active or suspended), oldest join first. */
    others: BurstAccount[];
    /** How many of the rest were removed. */
    removedAlready: number;
}

interface JoinRow { member_pubkey: string; joined_at: string; callsign: string | null; status: string | null }

const statusWord = (s: string | null): BurstAccount['status'] => (s === 'pruned' ? 'removed' : s === 'disabled' ? 'suspended' : 'active');

function labelOf(pubkey: string): string | null {
    return (db.prepare('SELECT join_cohort FROM open_joins WHERE member_pubkey = ?').get(pubkey) as { join_cohort: string | null } | undefined)?.join_cohort ?? null;
}

function burstRows(label: string): JoinRow[] {
    return db.prepare(`
        SELECT oj.member_pubkey, oj.joined_at, m.callsign, m.status
          FROM open_joins oj JOIN members m ON m.public_key = oj.member_pubkey
         WHERE oj.join_cohort = ?
         ORDER BY oj.joined_at, oj.member_pubkey
    `).all(label) as JoinRow[];
}

const OPEN_REPORT = "(ar.status = 'pending' OR ar.status IS NULL)";

function openReportsOn(pubkey: string): number {
    return (db.prepare(`
        SELECT COUNT(*) AS c FROM abuse_reports ar
         WHERE ${OPEN_REPORT}
           AND (ar.target_pubkey = ? OR ar.target_post_id IN (SELECT id FROM posts WHERE author_pubkey = ?))
    `).get(pubkey, pubkey) as { c: number }).c;
}

function holdsRole(pubkey: string): boolean {
    return !!db.prepare('SELECT 1 FROM node_roles WHERE member_pubkey = ? UNION ALL SELECT 1 FROM suspended_node_roles WHERE member_pubkey = ? LIMIT 1')
        .get(pubkey, pubkey);
}

function describe(row: JoinRow, now: number): BurstAccount {
    const pk = row.member_pubkey;
    const parts = standingParts(pk, now);
    const posts = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN hidden_by_reports_at IS NULL THEN 1 ELSE 0 END), 0) AS up,
               COALESCE(SUM(CASE WHEN hidden_by_reports_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS hidden
          FROM posts WHERE author_pubkey = ? AND origin_node IS NULL AND status != 'cancelled'
    `).get(pk) as { up: number; hidden: number };
    return {
        publicKey: pk,
        callsign: row.callsign,
        joinedAt: row.joined_at,
        status: statusWord(row.status),
        standing: parts.total,
        standingParts: { weeks: parts.weeks, keptPosts: parts.keptPosts, dealPartners: parts.dealPartners },
        established: parts.total >= BURST.establishedStanding,
        postsUp: posts.up,
        postsHidden: posts.hidden,
        openReports: openReportsOn(pk),
        holdsRole: holdsRole(pk),
    };
}

/** The member's row, for an account the door has no record of. */
function memberRow(pubkey: string): JoinRow | null {
    const m = db.prepare('SELECT public_key, callsign, status, joined_at FROM members WHERE public_key = ? AND COALESCE(is_treasury, 0) = 0 AND COALESCE(is_visitor, 0) = 0')
        .get(pubkey) as { public_key: string; callsign: string | null; status: string | null; joined_at: string | null } | undefined;
    return m ? { member_pubkey: m.public_key, joined_at: m.joined_at ?? '', callsign: m.callsign, status: m.status } : null;
}

/** Whether this key is a member's row here (any status), not an enterprise's or a visitor's: an account a burst opens from. */
export function isBurstAccount(pubkey: string): boolean {
    return memberRow(pubkey) !== null;
}

/** A key as the member table spells it, or null when it is no key. */
export function burstKey(raw: unknown): string | null {
    return provenKeySpelling(raw);
}

/** The burst of this member, or null when the key is no member here. */
export function readBurst(pubkey: string, now: number = Date.now()): Burst | null {
    const self = memberRow(pubkey);
    if (!self) return null;
    const label = labelOf(pubkey);
    if (!label) return { account: describe(self, now), joinedThroughDoor: false, others: [], removedAlready: 0 };
    const rows = burstRows(label);
    const mine = rows.find(r => r.member_pubkey === pubkey) ?? self;
    const rest = rows.filter(r => r.member_pubkey !== pubkey);
    return {
        account: describe(mine, now),
        joinedThroughDoor: true,
        others: rest.filter(r => r.status !== 'pruned').map(r => describe(r, now)),
        removedAlready: rest.filter(r => r.status === 'pruned').length,
    };
}

/** Whether the digest lists this burst: enough accounts, the first of them recently. */
function listedInDigest(rows: { joined_at: string }[], now: number): boolean {
    if (rows.length < BURST.digestMinAccounts) return false;
    const first = Math.min(...rows.map(r => Date.parse(r.joined_at)).filter(Number.isFinite));
    return Number.isFinite(first) && first >= now - BURST.digestDays * DAY_MS;
}

/**
 * Whether a moderator may open this account's burst: one with an open report about them or one of their posts, or one in
 * a burst the digest lists. Owners and admins may open any.
 */
export function moderatorMayOpen(pubkey: string, now: number = Date.now()): boolean {
    if (openReportsOn(pubkey) > 0) return true;
    const label = labelOf(pubkey);
    return !!label && listedInDigest(burstRows(label), now);
}

export interface BurstSelectionInput {
    members?: unknown;
    count?: unknown;
    includeEstablished?: unknown;
}

export type BurstRefusal = { ok: false; status: number; code: string; error: string; established?: string[] };
export type BurstSelection = { ok: true; keys: string[] } | BurstRefusal;

const refuse = (status: number, code: string, error: string, extra: { established?: string[] } = {}): BurstRefusal =>
    ({ ok: false, status, code, error, ...extra });

/**
 * The guard (the file header): the accounts an action may act on, exactly as named, or why not. Reads the burst as it is
 * now, so a list read earlier can't reach an account that has since joined or been removed.
 */
export function checkBurstSelection(anchor: string, input: BurstSelectionInput, now: number = Date.now()): BurstSelection {
    const raw = input?.members;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > BURST.maxAccountsPerAction) {
        return refuse(400, 'bad_selection', `Name the accounts to act on: between 1 and ${BURST.maxAccountsPerAction} of them.`);
    }
    const keys = raw.map(burstKey);
    if (keys.some(k => k === null)) return refuse(400, 'bad_selection', 'Each account is named by its key.');
    if (new Set(keys).size !== keys.length) return refuse(400, 'bad_selection', 'An account is named more than once.');
    if (input.count !== keys.length) {
        return refuse(400, 'bad_selection', `Say how many accounts this acts on: ${keys.length} are named.`);
    }
    const burst = readBurst(anchor, now);
    const inBurst = new Map<string, BurstAccount>();
    if (burst?.joinedThroughDoor) {
        for (const a of [burst.account, ...burst.others]) if (a.status !== 'removed') inBurst.set(a.publicKey, a);
    }
    const chosen = keys as string[];
    if (chosen.some(k => !inBurst.has(k))) {
        return refuse(409, 'not_in_burst', 'Some of these accounts did not join from the same connection within a day as this one, or were removed since. Load the list again.');
    }
    if (chosen.some(k => inBurst.get(k)!.holdsRole)) {
        return refuse(403, 'holds_role', 'One of these accounts holds a role here (owner, admin or moderator). Take the role away first, or leave them out.');
    }
    const established = chosen.filter(k => inBurst.get(k)!.established);
    if (established.length > 0 && input.includeEstablished !== true) {
        return refuse(409, 'established', `${established.length === 1 ? 'One of these accounts is' : `${established.length} of these accounts are`} established here (standing ${BURST.establishedStanding} or more). Check them, and confirm you mean them too.`, { established });
    }
    return { ok: true, keys: chosen };
}

export interface BurstActionSummary { id: string; kind: 'hide' | 'remove'; accounts: number; posts: number }

function pruneOldActions(now: number): void {
    const cutoff = iso(now - BURST.keepActionsDays * DAY_MS);
    db.transaction(() => {
        db.prepare('DELETE FROM burst_action_posts WHERE action_id IN (SELECT id FROM burst_actions WHERE at < ?)').run(cutoff);
        db.prepare('DELETE FROM burst_actions WHERE at < ?').run(cutoff);
    })();
}

/** Hidden or visible again: every copy anyone holds has to change (as engine/auto-moderation.ts announces one post). */
function announce(cb: ModerationNoticeCallbacks, postIds: string[]): void {
    if (postIds.length === 0) return;
    bumpPostsVersion();
    bumpActivityVersion();
    for (const id of postIds) {
        try { cb.broadcast({ type: 'post_updated', id }); } catch (e: any) { console.warn('[Burst] Doorbell failed:', e?.message || e); }
    }
}

/**
 * Hide every post of these accounts (already checked: `checkBurstSelection`) that is not hidden or cancelled, in one
 * action with one stamp, and tell each author once.
 */
export function hideBurstPosts(cb: ModerationNoticeCallbacks, anchor: string, keys: string[], byRole: BurstActorRole, now: number = Date.now()): BurstActionSummary {
    pruneOldActions(now);
    const at = iso(now);
    const id = crypto.randomUUID();
    const hidden: { id: string; author: string }[] = [];
    db.transaction(() => {
        const select = db.prepare(`SELECT id FROM posts
                                    WHERE author_pubkey = ? AND origin_node IS NULL AND hidden_by_reports_at IS NULL AND status != 'cancelled'`);
        const hide = db.prepare('UPDATE posts SET hidden_by_reports_at = ?, updated_at = ? WHERE id = ? AND hidden_by_reports_at IS NULL');
        const record = db.prepare('INSERT INTO burst_action_posts (action_id, post_id) VALUES (?, ?)');
        for (const author of keys) {
            for (const p of select.all(author) as { id: string }[]) {
                if (hide.run(at, at, p.id).changes === 0) continue;
                record.run(id, p.id);
                hidden.push({ id: p.id, author });
            }
        }
        db.prepare('INSERT INTO burst_actions (id, kind, at, by_role, anchor_pubkey, accounts, posts) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, 'hide', at, byRole, anchor, keys.length, hidden.length);
    })();
    announce(cb, hidden.map(h => h.id));
    const perAuthor = new Map<string, number>();
    for (const h of hidden) perAuthor.set(h.author, (perAuthor.get(h.author) ?? 0) + 1);
    for (const [author, n] of perAuthor) notifyPostsHiddenForReview(cb, author, n);
    console.log(`🛡️ Burst hide ${id}: ${hidden.length} post(s) of ${keys.length} account(s) that joined from one connection within a day, by a ${byRole}.`);
    return { id, kind: 'hide', accounts: keys.length, posts: hidden.length };
}

export type UndoOutcome =
    | { ok: true; restored: number; keptHidden: number }
    | { ok: false; status: number; code: string; error: string };

/**
 * Undo a hide: un-hide each post it hid that still carries its stamp, unless reports from enough independent circles
 * would hide it now, and tell each author once. A post restored, removed or hidden again on its own since is left alone.
 */
export function undoBurstHide(cb: ModerationNoticeCallbacks, actionId: string, now: number = Date.now()): UndoOutcome {
    pruneOldActions(now);
    const action = db.prepare('SELECT id, kind, at, undone_at FROM burst_actions WHERE id = ?').get(actionId) as
        { id: string; kind: string; at: string; undone_at: string | null } | undefined;
    if (!action) return { ok: false, status: 404, code: 'not_found', error: 'There is no such action here (an action is kept for 30 days).' };
    if (action.kind !== 'hide') return { ok: false, status: 409, code: 'not_a_hide', error: 'Only a hide can be undone. A removal stays.' };
    if (action.undone_at) return { ok: false, status: 409, code: 'already_undone', error: 'This hide was already undone.' };
    const reportsHide = getProfileSwitches().autoHideReports;
    const back: { id: string; author: string | null; live: boolean }[] = [];
    let keptHidden = 0;
    const at = iso(now);
    const done = db.transaction((): boolean => {
        // Claimed first, so two undos at once can't both run.
        if (db.prepare('UPDATE burst_actions SET undone_at = ? WHERE id = ? AND undone_at IS NULL').run(at, actionId).changes === 0) return false;
        const posts = db.prepare(`SELECT p.id, p.author_pubkey, p.active, p.status, m.status AS author_status
                                    FROM burst_action_posts bp JOIN posts p ON p.id = bp.post_id
                                    LEFT JOIN members m ON m.public_key = p.author_pubkey
                                   WHERE bp.action_id = ? AND p.hidden_by_reports_at = ?`)
            .all(actionId, action.at) as { id: string; author_pubkey: string | null; active: number; status: string; author_status: string | null }[];
        const unhide = db.prepare('UPDATE posts SET hidden_by_reports_at = NULL, updated_at = ? WHERE id = ? AND hidden_by_reports_at = ?');
        for (const p of posts) {
            if (reportsHide && hideTally(p.id, now).circles.length >= AUTO_HIDE.circles) { keptHidden++; continue; }
            if (unhide.run(at, p.id, action.at).changes === 0) continue;
            back.push({ id: p.id, author: p.author_status === 'pruned' ? null : p.author_pubkey, live: p.active === 1 && p.status !== 'cancelled' });
        }
        return true;
    })();
    if (!done) return { ok: false, status: 409, code: 'already_undone', error: 'This hide was already undone.' };
    announce(cb, back.map(b => b.id));
    const perAuthor = new Map<string, number>();
    for (const b of back) if (b.author && b.live) perAuthor.set(b.author, (perAuthor.get(b.author) ?? 0) + 1);
    for (const [author, n] of perAuthor) notifyPostsBack(cb, author, n);
    console.log(`🛡️ Burst hide ${actionId} undone: ${back.length} post(s) back, ${keptHidden} kept hidden by reports.`);
    return { ok: true, restored: back.length, keptHidden };
}

export interface BurstRemoval {
    action: BurstActionSummary;
    removed: number;
    /** Accounts the removal refused, each with why: the rest were removed. */
    failed: { publicKey: string; error: string }[];
}

/**
 * Remove these accounts (already checked: `checkBurstSelection`), each by `prune`, the removal there already is
 * (state-engine adminPruneUser with the authenticated actor), and record the action.
 */
export function removeBurst(prune: (pubkey: string) => void, anchor: string, keys: string[], byRole: BurstActorRole, now: number = Date.now()): BurstRemoval {
    pruneOldActions(now);
    let removed = 0;
    const failed: { publicKey: string; error: string }[] = [];
    for (const k of keys) {
        try { prune(k); removed++; } catch (e: any) { failed.push({ publicKey: k, error: e?.message || 'Could not remove this account' }); }
    }
    const id = crypto.randomUUID();
    db.prepare('INSERT INTO burst_actions (id, kind, at, by_role, anchor_pubkey, accounts, posts) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(id, 'remove', iso(now), byRole, anchor, removed);
    console.log(`🛡️ Burst removal ${id}: ${removed} account(s) that joined from one connection within a day removed by a ${byRole}${failed.length ? `, ${failed.length} refused` : ''}.`);
    return { action: { id, kind: 'remove', accounts: removed, posts: 0 }, removed, failed };
}

export interface BurstDigestLine {
    accounts: number;
    stillHere: number;
    removed: number;
    /** Accounts with an open report about them or one of their posts. */
    reported: number;
    postsHidden: number;
    firstJoinAt: string;
    lastJoinAt: string;
    /** The account to open it from: the first reported one still here, else the first still here; null when none is. */
    open: { publicKey: string; callsign: string | null } | null;
}

export interface BurstActionLine {
    id: string;
    kind: 'hide' | 'remove';
    at: string;
    by: BurstActorRole;
    accounts: number;
    posts: number;
    undoneAt: string | null;
    /** The account the burst was opened from, while it is a member here. */
    account: { publicKey: string; callsign: string | null } | null;
}

export interface BurstDigest {
    bursts: BurstDigestLine[];
    actions: BurstActionLine[];
    minAccounts: number;
    days: number;
}

/** The digest (the file header): recent bursts big enough to list, and the actions taken lately, newest first. */
export function burstDigest(now: number = Date.now()): BurstDigest {
    pruneOldActions(now);
    const since = iso(now - BURST.digestDays * DAY_MS);
    // A label spans at most a day, so every row of a burst whose first join is in the window joined after `since`.
    const labels = db.prepare(`
        SELECT join_cohort AS label FROM open_joins
         WHERE join_cohort IS NOT NULL AND joined_at >= ?
         GROUP BY join_cohort HAVING COUNT(*) >= ?
         ORDER BY MIN(joined_at) DESC LIMIT ?
    `).all(since, BURST.digestMinAccounts, BURST.digestMaxLines) as { label: string }[];
    const bursts: BurstDigestLine[] = [];
    for (const { label } of labels) {
        const rows = burstRows(label);
        if (!listedInDigest(rows, now)) continue;
        const here = rows.filter(r => r.status !== 'pruned');
        const reported = here.filter(r => openReportsOn(r.member_pubkey) > 0);
        const opener = reported[0] ?? here[0] ?? null;
        const postsHidden = here.length === 0 ? 0 : (db.prepare(`SELECT COUNT(*) AS c FROM posts
              WHERE author_pubkey IN (${here.map(() => '?').join(',')}) AND origin_node IS NULL AND hidden_by_reports_at IS NOT NULL AND status != 'cancelled'`)
            .get(...here.map(r => r.member_pubkey)) as { c: number }).c;
        bursts.push({
            accounts: rows.length,
            stillHere: here.length,
            removed: rows.length - here.length,
            reported: reported.length,
            postsHidden,
            firstJoinAt: rows[0].joined_at,
            lastJoinAt: rows[rows.length - 1].joined_at,
            open: opener ? { publicKey: opener.member_pubkey, callsign: opener.callsign } : null,
        });
    }
    const actions = (db.prepare(`
        SELECT a.id, a.kind, a.at, a.by_role, a.accounts, a.posts, a.undone_at, a.anchor_pubkey, m.callsign, m.status
          FROM burst_actions a LEFT JOIN members m ON m.public_key = a.anchor_pubkey
         ORDER BY a.at DESC, a.rowid DESC
    `).all() as { id: string; kind: 'hide' | 'remove'; at: string; by_role: BurstActorRole; accounts: number; posts: number; undone_at: string | null; anchor_pubkey: string | null; callsign: string | null; status: string | null }[])
        .map((a): BurstActionLine => ({
            id: a.id, kind: a.kind, at: a.at, by: a.by_role, accounts: a.accounts, posts: a.posts, undoneAt: a.undone_at,
            account: a.anchor_pubkey && a.status ? { publicKey: a.anchor_pubkey, callsign: a.callsign } : null,
        }));
    return { bursts, actions, minAccounts: BURST.digestMinAccounts, days: BURST.digestDays };
}

/**
 * A member deleting their own account, and with it their connection label (state-engine purgeMemberSelf, engine/open-join.ts
 * releaseOpenJoin), leaves every burst record: their posts go from the hides that hid them, and their key from any action
 * opened from them. Who joined alongside them is nobody's business now.
 */
export function forgetBurstActionsOf(publicKey: string): void {
    db.prepare('DELETE FROM burst_action_posts WHERE post_id IN (SELECT id FROM posts WHERE author_pubkey = ?)').run(publicKey);
    db.prepare('UPDATE burst_actions SET anchor_pubkey = NULL WHERE anchor_pubkey = ?').run(publicKey);
}
