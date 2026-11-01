/**
 * "Your community's admins can bring you back", shared placement (vault rethink VR4;
 * scratch/fable-design/DESIGN-vault-rethink-fable.md §4.3): beside utils/sso-recovery.ts, the phone's side of a copy that
 * BeanPool's key vault and the member's community keep half each. The community-held placement is utils/community-copy.ts.
 *
 * ## Turning it on
 *
 * The phone seals its key, and its 12 words when they make this key, under 32 random bytes it makes for this copy (the same
 * copy as the community-held one), and splits those bytes in two: one half is random, the other is that XORed with the key,
 * so neither says anything of the key alone. The copy and one half go to the vault, signed by the member's key, sealed to the
 * vault's deposit key with the community's node key inside; the other half goes to the community's server, signed by the
 * member's key, where it is locked under the recovery seal. So the vault can open nothing, the community can open nothing,
 * and this is the member's own copy of their own account: only the two together open it.
 *
 * The vault goes first, because it is the one more likely to be paused, and because a half at the community is what tells
 * its admins the member can be brought back: it must never be there for a copy the vault doesn't hold. **Never a false
 * success:** it is On only when both have answered, the vault with its signed receipt and the community with its own
 * status naming this copy. Anything less is "Not finished", tried again from the row ({@link sharedCopySide}).
 *
 * ## Getting back in
 *
 * The admin's code and the two digits are the re-key's (utils/rekey-redeem.ts). When the admin types the number, the
 * community answers this phone's poll with its half and its voucher ({@link takeSharedRelease}), which are written down here
 * before anything else happens. The phone shows the voucher to the vault, which holds the restore a day (D2: the member's
 * other phones are told and can Stop it, or say "Yes, it's me"), and then releases the copy and the vault's half to the key
 * that asked. The phone joins the halves, opens the copy, and the account is saved only if the seed makes the member's key.
 *
 * The record outlives the re-key's: the vault's day ends after the code's does, when the community's answer is `gone`. So it
 * holds everything the rest needs, in this device's secure store, and it goes when the account is saved, when the restore
 * is stopped, or when the vault says there is nothing to wait for. One thing it never holds: an account's key. A key the ask
 * made is a throwaway, and is kept. On a phone holding another account the ask used that account's own key
 * (utils/rekey-redeem.ts `beginRekey`), and an account's key stays in the one place Sign Out wipes: it is read from there at
 * each step, and if it has gone, so has this restore, since the voucher and the vault's release are for that key alone.
 *
 * Plain English only: this file opens a copy to the account's seed, so it is on the 12 words' key path, where nothing may
 * reach the words layer (core recovery-path-files.test.ts). The screens translate (components/key-lines.ts).
 */

import * as SecureStore from 'expo-secure-store';
import {
    isVaultKeyHex,
    joinCopyKeyHalves,
    openReleaseOnDevice,
    communityHalfFromRelease,
    openSeedWithCopyKey,
    parseVaultVoucher,
    recoveryWordsMatchSeed,
    sealSeedToCopyKey,
    splitCopyKey,
    toEd25519Seed,
    vaultCommunityRef,
    vaultCopyDigest,
} from '@beanpool/core';
import { hexToBytes } from './crypto';
import { getMnemonic, readStoredIdentity, type BeanPoolIdentity } from './identity';
import { signedDelete, signedPost } from './node-post';
import { BRING_BACK_NOT_OPENED, keyOf, REKEY_TEXT, type RekeyAnswer, type RekeyDeps, type RekeySlot } from './rekey-redeem';
import { COMMUNITY_COPY_TEXT, communityCopyStatus, type CommunityCopyStatus } from './community-copy';
import { COMMUNITY_RESTORE_STORE_KEY } from './storage-keys';
import {
    collectCommunityRelease, depositCommunityCopy, disconnectCommunityCopy, restoreWithVoucher, vaultStatus, VaultError, type VaultSigner,
} from './vault';

