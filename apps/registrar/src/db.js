// D1 helpers for the registrar. The `name` PRIMARY KEY is the atomic arbiter: a second
// simultaneous claim for the same name fails the INSERT rather than racing.
// States: migrations/0002_states.sql.

export const getAllocation = (env, name) =>
    env.DB.prepare('SELECT * FROM name_allocations WHERE name=?').bind(name).first();

// The node's current name: the most recent row it still holds and may use (a node holds one name).
export const getAllocationByPubkey = (env, pubkey) =>
    env.DB.prepare(
        "SELECT * FROM name_allocations WHERE node_pubkey=? AND status IN ('pending','live','paused') ORDER BY requested_at DESC"
    ).bind(pubkey).first();

// The node's own row in ANY state, the one that matters most first — what /status reports, so a node whose
// name is paused, released or blocked hears that rather than 'none' (which reads as "you never had a name",
// and makes the node claim again or wipe its saved address: the 2026-09-24 incident).
export const getOwnAllocation = (env, pubkey) =>
    env.DB.prepare(
        `SELECT * FROM name_allocations WHERE node_pubkey=?
         ORDER BY CASE status WHEN 'live' THEN 0 WHEN 'pending' THEN 1 WHEN 'paused' THEN 2 WHEN 'blocked' THEN 3
                              WHEN 'released' THEN 4 ELSE 5 END, requested_at DESC`
    ).bind(pubkey).first();

export const policyTier = async (env, name) => {
    const r = await env.DB.prepare('SELECT tier FROM name_policy WHERE pattern=?').bind(name).first();
    return r?.tier || 'auto';
};

export const listByStatus = async (env, status) =>
    (await env.DB.prepare('SELECT * FROM name_allocations WHERE status=?').bind(status).all()).results || [];

// Every name someone holds or held (not the abandoned ones), newest first — the admin page's list.
export const listActive = async (env) =>
    (await env.DB.prepare(
        "SELECT * FROM name_allocations WHERE status IN ('pending','live','paused','blocked','released') ORDER BY requested_at DESC"
    ).all()).results || [];

// Atomic reserve. Throws (UNIQUE constraint) if the name is already held. `held_reason` (migration 0011) is written only
// when the row carries one: a database without the column still takes every other claim.
export const insertAllocation = (env, a) =>
    env.DB.prepare(
        `INSERT INTO name_allocations
           (name, node_pubkey, hostname, mode, status, community_name, origin, public_ip, contact, attest_fails, requested_at${a.held_reason ? ', held_reason' : ''})
         VALUES (?,?,?,?,?,?,?,?,?,0,?${a.held_reason ? ',?' : ''})`
    ).bind(a.name, a.node_pubkey, a.hostname, a.mode, a.status,
           a.community_name || null, a.origin || null, a.public_ip || null, a.contact || null, a.requested_at,
           ...(a.held_reason ? [a.held_reason] : [])).run();

