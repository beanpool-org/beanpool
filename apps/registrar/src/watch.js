// The control room's outside checks (design scratch/global-node/DESIGN-alerts-fable.md §2.3, slice S2; decided by Marty
// 2026-10-10): every 5 minutes, beside the sweep, the Worker looks at our servers from outside — never from the server
// it watches — and tells the admin's phone through the alert book (src/alerts.js) what it sees:
//   - a server that does not answer 2xx two looks in a row (15 s each, a redirect is not followed): urgent, cleared at
//     its first 2xx;
//   - the vault answering locked two looks in a row: urgent;
//   - the vault's daily signed report, believed only under the ticket public key the apps pin (VAULT_TICKET_KEYS): one
//     that is missing, not signed by that key ("unverifiable"), unreadable or not from now ("stale") two looks in a
//     row, or one that says backups or the off-box copy are failing: high. With no key set the report is "not
//     checked" — never "fine";
//   - a release that changed since the last look (default; the vault's high), told once;
//   - a node's host watchdog restarting it (its health's watchdog.recoveries rose), told once: high;
//   - our nodes running different releases for over a day: told then and daily while it lasts;
//   - at 08:00 Brisbane (UTC+10 all year: Queensland keeps no daylight saving) one quiet line with how they all are and
//     the events the digest held since the last one. Its absence is the sign the Worker or ntfy is broken.
// This reproduces the Mac vault watcher's checks (apps/vault/custodian/watch.ts), so it can be retired after a week of
// agreeing (§2.5). What it reads is public and unauthenticated; what it says is a server's name, what it answers and
// what it runs. Each look is a row in watch_log (migration 0009), kept 30 days; /admin's "Our servers" reads it.

import * as alerts from './alerts.js';
import * as db from './db.js';
import { verifyEd25519 } from './sign.js';

export const WATCH_TIMEOUT_MS = 15_000;
export const LOOKS_TO_RAISE = 2;               // two failed looks in a row (5 min apart) before anything is said
export const FLEET_DIFFERS_S = 24 * 3600;
export const DAILY_HOUR = 8;                   // 08:00 Brisbane
export const BRISBANE_UTC_OFFSET_S = 10 * 3600;
const KEEP_S = 30 * 86400;
const MAX_TARGETS = 20;
const REPORT_TAG = 'beanpool-vault-report/1\n';
const REPORT_SKEW_MS = 10 * 60 * 1000;         // a report signed further than this from now is a replay or a wrong clock
const BACKUP_STALE_MS = 2 * 3600 * 1000 + 10 * 60 * 1000;
const BAD_REPORTS = ['missing', 'unverifiable', 'unreadable', 'stale'];

const nowS = () => Math.floor(Date.now() / 1000);
const when = (s) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
// What a server says it runs goes into a message: printable ASCII, short.
const word = (v, n = 64) => (typeof v === 'string' && v.trim() ? v.trim().replace(/[^\x20-\x7e]/g, '?').slice(0, n) : null);
const short = (c) => (c ? c.slice(0, 7) : null);
const runs = (version, commit) => (version ? `${version}${commit ? ` (${short(commit)})` : ''}` : commit ? short(commit) : 'unknown');
const hostOf = (t) => new URL(t.url).host;

// WATCH_TARGETS (wrangler.toml [vars]): a JSON list of { name, url, kind } — kind "vault" for the key vault, anything
// else a node. Public facts only. An entry that isn't a name and an http(s) address is skipped and logged.
export function watchTargets(env) {
    let raw = env.WATCH_TARGETS;
    if (raw === undefined || raw === null || raw === '') return [];
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { console.error('[WATCH]', 'WATCH_TARGETS is not JSON: nothing is watched'); return []; }
    }
    if (!Array.isArray(raw)) { console.error('[WATCH]', 'WATCH_TARGETS is not a list: nothing is watched'); return []; }
    const out = [];
    for (const t of raw) {
        let url = null;
        try { url = new URL(t?.url); } catch { /* skipped below */ }
        const name = typeof t?.name === 'string' ? t.name : '';
        if (!/^[a-z0-9-]{1,32}$/.test(name) || !url || !['https:', 'http:'].includes(url.protocol) || out.some((o) => o.name === name)) {
            console.error('[WATCH]', `WATCH_TARGETS: skipped an entry that is not a name and an http(s) address: ${JSON.stringify(t).slice(0, 120)}`);
            continue;
        }
        if (out.length >= MAX_TARGETS) { console.error('[WATCH]', `WATCH_TARGETS: only the first ${MAX_TARGETS} are watched`); break; }
        out.push({ name, url: `${url.origin}${url.pathname.replace(/\/+$/, '')}`, kind: t.kind === 'vault' ? 'vault' : 'node' });
    }
    return out;
}

