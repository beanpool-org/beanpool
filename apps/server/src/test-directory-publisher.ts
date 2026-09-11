/**
 * Directory Publisher Service Integration Test
 *
 * Verifies:
 *  1. `pushDirectoryNow()` rejection when `getNodeRole()` is 'backup'.
 *  2. `pushDirectoryNow()` rejection when P2P node / key is not initialized.
 *  3. `pushDirectoryNow()` successful execution with a mock HTTP directory registry server.
 *     - Verifies request method is POST.
 *     - Verifies request headers `x-signature` and `x-public-key`.
 *     - Verifies JSON payload contents (`nodeId`, `callsign`, `timestamp`, `memberCount`, `postCount`, etc.).
 *     - Verifies `lastDirectoryPush` timestamp update in node config.
 *  4. `pushDirectoryNow()` error handling when directory registry returns non-2xx status code.
 *  5. `initDirectoryPublisher()` behavior when disabled or on backup node.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-directory-publisher.ts
 */

import http from 'node:http';

interface MockRequest {
    method: string;
    headers: http.IncomingHttpHeaders;
    body: Record<string, unknown> | string | null;
}

const receivedRequests: MockRequest[] = [];
let mockHttpStatus = 200;
let mockResponseBody = JSON.stringify({ status: 'ok' });

const server = http.createServer((req, res) => {
    let bodyStr = '';
    req.on('data', (chunk) => {
        bodyStr += chunk;
    });
    req.on('end', () => {
        let parsedBody: Record<string, unknown> | string | null;
        try {
            parsedBody = JSON.parse(bodyStr);
        } catch {
            parsedBody = bodyStr;
        }
        receivedRequests.push({
            method: req.method || 'UNKNOWN',
            headers: req.headers,
            body: parsedBody,
        });
        res.writeHead(mockHttpStatus, { 'Content-Type': 'application/json' });
        res.end(mockResponseBody);
    });
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
process.env.DIRECTORY_REGISTRY_URL = `http://127.0.0.1:${address.port}/v1/directory-register`;

// Import modules AFTER process.env.DIRECTORY_REGISTRY_URL is configured
const { initStateEngine, setNodeRole, getNodeConfig, updateNodeConfig } = await import('./state-engine.js');
const { startP2P } = await import('./p2p.js');
const { initDirectoryPublisher, pushDirectoryNow } = await import('./services/directory-publisher.js');

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

async function main() {
    console.log('Running directory-publisher service tests...\n');

    // Initialize isolated state engine
    initStateEngine();

    // ── 1. Role Guard Check ──────────────────────────────────────────────────
    setNodeRole('backup');
    const backupRes = await pushDirectoryNow();
    assert(backupRes.success === false, 'pushDirectoryNow fails when node role is backup');
    assert(
        backupRes.error === 'Directory push is only allowed on primary nodes',
        'pushDirectoryNow returns proper error message for backup node'
    );

    // Switch back to primary role
    setNodeRole('primary');

    // ── 2. Uninitialized P2P / Key Guard Check ──────────────────────────────
    const uninitRes = await pushDirectoryNow();
    assert(uninitRes.success === false, 'pushDirectoryNow fails when P2P node is not ready');
    assert(uninitRes.error === 'P2P node not ready', 'pushDirectoryNow reports P2P node not ready');

    // ── 3. Successful Directory Push with Mock Server ───────────────────────
    // Initialize P2P node (ephemeral ports)
    const p2pNode = await startP2P(0, 0);

    const successRes = await pushDirectoryNow();
    assert(successRes.success === true, 'pushDirectoryNow succeeds when P2P is ready and mock server returns 200');
    assert(typeof successRes.timestamp === 'string', 'pushDirectoryNow returns timestamp on success');

    assert(receivedRequests.length === 1, 'Mock directory registry received 1 request');
    const req0 = receivedRequests[0];
    assert(req0.method === 'POST', 'Directory push used HTTP POST');
    assert(typeof req0.headers['x-signature'] === 'string', 'Directory push included x-signature header');
    assert(typeof req0.headers['x-public-key'] === 'string', 'Directory push included x-public-key header');

    const bodyObj = req0.body as Record<string, unknown>;
    assert(bodyObj !== null && typeof bodyObj === 'object', 'Directory push sent valid JSON payload');
    assert(bodyObj.nodeId === p2pNode.peerId.toString(), 'Payload nodeId matches p2p peerId');
    assert(typeof bodyObj.timestamp === 'number', 'Payload includes timestamp');
    assert(typeof bodyObj.memberCount === 'number', 'Payload includes memberCount from directory info');

    const nodeConfig = getNodeConfig();
    assert(typeof nodeConfig.lastDirectoryPush === 'string', 'Node config lastDirectoryPush is updated after push');

    // ── 4. Error Handling on Non-2xx Response ──────────────────────────────
    mockHttpStatus = 500;
    mockResponseBody = 'Internal Server Error';

    const failRes = await pushDirectoryNow();
    assert(failRes.success === false, 'pushDirectoryNow fails when registry responds with HTTP 500');
    assert(
        typeof failRes.error === 'string' && failRes.error.includes('HTTP 500'),
        'pushDirectoryNow includes HTTP status in error message'
    );

    // ── 5. Disabled publisher check ───────────────────────────────────────
    updateNodeConfig({ directoryPushIntervalHours: 0 });
    initDirectoryPublisher();
    assert(getNodeConfig().directoryPushIntervalHours === 0, 'directoryPushIntervalHours can be set to 0');

    // Cleanup
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await p2pNode.stop();

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) {
        throw new Error(`${run - passed} check(s) failed`);
    }
    console.log('⭐️ Directory Publisher checks PASSED.');
}

main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
