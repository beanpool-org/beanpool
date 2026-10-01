import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { buildBoundRequestHeaders, ed25519Signer, vaultB64, vaultUnb64 } from '@beanpool/core';
import type { FetchLike } from '@beanpool/signin';
import {
    buildConfirmation,
    buildShareSubmission,
    cancelStatement,
    genesisStatement,
    openCustodianShare,
    restoreStatement,
    signStatement,
    unlockBind,
    type CustodianShare,
    type UnlockHello,
} from '../shared/ceremony.js';
import type { ReleaseFeed } from '../shared/release-feed.js';
import { KNOWN_PLATFORMS, resolveChain, type ReleaseChain, type TrustedRelease } from '../shared/release.js';
import { checkHost, type EvidenceChecker } from './checker.js';

export { NO_HARDWARE_PROOF } from './checker.js';

/**
 * A custodian's side of the ceremonies, over HTTP (key vault design §2.2; host design §5.1 item 4). Before any part,
 * or any request that makes or takes shares (genesis, a restore from backup), goes to the vault:
 *
 *   1. the releases are read from the feed and walked from the pinned genesis keys (release.ts); the newest two-signed
 *      release is the one in force. A feed with no release, a fork, or a signed-but-malformed release: nothing is sent;
 *   2. the hello, with a fresh 32-byte nonce; `bind` is computed here from what comes back;
 *   3. the vault's `releaseHash` (the image it booted) must be that release's `imageHash`, or the one a custodian named
 *      with `acceptRelease` (an older release still in the chain, while a new image waits for its restart);
 *   4. the host is checked against that release's `hostPolicy` (checker.ts), never against anything the vault offers;
 *   5. under `none`, {@link NO_HARDWARE_PROOF} is shown and the custodian must confirm (or have passed
 *      `--no-hardware-proof`).
 *
 * Every request sent after those checks goes through the outbox, so a test can see that a refused check sent nothing.
 * The release check catches mistakes (an image nobody signed, an old one still running), not a hostile host, which can
 * answer with any hash it likes: on `none` only the reinstall-before-unlock rule and the split hosting login guard
 * against that (design §2.2, §2.5).
 */

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

/** Where the releases come from, and the keys they are checked from (the vault's genesis custodians). */
export interface ReleaseTrust {
    feed: ReleaseFeed;
    rootKeys: readonly string[];
}

/** How a call is made: `fetch` and `now` for tests (the vault checks a request's time against its own clock). */
export interface CallOptions {
    fetch?: FetchLike;
    now?: () => number;
    /** The releases to check the vault against. Required for every ceremony that says hello. */
    trust?: ReleaseTrust;
    /** Accept the vault running this older release (its version), still in the chain; otherwise only the newest. */
    acceptRelease?: string;
    /** The custodian has read {@link NO_HARDWARE_PROOF} and goes on (`--no-hardware-proof`). */
    acceptNoHardwareProof?: boolean;
    /** Asked when there is no hardware proof and it wasn't accepted up front: true sends. */
    confirm?: (warning: string) => Promise<boolean>;
    /** Every request sent after the checks: its path. */
    outbox?: string[];
    /** A checker per confidential platform (V8); none today. */
    checkers?: Partial<Record<string, EvidenceChecker>>;
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

/** A request that carries something of a ceremony: into the outbox, then out. */
function send(baseUrl: string, path: string, body: unknown, key: CustodianKey, opts: CallOptions): Promise<CustodianCall> {
    opts.outbox?.push(path);
    return signedPost(baseUrl, path, body, key, opts);
}

export class CustodianRefusal extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
        this.name = 'CustodianRefusal';
    }
}

function refuse(code: string, message: string): never {
    throw new CustodianRefusal(code, message);
}

