/**
 * The names list, on an owner's or admin's phone (community modes slice 2; the server is apps/server/src/routes/
 * names-list.ts and engine/names-list.ts; the crypto is @beanpool/core names-list-crypto.ts).
 *
 * The community's admins keep a list of who its members are, by real name, and confirm a member against an entry. The
 * names are sealed on this phone before anything is sent: the node keeps scrambled text and the list's key wrapped to
 * each admin's own key, and only an admin's phone opens them. Everything here is signed with the member's own key.
 *
 * What this module decides, so the screen (app/names-list.tsx) only draws it:
 *   - the key: open this admin's own wraps; make the first key, a new one after an admin goes (wrapped to the admins
 *     who held the old one, never to anyone new), or start again when nobody here holds it; or say who to ask
 *     ({@link keyPlan});
 *   - the entries: open each with the key of its generation, or say why it can't be ({@link openEntries}); seal the older
 *     ones again under a new key ({@link reEncryptBatches});
 *   - sharing: an admin made since waits until an admin who holds the key taps "Share" for them — never automatic, so
 *     the node can't decide who reads the names ({@link waitingAdmins});
 *   - confirming: who can be confirmed ({@link confirmableMembers}), and the words for each confirmation;
 *   - the access log's lines, and the PDF's page ({@link namesListHtml}), made and shared on this phone.
 *
 * A confirmation is a fact about a member, never a tier, and in this version it gates nothing.
 */
import {
    NAMES_LIMITS, newNamesListKey, wrapNamesListKey, unwrapNamesListKey, sealNamesEntry, openNamesEntry, newNamesEntryId,
    normaliseNamesEntryText, type NamesEntryText, type WrappedNamesKey,
} from '@beanpool/core';
import { buildSignedHeaders } from './crypto';
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
}

export interface NamesAdminRow {
    pubkey: string;
    callsign: string;
    role: 'owner' | 'admin';
    holdsKey: boolean;
}

