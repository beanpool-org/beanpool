/**
 * Which community a join screen joins (DESIGN-shared-listing-door-fable.md §2.5 and §2.4, slice N1). Damo, 9 Nov: "it's not
 * intuitive for a new user WHAT NODE they are even joining … the normies will be THINKING they are joining the node where the
 * offer was posted." Every join screen says it: "Join the global community" at the app's global, "Join {name}" at any other
 * community (a self-hoster's open one, or a local one), where {name} is the community's own name from its public card, else
 * the address the page is served from. The member's word is "community", never "node".
 *
 * Two small reads, both public and both made at most once per page load: this community's card (`/api/community/card`,
 * only where it is not the app's global, whose name needs no asking) and, for a lobby opened with `?ask=<host>`, global's
 * list entry for that host (`/api/global/communities?host=`, which is how Home's Find card names it after the join).
 */
import { useEffect, useState } from 'react';
import { communityCardName, t, type CommunityCard } from '@beanpool/core';
import { getCommunityCard, getListedCommunityByHost } from './api';
import { webAppHost } from './former-address';

/** The heading of a join screen: the global community's own words at ours, else "Join {name}". */
export function joinHeading(ours: boolean, name: string): string {
    return ours ? t('Join the global community') : t('Join {name}', { name });
}

/** Under the card panel, the invite form's heading: which community the code is for. */
export function inviteHeading(name: string): string {
    return t('Join {name} with an invite', { name });
}

/** At the top of global's Join card when a community's card sent the visitor here: this is not that community. */
export function askedElsewhereLine(name: string): string {
    return t('This is the global community, not {name}. Join here first, then find {name} under Find a community.', { name });
}

/** What a join screen calls this community when it has no name of its own to give: the address the page is served from. */
export function ownCommunityAddress(): string {
    return communityCardName({ name: null, host: webAppHost() }, { t });
}

let cardOnce: Promise<CommunityCard | null> | null = null;

/** This community's public card, read once per page load and shared. A read that fails is not kept: the next caller asks again. */
export function ownCommunityCardOnce(): Promise<CommunityCard | null> {
    if (!cardOnce) {
        cardOnce = getCommunityCard().catch((e) => {
            cardOnce = null;
            throw e;
        });
    }
    return cardOnce;
}

/** Tests only: forget the shared read, as a new page load would. */
export function resetOwnCommunityCardOnce(): void {
    cardOnce = null;
}

/**
 * What a join screen at THIS community calls it: its card's name, else its card's address; until the card answers (or
 * where it never does, a node too old to have one) the address this page is served from, so a heading never says nothing
 * and never says "BeanPool" alone. `read` false: the community is the app's global and needs no name asked for.
 */
export function useOwnCommunityName(read: boolean): string {
    const [name, setName] = useState(ownCommunityAddress);
    useEffect(() => {
        if (!read) return;
        let cancelled = false;
        ownCommunityCardOnce()
            .then((card) => { if (!cancelled && card) setName(communityCardName(card, { t })); })
            .catch(() => { /* the address stays */ });
        return () => { cancelled = true; };
    }, [read]);
    return name;
}

/** The community a card sent the visitor here to ask: its name in global's list, else its host. */
export function useAskedCommunityName(host: string | null): string | null {
    const [name, setName] = useState<string | null>(host);
    useEffect(() => {
        setName(host);
        if (!host) return;
        let cancelled = false;
        getListedCommunityByHost(host)
            .then((row) => { if (!cancelled && row?.name) setName(row.name); })
            .catch(() => { /* the host stays */ });
        return () => { cancelled = true; };
    }, [host]);
    return name;
}
