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
                // (writeToStream always close()s its write side) instead of re-decoding +
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
 * Write data to a stream and HALF-CLOSE THE WRITE SIDE, which is what tells the remote reader the message is
 * complete.
 *
 * `closeWrite()` DOES NOT EXIST on a real libp2p 3.x stream — it is only implemented on `mock-stream.js` and
 * `mock-muxer.js`. So the old `if (typeof stream.closeWrite === 'function')` guard never fired in production and
 * the write side was never closed. The reader on the other end ends its iteration on `remoteCloseWrite` (or
 * `close`), so it sat waiting for an event that was never sent → `Read timeout` on both sides of every
 * handshake and every federation stream.
 *
 * Note WHY this survived: because the guard is a `typeof` check it degraded silently rather than throwing, and
 * because the mocks DO implement `closeWrite`, any test written against a mock stream passes either way. The
 * bug is only observable between two real nodes.
 *
 * `close()` is the correct call: "Close stream for writing and return a promise that resolves once any pending
 * data has been passed to the underlying transport… the stream itself will remain readable until the remote end
 * also closes its writable end." That is exactly half-close semantics, and it flushes first, so no `drain`
 * handling is needed for payloads this size.
 */
async function writeToStream(stream: any, data: string): Promise<void> {
    // `send()` IS SYNCHRONOUS AND RETURNS A BOOLEAN — deliberately not awaited (review finding, rejected with
    // evidence). It appends to the stream's internal writeBuffer and returns `processSendQueue()`, which is a
    // plain non-async function returning true/false; the bytes are buffered before it returns. So `await`ing it
    // would add a microtask and no ordering guarantee, while reading like a synchronisation point that isn't
    // one. What actually guarantees the bytes reach the transport is `close()` below.
    //
    // The boolean is BACKPRESSURE: false means the send buffer is full. Ignored on purpose here — one small
    // JSON write per stream cannot overflow it, and `close()` flushes whatever is buffered regardless. If this
    // ever writes repeatedly or carries a large payload, the correct API is `await stream.onDrain()`, NOT
    // awaiting `send()`.
    //
    // `send()` throws synchronously if the write side is already closed. Inside this async function that
    // surfaces as a rejected promise, which every caller already handles in its try/catch.
    stream.send(encoder.encode(data));
    await stream.close();
}

/**
 * Register the handshake protocol handler on the libp2p node.
 */
export function registerHandshakeHandler(node: Libp2p): void {
    // Two positional arguments — see the note in federation-protocol.ts. libp2p 3.x passes
    // `(stream, connection)`, so reading `.connection` off the first argument always gave undefined and every
    // inbound handshake reported the peer as 'unknown':
    //   [Handshake] ← unknown: trust=false level=none
    // which is why `mutualTrust` never became true between two correctly configured peers.
    node.handle(PROTOCOL, async (stream: any, connection: any) => {
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
