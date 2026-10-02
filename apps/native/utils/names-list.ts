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
    sealNamesPinBlob, openNamesPinBlob, namesStatementId, followNamesServer, namesListKeyCode, readNamesShare,
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

/** A signed request to the member's own community. Never throws: a failure is an answer. */
async function call<T>(anchorUrl: string, identity: BeanPoolIdentity, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<NamesResult<T>> {
    try {
        const url = `${anchorUrl.replace(/\/+$/, '')}${path}`;
        const raw = method === 'GET' || method === 'DELETE' ? '' : JSON.stringify(body ?? {});
        const headers = await buildSignedHeaders(method, url, raw, identity.privateKey, identity.publicKey);
        if (method === 'GET' || method === 'DELETE') delete headers['Content-Type'];
        const res = await fetch(url, { method, headers: { Accept: 'application/json', ...headers }, ...(raw ? { body: raw } : {}) });
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

export const fetchNamesState = (anchor: string, id: BeanPoolIdentity) => call<NamesState>(anchor, id, 'GET', `${NAMES_PATH}/state`);
/** Every entry, sealed, and every confirmation. The node logs it as a read, or, for an export, as an export. */
export const fetchNamesList = (anchor: string, id: BeanPoolIdentity, forExport = false) =>
    call<NamesListBody>(anchor, id, 'GET', `${NAMES_PATH}/entries${forExport ? '?for=export' : ''}`);
export const fetchNamesLog = (anchor: string, id: BeanPoolIdentity, limit = 50) =>
    call<{ log: NamesLogLine[]; total: number }>(anchor, id, 'GET', `${NAMES_PATH}/log?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`);
export const confirmMember = (anchor: string, id: BeanPoolIdentity, memberPubkey: string, entryId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations`, { memberPubkey, entryId });
export const secondConfirmation = (anchor: string, id: BeanPoolIdentity, confirmationId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations/${encodeURIComponent(confirmationId)}/second`, {});
export const revokeConfirmation = (anchor: string, id: BeanPoolIdentity, confirmationId: string) =>
    call<{ id: string; status: ConfirmationStatus }>(anchor, id, 'POST', `${NAMES_PATH}/confirmations/${encodeURIComponent(confirmationId)}/revoke`, {});
export const deleteNamesEntry = (anchor: string, id: BeanPoolIdentity, entryId: string) =>
    call<{ id: string }>(anchor, id, 'DELETE', `${NAMES_PATH}/entries/${encodeURIComponent(entryId)}`);
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

/** This phone's pin for the community, or null: none kept, or one that doesn't open (then it starts from an empty pin). */
export async function readNamesPinFrom(store: NamesPinStore, publicKey: string, anchor: string): Promise<NamesPin | null> {
    try {
        const label = namesTrustStoreKey(publicKey, anchor);
        const blob = await store.getItem(label);
        if (!blob) return null;
        const secret = await store.getSecret(namesPinSecretName(label));
        if (!secret || !/^[0-9a-f]{64}$/.test(secret)) return null;
        const json = openNamesPinBlob(blob, fromHex(secret), label);
        return json ? readNamesPin(JSON.parse(json), publicKey) : null;
    } catch {
        return null;
    }
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
    | { ok: false; reason: 'unreadable' | 'mismatch' | 'self' | 'no_match' };

/**
 * "Check each other" (design §3.3): what was scanned (a QR code: the other phone's key) or typed (its 20 digits). A QR
 * code pins the key it shows, even when it isn't the one the server lists for `picked` (then `mismatch`, said loudly:
 * nothing is sent to the server's key, and nothing to the scanned one unless the server lists it as an admin). A typed
 * code can only be compared: with `picked`'s key, or with each admin the server lists; a mismatch pins nothing.
 */
export async function checkEachOther(
    store: NamesPinStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, state: Pick<NamesState, 'communityId' | 'admins'>,
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
    const pin = await readNamesPinFrom(store, identity.publicKey, anchor);
    const base = pin && pin.communityId === state.communityId ? pin : emptyNamesPin(state.communityId, identity.publicKey);
    if (!(await writeNamesPinTo(store, identity.publicKey, anchor, checkNamesKeyInPerson(base, key)))) return { ok: false, reason: 'unreadable' };
    return { ok: true, pinned: key, mismatch };
}

/** "Remove @X's old key" (asked first): the next open makes a new key without it. */
export async function removeOldKey(store: NamesPinStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, key: string): Promise<boolean> {
    const pin = await readNamesPinFrom(store, identity.publicKey, anchor);
    if (!pin) return false;
    return writeNamesPinTo(store, identity.publicKey, anchor, removeNamesKey(pin, key));
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
    /** The keys this open made a new generation without, if it made one. */
    made: string[] | null;
    /** Whom this open sent the keys to. */
    sentTo: string[];
    /** Admins the node lists whose phones this phone hasn't checked: "Check @X in person" (never a share on a callsign). */
    toCheck: NamesAdminRow[];
    /** Rolled back: how many entries this phone last saw that the node no longer has. */
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

async function look(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore): Promise<NamesResult<Synced & { kept: boolean }>> {
    const s = await fetchNamesState(anchor, identity);
    if (!s.ok) return s;
    const pin = await readNamesPinFrom(store, identity.publicKey, anchor);
    const r = syncNames({ pin, state: s.value, me: identity });
    if (r.plan.kind === 'refused' && r.plan.reason === 'other_community') {
        return { ok: true, value: { state: s.value, pin: r.pin, plan: r.plan, notices: r.notices, generations: r.generations, kept: true } };
    }
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

async function makeAndSend(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, synced: Pick<Synced, 'pin'>, drops: string[]): Promise<NamesResult<true>> {
    const made = makeNamesGenerationFor(synced.pin, identity, drops);
    if (!(await writeNamesPinTo(store, identity.publicKey, anchor, made.pin))) return NOT_KEPT;
    return sendGeneration(anchor, identity, store, made.pin, made.generation);
}

/**
 * What the screen does on opening (design §4): the node's state; the sync from this phone's pin (kept again); a
 * generation the plan makes without asking (the first, or a new one without an admin who left or was removed here), or
 * this phone's own that never landed, sent again; the keys sent to every admin this phone trusts that lacks one; then,
 * only when the plan is ready, the list. A refusal stops before anything is read or written.
 */
export async function openNamesList(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    let l = await look(anchor, identity, store);
    if (!l.ok) return l;
    if (!l.value.kept) return NOT_KEPT;
    const notices: NamesNotice[] = [...l.value.notices];
    let made: string[] | null = null;
    let carried: string[] = [];
    let madeN = 0;
    const pend = l.value.pin.pending;
    const cur = l.value.state.current?.id ?? '-';
    if (pend && pend.statement.split('\n')[3] === cur && !(l.value.plan.kind === 'refused' && l.value.plan.reason === 'other_community')) {
        // Ours, never landed, and the node is still where it was: the same statement again (never a second key).
        const sent = await sendGeneration(anchor, identity, store, l.value.pin, pend);
        if (!sent.ok && sent.status === 0) return sent;
        l = await look(anchor, identity, store);
        if (!l.ok) return l;
        notices.push(...l.value.notices);
    } else if (l.value.plan.kind === 'make_first' || l.value.plan.kind === 'make_new') {
        const drops = l.value.plan.kind === 'make_new' ? l.value.plan.drops : [];
        // Drops this phone stands by that the history it took hadn't made (their statement is abandoned).
        const before = l.value.pin;
        madeN = (before.chain[before.chain.length - 1]?.n ?? 0) + 1;
        const chainIds = new Set(before.chain.map((x) => x.id));
        carried = drops.filter((k) => k in before.dropped && !chainIds.has(before.dropped[k]));
        const sent = await makeAndSend(anchor, identity, store, l.value, drops);
        if (!sent.ok && (sent.status === 0 || sent.code === 'not_kept')) return sent;
        if (sent.ok && l.value.plan.kind === 'make_new') made = drops;
        l = await look(anchor, identity, store);
        if (!l.ok) return l;
        notices.push(...l.value.notices);
    }
    const { state, pin, plan, generations } = l.value;
    const sentTo: string[] = [];
    let list: NamesListBody | null = null;
    let kept = pin;
    const due: string[] = [];
    if (plan.kind === 'ready') {
        for (const share of namesSharesToSend(pin, state, identity)) {
            due.push(share.to);
            const done = await postShare(anchor, identity, share);
            if (done.ok) sentTo.push(share.to);
        }
        const got = await fetchNamesList(anchor, identity);
        if (!got.ok) return got;
        list = got.value;
        kept = { ...pin, lastCount: list.entries.length };
        await writeNamesPinTo(store, identity.publicKey, anchor, kept);
    }
    const words = noticeWords(notices, state);
    if (made && made.length) {
        // "No longer an admin" only for keys the node no longer lists; a key removed by hand gets the Remove words. "Has
        // sent" only for the admins the key reached; the rest get it on the next open.
        const listed = new Set(state.admins.map((a) => a.pubkey.toLowerCase()));
        const rest = made.filter((k) => !carried.includes(k));
        const gone = rest.filter((k) => !listed.has(k)).map((k) => callsignIn(state, k));
        const byHand = rest.filter((k) => listed.has(k)).map((k) => callsignIn(state, k));
        const sending = NAMES_COPY.newKeySent(sentTo.map((k) => callsignIn(state, k)), due.filter((k) => !sentTo.includes(k)).map((k) => callsignIn(state, k)));
        words.unshift(...[
            carried.length ? NAMES_COPY.newKeyCarried(carried.map((k) => callsignIn(state, k))) : '',
            gone.length ? NAMES_COPY.newKeyMade(gone) : '', byHand.length ? NAMES_COPY.newKeyRemoved(byHand) : '', sending,
            // A carried drop of an admin the server lists: if they are an admin again, check each other again (J3).
            ...carried.filter((k) => listed.has(k)).map((k) => NAMES_COPY.checkAgain(callsignIn(state, k), madeN)),
        ].filter((w) => w));
    }
    if (plan.kind === 'refused' && plan.reason === 'rolled_back') {
        const lost = Math.max(0, pin.lastCount - (state.counts?.entries ?? 0));
        if (lost) words.push(NAMES_COPY.lostSinceCopy(lost));
    }
    return {
        ok: true,
        value: {
            state, plan, pin: kept, ring: namesRingKeys(kept), generations, list, notices: words, made, sentTo,
            toCheck: state.admins.filter((a) => a.pubkey !== identity.publicKey && !kept.trusted.includes(a.pubkey)),
            lost: plan.kind === 'refused' && plan.reason === 'rolled_back' ? Math.max(0, pin.lastCount - (state.counts?.entries ?? 0)) : 0,
        },
    };
}

// ── The asked actions ────────────────────────────────────────────────────────────────────────

/**
 * A new key on this phone, asked first: "Start again" on an empty history when nobody holds the current key, or a new key
 * off this phone's head when nobody who is an admin holds the head's key (what was sealed under it stays locked). Starting
 * again (design addendum (c)) first takes the node's whole key history onto this phone's, for its drops and its place only
 * (no trust, no key), and saves it; then it is the same new key off the head. Then the list opens again.
 */
export async function makeKeyOnThisPhone(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
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
    if (!sent.ok) return sent;
    return openNamesList(anchor, identity, store);
}

/**
 * "Put the key history back" (asked first, design §4.3.6): every statement this phone took after the node's current
 * one, sent again in order (one it has already is fine), then the open sends the keys again.
 */
export async function putHistoryBack(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    const l = await look(anchor, identity, store);
    if (!l.ok) return l;
    if (!(l.value.plan.kind === 'refused' && l.value.plan.reason === 'rolled_back')) return openNamesList(anchor, identity, store);
    for (const link of namesReplay(l.value.pin, l.value.state)) {
        const sent = await postGeneration(anchor, identity, link, true);
        if (!sent.ok) return sent;
    }
    return openNamesList(anchor, identity, store);
}

/**
 * "Follow the server's history" (asked first; design Addendum 3): offered on a different history whose server path is
 * whole (`canFollow`). This phone's chain goes back to the last statement it shares with the server's, and the rest of
 * the server's path is taken for its drops and its place only: every signature checked, no trust, no key, no check in
 * person needed. The words say whom it stopped trusting. Then the list opens again: before this phone writes, it makes
 * a key without every admin it had removed that the followed history hadn't.
 */
export async function followServerHistory(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore = DEVICE_NAMES_STORE): Promise<NamesResult<NamesOpened>> {
    const l = await look(anchor, identity, store);
    if (!l.ok) return l;
    const { plan, state } = l.value;
    if (!(plan.kind === 'refused' && plan.reason === 'different_history' && plan.canFollow)) {
        return { ok: false, status: 0, code: 'no_plan', message: 'There is no key history to follow here.' };
    }
    const followed = followNamesServer(l.value.pin, state);
    if (!(await writeNamesPinTo(store, identity.publicKey, anchor, followed.pin))) return NOT_KEPT;
    const listed = new Set(state.admins.map((a) => a.pubkey.toLowerCase()));
    const said = followed.dropped.map((d) => (listed.has(d.key)
        ? NAMES_COPY.checkAgain(callsignIn(state, d.key), d.n)
        : NAMES_COPY.newKeyBy(callsignIn(state, d.maker), [callsignIn(state, d.key)])));
    const opened = await openNamesList(anchor, identity, store);
    if (!opened.ok) return opened;
    return { ok: true, value: { ...opened.value, notices: [...new Set([...said, ...opened.value.notices])] } };
}

/** "Send the keys to @X again": the same share the open sends, now, to one admin this phone trusts. */
export async function sendKeysAgain(anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, to: string): Promise<NamesResult<{ to: string }>> {
    const l = await look(anchor, identity, store);
    if (!l.ok) return l;
    if (l.value.plan.kind !== 'ready') return { ok: false, status: 0, code: 'no_plan', message: NAMES_COPY.notReady };
    const share = namesSharesToSend(l.value.pin, l.value.state, identity, to)[0];
    if (!share) return { ok: false, status: 0, code: 'check_in_person', message: NAMES_COPY.checkFirst(callsignIn(l.value.state, to.toLowerCase())) };
    return postShare(anchor, identity, share);
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
    /** The live confirmation against it (confirmed or waiting for a second admin), if any. */
    confirmation: ConfirmationRow | null;
}

/**
 * Of `holders` (keys), the ones whose phones still trust this one, so will send it the keys on their next open (round 9):
 * the holder's newest share header (each is public) names this phone, and no statement on the server's path after that
 * header's head dropped it. Trust isn't mutual: a holder whose phone dropped this key sends nothing until a check.
 */
export function holdersWhoWillSend(state: Pick<NamesState, 'communityId' | 'generations' | 'shares' | 'current'>, me: string, holders: string[]): string[] {
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
    const mine = me.toLowerCase();
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

/** Every entry, opened where this phone can; open ones by name, then the locked ones. */
export function openEntries(list: NamesListBody, opened: Pick<NamesOpened, 'ring' | 'pin' | 'generations' | 'state'>): OpenedEntry[] {
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
        const holders = all.filter((a) => sending.has(a.pubkey)).map((a) => a.callsign);
        const notTrusting = all.filter((a) => !sending.has(a.pubkey)).map((a) => a.callsign);
        return {
            id: e.id, keyId: e.keyId, createdAt: e.createdAt, updatedAt: e.updatedAt, text, locked,
            key: text ? null : namesKeyLabel(opened.pin, opened.generations, e.keyId), holders, notTrusting, confirmation: live.get(e.id) ?? null,
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
 * Writes an entry (rule 4): only when the plan is ready, sealed under this phone's head key. `entryId` is an edit's;
 * `addId` a new entry's, chosen when its form opened ({@link newEntryId}), so a Save after a lost answer sends the same
 * id and the node answers `entry_exists`, which is done: never a second entry. When the node's current moved on (409
 * `stale_key`) the list is opened again and, if ready, sealed under the new head and sent once more.
 */
export async function saveNamesEntry(
    anchor: string, identity: BeanPoolIdentity, store: NamesPinStore, opened: Pick<NamesOpened, 'plan' | 'pin' | 'ring'>, text: { name: string; note: string },
    entryId?: string, addId?: string,
): Promise<NamesResult<{ id: string; keyId: string; ciphertext: string; opened: NamesOpened | null }>> {
    // One id for every try: an add that landed but whose answer was lost comes back `entry_exists`.
    const id = entryId ?? addId ?? newNamesEntryId();
    const attempt = async (o: Pick<NamesOpened, 'plan' | 'pin' | 'ring'>) => {
        const head = o.pin.chain[o.pin.chain.length - 1];
        if (o.plan.kind !== 'ready' || !head || !o.ring[head.id]) return { ok: false as const, status: 0, code: 'not_ready', message: NAMES_COPY.notReady };
        const sealed = sealedFor(o.ring[head.id], head.id, text, id);
        if (!sealed.ok) return { ok: false as const, status: 0, code: 'bad_text', message: sealed.error };
        const sent = entryId ? await editNamesEntry(anchor, identity, head.id, sealed) : await addNamesEntry(anchor, identity, head.id, sealed);
        if (!sent.ok && sent.code === 'entry_exists' && !entryId) return { ok: true as const, value: { id: sealed.id, keyId: head.id, ciphertext: sealed.ciphertext } };
        return sent.ok ? { ok: true as const, value: { id: sealed.id, keyId: head.id, ciphertext: sealed.ciphertext } } : sent;
    };
    const first = await attempt(opened);
    if (first.ok) return { ok: true, value: { ...first.value, opened: null } };
    if (first.code !== 'stale_key') return first;
    const again = await openNamesList(anchor, identity, store);
    if (!again.ok) return again;
    const second = await attempt(again.value);
    return second.ok ? { ok: true, value: { ...second.value, opened: again.value } } : second;
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
    newKeyCarried: (who: string[]) => `The list has a new key without ${both(who)}: this phone had removed their key, and the history it followed hadn’t.`,
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
    wait: (holders: string[]) => (holders.length
        ? `You don’t hold the list’s keys yet. ${either(holders)} will send them the next time they open the names list.`
        : 'Nobody this phone trusts holds the list’s keys. Meet an admin who does and check each other’s phones.'),
    lockedEntry: (n: number | null, who: string, holders: string[], notTrusting: string[] = []) => `${n === null ? 'Sealed with a key this phone has never seen.' : `Sealed with key ${n} (made by ${at(who)}).`} `
        + 'This phone doesn’t hold it. '
        + (holders.length
            ? `${either(holders)} ${holders.length > 1 ? 'hold' : 'holds'} it and will send it on their next open.`
            : notTrusting.length
            ? `${either(notTrusting)} ${notTrusting.length > 1 ? 'hold it, but their phones don’t trust this one yet: meet one of them' : 'holds it, but their phone doesn’t trust this one yet: meet them'} and check each other’s phones.`
            : 'Nobody who is an admin now holds it: type it again from your paper copy, or delete it.'),
    startAgain: (count: number) => 'Nobody who is an admin now holds the list’s keys. You can start a new key; the '
        + `${count} ${count === 1 ? 'entry' : 'entries'} written before stay locked until an admin who held a key comes back, or they are typed again from your paper copy.`,
    // The design's other words (§4, §7, §10), and the screen's.
    otherCommunity: 'The server says this list belongs to a different community from the one this phone opened before. Nothing was read or written.',
    missingRecord: 'The server is missing part of the list’s key history, so this phone can’t check the newest key. Nothing was read or written. '
        + 'Ask whoever runs the server, or an admin.',
    /** Holders whose phones don't trust this one (round 9): nothing comes until a check in person. */
    waitNotTrusted: (holders: string[]) => `${either(holders)} ${holders.length > 1
        ? 'hold the list’s keys, but their phones don’t trust this one yet: meet one of them'
        : 'holds the list’s keys, but their phone doesn’t trust this one yet: meet them'} and check each other’s phones.`,
    waitNewKey: (holders: string[]) => (holders.length
        ? `The list needs a new key before anything more is written. ${either(holders)} will make it the next time they open the names list.`
        : 'The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Meet an admin who does and check each other’s phones.'),
    /**
     * The wait when the new key is this phone's own drop (a removal by hand, or one the history it took hadn't made): the
     * holder only sends the current key; this phone then makes the new one (round 7).
     */
    waitOwnKey: (holders: string[], own: string[]) => (holders.length
        ? `The list needs a new key without ${both(own)} before anything more is written. This phone makes it once it holds the list’s `
            + `current key: ${either(holders)} will send that the next time they open the names list.`
        : 'The list needs a new key before anything more is written, and nobody this phone trusts holds the current one. Meet an admin who does and check each other’s phones.'),
    nobodyHoldsKey: (n: number, count: number, maker: string) => `Nobody who is an admin now holds key ${n}. You can make a new key; the `
        + `${count} ${count === 1 ? 'name' : 'names'} sealed under it stay locked unless ${at(maker)}’s phone is found.`,
    droppedMe: (who: string) => `${at(who)} made a key without this phone. This phone still trusts them; ask them why, and tell your other admins if you didn’t expect it.`,
    differentKeys: (n: number) => `Two admins sent different keys for key ${n}: tell your admins. This phone kept the first one.`,
    otherHistory: (who: string) => `${at(who)}’s phone is on a different key history: meet ${at(who)}.`,
    newKeyBy: (maker: string, who: string[]) => `${at(maker)} made the list a new key without ${both(who)}.`,
    tooMany: 'The server sent more of the list’s history than this phone reads. Ask whoever runs the server.',
    lostSinceCopy: (count: number) => `${count} ${count === 1 ? 'entry this phone saw is' : 'entries this phone saw are'} gone from the server: restore them from the paper copy.`,
    notReady: 'This phone can’t write to the list right now. Open it again.',
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

/** The plan, in words, for the screen's top card: the refusal or the wait. Null when ready. */
export function planWords(o: Pick<NamesOpened, 'plan' | 'state' | 'pin'>): string | null {
    const { plan, state } = o;
    const name = (k: string) => callsignIn(state, k);
    if (plan.kind === 'ready' || plan.kind === 'make_first' || plan.kind === 'make_new') return null;
    if (plan.kind === 'wait') {
        // "Will send" only for holders whose phones trust this one; otherwise a check in person comes first (round 9).
        const sending = holdersWhoWillSend(state, o.pin.me, plan.holders);
        const holders = sending.map(name);
        if (!plan.canMakeNew && !sending.length && plan.holders.length) return NAMES_COPY.waitNotTrusted(plan.holders.map(name));
        if (plan.canMakeNew) {
            const maker = o.pin.chain.length ? readNamesGeneration(o.pin.chain[o.pin.chain.length - 1], undefined, new Set([plan.keyId]))?.maker ?? '' : '';
            return NAMES_COPY.nobodyHoldsKey(plan.n, state.counts?.byKey?.[plan.keyId] ?? 0, name(maker));
        }
        if (!plan.newKeyNeeded) return NAMES_COPY.wait(holders);
        // This phone's own drops (by hand, or standing from a history it left): the holder only sends the key.
        const chainIds = new Set(o.pin.chain.map((l) => l.id));
        const own = plan.drops.filter((k) => o.pin.manualDrops.includes(k) || (k in o.pin.dropped && !chainIds.has(o.pin.dropped[k])));
        return own.length ? NAMES_COPY.waitOwnKey(holders, own.map(name)) : NAMES_COPY.waitNewKey(holders);
    }
    switch (plan.reason) {
        case 'other_community': return NAMES_COPY.otherCommunity;
        case 'missing_record': return NAMES_COPY.missingRecord;
        case 'different_history': return NAMES_COPY.refusedDifferent;
        case 'rolled_back': return NAMES_COPY.refusedRolledBack(plan.offered?.n ?? 0, plan.newest?.n ?? 0);
        case 'untrusted_maker':
            return plan.canStartAgain && o.pin.chain.length === 0
                ? `${NAMES_COPY.refusedUntrusted(plan.n ?? 0, name(plan.maker ?? ''))}\n\n${NAMES_COPY.startAgain(state.counts?.entries ?? 0)}`
                : NAMES_COPY.refusedUntrusted(plan.n ?? 0, name(plan.maker ?? ''));
    }
}
