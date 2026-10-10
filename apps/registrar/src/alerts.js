// The control room's alerts: the registrar tells its admin's phone, through one ntfy topic, what only the registrar
// knows (design scratch/global-node/DESIGN-alerts-fable.md §2, slice S1; decided by Marty 2026-10-10). A port of the
// vault's alert book (apps/vault/src/api/alerts.ts) with its state in D1 (migration 0008), since a Worker keeps nothing
// between requests:
//   - an event (a name request, a new community, a pause, an admin action) is told once (notify);
//   - a condition (a suspended sweep, deletions Cloudflare keeps refusing) is told once when it starts ('raised'), again
//     every 24 h while it lasts ('still'), and once when it ends ('cleared') (updateConditions);
//   - what is not yet told waits in alert_outbox. A send that fails is tried again every 5 minutes (the cron runs flush),
//     with everything waiting — at most 50; older ones are dropped and counted — in one message;
//   - with no NTFY_URL set nothing is sent: the events wait for the first channel that is, and /admin says so;
//   - at most 20 messages an hour: past them, a message with nothing high or urgent in it is muted — the first is one
//     line, "muted: N more this hour, see /admin", the rest of that hour is kept for /admin only. High and urgent ones
//     still go, up to 40 messages in the hour, so a loop can't flood the phone. A condition whose telling was muted is
//     told again in the next hour.
// Each category (names, health, uptake, admin) is on (sent at once), digest (held, and sent in the daily summary at
// 08:00 Brisbane — src/watch.js dailyLine) or off (alert_settings, /admin's toggles). The daily summary itself, like
// the admin's test, is always sent: its absence is what says the Worker or ntfy is broken.
// What a message says: a name, the community name its operator published, and counts. Never the `contact` column (a
// person's address), a key, or anything a member wrote. The topic URL and token are secrets: they go in the request
// and nowhere else — a failed send logs its status code, never the address.

export const ALERT_REMIND_S = 24 * 3600;
export const ALERT_RETRY_S = 5 * 60;
export const MAX_WAITING = 50;
export const HOURLY_CAP = 20;
export const HOURLY_CEILING = 40;   // high and urgent go past the cap, never past this
export const CATEGORIES = ['names', 'health', 'uptake', 'admin'];
export const MODES = ['on', 'digest', 'off'];
const SEND_TIMEOUT_MS = 15_000;
const KEEP_S = 7 * 86400;    // sent, muted and held rows are kept this long for /admin
const CLAIM_S = 60;          // a sender's hold on the waiting rows, should it die mid-send

// ntfy priorities (§5) and one tag per class: an emoji short code, which ntfy shows as the emoji (a header carries no
// emoji itself).
export const PRIORITY = { min: 1, low: 2, default: 3, high: 4, urgent: 5 };
const TAG = { urgent: 'red_circle', warning: 'warning', growth: 'seedling', resolved: 'white_check_mark', summary: 'bar_chart' };

const nowS = () => Math.floor(Date.now() / 1000);
const when = (s) => `${new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const base = (env) => env.BASE_DOMAIN || 'beanpool.org';
const host = (env, name) => `${name}.${base(env)}`;
// Where a tap opens: the control room, at the name's row (admin-html.js scrolls to it).
export const adminUrl = (env, name) => `https://${base(env)}/admin${name ? `#${name}` : ''}`;
// A header carries printable ASCII only (fetch refuses anything past Latin-1): the title is built from a name and our
// own words, and this keeps it so whatever comes in.
const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quoted = (community) => (community ? `"${community}"` : 'no community name given');

// The channel, if one is set: NTFY_URL, the full topic URL (the topic is the secret).
export function channelSet(env) {
    const u = typeof env.NTFY_URL === 'string' ? env.NTFY_URL.trim() : '';
    if (!u) return false;
    try { return ['https:', 'http:'].includes(new URL(u).protocol); } catch { return false; }
}

// --- The words (A1–A7, §2.2) ---