export const updateAllocation = async (env, name, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE name_allocations SET ${set} WHERE name=?`)
        .bind(...keys.map((k) => fields[k]), name).run();
};

// A row's tenure (key, claim time), state (status, pause reason) and the decisions taken on it (decision_seq,
// migration 0003 — a repeat pause or block changes nothing else, nor does a write recording Cloudflare work that points
// the record back at the address the row already records): what a request that read it acted on.
const STATE = ['node_pubkey', 'requested_at', 'status', 'pause_reason', 'decision_seq'];
// The routing a row records: its tunnel and DNS record ids, and the target they route to. A move to a new address
// keeps the record's id (a PATCH), so the ids alone can't tell a request that it is acting on an address, mode or
// origin the row no longer records.
const ROUTING = ['tunnel_id', 'dns_record_id', 'mode', 'public_ip', 'origin'];

// Is the row still `expected` (tenure, state, decisions — and, `withIds`, the routing it recorded: ids and target)?
// Asked before touching a record found by hostname, which is another tenure's once the row has changed, and before a
// clean-up removes routing a later request may have put up.
export const isUnchanged = async (env, name, expected, { withIds = false } = {}) => {
    const cols = withIds ? [...STATE, ...ROUTING] : STATE;
    return !!(await env.DB.prepare(`SELECT 1 AS yes FROM name_allocations WHERE name=? AND ${cols.map((c) => `${c} IS ?`).join(' AND ')}`)
        .bind(name, ...cols.map((c) => expected[c] ?? null)).first());
};

// Write `fields` over `expected` — the row as this request read it, or last wrote it — only if its tenure and
// state are unchanged (and, `withIds`, the routing it recorded: ids and target): a request that worked at Cloudflare
// meanwhile must not overwrite an admin's pause or block, the sweep's pause, a release or another claim. False =
// the row changed — or the driver didn't say how many rows changed: a lock that can't tell must not report a win.
export const updateIfUnchanged = async (env, name, expected, fields, { withIds = false } = {}) => {
    const keys = Object.keys(fields);
    const cols = withIds ? [...STATE, ...ROUTING] : STATE;
    const set = keys.length ? keys.map((k) => `${k}=?`).join(', ') : 'name=name';
    const r = await env.DB.prepare(
        `UPDATE name_allocations SET ${set} WHERE name=? AND ${cols.map((c) => `${c} IS ?`).join(' AND ')}`
    ).bind(...keys.map((k) => fields[k]), name, ...cols.map((c) => expected[c] ?? null)).run();
    return (r?.meta?.changes ?? 0) > 0;
};

// Overwrite `expected` — a row as it was just read — with a new tenure, only if nobody changed it meanwhile: two
// keys racing for a freed name must not both think they won, and a take-back must not undo the admin's release.
export const replaceAllocation = (env, name, expected, fields) => updateIfUnchanged(env, name, expected, fields);

// Delete `expected` — a row this request inserted — only if its tenure and state are still as inserted.
export const deleteIfUnchanged = async (env, name, expected) => {
    const r = await env.DB.prepare(`DELETE FROM name_allocations WHERE name=? AND ${STATE.map((c) => `${c} IS ?`).join(' AND ')}`)
        .bind(name, ...STATE.map((c) => expected[c] ?? null)).run();
    return (r?.meta?.changes ?? 0) > 0;
};

// How many names `pubkey` holds, for the per-key claim limit (index.js claimLimit): every row of that key that holds
// its name as holdsName decides it — any state but a release past its hold (`since` = now − the hold), a release that
// freed the name at once ('admin', 'withdrawn') and an abandoned one; a state this code doesn't know counts, as holdsName
// treats it — except the admin's release of a name it had taken from that key ('admin-held-all'), held from that key too.
export const countHeldBy = async (env, pubkey, since) => {
    const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM name_allocations WHERE node_pubkey=?
           AND (status NOT IN ('released', 'abandoned')
                OR (status = 'released' AND COALESCE(pause_reason, '') NOT IN ('admin', 'withdrawn', 'admin-held-all')
                    AND COALESCE(released_at, 0) > ?))`
    ).bind(pubkey, since).first();
    return Number(r?.n) || 0;
};

// A signed request's one-use nonce (signing protocol v2, migration 0006): true the first time this key sends it, false
// after — a replay. A driver that doesn't say how many rows changed reads as a replay: a check that can't tell must not
// let one through.
export const takeNonce = async (env, pubkey, nonce, ts) => {
    const r = await env.DB.prepare('INSERT OR IGNORE INTO request_nonces (pubkey, nonce, ts) VALUES (?,?,?)').bind(pubkey, nonce, ts).run();
    return (r?.meta?.changes ?? 0) > 0;
};

// Nonces whose request's timestamp no longer verifies (sign.js CLOCK_SKEW_S) can't be replayed: the sweep drops them.
export const pruneNonces = (env, before) => env.DB.prepare('DELETE FROM request_nonces WHERE ts < ?').bind(before).run();

