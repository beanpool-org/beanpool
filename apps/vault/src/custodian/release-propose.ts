import type { HostPolicy, HostPolicyUnknown, ReleaseImage, ReleaseManifest, TrustedRelease } from '../shared/release.js';

/**
 * Which host policy a proposed release carries (`vault-custodian release propose`), and how the signing screen shows a
 * release that drops the hardware check.
 *
 * With neither flag, the newest release's policy goes forward unchanged, copied from its manifest as it was signed: a
 * routine release (`--same-image`, a new API) can't drop the chip check by leaving a flag out. Changing it takes
 * `--host-policy <file>`. Going to `none` after a release that had a hardware check takes `--host-policy-none`, a flag
 * named for exactly that; `--host-policy` with a file that says `none` is refused then, so it can't happen by picking
 * the wrong file. Every screen that shows the release (propose, sign, verify) calls it a DOWNGRADE.
 */

export class ProposeRefused extends Error {}

export function proposedHostPolicy(o: {
    /** The newest two-signed release, or null before the first. */
    newest: Pick<TrustedRelease, 'manifest' | 'manifestText'> | null;
    /** The proposed release's image (a sev-snp policy must list a launch of its UKI). */
    image: ReleaseImage;
    /** `--host-policy <file>`, parsed. */
    file?: HostPolicy | HostPolicyUnknown;
    /** `--host-policy-none`. */
    none?: boolean;
}): HostPolicy | HostPolicyUnknown {
    const { newest } = o;
    if (o.file && o.none) throw new ProposeRefused('--host-policy and --host-policy-none: pass one of them, not both.');
    let policy: HostPolicy | HostPolicyUnknown;
    let source: string;
    if (o.none) {
        policy = { platform: 'none' };
        source = '--host-policy-none';
    } else if (o.file) {
        if (o.file.platform === 'none' && newest && hasHardwareCheck(newest.manifest.hostPolicy)) {
            throw new ProposeRefused(`--host-policy names platform none, which drops the ${newest.manifest.hostPolicy.platform} hardware check that ${newest.manifest.version} requires. `
                + 'If every custodian agreed to that, pass --host-policy-none instead of a file: the signing screen then shows it as a downgrade.');
        }
        policy = o.file;
        source = '--host-policy';
    } else if (newest) {
        // As signed, not as this tool parsed it: the same policy, field for field and in the same order.
        policy = (JSON.parse(newest.manifestText) as { hostPolicy: HostPolicy | HostPolicyUnknown }).hostPolicy;
        source = `the policy of ${newest.manifest.version}, carried forward`;
    } else {
        throw new ProposeRefused('The first release names its host policy: --host-policy <file> (an image built with --host writes host-policy.json), '
            + 'or --host-policy-none for a host with no hardware proof.');
    }
    if (policy.platform === 'sev-snp') {
        const hosts = (policy as { hosts: { launches: { ukiSha256: string }[] }[] }).hosts;
        if (!hosts.some(h => h.launches.some(l => l.ukiSha256 === o.image.ukiSha256))) {
            throw new ProposeRefused(`The sev-snp host policy (${source}) lists no launch of this release's UKI (${o.image.ukiSha256.slice(0, 16)}…): `
                + 'once the vault runs this image, every chip check would refuse it. Pass --host-policy with that launch added (the image build\'s host-policy.json), '
                + 'keeping the running image\'s launch beside it until the restart.');
        }
    }
    return policy;
}

function hasHardwareCheck(policy: HostPolicy | HostPolicyUnknown): boolean {
    return policy.platform !== 'none';
}

/**
 * The lines the signing screen adds under the host policy when `next` drops the hardware check `previous` had; empty
 * otherwise.
 */
export function hostPolicyDowngrade(next: ReleaseManifest, previous: ReleaseManifest | null): string[] {
    if (!previous || next.hostPolicy.platform !== 'none' || !hasHardwareCheck(previous.hostPolicy)) return [];
    return [
        '',
        `!!! DOWNGRADE: ${previous.version} requires the ${previous.hostPolicy.platform} hardware check before any share goes. This release has none.`,
        '!!! Once it is in force the custodians\' tools check nothing about the host: it could read the vault\'s memory, and nothing proves what the vault runs.',
        '!!! Sign it only if every custodian agreed to drop the check.',
        '',
    ];
}
