/**
 * The names list, on an owner's or admin's phone (community modes slice 2; the server is apps/server/src/routes/
 * names-list.ts and engine/names-list.ts; the crypto is @beanpool/core names-list-crypto.ts).
 *
 * The community's admins keep a list of who its members are, by real name, and confirm a member against an entry. The
 * names are sealed on this phone before anything is sent: the node keeps scrambled text and the list's key wrapped to
 * each admin's own key, and only an admin's phone opens them. Everything here is signed with the member's own key.
 *
 * What this module decides, so the screen (app/names-list.tsx) only draws it:
 *   - whom this phone takes the key from ({@link traceFor}; @beanpool/core names-list-trust.ts): every wrap is signed by
 *     the admin who made it, and this phone keeps its own pinned set of trusted admin keys for the community (trust on
 *     first use, on this phone only: {@link readNamesTrust}). It uses a wrap only where a trusted key signed it, so a
 *     row whoever runs the server writes into its database opens nothing here, and a key the server makes an admin is
 *     trusted only once a trusted admin's signed share adds it. When it refuses one, it says so ({@link namesRefusal})
 *     and changes nothing: nothing is sealed under a key it can't trace (PR #1411's deciding review). The pin also
 *     remembers the newest generation it took and whom trusted admins dropped, and refuses a server put back to an
 *     older copy;
 *   - whom this phone gives the key to: only a key it trusts, never one the server names by a callsign alone (PR #1411's
 *     second deciding review: a re-key with the owner password put an admin's callsign on the operator's key). A key
 *     is trusted by an in-person check ({@link checkAdminInPerson}: the other admin's phone shows a QR code and a code,
 *     {@link myKeyCheck}), or by a trusted admin's signed share. When an admin's key changes (a re-key, a lost phone),
 *     this phone drops the old one and says so ({@link NamesOpened.keyChanged});
 *   - the key: open this admin's own accepted wraps; make the first key, or a new one after an admin goes, for this
 *     admin alone (every other admin then gets it by a Share tap: the phone never wraps the key to anyone because the
 *     node says so); start again when nobody here holds it; or say who to ask ({@link keyPlan});
 *   - the entries: open each with the key of its generation, or say why it can't be ({@link openEntries}); seal the older
 *     ones again under a new key this phone traced ({@link reEncryptBatches}); the whole opening, in order, is
 *     {@link openNamesList};
 *   - sharing: an admin made since waits until an admin who holds the key taps "Share" for them — never automatic, and
 *     offered only for a key this phone trusts ({@link waitingAdmins}, {@link shareKeyWith});
 *   - confirming: who can be confirmed ({@link confirmableMembers}), and the words for each confirmation;
 *   - the access log's lines, and the PDF's page ({@link namesListHtml}), made and shared on this phone.
 *
 * A confirmation is a fact about a member, never a tier, and in this version it gates nothing.
 */
import {
    NAMES_LIMITS, newNamesListKey, wrapNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId,
    normaliseNamesEntryText, signedNamesWrap, traceNamesTrust, readNamesTrustPin, verifyNamesWrap, emptyNamesTrustPin,
    namesKeyChanges, pinKeyChanges, pinCallsigns, pinCheckedKey, namesShareCheck, namesKeyCheckMatches, readNamesKeyCheck,
    namesKeyQr, namesKeyCode,
    type NamesEntryText, type WrappedNamesKey, type NamesKeyRecord, type NamesTrustPin, type NamesTrustTrace,
} from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
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

export interface NamesKeyWrap extends WrappedNamesKey {
    generation: number;
    wrappedBy: string;
    signature: string;
    drops: string[];
}

export interface NamesAdminRow {
    pubkey: string;
    callsign: string;
    role: 'owner' | 'admin';
    holdsKey: boolean;
}

export interface NamesState {
    /** The community's id, which every wrap's signature is bound to. */
    communityId: string;
    generation: number;
    newKeyNeeded: boolean;
    /** The holders dropped from the current generation: the maker of the next one names them, signed. */
    droppedHolders: string[];
    nobodyHoldsKey: boolean;
    myKeys: NamesKeyWrap[];
    /** Every wrap's signed header, which this phone walks to decide whom it trusts. */
    records: NamesKeyRecord[];
    admins: NamesAdminRow[];
    settings: { twoAdminsToConfirm: boolean; namesShownToMembers: boolean };
    counts: { entries: number; olderKey: number; locked: number; confirmed: number; awaitingSecond: number };
    me: { pubkey: string; role: 'owner' | 'admin' | null; owner: boolean };
}

