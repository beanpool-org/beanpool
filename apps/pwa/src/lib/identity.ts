/**
 * Identity Library — Ed25519 Keypair + Callsign Management
 *
 * On first run, generates a 12-word BIP-39 mnemonic, derives an
 * Ed25519 keypair deterministically, and stores both in IndexedDB.
 * The public key acts as the DID.
 */

import { generateMnemonic, mnemonicToKeypair } from './mnemonic';

const DB_NAME = 'beanpool-identity';
const STORE_NAME = 'keys';
const KEY_ID = 'sovereign-identity';
/** A join through the open door that has not finished yet (savePendingJoin). Never read by loadIdentity. */
const PENDING_JOIN_ID = 'pending-join';
/** A restore with a sign-in that has left the page for the provider (savePendingRestore). Never read by loadIdentity. */
const PENDING_RESTORE_ID = 'pending-restore';
/** A key an invite was sent with, until the node has settled it (markInviteSent). Never read by loadIdentity. */
const INVITE_SENT_ID = 'invite-sent';

export interface BeanPoolIdentity {
    publicKey: string;    // Hex-encoded Ed25519 public key
    privateKey: string;   // Hex-encoded Ed25519 private key (never leaves device)
    callsign: string;     // Human-readable name
    createdAt: string;
    mnemonic?: string[];  // 12-word recovery phrase (optional for legacy identities)
}

/*
 * Every write below listens for `abort` as well as `error`. A write the browser cannot commit (its storage full, say)
 * aborts the transaction with no `error` event, and a promise waiting only for `complete` or `error` would never
 * settle: a join the node has said yes to would sit on "Joining…" instead of saying it could not be saved.
 */

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            req.result.createObjectStore(STORE_NAME);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** What the four slots hold, read inside the transaction that may write them. */
interface StoredSlots {
    identity: BeanPoolIdentity | undefined;
    pending: PendingJoin | undefined;
    /** Whatever is in the restore slot, unread: pendingRestoreAsStored decides whether it is one. */
    restore: unknown;
    /** Whatever is in the invite-sent slot, unread: asInviteSent decides whether it is one. */
    inviteSent: unknown;
}

/** What to write back: a slot left out is left as it is. */
interface SlotWrites<T> {
    identity?: BeanPoolIdentity;
    pending?: PendingJoin | 'delete';
    restore?: PendingRestore | 'delete';
    inviteSent?: InviteSent | 'delete';
    result: T;
}

/**
 * Read the slots and decide what to write, in one readwrite transaction: `decide` sees what is stored at that moment,
 * never a tab's copy, and nothing else can write between its reading and its writing. Every write to any slot but
 * wipeIdentity's goes through here.
 */
async function withStoredSlots<T>(decide: (stored: StoredSlots) => SlotWrites<T>): Promise<T> {
    const db = await openDb();
    let result: T | undefined;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // All asked at once: requests answer in order, so the last answer comes with the others already in.
        const identityReq = store.get(KEY_ID);
        const pendingReq = store.get(PENDING_JOIN_ID);
        const restoreReq = store.get(PENDING_RESTORE_ID);
        const inviteSentReq = store.get(INVITE_SENT_ID);
        inviteSentReq.onsuccess = () => {
            try {
                const decision = decide({
                    identity: (identityReq.result ?? undefined) as BeanPoolIdentity | undefined,
                    pending: (pendingReq.result ?? undefined) as PendingJoin | undefined,
                    restore: restoreReq.result ?? undefined,
                    inviteSent: inviteSentReq.result ?? undefined,
                });
                if (decision.identity) store.put(decision.identity, KEY_ID);
                if (decision.pending === 'delete') store.delete(PENDING_JOIN_ID);
                else if (decision.pending) store.put(decision.pending, PENDING_JOIN_ID);
                if (decision.restore === 'delete') store.delete(PENDING_RESTORE_ID);
                else if (decision.restore) store.put(decision.restore, PENDING_RESTORE_ID);
                if (decision.inviteSent === 'delete') store.delete(INVITE_SENT_ID);
                else if (decision.inviteSent) store.put(decision.inviteSent, INVITE_SENT_ID);
                result = decision.result;
            } catch (err) {
                // A `decide` that throws, or a value the store can't take (put's DataCloneError): the caller hears that
                // error, not an uncaught one nor the bare abort it would cause, and nothing written here stays
                // (review 4108355843). Rejected first, so the abort's own rejection below comes too late to replace it.
                reject(err);
                try {
                    tx.abort();
                } catch {
                    // Already aborted (it can't have committed inside its own request's callback): nothing left to undo.
                }
            }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
    return result as T;
}

/*
 * ---------- One browser, one identity (#1154 follow-up, review 4106962020) ----------
 *
 * Nothing here writes a different key over the identity this browser holds. Two tabs can each be part way through a
 * join, a restore or an invite, and whichever saves first is this browser's account: another key arriving after it is
 * refused (IdentityHeldError) with nothing changed, and the page that tried says so, with the account already here to
 * open. A key a join sent that way stays in the pending slot, marked sent (completePendingJoin), so it is never lost
 * without the member being told. The same key may be written again (a name change, a join finishing twice), and keeps
 * the 12 words stored with it when the new copy brings none. The one way to put another account here is the member's
 * own: sign out (wipeIdentity), then restore it.
 *
 * A save can also be told to wait for a join that went out from this browser (SaveIdentityOptions): then it is refused
 * (SentJoinWaitingError) while such a join is stored unsettled, decided in the same transaction that would write the
 * identity. A check in a transaction of its own would leave a gap in which another tab could mark a join sent.
 */

/** This browser holds another account, and a write that would have replaced it was refused. Nothing changed. */
export class IdentityHeldError extends Error {
    /** The identity this browser holds, as stored. */
    readonly held: BeanPoolIdentity;
    constructor(held: BeanPoolIdentity) {
        super('This browser holds a different BeanPool account, so it was not replaced.');
        this.name = 'IdentityHeldError';
        this.held = held;
    }
}

/** What may go in the identity slot in place of `stored`: `incoming`, unless `stored` is another key's. */
function identityToWrite(stored: BeanPoolIdentity | undefined, incoming: BeanPoolIdentity): { write: BeanPoolIdentity } | { held: BeanPoolIdentity } {
    if (!stored?.publicKey) return { write: incoming };
    if (stored.publicKey !== incoming.publicKey) return { held: stored };
    const keepWords = !incoming.mnemonic?.length && !!stored.mnemonic?.length;
    return { write: keepWords ? { ...incoming, mnemonic: stored.mnemonic } : incoming };
}

/**
 * Load the existing identity from IndexedDB, or return null.
 */
export async function loadIdentity(): Promise<BeanPoolIdentity | null> {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(KEY_ID);
        req.onsuccess = () => resolve(req.result ?? null);
        req.onerror = () => reject(req.error);
    });
}

