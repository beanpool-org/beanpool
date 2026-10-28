// The registrar's live limits and its one switch (migration 0011 `settings`; Marty 2026-10-18: "open code, private
// settings"). The code is public, and so are the safe defaults below; the numbers a live registrar runs with are rows in
// D1, edited in /admin (POST /api/local/admin/registrar/settings), never written in the committed wrangler.toml or
// README. Each is read as: its D1 row when that is a whole number in range, else the Worker var `env` names (a
// self-hoster's wrangler.toml, the tests), else the default.
// One read a request that needs them (read), never more: D1 allows 50 queries an invocation on Workers Free.

export const SETTINGS = {
    // Where new names come from (scratch/global-node/DESIGN-registrar-trust-fable.md §4.3, D6 = hold, never refuse): past
    // either, a new auto name from that source is held for the admin's approval.
    source_per_hour: { def: 3, min: 1, max: 100000, words: 'New names from one source (one connecting address) in an hour; past it they are held for your approval' },
    source_per_day: { def: 10, min: 1, max: 100000, words: 'New names from one source in 24 hours; past it they are held for your approval' },
    // A hosting network carries many honest nodes: past this the admin is told, and nothing is held for it alone.
    asn_per_day: { def: 20, min: 1, max: 100000, words: 'New names from one network (ASN) in 24 hours; past it you are told (nothing is held for it alone)' },
    // Across all keys (SEC-REG-05): past either, every new auto name is held for approval.
    new_names_per_hour: { def: 20, min: 1, max: 100000, env: 'NEW_NAMES_PER_HOUR', words: 'New auto names across all nodes in an hour; past it they are held for your approval' },
    new_names_per_day: { def: 50, min: 1, max: 100000, env: 'NEW_NAMES_PER_DAY', words: 'New auto names across all nodes in 24 hours; past it they are held for your approval' },
    // M1 of the 2026-10-01 review (index.js claimLimit): a node uses one name; a rename keeps the old one held for it.
    claim_limit_per_key: { def: 3, min: 1, max: 1000, env: 'CLAIM_LIMIT_PER_KEY', words: 'Names one node key may hold at once (a further claim is refused 403)' },
    // Probation (§4.3.2): a new name is routed, but out of the directory, until both hold.
    probation_sweeps: { def: 3, min: 1, max: 288, words: 'Ok sweeps in a row before a new name leaves probation' },
    probation_s: { def: 3600, min: 0, max: 30 * 86400, words: 'Seconds a new name is live before it can leave probation' },
    // The attestation sweep's strikes (index.js applyVerdict).
    attest_fail_limit: { def: 2, min: 1, max: 1000, env: 'ATTEST_FAIL_LIMIT', words: 'Impostor answers in a row before a name\'s routing is paused' },
    swap_fail_limit: { def: 12, min: 1, max: 10000, env: 'SWAP_FAIL_LIMIT', words: 'Sweeps in a row of something other than its node answering before a name\'s routing is paused' },
    // The DNS zone's record cap (Cloudflare: 200 on a Free zone made after 1 Sep 2024, 1,000 before or on Pro), our own
    // hand records included. Past `capacity_alert_at` names on the zone (live, or being made) the admin is told, once a day; past
    // `capacity_hold_at` every new auto name is held: the last places are the admin's to give (§4.3.5).
    capacity: { def: 200, min: 1, max: 1000000, env: 'CAPACITY', words: 'DNS records the zone may hold (its Cloudflare plan\'s cap)' },
    capacity_alert_at: { def: (s) => Math.floor(s.capacity * 0.6), min: 1, max: 1000000, words: 'Names on the zone (live, or being made) past which you are told, once a day; default 60% of capacity' },
    capacity_hold_at: { def: (s) => Math.floor(s.capacity * 0.8), min: 1, max: 1000000, words: 'Names on the zone past which every new auto name is held for your approval; default 80% of capacity' },
};

