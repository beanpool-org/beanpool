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
 *
 * A registration that doesn't land (no connection, no answer within its timeout, an error, or no push token to be had
 * yet) stays due, written down so it outlives a restart, and is tried again as the app comes back and with the 5-minute
 * sync until it lands ({@link retryDueRegistrations}). Before, it waited for the app's next cold start, and a member who
 * signed in on a poor connection got no alerts, recovery alerts included, until then (#1258 confirmation 5859456754).
 * A community that answered with an error or not at all is left alone for a while, longer after each such answer in a
 * row. A retry is a registration like any other ({@link registerPushTokenWithCommunity}), and what is due for a key goes
 * as that key starts leaving the phone.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { onAccountOnPhone } from './account-on-phone';
import { buildSignedHeaders } from './crypto';
import { loadIdentity, type BeanPoolIdentity } from './identity';
import { PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY, PUSH_STAMP_STORE_KEY } from './storage-keys';

const PUSH_TOKENS_PATH = '/api/push-tokens';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** How long a registration may take, as other signed requests (db.ts `signedRequest`). */
const REGISTER_TIMEOUT_MS = 12000;
/** How long a community that refused a registration, or never answered it, is left alone before the next try. */
export const RETRY_FIRST_WAIT_MS = 60 * 1000;
/** The longest it is left alone: the wait doubles with each refusal in a row, up to this. */
export const RETRY_LONGEST_WAIT_MS = 60 * 60 * 1000;

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
 * follows reaches the community after it, and the registrations still due for it are dropped: none is tried again
 * ({@link retryDueRegistrations}). Never throws.
 */
export async function stopRegistering(publicKey: string, storage: Storage = AsyncStorage): Promise<void> {
    const key = publicKey.toLowerCase();
    leaving.set(key, { gone: false });
    await Promise.allSettled([...inFlight].filter(([, k]) => k === key).map(([request]) => request));
    try {
        await changeDue(storage, (due) => due.filter((d) => d.publicKey !== key));
    } catch (e) {
        console.warn('[Push] Could not drop the registrations still due for an account leaving the phone', e);
    }
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

// ── Registrations still due ─────────────────────────────────────────────────────────────────────────────────────

/** A registration the account on the phone still needs at one community. */
interface DueRegistration {
    /** The account's key, lower-case hex. */
    publicKey: string;
    community: string;
    /** How many times in a row the community refused it or never answered. */
    refusals: number;
    /** Not tried again before this (ms since the epoch); 0 for the next chance. */
    retryAt: number;
}

function isDueRegistration(d: unknown): d is DueRegistration {
    if (!d || typeof d !== 'object') return false;
    const o = d as Record<string, unknown>;
    return typeof o.publicKey === 'string' && /^[0-9a-f]{64}$/.test(o.publicKey) && communityAddress(o.community) === o.community
        && Number.isSafeInteger(o.refusals) && (o.refusals as number) >= 0 && Number.isSafeInteger(o.retryAt);
}

function parseDue(raw: string | null): DueRegistration[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isDueRegistration) : [];
}

let dueWrites: Promise<unknown> = Promise.resolve();

/**
 * Change what is due, after any change already under way. Nothing is written when nothing changes, and nothing is kept
 * once none is due. Throws when it can't be read or written, and then it is left as it was.
 */
function changeDue(storage: Storage, change: (due: DueRegistration[]) => DueRegistration[]): Promise<void> {
    const next = dueWrites.then(async () => {
        const due = parseDue(await storage.getItem(PUSH_REGISTRATIONS_DUE_STORE_KEY));
        const changed = change(due);
        if (JSON.stringify(changed) === JSON.stringify(due)) return;
        if (changed.length === 0) await storage.removeItem(PUSH_REGISTRATIONS_DUE_STORE_KEY);
        else await storage.setItem(PUSH_REGISTRATIONS_DUE_STORE_KEY, JSON.stringify(changed));
    });
    dueWrites = next.catch(() => {});
    return next;
}

/** How long a community is left alone after `refusals` refusals in a row: doubling from the first wait, up to the longest. */
function waitAfter(refusals: number): number {
    return Math.min(RETRY_FIRST_WAIT_MS * 2 ** Math.max(0, refusals - 1), RETRY_LONGEST_WAIT_MS);
}

/** Its wait is over, or its time is further off than any wait: the clock went back since. */
function isDue(d: DueRegistration, now: number): boolean {
    return d.retryAt <= now || d.retryAt - now > RETRY_LONGEST_WAIT_MS;
}

/**
 * `key`'s registration at `community` did not land: it stays due. `refused`: the community answered, but not with the
 * route's own confirmation, or never answered within the timeout, and is left alone a while, longer after each refusal in
 * a row. Otherwise (no connection, or no token to be had) it is tried at the next chance: nothing reached the community.
 * Nothing for a key leaving the phone: its leave drops what it had ({@link stopRegistering}). Never throws.
 */
async function stillDue(key: string, community: string, refused: boolean, storage: Storage): Promise<void> {
    try {
        await changeDue(storage, (due) => {
            if (leaving.has(key)) return due;
            const had = due.find((d) => d.publicKey === key && d.community === community);
            const refusals = (had?.refusals ?? 0) + (refused ? 1 : 0);
            const retryAt = refused ? Date.now() + waitAfter(refusals) : had?.retryAt ?? 0;
            return [...due.filter((d) => d !== had), { publicKey: key, community, refusals, retryAt }];
        });
    } catch (e) {
        console.warn(`[Push] Could not write down that this phone's registration at ${community} is still due`, e);
    }
}

/** `key`'s registration at `community` landed: nothing more is due there. Never throws. */
async function landed(key: string, community: string, storage: Storage): Promise<void> {
    try {
        await changeDue(storage, (due) => due.filter((d) => !(d.publicKey === key && d.community === community)));
    } catch (e) {
        console.warn(`[Push] Could not cross off this phone's registration at ${community}`, e);
    }
}

// ── Registering ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Register this phone's push token for `account` with `at`, or else the community the phone is set to, signed by the
 * account's key, after putting that community on the record, with a fresh push stamp. False, with nothing sent, when
 * there is no community or the account is leaving the phone ({@link stopRegistering}). Throws when the node can't be
 * reached, doesn't answer within `timeoutMs`, or answers with anything but the route's own confirmation (`{ success:
 * true }`: a captive portal's sign-in page never reached it); the community stays on the record, and the registration
 * stays due there ({@link retryDueRegistrations}). One that lands is due there no more.
 *
 * A record that can't be written is logged and the token still goes: the account's recovery alerts matter more than
 * this phone remembering to unregister there later.
 */
export async function registerPushTokenWithCommunity(
    account: RegisteringAccount,
    token: string,
    platform: string,
    timeoutMs: number = REGISTER_TIMEOUT_MS,
    storage: Storage = AsyncStorage,
    at?: string,
): Promise<boolean> {
    const key = account.publicKey.toLowerCase();
    const community = communityAddress(at ?? await storage.getItem(ANCHOR_STORE_KEY));
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
    let answered = false;
    try {
        const res = await request;
        answered = true;
        const answer: { success?: unknown } | undefined = await res.json().catch(() => undefined);
        if (!res.ok || answer?.success !== true) throw new Error(`${community} did not register this phone (${res.status})`);
    } catch (e) {
        await stillDue(key, community, answered || controller.signal.aborted, storage);
        throw e;
    } finally {
        inFlight.delete(request);
        clearTimeout(timer);
    }
    await landed(key, community, storage);
    return true;
}

function isLeaving(key: string): boolean {
    if (!leaving.has(key)) return false;
    console.log('[Push] This account is leaving the phone: its token is not registered');
    return true;
}

/**
 * The account on the phone registers it for its alerts (services/push-notifications.ts: its key written to the phone,
 * and each time the app starts). The phone's push token from `phoneToken`, then {@link registerPushTokenWithCommunity}
 * with the community the phone is set to. When the token can't be had yet (`phoneToken` throws: no connection, most
 * often), that registration stays due all the same and is tried at the next chance ({@link retryDueRegistrations}).
 * Nothing once `publicKey` is no longer the account on the phone, or where push can't work (`phoneToken` gives null).
 * Returns the token, or null. Never throws.
 */
export async function registerAccountForPush(
    publicKey: string,
    phoneToken: () => Promise<string | null>,
    platform: string,
    storage: Storage = AsyncStorage,
    onPhone: () => Promise<RegisteringAccount | null> = loadIdentity,
): Promise<string | null> {
    let token: string | null;
    try {
        token = await phoneToken();
    } catch (e) {
        console.warn('[Push] Could not get this phone\'s push token; its registration is tried again later:', e instanceof Error ? e.message : e);
        try {
            const community = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
            if (community && (await onPhone())?.publicKey === publicKey) await stillDue(publicKey.toLowerCase(), community, false, storage);
        } catch (e2) {
            console.warn('[Push] Could not write down that this phone\'s registration is still due', e2);
        }
        return null;
    }
    if (!token) return null;
    const account = await onPhone();
    if (account?.publicKey !== publicKey) {
        console.log('[Push] The account changed before its token was registered');
        return token;
    }
    try {
        if (await registerPushTokenWithCommunity(account, token, platform, REGISTER_TIMEOUT_MS, storage)) {
            console.log('[Push] Token registered with server');
        }
    } catch (e) {
        console.warn('[Push] Failed to register token with server; tried again later:', e instanceof Error ? e.message : e);
    }
    return token;
}

let retrying: Promise<void> | null = null;

/**
 * Try again each registration the account on the phone still needs whose wait is over, as the app comes back and with
 * the 5-minute sync (services/push-notifications.ts `retryPushRegistrations`, app/_layout.tsx), each through
 * {@link registerPushTokenWithCommunity} as any other: stamped, never for a key leaving the phone, and due until it
 * lands. Only the account on the phone's own, signed by its key: never one for a key that is leaving or has left, nor
 * for another key. The token (`phoneToken`) is asked for only when one is due; when it can't be had, all stay due. One
 * run at a time: a call while one runs waits for it. Never throws.
 */
export function retryDueRegistrations(
    phoneToken: () => Promise<string | null>,
    platform: string,
    storage: Storage = AsyncStorage,
    onPhone: () => Promise<RegisteringAccount | null> = loadIdentity,
    timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<void> {
    if (retrying) return retrying;
    retrying = (async () => {
        try {
            const account = await onPhone();
            if (!account?.publicKey || !account.privateKey) return;
            const key = account.publicKey.toLowerCase();
            if (leaveState(key) !== 'none') return;
            await dueWrites;
            const now = Date.now();
            const due = parseDue(await storage.getItem(PUSH_REGISTRATIONS_DUE_STORE_KEY)).filter((d) => d.publicKey === key && isDue(d, now));
            if (due.length === 0) return;

            let token: string | null;
            try {
                token = await phoneToken();
            } catch (e) {
                console.warn('[Push] Could not get this phone\'s push token; its registrations stay due', e instanceof Error ? e.message : e);
                return;
            }
            // The account on the phone may have changed while the token was fetched: only its own go.
            if (!token || (await onPhone())?.publicKey?.toLowerCase() !== key) return;
            await Promise.all(due.map(async (d) => {
                try {
                    if (await registerPushTokenWithCommunity(account, token, platform, timeoutMs, storage, d.community)) {
                        console.log(`[Push] Token registered with ${d.community} at last`);
                    }
                } catch (e) {
                    console.warn(`[Push] ${d.community} still has no registration from this phone; tried again later`, e instanceof Error ? e.message : e);
                }
            }));
        } catch (e) {
            console.warn('[Push] Trying the registrations still due again failed', e);
        } finally {
            retrying = null;
        }
    })();
    return retrying;
}
