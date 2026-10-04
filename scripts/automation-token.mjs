// The owner scripts' one check of an automation token, before any header is built (bootstrap-community-eggs,
// grant-operator, setup-backup, federation/fed.mjs).
//
// The shape is the server's (apps/server/src/automation-tokens.ts TOKEN_SHAPE; automation-token.test.mjs keeps the two
// the same): bp_ + 12 hex + _ + 64 hex, nothing before or after. A value with a control character inside (a line break
// from a paste) fails it, so it never reaches fetch, whose error for such a header repeats the whole value. No message
// here ever repeats the value.

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
