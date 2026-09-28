import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildBoundRequestHeaders, ed25519Signer, vaultB64, vaultUnb64 } from '@beanpool/core';
import type { FetchLike } from '@beanpool/signin';
import {
    buildShareSubmission,
    genesisStatement,
    openCustodianShare,
    restoreStatement,
    signStatement,
    unlockBind,
    type CustodianShare,
    type UnlockHello,
} from '../shared/ceremony.js';

/**
 * A custodian's side of the ceremonies, over HTTP: enough for the tests and for a rehearsal. V3 makes the real tool
 * (a passphrase on the key file, the release check against the two-signed manifest, the host policy).
 *
 * What this stub already does as the real one must: a fresh nonce per hello, `bind` computed on the custodian's side,
 * the share sealed to this boot's hello key and signed, and, when the vault reports no hardware proof, the plain words
 * {@link NO_HARDWARE_PROOF}, with nothing sent unless the caller has accepted them.
 */

export const NO_HARDWARE_PROOF = 'This vault\'s host can read its memory. There is no hardware proof of what it runs.';

export interface CustodianKey {
    seed: Uint8Array;
    publicKey: string;
}

export function custodianKey(seed: Uint8Array): CustodianKey {
    return { seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}

export function newCustodianKey(): CustodianKey {
    return custodianKey(crypto.randomBytes(32));
}

export interface CustodianCall {
    status: number;
    body: Record<string, unknown>;
}

/** How a call is made: `fetch` and `now` for tests (the vault checks a request's time against its own clock). */
export interface CallOptions {
    fetch?: FetchLike;
    now?: () => number;
    /** The custodian has read {@link NO_HARDWARE_PROOF} and goes on. */
    acceptNoHardwareProof?: boolean;
}

export async function signedPost(baseUrl: string, path: string, body: unknown, key: CustodianKey, opts: CallOptions = {}): Promise<CustodianCall> {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const text = JSON.stringify(body);
    const headers = await buildBoundRequestHeaders({
        method: 'POST', url, body: text, publicKeyHex: key.publicKey, sign: ed25519Signer(key.seed), timestamp: opts.now?.(),
    });
    const fetchFn: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    const res = await fetchFn(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: text });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
}

export interface HelloResult {
    hello: UnlockHello;
    bind: Uint8Array;
    /** Set when the vault offers no hardware proof: the words the custodian must accept before a share goes. */
    warning: string | null;
}

/** The hello, with a fresh 32-byte nonce, and `bind` computed here from what came back. */
export async function fetchHello(baseUrl: string, key: CustodianKey, path = '/v1/unlock/hello', opts: CallOptions = {}): Promise<HelloResult> {
    const nonce = crypto.randomBytes(32);
    const res = await signedPost(baseUrl, path, { custodianNonce: vaultB64(nonce) }, key, opts);
    if (res.status !== 200) throw new Error(`hello refused (${res.status}): ${String(res.body.error ?? '')}`);
    const hello = res.body as unknown as UnlockHello;
    const helloPub = vaultUnb64(hello.helloPub, 32);
    const bootId = vaultUnb64(hello.bootId, 16);
    if (!helloPub || helloPub.length !== 32 || !bootId || bootId.length !== 16) throw new Error('The hello is malformed.');
    if (hello.platform !== 'none') throw new Error(`This tool does not check ${hello.platform} evidence yet (V3/V8): nothing sent.`);
    return { hello, bind: unlockBind(helloPub, bootId, nonce), warning: hello.evidence === null ? NO_HARDWARE_PROOF : null };
}

function requireAccepted(h: HelloResult, acceptNoHardwareProof: boolean): void {
    if (h.warning && !acceptNoHardwareProof) throw new Error(`${h.warning} Nothing was sent (pass --no-hardware-proof to go on).`);
}

export async function genesis(baseUrl: string, key: CustodianKey, opts: CallOptions = {}): Promise<CustodianCall> {
    const h = await fetchHello(baseUrl, key, '/v1/unlock/hello', opts);
    requireAccepted(h, opts.acceptNoHardwareProof ?? false);
    const sig = signStatement(key.seed, genesisStatement(h.hello.bootId, h.hello.helloPub));
    return signedPost(baseUrl, '/v1/unlock/genesis', { sig }, key, opts);
}

/** Present this custodian's share: `share` as genesis or a reshare handed it out, or the share's words. */
export async function presentShare(baseUrl: string, key: CustodianKey, share: CustodianShare | string, opts: CallOptions & {
    purpose?: 'unlock' | 'reshare'; newCustodians?: string[];
} = {}): Promise<CustodianCall> {
    const purpose = opts.purpose ?? 'unlock';
    const prefix = purpose === 'unlock' ? '/v1/unlock' : '/v1/reshare';
    const h = await fetchHello(baseUrl, key, `${prefix}/hello`, opts);
    requireAccepted(h, opts.acceptNoHardwareProof ?? false);
    const mnemonic = typeof share === 'string' ? share : openCustodianShare(share, key.seed);
    const submission = buildShareSubmission({ mnemonic, purpose, hello: h.hello, custodianSeed: key.seed, newCustodians: opts.newCustodians });
    return signedPost(baseUrl, `${prefix}/share`, { submission }, key, opts);
}

/** Point a fresh vault at a backup; two custodians then unlock it with that backup's shares. */
export async function restoreFromBackup(baseUrl: string, key: CustodianKey, backup: string, opts: CallOptions = {}): Promise<CustodianCall> {
    const h = await fetchHello(baseUrl, key, '/v1/unlock/hello', opts);
    requireAccepted(h, opts.acceptNoHardwareProof ?? false);
    const sig = signStatement(key.seed, restoreStatement(h.hello.bootId, h.hello.helloPub, backup));
    return signedPost(baseUrl, '/v1/unlock/restore', { backup, sig }, key, opts);
}
