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

/** What the two slots hold, read inside the transaction that may write them. */
interface StoredSlots {
    identity: BeanPoolIdentity | undefined;
    pending: PendingJoin | undefined;
}

/** What to write back: a slot left out is left as it is. */
interface SlotWrites<T> {
    identity?: BeanPoolIdentity;
    pending?: PendingJoin | 'delete';
    result: T;
}

/**
 * Read both slots and decide what to write, in one readwrite transaction: `decide` sees what is stored at that moment,
 * never a tab's copy, and nothing else can write between its reading and its writing. Every write to either slot but
 * wipeIdentity's goes through here.
 */
async function withStoredSlots<T>(decide: (stored: StoredSlots) => SlotWrites<T>): Promise<T> {
    const db = await openDb();
    let result: T | undefined;
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        // Both asked at once: requests answer in order, so the second answer comes with the first already in.
        const identityReq = store.get(KEY_ID);
        const pendingReq = store.get(PENDING_JOIN_ID);
        pendingReq.onsuccess = () => {
            const decision = decide({
                identity: (identityReq.result ?? undefined) as BeanPoolIdentity | undefined,
                pending: (pendingReq.result ?? undefined) as PendingJoin | undefined,
            });
            if (decision.identity) store.put(decision.identity, KEY_ID);
            if (decision.pending === 'delete') store.delete(PENDING_JOIN_ID);
            else if (decision.pending) store.put(decision.pending, PENDING_JOIN_ID);
            result = decision.result;
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
 * Refused, with nothing saved, when this browser holds another account (IdentityHeldError).
 */
export async function createIdentity(callsign: string): Promise<BeanPoolIdentity> {
    const identity = await generateIdentity(callsign);
    await saveIdentity(identity);
    return identity;
}

/** A new identity and its 12 words, made exactly as createIdentity makes them, but saved nowhere. */
export async function generateIdentity(callsign: string): Promise<BeanPoolIdentity> {
    return identityFromMnemonic(generateMnemonic(), callsign);
}

/**
 * Recover identity from a 12-word mnemonic phrase.
 * Derives the same keypair deterministically.
 * Refused, with nothing saved, when this browser holds another account (IdentityHeldError).
 */
export async function createIdentityFromMnemonic(words: string[], callsign: string): Promise<BeanPoolIdentity> {
    const identity = await identityFromMnemonic(words, callsign);
    await saveIdentity(identity);
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

/**
 * Mark `pending` sent at `at`, before its join goes. If a join with this key was already out and unsettled (in the
 * store, or in this copy), that one may still land, and is remembered as `earlierSentAt`. Refused like
 * savePendingJoin when another key's sent join holds the slot. Returns what was stored.
 */
export async function markPendingJoinSent(pending: PendingJoin, at: number = Date.now()): Promise<PendingJoin> {
    const out = await withStoredPendingJoin<{ saved: PendingJoin } | { held: PendingJoin }>((current) => {
        if (isSent(current) && current.identity.publicKey !== pending.identity.publicKey) return { result: { held: current } };
        const earlier = [current && isSent(current) ? lastSentAt(current) : null, pendingJoinSent(pending) ? lastSentAt(pending) : null]
            .filter((t): t is number => t !== null);
        const next: PendingJoin = { ...withoutSentMark(pending), sentAt: at };
        // NaN (a time that cannot be read) wins, so such a join is never judged unable to land.
        if (earlier.length) next.earlierSentAt = earlier.some(Number.isNaN) ? Number.NaN : Math.max(...earlier);
        return { write: next, result: { saved: next } };
    });
    if ('held' in out) throw new PendingJoinHeldError(out.held);
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

/**
 * Import a pre-existing identity (from another device) and store it in IndexedDB. Refused, with nothing changed, when
 * this browser holds another account (IdentityHeldError).
 */
export async function importIdentity(identity: BeanPoolIdentity): Promise<void> {
    await saveIdentity(identity);
}

/**
 * Permanently delete the identity (private key included) from IndexedDB.
 * Used by the "Wipe Identity" flow so the key cannot linger in the secure store
 * after the user asks for it to be destroyed. A pending join goes with it, sent or not: it holds a key and 12 words
 * too, and this is the member's own "delete everything on this device" (the one way past releaseSentPendingJoin).
 */
export async function wipeIdentity(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(KEY_ID);
        store.delete(PENDING_JOIN_ID);
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

/** Save `identity` as this browser's, unless it holds another account (IdentityHeldError, nothing changed). */
async function saveIdentity(identity: BeanPoolIdentity): Promise<void> {
    const held = await withStoredSlots<BeanPoolIdentity | null>(({ identity: stored }) => {
        const next = identityToWrite(stored, identity);
        return 'held' in next ? { result: next.held } : { identity: next.write, result: null };
    });
    if (held) throw new IdentityHeldError(held);
}
