/**
 * BeanPool's key vault, from the phone (key vault design §1–§5, V4; the vault itself is apps/vault).
 *
 * The vault keeps each member's locked sign-in copy, and gives one back only after it has checked the Google, Apple or
 * Facebook sign-in itself. No community keeps a copy or is asked for one: everything here goes to the vault's own
 * address, never to "the current community". So a stranger's community never sees a sign-in token, a copy, or a
 * request for a nonce (custody design P1–P3).
 *
 * ## Where the vault is, and how the phone knows it's the vault
 *
 * Per build ({@link vaultConfig}): the address and the vault's public keys, pinned, from three build variables that
 * Expo writes into the app when it is built (`EXPO_PUBLIC_BEANPOOL_VAULT_URL`, `…_TICKET_KEYS`, `…_DEPOSIT_KEYS`; see
 * apps/native/.env.example). A build without all three, well formed, keeps sign-in copies where the app always kept
 * them, at the member's community ({@link signInCopiesAt}): the vault paths switch on only in a build that has a vault,
 * and no build is left with neither. The keys are what make it the vault, not the address: a server at the vault's
 * address that isn't the vault can't sign a ticket the phone accepts or open a deposit box (design §1.4).
 *
 * No vault-configured build ships until (PR #1336's gate list, also in apps/native/.env.example): the vault signs its
 * releases and deposit receipts (what a server at its address can still do before then: review finding 4); global's
 * door accepts vault tickets, V5 (finding 5); a member whose only copy is still at a community can get back in, since
 * such a build restores only through the vault and the move card shows only in Settings (finding 3); a phone told
 * "none" ({@link vaultCopyKnowledge}) learns of a copy the member makes later on another phone, which becomes common at
 * rollout, when every phone starts at "none" (confirmation N1); and a 2xx status answer that isn't a status is not
 * recorded as "none" ({@link vaultStatus}; confirmation N2). The parked guide pages: GitHub issue #1349.
 *
 * ## One sign-in, bound three ways
 *
 * - The phone asks the vault for a ticket naming its own key, and checks it against the pinned ticket keys before any
 *   provider's sheet opens ({@link vaultTicket}). A relay that hands the phone a real ticket for the relay's key is
 *   refused here; one that forwards the phone's own ticket gets a release sealed to the phone.
 * - The provider's nonce is the ticket's hash (`vaultTicketNonce`), so the token names that ticket.
 * - A deposit is sealed to the pinned deposit key, for this member key and this provider ({@link depositWithVault}).
 *   A release is sealed to the restoring device's own throwaway key, and the phone saves the opened seed only if it
 *   makes the key the release names ({@link collectVaultRestore}).
 *
 * ## Restores wait a day (D2)
 *
 * Every sign-in restore is held 24 hours unless a device that still holds the account taps "Yes, it's me"; that
 * device is told at once and can Stop it. The restoring phone keeps its throwaway key, the sign-in's subject and the
 * hold on the phone (SecureStore, this device only) until it has saved the account, so it can collect after a
 * restart. Written before the restore goes out: a lost answer comes back to the same hold with the same key.
 *
 * ## Off the everyday path
 *
 * Day-to-day use talks only to the member's community. The vault is reached to connect or disconnect a sign-in, to
 * restore, for Stop or "Yes, it's me", and for the status check at app open, which runs in the background and never
 * holds up a screen: a slow or unreachable vault shows nothing (design, Marty 2026-09-28).
 *
 * While the vault is locked (a restart, before two custodians unlock it), every call but its health answers 503
 * `{locked: true}`, read here as {@link VAULT_MESSAGES.paused}: nothing is shown as done that isn't.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import {
    checkVaultTicket,
    isVaultKeyHex,
    isVaultPushToken,
    openSeedFromSso,
    openVaultRelease,
    recoveryWordsMatchPublicKey,
    sealVaultDepositBox,
    vaultTicketNonce,
    type SealedShare,
    type VaultTicketPurpose,
} from '@beanpool/core';
import { buildVaultSignedHeaders, hexToBytes, randomSeed, seedToKeypair } from './crypto';
import { isSsoProvider, offeredProviders, type SsoProvider } from './sso-providers';
import { hasVault, vaultConfig, type VaultConfig } from './vault-config';
import {
    PUSH_TOKEN_STORE_KEY,
    VAULT_RESTORE_STORE_KEY,
    vaultApprovedHoldsStoreKey,
    vaultConnectWantedStoreKey,
    vaultCopyKnownStoreKey,
    vaultPushTokenStoreKey,
} from './storage-keys';

// ─── Where the vault is (vault-config.ts: no native modules, so any screen can ask) ─────────

export {
    hasVault, readVaultConfig, signInCopiesAt, vaultConfig, type SignInCopies, type VaultConfig,
} from './vault-config';

// ─── What the member reads ─────────────────────────────────────────────────────────────────

export const VAULT_MESSAGES = {
    /** Never met by a member: every vault path runs only in a build that has one ({@link signInCopiesAt}). */
    notConfigured: "Sign-in recovery isn't set up in this version of the app. Your 12 words work any time.",
    /** Design §2.3: while the vault is locked. */
    paused: 'Getting back in with a sign-in is paused for a little while. Your 12 words work any time.',
    pausedConnect: "BeanPool's key vault is paused for a little while, so your sign-in wasn't linked. Settings offers to "
        + 'link it again once the vault is back. Your 12 words work any time.',
    unreachable: "BeanPool's key vault didn't answer. Check your connection and try again. Your 12 words work any time.",
    badTicket: "BeanPool's key vault sent an answer that didn't check out, so no sign-in was started. Check that your "
        + "phone's date and time are right, then try again.",
    notConfirmed: "The key vault's answer didn't confirm it, so nothing is shown as done. Try again.",
    wrongAccount: "The copy that came back doesn't make the account it belongs to, so nothing was saved. Your 12 words "
        + 'work any time.',
    notOpened: "The copy that came back didn't open with this sign-in, so nothing was saved. Your 12 words work any time.",
    stopped: 'This restore was stopped from a phone or computer that has your account, so nothing came back. If that '
        + "wasn't you, use your 12 words.",
    gone: 'This restore is no longer waiting at the key vault. Start again, or use your 12 words.',
    noCopy: "BeanPool's key vault keeps no copy for this sign-in account. Your 12 words work any time.",
    tooMany: 'Too many tries just now. Please try again later.',
    signInRefused: "BeanPool's key vault couldn't check that sign-in, so nothing happened. Try again. Your 12 words work any time.",
    /** A Stop (or "Yes, it's me") after the other device already collected: it has the account now. */
    holdCollected: 'That restore has already gone through: the other phone or computer has your account now. If it wasn\'t you, '
        + "someone else has your account: make sure the sign-in account it used is yours alone, and ask your community's "
        + 'admins for help.',
    holdStopped: "That restore was already stopped. It won't go through.",
    holdGone: 'That restore is no longer waiting at the key vault.',
} as const;

