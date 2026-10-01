/**
 * The gateway's request throttle (on by default: GatewayConfig.rateLimiting, 120 a minute).
 *
 * Buckets:
 *   - `ip:<client>`  — unsigned requests, `maxPerMinute` per real client address (client-ip.ts; an IPv6 client
 *     is counted by its /64, see limiterKeyForIp). It used to key
 *     on the raw socket address, which in tunnel mode is the cloudflared container for EVERY member, so a whole
 *     community shared one 120-a-minute bucket and a busy minute answered 429 to everyone.
 *   - `m:<pubkey>`   — requests with a verified signature by a member of this node (or a visitor's row, which only a
 *     member's message or Beans makes), `maxPerMinute` per member. A hall's wifi or a carrier NAT puts many members
 *     behind one address; each of them gets their own allowance. A verified signature by any other key (a fresh keypair,
 *     a guest's local key, someone mid-join) proves only that someone made a keypair, so it is charged to the address's
 *     `ip:` bucket instead (global-abuse review M-4: a scraper signing each request with a new key got 10× the rate).
 *   - `sig:<client>` — every request that CLAIMS a signature, `maxPerMinute × SIGNED_CEILING_FACTOR` per
 *     address. The member bucket can only be charged after the signature is verified, later in the stack; this
 *     ceiling bounds what one address can push through by attaching signature headers, forged or not.
 *   - `claim:<client>` — every request that claims a signature AND whose body the body parser reads past
 *     CLAIM_SMALL_BODY_BYTES, `maxPerMinute` per address. A claim that may carry such a body (a POST, PUT, PATCH or
 *     DELETE declaring more, or a chunked one) is refused BEFORE its body is read when the bucket is full; it is charged
 *     only once the parser has read more than CLAIM_SMALL_BODY_BYTES of it (gatewayChargeLargeClaim), and given back the
 *     moment the signature verifies (gatewayClaimVerified). What stays in it is the large claims that never verified
 *     (forged, stale, replayed, for another community), so an address gets no more of them a minute than unsigned
 *     requests, and the body parser reads and parses no more 2 MB bodies for them (DoS review F2). It is its own bucket,
 *     not `ip:`, because a member's signed request must never be refused for the address's unsigned traffic (a hall's
 *     members loading photos fill `ip:`): only large claims that fail count against it. A claim with no body or a small
 *     one (a signed read, a chat line, a /ws connect token) never touches it, and has its body held to
 *     CLAIM_SMALL_BODY_BYTES: the body parser's cost is what `claim:` bounds, and those cost it 16 KiB at most. Nor does
 *     a claim whose body never gets that far, whatever it declared: a chunked `{}`, or a length of 1 MB with 5 bytes sent
 *     and the connection dropped. So junk signatures from someone sharing members' address (a carrier NAT, a hall's
 *     wifi) can't shut off the members' larger writes unless they send more than 16 KiB of real body for each one (the
 *     review of 06491de5: 120 bodiless junk claims had turned a member's 20 KB chat line into 429 for a minute; the
 *     confirm review of #1384: so had 120 chunked `{}` claims, or 120 large lengths declared and dropped).
 *   - `peer:<client>` — the peer protocol's own reads (https-server.ts GATEWAY_EXEMPT_PEER_READS), which the other
 *     buckets leave alone: `maxPerMinute × PEER_READ_FACTOR` per address, whoever signs (DoS review F4).
 *
 * A claimed signature that does not verify is charged to the address's unsigned bucket afterwards too, so forged
 * headers buy nothing for that address's plain traffic.
 *
 * A WebSocket upgrade (https-server.ts createUpgradeHandler) never passes through Koa, and is charged here all the same
 * (gatewayAdmitUpgrade, gatewaySettleUpgrade): one request, by the same rules.
 *
 * The day budget (`gatewayAdmitDayBudget`, W-main): beside the minute buckets, every verified key's writes (POST, PUT,
 * PATCH, DELETE) are counted over a rolling day, and past WRITER_LIMITS.signedWritesPerDay they are answered 429
 * `day_budget`. It bounds every table a member's signed requests write, the money tables included, without touching
 * money code (the rows the server writes for a member on its own, the Pulse harvester's, have their own daily allowance:
 * WRITER_LIMITS.pulseHarvestedItemsPerDay). The admin surface (`/api/local/admin/*`) has its own limiter and is not
 * counted, nor are the read marks (DAY_BUDGET_READ_MARKS): the apps send those on a timer, and they make no new row. It
 * applies whether or not the operator has the minute throttle on: it is what keeps one key from growing the tables a
 * standby copies past its cap.
 *
 * An enterprise's day budget: a write whose path names an enterprise the signer keeps (https-server.ts passes it, from
 * routes/money-limits-gate.ts enterpriseActingFor) is counted against that enterprise, WRITER_LIMITS
 * .enterpriseSignedWritesPerDay, and not against the keeper's own: a keeper running a busy shop must not spend their own
 * day on it, nor the shop's on their own. It also counts against the keeper's enterprise work, WRITER_LIMITS
 * .enterpriseWorkSignedWritesPerDay, across every enterprise they keep, and both must have room: so a shop's keepers
 * together get its whole budget, and one person can't multiply their day by starting enterprises. Once the enterprise's
 * own day is spent, a keeper's further writes for it count against the keeper's own day instead (as every write did on
 * main), and not their enterprise work: so a keeper who spends a shop's day blocks only themselves, and every other
 * keeper keeps their own 5,000 for it (the director, 2026-09-30: removing that keeper waits out a 3-day objection
 * window). A refusal then is the keeper's own `day_budget`, with a sentence naming the enterprise. A made-up, foreign or
 * wound-up enterprise in a path is no enterprise here, and the write counts against the signer as any other. The money
 * limits proper are engine/money-limits.ts.
 *
 * A shop's governance and settling (ENTERPRISE_GOVERNANCE_WRITE) always counts against the signer's own day: taking
 * keepers on, removing them, stepping down, succession, pausing, resuming, winding up, and completing or turning down a
 * deal the shop already funded. Those count as on main, never against the shop's day or the keeper's enterprise work,
 * whether or not the shop's day is spent (the review of 68ff4e4f).
 */
