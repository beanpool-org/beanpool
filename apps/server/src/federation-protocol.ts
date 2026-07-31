/**
 * BeanPool Federation Protocol — /beanpool/federation/1.0.0
 *
 * Secure RPC protocol for cross-node operations (messaging and member verification).
 * Runs over Libp2p multiplexed Noise streams, so interactions are inherently
 * authenticated by the sender's static Libp2p PeerID.
 */

import type { Libp2p } from 'libp2p';
import { isPeerTrusted } from './connector-manager.js';
import { getMember, getBalance, createConversation, sendMessage, registerVisitor } from './state-engine.js';
import { FEDERATION_SETTLEMENT_ENABLED, SETTLEMENT_REFUSED_CODE } from './federation-settlement.js';
import {
    handlePurchaseRequest, handleReceiptDelivery, answerReceiptStatus,
    PURCHASE_ASK_TIMEOUT_MS, RECEIPT_DELIVERY_TIMEOUT_MS,
} from './federation-settlement-exchange.js';
import type { SettlementReceipt } from './federation-receipt.js';
import type { ReceiptStatus } from './federation-settlement-state.js';

const PROTOCOL = '/beanpool/federation/1.0.0';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Read data from a stream by polling readBuffer until data arrives.
 */
function readFromStream(stream: any, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Read timeout'));
        }, timeoutMs);

        (async () => {
            const chunks: Uint8Array[] = [];
            let totalLength = 0;
            const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB

            try {
                for await (const chunk of stream) {
                    let parsedChunk: Uint8Array;
                    if (chunk instanceof Uint8Array) {
                        parsedChunk = chunk;
                    } else if (typeof chunk.subarray === 'function') {
                        parsedChunk = chunk.subarray();
                    } else {
                        parsedChunk = Uint8Array.from(chunk);
                    }

                    totalLength += parsedChunk.length;
                    if (totalLength > MAX_PAYLOAD_SIZE) {
                        clearTimeout(timer);
                        reject(new Error('Payload size exceeded maximum limit of 10MB'));
                        return;
                    }

                    chunks.push(parsedChunk);
                }

                // A2-12: decode once after the write side closes (caller parses),
                // instead of an O(n²) re-decode + JSON.parse on every chunk.
                clearTimeout(timer);
                resolve(decoder.decode(Buffer.concat(chunks)));
            } catch (err) {
                clearTimeout(timer);
                reject(err);
            }
        })();
    });
}

/**
 * Write data to a stream using AbstractStream's send().
 */
async function writeToStream(stream: any, data: string): Promise<void> {
    await stream.send(encoder.encode(data));
    if (typeof stream.closeWrite === 'function') {
        await stream.closeWrite();
    }
}

/**
 * The settlement actions (#104 §2.5), named on the wire.
 *
 * Kept as a set so the handler's flag/trust gate covers all of them at once — adding a fourth action
 * without remembering to gate it is the mistake this shape prevents.
 */
export const SETTLE_PURCHASE = 'settle_purchase';
export const SETTLE_RECEIPT = 'settle_receipt';
export const SETTLE_RECEIPT_STATUS = 'settle_receipt_status';
export const SETTLEMENT_ACTIONS = new Set<string>([SETTLE_PURCHASE, SETTLE_RECEIPT, SETTLE_RECEIPT_STATUS]);

/**
 * The three preconditions for touching the ledger on a peer's behalf. Returns a refusal, or null to
 * proceed.
 *
 * A named function rather than inline `if`s in the stream handler, because this is the most
 * consequential decision in the module and it should be assertable on its own — a regression here
 * doesn't produce a wrong answer, it produces beans minted for a peer that was never authorised.
 *
 *   1. The FLAG. #102's kill switch (`assertLocalSettlement`) stops a VISITOR SPENDING here; it says
 *      nothing about the inbound half, where a peer's request causes us to pay our own seller out of a
 *      bridge account. Without this gate, merging the settlement code would silently switch that on.
 *   2. Trust level `peer` SPECIFICALLY. A `mirror` is a backup replica, not a trading partner, and the
 *      handler's outer trust check admits both.
 *   3. An identified peer. Every settlement decision is keyed on the peer id — which bridge account
 *      moves, whose cap applies, whose receipt is valid. Without one there is nothing to key on.
 */