/** Whether a refused Stop or "Yes, it's me" is a final answer (collected, already stopped, gone), not one to try again. */
export function holdAnswerIsFinal(e: unknown): boolean {
    return e instanceof VaultError && (e.code === 'collected' || e.code === 'stopped' || e.code === 'no_hold');
}

export type VaultFailure =
    /** This build has no vault. */
    | 'not_configured'
    /** The vault is locked (§2.3): {@link VAULT_MESSAGES.paused}. */
    | 'locked'
    /** No answer, a timeout, or the vault's provider check was down. */
    | 'unreachable'
    /** A ticket that isn't the vault's, or isn't this key's. No provider sheet opened. */
    | 'bad_ticket'
    /** The vault keeps no copy for this sign-in account. */
    | 'no_copy'
    /** A restore of this account is already waiting on another device. */
    | 'hold_open'
    | 'rate_limited'
    /** A release that doesn't open, or opens to a seed that doesn't make the key it names. Nothing saved. */
    | 'wrong_account'
    /** Anything else the vault refused, in its own words. */
    | 'refused';

export class VaultError extends Error {
    constructor(readonly reason: VaultFailure, message: string, readonly code?: string) {
        super(message);
        this.name = 'VaultError';
    }
}

function requireVault(): VaultConfig {
    const cfg = vaultConfig();
    if (!cfg) throw new VaultError('not_configured', VAULT_MESSAGES.notConfigured);
    return cfg;
}

// ─── Requests ──────────────────────────────────────────────────────────────────────────────

/** How long one vault request may take. The vault is in Iceland; a phone may be on a slow link. */
export const VAULT_TIMEOUT_MS = 20_000;

/** A key a vault request is signed with: the member's, or a restore's throwaway key. */
export interface VaultSigner {
    publicKey: string;
    privateKey: string;
}

function codeOf(body: unknown): string | undefined {
    const c = (body as { code?: unknown } | null)?.code;
    return typeof c === 'string' ? c : undefined;
}

/**
 * A refusal from the vault, as the member meets it: always in the app's own words, chosen by the answer's status and
 * code, never the answer's own text. An answer at the vault's address isn't known to be the vault's until it is
 * checked, and a refusal can't be: shown verbatim, a server that isn't the vault could put its own sentences on the
 * restore screens and in Settings (PR #1336 review finding 9). The code goes to the log.
 */
