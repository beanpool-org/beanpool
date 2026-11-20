/**
 * Message requests of the phone's other communities, answered there in place (Marty, 19 Nov 2026, "yes to all 5" on
 * scratch/fable-design/DESIGN-no-switch-messaging-fable.md, slice S3): while Chat's Message requests shows, each other
 * community this phone holds where requests wait is read in place (db.ts requestsInPlace: its own server's list, signed
 * for its name, kept in its own copy), and its cards ("In {community}") are answered there: Accept, Decline and Report
 * each go to that community's copy and server by name, with no switch.
 *
 * - **Held while shown.** Each such community's copy is held in place (db.ts enterChatInPlace) from the read until the
 *   requests are left, then let go (leaveChatInPlace): the last to let go closes it, and nothing of it opens again
 *   until a screen holds it. A chat opened from a card holds it too, so it stays open under the chat.
 * - **Only places with requests.** A community whose count is 0, or one that can't be read in place (not saved, a
 *   guest's look, no copy on the phone, global's door count where the member is no member), is not held or read; a place
 *   with a count that can't be read in place keeps its S0 card, which moves the phone there.
 * - Nothing here names a community: the places come from the phone's own rounds (requests-elsewhere.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { enterChatInPlace, leaveChatInPlace, requestsInPlace } from './db';
import type { RequestsPlace } from './requests-elsewhere';

/** One other community's requests, read there in place. */
export interface RequestsInPlaceGroup {
    place: RequestsPlace;
    entries: any[];
    /** How many wait there, as its read counts them: more than `entries` when it lists only some (#3309 review F3). */
    count: number;
}

/** The places a read in place is asked for: those with requests waiting, once each, in the order the row has them. */
export function placesToReadInPlace(places: readonly RequestsPlace[] | null | undefined): RequestsPlace[] {
    const seen = new Set<string>();
    return (places ?? []).filter((p) => {
        if (!(p.count > 0) || !p.url || seen.has(p.url)) return false;
        seen.add(p.url);
        return true;
    });
}

/**
 * Reads `places` in place, one after another, each held while it is read and after: the groups read (a place that can't be
 * read in place is left out). `stillWanted` false stops before the next place.
 */
export async function readRequestsInPlace(
    myPubkey: string,
    places: readonly RequestsPlace[],
    stillWanted: () => boolean,
    read: typeof requestsInPlace = requestsInPlace,
): Promise<RequestsInPlaceGroup[]> {
    const groups: RequestsInPlaceGroup[] = [];
    for (const place of places) {
        if (!stillWanted()) break;
        const requests = await read(myPubkey, place.url).catch(() => null);
        if (requests) groups.push({ place, entries: requests.conversations, count: requests.count });
    }
    return groups;
}

/**
 * The requests of `places` read in place while `shown` (Chat's Message requests open), and a re-read for after a card's
 * decision. Every place read is held in place from its read until `shown` ends or the places change, then let go.
 */
export function useRequestsInPlace(myPubkey: string | null | undefined, places: readonly RequestsPlace[] | null, shown: boolean): [RequestsInPlaceGroup[], () => void] {
    const [groups, setGroups] = useState<RequestsInPlaceGroup[]>([]);
    const [round, setRound] = useState(0);
    const wanted = placesToReadInPlace(places);
    // The effect's key: each address with its count, so a request that arrives there while the list shows is read too (its
    // S0 card is not drawn beside the group read in place). The same counts again keep the same key: nothing is read again.
    const key = shown && myPubkey ? wanted.map((p) => `${p.url}#${p.count}`).join('\n') : '';
    const placesRef = useRef(wanted);
    placesRef.current = wanted;
    useEffect(() => {
        if (!key || !myPubkey) {
            setGroups([]);
            return;
        }
        const held = placesRef.current;
        let live = true;
        for (const place of held) enterChatInPlace(place.url);
        void readRequestsInPlace(myPubkey, held, () => live).then((read) => { if (live) setGroups(read); }, () => {});
        return () => {
            live = false;
            for (const place of held) void leaveChatInPlace(place.url);
        };
    }, [key, myPubkey, round]);
    const again = useCallback(() => setRound((n) => n + 1), []);
    return [groups, again];
}
