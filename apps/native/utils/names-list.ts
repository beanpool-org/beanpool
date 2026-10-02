/**
 * The names list, on an owner's or admin's phone (community modes slice 2; the server is apps/server/src/routes/
 * names-list.ts and engine/names-list.ts; the crypto and the trust model are @beanpool/core names-list-crypto.ts and
 * names-list-trust.ts; the design is scratch/global-node/DESIGN-names-list-trust-fable.md).
 *
 * The community's admins keep a list of who its members are, by real name, and confirm a member against an entry. The
 * names are sealed on this phone before anything is sent: the node keeps scrambled text, a signed history of the
 * list's keys, and boxes of keys sealed from one admin to another. Only an admin's phone opens them. Everything here is
 * signed with the member's own key.
 *
 * What this module decides, so the screen (app/names-list.tsx) only draws it:
 *   - the open ({@link openNamesList}): the node's state; this phone's pin (whom it trusts, the history it took and the
 *     keys it holds, sealed at rest under a key in the secure store: {@link readNamesPinFrom}); the sync (core
 *     syncNames: rule 1 takes a statement only off this phone's head from a maker it trusts; a key only from a box a
 *     trusted admin signed, for a statement it took); then what the plan says, without asking where it only removes
 *     trust (the first key, a new key without an admin who left), and the keys sent to every admin this phone trusts that
 *     lacks one (logged on the node); and only when the plan is ready, the list;
 *   - a generation is written ahead: the pin keeps it and its key before the request (`pending`), so a phone that dies
 *     after the node took it still has the key, and one whose request never landed sends it again
 *     ({@link openNamesList});
 *   - the asked actions: "Check each other" ({@link checkEachOther}), "Remove @X's old key" ({@link removeOldKey}), "Put
 *     the key history back" ({@link putHistoryBack}), "Start again" / a new key nobody can hand over
 *     ({@link makeKeyOnThisPhone}), "Follow the server's history" ({@link followServerHistory}), "Send the keys to @X again"
 *     ({@link sendKeysAgain});
 *   - the entries: opened with the key of each one's generation from this phone's ring, or said to be locked with the
 *     key's number, its maker and who holds it ({@link openEntries}); written only under the head's key
 *     ({@link saveNamesEntry});
 *   - confirming, the access log's lines, the PDF's page, and every sentence the screen says ({@link NAMES_COPY}).
 *
 * A confirmation is a fact about a member, never a tier, and in this version it gates nothing.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
    newNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId, normaliseNamesEntryText, namesKeyCheckMatches,
    readNamesKeyCheck, namesKeyQr, namesKeyCode, syncNames, readNamesPin, emptyNamesPin, checkNamesKeyInPerson, removeNamesKey,
    makeNamesGenerationFor, namesSharesToSend, namesReplay, namesRingKeys, namesKeyLabel, readNamesGeneration,
    sealNamesPinBlob, openNamesPinBlob, namesStatementId, followNamesServer, namesListKeyCode, readNamesShare, namesSeenAfterRead, namesSelfClaim,
    type NamesEntryText, type NamesPin, type NamesPlan, type NamesNotice, type NamesServerState, type NamesGeneration, type NamesShare,
} from '@beanpool/core';
import { buildSignedHeaders, bytesToHex } from './crypto';
import { communityAddress } from './push-pins';
import type { BeanPoolIdentity } from './identity';

export const NAMES_PATH = '/api/names';

/**
 * Whether Settings offers "Names list": to an owner or admin (never a moderator or a member), on a local community (the
 * global node keeps none; one not known yet counts as local, and the node answers for itself). The node refuses
 * everyone else whatever the phone shows.
 */
export function offersNamesList(role: string | null | undefined, profile: 'local' | 'global' | null | undefined): boolean {
    return (role === 'owner' || role === 'admin') && profile !== 'global';
}

// ── What the node sends ──────────────────────────────────────────────────────────────────────

export interface NamesAdminRow {
    pubkey: string;
    callsign: string;
    role: 'owner' | 'admin';
    /** The key ids the node says this admin holds: a hint, never trust. */
    keyIds: string[];
    holdsCurrent: boolean;
}

export interface NamesState extends NamesServerState {
    communityId: string;
    admins: NamesAdminRow[];
    holdersOfCurrent: string[];
    droppedHolders: string[];
    nobodyHoldsKey: boolean;
    newKeyNeeded: boolean;
    /** The name each key the history names goes by, for words only. */
    callsigns: Record<string, string>;
    settings: { twoAdminsToConfirm: boolean; namesShownToMembers: boolean };
    counts: { entries: number; confirmed: number; awaitingSecond: number; byKey: Record<string, number>; locked: number };
    me: { pubkey: string; role: 'owner' | 'admin' | null; owner: boolean };
}

export interface SealedEntryRow {
    id: string;
    ciphertext: string;
    keyId: string;
    createdBy: string;
    createdAt: string;
    updatedBy: string | null;
    updatedAt: string;
}

export type ConfirmationStatus = 'confirmed' | 'awaiting_second' | 'revoked';

export interface ConfirmationRow {
    id: string;
    memberPubkey: string;
    callsign: string | null;
    entryId: string;
    confirmedBy: string;
    confirmedAt: string;
    needsSecond: boolean;
    secondedBy: string | null;
    secondedAt: string | null;
    revokedBy: string | null;
    revokedAt: string | null;
    revokeReason: 'admin' | 'removed' | 'account_deleted' | null;
    status: ConfirmationStatus;
}

export interface NamesListBody {
    current: string | null;
    entries: SealedEntryRow[];
    confirmations: ConfirmationRow[];
    /** The ids an admin deleted (the access log's `delete` lines, newest 10,000; design Addendum 4). */
    deleted?: string[];
}

export type NamesAction = 'read' | 'export' | 'add' | 'edit' | 'delete' | 'confirm' | 'second' | 'revoke'
    | 'key_made' | 'key_changed' | 'key_shared' | 'holder_dropped' | 'settings';

export interface NamesLogLine {
    id: string;
    actor: string;
    actorCallsign: string | null;
    action: NamesAction;
    entryId: string | null;
    subject: string | null;
    subjectCallsign: string | null;
    at: string;
}

/** An answer: the node's body, or its refusal in its own words (and its code, which the screen acts on). */
export type NamesResult<T> =
    | { ok: true; value: T }
    | { ok: false; status: number; code: string | null; message: string };

export const UNREACHABLE = "Couldn't reach your community. Check your connection and try again.";
/** The code of a request let go at its time limit (status 0, like any lost connection; round 14: the open stops at it). */
export const NAMES_TIMED_OUT = 'timed_out';

/** A signed request to the member's own community. Never throws: a failure is an answer. */
/**
 * How long a names-list request may take before it counts as no connection (round 13; sized per request in round 14).
 * React Native's fetch never gives up by itself (OkHttp's timeouts are 0), and it reports no progress, so each request
 * gets a total limit that fits what it carries. Every pin operation waits for the one before it, so a request that never
 * answered would otherwise stop every names-list action until the app is closed. The node doesn't compress its answers.
 *
 * - Small requests (statements, shares, entries, confirmations, the log): 45 s.
 * - The state: 120 s. It grows with admins times keys (every header names every key id): about 390 kB at 8 admins and 30
 *   keys, which takes about 63 s at 50 kbit/s (GPRS).
 * - The whole list: 45 s plus 0.4 s per entry the state counts. 2,000 entries are 1.2 MB with short names and no
 *   confirmations, up to 4.8 MB at the longest allowed with most confirmed: at 50 kbit/s that is 190–770 s, inside the
 *   845 s this gives. The list is read outside the pin's chain, so this long limit holds no Remove up.
 *
 * A request let go here may still have landed: status 0 is already read that way (a statement written ahead keeps
 * `pending`; an add keeps its id, so a retry is `entry_exists`).
 */
export const NAMES_REQUEST_TIMEOUT_MS = 45_000;
export const NAMES_STATE_TIMEOUT_MS = 120_000;
export const NAMES_LIST_MS_PER_ENTRY = 400;
let requestTimeoutMs = NAMES_REQUEST_TIMEOUT_MS;
let stateTimeoutMs = NAMES_STATE_TIMEOUT_MS;
let listMsPerEntry = NAMES_LIST_MS_PER_ENTRY;
/** For tests: shorter limits (`stateMs` and `listPerEntryMs` default to the small limit and 0 when the small one is changed). */
export function setNamesRequestTimeout(ms: number, opts: { stateMs?: number; listPerEntryMs?: number } = {}): void {
    const reset = ms === NAMES_REQUEST_TIMEOUT_MS && opts.stateMs === undefined && opts.listPerEntryMs === undefined;
    requestTimeoutMs = ms;
    stateTimeoutMs = opts.stateMs ?? (reset ? NAMES_STATE_TIMEOUT_MS : ms);
    listMsPerEntry = opts.listPerEntryMs ?? (reset ? NAMES_LIST_MS_PER_ENTRY : 0);
}
/** The whole list's limit, from the count of entries the state just gave. */
const listTimeoutMs = (entries: number): number => requestTimeoutMs + Math.max(0, Math.min(entries, 2000)) * listMsPerEntry;

