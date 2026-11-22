/**
 * A community on this phone, by any of its addresses (#3354 review round 4; core community-homes.ts): the one rule by which
 * Message (utils/message-anyone.ts) and the address card (app/address-card.tsx) tell whether a contact's link, a card's home
 * or the home of a chat across names a community this phone is in. What it weighs, no network asked:
 *
 * - the address the phone keeps it under, and the ones its record holds (community-index.ts: where the phone met it, the one
 *   in use, each proved one): an old main address after a move is among them;
 * - what it says of itself: its signed list of addresses, and its info as this phone keeps it (node-profile.ts `addresses`,
 *   `primaryAddress`; then `formerAddresses`, which yield to a community here that goes by the name now).
 *
 * An address that answered the phone as something else (the record's `refused`) is never a HELD community's, whatever that
 * community says. For the community in use it stays one: its own server refuses every line to a name it calls its own.
 *
 * **A name it lost** (round 5) is another community's now: its server answers as it no more, and someone there would never
 * see a chat made here. It stays in the record for good (where the phone met it), so an address only the record holds, when
 * the community says others are its own now, counts only for a person this phone's copy has as a member there.
 */
import { addressOf, communityNamed, formerHomesOf, homesOfCommunity, type NamedCommunity } from '@beanpool/core';
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

/**
 * `community` with every address the phone's record and `profile` (its info) give it. `inUse`: the one the phone is set to.
 * `member`: the person it is asked for is a member there by this phone's copy ({@link addressesFor}), so an address the
 * record alone holds is where they are, one it goes by no more included.
 */
export function addressesOf(community: string, profile: NodeProfile | null, inUse: boolean, member = false): NamedCommunity {
    const record = communityRecordOf(community);
    const using = record?.using ?? community;
    const list = record?.list?.list;
    const listed = record?.peerId && list && list.peerId === record.peerId && Array.isArray(list.addresses) ? list.addresses : [];
    const says = [...homesOfCommunity(using, profile), ...listed];
    const refused = record ? Object.keys(record.refused ?? {}) : [];
    const before = formerHomesOf(using, profile);
    // Heard what it goes by now: an address the record alone holds is no proof any more. One it says it had before is that.
    const now = profile?.addresses?.length ? new Set(says.map((a) => addressOf(a))) : null;
    const proof = (a: string) => a === using || (!refused.includes(a) && (!now || now.has(addressOf(a))));
    const known = (record ? recordAddresses(record) : []).filter((a) => proof(a) || (member && !before.includes(addressOf(a) ?? '')));
    return { community, known, says, before, refused: inUse ? [] : refused };
}

/** Whether this phone's copy of `community` has any of `keys` as a member (db.ts). A read that fails: not known, so no. */
async function memberThere(community: string, keys: readonly string[], inUse: boolean): Promise<boolean> {
    for (const key of keys) {
        try {
            if (inUse) {
                const row = await (await import('./db')).getMemberProfile(key);
                if (row && row.status !== 'pruned') return true;
            } else if (await (await import('./held-chats')).heldMemberThere(community, key)) return true;
        } catch { /* not known */ }
    }
    return false;
}

/**
 * {@link addressesOf} for the person `keys` name, weighed against `addresses` (their links, the homes of chats with them):
 * this phone's copy is asked for them only when one of those is an address the record alone holds.
 */
export async function addressesFor(
    community: string, profile: NodeProfile | null, inUse: boolean, keys: readonly string[], addresses: ReadonlyArray<string | null>,
): Promise<NamedCommunity> {
    const said = addressesOf(community, profile, inUse);
    const whole = addressesOf(community, profile, inUse, true);
    const bySaid = communityNamed([said]);
    const byWhole = communityNamed([whole]);
    const recordAlone = addresses.some((a) => bySaid(a) === null && byWhole(a) !== null);
    return recordAlone && await memberThere(community, keys, inUse) ? whole : said;
}

/**
 * Whether `address` (a home, a link), where the person with `key` is, names the community in use at `community`, by any of
 * its addresses, and no other community this phone saved that goes by it now: the check made as a chat across is
 * (message-anyone.ts openAcrossChat), and the address card's.
 */
export async function namesCommunityInUse(community: string, address: string, key: string, profile?: NodeProfile | null): Promise<boolean> {
    const said = profile === undefined ? await keptProfileOf(community) : profile;
    const communities = [await addressesFor(community, said, true, [key], [address])];
    const saved = await import('./nodes').then((m) => m.getSavedNodes()).catch(() => []);
    for (const { url } of saved) {
        if (url && !keptAsOne(community, url)) communities.push(await addressesFor(url, await keptProfileOf(url), false, [key], [address]));
    }
    return communityNamed(communities)(address) === community;
}
