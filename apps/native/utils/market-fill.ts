/**
 * The Market's fill on the phone (Damo via Marty, 30 Oct; the rule is core's market-fill.ts, the web's the same). On a
 * community that syncs listings by area the phone's list is the nearby set it holds; when that leaves fewer than
 * FILL_BELOW in view, the newest from everywhere come beneath it, read from the node as the Market's search reads (the
 * same route, the same rows, the same type and category), with no words to search for and no point: the newest 50.
 *
 * Not for a member with no area (the node already gave them the newest worldwide), not while a search is typed (that is
 * a read of the whole node already), not under Events, a group, or a picked distance, which narrow the list on purpose.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { wantsFill, word } from '@beanpool/core';
import type { NodeProfile } from './node-profile';
import { EVENT_TYPES_QUERY } from './events';
import { marketSecondRow, type MarketTypeFilter } from './market-filters';

/** The section's heading: a word() key, shown through t() (the list's headings are). */
export const ELSEWHERE_HEADING = word('Newest from elsewhere');

/** The node's page, which is the most the fill holds (core FILL_MAX). */
const READ_LIMIT = 50;

/** The type and the category a read of the node is narrowed by, as `&`-led query pieces: the Market search's own. */
export function marketServerFilter(filter: MarketTypeFilter, categoryFilter: string): { type: string; cat: string } {
    // Events are opt-in on the list route; All and Events ask for them.
    const type = filter === 'all' ? `&${EVENT_TYPES_QUERY}` : filter === 'for-you' ? '' : filter === 'needs' ? '&type=need' : filter === 'polls' ? '&type=poll' : filter === 'events' ? '&type=event' : '&type=offer';
    // Only while the category chip is on screen (not under Polls or Events).
    const row = marketSecondRow(filter);
    const cat = categoryFilter !== 'all' && row.kind === 'filters' && row.category ? `&category=${categoryFilter}` : '';
    return { type, cat };
}

/**
 * Rows the node answered, as the feed reads them. The server returns camelCase MarketplacePost; the UI reads snake_case
 * (matching local SQLite shape). Normalize and parse photos.
 */
export function normalizeServerPosts(data: unknown, anchorUrl: string): any[] {
    return (Array.isArray(data) ? data : []).map((p: any) => {
        let photosArr = p.photos;
        if (typeof p.photos === 'string') {
            try { photosArr = JSON.parse(p.photos); } catch { photosArr = []; }
        }
        if (Array.isArray(photosArr)) {
            photosArr = photosArr.map((url: string) => url && url.startsWith('/') ? `${anchorUrl}${url}` : url);
        }
        const bannerUrl = p.authorBannerUrl || p.author_banner_url || null;
        const absoluteBannerUrl = bannerUrl && bannerUrl.startsWith('/') ? `${anchorUrl}${bannerUrl}` : bannerUrl;
        return {
            ...p,
            photos: photosArr,
            author_pubkey: p.author_pubkey ?? p.authorPublicKey,
            author_callsign: p.author_callsign ?? p.authorCallsign,
            author_avatar: p.author_avatar ?? p.authorAvatarUrl ?? null,
            author_banner_url: absoluteBannerUrl,
            authorBannerUrl: absoluteBannerUrl,
            author_energy_cycled: p.author_energy_cycled ?? p.authorEnergyCycled ?? 0,
            authorFoundingNeeded: p.authorFoundingNeeded ?? (p.author_founding_needed === 1),
            author_founding_needed: p.author_founding_needed ?? (p.authorFoundingNeeded ? 1 : 0),
            // #108: the server returns camelCase `cashAlsoNeeded`; local SQLite rows carry
            // snake_case 0/1. Normalise here — the same place the other mixed-casing fields
            // are reconciled — so the beans-only filter AND the card badge both keep working
            // while a server search is active. Guarding at each call site instead would leave
            // the next reader to rediscover this.
            cash_also_needed: p.cash_also_needed ?? (p.cashAlsoNeeded ? 1 : 0),
        };
    });
}

export interface FillInputs {
    /** The node's profile: the switch is `features.nearbyListings`. */
    profile: NodeProfile | null | undefined;
    /** Signed in as a member of this community. */
    member: boolean;
    /** The member has no area on this community: the node already gave them the newest worldwide. */
    noArea: boolean;
    searching: boolean;
    filter: MarketTypeFilter;
    groupFiltered: boolean;
    distancePicked: boolean;
    /** The community refused this phone its listings, or the first sync has not landed. */
    ready: boolean;
    /** How many listings the nearby list shows, under the member's filters. */
    shownNear: number;
}

/** Whether the list is to be filled from elsewhere. */
export function fillWanted(i: FillInputs): boolean {
    return !!i.profile?.features?.nearbyListings && i.member && i.ready && !i.noArea && !i.searching
        && i.filter !== 'events' && !i.groupFiltered && !i.distancePicked && wantsFill(i.shownNear);
}

/** The newest from everywhere under the type and category, normalised as the feed reads rows; null when it can't be read. */
export async function readElsewhere(filter: MarketTypeFilter, categoryFilter: string): Promise<any[] | null> {
    try {
        const anchorUrl = await AsyncStorage.getItem('beanpool_anchor_url');
        if (!anchorUrl) return null;
        const { type, cat } = marketServerFilter(filter, categoryFilter);
        const query = `${type}${cat}&limit=${READ_LIMIT}`.replace(/^&/, '');
        const res = await fetch(`${anchorUrl}/api/marketplace/posts?${query}`);
        if (!res.ok) return null;
        return normalizeServerPosts(await res.json(), anchorUrl);
    } catch {
        return null;
    }
}
