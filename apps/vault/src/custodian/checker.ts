import type { UnlockHello } from '../shared/ceremony.js';
import { KNOWN_PLATFORMS, type HostPolicy, type HostPolicyUnknown } from '../shared/release.js';

/**
 * What the custodian's tool checks about the vault's host before a part goes (host design §5.1 item 4). The policy
 * is the newest two-signed release's `hostPolicy`, never anything the vault says: a hostile host must not choose what
 * it gets checked against. The vault's hello says only which platform it claims and carries its evidence.
 *
 * - `none` (1984, D7): there is no hardware proof. The tool says so in plain words ({@link NO_HARDWARE_PROOF}) and
 *   sends a part only after the custodian confirms.
 * - `tdx`, `sev-snp`: the evidence must be present and pass that platform's checker. None is built yet (V8, only if a
 *   confidential host is chosen), so today a policy naming either is refused and nothing is sent.
 * - Any other platform: refused.
 *
 * A checker for a platform (V8) implements {@link EvidenceChecker}: given the policy, the evidence and the `bind` the
 * tool computed from its own nonce, it answers whether this is that exact release on that hardware.
 */

export const NO_HARDWARE_PROOF = 'This vault\'s host can read its memory. There is no hardware proof of what it runs.';

export type HostCheck =
    | { ok: true; hardwareProof: boolean; warning: string | null }
    | { ok: false; code: 'unknown_platform' | 'platform_mismatch' | 'evidence_missing' | 'no_checker' | 'evidence_refused'; reason: string };

export interface EvidenceChecker {
    readonly platform: 'tdx' | 'sev-snp';
    /** Whether `evidence` is a genuine report for `policy`, over exactly `bind`. */
    check(policy: HostPolicy, evidence: Uint8Array, bind: Uint8Array): Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** The checkers this tool has: none yet (V8 adds TDX via configfs-tsm quotes and Intel's collateral). */
export const EVIDENCE_CHECKERS: Partial<Record<EvidenceChecker['platform'], EvidenceChecker>> = {};

export async function checkHost(
    policy: HostPolicy | HostPolicyUnknown,
    hello: Pick<UnlockHello, 'platform' | 'evidence'>,
    bind: Uint8Array,
    checkers: Partial<Record<string, EvidenceChecker>> = EVIDENCE_CHECKERS,
): Promise<HostCheck> {
    const platform = policy.platform;
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
        return { ok: false, code: 'unknown_platform', reason: `The release names a host platform this tool doesn't know (${platform}). Nothing was sent: update the tool.` };
    }
    if (hello.platform !== platform) {
        return { ok: false, code: 'platform_mismatch', reason: `The release says the vault runs on ${platform}, but the vault says ${String(hello.platform)}. Nothing was sent.` };
    }
    if (platform === 'none') return { ok: true, hardwareProof: false, warning: NO_HARDWARE_PROOF };
    if (typeof hello.evidence !== 'string' || !hello.evidence) {
        return { ok: false, code: 'evidence_missing', reason: `The release requires ${platform} evidence and the vault sent none. Nothing was sent.` };
    }
    const checker = checkers[platform];
    if (!checker) return { ok: false, code: 'no_checker', reason: `This tool can't check ${platform} evidence yet. Nothing was sent.` };
    const evidence = Buffer.from(hello.evidence, 'base64url');
    const result = await checker.check(policy as HostPolicy, evidence, bind);
    if (!result.ok) return { ok: false, code: 'evidence_refused', reason: `The vault's ${platform} evidence was refused: ${result.reason}. Nothing was sent.` };
    return { ok: true, hardwareProof: true, warning: null };
}
