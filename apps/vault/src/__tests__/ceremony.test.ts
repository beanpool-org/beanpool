import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { vaultB64 } from '@beanpool/core';
import { confirmShare, fetchHello, fetchPendingShare, genesis, NO_HARDWARE_PROOF, presentShare, signedPost, type CustodianKey } from '../custodian/lib.js';
import { PENDING_FILE } from '../keyholder/keys.js';
import { combineMnemonics, decodeShare, splitMasterSecret } from '../keyholder/slip39.js';
import { buildShareSubmission, openCustodianShare, sealCustodianShare, unlockBind, type CustodianShare } from '../shared/ceremony.js';
import { confirmWith, doGenesis, get, newMember, scan, signed, startVault, unlockWith, type VaultUnderTest } from './harness.js';

/**
 * Genesis, the locked state and the 2-of-3 unlock (key vault design §2; V2's "Locked" and "After unlock" tests),
 * and the hello's binding (host design §5.1).
 */

let v: VaultUnderTest | null = null;

function stranger(): CustodianKey {
    const seed = crypto.randomBytes(32);
    return { seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') };
}

afterEach(async () => {
    await v?.close();
    v = null;
});

/** Every route but health and unlock/*, with a body shaped like a real one. */
const GATED: [string, string][] = [
    ['POST', '/v1/ticket'], ['POST', '/v1/github/start'], ['POST', '/v1/github/poll'], ['POST', '/v1/copies'],
    ['POST', '/v1/copies/status'], ['POST', '/v1/copies/delete'], ['POST', '/v1/push-token'], ['POST', '/v1/restore'],
    ['POST', '/v1/restore/collect'], ['POST', '/v1/holds/cancel'], ['POST', '/v1/holds/approve'], ['GET', '/v1/report'],
    ['POST', '/v1/reshare/hello'], ['POST', '/v1/reshare/share'],
];

async function expectAllGated(vault: VaultUnderTest): Promise<void> {
    const member = newMember();
    for (const [method, p] of GATED) {
        const r = method === 'GET' ? await get(vault, p) : await signed(vault, p, { purpose: 'deposit', provider: 'google' }, member.seed);
        expect({ route: p, status: r.status, body: r.body }).toMatchObject({ route: p, status: 503, body: { locked: true } });
    }
}

describe('the hello', () => {
    it('binds a fixed test vector: SHA-512("beanpool-vault-unlock-v1" ‖ helloPub ‖ bootId ‖ custodianNonce)', () => {
        // Computed independently (Python hashlib) from these bytes.
        const helloPub = Uint8Array.from({ length: 32 }, (_, i) => i);
        const bootId = Uint8Array.from({ length: 16 }, (_, i) => 0x40 + i);
        const nonce = Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i);
        expect(Buffer.from(unlockBind(helloPub, bootId, nonce)).toString('hex')).toBe(
            'addb5ac1516b935b79d2eb18503d99be2ed98410831d73fb4df110c95eee0aac738f820c77b8dd694cb11b58b227fef94b1de0cd5c333887a5efb830765044c2');
    });

    it('answers {bootId, helloPub, releaseHash, platform: none, evidence: null}, and the tool refuses to send until the warning is accepted', async () => {
        v = await startVault();
        const h = await fetchHello(v.baseUrl, v.custodians[0], '/v1/unlock/hello', v.call());
        expect(Object.keys(h.hello).sort()).toEqual(['bootId', 'evidence', 'helloPub', 'platform', 'releaseHash']);
        expect(h.hello).toMatchObject({ platform: 'none', evidence: null });
        expect(h.bind).toHaveLength(64);
        expect(h.warning).toBe(NO_HARDWARE_PROOF);
        await expect(genesis(v.baseUrl, v.custodians[0], { now: v.clock.now })).rejects.toThrow(/no hardware proof/);
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
    });

    it('is refused to a key that is not a custodian', async () => {
        v = await startVault();
        const r = await signedPost(v.baseUrl, '/v1/unlock/hello', { custodianNonce: vaultB64(crypto.randomBytes(32)) }, stranger(), v.call());
        expect(r.status).toBe(403);
    });
});

