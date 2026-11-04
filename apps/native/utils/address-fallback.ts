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
 * have failed for five minutes with no answer between them, or at once when the app's first look since it opened (or
 * came back to the front, addressFallbackAppOpened) gets no statement at all from its address: design §3.2, "~5 minutes
 * of tries (or at app open with a connection error)", as the director read it (review of 90712eba). That run's card stays
 * due until the address answers. The failed tries are kept on the phone, so a member who opens the app again within the
 * hour picks up where they left off; a try more than an hour after the last starts the count again, so an old failure
 * never stands for a new one.
 *
 * To where. Only to an address the community itself published, and only once that address has proved, by a statement
 * signed with the key its PeerId names, to be the same community the phone first verified at its own address (the same
 * PeerId and community id, never fewer take-overs: address-follow.ts sameCommunity, against COMMUNITY_IDENTITY_KEY). A
 * phone that kept nothing for its address has nothing to check another against, and is offered nothing. Never from or
 * to http (whoever is in the middle of a home network could name both the address and the identity), never from or to
 * the worldwide community, never to a bare number (a number does not survive a change of server, D3, and the phone
 * falls back for now, to a name), and only to an address communityOrigin takes. While the follow card offers the
 * community's new main address (utils/address-follow.ts addressFollowOffer: not snoozed, and checked to be the same
 * community), this card stays out of its way. Only then: when that card can't show (the member said "Not now" to it, or
 * the main address doesn't answer either, design §3.1), this one goes ahead, so a member is never left with neither. A
 * 'same' that card checked before this run of failed tries began, or five minutes ago or more, is checked again first
 * (sameSince, sameWithin): else its hour-long check kept this card aside while the main address had stopped answering too
 * (review of 533de50e). That costs one check of the move (its two addresses asked) at most every five minutes, and only
 * while this card is due.
 *
 * It costs nothing while there is nothing to fall back to: with no other published name, nobody is asked. "Not now"
 * hides the card for 24 hours, for that pair of addresses only, and a look already on its way when it was said never
 * offers that pair (the snooze is read again before an offer is returned; the card drops that look's answer too).
 */

import { audienceOf } from '@beanpool/core';
import { communityOrigin } from './community-origin';
import { GLOBAL_NODE_URL } from './global-node-url';
import { isPlainNodeAddress } from './node-url';
import {
    COMMUNITY_IDENTITY_KEY, IPV4_HOST, addressFollowOffer, depsWith, followableOrigin, keptIdentityAt, moveCommunity, readMap,
    sameCommunity, sameIdentity, writeEntry,
    type AddressFollowDeps, type CommunityIdentity, type FollowResult,
} from './address-follow';
import type { NodeProfile } from './node-profile';

/** How long the phone's address must have failed, try after try, before the card is offered. */
export const FALLBACK_AFTER_MS = 5 * 60 * 1000;
/** "Not now" hides the card this long, for the same pair of addresses. */
export const FALLBACK_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** `{ ["<from> <to>"]: until }`: the pairs declined, until when. */
export const FALLBACK_SNOOZE_KEY = 'beanpool_address_fallback_snooze';
/**
 * `{ [the phone's address]: { since, last, due? } }`: when its run of failed tries began, the latest, and whether a
 * connection error at the app's open made its card due at once.
 */
export const FALLBACK_TRIES_KEY = 'beanpool_address_fallback_tries';
/** The phone's address is asked at most this often while it isn't answering. */
export const ASK_EVERY_MS = 60 * 1000;
/** And not again for this long after it answered. */
export const ANSWERED_FOR_MS = 5 * 60 * 1000;
/** A failed try more than this long after the last one starts a new run. */
export const TRIES_GAP_MS = 60 * 60 * 1000;
/**
 * Only the first this many other addresses not snoozed, in the community's own order, are ever asked: the rest only once
 * one of those is snoozed. A community publishes a handful; this caps a 32-address list's cost on a phone that can't
 * reach its own.
 */
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
 * storage. None unless the phone's address is one a move may start from (https, not the worldwide community's). The
 * community's main address is among them: whether the follow card offers it instead is addressFallbackOffer's to ask.
 * Each is an address communityOrigin takes on another host, never a number, never the worldwide community.
 */
