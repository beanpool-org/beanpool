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
 * Generate a new Ed25519 identity from a 12-word mnemonic.
 * Returns the identity AND the mnemonic (for one-time display).
 */
export async function createIdentity(callsign: string): Promise<BeanPoolIdentity> {
    const words = generateMnemonic();
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);

    const identity: BeanPoolIdentity = {
        publicKey: publicKeyHex,
        privateKey: privateKeyHex,
        callsign,
        createdAt: new Date().toISOString(),
        mnemonic: words,
    };

    await saveIdentity(identity);
    return identity;
}

/**
 * Recover identity from a 12-word mnemonic phrase.
 * Derives the same keypair deterministically.
 */
export async function createIdentityFromMnemonic(words: string[], callsign: string): Promise<BeanPoolIdentity> {
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);

    const identity: BeanPoolIdentity = {
        publicKey: publicKeyHex,
        privateKey: privateKeyHex,
        callsign,
        createdAt: new Date().toISOString(),
        mnemonic: words,
    };

    await saveIdentity(identity);
    return identity;
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
 * after the user asks for it to be destroyed.
 */
export async function wipeIdentity(): Promise<void> {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(KEY_ID);
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