// The vault's ticket public key(s), as the apps pin them: 64 hex each, comma-separated, newest first, two at most.
export function ticketKeys(env) {
    const raw = typeof env.VAULT_TICKET_KEYS === 'string' ? env.VAULT_TICKET_KEYS : '';
    return raw.split(',').map((k) => k.trim().toLowerCase()).filter((k) => /^[0-9a-f]{64}$/.test(k)).slice(0, 2);
}

// One GET, as the design says: 15 s, a redirect is never followed (a 3xx is a failed look like any other non-2xx).
// Never throws; what it reports is a status, and the body as JSON when it is.
async function look(url) {
    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            headers: { accept: 'application/json', 'user-agent': 'beanpool-registrar-watch' },
            redirect: 'manual', signal: AbortSignal.timeout(WATCH_TIMEOUT_MS),
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch { /* not JSON: body stays null */ }
        return { ok: res.status >= 200 && res.status < 300, status: `HTTP ${res.status}`, body, ms: Date.now() - t0 };
    } catch (e) {
        return { ok: false, status: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'unreachable', body: null, ms: Date.now() - t0 };
    }
}

// A node: /api/version (version, commit) and /api/community/health (its host watchdog). It answers if either does.
async function lookAtNode(t) {
    const [v, h] = await Promise.all([look(`${t.url}/api/version`), look(`${t.url}/api/community/health`)]);
    const answered = v.ok ? v : h.ok ? h : v;
    const rec = h.ok ? h.body?.watchdog?.recoveries : undefined;
    return {
        ok: v.ok || h.ok, ms: answered.ms, status: answered.status,
        version: word(v.ok ? v.body?.version : null) ?? word(h.ok ? h.body?.version : null),
        commit: word(v.ok ? v.body?.commit : null),
        recoveries: Number.isSafeInteger(rec) && rec >= 0 ? rec : null,
    };
}

const b64urlToHex = (s) => {
    if (typeof s !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return null;
    try {
        const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '').padEnd(Math.ceil(s.replace(/=+$/, '').length / 4) * 4, '='));
        return Array.from(bin, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
    } catch { return null; }
};