/** The phone's own sentences. The vault's come from utils/vault.ts VAULT_MESSAGES, the community's in its own words. */
export const COMMUNITY_RECOVERY_TEXT = {
    /** The vault holds no copy this community can bring back: it was removed, or was made again and its half wasn't. */
    noCopy: "BeanPool's key vault keeps no copy your community can bring back. Your 12 words work any time, and an admin can re-key you to a new key.",
    /** The voucher's day is over, or the vault didn't take it: the admin starts again. */
    newCode: 'This bring-back ran out of time. Ask the admin for a new code.',
    /** A version of the app with no key vault, on a copy half kept there. */
    noVaultHere: "This copy is kept half at BeanPool's key vault, and this version of the app can't reach it. Use a version that can, or your 12 words.",
    /** The vault is locked (a restart, before its custodians open it), while a restore waits: nothing is lost by it. */
    paused: "BeanPool's key vault is paused for a little while. Your account is safe, and this carries on when the vault is back.",
    /** The same at Turn on. */
    pausedOn: "BeanPool's key vault is paused for a little while, so this isn't on yet. Try again later. Your 12 words work any time.",
    /** The same at Remove. */
    pausedOff: "BeanPool's key vault is paused for a little while, so nothing was removed. Try again later.",
} as const;

/** How often the phone asks the vault while it waits: a day's hold, so once a minute is plenty, and costs a signed call. */
export const COMMUNITY_RESTORE_POLL_MS = 60_000;

/** The vault's refusal as this flow says it: a paused vault's words here, never the sign-in's. */
function inThisFlow(e: unknown, paused: string): unknown {
    return e instanceof VaultError && e.reason === 'locked' ? new VaultError('locked', paused, e.code) : e;
}

/** The member's own label for the community with this node key, from their seed. */
export function communityRefFor(identity: Pick<BeanPoolIdentity, 'privateKey'>, nodeKey: string): string {
    return vaultCommunityRef(toEd25519Seed(hexToBytes(identity.privateKey)), nodeKey);
}

// ── Turning it on and off ──────────────────────────────────────────────────────────────────────────────────────────

/** How the vault's side stands against the community's: the same copy, another one, none, or no answer. */
export type SharedCopySide = 'matches' | 'differs' | 'none' | 'unknown';

/**
 * What the vault keeps for this community, as against what the community says it keeps. Asked of the vault with the
 * member's key, signed; a vault that can't say is `unknown`, which is never read as a copy gone.
 */
export async function sharedCopySide(identity: BeanPoolIdentity, status: CommunityCopyStatus): Promise<SharedCopySide> {
    if (!status.nodeKey || !identity.privateKey) return 'unknown';
    try {
        const ref = communityRefFor(identity, status.nodeKey);
        const kept = (await vaultStatus(identity)).communityCopies?.find(c => c.ref === ref);
        if (!kept) return 'none';
        return kept.copy === status.copy ? 'matches' : 'differs';
    } catch {
        return 'unknown';
    }
}

/** Where this phone stands with a shared copy: `on`, or begun on one side and `unfinished`. Null when none is begun. */
export function sharedCopyState(status: CommunityCopyStatus | null, side: SharedCopySide | null): 'on' | 'unfinished' | null {
    if (!status) return null;
    const halfHere = status.kept && status.placement === 'shared';
    if (halfHere) return side === 'none' || side === 'differs' ? 'unfinished' : 'on';
    // A copy at the vault and no half here (a turn-on cut short, or this server lost its half).
    return !status.kept && !status.unopenable && side === 'differs' ? 'unfinished' : null;
}

/**
 * Turn it on: seal, split, the vault, then the community. Resolves with since when, only once both have answered that they
 * keep this very copy; throws an Error whose message is the vault's, the community's, or one of {@link COMMUNITY_COPY_TEXT}.
 * A second turn-on makes a new copy and replaces what either keeps. The words travel only when they make this key.
 */
