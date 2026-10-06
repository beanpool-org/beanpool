import { utf8ToBytes } from '@noble/hashes/utils.js';
import { signStatement, verifyStatement } from './ceremony.js';
import { sha256Hex, type ReleaseSignature } from './release.js';

/**
 * The custodians' restart for a new image (key vault design §3, D3 as changed by Marty on 2026-10-06): nothing restarts
 * the vault on a schedule. When a release brings a new image, the API stages it (updater.ts) and `/v1/report` says a
 * restart is needed; two custodians, ready to unlock at once, each sign the same short request with
 * `vault-custodian restart`. The API only carries it: it keeps the first signature until a second custodian signs the
 * same request, then writes both into RESTART_REQUEST_FILE. Root's unit on that file (beanpool-vault-restart.path) runs
 * the install step, which checks the request itself from the pinned custodian keys (install.ts: checkRestartRequest),
 * never from anything the API says. Only a request two custodians of the running release signed, fresh, not seen
 * before, naming exactly the image that is staged and passes root's own checks, restarts the vault.
 *
 * The request is `{v: 1, purpose, version, imageHash, ukiSha256, roothash, at, nonce}` as canonical JSON text; each
 * custodian signs `beanpool-vault restart v1\n<SHA-256 of that text>` (as a release is signed: release.ts).
 */

/** Where the API leaves a request two custodians signed (its own directory: root reads it, then removes it). */
export const RESTART_REQUEST_DIR = '/var/lib/beanpool-vault/restart';
export const RESTART_REQUEST_FILE = `${RESTART_REQUEST_DIR}/request.json`;
/** Root's record of the requests it acted on (root's directory), so none is acted on twice. */
export const RESTART_USED_FILE = '/var/lib/beanpool-vault/restart-used.json';

export const RESTART_PURPOSE = 'beanpool-vault-restart-for-image';
const RESTART_TAG = 'beanpool-vault restart v1';
/** A request file is no larger than this (a request and a few signatures). */
export const RESTART_REQUEST_MAX_BYTES = 16 * 1024;
/** A request is acted on only within this long after the first custodian signed it. */
export const RESTART_REQUEST_MAX_AGE_MS = 60 * 60 * 1000;
/** And never when it says it was signed more than this ahead of the vault's clock. */
export const RESTART_CLOCK_MARGIN_MS = 5 * 60 * 1000;
export const RESTART_THRESHOLD = 2;

export interface RestartRequest {
    v: 1;
    purpose: typeof RESTART_PURPOSE;
    /** The staged release, its image (the UKI's SHA-256 and the system partition's root hash) and its image hash. */
    version: string;
    imageHash: string;
    ukiSha256: string;
    roothash: string;
    /** When the first custodian signed it (ms), and 16 random bytes in hex. */
    at: number;
    nonce: string;
}

/** What the API writes for root: the request's text, exactly as signed, and the custodians' signatures of it. */
export interface SignedRestartRequest {
    v: 1;
    request: string;
    signatures: ReleaseSignature[];
}

/** For `/v1/report`: whether the custodians' restart is needed. */
export interface RestartStatus {
    /** The release whose new image waits for the custodians' restart (staged: its files are in place), or null. */
    imageWaiting: { version: string; staged: boolean } | null;
    /** True once a staged image waits: two custodians run `vault-custodian restart` when both can unlock at once. */
    custodianRestartNeeded: boolean;
}

export function restartStatus(waiting: { version: string; staged: boolean } | null): RestartStatus {
    return { imageWaiting: waiting ? { version: waiting.version, staged: waiting.staged } : null, custodianRestartNeeded: !!waiting?.staged };
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const VERSION = /^(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})\.(?:0|[1-9]\d{0,8})$/;

export function formatRestartRequest(r: RestartRequest): string {
    return JSON.stringify({ v: 1, purpose: RESTART_PURPOSE, version: r.version, imageHash: r.imageHash, ukiSha256: r.ukiSha256, roothash: r.roothash, at: r.at, nonce: r.nonce });
}

