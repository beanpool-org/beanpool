/**
 * Where a member a peer speaks for comes from (FED-02, M3, M5).
 *
 * A peer connector authenticates the CONNECTION (libp2p Noise), not what the peer says about the members it relays
 * or buys for. Before this, a relayed line's sender got the home the payload named (`senderNodeUrl`), and a cross-node
 * buyer the payload's `buyerHomeNode`: so peer A could relay a line "from" a member of community B into B's thread,
 * or name A as the home of a B member who had no row here yet, so replies to them went to A.
 *
 * Now the home is the relaying peer's own address from our connector record for the authenticated peer id, and a
 * member whose row already names another home is refused. The payload's URL is ignored.
 */

import { getConnectorByPeerId } from './connector-manager.js';
import { db } from './db/db.js';

/** Our connector record's public URL for this authenticated peer id, or null when we hold none. */
export function peerHomeUrl(peerId: string): string | null {
    const url = getConnectorByPeerId(peerId)?.publicUrl;
    return typeof url === 'string' && url.trim() ? url.trim() : null;
}

function normaliseHome(url: string): string {
    try {
        return new URL(url).origin.toLowerCase();
    } catch {
        return url.trim().replace(/\/+$/, '').toLowerCase();
    }
}

export function sameHomeUrl(a: string, b: string): boolean {
    return normaliseHome(a) === normaliseHome(b);
}

/**
 * What our members table says about a key a peer claims as one of its own members:
 * - `local`: one of OUR members: a row with no home that is not a visitor's. Never a remote sender or buyer. (A row with
 *   a home reads as remote whatever its is_visitor says: the first boot's visitor marking can leave one at 0.)
 * - `elsewhere`: a visitor whose row already names a different home than this peer's.
 * - `ok`: no row yet, or a visitor with no home (M5: a row a local DM made) or with this peer's home.
 */
export function remoteMemberStanding(publicKey: string, peerHome: string | null): 'local' | 'elsewhere' | 'ok' {
    const row = db.prepare('SELECT is_visitor, home_node_url FROM members WHERE public_key = ?').get(publicKey) as
        { is_visitor: number; home_node_url: string | null } | undefined;
    if (!row) return 'ok';
    if (!row.is_visitor && !row.home_node_url) return 'local';
    if (row.home_node_url && (!peerHome || !sameHomeUrl(row.home_node_url, peerHome))) return 'elsewhere';
    return 'ok';
}
