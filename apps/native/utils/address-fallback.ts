/**
 * A second way in when the phone's address stops answering (scratch/fable-design/DESIGN-dns-robustness-fable.md §3.2,
 * slice S3; Marty's pick 2 Nov: a card after about 5 minutes of failed reads, never silent).
 *
 * A community can answer at more than one address (`addresses` in its info: its beanpool.org names, its own domain).
 * The phone keeps them in its copy of the community's profile (utils/node-profile.ts, read hourly) and, until now, used
 * them only to follow a changed main address (utils/address-follow.ts). When the phone's own address stops answering
 * (a name's DNS answer gone wrong, its tunnel down), the others may still work. Home then shows one card
 * (components/AddressFallbackCard.tsx): "byron.beanpool.org isn't answering. Your community also answers at
 * mullum.beanpool.org. Use that for now?". Tapping it moves the phone by the follow card's own move (moveCommunity in
 * address-follow.ts: utils/reconnect.ts switchPhoneTo, the copy and what guards its chats carried first). When the main
 * address answers again, the follow card offers the way back, as for any move of the community's main address.
 *
 * When. The phone asks its own address for the community's signed statement (GET /api/node/identity-epoch, the same
 * public route the follow card reads): at most once a minute while it isn't answering, and not again for five minutes
 * after it answered. A try fails when no statement comes, or one that isn't the community the phone first verified
 * there (another server answering at the name, or an older one of the community). The card is offered once the tries
 * have failed for five minutes with no answer between them. The failed tries are kept on the phone, so a member who
 * opens the app again within the hour picks up where they left off ("at app open with a connection error", design
 * §3.2); a try more than an hour after the last starts the count again, so an old failure never stands for a new one.
 *
 * To where. Only to an address the community itself published, and only once that address has proved, by a statement
 * signed with the key its PeerId names, to be the same community the phone first verified at its own address (the same
 * PeerId and community id, never fewer take-overs: address-follow.ts sameCommunity, against COMMUNITY_IDENTITY_KEY). A
 * phone that kept nothing for its address has nothing to check another against, and is offered nothing. Never from or
 * to http (whoever is in the middle of a home network could name both the address and the identity), never from or to
 * the worldwide community, never to a bare number (a number does not survive a change of server, D3, and the phone
 * falls back for now, to a name), and only to an address communityOrigin takes. While the community says it lives
 * somewhere else now, the follow card says so and this card stays out of its way.
 *
 * It costs nothing while there is nothing to fall back to: with no other published name, nobody is asked. "Not now"
 * hides the card for 24 hours, for that pair of addresses only.
 */

import { audienceOf } from '@beanpool/core';
import { communityOrigin } from './community-origin';
import { GLOBAL_NODE_URL } from './global-node-url';
import { isPlainNodeAddress } from './node-url';
import {
    COMMUNITY_IDENTITY_KEY, IPV4_HOST, depsWith, followCandidate, followableOrigin, keptIdentityAt, moveCommunity, readMap,
    sameCommunity, sameIdentity, writeEntry,
    type AddressFollowDeps, type CommunityIdentity, type FollowCheck, type FollowResult,
} from './address-follow';
import type { NodeProfile } from './node-profile';

/** How long the phone's address must have failed, try after try, before the card is offered. */
export const FALLBACK_AFTER_MS = 5 * 60 * 1000;
/** "Not now" hides the card this long, for the same pair of addresses. */
export const FALLBACK_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** `{ ["<from> <to>"]: until }`: the pairs declined, until when. */
export const FALLBACK_SNOOZE_KEY = 'beanpool_address_fallback_snooze';
/** `{ [the phone's address]: { since, last } }`: when its run of failed tries began, and the latest. */
export const FALLBACK_TRIES_KEY = 'beanpool_address_fallback_tries';
/** The phone's address is asked at most this often while it isn't answering. */
export const ASK_EVERY_MS = 60 * 1000;
/** And not again for this long after it answered. */
export const ANSWERED_FOR_MS = 5 * 60 * 1000;
/** A failed try more than this long after the last one starts a new run. */
export const TRIES_GAP_MS = 60 * 60 * 1000;
/** At most this many other addresses are asked in one round, in the community's own order. */
const MAX_ASKED = 6;
/** How long another address's check is reused (an hour; five minutes when it gave no answer), as the follow card's. */
const VERDICT_TTL_MS = 60 * 60 * 1000;
const UNREACHABLE_TTL_MS = 5 * 60 * 1000;

