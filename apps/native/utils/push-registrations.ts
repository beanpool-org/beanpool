/**
 * Where this phone sent its push token for the account on it.
 *
 * The token lets whoever holds it push to this phone, and every community it is sent to keeps it. So the phone sends it
 * only where the account's alerts come from: the community the phone is set to when the app registers
 * (services/push-notifications.ts). Each community goes on the record before the request goes out, so a node that took
 * the token but whose answer never arrived is on it too. As the account leaves the phone, only the communities on the
 * record are asked to drop the token (account-leaves-phone.ts): one this phone never sent it to is never sent it
 * (#1184 review 4110460184). The record goes with the account (identity.ts `wipeIdentityScopedStorage`).
 *
 * Each registration carries the phone's push stamp ({@link nextPushStamp}), and so does each leave (push-leave.ts): a
 * community removes a leaving account's registration only when it is not later than the leave, so the same account
 * signing back in on this phone is never undone by an older leave. And once an account starts leaving this phone
 * ({@link stopRegistering}), nothing registers for its key until that key is written to the phone again, and a
 * registration already on its way is waited for, so it can't land after the leave. When it is written to the phone
 * again, the leave statements it made here are taken back and their communities come back on the record
 * ({@link putBackOnRecord}, push-leave.ts).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { onAccountOnPhone } from './account-on-phone';
import { buildSignedHeaders } from './crypto';
import type { BeanPoolIdentity } from './identity';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_STAMP_STORE_KEY } from './storage-keys';

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

let recordWrites: Promise<unknown> = Promise.resolve();

/** Change the record after any change already under way: a registration and a sign-in's take-back write it together. */
function changeRecord(change: () => Promise<void>): Promise<void> {
    const next = recordWrites.then(change);
    recordWrites = next.catch(() => {});
    return next;
}

/**
 * The communities this phone sent its push token to for the account on it, each once, after any change under way.
 * Reads only; never throws.
 */
