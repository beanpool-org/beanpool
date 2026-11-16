/**
 * One community, several addresses, slice S2: the server publishes and proves (design scratch/fable-design/
 * DESIGN-several-addresses-fable.md §2.2, §2.3, §6, §7; decided by Marty 16 Nov). The bytes, the spelling of an address
 * and the order are core's (@beanpool/core address-list.ts, S0); this file is what this server signs with them.
 *
 * **The list.** `GET /api/node/addresses` (routes/address-list.ts), at every address: the community's addresses and its
 * main one (engine/own-addresses.ts addressListContent), signed with the server key, numbered `(epoch, seq)`:
 *   - `epoch` is the take-over count (services/identity-epoch.ts ownIdentityEpoch), so a take-over's list beats every list
 *     from before it, whatever its counter;
 *   - `seq` goes up whenever the content changes (an address added or removed, a new main, a port, the key or the
 *     community id), and never for no change. The content is compared with the last list signed, kept in node_config
 *     `addressList`, at every read and on a timer (startAddressListWatch), so no writer has to remember to call. The new
 *     number is stored BEFORE anything is signed with it, so two lists with different content are never signed at one
 *     number by this server, a restart included.
 * A promoted standby goes on from the number the take-over envelope carries (services/takeover-envelope.ts `addressList`,
 * written by the take-over's `public-address` step through addressListAfterTakeover), one take-over past it.
 *
 * **The invariant: this key never signs at or below a number it may already have signed** (#3232 round 2, the director's
 * design call). The kept record lives in state.db, and a sealed-backup restore or a roll-back to a restore point puts an
 * older state.db in place: kept alone, the same key would sign a number at or below one it signed after that backup, with
 * other content (and on a fresh machine after a past take-over, whose local-config.json has no identity epoch, at a lower
 * epoch). Three things keep it:
 *   (a) the epoch is never below the kept list's, nor the take-over count a restore's keys carried (listEpoch);
 *   (b) every bump is `max(kept seq + 1, the floor)`, the floor being whole seconds since 2026-01-01 by this server's clock
 *       (addressSeqFloor), which no database swap takes back;
 *   (c) a restore's or a roll-back's notice, delivered at the next boot before anything is signed (services/restore-points.ts
 *       deliverRestoreNotices), raises the kept number with no change of content (renumberAddressListAfterSwap): past the
 *       one the server before the swap last signed (the notice carries it, routes/backup.ts) and never below the floor.
 * Otherwise there is still no bump for no change.
 * **The clock.** The floor assumes the server's clock is roughly right (NTP, as TLS already needs). Content changes more
 * than once a second run seq ahead of the clock by that many, never more; a restore comes minutes later at least. A clock
 * behind the kept number gives a floor below it, and each bump falls back to kept seq + 1: still above everything this
 * database kept, but after a restore onto a new machine (where no notice can carry the lost server's number) it may not
 * outrank what the lost server signed after the backup until the clock catches up; the boot logs a warning when that
 * happens. A restore on the same machine and a roll-back never depend on the clock: their notice carries the number. A
 * clock far ahead only spends numbers.
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
import { getLocalConfig } from '../config/local-config.js';
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

/**
 * What a restore's or a roll-back's notice carries (routes/backup.ts, read while the database being replaced is still
 * open): the list this server last signed, for renumberAddressListAfterSwap at the next boot. Null when there is none or
 * it cannot be read: the floor then does the work. Never throws.
 */
export function addressListForNotice(): AddressListFields | null {
    try {
        return keptAddressList();
    } catch {
        return null;
    }
}

// ── The number ───────────────────────────────────────────────────────────────────────────

/** The floor counts whole seconds from 2026-01-01T00:00:00Z by this server's clock. */
export const ADDRESS_SEQ_FLOOR_FROM_MS = Date.UTC(2026, 0, 1);

let clockForTests: (() => number) | null = null;
/** Tests only: the clock the floor reads, in ms (null: the real one). */
export function addressListClockForTests(now: (() => number) | null): void {
    clockForTests = now;
}
const clockNow = (): number => (clockForTests ?? Date.now)();

/**
 * The seq floor: whole seconds since 2026-01-01 by this server's clock, 0 for a clock before then. It survives a database
 * swap, so a bump after a restore or a roll-back lands above every number signed before it while the clock is right (the
 * module comment says what a clock behind does).
 */
export function addressSeqFloor(nowMs: number = clockNow()): number {
    const s = Math.floor((nowMs - ADDRESS_SEQ_FLOOR_FROM_MS) / 1000);
    return Number.isSafeInteger(s) && s > 0 ? s : 0;
}

/** The seq a bump gives: one more than the highest kept (null: none, the first list), and never below the floor. */
function bumpedSeq(highestKept: number | null): number {
    return Math.max(highestKept === null ? 1 : highestKept + 1, addressSeqFloor());
}

