// Validation for a public feedback submission. Pure functions — no I/O — so the tests can pin them.
//
// The limits mirror packages/beanpool-core/src/feedback.ts, which the apps use to check a form
// before sending. Change them in both places together; the Worker is the one that decides.

export const TEXT_MIN = 10;
export const TEXT_MAX = 2000;
export const COMMUNITY_MAX = 80;
export const KINDS = ['idea', 'problem', 'other'];
export const SOURCES = ['member-app', 'web', 'settings-app'];
export const STATUSES = ['new', 'spam', 'triaged', 'filed'];
export const HONEYPOT_FIELD = 'website';

// Characters, not UTF-16 units: a suggestion in Hindi or Amharic gets the same room as one in English.
export const charLength = (s) => [...s].length;

// C0/C1 control characters except tab and newlines. They have no place in a suggestion and make
// the digest prompt harder to read.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;
const clean = (s) => s.replace(CONTROL, '').trim();

const VERSION_RE = /^[0-9A-Za-z.+_-]{1,32}$/;
const PLATFORM_RE = /^[0-9A-Za-z._ -]{1,32}$/;
const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

/**
 * @returns {{ ok: true, item: object, honeypot: boolean } | { ok: false, error: string }}
 * `honeypot: true` means a bot filled the hidden field: the caller answers as if it worked and
 * stores nothing.
 */
export function validateSubmission(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };

    const hp = body[HONEYPOT_FIELD];
    const honeypot = hp !== undefined && hp !== null && String(hp) !== '';

    if (typeof body.text !== 'string') return { ok: false, error: 'Please write your suggestion.' };
    const text = clean(body.text);
    const len = charLength(text);
    if (len < TEXT_MIN) return { ok: false, error: `Please write at least ${TEXT_MIN} characters.` };
    if (len > TEXT_MAX) return { ok: false, error: `Please keep it under ${TEXT_MAX} characters.` };

    const kind = body.kind === undefined || body.kind === null || body.kind === '' ? 'other' : body.kind;
    if (!KINDS.includes(kind)) return { ok: false, error: 'kind must be idea, problem or other.' };

    if (!SOURCES.includes(body.source)) return { ok: false, error: 'source must be member-app, web or settings-app.' };

    let community = null;
    if (body.community !== undefined && body.community !== null) {
        if (typeof body.community !== 'string') return { ok: false, error: 'community must be text.' };
        const c = clean(body.community);
        if (charLength(c) > COMMUNITY_MAX) return { ok: false, error: `Please keep the community name under ${COMMUNITY_MAX} characters.` };
        community = c || null;
    }

    // Diagnostic fields are best-effort: a malformed one is dropped, never a reason to lose the
    // suggestion itself.
    const optional = (v, re) => (typeof v === 'string' && re.test(v.trim()) ? v.trim() : null);

    return {
        ok: true,
        honeypot,
        item: {
            text,
            kind,
            source: body.source,
            app_version: optional(body.appVersion, VERSION_RE),
            platform: optional(body.platform, PLATFORM_RE),
            lang: optional(body.lang, LANG_RE),
            community,
        },
    };
}

/**
 * A reply through a notice's reply link (src/reply.js): the form's `text` and its hidden `website`, as a suggestion's.
 * @returns {{ ok: true, text: string, honeypot: boolean } | { ok: false, error: string }}
 */
export function validateReply(form) {
    const hp = form[HONEYPOT_FIELD];
    const honeypot = hp !== undefined && hp !== null && String(hp) !== '';
    if (typeof form.text !== 'string') return { ok: false, error: 'Please write your reply.' };
    const text = clean(form.text.replace(/\r\n?/g, '\n'));
    const len = charLength(text);
    if (len < TEXT_MIN) return { ok: false, error: `Please write at least ${TEXT_MIN} characters.` };
    if (len > TEXT_MAX) return { ok: false, error: `Please keep it under ${TEXT_MAX} characters.` };
    return { ok: true, text, honeypot };
}

/** Admin status update body. */
export function validateStatusUpdate(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'Expected a JSON object.' };
    if (!STATUSES.includes(body.status)) return { ok: false, error: `status must be one of ${STATUSES.join(', ')}.` };
    let github_url = null;
    if (body.github_url !== undefined && body.github_url !== null && body.github_url !== '') {
        if (typeof body.github_url !== 'string' || !/^https:\/\/github\.com\/[^\s]{1,300}$/.test(body.github_url))
            return { ok: false, error: 'github_url must be an https://github.com/ link.' };
        github_url = body.github_url;
    }
    let note = null;
    if (body.note !== undefined && body.note !== null && body.note !== '') {
        if (typeof body.note !== 'string' || charLength(body.note) > 1000) return { ok: false, error: 'note must be text under 1000 characters.' };
        note = clean(body.note);
    }
    return { ok: true, update: { status: body.status, github_url, note } };
}
