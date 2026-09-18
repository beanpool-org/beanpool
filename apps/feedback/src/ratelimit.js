// Per-sender rate limit without keeping the sender's IP.
//
// The key is SHA-256(daily salt ‖ IP). The salt is random, lives only in D1, is never logged, and is
// replaced at the start of each UTC day — the previous day's salt and counters are deleted at the
// same moment. So a stored hash can be tested against a guessed IP only for the day it was made,
// and not at all afterwards. The counters never reference a feedback row.
//
// Honest limits of this: the hourly window restarts at UTC midnight (new salt, new hash), and a
// whole village behind one carrier-grade NAT shares one IP and therefore one allowance. The limits
// are vars in wrangler.toml so they can be raised without a code change.

const HOUR = 3600;
const DAY = 86400;

export const utcDay = (nowS) => new Date(nowS * 1000).toISOString().slice(0, 10);

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256Hex(text) {
    return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

/** Today's salt, created on first use. Creating it also deletes every older salt and counter. */
export async function saltForDay(env, day) {
    const row = await env.DB.prepare('SELECT salt FROM rate_salts WHERE day=?').bind(day).first();
    if (row) return row.salt;
    const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
    // INSERT OR IGNORE then re-read: two first-requests-of-the-day racing agree on one salt.
    await env.DB.prepare('INSERT OR IGNORE INTO rate_salts (day, salt) VALUES (?, ?)').bind(day, fresh).run();
    await purgeBefore(env, day);
    const again = await env.DB.prepare('SELECT salt FROM rate_salts WHERE day=?').bind(day).first();
    return again.salt;
}

export async function purgeBefore(env, day) {
    await env.DB.batch([
        env.DB.prepare('DELETE FROM rate_salts WHERE day < ?').bind(day),
        env.DB.prepare('DELETE FROM rate_buckets WHERE day < ?').bind(day),
    ]);
}

const INCREMENT =
    'INSERT INTO rate_buckets (hash, bucket, day, count) VALUES (?, ?, ?, 1) ' +
    'ON CONFLICT(hash, bucket) DO UPDATE SET count = count + 1 RETURNING count';

/**
 * Counts this attempt and says whether it is within the limits. Attempts over the limit are
 * counted too, so hammering the endpoint keeps a sender blocked rather than probing the edge.
 * @returns {Promise<{ allowed: boolean, retryAfter: number }>}
 */
export async function checkAndCount(env, ip, nowS) {
    const perHour = Number(env.RATE_PER_HOUR) || 5;
    const perDay = Number(env.RATE_PER_DAY) || 20;
    const day = utcDay(nowS);
    const salt = await saltForDay(env, day);
    const hash = await sha256Hex(`${salt}:${ip || 'unknown'}`);
    const hourBucket = `h${Math.floor(nowS / HOUR)}`;
    const [h, d] = await env.DB.batch([
        env.DB.prepare(INCREMENT).bind(hash, hourBucket, day),
        env.DB.prepare(INCREMENT).bind(hash, `d${day}`, day),
    ]);
    const hourCount = h.results[0].count;
    const dayCount = d.results[0].count;
    if (dayCount > perDay) return { allowed: false, retryAfter: DAY - (nowS % DAY) };
    if (hourCount > perHour) return { allowed: false, retryAfter: HOUR - (nowS % HOUR) };
    return { allowed: true, retryAfter: 0 };
}