export interface AddressFallbackOffer {
    /** The phone's community address now (not answering), as an origin. */
    from: string;
    /** Another address the community published, checked to be the same community, as an origin. */
    to: string;
    /** `from`'s host, for the card's sentence. */
    fromHost: string;
    /** `to`'s host (and port), for the card's sentence. */
    host: string;
}

/**
 * Every other address the phone could fall back to, in the community's own order, or none. Pure: no network, no
 * storage. None unless the phone's address is one a move may start from (https, not the worldwide community's), and
 * none while the community says it lives somewhere else now (the follow card's move). Each is an address communityOrigin
 * takes on another host, never a number, never the worldwide community.
 */
export function fallbackCandidates(
    anchor: string | null | undefined, profile: Pick<NodeProfile, 'addresses' | 'primaryAddress'> | null | undefined,
): AddressFallbackOffer[] {
    const from = followableOrigin(anchor);
    const here = from ? audienceOf(from) : null;
    if (!from || !here) return [];
    if (followCandidate(anchor, profile)) return [];
    const global = audienceOf(GLOBAL_NODE_URL);
    const seen = new Set([here]);
    const out: AddressFallbackOffer[] = [];
    for (const a of profile?.addresses ?? []) {
        const to = communityOrigin(`https://${a}`);
        const there = to && isPlainNodeAddress(to) && to.startsWith('https://') ? audienceOf(to) : null;
        if (!to || !there || seen.has(there) || there === global || IPV4_HOST.test(there) || there.startsWith('[')) continue;
        seen.add(there);
        out.push({ from, to, fromHost: from.slice('https://'.length), host: to.slice('https://'.length) });
    }
    return out;
}

interface Tries { since: number; last: number }

function readTries(v: unknown): Tries | null {
    const t = v as Partial<Tries> | null | undefined;
    return t && typeof t.since === 'number' && typeof t.last === 'number' && t.since <= t.last ? { since: t.since, last: t.last } : null;
}

/** This run's last ask of each phone address: when, and whether it answered (ASK_EVERY_MS, ANSWERED_FOR_MS). */
const asked = new Map<string, { at: number; answered: boolean }>();
/** This run's checks of other addresses: `"<from> <to>"` → the answer and when. */
const checked = new Map<string, { verdict: FollowCheck; at: number }>();

/** Forget this run's asks and checks (tests). */
export function forgetFallbackChecks(): void {
    asked.clear();
    checked.clear();
}

/**
 * Whether the phone's address `from` has not answered as its community for FALLBACK_AFTER_MS of tries. Asks it, unless
 * it was asked within the minute (or answered within five). A statement of the same community with more take-overs
 * raises what is kept, as the follow card's check does, so the replaced server is never a way back in.
 */
async function notAnswering(from: string, kept: CommunityIdentity, deps: AddressFollowDeps): Promise<boolean> {
    const now = deps.now();
    const last = asked.get(from);
    const fresh = last && now - last.at >= 0 && now - last.at < (last.answered ? ANSWERED_FOR_MS : ASK_EVERY_MS);
    let answered: boolean;
    if (fresh) {
        answered = last.answered;
    } else {
        const said = await deps.statement(from);
        answered = !!said && sameCommunity(kept, said);
        asked.set(from, { at: now, answered });
        if (said && sameIdentity(kept, said) && said.epoch > kept.epoch) await writeEntry(COMMUNITY_IDENTITY_KEY, from, { ...kept, epoch: said.epoch });
        const run = readTries((await readMap<Tries>(FALLBACK_TRIES_KEY))[from]);
        if (answered) {
            if (run) await writeEntry(FALLBACK_TRIES_KEY, from, undefined);
        } else {
            const goesOn = run && now - run.last >= 0 && now - run.last <= TRIES_GAP_MS;
            await writeEntry<Tries>(FALLBACK_TRIES_KEY, from, { since: goesOn ? run.since : now, last: now });
        }
    }
    if (answered) return false;
    const run = readTries((await readMap<Tries>(FALLBACK_TRIES_KEY))[from]);
    return !!run && now - run.since >= FALLBACK_AFTER_MS;
}

/** Whether `offer.to` is the community the phone kept at `offer.from`: its statement, verified, never fewer take-overs. */
async function checkOther(offer: AddressFallbackOffer, kept: CommunityIdentity, deps: AddressFollowDeps): Promise<FollowCheck> {
    const there = await deps.statement(offer.to);
    if (!there) return 'unreachable';
    return sameCommunity(kept, there) ? 'same' : 'not-same';
}