// Is this the vault's report, signed by a pinned ticket key, and from now? Its contents, or the verdict and why not.
// WebCrypto's Ed25519 is RFC 8032's strict verify (zip215 false: a non-canonical point or scalar is refused).
export async function checkReport(body, keys, nowMs) {
    const r = body?.report;
    if (!r || typeof r.text !== 'string' || typeof r.signature !== 'string') return { verdict: 'missing', why: 'it gives no signed report' };
    const sig = b64urlToHex(r.signature);
    let good = false;
    for (const k of keys) if (sig && await verifyEd25519(k, `${REPORT_TAG}${r.text}`, sig)) { good = true; break; }
    if (!good) return { verdict: 'unverifiable', why: "its report is not signed by the vault's ticket key" };
    let report;
    try { report = JSON.parse(r.text); } catch { return { verdict: 'unreadable', why: 'its signed report is not readable' }; }
    if (!report || typeof report !== 'object') return { verdict: 'unreadable', why: 'its signed report is not readable' };
    if (typeof report.at !== 'number' || !Number.isFinite(report.at) || Math.abs(nowMs - report.at) > REPORT_SKEW_MS) {
        const at = typeof report.at === 'number' && Number.isFinite(report.at) ? `${new Date(report.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'no time';
        return { verdict: 'stale', why: `its signed report is from ${at}, not now (a replay, or its clock is wrong)` };
    }
    return { verdict: 'fine', report };
}

// What a verified report says of backups and the off-box copy, as the vault's own check and the Mac watcher read it: a
// backup older than 2 h 10 min (counted from the later of when it opened and the newest), or what it raised itself.
function backupsFrom(report, nowMs) {
    const relayed = new Set(Array.isArray(report?.alerts?.active) ? report.alerts.active : []);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const openedAt = num(report.openSince) ?? nowMs - (num(report.uptimeSeconds) ?? 0) * 1000;
    const lastBackup = num(report.backups?.lastOkAt);
    const off = report.offsite && typeof report.offsite === 'object' ? report.offsite : null;
    const at = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown');
    const inARow = (v) => (Number.isSafeInteger(v) ? v : 0);
    return {
        reportRelayed: relayed.has('report'),
        backupBad: relayed.has('backup') || nowMs - Math.max(openedAt, lastBackup ?? 0) > BACKUP_STALE_MS,
        backupWhy: `${inARow(report.backups?.failuresInARow)} failed in a row; the newest at ${at(lastBackup)}`,
        offsiteBad: relayed.has('offsite') || (!!off && nowMs - Math.max(openedAt, num(off.lastOkAt) ?? 0) > BACKUP_STALE_MS),
        offsiteWhy: `${inARow(off?.failuresInARow)} failed in a row; the newest at ${at(num(off?.lastOkAt))}`,
    };
}

// The vault: /v1/health ({ state, release, since }) and, when it answers open, /v1/report.
async function lookAtVault(env, t, nowMs) {
    const h = await look(`${t.url}/v1/health`);
    const out = { ok: h.ok, ms: h.ms, status: h.status, version: null, commit: null, state: null, report: null, recoveries: null };
    if (!h.ok) return out;
    out.state = h.body?.state === 'open' ? 'open' : 'locked';   // anything but open is locked, as watch.ts reads it
    out.version = word(h.body?.release);
    if (out.state !== 'open') return out;
    const keys = ticketKeys(env);
    if (!keys.length) { out.report = 'not checked'; return out; }
    const r = await look(`${t.url}/v1/report`);
    if (!r.ok) { out.report = 'missing'; out.reportWhy = `its report answers ${r.status}`; return out; }
    const c = await checkReport(r.body, keys, nowMs);
    out.report = c.verdict;
    out.reportWhy = c.why;
    if (c.report) out.backups = backupsFrom(c.report, nowMs);
    return out;
}

// --- The conditions and events, from what was seen ---

const key = (t, what) => `watch:${t.name}:${what}`;
const lastLooks = async (env, t, n) => (await env.DB.prepare('SELECT * FROM watch_log WHERE target=? ORDER BY id DESC LIMIT ?').bind(t.name, n).all()).results || [];
const allOf = (rows, test) => rows.length >= LOOKS_TO_RAISE && rows.every(test);

function down(t, rows, seen) {
    const active = allOf(rows, (r) => !r.ok);
    return {
        key: key(t, 'down'), category: 'health', priority: alerts.PRIORITY.urgent, tag: 'red_circle', title: `${t.name} down`, active,
        detail: active
            ? `${t.name} (${hostOf(t)}) does not answer from outside: ${seen.status}, ${rows.length} looks in a row 5 minutes apart.`
            : `${t.name} (${hostOf(t)}) answers again${seen.ok ? ` (${seen.status})` : ''}.`,
    };
}
function locked(t, rows) {
    const active = allOf(rows, (r) => r.ok && r.state === 'locked');
    return {
        key: key(t, 'locked'), category: 'health', priority: alerts.PRIORITY.urgent, tag: 'red_circle', title: `${t.name} locked`, active,
        detail: active
            ? `${t.name} (${hostOf(t)}) answers locked, ${rows.length} looks in a row: deposits and restores wait until two custodians unlock it.`
            : `${t.name} (${hostOf(t)}) answers open again.`,
    };
}
// Only when the vault answers open is anything known of its report: locked or gone, what was raised stays raised.
function reportConditions(t, rows, seen) {
    const bad = allOf(rows, (r) => BAD_REPORTS.includes(r.report));
    const b = seen.backups;
    const reportActive = bad || !!b?.reportRelayed;
    const c = [{
        key: key(t, 'report'), category: 'health', priority: alerts.PRIORITY.high, tag: 'warning', title: `${t.name} report`, active: reportActive,
        detail: bad ? `${t.name}: report ${seen.report} — ${seen.reportWhy}, ${rows.length} looks in a row.`
            : b?.reportRelayed ? `${t.name}: its own signed report says a day's report was not made.`
                : `${t.name}: its report is signed by the ticket key and from now again.`,
    }];
    // Backups and the off-box copy are known only from a report that verified.
    if (b) {
        c.push({
            key: key(t, 'backups'), category: 'health', priority: alerts.PRIORITY.high, tag: 'warning', title: `${t.name} backups`, active: b.backupBad,
            detail: b.backupBad ? `${t.name}: its signed report says backups are failing (${b.backupWhy}).` : `${t.name}: its signed report says backups work again.`,
        }, {
            key: key(t, 'offsite'), category: 'health', priority: alerts.PRIORITY.high, tag: 'warning', title: `${t.name} off-box copy`, active: b.offsiteBad,
            detail: b.offsiteBad ? `${t.name}: its signed report says the off-box copy is failing (${b.offsiteWhy}).` : `${t.name}: its signed report says backups go off the box again.`,
        });
    }
    return c;
}

