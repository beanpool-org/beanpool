/**
 * Public channel fetching & helpers for Native clients (The Pulse, Phase 1).
 */

import { type PublicCreatorChannel } from '@beanpool/core';
import { anchorUrl } from './node-post';

/**
 * Fetch a member's syndicated channels from their community node.
 *
 * GET /api/members/:publicKey/channels returns the channels the member chose to
 * syndicate (syndicate_to_node = 1) while their membership status is active.
 *
 * Returns an empty array if off-grid or if the member publishes no channels.
 */
export async function fetchPublicChannels(pubkey: string): Promise<PublicCreatorChannel[]> {
    if (!pubkey || !/^[0-9a-f]{64}$/i.test(pubkey)) return [];
    try {
        const url = await anchorUrl();
        if (!url) return [];
        const res = await fetch(`${url.replace(/\/+$/, '')}/api/members/${encodeURIComponent(pubkey)}/channels`);
        if (!res.ok) return [];
        const data = await res.json().catch(() => ({}));
        return Array.isArray(data?.channels) ? data.channels : [];
    } catch {
        return [];
    }
}
