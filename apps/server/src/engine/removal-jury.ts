/**
 * The removal jury's records on this node (scratch/fable-design/DESIGN-removal-jury-fable.md §3, §4; slice J1). The draw
 * itself is @beanpool/core juryDraw, the same code both apps check it with; who may serve is decisions-engine.ts
 * removalJuryPool. Here: who stands aside, and the two records a jury's vote keeps.
 *
 *  - The pool (decision_jury_pools): the keys the draw was made from, sorted, kept as they were hashed. Never moved by a
 *    re-key and tied to no member row, so what the node serves for Check the draw is what it drew from, whoever has left
 *    since. Written once, when the pause opens the vote.
 *  - The roll (decision_electors, as an enterprise's or a group's vote keeps one): every member the walk reached, in draw
 *    order, seated (`on`) or passed over (`stood_aside`). Slice J2b (decisions-engine.ts answerJurySeat, settleOpenJuries):
 *    a juror who steps aside is `stood_aside` too; one with no answer 72 hours after being seated is `silent`; one who
 *    leaves, is paused or is removed is `left`; and for each the walk goes on and seats the next member of the draw. A
 *    seat dates from its row's created_at, a Serve is its answered_at, and the last reminder sent its reminded_at. A
 *    juror's vote counts while they are `on` (decisions-engine.ts tallyDecision).
 *
 * Both replicate with the decision (engine/replication-manifest.ts), so a restored node never redraws. Beside them, this
 * server's own note of when formal Decisions were off while a jury sat (JURY_HOLDS_KEY), which a seat's hours leave out.
 */
import { db } from '../db/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back a report on the subject, or a deal completed with them, stands a member aside (§4). */
export const JURY_CONFLICT_DAYS = 90;

/**
 * Who stands aside from judging `subject`, from data only this node holds: only a conflict the subject cannot make alone
 * (Marty, 3 Nov 2026, "Only conflicts they can't fake", narrowing §4 of the design). The draw's order is public, so
 * anything the subject could do by themselves would let them pass over whoever they expect to say Yes and pick their jury.
 *
 *  - the member reported them, or something they posted, in the last 90 days;
 *  - the member blocked them;
 *  - the member invited them, or was invited by them;
 *  - a deal between the two was completed in the last 90 days that the member took part in: they bought from the subject,
 *    or it was on a listing of the subject's, or it was a loan (the subject accepting and confirming a member's Offer alone
 *    doesn't count, but a loan is always asked for and its lender says yes first, engine/escrow.ts lendAskFirst, so a
 *    member who lent the subject something made the deal too: DESIGN-removal-jury-j2-calls-fable.md call 3, J2a);
 *  - a deal still open that the member opened: one on a listing of the subject's (the side that isn't a deal's listing's
 *    author is the side that asked for it: engine/escrow.ts);
 *  - a direct conversation the member opened with them.
 *
 * Never the subject's own acts: their blocks, or a message or deal request they sent. A block the subject made shows
 * nowhere here either (engine/member-blocks.ts: nothing a blocked member can read changes): a conversation the member
 * opened counts the same whether it became a real one or was kept for them alone because the subject blocks them
 * (engine/withheld-lines.ts withheld_conversations; and one of those the subject later opened too, which became the real
 * one under the subject's name: the member's kept lines are older than it). None of it is ever said: a member passed over
 * for any of these is listed after close exactly as one who stepped aside themselves, with no reason, and while the vote
 * is open is refused in the words a member not drawn is.
 *
 * A branch's vote is on every account on its list (DESIGN-removal-jury-j2-calls-fable.md call 4, J2c): a member with any
 * of these links to any one of them stands aside, so `subjects` may be that whole list. No account on it is ever one of
 * the conflicts returned: each is out of the vote's pool already.
 */