// "Hold all new names" (§4.3.3): until this time (unix s) every new name waits for the admin's approval. Pressed, it
// holds for HOLD_S, then lets go by itself unless pressed again; 0 = off.
export const HOLD_KEY = 'hold_new_names_until';
export const HOLD_S = 24 * 3600;

const whole = (v, d) => {
    const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v) ? parseInt(v, 10) : NaN);
    return Number.isSafeInteger(n) && n >= d.min && n <= d.max ? n : null;
};

// Every setting as it applies now, from `rows` (the settings table's, by key): { <key>: number, hold_until, held (the
// rows: what the admin set, when and by whom), schema (false: the table is not there, migration 0011 not applied) }.
export function resolve(env, rows = new Map(), schema = true) {
    const out = {};
    for (const [key, d] of Object.entries(SETTINGS)) {
        const row = rows.get(key);
        const fromRow = row ? whole(row.value, d) : null;
        const fromEnv = d.env ? whole(env?.[d.env], d) : null;
        out[key] = fromRow ?? fromEnv ?? (typeof d.def === 'function' ? d.def(out) : d.def);
    }
    const hold = rows.get(HOLD_KEY);
    out.hold_until = hold && /^\d+$/.test(String(hold.value)) ? parseInt(hold.value, 10) : 0;
    out.rows = rows;
    out.schema = schema;
    return out;
}

// The settings, in one D1 read. A database without the table (a Worker deployed before its migration) gets the defaults
// and `schema: false`, which the callers read as "migration 0011 is not applied": nothing of it is written then. Any other
// failure (D1 overloaded, a connection lost) is thrown, never read as that (review of #2132): a claim then answers 5xx,
// which its node retries, rather than skip the blocks, the holds and probation; the sweep acts on no verdict (attestSweep).
export async function read(env) {
    let rs;
    try {
        rs = (await env.DB.prepare('SELECT key, value, updated_at, updated_by FROM settings').all()).results || [];
    } catch (e) {
        if (!/no such table/i.test(String(e?.message || e))) throw e;
        return resolve(env, new Map(), false);
    }
    return resolve(env, new Map(rs.map((r) => [r.key, r])));
}

// Is the switch on at `now`?
export const holding = (s, now) => s.hold_until > now;

// A setting written by the admin: a whole number in its range, or null to go back to the default. Answers the problem
// (a string) or null.
export async function write(env, key, value, who, now) {
    const d = SETTINGS[key];
    if (!d) return `unknown setting ${JSON.stringify(String(key)).slice(0, 40)}: one of ${Object.keys(SETTINGS).join(', ')}`;
    if (value === null || value === '') {
        await env.DB.prepare('DELETE FROM settings WHERE key=?').bind(key).run();
        return null;
    }
    const n = whole(value, d);
    if (n === null) return `${key} must be a whole number from ${d.min} to ${d.max}`;
    await env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .bind(key, String(n), now, who || null).run();
    return null;
}

// The switch: on for HOLD_S from now, or off.
export async function setHold(env, on, who, now) {
    await env.DB.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
        .bind(HOLD_KEY, String(on ? now + HOLD_S : 0), now, who || null).run();
    return on ? now + HOLD_S : 0;
}

// For /admin: each setting's value now, its default, its range and words, and whether a D1 row sets it.
export function describe(env, s) {
    const defaults = resolve(env, new Map(), true);
    return Object.entries(SETTINGS).map(([key, d]) => {
        const row = s.rows.get(key);
        return {
            // A line that follows the capacity follows the capacity in force.
            key, value: s[key], default: typeof d.def === 'function' ? d.def(s) : defaults[key], min: d.min, max: d.max, words: d.words,
            set: row ? { value: row.value, at: row.updated_at, by: row.updated_by || null } : null,
            ...(d.env && env?.[d.env] !== undefined ? { env: d.env } : {}),
        };
    });
}
