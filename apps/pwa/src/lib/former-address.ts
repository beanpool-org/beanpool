/**
 * The web app opened at a BeanPool name its community had before says where the community lives now (lost-name L4;
 * design scratch/registrar/DESIGN-lost-name-audience-opus.md §6; Marty, 2026-09-28: a web banner now, the phone app
 * follows renames later).
 *
 * The node says both halves in `/api/community/info`: `primaryAddress`, where the community lives now, and
 * `formerAddresses`, the names it had before (still accepted, never published). Nothing here moves anyone: a member's
 * key lives in this address's storage, so a redirect couldn't take it, and must never take it or anything signed. The
 * banner offers a plain link to the new address, which the member opens and signs in at.
 */

import { audienceOf } from '@beanpool/core';
import { getNodeApiUrl, type CommunityInfo } from './api';

export interface FormerAddressNotice {
    /** Where the community lives now: a bare host. */
    primaryAddress: string;
    /** `https://<primaryAddress>/`, nothing more: no path, no query, nothing of this address's. */
    href: string;
}

/** A bare host in the form a signature carries it (audienceOf): no scheme, port, path or user, lower case. */
const isBareHost = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && audienceOf(v) === v;

/**
 * What to tell someone who opened the web app at `host`: where the community lives now when `host` is one of its
 * former names and the node names a current one; null otherwise (its current name or any other, a node with no
 * current name, or one too old to say).
 */
export function formerAddressNotice(
    info: Pick<CommunityInfo, 'primaryAddress' | 'formerAddresses'> | null | undefined,
    host: string | null,
): FormerAddressNotice | null {
    if (!info || !host) return null;
    const primary = info.primaryAddress;
    if (!isBareHost(primary) || primary === host) return null;
    if (!Array.isArray(info.formerAddresses) || !info.formerAddresses.includes(host)) return null;
    return { primaryAddress: primary, href: `https://${primary}/` };
}

/**
 * The host the web app reaches its community at: the detached node's (`bp_node_url`) when one is set, else this
 * page's, as every signature it makes names (lib/api.ts nodeAddress).
 */
export function webAppHost(): string | null {
    const url = getNodeApiUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
    return url ? audienceOf(url) : null;
}