import type Koa from 'koa';
import { clientLimiterKey } from './client-ip.js';
import { logger } from './logger.js';
import { logAddressTag } from './log-address.js';
import { WRITER_LIMITS } from './config/writer-limits.js';

export const SIGNED_CEILING_FACTOR = 10;
/**
 * The peer protocol's reads per address, against `maxPerMinute`: 600 a minute at the default 120. A linked community's
 * harvester or a take-over's health check may read in a burst, and every phone reads /api/community/health every 30 s
 * (a hall's wifi, or a carrier NAT, puts many behind one address); a flood from one address stops here. The reads
 * themselves are cheap now (state-engine communityCountsCached, getPublicCommunityHealth).
 */
export const PEER_READ_FACTOR = 5;
const WINDOW_MS = 60_000;

/**
 * Past this many buckets, a request's admission prunes the closed windows (pruneGatewayBuckets, a walk of every bucket
 * and the day counts), at most once every PRUNE_INTERVAL_MS. It ran on every count past this mark, and a request counts
 * up to three buckets (`sig:`, `claim:`, and `ip:` or `m:`): a flood of forged claims from rotating IPv6 /64s, whose
 * buckets are all live so a prune frees nothing, walked the whole map three times a request, 42 s of CPU for 50,000
 * requests where main spent 13 (the review of 06491de5).
 */
const PRUNE_ABOVE = 20_000;
const PRUNE_INTERVAL_MS = 1_000;
/**
 * The most buckets the limiter holds. When it is full, the least-counted buckets are forgotten, down to 90%, before a new
 * one is made (forgetLeastCountedBuckets): forgetting a bucket only forgives what it counted, and a flood from more
 * addresses in a minute than this leaves buckets counted once or twice, while a caller the limiter has stopped has a full
 * one. About 17 MB of heap when full (measured with IPv6 keys). A node's own traffic is far below it (a few buckets for
 * each address and member that made a request this minute).
 */
export const GATEWAY_MAX_BUCKETS = 100_000;
/**
 * The counts forgetLeastCountedBuckets tells apart: a bucket counted this many times or more is at the top level, forgotten
 * only after every bucket counted fewer times (and then the oldest first).
 */
const COUNT_LEVELS = 1024;