export async function pushRegisteredCommunities(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<string[]> {
    try {
        await recordWrites;
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
        await changeRecord(() => storage.removeItem(PUSH_REGISTERED_AT_STORE_KEY));
    } catch (e) {
        console.warn('[Push] Could not forget where this phone sent its token', e);
    }
}

/**
 * Put `communities` back on the record: the account on the phone took back its leave statements for them
 * (push-leave.ts), and its registration from before may still be at each. Its next leave goes there too. Throws when the
 * record can't be read or written, and then it is left as it was.
 */
export function putBackOnRecord(communities: readonly string[], storage: Pick<Storage, 'getItem' | 'setItem'> = AsyncStorage): Promise<void> {
    return changeRecord(() => addToRecord(communities, storage));
}

// ── The push stamp ──────────────────────────────────────────────────────────────────────────────────────────────

type StampCopy = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The stamp's second copy, in SecureStore beside the phone's key and its push token. A stamp handed out while the clock
 * ran ahead keeps every later one ahead, and a community takes them (it never compares a stamp with its own clock). An
 * iOS reinstall keeps the keychain and clears app storage: with the stamp in app storage alone, the same key's next
 * leave could be stamped earlier than a registration it made before, and remove nothing (#1258, deciding pass).
 */
const besideTheKey: StampCopy = {
    getItem: (key) => SecureStore.getItemAsync(key),
    setItem: (key, value) => SecureStore.setItemAsync(key, value),
};

let lastStamp = 0;
let stampQueue: Promise<unknown> = Promise.resolve();

/**
 * The next push stamp: later than every one this phone gave before, whatever its clock does since (the clock, else
 * one past the last), and written down before it is returned, so no request carries a stamp the phone could hand out
 * again after a restart. Kept twice, in `storage` and beside the key ({@link besideTheKey}), and the later copy
 * counts: it is lost only with the key, and then the key signs nothing here anyway. One at a time. Compared by a
 * community only with this phone's other stamps, never with its own clock. A copy that can't be read or written is
 * logged and the stamp still used: this run keeps counting up from it.
 */
export function nextPushStamp(storage: StampCopy = AsyncStorage, keyStore: StampCopy = besideTheKey): Promise<number> {
    const next = stampQueue.then(async () => {
        let stored = 0;
        for (const copy of [storage, keyStore]) {
            try {
                const n = Number(await copy.getItem(PUSH_STAMP_STORE_KEY));
                if (Number.isSafeInteger(n) && n > stored) stored = n;
            } catch (e) {
                console.warn('[Push] Could not read a copy of the last push stamp', e);
            }
        }
        const stamp = Math.max(Date.now(), lastStamp + 1, stored + 1);
        lastStamp = stamp;
        for (const copy of [keyStore, storage]) {
            try {
                await copy.setItem(PUSH_STAMP_STORE_KEY, String(stamp));
            } catch (e) {
                console.warn('[Push] Could not write a copy of the push stamp down', e);
            }
        }
        return stamp;
    });
    stampQueue = next.catch(() => {});
    return next;
}

// ── An account leaving ──────────────────────────────────────────────────────────────────────────────────────────

/** The keys leaving this phone; `gone` once the phone has announced another key, or none, since. */
const leaving = new Map<string, { gone: boolean }>();
/** Registrations on their way, and the key each is for. */
const inFlight = new Map<Promise<unknown>, string>();

// A leaving key registers again only once it is written to the phone again after another, or none: a sign-in, on purpose.
// A name change during the leave announces the same key and changes nothing (account-on-phone.ts).
onAccountOnPhone((publicKey) => {
    const now = publicKey?.toLowerCase() ?? null;
    for (const [key, state] of leaving) {
        if (now !== key) state.gone = true;
        else if (state.gone) leaving.delete(key);
    }
});

/**
 * Where `publicKey` stands in leaving this phone: 'leaving' from the start of its leave ({@link stopRegistering}) until
 * the phone holds another key or none, then 'left' until the key is written to the phone again, then 'none' again.
 */
export function leaveState(publicKey: string): 'none' | 'leaving' | 'left' {
    const state = leaving.get(publicKey.toLowerCase());
    return !state ? 'none' : state.gone ? 'left' : 'leaving';
}

/**
 * An account starts leaving this phone (account-leaves-phone.ts): from now on no registration goes out for
 * `publicKey`, until that key is written to the phone again after another or none. Resolves once each registration for
 * it that had already gone out has finished (answered, refused or given up, within its own timeout), so the leave that
 * follows reaches the community after it. Never throws.
 */
export async function stopRegistering(publicKey: string): Promise<void> {
    const key = publicKey.toLowerCase();
    leaving.set(key, { gone: false });
    await Promise.allSettled([...inFlight].filter(([, k]) => k === key).map(([request]) => request));
}

async function addToRecord(communities: readonly string[], storage: Pick<Storage, 'getItem' | 'setItem'>): Promise<void> {
    // A read that fails throws here, so the record is never overwritten with these communities alone.
    const recorded = parseRecord(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY));
    const added = [...new Set(communities.map(communityAddress).filter((c): c is string => c !== null && !recorded.includes(c)))];
    if (added.length === 0) return;
    await storage.setItem(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify([...recorded, ...added]));
}

function recordPushRegistration(community: string, storage: Pick<Storage, 'getItem' | 'setItem'>): Promise<void> {
    return changeRecord(() => addToRecord([community], storage));
}

/**
 * Register this phone's push token for `account` with the community the phone is set to, signed by the account's key,
 * after putting that community on the record, with a fresh push stamp. False, with nothing sent, when the phone is set
 * to no community or the account is leaving the phone ({@link stopRegistering}). Throws when the node can't be reached,
 * refuses or doesn't answer within `timeoutMs`; the community stays on the record.
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
    const key = account.publicKey.toLowerCase();
    const community = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    if (!community || isLeaving(key)) return false;
    try {
        await recordPushRegistration(community, storage);
    } catch (e) {
        console.warn(`[Push] Could not record that this phone's token goes to ${community}`, e);
    }

    const registeredAt = await nextPushStamp(storage);
    const body = JSON.stringify({ publicKey: account.publicKey, token, platform, registeredAt });
    const url = `${community}${PUSH_TOKENS_PATH}`;
    const headers = await buildSignedHeaders('POST', url, body, account.privateKey, account.publicKey);
    // The last look before the request goes out, with nothing awaited between it and the fetch: a leave that began
    // meanwhile stops this one here, or finds it on its way and waits for it.
    if (isLeaving(key)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    inFlight.set(request, key);
    try {
        const res = await request;
        if (!res.ok) throw new Error(`${community} did not register this phone (${res.status})`);
    } finally {
        inFlight.delete(request);
        clearTimeout(timer);
    }
    return true;
}

function isLeaving(key: string): boolean {
    if (!leaving.has(key)) return false;
    console.log('[Push] This account is leaving the phone: its token is not registered');
    return true;
}