// The newest look before `id` that said what it runs, or its watchdog's count.
const before = (env, t, id, col) => env.DB.prepare(`SELECT id, ${col === 'version' ? 'version, commit_sha' : col} FROM watch_log
    WHERE target=? AND id < ? AND ${col} IS NOT NULL ORDER BY id DESC LIMIT 1`).bind(t.name, id).first();

async function oneShots(env, t, id, seen) {
    if (seen.version) {
        const prev = await before(env, t, id, 'version');
        if (prev && (prev.version !== seen.version || (prev.commit_sha || null) !== (seen.commit || null))) {
            const vault = t.kind === 'vault';
            await alerts.notify(env, {
                category: 'health', priority: vault ? alerts.PRIORITY.high : alerts.PRIORITY.default, tag: vault ? 'warning' : 'seedling',
                name: null, once: `release:${t.name}:${prev.id}`,
                title: `${t.name} now runs ${runs(seen.version, seen.commit)}`,
                body: `Release changed: ${t.name} now runs ${runs(seen.version, seen.commit)}, was ${runs(prev.version, prev.commit_sha)}.${vault
                    ? ' A vault release needs its custodians: check it was planned.' : ''}`,
            });
        }
    }
    if (seen.recoveries !== null && seen.recoveries !== undefined) {
        const prev = await before(env, t, id, 'recoveries');
        if (prev && seen.recoveries > prev.recoveries) {
            await alerts.notify(env, {
                category: 'health', priority: alerts.PRIORITY.high, tag: 'warning', name: null, once: `watchdog:${t.name}:${id}`,
                title: `${t.name} restarted by its watchdog`,
                body: `Watchdog: ${t.name}'s host watchdog restarted it (${prev.recoveries} → ${seen.recoveries} recoveries): the node hung. Its freeze report is in the server's log.`,
            });
        }
    }
}

// Our nodes (not the vault) running different versions: since when is a mark; over a day it is told, and daily after.
async function fleetCondition(env, targets, now) {
    const nodes = targets.filter((t) => t.kind === 'node');
    const known = [];
    for (const t of nodes) {
        const r = await env.DB.prepare('SELECT version, commit_sha FROM watch_log WHERE target=? AND version IS NOT NULL ORDER BY id DESC LIMIT 1').bind(t.name).first();
        if (r) known.push({ name: t.name, version: r.version, commit: r.commit_sha });
    }
    const differ = new Set(known.map((k) => k.version)).size > 1;
    if (differ) await env.DB.prepare("INSERT OR IGNORE INTO watch_marks (key, since) VALUES ('fleet-differs', ?)").bind(now).run();
    else await env.DB.prepare("DELETE FROM watch_marks WHERE key='fleet-differs'").run();
    const mark = differ ? await env.DB.prepare("SELECT since FROM watch_marks WHERE key='fleet-differs'").first() : null;
    const active = !!mark && now - mark.since >= FLEET_DIFFERS_S;
    return {
        key: 'watch-fleet', category: 'health', priority: alerts.PRIORITY.default, tag: 'warning', title: 'Our nodes run different releases', active,
        detail: active
            ? `Our nodes run different releases, since ${when(mark.since)}: ${known.map((k) => `${k.name} ${runs(k.version, k.commit)}`).join(' · ')}.`
            : `Our nodes run one release again${known.length ? `: ${runs(known[0].version, null)}` : ''}.`,
    };
}

