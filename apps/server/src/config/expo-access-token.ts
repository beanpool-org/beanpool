// The Expo access token this node's pushes go with (scratch/reviews/FABLE-sec-outbound.md M1).
//
// Every push token a phone registers here is enough on its own to send that phone a notification: anyone holding one,
// from a leaked database, a plain backup or a standby's copy, can push a phishing link to a member. Once "Enhanced
// security for push notifications" is on for BeanPool's Expo project, Expo also asks for this token, and a push token
// alone is useless.
//
// From the environment ONLY, as IMAGE_S3_SECRET_ACCESS_KEY is: never stored in node_config or the database, so never in
// a backup, a snapshot or a standby's copy, and never logged (sanitize-message.ts also takes the value itself out of any
// line that carries it). Read at every send, never cached. A leaf module: the log sanitiser imports it.

/** The variable, as docker-compose.yml passes it through from .env. */
export const EXPO_ACCESS_TOKEN_ENV = 'EXPO_ACCESS_TOKEN';

/**
 * What a token can be: visible ASCII, no space. Anything else in a header makes fetch throw an error that quotes the
 * whole header value, token and all ("Headers.append: "Bearer …" is an invalid header value"), and that error is logged.
 */
const TOKEN_SHAPE = /^[\x21-\x7E]+$/;

/** The variable's value without the spaces or line ending .env can leave around it, or null when it is empty. */
export function expoAccessTokenValue(env: NodeJS.ProcessEnv = process.env): string | null {
    const value = (env[EXPO_ACCESS_TOKEN_ENV] ?? '').trim();
    return value ? value : null;
}

let warnedUnusable = false;

/** The token to send, or null: unset, or set to something no header can carry (warned once, never with the value). */
export function expoAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
    const value = expoAccessTokenValue(env);
    if (value === null) return null;
    if (TOKEN_SHAPE.test(value)) return value;
    if (!warnedUnusable) {
        warnedUnusable = true;
        console.warn(`[Push] ${EXPO_ACCESS_TOKEN_ENV} is set, but has a space or a character a request header can't carry, `
            + 'so pushes go without it. Copy the token again into .env, on one line, and restart the server.');
    }
    return null;
}

/** For diagnostics: whether pushes go with a token. Never the value. */
export function expoAccessTokenStatus(env: NodeJS.ProcessEnv = process.env): 'set' | 'not set' | 'unusable' {
    const value = expoAccessTokenValue(env);
    if (value === null) return 'not set';
    return TOKEN_SHAPE.test(value) ? 'set' : 'unusable';
}

/**
 * The headers of a request to Expo's push API. Without a token, exactly what the node sent before the token existed;
 * with one, the same and `Authorization: Bearer <token>`.
 */
export function expoPushHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const token = expoAccessToken(env);
    return token ? { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } : { 'Content-Type': 'application/json' };
}
