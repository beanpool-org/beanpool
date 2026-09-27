/**
 * Which request format each community's server checks (request binding, @beanpool/core request-signing.ts).
 *
 * A server from #1219 on says `requestSigning: 2` in `GET /api/community/info`, and the app signs everything it sends
 * there in format 2: bound to the host it connects to, so the signature is no good at any other community. A server
 * older than that can't read format 2, so a node whose info answered WITHOUT the field gets the old format. A node
 * this phone has not heard from yet gets format 2: that is every node once the release is out, and a hostile node
 * that pretends to be old gains only old-format signatures, which every node refuses after the switch.
 *
 * Kept per host (the name signed for, `audienceOf`), in memory for this run and on each SavedNode for the next
 * (utils/nodes.ts recordRequestSigning / loadSavedRequestSigning). No React Native import here: utils/crypto.ts reads
 * it on every signed request.
 *
 * Only a plain address (node-url.ts `isPlainNodeAddress`) is read or recorded. From any other, iOS reaches a
 * different host than the one `audienceOf` names, and that other node's answer must not change the format used
 * for the named host.
 */

import { audienceOf, REQUEST_SIGNING_VERSION } from '@beanpool/core';
import { isPlainNodeAddress } from './node-url';

/** The host a request to `url` is kept under: null for an address that isn't plain. */
function hostOf(url: string): string | null {
    return isPlainNodeAddress(url) ? audienceOf(url) : null;
}

/** 2: bound to the host. 1: the old, unbound format, for a server that predates format 2. */
export type RequestSigningFormat = 1 | 2;

/** host → what its info answer said (1 when it said nothing). */
const known = new Map<string, number>();
let hydrating: Promise<void> | null = null;

/**
 * What an info answer says about request signing: its `requestSigning` when that is a whole number, otherwise 1 (a
 * server older than format 2 answers without it). Null when the answer isn't an info answer at all, so nothing is
 * recorded from an error page or a proxy's HTML.
 */
export function requestSigningOf(infoBody: unknown): number | null {
    if (!infoBody || typeof infoBody !== 'object' || Array.isArray(infoBody)) return null;
    const v = (infoBody as { requestSigning?: unknown }).requestSigning;
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : 1;
}

/** Remember what the node at `url` said, for this run. Returns the host it was kept under, or null for none. */
export function rememberRequestSigning(url: string, version: number): string | null {
    const host = hostOf(url);
    if (!host) return null;
    known.set(host, version);
    return host;
}

/** What this phone knows the node at `url` said, or undefined when it hasn't asked yet. No network. */
export function knownRequestSigning(url: string): number | undefined {
    const host = hostOf(url);
    return host ? known.get(host) : undefined;
}

/** The format for a request to `url`: the old one only for a node that answered without `requestSigning`. */
export async function requestSigningFormatFor(url: string): Promise<RequestSigningFormat> {
    if (hydrating) await hydrating;
    const said = knownRequestSigning(url);
    return said !== undefined && said < REQUEST_SIGNING_VERSION ? 1 : 2;
}

/**
 * Load what saved nodes recorded on an earlier run (app start). An answer heard in this run wins over the stored one.
 * Requests signed while this runs wait for it, so the first request after a cold start uses the stored answer.
 */
export function hydrateRequestSigning(load: () => Promise<Array<{ url: string; requestSigning?: unknown }>>): Promise<void> {
    const run = (async () => {
        try {
            for (const node of await load()) {
                const host = typeof node.url === 'string' ? hostOf(node.url) : null;
                const v = node.requestSigning;
                if (host && !known.has(host) && typeof v === 'number' && Number.isSafeInteger(v) && v > 0) known.set(host, v);
            }
        } catch {
            // Nothing stored, or unreadable: each node is asked again when the app next reads its info.
        }
    })();
    hydrating = run;
    void run.finally(() => { if (hydrating === run) hydrating = null; });
    return run;
}

/** Tests only: forget everything. */
export function resetRequestSigningForTests(): void {
    known.clear();
    hydrating = null;
}
