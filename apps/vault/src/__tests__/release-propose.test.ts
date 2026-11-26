import { describe, expect, it } from 'vitest';
import { hostPolicyDowngrade, proposedHostPolicy, ProposeRefused } from '../custodian/release-propose.js';
import { parseHostPolicy, parseManifest, type HostPolicy, type HostPolicySevSnp, type HostPolicyUnknown } from '../shared/release.js';
import { keys3, makeRelease, randomImage } from './release-kit.js';

/**
 * `release propose`'s host policy (deciding review of #3387, finding 2): with no flag the policy in force goes forward
 * unchanged, so a routine release can't drop the chip check by leaving a flag out; `none` after a hardware check takes
 * its own flag and the signing screen calls it a downgrade.
 */

const image = randomImage();
/** A sev-snp policy written with its keys out of the parser's order, to see the carried policy is the signed one. */
const snpPolicy = (uki: string) => ({
    hosts: [{
        chipIds: [], requireAliasCheck: true, minTcb: { snp: 29, bootloader: 4, tee: 0, microcode: 222 }, policies: ['0000030000000000'],
        launches: [{ source: 'computed', measurement: 'cd'.repeat(48), firmwareSha256: 'ef'.repeat(32), ukiSha256: uki }],
        product: 'Milan', profile: 'servury',
    }],
    signer: 'vcek', platform: 'sev-snp',
}) as unknown as HostPolicyUnknown;

function chainWith(hostPolicy: HostPolicy | HostPolicyUnknown) {
    const custodians = keys3();
    return makeRelease({ version: '1.0.0', previous: null, custodianKeys: custodians, signers: custodians.slice(0, 2), image, hostPolicy });
}

const refusal = (f: () => unknown) => {
    try {
        f();
    } catch (e) {
        if (e instanceof ProposeRefused) return e.message;
        throw e;
    }
    return null;
};

describe('the host policy a proposed release carries', () => {
    it('no flag: the newest release\'s policy goes forward exactly as it was signed (sev-snp, --same-image)', () => {
        const newest = chainWith(snpPolicy(image.ukiSha256));
        const carried = proposedHostPolicy({ newest, image });
        const signed = (JSON.parse(newest.manifestText) as { hostPolicy: unknown }).hostPolicy;
        expect(JSON.stringify(carried)).toBe(JSON.stringify(signed));
        // Not the parser's reordering of it (what the chain hands the tool): the same keys in the same order.
        expect(JSON.stringify(carried)).not.toBe(JSON.stringify(parseManifest(newest.manifestText).hostPolicy));
        expect(carried.platform).toBe('sev-snp');
    });

    it('no flag on a none chain stays none; the first release must name its policy', () => {
        expect(proposedHostPolicy({ newest: chainWith({ platform: 'none' }), image })).toEqual({ platform: 'none' });
        expect(refusal(() => proposedHostPolicy({ newest: null, image }))).toMatch(/The first release names its host policy: --host-policy <file> .* or --host-policy-none/);
        expect(proposedHostPolicy({ newest: null, image, none: true })).toEqual({ platform: 'none' });
    });

    it('a changed policy takes --host-policy (raising the floor)', () => {
        const newest = chainWith(snpPolicy(image.ukiSha256));
        const raised = parseHostPolicy(snpPolicy(image.ukiSha256)) as HostPolicySevSnp;
        raised.hosts[0].minTcb.snp = 31;
        expect(proposedHostPolicy({ newest, image, file: raised })).toBe(raised);
    });

    it('none after sev-snp: refused from a file, taken only with --host-policy-none, and shown as a DOWNGRADE', () => {
        const newest = chainWith(snpPolicy(image.ukiSha256));
        expect(refusal(() => proposedHostPolicy({ newest, image, file: { platform: 'none' } }))).toMatch(/drops the sev-snp hardware check that 1\.0\.0 requires.*pass --host-policy-none instead/);
        expect(refusal(() => proposedHostPolicy({ newest, image, file: { platform: 'none' }, none: true }))).toMatch(/pass one of them, not both/);
        const dropped = proposedHostPolicy({ newest, image, none: true });
        expect(dropped).toEqual({ platform: 'none' });
        const next = parseManifest(makeRelease({ version: '1.0.1', previous: newest, custodianKeys: keys3(), signers: [], hostPolicy: dropped }).manifestText);
        const lines = hostPolicyDowngrade(next, newest.manifest).join('\n');
        expect(lines).toMatch(/!!! DOWNGRADE: 1\.0\.0 requires the sev-snp hardware check before any share goes\. This release has none\./);
        expect(lines).toMatch(/Sign it only if every custodian agreed to drop the check/);
        // On a none chain a file naming none is no downgrade.
        expect(proposedHostPolicy({ newest: chainWith({ platform: 'none' }), image, file: { platform: 'none' } })).toEqual({ platform: 'none' });
    });

    it('the signing screen says DOWNGRADE only when a hardware check is dropped', () => {
        const snp = chainWith(snpPolicy(image.ukiSha256));
        const none = chainWith({ platform: 'none' });
        const snpNext = parseManifest(makeRelease({ version: '1.0.1', previous: snp, custodianKeys: keys3(), signers: [], hostPolicy: snpPolicy(image.ukiSha256) }).manifestText);
        const noneNext = parseManifest(makeRelease({ version: '1.0.1', previous: none, custodianKeys: keys3(), signers: [] }).manifestText);
        expect(hostPolicyDowngrade(snpNext, snp.manifest)).toEqual([]);
        expect(hostPolicyDowngrade(noneNext, none.manifest)).toEqual([]);
        expect(hostPolicyDowngrade(noneNext, null)).toEqual([]);
        expect(hostPolicyDowngrade(snpNext, none.manifest)).toEqual([]);
    });

    it('a sev-snp policy must list a launch of the proposed image\'s UKI (a new image cannot carry the old policy as it is)', () => {
        const newest = chainWith(snpPolicy(image.ukiSha256));
        const next = randomImage();
        expect(refusal(() => proposedHostPolicy({ newest, image: next }))).toMatch(/\(the policy of 1\.0\.0, carried forward\) lists no launch of this release's UKI .*Pass --host-policy with that launch added/);
        expect(refusal(() => proposedHostPolicy({ newest, image: next, file: parseHostPolicy(snpPolicy(image.ukiSha256)) }))).toMatch(/\(--host-policy\) lists no launch/);
        const both = parseHostPolicy(snpPolicy(image.ukiSha256)) as HostPolicySevSnp;
        both.hosts[0].launches.push({ ukiSha256: next.ukiSha256, firmwareSha256: 'ef'.repeat(32), measurement: '12'.repeat(48), source: 'computed' });
        expect(proposedHostPolicy({ newest, image: next, file: both })).toBe(both);
    });
});