export interface SealedEntryRow {
    id: string;
    ciphertext: string;
    keyGeneration: number;
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
    generation: number;
    entries: SealedEntryRow[];
    confirmations: ConfirmationRow[];
}

export type NamesAction = 'read' | 'export' | 'add' | 'edit' | 'delete' | 'confirm' | 'second' | 'revoke'
    | 'key_made' | 'key_changed' | 'key_shared' | 're_encrypt' | 'holder_dropped' | 'settings';

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

// ── Whom this phone trusts ───────────────────────────────────────────────────────────────────

/** What a pin is kept with: a small key-value store (AsyncStorage on the phone). */
export interface NamesTrustStore {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/**
 * Where this phone keeps its pin for one community: by this member's key and the community's address, both the phone's
 * own (never the server's word), so a server can't hand the phone an empty pin by naming another community.
 */
export function namesTrustStoreKey(publicKey: string, anchor: string): string {
    return `beanpool:names-trust:${publicKey.toLowerCase()}:${communityAddress(anchor) ?? anchor}`;
}

export async function readNamesTrust(store: NamesTrustStore, publicKey: string, anchor: string): Promise<NamesTrustPin | null> {
    try {
        const raw = await store.getItem(namesTrustStoreKey(publicKey, anchor));
        return raw ? readNamesTrustPin(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

async function writeNamesTrust(store: NamesTrustStore, publicKey: string, anchor: string, pin: NamesTrustPin): Promise<void> {
    try { await store.setItem(namesTrustStoreKey(publicKey, anchor), JSON.stringify(pin)); } catch { /* learnt again next time */ }
}

/** Adds this phone's own key to its pin (it made a key, so it trusts itself), keeping everything else the pin holds. */
async function pinSelf(store: NamesTrustStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, communityId: string): Promise<void> {
    const pin = await readNamesTrust(store, identity.publicKey, anchor);
    if (pin && pin.communityId !== communityId) return;
    const base = pin ?? emptyNamesTrustPin(communityId, identity.publicKey);
    await writeNamesTrust(store, identity.publicKey, anchor, { ...base, trusted: [...new Set([...base.trusted, identity.publicKey.toLowerCase()])].sort() });
}

/** The walk (@beanpool/core traceNamesTrust) over the node's state, from this phone's pin: the keys it may use. */
export function traceFor(state: NamesState, identity: Pick<BeanPoolIdentity, 'privateKey' | 'publicKey'>, pin: NamesTrustPin | null): NamesTrustTrace {
    return traceNamesTrust({
        communityId: state.communityId, me: { publicKey: identity.publicKey, privateKey: identity.privateKey }, pin,
        records: state.records ?? [], myKeys: state.myKeys ?? [], generation: state.generation,
    });
}

/** Why this phone won't use the list's current key, in a form the screen says plainly. */
export interface NamesRefusal {
    reason: 'other_community' | 'rolled_back' | 'unsigned' | 'untrusted';
    /** Who the key says made it (its signer, or whom the node names), and their callsign where they are an admin here. */
    maker: string | null;
    makerCallsign: string | null;
    /** The admin may check the maker in person and then trust them: a real signature, by a key that is an admin here. */
    canTrust: boolean;
    /**
     * `rolled_back` only: this phone holds the key the server now calls current, so it may make a new one past the newest it
     * took (for itself alone, asked first); the server's old key is used for nothing.
     */
    canMakeNew?: boolean;
    /** `rolled_back` only: the generation the server offers, and the newest this phone took. */
    offered?: number;
    newest?: number;
}

/**
 * Whether this phone refuses the list's current key, and why: the community isn't the one it pinned; the server offers
 * an older generation than this phone already took (put back to an older copy); its own wrap of the current key isn't
 * signed by a key it trusts; or, where it trusts anyone yet, no trusted admin made the current key.
 */
export function namesRefusal(state: NamesState, trace: NamesTrustTrace, hadPin: boolean, pin: NamesTrustPin | null = null): NamesRefusal | null {
    if (trace.otherCommunity) return { reason: 'other_community', maker: null, makerCallsign: null, canTrust: false };
    if (trace.rolledBack) {
        const iHold = state.generation > 0 && trace.keys.has(state.generation) && state.admins.some((a) => a.pubkey === state.me.pubkey && a.holdsKey);
        return {
            reason: 'rolled_back', maker: null, makerCallsign: null, canTrust: false,
            canMakeNew: iHold || state.generation === 0 || state.nobodyHoldsKey, offered: state.generation, newest: pin?.newest ?? trace.pin?.newest ?? 0,
        };
    }
    if (state.generation === 0) return null;
    const mine = trace.refused.find((r) => r.generation === state.generation && r.reason !== 'did_not_open');
    const hasBasis = hadPin || !!trace.pin;
    if (!mine && (!hasBasis || trace.currentTraced)) return null;
    let maker = mine?.wrappedBy ?? null;
    let signed = mine ? mine.reason === 'untrusted' : false;
    if (!mine) {
        const here = (state.records ?? []).filter((r) => r.generation === state.generation);
        const record = here.find((r) => r.holder === r.wrappedBy) ?? here[0];
        maker = record?.wrappedBy ?? null;
        signed = !!record && verifyNamesWrap({ ...record, communityId: state.communityId }, record.signature);
    }
    const admin = maker ? state.admins.find((a) => a.pubkey === maker) : undefined;
    return { reason: signed ? 'untrusted' : 'unsigned', maker, makerCallsign: admin?.callsign ?? null, canTrust: signed && !!admin };
}

// ── Checking a key in person ─────────────────────────────────────────────────────────────────

/** What this phone shows another admin to check it in person: its key as a QR code, and the same key as a code. */
export function myKeyCheck(identity: Pick<BeanPoolIdentity, 'publicKey'>): { qr: string; code: string } {
    return { qr: namesKeyQr(identity.publicKey), code: namesKeyCode(identity.publicKey) };
}

/** A key's code, to show beside a callsign (the admin this phone trusted on first use, say). */
export const keyCodeOf = (pubkey: string): string => namesKeyCode(pubkey);

export type InPersonCheck = { ok: true } | { ok: false; reason: 'unreadable' | 'mismatch' };

/** Whether what was scanned or typed is `pubkey`'s key, before anything is kept (the screen asks first where it must). */
export function inPersonResult(scannedOrTyped: string, pubkey: string): 'match' | 'unreadable' | 'mismatch' {
    if (!readNamesKeyCheck(scannedOrTyped)) return 'unreadable';
    return namesKeyCheckMatches(scannedOrTyped, pubkey) ? 'match' : 'mismatch';
}

/**
 * The admin checked `admin`'s key in person: they scanned the QR code on that admin's phone, or typed the code it shows.
 * Only if it is the key the server lists for that admin does this phone trust it (and so offer Share, or take a key they
 * made). A mismatch changes nothing: the server has put that admin's name on a key their phone doesn't hold.
 */
export async function checkAdminInPerson(
    store: NamesTrustStore, identity: Pick<BeanPoolIdentity, 'publicKey'>, anchor: string, state: NamesState,
    admin: Pick<NamesAdminRow, 'pubkey' | 'callsign'>, scannedOrTyped: string,
): Promise<InPersonCheck> {
    const result = inPersonResult(scannedOrTyped, admin.pubkey);
    if (result !== 'match') return { ok: false, reason: result };
    const pin = await readNamesTrust(store, identity.publicKey, anchor);
    if (pin && pin.communityId !== state.communityId) return { ok: false, reason: 'mismatch' };
    await writeNamesTrust(store, identity.publicKey, anchor, pinCheckedKey(pin ?? emptyNamesTrustPin(state.communityId, identity.publicKey), admin.pubkey, admin.callsign));
    return { ok: true };
}

// ── The key ──────────────────────────────────────────────────────────────────────────────────

export type KeyPlan =
    /** This phone holds the current key: open the list. */
    | { kind: 'ready' }
    /** The list has no key yet: this phone makes it, for this admin alone. */
    | { kind: 'make_first' }
    /**
     * An admin went: this phone makes the next key, for this admin alone. The others wait for a Share tap, as a new admin
     * does: who held the last key is the node's word, and a node that named its own key there must get nothing.
     */
    | { kind: 'make_new' }
    /** Nobody who is an admin now holds the key: a new one, and the entries sealed under the old one stay locked. Asks first. */
    | { kind: 'start_again' }
    /** Another admin holds the key (or must make the new one): ask them, and show them this phone's key to check. */
    | { kind: 'wait'; holders: NamesAdminRow[]; newKeyNeeded: boolean }
    /** This phone won't use the current key (see {@link namesRefusal}): nothing is read, sealed or sent under it. */
    | { kind: 'refused'; refusal: NamesRefusal };

/** What this phone does about the key, from the node's state and the walk over it. */
export function keyPlan(state: NamesState, myPubkey: string, trace: NamesTrustTrace, hadPin: boolean, pin: NamesTrustPin | null = null): KeyPlan {
    if (state.generation === 0 && !trace.otherCommunity && !trace.rolledBack) return { kind: 'make_first' };
    const refusal = namesRefusal(state, trace, hadPin, pin);
    if (refusal) return { kind: 'refused', refusal };
    if (state.nobodyHoldsKey) return { kind: 'start_again' };
    const holders = state.admins.filter((a) => a.holdsKey);
    const iHold = trace.keys.has(state.generation) && holders.some((h) => h.pubkey === myPubkey);
    if (state.newKeyNeeded) {
        return iHold ? { kind: 'make_new' } : { kind: 'wait', holders, newKeyNeeded: true };
    }
    return iHold ? { kind: 'ready' } : { kind: 'wait', holders, newKeyNeeded: false };
}

/**
 * Wraps `key` of `generation` to each admin in `holders`, each wrap signed by this admin for this community. `drops`
 * (only on this admin's own wrap of a new generation) names, signed, the admins dropped from the list.
 */
export function wrapsFor(
    key: Uint8Array, generation: number, holders: string[], signer: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>, communityId: string, drops: string[] = [],
): ({ holder: string; signature: string; drops: string[] } & WrappedNamesKey)[] {
    return holders.map((holder) => signedNamesWrap(wrapNamesListKey(key, holder, generation), {
        communityId, generation, holder, signer, drops: holder === signer.publicKey ? drops : [],
    }));
}

/**
 * Makes the key the plan asks for (not for `ready`, `wait` or a `refused` that offers no new key), wrapped to this admin
 * alone and signed, and sends it. It names, signed, the admins dropped from the current key, and every key this phone
 * knows was dropped or replaced (never itself: an admin who was the only holder and is an admin again starts a new key).
 * It is numbered past both the server's generation and the newest this phone took, so a phone never goes back. This
 * phone trusts its own key: its pin keeps this admin. The new key is kept for this screen only: the phone opens its own
 * wrap again from the node, as any other admin's does.
 */
export async function installKeyFor(
    anchor: string, identity: BeanPoolIdentity, state: NamesState, plan: KeyPlan, store: NamesTrustStore,
): Promise<NamesResult<{ generation: number; key: Uint8Array }>> {
    if (plan.kind === 'ready' || plan.kind === 'wait' || (plan.kind === 'refused' && !plan.refusal.canMakeNew)) {
        return { ok: false, status: 0, code: 'no_plan', message: 'Nothing to make.' };
    }
    const me = identity.publicKey.toLowerCase();
    const pin = await readNamesTrust(store, identity.publicKey, anchor);
    const known = pin && pin.communityId === state.communityId ? pin : null;
    const generation = Math.max(state.generation, known?.newest ?? 0) + 1;
    const key = newNamesListKey();
    const mustName = state.generation > 0 ? (state.droppedHolders ?? []) : [];
    const remembered = known ? [...Object.keys(known.dropped), ...Object.keys(known.replaced)] : [];
    const drops = [...new Set([...mustName, ...remembered].map((k) => k.toLowerCase()))].filter((k) => k !== me).slice(0, 50);
    const sent = await call<{ generation: number }>(anchor, identity, 'POST', `${NAMES_PATH}/key`, {
        generation, wraps: wrapsFor(key, generation, [identity.publicKey], identity, state.communityId, drops),
    });
    if (!sent.ok) return sent;
    await pinSelf(store, identity, anchor, state.communityId);
    return { ok: true, value: { generation, key } };
}

/**
 * An admin who doesn't hold the key yet (made since, or since a new key), and whether this phone may share with them:
 * `trusted`, a key this phone trusts (checked in person, here or by a trusted admin who shared with them); `changed`,
 * their name was on another key this phone trusted (a re-key, a lost phone, or whoever runs the server); `check`, a key
 * this phone hasn't checked. Share is offered for `trusted` only.
 */
export interface WaitingAdmin extends NamesAdminRow {
    check: 'trusted' | 'changed' | 'check';
}

/** The admins who don't hold the key yet, each with whether this phone may share with them now. */
export function waitingAdmins(state: NamesState, myPubkey: string, pin: NamesTrustPin | null): WaitingAdmin[] {
    if (state.generation === 0 || state.newKeyNeeded) return [];
    return state.admins.filter((a) => !a.holdsKey && a.pubkey !== myPubkey).map((a) => ({ ...a, check: namesShareCheck(pin, a) }));
}

/**
 * Shares the current key with one admin: a tap on this phone, after the screen asked. Only to a key this phone trusts
 * (its pin), never to whatever key the server puts behind a callsign: anything else sends nothing and says to check in
 * person first. The wrap is signed: it is this admin vouching for that one, so every phone that trusts this admin
 * trusts them too.
 */
export async function shareKeyWith(
    anchor: string, identity: BeanPoolIdentity, state: NamesState, key: Uint8Array, admin: Pick<NamesAdminRow, 'pubkey' | 'callsign'>, store: NamesTrustStore,
): Promise<NamesResult<{ shared: string[] }>> {
    const pin = await readNamesTrust(store, identity.publicKey, anchor);
    if (!pin || pin.communityId !== state.communityId || namesShareCheck(pin, admin) !== 'trusted') {
        return { ok: false, status: 0, code: 'check_in_person', message: NAMES_COPY.checkFirst(admin.callsign) };
    }
    return call<{ shared: string[] }>(anchor, identity, 'POST', `${NAMES_PATH}/key/share`, {
        generation: state.generation, wraps: wrapsFor(key, state.generation, [admin.pubkey], identity, state.communityId),
    });
}

// ── Entries ──────────────────────────────────────────────────────────────────────────────────

export interface OpenedEntry {
    id: string;
    generation: number;
    createdAt: string;
    updatedAt: string;
    /** The name and note, or null where this phone can't open it. */
    text: NamesEntryText | null;
    /** Why it can't be opened: no key of its generation on this phone, or the box didn't open (altered, or a wrong key). */
    locked: 'no_key' | 'did_not_open' | null;
    /** The live confirmation against it (confirmed or waiting for a second admin), if any. */
    confirmation: ConfirmationRow | null;
}

/** Every entry, opened where this phone can; open ones by name, then the locked ones. */
export function openEntries(list: NamesListBody, keys: Map<number, Uint8Array>): OpenedEntry[] {
    const live = new Map<string, ConfirmationRow>();
    for (const c of list.confirmations ?? []) if (c.status !== 'revoked') live.set(c.entryId, c);
    const out = (list.entries ?? []).map((e): OpenedEntry => {
        const key = keys.get(e.keyGeneration);
        let text: NamesEntryText | null = null;
        let locked: OpenedEntry['locked'] = key ? null : 'no_key';
        if (key) {
            try { text = openNamesEntry(key, e.id, e.keyGeneration, e.ciphertext); } catch { locked = 'did_not_open'; }
        }
        return { id: e.id, generation: e.keyGeneration, createdAt: e.createdAt, updatedAt: e.updatedAt, text, locked, confirmation: live.get(e.id) ?? null };
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

/** Seals a name and note under the current key, as a new entry or an edit of `entryId`. A problem in the text is said. */
export function sealedFor(key: Uint8Array, generation: number, text: { name: string; note: string }, entryId?: string):
    { ok: true; id: string; ciphertext: string } | { ok: false; error: string } {
    const checked = normaliseNamesEntryText(text);
    if (!checked.ok) return checked;
    const id = entryId ?? newNamesEntryId();
    return { ok: true, id, ciphertext: sealNamesEntry(key, id, generation, checked.value) };
}

export function addNamesEntry(anchor: string, identity: BeanPoolIdentity, generation: number, sealed: { id: string; ciphertext: string }) {
    return call<{ id: string }>(anchor, identity, 'POST', `${NAMES_PATH}/entries`, { id: sealed.id, ciphertext: sealed.ciphertext, keyGeneration: generation });
}

export function editNamesEntry(anchor: string, identity: BeanPoolIdentity, generation: number, sealed: { id: string; ciphertext: string }) {
    return call<{ id: string }>(anchor, identity, 'PUT', `${NAMES_PATH}/entries/${encodeURIComponent(sealed.id)}`, { ciphertext: sealed.ciphertext, keyGeneration: generation });
}

/**
 * After a new key: the older entries this phone can open, sealed again under the current one, in batches the node takes.
 * One that doesn't open is left as it is (another admin who holds its key can do it). `keys` are the walk's
 * ({@link traceFor}): without a traced key of `generation` there is nothing to seal under, and nothing is sealed.
 */
export function reEncryptBatches(list: NamesListBody, keys: Map<number, Uint8Array>, generation: number): { id: string; ciphertext: string }[][] {
    const current = keys.get(generation);
    if (!current) return [];
    const resealed: { id: string; ciphertext: string }[] = [];
    for (const e of list.entries ?? []) {
        if (e.keyGeneration >= generation) continue;
        const old = keys.get(e.keyGeneration);
        if (!old) continue;
        try {
            resealed.push({ id: e.id, ciphertext: sealNamesEntry(current, e.id, generation, openNamesEntry(old, e.id, e.keyGeneration, e.ciphertext)) });
        } catch { /* left for an admin who can open it */ }
    }
    const batches: { id: string; ciphertext: string }[][] = [];
    for (let i = 0; i < resealed.length; i += NAMES_LIMITS.batch) batches.push(resealed.slice(i, i + NAMES_LIMITS.batch));
    return batches;
}

export async function sendReEncrypted(anchor: string, identity: BeanPoolIdentity, generation: number, batches: { id: string; ciphertext: string }[][]): Promise<NamesResult<{ done: number }>> {
    let done = 0;
    for (const entries of batches) {
        const sent = await call<{ done: number; left: number }>(anchor, identity, 'POST', `${NAMES_PATH}/entries/re-encrypt`, { generation, entries });
        if (!sent.ok) return sent;
        done += sent.value.done;
    }
    return { ok: true, value: { done } };
}

// ── Opening the list, in order ───────────────────────────────────────────────────────────────

export interface NamesOpened {
    state: NamesState;
    plan: KeyPlan;
    /** The keys this phone may use: only wraps a trusted admin signed. */
    keys: Map<number, Uint8Array>;
    /** The list, where the plan is `ready`; null otherwise (nothing was read). */
    list: NamesListBody | null;
    /** A line to show: a key this phone made, or an admin it trusted for the first time (with their code). */
    notice: string | null;
    /** This phone's pin after opening: whom it trusts, for the screen's Share rows. */
    pin: NamesTrustPin | null;
    /** Admins whose key changed under their name since this phone last looked: it trusts neither key until checked. */
    keyChanged: string[];
}

/**
 * What the screen does on opening: the node's state; the walk from this phone's pin (kept again, with what it learnt); the
 * key the plan asks for, made and signed here; then, only with a key the walk accepted for the current generation, the
 * list, and the older entries sealed again under that key. A refusal stops before anything is read or sealed.
 */
export async function openNamesList(anchor: string, identity: BeanPoolIdentity, store: NamesTrustStore): Promise<NamesResult<NamesOpened>> {
    let s = await fetchNamesState(anchor, identity);
    if (!s.ok) return s;
    const keyChanged: string[] = [];
    const look = async (state: NamesState) => {
        let pin = await readNamesTrust(store, identity.publicKey, anchor);
        // An admin's callsign on a new key, and the key this phone trusted under it gone: trust neither until checked. The
        // old key counts only for this phone's own wraps up to the newest generation it took before now (the pin's, never
        // the server's number), and vouches for no one (PR #1411's third deciding review).
        if (pin && pin.communityId === state.communityId) {
            const changes = namesKeyChanges(pin, state.admins);
            if (changes.length) {
                pin = pinKeyChanges(pin, changes);
                await writeNamesTrust(store, identity.publicKey, anchor, pin);
                for (const c of changes) if (!keyChanged.includes(c.callsign)) keyChanged.push(c.callsign);
            }
        }
        const trace = traceFor(state, identity, pin);
        const kept = trace.pin ? pinCallsigns(trace.pin, state.admins) : null;
        if (kept) await writeNamesTrust(store, identity.publicKey, anchor, kept);
        return { trace, pin: kept ?? pin, plan: keyPlan(state, identity.publicKey, trace, !!pin, kept ?? pin) };
    };
    let { trace, plan, pin } = await look(s.value);
    const callsignOf = (pubkey: string) => s.ok ? (s.value.admins.find((a) => a.pubkey === pubkey)?.callsign ?? null) : null;
    let notice: string | null = trace.firstTrust ? NAMES_COPY.firstTrust(callsignOf(trace.firstTrust), keyCodeOf(trace.firstTrust)) : null;
    if (plan.kind === 'make_first' || plan.kind === 'make_new') {
        const was = plan.kind;
        const made = await installKeyFor(anchor, identity, s.value, plan, store);
        if (!made.ok) return made;
        s = await fetchNamesState(anchor, identity);
        if (!s.ok) return s;
        ({ trace, plan, pin } = await look(s.value));
        notice = was === 'make_new' ? NAMES_COPY.newKeyMade : notice;
    }
    if (keyChanged.length) notice = [notice, ...keyChanged.map((c) => NAMES_COPY.keyChanged(c))].filter(Boolean).join('\n\n');
    if (plan.kind !== 'ready') return { ok: true, value: { state: s.value, plan, keys: trace.keys, list: null, notice, pin, keyChanged } };
    const l = await fetchNamesList(anchor, identity);
    if (!l.ok) return l;
    let body = l.value;
    // After a new key, the older entries this phone can open go back sealed under it: a key the walk accepted, only.
    const batches = reEncryptBatches(body, trace.keys, s.value.generation);
    if (batches.length) {
        const sent = await sendReEncrypted(anchor, identity, s.value.generation, batches);
        if (sent.ok) {
            const again = await fetchNamesList(anchor, identity);
            if (again.ok) body = again.value;
        }
    }
    return { ok: true, value: { state: s.value, plan, keys: trace.keys, list: body, notice, pin, keyChanged } };
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
    key_made: 'made the list’s key',
    key_changed: 'made a new key',
    key_shared: 'shared the key with',
    re_encrypt: 'sealed older entries under the new key',
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

// ── Words ────────────────────────────────────────────────────────────────────────────────────

export const NAMES_COPY = {
    title: 'Names list',
    who: 'Only this community’s owners and admins can read these names, on their own phones. The community’s server keeps them scrambled, '
        + 'so a backup, a copy or a stolen database holds nothing readable. Whoever runs the server can put an admin’s name on a key of its own, '
        + 'so this phone shares the list only with a key you or an admin you trust checked in person. What it can’t protect: '
        + 'a check made with the wrong person, a phone someone else gets into, and the first key this phone took.',
    notShownToMembers: 'Members don’t see these names. Showing real names to members isn’t available yet.',
    makingKey: 'Setting up the list’s key on this phone…',
    newKeyMade: 'Someone stopped being an admin, so this phone made the list a new key. They can’t read anything written from now on. '
        + 'Share the new key with each of the other admins below. Where it asks, check their phone in person first.',
    firstTrust: (callsign: string | null, code: string) => `This phone now trusts ${callsign ? `@${callsign}` : 'the admin'} for the names list: `
        + `they shared its key with you. Check it in person: their code is ${code}, and it should match “Your code” on their phone. `
        + 'If it doesn’t, don’t add names, and tell your other admins.',
    keyChanged: (callsign: string) => `@${callsign}’s phone key changed: check it with @${callsign} in person before sharing. `
        + 'A new phone does that, and so can whoever runs the server, so this phone trusts neither key until you check. '
        + 'It takes nothing new the old key signs: a lost phone still has it.',
    refusedTitle: 'This phone refused the list’s key',
    refused: (r: NamesRefusal, trusted: string[]) => {
        const who = r.makerCallsign ? `@${r.makerCallsign}` : 'a key that isn’t an admin here';
        const ask = trusted.length ? ` Ask ${holderNames(trusted)}, whom this phone trusts, to open the names list.` : '';
        if (r.reason === 'other_community') {
            return 'The server says this list belongs to a different community from the one this phone opened before. Nothing was read or changed.';
        }
        if (r.reason === 'rolled_back') {
            return `The server offers an older key of the list (number ${r.offered ?? 0}) than this phone already took (number ${r.newest ?? 0}). `
                + 'A server put back to an older copy does that, and an admin who was removed may hold that older key. This phone used nothing '
                + 'under it and changed nothing.' + (r.canMakeNew ? ' You can make a new key on this phone: the older entries it can open are sealed again under it.' : ask);
        }
        if (r.reason === 'unsigned') {
            return `The list’s newest key says it was made by ${who}, but it isn’t signed by them. Whoever runs the server, or anyone `
                + 'with its database, could have written it in. This phone used nothing under it and changed nothing: no name was sealed under it.' + ask;
        }
        return `The list’s newest key was made by ${who}, and no admin this phone trusts added them. Whoever runs the server can make any key `
            + 'an admin, so this phone used nothing under it and changed nothing: no name was sealed under it.' + ask;
    },
    makeNewTitle: 'Make a new key on this phone?',
    makeNew: 'This phone makes the list a new key for you alone, and seals the entries it can open again under it. Every other admin '
        + 'then waits for you to share it, after checking their phone in person where the app asks.',
    startAgainTitle: 'Start the list again?',
    startAgain: 'Nobody who is an admin now holds the list’s key: the admins who did have left or lost their phones. You can start a new key, '
        + 'but the entries written before can’t be opened by anyone here any more. They stay, locked, until an admin types each one again '
        + 'from your paper copy, or deletes it.',
    waitTitle: 'Waiting for the key',
    wait: (holders: string[], newKey: boolean) => (newKey
        ? `The list needs a new key before anything more is written. ${holderNames(holders)} can make it: ask them to open the names list.`
        : `You don’t hold the list’s key yet. ${holderNames(holders)} can share it with you: meet them, open the names list on both phones, `
            + 'and let them scan the code below.'),
    myKeyTitle: 'Your phone’s key',
    myKey: 'An admin who shares the list with you checks this first, in person: they scan the QR code, or compare the code with what '
        + 'their phone shows for you. Show it only to someone you’re with.',
    myCode: (code: string) => `Your code: ${code}`,
    showMyKey: 'Show my phone’s key',
    hideMyKey: 'Hide my phone’s key',
    // Sharing, and checking a key in person.
    checkFirst: (callsign: string) => `Check @${callsign}’s phone in person before sharing: the server’s word that a key is @${callsign}’s isn’t enough.`,
    waitingTrusted: (callsign: string) => `@${callsign} is an admin and is waiting for the list’s key. This phone has checked their key.`,
    waitingCheck: (callsign: string) => `@${callsign} is an admin and is waiting for the list’s key. Check their phone in person first: `
        + 'the server can put an admin’s name on any key.',
    checkButton: (callsign: string) => `Check @${callsign} in person`,
    checkTitle: (callsign: string) => `Check @${callsign} in person`,
    checkIntro: (callsign: string) => `Meet @${callsign}. Ask them to open the names list on their phone: it shows their phone’s key as a QR code `
        + 'and a code. Scan the QR code, or compare the code with theirs and type it in. Only do this with them in front of you.',
    scanButton: 'Scan their QR code',
    stopScan: 'Stop scanning',
    cameraNeeded: 'To scan their code, allow the camera. You can type the code instead.',
    codeLabel: 'THEIR CODE (20 DIGITS)',
    compareButton: 'Compare',
    unreadable: 'That isn’t a phone key code. Scan the QR code on their names list, or type the 20 digits shown under it.',
    mismatch: (callsign: string) => `That isn’t the key the server has for @${callsign}. Don’t share the list with it. Either this isn’t `
        + `@${callsign}’s phone, or the server has put their name on a key their phone doesn’t hold. Tell your other admins.`,
    matched: (callsign: string) => `It matches: this phone now trusts @${callsign}’s key.`,
    trustTitle: (callsign: string) => `Trust @${callsign}’s new key?`,
    trust: (callsign: string) => `It matches the phone in front of you. Only go on if that is @${callsign} and they told you themselves that `
        + 'they made the list a new key (after its last key was lost). From then on this phone uses their key and seals names under it.',
    shareTitle: (callsign: string) => `Share the names list with @${callsign}?`,
    share: (callsign: string) => `This phone has checked @${callsign}’s key, in person (here, or by an admin you trust). Sharing gives their phone `
        + 'the list’s key: they can read every name on it.',
    exportTitle: 'Export the list as a PDF?',
    export: 'The PDF holds every name you can open here. Once it leaves this phone it’s yours to keep safe, like a paper list. '
        + 'The other admins can see that you exported it, and when.',
    lockedEntry: 'Locked: written with a key nobody here holds. Type it again from your paper copy, or delete it.',
    noKeyEntry: 'This entry was sealed under an older key you don’t hold. An admin who does will update it.',
    deleteConfirmed: 'A member is confirmed against this entry. Revoke the confirmation first.',
    removedConfirmTitle: 'Revoke this confirmation?',
    twoAdminsLabel: 'Two admins confirm each member',
    twoAdminsHelp: 'A confirmation waits until a second admin confirms it too: not the admin who made it, and not the member. '
        + 'Where nobody else could (an admin confirmed in a community of two admins), one admin is enough.',
} as const;

function holderNames(holders: string[]): string {
    if (holders.length === 0) return 'An admin who holds it';
    const named = holders.map((h) => `@${h}`);
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`;
}
