import * as alerts from './alerts.js';
import * as cf from './cf.js';

export const DEFAULT_DNS_RECORD_CAP = 200;
export const DEFAULT_DNS_RECORD_ALERT_PCT = 80;
export const DNS_RECORD_CHECK_CADENCE_S = 3600; // at most once per hour

export function dnsRecordCap(env) {
    const n = Number(env?.DNS_RECORD_CAP);
    return Number.isSafeInteger(n) && n > 0 ? n : DEFAULT_DNS_RECORD_CAP;
}

export function dnsRecordAlertPct(env) {
    const n = Number(env?.DNS_RECORD_ALERT_PCT);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_DNS_RECORD_ALERT_PCT;
}

// Read the cached DNS record count from watch_marks (if within 1 hour).
// If missing, expired, or force=true: call Cloudflare, update watch_marks.
// Never throws: on failure returns { ok: false, error: '...', count: null, cap, pct: null }
export async function getOrCountDnsRecords(env, now = Math.floor(Date.now() / 1000), { force = false } = {}) {
    const cap = dnsRecordCap(env);
    if (!force) {
        try {
            const mark = await env.DB.prepare("SELECT since, value FROM watch_marks WHERE key='dns-records'").first();
            if (mark?.value && mark.since && (now - mark.since) < DNS_RECORD_CHECK_CADENCE_S) {
                const parsed = JSON.parse(mark.value);
                if (parsed.count !== null && parsed.count !== undefined) {
                    return { ok: true, count: parsed.count, cap: parsed.cap || cap, pct: parsed.pct, checked_at: mark.since };
                }
                if (parsed.error) {
                    return { ok: false, error: parsed.error, count: null, cap: parsed.cap || cap, pct: null, checked_at: mark.since };
                }
            }
        } catch { /* ignore D1 error */ }
    }

    try {
        const count = await cf.countDnsRecords(env);
        const pct = Math.round((count / cap) * 100);
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

// Evaluate DNS record cap condition for the attest sweep (at most once per hour).
// Returns the condition object to update, or null if not due or count failed.
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

    const alertPct = dnsRecordAlertPct(env);
    return alerts.dnsRecordCapCondition(env, { count: res.count, cap: res.cap, alertPct });
}