export function vaultRefusal(status: number, body: unknown): VaultError {
    const code = codeOf(body);
    const locked = (body as { locked?: unknown } | null)?.locked === true;
    if (code) console.log(`[VAULT] refused: ${status} ${code.slice(0, 40)}`);
    if (status === 503 && (locked || code === 'locked' || code === 'restoring')) return new VaultError('locked', VAULT_MESSAGES.paused, code);
    if (status === 503 || status >= 500) return new VaultError('unreachable', VAULT_MESSAGES.unreachable, code);
    if (status === 404 && code === 'no_copy') return new VaultError('no_copy', VAULT_MESSAGES.noCopy, code);
    if (status === 409 && code === 'hold_open') {
        return new VaultError('hold_open', 'A restore of this account is already waiting on another phone. It goes through there, '
            + 'or you can use your 12 words here.', code);
    }
    if (status === 429) return new VaultError('rate_limited', VAULT_MESSAGES.tooMany, code);
    // A Stop or "Yes, it's me" that came too late: final answers, not ones to try again (confirmation review NEW-3).
    if (status === 409 && code === 'collected') return new VaultError('refused', VAULT_MESSAGES.holdCollected, code);
    if (status === 409 && code === 'stopped') return new VaultError('refused', VAULT_MESSAGES.holdStopped, code);
    if (status === 404 && code === 'no_hold') return new VaultError('refused', VAULT_MESSAGES.holdGone, code);
    if (status === 401 && (code === 'signin_refused' || code?.startsWith('ticket_'))) return new VaultError('refused', VAULT_MESSAGES.signInRefused, code);
    return new VaultError('refused', `BeanPool's key vault couldn't do that (${status}). Try again later. Your 12 words work any time.`, code);
}

/**
 * A POST to the vault, signed for the vault's own host (utils/crypto.ts `buildVaultSignedHeaders`), answered within
 * {@link VAULT_TIMEOUT_MS}. Resolves with the 2xx answer's JSON (null when it isn't JSON: callers check its shape);
 * throws {@link VaultError} for everything else.
 */
async function vaultPost<T>(path: string, body: Record<string, unknown>, signer: VaultSigner, timeoutMs = VAULT_TIMEOUT_MS): Promise<T | null> {
    const cfg = requireVault();
    const url = `${cfg.url}${path}`;
    const bodyString = JSON.stringify(body);
    const headers = await buildVaultSignedHeaders('POST', url, bodyString, signer.privateKey, signer.publicKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let res: Response;
        try {
            res = await fetch(url, { method: 'POST', headers, body: bodyString, signal: controller.signal });
        } catch {
            throw new VaultError('unreachable', VAULT_MESSAGES.unreachable);
        }
        const parsed: unknown = await res.json().catch(() => null);
        if (!res.ok) throw vaultRefusal(res.status, parsed);
        return (parsed && typeof parsed === 'object' ? parsed : null) as T | null;
    } finally {
        clearTimeout(timer);
    }
}

// ─── Tickets ───────────────────────────────────────────────────────────────────────────────

export interface VaultTicketGrant {
    /** The ticket itself: the deposit or restore carries it, and so does the global door's join (§5.4). */
    ticket: string;
    /** What the provider's sheet is given: `base64url(SHA-256(ticket))`. */
    nonce: string;
}

/**
 * A ticket for `signer`'s key, checked before anything else happens: signed by one of the pinned ticket keys,
 * unexpired, naming this key and this purpose. Otherwise {@link VaultError} `bad_ticket`, and no provider sheet opens.
 */
export async function vaultTicket(signer: VaultSigner, purpose: VaultTicketPurpose, provider: SsoProvider): Promise<VaultTicketGrant> {
    const cfg = requireVault();
    const body = await vaultPost<{ ticket?: unknown }>('/v1/ticket', { purpose, provider }, signer);
    const ticket = body?.ticket;
    const check = checkVaultTicket(ticket, { ticketKeys: cfg.ticketKeys, now: Date.now(), key: signer.publicKey, purpose });
    if (!check.ok) {
        console.log(`[VAULT] refused a ${purpose} ticket: ${check.reason}`);
        throw new VaultError('bad_ticket', VAULT_MESSAGES.badTicket, check.reason);
    }
    return { ticket: ticket as string, nonce: vaultTicketNonce(ticket as string) };
}

// ─── Deposits ──────────────────────────────────────────────────────────────────────────────

/** This phone's Expo push token, when it has one (services/push-notifications.ts keeps it). Never asks for one. */
async function storedPushToken(): Promise<string | undefined> {
    try {
        const token = await SecureStore.getItemAsync(PUSH_TOKEN_STORE_KEY);
        return isVaultPushToken(token) ? token : undefined;
    } catch {
        return undefined;
    }
}

export interface VaultDeposit {
    provider: SsoProvider;
    /** This sign-in account protected another BeanPool account until now: that account's devices were told. */
    replaced: boolean;
    /** Whether the copy carries the 12 words, so a restore with it gives them back. */
    wordsSealed: boolean;
}

/**
 * Deposit this member's copy for `provider`: `clientCopy` (sealed to the sign-in's subject, keeper-enrolment.ts
 * `sealSsoShares`) and this phone's push token, in a box sealed to the pinned deposit key for this member key and this
 * provider. Proven with the deposit ticket and the token that carries its nonce; signed by the member key the ticket
 * names. One copy per sign-in account: a deposit for the same account replaces the one before.
 */