/**
 * The one way to read a user's recovery words. Mirrors `getMnemonic` in the native app
 * deliberately — the two clients show the same words in the same places, and a seam that
 * exists on only one of them is a seam that gets forgotten on the other.
 *
 * Today it returns `identity.mnemonic` and nothing else, which is the point: every screen
 * that shows the words goes through one function BEFORE that function has anything
 * interesting to do. The PWA's vault (Phase C) is also the fix for these words sitting in
 * plaintext IndexedDB, and it lands here without touching a single caller.
 *
 * Async now, though it need not be, so callers are already awaiting by the time it is.
 */
export async function getMnemonic(identity: BeanPoolIdentity | null | undefined): Promise<string[] | null> {
    if (!identity) return null;
    const words = identity.mnemonic;
    return words && words.length > 0 ? words : null;
}

/**
 * Does this identity have recovery words at all — without reading them. Stays synchronous
 * because whether words exist is not itself a secret, and because the callers are render
 * guards: making them await would hand each one a null first frame, which in the
 * onboarding flow is enough to show the wrong step for a tick.
 */
export function hasMnemonic(identity: BeanPoolIdentity | null | undefined): identity is BeanPoolIdentity {
    return !!identity?.mnemonic && identity.mnemonic.length > 0;
}

/**
 * Where we record that this member has actually seen their 12 words.
 *
 * Scoped to the public key, not global: wiping and creating a new identity in the same
 * browser must show the warning again, and a global key would silently mark the new
 * account as backed up because the old one was. Client-side only — the server cannot
 * read a PWA member's phrase and has no business knowing whether they saved it.
 *
 * Shared here rather than inlined so WelcomePage (which sets it at onboarding) and
 * SettingsPage (which reads it) cannot drift onto different keys.
 */
export function seedViewedKey(publicKey: string): string {
    return `bp_seed_viewed_${publicKey}`;
}

/**
 * Generate a new Ed25519 identity from a 12-word mnemonic.
 * Returns the identity AND the mnemonic (for one-time display).
 * Refused, with nothing saved, when this browser holds another account (IdentityHeldError), or as `options` says.
 */
export async function createIdentity(callsign: string, options: SaveIdentityOptions = {}): Promise<BeanPoolIdentity> {
    const identity = await generateIdentity(callsign);
    await saveIdentity(identity, options);
    return identity;
}

/** A new identity and its 12 words, made exactly as createIdentity makes them, but saved nowhere. */
export async function generateIdentity(callsign: string): Promise<BeanPoolIdentity> {
    return identityFromMnemonic(generateMnemonic(), callsign);
}

/**
 * Recover identity from a 12-word mnemonic phrase.
 * Derives the same keypair deterministically.
 * Refused, with nothing saved, when this browser holds another account (IdentityHeldError), or as `options` says.
 */
export async function createIdentityFromMnemonic(words: string[], callsign: string, options: SaveIdentityOptions = {}): Promise<BeanPoolIdentity> {
    const identity = await identityFromMnemonic(words, callsign);
    await saveIdentity(identity, options);
    return identity;
}

/** The identity 12 words derive, saved nowhere. */
export async function identityFromMnemonic(words: string[], callsign: string): Promise<BeanPoolIdentity> {
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);
    return {
        publicKey: publicKeyHex,
        privateKey: privateKeyHex,
        callsign,
        createdAt: new Date().toISOString(),
        mnemonic: words,
    };
}

// ===================== THE PENDING JOIN (design G11 §4.1) =====================

/** How long a pending join lives: the node's sign-in nonce lives ten minutes (apps/server/src/sso.ts NONCE_TTL_MS). */
export const PENDING_JOIN_TTL_MS = 10 * 60 * 1000;
/** How long it is kept after the node said too many accounts joined from this network, so a retry keeps the same key. */
export const PENDING_JOIN_RATE_LIMITED_TTL_MS = 60 * 60 * 1000;

/** The node's sign-in nonce life (apps/server/src/sso.ts NONCE_TTL_MS). */
const NODE_NONCE_LIFE_MS = 10 * 60 * 1000;

