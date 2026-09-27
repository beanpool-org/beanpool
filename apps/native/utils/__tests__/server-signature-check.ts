/**
 * The node's own check of a member-signed request, for tests that capture what the app sent (apps/server
 * engine/member-signature.ts, request binding format 2): the signature is over
 * `0xFF ‖ beanpool-request/2\nHOST\nMETHOD\nPATH\nTS\nNONCE\nBODY`, HOST is the host of the URL the request was sent
 * to and must equal X-Signed-For, and PATH is that URL's path without its query. Built from @beanpool/core, the same
 * definition the server verifies with, and nothing from the app, so it can't agree with the app by construction.
 *
 * Self-contained on purpose (@noble/curves, Buffer): a test that mocks ../crypto can still use it.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import { audienceOf, signedPathOf, signedRequestText, signedRequestBytes, SIGNED_FOR_HEADER } from '@beanpool/core';

export interface SentRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.length);

/** Would the node at `req.url` accept this as signed by `publicKey`? */
export function boundSignatureValid(req: SentRequest, publicKey: string): boolean {
    const h = req.headers;
    const host = audienceOf(req.url);
    if (!host || h['X-Public-Key'] !== publicKey || h[SIGNED_FOR_HEADER] !== host) return false;
    const text = signedRequestText({
        host, method: req.method.toUpperCase(), path: signedPathOf(req.url),
        timestamp: h['X-Timestamp'], nonce: h['X-Nonce'], body: req.body ?? '',
    });
    try {
        return ed25519.verify(bytes(Buffer.from(h['X-Signature'], 'base64')), signedRequestBytes(text), bytes(Buffer.from(publicKey, 'hex')));
    } catch {
        return false;
    }
}
