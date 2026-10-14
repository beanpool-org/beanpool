import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { vaultB64 } from '@beanpool/core';
import type { FetchLike } from '@beanpool/signin';
import type { EvidenceChecker } from '../custodian/checker.js';
import { openKeyFile, sealKeyFile } from '../custodian/keyfile.js';
import { custodianKey, NO_HARDWARE_PROOF, presentShare, type CallOptions } from '../custodian/lib.js';
import { unlockBind } from '../shared/ceremony.js';
import { LocalDirectoryFeed } from '../shared/release-feed.js';
import type { HostPolicy, HostPolicyUnknown } from '../shared/release.js';
import { keys3, makeRelease, publish, randomImage } from './release-kit.js';

/**
 * The custodian's tool before a part goes (host design §5.1 item 4 and its tests): the policy only from the newest
 * two-signed release, never from the vault; `tdx` without evidence, or an unknown platform, refused with nothing sent;
 * `none` shows the plain warning and sends only after the custodian confirms. The vault here is a fake that records
 * every request and answers the hello as a test tells it to.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const h = (bytes: number) => 'ab'.repeat(bytes);
const TDX: HostPolicy = { platform: 'tdx', mrtd: [h(48)], googleEndorsementRoot: h(32), rtmr1: h(48), rtmr2: h(48), minTeeTcbSvn: h(16), tcbStatus: ['UpToDate'], debug: false };

interface FakeVault {
    fetch: FetchLike;
    requests: string[];
    nonces: Uint8Array[];
    helloPub: Uint8Array;
    bootId: Uint8Array;
}

/** A vault that answers every hello with `hello` (plus a real hello key and boot id) and 200 to everything else. */
function fakeVault(hello: Record<string, unknown>): FakeVault {
    const helloPub = x25519.getPublicKey(crypto.randomBytes(32));
    const bootId = crypto.randomBytes(16);
    const v: FakeVault = {
        requests: [], nonces: [], helloPub, bootId,
        fetch: async (url, init) => {
            const p = new URL(url).pathname;
            v.requests.push(p);
            if (p.endsWith('/hello')) {
                v.nonces.push(Buffer.from(JSON.parse(String(init?.body)).custodianNonce, 'base64url'));
                return Response.json({ bootId: vaultB64(bootId), helloPub: vaultB64(helloPub), ...hello });
            }
            return Response.json({ state: 'locked', sharesPresent: 1 });
        },
    };
    return v;
}

function setUp(policy: HostPolicy | HostPolicyUnknown = { platform: 'none' }) {
    const root = keys3();
    const feedDir = path.join(dir, `feed-${++n}`);
    const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), hostPolicy: policy });
    publish(feedDir, r1);
    const opts = (extra: Partial<CallOptions> = {}): CallOptions & { outbox: string[] } => ({
        trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys: root.map(k => k.publicKey) }, outbox: [], ...extra,
    });
    return { root, feedDir, r1, opts };
}

const unlock = (v: FakeVault, key: ReturnType<typeof custodianKey>, opts: CallOptions) => presentShare('https://vault.test', key, 'some share words', { ...opts, fetch: v.fetch });

describe('the host policy comes from the newest two-signed release', () => {
    it('tdx with evidence null: refused, and nothing but the hello was sent', async () => {
        const { root, r1, opts } = setUp(TDX);
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'tdx', evidence: null });
        const o = opts({ acceptNoHardwareProof: true });
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'evidence_missing' });
        expect(o.outbox).toEqual([]);
        expect(v.requests).toEqual(['/v1/unlock/hello']);
    });

    it('tdx with evidence but no checker for it yet (V8): refused, nothing sent', async () => {
        const { root, r1, opts } = setUp(TDX);
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'tdx', evidence: vaultB64(crypto.randomBytes(64)) });
        const o = opts();
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'no_checker' });
        expect(o.outbox).toEqual([]);
    });

    it('an unknown platform: refused before the vault is even contacted', async () => {
        const { root, opts } = setUp({ platform: 'quantum-enclave' });
        const v = fakeVault({ platform: 'quantum-enclave', evidence: null });
        const o = opts({ acceptNoHardwareProof: true });
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'unknown_platform' });
        expect(o.outbox).toEqual([]);
        expect(v.requests).toEqual([]);
    });

    it('a policy the vault offers is ignored: the release says tdx, the vault says none and offers a none policy: refused', async () => {
        const { root, r1, opts } = setUp(TDX);
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'none', evidence: null, hostPolicy: { platform: 'none' } });
        const o = opts({ acceptNoHardwareProof: true });
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'platform_mismatch' });
        expect(o.outbox).toEqual([]);
    });

    it('... and the release says none while the vault offers a tdx policy and evidence: still none, with the warning', async () => {
        const { root, r1, opts } = setUp();
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'none', evidence: null, hostPolicy: TDX });
        const asked: string[] = [];
        const o = opts({ confirm: async w => { asked.push(w); return false; } });
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'not_confirmed' });
        expect(asked).toEqual([NO_HARDWARE_PROOF]);
        expect(o.outbox).toEqual([]);
    });

    it('a checker (V8) gets the bind the tool computed from its own nonce, and the part goes only when it passes', async () => {
        const { root, r1, opts } = setUp(TDX);
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'tdx', evidence: vaultB64(Buffer.from('a quote')) });
        const seen: Uint8Array[] = [];
        let pass = false;
        const tdx: EvidenceChecker = {
            platform: 'tdx',
            check: async (policy, evidence, bind) => {
                seen.push(bind);
                expect(policy).toEqual(TDX);
                expect(Buffer.from(evidence).toString()).toBe('a quote');
                return pass ? { ok: true } : { ok: false, reason: 'REPORTDATA is not bind' };
            },
        };
        const refused = opts({ checkers: { tdx } });
        await expect(unlock(v, root[0], refused)).rejects.toMatchObject({ code: 'evidence_refused' });
        expect(refused.outbox).toEqual([]);
        expect(Buffer.from(seen[0]).equals(Buffer.from(unlockBind(v.helloPub, v.bootId, v.nonces[0])))).toBe(true);
        pass = true;
        const accepted = opts({ checkers: { tdx } });
        expect((await unlock(v, root[0], accepted)).status).toBe(200);
        expect(accepted.outbox).toEqual(['/v1/unlock/share']);
        // A fresh nonce for every hello.
        expect(Buffer.from(v.nonces[1]).equals(Buffer.from(v.nonces[0]))).toBe(false);
    });
});