export function juryConflictsOf(subjects: string | readonly string[], atMs: number = Date.now()): Set<string> {
    const judged = new Set(typeof subjects === 'string' ? [subjects] : subjects);
    const since = new Date(atMs - JURY_CONFLICT_DAYS * DAY_MS).toISOString();
    const conflictsOf = db.prepare(`
        SELECT reporter_pubkey AS k FROM abuse_reports
         WHERE julianday(created_at) >= julianday(@since)
           AND (target_pubkey = @s OR target_post_id IN (SELECT id FROM posts WHERE author_pubkey = @s))
        UNION SELECT invited_by FROM members WHERE public_key = @s AND invited_by IS NOT NULL
        UNION SELECT public_key FROM members WHERE invited_by = @s
        UNION SELECT owner_pubkey FROM member_blocks WHERE blocked_pubkey = @s
        UNION SELECT CASE WHEN t.buyer_pubkey = @s THEN t.seller_pubkey ELSE t.buyer_pubkey END FROM marketplace_transactions t
          LEFT JOIN posts p ON p.id = t.post_id
         WHERE (t.buyer_pubkey = @s OR t.seller_pubkey = @s) AND t.status = 'completed'
           AND julianday(COALESCE(t.completed_at, t.updated_at, t.created_at)) >= julianday(@since)
           AND (t.seller_pubkey = @s OR p.author_pubkey = @s OR p.lendable = 1)
        UNION SELECT CASE WHEN t.buyer_pubkey = @s THEN t.seller_pubkey ELSE t.buyer_pubkey END FROM marketplace_transactions t
          JOIN posts p ON p.id = t.post_id AND p.author_pubkey = @s
         WHERE (t.buyer_pubkey = @s OR t.seller_pubkey = @s) AND t.status IN ('requested', 'pending', 'disputed')
        UNION SELECT c.created_by FROM conversations c
          JOIN conversation_participants them ON them.conversation_id = c.id AND them.public_key = @s
          JOIN conversation_participants opener ON opener.conversation_id = c.id AND opener.public_key = c.created_by
         WHERE c.type = 'dm'
        UNION SELECT owner_pubkey FROM withheld_conversations WHERE other_pubkey = @s
        UNION SELECT w.author_pubkey FROM withheld_lines w
          JOIN conversations c ON c.id = w.conversation_id AND c.type = 'dm'
          JOIN conversation_participants them ON them.conversation_id = c.id AND them.public_key = @s
          JOIN conversation_participants opener ON opener.conversation_id = c.id AND opener.public_key = w.author_pubkey
         WHERE julianday(w.timestamp) < julianday(c.created_at)
    `);
    const out = new Set<string>();
    for (const subject of judged) {
        for (const r of conflictsOf.all({ s: subject, since }) as Array<{ k: string | null }>) if (r.k && !judged.has(r.k)) out.add(r.k);
    }
    return out;
}

