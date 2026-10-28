import * as alerts from './alerts.js';
import * as cf from './cf.js';
import * as settings from './settings.js';

export const DNS_RECORD_CHECK_CADENCE_S = 3600; // at most once per hour

// The zone's record cap is the `capacity` setting (/admin; env CAPACITY; default 200, the Free plan's), the same number
// the names are held against. A failed settings read falls back to that default rather than skip the count.
export async function dnsRecordCap(env) {
    try {
        return (await settings.read(env)).capacity;
    } catch {
        return settings.SETTINGS.capacity.def;
    }
}

// Read the cached DNS record count from watch_marks (if within 1 hour).
// If missing, expired, or force=true: call Cloudflare, update watch_marks.
// Never throws: on failure returns { ok: false, error: '...', count: null, cap, pct: null }
export async function getOrCountDnsRecords(env, now = Math.floor(Date.now() / 1000), { force = false, cap: known } = {}) {
    if (!force) {
        try {
            const mark = await env.DB.prepare("SELECT since, value FROM watch_marks WHERE key='dns-records'").first();
            if (mark?.value && mark.since && (now - mark.since) < DNS_RECORD_CHECK_CADENCE_S) {
                const parsed = JSON.parse(mark.value);
                if (parsed.count !== null && parsed.count !== undefined && parsed.cap) {
                    return { ok: true, count: parsed.count, cap: parsed.cap, pct: parsed.pct, checked_at: mark.since };
                }
                if (parsed.error && parsed.cap) {
                    return { ok: false, error: parsed.error, count: null, cap: parsed.cap, pct: null, checked_at: mark.since };
                }
            }
        } catch { /* ignore D1 error */ }
    }

    const cap = known || await dnsRecordCap(env);
    try {
        const count = await cf.countDnsRecords(env);
        const pct = alerts.dnsRecordPct(count, cap);
        const val = JSON.stringify({ count, cap, pct, error: null });
        try {
            await env.DB.prepare(`INSERT INTO watch_marks (key, since, value) VALUES ('dns-records', ?, ?)
                ON CONFLICT(key) DO UPDATE SET since=excluded.since, value=excluded.value`).bind(now, val).run();
        } catch (e) {
            console.error('[DNS_CAP_MARK]', e.message || e);
        }
        return { ok: true, count, cap, pct, checked_at: now };
    } catch (e) {
        const error = e.message || String(e);
        console.error('[DNS_CAP_COUNT]', error);
        try {
            const val = JSON.stringify({ count: null, cap, pct: null, error });
            await env.DB.prepare(`INSERT INTO watch_marks (key, since, value) VALUES ('dns-records', ?, ?)
                ON CONFLICT(key) DO UPDATE SET since=excluded.since, value=excluded.value`).bind(now, val).run();
        } catch { /* ignore */ }
        return { ok: false, error, count: null, cap, pct: null, checked_at: now };
    }
}

// The DNS record cap condition for the watch tick (watchOurServers), at most once per hour.
// Returns the condition object to update, or null if not due or the count failed.
export async function checkDnsRecordCap(env, now = Math.floor(Date.now() / 1000), { force = false } = {}) {
    if (!force) {
        try {
            const mark = await env.DB.prepare("SELECT since, value FROM watch_marks WHERE key='dns-records'").first();
            if (mark?.since && (now - mark.since) < DNS_RECORD_CHECK_CADENCE_S) {
                return null; // Not due: at most once per hour
            }
        } catch { /* proceed */ }
    }

    const res = await getOrCountDnsRecords(env, now, { force: true });
    if (!res.ok || res.count === null) {
        return null; // Failed count raises nothing
    }

    return alerts.dnsRecordCapCondition(env, { count: res.count, cap: res.cap });
}