/**
 * How long after a join went out it can still land. The node writes the member only as it spends the sign-in the
 * join carried, and it spends none older than its nonce life. The nonce was issued before the join went, and a
 * GitHub result lives as long from before it (engine/github-device.ts), so ten minutes after `sentAt` nothing that
 * join carried can be spent. A minute more, for good measure.
 */
export const SENT_JOIN_CAN_LAND_MS = NODE_NONCE_LIFE_MS + 60 * 1000;

/** The sign-ins the open door takes (apps/server/src/routes/open-join.ts). */
export type JoinProvider = 'google' | 'apple' | 'facebook' | 'github';

/**
 * A join through the open door that has left the page, or may: the new key and its 12 words, the name, and the
 * sign-in the page sent the member to with the node's nonce for it.
 *
 * It lives beside the identity, in its own key, because the page LEAVES for the sign-in: the key has to survive the
 * round trip and a reload, and it must not sit in `sovereign-identity`, where the app's identity gate would open the
 * app to somebody who is not a member yet. loadIdentity never reads it. completePendingJoin moves the identity across
 * once the node has said yes; wipeIdentity clears it.
 *
 * `restored`: the key was brought here (the phone's QR or the 12 words) rather than made for this join, so the page
 * never shows it the new member's steps.
 *
 * `sentAt`: a join with this key has gone to the node. From then on the node may hold the key as a member while this
 * record is the only copy of it and of its 12 words (the answer can be lost on the way back). See "A sent key's
 * fate" below: nothing but releaseSentPendingJoin deletes such a record or takes its mark off.
 */
export interface PendingJoin {
    identity: BeanPoolIdentity;
    provider: JoinProvider | null;
    nonce: string | null;
    startedAt: number;
    expiresAt: number;
    restored: boolean;
    /** The one automatic retry after the node said the sign-in expired (design §2, screen 4) has been spent. */
    retriedExpired?: boolean;
    /** When a join with this key last went to the node (Date.now()); absent until one has. */
    sentAt?: number;
    /**
     * When the join before that one went, if it went while this key was still marked sent: that one may land too, so
     * a refusal of the later join settles nothing until the earlier one can no longer land (releaseSentPendingJoin).
     */
    earlierSentAt?: number;
}

/** A join with this pending key has gone to the node, and the node has not said it did not land. */
export function pendingJoinSent(pending: PendingJoin): boolean {
    return typeof pending.sentAt === 'number';
}

/** When the latest join with this key went, of every one still unsettled (NaN when a time cannot be read). */
export function lastSentAt(pending: PendingJoin): number {
    return typeof pending.earlierSentAt === 'number' ? Math.max(pending.sentAt ?? Number.NaN, pending.earlierSentAt) : pending.sentAt ?? Number.NaN;
}

/** A record that holds a key and is marked sent: the node may have that key as a member. */
function isSent(record: PendingJoin | undefined): record is PendingJoin & { sentAt: number } {
    return !!record?.identity?.privateKey && pendingJoinSent(record);
}

/** A sent pending join holding one key, which another key was about to replace. */
export class PendingJoinHeldError extends Error {
    /** The sent pending join as it is stored, for the page to settle first. */
    readonly held: PendingJoin;
    constructor(held: PendingJoin) {
        super('A join with another key has gone to the node and has not been settled; it is kept.');
        this.name = 'PendingJoinHeldError';
        this.held = held;
    }
}

/**
 * A join that went out from this browser waits to be settled, and a save told to wait for one (SaveIdentityOptions)
 * was refused. Nothing changed.
 */
export class SentJoinWaitingError extends Error {
    /** The sent pending join as it is stored, for the page to settle first. */
    readonly pending: PendingJoin;
    constructor(pending: PendingJoin) {
        super('A join that went out from this browser has not been settled, so no identity was saved.');
        this.name = 'SentJoinWaitingError';
        this.pending = pending;
    }
}

/** A sent join the node has said never landed and can no longer land: its key, and when it was last sent (lastSentAt). */
export interface SettledSentJoin {
    publicKey: string;
    sentAt: number;
}

export interface SaveIdentityOptions {
    /**
     * Refuse the save (SentJoinWaitingError) while a join that went out from this browser is stored unsettled, unless
     * it is `except`, as last sent: one sent again since is waited for again. Decided on the pending join as stored, in
     * the transaction that writes the identity.
     */
    refuseWhileSentJoinWaits?: { except: SettledSentJoin | null };
}

/** The sent pending join a save told `options` must wait for, or null. */
function sentJoinToWaitFor(pending: PendingJoin | undefined, options: SaveIdentityOptions): PendingJoin | null {
    const rule = options.refuseWhileSentJoinWaits;
    if (!rule || !isSent(pending)) return null;
    const settled = rule.except;
    return settled && settled.publicKey === pending.identity.publicKey && settled.sentAt === lastSentAt(pending) ? null : pending;
}