/** In the order their windows opened (count() moves a reopened window to the end), so the first are the oldest. */
const buckets = new Map<string, { count: number; resetAt: number }>();
const loggedTrips = new Map<string, number>();
let lastPruneAt = 0;
let pruneRuns = 0;

// ── The day budget ───────────────────────────────────────────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;
/** The rolling day, in whole hours: this hour and the 23 before it. */
const DAY_HOURS = 24;
const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * The most keys (members' and enterprises' together) the day budget holds counts for at once. Past it, keys with no write
 * in the last day go first, then the keys that have used the least of their budget: forgetting one can only forgive a
 * small part of a day, never a key near its budget.
 */
export const DAY_BUDGET_MAX_KEYS = 50_000;
/** Per key: the hours it wrote in (oldest first, within the day) and how many writes in each. */
interface DayCount { hours: number[]; counts: number[]; total: number }
/**
 * Keyed by the member's key; `ent:` and the enterprise's for an enterprise's own budget; `work:` and a keeper's for what
 * they write for every enterprise they keep.
 */
const dayCounts = new Map<string, DayCount>();
const ENTERPRISE_KEY = 'ent:';
const WORK_KEY = 'work:';
const budgetOf = (key: string) => key.startsWith(ENTERPRISE_KEY) ? WRITER_LIMITS.enterpriseSignedWritesPerDay
    : key.startsWith(WORK_KEY) ? WRITER_LIMITS.enterpriseWorkSignedWritesPerDay : WRITER_LIMITS.signedWritesPerDay;

/**
 * The read marks, left out of the day budget (still under the minute bucket). Each only moves a marker on a row the
 * member already has, so it can't grow a table however often it is sent, and both apps send them on a timer while a chat
 * is open (a phone ~300 an hour, the web app on every poll and doorbell), so counting them spent a real member's day
 * without a change made (PR #1312 review). Exact POST paths as the gateway sees them (ctx.path, never decoded, trimmed
 * or lower-cased), so no other spelling, and no write route, can ride the exemption:
 *   - POST /api/messages/mark-read (routes/messaging.ts): moves last_read_at on the member's own participant row
 *     (engine/messaging.ts markConversationRead), or a keeper's thread_read_cursors row (engine/enterprise-thread.ts
 *     markKeeperThreadRead, one per keeper and enterprise, local and never copied). On a group chat it first mirrors
 *     the member's group membership onto the participant row (syncGroupThreadMembership): one row per group they
 *     joined, which the join itself paid for.
 *   - POST /api/notices/seen (routes/notices.ts): stamps seen_at once on the member's own kept notices.
 */
export const DAY_BUDGET_READ_MARKS: ReadonlySet<string> = new Set(['/api/messages/mark-read', '/api/notices/seen']);

/**
 * A shop's governance and settling writes (routes/treasury.ts, at each of its path prefixes): counted against the
 * signer's own day as on main, never against the enterprise's day or the keeper's enterprise work, so that a keeper who
 * spent the shop's day can't lock its other keepers out of running it. Every one is a POST:
 *   - keepers/request, keepers/requests/:id/approve, keepers/requests/:id/decline, keepers/:pubkey/remove,
 *     keepers/changes/:id/object, keepers/step-down;
 *   - succession/propose, succession/:id/vote;
 *   - pause, resume;
 *   - wind-up/initiate, wind-up/cancel, wind-up/finalise;
 *   - complete (paying a helper out of the escrow its approval funded, which the money limits counted then), and reject
 *     (turning a request down: the Beans stay or come back).
 * Matched as the gateway sees the path (never decoded or lower-cased; isNonCanonicalPath refuses other casings first),
 * with the router's one trailing slash. A spelling this misses only counts against the shop as before.
 */
export const ENTERPRISE_GOVERNANCE_WRITE = new RegExp('^/api/(?:treasury|enterprise|enterprises)/[^/]+/(?:'
    + 'keepers/(?:request|step-down|requests/[^/]+/(?:approve|decline)|[^/]+/remove|changes/[^/]+/object)'
    + '|succession/(?:propose|[^/]+/vote)|pause|resume|wind-up/(?:initiate|cancel|finalise)|complete|reject'
    + ')/?$');

