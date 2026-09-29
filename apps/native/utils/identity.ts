import * as SecureStore from 'expo-secure-store';
import {
    checkOwnerWords,
    isWellFormedRecoveryPhrase,
    normaliseRecoveryWords,
    type OwnerWordsCheckResult,
} from '@beanpool/core';
import { announceAccountOnPhone } from './account-on-phone';
import { generateMnemonic, mnemonicToKeypair } from './crypto';
import {
    CANONICAL_PROFILE_STORE_KEY, IDENTITY_THIS_DEVICE_STORE_KEY, KNOCKS_STORE_KEY, PENDING_ABUSE_REPORTS_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY,
    PUSH_REGISTRATIONS_DUE_STORE_KEY,
} from './storage-keys';
import { Platform } from 'react-native';

const isWeb = Platform.OS === 'web';
const onIPhone = Platform.OS === 'ios';

const KEY_ID = 'sovereign-identity';

/**
 * How every item that holds this phone's key and its 12 words is written: readable only while the phone is unlocked, as
 * before, and never carried to another phone. On an iPhone that is the Keychain's
 * kSecAttrAccessibleWhenUnlockedThisDeviceOnly: a backup restored onto a new iPhone no longer brings the key, and the
 * member signs in there with their 12 words or their sign-in account, as on Android.
 *
 * Android has no such option (expo-secure-store ignores it there) and needs none: the item is encrypted with an Android
 * Keystore key that never leaves the phone, and expo-secure-store's backup rules leave the item out of backups.
 *
 * On an iPhone the option takes effect only when the item is made: a write over an item that is already there changes its
 * contents and keeps its old setting (expo-secure-store's update is SecItemUpdate of the data alone). An item made before
 * this build is made again, once, by {@link keepKeyOnThisPhone}.
 */
export const KEY_ITEM_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

/**
 * iPhone only: the key's copy while {@link keepKeyOnThisPhone} makes its item again. Reads fall back to it when the item is
 * missing, so a move stopped part-way (the app closed, a write failed) never leaves the phone without its key.
 */
export const KEY_ID_MOVING = 'sovereign-identity.moving';

/**
 * iPhone only: every read, write and removal of the key waits its turn, so none lands in the middle of a move (a read
 * between the item going and the item coming back must not answer "no key", and a save must not be overwritten by the
 * move's copy of the key before it). Android and the web have no move, and do what they always did.
 */
let keyItemTurn: Promise<unknown> = Promise.resolve();
function keyItemJob<T>(job: () => Promise<T>): Promise<T> {
    if (!onIPhone) return job();
    const run = keyItemTurn.then(job);
    keyItemTurn = run.catch(() => {});
    return run;
}

async function readKeyItem(): Promise<string | null> {
    return keyItemJob(async () => {
        const data = await SecureStore.getItemAsync(KEY_ID);
        if (data || !onIPhone) return data;
        return SecureStore.getItemAsync(KEY_ID_MOVING);
    });
}

async function writeKeyItem(payload: string): Promise<void> {
    await keyItemJob(() => SecureStore.setItemAsync(KEY_ID, payload, KEY_ITEM_OPTIONS));
}

async function deleteKeyItem(): Promise<void> {
    await keyItemJob(async () => {
        await SecureStore.deleteItemAsync(KEY_ID);
        // A copy left by a stopped move would otherwise bring the key back on the next read.
        if (onIPhone) await SecureStore.deleteItemAsync(KEY_ID_MOVING);
    });
}

/** Where {@link keepKeyOnThisPhone} records that it is done: AsyncStorage in the app, a map in tests. */
export interface KeyMoveRecord {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
}

/**
 * - `not-needed`: nothing to move (not an iPhone, no key, or this key's item was made this-device-only already).
 * - `moved`: the item was made again, this-device-only, and read back the same.
 * - `kept`: a step failed or couldn't be checked; the phone keeps the key it had, and the next launch tries again.
 */
export type KeyMoveOutcome = 'not-needed' | 'moved' | 'kept';