export async function depositWithVault(input: {
    identity: VaultSigner;
    provider: SsoProvider;
    ticket: string;
    idToken: string;
    clientCopy: SealedShare;
    wordsSealed: boolean;
}): Promise<VaultDeposit> {
    const cfg = requireVault();
    const pushToken = await storedPushToken();
    const { encryptedShare, shareIv, shareTag, kdfParams } = input.clientCopy;
    const clientCopy = { encryptedShare, shareIv, shareTag, kdfParams };
    const box = sealVaultDepositBox(pushToken ? { clientCopy, pushToken } : { clientCopy }, cfg.depositKeys[0], input.identity.publicKey, input.provider);
    const body = await vaultPost<{ ok?: unknown; replaced?: unknown }>(
        '/v1/copies', { ticket: input.ticket, provider: input.provider, idToken: input.idToken, box }, input.identity,
    );
    if (body?.ok !== true) throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
    await noteVaultCopy(input.identity.publicKey, true);
    if (pushToken) await AsyncStorage.setItem(vaultPushTokenStoreKey(input.identity.publicKey), pushToken).catch(() => {});
    await forgetConnectWanted(input.identity.publicKey, input.provider);
    return { provider: input.provider, replaced: body.replaced === true, wordsSealed: input.wordsSealed };
}

// ─── Status, disconnect, push token ───────────────────────────────────────────────────────

export interface VaultHold {
    holdId: string;
    provider: SsoProvider;
    openedAt: number;
    /** When the restore goes through unless it is stopped. */
    releaseAt: number;
}

export interface VaultStatus {
    /** The sign-ins the vault keeps a copy for, for this key. Only the ones this app offers. */
    providers: SsoProvider[];
    /** Restores of this account waiting at the vault. */
    holds: VaultHold[];
}

/** Read the vault's answer to `/v1/copies/status`: anything malformed is left out, never guessed. */
export function readVaultStatus(body: unknown): VaultStatus {
    const b = (body ?? {}) as { copies?: unknown; holds?: unknown };
    const copies = Array.isArray(b.copies) ? b.copies : [];
    const providers = offeredProviders(copies.map(c => (c as { provider?: unknown } | null)?.provider));
    const holds: VaultHold[] = [];
    for (const h of Array.isArray(b.holds) ? b.holds : []) {
        const x = (h ?? {}) as Record<string, unknown>;
        if (typeof x.holdId === 'string' && x.holdId && isSsoProvider(x.provider)
            && typeof x.openedAt === 'number' && typeof x.releaseAt === 'number') {
            holds.push({ holdId: x.holdId, provider: x.provider, openedAt: x.openedAt, releaseAt: x.releaseAt });
        }
    }
    return { providers: [...new Set(providers)], holds };
}

/** Which sign-ins the vault keeps a copy for, and any restore waiting. Never a copy. */
export async function vaultStatus(identity: VaultSigner, timeoutMs = VAULT_TIMEOUT_MS): Promise<VaultStatus> {
    const status = readVaultStatus(await vaultPost('/v1/copies/status', {}, identity, timeoutMs));
    await noteVaultCopy(identity.publicKey, status.providers.length > 0);
    return status;
}

/**
 * What this phone knows about a copy at the vault for `publicKey` ({@link noteVaultCopy}), asked of the phone, never of
 * the vault: `'kept'` (it deposited one, restored the account from one, or a status read listed one), `'none'` (a
 * status read listed none), or `'unknown'` (nothing learnt yet: a phone that got the account back with the 12 words,
 * or a new account, or a phone updated from a build before this record).
 *
 * The app-open check and the Settings banner skip only `'none'` (PR #1336 review finding 1: a member with no copy
 * there is never asked about, and nothing asks on a timer). `'unknown'` is asked, once, and the answer is kept: a phone
 * restored with the 12 words must see and stop a sign-in restore of its account (D2), and its push token must reach the
 * copy (confirmation review NEW-1).
 */
export type VaultCopyKnowledge = 'kept' | 'none' | 'unknown';

export async function vaultCopyKnowledge(publicKey: string): Promise<VaultCopyKnowledge> {
    try {
        const v = await AsyncStorage.getItem(vaultCopyKnownStoreKey(publicKey));
        return v === '1' ? 'kept' : v === '0' ? 'none' : 'unknown';
    } catch {
        return 'unknown';
    }
}

/** Whether this phone knows the vault keeps a copy for `publicKey` ({@link vaultCopyKnowledge} is `'kept'`). */
export async function vaultCopyKnown(publicKey: string): Promise<boolean> {
    return (await vaultCopyKnowledge(publicKey)) === 'kept';
}

/**
 * Remember what the phone has just learnt: a deposit here, a restore from the vault, or a status read (the app-open
 * check, Account Protection), which is how a phone learns of a copy another of the member's devices made.
 */
