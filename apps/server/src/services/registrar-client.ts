// Node-side client for the public-address registrar (docs/node-dns-registrar.md).
//
// Signs with the node's persistent Ed25519 identity (data/libp2p_key, via p2p.getPrivateKey) so the
// registrar can bind a <name>.beanpool.org lease to THIS node and re-verify it via /api/attest.
// The signed-request scheme mirrors the Worker's verifier (apps/registrar/src/sign.js):
//   headers x-bp-pubkey (raw Ed25519 pubkey hex) / x-bp-timestamp / x-bp-signature, plus x-bp-proto for any
//   protocol but DEFAULT_PROTO
//   message = `${PROTOCOLS[proto].request}\n${METHOD}\n${pathname}\n${timestamp}\n${bodyText}`
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
// Kept in lockstep with apps/registrar/src/sign.js — change both or neither. src/test-registrar-contract.ts
// signs with this file and verifies with the Worker's own code, and fails when they disagree.
//
// ## Protocol versions (design §5.1, scratch/registrar/DESIGN-2026-09-24-fable.md)
//
// On 2026-09-24 the node changed its signing format alone (#542): the Worker could verify nothing, every signed
// request 401'd and names were freed. A format change is therefore a new version, never an edit of one:
//   1. one PR adds v(n+1) to PROTOCOLS here AND in sign.js — both accept it, nobody sends it yet;
//   2. a later release moves SEND_PROTO to it, once a Worker that accepts it is deployed (the registrar's deploy
//      workflow fails unless the live Worker accepts every key of PROTOCOLS below);
//   3. the old entry goes two releases after that.
// A Worker that doesn't speak SEND_PROTO answers 401 with the protocols it does (accepted_proto), and signedFetch
// retries once under the newest one both sides speak, with a warning. An attestation under a protocol the Worker
// doesn't know is 'unverifiable' there: never evidence against the node.

/**
 * The signing protocols this node speaks: the domain tags of a signed request and of an attestation, per version.
 * Mirror of PROTOCOLS in apps/registrar/src/sign.js. Keep one `vN: { request: '…', attest: '…' },` per line: the
 * registrar's deploy workflow reads the keys from this file (apps/registrar/scripts/deploy-checks.mjs), and the
 * contract test checks that it reads them right.
 */
export const PROTOCOLS = {
    v1: { request: 'beanpool-registrar-request/v1', attest: 'beanpool-node-attest/v1' },
} as const;
export type Proto = keyof typeof PROTOCOLS;
/** What this node signs with. Moves only in a release after a Worker accepting it is live (step 2 above). */
export const SEND_PROTO: Proto = 'v1';
/**
 * The protocol of a request without x-bp-proto, or an attestation without `proto`. v1 predates both, so the node
 * sends neither for it: a v1 request or attestation is byte for byte what it was before versions existed, and any
 * Worker ever deployed verifies it. Must match DEFAULT_PROTO in sign.js.
 */
export const DEFAULT_PROTO: Proto = 'v1';

/** Leading line of a v1 signed node→registrar request. Must match apps/registrar/src/sign.js. */
export const REQUEST_DOMAIN = PROTOCOLS.v1.request;
/** Leading line of a v1 node attestation. Must match apps/registrar/src/sign.js (attestOne verifies it). */
export const ATTEST_DOMAIN = PROTOCOLS.v1.attest;

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

function tags(proto: Proto) {
    if (!Object.hasOwn(PROTOCOLS, proto)) throw new Error(`Unknown registrar signing protocol: ${proto}`);
    return PROTOCOLS[proto];
}
export const requestMessage = (proto: Proto, method: string, path: string, ts: number | string, bodyText: string) =>
    `${tags(proto).request}\n${method}\n${path}\n${ts}\n${bodyText}`;
export const attestMessage = (proto: Proto, nonce: string, ts: number | string) =>
    `${tags(proto).attest}\n${nonce}\n${ts}`;

export interface Attestation { pubkey: string; nonce: string; timestamp: number; signature: string; proto?: Proto }