describe('genesis, lock and unlock', () => {
    it('before genesis and after a restart every route but health and unlock answers 503 {locked: true}', async () => {
        v = await startVault();
        expect((await get(v, '/v1/health')).body).toMatchObject({ state: 'locked' });
        await expectAllGated(v);

        const g = await doGenesis(v);
        expect(g.shares.map(s => s.custodian)).toEqual(v.custodians.map(c => c.publicKey));
        expect((await get(v, '/v1/health')).body.state).toBe('open');

        await v.restartKeyholder();
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        await expectAllGated(v);
    });

    it('each share opens only with its own custodian\'s key, and is a 33-word SLIP-0039 share of a 2-of-3 split', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        const words = g.shares.map((s, i) => openCustodianShare(s, v!.custodians[i].seed));
        for (const w of words) expect(decodeShare(w)).toMatchObject({ memberThreshold: 2, groupThreshold: 1 });
        expect(() => openCustodianShare(g.shares[0], v!.custodians[1].seed)).toThrow();
    });

    it('one share leaves it locked; a share from an unknown key is ignored; a wrong M stays locked and says so; two right shares open it', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        await v.restartKeyholder();

        const [first] = await unlockWith(v, g.shares, [0]);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ state: 'locked', sharesPresent: 1, threshold: 2 });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');

        // A key that isn't a custodian: refused at the API's door (its hello, its share), and by the keyholder itself
        // when handed one directly. The one share already given still stands.
        const otherSplit = splitMasterSecret(crypto.randomBytes(32), { threshold: 2, count: 3, iterationExponent: 0 });
        const outsider = stranger();
        await expect(presentShare(v.baseUrl, outsider, otherSplit[0], v.call())).rejects.toThrow(/403/);
        const hello = await v.keyholder().hello(vaultB64(crypto.randomBytes(32)));
        const forged = buildShareSubmission({ mnemonic: otherSplit[0], purpose: 'unlock', hello, custodianSeed: outsider.seed });
        const atDoor = await signedPost(v.baseUrl, '/v1/unlock/share', { submission: forged }, outsider, v.call());
        expect(atDoor.status).toBe(403);
        expect(() => v!.keyholder().submitShare(forged)).toThrow(expect.objectContaining({ code: 'unknown_custodian' }));
        expect(v.keyholder().status().sharesPresent).toBe(1);
        expect((await get(v, '/v1/health')).body.state).toBe('locked');

        // Two shares of another split, from the real custodians: they combine, to the wrong M.
        await v.restartKeyholder();
        const wrong1 = await presentShare(v.baseUrl, v.custodians[0], otherSplit[0], v.call());
        const wrong2 = await presentShare(v.baseUrl, v.custodians[1], otherSplit[1], v.call());
        expect(wrong1.body).toMatchObject({ state: 'locked', sharesPresent: 1 });
        expect(wrong2.status).toBe(200);
        expect(wrong2.body).toMatchObject({ state: 'locked', error: 'wrong_m' });
        expect(v.keyholder().status()).toMatchObject({ state: 'locked', lastError: 'wrong_m', sharesPresent: 0 });

        const opened = await unlockWith(v, g.shares, [2, 1]);
        expect(opened[1].body).toMatchObject({ state: 'open' });
        expect((await get(v, '/v1/health')).body.state).toBe('open');
    });

    it('a share sealed for another boot does not open at this one', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        await v.restartKeyholder();
        const words = openCustodianShare(g.shares[0], v.custodians[0].seed);
        const stale = buildShareSubmission({
            mnemonic: words, purpose: 'unlock', custodianSeed: v.custodians[0].seed,
            hello: { bootId: vaultB64(crypto.randomBytes(16)), helloPub: vaultB64(crypto.randomBytes(32)) },
        });
        const r = await signedPost(v.baseUrl, '/v1/unlock/share', { submission: stale }, v.custodians[0], v.call());
        expect(r.status).toBe(403);
        expect(v.keyholder().status().sharesPresent).toBe(0);
    });

    it('after the unlock no share, no M and no hello-sealed share is anywhere on disk', async () => {
        v = await startVault();
        const g = await doGenesis(v);
        const member = newMember();
        // Some data, so the database and the state are both real.
        await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, member.seed);
        await v.restartKeyholder();
        await unlockWith(v, g.shares, [0, 2]);
        expect((await get(v, '/v1/health')).body.state).toBe('open');

        const words = g.shares.map((s, i) => openCustodianShare(s, v!.custodians[i].seed));
        const m = combineMnemonics([words[0], words[1]]);
        const needles: (string | Uint8Array)[] = [m, m.toString('hex'), vaultB64(m), m.toString('base64')];
        for (const w of words) {
            needles.push(w, w.split(' ').slice(0, 6).join(' '), decodeShare(w).value);
        }
        expect(scan(v.dir, needles)).toEqual([]);
    });

    it('a genesis happens once, and only from a pinned custodian', async () => {
        v = await startVault();
        await doGenesis(v);
        // Open: no hello at all. Locked after a restart: the hello answers, the genesis doesn't.
        await expect(genesis(v.baseUrl, v.custodians[1], v.call())).rejects.toThrow(/409/);
        await v.restartKeyholder();
        const again = await genesis(v.baseUrl, v.custodians[1], v.call());
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('already_set_up');
    });

    it('seals a custodian share that only the named custodian opens (the format genesis uses)', () => {
        const c = stranger();
        const share = sealCustodianShare('some words', c.publicKey, vaultB64(crypto.randomBytes(16)), 1, 1);
        expect(openCustodianShare(share, c.seed)).toBe('some words');
    });
});

