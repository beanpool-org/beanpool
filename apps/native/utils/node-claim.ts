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
 *      hold it). No answer in time ({@link CLAIM_REQUEST_TIMEOUT_MS}) is a lost answer too.
 *
 * The key the node registers is the one the claim is signed with: the phone's own account when it has one (one identity
 * per device), else the one the claim made for this phone (utils/claim-key.ts, which writes it to the phone just before
 * the POST, through `beforePost`). Nothing here makes, writes or takes off a key.
 */
import {
    CLAIM_SCRYPT, audienceOf, claimKeyFromCodeAsync, claimProof, claimText, signedRequestBytes, toBase64,
} from '@beanpool/core';
import { buildSignedHeaders, memberSigner } from './crypto';
import { isPlainNodeAddress } from './node-url';
import { CLAIM_CODE_ID, cleanClaimName, isClaimCode } from './claim-link';

export * from './claim-link';

/**
 * The scrypt for K, the server's (Node's defaults, a 32-byte key). The app's own copy: a claim refuses to run when
 * core's helper would use anything else, so no change elsewhere can lower what a captured proof costs to attack.
 */
export const APP_CLAIM_SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, dkLen: 32 });

export function claimScryptIsTheApps(params: { N: number; r: number; p: number; dkLen: number } = CLAIM_SCRYPT): boolean {
    return params.N === APP_CLAIM_SCRYPT.N && params.r === APP_CLAIM_SCRYPT.r && params.p === APP_CLAIM_SCRYPT.p
        && params.dkLen === APP_CLAIM_SCRYPT.dkLen;
}

const CODE_ID = CLAIM_CODE_ID;
const SALT = /^[0-9a-f]{16,128}$/;
const KEY = /^[0-9a-f]{64}$/;

/**
 * `communityName` is what the server says its name is: whoever runs that server writes it, and it is shown large, as the
 * claim screen's title and the Find a community card's heading, right above the real address. Cleaned with
 * {@link cleanClaimName}; when nothing is left (or the server sent none) it is the address's host instead.
 */
export type ClaimStatus =
    | { kind: 'unclaimed'; codeId: string; salt: string; communityName: string }
    | { kind: 'no-code'; communityName: string }
    | { kind: 'claimed' }
    | { kind: 'busy'; retryAfter: number | null }
    | { kind: 'unreachable'; message: string };

type Fetch = typeof fetch;

/**
 * Each request of a claim gets this long, as the global door's do (global-join.ts JOIN_TIMEOUT_MS): the claim screen
 * can't be left while the claim is out (app/claim-community.tsx `leave`), and nothing else bounds how long a fetch may
 * wait. A claim with no answer in time may still have landed: it is a lost answer, and the node is asked whether it did
 * ({@link confirmLostClaim}), with the same time for each of those reads.
 */
export const CLAIM_REQUEST_TIMEOUT_MS = 30_000;

/**
 * `ask`, given {@link CLAIM_REQUEST_TIMEOUT_MS} to answer, else `late`: its fetch is aborted then, and raced as well,
 * so the wait ends even where a fetch doesn't stop when asked to (invite-next.ts nodeSaysMember). The answer's body is
 * read inside `ask`: a reply whose body never comes is no answer either.
 */
async function inTime<T>(ask: (signal: AbortSignal) => Promise<T>, late: T): Promise<T> {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outOfTime = new Promise<T>((resolve) => {
        // `late` before the abort: whatever the abort makes of the fetch comes after it.
        timer = setTimeout(() => { resolve(late); stop.abort(); }, CLAIM_REQUEST_TIMEOUT_MS);
    });
    try {
        return await Promise.race([ask(stop.signal), outOfTime]);
    } finally {
        clearTimeout(timer);
    }
}

function retryAfterOf(res: Response): number | null {
    const n = Number(res.headers?.get?.('Retry-After'));
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}

/** Anything that looks like a claim code (with or without `claim-` and the dashes), for the developer log. */
const CODE_SHAPED = /(?:claim-)?[0-9a-f]{4}(?:-?[0-9a-f]{4}){3}/gi;

