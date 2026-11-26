import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import { vaultB64 } from '@beanpool/core';
import type { FetchLike } from '@beanpool/signin';
import { genesis, presentShare, restoreFromBackup, sendSettings, type CallOptions, type CustodianKey } from '../custodian/lib.js';
import { snpChecker } from '../custodian/snp-checker.js';
import { unlockBind } from '../shared/ceremony.js';
import { LocalDirectoryFeed } from '../shared/release-feed.js';
import type { HostPolicySevSnp, ReleaseImage, SnpHost } from '../shared/release.js';
import { keys3, makeRelease, publish, randomImage, type MadeRelease } from './release-kit.js';
import { evidenceOf, fixedCollateral, NOW, PROBE_TCB, reportBytes, signReport, testAmd, type ReportSpec, type TestAmd } from './snp-kit.js';

/**
 * The chip check inside the custodian's ceremonies (vault comeback design §2.1, §2.3): the policy from the newest
 * two-signed release, the report over the bind the tool computed from its own nonce, and nothing but the hello sent
 * when any check fails. No "go on anyway": --no-hardware-proof and a typed yes change nothing on sev-snp. The vault is a
 * fake that makes a real-layout report over each hello's bind, signed by a test-only AMD chain (snp-kit.ts).
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bv-snpu-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const CHIP = crypto.createHash('sha512').update('the vault\'s chip').digest();
const FIRMWARE = '8731846cdbcbb6aa5c624238b839544b1553f4c5af874450f043321b3ef8958b';
const measurementOf = (image: ReleaseImage) => crypto.createHash('sha384').update(`launch of ${image.ukiSha256}`).digest();

let amd: TestAmd;
beforeAll(() => {
    amd = testAmd();
});

function host(images: ReleaseImage[], o: Partial<SnpHost> = {}): SnpHost {
    return {
        profile: 'servury', product: 'Milan',
        launches: images.map(i => ({ ukiSha256: i.ukiSha256, firmwareSha256: FIRMWARE, measurement: measurementOf(i).toString('hex'), source: 'computed' as const })),
        policies: ['0000030000000000'], minTcb: { ...PROBE_TCB }, requireAliasCheck: true, chipIds: [CHIP.toString('hex')], ...o,
    };
}
const snp = (h: SnpHost): HostPolicySevSnp => ({ platform: 'sev-snp', signer: 'vcek', hosts: [h] });

interface SnpVault {
    fetch: FetchLike;
    requests: string[];
}

/**
 * A vault on an SEV-SNP host: every hello's evidence is a report over that hello's bind, launched from `runs` (the
 * measurement the chip would see), with `change` applied to the report first. `claims` is the release hash it reports.
 */
function snpVault(o: { runs: ReleaseImage; claims: string; change?: (s: ReportSpec) => void; platform?: string; evidence?: null }): SnpVault {
    const helloPub = x25519.getPublicKey(crypto.randomBytes(32));
    const bootId = crypto.randomBytes(16);
    const v: SnpVault = {
        requests: [],
        fetch: async (url, init) => {
            const p = new URL(url).pathname;
            v.requests.push(p);
            if (!p.endsWith('/hello')) return Response.json({ state: 'open' });
            const nonce = Buffer.from(JSON.parse(String(init?.body)).custodianNonce, 'base64url');
            const spec: ReportSpec = { reportData: Buffer.from(unlockBind(helloPub, bootId, nonce)), measurement: measurementOf(o.runs), chipId: CHIP };
            o.change?.(spec);
            const evidence = o.evidence === null ? null : vaultB64(evidenceOf(signReport(reportBytes(spec))));
            return Response.json({ bootId: vaultB64(bootId), helloPub: vaultB64(helloPub), releaseHash: o.claims, platform: o.platform ?? 'sev-snp', evidence });
        },
    };
    return v;
}

function setUp(policyFor: (r1Image: ReleaseImage) => HostPolicySevSnp) {
    const root = keys3();
    const feedDir = path.join(dir, `feed-${++n}`);
    const image = randomImage();
    const r1 = makeRelease({ version: '1.0.0', previous: null, custodianKeys: root, signers: root.slice(0, 2), image, hostPolicy: policyFor(image) });
    publish(feedDir, r1);
    const opts = (extra: Partial<CallOptions> = {}): CallOptions & { outbox: string[]; lines: string[] } => {
        const lines: string[] = [];
        return {
            trust: { feed: new LocalDirectoryFeed(feedDir), rootKeys: root.map(k => k.publicKey) }, outbox: [], lines,
            checkers: { 'sev-snp': snpChecker({ collateral: fixedCollateral({ vcek: amd.vcek(CHIP, PROBE_TCB), crl: amd.crl() }), now: () => NOW, roots: amd.roots }) },
            onHostCheck: l => lines.push(...l),
            ...extra,
        };
    };
    return { root, feedDir, r1, image, opts };
}

const unlock = (v: SnpVault, key: CustodianKey, o: CallOptions) => presentShare('https://vault.test', key, 'some share words', { ...o, fetch: v.fetch });