// A1: a claim on a gated name, waiting for the admin.
export const nameRequest = (env, { name, community_name, mode }, waiting) => ({
    category: 'names', priority: PRIORITY.default, tag: TAG.growth, name, title: `Name request: ${name}`,
    body: `Name request: ${host(env, name)} — ${quoted(community_name)}, ${mode || 'tunnel'}. ${waiting} waiting for your approval.`,
});
// A2: a new community's name went live (an auto name).
export const newCommunity = (env, { name, community_name }, live) => ({
    category: 'names', priority: PRIORITY.default, tag: TAG.growth, name, title: `New community: ${name}`,
    body: `New community: ${host(env, name)} — ${quoted(community_name)} is live (tier auto). ${plural(live, 'name')} live.`,
});
// A3: the sweep paused a name's routing: another node's key answered, or something that is no node at all.
export const routingPaused = (env, name, reason, count) => ({
    category: 'names', priority: PRIORITY.high, tag: TAG.warning, name, title: `Routing paused: ${name}`,
    body: `Routing paused: ${host(env, name)} — ${reason === 'impostor'
        ? `another node's key answered ${count}× in a row`
        : `something other than its node answered in ${count} sweeps in a row`}. Name kept for its owner, whose heal resumes it.`,
});
// A5: what the admin did, as the Worker answered it (a resume whose re-attest failed says so: the name stays paused).
const DID = { approve: 'approved', pause: 'paused', resume: 'resumed', block: 'blocked', revoke: 'blocked', release: 'released' };
export function adminDid(env, name, action, out) {
    const verb = DID[action] || action;
    const h = host(env, name);
    const body = action === 'resume' && out.status !== 'live'
        ? `You resumed ${h}, but it stays paused: edge re-attest ${out.attest || 'not passed'}. Its node's heal re-attests.`
        : `You ${verb} ${h}${action === 'release' ? (out.held_until ? ` (held until ${when(out.held_until)})` : ' (free now)') : ''}.`;
    return { category: 'admin', priority: PRIORITY.low, tag: TAG.resolved, name, title: `You ${verb} ${name}`, body };
}
// A6: a heal refused (told once per pause: its node heals every 5 minutes while it lasts), a name repaired.
export const healRefused = (env, name, verdict, pausedAt) => ({
    category: 'names', priority: PRIORITY.low, tag: TAG.warning, name, title: `Heal refused: ${name}`, once: `heal-refused:${name}:${pausedAt ?? ''}`,
    body: `Heal refused: ${host(env, name)} stays paused (edge re-attest ${verdict}). Its node tries again.`,
});
export const repaired = (env, name, what) => ({
    category: 'names', priority: PRIORITY.low, tag: TAG.resolved, name, title: `Repaired: ${name}`,
    body: `Repaired: ${host(env, name)} was live but not routed as its row says; the registrar ${what}.`,
});

// A4 and A7: conditions the sweep evaluates every tick. `detail` is said while it is active, `clear` once it ends.
const SUSPENDED = {
    'suspended:canary': (env) => `the canary ${env.CANARY_NAME} did not attest ok`,
    'suspended:mass': (env, s) => `mass (${s.impostor + (s.content_swap || 0)} of ${s.live} live names answered as someone else). The 24 Sep failure looked like this`,
    'suspended:unverifiable': (env, s) => `${s.unverifiable} of ${s.live} live names could not be verified`,
};
export function sweepCondition(env, s) {
    const why = SUSPENDED[s.action];
    return {
        key: 'sweep-suspended', category: 'health', priority: PRIORITY.urgent, tag: TAG.urgent, title: 'Attest sweep suspended',
        active: !!why,
        detail: why ? `Attest sweep suspended: ${why(env, s)}. Acting on nothing.` : `Attest sweeps act again (${s.ok} of ${s.live} live names ok).`,
    };
}
export const teardownCondition = (count, oldestS, now) => ({
    key: 'teardown-owed', category: 'health', priority: PRIORITY.default, tag: TAG.warning, title: 'Cloudflare refuses deletions',
    active: count > 0,
    detail: count > 0
        ? `Cloudflare still refuses ${plural(count, 'deletion')} (oldest ${Math.max(1, Math.floor((now - oldestS) / 86400))} d).`
        : 'Cloudflare took every deletion it had refused for over a day.',
});
export const nonceCondition = (missing) => ({
    key: 'nonce-table', category: 'health', priority: PRIORITY.default, tag: TAG.warning, title: 'Nonce table missing',
    active: missing,
    detail: missing
        ? 'The request_nonces table is missing (migration 0006): signed v2 requests are refused, and nodes fall back to v1.'
        : 'The request_nonces table is there again: v2 requests are served.',
});

