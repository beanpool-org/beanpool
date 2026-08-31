// Node-side client for the public-address registrar (docs/node-dns-registrar.md).
//
// Signs with the node's persistent Ed25519 identity (data/libp2p_key, via p2p.getPrivateKey) so the
// registrar can bind a <name>.beanpool.org lease to THIS node and re-verify it via /api/attest.
// The signed-request scheme mirrors the Worker's verifier (apps/registrar/src/sign.js):
//   headers x-bp-pubkey (raw Ed25519 pubkey hex) / x-bp-timestamp / x-bp-signature
//   message = `${REQUEST_DOMAIN}\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}`
//
// ## Domain separation — why the first line is a constant
//
// The node signs two different things with the SAME identity key: a signed request (above) and a
// public attestation over a registrar-supplied nonce (`buildAttestation`). `/api/attest` is public
// and its nonce was attacker-controlled, so without separation an attacker could ask the oracle to
// sign `POST\n/api/registrar/offline\n<ts>` — a string that IS a valid signed-request message — and
// replay the result to take any node's public domain offline. Each message now begins with a
// distinct domain tag, so a signature produced for one context can never reconstruct as the other:
// the verifier rebuilds its own message with its own leading tag, and the first bytes never match.
// Kept in lockstep with apps/registrar/src/sign.js — change both or neither.

/** Leading line of a signed node→registrar request. Must match apps/registrar/src/sign.js. */
export const REQUEST_DOMAIN = 'beanpool-registrar-request/v1';
/** Leading line of a node attestation. Must match apps/registrar/src/index.js (attestOne). */
export const ATTEST_DOMAIN = 'beanpool-node-attest/v1';

import { getPrivateKey } from '../p2p.js';
import { publicKeyToProtobuf } from '@libp2p/crypto/keys';

const getRegistrarUrl = () => (process.env.REGISTRAR_URL || 'https://beanpool.org').replace(/\/$/, '');

function key(): any {
    const k = getPrivateKey();
    if (!k) throw new Error('Node identity not ready');
    return k;
}

// Raw 32-byte Ed25519 public key as hex — what the registrar's Web-Crypto verify imports ('raw').
export function nodePubkeyHex(): string {
    const k = key();
    const raw: Uint8Array = k.publicKey?.raw
        ?? publicKeyToProtobuf(k.publicKey).slice(-32); // fallback: strip libp2p protobuf header (…12 20 <32>)
    return Buffer.from(raw).toString('hex');
}

async function signHex(message: string): Promise<string> {
    const sig: Uint8Array = await key().sign(new TextEncoder().encode(message));
    return Buffer.from(sig).toString('hex');
}

// Attestation payload the registrar's cron expects at GET /api/attest?nonce=.
export async function buildAttestation(nonce: string): Promise<{ pubkey: string; nonce: string; timestamp: number; signature: string }> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signHex(`${ATTEST_DOMAIN}\n${nonce}\n${timestamp}`);
    return { pubkey: nodePubkeyHex(), nonce, timestamp, signature };
}

async function signedFetch(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
    const bodyText = body ? JSON.stringify(body) : '';
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
        'x-bp-pubkey': nodePubkeyHex(),
        'x-bp-timestamp': String(ts),
        'x-bp-signature': await signHex(`${REQUEST_DOMAIN}\n${method}\n${path}\n${ts}\n${bodyText}`),
    };
    if (body) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const baseUrl = getRegistrarUrl();
        const res = await fetch(`${baseUrl}${path}`, { method, headers, body: bodyText || undefined, signal: controller.signal });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({} as any));
        if (!res.ok) throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error || `Registrar returned ${res.status}`));
        return data;
    } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Registrar request timed out after 5s');
        throw err;
    }
}

export const claimAddress = (name: string, mode: 'tunnel' | 'direct', origin?: string, contact?: string, communityName?: string) =>
    signedFetch('POST', '/api/registrar/claim', { name, mode, origin, contact, community_name: communityName });
export const updateAddressMetadata = (communityName?: string, contact?: string) =>
    signedFetch('POST', '/api/registrar/update', { community_name: communityName, contact });
export const addressStatus = () => signedFetch('GET', '/api/registrar/status');
export const releaseAddress = () => signedFetch('POST', '/api/registrar/offline', {});