/*
 * ---------- A sent key's fate: decided here, and only here ----------
 *
 * Once a join has gone, only two things let this browser drop that key or take its sent mark off:
 *
 *   - the node's word, twice over: the door refused the LATEST join with it definitely (a parsed refusal it gives
 *     before it writes a member, NodeRefusedJoin), the node then said the key is not a member (its membership probe,
 *     signed by the key, NodeSaidNotMember), and no earlier join with the key can still land;
 *   - the member letting it go, on the record they were shown, after being told what that means.
 *
 * Both are releaseSentPendingJoin. Every other write reads the STORED record in its own transaction (never a tab's
 * copy of it) and keeps a sent mark it finds there: savePendingJoin writes the same key back with the stored mark,
 * clearUnsentPendingJoin and loadPendingJoin's clock never delete a sent record, and completePendingJoin removes the
 * pending join only when it holds the key that joined, and only as that key becomes this browser's identity (never
 * when another account is here). The one exception is wipeIdentity, the member's own "delete everything on this
 * device".
 */

/** The node's membership probe, signed by the pending key, answered `isMember: false` (web-join.ts probeMembership). */
export interface NodeSaidNotMember {
    publicKey: string;
    /** When the probe was asked (taken before it went): the key was not a member then. */
    askedAt: number;
}

/**
 * The refusals the door gives a join before it writes a member (apps/server/src/routes/open-join.ts), each with the
 * one status it comes with. Only one of these, read from the answer's body with its matching status, is a definite
 * "that join did not land".
 */
export const DEFINITE_JOIN_REFUSALS = {
    invite_only: 404,
    bad_request: 400,
    bad_key: 400,
    recovery_invalid: 400,
    sign_in: 401,
    key_invalidated: 403,
    removed: 403,
    already_joined: 409,
    rate_limited: 429,
} as const;
export type DefiniteJoinRefusalCode = keyof typeof DEFINITE_JOIN_REFUSALS;

export function isDefiniteJoinRefusal(code: unknown, status: number): code is DefiniteJoinRefusalCode {
    return typeof code === 'string' && Object.prototype.hasOwnProperty.call(DEFINITE_JOIN_REFUSALS, code)
        && DEFINITE_JOIN_REFUSALS[code as DefiniteJoinRefusalCode] === status;
}

/** The door refused one join with this key, definitely (web-join.ts joinVerdict). */
export interface NodeRefusedJoin {
    publicKey: string;
    /** The `sentAt` of the join it answered. */
    sentAt: number;
    /** When its answer arrived. */
    answeredAt: number;
    status: number;
    code: DefiniteJoinRefusalCode;
}

export type SentJoinRelease =
    /** The door refused the latest join definitely, and the node said afterwards that the key is not a member. */
    | { kind: 'refused'; refusal: NodeRefusedJoin; notMember: NodeSaidNotMember }
    /** The member chose to let this record go (the one with this key and this sentAt), told what that means. */
    | { kind: 'abandoned'; publicKey: string; sentAt: number | undefined };

/** withStoredSlots for the pending join alone. */
async function withStoredPendingJoin<T>(
    decide: (current: PendingJoin | undefined) => { write?: PendingJoin | 'delete'; result: T },
): Promise<T> {
    return withStoredSlots(({ pending }) => {
        const decision = decide(pending);
        return { pending: decision.write, result: decision.result };
    });
}

/** `pending` without any sent mark: what a write may put in the slot when the store holds none for its key. */
function withoutSentMark(pending: PendingJoin): PendingJoin {
    const next = { ...pending };
    delete next.sentAt;
    delete next.earlierSentAt;
    return next;
}

/**
 * Keep `pending` as the one pending join, in place of any other, except a sent one holding another key: that one may
 * be a member's only copy, so the write is refused (PendingJoinHeldError) and nothing changes. When the store has
 * THIS key marked sent, the stored mark stays, whatever `pending` says: a tab whose copy is older than the join
 * another tab sent must not undo it. Returns what was stored.
 */
export async function savePendingJoin(pending: PendingJoin): Promise<PendingJoin> {
    const out = await withStoredPendingJoin<{ saved: PendingJoin } | { held: PendingJoin }>((current) => {
        if (isSent(current)) {
            if (current.identity.publicKey !== pending.identity.publicKey) return { result: { held: current } };
            const next: PendingJoin = { ...withoutSentMark(pending), sentAt: current.sentAt };
            if (current.earlierSentAt !== undefined) next.earlierSentAt = current.earlierSentAt;
            return { write: next, result: { saved: next } };
        }
        // Nothing sent is stored: a copy that says sent is kept as it says (the safe way round).
        return { write: pending, result: { saved: pending } };
    });
    if ('held' in out) throw new PendingJoinHeldError(out.held);
    return out.saved;
}

export interface MarkJoinSentOptions {
    /**
     * Refuse (InviteSentHeldError) while a key an invite went with from this browser is stored unsettled, holding
     * another key (markInviteSent): that key may be a member's, and a join going out beside it would make this browser
     * two members' keys, with only one of them ever saved (4112075367). Decided in the transaction that marks the join.
     * markInviteSent refuses the other way round, so the two never both go out.
     */
    refuseWhileInviteKept?: boolean;
}

/**
 * Mark `pending` sent at `at`, before its join goes. If a join with this key was already out and unsettled (in the
 * store, or in this copy), that one may still land, and is remembered as `earlierSentAt`. Refused like
 * savePendingJoin when another key's sent join holds the slot, or as `options` says. Returns what was stored.
 */