export async function turnOnSharedCopy(url: string, identity: BeanPoolIdentity, nodeKey: string): Promise<{ since: string }> {
    if (!isVaultKeyHex(nodeKey)) throw new Error(COMMUNITY_COPY_TEXT.unreachable);
    let seed: Uint8Array;
    try {
        seed = toEd25519Seed(hexToBytes(identity.privateKey));
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.noKey);
    }
    const words = await getMnemonic(identity);
    const { copy, copyKey } = sealSeedToCopyKey(seed, { words: words && recoveryWordsMatchSeed(words, seed) ? words : null });
    const { vaultHalf, nodeHalf } = splitCopyKey(copyKey);
    const digest = vaultCopyDigest(copy);
    await depositCommunityCopy({ identity, nodeKey, clientCopy: copy, half: vaultHalf, ref: vaultCommunityRef(seed, nodeKey) })
        .catch((e) => { throw inThisFlow(e, COMMUNITY_RECOVERY_TEXT.pausedOn); });
    let res: Response;
    try {
        res = await signedPost(url, '/api/recovery/community-copy/half', { half: nodeHalf, copy: digest }, identity);
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== true || typeof body.since !== 'string') throw new Error(COMMUNITY_COPY_TEXT.notKept);
    // The community's own word that this is the half it keeps now, and can open.
    const now = await communityCopyStatus(url, identity);
    if (!now?.kept || now.placement !== 'shared' || now.copy !== digest) throw new Error(COMMUNITY_COPY_TEXT.notKept);
    return { since: body.since };
}

/**
 * Turn it off: the vault deletes its copy and its half, then the community its half. Resolves only on both answers; throws
 * with a sentence otherwise, and what is left is "Not finished" on the row, with Remove still there. `nodeKey` null: the
 * community didn't say it, or this build has no vault to ask, so only its half can be asked for.
 */
export async function removeSharedCopy(url: string, identity: BeanPoolIdentity, nodeKey: string | null): Promise<void> {
    if (nodeKey) await disconnectCommunityCopy(identity, communityRefFor(identity, nodeKey)).catch((e) => { throw inThisFlow(e, COMMUNITY_RECOVERY_TEXT.pausedOff); });
    let res: Response;
    try {
        res = await signedDelete(url, '/api/recovery/community-copy', identity);
    } catch {
        throw new Error(COMMUNITY_COPY_TEXT.unreachable);
    }
    const body = await res.json().catch(() => ({} as Record<string, unknown>));
    if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : COMMUNITY_COPY_TEXT.unreachable);
    if (body.kept !== false) throw new Error(COMMUNITY_COPY_TEXT.unreachable);
}

// ── Getting back in ────────────────────────────────────────────────────────────────────────────────────────────────

/** A shared bring-back this phone is waiting on, kept until the account is saved (COMMUNITY_RESTORE_STORE_KEY). */
export interface PendingCommunityRestore {
    v: 1;
    /** The key that asked: the voucher names it, and the vault's release is sealed to it. */
    publicKey: string;
    /** Its private half when the ask made that key. Null when it is the phone's own account's ({@link signerOf}). */
    privateKey: string | null;
    /** The community's address and name, to land on. */
    community: string;
    communityName: string;
    /** The member's name there. */
    callsign: string;
    /** The account the release must make. */
    memberKey: string;
    /** The community's half, from its release. */
    nodeHalf: string;
    /** The community's statement, shown to the vault. */
    voucher: string;
    /** Null until the vault has answered: a lost answer comes back to the same hold, since one voucher is one hold. */
    holdId: string | null;
    /** When it goes through, as the vault last said. */
    until: number | null;
}

const SECURE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

function readPending(raw: string | null): PendingCommunityRestore | null {
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as Partial<PendingCommunityRestore>;
        if (p.v !== 1 || !isVaultKeyHex(p.publicKey) || !isVaultKeyHex(p.memberKey) || (typeof p.privateKey !== 'string' && p.privateKey !== null)
            || typeof p.community !== 'string' || typeof p.nodeHalf !== 'string' || typeof p.voucher !== 'string') return null;
        return {
            v: 1, publicKey: p.publicKey, privateKey: p.privateKey ?? null, community: p.community, communityName: String(p.communityName ?? ''),
            callsign: String(p.callsign ?? ''), memberKey: p.memberKey, nodeHalf: p.nodeHalf, voucher: p.voucher,
            holdId: typeof p.holdId === 'string' && p.holdId ? p.holdId : null,
            until: typeof p.until === 'number' ? p.until : null,
        };
    } catch {
        return null;
    }
}