// ntfy takes a message of up to 4,096 bytes (a longer body becomes an attachment, "You received a file"): a body stays
// under this, as many events as fit and then "… and N more, see /admin".
const MAX_BODY_BYTES = 3900;
const utf8 = new TextEncoder();
const bytes = (s) => utf8.encode(s).length;
// The longest start of `s` that fits in `max` bytes with an ellipsis, cut between characters.
function clip(s, max) {
    if (bytes(s) <= max) return s;
    let out = '';
    let size = bytes('…');
    for (const ch of s) {
        size += bytes(ch);
        if (size > max) break;
        out += ch;
    }
    return `${out}…`;
}
export function listBody(lines) {
    const more = (n) => `\n… and ${n} more, see /admin`;
    let body = '';
    for (let i = 0; i < lines.length; i++) {
        const next = `${i ? '\n' : ''}${lines[i]}`;
        const after = lines.length - i - 1;
        if (bytes(body) + bytes(next) + (after ? bytes(more(after)) : 0) > MAX_BODY_BYTES) {
            if (i) return body + more(lines.length - i);
            return after ? clip(lines[0], MAX_BODY_BYTES - bytes(more(after))) + more(after) : clip(lines[0], MAX_BODY_BYTES);
        }
        body += next;
    }
    return body;
}

// One message for `events` (oldest first): the first one's title (+N more), the highest priority, and the name's row
// for a tap when every event is about one name.
export function composeAlert(env, events) {
    const first = events[0];
    const priority = Math.max(...events.map((e) => e.priority));
    const names = new Set(events.map((e) => e.name || ''));
    return {
        title: ascii(`${first.title}${events.length > 1 ? ` (+${events.length - 1} more)` : ''}`),
        body: events.length === 1 ? clip(first.body, MAX_BODY_BYTES) : listBody(events.map((e) => `- ${when(e.at)}: ${e.body}`)),
        priority,
        tag: (events.find((e) => e.priority === priority) || first).tag,
        click: adminUrl(env, names.size === 1 ? first.name : null),
    };
}

// --- Sending ---