/** Seconds until `key` has room again, or 0 when it has room now (the trip logged once a window). */
function waitFor(key: string, max: number, now: number): number {
    const entry = buckets.get(key);
    if (!entry || now >= entry.resetAt || entry.count < max) return 0;
    logTrip(key, now);
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
}

/**
 * Once per request, at its admission (gatewayAdmit, gatewayAdmitUpgrade, gatewayAdmitPeerRead) and never in count():
 * past PRUNE_ABOVE buckets, prune the closed windows if the last prune was PRUNE_INTERVAL_MS ago or more (or the clock
 * went back).
 */
function upkeep(now: number): void {
    if (buckets.size <= PRUNE_ABOVE) return;
    if (now >= lastPruneAt && now - lastPruneAt < PRUNE_INTERVAL_MS) return;
    pruneGatewayBuckets(now);
}

/** Count one request against `key`, full or not. The window it was counted in (its resetAt). */
function count(key: string, now: number): number {
    const entry = buckets.get(key);
    if (entry && now < entry.resetAt) { entry.count++; return entry.resetAt; }
    // A new window goes to the end of the map, so the map stays in the order windows opened.
    if (entry) buckets.delete(key);
    else if (buckets.size >= GATEWAY_MAX_BUCKETS) forgetLeastCountedBuckets(now);
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return now + WINDOW_MS;
}

/**
 * At GATEWAY_MAX_BUCKETS: forget the closed windows, then the least-counted buckets (the oldest first among those counted
 * the same), down to 90% of it. It forgot the oldest windows before, so about 25,000 rotating /64s, each opening up to
 * four buckets, reset every limit set before them within the minute (the confirm review of #1384). Three walks of the
 * map and no sort: a few milliseconds for each 10,000 new buckets.
 */
function forgetLeastCountedBuckets(now: number): void {
    const target = Math.floor(GATEWAY_MAX_BUCKETS * 0.9);
    for (const [key, entry] of buckets) if (now >= entry.resetAt) buckets.delete(key);
    if (buckets.size <= target) return;
    const atLevel = new Uint32Array(COUNT_LEVELS);
    for (const entry of buckets.values()) atLevel[Math.min(entry.count, COUNT_LEVELS - 1)]++;
    // Every bucket below `level` goes, and the oldest `extra` of those at it.
    let extra = buckets.size - target;
    let level = 0;
    while (atLevel[level] < extra) extra -= atLevel[level++];
    for (const [key, entry] of buckets) {
        const at = Math.min(entry.count, COUNT_LEVELS - 1);
        if (at < level) buckets.delete(key);
        else if (at === level && extra > 0) { buckets.delete(key); extra--; }
    }
}

/** Count one request against `key`. The seconds to wait (and nothing counted) when the bucket is already full, else 0. */
function takeKey(key: string, max: number, now: number): number {
    const wait = waitFor(key, max, now);
    if (!wait) count(key, now);
    return wait;
}

function refuse(ctx: Koa.Context, waitSec: number): false {
    ctx.status = 429;
    ctx.set('Retry-After', String(waitSec)); // RFC 6585
    ctx.body = { error: `Gateway rate limit exceeded. Please try again in ${waitSec}s.` };
    return false;
}

/** Count one request against `key`. False (and 429 set) when the bucket is already full. */
function take(ctx: Koa.Context, key: string, max: number, now: number): boolean {
    const wait = takeKey(key, max, now);
    return wait ? refuse(ctx, wait) : true;
}

/** Give back one request counted against `key` in the window `resetAt` names (never one of a later window). */
function giveBack(key: string, resetAt: number): void {
    const entry = buckets.get(key);
    if (entry && entry.resetAt === resetAt && entry.count > 0) entry.count--;
}

