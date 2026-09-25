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

// Atomic reserve. Throws (UNIQUE constraint) if the name is already held.
export const insertAllocation = (env, a) =>
    env.DB.prepare(
        `INSERT INTO name_allocations
           (name, node_pubkey, hostname, mode, status, community_name, origin, public_ip, contact, attest_fails, requested_at)
         VALUES (?,?,?,?,?,?,?,?,?,0,?)`
    ).bind(a.name, a.node_pubkey, a.hostname, a.mode, a.status,
           a.community_name || null, a.origin || null, a.public_ip || null, a.contact || null, a.requested_at).run();

export const updateAllocation = async (env, name, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE name_allocations SET ${set} WHERE name=?`)
        .bind(...keys.map((k) => fields[k]), name).run();
};

// A row's tenure (key, claim time), state (status, pause reason) and the decisions taken on it (decision_seq,
// migration 0003 — a repeat pause or block changes nothing else): what a request that read it acted on.
const STATE = ['node_pubkey', 'requested_at', 'status', 'pause_reason', 'decision_seq'];
const IDS = ['tunnel_id', 'dns_record_id'];

// Is the row still `expected` (tenure, state, decisions — and, `withIds`, the tunnel and DNS ids it recorded)? Asked
// before touching a record found by hostname, which is another tenure's once the row has changed, and before a clean-up
// removes routing a later request may have put up.
export const isUnchanged = async (env, name, expected, { withIds = false } = {}) => {
    const cols = withIds ? [...STATE, ...IDS] : STATE;
    return !!(await env.DB.prepare(`SELECT 1 AS yes FROM name_allocations WHERE name=? AND ${cols.map((c) => `${c} IS ?`).join(' AND ')}`)
        .bind(name, ...cols.map((c) => expected[c] ?? null)).first());
};

// Write `fields` over `expected` — the row as this request read it, or last wrote it — only if its tenure and
// state are unchanged (and, `withIds`, the tunnel and DNS ids it recorded): a request that worked at Cloudflare
// meanwhile must not overwrite an admin's pause or block, the sweep's pause, a release or another claim. False =
// the row changed — or the driver didn't say how many rows changed: a lock that can't tell must not report a win.
export const updateIfUnchanged = async (env, name, expected, fields, { withIds = false } = {}) => {
    const keys = Object.keys(fields);
    const cols = withIds ? [...STATE, ...IDS] : STATE;
    const set = keys.length ? keys.map((k) => `${k}=?`).join(', ') : 'name=name';
    const r = await env.DB.prepare(
        `UPDATE name_allocations SET ${set} WHERE name=? AND ${cols.map((c) => `${c} IS ?`).join(' AND ')}`
    ).bind(...keys.map((k) => fields[k]), name, ...cols.map((c) => expected[c] ?? null)).run();
    return (r?.meta?.changes ?? 0) > 0;
};

// Overwrite `expected` — a row as it was just read — with a new tenure, only if nobody changed it meanwhile: two
// keys racing for a freed name must not both think they won, and a take-back must not undo the admin's release.
export const replaceAllocation = (env, name, expected, fields) => updateIfUnchanged(env, name, expected, fields);

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

export const teardownRefused = (env, kind, cfId, error) =>
    env.DB.prepare('UPDATE teardown SET tries = tries + 1, last_error=? WHERE kind=? AND cf_id=?').bind(error, kind, cfId).run();

// One row per sweep; rows older than 90 days go (288 sweeps a day).
export const insertSweepLog = async (env, s, now) => {
    await env.DB.prepare(
        'INSERT INTO sweep_log (ran_at, live_count, ok, unverifiable, impostor, content_swap, action) VALUES (?,?,?,?,?,?,?)'
    ).bind(now, s.live, s.ok, s.unverifiable, s.impostor, s.content_swap || 0, s.action).run();
    await env.DB.prepare('DELETE FROM sweep_log WHERE ran_at < ?').bind(now - 90 * 86400).run();
};