async function call<T>(anchorUrl: string, identity: BeanPoolIdentity, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, limitMs?: number): Promise<NamesResult<T>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<NamesResult<T>>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve({ ok: false, status: 0, code: NAMES_TIMED_OUT, message: UNREACHABLE }); }, limitMs ?? requestTimeoutMs);
    });
    try {
        // The whole request, the answer's body included, within the time limit.
        return await Promise.race([send<T>(anchorUrl, identity, method, path, body, controller.signal), timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

async function send<T>(anchorUrl: string, identity: BeanPoolIdentity, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, signal: AbortSignal): Promise<NamesResult<T>> {
    try {
        const url = `${anchorUrl.replace(/\/+$/, '')}${path}`;
        const raw = method === 'GET' || method === 'DELETE' ? '' : JSON.stringify(body ?? {});
        const headers = await buildSignedHeaders(method, url, raw, identity.privateKey, identity.publicKey);
        if (method === 'GET' || method === 'DELETE') delete headers['Content-Type'];
        const res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, ...(raw ? { body: raw } : {}), signal });
        const parsed = await res.json().catch(() => null) as Record<string, unknown> | null;
        if (!res.ok) {
            return {
                ok: false, status: res.status,
                code: typeof parsed?.code === 'string' ? parsed.code : null,
                message: typeof parsed?.error === 'string' && parsed.error.trim() ? parsed.error : UNREACHABLE,
            };
        }
        if (parsed === null) return { ok: false, status: res.status, code: null, message: UNREACHABLE };
        return { ok: true, value: parsed as T };
    } catch {
        return { ok: false, status: 0, code: null, message: UNREACHABLE };
    }
}

export const fetchNamesState = (anchor: string, id: BeanPoolIdentity) => call<NamesState>(anchor, id, 'GET', `${NAMES_PATH}/state`, undefined, stateTimeoutMs);
/** Every entry, sealed, and every confirmation. The node logs it as a read, or, for an export, as an export. */
export const fetchNamesList = (anchor: string, id: BeanPoolIdentity, forExport = false, entries = 2000) =>
    call<NamesListBody>(anchor, id, 'GET', `${NAMES_PATH}/entries${forExport ? '?for=export' : ''}`, undefined, listTimeoutMs(entries));
export const fetchNamesLog = (anchor: string, id: BeanPoolIdentity, limit = 50) =>
    call<{ log: NamesLogLine[]; total: number }>(anchor, id, 'GET', `${NAMES_PATH}/log?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`);
export const confirmMember = (anchor: string, id: BeanPoolIdentity, memberPubkey: string, entryId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations`, { memberPubkey, entryId });
export const secondConfirmation = (anchor: string, id: BeanPoolIdentity, confirmationId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations/${encodeURIComponent(confirmationId)}/second`, {});
export const revokeConfirmation = (anchor: string, id: BeanPoolIdentity, confirmationId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations/${encodeURIComponent(confirmationId)}/revoke`, {});
/** Deletes an entry; once the node says it's gone, this phone stops counting it as seen (an honest delete is no loss). */
export async function deleteNamesEntry(anchor: string, id: BeanPoolIdentity, entryId: string, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<{ id: string }>> {
    const done = await call<{ id: string }>(anchor, id, 'DELETE', `${NAMES_PATH}/entries/${encodeURIComponent(entryId)}`);
    if (done.ok) {
        await withPin(id.publicKey, anchor, async () => {
            const pin = await readNamesPinFrom(store, id.publicKey, anchor);
            if (pin && pin.seen.includes(entryId)) await writeNamesPinTo(store, id.publicKey, anchor, { ...pin, seen: pin.seen.filter((x) => x !== entryId) });
        });
    }
    return done;
}
export const setNamesSettings = (anchor: string, id: BeanPoolIdentity, settings: { twoAdminsToConfirm?: boolean }) =>
    call<{ twoAdminsToConfirm: boolean; namesShownToMembers: boolean }>(anchor, id, 'POST', `${NAMES_PATH}/settings`, settings);

const postGeneration = (anchor: string, id: BeanPoolIdentity, g: Pick<NamesGeneration, 'statement' | 'signature'>, replay = false) =>
    call<{ id: string; n: number; code?: string }>(anchor, id, 'POST', `${NAMES_PATH}/generations`, { statement: g.statement, signature: g.signature, ...(replay ? { replay: true } : {}) });
const postShare = (anchor: string, id: BeanPoolIdentity, s: NamesShare) =>
    call<{ to: string }>(anchor, id, 'POST', `${NAMES_PATH}/shares`, { header: s.header, signature: s.signature, box: s.box });

// ── The pin, sealed at rest ──────────────────────────────────────────────────────────────────

/**
 * Where a pin is kept: a small store for the sealed blob (AsyncStorage: Android caps a SecureStore value at 2 KB), and
 * the secure store for the key that seals it.
 */
export interface NamesPinStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    getSecret(name: string): Promise<string | null>;
    setSecret(name: string, value: string): Promise<void>;
}

/** The phone's own stores. */
export const DEVICE_NAMES_STORE: NamesPinStore = {
    getItem: (k) => AsyncStorage.getItem(k),
    setItem: (k, v) => AsyncStorage.setItem(k, v),
    getSecret: (name) => SecureStore.getItemAsync(name),
    setSecret: (name, value) => SecureStore.setItemAsync(name, value),
};

/**
 * Where this phone keeps its pin for one community: by this member's key and the community's address, both the phone's
 * own (never the server's word), so a server can't hand the phone an empty pin by naming another community.
 */
export function namesTrustStoreKey(publicKey: string, anchor: string): string {
    return `beanpool:names-trust:${publicKey.toLowerCase()}:${communityAddress(anchor) ?? anchor}`;
}

/** The secure store's name for the key that seals that pin (letters, digits, dots, dashes and underscores only). */
export function namesPinSecretName(label: string): string {
    return `beanpool.names-pin.${namesStatementId(label).slice(0, 40)}`;
}

/**
 * One read-modify-write of a pin at a time (round 12): every function here that saves the pin runs its whole body, reads
 * included, on one promise chain per pin label, after the one before it settles. So an open that reads the pin, waits on
 * the network and saves it can never write back over a Remove, a check or a new key saved while it waited. A failure in
 * one link doesn't wedge the chain. The functions on the chain never call each other (no re-entry). Nothing on it waits
 * for good: every request has a time limit ({@link NAMES_REQUEST_TIMEOUT_MS}), and the rest is local (AsyncStorage, and
 * SecureStore with no authentication asked for: no prompt, no scan). A link is never let go while it still runs: one let
 * go with its request out could save its pin later, which is the race this chain is for.
 */
const pinChains = new Map<string, Promise<void>>();
function withPin<T>(publicKey: string, anchor: string, fn: () => Promise<T>): Promise<T> {
    const label = namesTrustStoreKey(publicKey, anchor);
    const before = pinChains.get(label) ?? Promise.resolve();
    const run = before.then(fn);
    const tail = run.then(() => undefined, () => undefined);
    pinChains.set(label, tail);
    void tail.then(() => { if (pinChains.get(label) === tail) pinChains.delete(label); });
    return run;
}

/**
 * A pin read before a write (round 15). `pin` is null when none is kept, or when the one kept doesn't open (`kept`: its
 * key is gone from the secure store, or the blob was altered; an open then starts from an empty pin). `failed`: a store
 * read threw (a storage error, which may pass), so nothing may be written over what is kept: an empty pin saved then
 * would lose the phone's history, keys, trust and removals.
 */
type PinRead = { failed: false; pin: NamesPin | null; kept: boolean } | { failed: true };
async function readPin(store: NamesPinStore, publicKey: string, anchor: string): Promise<PinRead> {
    const label = namesTrustStoreKey(publicKey, anchor);
    let blob: string | null;
    let secret: string | null;
    try {
        blob = await store.getItem(label);
        if (!blob) return { failed: false, pin: null, kept: false };
        secret = await store.getSecret(namesPinSecretName(label));
    } catch {
        return { failed: true };
    }
    try {
        if (!secret || !/^[0-9a-f]{64}$/.test(secret)) return { failed: false, pin: null, kept: true };
        const json = openNamesPinBlob(blob, fromHex(secret), label);
        return { failed: false, pin: json ? readNamesPin(JSON.parse(json), publicKey) : null, kept: true };
    } catch {
        return { failed: false, pin: null, kept: true };
    }
}

/** This phone's pin for the community, or null: none kept, one that doesn't open, or a read that failed. */
export async function readNamesPinFrom(store: NamesPinStore, publicKey: string, anchor: string): Promise<NamesPin | null> {
    const read = await readPin(store, publicKey, anchor);
    return read.failed ? null : read.pin;
}

/** Seals and keeps the pin; false when it couldn't be kept (then nothing that depends on it is sent). */
export async function writeNamesPinTo(store: NamesPinStore, publicKey: string, anchor: string, pin: NamesPin): Promise<boolean> {
    try {
        const label = namesTrustStoreKey(publicKey, anchor);
        const name = namesPinSecretName(label);
        let secret = await store.getSecret(name);
        if (!secret || !/^[0-9a-f]{64}$/.test(secret)) {
            // Written once, before the first pin that holds a key.
            secret = bytesToHex(newNamesListKey());
            await store.setSecret(name, secret);
        }
        await store.setItem(label, sealNamesPinBlob(JSON.stringify(pin), fromHex(secret), label));
        return true;
    } catch {
        return false;
    }
}

const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

const NOT_KEPT: NamesResult<never> = { ok: false, status: 0, code: 'not_kept', message: 'This phone couldn’t keep the names list’s keys. Nothing was sent. Try again.' };
const NOT_READ: NamesResult<never> = { ok: false, status: 0, code: 'not_kept', message: 'This phone couldn’t read the names list’s keys just now. Nothing was sent or changed. Try again.' };

// ── Checking each other in person ────────────────────────────────────────────────────────────

/** What this phone shows another admin to check it in person: its key as a QR code, and the same key as a code. */
export function myKeyCheck(identity: Pick<BeanPoolIdentity, 'publicKey'>): { qr: string; code: string } {
    return { qr: namesKeyQr(identity.publicKey), code: namesKeyCode(identity.publicKey) };
}

/** A key's code, to show beside a callsign. */
export const keyCodeOf = (pubkey: string): string => namesKeyCode(pubkey);

/** Whether what was scanned or typed is `pubkey`'s key. */
export function inPersonResult(scannedOrTyped: string, pubkey: string): 'match' | 'unreadable' | 'mismatch' {
    if (!readNamesKeyCheck(scannedOrTyped)) return 'unreadable';
    return namesKeyCheckMatches(scannedOrTyped, pubkey) ? 'match' : 'mismatch';
}

export type EachOtherCheck =
    /** `pinned`: the key this phone now trusts. `mismatch`: it isn't the key the server lists for the admin picked. */
    | { ok: true; pinned: string; mismatch: boolean }
    /** `not_kept`: this phone couldn't read or keep its pin, so the check wasn't saved and everything kept stays as it was. */
    | { ok: false; reason: 'unreadable' | 'mismatch' | 'self' | 'no_match' | 'not_kept' };

/**
 * "Check each other" (design §3.3): what was scanned (a QR code: the other phone's key) or typed (its 20 digits). A QR
 * code pins the key it shows, even when it isn't the one the server lists for `picked` (then `mismatch`, said loudly:
 * nothing is sent to the server's key, and nothing to the scanned one unless the server lists it as an admin). A typed
 * code can only be compared: with `picked`'s key, or with each admin the server lists; a mismatch pins nothing.
 */
export async function checkEachOther(
    store: NamesPinStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, state: Pick<NamesState, 'communityId' | 'admins'> & Partial<Pick<NamesState, 'shares'>>,
    scannedOrTyped: string, picked?: Pick<NamesAdminRow, 'pubkey'> | null,
): Promise<EachOtherCheck> {
    const read = readNamesKeyCheck(scannedOrTyped);
    if (!read) return { ok: false, reason: 'unreadable' };
    let key: string;
    let mismatch = false;
    if (read.kind === 'key') {
        key = read.pubkey;
        mismatch = !!picked && picked.pubkey.toLowerCase() !== key;
    } else if (picked) {
        if (!namesKeyCheckMatches(scannedOrTyped, picked.pubkey)) return { ok: false, reason: 'mismatch' };
        key = picked.pubkey.toLowerCase();
    } else {
        const found = state.admins.find((a) => namesKeyCheckMatches(scannedOrTyped, a.pubkey));
        if (!found) return { ok: false, reason: 'no_match' };
        key = found.pubkey.toLowerCase();
    }
    if (key === identity.publicKey.toLowerCase()) return { ok: false, reason: 'self' };
    return withPin(identity.publicKey, anchor, async (): Promise<EachOtherCheck> => {
        // Round 15: an empty pin only where none is kept. A read that failed, a kept pin that doesn't open, or one for
        // another community is never written over here: the check fails and the phone's history, keys, trust and
        // removals stay as they are (an open is what starts again from a pin that will never open).
        const read = await readPin(store, identity.publicKey, anchor);
        if (read.failed || (read.kept && read.pin?.communityId !== state.communityId)) return { ok: false, reason: 'not_kept' };
        const base = read.pin ?? emptyNamesPin(state.communityId, identity.publicKey);
        if (!(await writeNamesPinTo(store, identity.publicKey, anchor, checkNamesKeyInPerson(base, key)))) return { ok: false, reason: 'not_kept' };
        await rememberChecked(store, identity.publicKey, anchor, key, state.shares);
        return { ok: true, pinned: key, mismatch };
    });
}

/**
 * The admins this phone checked in person, each with the signatures of the share headers their phone had sent when it
 * was checked (round 11). Until that admin's phone sends a newer header, it hasn't opened since the check, and it will
 * send the keys the next time it does: the words say so rather than "meet them". Public values only (keys, signatures).
 */
const checkedLabel = (publicKey: string, anchor: string) => `beanpool:names-checked:${publicKey.toLowerCase()}:${communityAddress(anchor) ?? anchor}`;
const headersFrom = (shares: unknown, key: string): string[] => (Array.isArray(shares) ? shares : [])
    .filter((x) => (x as { from?: unknown })?.from === key).map((x) => String((x as { signature?: unknown }).signature ?? ''));

async function rememberChecked(store: NamesPinStore, publicKey: string, anchor: string, key: string, shares: unknown): Promise<void> {
    try {
        const raw = await store.getItem(checkedLabel(publicKey, anchor));
        const map = raw ? JSON.parse(raw) as Record<string, string[]> : {};
        map[key] = headersFrom(shares, key);
        await store.setItem(checkedLabel(publicKey, anchor), JSON.stringify(map));
    } catch { /* a convenience for the words only */ }
}

/** The admins checked in person here whose phones have sent no header since; the rest are forgotten. */
async function justCheckedNow(store: NamesPinStore, publicKey: string, anchor: string, state: Pick<NamesState, 'shares'>): Promise<string[]> {
    try {
        const raw = await store.getItem(checkedLabel(publicKey, anchor));
        if (!raw) return [];
        const map = JSON.parse(raw) as Record<string, string[]>;
        const still: Record<string, string[]> = {};
        for (const [k, sigs] of Object.entries(map)) if (headersFrom(state.shares, k).every((sig) => sigs.includes(sig))) still[k] = sigs;
        if (Object.keys(still).length !== Object.keys(map).length) await store.setItem(checkedLabel(publicKey, anchor), JSON.stringify(still));
        return Object.keys(still);
    } catch {
        return [];
    }
}

/** "Remove @X's old key" (asked first): the next open makes a new key without it. */
export async function removeOldKey(store: NamesPinStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, key: string): Promise<boolean> {
    return withPin(identity.publicKey, anchor, async () => {
        const pin = await readNamesPinFrom(store, identity.publicKey, anchor);
        if (!pin) return false;
        return writeNamesPinTo(store, identity.publicKey, anchor, removeNamesKey(pin, key));
    });
}

// ── Opening the list, in order ───────────────────────────────────────────────────────────────

export interface NamesOpened {
    state: NamesState;
    plan: NamesPlan;
    pin: NamesPin;
    /** This phone's keys, by generation id. */
    ring: Record<string, Uint8Array>;
    /** The statements the node sent that check out, by id. */
    generations: Map<string, NamesGeneration>;
    /** The list, where the plan is ready; null otherwise (nothing was read). */
    list: NamesListBody | null;
    /** Lines to show, in words. */
    notices: string[];
    /** Admins checked in person on this phone whose phones have sent no header since (round 11): they will send. */
    justChecked?: string[];
    /** The keys this open made a new generation without, if it made one. */
    made: string[] | null;
    /** Whom this open sent the keys to. */
    sentTo: string[];
    /** Admins the node lists whose phones this phone hasn't checked: "Check @X in person" (never a share on a callsign). */
    toCheck: NamesAdminRow[];
    /**
     * Ready: entries this phone saw that are neither on the node nor deleted by an admin (design Addendum 4). Rolled back:
     * the card's estimate, before anything is read.
     */
    lost: number;
}

const callsignIn = (state: Pick<NamesState, 'callsigns' | 'admins'>, key: string): string =>
    state.admins.find((a) => a.pubkey === key)?.callsign ?? state.callsigns?.[key] ?? '';
const at = (callsign: string): string => (callsign ? `@${callsign}` : 'an admin');

/** The notices a sync gave, in words. */
export function noticeWords(notices: NamesNotice[], state: Pick<NamesState, 'callsigns' | 'admins'>): string[] {
    const out: string[] = [];
    for (const n of notices) {
        if (n.kind === 'dropped_me') out.push(NAMES_COPY.droppedMe(callsignIn(state, n.maker)));
        else if (n.kind === 'different_keys') out.push(NAMES_COPY.differentKeys(n.n));
        else if (n.kind === 'other_history') out.push(NAMES_COPY.otherHistory(callsignIn(state, n.who)));
        else if (n.kind === 'dropped') out.push(NAMES_COPY.newKeyBy(callsignIn(state, n.maker), n.keys.map((k) => callsignIn(state, k))));
        else if (n.kind === 'too_many') out.push(NAMES_COPY.tooMany);
        else if (n.kind === 'check_again') out.push(NAMES_COPY.checkAgain(callsignIn(state, n.who), n.n));
    }
    return [...new Set(out)];
}

interface Synced { state: NamesState; pin: NamesPin; plan: NamesPlan; notices: NamesNotice[]; generations: Map<string, NamesGeneration> }

/**
 * The walk's notices are said once (they come from taking a statement, which happens once). An operation that syncs but
 * isn't an open (a save, a follow, a new key, Put back, Send again) keeps them here, and the next open says them (round 14).
 */
const unsaidLabel = (publicKey: string, anchor: string) => `beanpool:names-unsaid:${publicKey.toLowerCase()}:${communityAddress(anchor) ?? anchor}`;
async function keepUnsaid(store: NamesPinStore, publicKey: string, anchor: string, words: string[]): Promise<void> {
    if (!words.length) return;
    try {
        const raw = await store.getItem(unsaidLabel(publicKey, anchor));
        const was = raw ? JSON.parse(raw) as string[] : [];
        await store.setItem(unsaidLabel(publicKey, anchor), JSON.stringify([...new Set([...was, ...words])].slice(-50)));
    } catch { /* words only */ }
}
async function takeUnsaid(store: NamesPinStore, publicKey: string, anchor: string): Promise<string[]> {
    try {
        const raw = await store.getItem(unsaidLabel(publicKey, anchor));
        if (!raw) return [];
        await store.setItem(unsaidLabel(publicKey, anchor), '[]');
        const words = JSON.parse(raw);
        return Array.isArray(words) ? words.filter((w): w is string => typeof w === 'string') : [];
    } catch {
        return [];
    }
}

/** The node's state, the sync, the pin kept. `say`: an open says the notices itself; anything else keeps them for the next open. */
async function look(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, say = false): Promise<NamesResult<Synced & { kept: boolean }>> {
    const s = await fetchNamesState(anchor, identity);
    if (!s.ok) return s;
    // A read that failed is no pin to start again from (round 15): the sync would save an empty one over the kept one.
    const read = await readPin(store, identity.publicKey, anchor);
    if (read.failed) return NOT_READ;
    const r = syncNames({ pin: read.pin, state: s.value, me: identity });
    if (r.plan.kind === 'refused' && r.plan.reason === 'other_community') {
        return { ok: true, value: { state: s.value, pin: r.pin, plan: r.plan, notices: r.notices, generations: r.generations, kept: true } };
    }
    if (!say) await keepUnsaid(store, identity.publicKey, anchor, noticeWords(r.notices, s.value));
    const kept = await writeNamesPinTo(store, identity.publicKey, anchor, r.pin);
    return { ok: true, value: { state: s.value, pin: r.pin, plan: r.plan, notices: r.notices, generations: r.generations, kept } };
}

/**
 * The node's answers that say it did NOT store a statement: its own refusals, made before anything is written (the
 * shape or signature, who may make the next key, a standby, no names list here). Anything else (a 5xx from a proxy in
 * front of the node, an answer with no code, no answer at all) may come after the node stored it.
 */
function neverLanded(r: { status: number; code: string | null }): boolean {
    if (r.status === 400) return r.code === 'bad_statement' || r.code === 'bad_signature' || r.code === 'bad_key';
    if (r.status === 401) return r.code === 'unsigned';
    if (r.status === 403) return r.code !== null;
    if (r.status === 404) return r.code === 'feature_off';
    if (r.status === 409) return r.code === 'ask_for_share' || r.code === 'standby';
    return false;
}

/**
 * Sends a generation this phone made, written ahead (`pending`, with its key) before the request (design §8, D1: never a
 * statement of this phone's on the node whose key it lacks). On 201 the next sync takes it from the node and moves its key
 * into the ring. The key is dropped only on an answer that says the node did not store it. On anything else (a 5xx, no
 * answer) it stays: the next sync takes it if the node has it, sends it again while the node is where it was, and drops
 * it once the node moved on (409 `stale` included: the sync then takes the winner).
 */
async function sendGeneration(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, pin: NamesPin, g: Pick<NamesGeneration, 'statement' | 'signature'>): Promise<NamesResult<true>> {
    const sent = await postGeneration(anchor, identity, g);
    if (sent.ok) return { ok: true, value: true };
    if (neverLanded(sent)) await writeNamesPinTo(store, identity.publicKey, anchor, { ...pin, pending: null });
    return sent;
}

async function makeAndSend(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, synced: Pick<Synced, 'pin' | 'state'>, drops: string[]): Promise<NamesResult<true>> {
    const made = makeNamesGenerationFor(synced.pin, identity, drops);
    if (!(await writeNamesPinTo(store, identity.publicKey, anchor, made.pin))) return NOT_KEPT;
    const first = await postGeneration(anchor, identity, made.generation);
    if (first.ok) return { ok: true, value: true };
    // The node counts a holder on its own word (design Addendum 4): a phone that took the head's key from a box but has
    // sent no header since isn't one, and its own new key is refused (409 `ask_for_share`). It says so by sending its
    // signed header to the admins it trusts (never to a key this statement drops), then sends the statement once more.
    const claim = first.code === 'ask_for_share' ? await claimHeldKey(anchor, identity, synced, drops) : null;
    if (claim?.ok) return sendGeneration(anchor, identity, store, made.pin, made.generation);
    if (neverLanded(first)) await writeNamesPinTo(store, identity.publicKey, anchor, { ...made.pin, pending: null });
    // A claim that ran out of time (round 15): its status 0 stops the open, with no second look at the node.
    return claim ?? first;
}

/**
 * Sends this phone's ring, under its signed header, to every trusted listed admin but `drops`. Ok when one landed; the
 * timed-out answer when a share ran out of time (round 15: the open stops at it, as it does at a share's, so one open
 * waits one limit); null when none landed.
 */
async function claimHeldKey(anchor: string, identity: BeanPoolIdentity, synced: Pick<Synced, 'pin' | 'state'>, drops: string[]): Promise<NamesResult<true> | null> {
    const { pin, state } = synced;
    const head = pin.chain[pin.chain.length - 1];
    if (!head || !pin.ring[head.id]) return null;
    let landed = false;
    for (const a of state.admins) {
        const to = a.pubkey.toLowerCase();
        if (to === pin.me || !pin.trusted.includes(to) || drops.includes(to)) continue;
        // Never vouching for a key this statement drops, nor one this phone removed by hand (round 11).
        const share = namesSharesToSend(pin, state, identity, to, drops)[0];
        if (!share) continue;
        const done = await postShare(anchor, identity, share);
        if (done.ok) landed = true;
        else if (done.code === NAMES_TIMED_OUT) return done; // the connection stopped answering: stop here
    }
    // Nobody else to tell (the only other holder is the key being dropped): a claim to itself (design Addendum 5).
    if (!landed) {
        const self = namesSelfClaim(pin, state, identity, drops);
        const done = self ? await postShare(anchor, identity, self) : null;
        if (done && done.ok) landed = true;
        else if (done && done.code === NAMES_TIMED_OUT) return done;
    }
    return landed ? { ok: true, value: true } : null;
}

/**
 * What the screen does on opening (design §4): the node's state; the sync from this phone's pin (kept again); a
 * generation the plan makes without asking (the first, or a new one without an admin who left or was removed here), or
 * this phone's own that never landed, sent again; the keys sent to every admin this phone trusts that lacks one; then,
 * only when the plan is ready, the list. A refusal stops before anything is read or written.
 */
export async function openNamesList(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    return readTheList(anchor, identity, store, await withPin(identity.publicKey, anchor, () => openUnlocked(anchor, identity, store)));
}

/**
 * The open, on the pin's chain (the caller holds it). The notices kept for it are taken at the start and said by its
 * result. If it fails before that, they go back, with this open's own words, for the next open (round 15): every failure
 * return goes through `fail`. A notice is said once, and never lost to a failed open.
 */
async function openUnlocked(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore): Promise<NamesResult<NamesOpened>> {
    let l = await look(anchor, identity, store, true);
    if (!l.ok) return l;
    const unsaid = await takeUnsaid(store, identity.publicKey, anchor);
    // The walk wasn't kept, so the next look takes the same statements and gives the same notices: only `unsaid` goes back.
    if (!l.value.kept) { await keepUnsaid(store, identity.publicKey, anchor, unsaid); return NOT_KEPT; }
    let state = l.value.state;
    const notices: NamesNotice[] = [...l.value.notices];
    let made: string[] | null = null;
    let carried: string[] = [];
    let madeN = 0;
    let askedFor = '';
    const sentTo: string[] = [];
    const due: string[] = [];
    const words = (): string[] => {
        const out = [...unsaid, ...noticeWords(notices, state)];
        if (askedFor) out.push(askedFor);
        if (made && made.length) {
            // "No longer an admin" only for keys the node no longer lists; a key removed by hand gets the Remove words. "Has
            // sent" only for the admins the key reached; the rest get it on the next open.
            const listed = new Set(state.admins.map((a) => a.pubkey.toLowerCase()));
            const rest = made.filter((k) => !carried.includes(k));
            const gone = rest.filter((k) => !listed.has(k)).map((k) => callsignIn(state, k));
            const byHand = rest.filter((k) => listed.has(k)).map((k) => callsignIn(state, k));
            const sending = NAMES_COPY.newKeySent(sentTo.map((k) => callsignIn(state, k)), due.filter((k) => !sentTo.includes(k)).map((k) => callsignIn(state, k)));
            out.unshift(...[
                carried.length ? NAMES_COPY.newKeyCarried(carried.map((k) => callsignIn(state, k))) : '',
                gone.length ? NAMES_COPY.newKeyMade(gone) : '', byHand.length ? NAMES_COPY.newKeyRemoved(byHand) : '', sending,
                // A carried drop of an admin the server lists: if they are an admin again, check each other again (J3).
                ...carried.filter((k) => listed.has(k)).map((k) => NAMES_COPY.checkAgain(callsignIn(state, k), madeN)),
            ].filter((w) => w));
        }
        return [...new Set(out)];
    };
    const fail = async (r: NamesResult<never>): Promise<NamesResult<NamesOpened>> => {
        await keepUnsaid(store, identity.publicKey, anchor, words());
        return r;
    };
    const pend = l.value.pin.pending;
    const cur = l.value.state.current?.id ?? '-';
    if (pend && pend.statement.split('\n')[3] === cur && !(l.value.plan.kind === 'refused' && l.value.plan.reason === 'other_community')) {
        // Ours, never landed, and the node is still where it was: the same statement again (never a second key).
        const sent = await sendGeneration(anchor, identity, store, l.value.pin, pend);
        if (!sent.ok && sent.status === 0) return fail(sent);
        l = await look(anchor, identity, store, true);
        if (!l.ok) return fail(l);
        state = l.value.state;
        notices.push(...l.value.notices);
    } else if (l.value.plan.kind === 'make_first' || l.value.plan.kind === 'make_new') {
        const drops = l.value.plan.kind === 'make_new' ? l.value.plan.drops : [];
        // Drops this phone stands by whose statement it has left (abandoned): rule (a) keeps them, even where the history it
        // took drops the same key in a statement of its own, so the key comes from this phone (round 14, :1078).
        const before = l.value.pin;
        madeN = (before.chain[before.chain.length - 1]?.n ?? 0) + 1;
        const chainIds = new Set(before.chain.map((x) => x.id));
        carried = drops.filter((k) => k in before.dropped && !chainIds.has(before.dropped[k]));
        const sent = await makeAndSend(anchor, identity, store, l.value, drops);
        if (!sent.ok && (sent.status === 0 || sent.code === 'not_kept')) return fail(sent);
        if (sent.ok && l.value.plan.kind === 'make_new') made = drops;
        if (!sent.ok && sent.code === 'ask_for_share') askedFor = askForShareWords(l.value.state, identity.publicKey);
        l = await look(anchor, identity, store, true);
        if (!l.ok) return fail(l);
        state = l.value.state;
        notices.push(...l.value.notices);
    }
    const { pin, plan, generations } = l.value;
    const kept = pin;
    if (plan.kind === 'ready') {
        for (const share of namesSharesToSend(pin, state, identity)) {
            due.push(share.to);
            const done = await postShare(anchor, identity, share);
            if (done.ok) sentTo.push(share.to);
            // A request ran out of time (round 14): stop here, so one open waits one limit, not one per request. The next
            // open sends any share still due; the list isn't read. A connection that fails at once costs nothing: go on.
            else if (done.code === NAMES_TIMED_OUT) return fail(done);
        }
    }
    const said = words();
    // The rolled-back card's estimate, before anything is read; the exact count comes on the ready read after it.
    const estimate = plan.kind === 'refused' && plan.reason === 'rolled_back' ? Math.max(0, pin.seen.length - (state.counts?.entries ?? 0)) : 0;
    if (estimate) said.push(NAMES_COPY.lostSinceCopy(estimate));
    const justChecked = await justCheckedNow(store, identity.publicKey, anchor, state);
    return {
        ok: true,
        value: {
            state, plan, pin: kept, ring: namesRingKeys(kept), generations, list: null, notices: said, made, sentTo, justChecked,
            toCheck: state.admins.filter((a) => a.pubkey !== identity.publicKey && !kept.trusted.includes(a.pubkey)),
            lost: estimate,
        },
    };
}

/**
 * The list read, after the pin's chain is let go (round 14): a big list on a slow link can take minutes, and nothing it
 * does needs the chain until it saves `seen`, which is a short link of its own that reads the pin afresh. So a Remove or
 * a check tapped during a long read isn't held up, and isn't written over (round 12's race stays closed). Where the pin
 * can't be read afresh, nothing is saved (round 15): `seen` stays as it was, and the next ready read catches up.
 * A read that fails puts the open's words back for the next open: they were never said (round 15).
 */
async function readTheList(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, opened: NamesResult<NamesOpened>): Promise<NamesResult<NamesOpened>> {
    if (!opened.ok || opened.value.plan.kind !== 'ready') return opened;
    const o = opened.value;
    const got = await fetchNamesList(anchor, identity, false, o.state.counts?.entries ?? 2000);
    if (!got.ok) {
        await withPin(identity.publicKey, anchor, () => keepUnsaid(store, identity.publicKey, anchor, o.notices));
        return got;
    }
    const list = got.value;
    return withPin(identity.publicKey, anchor, async (): Promise<NamesResult<NamesOpened>> => {
        // Names this phone saw that are neither on the node nor deleted by an admin: a loss, said with its count.
        // Only what the pin had seen when the read began can be missing from it; an id seen since (a Save that landed during
        // the read) is kept, never counted lost. Never the open's own pin saved instead: it would undo a Remove, a check or
        // a new key saved during the read, or bring back a pin removed since.
        const fresh = await readPin(store, identity.publicKey, anchor);
        if (fresh.failed || !fresh.pin) return { ok: true, value: { ...o, list } };
        const now = fresh.pin;
        const before = new Set(o.pin.seen ?? []);
        const since = (now.seen ?? []).filter((id) => !before.has(id));
        const read = namesSeenAfterRead({ ...now, seen: o.pin.seen ?? [] }, list.entries.map((e) => e.id), list.deleted ?? []);
        const after = { pin: { ...read.pin, seen: [...new Set([...read.pin.seen, ...since])].slice(0, 2000) }, gone: read.gone };
        await writeNamesPinTo(store, identity.publicKey, anchor, after.pin);
        const gone = after.gone.length;
        return {
            ok: true,
            value: {
                ...o, pin: after.pin, ring: namesRingKeys(after.pin), list, lost: gone,
                notices: gone ? [...o.notices, NAMES_COPY.lostEntries(gone)] : o.notices,
                toCheck: o.state.admins.filter((a) => a.pubkey !== identity.publicKey && !after.pin.trusted.includes(a.pubkey)),
            },
        };
    });
}

// ── The asked actions ────────────────────────────────────────────────────────────────────────

/**
 * A new key on this phone, asked first: "Start again" on an empty history when nobody holds the current key, or a new key
 * off this phone's head when nobody who is an admin holds the head's key (what was sealed under it stays locked). Starting
 * again (design addendum (c)) first takes the node's whole key history onto this phone's, for its drops and its place only
 * (no trust, no key), and saves it; then it is the same new key off the head. Then the list opens again.
 */
export async function makeKeyOnThisPhone(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    return readTheList(anchor, identity, store, await withPin(identity.publicKey, anchor, () => makeKeyUnlocked(anchor, identity, store)));
}

async function makeKeyUnlocked(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore): Promise<NamesResult<NamesOpened>> {
    let l = await look(anchor, identity, store);
    if (!l.ok) return l;
    const first = l.value.plan;
    if (first.kind === 'refused' && first.reason === 'untrusted_maker' && first.canStartAgain && l.value.pin.chain.length === 0) {
        // Start again is a follow on an empty chain (design Addendum 3).
        const taken = followNamesServer(l.value.pin, l.value.state).pin;
        if (taken.chain.length === 0) return { ok: false, status: 0, code: 'no_plan', message: NAMES_COPY.missingRecord };
        if (!(await writeNamesPinTo(store, identity.publicKey, anchor, taken))) return NOT_KEPT;
        l = await look(anchor, identity, store);
        if (!l.ok) return l;
    }
    const { plan } = l.value;
    if (!(plan.kind === 'wait' && plan.canMakeNew)) return { ok: false, status: 0, code: 'no_plan', message: 'There is no new key to make here.' };
    const sent = await makeAndSend(anchor, identity, store, l.value, plan.drops);
    if (!sent.ok && sent.code === 'ask_for_share') return { ...sent, message: askForShareWords(l.value.state, identity.publicKey) };
    if (!sent.ok) return sent;
    return openUnlocked(anchor, identity, store);
}

/** The 409 `ask_for_share` in words: who the node says holds the current key (design Addendum 4). */
function askForShareWords(state: NamesState, me: string): string {
    // The holder the node names; on a stale screen it may name none here, then the current key's maker.
    const maker = (state.generations as { id?: string; maker?: string }[] ?? []).find((g) => g?.id === state.current?.id)?.maker ?? '';
    const holder = (state.holdersOfCurrent ?? []).find((k) => k !== me.toLowerCase()) ?? maker;
    return NAMES_COPY.askForShare(callsignIn(state, holder));
}

/**
 * "Put the key history back" (asked first, design §4.3.6): every statement this phone took after the node's current
 * one, sent again in order (one it has already is fine), then the open sends the keys again.
 */
export async function putHistoryBack(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    return readTheList(anchor, identity, store, await withPin(identity.publicKey, anchor, async (): Promise<NamesResult<NamesOpened>> => {
        const l = await look(anchor, identity, store);
        if (!l.ok) return l;
        if (!(l.value.plan.kind === 'refused' && l.value.plan.reason === 'rolled_back')) return openUnlocked(anchor, identity, store);
        for (const link of namesReplay(l.value.pin, l.value.state)) {
            const sent = await postGeneration(anchor, identity, link, true);
            if (!sent.ok) return sent;
        }
        return openUnlocked(anchor, identity, store);
    }));
}

/**
 * "Follow the server's history" (asked first; design Addendum 3): offered on a different history whose server path is
 * whole (`canFollow`). This phone's chain goes back to the last statement it shares with the server's, and the rest of
 * the server's path is taken for its drops and its place only: every signature checked, no trust, no key, no check in
 * person needed. The words say whom it stopped trusting. Then the list opens again: before this phone writes, it makes
 * a key without every admin it had removed, unless the statement that removed them on this phone is on the followed
 * path (rule (a): a removal is carried by its own statement, never by another one that drops the same key).
 */
export async function followServerHistory(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    return readTheList(anchor, identity, store, await withPin(identity.publicKey, anchor, () => followUnlocked(anchor, identity, store)));
}

async function followUnlocked(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore): Promise<NamesResult<NamesOpened>> {
    const l = await look(anchor, identity, store);
    if (!l.ok) return l;
    const { plan, state } = l.value;
    // Addendum 4: also on a stop at a maker no trusted admin vouches for (a non-empty chain; an empty one is Start again).
    if (!(plan.kind === 'refused' && (plan.reason === 'different_history' || plan.reason === 'untrusted_maker') && plan.canFollow && l.value.pin.chain.length > 0)) {
        return { ok: false, status: 0, code: 'no_plan', message: 'There is no key history to follow here.' };
    }
    const followed = followNamesServer(l.value.pin, state);
    if (!(await writeNamesPinTo(store, identity.publicKey, anchor, followed.pin))) return NOT_KEPT;
    const listed = new Set(state.admins.map((a) => a.pubkey.toLowerCase()));
    const said = followed.dropped.map((d) => (listed.has(d.key)
        ? NAMES_COPY.checkAgain(callsignIn(state, d.key), d.n)
        : NAMES_COPY.newKeyBy(callsignIn(state, d.maker), [callsignIn(state, d.key)])));
    const opened = await openUnlocked(anchor, identity, store);
    // The follow's own words go back for the next open when its open fails (round 15), as the open's own do.
    if (!opened.ok) { await keepUnsaid(store, identity.publicKey, anchor, said); return opened; }
    return { ok: true, value: { ...opened.value, notices: [...new Set([...said, ...opened.value.notices])] } };
}

/** "Send the keys to @X again": the same share the open sends, now, to one admin this phone trusts. */
export function sendKeysAgain(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, to: string): Promise<NamesResult<{ to: string }>> {
    return withPin(identity.publicKey, anchor, async (): Promise<NamesResult<{ to: string }>> => {
        const l = await look(anchor, identity, store);
        if (!l.ok) return l;
        if (l.value.plan.kind !== 'ready') return { ok: false, status: 0, code: 'no_plan', message: NAMES_COPY.notReady };
        const share = namesSharesToSend(l.value.pin, l.value.state, identity, to)[0];
        if (!share) return { ok: false, status: 0, code: 'check_in_person', message: NAMES_COPY.checkFirst(callsignIn(l.value.state, to.toLowerCase())) };
        return postShare(anchor, identity, share);
    });
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

export interface OpenedEntry {
    id: string;
    keyId: string;
    createdAt: string;
    updatedAt: string;
    /** The name and note, or null where this phone can't open it. */
    text: NamesEntryText | null;
    /** Why it can't be opened: no key of its generation on this phone, or the box didn't open (altered, or a wrong key). */
    locked: 'no_key' | 'did_not_open' | null;
    /** The key's number and maker, where this phone took its statement; null for a key it has never seen. */
    key: { n: number; maker: string } | null;
    /** The trusted admins the node says hold its key and whose phones trust this one (they will send it), by callsign. */
    holders: string[];
    /** Trusted admins the node says hold its key whose phones don't trust this one: a check in person comes first. */
    notTrusting: string[];
    /** Holders checked in person here whose phones haven't said yet whether they trust this one (round 12). */
    checkedHere: string[];
    /** The live confirmation against it (confirmed or waiting for a second admin), if any. */
    confirmation: ConfirmationRow | null;
}

type CheckedRecords = { gens: Map<string, NamesGeneration>; newest: Map<string, NamesShare> };
const checkedByState = new WeakMap<object, CheckedRecords>();

/**
 * The node's statements and share headers, each parsed and its signature checked once per state object (round 14): a
 * draw of the list asks for them once per entry, and each strict Ed25519 check costs about a millisecond (several on an
 * old phone). Keyed on the exact object the open received (a WeakMap: identity, never anything a server could make
 * collide), so a new answer is checked afresh, and nothing refused before is taken now: the same checks, run once.
 * `newest`: each admin's share header with the newest head.
 */
function checkedRecords(state: Pick<NamesState, 'communityId' | 'generations' | 'shares'>): CheckedRecords {
    const cached = checkedByState.get(state);
    if (cached) return cached;
    const gens = new Map<string, NamesGeneration>();
    for (const r of Array.isArray(state.generations) ? state.generations : []) {
        const g = readNamesGeneration(r, state.communityId);
        if (g) gens.set(g.id, g);
    }
    const newest = new Map<string, NamesShare>();
    for (const r of Array.isArray(state.shares) ? state.shares : []) {
        const w = readNamesShare(r, state.communityId);
        if (!w) continue;
        const prev = newest.get(w.from);
        if (!prev || (gens.get(w.headId)?.n ?? 0) > (gens.get(prev.headId)?.n ?? 0)) newest.set(w.from, w);
    }
    const out = { gens, newest };
    checkedByState.set(state, out);
    return out;
}

/**
 * Of `holders` (keys), the ones whose phones still trust this one, so will send it the keys on their next open (round 9):
 * the holder's newest share header (each is public) names this phone, and no statement on the server's path after that
 * header's head dropped it. Trust isn't mutual: a holder whose phone dropped this key sends nothing until a check.
 */
export function holdersWhoWillSend(state: Pick<NamesState, 'communityId' | 'generations' | 'shares' | 'current'>, me: string, holders: string[], justChecked: string[] = []): string[] {
    if (!holders.length) return [];
    const { gens, newest } = checkedRecords(state);
    const mine = me.toLowerCase();
    void justChecked; // round 12: a check here doesn't make a holder one that will send: its phone may not trust this one
    return holders.filter((h) => {
        const w = newest.get(h.toLowerCase());
        if (!w || !w.trusts.includes(mine)) return false;
        // Walk back from the server's current to that header's head: a drop of this phone on the way means they dropped it.
        let at: string | null = state.current?.id ?? null;
        for (let i = 0; at && i <= gens.size; i++) {
            if (at === w.headId) return true;
            const g = gens.get(at);
            if (!g) return false;
            if (g.drops.includes(mine)) return false;
            at = g.parentId;
        }
        return false;
    });
}

/**
 * Of `holders`, the ones this phone checked in person whose phones have sent no header since (round 12): the phone can't
 * know whether they checked it back, so the words say both ways.
 */
export function holdersCheckedHere(state: Pick<NamesState, 'communityId' | 'generations' | 'current'>, me: string, holders: string[], justChecked: string[] = []): string[] {
    // Round 13: a re-admitted phone too. A check both ways makes the holder's phone trust it again, and one way the
    // words' "if not, meet them" is the right advice.
    void state; void me;
    return holders.filter((h) => justChecked.includes(h.toLowerCase()));
}

/** Every entry, opened where this phone can; open ones by name, then the locked ones. */
export function openEntries(list: NamesListBody, opened: Pick<NamesOpened, 'ring' | 'pin' | 'generations' | 'state'> & Partial<Pick<NamesOpened, 'justChecked'>>): OpenedEntry[] {
    const live = new Map<string, ConfirmationRow>();
    for (const c of list.confirmations ?? []) if (c.status !== 'revoked') live.set(c.entryId, c);
    const out = (list.entries ?? []).map((e): OpenedEntry => {
        const key = opened.ring[e.keyId];
        let text: NamesEntryText | null = null;
        let locked: OpenedEntry['locked'] = key ? null : 'no_key';
        if (key) {
            try { text = openNamesEntry(key, e.id, e.keyId, e.ciphertext); } catch { locked = 'did_not_open'; }
        }
        const all = text ? [] : opened.state.admins
            .filter((a) => a.pubkey !== opened.pin.me && opened.pin.trusted.includes(a.pubkey) && (a.keyIds ?? []).includes(e.keyId));
        const sending = new Set(holdersWhoWillSend(opened.state, opened.pin.me, all.map((a) => a.pubkey)));
        const checked = new Set(holdersCheckedHere(opened.state, opened.pin.me, all.filter((a) => !sending.has(a.pubkey)).map((a) => a.pubkey), opened.justChecked ?? []));
        const holders = all.filter((a) => sending.has(a.pubkey)).map((a) => a.callsign);
        const checkedHere = all.filter((a) => checked.has(a.pubkey)).map((a) => a.callsign);
        const notTrusting = all.filter((a) => !sending.has(a.pubkey) && !checked.has(a.pubkey)).map((a) => a.callsign);
        return {
            id: e.id, keyId: e.keyId, createdAt: e.createdAt, updatedAt: e.updatedAt, text, locked,
            key: text ? null : namesKeyLabel(opened.pin, opened.generations, e.keyId), holders, notTrusting, checkedHere, confirmation: live.get(e.id) ?? null,
        };
    });
    return out.sort((a, b) => {
        if (!a.text || !b.text) return a.text ? -1 : b.text ? 1 : a.createdAt.localeCompare(b.createdAt);
        return a.text.name.localeCompare(b.text.name, undefined, { sensitivity: 'base' });
    });
}

/** Entries whose name or note holds `query` (any case); every entry for an empty query. */
export function filterEntries(entries: OpenedEntry[], query: string): OpenedEntry[] {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return entries;
    return entries.filter((e) => !!e.text && `${e.text.name}\n${e.text.note}`.toLocaleLowerCase().includes(q));
}

/** Seals a name and note under the key of `keyId`, as a new entry or an edit of `entryId`. A problem in the text is said. */
export function sealedFor(key: Uint8Array, keyId: string, text: { name: string; note: string }, entryId?: string):
    { ok: true; id: string; ciphertext: string } | { ok: false; error: string } {
    const checked = normaliseNamesEntryText(text);
    if (!checked.ok) return checked;
    const id = entryId ?? newNamesEntryId();
    return { ok: true, id, ciphertext: sealNamesEntry(key, id, keyId, checked.value) };
}

export function addNamesEntry(anchor: string, identity: BeanPoolIdentity, keyId: string, sealed: { id: string; ciphertext: string }) {
    return call<{ id: string }>(anchor, identity, 'POST', `${NAMES_PATH}/entries`, { id: sealed.id, ciphertext: sealed.ciphertext, keyId });
}

export function editNamesEntry(anchor: string, identity: BeanPoolIdentity, keyId: string, sealed: { id: string; ciphertext: string }) {
    return call<{ id: string }>(anchor, identity, 'PUT', `${NAMES_PATH}/entries/${encodeURIComponent(sealed.id)}`, { ciphertext: sealed.ciphertext, keyId });
}


/** A new entry's id, chosen when the Add form opens and kept until the add is confirmed (design §8: add is idempotent by id). */
export const newEntryId = (): string => newNamesEntryId();

/**
 * The removals this phone stands by that no ready key of its own carries yet (round 13): its removals by hand, and every
 * drop whose statement isn't on its chain. While any stands, it writes nothing.
 */
function removalsPending(pin: NamesPin): string[] {
    const chainIds = new Set(pin.chain.map((l) => l.id));
    return [...new Set([...pin.manualDrops, ...Object.entries(pin.dropped).filter(([, id]) => !chainIds.has(id)).map(([k]) => k)])];
}

/** The removals this phone stands by, by callsign, as the pin has them now (for the screen after an action failed). */
export function pendingRemovals(store: NamesPinStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, state: Pick<NamesState, 'callsigns' | 'admins'> | null): Promise<string[]> {
    return withPin(identity.publicKey, anchor, async () => {
        const pin = await readNamesPinFrom(store, identity.publicKey, anchor);
        return pin ? removalsPending(pin).map((k) => (state ? callsignIn(state, k) : '')) : [];
    });
}

/**
 * Writes an entry (rule 4), deciding from the pin, never from the screen's last open (round 13): on the pin's chain, a
 * fresh look at the node and the pin; nothing is written while a removal this phone stands by isn't carried by a key of
 * its own yet (the words say so: open the list again), or while the plan isn't ready; otherwise it is sealed under the
 * head's key. `entryId` is an edit's; `addId` a new entry's, chosen when its form opened ({@link newEntryId}), so a Save
 * after a lost answer sends the same id and the node answers `entry_exists`, which is done: never a second entry. When
 * the node's current moved on (409 `stale_key`) it looks again and tries once more. An add that lands is seen at once.
 */
export function saveNamesEntry(
    anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, opened: Pick<NamesOpened, 'plan' | 'pin' | 'ring'>, text: { name: string; note: string },
    entryId?: string, addId?: string,
): Promise<NamesResult<{ id: string; keyId: string; ciphertext: string; opened: NamesOpened | null }>> {
    void opened; // the screen's snapshot: never the ground for a write
    // One id for every try: an add that landed but whose answer was lost comes back `entry_exists`.
    const id = entryId ?? addId ?? newNamesEntryId();
    return withPin(identity.publicKey, anchor, async (): Promise<NamesResult<{ id: string; keyId: string; ciphertext: string; opened: NamesOpened | null }>> => {
        for (let tries = 0; tries < 2; tries++) {
            const l = await look(anchor, identity, store);
            if (!l.ok) return l;
            const { pin, plan, state } = l.value;
            const removing = removalsPending(pin);
            if (removing.length) return { ok: false, status: 0, code: 'still_removing', message: NAMES_COPY.stillRemoving(removing.map((k) => callsignIn(state, k))) };
            const head = pin.chain[pin.chain.length - 1];
            if (plan.kind !== 'ready' || !head || !pin.ring[head.id]) return { ok: false, status: 0, code: 'not_ready', message: NAMES_COPY.notReady };
            const sealed = sealedFor(fromHex(pin.ring[head.id]), head.id, text, id);
            if (!sealed.ok) return { ok: false, status: 0, code: 'bad_text', message: sealed.error };
            const sent = entryId ? await editNamesEntry(anchor, identity, head.id, sealed) : await addNamesEntry(anchor, identity, head.id, sealed);
            const landed = sent.ok || (sent.code === 'entry_exists' && !entryId);
            if (landed) {
                // Seen at once (round 11): a take-over that loses it is said, with no read in between. On the chain already.
                if (!entryId) {
                    const now = await readNamesPinFrom(store, identity.publicKey, anchor);
                    if (now && !now.seen.includes(sealed.id) && now.seen.length < 2000) await writeNamesPinTo(store, identity.publicKey, anchor, { ...now, seen: [...now.seen, sealed.id] });
                }
                return { ok: true, value: { id: sealed.id, keyId: head.id, ciphertext: sealed.ciphertext, opened: null } };
            }
            if (sent.code !== 'stale_key') return sent;
        }
        return { ok: false, status: 0, code: 'not_ready', message: NAMES_COPY.notReady };
    });
}

// ── Confirming ───────────────────────────────────────────────────────────────────────────────

export interface CommunityMember {
    publicKey: string;
    callsign: string;
}

/**
 * Who can be confirmed now: members with no live confirmation, by name; this admin too only where they are the
 * community's only admin (the node says the same).
 */
export function confirmableMembers(members: CommunityMember[], list: NamesListBody, myPubkey: string, adminCount: number): CommunityMember[] {
    const confirmed = new Set((list.confirmations ?? []).filter((c) => c.status !== 'revoked').map((c) => c.memberPubkey));
    return members
        .filter((m) => /^[0-9a-f]{64}$/.test(m.publicKey) && !confirmed.has(m.publicKey) && (m.publicKey !== myPubkey || adminCount <= 1))
        .sort((a, b) => a.callsign.localeCompare(b.callsign, undefined, { sensitivity: 'base' }));
}

/** A confirmation in words, for the entry it is against. */
export function confirmationLine(c: ConfirmationRow, nameOf: (pubkey: string) => string): string {
    const who = c.callsign ? `@${c.callsign}` : 'a member';
    const by = nameOf(c.confirmedBy);
    const when = shortDate(c.confirmedAt);
    if (c.status === 'awaiting_second') return `${who}: confirmed by ${by} ${when}, waiting for a second admin`;
    if (c.status === 'revoked') return `${who}: confirmation revoked`;
    return c.secondedBy ? `${who}: confirmed by ${by} and ${nameOf(c.secondedBy)}, ${when}` : `${who}: confirmed by ${by}, ${when}`;
}

/** What this admin may do with a live confirmation: second it (someone else's, waiting), and revoke it. */
export function confirmationActions(c: ConfirmationRow, myPubkey: string): { second: boolean; revoke: boolean } {
    const live = c.status !== 'revoked';
    return {
        second: live && c.status === 'awaiting_second' && c.confirmedBy !== myPubkey && c.memberPubkey !== myPubkey,
        revoke: live,
    };
}

// ── The access log ───────────────────────────────────────────────────────────────────────────

const ACTION_WORDS: Record<NamesAction, string> = {
    read: 'opened the list',
    export: 'exported the list',
    add: 'added an entry',
    edit: 'changed an entry',
    delete: 'deleted an entry',
    confirm: 'confirmed',
    second: 'confirmed as second admin',
    revoke: 'revoked the confirmation of',
    key_made: 'made the list’s first key',
    key_changed: 'made a new key',
    key_shared: 'sent the list’s keys to',
    holder_dropped: 'no longer holds the key:',
    settings: 'changed the settings',
};

/** One line of the access log, in words: who, what, and when. */
export function logLineText(line: NamesLogLine, nameOf: (pubkey: string) => string): string {
    const subject = line.subject ? `@${line.subjectCallsign ?? nameOf(line.subject)}` : '';
    if (line.action === 'holder_dropped') return `${subject} no longer holds the key (not an admin now) · ${shortDate(line.at)}`;
    const actor = line.actorCallsign ? `@${line.actorCallsign}` : nameOf(line.actor);
    return `${actor} ${ACTION_WORDS[line.action] ?? line.action}${subject ? ` ${subject}` : ''} · ${shortDate(line.at)}`;
}

export function shortDate(iso: string): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ── The PDF ──────────────────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * The page the PDF is printed from, on this phone (expo-print): the community, who exported it and when, and every entry
 * this phone could open, with the member confirmed against it. Locked entries are counted, never guessed at. Every value
 * is escaped: a note is the admin's free text.
 */
export function namesListHtml(opts: { communityName: string; exportedBy: string; at: Date; entries: OpenedEntry[] }): string {
    const open = opts.entries.filter((e) => e.text);
    const locked = opts.entries.length - open.length;
    const rows = open.map((e) => {
        const c = e.confirmation;
        const member = c ? `@${escapeHtml(c.callsign ?? '')}${c.status === 'awaiting_second' ? ' (waiting for a second admin)' : ''}` : '';
        return `<tr><td>${escapeHtml(e.text!.name)}</td><td>${escapeHtml(e.text!.note).replace(/\n/g, '<br>')}</td><td>${member}</td></tr>`;
    }).join('\n');
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(opts.communityName)}: names list</title>
<style>
body { font-family: -apple-system, Roboto, "Noto Sans", sans-serif; font-size: 11pt; margin: 24px; color: #111; }
h1 { font-size: 16pt; margin: 0 0 4px; }
p { margin: 4px 0; }
table { width: 100%; border-collapse: collapse; margin-top: 12px; }
th, td { border: 1px solid #999; padding: 6px; text-align: left; vertical-align: top; }
th { background: #eee; }
.warn { border: 1px solid #b45309; padding: 8px; margin-top: 8px; }
</style></head><body>
<h1>${escapeHtml(opts.communityName)}: names list</h1>
<p>Exported by ${escapeHtml(opts.exportedBy)} on ${escapeHtml(opts.at.toISOString().slice(0, 10))}. ${open.length} ${open.length === 1 ? 'entry' : 'entries'}${locked ? `, and ${locked} this phone couldn’t open` : ''}.</p>
<p class="warn">Real names of this community’s members. Keep this page as safe as a paper list: whoever holds it can read it. The community’s other admins can see that it was exported, and when.</p>
<table><thead><tr><th>Name</th><th>Note</th><th>Member confirmed</th></tr></thead><tbody>
${rows}
</tbody></table>
</body></html>`;
}

/**
 * The list key this phone adds names under, to compare with another admin's phone in person: its number and 20 digits
 * from its id. Only when the plan is ready (the only time this phone writes); null otherwise. Two phones that open the
 * list one after the other on an honest server show the same; a phone the server keeps from a removal shows an older one.
 */
export function listKeyOf(o: Pick<NamesOpened, 'plan' | 'pin'>): { n: number; code: string } | null {
    const head = o.pin.chain[o.pin.chain.length - 1];
    if (o.plan.kind !== 'ready' || !head) return null;
    return { n: head.n, code: namesListKeyCode(head.id) };
}

// ── Words ────────────────────────────────────────────────────────────────────────────────────

/** "@A", "@A or @B", "@A, @B or @C". */
function either(names: string[]): string {
    const named = names.map(at);
    return named.length <= 1 ? named[0] ?? 'an admin' : `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`;
}

function both(names: string[]): string {
    const named = names.map(at);
    return named.length <= 1 ? named[0] ?? 'an admin' : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

/**
 * Every sentence the screen says about the list's keys. The ones the design fixes (DESIGN-names-list-trust-fable.md §9)
 * are exactly its words, which are true under its proof (§6) and say its limits; the tests pin each.
 */
export const NAMES_COPY = {
    title: 'Names list',
    // §9, exact.
    who: 'Only this community’s owners and admins can read these names, on their own phones. The server keeps them scrambled: '
        + 'a backup, a copy or a stolen database holds nothing readable. This phone gives the list’s keys only to admins whose phones '
        + 'were checked in person, by you or by an admin you trust, and takes a new key only from them. What it can’t protect: '
        + 'a check made with the wrong person, a phone someone else gets into, a lost phone until an admin removes its key, and an '
        + 'admin’s phone that the server keeps from learning of a removal: what that phone writes until it learns, the removed admin’s '
        + 'keys can read. Each admin’s phone learns of a removal when it opens the list, unless the server hides it. '
        // Addendum 2 (§3): the removal check is Remove by hand, not a comparison.
        + 'After an admin is removed, look at this phone’s admins: if it still shows them, tap Remove @X’s old key. Whatever the '
        + 'server says, this phone then makes a key without them or writes nothing.',
    // The design addendum's (e) (the fifth deciding review's BLOCKING finding): what the new key protects is this phone's writes.
    newKeyMade: (who: string[]) => `The list has a new key because ${both(who)} ${who.length > 1 ? 'are' : 'is'} no longer ${who.length > 1 ? 'admins' : 'an admin'}. `
        + `Nothing this phone writes from now on can be read with the keys ${both(who)} had.`,
    /** A key removed by hand ("Remove @X's old key"): the node still lists the admin, so not "no longer an admin". */
    newKeyRemoved: (who: string[]) => (who.length > 1
        ? `The list has a new key that the old phones of ${both(who)} can’t read. If they get new phones, check them in person and this phone will send the keys.`
        : `The list has a new key that ${at(who[0] ?? '')}’s old phone can’t read. If ${at(who[0] ?? '')} gets a new phone, check it in person and this phone will send the keys.`),
    /** Whom the new key reached, and whom it will reach on the next open; nothing when there is nobody to send it to. */
    newKeySent: (sent: string[], unsent: string[]) => {
        if (!unsent.length) return sent.length ? 'This phone has sent the new key to the admins it trusts.' : '';
        const later = `the next time the list opens on it.`;
        return sent.length
            ? `This phone has sent the new key to ${both(sent)}. It will send it to ${both(unsent)} ${later}`
            : `This phone will send the new key to ${both(unsent)} ${later}`;
    },
    /** A key this phone had removed, carried into the history it took (Addendum 2, ruling 2): the forced drop landed. */
    // Round 14 (:1078): the key that removed them on this phone is on a history it left (the followed one may drop them too,
    // in another statement; rule (a) keeps this phone's own, so it makes its own key).
    newKeyCarried: (who: string[]) => `The list has a new key without ${both(who)}: this phone had removed their key on a key history it has since left.`,
    /** The walk dropped a key this phone trusted that the server still lists (Addendum 2, ruling 5). */
    checkAgain: (who: string, n: number) => `Key ${n} removed ${at(who)}’s key. If ${at(who)} is an admin again, check each other’s phones again: `
        + `a check made before this phone took key ${n} doesn’t count past it.`,
    listKey: (n: number, code: string) => `This phone adds names under list key ${n}, code ${code}.`,
    compareListKey: 'When you check each other, compare this line too. If it differs, open the list again on both phones. '
        + 'If it still differs, the server is showing your phones different things: add no names until it matches, and tell your admins.',
    removeKey: (who: string) => `Remove ${at(who)}’s old key? The list gets a new key that ${at(who)}’s old phone can’t read. `
        + `If ${at(who)} gets a new phone, check it in person and this phone will send the keys.`,
    checkIntro: (who: string) => `Meet ${at(who)}. Open the names list on both phones, and scan each other’s code (or compare and type the `
        + `20 digits). Only do this with ${at(who)} in front of you: your phone will trust this key, send it the names, and take new keys it makes.`,
    mismatch: (who: string) => `The key you scanned isn’t the one the server lists for ${at(who)}. Your phone trusts the key you scanned and `
        + `nothing is sent to the server’s key. Either the server has put ${at(who)}’s name on another key, or this isn’t ${at(who)}’s phone. Tell your other admins.`,
    // The design addendum's (e): rule 1b gives a way forward through any admin whose phone opens the list.
    refusedUntrusted: (n: number, who: string) => `The list’s key number ${n} was made by ${at(who)}, and no admin this phone trusts has `
        + `checked them. Nothing was read or written. Meet ${at(who)}, or an admin whose phone already opens the list, and check each other’s phones.`,
    refusedRolledBack: (n: number, m: number) => `The server offers an older key history (up to key ${n}) than this phone has (key ${m}). `
        + 'A server put back to an older copy does that. Nothing was read or written. You can put the key history back from this phone; '
        + 'entries written since the copy are gone and must be typed again from your paper copy.',
    // Design Addendum 3, exact.
    refusedDifferent: 'The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an '
        + 'admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or '
        + 'written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds, and before '
        + 'it writes again it makes a new key without any admin it had removed.',
    /** refusedDifferent when this phone stands by no removal (round 12, J10): no new key follows, so the words don't say one. */
    refusedDifferentNone: 'The server shows a key history this phone didn’t take. A standby that took over from an older copy, where an '
        + 'admin’s phone then made a new key, does that; so does whoever runs the server changing the history. Nothing was read or '
        + 'written. Ask your admins what happened. You can follow the server’s history: this phone keeps the keys it holds.',
    wait: (holders: string[]) => (holders.length
        ? `You don’t hold the list’s keys yet. ${either(holders)} will send them the next time they open the names list.`
        : 'Nobody this phone trusts holds the list’s keys. Meet an admin who does and check each other’s phones.'),
    lockedEntry: (n: number | null, who: string, holders: string[], notTrusting: string[] = [], checkedHere: string[] = []) => `${n === null ? 'Sealed with a key this phone has never seen.' : `Sealed with key ${n} (made by ${at(who)}).`} `
        + 'This phone doesn’t hold it. '
        + (holders.length
            ? `${either(holders)} ${holders.length > 1 ? 'hold' : 'holds'} it and will send it on their next open.`
            : checkedHere.length
            ? (checkedHere.length > 1
                ? `${either(checkedHere)} hold it. Their phones send it once they trust this one: if you have just checked each other, that is the next time one of them opens the names list; if not, meet one of them and check each other’s phones.`
                : `${at(checkedHere[0])} holds it. Their phone sends it once it trusts this one: if you have just checked each other, that is the next time it opens the names list; if not, meet them and check each other’s phones.`)
            : notTrusting.length
            ? (notTrusting.length > 1
                ? `${either(notTrusting)} hold it, but their phones don’t trust this one yet: meet one of them and check each other’s phones.`
                : `${at(notTrusting[0])} holds it, but their phone doesn’t trust this one yet: meet ${at(notTrusting[0])} and check each other’s phones.`)
            : 'Nobody who is an admin now holds it: type it again from your paper copy, or delete it.'),
    startAgain: (count: number) => 'Nobody who is an admin now holds the list’s keys. You can start a new key; the '
        + `${count} ${count === 1 ? 'entry' : 'entries'} written before stay locked until an admin who held a key comes back, or they are typed again from your paper copy.`,
    // The design's other words (§4, §7, §10), and the screen's.
    otherCommunity: 'The server says this list belongs to a different community from the one this phone opened before. Nothing was read or written.',
    missingRecord: 'The server is missing part of the list’s key history, so this phone can’t check the newest key. Nothing was read or written. '
        + 'Ask whoever runs the server, or an admin.',
    /** Holders whose phones don't trust this one (round 9): nothing comes until a check in person. */
    /** Holders this phone checked in person whose phones haven't said yet whether they trust it (round 12): both ways. */
    holdersJustChecked: (holders: string[]) => (holders.length > 1
        ? `${either(holders)} hold the list’s keys. Their phones send them once they trust this one: if you have just checked each other, that is the next time one of them opens the names list; if not, meet one of them and check each other’s phones.`
        : `${at(holders[0] ?? '')} holds the list’s keys. Their phone sends them once it trusts this one: if you have just checked each other, that is the next time it opens the names list; if not, meet them and check each other’s phones.`),
    /** Holders whose phones don't trust this one (the reviewer's :851, design Addendum 4): a check comes first. */
    holdersNoTrust: (holders: string[]) => (holders.length > 1
        ? `${either(holders)} hold the list’s keys, but their phones don’t trust this one yet: meet one of them and check each other’s phones.`
        : `${at(holders[0] ?? '')} holds the list’s keys, but their phone doesn’t trust this one yet: meet ${at(holders[0] ?? '')} and check each other’s phones.`),
    // Design Addendum 4 (§4), exact.
    /** `removedAny`: this phone stands by a removal (round 12, J10: otherwise it makes no new key, and the words don't say so). */
    followFromHere: (n: number, removedAny = true) => `If none of them can be reached, follow the server’s history: this phone takes key ${n} for its place only, `
        + (removedAny ? 'with no new trust and no new key, and before it writes it makes a new key without any admin it had removed.' : 'with no new trust and no new key.'),
    refusedRemoved: (n: number, who: string) => `The list’s key number ${n} was made by ${at(who)}, and this phone had removed ${at(who)}’s key; `
        + `the server’s history hasn’t. Nothing was read or written. Check ${at(who)}’s phone in person only if ${at(who)} is an admin again: `
        + `this phone then trusts them again. Or check an admin whose phone already opens the list: this phone then takes key ${n} for its `
        + `place only and makes a new key without ${at(who)} before it writes. If none of them can be reached, follow the server’s history: `
        + 'the same, without a meeting.',
    refusedRemovedGone: (n: number, who: string) => `The list’s key number ${n} was made by ${at(who)}, who is no longer an admin, and this `
        + `phone had removed ${at(who)}’s key. Nothing was read or written. Check an admin whose phone already opens the list, or follow `
        + `the server’s history: either way this phone takes key ${n} for its place only and makes a new key without ${at(who)} before it writes.`,
    waitRemovedHolder: (who: string[], n: number) => (who.length > 1
        ? `The server says ${both(who)} hold key ${n}, and this phone had removed their keys. Nobody else can make a new key until an `
            + 'owner removes them or moves their accounts to new keys.'
        : `The server says ${at(who[0] ?? '')} holds key ${n}, and this phone had removed ${at(who[0] ?? '')}’s key. `
            + `Nobody else can make a new key until an owner removes ${at(who[0] ?? '')} or moves their account to a new key.`),
    askForShare: (who: string) => `The server says ${at(who)} holds the current key, so only their phone can make the next one. Ask `
        + `${at(who)} to open the names list; if their phone is lost, have an owner remove them.`,
    lostEntries: (n: number) => (n === 1
        ? '1 entry this phone saw isn’t on the server now, and no admin deleted it. '
        : `${n} entries this phone saw aren’t on the server now, and no admin deleted them. `)
        + 'A server put back to an older copy does that. Whoever runs the server may still have them on the other copy and can put '
        + 'them back; the phones still hold their keys. Otherwise type them again from your paper copy.',
    waitNewKey: (holders: string[]) => (holders.length
        ? `The list needs a new key before anything more is written. ${either(holders)} will make it the next time they open the names list.`
        : 'The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Meet an admin who does and check each other’s phones.'),
    /**
     * The wait when the new key is this phone's own drop (a removal by hand, or one on a key history it has left): the
     * holder only sends the current key; this phone then makes the new one (round 7).
     */
    waitOwnKey: (holders: string[], own: string[]) => (holders.length
        ? `The list needs a new key without ${both(own)} before anything more is written. This phone makes it once it holds the list’s `
            + `current key: ${either(holders)} will send that the next time they open the names list.`
        : 'The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Meet an admin who does and check each other’s phones.'),
    nobodyHoldsKey: (n: number, count: number, maker: string) => `Nobody who is an admin now holds key ${n}. You can make a new key; the `
        + `${count} ${count === 1 ? 'name sealed under it stays' : 'names sealed under it stay'} locked unless ${at(maker)}’s phone is found.`,
    droppedMe: (who: string) => `${at(who)} made a key without this phone. This phone still trusts them; ask them why, and tell your other admins if you didn’t expect it.`,
    differentKeys: (n: number) => `Two admins sent different keys for key ${n}: tell your admins. This phone kept the first one.`,
    otherHistory: (who: string) => `${at(who)}’s phone is on a different key history: meet ${at(who)}.`,
    newKeyBy: (maker: string, who: string[]) => `${at(maker)} made the list a new key without ${both(who)}.`,
    tooMany: 'The server sent more of the list’s history than this phone reads. Ask whoever runs the server.',
    lostSinceCopy: (count: number) => `${count} ${count === 1 ? 'entry this phone saw is' : 'entries this phone saw are'} gone from the server: restore them from the paper copy.`,
    notReady: 'This phone can’t write to the list right now. Open it again.',
    /** A removal this phone stands by isn't carried by a key of its own yet (round 13): nothing is written. */
    stillRemoving: (who: string[]) => `This phone is still removing ${who.length > 1 ? `the old keys of ${both(who)}` : `${at(who[0] ?? '')}’s old key`}. `
        + 'Connect and open the names list again before adding or changing a name.',
    /** While a reload runs with the list on screen. */
    reloading: 'Opening the list again…',
    openAgainButton: 'Open the list again',
    checkFirst: (who: string) => `Check ${at(who)}’s phone in person first: the server’s word that a key is ${at(who)}’s isn’t enough.`,
    toCheck: (who: string) => `${at(who)} is an admin, and this phone hasn’t checked their phone. Meet them and check each other’s phones: then this phone sends them the keys.`,
    notShownToMembers: 'Members don’t see these names. Showing real names to members isn’t available yet.',
    // Buttons and titles.
    checkEachOtherTitle: 'Check each other',
    checkButton: (who: string) => `Check ${at(who)} in person`,
    checkSomeone: 'Check an admin in person',
    removeKeyButton: (who: string) => `Remove ${at(who)}’s old key`,
    removeKeyTitle: (who: string) => `Remove ${at(who)}’s old key?`,
    putBackButton: 'Put the key history back',
    putBackTitle: 'Put the key history back?',
    startAgainButton: 'Start again',
    startAgainTitle: 'Start the list again?',
    makeNewButton: 'Make a new key',
    makeNewTitle: 'Make a new key?',
    followButton: 'Follow the server’s history',
    followTitle: 'Follow the server’s history?',
    /** The Follow question when no removal of this phone's will stand after it (round 14, J10): no key of its own follows. */
    followNone: 'This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with '
        + 'them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to them.',
    follow: 'This phone follows the key history the server shows, from the last key both share. It keeps the keys it holds, reads with '
        + 'them and passes them on to the admins it trusts, but never writes under them again unless the server’s history comes back to '
        + 'them. An admin this phone had removed stays removed: before it writes, it makes a key without them.',
    sendAgainButton: (who: string) => `Send the keys to ${at(who)} again`,
    myKeyTitle: 'Your phone’s key',
    myKey: 'The other admin scans this QR code, or compares the 20 digits with what their phone shows. Show it only to someone you’re with.',
    myCode: (code: string) => `Your code: ${code}`,
    showMyKey: 'Show my phone’s key',
    hideMyKey: 'Hide my phone’s key',
    scanButton: 'Scan their QR code',
    stopScan: 'Stop scanning',
    cameraNeeded: 'To scan their code, allow the camera. You can type the code instead.',
    codeLabel: 'THEIR CODE (20 DIGITS)',
    compareButton: 'Compare',
    unreadable: 'That isn’t a phone key code. Scan the QR code on their names list, or type the 20 digits shown under it.',
    codeMismatch: (who: string) => `Those digits aren’t ${at(who)}’s key as the server lists it. Nothing was trusted. Scan their QR code instead, and tell your other admins.`,
    noMatch: 'Those digits aren’t the key of any admin the server lists. Scan their QR code instead.',
    self: 'That is this phone’s own key.',
    /** A check whose pin couldn't be read or kept (round 15): nothing was saved, and what the phone kept is unchanged. */
    checkNotKept: 'This phone couldn’t read or keep its names list’s keys just now, so the check wasn’t saved. Nothing else changed. Try the check again.',
    matched: (who: string) => `Checked: this phone now trusts ${at(who)}’s phone.`,
    exportTitle: 'Export the list as a PDF?',
    export: 'The PDF holds every name you can open here. Once it leaves this phone it’s yours to keep safe, like a paper list. '
        + 'The other admins can see that you exported it, and when.',
    deleteConfirmed: 'A member is confirmed against this entry. Revoke the confirmation first.',
    removedConfirmTitle: 'Revoke this confirmation?',
    twoAdminsLabel: 'Two admins confirm each member',
    twoAdminsHelp: 'A confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. '
        + 'Where nobody else could (an admin confirmed in a community of two admins), one admin is enough.',
} as const;

/** The removals that would still stand after following the server's history: removals by hand, and drops off its path. */
function removalsAfterFollow(pin: NamesPin, state: Pick<NamesState, 'communityId' | 'generations' | 'shares' | 'current'>): string[] {
    const parents = new Map<string, string | null>();
    for (const g of checkedRecords(state).gens.values()) parents.set(g.id, g.parentId);
    const onPath = new Set<string>();
    for (let at: string | null = state.current?.id ?? null; at && parents.has(at) && !onPath.has(at);) { onPath.add(at); at = parents.get(at) ?? null; }
    return [...new Set([...(pin.manualDrops ?? []), ...Object.entries(pin.dropped ?? {}).filter(([, id]) => !onPath.has(id)).map(([k]) => k)])];
}

/** Whether following the server's history leads to a key of this phone's own (a removal will still stand): the card and the question agree. */
export function followRemovesAny(o: Pick<NamesOpened, 'pin' | 'state'>): boolean {
    return removalsAfterFollow(o.pin, o.state).length > 0;
}

/** The plan, in words, for the screen's top card: the refusal or the wait. Null when ready. */
export function planWords(o: Pick<NamesOpened, 'plan' | 'state' | 'pin'> & Partial<Pick<NamesOpened, 'justChecked'>>): string | null {
    const { plan, state } = o;
    const name = (k: string) => callsignIn(state, k);
    // Whether a removal this phone stands by will still stand after a follow: only then does a new key of its own follow
    // (J10, round 13). A drop whose statement is on the server's path stays on the chain after a follow.
    const removedAny = removalsAfterFollow(o.pin, state).length > 0;
    if (plan.kind === 'ready' || plan.kind === 'make_first' || plan.kind === 'make_new') return null;
    if (plan.kind === 'wait') {
        if (plan.canMakeNew) {
            const maker = o.pin.chain.length ? readNamesGeneration(o.pin.chain[o.pin.chain.length - 1], undefined, new Set([plan.keyId]))?.maker ?? '' : '';
            return NAMES_COPY.nobodyHoldsKey(plan.n, state.counts?.byKey?.[plan.keyId] ?? 0, name(maker));
        }
        if (!plan.holders.length) {
            // Nobody this phone trusts holds it, and someone the server says holds it is an admin this phone removed: only an
            // owner can unblock it (design Addendum 4).
            const others = (state.admins ?? []).filter((a) => a.pubkey.toLowerCase() !== o.pin.me && (a.keyIds ?? []).includes(plan.keyId));
            if (others.length && others.every((a) => a.pubkey.toLowerCase() in o.pin.dropped || o.pin.manualDrops.includes(a.pubkey.toLowerCase()))) {
                return NAMES_COPY.waitRemovedHolder(others.map((a) => a.callsign), plan.n);
            }
        }
        // "Will send" only for holders whose phones trust this one; one checked here but not yet heard from gets both ways;
        // the rest get the meeting words (round 9, Addendum 4, round 12).
        const sending = holdersWhoWillSend(state, o.pin.me, plan.holders);
        const checked = holdersCheckedHere(state, o.pin.me, plan.holders.filter((k) => !sending.includes(k)), o.justChecked ?? []);
        const noTrust = plan.holders.filter((k) => !sending.includes(k) && !checked.includes(k)).map(name);
        const restWords = [checked.length ? NAMES_COPY.holdersJustChecked(checked.map(name)) : '', noTrust.length ? NAMES_COPY.holdersNoTrust(noTrust) : ''].filter((w) => w).join(' ');
        if (!sending.length && restWords) return restWords;
        const holders = sending.map(name);
        const rest = restWords ? ` ${restWords}` : '';
        if (!plan.newKeyNeeded) return NAMES_COPY.wait(holders) + rest;
        // This phone's own drops (by hand, or standing from a history it left): the holder only sends the key.
        const chainIds = new Set(o.pin.chain.map((l) => l.id));
        const own = plan.drops.filter((k) => o.pin.manualDrops.includes(k) || (k in o.pin.dropped && !chainIds.has(o.pin.dropped[k])));
        return (own.length ? NAMES_COPY.waitOwnKey(holders, own.map(name)) : NAMES_COPY.waitNewKey(holders)) + rest;
    }
    switch (plan.reason) {
        case 'other_community': return NAMES_COPY.otherCommunity;
        case 'missing_record': return NAMES_COPY.missingRecord;
        case 'different_history': return removedAny ? NAMES_COPY.refusedDifferent : NAMES_COPY.refusedDifferentNone;
        case 'rolled_back': return NAMES_COPY.refusedRolledBack(plan.offered?.n ?? 0, plan.newest?.n ?? 0);
        case 'untrusted_maker': {
            const n = plan.n ?? 0;
            const who = name(plan.maker ?? '');
            if (o.pin.chain.length === 0) {
                return plan.canStartAgain ? `${NAMES_COPY.refusedUntrusted(n, who)}\n\n${NAMES_COPY.startAgain(state.counts?.entries ?? 0)}` : NAMES_COPY.refusedUntrusted(n, who);
            }
            // Addendum 4: a maker this phone had removed on a history it left, and Follow from here.
            if (plan.standing) return plan.canCheck ? NAMES_COPY.refusedRemoved(n, who) : NAMES_COPY.refusedRemovedGone(n, who);
            return plan.canFollow ? `${NAMES_COPY.refusedUntrusted(n, who)}\n\n${NAMES_COPY.followFromHere(n, removedAny)}` : NAMES_COPY.refusedUntrusted(n, who);
        }
    }
}