export async function noteVaultCopy(publicKey: string, kept: boolean): Promise<void> {
    await AsyncStorage.setItem(vaultCopyKnownStoreKey(publicKey), kept ? '1' : '0').catch(() => {});
}

/** Forget what the phone knew (a restore with the 12 words): the next app open asks the vault again. */
export async function forgetVaultCopyKnowledge(publicKey: string): Promise<void> {
    await AsyncStorage.removeItem(vaultCopyKnownStoreKey(publicKey)).catch(() => {});
}

/** Disconnect: the vault deletes the copy at once, and from its backups within 30 days (design §1.7). */
export async function disconnectFromVault(identity: VaultSigner, provider: SsoProvider | 'all'): Promise<number> {
    const body = await vaultPost<{ deleted?: unknown }>(
        '/v1/copies/delete', provider === 'all' ? { all: true } : { provider }, identity,
    );
    if (typeof body?.deleted !== 'number') throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
    return body.deleted;
}

/**
 * Give the vault this phone's push token when it has changed since it last had it, so its notices (a restore waiting,
 * a release, a replaced copy) reach this phone. Only for an account the vault keeps a copy for. Never throws.
 */
export async function keepVaultPushTokenCurrent(identity: VaultSigner): Promise<void> {
    try {
        const token = await storedPushToken();
        if (!token) return;
        const key = vaultPushTokenStoreKey(identity.publicKey);
        if ((await AsyncStorage.getItem(key)) === token) return;
        await vaultPost('/v1/push-token', { token }, identity);
        await AsyncStorage.setItem(key, token);
    } catch (e) {
        console.log(`[VAULT] push token not updated: ${(e as Error).message}`);
    }
}

/**
 * An account is leaving this phone (Sign Out, "Replace this phone's account", the self-delete purge;
 * account-leaves-phone.ts): the push token this phone gave the vault for it comes out of every copy of the key, so the
 * account's notices (a restore waiting, a release, a replaced copy) stop reaching a phone that may now be someone
 * else's (PR #1336 review finding 8). Signed by the account's key while the phone still holds it. Only a token this
 * phone gave the vault (the deposit or {@link keepVaultPushTokenCurrent} recorded it). Within `timeoutMs`, and never
 * throws: a vault that doesn't answer never holds up or fails the leave, and the token then stays at the vault (the
 * key is gone from the phone afterwards, so nothing can take it out later). True once the vault took it out.
 */
export async function withdrawVaultPushToken(identity: VaultSigner, timeoutMs: number): Promise<boolean> {
    if (!hasVault() || !identity.publicKey || !identity.privateKey) return false;
    const key = vaultPushTokenStoreKey(identity.publicKey);
    let token: string | null = null;
    try {
        token = await AsyncStorage.getItem(key);
    } catch {
        return false;
    }
    if (!isVaultPushToken(token)) return false;
    try {
        const body = await vaultPost<{ updated?: unknown }>('/v1/push-token/remove', { token }, identity, timeoutMs);
        if (typeof body?.updated !== 'number') return false;
        await AsyncStorage.removeItem(key).catch(() => {});
        return true;
    } catch (e) {
        console.log(`[VAULT] this phone's push token was not taken out: ${(e as Error).message}`);
        return false;
    }
}

/** Holds already brought to the member's attention in this run of the app (one alert each). */
const holdsAlerted = new Set<string>();

/**
 * The app-open check (design §1.5, V4): in the background, the vault's status for the account on this phone. Resolves
 * with the restores of this account waiting that haven't been brought up yet in this run, and gives the vault this
 * phone's push token when it has changed. Short timeout, never throws, and nothing waits for it: a slow or unreachable
 * vault shows nothing. No vault in this build, or an account the phone knows has no copy there
 * ({@link vaultCopyKnowledge} `'none'`): nothing is asked. An account it knows nothing about yet is asked, and the
 * answer is kept.
 *
 * Marks nothing: the caller marks the holds it actually shows ({@link takeHoldsToShow}), at the moment it shows them.
 * An answer that arrives after the screen asking for it has gone (a remount) must not use up the hold's one alert.
 */
export async function vaultHoldsAtOpen(identity: VaultSigner): Promise<VaultHold[]> {
    if (!hasVault() || (await vaultCopyKnowledge(identity.publicKey)) === 'none') return [];
    try {
        const status = await vaultStatus(identity, 15_000);
        if (status.providers.length) void keepVaultPushTokenCurrent(identity);
        await forgetEndedApprovals(identity.publicKey, status.holds);
        // A hold this phone already let through is not asked about again.
        const approved = await approvedHolds(identity.publicKey);
        return status.holds.filter(h => !holdsAlerted.has(h.holdId) && !approved.includes(h.holdId));
    } catch {
        return [];
    }
}

/**
 * The holds in `holds` not yet brought up in this run, marked as brought up now: call it only as the alert is shown.
 * Synchronous, so two answers arriving together (the app opening and turning active at once) show one alert.
 */
