/**
 * Federation links — a peer relationship as an enterprise (#143, slice step 3).
 *
 * Spec: docs/federation-connector.md §7. Two halves already existed and had nothing joining them: the
 * `bridge_<peer>` account that carries the tab (#104), and the `is_treasury=1` enterprise with a keeper
 * from `treasury_operators` (#106). A link is that join, so that a community can SEE its own energy
 * balance and has a named person accountable for acting on it.
 *
 * THE TWO NUMBERS ON A LINK, which must never be added together:
 *
 *   energy balance  balance of `bridge_<peerId>`. What we owe the peer, or they owe us. NOT spendable —
 *                   §2.2 is explicit, and §2.4 separated bridge accounts from the Commons precisely so
 *                   "what we owe Byron" stays a different question from "what we have to spend".
 *   treasury        balance of the link's own member account. Real beans, funded from the Commons pot,
 *                   which is what a keeper commissions with when they call a favour in (step 5).
 *
 * LINKS ARE DERIVED, NOT PUSHED. A link exists for every connector that has a credit cap. Rather than
 * hooking the cap setter — `connector-manager` cannot import this module, because `federation-bridge`
 * already imports `connector-manager` and the cycle would be real — `reconcileFederationLinks()`
 * converges the set, and is called on boot and after a cap is set. Convergent rather than incremental
 * means a cap applied by hand-editing connectors.json still produces a link, and running it twice is a
 * no-op.
 *
 * `createTreasury` arrives as a PARAMETER rather than an import, for the same cycle reason
 * (`state-engine` imports `federation-bridge`, and it is `state-engine` that calls the boot reconcile).
 * Same db-as-param shape the @beanpool/engine extraction already uses.
 */

import { db } from './db/db.js';
import { bridgeAccountId, ensureBridgeAccount, getEnergyBalance } from './federation-bridge.js';
import { getConnectors, peerIdFromAddress, getConnectorCreditCap } from './connector-manager.js';
import { logger } from './logger.js';

export interface FederationLink {
    peerId: string;
    treasuryPubkey: string;
    name: string;
    /** Balance of `bridge_<peerId>` — the tab. Positive = the peer owes us. NOT spendable. */
    energyBalance: number;
    /** Balance of the link's own account — real beans a keeper may commission with. */
    treasuryBalance: number;
    commissionCeiling: number;
    createdAt: string | null;
}

/** How a treasury created for a peer is named. "eastgippy" → "eastgippy Link". */
export function linkNameFor(callsign: string | undefined, peerId: string): string {
    const base = (callsign || '').trim();
    // A peer with no callsign is still a peer. The last 8 of a peer id is what every log line and the
    // bridge display name already use, so an operator can match them up by eye.
    return base ? `${base} Link` : `Peer ${peerId.slice(-8)} Link`;
}

type CreateTreasuryFn = (
    name: string, avatar: string, creditLine?: number, opts?: { systemCreated?: boolean },
) => { publicKey: string };

/**
 * Create the link for a peer if it does not have one. Idempotent, and returns the existing row unchanged
 * when it does — this is called on every boot.
 *
 * The treasury is created with a credit line of ZERO, deliberately and per §7: a credit line on a link
 * treasury "creates a negative nobody earns back — the stranded-negative problem in reverse". A link
 * spends beans the community actually has, or it does not spend.
 */
export function ensureFederationLink(
    peerId: string,
    callsign: string | undefined,
    createTreasury: CreateTreasuryFn,
): FederationLink | null {
    if (!peerId) return null;

    const existing = getFederationLink(peerId);
    if (existing) return existing;

    // The bridge account may not exist yet — a cap can be set before the first trade. Create it now so
    // the card can show a real 0 rather than nothing, and so the demurrage exemption is in place before
    // the account can ever hold an obligation.
    ensureBridgeAccount(peerId);

    let name = linkNameFor(callsign, peerId);
    let created: { publicKey: string };
    try {
        created = createTreasury(name, '', 0, { systemCreated: true });
    } catch (e: any) {
        // `createTreasury` refuses a duplicate name (case-insensitive across all non-migrated members).
        // Two peers whose operators chose the same callsign is not a configuration error we should
        // refuse a link over, and neither is an operator having already made a treasury by that name.
        if (!/already taken/i.test(e?.message ?? '')) throw e;
        name = `${name} (${peerId.slice(-6)})`;
        created = createTreasury(name, '', 0, { systemCreated: true });
        logger.info('P2P', `[Link] Name collision — link for ${peerId.slice(-8)} named "${name}"`);
    }

    db.prepare('INSERT INTO federation_links (peer_id, treasury_pubkey) VALUES (?, ?)')
        .run(peerId, created.publicKey);
    logger.info('P2P', `[Link] Created "${name}" for peer ${peerId.slice(-8)} (treasury ${created.publicKey.slice(0, 12)}…, ceiling 0)`);

    return getFederationLink(peerId);
}