/** GET /api/local/claim at `origin`. Only `unclaimed`, `codeId`, `salt` and `communityName` are read. */
export async function readClaimStatus(origin: string, fetchImpl: Fetch = fetch): Promise<ClaimStatus> {
    if (!isPlainNodeAddress(origin)) return { kind: 'unreachable', message: 'That is not a community address the app can use.' };
    let reply: { res: Response; body: unknown } | null;
    try {
        reply = await inTime(async (signal) => {
            const res = await fetchImpl(`${origin}/api/local/claim`, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-store' }, signal });
            return { res, body: res.ok ? await res.json().catch(() => null) : null };
        }, null);
    } catch (e: any) {
        return { kind: 'unreachable', message: e?.message || 'Could not reach the server.' };
    }
    if (!reply) return { kind: 'unreachable', message: 'Could not reach the server.' };
    const { res } = reply;
    if (res.status === 429) return { kind: 'busy', retryAfter: retryAfterOf(res) };
    if (!res.ok) return { kind: 'unreachable', message: `The server did not answer (${res.status}).` };
    const body = reply.body as { unclaimed?: unknown; codeId?: unknown; salt?: unknown; communityName?: unknown } | null;
    if (!body || typeof body.unclaimed !== 'boolean') return { kind: 'unreachable', message: "That address doesn't answer like a BeanPool server." };
    if (body.unclaimed === false) return { kind: 'claimed' };
    const communityName = cleanClaimName(body.communityName) ?? audienceOf(origin) ?? origin;
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
 * What the node said to the claim's POST itself (utils/claim-key.ts counts a claim signed by a key the claim made as out
 * until the node refuses it, utils/door-key.ts):
 * - `unsent`: nothing went out (the body could not be made, or `beforePost` stopped it);
 * - `owner`: this key owns the community, by the POST's answer or by the owner check after a lost one;
 * - `refused`: the node refused this POST before or instead of any write (a wrong or changed code, no code, another
 *   server, the brake, a refusal this app has no words for);
 * - `another-owner`: the POST's own `claim_already_claimed`: by the node's answer, another key owns it;
 * - `not-owner`: after a lost answer, the owner check said the node's owner is not this key;
 * - `unclear`: no clear answer. The claim may have landed.
 */
export type ClaimHeard = 'unsent' | 'owner' | 'refused' | 'another-owner' | 'not-owner' | 'unclear';

/** What a claim showed and what the node said to it. */
export interface ClaimAnswer { outcome: ClaimOutcome; heard: ClaimHeard }

/**
 * The whole claim, after the phone's unlock: derive, sign, POST, and read the answer. A lost answer (no reply, or none
 * in time, a 5xx, an answer that isn't the node's, a 2xx that isn't an owner's) and a 429 go through
 * {@link confirmLostClaim}.
 */
export async function claimCommunity(req: ClaimRequest & { isOwner: OwnerCheck; fetchImpl?: Fetch; beforePost?: () => Promise<void> }): Promise<ClaimOutcome> {
    return (await claimAndHear(req)).outcome;
}

/**
 * {@link claimCommunity}, with what the node said to the POST itself ({@link ClaimHeard}). `beforePost` runs once the
 * body is signed and before the POST goes: the claim's key goes onto the phone there (utils/claim-key.ts). When it
 * throws, nothing is sent.
 */
export async function claimAndHear(req: ClaimRequest & { isOwner: OwnerCheck; fetchImpl?: Fetch; beforePost?: () => Promise<void> }): Promise<ClaimAnswer> {
    const fetchImpl = req.fetchImpl ?? fetch;
    let body: Record<string, string>;
    try {
        body = await buildClaimBody(req);
        await req.beforePost?.();
    } catch (e: any) {
        return { outcome: { kind: 'error', message: e?.message || 'The claim could not be made.' }, heard: 'unsent' };
    }
    const lost = async (): Promise<ClaimAnswer> => {
        const outcome = await confirmLostClaim(req.origin, req.identity, req.isOwner, fetchImpl);
        return { outcome, heard: outcome.kind === 'owner' ? 'owner' : outcome.kind === 'already-claimed' ? 'not-owner' : 'unclear' };
    };
    const reply = await inTime(async (signal) => {
        const res = await fetchImpl(`${req.origin}/api/local/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
        const answer = await res.json().catch(() => null) as { ok?: unknown; role?: unknown; callsign?: unknown; code?: unknown; error?: unknown } | null;
        return { res, answer };
    }, null).catch(() => null);
    // No answer, or none in time: the claim may have landed all the same.
    if (!reply) return lost();
    const { res, answer } = reply;
    if (res.ok && answer?.ok === true && answer.role === 'owner') {
        return { outcome: { kind: 'owner', callsign: typeof answer.callsign === 'string' ? answer.callsign : null }, heard: 'owner' };
    }
    const code = typeof answer?.code === 'string' ? answer.code : '';
    if (res.status === 429) {
        // The node brakes only before it writes anything, so this POST changed nothing; an earlier one may have landed.
        const earlier = await confirmLostClaim(req.origin, req.identity, req.isOwner, fetchImpl);
        if (earlier.kind === 'owner') return { outcome: earlier, heard: 'owner' };
        return { outcome: { kind: 'braked', retryAfter: retryAfterOf(res) }, heard: 'refused' };
    }
    if (res.status === 421) return { outcome: { kind: 'wrong-server' }, heard: 'refused' };
    if (code === 'claim_wrong_code') return { outcome: { kind: 'wrong-code' }, heard: 'refused' };
    if (code === 'claim_code_changed') return { outcome: { kind: 'code-changed' }, heard: 'refused' };
    if (code === 'claim_already_claimed') return { outcome: { kind: 'already-claimed' }, heard: 'another-owner' };
    if (code === 'claim_no_code') return { outcome: { kind: 'no-code' }, heard: 'refused' };
    // The node answers 2xx only for an owner: anything else in a 2xx is no answer of the node's.
    if (res.status >= 500 || !answer || res.ok) return lost();
    // A refusal this app has no words for. The server's own text never reaches the screen: it would sit right under the
    // code field, the one place a server could still talk the owner out of the code. Dev builds log it, never with the
    // code: the code is not in the line, and anything in the server's text shaped like a claim code is blanked.
    if (typeof __DEV__ !== 'undefined' && __DEV__ && typeof answer.error === 'string' && answer.error) {
        const said = answer.error.slice(0, 200).replace(CODE_SHAPED, '[code]');
        console.warn(`[claim] the server refused the claim (${res.status}): ${said}`);
    }
    return { outcome: { kind: 'error', message: `The server refused the claim (${res.status}).` }, heard: 'refused' };
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
 * The node's own addresses (`/api/community/info` `addresses`: its names, and its public number once it has one; empty on
 * a node that knows none), the non-blank strings of them. Null for no answer or an older node that doesn't say.
 */
export async function readNodeAddresses(origin: string, fetchImpl: Fetch = fetch): Promise<string[] | null> {
    if (!isPlainNodeAddress(origin)) return null;
    // Read while the claim screen still says "Claiming…" (the phone's own account's success): in time, or none.
    return inTime(async (signal) => {
        try {
            const res = await fetchImpl(`${origin}/api/community/info`, { method: 'GET', headers: { Accept: 'application/json' }, signal });
            if (!res.ok) return null;
            const body = await res.json().catch(() => null) as { addresses?: unknown } | null;
            if (!body || !Array.isArray(body.addresses)) return null;
            return body.addresses.filter((a): a is string => typeof a === 'string' && a.trim() !== '').map(a => a.trim());
        } catch {
            return null;
        }
    }, null);
}

/**
 * Whether the node already has a public address (readNodeAddresses). `beanpool claim` usually sets one first, so the
 * success screen offers "Set the address" only on `false`; `null` (no answer, an older node) offers Settings as usual.
 */
export async function readNodeHasAddress(origin: string, fetchImpl: Fetch = fetch): Promise<boolean | null> {
    const addresses = await readNodeAddresses(origin, fetchImpl);
    return addresses ? addresses.length > 0 : null;
}

/**
 * The node's refusal of a key that is no member there (apps/server engine/members.ts NOT_A_MEMBER_CODE): its read gate's,
 * for a key with no member row, and node-admin.ts's, for one that is no active member.
 */
const NOT_A_MEMBER = 'not_a_member';

/**
 * {@link OwnerCheck} through the signed role lookup the app already uses (`GET /api/node-admin/me`, node-admin.ts). Only
 * the node saying so is "someone else owns it": a role it names that is not owner, or its refusal of a key that is no
 * member there (403 `not_a_member`). Anything else is no answer ("check again"): a 429 or a 5xx, a 401 for the phone's
 * clock, a 421 for a host the node's names don't take yet, an older node's 404, a 2xx that names no role, and every other
 * 403, which the signature check gives for reasons that say nothing about who owns the node (a nonce already spent by
 * the same request sent twice, a signature it couldn't check, a replaced or closed key), and no answer in time. A
 * claim's own key comes off the phone on "someone else owns it" (utils/claim-key.ts), so a key the node may hold as
 * owner is never taken for someone else's.
 */
export const ownerCheckViaRole: OwnerCheck = (origin, identity) => inTime(async (signal) => {
    try {
        const url = `${origin}/api/node-admin/me`;
        const headers = await buildSignedHeaders('GET', url, '', identity.privateKey, identity.publicKey);
        delete headers['Content-Type'];
        const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json', ...headers }, signal });
        if (res.status === 403) {
            const refusal = await res.json().catch(() => null) as { code?: unknown } | null;
            return refusal?.code === NOT_A_MEMBER ? 'not-owner' : null;
        }
        if (!res.ok) return null;
        const body = await res.json().catch(() => null) as { role?: unknown } | null;
        // The node names the role, or none (null).
        if (!body || !(typeof body.role === 'string' || body.role === null)) return null;
        return body.role === 'owner' ? 'owner' : 'not-owner';
    } catch {
        return null;
    }
}, null);

/**
 * The success screen's buttons. Manage opens only the phone's own community (NodeAdminEntry), so a phone anchored
 * elsewhere is first asked to make this its community. "Set the address" only when the node says it has none.
 */
export type ClaimSuccessAction = 'set-address' | 'open-settings' | 'make-mine' | 'not-now';

export function claimSuccessActions(opts: { isAnchor: boolean; hasAddress: boolean | null }): ClaimSuccessAction[] {
    if (!opts.isAnchor) return ['make-mine', 'not-now'];
    return [opts.hasAddress === false ? 'set-address' : 'open-settings'];
}
