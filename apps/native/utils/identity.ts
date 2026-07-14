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
        
        const { getDb } = require('./db');
        const db = await getDb();
        if (db) {
            await db.execAsync('DELETE FROM messages; DELETE FROM conversations; DELETE FROM posts; DELETE FROM projects;');
        }
    } catch (e) {
        console.error('Failed to fully wipe native identity state', e);
    }
}