export function settlementGateRefusal(
    trustLevel: string | null,
    remotePeerId: string,
    // Defaulted from the module const, so production behaviour is unchanged and there is one source of
    // truth — but passing it explicitly lets the trust-level and peer-id branches be asserted now, rather
    // than shipping untested until the day the flag flips.
    enabled: boolean = FEDERATION_SETTLEMENT_ENABLED,
): { error: string; code?: string } | null {
    if (!enabled) {
        return { error: 'Cross-community settlement is not enabled on this node', code: SETTLEMENT_REFUSED_CODE };
    }
    if (trustLevel !== 'peer') {
        return { error: 'This connection is not a trading peer', code: SETTLEMENT_REFUSED_CODE };
    }
    if (!remotePeerId || remotePeerId === 'unknown') {
        return { error: 'Settlement requires an identified peer' };
    }
    return null;
}

/**
 * Responder side of the settlement exchange.
 *
 * Every branch here is the SELLER's node answering. The peer id comes from the authenticated connection,
 * never from the payload — a peer must not be able to name which credit line it is drawing on.
 */
async function routeSettlementAction(request: any, remotePeerId: string): Promise<any> {
    switch (request.action) {
        // Step 2: will we accept a purchase from one of their members? Checks our own cap and reserves.
        case SETTLE_PURCHASE:
            return handlePurchaseRequest({
                key: request.key,
                peerId: remotePeerId,
                buyerPublicKey: request.buyerPublicKey,
                buyerCallsign: request.buyerCallsign,
                buyerHomeNode: request.buyerHomeNode ?? null,
                sellerPublicKey: request.sellerPublicKey,
                postId: request.postId ?? null,
                amount: request.amount,
            });

        // Step 4: their receipt arrived. Persist it, then pay our seller — or refuse CAPACITY_LAPSED.
        case SETTLE_RECEIPT:
            return await handleReceiptDelivery({
                key: request.key,
                receipt: request.receipt as SettlementReceipt,
                signature: request.signature,
                peerId: remotePeerId,
            });

        // Recovery: what became of this receipt? Scoped to the asking peer.
        case SETTLE_RECEIPT_STATUS:
            return { status: answerReceiptStatus(request.key, remotePeerId) };

        default:
            return { error: 'Unknown settlement action' };
    }
}

/**
 * Register the federation protocol handler (Responder side).
 */
