/**
 * The jury that decides a removal in a large community (scratch/fable-design/DESIGN-removal-jury-fable.md §3, §5; Marty
 * accepted all ten answers 29 Oct). One draw, used by the server when a pause opens the vote and by both apps to check it:
 * drawn by nobody, from data fixed before the case existed, and recomputable by any member from what the node serves.
 *
 *   rosterHash = SHA-256 of the pool's public keys, sorted and joined by "\n"
 *   seed       = SHA-256 of "beanpool-jury-v1" \n subject's key \n rosterHash \n snapshot date (YYYY-MM-DD, UTC)
 *   rank(key)  = SHA-256 of seed \n key
 * Every hash is of the UTF-8 text and written as lowercase hex. The pool in ascending rank (a tie, which SHA-256 never
 * makes, by key) is the order: the jury is seated from its head, a member who stands aside is passed over and the next
 * one seated, so a roll is always the first k of the order. No random number, no nonce, nothing chosen when it opens.
 *
 * The pool is the server's to choose (who may serve, §2) and the stand-asides its private data (§4); this file only orders
 * and seats. Changing anything here changes every jury: a new rule is a new domain word ("beanpool-jury-v2"), never an
 * edit, so an old vote's draw still checks out.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/** The domain word in every seed: a rule changed later is a new word, so a draw made under this one still checks out. */
export const JURY_DRAW_DOMAIN = 'beanpool-jury-v1';
/** The eligible pool at which "Automatic" has a jury decide a removal (§5, §6): below it, everyone does. */
export const JURY_LINE = 100;
/** The smallest pool an owner may choose "A jury" for (§6): three juries' worth, the lock `pool_too_small` below it. */
export const JURY_MIN_POOL = 36;
/** A member serves only once they joined at least this many days before the snapshot (§2): fresh invites can't pack it. */
export const JURY_SERVE_AFTER_DAYS = 30;

/**
 * Seating (§4; DESIGN-removal-jury-j2-calls-fable.md call 2 point 3, slice J2b). Every juror is asked, when seated, to
 * answer within JURY_ANSWER_HOURS: Serve (then vote) or Step aside. A vote is an answer too. One who gives none is
 * `silent`, and the next member of the draw is seated in their place.
 */
export const JURY_ANSWER_HOURS = 72;
/** A seated juror who hasn't answered is reminded once, this many hours after being seated (§4). */
export const JURY_REMINDER_HOURS = 48;
/** Every seated juror who hasn't voted is reminded once, when the vote has been open this many days (§4: "on day 6"). */
export const JURY_LAST_DAY_AFTER_DAYS = 6;
/** A juror seated with less than this many hours of the vote left is told so (§4). Nothing extends the vote's 7 days. */
export const JURY_LATE_SEAT_HOURS = 48;

export interface JuryRule {
    /** Jurors seated. */
    size: number;
    /** Votes cast by close, or the quorum is missed and the pause lifts. */
    mustVote: number;
    /** Yes votes needed besides two-thirds of those cast. */
    minYes: number;
}

/** §5: a jury of 12 below 1,000 in the pool (9 must vote, at least 6 Yes), of 18 from 1,000 (13 must vote, at least 9 Yes). */
export function juryRuleFor(poolSize: number): JuryRule {
    return poolSize >= 1000 ? { size: 18, mustVote: 13, minYes: 9 } : { size: 12, mustVote: 9, minYes: 6 };
}

/**
 * Whether a jury's votes remove the member (§5): enough cast, at least two-thirds of them Yes, at least the rule's Yes
 * votes, and more Yes than No. Whole numbers only, so two-thirds is exact (6 of 9 passes, 5 of 9 doesn't); a tie fails.
 */
export function juryPasses(yes: number, no: number, rule: JuryRule): boolean {
    const cast = yes + no;
    return cast >= rule.mustVote && 3 * yes >= 2 * cast && yes >= rule.minYes && yes > no;
}