// A valid signed request from `pubkey`: the abandonment clock restarts and any warning clears, on every name
// the key holds. At most one write an hour per key (nodes ask every 5 min), unless a warning must clear.
export const touchContact = (env, pubkey, now, proto = 'v1') =>
    env.DB.prepare(
        `UPDATE name_allocations SET last_contact_at=?, warned_at=NULL, proto=?
         WHERE node_pubkey=? AND status <> 'abandoned'
           AND (last_contact_at IS NULL OR last_contact_at < ? OR warned_at IS NOT NULL)`
    ).bind(now, proto, pubkey, now - 3600).run();

export const deleteAllocation = (env, name) =>
    env.DB.prepare('DELETE FROM name_allocations WHERE name=?').bind(name).run();

export const getInvite = (env, code) =>
    env.DB.prepare('SELECT * FROM invites WHERE code=?').bind(code).first();

export const insertInvite = (env, code, nodeName, createdAt = Math.floor(Date.now() / 1000)) =>
    env.DB.prepare('INSERT INTO invites (code, node_name, created_at) VALUES (?,?,?)').bind(code, nodeName, createdAt).run();

export const insertEvent = (env, name, event, detail = null, at = Math.floor(Date.now() / 1000)) =>
    env.DB.prepare('INSERT INTO name_events (name, at, event, detail) VALUES (?,?,?,?)').bind(name, at, event, detail).run();

// When `name` last had `event` (unix s), or null.
export const lastEventAt = async (env, name, event) =>
    (await env.DB.prepare('SELECT MAX(at) AS at FROM name_events WHERE name=? AND event=?').bind(name, event).first())?.at ?? null;

export const listEvents = async (env, name, limit = 200) =>
    (name
        ? await env.DB.prepare('SELECT * FROM name_events WHERE name=? ORDER BY at DESC, id DESC LIMIT ?').bind(name, limit).all()
        : await env.DB.prepare('SELECT * FROM name_events ORDER BY at DESC, id DESC LIMIT ?').bind(limit).all()
    ).results || [];

// Owed deletions (migration 0004): a Cloudflare tunnel or DNS record the registrar let go of but Cloudflare refused
// to delete. Recorded once (the first refusal's time stands); the sweep retries them.
export const oweTeardown = (env, name, kind, cfId, since) =>
    env.DB.prepare('INSERT OR IGNORE INTO teardown (kind, cf_id, name, since) VALUES (?,?,?,?)').bind(kind, cfId, name, since).run();

// The name's owed deletions, or (no name) all of them — only refused deletes land here, so it stays small, and one the
// sweep leaves for now (a tunnel a row still keeps) must not crowd out the rest.
export const listTeardown = async (env, name) =>
    (name
        ? await env.DB.prepare('SELECT * FROM teardown WHERE name=? ORDER BY since').bind(name).all()
        : await env.DB.prepare('SELECT * FROM teardown ORDER BY since').all()
    ).results || [];

export const dropTeardown = (env, kind, cfId) =>
    env.DB.prepare('DELETE FROM teardown WHERE kind=? AND cf_id=?').bind(kind, cfId).run();

// Drop an owed deletion only while the name's row is still `expected` (tenure, state, decisions, routing), in one
// statement: a take-down writes its row before it owes, so one that landed first keeps the entry (its own owe onto it
// was a no-op), and one landing after owes it anew. True if dropped.
export const dropTeardownIfUnchanged = async (env, kind, cfId, name, expected) => {
    const cols = [...STATE, ...ROUTING];
    const r = await env.DB.prepare(
        `DELETE FROM teardown WHERE kind=? AND cf_id=?
           AND EXISTS (SELECT 1 FROM name_allocations WHERE name=? AND ${cols.map((c) => `${c} IS ?`).join(' AND ')})`
    ).bind(kind, cfId, name, ...cols.map((c) => expected[c] ?? null)).run();
    return (r?.meta?.changes ?? 0) > 0;
};

export const teardownRefused = (env, kind, cfId, error) =>
    env.DB.prepare('UPDATE teardown SET tries = tries + 1, last_error=? WHERE kind=? AND cf_id=?').bind(error, kind, cfId).run();

