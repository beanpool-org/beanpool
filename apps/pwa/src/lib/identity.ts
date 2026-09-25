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
}

/** Keep `pending` as the one pending join, in place of any other. */
export async function savePendingJoin(pending: PendingJoin): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(pending, PENDING_JOIN_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/** The pending join, or null. One past its `expiresAt` is dropped on sight and never returned. */
export async function loadPendingJoin(now: number = Date.now()): Promise<PendingJoin | null> {
    const db = await openDb();
    const pending = await new Promise<PendingJoin | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(PENDING_JOIN_ID);
        req.onsuccess = () => resolve((req.result as PendingJoin | undefined) ?? null);
        req.onerror = () => reject(req.error);
    });
    if (!pending) return null;
    if (!(typeof pending.expiresAt === 'number' && pending.expiresAt > now) || !pending.identity?.privateKey) {
        await clearPendingJoin();
        return null;
    }
    return pending;
}

export async function clearPendingJoin(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(PENDING_JOIN_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * The node said yes: `identity` becomes this browser's identity and the pending join goes, in one transaction, so
 * there is never a moment with both or neither.
 */
export async function completePendingJoin(identity: BeanPoolIdentity): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(identity, KEY_ID);
        store.delete(PENDING_JOIN_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

/**
 * Import a pre-existing identity (from another device) and store it in IndexedDB.
 * Overwrites any existing identity.
 */
export async function importIdentity(identity: BeanPoolIdentity): Promise<void> {
    await saveIdentity(identity);
}

/**
 * Permanently delete the identity (private key included) from IndexedDB.
 * Used by the "Wipe Identity" flow so the key cannot linger in the secure store
 * after the user asks for it to be destroyed. A pending join goes with it: it holds a key and 12 words too.
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
    });
}

/**
 * Update the callsign on the existing identity in IndexedDB.
 * Returns the updated identity.
 */
export async function updateCallsign(newCallsign: string): Promise<BeanPoolIdentity | null> {
    const identity = await loadIdentity();
    if (!identity) return null;
    identity.callsign = newCallsign;
    await saveIdentity(identity);
    return identity;
}

async function saveIdentity(identity: BeanPoolIdentity): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(identity, KEY_ID);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