/** The link for a peer, or null. */
export function getFederationLink(peerId: string): FederationLink | null {
    const row = db.prepare(`SELECT l.peer_id, l.treasury_pubkey, l.commission_ceiling, l.created_at, m.callsign
                            FROM federation_links l
                            JOIN members m ON m.public_key = l.treasury_pubkey
                            WHERE l.peer_id = ?`).get(peerId) as any;
    return row ? hydrate(row) : null;
}

/** The link backing a treasury account, or null when that treasury is an ordinary enterprise. */
export function getLinkByTreasury(treasuryPubkey: string): FederationLink | null {
    const row = db.prepare(`SELECT l.peer_id, l.treasury_pubkey, l.commission_ceiling, l.created_at, m.callsign
                            FROM federation_links l
                            JOIN members m ON m.public_key = l.treasury_pubkey
                            WHERE l.treasury_pubkey = ?`).get(treasuryPubkey) as any;
    return row ? hydrate(row) : null;
}

export function listFederationLinks(): FederationLink[] {
    const rows = db.prepare(`SELECT l.peer_id, l.treasury_pubkey, l.commission_ceiling, l.created_at, m.callsign
                             FROM federation_links l
                             JOIN members m ON m.public_key = l.treasury_pubkey
                             ORDER BY m.callsign COLLATE NOCASE`).all() as any[];
    return rows.map(hydrate);
}

function hydrate(row: any): FederationLink {
    return {
        peerId: row.peer_id,
        treasuryPubkey: row.treasury_pubkey,
        name: row.callsign,
        energyBalance: getEnergyBalance(row.peer_id),
        treasuryBalance: balanceOf(row.treasury_pubkey),
        commissionCeiling: row.commission_ceiling,
        createdAt: row.created_at ?? null,
    };
}

/**
 * Read a balance straight from `accounts`.
 *
 * Deliberately NOT `getBalance()` from state-engine: that would be the import cycle this module exists to
 * avoid, and it also applies demurrage-on-read, which a link treasury is exempt from anyway.
 */
function balanceOf(publicKey: string): number {
    const row = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(publicKey) as any;
    return Math.round((row?.balance ?? 0) * 10000) / 10000;
}

/**
 * Set a link's commissioning ceiling. Returns null when no such link.
 *
 * This is the safety on step 5, so it is bounded on both ends: negative is refused outright, and there
 * is no "unlimited" value — an absent ceiling is 0, not infinity.
 */
export function setCommissionCeiling(peerId: string, ceiling: number): FederationLink | null {
    if (!Number.isFinite(ceiling) || ceiling < 0) throw new Error('Commissioning ceiling must be a non-negative number');
    const res = db.prepare('UPDATE federation_links SET commission_ceiling = ? WHERE peer_id = ?')
        .run(Math.round(ceiling * 100) / 100, peerId);
    if (res.changes === 0) return null;
    logger.info('P2P', `[Link] Commissioning ceiling for ${peerId.slice(-8)} set to ${ceiling}`);
    return getFederationLink(peerId);
}

/**
 * Converge links against the connector list: every peer connector with a credit cap has a link.
 *
 * Returns the number created. Called on boot and after a cap is set. Never DELETES a link whose cap has
 * been cleared — the treasury may hold beans and the bridge may hold a tab, and dropping a link because
 * a cap was withdrawn would orphan both. Withdrawing a cap stops new settlement, which is what it is
 * for; unwinding a live tab is open decision 2 and is deliberately not invented here.
 */
export function reconcileFederationLinks(createTreasury: CreateTreasuryFn): number {
    let created = 0;
    for (const connector of getConnectors()) {
        if (connector.trustLevel !== 'peer') continue;
        if (getConnectorCreditCap(connector.address) === null) continue;
        const peerId = peerIdFromAddress(connector.address);
        if (!peerId) continue;                       // no peer id = nothing to key a bridge or a link on
        if (getFederationLink(peerId)) continue;
        try {
            if (ensureFederationLink(peerId, connector.callsign, createTreasury)) created++;
        } catch (e: any) {
            // One bad link must not stop the others, and must not stop boot. Logged loudly because a
            // peer with a cap and no link is a peer we will settle with that has no visible home.
            logger.error('P2P', `[Link] Failed to create link for ${peerId.slice(-8)}: ${e?.message || e}`);
        }
    }
    return created;
}

export { bridgeAccountId };