describe('a genesis is in force only once two custodians hold their shares', () => {
    async function begin(vault: VaultUnderTest, who = 0) {
        const r = await genesis(vault.baseUrl, vault.custodians[who], vault.call());
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ generation: 1, pending: { purpose: 'genesis', generation: 1, confirmed: [] } });
        return { vaultId: r.body.vaultId as string, shares: r.body.custodianShares as CustodianShare[] };
    }

    it('nothing is open until the second confirmation; a custodian can fetch their share again', async () => {
        v = await startVault();
        const { shares } = await begin(v);
        expect(v.keyholder().status().state).toBe('fresh');
        await expectAllGated(v);
        expect((await fetchPendingShare(v.baseUrl, v.custodians[2], v.call())).share).toEqual(shares[2]);
        expect((await fetchPendingShare(v.baseUrl, stranger(), v.call())).call.status).toBe(403);

        expect((await confirmWith(v, shares, [2]))[0].body).toMatchObject({ state: 'fresh', switched: false });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        expect((await confirmWith(v, shares, [0]))[0].body).toMatchObject({ state: 'open', switched: true, generation: 1 });
        expect((await get(v, '/v1/health')).body.state).toBe('open');
        expect(existsSync(path.join(v.stateDir, PENDING_FILE))).toBe(false);
        expect((await signed(v, '/v1/ticket', { purpose: 'deposit', provider: 'google' }, newMember().seed)).status).toBe(200);
    });

    it('the answer is lost and the keyholder restarts: nobody holds a share, and the next genesis replaces it', async () => {
        v = await startVault();
        const lost = await begin(v);
        await v.restartKeyholder();
        expect(v.keyholder().status()).toMatchObject({ state: 'fresh', pending: { purpose: 'genesis', sharesHeld: false } });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        expect((await fetchPendingShare(v.baseUrl, v.custodians[1], v.call())).share).toBeNull();

        const next = await begin(v, 1);
        expect(next.vaultId).not.toBe(lost.vaultId);
        // The lost genesis's shares were never in force, and now open nothing.
        await v.restartKeyholder();
        await unlockWith(v, lost.shares, [0]);
        expect((await unlockWith(v, lost.shares, [1]))[0].body).toMatchObject({ state: 'fresh', error: 'wrong_m' });
        expect((await unlockWith(v, next.shares, [0, 2]))[1].body).toMatchObject({ state: 'open', switched: true });
    });

    it('delivered, then a restart before anyone confirmed: two custodians unlock with the new shares', async () => {
        v = await startVault();
        const { shares } = await begin(v);
        await v.restartKeyholder();
        await expectAllGated(v);
        const [first, second] = await unlockWith(v, shares, [1, 2]);
        expect(first.body).toMatchObject({ state: 'fresh', sharesPresent: 1 });
        expect(second.body).toMatchObject({ state: 'open', switched: true, generation: 1 });
        await v.restartKeyholder();
        expect((await unlockWith(v, shares, [0, 1]))[1].body.state).toBe('open');
    });

    it('one confirmation, then a restart: the second switches it, locked, and the shares open it; after both, a restart opens with them', async () => {
        v = await startVault();
        const { shares } = await begin(v);
        await confirmWith(v, shares, [1]);
        await v.restartKeyholder();
        expect(v.keyholder().status().pending).toMatchObject({ confirmed: [v.custodians[1].publicKey] });
        expect((await confirmShare(v.baseUrl, v.custodians[2], shares[2], v.call())).body).toMatchObject({ state: 'locked', switched: true });
        expect((await get(v, '/v1/health')).body.state).toBe('locked');
        expect((await unlockWith(v, shares, [1, 2]))[1].body.state).toBe('open');
        await v.restartKeyholder();
        expect((await unlockWith(v, shares, [0, 2]))[1].body.state).toBe('open');
    });
});