// A condition of a server no longer in WATCH_TARGETS ends: it is told cleared once, never left raised forever.
async function unwatched(env, targets) {
    const names = new Set(targets.map((t) => t.name));
    const rows = (await env.DB.prepare("SELECT key, last_seen_json FROM alert_state WHERE key LIKE 'watch:%'").all()).results || [];
    return rows.filter((r) => !names.has(r.key.split(':')[1])).map((r) => {
        let seen = {};
        try { seen = JSON.parse(r.last_seen_json || '{}'); } catch { /* the defaults below */ }
        return { key: r.key, category: 'health', priority: seen.priority || alerts.PRIORITY.default, tag: 'warning', title: seen.title || r.key, active: false,
            detail: `${r.key.split(':')[1]} is no longer watched (WATCH_TARGETS).` };
    });
}

// --- The daily line ---

export const brisbaneDay = (s) => new Date((s + BRISBANE_UTC_OFFSET_S) * 1000).toISOString().slice(0, 10);
const brisbaneHour = (s) => new Date((s + BRISBANE_UTC_OFFSET_S) * 1000).getUTCHours();

// Once per Brisbane day, from 08:00: how our servers are, the names, what is raised, and every event the digest held
// since the last one (they are then marked sent: their words are in this line). A conditional write decides which
// tick sends it.
export async function dailyLine(env, targets, now) {
    if (brisbaneHour(now) < DAILY_HOUR) return false;
    const day = brisbaneDay(now);
    const w = await env.DB.prepare(`INSERT INTO watch_marks (key, value) VALUES ('daily', ?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE watch_marks.value IS NOT excluded.value`).bind(day).run();
    if (!w?.meta?.changes) return false;

    const last = [];
    for (const t of targets) last.push({ t, r: (await lastLooks(env, t, 1))[0] || null });
    const up = last.filter((x) => x.r?.ok).length;
    const lines = [`Our servers: ${up} of ${targets.length} answer.`];
    const nodes = last.filter((x) => x.t.kind === 'node');
    if (nodes.length) lines.push(nodes.map(({ t, r }) => `${t.name} ${!r ? 'not looked at yet' : r.ok ? runs(r.version, r.commit_sha) : `down (${r.status})`}`).join(' · '));
    for (const { t, r } of last.filter((x) => x.t.kind === 'vault')) {
        lines.push(!r ? `${t.name}: not looked at yet.`
            : !r.ok ? `${t.name}: down (${r.status}).`
                : `${t.name}: ${r.state}${r.version ? `, release ${r.version.slice(0, 12)}` : ''}${r.state === 'open' ? `, report ${r.report === 'not checked' ? 'not checked (VAULT_TICKET_KEYS is not set)' : r.report}` : ''}.`);
    }
    const live = await db.countLive(env);
    const waiting = await db.countAwaitingApproval(env);
    lines.push(`${live} ${live === 1 ? 'name' : 'names'} live${waiting ? `, ${waiting} waiting for your approval` : ''}.`);
    const raised = (await env.DB.prepare('SELECT key, detail FROM alert_state ORDER BY since').all()).results || [];
    lines.push(raised.length ? `Raised now (${raised.length}): ${raised.map((r) => r.detail).join(' | ')}` : 'Nothing raised.');
    const held = (await env.DB.prepare('SELECT id, at, body FROM alert_outbox WHERE held=1 AND sent_at IS NULL ORDER BY id').all()).results || [];
    if (held.length) {
        lines.push(`Held for this summary (${held.length}):`);
        for (const h of held) lines.push(`- ${when(h.at)}: ${h.body}`);
    }
    await alerts.enqueueEvent(env, {
        category: 'summary', priority: alerts.PRIORITY.min, tag: 'bar_chart', name: null,
        title: `Daily: ${up} of ${targets.length} servers answer, ${live} ${live === 1 ? 'name' : 'names'} live${held.length ? `, ${held.length} held` : ''}`,
        body: alerts.listBody(lines),
    });
    // Their words are in the line now: sent with it (/admin shows them as in the daily summary).
    if (held.length) await env.DB.prepare('UPDATE alert_outbox SET sent_at=? WHERE held=1 AND sent_at IS NULL AND id <= ?').bind(now, held[held.length - 1].id).run();
    if (typeof env.waitUntil === 'function') env.waitUntil(alerts.flush(env));
    else await alerts.flush(env);
    return true;
}

// --- The tick ---

