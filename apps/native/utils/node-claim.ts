/**
 * "Claim a community": becoming the first owner of a community server that has none yet, with the one-time claim code
 * its first boot wrote on the server (claim v2, apps/server/src/routes/node-claim.ts).
 *
 *   1. GET /api/local/claim: whether the node is unclaimed, the waiting code's public id and its salt. Nothing else in
 *      that answer is used: a phishing server writes it.
 *   2. K = scrypt(sha256(code), salt) with the parameters below, hard-coded here and never read from the wire (a lower N
 *      from a phishing server would make a proof it captured cheap to brute-force offline). One to four seconds on an
 *      old phone: "Checking the code…".
 *   3. proof = HMAC(K, host, code id, this phone's key); the key signs 0xFF ‖ beanpool-claim/2 with the same fields
 *      (@beanpool/core claimProof, claimText). The code and K never leave the phone.
 *   4. POST. If the answer is lost, the claim may still have happened: the node is asked again, and when it says it has
 *      an owner and that owner is this phone's key, the claim is done. A 429 on that check means "check again later or
 *      from another network", never "failed" (the node's brake is per address, and a stranger on the same address can
 *      hold it).
 *
 * The key the node registers is the identity already on this phone (one identity per device): nothing here makes one.
 */
import {
    CLAIM_SCRYPT, audienceOf, claimKeyFromCodeAsync, claimProof, claimText, signedRequestBytes, toBase64,
} from '@beanpool/core';
import { buildSignedHeaders, memberSigner } from './crypto';
import { isPlainNodeAddress, normalizeNodeUrl, plainOriginOf, shouldBlockCleartextNodeUrl } from './node-url';

/**
 * The scrypt for K, the server's (Node's defaults, a 32-byte key). The app's own copy: a claim refuses to run when
 * core's helper would use anything else, so no change elsewhere can lower what a captured proof costs to attack.
 */
export const APP_CLAIM_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, dkLen: 32 });

export function claimScryptIsTheApps(params: { N: number; r: number; p: number; dkLen: number } = CLAIM_SCRYPT): boolean {
    return params.N === APP_CLAIM_SCRYPT.N && params.r === APP_CLAIM_SCRYPT.r && params.p === APP_CLAIM_SCRYPT.p
        && params.dkLen === APP_CLAIM_SCRYPT.dkLen;
}

const CODE_ID = /^[0-9a-f]{8}$/;
const SALT = /^[0-9a-f]{16,128}$/;
const KEY = /^[0-9a-f]{64}$/;
const CODE = /^claim-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/;

/** A whole claim code, `claim-` and four groups of four hex digits, in any case and with spaces around. */
export function isClaimCode(code: unknown): code is string {
    return typeof code === 'string' && CODE.test(code.trim().toLowerCase());
}

/**
 * What the code field holds after a keystroke, a paste or a scan: the hex digits after `claim-`, grouped `a1b2-c3d4-…`,
 * at most 16. The field shows `claim-` itself. A pasted whole code (`claim-a1b2-…`) loses its prefix first, so its
 * `a` and `c`… are not read as digits.
 */
export function claimCodeDigits(raw: string): string {
    const s = String(raw ?? '').trim().toLowerCase().replace(/^claim-?/, '');
    const hex = s.replace(/[^0-9a-f]/g, '').slice(0, 16);
    return (hex.match(/.{1,4}/g) ?? []).join('-');
}

/** The whole code from the field's digits, or null while it is not complete. */
export function claimCodeFromDigits(digits: string): string | null {
    const code = `claim-${claimCodeDigits(digits)}`;
    return CODE.test(code) ? code : null;
}

/**
 * A node address from a claim link or a typed field, as an origin (`scheme://host[:port]`), or null when it is not one
 * the app will connect to and sign for: not a plain address (node-url.ts: no login `@`, no `\`, no whitespace), a
 * scheme other than http(s), or cleartext to a public host. A bare name becomes `<name>.beanpool.org`, as everywhere.
 */