/** The UTC day a moment falls on, YYYY-MM-DD: the snapshot date of a pause made then. */
export function jurySnapshotDate(atMs: number): string {
    return new Date(atMs).toISOString().slice(0, 10);
}

/** The snapshot's moment: 00:00 UTC of its date. NaN for a date that isn't YYYY-MM-DD. */
export function jurySnapshotAt(snapshotDate: string): number {
    return /^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) ? Date.parse(`${snapshotDate}T00:00:00.000Z`) : NaN;
}

const hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** The pool's keys once each, in plain code-unit order (never a locale's), the order the hash is taken in. */
export function sortedPool(pool: readonly string[]): string[] {
    return [...new Set(pool)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function juryRosterHash(pool: readonly string[]): string {
    return hex(sortedPool(pool).join('\n'));
}

export function jurySeed(subject: string, rosterHash: string, snapshotDate: string): string {
    return hex([JURY_DRAW_DOMAIN, subject, rosterHash, snapshotDate].join('\n'));
}

export function juryRank(seed: string, key: string): string {
    return hex(`${seed}\n${key}`);
}

export interface JuryOrder {
    rosterHash: string;
    seed: string;
    /** The pool, every key once, in the order jurors are seated. */
    order: string[];
}

/** The whole pool in draw order for this subject and snapshot. */
export function juryOrder(pool: readonly string[], subject: string, snapshotDate: string): JuryOrder {
    const keys = sortedPool(pool);
    const rosterHash = hex(keys.join('\n'));
    const seed = jurySeed(subject, rosterHash, snapshotDate);
    const ranked = keys.map(key => ({ key, rank: juryRank(seed, key) }));
    ranked.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return { rosterHash, seed, order: ranked.map(r => r.key) };
}

export interface JuryDraw extends JuryOrder {
    poolSize: number;
    /** Seated, in draw order. Fewer than asked only when the pool ran out. */
    jury: string[];
    /** Passed over on the way, in draw order: the node's own reasons (§4), never said. */
    stoodAside: string[];
}

/**
 * Draw the jury: walk the order from its head, pass over each key `standsAside` names, and seat the rest until `size`
 * are seated or the pool runs out. `jury` and `stoodAside` together are the first k of `order`.
 */
export function juryDraw(opts: {
    pool: readonly string[];
    subject: string;
    snapshotDate: string;
    size: number;
    standsAside?: (key: string) => boolean;
}): JuryDraw {
    const drawn = juryOrder(opts.pool, opts.subject, opts.snapshotDate);
    const jury: string[] = [];
    const stoodAside: string[] = [];
    for (const key of drawn.order) {
        if (jury.length >= opts.size) break;
        if (opts.standsAside?.(key)) stoodAside.push(key);
        else jury.push(key);
    }
    return { ...drawn, poolSize: drawn.order.length, jury, stoodAside };
}

export type JuryCheckProblem = 'hash' | 'order';

/**
 * "Check the draw" (§3): does what the node served agree with its own record? `rosterHash` is what the vote recorded
 * when it opened; `pool` the keys it serves now. `roll`, served once the vote closes, is everyone it seated or passed
 * over, in any order: it must be exactly the first keys of the draw. `hash`: the pool served isn't the pool the draw
 * was made from. `order`: the roll isn't the head of that pool's draw.
 */
export function checkJuryDraw(opts: {
    pool: readonly string[];
    subject: string;
    snapshotDate: string;
    rosterHash: string;
    roll?: readonly string[];
}): { ok: true } | { ok: false; problem: JuryCheckProblem } {
    const drawn = juryOrder(opts.pool, opts.subject, opts.snapshotDate);
    if (drawn.rosterHash !== opts.rosterHash) return { ok: false, problem: 'hash' };
    if (opts.roll) {
        const roll = new Set(opts.roll);
        if (roll.size !== opts.roll.length) return { ok: false, problem: 'order' };
        const head = new Set(drawn.order.slice(0, roll.size));
        for (const key of roll) if (!head.has(key)) return { ok: false, problem: 'order' };
    }
    return { ok: true };
}