export async function loadPendingCommunityRestore(): Promise<PendingCommunityRestore | null> {
    try {
        return readPending(await SecureStore.getItemAsync(COMMUNITY_RESTORE_STORE_KEY, SECURE_OPTIONS));
    } catch {
        return null;
    }
}

async function savePendingCommunityRestore(p: PendingCommunityRestore): Promise<void> {
    await SecureStore.setItemAsync(COMMUNITY_RESTORE_STORE_KEY, JSON.stringify(p), SECURE_OPTIONS);
}

export async function clearPendingCommunityRestore(): Promise<void> {
    await SecureStore.deleteItemAsync(COMMUNITY_RESTORE_STORE_KEY, SECURE_OPTIONS).catch(() => {});
}

/**
 * The community's answer to a shared bring-back (the admin typed the number): the half opened with the key this phone
 * asked with, and the voucher checked to be for that key, this member and that half's copy. The record is written before
 * the re-key's goes, so nothing is lost to an app stopped here. A community that sends anything else is refused, with
 * nothing saved. Throws {@link BRING_BACK_NOT_OPENED}, or {@link REKEY_TEXT}.changedAccount when the asking key is gone.
 */
export async function takeSharedRelease(
    slot: RekeySlot, answer: Extract<RekeyAnswer, { state: 'released' }>, deps: Pick<RekeyDeps, 'slot' | 'loadIdentity'>,
): Promise<PendingCommunityRestore> {
    const key = await keyOf(slot, deps);
    if (!key) throw new Error(REKEY_TEXT.changedAccount);
    let half: { half: string; copy: string };
    try {
        half = communityHalfFromRelease(openReleaseOnDevice(answer.release, key.privateKey, { collectionId: slot.code, holderType: 'community-half' }));
    } catch {
        throw new Error(BRING_BACK_NOT_OPENED);
    }
    const voucher = parseVaultVoucher(answer.voucher);
    if (!voucher || voucher.payload.phone !== key.publicKey || voucher.payload.member !== answer.memberKey || voucher.payload.copy !== half.copy) {
        throw new Error(BRING_BACK_NOT_OPENED);
    }
    const pending: PendingCommunityRestore = {
        v: 1, publicKey: key.publicKey, privateKey: slot.madeHere ? key.privateKey : null, community: slot.community, communityName: answer.communityName,
        callsign: answer.callsign, memberKey: answer.memberKey, nodeHalf: half.half, voucher: answer.voucher as string, holdId: null, until: null,
    };
    await savePendingCommunityRestore(pending);
    await deps.slot.clear();
    return pending;
}

/** The account out of a release: checked, not yet saved (restore-account.ts saves it). */
export interface BroughtBackShared {
    publicKey: string;
    /** The raw seed, hex, as the phone keeps a key. */
    privateKey: string;
    /** Only when the copy carried them and they make this key. */
    mnemonic?: string[];
}

export type CommunityRestoreStep =
    /** The vault is holding it, until then. */
    | { status: 'held'; until: number; pending: PendingCommunityRestore }
    /** The vault can't be asked just now (paused, unreachable, too many tries, another phone's restore waiting): `message`, and it is asked again. */
    | { status: 'waiting'; message: string; pending: PendingCommunityRestore }
    /** A phone holding the account said no, or a newer restore took its place. The record is gone. */
    | { status: 'stopped' }
    /** Nothing to wait for: `message` says why, and the record is gone. */
    | { status: 'ended'; message: string }
    /** Both halves are here and the copy opened to the member's key. The record stays until the account is saved. */
    | { status: 'released'; back: BroughtBackShared; pending: PendingCommunityRestore };

const toHex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

