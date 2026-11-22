/**
 * The communities on this phone, as an address is weighed against them (slice S5 part 2; #3354 review rounds 4 to 6). The rule
 * is core's alone (community-homes.ts nameStanding, whoseName: what a community answers now outranks every copy; copies count
 * only where they agree; anything else is uncertain). This file only gathers what the rule weighs, and every caller goes
 * through it: Message (utils/message-anyone.ts) and the address card (app/address-card.tsx).
 *
 * - **What the phone keeps** ({@link keptNames}, no network): the address it reaches the community at and the ones its record
 *   holds (community-index.ts: where it met it, each proved one; `refused`: each that answered as something else), its signed
 *   list as last seen, and its info as last heard (node-profile.ts). Each is as old as it is: the list of a community the
 *   phone isn't set to has no age limit at all.
 * - **What the community answers now** ({@link askedNow}): its info, asked within a deadline, and only where a copy kept makes
 *   the address one of its names. At the address it is reached at nothing is asked.
 * - **Who the copy has there** ({@link doubted}): where the community says now that an address this phone knew as its own isn't,
 *   and this phone's copy of it still has a row for the person, where they are is in doubt. A row is no proof of a member:
 *   the directory lists visitors' rows too, and the phone can't tell them apart.
 */
import { addressOf, keptClaims, nameStanding, saysNames, type KnownNames } from '@beanpool/core';
import { communityRecordOf, recordAddresses } from './community-index';
import type { NodeProfile } from './node-profile';

/** A community on this phone, as the rule weighs it, and its info: its answer now, else as this phone keeps it. */
export interface PhoneNames extends KnownNames {
    profile: NodeProfile | null;
}

/** What `community` says of itself as this phone keeps it: its info under the address in use, else under `community`. Null: not kept. */
async function keptProfileOf(community: string): Promise<NodeProfile | null> {
    const { getCachedNodeProfile } = await import('./node-profile');
    const using = communityRecordOf(community)?.using;
    const kept = using && using !== community ? await getCachedNodeProfile(using).catch(() => null) : null;
    return kept ?? await getCachedNodeProfile(community).catch(() => null);
}

/** Whether the phone itself keeps `a` and `b` as one community: one spelling, or its record of one holds the other. */
export function keptAsOne(a: string, b: string): boolean {
    const record = communityRecordOf(a);
    const home = addressOf(b);
    return home !== null && [a, ...(record ? recordAddresses(record) : [])].some((x) => addressOf(x) === home);
}

/** What this phone keeps of one community's names, nothing asked. */
async function keptNamesOf(community: string): Promise<PhoneNames> {
    const record = communityRecordOf(community);
    const list = record?.list?.list;
    const profile = await keptProfileOf(community);
    return {
        community, profile,
        reached: record?.using ?? community,
        kept: {
            info: profile,
            list: record?.peerId && list && list.peerId === record.peerId && Array.isArray(list.addresses) ? list.addresses : null,
            record: record ? recordAddresses(record) : null,
        },
        refused: Object.keys(record?.refused ?? {}),
    };
}

/** What this phone keeps of each community's names, nothing asked. */
export async function keptNames(communities: readonly string[]): Promise<PhoneNames[]> {
    const out: PhoneNames[] = [];
    for (const community of communities) out.push(await keptNamesOf(community));
    return out;
}

/** `community`, and every other one this phone saved, as {@link keptNames}. */
export async function keptNamesWith(community: string): Promise<PhoneNames[]> {
    const saved = await import('./nodes').then((m) => m.getSavedNodes()).catch(() => []);
    const all = [community];
    for (const { url } of saved) if (url && !all.some((c) => keptAsOne(c, url))) all.push(url);
    return keptNames(all);
}

/**
 * `names`, each community asked now for its own word where a copy this phone keeps makes one of `addresses` its name (or for
 * which `always` says so): each once, side by side, within the deadline (outside-chat-live.ts answerNow).
 */
export async function askedNow(names: readonly PhoneNames[], addresses: ReadonlyArray<string | null>, always: (n: PhoneNames) => boolean = () => false): Promise<PhoneNames[]> {
    const asked = names.filter((n) => always(n) || addresses.some((a) => nameStanding(n, a) === 'uncertain'));
    if (asked.length === 0) return [...names];
    const { answerNow } = await import('./outside-chat-live');
    return Promise.all(names.map(async (n) => {
        if (!asked.includes(n)) return n;
        const answer = await answerNow(n.reached).catch(() => null);
        return { ...n, answer, profile: answer ?? n.profile };
    }));
}

/** Whether this phone's copy of `community` has a row for `key`, a member's or a visitor's (db.ts). A read that fails: not known, so no. */
async function rowThere(community: string, key: string, inUse: boolean): Promise<boolean> {
    try {
        if (!inUse) return await (await import('./held-chats')).heldMemberThere(community, key);
        const row = await (await import('./db')).getMemberProfile(key);
        return !!row && row.status !== 'pruned';
    } catch {
        return false;
    }
}

/**
 * Whether where the person with `key` at `address` is, is in doubt: a community here says now that the address isn't its name,
 * this phone knew it as one, and its copy there has a row for them (they may be a member there whose contact was saved at the
 * name, or someone at the community that has it now). `inUse`: the community the phone is set to.
 */
export async function doubted(names: readonly PhoneNames[], address: string, key: string, inUse: string | null): Promise<boolean> {
    for (const n of names) {
        if (!saysNames(n.answer) || nameStanding(n, address) !== 'not' || !keptClaims(n, address)) continue;
        if (await rowThere(n.community, key, n.community === inUse)) return true;
    }
    return false;
}
