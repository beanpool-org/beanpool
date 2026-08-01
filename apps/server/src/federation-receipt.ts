/**
 * Settlement receipts — the signed artifact that authorises a local mint (#104, step 3b).
 *
 * Spec: docs/federation-economics.md §2.5, Rule 3c ("a node never credits a local member before it holds
 * a signed settlement receipt from the buyer's node").
 *
 * WHY SIGN AT ALL, when the stream is already an authenticated Noise channel from a trusted peer?
 * Because the receipt has to outlive the connection. The seller's node persists it and may act on it
 * minutes later, or after a reboot, with no live connection to re-authenticate against. At that point the
 * signature is the *only* evidence that the buyer's node really committed. Transport authentication
 * proves who is talking now; the signature proves who committed then, and stays checkable in an audit.
 *
 * WHAT THE SIGNATURE BINDS, and why each field is in it:
 *   • `key`            — so a receipt cannot be moved onto a different settlement
 *   • `issuerPeerId`   — so a receipt cannot be replayed by a DIFFERENT peer. This one matters most: the
 *                        bridge account we debit is chosen by who issued the receipt, so an unbound
 *                        receipt would let peer B spend peer A's credit line.
 *   • `amount`         — so a receipt cannot be inflated past the reserved (and cap-checked) figure
 *   • buyer/seller/post — so the seller's node can confirm it is paying for the trade it reserved
 *
 * The signing key is the node's persistent libp2p Ed25519 identity (`p2p.ts`), so verification needs no
 * new key distribution: an Ed25519 PeerId *embeds* its public key, and the peer id is already what the
 * connector trust list is keyed on. Nothing new to configure, nothing new to get wrong.
 */

import { peerIdFromString } from '@libp2p/peer-id';

/**
 * Domain separator. The node identity key also signs libp2p handshakes and (in the DNS registrar work)
 * attestations, so a bare signature over bare fields could in principle be lifted from one context into
 * another. Prefixing every payload with a context string and version makes that impossible, and gives us
 * a way to change the format later without ambiguity.
 */
const RECEIPT_DOMAIN = 'beanpool-settlement-receipt/1';

export interface SettlementReceipt {
    /** The idempotency key, minted by the buyer's node. */
    key: string;
    /** libp2p peer id of the node that committed — the buyer's node. Bound into the signature. */
    issuerPeerId: string;
    buyerPublicKey: string;
    /** Public URL of the buyer's home node, for the seller's visitor record. May be absent. */
    buyerHomeNode: string | null;
    sellerPublicKey: string;
    postId: string | null;
    /** The agreed price — NEVER price plus fee. The fee never crosses the border (§2.1). */
    amount: number;
    /** ISO timestamp of the commit on the buyer's node. */
    committedAt: string;
}

/**
 * Canonicalise a number for signing.
 *
 * Both sides rebuild the payload from parsed fields, so the formatting must be identical on both or every
 * signature fails. Fixed decimal places rather than `String(n)`, because `String()` renders 5 as "5" and
 * 5.0 as "5" but 1e21 as "1e+21" — a representation that varies with magnitude is exactly what a
 * canonical form must not have.
 */
const canonicalAmount = (n: number): string => n.toFixed(4);

/**
 * The exact bytes that get signed.
 *
 * Built from an explicit ordered field list rather than `JSON.stringify(receipt)`, because object key
 * order is a property of how the object was constructed — a receipt rebuilt from a parsed wire message
 * could serialise its keys in a different order and fail to verify, intermittently and confusingly.
 */
export function receiptPayload(r: SettlementReceipt): string {
    return [
        RECEIPT_DOMAIN,
        r.key,
        r.issuerPeerId,
        r.buyerPublicKey,
        r.buyerHomeNode ?? '',
        r.sellerPublicKey,
        r.postId ?? '',
        canonicalAmount(r.amount),
        r.committedAt,
    ].join('\n');
}

/** Sign a receipt with this node's libp2p identity key. Returns base64. */
export async function signReceipt(r: SettlementReceipt, privateKey: any): Promise<string> {
    if (!privateKey?.sign) throw new Error('No node identity key available to sign a settlement receipt');
    // `canonicalAmount` calls toFixed, which throws a bare TypeError on a non-number. Fail with a message
    // that says what is wrong, since a malformed receipt here means a caller bug, not a peer's input.
    if (!r || typeof r.amount !== 'number' || !Number.isFinite(r.amount)) {
        throw new Error('Cannot sign a settlement receipt without a finite numeric amount');
    }
    if (!r.key || !r.issuerPeerId) {
        throw new Error('Cannot sign a settlement receipt without a key and an issuer');
    }
    const sig = await privateKey.sign(new TextEncoder().encode(receiptPayload(r)));
    return Buffer.from(sig).toString('base64');
}

/**
 * Verify a receipt against the peer that presented it.
 *
 * `expectedIssuerPeerId` must be the remote peer of the *connection the receipt arrived on* (or, during
 * boot recovery, the peer recorded on the settlement row). Passing the receipt's own `issuerPeerId` here
 * would make the check circular and worthless — the whole point is to pin the claim to an independently
 * known identity.
 *
 * Fails closed on every unexpected shape: a malformed peer id, a peer id type that does not embed a
 * public key, a bad base64 signature. Never throws, so a caller cannot accidentally treat an exception
 * path as success.
 */
export async function verifyReceipt(
    r: SettlementReceipt,
    signatureB64: string,
    expectedIssuerPeerId: string,
): Promise<boolean> {
    try {
        if (!r?.key || !r.issuerPeerId || !signatureB64) return false;
        if (r.issuerPeerId !== expectedIssuerPeerId) return false;

        const peerId: any = peerIdFromString(r.issuerPeerId);
        // RSA peer ids carry only a hash of the key, so the key is not recoverable from the id alone.
        // We only ever generate Ed25519 identities; refuse rather than guess.
        if (!peerId.publicKey?.verify) return false;

        const sig = Buffer.from(signatureB64, 'base64');
        if (sig.length === 0) return false;

        return await peerId.publicKey.verify(new TextEncoder().encode(receiptPayload(r)), sig);
    } catch {
        return false;
    }
}