export interface NamesState {
    generation: number;
    newKeyNeeded: boolean;
    nobodyHoldsKey: boolean;
    myKeys: NamesKeyWrap[];
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

// ── The key ──────────────────────────────────────────────────────────────────────────────────

/** This admin's own wraps, opened with their own key: generation → list key. A wrap that doesn't open is left out. */
export function myListKeys(state: Pick<NamesState, 'myKeys'>, identity: Pick<BeanPoolIdentity, 'privateKey' | 'publicKey'>): Map<number, Uint8Array> {
    const keys = new Map<number, Uint8Array>();
    for (const wrap of state.myKeys ?? []) {
        try {
            keys.set(wrap.generation, unwrapNamesListKey(wrap, identity.privateKey, identity.publicKey, wrap.generation));
        } catch {
            // Not made for this key, or altered: as if there were none. The screen says who to ask.
        }
    }
    return keys;
}

export type KeyPlan =
    /** This phone holds the current key: open the list. */
    | { kind: 'ready' }
    /** The list has no key yet: this phone makes it, for this admin alone. */
    | { kind: 'make_first' }
    /** An admin went: this phone makes the next key, for the admins who held the last one (never anyone new). */
    | { kind: 'make_new'; wrapTo: string[] }
    /** Nobody who is an admin now holds the key: a new one, and the entries sealed under the old one stay locked. Asks first. */
    | { kind: 'start_again' }
    /** Another admin holds the key (or must make the new one): ask them. */
    | { kind: 'wait'; holders: NamesAdminRow[]; newKeyNeeded: boolean };

/** What this phone does about the key, from the node's state and the keys it opened. */
export function keyPlan(state: NamesState, myPubkey: string, keys: Map<number, Uint8Array>): KeyPlan {
    if (state.generation === 0) return { kind: 'make_first' };
    if (state.nobodyHoldsKey) return { kind: 'start_again' };
    const holders = state.admins.filter((a) => a.holdsKey);
    const iHold = keys.has(state.generation) && holders.some((h) => h.pubkey === myPubkey);
    if (state.newKeyNeeded) {
        return iHold
            ? { kind: 'make_new', wrapTo: holders.map((h) => h.pubkey) }
            : { kind: 'wait', holders, newKeyNeeded: true };
    }
    return iHold ? { kind: 'ready' } : { kind: 'wait', holders, newKeyNeeded: false };
}

/** Wraps `key` of `generation` to each admin in `holders`. */
export function wrapsFor(key: Uint8Array, generation: number, holders: string[]): ({ holder: string } & WrappedNamesKey)[] {
    return holders.map((holder) => ({ holder, ...wrapNamesListKey(key, holder, generation) }));
}

/**
 * Makes the key the plan asks for (not for `ready` or `wait`), and sends it. The new key is kept for this screen only:
 * the phone opens its own wrap again from the node, as any other admin's does.
 */
export async function installKeyFor(
    anchor: string, identity: BeanPoolIdentity, state: NamesState, plan: KeyPlan,
): Promise<NamesResult<{ generation: number; key: Uint8Array }>> {
    if (plan.kind === 'ready' || plan.kind === 'wait') return { ok: false, status: 0, code: 'no_plan', message: 'Nothing to make.' };
    const generation = state.generation + 1;
    const holders = plan.kind === 'make_new'
        ? [identity.publicKey, ...plan.wrapTo.filter((h) => h !== identity.publicKey)]
        : [identity.publicKey];
    const key = newNamesListKey();
    const sent = await call<{ generation: number }>(anchor, identity, 'POST', `${NAMES_PATH}/key`, { generation, wraps: wrapsFor(key, generation, holders) });
    return sent.ok ? { ok: true, value: { generation, key } } : sent;
}

/** The admins who don't hold the key yet (made since, or left out of a new one): this admin may share it with them. */
export function waitingAdmins(state: NamesState, myPubkey: string): NamesAdminRow[] {
    if (state.generation === 0 || state.newKeyNeeded) return [];
    return state.admins.filter((a) => !a.holdsKey && a.pubkey !== myPubkey);
}

/** Shares the current key with one admin: a tap on this phone, after the screen asked. */
export function shareKeyWith(anchor: string, identity: BeanPoolIdentity, state: NamesState, key: Uint8Array, admin: NamesAdminRow) {
    return call<{ shared: string[] }>(anchor, identity, 'POST', `${NAMES_PATH}/key/share`, { generation: state.generation, wraps: wrapsFor(key, state.generation, [admin.pubkey]) });
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
 * One that doesn't open is left as it is (another admin who holds its key can do it).
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
    who: 'Only this community’s owners and admins can read these names, on their own phones. The community’s server keeps them scrambled: it, BeanPool and anyone who copies it can’t read them.',
    notShownToMembers: 'Members don’t see these names. Showing real names to members isn’t available yet.',
    makingKey: 'Setting up the list’s key on this phone…',
    newKeyMade: 'Someone stopped being an admin, so this phone made the list a new key. They can’t read anything written from now on.',
    startAgainTitle: 'Start the list again?',
    startAgain: 'Nobody who is an admin now holds the list’s key: the admins who did have left or lost their phones. You can start a new key, '
        + 'but the entries written before can’t be opened by anyone here any more. They stay, locked, until an admin types each one again '
        + 'from your paper copy, or deletes it.',
    waitTitle: 'Waiting for the key',
    wait: (holders: string[], newKey: boolean) => (newKey
        ? `The list needs a new key before anything more is written. ${holderNames(holders)} can make it: ask them to open the names list.`
        : `You don’t hold the list’s key yet. ${holderNames(holders)} can share it with you: ask them to open the names list.`),
    shareTitle: (callsign: string) => `Share the names list with @${callsign}?`,
    share: (callsign: string) => `@${callsign} is an admin here. Sharing gives their phone the list’s key: they can read every name on it. `
        + 'Only share it with someone you trust with the list.',
    exportTitle: 'Export the list as a PDF?',
    export: 'The PDF holds every name you can open here. Once it leaves this phone it’s yours to keep safe, like a paper list. '
        + 'The other admins can see that you exported it, and when.',
    lockedEntry: 'Locked: written with a key nobody here holds. Type it again from your paper copy, or delete it.',
    noKeyEntry: 'This entry was sealed under an older key you don’t hold. An admin who does will update it.',
    deleteConfirmed: 'A member is confirmed against this entry. Revoke the confirmation first.',
    removedConfirmTitle: 'Revoke this confirmation?',
    twoAdminsLabel: 'Two admins confirm each member',
    twoAdminsHelp: 'With two or more admins, a confirmation waits until a second admin, not the first, confirms it too.',
} as const;

function holderNames(holders: string[]): string {
    if (holders.length === 0) return 'An admin who holds it';
    const named = holders.map((h) => `@${h}`);
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} or ${named[named.length - 1]}`;
}
