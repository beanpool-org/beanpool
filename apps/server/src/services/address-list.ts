/**
 * One community, several addresses, slice S2: the server publishes and proves (design scratch/fable-design/
 * DESIGN-several-addresses-fable.md §2.2, §2.3, §6, §7; decided by Marty 16 Nov). The bytes, the spelling of an address
 * and the order are core's (@beanpool/core address-list.ts, S0); this file is what this server signs with them.
 *
 * **The list.** `GET /api/node/addresses` (routes/address-list.ts), at every address: the community's addresses and its
 * main one (engine/own-addresses.ts addressListContent), signed with the server key, numbered `(epoch, seq)`:
 *   - `epoch` is the take-over count (services/identity-epoch.ts ownIdentityEpoch), so a take-over's list beats every list
 *     from before it, whatever its counter;
 *   - `seq` goes up by exactly one whenever the content changes (an address added or removed, a new main, a port, the key
 *     or the community id), and never for no change. The content is compared with the last list signed, kept in
 *     node_config `addressList`, at every read and on a timer (startAddressListWatch), so no writer has to remember to
 *     call. The new number is stored BEFORE anything is signed with it, so two lists with different content are never
 *     signed at one number by this server, a restart included.
 * A promoted standby goes on from the number the take-over envelope carries (services/takeover-envelope.ts `addressList`,
 * written by the take-over's `public-address` step), at the bundle's epoch + 1.
 *
 * **The proof.** `GET /api/node/proof?for=<address>&nonce=<32 hex>`: the server key's signature over core's proof bytes
 * for that address, that nonce and the list's number, only for an address exactly on the current list (400 for a nonce
 * that is not 32 lower-case hex, 421 for anything else: another spelling, a former, lost or loopback name, a removed
 * address). It never reads the Host header: the phone names the address it dialled, and the signed bytes carry it.
 *
 * **Once replaced** (identity-epoch.ts: another server took over this identity, or took over to the same epoch first), this
 * server signs neither: both reads answer 503 with the read-only words, so phones on its addresses stop using them and
 * go where the newer list sends them. A replaced server's list is never newer than the one that replaced it, and nothing it
 * signs about where the community lives is worth a phone's trust.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import {
    ADDRESS_LIST_MAX, ADDRESS_SPARES_MAX, addressProofRefusal, isListableAddress, sameAddressListContent, signAddressList,
    signAddressProof, type AddressListFields, type AddressProof, type SignedAddressList,
} from '@beanpool/core';
import { getNodeConfig, updateNodeConfig } from '../state-engine.js';
import { addressListContent } from '../engine/own-addresses.js';
import { readNodeIdentity, type NodeIdentity } from './takeover-envelope.js';
import { ownCommunityId, ownIdentityEpoch, replacedNow } from './identity-epoch.js';
import { logger } from '../logger.js';

const COMMUNITY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const NONCE_HEX = /^[0-9a-f]{32}$/;
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const isAddressArray = (xs: unknown, max: number): xs is string[] =>
    Array.isArray(xs) && xs.length <= max && xs.every((x) => isListableAddress(x));

/**
 * A kept record (node_config `addressList`, or one a take-over envelope carries) read back: the last list signed, or null
 * for anything not in its shape. Read as any stored record is: a malformed one counts as none, so the next list is
 * numbered from nothing kept rather than from a guess.
 */
export function readAddressListRecord(x: unknown): AddressListFields | null {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
    const r = x as Record<string, unknown>;
    if (typeof r.peerId !== 'string' || typeof r.communityId !== 'string' || typeof r.main !== 'string') return null;
    if (!isCount(r.epoch) || !isCount(r.seq)) return null;
    if (!isAddressArray(r.addresses, ADDRESS_LIST_MAX) || !isAddressArray(r.spares, ADDRESS_SPARES_MAX)) return null;
    return {
        peerId: r.peerId, communityId: r.communityId, epoch: r.epoch, seq: r.seq, main: r.main,
        addresses: [...r.addresses], spares: [...r.spares],
    };
}

/** The list this server last signed, as kept in node_config. */
export function keptAddressList(): AddressListFields | null {
    return readAddressListRecord(getNodeConfig().addressList);
}

/** Why this server has no list to sign now, in words for a phone or a person reading the raw answer. */
export type NoAddressList =
    | { why: 'replaced'; message: string }
    | { why: 'no-node-key' | 'no-community' | 'no-address'; message: string };

type ListNow = { ok: true; fields: AddressListFields; identity: NodeIdentity } | ({ ok: false } & NoAddressList);

/**
 * The list as it stands now, numbered: the kept number when the content is the kept content, else one more, stored before
 * it is returned. Synchronous from the read of what is kept to the write of the new number, so two requests at once can
 * never number two contents alike. Never bumps while replaced.
 */