describe('none: the warning, and a part sent only after the custodian confirms', () => {
    it('no confirmation: refused with the plain words; confirmed, or --no-hardware-proof: sent', async () => {
        const { root, r1, opts } = setUp();
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'none', evidence: null });
        const none = opts();
        await expect(unlock(v, root[0], none)).rejects.toThrow(NO_HARDWARE_PROOF);
        expect(none.outbox).toEqual([]);
        const asked: string[] = [];
        const yes = opts({ confirm: async w => { asked.push(w); return true; } });
        expect((await unlock(v, root[0], yes)).status).toBe(200);
        expect(asked).toEqual([NO_HARDWARE_PROOF]);
        expect(yes.outbox).toEqual(['/v1/unlock/share']);
        const flagged = opts({ acceptNoHardwareProof: true });
        expect((await unlock(v, root[0], flagged)).status).toBe(200);
        expect(flagged.outbox).toEqual(['/v1/unlock/share']);
    });
});

describe('the vault\'s release hash', () => {
    it('must be the newest release\'s image; an older one only when named; an unsigned one never', async () => {
        const { root, feedDir, r1, opts } = setUp();
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root.slice(1), image: randomImage() });
        publish(feedDir, r2);
        const old = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'none', evidence: null });
        const o = opts({ acceptNoHardwareProof: true });
        await expect(unlock(old, root[0], o)).rejects.toThrow(/release 1\.0\.0's image, not the newest \(1\.1\.0\)/);
        expect(o.outbox).toEqual([]);
        expect((await unlock(old, root[0], opts({ acceptNoHardwareProof: true, acceptRelease: '1.0.0' }))).status).toBe(200);
        const stranger = fakeVault({ releaseHash: crypto.randomBytes(32).toString('hex'), platform: 'none', evidence: null });
        await expect(unlock(stranger, root[0], opts({ acceptNoHardwareProof: true, acceptRelease: '1.0.0' }))).rejects.toThrow(/no signed release/);
        expect((await unlock(fakeVault({ releaseHash: r2.manifest.imageHash, platform: 'none', evidence: null }), root[0], opts({ acceptNoHardwareProof: true }))).status).toBe(200);
    });

    it('a feed with a fork, or with no release, stops the tool before the vault is contacted', async () => {
        const { root, feedDir, r1, opts } = setUp();
        publish(feedDir, makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root, label: 'a' }));
        publish(feedDir, makeRelease({ version: '1.1.1', previous: r1, custodianKeys: root, signers: root, label: 'b' }));
        const v = fakeVault({ releaseHash: r1.manifest.imageHash, platform: 'none', evidence: null });
        await expect(unlock(v, root[0], opts({ acceptNoHardwareProof: true }))).rejects.toMatchObject({ code: 'chain_fork' });
        const empty = { trust: { feed: new LocalDirectoryFeed(path.join(dir, 'nothing')), rootKeys: root.map(k => k.publicKey) }, acceptNoHardwareProof: true };
        await expect(unlock(v, root[0], empty)).rejects.toMatchObject({ code: 'no_release' });
        await expect(unlock(v, root[0], { acceptNoHardwareProof: true })).rejects.toMatchObject({ code: 'no_trust' });
        expect(v.requests).toEqual([]);
    });
});

describe('the key file', () => {
    it('opens only with its passphrase; the public key is readable without it; a V2 stub file opens and says it is unprotected', () => {
        const key = custodianKey(crypto.randomBytes(32));
        const text = sealKeyFile(key.seed, 'correct horse battery', 2 ** 14);
        expect(JSON.parse(text).publicKey).toBe(key.publicKey);
        expect(text).not.toContain(Buffer.from(key.seed).toString('hex'));
        expect(openKeyFile(text, 'correct horse battery')).toMatchObject({ publicKey: key.publicKey, protectedByPassphrase: true });
        expect(() => openKeyFile(text, 'wrong horse battery')).toThrow(/Wrong passphrase/);
        expect(() => openKeyFile(text, null)).toThrow(/needs its passphrase/);
        expect(openKeyFile(JSON.stringify({ seed: Buffer.from(key.seed).toString('hex') }), null)).toMatchObject({ publicKey: key.publicKey, protectedByPassphrase: false });
    });
});

