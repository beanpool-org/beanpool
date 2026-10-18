// The public status line (design scratch/global-node/DESIGN-global-mothership-fable.md §3.2 U4, slice A8; accepted by
// Marty 2026-10-18): at the end of each watch tick (src/watch.js) the Worker writes status.json to its STATUS KV
// namespace — for each server of ours that STATUS_SERVERS names, and for the registrar itself: whether it answered its
// last look, its last incident, and the share of its looks over the last 90 days it answered — and
// GET /api/registrar/status.json serves it to anyone. beanpool.org/status (apps/website/status.html) draws it.
// What it says is a name from STATUS_SERVERS, times, counts, and what an incident was, as a short code. Never a
// community's node or name (a watched server is published only when STATUS_SERVERS lists it; unset, only the
// registrar), never an address, an IP, a version or a key. No node reads it: it is for people.
//
// An incident is what the alert calls down (watch.js LOOKS_TO_RAISE: two failed looks in a row); it began at the first
// of them and ended at the first answer. The registrar's own line is its checks running, a tick every 5 minutes
// (WATCH_CRON): as many missed in a row are an incident, and its share is the ticks that ran of the slots since its
// first. The numbers come from D1 (watch_days, migration 0012), counted again from watch_log at every tick, so a tick
// that failed loses nothing: the next one catches up.
//
// D1: a watch tick already spends most of the 50 queries Workers Free allows one invocation (38 with our five servers,
// about 50 on a tick that raises or clears an alert), so this runs after the alerts and the daily line and spends 2 on a
// quiet tick; 1 more when an incident begins or ends, once on its first tick, and once a day to prune. On a tick past the
// budget what is refused is this, and status.json is one tick older. KV: one write a tick, 288 a day (Workers Free
// allows 1,000). With no STATUS binding nothing here runs and the GET answers 404.

export const STATUS_KEY = 'status.json';
export const STATUS_WINDOW_DAYS = 90;
export const STATUS_MAX_SERVERS = 6;           // the registrar and five more: status.json stays well under 2 KB
export const DAYS_KEPT = 100;
const SELF = '(registrar)';                    // the registrar's rows in watch_days: never a WATCH_TARGETS name ([a-z0-9-])
const SELF_NAME = 'registrar';                 // and its name in status.json
const TICK_S = 300;
const DAY_S = 86400;
const MARK = 'status:';
const SINCE = 'status:since';
const INCIDENT = 'status:incident:';

const dayOf = (s) => new Date(s * 1000).toISOString().slice(0, 10);
// The watch's ticks are at :02 and every 5 minutes after (WATCH_CRON): each in a slot of its own, however late within
// 2½ minutes it starts.
const slot = (s) => Math.floor((s + 30) / TICK_S);
// A share, never rounded up: 99.996% is 99.99, so a server that missed a look never reads 100.
const share = (ok, looks) => (looks > 0 ? Math.floor((Math.min(ok, looks) * 10000) / looks) / 100 : null);

// STATUS_SERVERS (wrangler.toml [vars]): the names, comma-separated, of the WATCH_TARGETS servers status.json shows, in
// that order. Only our own: a community's node is never listed. A name not watched is skipped; "registrar" is the
// registrar itself, always shown, last.
export function statusServers(env, targets) {
    const out = [];
    for (const name of String(env.STATUS_SERVERS ?? '').split(',').map((s) => s.trim().toLowerCase())) {
        const t = targets.find((x) => x.name === name);
        if (!t || name === SELF_NAME || out.includes(t)) continue;
        if (out.length >= STATUS_MAX_SERVERS - 1) break;
        out.push(t);
    }
    return out;
}

// What a failed look said (watch.js look(): 'HTTP 502', 'timed out', 'unreachable', 'not a BeanPool answer (HTTP 200)'),
// as a code the page puts in words; anything else is 'no-answer'.
export function whyCode(status) {
    const s = typeof status === 'string' ? status : '';
    if (s === 'timed out') return 'timed-out';
    if (s === 'unreachable') return 'unreachable';
    if (s === 'checks-missed') return 'checks-missed';
    if (/^not a BeanPool answer \(HTTP \d{3}\)$/.test(s)) return 'not-ours';
    const m = s.match(/^HTTP ([1-5]\d\d)$/);
    return m ? `http-${m[1]}` : 'no-answer';
}

function incidentFrom(row) {
    let v = {};
    try { v = JSON.parse(row?.value || '{}') || {}; } catch { /* the defaults below */ }
    return { began: Number(row?.since) || null, ended: Number.isSafeInteger(v.ended) ? v.ended : null, status: v.status };
}
const published = (i) => (i?.began ? { began_at: i.began, ended_at: i.ended, why: whyCode(i.status) } : null);

