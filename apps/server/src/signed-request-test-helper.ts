/**
 * How a server suite signs a request or a socket: the way every client sends today, format 2 (cutover N2b).
 *
 * The bytes are @beanpool/core request-signing.ts (`signedRequestText`, `signedRequestBytes`): 0xFF, then
 * `beanpool-request/2`, the host the request is for, and METHOD, PATH, TIMESTAMP, NONCE and BODY. The request names that
 * host in `X-Signed-For`; a `/ws` connect names it as `for=HOST&v=2`. The suites use these functions and never write the
 * bytes out themselves, so a suite and a phone can't drift apart.
 *
 * The host a suite signs for is `localhost`: a test node knows none of its names, and a node in that state counts a host
 * on this machine as its own (engine/own-addresses.ts audienceStanding). A suite whose node has a name of its own
 * (BEANPOOL_ADDRESSES, a confirmed address, a registrar name) calls {@link setSignedForHost} with that name once it is set,
 * or names the host on one call.
 *
 * Why this file is not named test-*.ts: scripts/test-all.sh requires every such file to be a suite in
 * scripts/server-suites.mjs.
 */

import crypto from 'node:crypto';
import {
    REQUEST_SIGNING_VERSION, SIGNED_FOR_HEADER, adminSigninText, ed25519Signer, settingsSigninText, signedRequestBytes,
    signedRequestText,
} from '@beanpool/core';

export { SIGNED_FOR_HEADER };

/** The host suites sign for unless they name another. */
export const TEST_SIGNED_FOR = 'localhost';

let signedFor = TEST_SIGNED_FOR;

/** The host the next signature is for. */
export function signedForHost(): string {
    return signedFor;
}

/** Sign for `host` from now on (a node with a name of its own); null goes back to {@link TEST_SIGNED_FOR}. */
export function setSignedForHost(host: string | null): void {
    signedFor = host ?? TEST_SIGNED_FOR;
}

export interface TestRequestFields {
    method: string;
    /** The path alone, as the server sees it (`ctx.path`): no query. */
    path: string;
    timestamp: string | number;
    nonce: string;
    /** Exactly the body string sent; '' for none. */
    body?: string;
}

/** The format-2 text of a request, as the server rebuilds it to check a signature. */
export function requestTextFor(f: TestRequestFields, host: string = signedFor): string {
    return signedRequestText({
        host, method: f.method, path: f.path, timestamp: String(f.timestamp), nonce: f.nonce, body: f.body ?? '',
    });
}

/** A member's private key as a suite holds it: a node:crypto key object, or the 32-byte seed the noble curves sign with. */
export type TestSigningKey = crypto.KeyObject | Uint8Array;

/** `bytes` signed with `key` (an Ed25519 signature). */
function signBytes(key: TestSigningKey, bytes: Uint8Array): Buffer {
    if (key instanceof Uint8Array) {
        const signed = ed25519Signer(key)(bytes);
        if (signed instanceof Promise) throw new Error('ed25519Signer answered later than it should');
        return Buffer.from(signed);
    }
    return crypto.sign(null, Buffer.from(bytes), key);
}

/** A request's signature (base64), over the format-2 bytes for `host` (default: {@link signedForHost}). */
export function signRequest(key: TestSigningKey, f: TestRequestFields, host: string = signedFor): string {
    return signBytes(key, signedRequestBytes(requestTextFor(f, host))).toString('base64');
}

/** A `/ws` connect token's signature (base64): method WS, path /ws, no body. */
export function signSocket(key: TestSigningKey, timestamp: string | number, nonce: string, host: string = signedFor): string {
    return signRequest(key, { method: 'WS', path: '/ws', timestamp, nonce }, host);
}

/** How a statement's signature is spelled in its body: the server takes either (verifyStatementSignature). */
export type StatementEncoding = 'hex' | 'base64';

/** A signed statement, as the body that carries it names it: the signature and the host it was signed for. */
export interface SignedStatement {
    signature: string;
    signedFor: string;
}

/**
 * The Manage button's sign-in as today's app signs it (cutover N2c): format 2 over the challenge id alone,
 * `0xFF ‖ beanpool-admin-signin/2\n<host>\n<challengeId>` (core's adminSigninText), never the node's challenge text. Spread
 * it into the body of POST /api/local/admin/auth/verify-challenge, or the params of verifyAndSolveChallenge, beside
 * `challengeId` and `memberPubkey`. One without `signedFor` is an app from before request binding: 426 app_too_old.
 */
export function adminSigninFields(key: TestSigningKey, challengeId: string, host: string = signedFor, encoding: StatementEncoding = 'hex'): SignedStatement {
    return { signature: signBytes(key, signedRequestBytes(adminSigninText(host, challengeId))).toString(encoding), signedFor: host };
}

/**
 * A phone's approval or decline of a Settings sign-in by QR (settings-signin-pairing.ts) as today's app signs it: format
 * 2, `0xFF ‖ beanpool-settings-signin/2\n<host>\n<action>\n<pairingId>\n<shortCode>` (core's settingsSigninText).
 */
export function settingsSigninFields(
    key: TestSigningKey, action: 'approve' | 'decline', pairingId: string, shortCode: string, host: string = signedFor,
    encoding: StatementEncoding = 'base64',
): SignedStatement {
    return {
        signature: signBytes(key, signedRequestBytes(settingsSigninText(host, action, pairingId, shortCode))).toString(encoding),
        signedFor: host,
    };
}

/** The `/ws` query params that name the host a socket's token was signed for, as an `&`-joinable fragment. */
export function socketBinding(host: string = signedFor): string {
    return `for=${encodeURIComponent(host)}&v=${REQUEST_SIGNING_VERSION}`;
}

export interface TestSignedHeadersInput extends Omit<TestRequestFields, 'timestamp' | 'nonce'> {
    publicKeyHex: string;
    key: TestSigningKey;
    /** Defaults to now. */
    timestamp?: string | number;
    /** Defaults to 16 random bytes in hex. */
    nonce?: string;
    /** Defaults to {@link signedForHost}. */
    host?: string;
}

/** The five signed-request headers for a request, in format 2: what a client's fetch wrapper adds. */
export function signedHeaders(input: TestSignedHeadersInput): Record<string, string> {
    const timestamp = String(input.timestamp ?? Date.now());
    const nonce = input.nonce ?? crypto.randomBytes(16).toString('hex');
    const host = input.host ?? signedFor;
    return {
        'X-Public-Key': input.publicKeyHex,
        'X-Signature': signRequest(input.key, { method: input.method, path: input.path, timestamp, nonce, body: input.body }, host),
        'X-Timestamp': timestamp,
        'X-Nonce': nonce,
        [SIGNED_FOR_HEADER]: host,
    };
}