/** One log line per bucket per window, so a node's logs show when (and for whom) the gateway said 429. */
function logTrip(key: string, now: number): void {
    const last = loggedTrips.get(key);
    if (last && now - last < WINDOW_MS) return;
    loggedTrips.set(key, now);
    // Members are named by a key prefix only, an address by its daily keyed hash only (log-address.ts): a log line never
    // carries one.
    if (key.startsWith('day:')) {
        try { logger.warn('AUTH', `[gateway] day budget reached for member ${key.slice(4, 16)}…; answering 429 day_budget to its writes`); } catch { /* logging never blocks a response */ }
        return;
    }
    if (key.startsWith('dayent:')) {
        try { logger.warn('AUTH', `[gateway] day budget reached for enterprise ${key.slice(7, 19)}…; its keepers' writes for it count on their own days`); } catch { /* logging never blocks a response */ }
        return;
    }
    if (key.startsWith('daywork:')) {
        try { logger.warn('AUTH', `[gateway] enterprise work budget reached for member ${key.slice(8, 20)}…; answering 429 enterprise_work_day_budget to their enterprises' writes`); } catch { /* logging never blocks a response */ }
        return;
    }
    const kind = key.startsWith('sig:') ? 'signed requests from ' : key.startsWith('claim:') ? 'unverified signatures from '
        : key.startsWith('peer:') ? 'peer reads from ' : '';
    const label = key.startsWith('m:') ? `member ${key.slice(2, 14)}…` : `${kind}${logAddressTag(key.slice(key.indexOf(':') + 1))}`;
    try { logger.warn('AUTH', `[gateway] rate limit reached for ${label}; answering 429 until the window resets`); } catch { /* logging never blocks a response */ }
}

/**
 * The largest body a claimed signature may carry without being charged to its address's unverified claims (`claim:`);
 * the body parser is held to it for such a claim. Nearly every signed write is far smaller (a chat line, a trade, a
 * vote); a listing's photos are not. So a forger's claims that never spend the allowance cost the body parser 16 KiB
 * each at most, not 2 MB, and once they have spent it, a member behind the same address (a carrier NAT) keeps writing
 * everything up to this size.
 */
export const CLAIM_SMALL_BODY_BYTES = 16 * 1024;

/** The methods whose body the body parser reads (https-server.ts MUTATING_METHODS). */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A request that claims a signature, before anything is verified: the address's signed ceiling (`sig:`) must have room,
 * and when the claim may carry a body over CLAIM_SMALL_BODY_BYTES (`large`), its unverified claims (`claim:`) too. Only
 * `sig:` is counted here: `claim:` is charged once the body parser has read that much (gatewayChargeLargeClaim). The
 * seconds to wait (and nothing counted) when refused, else 0.
 */
function admitClaim(client: string, maxPerMinute: number, large: boolean, now: number): number {
    const sigWait = waitFor(`sig:${client}`, maxPerMinute * SIGNED_CEILING_FACTOR, now);
    if (sigWait) return sigWait;
    if (large) {
        const claimWait = waitFor(`claim:${client}`, maxPerMinute, now);
        if (claimWait) return claimWait;
    }
    count(`sig:${client}`, now);
    return 0;
}

/**
 * Whether the body parser may read more than CLAIM_SMALL_BODY_BYTES of a request: a method it reads the body of, with a
 * chunked body (which declares no length to hold it to) or a declared length over that (or one that isn't a number).
 * A request with no Content-Length and no Transfer-Encoding has no body (RFC 9112 6.3).
 */
function mayCarryLargeBody(ctx: Koa.Context): boolean {
    if (!BODY_METHODS.has(ctx.method)) return false;
    if (ctx.get('Transfer-Encoding')) return true;
    const declared = ctx.get('Content-Length');
    if (!declared) return false;
    const n = Number(declared);
    return !(Number.isFinite(n) && n >= 0 && n <= CLAIM_SMALL_BODY_BYTES);
}

/**
 * Early check, before the body is read. `claimsSignature` means the request carries signature headers on a
 * path where the signature middleware will verify them.
 *
 * A claim is checked here, before the body parser reads a byte, rather than after a cheaper check of the headers: the
 * signature covers the body, so nothing short of reading it tells a forger from a member. A fresh timestamp, an unused
 * nonce and a real member's key (keys are public: every listing names its author's) pass any check of the headers alone.
 * A claim that may carry a body over CLAIM_SMALL_BODY_BYTES is refused here when the address's unverified claims are
 * full, and charged to them by the body parser once it has read that much (`ctx.state.gatewayLargeClaim`,
 * gatewayChargeLargeClaim); any other has `ctx.state.gatewayBodyLimit` hold the body parser to that size.
 */