async function snoozed(offer: AddressFallbackOffer, now: number): Promise<boolean> {
    const until = (await readMap<unknown>(FALLBACK_SNOOZE_KEY))[`${offer.from} ${offer.to}`];
    return typeof until === 'number' && until > now;
}

/**
 * The card's question, or null: the phone's address hasn't answered as its community for five minutes of tries, and
 * another address the community published answers as that same community, checked by its signed statement. The first
 * such in the community's own order, skipping a pair the member said "Not now" to in the last 24 hours. Writes nothing
 * but the run of failed tries and what the phone verified of its own community: never the community's address.
 */
export async function addressFallbackOffer(injected?: Partial<AddressFollowDeps>): Promise<AddressFallbackOffer | null> {
    const deps = await depsWith(injected);
    const anchor = await deps.anchor().catch(() => null);
    const from = followableOrigin(anchor);
    if (!anchor || !from) return null;
    const all = fallbackCandidates(anchor, await deps.profile(anchor).catch(() => null));
    if (!all.length) return null;
    const kept = await keptIdentityAt(from);
    if (!kept) return null;
    const open: AddressFallbackOffer[] = [];
    for (const c of all) if (!(await snoozed(c, deps.now()))) open.push(c);
    if (!open.length) return null;
    if (!(await notAnswering(from, kept, deps))) return null;
    const verdicts = await Promise.all(open.slice(0, MAX_ASKED).map(async (c) => {
        const id = `${c.from} ${c.to}`;
        const memo = checked.get(id);
        const ttl = memo?.verdict === 'unreachable' ? UNREACHABLE_TTL_MS : VERDICT_TTL_MS;
        const now = deps.now();
        if (memo && now - memo.at >= 0 && now - memo.at < ttl) return memo.verdict;
        const verdict = await checkOther(c, kept, deps);
        checked.set(id, { verdict, at: now });
        return verdict;
    }));
    const i = verdicts.indexOf('same');
    return i >= 0 ? open[i] : null;
}

/** "Not now": the same pair is not offered again for 24 hours. Another address of the community is another pair. */
export async function snoozeAddressFallback(offer: AddressFallbackOffer, injected?: Partial<AddressFollowDeps>): Promise<void> {
    const deps = await depsWith(injected);
    await writeEntry(FALLBACK_SNOOZE_KEY, `${offer.from} ${offer.to}`, deps.now() + FALLBACK_SNOOZE_MS);
}

/**
 * The member chose the other address. Checked again first, by the same rules and the same community's statement (the
 * card may have waited), then moved by the follow card's own move (address-follow.ts moveCommunity: the guest mark, the
 * switch with the copy carried, the profile change waiting, alerts turned off, the saved row). The run of failed tries at
 * the old address and this pair's "Not now" are forgotten. Results as the follow card's: only 'moved' and
 * 'moved-kept-both' moved anything.
 */
export async function acceptAddressFallback(offer: AddressFallbackOffer, injected?: Partial<AddressFollowDeps>): Promise<FollowResult> {
    const deps = await depsWith(injected);
    const anchor = await deps.anchor().catch(() => null);
    if (!anchor || followableOrigin(anchor) !== offer.from) return 'gone';
    // The offer by the same rules as when it was made, never a move the card was handed some other way.
    if (!fallbackCandidates(anchor, { addresses: [offer.host] }).some(c => c.to === offer.to)) return 'not-same';
    const kept = await keptIdentityAt(offer.from);
    if (!kept) return 'unreachable';
    // Asked again at the old address too: a take-over there since raises what is kept, as the follow card's check does.
    const [now, there] = await Promise.all([deps.statement(offer.from), deps.statement(offer.to)]);
    const here = now && sameIdentity(kept, now) && now.epoch > kept.epoch ? { ...kept, epoch: now.epoch } : kept;
    if (here !== kept) await writeEntry(COMMUNITY_IDENTITY_KEY, offer.from, here);
    checked.delete(`${offer.from} ${offer.to}`);
    if (!there) return 'unreachable';
    if (!sameCommunity(here, there)) return 'not-same';
    const moved = await moveCommunity(offer, anchor, deps);
    await writeEntry(FALLBACK_TRIES_KEY, offer.from, undefined);
    await writeEntry(FALLBACK_SNOOZE_KEY, `${offer.from} ${offer.to}`, undefined);
    asked.delete(offer.from);
    return moved;
}