/** The take-over count a restore's keys carried (services/lights-out.ts noteRestoredCopy keeps it), 0 for none. */
function restoredKeysEpoch(): number {
    const n = Number(getLocalConfig().restoredCopy?.epoch);
    return isCount(n) ? n : 0;
}

/**
 * The epoch a list is signed at: this server's take-over count, never below the kept list's or the count a restore's keys
 * carried. On a fresh machine restored after a past take-over, local-config.json has no identity epoch while the restored
 * record says 1: it signs at 1, never 0.
 */
function listEpoch(kept: AddressListFields | null): number {
    return Math.max(ownIdentityEpoch().epoch, kept?.epoch ?? 0, restoredKeysEpoch());
}

/**
 * What a take-over's `public-address` step keeps (services/takeover.ts): the carried list, content unchanged, one take-over
 * past both the keys' count and the carried list's epoch. The `role` step writes the keys' count + 1; a list kept at an
 * epoch above the keys' (a server restored onto a fresh machine, (a) above) would otherwise tie the promoted server with
 * the one it replaces. Computed from the bundle alone, so running the step again keeps the same.
 */
export function addressListAfterTakeover(carried: AddressListFields, bundleEpoch: number): AddressListFields {
    return { ...carried, epoch: Math.max(carried.epoch, isCount(bundleEpoch) ? bundleEpoch : 0) + 1 };
}

/**
 * A restore or a roll-back put another state.db in place before this start (services/restore-points.ts
 * deliverRestoreNotices calls this at the boot, before anything is signed, once for each notice, readable or not). The kept
 * record is now the backup's or the restore point's, at or below numbers this key may have signed since. It is raised here,
 * content unchanged: the epoch to the higher of the record now in place and the one the server before the swap last signed
 * (the notice's `addressList`, this key's only), and seq one past the higher of theirs and never below the floor. So the
 * first list signed after the swap outranks every list signed before it, an address changed or not. Signs nothing. With
 * nothing kept anywhere there is nothing to raise: the first list is numbered at the floor. Never throws.
 */
export function renumberAddressListAfterSwap(notice: { addressList?: unknown } | null): void {
    try {
        let peerId: string | null = null;
        try {
            peerId = readNodeIdentity()?.peerId ?? null;
        } catch { /* no key yet: the record in place stands alone */ }
        const ofThisKey = (r: AddressListFields | null) => (r && (peerId === null || r.peerId === peerId) ? r : null);
        const inPlace = ofThisKey(keptAddressList());
        const going = peerId ? ofThisKey(readAddressListRecord(notice?.addressList)) : null;
        const base = inPlace ?? going;
        if (!base) return;
        const highest = Math.max(inPlace?.seq ?? 0, going?.seq ?? 0);
        const floor = addressSeqFloor();
        const raised: AddressListFields = { ...base, epoch: Math.max(inPlace?.epoch ?? 0, going?.epoch ?? 0), seq: bumpedSeq(highest) };
        updateNodeConfig({ addressList: raised });
        logger.info('SYS', `[Addresses] The database was restored or rolled back: the address list's number goes on at ${raised.epoch}.${raised.seq}, `
            + `past ${inPlace ? `${inPlace.epoch}.${inPlace.seq} in the database now in place` : 'nothing in the database now in place'}`
            + `${going ? ` and ${going.epoch}.${going.seq} signed before the swap` : ''}.`);
        // Only when nothing carried the number signed before the swap (a restore onto a new machine): with it, the list is past
        // everything signed before whatever the clock says.
        if (!going && floor <= highest) {
            logger.warn('SYS', `[Addresses] This server's clock reads ${new Date(clockNow()).toISOString()}, behind the address list's number, so the number `
                + 'went on by one. If the clock is wrong, set it right: a list the lost server signed after its last backup may outrank this one until then.');
        }
    } catch (e: any) {
        logger.warn('SYS', `[Addresses] Could not raise the address list's number after the restore: ${e?.message || e}`);
    }
}

/** Why this server has no list to sign now, in words for a phone or a person reading the raw answer. */
export type NoAddressList =
    | { why: 'replaced'; message: string }
    | { why: 'no-node-key' | 'no-community' | 'no-address'; message: string };

type ListNow = { ok: true; fields: AddressListFields; identity: NodeIdentity } | ({ ok: false } & NoAddressList);

/**
 * The list as it stands now, numbered: the kept number when the content is the kept content, else a bump (bumpedSeq),
 * stored before it is returned. Synchronous from the read of what is kept to the write of the new number, so two requests at once can
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
    const now = { peerId: identity.peerId, communityId, main: content.main, addresses: content.addresses, spares: [] as string[] };
    const kept = keptAddressList();
    const epoch = listEpoch(kept);
    const seq = kept && sameAddressListContent(kept, { ...now, epoch, seq: kept.seq }) ? kept.seq : bumpedSeq(kept?.seq ?? null);
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
