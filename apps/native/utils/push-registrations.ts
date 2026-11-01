/**
 * Where this phone sent its push token for the account on it.
 *
 * The token lets whoever holds it push to this phone, and every community it is sent to keeps it. So the phone sends it
 * only where the account's alerts come from: every community it keeps ({@link communitiesForAlerts}), each by its own
 * signed request with its own record entry, its own retries and its own pin, unless the member turned alerts from that
 * community off (account-leaves-phone.ts `turnAlertsOffAt`), and never one it only looks at as a guest while it is set
 * elsewhere. A DM at a community the phone wasn't set to used to reach nobody
 * (scratch/fable-design/DESIGN-cross-community-chat-fable.md §1.2, R1). Being kept is not belonging, and no mark says
 * which it is, so the first token at a community asks it first ({@link belongsThere}). Each community goes on the
 * record before the request goes out, so a node that took the token but whose answer never arrived is on it too. As the account leaves the
 * phone, only the communities on the record are asked to drop the token (account-leaves-phone.ts): one this phone never
 * sent it to is never sent it (#1184 review 4110460184). The record goes with the account (identity.ts
 * `wipeIdentityScopedStorage`).
 *
 * One community going (Forget Community, alerts off) is not an account leaving: the key stays and goes on registering
 * everywhere else. {@link stopRegisteringAt} stops that one community alone (account-leaves-phone.ts
 * `unregisterPushTokenAt`); {@link stopRegistering} would stop them all.
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
 * row, and one whose request failed with no answer at all for a minute: every try sends it the token and the phone's
 * address, so none is tried at every return, and one that says the account isn't a member waits the same way. A retry
 * is a registration like any other ({@link registerPushTokenWithCommunity}), and only where the phone still keeps the
 * community: what is due for a key goes as that key starts leaving the phone, and what is due at a community goes once the phone forgets it (Forget
 * Community, Wipe Connection).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { onAccountOnPhone } from './account-on-phone';
import { buildSignedHeaders } from './crypto';
import { loadIdentity, KEY_ITEM_OPTIONS, type BeanPoolIdentity } from './identity';
import { fetchMembership } from './membership-probe';
import { isPlainNodeAddress } from './node-url';
import { communitiesWithAlertsOff, readAlertsOff } from './push-alerts-off';
import { communityAddress, pinPushKey, pushKeyOf } from './push-pins';
import { languageForNode } from './language-choice';
import {
    PUSH_LEAVES_OWED_STORE_KEY, PUSH_REGISTERED_AT_STORE_KEY, PUSH_REGISTRATIONS_DUE_STORE_KEY, PUSH_STAMP_STORE_KEY, SAVED_NODES_STORE_KEY,
} from './storage-keys';

export { communityAddress };

const PUSH_TOKENS_PATH = '/api/push-tokens';
const ANCHOR_STORE_KEY = 'beanpool_anchor_url';
/** The communities this key visited as a guest (nodes.ts `markGuestNode`). */
const GUEST_NODES_STORE_KEY = 'beanpool_guest_nodes';
/** How long a registration may take, as other signed requests (db.ts `signedRequest`). */
const REGISTER_TIMEOUT_MS = 12000;
/**
 * How long a community is left alone after a try that didn't land there, whatever went wrong: after one that refused
 * the registration or never answered it, and after a request that failed with no answer, which may have reached it.
 */
export const RETRY_FIRST_WAIT_MS = 60 * 1000;
/** The longest it is left alone: the wait doubles with each refusal in a row, up to this. */
export const RETRY_LONGEST_WAIT_MS = 60 * 60 * 1000;
/**
 * How long a retry waits for the phone's push token (services/push-notifications.ts `phonePushToken`, which never asks
 * for permission then). Expo's request for it has no timeout of its own on Android, and one that stalled would hold up
 * every later retry until the app's next cold start (#1267 review 4117005129).
 */
export const TOKEN_TIMEOUT_MS = 30 * 1000;

type RegisteringAccount = Pick<BeanPoolIdentity, 'publicKey' | 'privateKey'>;

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
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

/**
 * Take `communities` off the record: the account deleted itself there and stays on the phone (delete-here.ts
 * `leaveThisCommunity`; that node dropped the key's push tokens with the account, server `purgeMemberSelf`, so no leave
 * is ever sent there), or that one community has let the token go, or will by a statement on its way
 * (account-leaves-phone.ts `unregisterPushTokenAt`). Never throws: a record that can't be changed is logged, and a later
 * leave asks that node for nothing it still holds.
 */