export async function markPendingJoinSent(pending: PendingJoin, at: number = Date.now(), options: MarkJoinSentOptions = {}): Promise<PendingJoin> {
    const out = await withStoredSlots<{ saved: PendingJoin } | { held: PendingJoin } | { invite: InviteSent }>(({ pending: current, inviteSent }) => {
        if (isSent(current) && current.identity.publicKey !== pending.identity.publicKey) return { result: { held: current } };
        const invite = options.refuseWhileInviteKept ? asInviteSent(inviteSent) : null;
        if (invite && invite.identity.publicKey !== pending.identity.publicKey) return { result: { invite } };
        const earlier = [current && isSent(current) ? lastSentAt(current) : null, pendingJoinSent(pending) ? lastSentAt(pending) : null]
            .filter((t): t is number => t !== null);
        const next: PendingJoin = { ...withoutSentMark(pending), sentAt: at };
        // NaN (a time that cannot be read) wins, so such a join is never judged unable to land.
        if (earlier.length) next.earlierSentAt = earlier.some(Number.isNaN) ? Number.NaN : Math.max(...earlier);
        return { pending: next, result: { saved: next } };
    });
    if ('held' in out) throw new PendingJoinHeldError(out.held);
    if ('invite' in out) throw new InviteSentHeldError(out.invite);
    return out.saved;
}

/**
 * The pending join, or null. An unsent one past its `expiresAt` is dropped on sight and never returned; a sent one
 * is returned whatever its age, for the page to ask the node about. The drop is decided on the record as stored in
 * the same transaction, so a join another tab has just sent is never dropped on this tab's clock.
 */
export async function loadPendingJoin(now: number = Date.now()): Promise<PendingJoin | null> {
    return withStoredPendingJoin<PendingJoin | null>((current) => {
        if (!current) return { result: null };
        // No key in it: nothing to lose.
        if (!current.identity?.privateKey) return { write: 'delete', result: null };
        if (pendingJoinSent(current)) return { result: current };
        if (!(typeof current.expiresAt === 'number' && current.expiresAt > now)) return { write: 'delete', result: null };
        return { result: current };
    });
}

/**
 * Clear a pending join nobody needs any more (the member went back past the name, or restored another identity),
 * unless a join with its key has gone to the node: that one is kept, and returned for the page to settle. With
 * `publicKey`, only a pending join holding that key is cleared; another key's is left alone. Null when nothing sent
 * was found.
 */
export async function clearUnsentPendingJoin(publicKey?: string): Promise<PendingJoin | null> {
    return withStoredPendingJoin<PendingJoin | null>((current) => {
        if (!current) return { result: null };
        if (publicKey !== undefined && current.identity?.publicKey !== publicKey) return { result: null };
        if (isSent(current)) return { result: current };
        return { write: 'delete', result: null };
    });
}

/**
 * The one way a sent pending join is let go: made unsent again after the node's definite refusal and its "not a
 * member" (then its own clock applies, and clearUnsentPendingJoin may clear it), or deleted when the member abandons
 * it. Everything is checked against the record as stored, in the same transaction. A refusal releases only:
 *   - the key the refusal and the probe were both about;
 *   - when the refused join is the latest one sent with it (another tab may have sent it again since);
 *   - when the probe was asked after the refusal came back;
 *   - when no earlier join with the key can still land.
 * An abandon deletes only the record the member was shown (the same key and sentAt). Anything else changes nothing:
 * `released` is false and `pending` is what is stored.
 */
export async function releaseSentPendingJoin(release: SentJoinRelease): Promise<{ released: boolean; pending: PendingJoin | null }> {
    return withStoredPendingJoin((current) => {
        const kept = { result: { released: false, pending: current ?? null } };
        if (release.kind === 'abandoned') {
            if (!current) return { result: { released: true, pending: null } };
            if (current.identity?.publicKey !== release.publicKey) return kept;
            if (isSent(current) && current.sentAt !== release.sentAt) return kept;
            return { write: 'delete', result: { released: true, pending: null } };
        }
        const { refusal, notMember } = release;
        if (!isSent(current)) return kept;
        const key = current.identity.publicKey;
        const confirmed = refusal.publicKey === key && notMember.publicKey === key
            && isDefiniteJoinRefusal(refusal.code, refusal.status)
            && current.sentAt === refusal.sentAt
            && refusal.answeredAt >= refusal.sentAt
            && notMember.askedAt >= refusal.answeredAt
            && (current.earlierSentAt === undefined || notMember.askedAt >= current.earlierSentAt + SENT_JOIN_CAN_LAND_MS);
        if (!confirmed) return kept;
        const next = withoutSentMark(current);
        return { write: next, result: { released: true, pending: next } };
    });
}

/**
 * The node said yes: `identity` becomes this browser's identity and the pending join holding its key goes, in one
 * transaction, so there is never a moment with both or neither. A pending join holding another key stays.
 *
 * Unless this browser already holds another account (another tab saved one while this join was out): then nothing is
 * written, the pending join stays exactly as stored, sent mark and all, and IdentityHeldError says which account is
 * here. That key is a member now, so it must not be dropped without the member being told (WebJoin's 'taken' screen).
 */
export async function completePendingJoin(identity: BeanPoolIdentity): Promise<void> {
    const out = await withStoredSlots<{ held: BeanPoolIdentity } | null>(({ identity: stored, pending }) => {
        const next = identityToWrite(stored, identity);
        if ('held' in next) return { result: next };
        const drop = !!pending && (!pending.identity?.privateKey || pending.identity.publicKey === identity.publicKey);
        return { identity: next.write, pending: drop ? 'delete' : undefined, result: null };
    });
    if (out) throw new IdentityHeldError(out.held);
}

// ===================== THE PENDING RESTORE (design G11 §4.4, G11-d) =====================