export function takeHoldsToShow(holds: readonly VaultHold[]): VaultHold[] {
    const fresh = holds.filter(h => !holdsAlerted.has(h.holdId));
    for (const h of fresh) holdsAlerted.add(h.holdId);
    return fresh;
}

// ─── Holds: Stop, and "Yes, it's me" ──────────────────────────────────────────────────────

/** Stop a restore of this account: it is never released. */
export async function stopVaultHold(identity: VaultSigner, holdId: string): Promise<void> {
    const body = await vaultPost<{ status?: unknown }>('/v1/holds/cancel', { holdId }, identity);
    if (body?.status !== 'stopped') throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
}

/** "Yes, it's me": the restore goes through now instead of after the wait. Remembered on this phone ({@link approvedHolds}). */
export async function approveVaultHold(identity: VaultSigner, holdId: string): Promise<void> {
    const body = await vaultPost<{ status?: unknown }>('/v1/holds/approve', { holdId }, identity);
    if (body?.status !== 'approved') throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
    const approved = await approvedHolds(identity.publicKey);
    if (!approved.includes(holdId)) {
        await AsyncStorage.setItem(vaultApprovedHoldsStoreKey(identity.publicKey), JSON.stringify([...approved, holdId].slice(-20))).catch(() => {});
    }
}

/**
 * The holds this phone said "Yes, it's me" to. The vault's status lists a hold until the other device collects it and
 * says nothing of an approval, so without this the banner offered Stop and "Yes, it's me" again for the member's own
 * approved restore, and the app-open check asked "Is this you?" about it (PR #1336 review finding 9).
 */
export async function approvedHolds(publicKey: string): Promise<string[]> {
    try {
        const raw = await AsyncStorage.getItem(vaultApprovedHoldsStoreKey(publicKey));
        const list = raw ? JSON.parse(raw) as unknown : [];
        return Array.isArray(list) ? list.filter((h): h is string => typeof h === 'string') : [];
    } catch {
        return [];
    }
}

/** Forget approvals for holds the vault no longer lists (collected, or pruned): the list stays short. */
export async function forgetEndedApprovals(publicKey: string, listed: readonly VaultHold[]): Promise<void> {
    const approved = await approvedHolds(publicKey);
    const still = approved.filter(id => listed.some(h => h.holdId === id));
    if (still.length === approved.length) return;
    const key = vaultApprovedHoldsStoreKey(publicKey);
    await (still.length ? AsyncStorage.setItem(key, JSON.stringify(still)) : AsyncStorage.removeItem(key)).catch(() => {});
}

/**
 * When a hold ends, as a member reads it: "in about 5 hours (Thu 3:40 pm)", "in a few minutes", or "any moment now".
 * The clock is the phone's; the vault's `releaseAt` is what counts, so this is only ever "about".
 */
export function holdEndsText(releaseAt: number, now: number = Date.now()): string {
    const left = releaseAt - now;
    if (left <= 60_000) return 'any moment now';
    if (left < 60 * 60_000) return 'in a few minutes';
    const hours = Math.round(left / (60 * 60_000));
    const at = new Date(releaseAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    return `in about ${hours} ${hours === 1 ? 'hour' : 'hours'} (${at})`;
}

// ─── Restores ──────────────────────────────────────────────────────────────────────────────

/** A sign-in restore this phone started, kept until the account is saved (VAULT_RESTORE_STORE_KEY). */
export interface PendingVaultRestore extends VaultSigner {
    v: 1;
    provider: SsoProvider;
    /** The sign-in's subject: what opens the copy once the vault releases it. */
    sub: string;
    /** Null until the vault has answered: a lost answer keeps the key, and the next try comes back to the same hold. */
    holdId: string | null;
    /** When it goes through, as the vault last said. */
    until: number | null;
}

const SECURE_OPTIONS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

function readPending(raw: string | null): PendingVaultRestore | null {
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as Partial<PendingVaultRestore>;
        if (p.v !== 1 || !isSsoProvider(p.provider) || !isVaultKeyHex(p.publicKey) || typeof p.privateKey !== 'string'
            || typeof p.sub !== 'string' || !p.sub) return null;
        return {
            v: 1, provider: p.provider, publicKey: p.publicKey, privateKey: p.privateKey, sub: p.sub,
            holdId: typeof p.holdId === 'string' && p.holdId ? p.holdId : null,
            until: typeof p.until === 'number' ? p.until : null,
        };
    } catch {
        return null;
    }
}

export async function loadPendingVaultRestore(): Promise<PendingVaultRestore | null> {
    try {
        return readPending(await SecureStore.getItemAsync(VAULT_RESTORE_STORE_KEY, SECURE_OPTIONS));
    } catch {
        return null;
    }
}

async function savePendingVaultRestore(p: PendingVaultRestore): Promise<void> {
    await SecureStore.setItemAsync(VAULT_RESTORE_STORE_KEY, JSON.stringify(p), SECURE_OPTIONS);
}

