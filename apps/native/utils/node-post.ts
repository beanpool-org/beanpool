/**
 * A signed POST to the member's own node.
 *
 * Extracted from `keeper-enrolment.ts` rather than copied, because the one interesting line in it
 * is a fix that would not survive being retyped: a stored anchor of `https://node/` would send the
 * request to `https://node//api/...`. When the headers signed `path` on its own, the server verified
 * over `ctx.path`, saw the doubled slash, and every call 401'd with nothing to suggest a URL was the
 * cause. The headers now sign the URL fetched (request binding: its host and its path), so the two
 * can't disagree, but the slash is still trimmed so the request reaches the route it names. Two copies
 * of this function is two chances to lose that.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';

let _cachedAnchorUrl: string | null = null;

export function getCachedAnchorUrl(): string | null {
    return _cachedAnchorUrl;
}

export function setCachedAnchorUrl(url: string | null): void {
    _cachedAnchorUrl = url ? url.replace(/\/+$/, '') : null;
}

/** The node this member belongs to, or null before one is chosen. */
export async function anchorUrl(): Promise<string | null> {
    const val = await AsyncStorage.getItem('beanpool_anchor_url');
    _cachedAnchorUrl = val ? val.replace(/\/+$/, '') : null;
    return val;
}

export async function signedPost(
    url: string, path: string, body: unknown, identity: BeanPoolIdentity, signal?: AbortSignal,
): Promise<Response> {
    const bodyString = JSON.stringify(body);
    // Covered by "does not double the slash when the stored node URL ends in one" in
    // keeper-enrolment.test.ts — through the real call path rather than against a helper, which
    // is what makes it a regression test for this line rather than for a regex.
    const target = `${url.replace(/\/+$/, '')}${path}`;
    const headers = await buildSignedHeaders(
        'POST', target, bodyString, identity.privateKey, identity.publicKey,
    );
    return fetch(target, {
        method: 'POST', headers, body: bodyString, ...(signal ? { signal } : {}),
    });
}

/**
 * A signed GET: a read the node answers only for a member (read auth), signed by the key it is about.
 * Empty body, as for {@link signedDelete}.
 */
export async function signedGet(
    url: string, path: string, identity: BeanPoolIdentity,
): Promise<Response> {
    const target = `${url.replace(/\/+$/, '')}${path}`;
    const headers = await buildSignedHeaders(
        'GET', target, '', identity.privateKey, identity.publicKey,
    );
    return fetch(target, {
        method: 'GET', headers,
    });
}

/**
 * A signed DELETE to the member's own node.
 *
 * The signed message is `${method}\n${path}\n${ts}\n${nonce}\n${body}`, so the verb is part of
 * what is signed — a DELETE route cannot be called with headers built for POST, and the server
 * rejects the mismatch rather than ignoring it. `signedPost` against `router.delete(...)` does
 * not fail loudly either; koa-router simply has no POST at that path, so it 404s.
 *
 * Empty body rather than no body, so the signed body string matches the `''` the server reads
 * for a request that carries none.
 */
export async function signedDelete(
    url: string, path: string, identity: BeanPoolIdentity,
): Promise<Response> {
    const target = `${url.replace(/\/+$/, '')}${path}`;
    const headers = await buildSignedHeaders(
        'DELETE', target, '', identity.privateKey, identity.publicKey,
    );
    return fetch(target, {
        method: 'DELETE', headers,
    });
}

/** How long the member's node has to answer Delete account before the phone stops waiting (PR #1303, 4128119830). */
export const PURGE_TIMEOUT_MS = 20_000;

/** What {@link purgeAccountOnNode} throws when the node doesn't answer in time: nothing on the phone changes. */
export const PURGE_NO_ANSWER =
    "The community didn't answer. You can try again: if it deleted your account meanwhile, trying again finishes " +
    'the delete on this phone.';

/** What it throws for a 2xx that isn't the purge route's `{ ok: true }` (a captive portal, a proxy's page). */
export const PURGE_NOT_CONFIRMED =
    "The community's answer didn't confirm the delete. Try again.";

/**
 * Permanently purge the member's account and data from their community node (#99).
 *
 * Resolves only when the node answers `{ ok: true }`: the route (routes/community.ts, state-engine.ts
 * `purgeMemberSelf`) always answers that way on a delete, and on a retry ("Account is already pruned"). Any other
 * answer throws, a 2xx included: a captive portal or proxy on a plain `http://` address answers 200 with its own page,
 * and a caller that took that for a delete would wipe the key while the account is still on the node (#1303,
 * 4128110186). So does a node that hasn't answered within `timeoutMs` (4128119830): React Native's fetch never gives up
 * by itself, and the screen would wait forever.
 */
export async function purgeAccountOnNode(
    identity: BeanPoolIdentity, timeoutMs: number = PURGE_TIMEOUT_MS,
): Promise<{ ok: true; message: string }> {
    const nodeUrl = await anchorUrl();
    if (!nodeUrl) {
        throw new Error('No community node connection found.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let res: Response;
        let parsed: unknown;
        try {
            res = await signedPost(nodeUrl, '/api/member/purge', { action: 'purge_account' }, identity, controller.signal);
            parsed = await res.json().catch(() => ({}));
        } catch (e) {
            if (controller.signal.aborted) throw new Error(PURGE_NO_ANSWER);
            throw e;
        }
        const json = (parsed && typeof parsed === 'object' ? parsed : {}) as { ok?: unknown; error?: unknown; message?: unknown };
        const text = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
        if (!res.ok) {
            throw new Error(text(json.error) || text(json.message) || `Server returned ${res.status}`);
        }
        if (json.ok !== true) throw new Error(PURGE_NOT_CONFIRMED);
        return { ok: true, message: text(json.message) ?? '' };
    } finally {
        clearTimeout(timer);
    }
}