// Every 5 minutes, beside the sweep (index.js scheduled). Never throws: a failure is logged, and the sweep is not
// touched. Returns what each target answered (for tests and the workerd probe).
export async function watchOurServers(env) {
    try {
        const targets = watchTargets(env);
        if (!targets.length) {
            // Nothing to watch (WATCH_TARGETS unset): no looks and no daily line; what was raised before ends.
            const ended = await unwatched(env, targets);
            if (ended.length) await alerts.updateConditions(env, ended);
            return [];
        }
        const now = nowS();
        const nowMs = now * 1000;
        const seen = await Promise.all(targets.map((t) => (t.kind === 'vault' ? lookAtVault(env, t, nowMs) : lookAtNode(t))
            .catch(() => ({ ok: false, status: 'unreachable', ms: null }))));
        const conditions = [];
        for (let i = 0; i < targets.length; i++) {
            const t = targets[i], s = seen[i];
            try {
                const row = await env.DB.prepare(`INSERT INTO watch_log (ran_at, target, ok, ms, status, version, commit_sha, state, report, recoveries)
                    VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`)
                    .bind(now, t.name, s.ok ? 1 : 0, s.ms ?? null, s.status, s.version ?? null, s.commit ?? null, s.state ?? null, s.report ?? null, s.recoveries ?? null).first();
                const rows = await lastLooks(env, t, LOOKS_TO_RAISE);
                conditions.push(down(t, rows, s));
                if (t.kind === 'vault' && s.ok) {
                    conditions.push(locked(t, rows));
                    if (s.state === 'open' && s.report !== 'not checked') conditions.push(...reportConditions(t, rows, s));
                }
                await oneShots(env, t, row.id, s);
            } catch (e) { console.error('[WATCH]', t.name, String(e?.message || e).slice(0, 200)); }
        }
        try { conditions.push(await fleetCondition(env, targets, now)); } catch (e) { console.error('[WATCH]', 'fleet', String(e?.message || e).slice(0, 200)); }
        try { conditions.push(...await unwatched(env, targets)); } catch (e) { console.error('[WATCH]', 'unwatched', String(e?.message || e).slice(0, 200)); }
        await alerts.updateConditions(env, conditions);
        try { await dailyLine(env, targets, now); } catch (e) { console.error('[WATCH]', 'daily', String(e?.message || e).slice(0, 200)); }
        try { await env.DB.prepare('DELETE FROM watch_log WHERE ran_at < ?').bind(now - KEEP_S).run(); } catch (e) { console.error('[WATCH]', 'prune', String(e?.message || e).slice(0, 200)); }
        console.log(`[WATCH] ${targets.map((t, i) => `${t.name}=${seen[i].ok ? 'up' : seen[i].status}`).join(' ')}`);
        return targets.map((t, i) => ({ name: t.name, ...seen[i] }));
    } catch (e) {
        console.error('[WATCH]', String(e?.message || e).slice(0, 200));
        return [];
    }
}

// What /admin's "Our servers" panel shows: per target its newest look, its last answer, and its last day in looks.
export async function serversStatus(env) {
    const targets = watchTargets(env);
    const now = nowS();
    const out = [];
    for (const t of targets) {
        const last = (await lastLooks(env, t, 1))[0] || null;
        const lastOk = await env.DB.prepare('SELECT ran_at FROM watch_log WHERE target=? AND ok=1 ORDER BY id DESC LIMIT 1').bind(t.name).first();
        const day = await env.DB.prepare('SELECT COUNT(*) AS looks, COALESCE(SUM(ok), 0) AS ok FROM watch_log WHERE target=? AND ran_at >= ?').bind(t.name, now - 86400).first();
        out.push({
            name: t.name, url: t.url, kind: t.kind, last_ok_at: lastOk?.ran_at ?? null, day: { looks: Number(day?.looks) || 0, ok: Number(day?.ok) || 0 },
            last: last && { ran_at: last.ran_at, ok: !!last.ok, ms: last.ms, status: last.status, version: last.version, commit: last.commit_sha, state: last.state, report: last.report, recoveries: last.recoveries },
        });
    }
    const fleet = await env.DB.prepare("SELECT since FROM watch_marks WHERE key='fleet-differs'").first();
    const daily = await env.DB.prepare("SELECT value FROM watch_marks WHERE key='daily'").first();
    return { targets: out, ticket_key_set: ticketKeys(env).length > 0, fleet_differs_since: fleet?.since ?? null, daily_sent_for: daily?.value ?? null };
}