export async function clearPendingVaultRestore(): Promise<void> {
    await SecureStore.deleteItemAsync(VAULT_RESTORE_STORE_KEY, SECURE_OPTIONS).catch(() => {});
}

/** A fresh throwaway key for one restore: the ticket names it and the release is sealed to it. */
async function throwawayKey(): Promise<VaultSigner> {
    const k = await seedToKeypair(randomSeed());
    return { publicKey: k.publicKeyHex, privateKey: k.privateKeyHex };
}

/** The sign-in's subject, read from the token the phone has just been handed (the vault checks the token itself). */
export function subjectOf(idToken: string): string {
    const parts = idToken?.split('.');
    if (parts && parts.length >= 2 && parts[1]) {
        try {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(globalThis.atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { sub?: unknown };
            if (typeof payload?.sub === 'string' && payload.sub) return payload.sub;
        } catch {
            // Not a token whose claims can be read: refused below, as one with no subject is.
        }
    }
    throw new VaultError('refused', "That sign-in didn't say which account it was, so it can't be used. Try again.");
}

/**
 * Start a sign-in restore: a throwaway key, a restore ticket for it (checked before the sheet), the provider's sheet
 * via `signIn`, then `/v1/restore`. No name and no community address: the sign-in finds the copy. Resolves with the
 * hold (every restore waits, D2). The pending restore is written before the request goes out.
 *
 * `signIn` runs the provider's sheet with the nonce it is given and returns the token (utils/sso-signin.ts
 * `signInWithProvider`). `signal`, aborted before the restore is sent, stops it there: nothing is sent.
 */
export async function startVaultRestore(
    provider: SsoProvider,
    signIn: (provider: SsoProvider, nonce: string) => Promise<{ idToken: string }>,
    opts: { signal?: AbortSignal; onSignedIn?: () => void | Promise<void> } = {},
): Promise<PendingVaultRestore> {
    requireVault();
    // A restore this phone started earlier keeps its throwaway key, whatever sign-in is tried next: after a lost answer,
    // a restart, or "Start again" (PR #1336 review finding 2). The vault answers the key that opened a hold with that
    // hold, and only another key with "already waiting on another phone", which for the member's own sign-in would shut
    // them out for up to two days. Only saving the account, a Stop, or the hold ending gives the key up.
    const earlier = await loadPendingVaultRestore();
    const key = earlier ?? await throwawayKey();
    const { ticket, nonce } = await vaultTicket(key, 'restore', provider);
    const { idToken } = await signIn(provider, nonce);
    const sub = subjectOf(idToken);
    await opts.onSignedIn?.();
    if (opts.signal?.aborted) throw Object.assign(new Error('Sign-in was cancelled.'), { reason: 'cancelled' });

    // The same sign-in again keeps the hold it already has on record until the vault answers.
    const same = earlier && earlier.provider === provider && earlier.sub === sub ? earlier : null;
    const pending: PendingVaultRestore = {
        v: 1, provider, publicKey: key.publicKey, privateKey: key.privateKey, sub, holdId: same?.holdId ?? null, until: same?.until ?? null,
    };
    await savePendingVaultRestore(pending);
    let body: { status?: unknown; holdId?: unknown; until?: unknown } | null;
    try {
        body = await vaultPost('/v1/restore', { ticket, provider, idToken }, key);
    } catch (e) {
        // A refusal the vault gave for good leaves nothing waiting for this sign-in; no answer at all may have opened a
        // hold. Whatever this phone had on record before this try goes back, key and all: a hold this key already has
        // (an earlier sign-in's, even one whose answer was lost, so its hold id is unknown) is still this phone's to
        // collect, and the same sign-in comes back to it (confirmation review NEW-2).
        if (e instanceof VaultError && !['unreachable', 'locked'].includes(e.reason)) {
            if (earlier) await savePendingVaultRestore(earlier);
            else await clearPendingVaultRestore();
        }
        throw e;
    }
    if (body?.status !== 'held' || typeof body.holdId !== 'string' || !body.holdId || typeof body.until !== 'number') {
        throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
    }
    const held: PendingVaultRestore = { ...pending, holdId: body.holdId, until: body.until };
    await savePendingVaultRestore(held);
    return held;
}

/** The account a release brings back: checked, not yet saved (restore-account.ts `restoreFromVault` saves it). */
export interface RestoredFromVault {
    provider: SsoProvider;
    publicKey: string;
    privateKey: string;
    /** Only when the copy carried them and they make this key. */
    mnemonic?: string[];
}

export type VaultCollect =
    | { status: 'held'; until: number }
    | { status: 'stopped' }
    | { status: 'released'; restored: RestoredFromVault };

/**
 * Open a release: the box with the throwaway key, the copy with the sign-in's subject. The seed counts only if it makes
 * the key the release names; otherwise {@link VaultError} `wrong_account`, and nothing is saved.
 */
export async function openRelease(release: unknown, pending: PendingVaultRestore): Promise<RestoredFromVault> {
    let contents: { provider: string; pubkey: string; clientCopy: SealedShare };
    try {
        contents = openVaultRelease(release, hexToBytes(pending.privateKey));
    } catch {
        throw new VaultError('wrong_account', VAULT_MESSAGES.notOpened);
    }
    if (contents.provider !== pending.provider) throw new VaultError('wrong_account', VAULT_MESSAGES.wrongAccount);
    let opened: { seed: Uint8Array; words: string[] | null; wordsStatus?: string };
    try {
        opened = await openSeedFromSso(contents.clientCopy, pending.provider, pending.sub);
    } catch {
        throw new VaultError('wrong_account', VAULT_MESSAGES.notOpened);
    }
    if (opened.seed.length !== 32) throw new VaultError('wrong_account', VAULT_MESSAGES.notOpened);
    const keypair = await seedToKeypair(opened.seed);
    if (keypair.publicKeyHex !== contents.pubkey) {
        console.log(`[VAULT] a release opened to a key other than the one it names; nothing saved`);
        throw new VaultError('wrong_account', VAULT_MESSAGES.wrongAccount);
    }
    // Why a copy gave no words, never the words themselves. 'absent' is a copy from a phone without them: ordinary.
    if (opened.wordsStatus === 'unreadable' || opened.wordsStatus === 'mismatch') {
        console.log(`[VAULT] ${pending.provider}: the copy's 12 words ${opened.wordsStatus === 'mismatch'
            ? 'make a different key' : 'did not open'}; restoring the key alone`);
    }
    // Kept only if they make the key being saved: checked here against that key, not only by the opener.
    let words = opened.words;
    if (words && !recoveryWordsMatchPublicKey(words, keypair.publicKeyHex)) {
        console.log(`[VAULT] ${pending.provider}: the copy's 12 words do not make the restored key; restoring the key alone`);
        words = null;
    }
    return {
        provider: pending.provider,
        publicKey: keypair.publicKeyHex,
        privateKey: keypair.privateKeyHex,
        ...(words ? { mnemonic: words } : {}),
    };
}

/**
 * Ask the vault for the restore this phone is waiting on. Held: when it goes through. Stopped: a device that has the
 * account said no, and the pending restore is gone. Released: the account, checked ({@link openRelease}); the pending
 * restore stays until the account is saved, so a failed save can collect again.
 */
export async function collectVaultRestore(pending: PendingVaultRestore): Promise<VaultCollect> {
    if (!pending.holdId) throw new VaultError('refused', VAULT_MESSAGES.gone);
    let body: { status?: unknown; until?: unknown; release?: unknown } | null;
    try {
        body = await vaultPost('/v1/restore/collect', { holdId: pending.holdId }, pending);
    } catch (e) {
        if (e instanceof VaultError && (e.code === 'no_hold' || e.code === 'no_copy')) {
            await clearPendingVaultRestore();
            throw new VaultError('refused', VAULT_MESSAGES.gone, e.code);
        }
        throw e;
    }
    if (body?.status === 'held' && typeof body.until === 'number') {
        if (body.until !== pending.until) await savePendingVaultRestore({ ...pending, until: body.until }).catch(() => {});
        return { status: 'held', until: body.until };
    }
    if (body?.status === 'stopped') {
        await clearPendingVaultRestore();
        return { status: 'stopped' };
    }
    if (body?.status === 'released') return { status: 'released', restored: await openRelease(body.release, pending) };
    throw new VaultError('refused', VAULT_MESSAGES.notConfirmed);
}

// ─── A connect the vault was too paused to take ───────────────────────────────────────────

/** Remember that `provider` was asked for while the vault was paused: the move card offers it again (§2.3). */
export async function rememberConnectWanted(publicKey: string, provider: SsoProvider): Promise<void> {
    const key = vaultConnectWantedStoreKey(publicKey);
    const wanted = await connectWanted(publicKey);
    if (!wanted.includes(provider)) await AsyncStorage.setItem(key, JSON.stringify([...wanted, provider])).catch(() => {});
}

export async function connectWanted(publicKey: string): Promise<SsoProvider[]> {
    try {
        const raw = await AsyncStorage.getItem(vaultConnectWantedStoreKey(publicKey));
        return raw ? offeredProviders(JSON.parse(raw)) : [];
    } catch {
        return [];
    }
}

async function forgetConnectWanted(publicKey: string, provider: SsoProvider): Promise<void> {
    const wanted = await connectWanted(publicKey);
    if (!wanted.includes(provider)) return;
    const rest = wanted.filter(p => p !== provider);
    const key = vaultConnectWantedStoreKey(publicKey);
    await (rest.length ? AsyncStorage.setItem(key, JSON.stringify(rest)) : AsyncStorage.removeItem(key)).catch(() => {});
}