describe('a sev-snp release: the share goes only after the chip check passes', () => {
    it('a genuine report over this hello\'s bind, of the release\'s UKI: the share is sent, and the custodian is told what was checked', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i])));
        const v = snpVault({ runs: image, claims: r1.manifest.imageHash });
        const o = opts();
        expect((await unlock(v, root[0], o)).status).toBe(200);
        expect(o.outbox).toEqual(['/v1/unlock/share']);
        expect(o.lines.join('\n')).toMatch(/chip check passed: AMD SEV-SNP, host servury[\s\S]*computed from our own build/);
    });

    it('debug on: refused with the reason, nothing but the hello sent; neither --no-hardware-proof nor a yes moves it', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i])));
        const v = snpVault({ runs: image, claims: r1.manifest.imageHash, change: s => { s.policy = 0x30000n | (1n << 19n); } });
        const asked: string[] = [];
        const o = opts({ acceptNoHardwareProof: true, confirm: async w => { asked.push(w); return true; } });
        await expect(unlock(v, root[0], o)).rejects.toMatchObject({ code: 'evidence_refused', message: expect.stringMatching(/allows debugging.*Nothing was sent/) });
        expect(o.outbox).toEqual([]);
        expect(v.requests).toEqual(['/v1/unlock/hello']);
        expect(asked).toEqual([]);
    });

    it('the vault saying none, or sending no evidence, under a sev-snp release: refused, nothing sent', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i])));
        const none = opts({ acceptNoHardwareProof: true });
        await expect(unlock(snpVault({ runs: image, claims: r1.manifest.imageHash, platform: 'none', evidence: null }), root[0], none)).rejects.toMatchObject({ code: 'platform_mismatch' });
        const missing = opts();
        await expect(unlock(snpVault({ runs: image, claims: r1.manifest.imageHash, evidence: null }), root[0], missing)).rejects.toMatchObject({ code: 'evidence_missing' });
        expect([...none.outbox, ...missing.outbox]).toEqual([]);
    });

    it('a tool without the SEV-SNP checker refuses rather than sends', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i])));
        const o = opts({ checkers: {} });
        await expect(unlock(snpVault({ runs: image, claims: r1.manifest.imageHash }), root[0], o)).rejects.toMatchObject({ code: 'no_checker' });
        expect(o.outbox).toEqual([]);
    });

    it('genesis, a restore from backup and the settings pass through the same check', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i])));
        const bad = () => snpVault({ runs: image, claims: r1.manifest.imageHash, change: s => { s.vmpl = 1; } });
        for (const call of [
            (o: CallOptions) => genesis('https://vault.test', root[0], { ...o, fetch: bad().fetch }),
            (o: CallOptions) => restoreFromBackup('https://vault.test', root[0], 'backup-1', { ...o, fetch: bad().fetch }),
            (o: CallOptions) => sendSettings('https://vault.test', root[0], {}, { ...o, fetch: bad().fetch }),
        ]) {
            const o = opts();
            await expect(call(o)).rejects.toMatchObject({ code: 'evidence_refused', message: expect.stringMatching(/VMPL 1/) });
            expect(o.outbox).toEqual([]);
        }
    });
});

describe('the release the chip proves', () => {
    function twoReleases() {
        const s = setUp(i => snp(host([i])));
        const image2 = randomImage();
        // The newest release lists both launches: the old image may run until its restart, when named.
        const r2: MadeRelease = makeRelease({ version: '1.1.0', previous: s.r1, custodianKeys: s.root, signers: s.root.slice(1), image: image2, hostPolicy: snp(host([s.image, image2])) });
        publish(s.feedDir, r2);
        return { ...s, r2, image2 };
    }

    it('an older release running: refused unless named with --accept-release, then the chip must show that release\'s UKI', async () => {
        const { root, r1, image, opts } = twoReleases();
        const v = snpVault({ runs: image, claims: r1.manifest.imageHash });
        await expect(unlock(v, root[0], opts())).rejects.toMatchObject({ code: 'release_mismatch' });
        const named = opts({ acceptRelease: '1.0.0' });
        expect((await unlock(v, root[0], named)).status).toBe(200);
        expect(named.outbox).toEqual(['/v1/unlock/share']);
    });

    it('a vault that says it runs the newest release while the chip shows the old UKI: refused, nothing sent', async () => {
        const { root, r2, image, opts } = twoReleases();
        const o = opts();
        await expect(unlock(snpVault({ runs: image, claims: r2.manifest.imageHash }), root[0], o))
            .rejects.toMatchObject({ code: 'evidence_refused', message: expect.stringMatching(/runs another release than it says/) });
        expect(o.outbox).toEqual([]);
    });
});

describe('a chip the release does not list (design §2.3 row 10)', () => {
    it('refused, naming its first 8 characters; sent when the custodian types them', async () => {
        const { root, r1, image, opts } = setUp(i => snp(host([i], { chipIds: [] })));
        const v = snpVault({ runs: image, claims: r1.manifest.imageHash });
        const first = CHIP.toString('hex').slice(0, 8);
        const o = opts();
        await expect(unlock(v, root[0], o)).rejects.toThrow(`--accept-new-machine ${first}`);
        expect(o.outbox).toEqual([]);
        const accepted = opts({ acceptNewMachine: first });
        expect((await unlock(v, root[0], accepted)).status).toBe(200);
        expect(accepted.lines.join('\n')).toMatch(/NEW: accepted by you/);
    });
});