function listNow(): ListNow {
    const replaced = replacedNow();
    if (replaced) return { ok: false, why: 'replaced', message: `${replaced.message} Another server took over this community; use that one.` };
    let identity: NodeIdentity | null;
    try {
        identity = readNodeIdentity();
    } catch {
        identity = null;
    }
    if (!identity) return { ok: false, why: 'no-node-key', message: 'This server has no node key yet.' };
    const communityId = ownCommunityId();
    if (!communityId || !COMMUNITY_ID.test(communityId)) return { ok: false, why: 'no-community', message: 'This server has no community yet.' };
    const content = addressListContent();
    if (!content) {
        return { ok: false, why: 'no-address', message: 'This server knows none of its addresses yet, so it has no list to sign. Its owner confirms one in Settings → Addresses.' };
    }
    const { epoch } = ownIdentityEpoch();
    const now = { peerId: identity.peerId, communityId, main: content.main, addresses: content.addresses, spares: [] as string[] };
    const kept = keptAddressList();
    const seq = !kept ? 1 : sameAddressListContent(kept, { ...now, epoch, seq: kept.seq }) ? kept.seq : kept.seq + 1;
    // In the signed order, so the record kept and the one the take-over envelope carries read as the list does.
    const fields: AddressListFields = { peerId: now.peerId, communityId, epoch, seq, main: now.main, addresses: now.addresses, spares: now.spares };
    if (!kept || kept.seq !== seq || kept.epoch !== epoch) {
        updateNodeConfig({ addressList: fields });
        if (kept && kept.seq !== seq) {
            logger.info('SYS', `[Addresses] The address list changed: number ${epoch}.${seq}, main ${fields.main}, ${fields.addresses.length} address${fields.addresses.length === 1 ? '' : 'es'} (${fields.addresses.join(', ')}).`);
        }
    }
    return { ok: true, fields, identity };
}

/**
 * The list numbered as it stands now (kept and stored as listNow does), without signing it: the watch's tick, and what the
 * take-over envelope carries. Null with why when there is none.
 */
export function currentAddressList(): { ok: true; fields: AddressListFields } | ({ ok: false } & NoAddressList) {
    const now = listNow();
    return now.ok ? { ok: true, fields: now.fields } : now;
}

const signerOf = (identity: NodeIdentity) => (bytes: Uint8Array) => ed25519.sign(bytes, identity.seed);

let signedMemo: { key: string; signed: SignedAddressList } | null = null;

/** `GET /api/node/addresses`: the signed list, or why there is none. One signature per change of number or content. */
export async function signedAddressList(): Promise<{ ok: true; signed: SignedAddressList } | ({ ok: false } & NoAddressList)> {
    const now = listNow();
    if (!now.ok) return now;
    const key = JSON.stringify(now.fields);
    if (signedMemo?.key === key) return { ok: true, signed: signedMemo.signed };
    const signed = await signAddressList(now.fields, signerOf(now.identity));
    signedMemo = { key, signed };
    return { ok: true, signed };
}

export type ProofAnswer =
    | { status: 200; proof: AddressProof }
    | { status: 400 | 421 | 503; error: string; code: 'bad_nonce' | 'not_listed' | 'replaced' };

/**
 * `GET /api/node/proof`: the proof for this question, or the refusal. 503 once replaced, whatever was asked; then 400 for a
 * nonce that is not 32 lower-case hex; then 421 when `for` is not exactly one of the current list's addresses (and when
 * there is no list: nothing is on it). The question comes from the query alone, never the Host header.
 */
export async function addressProofFor(question: { for: unknown; nonce: unknown }, ts?: number): Promise<ProofAnswer> {
    const now = listNow();
    if (!now.ok && now.why === 'replaced') return { status: 503, error: now.message, code: 'replaced' };
    const notListed = 'That address is not on this community\'s address list, so this server signs nothing for it.';
    if (!now.ok) {
        // No list: the nonce is checked first all the same (as addressProofRefusal does), so a code means one thing whatever
        // the server's state.
        return typeof question.nonce !== 'string' || !NONCE_HEX.test(question.nonce)
            ? { status: 400, error: 'The nonce must be 32 lower-case hex characters.', code: 'bad_nonce' }
            : { status: 421, error: notListed, code: 'not_listed' };
    }
    const list = { v: 1 as const, ...now.fields };
    const refusal = addressProofRefusal(list, question);
    if (refusal === 400) return { status: 400, error: 'The nonce must be 32 lower-case hex characters.', code: 'bad_nonce' };
    if (refusal === 421) return { status: 421, error: notListed, code: 'not_listed' };
    const proof = await signAddressProof({ list, for: question.for as string, nonce: question.nonce as string, ...(ts === undefined ? {} : { ts }) }, signerOf(now.identity));
    return { status: 200, proof };
}

// ── The watch ─────────────────────────────────────────────────────────────────────────────

const WATCH_EVERY_MS = Number(process.env.ADDRESS_LIST_WATCH_INTERVAL_MS) || 10 * 60_000;
let timer: ReturnType<typeof setInterval> | null = null;

/** One tick: number the list as it stands (a change made with no read since gets its number now). Never throws. */
export function tickAddressList(): void {
    try {
        listNow();
    } catch (e: any) {
        logger.warn('SYS', `[Addresses] Could not number the address list: ${e?.message || e}`);
    }
}

/** At boot, after the node key exists, and every 10 minutes. Only timers: the boot never waits on it. */
export function startAddressListWatch(): void {
    stopAddressListWatch();
    tickAddressList();
    timer = setInterval(tickAddressList, WATCH_EVERY_MS);
    timer.unref?.();
}

export function stopAddressListWatch(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