// For the admin's alerts (src/alerts.js): claims waiting for the admin (pending on a name that is not auto-approved, or
// held for approval: index.js awaitingApproval), and live names. On a database without migration 0011 (no held_reason),
// the gated ones only.
export const countAwaitingApproval = async (env) => {
    try {
        return Number((await env.DB.prepare(
            `SELECT COUNT(*) AS n FROM name_allocations a LEFT JOIN name_policy p ON p.pattern = a.name
             WHERE a.status = 'pending' AND (a.held_reason IS NOT NULL OR COALESCE(NULLIF(p.tier, ''), 'auto') <> 'auto')`
        ).first())?.n) || 0;
    } catch (e) {
        if (!/no such column/i.test(String(e?.message || e))) throw e;
        return Number((await env.DB.prepare(
            "SELECT COUNT(*) AS n FROM name_allocations a JOIN name_policy p ON p.pattern = a.name WHERE a.status = 'pending' AND p.tier <> 'auto'"
        ).first())?.n) || 0;
    }
};
// The policy tier of every pending row's name that has a policy row (any other is auto), in one read: the admin's list
// asks it once whatever the number of claims (D1 allows 50 queries an invocation on Workers Free).
export const pendingTiers = async (env) => new Map(((await env.DB.prepare(
    "SELECT p.pattern AS name, p.tier FROM name_policy p JOIN name_allocations a ON a.name = p.pattern WHERE a.status = 'pending'"
).all()).results || []).map((r) => [r.name, r.tier]));

// Claims whose provisioning never finished, for the sweep to finish (index.js finishOrphans): pending on a name that is
// auto-approved (as policyTier decides: no policy row, or tier 'auto') and not held for approval (held_reason, migration
// 0011: asked of the database itself, as countAwaitingApproval asks it — never inferred from a settings read, which a D1
// blip fails: review of #2132), claimed before `before` (unix s), by a key the
// admin has not stopped — none of its rows blocked, nor a release the admin holds from it ('admin-held-all') released
// after `heldSince`. At most `limit`, in no fixed order: a few Cloudflare keeps refusing never hold back the rest.
export const listOrphans = async (env, before, heldSince, limit) => {
    const list = async (held) => (await env.DB.prepare(
        `SELECT a.* FROM name_allocations a LEFT JOIN name_policy p ON p.pattern = a.name
         WHERE a.status = 'pending' AND COALESCE(NULLIF(p.tier, ''), 'auto') = 'auto' AND a.requested_at < ?${held ? ' AND a.held_reason IS NULL' : ''}
           AND NOT EXISTS (SELECT 1 FROM name_allocations b WHERE b.node_pubkey = a.node_pubkey
                             AND (b.status = 'blocked' OR (b.status = 'released' AND b.pause_reason = 'admin-held-all' AND COALESCE(b.released_at, 0) > ?)))
         ORDER BY RANDOM() LIMIT ?`
    ).bind(before, heldSince, limit).all()).results || [];
    try {
        return await list(true);
    } catch (e) {
        if (!/no such column/i.test(String(e?.message || e))) throw e;
        return list(false);
    }
};
export const countLive = async (env) =>
    Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM name_allocations WHERE status = 'live'").first())?.n) || 0;
// The new-name budget (index.js newNameBudget): auto-approved names that went live after `since` (unix s), whatever their
// state now: each made a tunnel and a record at Cloudflare. No table of its own, and no IP stored.
export const autoNamesSince = async (env, since) => Number((await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM name_allocations WHERE decided_by = 'auto' AND decided_at > ?"
).bind(since).first())?.n) || 0;
// Deletions Cloudflare has refused since before `before` (unix s): how many, and the oldest's time.
export const owedSince = async (env, before) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n, MIN(since) AS oldest FROM teardown WHERE since < ?').bind(before).first();
    return { n: Number(r?.n) || 0, oldest: r?.oldest ?? null };
};

