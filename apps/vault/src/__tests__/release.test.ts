import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { custodianKey } from '../custodian/lib.js';
import {
    addSignature,
    formatManifest,
    formatSignatures,
    imageHashOf,
    parseManifest,
    parseSignatures,
    resolveChain,
    signRelease,
    validSigners,
    type ReleaseManifest,
    type ReleaseSignatures,
} from '../shared/release.js';
import { keys3, makeRelease, randomImage } from './release-kit.js';

/**
 * Releases (key vault design §3; host design §5.1 item 3; V3's row): a manifest counts only with two signatures from
 * the custodian keys in force, reached from the pinned genesis keys through a chain of releases.
 */

describe('the release manifest', () => {
    it('imageHash is SHA-256("beanpool-vault-image/1\\n" ‖ ukiSha256 ‖ "\\n" ‖ roothash ‖ "\\n"): a fixed vector', () => {
        expect(imageHashOf({ ukiSha256: 'aa'.repeat(32), roothash: 'bb'.repeat(32) }))
            .toBe('57eb176c60c16bb844292af03c2115d80255728ab0ee75fed10f81bcbab76b8d');
    });

    it('parses what formatManifest writes, and refuses an unknown field, a wrong imageHash, a bad version or two equal keys', () => {
        const root = keys3();
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2) });
        expect(parseManifest(r.manifestText)).toEqual(r.manifest);
        const edit = (f: (m: Record<string, unknown>) => void) => {
            const m = JSON.parse(r.manifestText) as Record<string, unknown>;
            f(m);
            return JSON.stringify(m);
        };
        expect(() => parseManifest(edit(m => { m.extra = 1; }))).toThrow(/do(es)? not know: extra/);
        expect(() => parseManifest(edit(m => { m.imageHash = 'cc'.repeat(32); }))).toThrow(/imageHash/);
        expect(() => parseManifest(edit(m => { m.version = '1.0'; }))).toThrow(/version/);
        expect(() => parseManifest(edit(m => { m.custodianKeys = [root[0].publicKey, root[0].publicKey, root[1].publicKey]; }))).toThrow(/three different/);
        expect(() => parseManifest(edit(m => { m.hostPolicy = { platform: 'none', allowAnything: true }; }))).toThrow(/do(es)? not know/);
        expect(() => parseManifest(edit(m => { m.hostPolicy = { platform: 'tdx', mrtd: [], debug: false }; }))).toThrow(/mrtd/);
    });

    it('keeps a host policy for a platform it does not know, so the chain does not skip that release', () => {
        const root = keys3();
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), hostPolicy: { platform: 'quantum-enclave', proof: 'x' } });
        expect(parseManifest(r.manifestText).hostPolicy).toEqual({ platform: 'quantum-enclave', proof: 'x' });
        expect(resolveChain([r], root.map(k => k.publicKey)).newest?.manifest.hostPolicy.platform).toBe('quantum-enclave');
    });

    it('a tdx policy is checked field by field', () => {
        const h = (n: number) => 'ab'.repeat(n);
        const tdx = { platform: 'tdx', mrtd: [h(48)], googleEndorsementRoot: h(32), rtmr1: h(48), rtmr2: h(48), minTeeTcbSvn: h(16), tcbStatus: ['UpToDate'], debug: false };
        const root = keys3();
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root, hostPolicy: tdx as ReleaseManifest['hostPolicy'] });
        expect(parseManifest(r.manifestText).hostPolicy).toEqual(tdx);
        const debug = formatManifest({ ...r.manifest, hostPolicy: { ...tdx, debug: true } as unknown as ReleaseManifest['hostPolicy'] });
        expect(() => parseManifest(debug)).toThrow(/debug/);
    });
});

