/**
 * Integration test for Handshake Protocol (`handshake.ts`).
 *
 * Verifies:
 *   1. `registerHandshakeHandler` and `sendHandshake` protocol execution.
 *   2. Mutual trust verification between trusted and untrusted peers.
 *   3. Inbound handshake status updating in connector-manager.
 *   4. Graceful handling of invalid JSON/malformed streams.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-handshake.ts
 */

import { initStateEngine } from './state-engine.js';
import { addConnector, isPeerTrusted, getConnectorByPeerId } from './connector-manager.js';
import { registerHandshakeHandler, sendHandshake } from './handshake.js';

let run = 0;
let passed = 0;

function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) {
        passed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}

type StreamHandler = (stream: unknown, connection: unknown) => Promise<void> | void;

/**
 * In-memory duplex stream pair simulating libp2p streams.
 */
function createMockStreamPair() {
    class AsyncQueue {
        private queue: Uint8Array[] = [];
        private resolvers: Array<(result: IteratorResult<Uint8Array>) => void> = [];
        private closed = false;

        push(chunk: Uint8Array) {
            if (this.closed) return;
            if (this.resolvers.length > 0) {
                const resolve = this.resolvers.shift()!;
                resolve({ value: chunk, done: false });
            } else {
                this.queue.push(chunk);
            }
        }

        close() {
            if (this.closed) return;
            this.closed = true;
            while (this.resolvers.length > 0) {
                const resolve = this.resolvers.shift()!;
                resolve({ value: undefined as unknown as Uint8Array, done: true });
            }
        }

        async next(): Promise<IteratorResult<Uint8Array>> {
            if (this.queue.length > 0) {
                return { value: this.queue.shift()!, done: false };
            }
            if (this.closed) {
                return { value: undefined as unknown as Uint8Array, done: true };
            }
            return new Promise((resolve) => {
                this.resolvers.push(resolve);
            });
        }

        [Symbol.asyncIterator]() {
            return {
                next: () => this.next(),
            };
        }
    }

    const queueA2B = new AsyncQueue();
    const queueB2A = new AsyncQueue();

    const streamA = {
        send(data: Uint8Array) {
            queueA2B.push(data);
            return true;
        },
        async close() {
            queueA2B.close();
        },
        [Symbol.asyncIterator]() {
            return queueB2A[Symbol.asyncIterator]();
        },
    };

    const streamB = {
        send(data: Uint8Array) {
            queueB2A.push(data);
            return true;
        },
        async close() {
            queueB2A.close();
        },
        [Symbol.asyncIterator]() {
            return queueA2B[Symbol.asyncIterator]();
        },
    };

    return [streamA, streamB];
}

async function main() {
    console.log('Running Handshake Protocol Integration Tests...\n');

    // Initialize state engine (db tables, system_logs, etc)
    initStateEngine();

    const localPeerIdStr = '12D3KooW_LOCAL_NODE_PEER_ID';
    const trustedPeerIdStr = '12D3KooW_TRUSTED_PEER_ID';
    const untrustedPeerIdStr = '12D3KooW_UNTRUSTED_PEER_ID';

    // Seed connector manager
    addConnector(`/p2p/${trustedPeerIdStr}`, 'peer', 'TrustedPeer', 'https://trusted.local', true);

    // Verify seeded connector
    assert(isPeerTrusted(trustedPeerIdStr).trusted === true, 'Trusted peer is trusted in connector manager');
    assert(isPeerTrusted(untrustedPeerIdStr).trusted === false, 'Untrusted peer is NOT trusted in connector manager');

    // Create mock node
    let registeredHandler: StreamHandler | null = null;

    const mockNode = {
        peerId: {
            toString: () => localPeerIdStr,
        },
        handle(protocol: string, handler: StreamHandler) {
            if (protocol === '/beanpool/handshake/1.0.0') {
                registeredHandler = handler;
            }
        },
        async dialProtocol(peerIdObj: { toString: () => string }, _protocol: string) {
            const remotePeerId = peerIdObj.toString();
            const [clientStream, serverStream] = createMockStreamPair();

            const mockConnection = {
                remotePeer: {
                    toString: () => remotePeerId,
                },
            };

            // Trigger server handler asynchronously
            if (registeredHandler) {
                registeredHandler(serverStream, mockConnection);
            }

            return clientStream;
        },
    };

    // 1. Register handler
    registerHandshakeHandler(mockNode as unknown as Parameters<typeof registerHandshakeHandler>[0]);
    assert(registeredHandler !== null, 'Handshake handler registered successfully');

    // 2. Test handshake with a TRUSTED peer
    const trustedPeerObj = { toString: () => trustedPeerIdStr };
    const trustedResult = await sendHandshake(mockNode as unknown as Parameters<typeof sendHandshake>[0], trustedPeerObj);

    assert(trustedResult.mutualTrust === true, 'Mutual trust is TRUE for trusted peer exchange');
    assert(trustedResult.remoteTrustLevel === 'peer', 'Remote trust level is "peer"');
    assert(trustedResult.remoteActive === true, 'Remote active is true');
    assert(typeof trustedResult.latencyMs === 'number', 'Latency in ms is measured');

    const updatedConnector = getConnectorByPeerId(trustedPeerIdStr);
    assert(updatedConnector !== null && updatedConnector.mutualTrust === true, 'Inbound handshake status updated connector status to mutualTrust=true');

    // 3. Test handshake with an UNTRUSTED peer
    const untrustedPeerObj = { toString: () => untrustedPeerIdStr };
    const untrustedResult = await sendHandshake(mockNode as unknown as Parameters<typeof sendHandshake>[0], untrustedPeerObj);

    assert(untrustedResult.mutualTrust === false, 'Mutual trust is FALSE for untrusted peer');
    assert(untrustedResult.remoteTrustLevel === null, 'Remote trust level is null for untrusted peer');

    // 4. Test error handling for invalid JSON payload sent to handler
    let errorLogged = false;
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => {
        if (args[0] && typeof args[0] === 'string' && args[0].includes('[Handshake] Invalid JSON')) {
            errorLogged = true;
        }
    };

    const [clientStream, serverStream] = createMockStreamPair();
    const mockConn = { remotePeer: { toString: () => untrustedPeerIdStr } };

    // Handler execution on bad input
    if (registeredHandler) {
        const encoder = new TextEncoder();
        clientStream.send(encoder.encode('INVALID_NOT_JSON'));
        await clientStream.close();
        await (registeredHandler as StreamHandler)(serverStream, mockConn);
    }

    console.error = originalConsoleError;
    assert(errorLogged, 'Invalid JSON payload logged error gracefully without throwing');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Handshake checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