/** How long a pending restore lives: the node's sign-in nonce life, as a pending join's. */
export const PENDING_RESTORE_TTL_MS = NODE_NONCE_LIFE_MS;

/**
 * A restore with a sign-in (lib/web-restore.ts) that has left the page for the provider: what the page needs when the
 * browser comes back. The node's recovery session for the account (`collectionId`) is bound to a throwaway key made for
 * this restore (`ephemeral`), which signs every call in it and was given the sign-in's `nonce`. `account` is the member
 * the node's lookup named: the account that comes back must have that key, or nothing is saved.
 *
 * Why its own key in the store, and not the pending join's slot with `kind: 'restore'` as design §4.4 has it: that slot
 * is the only copy of a sent join's key, which nothing may replace ("A sent key's fate" above), so a restore sharing it
 * could not start while such a join was out, and would push out an unsent one. So it sits beside it: read and written in
 * the same transactions (withStoredSlots), wiped with the rest (wipeIdentity), dropped on sight once old.
 *
 * It never holds an account's key. `ephemeral` is not one and is never saved as one; nothing here writes the identity
 * slot, and loadIdentity never reads this one. The account that comes back is saved only through importIdentity's
 * guarded write (one browser, one account), after its key has been compared with `account.publicKey`.
 */
export interface PendingRestore {
    kind: 'restore';
    /** The throwaway key the node's recovery session is bound to. Not an account. */
    ephemeral: { publicKey: string; privateKey: string };
    /** The account being brought back, as the node's lookup named it. */
    account: { publicKey: string; callsign: string };
    collectionId: string;
    provider: JoinProvider;
    /** The node's sign-in nonce for `ephemeral`. It is the provider's `state` as well. */
    nonce: string;
    startedAt: number;
    expiresAt: number;
}

/** A pending restore, whole: anything else in its slot is dropped rather than read. */
function asPendingRestore(value: unknown): PendingRestore | null {
    const r = value as Partial<PendingRestore> | null | undefined;
    if (!r || typeof r !== 'object' || r.kind !== 'restore') return null;
    if (typeof r.ephemeral?.privateKey !== 'string' || !r.ephemeral.privateKey || typeof r.ephemeral.publicKey !== 'string') return null;
    if (typeof r.account?.publicKey !== 'string' || !r.account.publicKey || typeof r.account.callsign !== 'string') return null;
    if (typeof r.collectionId !== 'string' || !r.collectionId || typeof r.nonce !== 'string' || !r.nonce || typeof r.provider !== 'string') return null;
    if (typeof r.expiresAt !== 'number' || typeof r.startedAt !== 'number') return null;
    return r as PendingRestore;
}

/** The pending restore as stored, if it is one and still in date; otherwise it is to be dropped. */
function pendingRestoreAsStored(stored: unknown, now: number): { restore: PendingRestore | null; drop: boolean } {
    if (stored === undefined) return { restore: null, drop: false };
    const r = asPendingRestore(stored);
    if (!r || !(r.expiresAt > now)) return { restore: null, drop: true };
    return { restore: r, drop: false };
}

/** Keep `restore` as the one pending restore, in place of any other. Touches nothing else. */
export async function savePendingRestore(restore: PendingRestore): Promise<void> {
    await withStoredSlots<void>(() => ({ restore, result: undefined }));
}

/** The pending restore, or null. One past its `expiresAt`, or not whole, is dropped on sight and never returned. */
export async function loadPendingRestore(now: number = Date.now()): Promise<PendingRestore | null> {
    return withStoredSlots(({ restore }) => {
        const r = pendingRestoreAsStored(restore, now);
        return { restore: r.drop ? 'delete' : undefined, result: r.restore };
    });
}

/**
 * The pending restore this sign-in came back for (its nonce is the return's `state`), taken out of the store in the
 * same transaction, so one return is acted on once. Null, with a pending restore for another nonce left as it is, when
 * none matches.
 */
export async function takePendingRestore(nonce: string, now: number = Date.now()): Promise<PendingRestore | null> {
    return withStoredSlots(({ restore }) => {
        const r = pendingRestoreAsStored(restore, now);
        if (r.drop) return { restore: 'delete', result: null };
        if (!r.restore || !nonce || r.restore.nonce !== nonce) return { result: null };
        return { restore: 'delete', result: r.restore };
    });
}

/** Drop the pending restore (the member went back, or chose another way). */
export async function clearPendingRestore(): Promise<void> {
    await withStoredSlots<void>(({ restore }) => ({ restore: restore === undefined ? undefined : 'delete', result: undefined }));
}

// ===================== THE INVITE SENT (deciding pass 4111943146) =====================

/**
 * How long after a redeem went out it can still land. The node answers a redeem as it handles it (engine/invites.ts
 * redeemInvite), so one whose answer was lost has either landed already or lands later only if its request was still on
 * the way, or waiting in a node that had stalled. The node sets no limit of its own on that, so the margin is wide:
 * keeping a key longer costs nothing, because every try in the meantime sends that same key.
 */
export const INVITE_SEND_CAN_LAND_MS = 15 * 60 * 1000;

