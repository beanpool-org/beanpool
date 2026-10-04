// The owner scripts' one check of an automation token, before any header is built, and their one fetch that never
// follows a redirect with a credential (bootstrap-community-eggs, grant-operator, setup-backup, federation/fed.mjs).
//
// The shape is the server's (apps/server/src/automation-tokens.ts TOKEN_SHAPE; automation-token.test.mjs keeps the two
// the same): bp_ + 12 hex + _ + 64 hex, nothing before or after. A value with a control character inside (a line break
// from a paste) fails it, so it never reaches fetch, whose error for such a header repeats the whole value. No message
// here ever repeats the value.

/* global fetch, URL -- Node globals; the repo's lint config declares none for scripts/ */

export const AUTOMATION_TOKEN_SHAPE = /^bp_[0-9a-f]{12}_[0-9a-f]{64}$/;

export function isAutomationTokenShape(value) {
    return typeof value === 'string' && AUTOMATION_TOKEN_SHAPE.test(value);
}

/** Why the value in `name` is not a token, in words that never include it; null when it is one. */
export function automationTokenProblem(name, value) {
    if (isAutomationTokenShape(value)) return null;
    return `${name} is not an automation token (bp_ + 12 hex + _ + 64 hex, nothing before or after): make one in Settings → Automation tokens and copy it whole.`;
}

/** Why a password or other secret in `name` cannot go in a header (a control character), or null. Never includes it. */
export function headerValueProblem(name, value) {
    // eslint-disable-next-line no-control-regex -- control characters are what this looks for
    return typeof value === 'string' && /[\x00-\x1f\x7f]/.test(value)
        ? `${name} has a control character in it (a line break from a paste?): it cannot be sent.`
        : null;
}

/**
 * fetch for a request that carries a credential (a token, the admin password, a 2FA session): it never follows a
 * redirect. fetch's default follows one, and to another origin it drops Authorization but keeps every other header, so
 * X-Admin-Password went wherever the node, or a proxy in front of it, pointed, and that origin's answer was read as the
 * node's. Any 3xx answer throws an Error (`redirect: true`) that says so and names where it pointed, by origin only;
 * nothing is sent there. Point the script at the address the node answers on itself.
 */
export async function fetchNoRedirect(url, init = {}) {
    const res = await fetch(url, { ...init, redirect: 'manual' });
    if (res.status < 300 || res.status > 399) return res;
    await res.body?.cancel().catch(() => {});
    const location = res.headers.get('location');
    let where = 'no address';
    if (location) {
        try { where = new URL(location, url).origin; } catch { where = 'an address that is not a URL'; }
    }
    const error = new Error(`${new URL(url).origin} answered HTTP ${res.status}, a redirect to ${where}. It was not followed, so ` +
        'the credential went nowhere else, and nothing more was sent. Use the address the node answers on itself.');
    error.redirect = true;
    throw error;
}
