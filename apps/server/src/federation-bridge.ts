/**
 * Inter-node energy balances — the `bridge_<peer>` accounts (#104).
 *
 * Spec: docs/federation-economics.md §2.2 (what the entry is), §2.4 (why it isn't the Commons),
 * §3.2 (the per-peer cap and its one-way nature).
 *
 * WHAT A BRIDGE ROW IS. Not beans parked in an account. Nothing is transferred between nodes — each
 * makes purely local entries, and the two nodes' bridge rows mirror each other as a shared record of
 * who owes whom WORK. The number says: "we have delivered N beans' worth of real work and have not yet
 * received equivalent work back." Hence "energy balance".
 *
 * That makes it a different KIND of row from a member balance even though it lives in the same
 * `accounts` table, and three properties follow from that one fact rather than being arbitrary:
 *   - not spendable    — no member is ever paid out of it; only opposite-direction trade moves it
 *   - not transferable — it is a claim on ONE community's future work, not a bearer instrument
 *   - not decayable    — decaying a debt is silent forgiveness (setDecayExempt below)
 *
 * SIGN CONVENTION (Rule 2), which implementations get wrong:
 *   positive → value taken from a local member and owed outward
 *   negative → value minted locally against a claim, i.e. credit we have EXTENDED to that peer
 * The two nodes' rows are always equal and opposite; drift is a reconciliation failure and is the most
 * useful federation health signal we have.
 *
 * Depends only on leaves (db, ledger, connector-manager, core) so any layer may import it.
 */

import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import { bridgeAccountId, peerFromBridgeAccountId } from '@beanpool/core';
import { getConnectorCreditCap, getConnectors, getConnectorByPeerId } from './connector-manager.js';
import { reservedAgainstPeer } from './federation-settlement-state.js';

export { bridgeAccountId, peerFromBridgeAccountId };

/** Beans are quoted to members at 2dp; cap arithmetic works at 4dp and rounds only for presentation. */
const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * Ensure the bridge account for a peer exists and is demurrage-exempt.
 *
 * Idempotent. Reuses `ledger.setDecayExempt()` — the same mechanism that already covers COMMONS_POOL,
 * `escrow_*`, `project_*` and every `is_treasury=1` account — rather than inventing a second exemption
 * concept. Must be re-applied on every boot, because the exemption set lives in the in-memory ledger.
 */
