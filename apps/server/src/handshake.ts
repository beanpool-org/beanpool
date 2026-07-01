/**
 * BeanPool Handshake Protocol — /beanpool/handshake/1.0.0
 *
 * A lightweight request/response protocol for:
 *   1. Mutual trust verification — each side checks if the other trusts them
 *   2. RTT measurement — round-trip time gives latency
 *
 * Uses AbstractStream's send() for writing and readBuffer polling for reading.
 */

import type { Libp2p } from 'libp2p';
import { isPeerTrusted, updateInboundHandshakeStatus, type TrustLevel } from './connector-manager.js';

const PROTOCOL = '/beanpool/handshake/1.0.0';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HandshakeResult {
    mutualTrust: boolean;
    remoteTrustLevel: TrustLevel | null;
    remoteActive: boolean | null;
    latencyMs: number;
}

/**
 * Read data from a stream by polling readBuffer until data arrives
 * and the remote write side is closed (or we have data after a short wait).
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

                // A2-12: decode + (the caller) parse ONCE after the write side closes
                // (writeToStream always closeWrite()s) instead of re-decoding +
                // JSON.parse-ing the whole accumulated buffer on EVERY chunk — which
                // was O(n²) CPU. For the handshake handler this is reached BEFORE any
                // trust gate (we must reply to untrusted peers too), so the old
                // per-chunk parse was a pre-auth CPU-exhaustion lever: a peer dribbling
                // a ~10 MB frame one byte per packet forced ~10M full re-parses.
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
 * Write data to a stream using AbstractStream's send() and close write side.
 */
async function writeToStream(stream: any, data: string): Promise<void> {
    await stream.send(encoder.encode(data));
    if (typeof stream.closeWrite === 'function') {
        await stream.closeWrite();
    }
}

/**
 * Register the handshake protocol handler on the libp2p node.
 */
export function registerHandshakeHandler(node: Libp2p): void {
    node.handle(PROTOCOL, async (incomingData: any) => {
        const stream = incomingData.stream || incomingData;
        const connection = incomingData.connection;

        // Extract remote peer ID from connection
        let remotePeerId = 'unknown';
        if (connection?.remotePeer) {
            remotePeerId = connection.remotePeer.toString();
        }

        try {
            // Read request
            const raw = await readFromStream(stream, 5000);

            let request: any;
            try {
                request = JSON.parse(raw);
            } catch {
                console.error(`[Handshake] Invalid JSON from ${remotePeerId.slice(-8)}: "${raw.substring(0, 80)}"`);
                return;
            }

            // A2-27: do NOT fall back to a body-supplied `request.peerId` for the
            // trust identity. Under libp2p+Noise an established inbound stream always
            // carries an authenticated `connection.remotePeer`; deriving the identity
            // from the request body instead would let a peer claim a trusted PeerID it
            // doesn't hold the key for. If the authenticated peer is unknown, we leave
            // remotePeerId='unknown' → isPeerTrusted returns false → we reply
            // youAreTrusted:false (trust discovery still works, no trust granted).

            // Check if the remote peer is in OUR connectors list
            const { trusted, trustLevel, enabled: ourEnabled } = isPeerTrusted(remotePeerId);

            // Update inbound connection/handshake status on our end if trusted
            if (trusted) {
                const initiatorTrusted = request.youAreTrusted === true;
                const initiatorTrustLevel = request.trustLevel || null;
                const initiatorActive = request.active === true;
                updateInboundHandshakeStatus(remotePeerId, initiatorTrusted, initiatorTrustLevel, initiatorActive);
            }

            const response = JSON.stringify({
                type: 'handshake_res',
                ts: Date.now(),
                youAreTrusted: trusted,
                trustLevel: trustLevel,
                active: ourEnabled,
            });

            await writeToStream(stream, response);
            console.log(`[Handshake] ← ${remotePeerId.slice(-8)}: trust=${trusted} level=${trustLevel || 'none'}`);
        } catch (e: any) {
            console.error(`[Handshake] Handler error:`, e.message || e);
        }
    });

    console.log(`[Handshake] Protocol handler registered: ${PROTOCOL}`);
}

/**
 * Send a handshake request to a connected peer.
 */
export async function sendHandshake(node: Libp2p, peerId: any): Promise<HandshakeResult> {
    const start = performance.now();
    let stream: any = null;

    try {
        stream = await node.dialProtocol(peerId, PROTOCOL);

        const { trusted, trustLevel, enabled: ourEnabled } = isPeerTrusted(peerId.toString());
        const request = JSON.stringify({
            type: 'handshake_req',
            ts: Date.now(),
            peerId: node.peerId.toString(), // Include our peerId so handler can identify us
            youAreTrusted: trusted,
            trustLevel: trustLevel,
            active: ourEnabled,
        });

        // Start reading before writing (duplex stream — concurrent read/write)
        const readPromise = readFromStream(stream);
        readPromise.catch(() => {}); // Prevent unhandled rejection if writeToStream throws or exits early

        // Write request
        await writeToStream(stream, request);

        // Wait for response
        const raw = await readPromise;
        const latencyMs = Math.round(performance.now() - start);

        let response: any;
        try {
            response = JSON.parse(raw);
        } catch {
            console.error(`[Handshake] Failed to parse response: "${raw.substring(0, 80)}"`);
            return { mutualTrust: false, remoteTrustLevel: null, remoteActive: null, latencyMs };
        }

        console.log(`[Handshake] → ${peerId.toString().slice(-8)}: mutual=${!!response.youAreTrusted} active=${response.active} latency=${latencyMs}ms`);

        return {
            mutualTrust: !!response.youAreTrusted,
            remoteTrustLevel: response.trustLevel || null,
            remoteActive: response.active !== undefined ? !!response.active : null,
            latencyMs,
        };
    } finally {
        if (stream) {
            try {
                stream.close();
            } catch {}
        }
    }
}
