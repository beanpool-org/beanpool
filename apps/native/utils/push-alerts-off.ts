/**
 * The per-community switch for alerts, default on (scratch/fable-design/DESIGN-cross-community-chat-fable.md R8): the
 * communities the member turned alerts off for, kept on this phone. This phone's push token is not registered with these
 * (push-registrations.ts), whoever asks, the one the phone is set to included. The switch on the BeanPool sheet reads this,
 * and so will the rounds that ask each community for its unread count.
 *
 * Off is account-leaves-phone.ts `turnAlertsOffAt`, which writes the list here first and then tells the community. On
 * again is services/push-notifications.ts `turnAlertsOnAt`. A community leaves the list as it leaves the phone, so a rejoin
 * starts from the default (account-leaves-phone.ts `forgetCommunityPush`), and one followed to its new address keeps its
 * place on it ({@link carryAlertsOff}). The list goes with the account (identity.ts `wipeIdentityScopedStorage`).
 *
 * Kept apart from push-registrations.ts so address-follow.ts, the sheet and the rounds can reach it without the
 * registration machinery. Writes are ordered against each other here; nothing else writes that key.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { plainOriginOf } from './node-url';
import { communityAddress } from './push-pins';
import { PUSH_ALERTS_OFF_STORE_KEY } from './storage-keys';

interface Storage {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
}

function parseList(raw: string | null): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw ?? '[]');
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(communityAddress).filter((c): c is string => c !== null))];
}

let writes: Promise<unknown> = Promise.resolve();

/** The communities with alerts off, after any change under way. Throws when they can't be read. */
export async function readAlertsOff(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<string[]> {
    await writes;
    return parseList(await storage.getItem(PUSH_ALERTS_OFF_STORE_KEY));
}

/** {@link readAlertsOff} for a reader that has nothing to do about a failure: none. Never throws. */
export async function communitiesWithAlertsOff(storage: Pick<Storage, 'getItem'> = AsyncStorage): Promise<string[]> {
    try {
        return await readAlertsOff(storage);
    } catch {
        return [];
    }
}

/** Change the list, one change at a time. Nothing is kept once none is off. Throws when it can't be read or written. */
function change(storage: Storage, changed: (off: string[]) => string[]): Promise<void> {
    const next = writes.then(async () => {
        const off = parseList(await storage.getItem(PUSH_ALERTS_OFF_STORE_KEY));
        const after = changed(off);
        if (JSON.stringify(after) === JSON.stringify(off)) return;
        if (after.length === 0) await storage.removeItem(PUSH_ALERTS_OFF_STORE_KEY);
        else await storage.setItem(PUSH_ALERTS_OFF_STORE_KEY, JSON.stringify(after));
    });
    writes = next.catch(() => {});
    return next;
}

/**
 * `community` goes on the list, so nothing registers there from now on, across restarts too. Throws, changing nothing,
 * when the list can't be written: the switch must not say off while the token still goes there.
 */
export function markAlertsOff(community: string, storage: Storage = AsyncStorage): Promise<void> {
    return change(storage, (off) => (off.includes(community) ? off : [...off, community]));
}

/** `community` comes off the list. Throws, changing nothing, when the list can't be written. */
export function markAlertsOn(community: string, storage: Storage = AsyncStorage): Promise<void> {
    return change(storage, (off) => off.filter((c) => c !== community));
}

/**
 * A community the phone followed to its new address (address-follow.ts) is the same community: alerts the member turned
 * off there stay off. Compared by origin: the list keeps an address as the phone saved it, capitals and a default port
 * included (node-url.ts `normalizeNodeUrl`), and a follow names it in one spelling (`plainOriginOf`). Never throws.
 */
export async function carryAlertsOff(from: string, to: string, storage: Storage = AsyncStorage): Promise<void> {
    const moved = communityAddress(to);
    const origin = plainOriginOf(from);
    const isFrom = (c: string) => origin !== null && plainOriginOf(c) === origin;
    try {
        await change(storage, (off) => (moved && off.some(isFrom) ? [...new Set(off.map((c) => (isFrom(c) ? moved : c)))] : off));
    } catch (e) {
        console.warn('[Push] Could not carry the alerts-off choice to the community\'s new address', e);
    }
}