export function ensureBridgeAccount(peerId: string): string {
    const id = bridgeAccountId(peerId);
    // Seed last_demurrage_epoch to NOW, not 0. Epoch 0 is 1970, so if a bridge account were ever
    // evaluated while unexempt — registerBridgeDecayExemptions() is wrapped in a try/catch that logs and
    // continues, so that is reachable — it would take ~56 years of compound demurrage on first read and
    // wipe the balance. Being exempt makes this unreachable in the happy path; seeding correctly makes
    // it harmless in the unhappy one.
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)`)
        .run(id, ledger.getCurrentEpoch());
    ledger.setDecayExempt(id);
    return id;
}

/**
 * Re-register every existing bridge account as demurrage-exempt. Call at boot, alongside the treasury
 * exemptions — the in-memory ledger is rebuilt each start, so an exemption that isn't re-applied
 * silently begins decaying a debt.
 */
export function registerBridgeDecayExemptions(): number {
    const rows = db.prepare("SELECT public_key FROM accounts WHERE public_key LIKE 'bridge_%'").all() as any[];
    for (const r of rows) ledger.setDecayExempt(r.public_key);
    return rows.length;
}

/**
 * This node's energy balance toward a peer, read straight from the ledger.
 *
 * Positive = we owe them work. Negative = they owe us work (we extended credit).
 */
export function getEnergyBalance(peerId: string): number {
    return Math.round(energyBalanceExact(peerId) * 100) / 100;
}

/**
 * The same balance UNROUNDED. For enforcement, never for display.
 *
 * Rounding to 2dp while settlement prices are carried at 4dp let the cap be exceeded (review finding): an
 * actual exposure of 99.994 reads as 99.99, so another 0.01 is accepted against a 100 cap and the bridge
 * lands at 100.004 — past the number the operator chose. Small, but the cap exists precisely to be the
 * number that is not exceeded, so the check has to use the stored value and rounding stays presentational.
 */
export function energyBalanceExact(peerId: string): number {
    const row = db.prepare('SELECT balance FROM accounts WHERE public_key = ?').get(bridgeAccountId(peerId)) as any;
    return row?.balance ?? 0;
}

/** How much credit we have currently extended to a peer — the magnitude of the negative side only. */
export function creditExtendedTo(peerId: string): number {
    return Math.max(0, -energyBalanceExact(peerId));
}

export type SettlementCapacity =
    | { ok: true; headroom: number; cap: number; extended: number }
    | { ok: false; reason: 'no_cap_configured'; message: string }
    | { ok: false; reason: 'cap_exhausted'; cap: number; extended: number; headroom: 0; message: string };

/**
 * May this node extend `amount` more credit to a peer, and how much room is left?
 *
 * The two failure reasons are deliberately distinct because they need different operator responses:
 * `no_cap_configured` is "nobody has decided yet" and is the state every peer starts in;
 * `cap_exhausted` is "the throttle is working as designed".
 *
 * ONE-WAY BY CONSTRUCTION (§3.2). This bounds only the NEGATIVE side — credit we extend. Flow in the
 * other direction moves the balance positive and is governed by the *peer's* cap, not ours, so it is
 * never blocked here. That matters: a check like `abs(balance) > cap` would freeze a drained community
 * permanently, because the only thing that can clear the balance is exactly what it would have blocked.
 *
 * @param address the connector address (the cap lives on the connector record, keyed by address)
 */
export function settlementCapacity(
    peerId: string,
    address: string,
    amount = 0,
    // The reservation being re-checked at payment time, so it is not counted against itself.
    excludeKey?: string,
): SettlementCapacity {
    const cap = getConnectorCreditCap(address);

    if (cap === null) {
        return {
            ok: false,
            reason: 'no_cap_configured',
            message: `No credit limit is set for this community yet, so purchases can't be settled with them. An operator needs to choose a limit in Settings first.`,
        };
    }

    // HEADROOM IS MEASURED FROM THE SIGNED BALANCE, not from "credit extended so far" (review finding, and
    // this was a spec violation rather than an inefficiency).
    //
    // The rule §3.2 actually states is that the balance may not go BELOW −cap. So:
    //
    //     resulting balance = balance − reserved − amount     must be  ≥  −cap
    //     ⇒  amount  ≤  cap + balance − reserved
    //
    // The previous form used `max(0, −balance)`, which THREW AWAY a positive balance — and a positive
    // balance is precisely the state where we owe them work and paying their seller *reduces* what we owe.
    // With a +5 position and a cap of 0, paying a 5-bean seller ends at 0 and extends no credit at all, yet
    // the old arithmetic computed zero headroom and refused it. That blocks the rebalancing direction §3.2
    // insists must stay open, and it made this module's own "flow in the other direction is never blocked
    // here" comment false. Measuring from the signed balance makes the one-way property fall out of the
    // arithmetic instead of being asserted next to code that contradicted it.
    //
    // Unrounded inputs: rounding here is what let the cap be exceeded before, and rounding the sum
    // re-introduces it just as effectively as rounding the balance did.
    const balance = energyBalanceExact(peerId);
    const reserved = reservedAgainstPeer(peerId, excludeKey);
    const extended = Math.max(0, -balance) + reserved;   // reported figure: how much we are on the hook for

    // Enforce at 4dp — the precision the settlement module actually carries prices at — and present at 2dp.
    // Comparing raw floats would refuse an exact fit on binary noise (10 − 7.1 renders as 2.9000000000000004);
    // comparing at 2dp would let 0.006 of headroom look like 0.01. 4dp is the honest middle, and it is the
    // same precision `round4` uses everywhere else in the settlement path.
    const headroom = round4(cap + balance - reserved);
    if (round4(amount) > headroom) {
        return {
            ok: false,
            reason: 'cap_exhausted',
            cap,
            extended: round2(extended),
            headroom: 0,
            message: `This community has reached the credit limit set for them (${round2(extended)} of ${cap}). They can buy from us — which is what brings the balance back — but we can't extend more until it does.`,
        };
    }

    return { ok: true, headroom, cap, extended: round2(extended) };
}

/**
 * `settlementCapacity` addressed by peer id alone, which is what the settlement path actually has.
 *
 * The cap lives on the connector record, keyed by address (§3.2) — but a libp2p stream knows only the
 * remote peer id. Resolving here keeps every caller from re-deriving it, and puts the fail-closed cases in
 * one place:
 *   • the peer is not a configured connector at all → refuse
 *   • it is configured, but not at trust level `peer` (a `mirror` is a backup replica, not a trading
 *     partner) → refuse. Trust level and credit cap are separate decisions and both must be affirmative.
 */
export function settlementCapacityForPeer(peerId: string, amount = 0, excludeKey?: string): SettlementCapacity {
    const connector = getConnectorByPeerId(peerId);
    if (!connector || connector.trustLevel !== 'peer') {
        return {
            ok: false,
            reason: 'no_cap_configured',
            message: `This community isn't a trading partner of ours, so purchases can't be settled with them.`,
        };
    }
    return settlementCapacity(peerId, connector.address, amount, excludeKey);
}

/**
 * Every peer's energy balance, for the operator health view and the zero-centred display (§2.2).
 *
 * `cap` is null when unset, which is also what makes `settleable` false — the fail-closed default.
 */
