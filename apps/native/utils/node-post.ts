/**
 * A signed POST to the member's own node.
 *
 * Extracted from `keeper-enrolment.ts` rather than copied, because the one interesting line in it
 * is a fix that would not survive being retyped: the headers sign `path`, so a stored anchor of
 * `https://node/` sends the request to `https://node//api/...`, the server verifies over
 * `ctx.path`, sees the doubled slash, and every call 401s with nothing to suggest a URL was the
 * cause. Two copies of this function is two chances to lose that.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';

/** The node this member belongs to, or null before one is chosen. */
export async function anchorUrl(): Promise<string | null> {
    return AsyncStorage.getItem('beanpool_anchor_url');
}

export async function signedPost(
    url: string, path: string, body: unknown, identity: BeanPoolIdentity,
): Promise<Response> {
    const bodyString = JSON.stringify(body);
    const headers = await buildSignedHeaders(
        'POST', path, bodyString, identity.privateKey, identity.publicKey,
    );
    // Covered by "does not double the slash when the stored node URL ends in one" in
    // keeper-enrolment.test.ts — through the real call path rather than against a helper, which
    // is what makes it a regression test for this line rather than for a regex.
    return fetch(`${url.replace(/\/+$/, '')}${path}`, {
        method: 'POST', headers, body: bodyString,
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