export function gatewayAdmit(ctx: Koa.Context, maxPerMinute: number, claimsSignature: boolean, now = Date.now()): boolean {
    upkeep(now);
    const ip = clientLimiterKey(ctx);
    if (claimsSignature) {
        ctx.state.gatewaySignedClaim = true;
        const large = mayCarryLargeBody(ctx);
        const wait = admitClaim(ip, maxPerMinute, large, now);
        if (wait) return refuse(ctx, wait);
        if (large) ctx.state.gatewayLargeClaim = maxPerMinute;
        else ctx.state.gatewayBodyLimit = CLAIM_SMALL_BODY_BYTES;
        return true;
    }
    return take(ctx, `ip:${ip}`, maxPerMinute, now);
}

/**
 * The body parser has read more than CLAIM_SMALL_BODY_BYTES of a claim gatewayAdmit let in as possibly large: charge it to
 * the address's unverified claims now (given back by gatewayClaimVerified). False (and 429 set) when they filled up after
 * its admission (large claims let in together), and the parser reads no more of it. True for any other request, and for a
 * claim already charged.
 */
export function gatewayChargeLargeClaim(ctx: Koa.Context, now = Date.now()): boolean {
    const maxPerMinute = ctx.state.gatewayLargeClaim as number | undefined;
    if (!maxPerMinute) return true;
    ctx.state.gatewayLargeClaim = 0;
    const key = `claim:${clientLimiterKey(ctx)}`;
    const wait = waitFor(key, maxPerMinute, now);
    if (wait) return refuse(ctx, wait);
    ctx.state.gatewayClaimWindow = count(key, now);
    return true;
}

/**
 * The signature verified (https-server.ts requireSignature, right after verifyMemberSignature): the claim is given back
 * to the address's unverified claims. Whatever the key then turns out to be (a member, a replaced key, a stranger) is
 * charged by gatewayAdmitMember, or as unsigned by gatewaySettle when the request is refused before it.
 */
export function gatewayClaimVerified(ctx: Koa.Context): void {
    const claimWindow = ctx.state.gatewayClaimWindow as number | undefined;
    if (!claimWindow) return;
    ctx.state.gatewayClaimWindow = 0;
    giveBack(`claim:${clientLimiterKey(ctx)}`, claimWindow);
}

/**
 * After signature verification: charge the verified key. A member of this node (or a visitor's row), `acts`, has its
 * own bucket; any other key is charged to the address's unsigned bucket (M-4), as if it had not signed.
 */
export function gatewayAdmitMember(ctx: Koa.Context, maxPerMinute: number, acts: boolean, now = Date.now()): boolean {
    if (!ctx.state.gatewaySignedClaim || !ctx.state.actor) return true;
    ctx.state.gatewayMemberCharged = true;
    return take(ctx, acts ? `m:${ctx.state.actor}` : `ip:${clientLimiterKey(ctx)}`, maxPerMinute, now);
}

/** After the request: a claimed signature that never produced a verified member is charged as unsigned. */
export function gatewaySettle(ctx: Koa.Context, now = Date.now()): void {
    if (!ctx.state.gatewaySignedClaim || ctx.state.gatewayMemberCharged) return;
    count(`ip:${clientLimiterKey(ctx)}`, now);
}

/** The peer protocol's own reads (GATEWAY_EXEMPT_PEER_READS): their own bucket per address, signed or not. */
export function gatewayAdmitPeerRead(ctx: Koa.Context, maxPerMinute: number, now = Date.now()): boolean {
    upkeep(now);
    return take(ctx, `peer:${clientLimiterKey(ctx)}`, maxPerMinute * PEER_READ_FACTOR, now);
}

/**
 * A WebSocket upgrade from `client` (limiterKeyForIp of the real client), before its connect token is verified: charged
 * as an HTTP request is at gatewayAdmit, a claimed token (`claimsSignature`: any of its signature parameters present)
 * to `sig:` only (an upgrade has no body, so it never spends `claim:`), anything else to `ip:`. The seconds to wait when
 * refused, else 0; `claimed` is for gatewaySettleUpgrade.
 */
export function gatewayAdmitUpgrade(client: string, maxPerMinute: number, claimsSignature: boolean, now = Date.now()): { wait: number; claimed: boolean } {
    upkeep(now);
    if (claimsSignature) {
        const wait = admitClaim(client, maxPerMinute, false, now);
        return { wait, claimed: !wait };
    }
    return { wait: takeKey(`ip:${client}`, maxPerMinute, now), claimed: false };
}

