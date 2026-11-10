/**
 * WebSocket application-level pong integration test
 *
 * Verifies:
 * 1. A plain ping {"type":"ping"} receives {"type":"pong"}: every ping is answered (cutover N2, audit E10; the
 *    `wantPong` opt-in kept apps from before ~17 Sep, now below the 1.4.0 floor, out of a sync loop)
 * 2. The apps' heartbeat {"type":"ping","wantPong":true} receives {"type":"pong"} (the key is not read)
 * 3. A ping in a frame of 256 bytes or more is never parsed, so it gets no reply (the DoS bound stays)
 * 4. Non-ping or malformed messages are handled safely without crashing
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

let PORT = 0; // the port startHttpsServer(0) bound
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('Running WebSocket pong watchdog server tests...\n');
    await initTls();
    initStateEngine();
    PORT = await startHttpsServer(0);

    const ws = new WebSocket(`wss://localhost:${PORT}/ws`, { rejectUnauthorized: false });
    const receivedMessages: Array<{ type?: string; [key: string]: unknown }> = [];

    ws.on('message', (d) => {
        try {
            receivedMessages.push(JSON.parse(d.toString()));
        } catch { /* ignore */ }
    });

    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    // Receive initial state_snapshot
    await sleep(100);
    assert(receivedMessages.length > 0 && receivedMessages[0].type === 'state_snapshot', 'Initial state_snapshot received on connection');
    receivedMessages.length = 0;

    // 1. A plain ping is answered: no opt-in any more (cutover N2, audit E10)
    ws.send(JSON.stringify({ type: 'ping' }));
    await sleep(250);
    const plainPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(plainPongReceived, 'A plain {"type":"ping"} receives {"type":"pong"}');
    receivedMessages.length = 0;

    // 2. The apps' heartbeat, which still says wantPong: true, is answered the same
    ws.send(JSON.stringify({ type: 'ping', wantPong: true }));
    await sleep(150);
    const heartbeatPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(heartbeatPongReceived, 'The heartbeat {"type":"ping","wantPong":true} receives {"type":"pong"}');
    receivedMessages.length = 0;

    // 3. The length bound stays: a frame of 256 bytes or more is never scanned or parsed, ping or not.
    ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(256) }));
    await sleep(150);
    const longPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(!longPongReceived, 'A ping in a frame of 256 bytes or more receives no reply');
    receivedMessages.length = 0;

    // 4. A message that is not a ping, though it says "ping" (so it is parsed), must NOT receive a pong
    ws.send(JSON.stringify({ type: 'other_message', wantPong: true, note: 'ping' }));
    await sleep(150);
    const otherPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(!otherPongReceived, 'Non-ping message does NOT trigger pong reply');
    receivedMessages.length = 0;

    // 5. Malformed payload does not crash server
    ws.send('NOT_VALID_JSON{:::');
    await sleep(150);
    assert(ws.readyState === WebSocket.OPEN, 'Malformed message handled safely without closing socket');

    ws.close();
    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ WebSocket pong watchdog server checks PASSED.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