/**
 * A key an invite join sent to the node (WelcomePage handleCreate), written before the redeem goes. The node can take
 * the redeem while its answer is lost on the way back (a dropped connection, a tunnel's 502 or 524, a 200 whose body
 * never arrived). Until the page hears back, this is the only copy of what may now be a member's key and its 12 words,
 * and a reload, a closed tab or old Android discarding the tab must not lose it. It has a slot of its own, beside the
 * identity: loadIdentity never reads it, so it never opens the app to a key the node hasn't taken, and it can't clash
 * with a door join's key in the pending-join slot.
 *
 * `inviteHash`: SHA-256 of the code or ticket it went with, never the code itself. `sentAt`: when the latest send with
 * this key went. `earlierSentAt`: when the latest unsettled send before that went. Its answer never came, so it may land
 * too.
 *
 * The record goes only once the node has settled the key: it is saved as this browser's identity (completeInviteSent);
 * the node refused it and then said it is not a member, with no earlier send left that may land
 * (settleRefusedInviteSend); or the node said it is not a
 * member once no send with it can land (releaseInviteSent). wipeIdentity, the member's own "delete everything", takes
 * it too. Nothing else writes another key over it (InviteSentHeldError).
 */
export interface InviteSent {
    identity: BeanPoolIdentity;
    inviteHash: string;
    sentAt: number;
    earlierSentAt?: number;
}

/** An invite-sent record that holds a key: anything else in the slot has nothing in it to lose, and is dropped. */
function asInviteSent(value: unknown): InviteSent | null {
    const r = value as Partial<InviteSent> | null | undefined;
    if (!r || typeof r !== 'object') return null;
    const key = r.identity;
    if (typeof key?.privateKey !== 'string' || !key.privateKey || typeof key.publicKey !== 'string' || !key.publicKey) return null;
    return r as InviteSent;
}

/** When the latest unsettled send with this key went (NaN when a time can't be read, so it is never judged unable to land). */
function lastInviteSentAt(r: InviteSent): number {
    const sent = typeof r.sentAt === 'number' ? r.sentAt : Number.NaN;
    if (r.earlierSentAt === undefined) return sent;
    return Math.max(sent, typeof r.earlierSentAt === 'number' ? r.earlierSentAt : Number.NaN);
}

/** A key another invite was sent with is stored, not settled yet, and is kept: the page settles it first. Nothing changed. */
export class InviteSentHeldError extends Error {
    /** The record as stored. */
    readonly held: InviteSent;
    constructor(held: InviteSent) {
        super('An invite was sent with another key, and it has not been settled; it is kept.');
        this.name = 'InviteSentHeldError';
        this.held = held;
    }
}

/** The key an invite was sent with, or null. A record holding no key is dropped on sight. */
export async function loadInviteSent(): Promise<InviteSent | null> {
    return withStoredSlots<InviteSent | null>(({ inviteSent }) => {
        if (inviteSent === undefined) return { result: null };
        const stored = asInviteSent(inviteSent);
        return stored ? { result: stored } : { inviteSent: 'delete', result: null };
    });
}

/**
 * Record `identity` as sent with the invite `inviteHash` names, at `at`, before its redeem goes. The same key sent again
 * keeps the send before it as `earlierSentAt`: that one isn't settled, or its record would be gone. Refused, with nothing
 * changed (InviteSentHeldError), when another key's record is stored, since that one may be a member's only copy; and
 * as `options` says (SentJoinWaitingError), decided on the pending join as stored, in this same transaction: a door
 * join that went out and waits to be settled is settled first, and never has an invite's key go out beside it
 * (4112075367; markPendingJoinSent's refuseWhileInviteKept is the other way round). Returns what was stored.
 */
export async function markInviteSent(
    identity: BeanPoolIdentity, inviteHash: string, at: number = Date.now(), options: SaveIdentityOptions = {},
): Promise<InviteSent> {
    const out = await withStoredSlots<{ saved: InviteSent } | { held: InviteSent } | { sentJoin: PendingJoin }>(({ inviteSent, pending }) => {
        const sentJoin = sentJoinToWaitFor(pending, options);
        if (sentJoin) return { result: { sentJoin } };
        const stored = asInviteSent(inviteSent);
        if (stored && stored.identity.publicKey !== identity.publicKey) return { result: { held: stored } };
        const next: InviteSent = { identity, inviteHash, sentAt: at };
        if (stored) next.earlierSentAt = lastInviteSentAt(stored);
        return { inviteSent: next, result: { saved: next } };
    });
    if ('sentJoin' in out) throw new SentJoinWaitingError(out.sentJoin);
    if ('held' in out) throw new InviteSentHeldError(out.held);
    return out.saved;
}

/**
 * The node refused the send made at `sentAt` with this key (the redeem route's 400), and then said, asked with the key
 * after that answer came (`notMember`, web-join.ts probeMembership), that it is not a member. A 400 alone is not enough:
 * an older node answered a ticket's fault AFTER registering the member with one (engine/invites.ts, 4112075324). The
 * 400 came once the node's handler had finished, so "not a member" after it is final for that send. If no earlier send
 * with the key is unsettled, the node never took it, and the record goes. If one is, the record stays for that one, on
 * its time. A record sent again since (another tab), or a probe asked before the send, leaves it as it is. Returns what
 * is stored afterwards.
 */
export async function settleRefusedInviteSend(notMember: NodeSaidNotMember, sentAt: number): Promise<InviteSent | null> {
    return withStoredSlots<InviteSent | null>(({ inviteSent }) => {
        const stored = asInviteSent(inviteSent);
        if (!stored || stored.identity.publicKey !== notMember.publicKey || stored.sentAt !== sentAt) return { result: stored };
        if (!(notMember.askedAt >= sentAt)) return { result: stored };
        if (stored.earlierSentAt === undefined) return { inviteSent: 'delete', result: null };
        const next: InviteSent = { ...stored, sentAt: stored.earlierSentAt };
        delete next.earlierSentAt;
        return { inviteSent: next, result: next };
    });
}

