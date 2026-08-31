// Ed25519 verification via Workers Web Crypto. Node identity keys are raw 32-byte Ed25519 pubkeys (hex).
//
// Signed-request scheme (node → registrar):
//   headers: x-bp-pubkey (64 hex), x-bp-timestamp (unix seconds), x-bp-signature (128 hex)
//   signed message = `${REQUEST_DOMAIN}\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}`
// The node signs with its identity key; the registrar binds the claim to that pubkey.
//
// The leading domain tag is what stops the public /api/attest oracle from being used to forge a
// signed request: the attestation is signed under ATTEST_DOMAIN, this verifier only ever rebuilds a
// message under REQUEST_DOMAIN, and the two can never be byte-equal. Kept in lockstep with the node
// (apps/server/src/services/registrar-client.ts).

const CLOCK_SKEW_S = 300;
/** Must match REQUEST_DOMAIN in the node's registrar-client.ts. */
export const REQUEST_DOMAIN = 'beanpool-registrar-request/v1';
/** Must match ATTEST_DOMAIN in the node's registrar-client.ts. */
export const ATTEST_DOMAIN = 'beanpool-node-attest/v1';

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

// Verify a signed node request. Returns the signer pubkey (hex) on success, else null.
export async function verifySignedRequest(request, bodyText) {
    const pubkey = request.headers.get('x-bp-pubkey') || '';
    const ts = request.headers.get('x-bp-timestamp') || '';
    const sig = request.headers.get('x-bp-signature') || '';
    if (!/^\d+$/.test(ts)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(ts, 10)) > CLOCK_SKEW_S) return null;
    const url = new URL(request.url);
    const message = `${REQUEST_DOMAIN}\n${request.method}\n${url.pathname}\n${ts}\n${bodyText || ''}`;
    return (await verifyEd25519(pubkey, message, sig)) ? pubkey.toLowerCase() : null;
}
