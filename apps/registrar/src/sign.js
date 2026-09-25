// Ed25519 verification via Workers Web Crypto. Node identity keys are raw 32-byte Ed25519 pubkeys (hex).
//
// Signed-request scheme (node → registrar):
//   headers: x-bp-pubkey (64 hex), x-bp-timestamp (unix seconds), x-bp-signature (128 hex),
//            x-bp-proto (the signing protocol; absent = DEFAULT_PROTO)
//   signed message = `${PROTOCOLS[proto].request}\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}`
// The node signs with its identity key; the registrar binds the claim to that pubkey.
//
// The leading domain tag is what stops the public /api/attest oracle from being used to forge a
// signed request: the attestation is signed under an `attest` tag, this verifier only ever rebuilds a
// message under a `request` tag, and the two can never be byte-equal. Kept in lockstep with the node
// (apps/server/src/services/registrar-client.ts); apps/server/src/test-registrar-contract.ts signs with the
// node's code and verifies with this file, and fails when the two disagree.

const CLOCK_SKEW_S = 300;

// The signing protocols this Worker accepts (design §5.1: scratch/registrar/DESIGN-2026-09-24-fable.md). A format
// change adds v(n+1) here AND to the node's PROTOCOLS in one PR; nodes start sending it (SEND_PROTO) in a later
// release, once this Worker is deployed with it; the old entry goes two releases after that. So both sides accept
// two versions whenever a change is in flight, and it never matters which one deploys first. On 2026-09-24 the
// node changed its tag alone (#542), every signed request 401'd and names were freed: never again.
// Every tag is distinct from every other, request tags from attest tags above all (the contract test checks it).
export const PROTOCOLS = Object.freeze({
    v1: Object.freeze({ request: 'beanpool-registrar-request/v1', attest: 'beanpool-node-attest/v1' }),
});
/** What a request without x-bp-proto, or an attest without `proto`, speaks. Must match the node's DEFAULT_PROTO. */
export const DEFAULT_PROTO = 'v1';
/** Answered by /health and in every 401, so a node can fall back to a protocol this Worker speaks. */
export const ACCEPTED_PROTOS = Object.freeze(Object.keys(PROTOCOLS));
/** v1's tags under their old names. */
export const REQUEST_DOMAIN = PROTOCOLS.v1.request;
export const ATTEST_DOMAIN = PROTOCOLS.v1.attest;

// The protocol a request header or an attest field names: DEFAULT_PROTO when it names none, null when this Worker
// doesn't speak it.
export function protoOf(named) {
    if (named === undefined || named === null) return DEFAULT_PROTO;
    return typeof named === 'string' && Object.hasOwn(PROTOCOLS, named) ? named : null;
}

export const requestMessage = (proto, method, pathname, ts, bodyText) =>
    `${PROTOCOLS[proto].request}\n${method}\n${pathname}\n${ts}\n${bodyText || ''}`;
export const attestMessage = (proto, nonce, ts) => `${PROTOCOLS[proto].attest}\n${nonce}\n${ts}`;

// The protocol of a request verifySignedRequest accepted (its x-bp-proto, or the default).
export const requestProto = (request) => protoOf(request.headers.get('x-bp-proto'));

function hexToBytes(hex) {
    if (typeof hex !== 'string' || hex.length % 2) return null;
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        const b = parseInt(hex.substr(i * 2, 2), 16);
        if (Number.isNaN(b)) return null;
        out[i] = b;
    }
    return out;
}

export async function verifyEd25519(pubkeyHex, message, signatureHex) {
    if (!/^[0-9a-f]{64}$/i.test(pubkeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) return false;
    const pub = hexToBytes(pubkeyHex), sig = hexToBytes(signatureHex);
    if (!pub || !sig) return false;
    try {
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, new TextEncoder().encode(message));
    } catch {
        return false;
    }
}

// Verify a signed node request under the protocol it names. Returns the signer pubkey (hex) on success, else null —
// also for a protocol this Worker doesn't speak.
export async function verifySignedRequest(request, bodyText) {
    const proto = requestProto(request);
    if (!proto) return null;
    const pubkey = request.headers.get('x-bp-pubkey') || '';
    const ts = request.headers.get('x-bp-timestamp') || '';
    const sig = request.headers.get('x-bp-signature') || '';
    if (!/^\d+$/.test(ts)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(ts, 10)) > CLOCK_SKEW_S) return null;
    const url = new URL(request.url);
    const message = requestMessage(proto, request.method, url.pathname, ts, bodyText);
    return (await verifyEd25519(pubkey, message, sig)) ? pubkey.toLowerCase() : null;
}