describe('two custodian signatures', () => {
    const root = keys3();
    const rootKeys = root.map(k => k.publicKey);
    const stranger = custodianKey(crypto.randomBytes(32));

    it('two signatures from the pinned keys: trusted', () => {
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: [root[0], root[2]] });
        const chain = resolveChain([r], rootKeys);
        expect(chain.newest?.hash).toBe(r.hash);
        expect(chain.newest?.signers.sort()).toEqual([root[0].publicKey, root[2].publicKey].sort());
        expect(chain.problems).toEqual([]);
    });

    it('one signature: refused', () => {
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: [root[1]] });
        const chain = resolveChain([r], rootKeys);
        expect(chain.newest).toBeNull();
        expect(chain.problems).toEqual([{ label: 'vault-v1.0.0', hash: r.hash, reason: 'one custodian signature, two are needed' }]);
    });

    it('one of the two from an unknown key: refused; the same signature twice counts once', () => {
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: [root[1], stranger] });
        expect(resolveChain([r], rootKeys).newest).toBeNull();
        const sigs = parseSignatures(r.signaturesText);
        const doubled = { ...sigs, signatures: [sigs.signatures[0], sigs.signatures[0], { ...sigs.signatures[1], key: root[2].publicKey }] };
        expect(validSigners(r.manifestText, doubled, rootKeys)).toEqual([root[1].publicKey]);
    });

    it('a manifest changed after it was signed: refused', () => {
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root, tamper: t => t.replace(/"apiBundleHash": "[0-9a-f]+"/, `"apiBundleHash": "${'ee'.repeat(32)}"`) });
        expect(r.manifestText).toContain('ee'.repeat(32));
        expect(resolveChain([r], rootKeys).newest).toBeNull();
    });

    it('signed by other keys than the pinned ones: refused', () => {
        const others = keys3();
        const r = makeRelease({ version: '1.0.0', previous: null, custodianKeys: others, signers: others });
        expect(resolveChain([r], rootKeys).newest).toBeNull();
    });
});

describe('the chain of releases', () => {
    const root = keys3();
    const rootKeys = root.map(k => k.publicKey);

    it('a reshare: the old custodians sign the release naming the new ones, who sign the next; the old ones can no longer', () => {
        const next = [root[0], ...keys3().slice(0, 2)];
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: [root[0], root[1]] });
        const r2 = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: next, signers: [root[1], root[2]] });
        const r3 = makeRelease({ version: '1.2.0', previous: r2, custodianKeys: next, signers: [next[1], next[2]] });
        const byOld = makeRelease({ version: '1.2.1', previous: r3, custodianKeys: root, signers: [root[1], root[2]] });
        const chain = resolveChain([byOld, r3, r1, r2], rootKeys);
        expect(chain.releases.map(r => r.manifest.version)).toEqual(['1.0.0', '1.1.0', '1.2.0']);
        expect(chain.newest?.hash).toBe(r3.hash);
        expect(chain.stopped).toBeNull();
        expect(chain.problems.map(p => [p.label, p.reason])).toEqual([['vault-v1.2.1', 'not signed by the custodians of the release before it']]);
    });

    it('two releases signed as the next after one (a fork): nothing after it is trusted', () => {
        const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root });
        const a = makeRelease({ version: '1.1.0', previous: r1, custodianKeys: root, signers: root, label: 'vault-v1.1.0-a' });
        const b = makeRelease({ version: '1.1.1', previous: r1, custodianKeys: root, signers: root, label: 'vault-v1.1.1-b' });
        const after = makeRelease({ version: '1.2.0', previous: a, custodianKeys: root, signers: root });
        const chain = resolveChain([r1, a, b, after], rootKeys);
        expect(chain.newest?.hash).toBe(r1.hash);
        expect(chain.stopped).toMatchObject({ reason: 'fork', after: r1.hash });
        // A second root is a fork too.
        const other = makeRelease({ version: '1.0.1', previous: null, custodianKeys: root, signers: root });
        expect(resolveChain([r1, other], rootKeys)).toMatchObject({ newest: null, stopped: { reason: 'fork', after: null } });
    });

    it('a release signed by the right keys but malformed, or not newer than the one before: nothing after it is trusted', () => {
        const r1 = makeRelease({ version: '1.3.0', previous: null, custodianKeys: root, signers: root });
        const older = makeRelease({ version: '1.2.9', previous: r1, custodianKeys: root, signers: root });
        expect(resolveChain([r1, older], rootKeys)).toMatchObject({ newest: { hash: r1.hash }, stopped: { reason: 'malformed' } });

        // Signed by the right keys over a text whose imageHash no longer matches its image: the keys are right, the content isn't.
        const image = randomImage();
        const text = makeRelease({ version: '1.4.0', previous: r1, custodianKeys: root, signers: [], image }).manifestText.replace(image.roothash, 'ff'.repeat(32));
        let sigs: ReleaseSignatures | null = null;
        for (const k of root.slice(0, 2)) sigs = addSignature(text, sigs, signRelease(text, k.seed, k.publicKey));
        const chain = resolveChain([r1, { manifestText: text, signaturesText: formatSignatures(sigs as ReleaseSignatures), label: 'vault-v1.4.0' }], rootKeys);
        expect(chain).toMatchObject({ newest: { hash: r1.hash }, stopped: { reason: 'malformed' } });
        expect(chain.stopped?.detail).toContain('imageHash');
    });
});
