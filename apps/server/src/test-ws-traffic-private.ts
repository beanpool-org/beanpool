/**
 * test-ws-traffic-private.ts — the /ws/logs traffic lines carry no member frame content (#1534).
 *
 * The admin connection log (/ws/logs) sends a `ws_traffic` line for every frame a member's socket sends or receives.
 * It used to carry the frame's first 150 bytes as `preview`: a payment's frame begins with who paid whom, so any admin
 * watching the log saw it. Balances and trades are private by default. Now each line says what kind of frame it was
 * (its top-level `type`), its size, its direction and when, and nothing of what it says.
 *
 * Real HTTPS server: a member's signed /ws socket, an admin's /ws/logs socket opened with a ticket, a real signed
 * POST /api/ledger/transfer between two members, and a frame the member's socket sends in. Then:
 *   1. the transfer reaches the payer's socket (the frame the log describes exists);
 *   2. the log has a `ws_traffic` line for it: direction out, frameType 'transaction', its size, a time;
 *   3. no `ws_traffic` line holds either member's key or callsign, the amount or the note, nor a `preview`;
 *   4. the frame sent in is described as frameType 'ping', its marker nowhere in the log.
 *
 * Local only: it talks to the server it starts on localhost and nothing else.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import WebSocket from 'ws';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, transfer, createPost, acceptPost, completePostTransaction } from './state-engine.js';
import { setMemberPhoto } from '@beanpool/engine';
import { startHttpsServer } from './https-server.js';
import { issueWsTicket } from './admin-auth.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Id { pub: string; priv: crypto.KeyObject }
function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

function seedMember(pk: string, callsign: string) {
    // Joined 30 days ago, with a photo: posting needs a photo, and the wash-trading analysis leaves established members be.
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'), 'genesis', 'genesis')`).run(pk, callsign);
    setMemberPhoto(db, pk, 'data:image/png;base64,iVBORw0KGgo=');
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
}

function signedWsQuery(id: Id): string {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`WS\n/ws\n${ts}\n${nonce}\n`), id.priv).toString('base64');
    return `pubkey=${id.pub}&ts=${ts}&nonce=${nonce}&sig=${encodeURIComponent(sig)}`;
}

function open(url: string): Promise<{ ws: WebSocket; raw: string[] }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        const raw: string[] = [];
        ws.on('message', d => raw.push(d.toString()));
        ws.on('open', () => resolve({ ws, raw }));
        ws.on('unexpected-response', (_req, res) => reject(new Error(`upgrade answered ${res.statusCode}`)));
        ws.on('error', reject);
        setTimeout(() => reject(new Error('timeout')), 3000);
    });
}

async function main() {
    console.log('--- TEST: /ws/logs traffic lines carry no member frame content ---');
    await initTls();
    initStateEngine();
    const PORT = await startHttpsServer(0);
    const BASE = `https://localhost:${PORT}`;
    const WSS = `wss://localhost:${PORT}`;

    const payer = keypair(), payee = keypair();
    const PAYER_CALLSIGN = 'payerQz' + crypto.randomBytes(2).toString('hex');
    const PAYEE_CALLSIGN = 'payeeXw' + crypto.randomBytes(2).toString('hex');
    seedGenesisMember(keypair().pub, 'Gwen');
    seedMember(payer.pub, PAYER_CALLSIGN);
    seedMember(payee.pub, PAYEE_CALLSIGN);
    // A direct send needs Beans held and a completed trade behind the sender (state-engine transfer), as
    // test-blocks-on-beans seeds them.
    transfer('genesis', payer.pub, 100, 'seed', 'direct', true);
    const eggs = createPost('offer', 'produce', 'Eggs', 'Eggs, fresh', 10, 'fixed', payee.pub)!;
    createPost('offer', 'produce', 'Seedlings', 'Seedlings, fresh', 10, 'fixed', payer.pub); // an Offer first: accepting needs one
    completePostTransaction(acceptPost(eggs.id, payer.pub).id, payer.pub);

    const logs = await open(`${WSS}/ws/logs?ticket=${issueWsTicket()}`);
    const member = await open(`${WSS}/ws?${signedWsQuery(payer)}`);
    await sleep(200);
    logs.raw.length = 0;
    member.raw.length = 0;

    // A real send, signed by the payer as the apps sign it.
    const AMOUNT = 3.75;
    const MEMO = 'memo-' + crypto.randomBytes(4).toString('hex');
    const bodyString = JSON.stringify({ to: payee.pub, amount: AMOUNT, memo: MEMO });
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}/api/ledger/transfer`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Public-Key': payer.pub,
            'X-Signature': crypto.sign(null, Buffer.from(`POST\n/api/ledger/transfer\n${ts}\n${nonce}\n${bodyString}`), payer.priv).toString('base64'),
            'X-Timestamp': String(ts),
            'X-Nonce': nonce,
        },
        body: bodyString,
    });
    const resBody = await res.json().catch(() => null) as any;
    assert(res.status === 200, `the payer sends ${AMOUNT} Beans (got ${res.status} ${JSON.stringify(resBody)})`);

    // A frame the member's socket sends in, with a marker of its own.
    const IN_MARKER = 'in-marker-' + crypto.randomBytes(4).toString('hex');
    member.ws.send(JSON.stringify({ type: 'ping', note: IN_MARKER }));
    await sleep(400);

    // 1. The payer's socket got the transfer: the frame the log describes.
    const payFrame = member.raw.find(r => r.startsWith('{"type":"transaction"'));
    assert(!!payFrame && payFrame.includes(payer.pub) && payFrame.includes(MEMO),
        `the payer's socket gets the transaction frame with its parties and note (got ${member.raw.map(r => r.slice(0, 40)).join(' | ')})`);

    const traffic = logs.raw.filter(r => r.includes('"ws_traffic"'));
    const lines = traffic.map(r => { try { return JSON.parse(r).data; } catch { return null; } }).filter(Boolean);
    assert(lines.length >= 2, `the log has traffic lines for the member's socket (got ${lines.length})`);

    // 2. What the line keeps.
    const outLine = lines.find((l: any) => l.direction === 'out' && l.frameType === 'transaction');
    assert(!!outLine && typeof outLine.size === 'number' && outLine.size === (payFrame ?? '').length && typeof outLine.at === 'number' && typeof outLine.id === 'string',
        `the transaction frame is logged as: out, frameType 'transaction', its size, a time (got ${JSON.stringify(outLine ?? lines)})`);

    // 3. What it no longer carries, in any traffic line.
    const all = traffic.join('\n');
    for (const [label, secret] of [
        ['the payer\'s key', payer.pub], ['the payee\'s key', payee.pub],
        ['the payer\'s key prefix', payer.pub.slice(0, 16)], ['the payee\'s key prefix', payee.pub.slice(0, 16)],
        ['the payer\'s callsign', PAYER_CALLSIGN], ['the payee\'s callsign', PAYEE_CALLSIGN],
        ['the amount', String(AMOUNT)], ['the note', MEMO], ['the frame sent in', IN_MARKER],
    ] as const) {
        assert(!all.includes(secret), `no traffic line holds ${label}`);
    }
    assert(lines.every((l: any) => !('preview' in l)), `no traffic line has a preview (got keys ${[...new Set(lines.flatMap((l: any) => Object.keys(l)))].join(', ')})`);

    // 4. The frame sent in.
    const inLine = lines.find((l: any) => l.direction === 'in');
    assert(!!inLine && inLine.frameType === 'ping' && inLine.size > 0, `the frame sent in is logged as: in, frameType 'ping', its size (got ${JSON.stringify(inLine)})`);

    logs.ws.close();
    member.ws.close();
    console.log(`\nws traffic privacy suite: ${passed}/${run} assertions passed.`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch(e => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
