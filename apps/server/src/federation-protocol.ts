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