export async function dropFromRecord(communities: readonly string[], storage: Pick<Storage, 'getItem' | 'setItem'> = AsyncStorage): Promise<void> {
    const dropped = new Set(communities.map(communityAddress).filter((c): c is string => c !== null));
    try {
        await changeRecord(async () => {
            const recorded = parseRecord(await storage.getItem(PUSH_REGISTERED_AT_STORE_KEY));
            const kept = recorded.filter((c) => !dropped.has(c));
            if (kept.length !== recorded.length) await storage.setItem(PUSH_REGISTERED_AT_STORE_KEY, JSON.stringify(kept));
        });
    } catch (e) {
        console.warn('[Push] Could not take the community left off the record', e);
    }
}

/**
 * The communities on the record that heard nothing when the member let them go: the DELETE failed and no statement was
 * written down (account-leaves-phone.ts `unregisterPushTokenAt`), so nothing but the phone trying again will reach them
 * (account-leaves-phone.ts `retryLeavesOwed`). The record can't say which they are: a community that moved stays on it at
 * its old address, which must never hear a DELETE, since it may be the same node (address-follow.ts). After any change
 * under way. Reads only; never throws.
 */
export async function leavesOwed(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<string[]> {
    try {
        await recordWrites;
        return parseRecord(await storage.getItem(PUSH_LEAVES_OWED_STORE_KEY));
    } catch {
        return [];
    }
}

function changeOwed(change: (owed: string[]) => string[], storage: Pick<Storage, 'getItem' | 'setItem'>): Promise<void> {
    return changeRecord(async () => {
        const owed = parseRecord(await storage.getItem(PUSH_LEAVES_OWED_STORE_KEY));
        const after = change(owed);
        if (after.length !== owed.length) await storage.setItem(PUSH_LEAVES_OWED_STORE_KEY, JSON.stringify(after));
    });
}

/**
 * `community` goes on {@link leavesOwed}. A list that can't be written is logged: the record still has it, and a later
 * Sign Out asks it. Never throws.
 */
export async function oweLeave(community: string, storage: Pick<Storage, 'getItem' | 'setItem'> = AsyncStorage): Promise<void> {
    try {
        await changeOwed((owed) => (owed.includes(community) ? owed : [...owed, community]), storage);
    } catch (e) {
        console.warn(`[Push] Could not write down that ${community} is still owed a leave`, e);
    }
}

/** `community` comes off {@link leavesOwed}: it has heard, or is wanted again. Never throws; one left on is only asked again. */
export async function leaveNoLongerOwed(community: string, storage: Pick<Storage, 'getItem' | 'setItem'> = AsyncStorage): Promise<void> {
    try {
        await changeOwed((owed) => owed.filter((c) => c !== community), storage);
    } catch (e) {
        console.warn(`[Push] Could not cross ${community} off the leaves still owed`, e);
    }
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
    setItem: (key, value) => SecureStore.setItemAsync(key, value, KEY_ITEM_OPTIONS),
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
/** Registrations on their way, and the key and community each is for. */
const inFlight = new Map<Promise<unknown>, { key: string; community: string }>();
/** The communities a stop is under way at ({@link stopRegisteringAt}), each as {@link heldAt} spells it. */
const stopsUnderWay = new Set<string>();
const heldAt = (key: string, community: string) => `${key} ${community}`;

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
    await Promise.allSettled([...inFlight].filter(([, to]) => to.key === key).map(([request]) => request));
    try {
        await changeDue(storage, (due) => due.filter((d) => d.publicKey !== key));
    } catch (e) {
        console.warn('[Push] Could not drop the registrations still due for an account leaving the phone', e);
    }
}

/**
 * One community stops getting this key's registrations while the key stays on the phone (Forget Community, alerts off):
 * {@link stopRegistering} for that community alone. From now until {@link resumeRegisteringAt} no registration goes out
 * there. Resolves once each one for it already on its way has finished, within its own timeout, so what the caller sends
 * next reaches the community after it, and what was due there is dropped. A registration at any other community goes on
 * as before. Never throws.
 */
export async function stopRegisteringAt(publicKey: string, community: string, storage: Storage = AsyncStorage): Promise<void> {
    const key = publicKey.toLowerCase();
    stopsUnderWay.add(heldAt(key, community));
    await Promise.allSettled([...inFlight].filter(([, to]) => to.key === key && to.community === community).map(([request]) => request));
    try {
        await changeDue(storage, (due) => due.filter((d) => !(d.publicKey === key && d.community === community)));
    } catch (e) {
        console.warn(`[Push] Could not drop the registration still due at ${community}`, e);
    }
}

/**
 * The stop {@link stopRegisteringAt} began is over. By now the phone no longer keeps the community, or holds it on its
 * alerts-off list, so nothing asks to register there; if the member rejoins, that registers as any other.
 */
export function resumeRegisteringAt(publicKey: string, community: string): void {
    stopsUnderWay.delete(heldAt(publicKey.toLowerCase(), community));
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
function changeDue(storage: Storage, change: (due: DueRegistration[]) => DueRegistration[] | Promise<DueRegistration[]>): Promise<void> {
    const next = dueWrites.then(async () => {
        const due = parseDue(await storage.getItem(PUSH_REGISTRATIONS_DUE_STORE_KEY));
        const changed = await change(due);
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
 * `key`'s registration at `community` did not land: it stays due. When it is tried again depends on how it `failed`:
 * - 'refused': the community answered, but not with the route's own confirmation, or never answered within the
 *   timeout. It is left alone a while, longer after each refusal in a row.
 *   A community that says the account isn't one of its members counts as a refusal ({@link belongsThere}).
 * - 'unanswered': the request failed with no answer: no connection, or a node that drops it, a lapsed certificate, a
 *   name that no longer resolves; the phone can't tell these apart. It is left alone the first wait, and never longer
 *   for it: a member back online lands within a minute, and a node that drops each request can't have the phone call
 *   it at every return (#1267 review 4117004415). A longer wait already under way stays.
 * - 'unsent': nothing went out (no token to be had). It is tried at the next chance.
 * Nothing for a key leaving the phone, or at a community a stop is under way at: its stop drops what it had. Never throws.
 */
async function stillDue(key: string, community: string, failed: 'refused' | 'unanswered' | 'unsent', storage: Storage): Promise<void> {
    try {
        await changeDue(storage, (due) => {
            if (leaving.has(key) || stopsUnderWay.has(heldAt(key, community))) return due;
            const had = due.find((d) => d.publicKey === key && d.community === community);
            const now = Date.now();
            const refusals = (had?.refusals ?? 0) + (failed === 'refused' ? 1 : 0);
            const waiting = had && !isDue(had, now) ? had.retryAt : 0;
            const retryAt = failed === 'refused' ? now + waitAfter(refusals)
                : failed === 'unanswered' ? Math.max(now + RETRY_FIRST_WAIT_MS, waiting)
                    : had?.retryAt ?? 0;
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
 * there is no community, the account is leaving the phone ({@link stopRegistering}), or that community is stopped
 * ({@link stopRegisteringAt}, or its alerts are off: the member's word holds whoever asks). Throws when the node can't be
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
    if (!community || isLeaving(key) || isStopped(key, community)) return false;
    if ((await communitiesWithAlertsOff(storage)).includes(community)) return false;
    try {
        await recordPushRegistration(community, storage);
    } catch (e) {
        console.warn(`[Push] Could not record that this phone's token goes to ${community}`, e);
    }

    const registeredAt = await nextPushStamp(storage);
    // `lang`: the language this phone writes in, for the node's pushes to it (utils/language-choice.ts; Marty's call M6:
    // kept on the token's row and erased with it). A node before it reads nothing else of the body and ignores it.
    const body = JSON.stringify({ publicKey: account.publicKey, token, platform, registeredAt, lang: languageForNode() });
    const url = `${community}${PUSH_TOKENS_PATH}`;
    const headers = await buildSignedHeaders('POST', url, body, account.privateKey, account.publicKey);
    // The last look before the request goes out, with nothing awaited between it and the fetch: a leave or a stop that
    // began meanwhile stops this one here, or finds it on its way and waits for it.
    if (isLeaving(key) || isStopped(key, community)) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const request = fetch(url, { method: 'POST', headers, body, signal: controller.signal });
    inFlight.set(request, { key, community });
    let answered = false;
    let answer: { success?: unknown; pushKey?: unknown } | undefined;
    try {
        const res = await request;
        answered = true;
        answer = await res.json().catch(() => undefined);
        if (!res.ok || answer?.success !== true) throw new Error(`${community} did not register this phone (${res.status})`);
    } catch (e) {
        await stillDue(key, community, answered || controller.signal.aborted ? 'refused' : 'unanswered', storage);
        throw e;
    } finally {
        inFlight.delete(request);
        clearTimeout(timer);
    }
    await landed(key, community, storage);
    // The key this community signs its notices with, from its answer to this signed request (push-pins.ts): pinned
    // under the phone's pins, or the pin taken off when it names none.
    await pinPushKey(community, pushKeyOf(answer), storage);
    return true;
}

function isLeaving(key: string): boolean {
    if (!leaving.has(key)) return false;
    console.log('[Push] This account is leaving the phone: its token is not registered');
    return true;
}

function isStopped(key: string, community: string): boolean {
    if (!stopsUnderWay.has(heldAt(key, community))) return false;
    console.log(`[Push] ${community} is being let go: this phone's token is not registered there`);
    return true;
}

/**
 * The account on the phone registers it for its alerts (services/push-notifications.ts: its key written to the phone,
 * each time the app starts, a language picked). The phone's push token from `phoneToken`, then
 * {@link registerPushTokenWithCommunity} with each community it should go to ({@link communitiesForAlerts}) that
 * {@link belongsThere} lets through, all together: one that refuses or never answers holds up no other, and stays due
 * alone. One still left alone after a failed try is left alone now too (every try sends it the token and the phone's address), unless it is the one the
 * phone is set to, which is asked each time, as ever. When the token can't be had yet (`phoneToken` throws: no
 * connection, most often), each registration stays due all the same and is tried at the next chance
 * ({@link retryDueRegistrations}). Nothing once `publicKey` is no longer the account on the phone, or where push can't
 * work (`phoneToken` gives null). Returns the token, or null. Never throws.
 */
export async function registerAccountForPush(
    publicKey: string,
    phoneToken: () => Promise<string | null>,
    platform: string,
    storage: Storage = AsyncStorage,
    onPhone: () => Promise<RegisteringAccount | null> = loadIdentity,
): Promise<string | null> {
    const key = publicKey.toLowerCase();
    let token: string | null;
    try {
        token = await phoneToken();
    } catch (e) {
        console.warn('[Push] Could not get this phone\'s push token; its registrations are tried again later:', e instanceof Error ? e.message : e);
        try {
            if ((await onPhone())?.publicKey === publicKey) {
                for (const community of await communitiesForAlerts(storage)) await stillDue(key, community, 'unsent', storage);
            }
        } catch (e2) {
            console.warn('[Push] Could not write down that this phone\'s registrations are still due', e2);
        }
        return null;
    }
    if (!token) return null;
    const account = await onPhone();
    if (account?.publicKey !== publicKey) {
        console.log('[Push] The account changed before its token was registered');
        return token;
    }
    // Read once the token is here, which can take a while: a community forgotten meanwhile is not asked.
    let communities: string[] = [];
    try {
        communities = await notLeftAlone(key, storage);
    } catch (e) {
        console.warn('[Push] Could not read which communities keep this phone\'s token; tried again later:', e instanceof Error ? e.message : e);
    }
    await Promise.all(communities.map(async (community) => {
        try {
            if (!await belongsThere(account, community, REGISTER_TIMEOUT_MS, storage)) return;
            if (await registerPushTokenWithCommunity(account, token, platform, REGISTER_TIMEOUT_MS, storage, community)) {
                console.log(`[Push] Token registered with ${community}`);
            }
        } catch (e) {
            console.warn(`[Push] Failed to register token with ${community}; tried again later:`, e instanceof Error ? e.message : e);
        }
    }));
    return token;
}

/**
 * Whether this phone's token may go to `community`, one {@link communitiesForAlerts} named: it is the one the phone is set
 * to, it is on the record and holds the token already, or it says `account` is one of its members. Being kept says nothing:
 * a restored list, a look before a restore, a failed invite and Add & Connect with no answer each leave a community the
 * member never joined on the list with no guest mark, and every community the token goes to keeps it and can put a line
 * on the lock screen. So it is asked first, by the signed probe the BeanPool sheet sends every row, which carries no token
 * (membership-probe.ts). No answer is no: the community stays due, like a registration that failed the same way, and is
 * asked at the next chance after its wait. What was true when it was named is looked at again once the answer is in,
 * which can take `timeoutMs`: a community let go meanwhile gets nothing. Never for a key that is leaving or a community
 * being stopped, whom a registration wouldn't reach either. Never throws.
 */
async function belongsThere(account: RegisteringAccount, community: string, timeoutMs: number, storage: Storage): Promise<boolean> {
    const key = account.publicKey.toLowerCase();
    if (isLeaving(key) || isStopped(key, community)) return false;
    if (community === communityAddress(await storage.getItem(ANCHOR_STORE_KEY))) return true;
    if ((await pushRegisteredCommunities(storage)).includes(community)) return true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let answered = false;
    let isMember = false;
    try {
        const res = await fetchMembership(community, account, controller.signal);
        answered = true;
        const answer: { isMember?: unknown } | undefined = await res.json().catch(() => undefined);
        isMember = res.ok && answer?.isMember === true;
    } catch (e) {
        console.warn(`[Push] ${community} did not say whether this account belongs there; asked again later:`, e instanceof Error ? e.message : e);
    } finally {
        clearTimeout(timer);
    }
    if (!isMember) await stillDue(key, community, answered || controller.signal.aborted ? 'refused' : 'unanswered', storage);
    return isMember && (await communitiesForAlerts(storage)).includes(community);
}

/** {@link communitiesForAlerts}, without those still waiting out a failed try, but for the one the phone is set to. */
async function notLeftAlone(key: string, storage: Storage): Promise<string[]> {
    const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    const now = Date.now();
    await dueWrites;
    const waiting = parseDue(await storage.getItem(PUSH_REGISTRATIONS_DUE_STORE_KEY))
        .filter((d) => d.publicKey === key && d.community !== anchor && !isDue(d, now))
        .map((d) => d.community);
    return (await communitiesForAlerts(storage)).filter((c) => !waiting.includes(c));
}

/**
 * The communities this phone still keeps: the one it is set to, and the ones in its list (nodes.ts `getSavedNodes`; a
 * list that can't be parsed is none, as the switcher shows it). A registration is tried again only at one of these.
 * Not the guest markers (nodes.ts `markGuestNode`), which Forget Community and Wipe Connection leave behind: a
 * community visited as a guest and then forgotten is forgotten here too. Read here rather than through
 * account-leaves-phone.ts `communitiesOnThisPhone`, which imports this module and reads the markers. Throws when the
 * phone's storage can't be read.
 */
async function communitiesKept(storage: Pick<Storage, 'getItem'>): Promise<string[]> {
    const anchor = await storage.getItem(ANCHOR_STORE_KEY);
    const rawSaved = await storage.getItem(SAVED_NODES_STORE_KEY);
    let saved: unknown;
    try {
        saved = JSON.parse(rawSaved ?? '[]');
    } catch {
        saved = [];
    }
    const urls = Array.isArray(saved) ? saved.map((n) => (n && typeof n === 'object' ? (n as { url?: unknown }).url : undefined)) : [];
    return [...new Set([anchor, ...urls].map(communityAddress).filter((c): c is string => c !== null))];
}

/**
 * Where this phone's push token may go for the account on it: the communities it keeps ({@link communitiesKept}, the
 * one it is set to first), each once, less the ones the member turned alerts off for. A saved community is left out when
 * its address isn't plain (node-url.ts: on iOS it reaches another host than it names) and when the phone only looks at it
 * as a guest (nodes.ts `markGuestNode`): a look is not belonging, and every community the token goes to keeps it.
 * Joining clears that mark. The community the phone is set to counts even as a guest, as it always has: a knock's answer
 * reaches the phone that way. {@link belongsThere} has the last word before a first token. Throws when the phone's
 * storage can't be read.
 */
export async function communitiesForAlerts(storage: Pick<Storage, 'getItem'>): Promise<string[]> {
    const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
    const off = await readAlertsOff(storage);
    const guests = await guestMarks(storage);
    return (await communitiesKept(storage))
        .filter((c) => !off.includes(c) && (c === anchor || (isPlainNodeAddress(c) && !guests.includes(c))));
}

async function guestMarks(storage: Pick<Storage, 'getItem'>): Promise<string[]> {
    return parseRecord(await storage.getItem(GUEST_NODES_STORE_KEY));
}

/** `promise`, or a rejection once `ms` pass without it settling. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`No answer within ${ms / 1000} s`)), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

let retrying: Promise<void> | null = null;

/**
 * Try again each registration the account on the phone still needs whose wait is over, as the app comes back and with
 * the 5-minute sync (services/push-notifications.ts `retryPushRegistrations`, app/_layout.tsx), each through
 * {@link registerPushTokenWithCommunity} as any other: stamped, never for a key leaving the phone, and due until it
 * lands. Only the account on the phone's own, signed by its key: never one for a key that is leaving or has left, nor
 * for another key. Only where the token should still go ({@link communitiesForAlerts}): what is due at a community the
 * phone has forgotten, or turned alerts off for, is dropped, and it is never contacted again (#1267 review 4117004415).
 * The token (`phoneToken`) is asked
 * for only when one is due; when it can't be had within {@link TOKEN_TIMEOUT_MS}, all stay due. Whichever door put a
 * community on the list, {@link belongsThere} lets it through first. One run at a time: a call while one runs waits for
 * it, and a run ends within the token's deadline and twice the registrations' timeout (the question, then the
 * registration). Never throws.
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
            let due: DueRegistration[] = [];
            await changeDue(storage, async (all) => {
                if (leaving.has(key)) return all;
                const kept = await communitiesForAlerts(storage);
                const now = Date.now();
                const forgotten = (d: DueRegistration) => d.publicKey === key && !kept.includes(d.community);
                for (const d of all.filter(forgotten)) console.log(`[Push] This phone no longer keeps ${d.community}: its registration there is not tried again`);
                due = all.filter((d) => d.publicKey === key && !forgotten(d) && isDue(d, now));
                return all.filter((d) => !forgotten(d));
            });
            if (due.length === 0) return;

            let token: string | null;
            try {
                token = await within(TOKEN_TIMEOUT_MS, phoneToken());
            } catch (e) {
                console.warn('[Push] Could not get this phone\'s push token; its registrations stay due', e instanceof Error ? e.message : e);
                return;
            }
            // The account on the phone, or the communities it keeps, may have changed while the token was fetched: only
            // its own go, and only where the phone still keeps them.
            if (!token || (await onPhone())?.publicKey?.toLowerCase() !== key) return;
            const kept = await communitiesForAlerts(storage);
            await Promise.all(due.filter((d) => kept.includes(d.community)).map(async (d) => {
                try {
                    if (!await belongsThere(account, d.community, timeoutMs, storage)) return;
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

/**
 * Communities the token should go to that have never been asked: each came onto the phone by one of the many doors that
 * add one (a join, a claim, a re-key, a restore's list, an app that registered with one community before this one), and
 * no moment of its own told it. Each goes on the due list, with no wait, then {@link retryDueRegistrations} runs: as the
 * app comes back, with the 5-minute sync, after a join and after a restore. Never a community marked as a guest's, even
 * the one the phone is set to: only a cold start asks that one, as ever, so coming back to the app sends no token to a
 * community a member is only looking at. The run itself asks each first token's community ({@link belongsThere}), and a
 * wait left by that question ends once the phone is set to the community, which needs no asking: a join lands at once.
 * First, each community still owed a leave is tried again ({@link leavesOwed}). Never throws.
 */
export async function registerWhereMissing(
    phoneToken: () => Promise<string | null>,
    platform: string,
    storage: Storage = AsyncStorage,
    onPhone: () => Promise<RegisteringAccount | null> = loadIdentity,
    timeoutMs: number = REGISTER_TIMEOUT_MS,
): Promise<void> {
    try {
        const account = await onPhone();
        if (account?.publicKey && leaveState(account.publicKey) === 'none') {
            if ((await leavesOwed(storage)).length > 0) {
                // Loaded only then: account-leaves-phone.ts imports this module.
                const { retryLeavesOwed } = await import('./account-leaves-phone');
                await retryLeavesOwed(account);
            }
            const key = account.publicKey.toLowerCase();
            const asked = await pushRegisteredCommunities(storage);
            const guests = await guestMarks(storage);
            const missing = (await communitiesForAlerts(storage)).filter((c) => !asked.includes(c) && !guests.includes(c));
            const anchor = communityAddress(await storage.getItem(ANCHOR_STORE_KEY));
            await changeDue(storage, (due) => {
                if (leaving.has(key)) return due;
                const fresh = missing.filter((c) => !due.some((d) => d.publicKey === key && d.community === c));
                // Never on the record, so nothing has gone there: its wait was the question's.
                const here = (d: DueRegistration) => d.publicKey === key && d.community === anchor && missing.includes(d.community);
                return [...due.map((d) => (here(d) ? { ...d, refusals: 0, retryAt: 0 } : d)), ...fresh.map((community) => ({ publicKey: key, community, refusals: 0, retryAt: 0 }))];
            });
        }
    } catch (e) {
        console.warn('[Push] Could not work out which communities still need this phone\'s token', e);
    }
    // A run already under way read what was due before these went on it.
    await retrying;
    await retryDueRegistrations(phoneToken, platform, storage, onPhone, timeoutMs);
}
