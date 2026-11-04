/**
 * Lights-out H2: what the phone keeps while it is on the hall laptop, and the one place the signing code asks it
 * (scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §2.3, §2.5).
 *
 * In the hall the phone sends its requests to the laptop's number (`at`, e.g. http://192.168.8.1:8080) and signs them for
 * the community's own name (`for`, e.g. byron.beanpool.org), the name its own address had before the move (`home`). The
 * server checks a signature against its own names only (apps/server engine/own-addresses.ts), so a request captured on
 * the hall Wi-Fi counts at this community and nowhere else: signed for the number, it would count at every lights-out
 * community that happens to sit at the same router number where the same key is a member.
 *
 * `for` is only ever the host of the phone's own saved community (utils/hall.ts enterHall writes it from the anchor it
 * had, after the laptop proved it holds the community's node key). Never a name a node, a poster or a health answer
 * named: a hostile laptop must not choose what the phone signs for.
 *
 * Kept small and with no imports beyond storage and node-url, because utils/crypto.ts reads it for every signature.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { audienceOf } from '@beanpool/core';
import { isPlainNodeAddress, isPrivateHost, plainOriginOf } from './node-url';

/** AsyncStorage key of the {@link HallRecord}. */
export const HALL_KEY = 'beanpool_hall';

export interface HallRecord {
    /** The hall laptop's address, as an origin: `http://192.168.8.1:8080`. */
    at: string;
    /** The host every signature is made for while on `at`: the host of `home`. */
    for: string;
    /** The phone's own community address before the move, as an origin: where it goes back to. */
    home: string;
    /** When the phone moved to the hall (ISO). */
    since: string;
}

/**
 * The hall laptop's address as an origin, or null when it isn't one: a plain http(s) address to a private host (a home
 * network number, `.local`, `.lan`: core isPrivateHost). The hall is a room's Wi-Fi; a public address is never one.
 * `ws://`/`wss://` read as http/https, so a socket URL finds the same origin.
 */
export function hallOriginOf(url: unknown): string | null {
    if (typeof url !== 'string') return null;
    const asHttp = url.trim().replace(/^ws(s?):\/\//i, 'http$1://');
    if (!isPlainNodeAddress(asHttp) || !/^https?:\/\//i.test(asHttp)) return null;
    const origin = plainOriginOf(asHttp);
    const host = origin ? audienceOf(origin) : null;
    return origin && host && isPrivateHost(host) ? origin : null;
}

function readRecord(raw: string | null): HallRecord | null {
    try {
        const r = raw ? JSON.parse(raw) : null;
        if (!r || typeof r !== 'object') return null;
        const at = hallOriginOf(r.at);
        const home = isPlainNodeAddress(r.home) ? plainOriginOf(r.home) : null;
        const host = home ? audienceOf(home) : null;
        // `for` is the home's host, always: a record whose two disagree was not written by enterHall, and is not used.
        if (!at || !home || !host || r.for !== host || at === home || typeof r.since !== 'string') return null;
        return { at, for: host, home, since: r.since };
    } catch {
        return null;
    }
}

/** undefined: not read yet this run. */
let cached: HallRecord | null | undefined;

/** The phone's hall record, or null when it is not in a hall. Read once a run, then from memory. */
export async function readHall(): Promise<HallRecord | null> {
    if (cached !== undefined) return cached;
    try {
        cached = readRecord(await AsyncStorage.getItem(HALL_KEY));
    } catch {
        cached = null;
    }
    return cached;
}

/** Keep `record` (utils/hall.ts, before the move: so the first request at the number is already signed for the name). */
export async function writeHall(record: HallRecord): Promise<void> {
    const checked = readRecord(JSON.stringify(record));
    if (!checked) throw new Error('Not a hall record');
    await AsyncStorage.setItem(HALL_KEY, JSON.stringify(checked));
    cached = checked;
}

/** Forget the hall (the phone is home again, or the move into the hall did not happen). */
export async function clearHall(): Promise<void> {
    cached = null;
    await AsyncStorage.removeItem(HALL_KEY);
}

/** Forget what this run read (tests). */
export function forgetHallCache(): void {
    cached = undefined;
}

/**
 * The host to sign a request to `url` for, when that is not `url`'s own: the community's name while `url` is on the hall
 * laptop the phone moved to. Null otherwise (every other address signs for its own host, as before). Never throws.
 */
export async function hallAudienceFor(url: string): Promise<string | null> {
    const hall = await readHall().catch(() => null);
    if (!hall) return null;
    return hallOriginOf(url) === hall.at ? hall.for : null;
}
