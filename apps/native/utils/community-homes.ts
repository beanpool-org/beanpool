/**
 * A community on this phone, by any of its addresses (#3354 review round 4; core community-homes.ts): the one rule by which
 * Message (utils/message-anyone.ts) and the address card (app/address-card.tsx) tell whether a contact's link, a card's home
 * or the home of a chat across names a community this phone is in. What it weighs, no network asked:
 *
 * - the address the phone keeps it under, and every one its record holds (community-index.ts: where the phone met it, the
 *   one in use, each proved one): an old main address after a move is among them;
 * - what it says of itself: its signed list of addresses, and its info as this phone keeps it (node-profile.ts `addresses`,
 *   `primaryAddress`, `formerAddresses`).
 *
 * An address that answered the phone as something else (the record's `refused`) is never a HELD community's, whatever that
 * community says. For the community in use it stays one: its own server refuses every line to a name it calls its own.
 */
import { communityNamed, homesOfCommunity, type NamedCommunity } from '@beanpool/core';
import { communityRecordOf, recordAddresses } from './community-index';
import type { NodeProfile } from './node-profile';

/** What `community` says of itself as this phone keeps it: its info under the address in use, else under `community`. Null: not kept. */
export async function keptProfileOf(community: string): Promise<NodeProfile | null> {
    const { getCachedNodeProfile } = await import('./node-profile');
    const using = communityRecordOf(community)?.using;
    const kept = using && using !== community ? await getCachedNodeProfile(using).catch(() => null) : null;
    return kept ?? await getCachedNodeProfile(community).catch(() => null);
}

/** Whether the phone itself keeps `a` and `b` as one community (one spelling, or its record of one holds the other), whatever either says. */
export function keptAsOne(a: string, b: string): boolean {
    const record = communityRecordOf(a);
    return communityNamed([{ community: a, known: record ? recordAddresses(record) : [] }])(b) !== null;
}

/** `community` with every address the phone's record and `profile` (its info) give it. `inUse`: the one the phone is set to. */
export function addressesOf(community: string, profile: NodeProfile | null, inUse: boolean): NamedCommunity {
    const record = communityRecordOf(community);
    const list = record?.list?.list;
    const listed = record?.peerId && list && list.peerId === record.peerId && Array.isArray(list.addresses) ? list.addresses : [];
    return {
        community,
        known: record ? recordAddresses(record) : [],
        says: [...homesOfCommunity(record?.using ?? community, profile), ...listed],
        refused: record && !inUse ? Object.keys(record.refused ?? {}) : [],
    };
}

/** Whether `address` (a home, a link) names the community in use at `community`, by any of its addresses: the address card's check. */
export async function namesCommunityInUse(community: string, address: string, profile?: NodeProfile | null): Promise<boolean> {
    const said = profile === undefined ? await keptProfileOf(community) : profile;
    return communityNamed([addressesOf(community, said, true)])(address) !== null;
}