export function fallbackCandidates(
    anchor: string | null | undefined, profile: Pick<NodeProfile, 'addresses' | 'primaryAddress'> | null | undefined,
): AddressFallbackOffer[] {
    const from = followableOrigin(anchor);
    const here = from ? audienceOf(from) : null;
    if (!from || !here) return [];
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

interface Tries { since: number; last: number; due?: true }

function readTries(v: unknown): Tries | null {
    const t = v as Partial<Tries> | null | undefined;
    if (!t || typeof t.since !== 'number' || typeof t.last !== 'number' || t.since > t.last) return null;
    return t.due === true ? { since: t.since, last: t.last, due: true } : { since: t.since, last: t.last };
}

/** This run's last ask of each phone address: when, and whether it answered (ASK_EVERY_MS, ANSWERED_FOR_MS). */
const asked = new Map<string, { at: number; answered: boolean }>();
/**
 * This run's asks of other addresses: `"<from> <to>"` → the statement there (null: none) and when. The statement, not a
 * verdict: it is judged each round against what is kept then, so a take-over seen since at the phone's address counts.
 */
const checked = new Map<string, { there: CommunityIdentity | null; at: number }>();
/** Whether the next look is the app's first since it opened: true when the app starts, and again via addressFallbackAppOpened. */
let opening = true;

/**
 * The app came back to the front (from the background): its next look is at app open again, so a connection error then
 * makes the card due at once (design §3.2). Home's card calls it (components/AddressFallbackCard.tsx).
 */
export function addressFallbackAppOpened(): void {
    opening = true;
}

/** Forget this run's asks and checks (tests). A test starts mid-run: a cold start is this, then addressFallbackAppOpened. */
export function forgetFallbackChecks(): void {
    asked.clear();
    checked.clear();
    opening = false;
}

/**
 * When this run of failed tries at the phone's address `from` began, if it has not answered as its community for
 * FALLBACK_AFTER_MS of tries, or gave no statement at all at the app's open (`atOpen`: asked then whatever the last ask
 * was); else null. Asks it, unless it was asked within the minute (or answered within five). A statement of the same
 * community with more take-overs raises what is kept, as the follow card's check does, so the replaced server is never a
 * way back in.
 */
async function notAnswering(from: string, kept: CommunityIdentity, deps: AddressFollowDeps, atOpen: boolean): Promise<number | null> {
    const now = deps.now();
    const last = asked.get(from);
    const fresh = !atOpen && last && now - last.at >= 0 && now - last.at < (last.answered ? ANSWERED_FOR_MS : ASK_EVERY_MS);
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
            // A connection error at the app's open (no statement at all) makes this run's card due from now on.
            const due = (goesOn && run.due) || (atOpen && !said);
            const next: Tries = { since: goesOn ? run.since : now, last: now };
            await writeEntry<Tries>(FALLBACK_TRIES_KEY, from, due ? { ...next, due: true } : next);
        }
    }
    if (answered) return null;
    const run = readTries((await readMap<Tries>(FALLBACK_TRIES_KEY))[from]);
    return run && (run.due === true || now - run.since >= FALLBACK_AFTER_MS) ? run.since : null;
}

async function snoozed(offer: AddressFallbackOffer, now: number): Promise<boolean> {
    const until = (await readMap<unknown>(FALLBACK_SNOOZE_KEY))[`${offer.from} ${offer.to}`];
    return typeof until === 'number' && until > now;
}

/**
 * The card's question, or null: the phone's address hasn't answered as its community for five minutes of tries (or gave
 * no statement at the app's open), the follow card has no move to show, and another address the community published
 * answers as that same community, checked by its signed statement. The first such in the community's own order,
 * skipping a pair the member said "Not now" to in the last 24 hours. Writes nothing but the run of failed tries and what
 * the phone verified of its own community: never the community's address.
 */
export async function addressFallbackOffer(injected?: Partial<AddressFollowDeps>): Promise<AddressFallbackOffer | null> {
    // The first look since the app opened, whatever it finds: a later look is not at app open.
    const atOpen = opening;
    opening = false;
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
    const since = await notAnswering(from, kept, deps, atOpen);
    if (since === null) return null;
    // The follow card shows the community's new main address: this card stays out of its way. Only when that card will
    // show (not snoozed, and checked to be the community), never merely because the community names another main address,
    // and only on a 'same' checked since this run of failed tries began and less than five minutes ago: one from before
    // says nothing of whether the main address answers now, with the phone's own not answering (review of 533de50e).
    if (await addressFollowOffer(deps, { sameSince: since, sameWithin: FALLBACK_AFTER_MS })) return null;
    // What is kept now: the follow card's check may have raised it just now.
    const keptNow = (await keptIdentityAt(from)) ?? kept;
    const same = await Promise.all(open.slice(0, MAX_ASKED).map(async (c) => {
        const id = `${c.from} ${c.to}`;
        const memo = checked.get(id);
        const ttl = memo && !memo.there ? UNREACHABLE_TTL_MS : VERDICT_TTL_MS;
        const now = deps.now();
        let there: CommunityIdentity | null;
        if (memo && now - memo.at >= 0 && now - memo.at < ttl) {
            there = memo.there;
        } else {
            there = await deps.statement(c.to);
            checked.set(id, { there, at: now });
        }
        // Its statement, verified, never fewer take-overs than kept now: judged each round, never a verdict kept.
        return !!there && sameCommunity(keptNow, there);
    }));
    // The snoozes again: "Not now" may have been said while this look waited on the network (review of 533de50e). A pair
    // just declined is never offered by it; another pair found the same is, as the next look would offer it.
    for (let i = 0; i < same.length; i++) if (same[i] && !(await snoozed(open[i], deps.now()))) return open[i];
    return null;
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
