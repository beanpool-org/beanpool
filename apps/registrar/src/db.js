// D1 helpers for the registrar. The `name` PRIMARY KEY is the atomic arbiter: a second
// simultaneous claim for the same name fails the INSERT rather than racing.

export const getAllocation = (env, name) =>
    env.DB.prepare('SELECT * FROM name_allocations WHERE name=?').bind(name).first();

// Most recent non-revoked allocation for a node (a node holds one live/pending name).
export const getAllocationByPubkey = (env, pubkey) =>
    env.DB.prepare(
        "SELECT * FROM name_allocations WHERE node_pubkey=? AND status IN ('pending','live') ORDER BY requested_at DESC"
    ).bind(pubkey).first();

export const policyTier = async (env, name) => {
    const r = await env.DB.prepare('SELECT tier FROM name_policy WHERE pattern=?').bind(name).first();
    return r?.tier || 'auto';
};

export const listByStatus = async (env, status) =>
    (await env.DB.prepare('SELECT * FROM name_allocations WHERE status=?').bind(status).all()).results || [];

export const listActive = async (env) =>
    (await env.DB.prepare(
        "SELECT * FROM name_allocations WHERE status IN ('pending','live') ORDER BY requested_at DESC"
    ).all()).results || [];

// Atomic reserve. Throws (UNIQUE constraint) if the name is already held.
export const insertAllocation = (env, a) =>
    env.DB.prepare(
        `INSERT INTO name_allocations
           (name, node_pubkey, hostname, mode, status, origin, public_ip, contact, attest_fails, requested_at)
         VALUES (?,?,?,?,?,?,?,?,0,?)`
    ).bind(a.name, a.node_pubkey, a.hostname, a.mode, a.status,
           a.origin || null, a.public_ip || null, a.contact || null, a.requested_at).run();

export const updateAllocation = async (env, name, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    const set = keys.map((k) => `${k}=?`).join(', ');
    await env.DB.prepare(`UPDATE name_allocations SET ${set} WHERE name=?`)
        .bind(...keys.map((k) => fields[k]), name).run();
};

export const deleteAllocation = (env, name) =>
    env.DB.prepare('DELETE FROM name_allocations WHERE name=?').bind(name).run();