/**
 * The same upgrade once its token is checked (a `claimed` one only): a verified key is charged as gatewayAdmitMember
 * charges it, to its own bucket when it `acts` here and to the address's `ip:` when not; a token that did not verify is
 * counted as unsigned (gatewaySettle). The seconds to wait when the verified key's bucket is full, else 0.
 */
export function gatewaySettleUpgrade(client: string, maxPerMinute: number, claimed: boolean, verified: { key: string; acts: boolean } | null, now = Date.now()): number {
    if (!claimed) return 0;
    if (!verified) { count(`ip:${client}`, now); return 0; }
    return takeKey(verified.acts ? `m:${verified.key}` : `ip:${client}`, maxPerMinute, now);
}

/** Forget the hours that have left the rolling day. */
function dropPastHours(entry: DayCount, hour: number): void {
    let gone = 0;
    while (gone < entry.hours.length && entry.hours[gone] <= hour - DAY_HOURS) entry.total -= entry.counts[gone++];
    if (gone) { entry.hours.splice(0, gone); entry.counts.splice(0, gone); }
}

/** "in about 3 hours", from now to when the budget lets up. */
function inAbout(atMs: number, now: number): string {
    const mins = Math.max(1, Math.ceil((atMs - now) / 60_000));
    if (mins < 60) return mins === 1 ? 'in about a minute' : `in about ${mins} minutes`;
    const hours = Math.round(mins / 60);
    return hours === 1 ? 'in about an hour' : `in about ${hours} hours`;
}

/**
 * The 429 a full day budget answers, by whose it is: a keeper's enterprise work, or the signer's own (with a sentence
 * naming the enterprise when the write was for one whose own day was spent, as engine/writer-bounds.ts keeperOwnNote
 * says it). An enterprise's own day never refuses: past it, its keepers' writes count on their own.
 */
function dayBudgetRefusal(key: string, limit: number, resetsAtMs: number, now: number, forSpentEnterprise: boolean): { error: string; code: string; resetsAt: string } {
    const n = limit.toLocaleString('en');
    const when = inAbout(resetsAtMs, now);
    const resetsAt = new Date(resetsAtMs).toISOString();
    if (key.startsWith(WORK_KEY)) {
        return { error: `You have made ${n} changes today for the enterprises you keep (posts, deals, payments and the like), the most one person can make for all their enterprises together in 24 hours. You can carry on for them ${when}. Your own changes are counted apart.`, code: 'enterprise_work_day_budget', resetsAt };
    }
    const note = forSpentEnterprise ? ' This enterprise has reached its own limit for today, so what you do for it counts against yours.' : '';
    return { error: `You have made ${n} changes today (posts, messages, edits and the like), the most one account can make in 24 hours. You can carry on ${when}.${note}`, code: 'day_budget', resetsAt };
}

/** Has `key` spent its day (its hours past the rolling day forgotten first)? */
function daySpent(key: string, hour: number): boolean {
    const entry = dayCounts.get(key);
    if (!entry) return false;
    dropPastHours(entry, hour);
    return entry.total >= budgetOf(key);
}

/**
 * After signature verification: count a verified key's write against its day or, when the write's path names an
 * enterprise the signer keeps (enterpriseActingFor) and that enterprise's day has room, against `enterprise`'s and the
 * signer's enterprise work. Once the enterprise's day is spent, the write counts against the signer's own day instead.
 * False (and 429 set) when a day it counts on already holds its budget: `day_budget` for a member's
 * WRITER_LIMITS.signedWritesPerDay, `enterprise_work_day_budget` for a keeper's
 * WRITER_LIMITS.enterpriseWorkSignedWritesPerDay (an enterprise's WRITER_LIMITS.enterpriseSignedWritesPerDay never
 * refuses: it only says whose day a write is). A shop's governance and settling (ENTERPRISE_GOVERNANCE_WRITE) counts
 * against the signer's own day whatever `enterprise` says. A refused write isn't counted in any. Reads, the read marks
 * (DAY_BUDGET_READ_MARKS), unsigned requests and the admin surface pass untouched.
 */