export function registerFederationHandler(node: Libp2p): void {
    node.handle(PROTOCOL, async (incomingData: any) => {
        const stream = incomingData.stream || incomingData;
        const connection = incomingData.connection;

        let remotePeerId = 'unknown';
        if (connection?.remotePeer) {
            remotePeerId = connection.remotePeer.toString();
        }

        try {
            // 1. Authenticate connection against trusted PeerIDs
            const { trusted, trustLevel } = isPeerTrusted(remotePeerId);
            if (!trusted || trustLevel === 'blocked') {
                console.warn(`[Federation] Rejected stream from untrusted peer ${remotePeerId.slice(-8)}`);
                stream.close();
                return;
            }

            // 2. Read Request
            const raw = await readFromStream(stream, 5000);
            let request: any;
            try {
                request = JSON.parse(raw);
            } catch {
                console.error(`[Federation] Invalid JSON from ${remotePeerId.slice(-8)}`);
                return;
            }

            // 3. Route Action
            let response: any = { error: 'Unknown action' };

            if (request.action === 'verify_member') {
                const { publicKey } = request;
                // ⚡ O(1) indexed lookup instead of loading all members and scanning
                const member = getMember(publicKey);

                if (!member) {
                    response = { isMember: false };
                } else {
                    const balance = getBalance(publicKey);
                    response = {
                        isMember: true,
                        callsign: member.callsign,
                        homeBalance: balance?.balance ?? 0,
                    };
                }
            } 
            else if (request.action === 'relay_message') {
                const { senderPublicKey, senderCallsign, senderNodeUrl, recipientPublicKey, ciphertext, nonce, metadata } = request;

                if (!senderPublicKey || !recipientPublicKey || !ciphertext || !nonce) {
                    response = { error: 'Missing required payload fields' };
                } else {
                    // Verify recipient exists locally (O(1) indexed lookup)
                    const recipient = getMember(recipientPublicKey);
                    if (!recipient) {
                        response = { error: 'Recipient not found on this node' };
                    } else if ((() => { const s = getMember(senderPublicKey); return s && !s.homeNodeUrl; })()) {
                        // A2-28: the connection is trusted (a `peer` connector), but that
                        // authorizes the CONNECTION, not the asserted sender authorship —
                        // a compromised/malicious federation peer can set senderPublicKey
                        // to anyone. A genuine federation relay is from a REMOTE member
                        // (one with a homeNodeUrl on another node). Refuse a relay that
                        // claims to be from one of OUR LOCAL members (no homeNodeUrl), so a
                        // peer cannot forge messages "from" a local identity into an inbox.
                        // (Full origin authenticity needs per-message sender signatures —
                        // a protocol change; tracked. The relay path is gated by
                        // ENABLE_PEER_CONNECTORS, off by default.)
                        console.warn(`[Federation] Rejected relay impersonating local member ${senderPublicKey.slice(0, 8)} from peer ${remotePeerId.slice(-8)}`);
                        response = { error: 'Sender impersonates a local member' };
                    } else {
                        // Origin is asserted by the relaying node (a trusted peer connector),
                        // NOT cryptographically verified per-message — treat as
                        // remote/unverified-origin. registerVisitor tags it with the
                        // sender's home node so it is never confused with a local member.
                        registerVisitor(senderPublicKey, senderCallsign, senderNodeUrl);
                        
                        const conversation = createConversation('dm', [senderPublicKey, recipientPublicKey], senderPublicKey);
                        if (conversation) {
                            const message = sendMessage(conversation.id, senderPublicKey, ciphertext, nonce, 'text', undefined, metadata);
                            if (message) {
                                console.log(`📨 Federation libp2p relay: ${senderCallsign || senderPublicKey.substring(0, 8)} → ${recipient.callsign}`);
                                response = { success: true, conversationId: conversation.id, messageId: message.id };
                            } else {
                                response = { error: 'Failed to store message' };
                            }
                        } else {
                            response = { error: 'Failed to create conversation' };
                        }
                    }
                }
            }
            // ── Cross-node settlement (#104 §2.5) ────────────────────────────────────────────────
            else if (SETTLEMENT_ACTIONS.has(request.action)) {
                response = settlementGateRefusal(trustLevel, remotePeerId)
                    ?? await routeSettlementAction(request, remotePeerId);
            }

            // 4. Write Response
            await writeToStream(stream, JSON.stringify(response));

        } catch (e: any) {
            console.error(`[Federation] Handler error:`, e.message || e);
        }
    });

    console.log(`[Federation] Protocol handler registered: ${PROTOCOL}`);
}

/**
 * Initiator (Sender) side: Verify remote member over Libp2p
 */
export async function federatedVerifyMember(node: Libp2p, targetPeerId: any, publicKey: string): Promise<any> {
    let stream: any = null;
    try {
        stream = await node.dialProtocol(targetPeerId, PROTOCOL);
        const request = JSON.stringify({ action: 'verify_member', publicKey });
        
        const readPromise = readFromStream(stream);
        readPromise.catch(() => {}); // Prevent unhandled rejection if writeToStream throws or exits early
        await writeToStream(stream, request);
        
        const raw = await readPromise;
        return JSON.parse(raw);
    } finally {
        if (stream) {
            try {
                stream.close();
            } catch {}
        }
    }
}