/** The chain from the feed, and the release in force: its newest. */
export async function loadReleases(trust: ReleaseTrust): Promise<{ chain: ReleaseChain; newest: TrustedRelease }> {
    let files;
    try {
        files = await trust.feed.list();
    } catch (e) {
        refuse('feed_unreadable', `The release feed could not be read (${(e as Error).message}). Nothing was sent.`);
    }
    const chain = resolveChain(files, trust.rootKeys);
    if (chain.stopped) {
        refuse(`chain_${chain.stopped.reason}`, `The releases can't be trusted past ${chain.newest?.manifest.version ?? 'the first'}: ${chain.stopped.detail}. Nothing was sent; tell the other custodians.`);
    }
    if (!chain.newest) refuse('no_release', 'The feed has no release signed by two of the vault\'s custodians. Nothing was sent.');
    return { chain, newest: chain.newest };
}

export interface HelloResult {
    hello: UnlockHello;
    bind: Uint8Array;
    /** The release the vault is running (the newest, or the one accepted). */
    release: TrustedRelease;
    /** Set when there is no hardware proof: the words the custodian confirmed. */
    warning: string | null;
}

/**
 * Steps 1 to 5 above. Throws {@link CustodianRefusal} (having sent nothing but the hello) when any check fails or the
 * custodian doesn't confirm.
 */
export async function checkedHello(baseUrl: string, key: CustodianKey, path: string, opts: CallOptions): Promise<HelloResult> {
    if (!opts.trust) refuse('no_trust', 'No release feed and pinned keys to check the vault against. Nothing was sent.');
    const { chain, newest } = await loadReleases(opts.trust);
    const platform = newest.manifest.hostPolicy.platform;
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
        refuse('unknown_platform', `The release names a host platform this tool doesn't know (${platform}). Nothing was sent: update the tool.`);
    }
    const nonce = crypto.randomBytes(32);
    const res = await signedPost(baseUrl, path, { custodianNonce: vaultB64(nonce) }, key, opts);
    if (res.status !== 200) refuse('hello_refused', `The hello was refused (${res.status}): ${String(res.body.error ?? '')}`);
    const hello = res.body as unknown as UnlockHello;
    const helloPub = vaultUnb64(hello.helloPub, 32);
    const bootId = vaultUnb64(hello.bootId, 16);
    if (!helloPub || helloPub.length !== 32 || !bootId || bootId.length !== 16) refuse('bad_hello', 'The hello is malformed. Nothing was sent.');
    const bind = unlockBind(helloPub, bootId, nonce);

    let release = newest;
    if (hello.releaseHash !== newest.manifest.imageHash) {
        const accepted = opts.acceptRelease ? chain.releases.find(r => r.manifest.version === opts.acceptRelease) : undefined;
        if (!accepted || hello.releaseHash !== accepted.manifest.imageHash) {
            const older = chain.releases.find(r => r.manifest.imageHash === hello.releaseHash);
            refuse('release_mismatch', older
                ? `The vault runs release ${older.manifest.version}'s image, not the newest (${newest.manifest.version}). Nothing was sent. If that is expected (a new image waits for its restart), run again with --accept-release ${older.manifest.version}.`
                : `The vault runs an image that is no signed release (${String(hello.releaseHash).slice(0, 16)}…). Nothing was sent. Reinstall it from the signed image before anyone unlocks.`);
        }
        release = accepted;
    }
    // The host policy comes from the newest release, whatever the vault's hello carries besides.
    const host = await checkHost(newest.manifest.hostPolicy, hello, bind, opts.checkers);
    if (!host.ok) refuse(host.code, host.reason);
    if (host.warning && !opts.acceptNoHardwareProof) {
        const yes = opts.confirm ? await opts.confirm(host.warning) : false;
        if (!yes) refuse('not_confirmed', `${host.warning} Nothing was sent (confirm, or pass --no-hardware-proof, to go on).`);
    }
    return { hello, bind, release, warning: host.warning };
}

export async function genesis(baseUrl: string, key: CustodianKey, opts: CallOptions = {}): Promise<CustodianCall> {
    const h = await checkedHello(baseUrl, key, '/v1/unlock/hello', opts);
    const sig = signStatement(key.seed, genesisStatement(h.hello.bootId, h.hello.helloPub));
    return send(baseUrl, '/v1/unlock/genesis', { sig }, key, opts);
}