// One row per sweep; rows older than 90 days go (288 sweeps a day).
export const insertSweepLog = async (env, s, now) => {
    await env.DB.prepare(
        'INSERT INTO sweep_log (ran_at, live_count, ok, unverifiable, impostor, content_swap, action) VALUES (?,?,?,?,?,?,?)'
    ).bind(now, s.live, s.ok, s.unverifiable, s.impostor, s.content_swap || 0, s.action).run();
    await env.DB.prepare('DELETE FROM sweep_log WHERE ran_at < ?').bind(now - 90 * 86400).run();
};

// Did the registrar hold `name` before the tenure claimed at `since`? A claim event earlier than it says so.
export const claimedBefore = async (env, name, since) =>
    !!(await env.DB.prepare("SELECT 1 AS yes FROM name_events WHERE name=? AND event='claimed' AND at < ? LIMIT 1").bind(name, since).first());

// --- Where new names come from (migration 0011; index.js claimGate) ---

// Everything a claim of a new name is decided on, in one read: how many new names its source (`hash`) and its network
// (`asn`) claimed since `hourAgo` and `dayAgo`, whether either is blocked now (the blocked_sources row's kind, or null),
// the auto names that went live across all keys in the hour and the day (the new-name budget: autoNamesSince), and the
// names against the zone's capacity (namesOnZone).
export const claimFacts = async (env, { hash, asn }, now, hourAgo, dayAgo) => {
    const a = asn === null || asn === undefined ? null : String(asn);
    const r = await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM claim_sources WHERE source_hash = ? AND at > ?) AS source_hour,
           (SELECT COUNT(*) FROM claim_sources WHERE source_hash = ? AND at > ?) AS source_day,
           (SELECT COUNT(*) FROM claim_sources WHERE asn = ? AND at > ?) AS asn_day,
           (SELECT kind FROM blocked_sources WHERE until > ? AND ((kind = 'source' AND value = ?) OR (kind = 'asn' AND value = ?)) LIMIT 1) AS blocked,
           (SELECT COUNT(*) FROM name_allocations WHERE decided_by = 'auto' AND decided_at > ?) AS auto_hour,
           (SELECT COUNT(*) FROM name_allocations WHERE decided_by = 'auto' AND decided_at > ?) AS auto_day,
           (SELECT COUNT(*) FROM name_allocations WHERE ${ON_ZONE}) AS names`
    ).bind(hash, hourAgo, hash, dayAgo, asn ?? null, dayAgo, now, hash, a, hourAgo, dayAgo).first();
    const n = (k) => Number(r?.[k]) || 0;
    return {
        source_hour: n('source_hour'), source_day: n('source_day'), asn_day: n('asn_day'), blocked: r?.blocked || null,
        auto_hour: n('auto_hour'), auto_day: n('auto_day'), names: n('names'),
    };
};

// The names that hold a DNS record at the zone, or are about to: live, and pending but not held for approval (a claim
// being made, or a gated one an approve would make). A held name makes nothing until the admin approves it: a bot's
// held batch must not fill the capacity and hold every honest claim behind it.
const ON_ZONE = "status = 'live' OR (status = 'pending' AND held_reason IS NULL)";
export const namesOnZone = async (env) => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM name_allocations WHERE ${ON_ZONE}`).first())?.n) || 0;

// One new name's source, kept 24 h, or for as long as its name is held for approval (pruneSources). Never the
// connecting address: its keyed hash only.
export const recordSource = (env, r) =>
    env.DB.prepare('INSERT INTO claim_sources (at, name, node_pubkey, source_hash, asn, as_org, country, held_reason) VALUES (?,?,?,?,?,?,?,?)')
        .bind(r.at, r.name, r.node_pubkey, r.source_hash ?? null, r.asn ?? null, r.as_org ?? null, r.country ?? null, r.held_reason ?? null).run();

// The row (`a`) of the tenure a claim (`s`) began, still held for the admin's approval: its source is kept past the day
// while it waits, so a bot's held batch is still rejected or blocked by source in one click however long it waits
// (Marty 2026-10-18: bulk action on a batch always works). Once the name is decided its source goes at the next prune.
const TENURE = 'a.name = s.name AND a.node_pubkey = s.node_pubkey AND a.requested_at = s.at';
const STILL_HELD = "a.status = 'pending' AND a.held_reason IS NOT NULL";