export function listEnergyBalances(): Array<{
    peerId: string | null;
    address: string;
    callsign?: string;
    balance: number;
    cap: number | null;
    extended: number;
    headroom: number | null;
    settleable: boolean;
}> {
    return getConnectors()
        .filter(c => c.trustLevel === 'peer')
        .map(c => {
            // A bridge account is keyed by the peer's LIBP2P PEER ID, never its address: the peerId is
            // the node's cryptographic identity and is stable, whereas an address can change when a node
            // moves host or DNS. You cannot rename a ledger account without migrating balances, so the
            // key has to be the stable one.
            //
            // A connector resolves its peer id from a live connection or from its own multiaddr, so one
            // added as a bare `host:port` has none until it connects, and therefore no balance to report.
            // Do NOT fall back to the address in that case — that would read a DIFFERENT account and
            // report someone else's position as this peer's.
            const peerId = c.peerId ?? null;
            const balance = peerId ? getEnergyBalance(peerId) : 0;
            const cap = c.creditCap ?? null;
            const extended = Math.max(0, -balance);
            return {
                peerId,
                address: c.address,
                callsign: c.callsign,
                balance,
                cap,
                extended,
                headroom: cap === null ? null : Math.round((cap - extended) * 100) / 100,
                // Settleable needs BOTH a cap (an operator decided) and a known peerId (we have actually
                // met this node). Either missing is fail-closed.
                settleable: cap !== null && peerId !== null,
            };
        });
}

/**
 * Sum of all bridge rows. Included because it is a useful invariant to assert in tests and audits, not
 * because it should be zero: it is zero only when every peer relationship is square. A non-zero total is
 * normal — it is the net of what we owe outward against what is owed to us.
 */
export function totalEnergyPosition(): number {
    const row = db.prepare("SELECT COALESCE(SUM(balance), 0) AS t FROM accounts WHERE public_key LIKE 'bridge_%'").get() as any;
    return Math.round((row?.t ?? 0) * 100) / 100;
}

/**
 * Human label for a bridge account, for a member's ledger (#104).
 *
 * A settled cross-node trade pays the seller from `bridge_<peerId>`, so that account IS the counterparty
 * on a real person's transaction. Left raw it reads `bridge_12D3KooWByron…`, which tells them nothing.
 *
 * The name comes from the **connector's callsign**, not from a member row — bridge accounts deliberately
 * have no member record (§2.2), and putting the name on the connector means it lives where the
 * relationship lives and follows an operator rename.
 *
 * The 🌐 prefix is the same marker the clients already use for cross-community posts, so a local
 * enterprise ("Community Eggs") and another whole community stay visually distinct in the same list —
 * they are very different facts and would otherwise read alike.
 */
export function bridgeDisplayName(accountId?: string | null): string | null {
    // Tolerate a missing id: counterparty fields are optional on some rows, and a label helper must not
    // be the thing that throws on one (review finding).
    if (!accountId || typeof accountId !== 'string') return null;
    if (!accountId.startsWith('bridge_')) return null;

    const peerId = peerFromBridgeAccountId(accountId);

    // A malformed `bridge_` id still gets a label. Returning null here let the caller fall back to its
    // normal member lookup, which fails, and the raw `bridge_12D3Koo…` string reached a member's ledger
    // (review finding). Every bridge account is *some* other community, whether we can name it or not.
    if (peerId) {
        // Trim, and strip a globe the operator may have typed into the callsign themselves — otherwise a
        // community called "🌐 Byron" renders as "🌐 🌐 Byron", and a callsign of "   " renders as "🌐    ".
        // ⚡ Bolt: Iterate raw connectors array via getConnectorByPeerId instead of calling getConnectors() which materializes every connector.
        const callsign = getConnectorByPeerId(peerId)?.callsign?.replace(/^🌐\s*/, '').trim();
        if (callsign) return `🌐 ${callsign}`;
    }

    // Connected but unnamed, configured and never met, or unparseable. Say what we know rather than leaking
    // a peer id: "another community" is honest and readable, where a truncated hash is neither.
    //
    // TODO(clients): screen readers read the globe verbatim ("Globe showing Americas, Byron Bay"). This
    // returns a plain string because nothing renders it yet; when a client wires it up, wrap the emoji in
    // an aria-hidden span and give the row an aria-label naming the community.
    return '🌐 Another community';
}

/**
 * Resolve any account id a member might see as a counterparty into something readable, or null to let the
 * caller fall back to its normal member lookup.
 *
 * Only bridge accounts are handled here. `escrow_*` and `COMMONS_POOL` already have client-side copy
 * treatments, and duplicating them would create two places to change one label.
 */
export function resolveCounterpartyLabel(accountId?: string | null): string | null {
    // Delegates entirely: bridgeDisplayName now owns both the prefix test and the "cannot name it" case, so
    // there is one place that decides what a bridge account looks like to a member. A `bridge_` id can no
    // longer fall through to a raw-string fallback in the caller.
    return bridgeDisplayName(accountId);
}
