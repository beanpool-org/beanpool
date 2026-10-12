/**
 * A member's new phone takes over their account with the admin's re-key code (#1768; design
 * scratch/global-node/DESIGN-rekey-redeem-fable.md §5, decided by Marty 2026-10-11).
 *
 * Scanning or typing the RK- code binds nothing. The phone ASKS (`POST /api/member/re-enroll`, signed by the key it wants
 * bound) and is given two digits to show the admin; the admin types that number on the dashboard and the node binds the
 * phone showing it (#1783 review B2), and the phone's poll (`GET /api/member/re-enroll/status`) then says `bound`.
 *
 * ## One identity per device, never overwritten
 *
 * A phone that holds a key (another community's member, or a door account) asks with THAT key: nothing new is made. A
 * phone with none makes one (`draftIdentity`), and it stays in this flow's own record, never the phone's identity, until
 * the node says it is bound. So a killed app never leaves a half-made account behind for the gatekeeper, and the
 * phone's identity is written only once, by {@link finishRekey}, and only when there is none.
 *
 * ## The key is on the phone before anything is sent
 *
 * {@link beginRekey} writes the record (community, code, key, and a new key's words) BEFORE the caller's first request.
 * Every step is resumable: the same record asks again with the same key, which the node answers with the same number;
 * the key the code was completed with is told `bound` (a lost answer). On the next launch {@link resumeRekey} asks once:
 * bound → saved; declined, gone or a dead code → the record goes, and a key it made with it (no node ever accepted it);
 * unreachable → kept, and the screen shows again.
 *
 * Pure: storage, signing and the network are passed in (`RekeyDeps`), so the order of every write and request is tested
 * (utils/__tests__/rekey-redeem.test.ts).
 */

import type { BeanPoolIdentity } from './identity';
import { looksLikeNodeAddress, normalizeNodeUrl, plainOriginOf, isPlainNodeAddress } from './node-url';

/** How often the screen asks whether the admin has bound this phone. */
export const REKEY_POLL_MS = 3000;

/** A code's life (server engine/member-wizards.ts REKEY_CODE_TTL_MS): a record older than this can no longer be bound. */
export const REKEY_ASK_LIFE_MS = 24 * 60 * 60 * 1000;

/** A code as the admin's screen shows it: `RK-` and two groups of four hex digits. */
const CODE = /^RK-[0-9A-F]{4}-[0-9A-F]{4}$/;

/** The code as the admin's screen spells it, whatever case, spaces or missing dashes the member typed. */
export function cleanRekeyCode(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const s = raw.trim().toUpperCase().replace(/\s+/g, '');
    const hex = s.replace(/^RK-?/, '').replace(/-/g, '');
    if (/^[0-9A-F]{8}$/.test(hex)) return `RK-${hex.slice(0, 4)}-${hex.slice(4)}`;
    return s;
}

export function isRekeyCode(raw: unknown): boolean {
    return CODE.test(cleanRekeyCode(raw));
}

/**
 * A community the member named, as the address the phone will use: a full address (any domain: no beanpool.org needed) or
 * a bare name, plain (one host, node-url.ts `isPlainNodeAddress`). Null for anything else.
 */
export function rekeyCommunityUrl(input: unknown): string | null {
    if (typeof input !== 'string' || !input.trim()) return null;
    const url = normalizeNodeUrl(input.trim());
    if (!looksLikeNodeAddress(url) || !isPlainNodeAddress(url)) return null;
    return plainOriginOf(url) || null;
}

/**
 * What the dashboard's QR (or a shared link) holds: `https://<node>/?rekey=RK-…`, or a bare code. The community is the
 * link's own address. Null when it holds no code.
 */
