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
    url: string, path: string, body: unknown, identity: BeanPoolIdentity,
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
        method: 'POST', headers, body: bodyString,
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

/**
 * Permanently purge the member's account and data from their community node (#99).
 */
export async function purgeAccountOnNode(identity: BeanPoolIdentity): Promise<{ ok: boolean; message: string }> {
    const nodeUrl = await anchorUrl();
    if (!nodeUrl) {
        throw new Error('No community node connection found.');
    }
    const res = await signedPost(nodeUrl, '/api/member/purge', { action: 'purge_account' }, identity);
    const json = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
        throw new Error(json.error || json.message || `Server returned ${res.status}`);
    }
    return json;
}