/** A refusal the vault gave for good: the record goes. Anything else is asked again. */
function finalWords(e: VaultError): string | null {
    if (e.reason === 'no_copy' || e.code === 'no_hold') return COMMUNITY_RECOVERY_TEXT.noCopy;
    if (e.code?.startsWith('voucher_')) return COMMUNITY_RECOVERY_TEXT.newCode;
    // A build with no key vault gets a shared bring-back's answer, and nothing it does can reach the rest.
    if (e.reason === 'not_configured') return COMMUNITY_RECOVERY_TEXT.noVaultHere;
    return null;
}

/**
 * The key this restore asks with: the one its ask made, or the phone's own account's, read now (rekey-redeem.ts `keyOf`).
 * Null only when the phone no longer holds that account. `deps.loadIdentity` must say so only then: one that can't read the
 * key just now (the phone locked) throws, and the wait goes on.
 */
async function signerOf(p: PendingCommunityRestore, deps: Pick<RekeyDeps, 'loadIdentity'>): Promise<VaultSigner | null> {
    if (p.privateKey) return { publicKey: p.publicKey, privateKey: p.privateKey };
    const stored = await deps.loadIdentity();
    return stored?.publicKey === p.publicKey ? stored : null;
}

/**
 * One step on from where the record stands: shows the voucher if no hold is known yet, then asks for the release. Safe to
 * call again at any time and after any restart: one voucher is one hold at the vault, and a release can be collected again
 * until the hold is pruned, so nothing here can open a second restore or lose the first.
 */
export async function advanceCommunityRestore(
    start: PendingCommunityRestore, deps: Pick<RekeyDeps, 'loadIdentity'> = { loadIdentity: readStoredIdentity },
): Promise<CommunityRestoreStep> {
    let pending = start;
    try {
        const signer = await signerOf(pending, deps);
        if (!signer) {
            // The account that asked left the phone: the vault's release could only ever be opened by its key.
            await clearPendingCommunityRestore();
            return { status: 'ended', message: REKEY_TEXT.changedAccount };
        }
        if (!pending.holdId) {
            const held = await restoreWithVoucher(signer, pending.voucher);
            if (held.status === 'stopped') {
                await clearPendingCommunityRestore();
                return { status: 'stopped' };
            }
            pending = { ...pending, holdId: held.holdId, until: held.until };
            await savePendingCommunityRestore(pending);
        }
        const got = await collectCommunityRelease(signer, pending.holdId as string);
        if (got.status === 'stopped') {
            await clearPendingCommunityRestore();
            return { status: 'stopped' };
        }
        if (got.status === 'held') {
            if (got.until !== pending.until) {
                pending = { ...pending, until: got.until };
                await savePendingCommunityRestore(pending).catch(() => {});
            }
            return { status: 'held', until: got.until, pending };
        }
        if (got.pubkey !== pending.memberKey) {
            await clearPendingCommunityRestore();
            return { status: 'ended', message: BRING_BACK_NOT_OPENED };
        }
        let opened: ReturnType<typeof openSeedWithCopyKey>;
        try {
            opened = openSeedWithCopyKey(got.clientCopy, joinCopyKeyHalves(got.half, pending.nodeHalf), pending.memberKey);
        } catch {
            // A half that isn't the vault's copy's: nothing more will come of this restore.
            await clearPendingCommunityRestore();
            return { status: 'ended', message: BRING_BACK_NOT_OPENED };
        }
        return {
            status: 'released',
            pending,
            back: {
                publicKey: pending.memberKey,
                privateKey: toHex(opened.seed),
                ...(opened.words ? { mnemonic: opened.words } : {}),
            },
        };
    } catch (e) {
        if (e instanceof VaultError) {
            const final = finalWords(e);
            if (final) {
                await clearPendingCommunityRestore();
                return { status: 'ended', message: final };
            }
            return { status: 'waiting', message: e.reason === 'locked' ? COMMUNITY_RECOVERY_TEXT.paused : e.message, pending };
        }
        return { status: 'waiting', message: REKEY_TEXT.unreachable, pending };
    }
}
