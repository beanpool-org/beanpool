/**
 * WebSocket Opt-in Application-level Pong Integration Test
 *
 * Verifies:
 * 1. Default/legacy ping {"type":"ping"} receives NO pong reply (Trap 1: protecting old clients)
 * 2. Opt-in ping {"type":"ping","wantPong":true} receives {"type":"pong"}
 * 3. Opt-in ping {"type":"ping","pong":true} receives {"type":"pong"}
 * 4. Non-ping or malformed messages are handled safely without crashing
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';

const PORT = 8559;
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
    await startHttpsServer(PORT);

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

    // 1. Legacy ping without opt-in flag must NOT receive a pong
    ws.send(JSON.stringify({ type: 'ping' }));
    await sleep(250);
    const legacyPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(!legacyPongReceived, 'Trap 1: Legacy {"type":"ping"} receives NO pong reply');
    receivedMessages.length = 0;

    // 2. Opt-in ping with wantPong: true must receive {"type":"pong"}
    ws.send(JSON.stringify({ type: 'ping', wantPong: true }));
    await sleep(150);
    const optInPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(optInPongReceived, 'Opt-in {"type":"ping","wantPong":true} receives {"type":"pong"}');
    receivedMessages.length = 0;

    // 3. `wantPong` is the ONLY opt-in key. A second alias bought nothing but another way to be
    // wrong, and prefiltering on a bare 'pong' substring forced a JSON.parse of any message that
    // merely contained the word.
    ws.send(JSON.stringify({ type: 'ping', pong: true }));
    await sleep(150);
    const aliasPongReceived = receivedMessages.some(m => m.type === 'pong');
    assert(!aliasPongReceived, 'A ping WITHOUT wantPong receives no reply, even if it says pong');
    receivedMessages.length = 0;

    // 4. Non-ping message with wantPong: true must NOT receive a pong
    ws.send(JSON.stringify({ type: 'other_message', wantPong: true }));
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