export const pruneSources = (env, before) => env.DB.prepare(
    `DELETE FROM claim_sources WHERE at < ? AND NOT EXISTS (SELECT 1 FROM name_allocations a
       WHERE a.name = claim_sources.name AND a.node_pubkey = claim_sources.node_pubkey AND a.requested_at = claim_sources.at AND ${STILL_HELD})`
).bind(before).run();

// The last day's new names, and older ones still held, with where they came from and their row as it is now (null when
// it is gone or another tenure's), newest first: /admin's "New names, last 24 h", grouped there by source and by network.
export const recentSources = async (env, since) => ((await env.DB.prepare(
    `SELECT s.at, s.name, s.node_pubkey, s.source_hash, s.asn, s.as_org, s.country, s.held_reason AS held_at_claim,
            a.status, a.held_reason, a.verified_at, a.community_name
     FROM claim_sources s LEFT JOIN name_allocations a ON ${TENURE}
     WHERE s.at > ? OR (${STILL_HELD}) ORDER BY s.at DESC LIMIT 1000`
).bind(since).all()).results || []);

// A group's names (claimed since `since`, or before it and still held, from one source, or with no source — SOURCE_KEY
// unset — from one network: the panel's group of that network's names with no source, never a keyed source's) still
// held by the tenure its claim made, that /admin's "Block all" acts on — every pending one (rejected: held, gated or
// being set up), live and paused (blocked) — or, `heldOnly`, "Reject all held": the pending ones held for approval
// (held_reason set), never a gated claim or a name still being set up. At most `limit`, oldest first.
export const groupNames = async (env, { source = null, asn = null, heldOnly = false }, since, limit) => ((await env.DB.prepare(
    `SELECT DISTINCT a.* FROM claim_sources s JOIN name_allocations a ON ${TENURE}
     WHERE ${source ? 's.source_hash = ?' : 's.source_hash IS NULL AND s.asn = ?'} AND (s.at > ? OR (${STILL_HELD}))
       AND ${heldOnly ? STILL_HELD : "a.status IN ('pending', 'live', 'paused')"}
     ORDER BY a.requested_at LIMIT ?`
).bind(source || asn, since, limit).all()).results || []);

// The latest facts the registrar keeps of a source (its network, country): what a block's label says.
export const sourceFacts = async (env, hash) => env.DB.prepare(
    'SELECT asn, as_org, country, COUNT(*) AS names FROM claim_sources WHERE source_hash = ? GROUP BY asn, as_org, country ORDER BY MAX(at) DESC LIMIT 1'
).bind(hash).first();

export const listBlocked = async (env, now) =>
    (await env.DB.prepare('SELECT * FROM blocked_sources WHERE until > ? ORDER BY at DESC').bind(now).all()).results || [];

export const blockSource = (env, kind, value, until, now, by, label) => env.DB.prepare(
    `INSERT INTO blocked_sources (kind, value, until, at, by, label) VALUES (?,?,?,?,?,?)
     ON CONFLICT(kind, value) DO UPDATE SET until=excluded.until, at=excluded.at, by=excluded.by, label=excluded.label`
).bind(kind, value, until, now, by ?? null, label ?? null).run();

export const unblockSource = async (env, kind, value) =>
    ((await env.DB.prepare('DELETE FROM blocked_sources WHERE kind=? AND value=?').bind(kind, value).run())?.meta?.changes ?? 0) > 0;

// --- Notices to the operators of names (migration 0013; index.js carryNotices, handleNotices, the ReplyTokens entrypoint) ---

// The states in which a key holds its name (holdsName, release aside): a notice is carried, and its reply link taken,
// only while the name it is about is still in one of them for that key. A blocked name's node still hears it.
const HOLDS = "('pending', 'live', 'paused', 'blocked')";
const HELD_BY = `EXISTS (SELECT 1 FROM name_allocations a WHERE a.name = r.name AND a.node_pubkey = r.node_pubkey AND a.status IN ${HOLDS})`;
// One recipient row per key: the key's live name first, when a group holds more than one of its names.
const BY_STATE = "CASE a.status WHEN 'live' THEN 0 WHEN 'pending' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END, a.name";