export function parseRekeyLink(raw: unknown): { community: string | null; code: string } | null {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    if (isRekeyCode(s)) return { community: null, code: cleanRekeyCode(s) };
    // The address as written must name one host (node-url.ts isPlainNodeAddress): parsers disagree on `\` and `@`.
    if (!isPlainNodeAddress(s)) return null;
    let url: URL;
    try {
        url = new URL(s);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const code = url.searchParams.get('rekey');
    if (!isRekeyCode(code)) return null;
    const community = rekeyCommunityUrl(url.origin);
    return community ? { community, code: cleanRekeyCode(code) } : null;
}

// ── the record ───────────────────────────────────────────────────────────────────────────────────────────────────

/** This flow's record on the phone: written before the first request, gone once bound, declined or dead. */
export interface RekeySlot {
    community: string;
    code: string;
    publicKey: string;
    /** True: this flow made the key, and `draft` holds it until it is bound. False: the phone's own key. */
    madeHere: boolean;
    draft?: BeanPoolIdentity;
    startedAt: number;
    /**
     * True once a node answered with a number for this ask, written before the screen shows it. The admin binds only by
     * typing that number (#1783 review B2), so an ask whose number never showed can't be bound (#1783 review C1).
     */
    shown?: boolean;
}

export interface RekeySlotStore {
    get(): Promise<RekeySlot | null>;
    set(slot: RekeySlot): Promise<void>;
    clear(): Promise<void>;
}

export type RekeyAnswer =
    | { state: 'waiting'; match: string; expiresAt: string }
    | { state: 'bound'; callsign: string; communityName: string; linkSignInAgain: boolean }
    | { state: 'declined' }
    | { state: 'gone' }
    /** The node refused the ask, in its own words (a dead code, a phone with an account here, too many tries). */
    | { state: 'refused'; message: string; code?: string }
    /** No answer, or one that says nothing: the record is kept and the phone asks again. */
    | { state: 'unreachable' };

export interface RekeyDeps {
    slot: RekeySlotStore;
    loadIdentity(): Promise<BeanPoolIdentity | null>;
    draftIdentity(): Promise<BeanPoolIdentity>;
    importIdentity(identity: BeanPoolIdentity): Promise<void>;
    /** `0xFF ‖ beanpool-re-enroll/2\nHOST\nCODE`, signed by the key (member-statements.ts signReEnrollStatement). */
    signStatement(nodeUrl: string, code: string, privateKeyHex: string): Promise<{ signature: string; signedFor: string }>;
    /** The replay-proof request headers (crypto.ts buildSignedHeaders). */
    signedHeaders(method: string, url: string, body: string, privateKeyHex: string, publicKeyHex: string): Promise<Record<string, string>>;
    fetch: typeof fetch;
}

/** The sentences the phone says itself, when the node gave none. */
export const REKEY_TEXT = {
    declined: 'Your admin said this phone isn’t yours, so nothing changed. Ask them to try again with you there.',
    gone: 'That code isn’t valid any more. Ask the admin for a new one.',
    wrongCommunity: 'That code is for another community. Check the community’s name or address and try again.',
    unreachable: 'Couldn’t reach your community. Check your connection: you can try again, and the code still works until it expires.',
    changedAccount: 'This phone’s account changed while you waited, so nothing was saved. Start again.',
} as const;

/**
 * Refused because an earlier ask may still be bound. `canForget`: the screen offers to forget it ({@link abandonRekey})
 * only when its node can't be reached, or it was bound and this phone holds another account since. A node that still
 * waits for the number is left to the code, the admin's Not theirs, or the day (#1783 review D1).
 */
export class RekeyHeldError extends Error {
    constructor(message: string, readonly host: string, readonly canForget: boolean) {
        super(message);
        this.name = 'RekeyHeldError';
    }
}

/** When this phone lets a held ask go by itself: a code's life after it started, in words. */
function letsGoIn(startedAt: number): string {
    const hours = Math.ceil((startedAt + REKEY_ASK_LIFE_MS - Date.now()) / 3600000);
    return hours <= 1 ? 'within the hour' : `in about ${hours} hours`;
}

/**
 * Starts (or resumes) an ask: the key this phone asks with, written down with the community and the code BEFORE the
 * caller sends anything. A record already here for the same community and code keeps its key: the same proposal, the
 * same number. A record for another community or code is never re-pointed while its node may still bind it (#1783
 * review N2): it is asked first. Bound, it is returned, so the caller's ask is told `bound` and finishes it (#1783
 * review D1). Ended, it is let go. Otherwise this ask is refused while its code may live, and let go after.
 * Only an ask that showed a number is asked about: any other (a typo in the name, an address that isn't a BeanPool node)
 * can't be bound, and is re-pointed here, keeping its key (#1783 review C1).
 */
export async function beginRekey(community: string, rawCode: string, deps: RekeyDeps): Promise<RekeySlot> {
    const code = cleanRekeyCode(rawCode);
    if (!CODE.test(code)) throw new Error('That isn’t a whole re-key code. It starts RK- and has eight letters and numbers.');
    const url = rekeyCommunityUrl(community);
    if (!url) throw new Error('That isn’t a community address the app can use.');
    let held = await deps.slot.get();
    const stored = await deps.loadIdentity();
    if (held?.madeHere && held.draft && (held.community !== url || held.code !== code) && held.shown) {
        const open = held;
        const where = (() => { try { return new URL(open.community).host; } catch { return open.community; } })();
        const answer = await pollRekey(open, deps);
        if (answer.state === 'bound') {
            // The admin typed the number (after Not now, or while the phone was away): the account is on this key now.
            if (!stored || stored.publicKey === open.publicKey) return open;
            throw new RekeyHeldError(`Your re-key at ${where} went through, but this phone holds another account now, and a phone holds only one. Forget that re-key to go on: your account at ${where} then needs a new code from an admin there.`, where, true);
        }
        if (endsRekey(answer)) {
            await abandonRekey(deps);
            held = null;
        } else if (Date.now() - open.startedAt < REKEY_ASK_LIFE_MS) {
            throw new RekeyHeldError(answer.state === 'unreachable'
                ? `This phone showed a number for a re-key at ${where}, and ${where} isn’t answering. Try again later, or forget that re-key.`
                : `The re-key you started at ${where} with ${open.code} is still open: an admin there can still type the number this phone showed. To go on with it, type that code. To end it, ask the admin there to press Not theirs. Otherwise this phone lets it go by itself ${letsGoIn(open.startedAt)}.`,
            where, answer.state === 'unreachable');
        }
        // A day old and not bound: its code has died (the node's REKEY_CODE_TTL_MS), whatever its node says now, so it
        // is re-pointed below with its key (#1783 review C1, D1c).
    }
    let slot: RekeySlot;
    if (stored) {
        // One identity per device: the phone's own key, never a new one beside it.
        slot = { community: url, code, publicKey: stored.publicKey, madeHere: false, startedAt: Date.now() };
    } else if (held?.madeHere && held.draft) {
        // The same ask, or one that can't be bound any more (above): the same key, pointed at this community and code.
        slot = held.community === url && held.code === code ? held : { ...held, community: url, code, startedAt: Date.now(), shown: false };
    } else {
        const draft = await deps.draftIdentity();
        slot = { community: url, code, publicKey: draft.publicKey, madeHere: true, draft, startedAt: Date.now() };
    }
    await deps.slot.set(slot);
    return slot;
}

/** The key the record asks with: the one it made, or the phone's own (null when the phone's account changed since). */
async function keyOf(slot: RekeySlot, deps: RekeyDeps): Promise<BeanPoolIdentity | null> {
    if (slot.madeHere) return slot.draft && slot.draft.publicKey === slot.publicKey ? slot.draft : null;
    const stored = await deps.loadIdentity();
    return stored && stored.publicKey === slot.publicKey ? stored : null;
}

function readAnswer(status: number, body: any): RekeyAnswer {
    if (status === 200 && body && typeof body.state === 'string') {
        if (body.state === 'waiting' && typeof body.match === 'string') return { state: 'waiting', match: body.match, expiresAt: String(body.expiresAt ?? '') };
        if (body.state === 'bound') return { state: 'bound', callsign: String(body.callsign ?? ''), communityName: String(body.communityName ?? ''), linkSignInAgain: body.linkSignInAgain === true };
        if (body.state === 'declined') return { state: 'declined' };
        if (body.state === 'gone') return { state: 'gone' };
    }
    // A 421 is re-sent by fetch on a new connection (the fetch spec), and the copy, its nonce spent, reads as a replay.
    if (status === 421 || body?.code === 'wrong_community' || (status === 403 && /nonce already used/i.test(String(body?.error ?? '')))) {
        return { state: 'refused', message: REKEY_TEXT.wrongCommunity, code: 'wrong_community' };
    }
    if (status >= 400 && status < 500 && typeof body?.error === 'string') return { state: 'refused', message: body.error, code: body.code };
    return { state: 'unreachable' };
}

/** The ask: a proposal and its number, the same again for the same key, or `bound` for the key the code was completed with. */
export async function askRekey(slot: RekeySlot, deps: RekeyDeps): Promise<RekeyAnswer> {
    const key = await keyOf(slot, deps);
    if (!key) return { state: 'refused', message: REKEY_TEXT.changedAccount, code: 'changed_account' };
    const url = `${slot.community}/api/member/re-enroll`;
    try {
        const { signature, signedFor } = await deps.signStatement(slot.community, slot.code, key.privateKey);
        const body = JSON.stringify({ code: slot.code, newPublicKey: key.publicKey, signature, signedFor });
        const headers = await deps.signedHeaders('POST', url, body, key.privateKey, key.publicKey);
        const res = await deps.fetch(url, { method: 'POST', headers, body });
        return await marked(slot, readAnswer(res.status, await res.json().catch(() => null)), deps);
    } catch {
        return { state: 'unreachable' };
    }
}

/** A number is about to show: the record says so first, so this ask is never re-pointed while it may be bound. */
async function marked(slot: RekeySlot, answer: RekeyAnswer, deps: RekeyDeps): Promise<RekeyAnswer> {
    if (answer.state !== 'waiting') return answer;
    const held = await deps.slot.get();
    if (held && !held.shown && held.community === slot.community && held.code === slot.code && held.publicKey === slot.publicKey) {
        await deps.slot.set({ ...held, shown: true });
    }
    return answer;
}

/** Where the ask stands. A 429 or no answer is `unreachable`: the screen keeps waiting and asks again. */
export async function pollRekey(slot: RekeySlot, deps: RekeyDeps): Promise<RekeyAnswer> {
    const key = await keyOf(slot, deps);
    if (!key) return { state: 'refused', message: REKEY_TEXT.changedAccount, code: 'changed_account' };
    const url = `${slot.community}/api/member/re-enroll/status?code=${encodeURIComponent(slot.code)}`;
    try {
        const headers = await deps.signedHeaders('GET', url, '', key.privateKey, key.publicKey);
        const res = await deps.fetch(url, { method: 'GET', headers });
        if (res.status === 429) return { state: 'unreachable' };
        return await marked(slot, readAnswer(res.status, await res.json().catch(() => null)), deps);
    } catch {
        return { state: 'unreachable' };
    }
}

/**
 * Bound: the key is the member's now. A key this flow made becomes the phone's identity, with the member's name from the
 * node, and only if the phone still holds none (never over another account). The phone's own key is left as it is. The
 * record goes. Returns the identity and whether its words are new (Safety Backup shows them).
 */
export async function finishRekey(slot: RekeySlot, answer: { callsign: string }, deps: RekeyDeps): Promise<{ identity: BeanPoolIdentity; newWords: boolean }> {
    const stored = await deps.loadIdentity();
    if (slot.madeHere) {
        if (!slot.draft || slot.draft.publicKey !== slot.publicKey) throw new Error(REKEY_TEXT.changedAccount);
        if (stored && stored.publicKey !== slot.publicKey) throw new Error(REKEY_TEXT.changedAccount);
        const identity = { ...slot.draft, callsign: answer.callsign || slot.draft.callsign };
        if (!stored) await deps.importIdentity(identity);
        await deps.slot.clear();
        return { identity, newWords: true };
    }
    if (!stored || stored.publicKey !== slot.publicKey) throw new Error(REKEY_TEXT.changedAccount);
    await deps.slot.clear();
    return { identity: stored, newWords: false };
}

/** Declined, gone or a dead code: the record goes, and with it a key this flow made (it was never the phone's identity). */
export async function abandonRekey(deps: RekeyDeps): Promise<void> {
    await deps.slot.clear();
}

/** An answer that ends the ask for good (the record and its key go). */
export function endsRekey(answer: RekeyAnswer): boolean {
    return answer.state === 'declined' || answer.state === 'gone'
        || (answer.state === 'refused' && (answer.code === 'code_not_valid' || answer.code === 'code_full' || answer.code === 'key_has_account' || answer.code === 'changed_account'));
}

/**
 * The next launch: a record left by an app stopped mid-ask is asked about once. `bound` is for the caller to finish
 * ({@link finishRekey}); an answer that ends it clears the record here; no answer keeps it. Null when there is none.
 * The status (GET) first, which no wrong-code limit holds back (#1783 review N4); the ask is sent again only when the
 * node never heard it (`gone`: the app stopped before the ask arrived, or the code is dead, which the ask then says).
 */
export async function resumeRekey(deps: RekeyDeps): Promise<{ slot: RekeySlot; answer: RekeyAnswer } | null> {
    const slot = await deps.slot.get();
    if (!slot) return null;
    const status = await pollRekey(slot, deps);
    const answer = status.state === 'gone' ? await askRekey(slot, deps) : status;
    if (endsRekey(answer)) await abandonRekey(deps);
    return { slot, answer };
}