export function gatewayAdmitDayBudget(ctx: Koa.Context, now = Date.now(), enterprise: string | null = null): boolean {
    const actor = ctx.state.actor as string | undefined;
    if (!actor || !WRITE_METHODS.has(ctx.method) || ctx.path.startsWith('/api/local/admin/')) return true;
    if (ctx.method === 'POST' && DAY_BUDGET_READ_MARKS.has(ctx.path)) return true;
    const forShop = enterprise && !(ctx.method === 'POST' && ENTERPRISE_GOVERNANCE_WRITE.test(ctx.path)) ? enterprise : null;
    const hour = Math.floor(now / HOUR_MS);
    const shopSpent = forShop !== null && daySpent(`${ENTERPRISE_KEY}${forShop}`, hour);
    if (shopSpent) logTrip(`dayent:${forShop}`, now);
    const keys = forShop && !shopSpent ? [`${ENTERPRISE_KEY}${forShop}`, `${WORK_KEY}${actor}`] : [actor];
    for (const key of keys) {
        // The enterprise's own day has room (shopSpent): only the keeper's can refuse.
        if (key.startsWith(ENTERPRISE_KEY)) continue;
        const entry = dayCounts.get(key);
        if (entry) dropPastHours(entry, hour);
        const limit = budgetOf(key);
        if (entry && entry.total >= limit) {
            // The oldest hour counted leaves the day at its end, 24 hours on, and gives back at least one write.
            const resetsAtMs = (entry.hours[0] + DAY_HOURS) * HOUR_MS;
            ctx.status = 429;
            ctx.set('Retry-After', String(Math.max(1, Math.ceil((resetsAtMs - now) / 1000))));
            ctx.body = dayBudgetRefusal(key, limit, resetsAtMs, now, shopSpent);
            logTrip(key.startsWith(WORK_KEY) ? `daywork:${actor}` : `day:${actor}`, now);
            return false;
        }
    }
    for (const key of keys) {
        let entry = dayCounts.get(key);
        if (!entry) {
            if (dayCounts.size >= DAY_BUDGET_MAX_KEYS) shrinkDayCounts(hour);
            entry = { hours: [], counts: [], total: 0 };
            dayCounts.set(key, entry);
        }
        const last = entry.hours.length - 1;
        if (last >= 0 && entry.hours[last] === hour) entry.counts[last]++;
        else { entry.hours.push(hour); entry.counts.push(1); }
        entry.total++;
    }
    return true;
}

/**
 * Make room below DAY_BUDGET_MAX_KEYS: keys with nothing in the day first, then those that have used the least of their
 * own budget (a member's 5,000, an enterprise's 50,000 or a keeper's enterprise work's 50,000), down to 90%.
 */
function shrinkDayCounts(hour: number): void {
    pruneDayCounts(hour);
    const target = Math.floor(DAY_BUDGET_MAX_KEYS * 0.9);
    if (dayCounts.size <= target) return;
    const smallest = [...dayCounts].sort((a, b) => a[1].total / budgetOf(a[0]) - b[1].total / budgetOf(b[0]));
    for (let i = 0; i < smallest.length && dayCounts.size > target; i++) dayCounts.delete(smallest[i][0]);
}

/** Forget every key with no write left in the rolling day. */
function pruneDayCounts(hour: number): void {
    for (const [k, entry] of dayCounts) {
        dropPastHours(entry, hour);
        if (entry.total <= 0) dayCounts.delete(k);
    }
}

/** How many keys the day budget holds counts for (tests and diagnostics). */
export function dayBudgetKeyCount(): number {
    return dayCounts.size;
}

/** Drop windows that have closed (the server's periodic cleaner), and the day counts of keys quiet for a day. */
export function pruneGatewayBuckets(now = Date.now()): void {
    lastPruneAt = now;
    pruneRuns++;
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    for (const [k, t] of loggedTrips) if (now - t >= WINDOW_MS) loggedTrips.delete(k);
    pruneDayCounts(Math.floor(now / HOUR_MS));
}

/** How many times the buckets have been pruned, and how many there are (tests and diagnostics). */
export function gatewayPruneRuns(): number {
    return pruneRuns;
}
export function gatewayBucketCount(): number {
    return buckets.size;
}

/** Tests only: forget every bucket, the day counts included. */
export function resetGatewayRateLimit(): void {
    buckets.clear();
    loggedTrips.clear();
    dayCounts.clear();
    lastPruneAt = 0;
}