/** The request in `text`, or why it isn't one. Only canonical text is a request (what was signed is what is read). */
export function parseRestartRequest(text: unknown): RestartRequest | string {
    if (typeof text !== 'string' || text.length > RESTART_REQUEST_MAX_BYTES) return 'not a restart request';
    let o: Record<string, unknown>;
    try {
        o = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return 'the restart request is not JSON';
    }
    if (!o || typeof o !== 'object' || o.v !== 1 || o.purpose !== RESTART_PURPOSE) return 'not a restart request';
    if (typeof o.version !== 'string' || !VERSION.test(o.version)) return 'the restart request names no release';
    for (const k of ['imageHash', 'ukiSha256'] as const) if (typeof o[k] !== 'string' || !HEX64.test(o[k] as string)) return `the restart request's ${k} is not a SHA-256`;
    if (typeof o.roothash !== 'string' || !/^[0-9a-f]{64,128}$/.test(o.roothash)) return 'the restart request\'s roothash is not a root hash';
    if (!Number.isSafeInteger(o.at) || (o.at as number) <= 0) return 'the restart request has no time';
    if (typeof o.nonce !== 'string' || !HEX32.test(o.nonce)) return 'the restart request has no nonce';
    const r = o as unknown as RestartRequest;
    if (formatRestartRequest(r) !== text) return 'the restart request is not in its canonical form';
    return r;
}

/** The request's id: the SHA-256 of its text (what root records once it acted on it). */
export function restartRequestId(text: string): string {
    return sha256Hex(utf8ToBytes(text));
}

function restartStatement(text: string): Uint8Array {
    return utf8ToBytes(`${RESTART_TAG}\n${restartRequestId(text)}`);
}

/** One custodian's signature of a restart request (their 32-byte Ed25519 seed). */
export function signRestartRequest(text: string, seed: Uint8Array, publicKey: string): ReleaseSignature {
    return { key: publicKey, sig: signStatement(seed, restartStatement(text)) };
}

/** The distinct keys of `trusted` that validly signed the request. */
export function restartSigners(text: string, signatures: readonly ReleaseSignature[], trusted: readonly string[]): string[] {
    const statement = restartStatement(text);
    const out = new Set<string>();
    for (const s of signatures.slice(0, 16)) {
        if (s && typeof s.key === 'string' && typeof s.sig === 'string' && trusted.includes(s.key) && !out.has(s.key) && verifyStatement(s.key, statement, s.sig)) out.add(s.key);
    }
    return [...out];
}

/** What root checks the request against: the staged release (from the pinned keys), and the keys that may sign. */
export interface RestartCheck {
    /** The custodian keys of the release this machine runs, from the chain the pinned keys start. */
    trusted: readonly string[];
    staged: { version: string; imageHash: string; ukiSha256: string; roothash: string };
    now: number;
    /** Ids of requests root already acted on. */
    used: ReadonlySet<string>;
}

/**
 * Root's check of a request file's text: two signatures from `trusted`, fresh, never acted on before, naming exactly
 * the staged release and its image. Returns the request's id, or why it is refused.
 */
export function checkRestartRequest(fileText: string, c: RestartCheck): { ok: true; id: string; signers: string[] } | { ok: false; reason: string } {
    let file: SignedRestartRequest;
    try {
        file = JSON.parse(fileText) as SignedRestartRequest;
    } catch {
        return { ok: false, reason: 'the restart request file is not JSON' };
    }
    if (!file || typeof file !== 'object' || file.v !== 1 || typeof file.request !== 'string' || !Array.isArray(file.signatures)) {
        return { ok: false, reason: 'the restart request file is not {v: 1, request, signatures}' };
    }
    const r = parseRestartRequest(file.request);
    if (typeof r === 'string') return { ok: false, reason: r };
    const signers = restartSigners(file.request, file.signatures, c.trusted);
    if (signers.length < RESTART_THRESHOLD) {
        return { ok: false, reason: `the restart request is signed by ${signers.length} of the running release's custodians, not ${RESTART_THRESHOLD}` };
    }
    if (r.at > c.now + RESTART_CLOCK_MARGIN_MS) return { ok: false, reason: 'the restart request is dated ahead of the vault\'s clock' };
    if (c.now - r.at > RESTART_REQUEST_MAX_AGE_MS) return { ok: false, reason: 'the restart request is stale (signed more than an hour ago)' };
    const id = restartRequestId(file.request);
    if (c.used.has(id)) return { ok: false, reason: 'the restart request was acted on before (a replay)' };
    const s = c.staged;
    if (r.version !== s.version || r.imageHash !== s.imageHash || r.ukiSha256 !== s.ukiSha256 || r.roothash !== s.roothash) {
        return { ok: false, reason: `the restart request names release ${r.version}'s image, not the staged release ${s.version}'s` };
    }
    return { ok: true, id, signers };
}
