import * as SecureStore from 'expo-secure-store';
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
        const allKeys = await AsyncStorage.getAllKeys();
        const syncKeys = allKeys.filter((k: string) => k.startsWith('pillar_sync_') || k.startsWith('pillar:'));
        if (syncKeys.length > 0) {
            await AsyncStorage.multiRemove(syncKeys);
        }
        
        await AsyncStorage.removeItem('beanpool_anchor_url');
        await AsyncStorage.removeItem('beanpool:identity');
        
        const { getDb } = require('./db');
        const db = await getDb();
        if (db) {
            await db.execAsync('DELETE FROM messages; DELETE FROM conversations; DELETE FROM posts; DELETE FROM projects;');
        }
    } catch (e) {
        console.error('Failed to fully wipe native identity state', e);
    }
}
