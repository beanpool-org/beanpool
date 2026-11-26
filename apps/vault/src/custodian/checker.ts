import type { UnlockHello } from '../shared/ceremony.js';
import { KNOWN_PLATFORMS, type HostPolicy, type HostPolicyUnknown } from '../shared/release.js';

/**
 * What the custodian's tool checks about the vault's host before a part goes (host design §5.1 item 4). The policy
 * is the newest two-signed release's `hostPolicy`, never anything the vault says: a hostile host must not choose what
 * it gets checked against. The vault's hello says only which platform it claims and carries its evidence.
 *
 * - `none` (1984, D7): there is no hardware proof. The tool says so in plain words ({@link NO_HARDWARE_PROOF}) and
 *   sends a part only after the custodian confirms.
 * - `sev-snp`: the evidence must be present and pass the chip check (snp-checker.ts, vault comeback design §2.3). No
 *   warning and no confirmation: it passes or nothing is sent.
 * - `tdx`: no checker is built (V8, only if a TDX host is chosen), so a policy naming it is refused and nothing is sent.
 * - Any other platform: refused.
 *
 * A checker for a platform implements {@link EvidenceChecker}: given the policy, the evidence, the `bind` the tool
 * computed from its own nonce and the release the vault's hello names, it answers whether this is that exact release
 * on that hardware.
 */

export const NO_HARDWARE_PROOF = 'This vault\'s host can read its memory. There is no hardware proof of what it runs.';

export type HostCheck =
    | { ok: true; hardwareProof: boolean; warning: string | null; lines: string[] }
    | { ok: false; code: 'unknown_platform' | 'platform_mismatch' | 'evidence_missing' | 'no_checker' | 'evidence_refused'; reason: string; detail?: string };

/** What a checker needs to know beyond the policy and the evidence. */
export interface CheckContext {
    /** The release the vault's hello names (the newest, or the one a custodian named with --accept-release). */
    release: string;
    /** That release's UKI: the measurement must be the launch of exactly this file. */
    ukiSha256: string;
    /** `--accept-new-machine`: the first 8 hex characters of a chip the policy does not list yet. */
    acceptNewMachine?: string;
}

export interface EvidenceChecker {
    readonly platform: 'tdx' | 'sev-snp';
    /** Whether `evidence` is a genuine report for `policy`, over exactly `bind`, of the release `ctx` names. */
    check(policy: HostPolicy, evidence: Uint8Array, bind: Uint8Array, ctx: CheckContext):
        Promise<{ ok: true; lines?: string[] } | { ok: false; reason: string; code?: string }>;
}

/**
 * The checkers a caller passes by default: none. The custodian's command line registers the SEV-SNP checker with its
 * AMD key-server cache (cli.ts); without it a sev-snp policy is refused (`no_checker`) and nothing is sent.
 */
export const EVIDENCE_CHECKERS: Partial<Record<EvidenceChecker['platform'], EvidenceChecker>> = {};

export async function checkHost(
    policy: HostPolicy | HostPolicyUnknown,
    hello: Pick<UnlockHello, 'platform' | 'evidence'>,
    bind: Uint8Array,
    ctx: CheckContext,
    checkers: Partial<Record<string, EvidenceChecker>> = EVIDENCE_CHECKERS,
): Promise<HostCheck> {
    const platform = policy.platform;
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
        return { ok: false, code: 'unknown_platform', reason: `The release names a host platform this tool doesn't know (${platform}). Nothing was sent: update the tool.` };
    }
    if (hello.platform !== platform) {
        return { ok: false, code: 'platform_mismatch', reason: `The release says the vault runs on ${platform}, but the vault says ${String(hello.platform)}. Nothing was sent.` };
    }
    if (platform === 'none') return { ok: true, hardwareProof: false, warning: NO_HARDWARE_PROOF, lines: [] };
    if (typeof hello.evidence !== 'string' || !hello.evidence) {
        return { ok: false, code: 'evidence_missing', reason: `The release requires ${platform} evidence and the vault sent none. Nothing was sent.` };
    }
    const checker = Object.hasOwn(checkers, platform) ? checkers[platform] : undefined;
    if (!checker) return { ok: false, code: 'no_checker', reason: `This tool can't check ${platform} evidence yet. Nothing was sent.` };
    const evidence = Buffer.from(hello.evidence, 'base64url');
    let result: Awaited<ReturnType<EvidenceChecker['check']>>;
    try {
        result = await checker.check(policy as HostPolicy, evidence, bind, ctx);
    } catch (e) {
        result = { ok: false, reason: `the check could not finish (${(e as Error).message})`, code: 'check_failed' };
    }
    if (!result.ok) {
        return { ok: false, code: 'evidence_refused', detail: result.code, reason: `The vault's ${platform} evidence was refused: ${result.reason}. Nothing was sent.` };
    }
    return { ok: true, hardwareProof: true, warning: null, lines: result.lines ?? [] };
}
