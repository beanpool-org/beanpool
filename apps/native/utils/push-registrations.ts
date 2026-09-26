/**
 * Where this phone sent its push token for the account on it.
 *
 * The token lets whoever holds it push to this phone, and every community it is sent to keeps it. So the phone sends it
 * only where the account's alerts come from: the community the phone is set to when the app registers
 * (services/push-notifications.ts). Each community goes on the record before the request goes out, so a node that took
 * the token but whose answer never arrived is on it too. As the account leaves the phone, only the communities on the
 * record are asked to drop the token (account-leaves-phone.ts): one this phone never sent it to is never sent it
 * (#1184 review 4110460184). The record goes with the account (identity.ts `wipeIdentityScopedStorage`).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { PUSH_REGISTERED_AT_STORE_KEY } from './storage-keys';

const PUSH_TOKENS_PATH = '/api/push-tokens';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** How long a registration may take, as other signed requests (db.ts `signedRequest`). */
const REGISTER_TIMEOUT_MS = 12000;

type RegisteringAccount = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

/** A community's address as the phone sends to it: trimmed, no trailing slash. Null for anything but an http(s) address. */
export function communityAddress(raw: unknown): string | null {
    if (typeof raw !== 'string' || !/^https?:\/\/\S+$/i.test(raw.trim())) return null;
    return raw.trim().replace(/\/+$/, '');
}

function parseRecord(raw: string | null): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(communityAddress).filter((c): c is string => c !== null))];
}

/** The communities this phone sent its push token to for the account on it, each once. Reads only; never throws. */
export async function pushRegisteredCommunities(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<string[]> {
    try {
        return parseRecord(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY));
    } catch {
        return [];
    }
}

/**
 * Forget where this phone sent its push token, once the account leaving it has unregistered there
 * (account-leaves-phone.ts). Never throws: the record goes with the account's app storage too.
 */
export async function forgetPushRegistrations(storage: Pick<Storage, 'removeItem'> = AsyncStorage): Promise<void> {
    try {
        await storage.removeItem(PUSH_REGISTERED_AT_STORE_KEY);
    } catch (e) {
        console.warn('[Push] Could not forget where this phone sent its token', e);
    }
}

async function recordPushRegistration(community: string, storage: Pick<Storage, 'getItem' | 'setItem'>): Promise<void> {
    // A read that fails throws here, so the record is never overwritten with this community alone.
    const recorded = parseRecord(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY));
    if (recorded.includes(community)) return;
    await storage.setItem(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([...recorded, community]));
}

/**
 * Register this phone's push token for `account` with the community the phone is set to, signed by the account's key,
 * after putting that community on the record. False, with nothing sent, when the phone is set to no community. Throws
 * when the node can't be reached, refuses or doesn't answer within `timeoutMs`; the community stays on the record.
 *
 * A record that can't be written is logged and the token still goes: the account's recovery alerts matter more than
 * this phone remembering to unregister there later.
 */
export async function registerPushTokenWithCommunity(
    account: RegisteringAccount,
    token: string,
    platform: string,
    timeoutMs: number = REGISTER_TIMEOUT_MS,
    storage: Pick<Storage, 'getItem' | 'setItem'> = AsyncStorage,
): Promise<boolean> {
    const community = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    if (!community) return false;
    try {
        await recordPushRegistration(community, storage);
    } catch (e) {
        console.warn(`[Push] Could not record that this phone's token goes to ${community}`, e);
    }

    const body = JSON.stringify({ publicKey: account.publicKey, token, platform });
    const headers = await buildSignedHeaders('POST', PUSH_TOKENS_PATH, body, account.privateKey, account.publicKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(`${community}${PUSH_TOKENS_PATH}`, { method: 'POST', headers, body, signal: controller.signal });
        if (!res.ok) throw new Error(`${community} did not register this phone (${res.status})`);
    } finally {
        clearTimeout(timer);
    }
    return true;
}