export function claimNodeOrigin(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (!s || /\s/.test(s)) return null;
    // Any other scheme (javascript:, beanpool:, file:…), but not a host followed by its port.
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^https?:\/\//i.test(s)) return null;
    const url = normalizeNodeUrl(s);
    if (!isPlainNodeAddress(url) || !/^https?:/i.test(url)) return null;
    const origin = plainOriginOf(url);
    if (!origin || shouldBlockCleartextNodeUrl(origin) || !audienceOf(origin)) return null;
    return origin;
}

export interface ClaimLink {
    /** The node's origin, or null when the link named none (or a bad one): the screen then asks for the address. */
    node: string | null;
    /** True when the link named a node the app refused, so the screen can say so rather than silently ask. */
    nodeRefused: boolean;
    codeId: string | null;
    /** The code, only when the link carries a whole one (the terminal QR does; the manager's never does). */
    code: string | null;
}

/**
 * `beanpool://claim?node=…[&id=…][&code=…]`, the link `beanpool claim` prints as a terminal QR and the manager's
 * unclaimed card shows. Null for any other link. Every field is checked on its own; a bad one is dropped.
 */
export function parseClaimLink(link: unknown): ClaimLink | null {
    if (typeof link !== 'string') return null;
    const m = /^beanpool:\/\/\/?claim\/?(?:\?([^#]*))?(?:#.*)?$/i.exec(link.trim());
    if (!m) return null;
    const params = new Map<string, string>();
    for (const part of (m[1] ?? '').split('&')) {
        if (!part) continue;
        const eq = part.indexOf('=');
        const k = eq < 0 ? part : part.slice(0, eq);
        let v = eq < 0 ? '' : part.slice(eq + 1);
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { v = ''; }
        if (!params.has(k)) params.set(k, v);
    }
    const rawNode = params.get('node');
    const node = rawNode ? claimNodeOrigin(rawNode) : null;
    const id = (params.get('id') ?? '').trim().toLowerCase();
    const code = (params.get('code') ?? '').trim().toLowerCase();
    return {
        node,
        nodeRefused: !!rawNode && !node,
        codeId: CODE_ID.test(id) ? id : null,
        code: CODE.test(code) ? code : null,
    };
}

/** The in-app route a claim link opens (app/claim-community.tsx), with only the checked fields. */
export function claimRouteFor(link: ClaimLink): string {
    const q: string[] = [];
    if (link.node) q.push(`node=${encodeURIComponent(link.node)}`);
    if (link.nodeRefused) q.push('refused=1');
    if (link.codeId) q.push(`id=${link.codeId}`);
    if (link.code) q.push(`code=${link.code}`);
    return `/claim-community${q.length ? `?${q.join('&')}` : ''}`;
}

export type ClaimStatus =
    | { kind: 'unclaimed'; codeId: string; salt: string; communityName: string | null }
    | { kind: 'no-code'; communityName: string | null }
    | { kind: 'claimed' }
    | { kind: 'busy'; retryAfter: number | null }
    | { kind: 'unreachable'; message: string };

type Fetch = typeof fetch;

function retryAfterOf(res: Response): number | null {
    const n = Number(res.headers?.get?.('Retry-After'));
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** GET /api/local/claim at `origin`. Only `unclaimed`, `codeId`, `salt` and `communityName` are read. */
export async function readClaimStatus(origin: string, fetchImpl: Fetch = fetch): Promise<ClaimStatus> {
    if (!isPlainNodeAddress(origin)) return { kind: 'unreachable', message: 'That is not a community address the app can use.' };
    let res: Response;
    try {
        res = await fetchImpl(`${origin}/api/local/claim`, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-store' } });
    } catch (e: any) {
        return { kind: 'unreachable', message: e?.message || 'Could not reach the server.' };
    }
    if (res.status === 429) return { kind: 'busy', retryAfter: retryAfterOf(res) };
    if (!res.ok) return { kind: 'unreachable', message: `The server did not answer (${res.status}).` };
    const body = await res.json().catch(() => null) as { unclaimed?: unknown; codeId?: unknown; salt?: unknown; communityName?: unknown } | null;
    if (!body || typeof body.unclaimed !== 'boolean') return { kind: 'unreachable', message: "That address doesn't answer like a BeanPool server." };
    if (body.unclaimed === false) return { kind: 'claimed' };
    const communityName = typeof body.communityName === 'string' && body.communityName.trim() ? body.communityName.trim().slice(0, 80) : null;
    if (typeof body.codeId === 'string' && CODE_ID.test(body.codeId) && typeof body.salt === 'string' && SALT.test(body.salt)) {
        return { kind: 'unclaimed', codeId: body.codeId, salt: body.salt, communityName };
    }
    return { kind: 'no-code', communityName };
}

export interface ClaimIdentity { publicKey: string; privateKey: string }

export interface ClaimRequest {
    origin: string;
    identity: ClaimIdentity;
    code: string;
    codeId: string;
    salt: string;
    callsign?: string;
}

/** The body a claim POSTs. Never the code, never K. Exported for the test that checks exactly that. */
export async function buildClaimBody(req: ClaimRequest): Promise<Record<string, string>> {
    if (!claimScryptIsTheApps()) throw new Error("This version of the app can't check claim codes safely.");
    if (!isPlainNodeAddress(req.origin)) throw new Error('That is not a community address the app can use.');
    const host = audienceOf(req.origin);
    if (!host) throw new Error('That is not a community address the app can use.');
    if (!isClaimCode(req.code)) throw new Error('That is not a whole claim code.');
    if (!CODE_ID.test(req.codeId) || !SALT.test(req.salt)) throw new Error("The server's answer can't be used.");
    const publicKey = String(req.identity.publicKey).toLowerCase();
    if (!KEY.test(publicKey)) throw new Error("This phone's key can't be read.");
    const k = await claimKeyFromCodeAsync(req.code, req.salt);
    const proof = claimProof(k, host, req.codeId, publicKey);
    k.fill(0);
    const signature = toBase64(await memberSigner(req.identity.privateKey)(signedRequestBytes(claimText(host, req.codeId, publicKey, proof))));
    return {
        publicKey,
        callsign: String(req.callsign ?? '').trim().slice(0, 20),
        codeId: req.codeId,
        signedFor: host,
        proof,
        signature,
    };
}

/** What the screen shows. `retryAfter` in seconds. */
export type ClaimOutcome =
    | { kind: 'owner'; callsign: string | null }
    | { kind: 'wrong-code' }
    | { kind: 'code-changed' }
    | { kind: 'already-claimed' }
    | { kind: 'no-code' }
    | { kind: 'wrong-server' }
    | { kind: 'braked'; retryAfter: number | null }
    | { kind: 'check-again' }
    | { kind: 'error'; message: string };

/**
 * Whether this phone's key is the node's owner, asked with the signed role lookup the app already uses
 * (node-admin.ts askNodeRole): 'owner', 'not-owner', or null when the node gave no answer.
 */
export type OwnerCheck = (origin: string, identity: ClaimIdentity) => Promise<'owner' | 'not-owner' | null>;

/**
 * The claim's answer was lost, or the node braked it: did it happen anyway? The node is asked whether it is unclaimed,
 * and when it has an owner, whether that owner is this key. Anything short of a clear answer is "check again".
 */
export async function confirmLostClaim(origin: string, identity: ClaimIdentity, isOwner: OwnerCheck, fetchImpl: Fetch = fetch): Promise<ClaimOutcome> {
    const status = await readClaimStatus(origin, fetchImpl);
    if (status.kind === 'claimed') {
        const who = await isOwner(origin, identity).catch(() => null);
        if (who === 'owner') return { kind: 'owner', callsign: null };
        if (who === 'not-owner') return { kind: 'already-claimed' };
        return { kind: 'check-again' };
    }
    if (status.kind === 'unclaimed' || status.kind === 'no-code') return { kind: 'error', message: "The claim didn't reach the server. Try again." };
    return { kind: 'check-again' };
}

/**
 * The whole claim, after the phone's unlock: derive, sign, POST, and read the answer. A lost answer (no reply, a 5xx,
 * an answer that isn't the node's) and a 429 go through {@link confirmLostClaim}.
 */
export async function claimCommunity(req: ClaimRequest & { isOwner: OwnerCheck; fetchImpl?: Fetch }): Promise<ClaimOutcome> {
    const fetchImpl = req.fetchImpl ?? fetch;
    let body: Record<string, string>;
    try {
        body = await buildClaimBody(req);
    } catch (e: any) {
        return { kind: 'error', message: e?.message || 'The claim could not be made.' };
    }
    let res: Response;
    try {
        res = await fetchImpl(`${req.origin}/api/local/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
        });
    } catch {
        return confirmLostClaim(req.origin, req.identity, req.isOwner, fetchImpl);
    }
    const answer = await res.json().catch(() => null) as { ok?: unknown; role?: unknown; callsign?: unknown; code?: unknown; error?: unknown } | null;
    if (res.ok && answer?.ok === true && answer.role === 'owner') {
        return { kind: 'owner', callsign: typeof answer.callsign === 'string' ? answer.callsign : null };
    }
    const code = typeof answer?.code === 'string' ? answer.code : '';
    if (res.status === 429) {
        const lost = await confirmLostClaim(req.origin, req.identity, req.isOwner, fetchImpl);
        if (lost.kind === 'owner') return lost;
        return { kind: 'braked', retryAfter: retryAfterOf(res) };
    }
    if (res.status === 421) return { kind: 'wrong-server' };
    if (code === 'claim_wrong_code') return { kind: 'wrong-code' };
    if (code === 'claim_code_changed') return { kind: 'code-changed' };
    if (code === 'claim_already_claimed') return { kind: 'already-claimed' };
    if (code === 'claim_no_code') return { kind: 'no-code' };
    if (res.status >= 500 || !answer) return confirmLostClaim(req.origin, req.identity, req.isOwner, fetchImpl);
    return { kind: 'error', message: typeof answer.error === 'string' && answer.error ? answer.error.slice(0, 200) : `The server refused the claim (${res.status}).` };
}

/** The words for each outcome but success (design: "The phone: Claim a community"). */
export function claimOutcomeMessage(outcome: ClaimOutcome, communityName: string): string {
    switch (outcome.kind) {
        case 'wrong-code':
            return "That code isn't right. Read it again on the server: docker compose exec beanpool-node cat /data/claim-code.txt";
        case 'code-changed':
            return 'The server made a new code; read it again.';
        case 'already-claimed':
            return `Someone already owns ${communityName}.`;
        case 'no-code':
            return 'This server has no claim code. Restart it to make one, then read the new code.';
        case 'wrong-server':
            return 'Your phone reached a different server than this address names. Check the address.';
        case 'braked':
            return outcome.retryAfter
                ? `Too many tries from this network. Wait ${outcome.retryAfter} seconds and try again.`
                : 'Too many tries from this network. Wait a little and try again.';
        case 'check-again':
            return `We couldn't confirm the claim yet. It may have worked. Check again in a minute, or from another network (Wi-Fi or mobile data).`;
        case 'error':
            return outcome.message;
        case 'owner':
            return '';
    }
}

/**
 * Whether the node already has a public address (`/api/community/info` `addresses`: its own names, empty on a node that
 * knows none). `beanpool claim` usually sets one first, so the success screen offers "Set the address" only on `false`;
 * `null` (no answer, an older node) offers Settings as usual.
 */
export async function readNodeHasAddress(origin: string, fetchImpl: Fetch = fetch): Promise<boolean | null> {
    if (!isPlainNodeAddress(origin)) return null;
    try {
        const res = await fetchImpl(`${origin}/api/community/info`, { method: 'GET', headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const body = await res.json().catch(() => null) as { addresses?: unknown } | null;
        if (!body || !Array.isArray(body.addresses)) return null;
        return body.addresses.some(a => typeof a === 'string' && a.trim() !== '');
    } catch {
        return null;
    }
}

/**
 * {@link OwnerCheck} through the signed role lookup the app already uses (`GET /api/node-admin/me`, node-admin.ts). A 429
 * or a 5xx is no answer ("check again"), not "someone else owns it".
 */
export const ownerCheckViaRole: OwnerCheck = async (origin, identity) => {
    try {
        const url = `${origin}/api/node-admin/me`;
        const headers = await buildSignedHeaders('GET', url, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers } });
        if (res.status === 429 || res.status >= 500) return null;
        if (!res.ok) return 'not-owner';
        const body = await res.json().catch(() => null) as { role?: unknown } | null;
        if (!body) return null;
        return body.role === 'owner' ? 'owner' : 'not-owner';
    } catch {
        return null;
    }
};