/**
 * The node's membership probe, signed by the key, said it is not a member (web-join.ts probeMembership). The record goes
 * only when no send with the key can land any more: the probe was asked INVITE_SEND_CAN_LAND_MS or more after the latest
 * send. Otherwise it stays, and the page's next try sends that same key. True when it went.
 */
export async function releaseInviteSent(notMember: NodeSaidNotMember): Promise<boolean> {
    return withStoredSlots<boolean>(({ inviteSent }) => {
        const stored = asInviteSent(inviteSent);
        if (!stored || stored.identity.publicKey !== notMember.publicKey) return { result: false };
        if (!(notMember.askedAt >= lastInviteSentAt(stored) + INVITE_SEND_CAN_LAND_MS)) return { result: false };
        return { inviteSent: 'delete', result: true };
    });
}

/**
 * The node has the key an invite was sent with as a member: it becomes this browser's identity, and the record holding
 * it goes, in one transaction, so there is never a moment with both or neither. Refused as importIdentity is
 * (IdentityHeldError, or as `options` says), and then nothing changes: the record stays, the key's only copy.
 */
export async function completeInviteSent(identity: BeanPoolIdentity, options: SaveIdentityOptions = {}): Promise<void> {
    const refused = await withStoredSlots<SaveRefusal | null>((stored) => {
        const verdict = saveVerdict(stored, identity, options);
        if (!('write' in verdict)) return { result: verdict };
        const holdsIt = asInviteSent(stored.inviteSent)?.identity.publicKey === identity.publicKey;
        return { identity: verdict.write, inviteSent: holdsIt ? 'delete' : undefined, result: null };
    });
    if (refused) throw saveRefusedError(refused);
}

/**
 * Import a pre-existing identity (from another device) and store it in IndexedDB. Refused, with nothing changed, when
 * this browser holds another account (IdentityHeldError), or as `options` says.
 */
export async function importIdentity(identity: BeanPoolIdentity, options: SaveIdentityOptions = {}): Promise<void> {
    await saveIdentity(identity, options);
}

/**
 * Would importIdentity(identity, options) be refused as things are stored now? Throws the refusal it would, and writes
 * nothing. For asking before something the save depends on is spent (an invite): the save decides again, in its own
 * transaction, so a tab that changes things in between is still refused there.
 */
export async function checkIdentitySave(identity: BeanPoolIdentity, options: SaveIdentityOptions = {}): Promise<void> {
    const refused = await withStoredSlots<SaveRefusal | null>((stored) => {
        const verdict = saveVerdict(stored, identity, options);
        return { result: 'write' in verdict ? null : verdict };
    });
    if (refused) throw saveRefusedError(refused);
}

/**
 * Permanently delete the identity (private key included) from IndexedDB.
 * Used by the "Wipe Identity" flow so the key cannot linger in the secure store
 * after the user asks for it to be destroyed. A pending join goes with it, sent or not: it holds a key and 12 words
 * too, and this is the member's own "delete everything on this device" (the one way past releaseSentPendingJoin). A
 * pending restore goes too, and so does a key an invite was sent with, for the same reason.
 */
export async function wipeIdentity(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(KEY_ID);
        store.delete(PENDING_JOIN_ID);
        store.delete(PENDING_RESTORE_ID);
        store.delete(INVITE_SENT_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    });
}

/**
 * Update the callsign on the existing identity in IndexedDB, read and written in one transaction (so it never writes
 * back an identity another tab has just signed out). Returns the updated identity, or null when there is none.
 */
export async function updateCallsign(newCallsign: string): Promise<BeanPoolIdentity | null> {
    return withStoredSlots<BeanPoolIdentity | null>(({ identity }) => {
        if (!identity) return { result: null };
        const next = { ...identity, callsign: newCallsign };
        return { identity: next, result: next };
    });
}

type SaveRefusal = { held: BeanPoolIdentity } | { sentJoin: PendingJoin };

/** What a save of `incoming` does as things are stored: saveIdentity and checkIdentitySave decide it the same way. */
function saveVerdict(stored: StoredSlots, incoming: BeanPoolIdentity, options: SaveIdentityOptions): { write: BeanPoolIdentity } | SaveRefusal {
    // The sent join first, as the page settles it first: its key may be a member, and this browser its only copy.
    const sentJoin = sentJoinToWaitFor(stored.pending, options);
    if (sentJoin) return { sentJoin };
    return identityToWrite(stored.identity, incoming);
}

function saveRefusedError(refused: SaveRefusal): Error {
    return 'held' in refused ? new IdentityHeldError(refused.held) : new SentJoinWaitingError(refused.sentJoin);
}

/**
 * Save `identity` as this browser's, unless it holds another account (IdentityHeldError), or `options` says to wait for
 * a sent join that is stored (SentJoinWaitingError). Refused, nothing changes.
 */
async function saveIdentity(identity: BeanPoolIdentity, options: SaveIdentityOptions = {}): Promise<void> {
    const refused = await withStoredSlots<SaveRefusal | null>((stored) => {
        const verdict = saveVerdict(stored, identity, options);
        return 'write' in verdict ? { identity: verdict.write, result: null } : { result: verdict };
    });
    if (refused) throw saveRefusedError(refused);
}
