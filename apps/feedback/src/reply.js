// GET/POST /reply/<token> — an operator answering a notice from the address service (scratch/global-node/
// DESIGN-registrar-trust-fable.md §3.2, slice S2). The notice reached their node through its own check-in, carrying a
// one-use link; this page takes what they choose to write and files it in the feedback inbox under the name the link was
// made for (source 'address-reply'), for the project to read. Nothing else is asked or kept: no address, no account.
//
// The link is the registrar's: this Worker checks it and takes its one use through the registrar's ReplyTokens entrypoint
// (a service binding, env.REGISTRAR: apps/registrar/src/worker.js), never its database. The token is random and the page
// shows nothing about the name or the key: a link that works shows the form, one that doesn't says so — that is all
// it tells anyone holding it. Without the binding (a copy of this Worker set up without the registrar) the page says
// replies are not set up here.
//
// Like the rest of this Worker it logs nothing. The page is plain HTML (no script), and sends no Referer: the token is in
// its address.

import { validateReply, TEXT_MIN, TEXT_MAX } from './validate.js';
import { checkAndCount } from './ratelimit.js';

export const REPLY_PREFIX = '/reply/';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;   // 32 random bytes, base64url (the registrar's)
const MAX_FORM_BYTES = 16 * 1024;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function page(status, title, body) {
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · BeanPool</title>
<style>
  :root { color-scheme: light dark; --bg: #f8fafc; --fg: #0f172a; --muted: #475569; --card: #ffffff; --line: #cbd5e1; --accent: #047857; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0b1220; --fg: #e2e8f0; --muted: #94a3b8; --card: #111827; --line: #334155; --accent: #34d399; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 36rem; margin: 0 auto; padding: 2rem 1rem; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  p { color: var(--muted); margin: 0 0 1rem; }
  textarea { width: 100%; min-height: 10rem; padding: 0.75rem; border: 1px solid var(--line); border-radius: 0.5rem; background: var(--card); color: var(--fg); font: inherit; }
  button { margin-top: 0.75rem; padding: 0.65rem 1.25rem; border: 0; border-radius: 0.5rem; background: var(--accent); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  .hide { position: absolute; left: -10000px; width: 1px; height: 1px; overflow: hidden; }
  .error { color: #b91c1c; }
  @media (prefers-color-scheme: dark) { .error { color: #f87171; } }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
    return new Response(html, {
        status,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
            'referrer-policy': 'no-referrer',
            'x-content-type-options': 'nosniff',
            'x-robots-tag': 'noindex',
        },
    });
}

const LEAD = '<p>This page sends a reply to the BeanPool project, which runs the address service your community\'s name comes from. '
    + 'Only the project team reads it. Write what you want us to know; please don\'t include anyone\'s personal details.</p>';

function form(text = '', error = null) {
    return page(error ? 400 : 200, 'Reply to the address service', `<h1>Reply to the address service</h1>${LEAD}`
        + (error ? `<p class="error" role="alert">${esc(error)}</p>` : '')
        + '<form method="post">'
        + `<label for="text">Your reply (${TEXT_MIN}–${TEXT_MAX} characters)</label>`
        + `<textarea id="text" name="text" required minlength="${TEXT_MIN}" maxlength="${TEXT_MAX}">${esc(text)}</textarea>`
        + '<div class="hide" aria-hidden="true"><label for="website">Leave this empty</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>'
        + '<button type="submit">Send reply</button></form>'
        + '<p style="margin-top: 1rem; font-size: 0.875rem;">The link works once. You can send another reply when the address service sends your community a new notice.</p>');
}

const gone = () => page(410, 'This reply link does not work', '<h1>This reply link does not work</h1>'
    + '<p>It has been used, it has expired, or the name it was for is no longer your community\'s. Your server\'s Settings, under Public address, '
    + 'shows the latest notices from the address service; a newer one may carry a new link. You can also use "Suggest a change to BeanPool" in Settings.</p>');

const thanks = () => page(201, 'Reply sent', '<h1>Thank you: your reply was sent</h1>'
    + '<p>It reached the BeanPool project team. If it needs an answer, the address service will send your community a notice: your server\'s Settings shows it under Public address.</p>');

const busy = (text = '') => page(503, 'Please try again later', '<h1>Please try again later</h1>'
    + '<p>The address service did not answer just now. Your link still works if it has not been used: try again in a few minutes.</p>'
    + (text ? `<textarea readonly>${esc(text)}</textarea>` : ''));

const notHere = () => page(503, 'Replies are not set up here', '<h1>Replies are not set up here</h1>'
    + '<p>This copy of the feedback service is not connected to an address service. Use "Suggest a change to BeanPool" in Settings instead.</p>');

/** The form's fields (application/x-www-form-urlencoded), at most MAX_FORM_BYTES; null when larger. */
async function readForm(request) {
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FORM_BYTES) return null;
    if (!request.body) return {};
    const reader = request.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_FORM_BYTES) {
            try { await reader.cancel(); } catch { /* already closed */ }
            return null;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.byteLength; }
    return Object.fromEntries(new URLSearchParams(new TextDecoder().decode(all)));
}

/** GET shows the form while the link works; POST sends the reply and takes the link's one use. */
export async function handleReply(request, env, path, nowS) {
    const token = path.slice(REPLY_PREFIX.length);
    if (!TOKEN_RE.test(token)) return gone();
    if (!env.REGISTRAR || typeof env.REGISTRAR.check !== 'function' || typeof env.REGISTRAR.redeem !== 'function') return notHere();
    if (request.method === 'GET' || request.method === 'HEAD') {
        let r;
        try { r = await env.REGISTRAR.check(token); } catch { return busy(); }
        return r?.ok === true ? form() : gone();
    }
    if (request.method !== 'POST') return page(405, 'Not allowed', '<h1>Not allowed</h1>');

    const fields = await readForm(request);
    if (fields === null) return form('', `Please keep it under ${TEXT_MAX} characters.`);
    const v = validateReply(fields);
    if (!v.ok) return form(typeof fields.text === 'string' ? fields.text.slice(0, TEXT_MAX * 2) : '', v.error);
    // A bot filled the hidden field: looks like success, takes nothing and stores nothing.
    if (v.honeypot) return thanks();

    const rl = await checkAndCount(env, request.headers.get('cf-connecting-ip'), nowS);
    if (!rl.allowed) {
        const res = form(v.text, 'Thank you — a lot has been sent from your connection recently. Please try again a bit later; your text is still here.');
        return new Response(res.body, { status: 429, headers: { ...Object.fromEntries(res.headers), 'retry-after': String(rl.retryAfter) } });
    }

    let r;
    try { r = await env.REGISTRAR.redeem(token); } catch { return busy(v.text); }
    if (r?.ok !== true || typeof r.name !== 'string') return gone();
    try {
        await env.DB.prepare(
            'INSERT INTO feedback_items (text, kind, source, community, received_at, status, note) ' +
            "VALUES (?, 'other', 'address-reply', ?, ?, 'new', ?)",
        ).bind(v.text, r.name, nowS, Number.isSafeInteger(r.notice_id) ? `reply to notice #${r.notice_id}` : 'reply to a notice').run();
    } catch {
        // The link is used up: the words are shown back, so they are not lost.
        return page(500, 'Your reply was not kept', '<h1>Your reply was not kept</h1>'
            + '<p class="error">Something went wrong on our side after the link was used. Please copy your words from below and send them with "Suggest a change to BeanPool" in Settings.</p>'
            + `<textarea readonly>${esc(v.text)}</textarea>`);
    }
    return thanks();
}