// Attestation payload the registrar's cron expects at GET /api/attest?nonce=. Names its protocol only when it isn't
// DEFAULT_PROTO.
export async function buildAttestation(nonce: string, proto: Proto = SEND_PROTO): Promise<Attestation> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signHex(attestMessage(proto, nonce, timestamp));
    const attestation: Attestation = { pubkey: nodePubkeyHex(), nonce, timestamp, signature };
    if (proto !== DEFAULT_PROTO) attestation.proto = proto;
    return attestation;
}

// The signature headers of a request signed under `proto`: the node's one request-signing path.
export async function signRequest(method: string, path: string, bodyText: string, proto: Proto = SEND_PROTO): Promise<Record<string, string>> {
    const ts = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
        'x-bp-pubkey': nodePubkeyHex(),
        'x-bp-timestamp': String(ts),
        'x-bp-signature': await signHex(requestMessage(proto, method, path, ts, bodyText)),
    };
    if (proto !== DEFAULT_PROTO) headers['x-bp-proto'] = proto;
    return headers;
}

const protoVersion = (p: string) => Number(p.slice(1)) || 0;

// After a 401: the protocol to sign the retry with, or null for none. Only when the registrar lists the protocols it
// accepts and `sent` isn't one of them (otherwise the signature failed for some other reason, and re-signing won't
// help); then the newest one `spoken` (this node's) and the registrar share.
export function retryProto<P extends string>(sent: string, accepted: unknown, spoken: readonly P[]): P | null {
    if (!Array.isArray(accepted) || accepted.includes(sent)) return null;
    const both = spoken.filter((p) => accepted.includes(p));
    return both.sort((a, b) => protoVersion(b) - protoVersion(a))[0] ?? null;
}

async function sendSigned(method: 'GET' | 'POST', path: string, bodyText: string, proto: Proto): Promise<{ ok: boolean; status: number; data: any }> {
    const headers = await signRequest(method, path, bodyText, proto);
    if (bodyText) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
        const baseUrl = getRegistrarUrl();
        const res = await fetch(`${baseUrl}${path}`, { method, headers, body: bodyText || undefined, signal: controller.signal });
        clearTimeout(timer);
        const data = await res.json().catch(() => ({} as any));
        return { ok: res.ok, status: res.status, data };
    } catch (err: any) {
        clearTimeout(timer);
        if (err.name === 'AbortError') throw new Error('Registrar request timed out after 5s');
        throw err;
    }
}

async function signedFetch(method: 'GET' | 'POST', path: string, body?: any): Promise<any> {
    const bodyText = body ? JSON.stringify(body) : '';
    let res = await sendSigned(method, path, bodyText, SEND_PROTO);
    const retry = res.status === 401 ? retryProto(SEND_PROTO, res.data?.accepted_proto, Object.keys(PROTOCOLS) as Proto[]) : null;
    if (retry) {
        const who = protoVersion(retry) < protoVersion(SEND_PROTO) ? 'the address service is behind this node' : 'this node is behind the address service';
        console.warn(`[registrar] ${who} (it accepts ${res.data.accepted_proto.join(', ')}, not ${SEND_PROTO}); still working on ${retry}`);
        res = await sendSigned(method, path, bodyText, retry);
    }
    const data = res.data;
    if (!res.ok) throw new Error(data.detail ? `${data.error}: ${data.detail}` : (data.error || `Registrar returned ${res.status}`));
    return data;
}

export const claimAddress = (name: string, mode: 'tunnel' | 'direct', origin?: string, contact?: string, communityName?: string) =>
    signedFetch('POST', '/api/registrar/claim', { name, mode, origin, contact, community_name: communityName });
export const updateAddressMetadata = (communityName?: string, contact?: string) =>
    signedFetch('POST', '/api/registrar/update', { community_name: communityName, contact });
export const addressStatus = () => signedFetch('GET', '/api/registrar/status');
export const releaseAddress = () => signedFetch('POST', '/api/registrar/offline', {});