/**
 * Initiator side of one settlement request/response round trip.
 *
 * Factored out because all three settlement calls are the same dial-write-read shape and differ only in
 * payload — and because the timeout is part of the protocol's correctness (§2.5: the seller's reservation
 * must outlive the buyer's timeouts), so it must be explicit at every call site rather than defaulted.
 */
async function settlementRoundTrip(
    node: Libp2p,
    targetPeerId: any,
    request: Record<string, unknown>,
    timeoutMs: number,
): Promise<any> {
    let stream: any = null;
    try {
        stream = await node.dialProtocol(targetPeerId, PROTOCOL);
        const readPromise = readFromStream(stream, timeoutMs);
        readPromise.catch(() => {});   // no unhandled rejection if the write throws first
        await writeToStream(stream, JSON.stringify(request));
        return JSON.parse(await readPromise);
    } finally {
        if (stream) {
            try { stream.close(); } catch {}
        }
    }
}

/**
 * Step 2 (buyer's node → seller's node): ask whether a purchase will be accepted.
 *
 * An ambiguous outcome here — timeout, dropped connection — is safe to retry with the same `key`: the
 * responder is idempotent on it, and our escrow stays held meanwhile, so the buyer's beans are neither
 * spent nor released while it resolves.
 */
export async function federatedPurchase(
    node: Libp2p,
    targetPeerId: any,
    payload: {
        key: string;
        buyerPublicKey: string;
        buyerCallsign?: string;
        buyerHomeNode?: string | null;
        sellerPublicKey: string;
        postId?: string | null;
        amount: number;
    },
): Promise<any> {
    return settlementRoundTrip(node, targetPeerId, { action: SETTLE_PURCHASE, ...payload }, PURCHASE_ASK_TIMEOUT_MS);
}

/** Step 4 (buyer's node → seller's node): deliver the signed receipt that authorises the local mint. */
export async function federatedDeliverReceipt(
    node: Libp2p,
    targetPeerId: any,
    payload: { key: string; receipt: SettlementReceipt; signature: string },
): Promise<any> {
    return settlementRoundTrip(node, targetPeerId, { action: SETTLE_RECEIPT, ...payload }, RECEIPT_DELIVERY_TIMEOUT_MS);
}

/**
 * Recovery: ask what became of a receipt we issued but never got confirmation for.
 *
 * Anything other than a well-formed known answer is treated as `UNKNOWN`, which means WAIT. That default
 * matters: `NOT_FOUND` instructs us to reverse, so a garbled or hostile reply must never be able to
 * mean "undo it".
 */
export async function federatedReceiptStatus(
    node: Libp2p,
    targetPeerId: any,
    key: string,
): Promise<ReceiptStatus> {
    const reply = await settlementRoundTrip(
        node, targetPeerId, { action: SETTLE_RECEIPT_STATUS, key }, PURCHASE_ASK_TIMEOUT_MS,
    );
    const status = reply?.status;
    return status === 'NOT_FOUND' || status === 'HELD' || status === 'SETTLED' ? status : 'UNKNOWN';
}

/**
 * Initiator (Sender) side: Relay a message over Libp2p
 */
export async function federatedRelayMessage(
    node: Libp2p, 
    targetPeerId: any, 
    payload: { senderPublicKey: string; senderCallsign?: string; senderNodeUrl?: string; recipientPublicKey: string; ciphertext: string; nonce: string; metadata?: string; }
): Promise<any> {
    let stream: any = null;
    try {
        stream = await node.dialProtocol(targetPeerId, PROTOCOL);
        const request = JSON.stringify({ action: 'relay_message', ...payload });
        
        const readPromise = readFromStream(stream);
        readPromise.catch(() => {}); // Prevent unhandled rejection if writeToStream throws or exits early
        await writeToStream(stream, request);
        
        const raw = await readPromise;
        return JSON.parse(raw);
    } finally {
        if (stream) {
            try {
                stream.close();
            } catch {}
        }
    }
}