/** The public key an item holds, or null when it doesn't read as an identity. */
function publicKeyIn(item: string): string | null {
    try {
        const parsed = JSON.parse(item);
        return typeof parsed?.publicKey === 'string' && parsed.publicKey ? parsed.publicKey : null;
    } catch {
        return null;
    }
}

/** Writes `value` under `key`, this-device-only, and reads it back: true only if the same string comes back. */
async function writeAndReadBack(key: string, value: string): Promise<boolean> {
    try {
        await SecureStore.setItemAsync(key, value, KEY_ITEM_OPTIONS);
        return (await SecureStore.getItemAsync(key)) === value;
    } catch {
        return false;
    }
}

/**
 * Make an iPhone's key item this-device-only, once per key, without ever risking the key (the move behind
 * {@link KEY_ITEM_OPTIONS}). Run once at launch, after the first read (IdentityContext), never awaited by anything that
 * draws: nothing waits on it but the next read or write of the key, and it never throws.
 *
 * The Keychain keeps an item's setting on every later write, so the item has to be made again. In order:
 * 1. a copy, this-device-only, under {@link KEY_ID_MOVING}, read back the same (else it goes, and nothing else changed);
 * 2. the old item deleted, and read again to be sure it is gone (a write over one still there would keep its old setting);
 * 3. the item made again, this-device-only, and read back the same;
 * 4. the record that this key is done, then the copy removed.
 * A step that fails leaves the key readable: before step 2 in the old item, after it in the copy, which reads fall back
 * to until the next launch puts the item back from it. A launch that finds both keeps the item and drops the copy: the
 * item is never older than the copy (it is either the old item, the item made again, or a later save).
 *
 * The record is the public key moved: a new key on this phone (a restore, a new account) is moved once too. A key whose
 * item this build made is moved again once, harmlessly, because a write can't tell whether it made the item or updated it.
 */
export function keepKeyOnThisPhone(record: KeyMoveRecord): Promise<KeyMoveOutcome> {
    if (!onIPhone) return Promise.resolve('not-needed');
    return keyItemJob(() => moveKeyItem(record)).catch((): KeyMoveOutcome => 'kept');
}

async function moveKeyItem(record: KeyMoveRecord): Promise<KeyMoveOutcome> {
    const item = await SecureStore.getItemAsync(KEY_ID);
    const copy = await SecureStore.getItemAsync(KEY_ID_MOVING);

    if (!item) {
        if (!copy) return 'not-needed';
        // A move stopped after the old item went: the key is only in the copy. Put the item back from it.
        const publicKey = publicKeyIn(copy);
        if (!publicKey) return 'kept';
        if (!(await writeAndReadBack(KEY_ID, copy))) {
            // Whatever the failed write left goes, so reads keep finding the copy.
            await SecureStore.deleteItemAsync(KEY_ID).catch(() => {});
            return 'kept';
        }
        await record.setItem(IDENTITY_THIS_DEVICE_STORE_KEY, publicKey).catch(() => {});
        await SecureStore.deleteItemAsync(KEY_ID_MOVING).catch(() => {});
        return 'moved';
    }

    const publicKey = publicKeyIn(item);
    // Not an identity this build can read: left exactly as it is.
    if (!publicKey) return 'kept';
    // Left over from a move that stopped: the item is there, and never older than the copy.
    if (copy) await SecureStore.deleteItemAsync(KEY_ID_MOVING);

    if ((await record.getItem(IDENTITY_THIS_DEVICE_STORE_KEY)) === publicKey) return 'not-needed';

    // 1. The copy, proven before the item is touched.
    if (!(await writeAndReadBack(KEY_ID_MOVING, item))) {
        await SecureStore.deleteItemAsync(KEY_ID_MOVING).catch(() => {});
        return 'kept';
    }
    // 2. The old item goes, and has to be gone. If it is still there, or the phone won't say, the copy stays: reads use
    // the item while it is there and the copy if it isn't, and the next launch sorts it out.
    await SecureStore.deleteItemAsync(KEY_ID);
    if ((await SecureStore.getItemAsync(KEY_ID)) !== null) return 'kept';
    // 3. Made again. A failure leaves the key in the copy.
    if (!(await writeAndReadBack(KEY_ID, item))) {
        await SecureStore.deleteItemAsync(KEY_ID).catch(() => {});
        return 'kept';
    }
    // 4. Done.
    await record.setItem(IDENTITY_THIS_DEVICE_STORE_KEY, publicKey).catch(() => {});
    await SecureStore.deleteItemAsync(KEY_ID_MOVING).catch(() => {});
    return 'moved';
}

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
            await writeKeyItem(legacyIdentity);
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
            data = await readKeyItem();
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
 * A new Ed25519 identity from fresh 12 words, NOT saved.
 *
 * For a key that has to sign before the member has committed to anything: the global community's door
 * binds its sign-in to the joining key (utils/global-join.ts), so the key exists before the sign-in and
 * is written to the phone only when the member taps Join. `importIdentity` saves it.
 */
