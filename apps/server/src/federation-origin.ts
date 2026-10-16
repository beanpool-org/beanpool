/**
 * Where a member a peer speaks for comes from (FED-02, M3, M5).
 *
 * A peer connector authenticates the CONNECTION (libp2p Noise), not what the peer says about the members it relays
 * or buys for. Before this, a relayed line's sender got the home the payload named (`senderNodeUrl`), and a cross-node
 * buyer the payload's `buyerHomeNode`: so a peer could name any community at all, a third one included, as the home of
 * a member who had no row here yet.
 *
 * Now a new row takes the relaying peer's own address, from our connector record for the authenticated peer id, and
 * the payload's URL is ignored. A row that already names a home keeps it (engine/members.ts writeVisitorRow), and a
 * later peer relaying or buying for that key is still served: a member of two communities keeps one key on every node
 * (apps/native/utils/join-another-community.ts), and an operator may correct a peer's public URL. (A refusal of a key
 * whose row names another home turned both away: #2039 review B1.)
 *
 * What this does not close: the first configured peer to mention a key decides its home here, and any configured peer
 * can put a line under an existing visitor's name. Per-message sender signatures (a protocol change) close that.
 */

import { getConnectorByPeerId } from './connector-manager.js';
import { db } from './db/db.js';

/** Our connector record's public URL for this authenticated peer id, or null when we hold none. */
export function peerHomeUrl(peerId: string): string | null {
    const url = getConnectorByPeerId(peerId)?.publicUrl;
    return typeof url === 'string' && url.trim() ? url.trim() : null;
}

/**
 * Whether a key a peer claims as one of its own members is one of OURS: a row with no home that is not a visitor's.
 * Never a remote sender or buyer. A row with a home reads as remote whatever its is_visitor says (the first boot's
 * visitor marking can leave one at 0), and a visitor's row with no home (M5: a row a local DM made) is not ours.
 */
export function isLocalMemberKey(publicKey: string): boolean {
    const row = db.prepare('SELECT is_visitor, home_node_url FROM members WHERE public_key = ?').get(publicKey) as
        { is_visitor: number; home_node_url: string | null } | undefined;
    return !!row && !row.is_visitor && !row.home_node_url;
}
