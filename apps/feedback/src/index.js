// BeanPool feedback — Cloudflare Worker.
//   POST /api/feedback                     public, no account: "Suggest a change to BeanPool"
//   GET  /api/feedback/admin/items          bearer FEEDBACK_ADMIN_TOKEN: list by status
//   POST /api/feedback/admin/items/:id      bearer FEEDBACK_ADMIN_TOKEN: set status / github_url / note
//   scheduled (daily): delete yesterday's rate-limit salt and counters
//
// Every BeanPool app — including those on self-hosted nodes we never talk to — posts here, so the
// project hears from all of them. Nothing stored identifies the sender: see README.md.
// This Worker must never log a request, a header, or a body.

import { validateSubmission, validateStatusUpdate, STATUSES } from './validate.js';
import { checkAndCount, purgeBefore, utcDay } from './ratelimit.js';

export const MAX_BODY_BYTES = 16 * 1024; // 2000 characters of 4-byte script is 8 KB; room for the rest
const PUBLIC_PATH = '/api/feedback';
const ADMIN_PREFIX = '/api/feedback/admin/';

const nowS = () => Math.floor(Date.now() / 1000);

function json(obj, status = 200, extra = {}) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
    });
}

// --- CORS (public endpoint only) ---
// The PWA and the node Settings app run on every community's own domain, including strangers'
// self-hosted nodes, so the default is any origin. That is safe here because the endpoint takes no
// credentials and returns nothing but ok/error; CORS is not what stops spam — the rate limit is.
// Set CORS_ORIGINS to a comma list to narrow it. Admin routes never send CORS headers, so a
// browser page on another origin can never read them.
function corsHeaders(request, env) {
    const origin = request.headers.get('origin');
    const conf = String(env.CORS_ORIGINS ?? '*').trim();
    const base = { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' };
    if (conf === '*') return { ...base, 'access-control-allow-origin': '*' };
    const allowed = conf.split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) return { ...base, 'access-control-allow-origin': origin, vary: 'Origin' };
    return { vary: 'Origin' };
}

// Reads at most `max` bytes; returns null if the body is larger. Checks content-length first so an
// honest oversized request is refused without reading it at all.
async function readCapped(request, max) {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > max) return null;
    if (!request.body) return '';
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return null;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return new TextDecoder().decode(all);
}

async function handleSubmit(request, env) {
    const cors = corsHeaders(request, env);
    const raw = await readCapped(request, MAX_BODY_BYTES);
    if (raw === null) return json({ ok: false, error: 'That is too long to send.' }, 413, cors);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'Expected a JSON object.' }, 400, cors); }

    const v = validateSubmission(body);
    if (!v.ok) return json({ ok: false, error: v.error }, 400, cors);
    // A bot filled the hidden field: look exactly like success, store nothing, count nothing.
    if (v.honeypot) return json({ ok: true }, 201, cors);

    const now = nowS();
    const rl = await checkAndCount(env, request.headers.get('cf-connecting-ip'), now);
    if (!rl.allowed) {
        return json(
            {
                ok: false,
                error: rl.reason === 'global'
                    ? "Thank you — we've had a lot of suggestions today. Please try again tomorrow; your text is still here."
                    : "Thank you — we've had a lot of suggestions from your connection recently. Please try again a bit later; your text is still here.",
            },
            429,
            { ...cors, 'retry-after': String(rl.retryAfter) },
        );
    }

    const it = v.item;
    await env.DB.prepare(
        'INSERT INTO feedback_items (text, kind, source, app_version, platform, lang, community, received_at, status) ' +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')",
    ).bind(it.text, it.kind, it.source, it.app_version, it.platform, it.lang, it.community, now).run();
    return json({ ok: true }, 201, cors);
}

// --- Admin ---
// Constant-time: compare SHA-256 digests, which are always the same length, so neither the
// content nor the length of the token leaks through timing.
export async function tokenMatches(presented, expected) {
    if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(presented)),
        crypto.subtle.digest('SHA-256', enc.encode(expected)),
    ]);
    const x = new Uint8Array(a), y = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
    return diff === 0;
}

async function isAdmin(request, env) {
    const m = /^Bearer (.+)$/.exec(request.headers.get('authorization') || '');
    return tokenMatches(m ? m[1] : null, env.FEEDBACK_ADMIN_TOKEN);
}

async function handleList(url, env) {
    const status = url.searchParams.get('status') || 'new';
    if (!STATUSES.includes(status)) return json({ error: `status must be one of ${STATUSES.join(', ')}` }, 400);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), 500);
    const { results } = await env.DB.prepare(
        'SELECT id, text, kind, source, app_version, platform, lang, community, received_at, status, github_url, note, updated_at ' +
        'FROM feedback_items WHERE status=? ORDER BY id ASC LIMIT ?',
    ).bind(status, limit).all();
    const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM feedback_items WHERE status=?').bind(status).first();
    return json({ items: results, total: total.n });
}

async function handleUpdate(request, env, id) {
    const raw = await readCapped(request, MAX_BODY_BYTES);
    if (raw === null) return json({ error: 'body too large' }, 413);
    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
    const v = validateStatusUpdate(body);
    if (!v.ok) return json({ error: v.error }, 400);
    const u = v.update;
    const res = await env.DB.prepare(
        'UPDATE feedback_items SET status=?, github_url=COALESCE(?, github_url), note=COALESCE(?, note), updated_at=? WHERE id=?',
    ).bind(u.status, u.github_url, u.note, nowS(), id).run();
    if (!res.meta || res.meta.changes === 0) return json({ error: 'not found' }, 404);
    return json({ ok: true, id, status: u.status });
}

async function handleAdmin(request, env, url) {
    if (!(await isAdmin(request, env))) return json({ error: 'unauthorised' }, 401, { 'www-authenticate': 'Bearer' });
    const rest = url.pathname.slice(ADMIN_PREFIX.length);
    if (rest === 'items' && request.method === 'GET') return handleList(url, env);
    const m = /^items\/(\d{1,12})$/.exec(rest);
    if (m && request.method === 'POST') return handleUpdate(request, env, Number(m[1]));
    return json({ error: 'not found' }, 404);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';
        const isPublic = path === PUBLIC_PATH;
        try {
            if (isPublic) {
                if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
                if (request.method === 'POST') return await handleSubmit(request, env);
                return json({ error: 'method not allowed' }, 405, { allow: 'POST, OPTIONS', ...corsHeaders(request, env) });
            }
            if (url.pathname.startsWith(ADMIN_PREFIX)) return await handleAdmin(request, env, url);
            return json({ error: 'not found' }, 404);
        } catch {
            // Deliberately no detail and no logging: an exception message could carry request data.
            return json(
                { ok: false, error: 'Something went wrong on our side. Your text is still here — please try again later.' },
                500,
                isPublic ? corsHeaders(request, env) : {},
            );
        }
    },

    async scheduled(_event, env) {
        await purgeBefore(env, utcDay(nowS()));
    },
};