// One tick's status, after its looks are in watch_log. `recent`: per target name, its newest looks (newest first, this
// tick's first) and whether its down condition holds. Returns what it wrote, or null with no STATUS binding.
export async function writeStatus(env, { targets, recent, now, missedToRaise, keepS }) {
    if (!env.STATUS || typeof env.STATUS.put !== 'function') return null;
    const shown = statusServers(env, targets);
    // The registrar's ticks are counted on the servers shown and the first watched (each tick looks at every one).
    const counted = JSON.stringify([...new Set([targets[0]?.name, ...shown.map((t) => t.name)].filter(Boolean))]);
    const today0 = now - (now % DAY_S);
    const fromS = today0 - keepS + DAY_S;      // watch_log's oldest whole day
    const windowS = today0 - (STATUS_WINDOW_DAYS - 1) * DAY_S;

    // Each day from the newest counted (today, but for the first tick of a day or after a gap), counted again: a
    // server's looks and answers, and the registrar's ticks.
    await env.DB.prepare(`WITH looked AS (SELECT target, ran_at, ok, date(ran_at, 'unixepoch') AS day FROM watch_log
            WHERE ran_at >= MAX(?, COALESCE((SELECT CAST(strftime('%s', MAX(day)) AS INTEGER) FROM watch_days WHERE target = '${SELF}'), 0))
            AND target IN (SELECT value FROM json_each(?)))
        INSERT INTO watch_days (target, day, looks, ok)
        SELECT target, day, COUNT(*), SUM(ok) FROM looked WHERE true GROUP BY target, day
        UNION ALL SELECT '${SELF}', day, COUNT(DISTINCT ran_at), COUNT(DISTINCT ran_at) FROM looked WHERE true GROUP BY day
        ON CONFLICT (target, day) DO UPDATE SET looks = excluded.looks, ok = excluded.ok`).bind(fromS, counted).run();

    // The 90 days of the servers shown and the registrar, the marks, and watch_log's first look: one read.
    const read = (await env.DB.prepare(`SELECT 'day' AS kind, target AS k, SUM(looks) AS a, SUM(ok) AS b, MIN(day) AS c FROM watch_days
            WHERE day >= ? AND target IN (SELECT value FROM json_each(?)) GROUP BY target
        UNION ALL SELECT 'mark', key, since, NULL, value FROM watch_marks WHERE key >= '${MARK}' AND key < 'status;'
        UNION ALL SELECT 'first', NULL, MIN(ran_at), NULL, NULL FROM watch_log`)
        .bind(dayOf(windowS), JSON.stringify([SELF, ...shown.map((t) => t.name)])).all()).results || [];
    const days = new Map();
    const marks = new Map();
    let since = null, first = null;
    for (const r of read) {
        if (r.kind === 'day') days.set(r.k, { looks: Number(r.a) || 0, ok: Number(r.b) || 0, first: r.c });
        else if (r.kind === 'mark' && r.k === SINCE) since = Number(r.a) || null;
        else if (r.kind === 'mark' && r.k.startsWith(INCIDENT)) marks.set(r.k.slice(INCIDENT.length), incidentFrom({ since: r.a, value: r.c }));
        else if (r.kind === 'first') first = Number(r.a) || null;
    }
    // The registrar's line starts at its first tick counted. With that mark, once: the last incident already in
    // watch_log of each server shown (its last run of missedToRaise failed looks or more, from the first of them to the
    // next answer) and of the registrar (its last missedToRaise slots or more with no tick), by the rules below, so an
    // outage the share counts is named too, never "no incident since" over it. One statement: refused, the next tick
    // tries it again.
    if (!since && first) {
        since = Math.max(first, fromS);
        const seeded = (await env.DB.prepare(`WITH looked AS (SELECT id, target, ok, SUM(ok) OVER (PARTITION BY target ORDER BY id) AS n
                    FROM watch_log WHERE target IN (SELECT value FROM json_each(?))),
                runs AS (SELECT target, MIN(id) AS id, COUNT(*) AS failed FROM looked WHERE ok = 0 GROUP BY target, n),
                last AS (SELECT target, MAX(id) AS id FROM runs WHERE failed >= ? GROUP BY target),
                ticks AS (SELECT ran_at, LAG(ran_at) OVER (ORDER BY ran_at) AS prev FROM (SELECT DISTINCT ran_at FROM watch_log))
            INSERT INTO watch_marks (key, since, value)
            SELECT ?, ?, NULL WHERE true
            UNION ALL SELECT '${INCIDENT}' || l.target, w.ran_at, json_object('ended',
                    (SELECT MIN(ran_at) FROM watch_log WHERE target = l.target AND ok = 1 AND id > l.id), 'status', w.status)
                FROM last l JOIN watch_log w ON w.id = l.id WHERE true
            UNION ALL SELECT * FROM (SELECT '${INCIDENT}${SELF_NAME}', prev + ${TICK_S}, json_object('ended', ran_at, 'status', 'checks-missed')
                FROM ticks WHERE (ran_at + 30) / ${TICK_S} - (prev + 30) / ${TICK_S} - 1 >= ? ORDER BY ran_at DESC LIMIT 1) WHERE true
            ON CONFLICT (key) DO UPDATE SET since = excluded.since, value = excluded.value WHERE key <> '${SINCE}'
            RETURNING key, since, value`)
            .bind(JSON.stringify(shown.map((t) => t.name)), missedToRaise, SINCE, since, missedToRaise).all()).results || [];
        for (const r of seeded) if (r.key.startsWith(INCIDENT)) marks.set(r.key.slice(INCIDENT.length), incidentFrom(r));
    }

    // The registrar: ticks missed since the one before (the newest look before this tick's, of any server).
    const prev = Math.max(0, ...[...recent.values()].map((l) => (l.rows?.[0]?.ran_at === now ? l.rows[1]?.ran_at ?? 0 : 0)));
    if (prev && since && prev >= since && slot(now) - slot(prev) - 1 >= missedToRaise) {
        const i = { began: prev + TICK_S, ended: now, status: 'checks-missed' };
        await env.DB.prepare(`INSERT INTO watch_marks (key, since, value) VALUES (?, ?, ?)
            ON CONFLICT (key) DO UPDATE SET since = excluded.since, value = excluded.value`)
            .bind(`${INCIDENT}${SELF_NAME}`, i.began, JSON.stringify({ ended: i.ended, status: i.status })).run();
        marks.set(SELF_NAME, i);
    }

    // A server shown: an incident begins when it is down (from its first failed look since it last answered) and ends
    // at its first answer after: either of its two newest looks, so an answer on a tick whose status write was refused
    // still ends it when the next look fails.
    for (const t of shown) {
        const l = recent.get(t.name);
        if (!l) continue;
        const open = marks.get(t.name)?.began && marks.get(t.name).ended === null;
        let row = null;
        if (l.down && !open) {
            row = await env.DB.prepare(`INSERT INTO watch_marks (key, since, value)
                SELECT ?, ran_at, json_object('ended', NULL, 'status', status) FROM watch_log
                WHERE target = ? AND id > COALESCE((SELECT MAX(id) FROM watch_log WHERE target = ? AND ok = 1), 0) ORDER BY id LIMIT 1
                ON CONFLICT (key) DO UPDATE SET since = excluded.since, value = excluded.value RETURNING since, value`)
                .bind(`${INCIDENT}${t.name}`, t.name, t.name).first();
        } else if (open && l.rows?.some((r) => r.ok)) {
            row = await env.DB.prepare(`UPDATE watch_marks SET value = json_object('ended',
                    COALESCE((SELECT MIN(ran_at) FROM watch_log WHERE target = ? AND ok = 1 AND ran_at > watch_marks.since), ?),
                    'status', json_extract(value, '$.status'))
                WHERE key = ? RETURNING since, value`).bind(t.name, now, `${INCIDENT}${t.name}`).first();
        }
        if (row) marks.set(t.name, incidentFrom(row));
    }

    const servers = shown.map((t) => {
        const last = recent.get(t.name)?.rows?.[0];
        const d = days.get(t.name);
        return {
            name: t.name, up: last?.ran_at === now ? !!last.ok : null, checked_at: last?.ran_at ?? null,
            looks: d?.looks ?? 0, answered: d?.ok ?? 0, percent: share(d?.ok ?? 0, d?.looks ?? 0), since: d?.first ?? null,
            incident: published(marks.get(t.name)),
        };
    });
    const start = Math.max(windowS, since ?? now);
    const slots = slot(now) - slot(start) + 1;
    const ticks = days.get(SELF)?.looks ?? 0;
    servers.push({
        name: SELF_NAME, up: true, checked_at: now, looks: slots, answered: Math.min(ticks, slots), percent: share(ticks, slots),
        since: dayOf(start), incident: published(marks.get(SELF_NAME)),
    });
    const doc = { v: 1, at: now, every_s: TICK_S, window_days: STATUS_WINDOW_DAYS, servers };
    await env.STATUS.put(STATUS_KEY, JSON.stringify(doc));

    // Once a day, at its first tick: days past what is kept go.
    if (now - today0 < TICK_S) await env.DB.prepare('DELETE FROM watch_days WHERE day < ?').bind(dayOf(today0 - DAYS_KEPT * DAY_S)).run();
    return doc;
}

// GET /api/registrar/status.json: what the last tick wrote, as it wrote it, to anyone (the website reads it from the
// visitor's browser). A minute in the browser's cache and KV's own: it changes every 5 minutes.
export async function handleStatusJson(env) {
    const headers = {
        'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60',
        'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff',
    };
    const text = env.STATUS && typeof env.STATUS.get === 'function' ? await env.STATUS.get(STATUS_KEY, { cacheTtl: 60 }) : null;
    if (!text) return new Response(JSON.stringify({ error: 'no status is published here' }), { status: 404, headers });
    return new Response(text, { headers });
}