// The node said it has every notice up to `seen` (its highest id): those carried to it are never carried again, and
// their reply links' tokens leave the table (only their hashes stay, in reply_tokens). One never carried to it is left
// as it is: it reaches the node once the name it is about is held again.
export const ackNotices = (env, pubkey, seen, now) => env.DB.prepare(
    `UPDATE notice_recipients SET seen_at = ?, reply_token = NULL
     WHERE node_pubkey = ? AND notice_id <= ? AND delivered_at IS NOT NULL AND seen_at IS NULL`
).bind(now, pubkey, seen).run();

// What `pubkey`'s /status carries: its notices not yet seen and not past their time, about a name it still holds, oldest
// first, at most `limit`.
export const noticesFor = async (env, pubkey, now, limit) => ((await env.DB.prepare(
    `SELECT r.notice_id, r.name, r.delivered_at, r.reply_token, n.at, n.level, n.text, n.reply
     FROM notice_recipients r JOIN notices n ON n.id = r.notice_id
     WHERE r.node_pubkey = ? AND r.seen_at IS NULL AND n.expires_at > ? AND ${HELD_BY}
     ORDER BY r.notice_id LIMIT ?`
).bind(pubkey, now, limit).all()).results || []);

// A notice's first carry to its key: delivered now, with its reply link's token (or null). True only for the one request
// that marked it: two /status of one key at once never make two links.
export const markDelivered = async (env, noticeId, pubkey, now, token) => ((await env.DB.prepare(
    'UPDATE notice_recipients SET delivered_at = ?, reply_token = ? WHERE notice_id = ? AND node_pubkey = ? AND delivered_at IS NULL'
).bind(now, token, noticeId, pubkey).run())?.meta?.changes ?? 0) > 0;

export const forgetReplyToken = (env, noticeId, pubkey) =>
    env.DB.prepare('UPDATE notice_recipients SET reply_token = NULL WHERE notice_id = ? AND node_pubkey = ?').bind(noticeId, pubkey).run();

export const insertReplyToken = (env, t) => env.DB.prepare(
    'INSERT INTO reply_tokens (token_hash, notice_id, node_pubkey, name, at, expires_at) VALUES (?,?,?,?,?,?)'
).bind(t.token_hash, t.notice_id, t.node_pubkey, t.name, t.at, t.expires_at).run();

// A reply link that still works: not used, not past its time, its name still held by its key.
const LIVE_TOKEN = `r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND ${HELD_BY}`;
export const replyTokenLive = async (env, hash, now) =>
    !!(await env.DB.prepare(`SELECT 1 AS yes FROM reply_tokens r WHERE ${LIVE_TOKEN}`).bind(hash, now).first());

// The reply link's one use, in one statement: the name and notice it was for, to the one request that took it; else null.
export const takeReplyToken = (env, hash, now) => env.DB.prepare(
    `UPDATE reply_tokens AS r SET used_at = ? WHERE ${LIVE_TOKEN} RETURNING name, notice_id`
).bind(now, hash, now).first();

// A notice the admin wrote; its id.
export const insertNotice = async (env, n) => (await env.DB.prepare(
    'INSERT INTO notices (at, level, text, reply, expires_at, audience, by) VALUES (?,?,?,?,?,?,?) RETURNING id'
).bind(n.at, n.level, n.text, n.reply ? 1 : 0, n.expires_at, n.audience, n.by ?? null).first())?.id ?? null;

export const deleteNotice = (env, id) => env.DB.prepare('DELETE FROM notices WHERE id = ?').bind(id).run();

