import * as SecureStore from 'expo-secure-store';
import {
    isWellFormedRecoveryPhrase,
    normaliseRecoveryWords,
    recoveryWordsMatchPublicKey,
} from '@beanpool/core';
import { generateMnemonic, mnemonicToKeypair } from './crypto';
import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';

const KEY_ID = 'sovereign-identity';

export interface BeanPoolIdentity {
    publicKey: string;    // Hex-encoded Ed25519 public key
    privateKey: string;   // Hex-encoded Ed25519 private key (never leaves device)
    callsign: string;     // Human-readable name
    createdAt: string;
    mnemonic?: string[];  // 12-word recovery phrase (optional for legacy identities)
}

async function migrateLegacyIdentity(): Promise<void> {
    if (isWeb) return;
    try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const legacyIdentity = await AsyncStorage.getItem('beanpool:identity');
        if (legacyIdentity) {
            await SecureStore.setItemAsync(KEY_ID, legacyIdentity);
            await AsyncStorage.removeItem('beanpool:identity');
            console.log('Successfully migrated legacy identity to SecureStore');
        }
    } catch (e) {
        console.error('Failed to migrate legacy identity', e);
    }
}

export async function loadIdentity(): Promise<BeanPoolIdentity | null> {
    try {
        await migrateLegacyIdentity();
        let data: string | null = null;
        if (isWeb) {
            data = localStorage.getItem(KEY_ID);
        } else {
            data = await SecureStore.getItemAsync(KEY_ID);
        }
        if (!data) return null;
        return JSON.parse(data);
    } catch (e) {
        console.error('Failed to load identity from Store', e);
        return null;
    }
}

/**
 * The one way to read a user's recovery words.
 *
 * Today it returns `identity.mnemonic` and nothing more, which is the whole point: every
 * screen that shows the words goes through one function BEFORE that function has anything
 * interesting to do. When the encrypted vault lands (Phase C) this is where it is read
 * from and where the biometric prompt happens, and no caller changes. Doing it in the
 * other order would mean editing every one of these screens while also introducing a
 * vault, and the plaintext fallback here is what keeps existing users working while the
 * long tail migrates (Part 8).
 *
 * Async now, though it needs to be, so that callers are already awaiting by the time the
 * vault makes it genuinely async. Returns null rather than throwing for a legacy identity
 * with no words — every caller already has to render that case.
 */
export async function getMnemonic(identity: BeanPoolIdentity | null | undefined): Promise<string[] | null> {
    if (!identity) return null;
    const words = identity.mnemonic;
    return words && words.length > 0 ? words : null;
}

/**
 * Does this identity have recovery words at all — without reading them.
 *
 * Several screens only ask the yes/no question: whether to offer a "show my words" button,
 * whether this is a legacy identity predating seed phrases. Those are guards on render
 * paths, and making them await would hand every one of them a null first frame — enough,
 * in the onboarding flow, to bounce someone to the wrong screen for a tick.
 *
 * So it stays synchronous, and can: whether words exist is not itself a secret. After the
 * vault lands this consults a non-secret marker instead of the field, and still answers
 * without a biometric prompt — which is the behaviour you want anyway, since asking for a
 * fingerprint to decide whether to draw a button would be absurd.
 */
export function hasMnemonic(identity: BeanPoolIdentity | null | undefined): identity is BeanPoolIdentity {
    return !!identity?.mnemonic && identity.mnemonic.length > 0;
}

/**
 * Generate a new Ed25519 identity from a 12-word mnemonic.
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
 * Import a pre-existing identity (from another device).
 */
export async function importIdentity(identity: BeanPoolIdentity): Promise<void> {
    await saveIdentity(identity);
}

export type AddMnemonicResult =
    | { ok: true; identity: BeanPoolIdentity }
    | { ok: false; reason: 'no-identity' | 'has-words' | 'malformed' | 'mismatch' };

/**
 * Put the 12 words back on a phone that has the key but not the words ("Add your 12 words", Settings).
 *
 * A phone restored with a sign-in before the sign-in copy carried the words has none, and they can't be
 * rebuilt from the key. The member who has them written down types them; they are kept only if they are
 * 12 listed words that make THIS account's public key (compared by public key: the stored private key may
 * be raw or PKCS8). Otherwise nothing is written. Nothing is sent anywhere, and the words are never logged.
 *
 * Refuses a phone that already has words: this adds words that are missing, it never replaces any.
 */
export async function addMnemonicToIdentity(typed: string | readonly string[]): Promise<AddMnemonicResult> {
    const identity = await loadIdentity();
    if (!identity) return { ok: false, reason: 'no-identity' };
    // Through a plain boolean: hasMnemonic is a type guard, and its false branch would narrow `identity` to never.
    const alreadyHasWords: boolean = hasMnemonic(identity);
    if (alreadyHasWords) return { ok: false, reason: 'has-words' };
    if (!isWellFormedRecoveryPhrase(typed)) return { ok: false, reason: 'malformed' };
    if (!recoveryWordsMatchPublicKey(typed, identity.publicKey)) return { ok: false, reason: 'mismatch' };
    const updated: BeanPoolIdentity = { ...identity, mnemonic: normaliseRecoveryWords(typed) };
    await saveIdentity(updated);
    return { ok: true, identity: updated };
}

/**
 * Update the callsign on the existing identity.
 */
export async function updateCallsign(newCallsign: string): Promise<BeanPoolIdentity | null> {
    const identity = await loadIdentity();
    if (!identity) return null;
    identity.callsign = newCallsign;
    await saveIdentity(identity);
    return identity;
}

async function saveIdentity(identity: BeanPoolIdentity): Promise<void> {
    const payload = JSON.stringify(identity);
    if (isWeb) {
        localStorage.setItem(KEY_ID, payload);
    } else {
        await SecureStore.setItemAsync(KEY_ID, payload);
    }
}

interface WipeableStorage {
    getAllKeys(): Promise<readonly string[]>;
    multiRemove(keys: string[]): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * AsyncStorage state that belongs to the identity being wiped. Guest markers record which nodes
 * THIS key joined as a guest; left behind, a fresh identity inherits them and a real 'stranger'
 * result on those nodes is treated as guest mode. `beanpool_saved_nodes` stays on purpose: it is
 * a list of community addresses, not anything about who the member is.
 */
export async function wipeIdentityScopedStorage(storage: WipeableStorage): Promise<void> {
    await storage.removeItem('beanpool_anchor_url');
    await storage.removeItem('beanpool:identity');
    await storage.removeItem('beanpool_guest_nodes');

    const allKeys = await storage.getAllKeys();
    const syncKeys = allKeys.filter((k: string) => k.startsWith('pillar_sync_') || k.startsWith('pillar:'));
    if (syncKeys.length > 0) {
        await storage.multiRemove(syncKeys);
    }
}

export async function wipeIdentity(): Promise<void> {
    if (isWeb) {
        localStorage.removeItem(KEY_ID);
    } else {
        await SecureStore.deleteItemAsync(KEY_ID);
    }

    // A wiped device has no half-finished join wizard to resume.
    try {
        const { clearPendingOnboarding } = require('./onboarding-state');
        await clearPendingOnboarding();
    } catch {}

    try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await wipeIdentityScopedStorage(AsyncStorage);

        const { getDb } = require('./db');
        const db = await getDb();
        if (db) {
            await db.execAsync('DELETE FROM messages; DELETE FROM conversations; DELETE FROM posts; DELETE FROM projects;');
        }
    } catch (e) {
        console.error('Failed to fully wipe native identity state', e);
    }
}