/** Present this custodian's share: `share` as genesis or a reshare handed it out, or the share's words. */
export async function presentShare(baseUrl: string, key: CustodianKey, share: CustodianShare | string, opts: CallOptions & {
    purpose?: 'unlock' | 'reshare'; newCustodians?: string[];
} = {}): Promise<CustodianCall> {
    const purpose = opts.purpose ?? 'unlock';
    const prefix = purpose === 'unlock' ? '/v1/unlock' : '/v1/reshare';
    const h = await checkedHello(baseUrl, key, `${prefix}/hello`, opts);
    const mnemonic = typeof share === 'string' ? share : openCustodianShare(share, key.seed);
    const submission = buildShareSubmission({ mnemonic, purpose, hello: h.hello, custodianSeed: key.seed, newCustodians: opts.newCustodians });
    return send(baseUrl, `${prefix}/share`, { submission }, key, opts);
}

/** Point a fresh vault at a backup; two custodians then unlock it with that backup's shares. */
export async function restoreFromBackup(baseUrl: string, key: CustodianKey, backup: string, opts: CallOptions = {}): Promise<CustodianCall> {
    const h = await checkedHello(baseUrl, key, '/v1/unlock/hello', opts);
    const sig = signStatement(key.seed, restoreStatement(h.hello.bootId, h.hello.helloPub, backup));
    return send(baseUrl, '/v1/unlock/restore', { backup, sig }, key, opts);
}

/**
 * After a genesis or a reshare: show the vault this custodian holds their new share (open it, sign a check of its
 * words). The vault switches to the new shares at two. Send it only once the share is saved where it will be kept.
 * No part goes: a check of the words, which gives nothing of them away.
 */
export async function confirmShare(baseUrl: string, key: CustodianKey, share: CustodianShare, opts: CallOptions = {}): Promise<CustodianCall> {
    return send(baseUrl, '/v1/unlock/confirm', { confirmation: buildConfirmation(share, key.seed) }, key, opts);
}

/** This custodian's new share of the genesis or reshare waiting, again (a lost answer), while the vault still has it. */
export async function fetchPendingShare(baseUrl: string, key: CustodianKey, opts: CallOptions = {}): Promise<{ call: CustodianCall; share: CustodianShare | null }> {
    const call = await signedPost(baseUrl, '/v1/unlock/pending', {}, key, opts);
    return { call, share: call.status === 200 ? (call.body.share as CustodianShare | null) : null };
}

/**
 * Send the vault's operator settings (shared/settings.ts: the off-box store, the alert channels). They take effect
 * when two custodians have sent the same. They hold secrets (the store's key, the mail password), so the release and
 * host checks come first, as before a share: through the hello a locked or fresh vault answers, or an open one's.
 */
export async function sendSettings(baseUrl: string, key: CustodianKey, settings: unknown, opts: CallOptions = {}): Promise<CustodianCall> {
    try {
        await checkedHello(baseUrl, key, '/v1/unlock/hello', opts);
    } catch (e) {
        if (!(e instanceof CustodianRefusal) || e.code !== 'hello_refused' || !/\(409\)/.test(e.message)) throw e;
        await checkedHello(baseUrl, key, '/v1/reshare/hello', opts);
    }
    return send(baseUrl, '/v1/unlock/settings', { settings }, key, opts);
}

/** The backups the vault can see by name: its own, and the off-box store's (or why that couldn't be listed). */
export async function listBackups(baseUrl: string, key: CustodianKey, opts: CallOptions = {}): Promise<CustodianCall> {
    return signedPost(baseUrl, '/v1/unlock/backups', {}, key, opts);
}

/** Drop the genesis or reshare waiting (`pendingId`, from its answer or the pending call). Two current custodians must. */
export async function cancelPending(baseUrl: string, key: CustodianKey, pendingId: string, opts: CallOptions = {}): Promise<CustodianCall> {
    const sig = signStatement(key.seed, cancelStatement(pendingId));
    return send(baseUrl, '/v1/unlock/cancel', { cancel: { custodian: key.publicKey, pendingId, sig } }, key, opts);
}