// Who a notice goes to, in one statement: every key holding one of `to`'s names now — { names } those names, { source }
// the names one source claimed since `since` (the last day) or still held for approval, { asn } the same of one
// network's names with no source (the panel's group, as groupNames reads it: never a keyed source's, another group and
// often another operator on a shared host), { all } every name held — one row per key. How many.
export async function addRecipients(env, noticeId, to, since) {
    let from;
    let args;
    if (to.names) {
        from = `FROM name_allocations a WHERE a.name IN (${to.names.map(() => '?').join(', ')}) AND a.status IN ${HOLDS}`;
        args = to.names;
    } else if (to.source || to.asn) {
        from = `FROM claim_sources s JOIN name_allocations a ON ${TENURE}
                WHERE ${to.source ? 's.source_hash = ?' : 's.source_hash IS NULL AND s.asn = ?'} AND (s.at > ? OR (${STILL_HELD})) AND a.status IN ${HOLDS}`;
        args = [to.source || to.asn, since];
    } else {
        from = `FROM name_allocations a WHERE a.status IN ${HOLDS}`;
        args = [];
    }
    const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO notice_recipients (notice_id, node_pubkey, name) SELECT ?, a.node_pubkey, a.name ${from} ORDER BY ${BY_STATE}`
    ).bind(noticeId, ...args).run();
    return r?.meta?.changes ?? 0;
}

// Each name a notice went to, in its history (name_events): the notice's id and level, never its words.
export const noticeEvents = (env, noticeId, detail, now) => env.DB.prepare(
    "INSERT INTO name_events (name, at, event, detail) SELECT name, ?, 'notice', ? FROM notice_recipients WHERE notice_id = ?"
).bind(now, detail, noticeId).run();

// /admin's list: the latest notices, each with how many keys it went to, how many a /status carried it to, how many said
// they have it, and how many replied.
export const listNotices = async (env, limit) => ((await env.DB.prepare(
    `SELECT n.*, COUNT(r.node_pubkey) AS recipients, COUNT(r.delivered_at) AS delivered, COUNT(r.seen_at) AS seen,
            (SELECT COUNT(*) FROM reply_tokens t WHERE t.notice_id = n.id AND t.used_at IS NOT NULL) AS replies
     FROM notices n LEFT JOIN notice_recipients r ON r.notice_id = n.id GROUP BY n.id ORDER BY n.id DESC LIMIT ?`
).bind(limit).all()).results || []);

// One notice's recipients: the name, when it was carried and seen, when its reply link was used.
export const noticeRecipients = async (env, noticeId, limit) => ((await env.DB.prepare(
    `SELECT r.name, r.delivered_at, r.seen_at,
            (SELECT t.used_at FROM reply_tokens t WHERE t.notice_id = r.notice_id AND t.node_pubkey = r.node_pubkey) AS replied_at
     FROM notice_recipients r WHERE r.notice_id = ? ORDER BY r.name LIMIT ?`
).bind(noticeId, limit).all()).results || []);

// Reply links never used go at their time; a used one is a reply /admin counts (listNotices, noticeRecipients), so it
// goes only with its notice. Notices more than `keep` past their time go, with their recipients and links.
export async function pruneNotices(env, now, keep) {
    await env.DB.prepare('DELETE FROM reply_tokens WHERE (used_at IS NULL AND expires_at < ?) OR notice_id IN (SELECT id FROM notices WHERE expires_at < ?)')
        .bind(now, now - keep).run();
    await env.DB.prepare('DELETE FROM notice_recipients WHERE notice_id IN (SELECT id FROM notices WHERE expires_at < ?)').bind(now - keep).run();
    await env.DB.prepare('DELETE FROM notices WHERE expires_at < ?').bind(now - keep).run();
}

// Contact retention (design §3.2): a name's optional contact is kept only while the name is held. Its hold over (a release
// past `heldSince`, or one that freed it at once) or the name abandoned, it is cleared. One statement, deciding "held" as
// holdsName does; the sweep runs it every time.
export const clearLapsedContacts = (env, heldSince) => env.DB.prepare(
    `UPDATE name_allocations SET contact = NULL WHERE contact IS NOT NULL
       AND (status = 'abandoned'
            OR (status = 'released' AND (COALESCE(pause_reason, '') IN ('admin', 'withdrawn') OR COALESCE(released_at, 0) <= ?)))`
).bind(heldSince).run();