// One POST to the topic, as ntfy reads it: the body is the message, the headers its title, priority, tag and tap. True
// on a 2xx. Never throws, and what it reports is a status, never the address. A redirect is never followed: 'manual'
// hands back the 3xx, which fails like any other non-2xx (workerd's fetch takes only follow or manual — 'error' throws).
async function post(env, m) {
    const headers = {
        'Content-Type': 'text/plain; charset=utf-8', Title: m.title, Priority: String(m.priority), Click: m.click,
        Actions: `view, Open control room, ${m.click}`,
    };
    if (m.tag) headers.Tags = m.tag;
    if (typeof env.NTFY_TOKEN === 'string' && env.NTFY_TOKEN.trim()) headers.Authorization = `Bearer ${env.NTFY_TOKEN.trim()}`;
    try {
        const res = await fetch(env.NTFY_URL.trim(), {
            method: 'POST', body: m.body, headers, redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        await res.arrayBuffer().catch(() => undefined);
        return { ok: res.status >= 200 && res.status < 300, status: `HTTP ${res.status}` };
    } catch (e) {
        return { ok: false, status: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timed out' : 'unreachable' };
    }
}

async function channelRow(env) {
    await env.DB.prepare("INSERT OR IGNORE INTO alert_channel (channel) VALUES ('ntfy')").run();
    return env.DB.prepare("SELECT * FROM alert_channel WHERE channel='ntfy'").first();
}

export async function categoryMode(env, category) {
    const r = await env.DB.prepare('SELECT mode FROM alert_settings WHERE category=?').bind(category).first();
    return MODES.includes(r?.mode) ? r.mode : 'on';
}

// Into the outbox, as the category says: the row's id when it waits to be sent now, else 0 (off: nothing kept; digest:
// held; an event with a `once` key already in the outbox — kept 7 days — is not kept again).
async function enqueue(env, ev, at) {
    const mode = ev.category === 'test' || ev.category === 'summary' ? 'on' : await categoryMode(env, ev.category);
    if (mode === 'off') return 0;
    const held = mode === 'digest' ? 1 : 0;
    const row = await env.DB.prepare('INSERT OR IGNORE INTO alert_outbox (at, category, priority, tag, title, body, name, held, once) VALUES (?,?,?,?,?,?,?,?,?) RETURNING id')
        .bind(at, ev.category, ev.priority, ev.tag || null, ev.title, ev.body, ev.name || null, held, ev.once || null).first();
    if (!row) return 0;
    if (!held) {
        // At most MAX_WAITING wait; the oldest beyond go, and are counted.
        const r = await env.DB.prepare(`DELETE FROM alert_outbox WHERE id IN (SELECT id FROM alert_outbox
            WHERE sent_at IS NULL AND held=0 AND muted=0 ORDER BY id DESC LIMIT -1 OFFSET ?)`).bind(MAX_WAITING).run();
        const dropped = r?.meta?.changes ?? 0;
        if (dropped) {
            await channelRow(env);
            await env.DB.prepare("UPDATE alert_channel SET dropped = dropped + ? WHERE channel='ntfy'").bind(dropped).run();
        }
    }
    await env.DB.prepare('DELETE FROM alert_outbox WHERE at < ? AND (sent_at IS NOT NULL OR muted=1 OR held=1)').bind(at - KEEP_S).run();
    return held ? 0 : Number(row?.id) || 0;
}

// Into the outbox now, as the category says; the row's id, or 0 when it is not to be sent now. Throws on a failed
// write (the daily line marks the held events it carries only once it is in).
export const enqueueEvent = (env, ev) => enqueue(env, ev, nowS());

// Tell the admin of one event (A1–A3, A5, A6). Like logEvent, it never undoes what it reports: a failure is logged,
// never thrown. The event is in the outbox before this returns; the send runs after the response when the request
// can wait for it (env.waitUntil, index.js), so a slow ntfy never slows a claim.
export async function notify(env, ev) {
    try {
        if (!(await enqueue(env, ev, nowS()))) return;
        if (typeof env.waitUntil === 'function') env.waitUntil(flush(env));
        else await flush(env);
    } catch (e) {
        console.error('[ALERT]', ev.category, ev.title, String(e?.message || e).slice(0, 200));
    }
}

// Every condition as it is now (each sweep): raised, still (24 h on), cleared — each told once, even with two sweeps at
// the same time (a conditional write decides who tells). A raised or still the hourly cap muted is told again in the
// next hour (alert_state.told_id: the row that told it). Then whatever waits is sent, if a try is due.
export async function updateConditions(env, conditions) {
    const now = nowS();
    for (const c of conditions) {
        try {
            const r = await env.DB.prepare('SELECT * FROM alert_state WHERE key=?').bind(c.key).first();
            const seen = JSON.stringify({ category: c.category, priority: c.priority, title: c.title });
            const tell = async (kind, since) => {
                const id = await enqueue(env, {
                category: c.category, name: null,
                priority: kind === 'cleared' ? PRIORITY.low : c.priority,
                tag: kind === 'cleared' ? TAG.resolved : c.tag,
                title: `${kind === 'still' ? 'Still: ' : kind === 'cleared' ? 'Resolved: ' : ''}${c.title}`,
                body: kind === 'raised' ? `${c.detail} Since ${when(since)}.`
                    : kind === 'still' ? `Still, since ${when(since)}: ${c.detail}`
                        : `Resolved (since ${when(since)}): ${c.detail}`,
                }, now);
                if (kind !== 'cleared') await env.DB.prepare('UPDATE alert_state SET told_id=? WHERE key=? AND since=?').bind(id || null, c.key, since).run();
            };
            if (c.active && !r) {
                const w = await env.DB.prepare('INSERT OR IGNORE INTO alert_state (key, since, last_told_at, detail, last_seen_json) VALUES (?,?,?,?,?)')
                    .bind(c.key, now, now, c.detail, seen).run();
                if (w?.meta?.changes) await tell('raised', now);
            } else if (c.active && r) {
                const muted = r.told_id ? await env.DB.prepare('SELECT title FROM alert_outbox WHERE id=? AND muted=1 AND at < ?')
                    .bind(r.told_id, now - (now % 3600)).first() : null;
                const due = !!muted || now - r.last_told_at >= ALERT_REMIND_S;
                const w = await env.DB.prepare('UPDATE alert_state SET detail=?, last_seen_json=?, last_told_at=?, told_id = CASE WHEN ? THEN NULL ELSE told_id END WHERE key=? AND last_told_at=?')
                    .bind(c.detail, seen, due ? now : r.last_told_at, due && muted ? 1 : 0, c.key, r.last_told_at).run();
                if (due && w?.meta?.changes) await tell(muted && !muted.title.startsWith('Still: ') ? 'raised' : 'still', r.since);
            } else if (!c.active && r) {
                const w = await env.DB.prepare('DELETE FROM alert_state WHERE key=? AND since=?').bind(c.key, r.since).run();
                if (w?.meta?.changes) await tell('cleared', r.since);
            }
        } catch (e) {
            console.error('[ALERT_CONDITION]', c.key, String(e?.message || e).slice(0, 200));
        }
    }
    if (typeof env.waitUntil === 'function') env.waitUntil(flush(env));
    else await flush(env);
}

// Send what waits, if a channel is set and a try is due: one message with every waiting event (at most 50), or, at the
// hour's cap, the one "muted" line and then nothing until the next hour — unless something high or urgent waits, which
// goes (with the rest) up to the hour's ceiling. `force`: try now even inside the 5 minutes
// after a failure (the admin's test button). Returns what happened: { sent, muted, status? }. Never throws.
export async function flush(env, { force = false } = {}) {
    try {
        if (!channelSet(env)) return { sent: 0, muted: 0, status: 'not set' };
        const now = nowS();
        const ch = await channelRow(env);
        if (!force && now < (ch?.next_try_at || 0)) return { sent: 0, muted: 0, status: 'waiting to retry' };
        const claim = crypto.randomUUID();
        await env.DB.prepare(`UPDATE alert_outbox SET claim=?, claim_at=? WHERE id IN (SELECT id FROM alert_outbox
            WHERE sent_at IS NULL AND held=0 AND muted=0 AND (claim IS NULL OR claim_at < ?) ORDER BY id LIMIT ?)`)
            .bind(claim, now, now - CLAIM_S, MAX_WAITING).run();
        const events = (await env.DB.prepare('SELECT * FROM alert_outbox WHERE claim=? ORDER BY id').bind(claim).all()).results || [];
        if (!events.length) return { sent: 0, muted: 0 };

        // The hour's cap, held even by two senders at once: a message is sent only once it has reserved its place in the
        // hour (one of HOURLY_CAP; past them, one of HOURLY_CEILING when something high or urgent is in it; or the one
        // "muted" line, which also counts what it mutes), and a send that fails gives it back.
        const hour = now - (now % 3600);
        const cur = (col) => `CASE WHEN hour_start=${hour} THEN ${col} ELSE 0 END`;
        const reserve = async (limit, muting = 0) => ((await env.DB.prepare(`UPDATE alert_channel
            SET hour_sent = ${cur('hour_sent')} + 1, hour_muted = ${cur('hour_muted')} + ?, hour_line = ${cur('hour_line')} + ?, hour_start=?
            WHERE channel='ntfy' AND ${cur('hour_sent')} < ?${muting ? ` AND ${cur('hour_line')} = 0` : ''}`).bind(muting, muting ? 1 : 0, hour, limit).run())?.meta?.changes ?? 0) > 0;
        const loud = events.some((e) => e.priority >= PRIORITY.high);
        const mutedLine = !(await reserve(HOURLY_CAP)) && !(loud && await reserve(HOURLY_CEILING));
        if (mutedLine && !(await reserve(HOURLY_CEILING + 1, events.length))) {
            // Muted for the rest of the hour: kept for /admin, never sent.
            await env.DB.prepare('UPDATE alert_outbox SET muted=1, claim=NULL WHERE claim=?').bind(claim).run();
            await env.DB.prepare("UPDATE alert_channel SET hour_muted = hour_muted + ? WHERE channel='ntfy' AND hour_start=?").bind(events.length, hour).run();
            return { sent: 0, muted: events.length };
        }
        const m = mutedLine ? {
            title: `Muted: ${events.length} more this hour`, body: `muted: ${events.length} more this hour, see /admin`,
            priority: PRIORITY.default, tag: TAG.warning, click: adminUrl(env, null),
        } : composeAlert(env, events);
        const r = await post(env, m);
        if (r.ok) {
            await env.DB.prepare(`UPDATE alert_outbox SET ${mutedLine ? 'muted=1' : 'sent_at=?'}, claim=NULL WHERE claim=?`)
                .bind(...(mutedLine ? [claim] : [now, claim])).run();
            await env.DB.prepare("UPDATE alert_channel SET last_ok_at=?, last_try_at=?, last_status=?, failed_in_a_row=0, next_try_at=0 WHERE channel='ntfy'")
                .bind(now, now, r.status).run();
            return { sent: 1, muted: mutedLine ? events.length : 0, status: r.status };
        }
        await env.DB.prepare('UPDATE alert_outbox SET claim=NULL WHERE claim=?').bind(claim).run();
        await env.DB.prepare("UPDATE alert_channel SET hour_sent = MAX(0, hour_sent - 1), hour_muted = MAX(0, hour_muted - ?), hour_line = CASE WHEN ? THEN 0 ELSE hour_line END WHERE channel='ntfy' AND hour_start=?")
            .bind(mutedLine ? events.length : 0, mutedLine ? 1 : 0, hour).run();
        await env.DB.prepare("UPDATE alert_channel SET last_try_at=?, last_status=?, failed_in_a_row=failed_in_a_row+1, next_try_at=? WHERE channel='ntfy'")
            .bind(now, r.status, now + ALERT_RETRY_S).run();
        console.error('[ALERT_SEND]', `ntfy: ${r.status}; ${plural(events.length, 'event')} waiting, tried again in ${ALERT_RETRY_S / 60} min`);
        return { sent: 0, muted: 0, status: r.status };
    } catch (e) {
        console.error('[ALERT_FLUSH]', String(e?.message || e).slice(0, 200));
        return { sent: 0, muted: 0, status: 'error' };
    }
}

// The admin's test button: one message through the channel now, with whatever else waits.
export async function sendTest(env) {
    if (!channelSet(env)) return { sent: false, error: 'NTFY_URL is not set, so nothing was sent: set it with `wrangler secret put NTFY_URL`' };
    await enqueue(env, {
        category: 'test', priority: PRIORITY.default, tag: TAG.summary, name: null, title: 'Test from the registrar',
        body: `Test from the ${base(env)} registrar's control room: its alerts reach this phone. Sent ${when(nowS())}.`,
    }, nowS());
    const r = await flush(env, { force: true });
    return r.sent ? { sent: true, status: r.status } : { sent: false, error: `not sent: ${r.status || 'muted for this hour'}` };
}

// What /admin shows: the channel (set or not — never its address), the hour's cap, the categories, what is raised, and
// the newest 50 events with their state.
export async function alertStatus(env) {
    const now = nowS();
    const ch = await channelRow(env);
    const hour = now - (now % 3600);
    const n = async (where) => Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM alert_outbox WHERE ${where}`).first())?.n) || 0;
    const settings = Object.fromEntries(CATEGORIES.map((c) => [c, 'on']));
    for (const r of (await env.DB.prepare('SELECT category, mode FROM alert_settings').all()).results || [])
        if (CATEGORIES.includes(r.category) && MODES.includes(r.mode)) settings[r.category] = r.mode;
    return {
        channel: {
            set: channelSet(env), token: typeof env.NTFY_TOKEN === 'string' && !!env.NTFY_TOKEN.trim(),
            last_ok_at: ch.last_ok_at ?? null, last_try_at: ch.last_try_at ?? null, last_status: ch.last_status ?? null,
            failed_in_a_row: ch.failed_in_a_row || 0, next_try_at: ch.next_try_at || null,
            waiting: await n('sent_at IS NULL AND held=0 AND muted=0'), dropped: ch.dropped || 0,
        },
        cap: { per_hour: HOURLY_CAP, sent: ch.hour_start === hour ? ch.hour_sent : 0, muted: ch.hour_start === hour ? ch.hour_muted : 0 },
        settings,
        held_for_digest: await n('held=1 AND sent_at IS NULL'),
        active: (await env.DB.prepare('SELECT key, since, last_told_at, detail FROM alert_state ORDER BY since').all()).results || [],
        recent: (await env.DB.prepare('SELECT id, at, category, priority, title, body, name, held, muted, sent_at FROM alert_outbox ORDER BY id DESC LIMIT 50').all()).results || [],
    };
}

export async function setCategoryMode(env, category, mode) {
    if (!CATEGORIES.includes(category) || !MODES.includes(mode)) return false;
    await env.DB.prepare('INSERT INTO alert_settings (category, mode) VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET mode=excluded.mode')
        .bind(category, mode).run();
    return true;
}