export async function draftIdentity(callsign = ''): Promise<BeanPoolIdentity> {
    const words = generateMnemonic();
    const { publicKeyHex, privateKeyHex } = await mnemonicToKeypair(words);
    return {
        publicKey: publicKeyHex,
        privateKey: privateKeyHex,
        callsign,
        createdAt: new Date().toISOString(),
        mnemonic: words,
    };
}

/**
 * Generate a new Ed25519 identity from a 12-word mnemonic.
 */
export async function createIdentity(callsign: string): Promise<BeanPoolIdentity> {
    const identity = await draftIdentity(callsign);
    await saveIdentity(identity);
    return identity;
}

/**
 * Take off this phone a key that no community ever accepted, and only if it is the key stored here.
 *
 * For one caller: the global community's join, when its door refuses for good a key that same join made
 * (the sign-in already has an account there, or the door is shut). The member never saw its words and no
 * node knows it. Left behind, it would be the phone's "account": restoring the member's real one would
 * then ask them to replace it, under a name they chose a minute ago. Returns whether a key was removed.
 */
export async function discardUnjoinedIdentity(publicKey: string): Promise<boolean> {
    const stored = await loadIdentity();
    if (!stored || !publicKey || stored.publicKey !== publicKey) return false;
    if (isWeb) {
        localStorage.removeItem(KEY_ID);
    } else {
        await deleteKeyItem();
    }
    announceAccountOnPhone(null);
    return true;
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
 * Are these typed words this phone's account's? The one check behind both places a member types their 12 words:
 * the owners' "Check your 12 words" (owner-words.ts `checkMyWords`) and "Add your 12 words to this phone"
 * ({@link addMnemonicToIdentity}), so the two can never give a member two answers.
 *
 * It is @beanpool/core `checkOwnerWords`, which decides with `recoveryWordsMatchPublicKey` (12 listed words whose
 * key has this account's public key: the comparison a sign-in restore and enrolment make too), then checks that
 * the key this phone signs with is the same account's and that the words open a sealed envelope on this device.
 *
 * Reads only the public key and the stored key, never the stored `mnemonic`: a phone that holds the words cannot
 * pass by comparing them with themselves. The words are never sent, stored or logged here.
 */
export function checkWordsForAccount(
    typed: string | readonly string[],
    identity: Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>,
): Promise<OwnerWordsCheckResult> {
    return checkOwnerWords(normaliseRecoveryWords(typed), { publicKeyHex: identity.publicKey, privateKey: identity.privateKey });
}

export type AddMnemonicResult =
    | { ok: true; identity: BeanPoolIdentity }
    | { ok: false; reason: 'no-identity' | 'has-words' | 'malformed' | 'mismatch' };

/**
 * Put the 12 words back on a phone that has the key but not the words ("Add your 12 words", Settings, and
 * "Save them on this phone" after the owners' check).
 *
 * A phone restored with a sign-in before the sign-in copy carried the words has none, and they can't be
 * rebuilt from the key. The member who has them written down types them; they are kept only if
 * {@link checkWordsForAccount} says they are this account's. Otherwise nothing is written. Nothing is sent
 * anywhere, and the words are never logged.
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
    if (!(await checkWordsForAccount(typed, identity)).matches) return { ok: false, reason: 'mismatch' };
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

/**
 * Every write of the phone's key comes through here, and announces the key the phone now holds (account-on-phone.ts):
 * what the phone keeps per account (blocklist.ts) follows it without a restart.
 */
async function saveIdentity(identity: BeanPoolIdentity): Promise<void> {
    const payload = JSON.stringify(identity);
    if (isWeb) {
        localStorage.setItem(KEY_ID, payload);
    } else {
        await writeKeyItem(payload);
    }
    announceAccountOnPhone(identity.publicKey);
}

interface WipeableStorage {
    getAllKeys(): Promise<readonly string[]>;
    multiRemove(keys: string[]): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/**
 * AsyncStorage state that belongs to the identity being wiped. Guest markers record which nodes
 * THIS key joined as a guest; left behind, a fresh identity inherits them and a real 'stranger'
 * result on those nodes is treated as guest mode. The communities this key asked to join (utils/knock.ts)
 * tie the key to places near where the member lives, so they go too (#1179 review 4109868126).
 *
 * So does the member's profile: the one profile copy (canonical-profile.ts: photo, bio, contact) and a
 * photo parked for the next sync with the flag that sends it (avatar-value.ts). None of them is keyed to
 * the account, and the next account's profile publish (db.ts `pushProfileToServer`) and its knocks
 * (find-community.tsx) fall back on them: left behind, they would go out under the new key. The invite
 * codes this key made (people.tsx) name who the member invited; the node keeps them, so the list comes back.
 * So does an unfinished post (map.tsx `OFFER_DRAFT_KEY`: its words, photos and map pin). It is kept per
 * community, not per account, so the next account there would be offered it to finish and post as its own
 * (PR #1183 review 4110094960).
 * And so does the one phone-wide queue of offline reports older builds kept (blocklist.ts moves the account's
 * own reports out of it first). A node files a report as whoever signs it, whatever reporter the body names.
 * And the record of where the phone sent its push token for this key (push-registrations.ts): the account
 * leaving the phone has already unregistered there (account-leaves-phone.ts), and the next account starts its own.
 * So do its registrations still due, which its leave has already dropped: none is ever tried for another key.
 *
 * `beanpool_saved_nodes` stays on purpose: it is a list of community addresses, not anything about
 * who the member is.
 *
 * The account's block list and its own queue of offline reports stay too, under its own key (storage-keys.ts
 * `blockedUsersStoreKey`, `pendingAbuseReportsStoreKey`): restoring the same account here brings its blocks back, and
 * no other account reads them or sends those reports (Marty, 2026-09-27: the list is the account's).
 */
export async function wipeIdentityScopedStorage(storage: WipeableStorage): Promise<void> {
    await storage.removeItem('beanpool_anchor_url');
    await storage.removeItem('beanpool:identity');
    await storage.removeItem('beanpool_guest_nodes');
    await storage.removeItem(KNOCKS_STORE_KEY);
    await storage.removeItem(CANONICAL_PROFILE_STORE_KEY);
    await storage.removeItem('pending_profile_avatar');
    await storage.removeItem('pending_profile_sync');
    await storage.removeItem('beanpool_offer_draft');
    await storage.removeItem(PENDING_ABUSE_REPORTS_STORE_KEY);
    await storage.removeItem(PUSH_REGISTERED_AT_STORE_KEY);
    await storage.removeItem(PUSH_REGISTRATIONS_DUE_STORE_KEY);

    const allKeys = await storage.getAllKeys();
    const accountKeys = allKeys.filter((k: string) =>
        k.startsWith('pillar_sync_') || k.startsWith('pillar:') || k.startsWith('bp_offline_invites_'));
    if (accountKeys.length > 0) {
        await storage.multiRemove(accountKeys);
    }
}

/** Take the key off this phone, and nothing else. {@link wipeIdentity} is the whole wipe. */
export async function removeStoredIdentity(): Promise<void> {
    if (isWeb) {
        localStorage.removeItem(KEY_ID);
    } else {
        await deleteKeyItem();
    }
    announceAccountOnPhone(null);
}

export async function wipeIdentity(): Promise<void> {
    await removeStoredIdentity();

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