/** Keep the draw's pool and roll. Inside the pause's transaction. */
export function writeJuryRecords(decisionId: string, pool: readonly string[], jury: readonly string[], stoodAside: readonly string[], at: string): void {
    db.prepare('INSERT INTO decision_jury_pools (decision_id, pool, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(decisionId, pool.join('\n'), at, at);
    const seat = db.prepare(`
        INSERT INTO decision_electors (decision_id, member_pubkey, role_at_open, status, created_at, updated_at)
        VALUES (?, ?, 'juror', ?, ?, ?)
    `);
    for (const k of jury) seat.run(decisionId, k, 'on', at, at);
    for (const k of stoodAside) seat.run(decisionId, k, 'stood_aside', at, at);
}

/** The keys a jury was drawn from, sorted as hashed; null for a vote with no jury. */
export function juryPoolOf(decisionId: string): string[] | null {
    const row = db.prepare('SELECT pool FROM decision_jury_pools WHERE decision_id = ?').get(decisionId) as { pool: string } | undefined;
    if (!row) return null;
    return row.pool === '' ? [] : row.pool.split('\n');
}

export type JurorStatus = 'on' | 'stood_aside' | 'silent' | 'left';

/** Everyone a jury's walk reached, with where each stands now. */
export function juryRollOf(decisionId: string): Array<{ key: string; status: JurorStatus }> {
    return (db.prepare("SELECT member_pubkey AS key, status FROM decision_electors WHERE decision_id = ? AND role_at_open = 'juror'")
        .all(decisionId) as Array<{ key: string; status: JurorStatus }>);
}

/** Whether this member sits on this jury now, so their vote counts. */
export function seatedJuror(decisionId: string, key: string): boolean {
    return !!db.prepare("SELECT 1 FROM decision_electors WHERE decision_id = ? AND member_pubkey = ? AND role_at_open = 'juror' AND status = 'on'")
        .get(decisionId, key);
}

/** A seated juror's seat (slice J2b): since when, whether they have answered (Serve, or a vote), and the last reminder. */
export interface JurorSeat {
    key: string;
    seatedAt: string;
    /** When they answered Serve; null when they haven't (they may still have voted: `voted`). */
    answeredAt: string | null;
    remindedAt: string | null;
    /** A vote of theirs is on this decision. */
    voted: boolean;
}

/** Everyone seated (`on`) on this jury now, with their seats. */
export function jurySeatsOf(decisionId: string): JurorSeat[] {
    return (db.prepare(`
        SELECT e.member_pubkey AS key, e.created_at AS seatedAt, e.answered_at AS answeredAt, e.reminded_at AS remindedAt,
               EXISTS (SELECT 1 FROM decision_votes v WHERE v.decision_id = e.decision_id AND v.voter_pubkey = e.member_pubkey) AS voted
          FROM decision_electors e
         WHERE e.decision_id = ? AND e.role_at_open = 'juror' AND e.status = 'on'
    `).all(decisionId) as Array<Omit<JurorSeat, 'voted'> & { voted: number }>).map(r => ({ ...r, voted: r.voted === 1 }));
}

/**
 * A seated juror's seat ends: `stood_aside` (they stepped aside), `silent` (no answer in time) or `left` (gone, paused or
 * removed). Only a seat still `on` changes, so a seat ends once, whoever asks twice. Returns whether it changed. Inside the
 * caller's transaction.
 */
export function unseatJuror(decisionId: string, key: string, status: Exclude<JurorStatus, 'on'>, at: string): boolean {
    return db.prepare(`
        UPDATE decision_electors SET status = ?, updated_at = ?
         WHERE decision_id = ? AND member_pubkey = ? AND role_at_open = 'juror' AND status = 'on'
    `).run(status, at, decisionId, key).changes > 0;
}

/** The walk goes on (decisions-engine.ts topUpJury): one more member it reached, seated now or passed over. */
export function addToJuryRoll(decisionId: string, key: string, status: 'on' | 'stood_aside', at: string): void {
    db.prepare(`
        INSERT INTO decision_electors (decision_id, member_pubkey, role_at_open, status, created_at, updated_at)
        VALUES (?, ?, 'juror', ?, ?, ?)
    `).run(decisionId, key, status, at, at);
}

/** A seated juror answered Serve. The first answer stands; returns whether they are seated. */
export function noteJurorServes(decisionId: string, key: string, at: string): boolean {
    return db.prepare(`
        UPDATE decision_electors SET answered_at = COALESCE(answered_at, ?), updated_at = ?
         WHERE decision_id = ? AND member_pubkey = ? AND role_at_open = 'juror' AND status = 'on'
    `).run(at, at, decisionId, key).changes > 0;
}

/** A seated juror was reminded at `at` (settleOpenJuries). */
export function noteJurorReminded(decisionId: string, key: string, at: string): void {
    db.prepare(`
        UPDATE decision_electors SET reminded_at = ?, updated_at = ?
         WHERE decision_id = ? AND member_pubkey = ? AND role_at_open = 'juror' AND status = 'on'
    `).run(at, at, decisionId, key);
}

/**
 * node_config: when this server's tick found formal Decisions off while a jury sat (decisions-engine.ts settleOpenJuries),
 * as a JSON list of holds, `{ from, to }` (ISO; `to` null while they are still off). Nobody can answer a seat then, so a
 * seat's 48 and 72 hours leave every hold out (juryHeldMs). Per server, as the tick is: a standby that takes over starts
 * with none.
 */
export const JURY_HOLDS_KEY = 'juryHolds';

/** One time formal Decisions were off while a jury sat: from, and to (null while still off), in ms. */
export interface JuryHold { from: number; to: number | null }

/** The holds this server keeps (JURY_HOLDS_KEY), oldest first; none for no row, or one that doesn't read. */
export function juryHolds(): JuryHold[] {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(JURY_HOLDS_KEY) as { value: string } | undefined;
    if (!row) return [];
    try {
        const list: unknown = JSON.parse(row.value);
        if (!Array.isArray(list)) return [];
        return (list as Array<{ from?: unknown; to?: unknown } | null>)
            .map(h => ({ from: Date.parse(String(h?.from)), to: h?.to == null ? null : Date.parse(String(h.to)) }))
            .filter((h): h is JuryHold => Number.isFinite(h.from) && (h.to === null || Number.isFinite(h.to)));
    } catch {
        return [];
    }
}

/**
 * The tick's note of the Decisions switch, for a seat's hours (settleOpenJuries, each tick, at `nowMs`). `oldestOpenMs`:
 * when the oldest vote a jury decides that is still open opened, or null when none is. Off, with a jury sitting: a hold
 * starts, unless one has. On: a hold still open ends now; one that ended before the oldest open jury's vote opened is
 * dropped, since no seat on it is older; and the row goes once no jury sits. Writes only when that changes something.
 */
export function noteJuryHold(decisionsOn: boolean, nowMs: number, oldestOpenMs: number | null): void {
    const holds = juryHolds();
    const last = holds[holds.length - 1];
    const open = last && last.to === null ? last : null;
    if (!decisionsOn) {
        if (!open && oldestOpenMs !== null) writeJuryHolds([...holds, { from: nowMs, to: null }]);
        return;
    }
    if (!holds.length) return;
    if (open) open.to = nowMs;
    const kept = oldestOpenMs === null ? [] : holds.filter(h => h.to !== null && h.to > h.from && h.to > oldestOpenMs);
    if (open || kept.length !== holds.length) writeJuryHolds(kept);
}

function writeJuryHolds(holds: readonly JuryHold[]): void {
    if (!holds.length) {
        db.prepare('DELETE FROM node_config WHERE key = ?').run(JURY_HOLDS_KEY);
        return;
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(JURY_HOLDS_KEY, JSON.stringify(holds.map(h => ({ from: iso(h.from), to: h.to === null ? null : iso(h.to) }))));
}

/**
 * How much of the time since a seat taken at `seatedMs` formal Decisions were off (the holds): the part of each hold after
 * the seat, a hold still open up to `nowMs`. A hold ends where the tick found them on again, so one that has ended is past.
 */
export function juryHeldMs(seatedMs: number, nowMs: number, holds: readonly JuryHold[] = juryHolds()): number {
    let held = 0;
    for (const h of holds) {
        const from = Math.max(h.from, seatedMs);
        const to = h.to ?? nowMs;
        if (to > from) held += to - from;
    }
    return held;
}

/**
 * The key a pool member holds now (slice J2b): their key in the pool, followed forward through the re-keys that replaced
 * it (`invalidated_keys.rekeyed_to`, as juryDrawnAs follows them back), so a member of the draw who moved to a new phone
 * since is seated under the key they sign with. A key no re-key replaced is its own answer.
 */
export function juryCurrentKey(poolKey: string): string {
    const next = db.prepare('SELECT rekeyed_to FROM invalidated_keys WHERE public_key = ? AND rekeyed_to IS NOT NULL');
    let at = poolKey;
    for (let hop = 0; hop < DRAWN_AS_HOPS; hop++) {
        const to = (next.get(at) as { rekeyed_to: string } | undefined)?.rekeyed_to;
        if (!to || to === at) break;
        at = to;
    }
    return at;
}

/** How many re-keys back a roll key is followed to find the key it was drawn as: far more than any member makes. */
const DRAWN_AS_HOPS = 16;

/**
 * The key each roll key was drawn as (DESIGN-removal-jury-j2-calls-fable.md §5.1, J2a). A re-key moves a juror's roll row
 * and vote to the new key (engine/key-move.ts) but never the pool, which is kept as it was hashed, so a roll key not in the
 * pool is followed back through the re-keys that replaced it to the one that is. Read from `invalidated_keys` (its
 * `rekeyed_to`), not `rekey_audit_log`: both record the move, but only the first is in a standby's copy
 * (engine/replication-manifest.ts: the audit log is this server's own), so a node restored from its standby serves the
 * same answer. A key that leads to nothing in the pool is its own answer, and Check the draw then fails on it, as it should.
 */
export function juryDrawnAs(keys: readonly string[], pool: ReadonlySet<string>): Map<string, string> {
    const replaced = db.prepare('SELECT public_key FROM invalidated_keys WHERE rekeyed_to = ? ORDER BY invalidated_at DESC LIMIT 1');
    const out = new Map<string, string>();
    for (const key of keys) {
        let at: string | undefined = key;
        for (let hop = 0; at && !pool.has(at) && hop < DRAWN_AS_HOPS; hop++) {
            at = (replaced.get(at) as { public_key: string } | undefined)?.public_key;
        }
        out.set(key, at && pool.has(at) ? at : key);
    }
    return out;
}
