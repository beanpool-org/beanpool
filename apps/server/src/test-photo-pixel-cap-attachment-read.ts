/**
 * Failing-first checks for the PHOTOS fixes:
 *   - P1: a chat photo goes to the people in its conversation only, for stored and withheld lines alike
 *   - P2: pixel cap at ingestion (MAX_STORED_PIXELS 2048x2048) for listing photos and avatars
 *
 * Extracted from the photos review verification (zz-ff.ts). Fails on origin/main, passes with the fixes.
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-photo-pixel-cap-attachment-read.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH', 'ENFORCE_LEDGER_AUTH', 'NODE_PROFILE', 'PRIVATE_PREVIEW']) delete process.env[k];
if (process.env.READ_AUTH === 'off') process.env.ENFORCE_READ_AUTH = 'false';
process.env.DISABLE_UPDATE_CHECK = 'true';

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { setMemberPhoto } from '@beanpool/engine';
import sharp from 'sharp';

let run = 0, passed = 0;
const fails: string[] = [];
function check(id: string, cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ [${id}] ${msg}`); } else { fails.push(id); console.error(`✗ [${id}] ${msg}`); }
}
let BASE = '';
const DAY = 86400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return { 'X-Public-Key': id.pk, 'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}
let beforeCall: () => void = () => {};
async function req(method: string, p: string, id?: Id, body?: any): Promise<{ status: number; body: any }> {
    beforeCall();
    const s = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = id ? signedHeaders(method, p, s, id) : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : s });
    const t = await res.text(); let json: any; try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, body: json };
}
function bombPng(w: number, h: number): Buffer {
    const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type, 'latin1'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 1;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc((1 + Math.ceil(w / 8)) * h), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } }, limitInputPixels: false } as any).jpeg({ quality: 60 }).toBuffer();
const webpLossless = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 1, g: 2, b: 3 } } }).webp({ lossless: true }).toBuffer();
const du = (mime: string, b: Buffer) => `data:${mime};base64,${b.toString('base64')}`;

async function main(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { lockedDm } = await import('./dm-test-payload.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls(); se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    console.log(`read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'OFF' : 'ON'}`);
    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`).run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const readAuthOn = process.env.ENFORCE_READ_AUTH !== 'false';

    // ── P1: a chat photo goes to the people in its conversation only ──
    {
        const alice = member('FfAlice'), bob = member('FfBob'), carol = member('FfCarol'), outsider = newId();
        const conv = se.createConversation('dm', [alice.pk, bob.pk], alice.pk)!;
        const ph = lockedDm(512);
        const s = await req('POST', '/api/messages/send', alice, { conversationId: conv.id, authorPubkey: alice.pk, ...lockedDm(), type: 'image', attachment: { data: ph.ciphertext, nonce: ph.nonce } });
        const mid = s.body?.message?.id;
        const u = await req('GET', `/api/messages/${mid}/attachment`);
        check('P1', readAuthOn ? u.status === 401 : u.status === 404, `unsigned → ${readAuthOn ? 401 : 404} (got ${u.status})`);
        const o = await req('GET', `/api/messages/${mid}/attachment`, outsider);
        check('P1', o.status === 403 || o.status === 404 || o.status === 401, `signed non-member → refused (got ${o.status})`);
        const c = await req('GET', `/api/messages/${mid}/attachment`, carol);
        check('P1', c.status === 404, `Carol, a member not in the DM → 404, as for no photo (got ${c.status})`);
        const b = await req('GET', `/api/messages/${mid}/attachment`, bob);
        const a = await req('GET', `/api/messages/${mid}/attachment`, alice);
        check('P1-control', b.status === 200 && b.body?.data === ph.ciphertext && a.status === 200, `Bob and Alice, in it → 200 (got ${b.status}, ${a.status})`);
        await req('POST', '/api/blocks', bob, { targetPubkey: alice.pk });
        const ph2 = lockedDm(256);
        const s2 = await req('POST', '/api/messages/send', alice, { conversationId: conv.id, authorPubkey: alice.pk, ...lockedDm(), type: 'image', attachment: { data: ph2.ciphertext, nonce: ph2.nonce } });
        const w = s2.body?.message?.id;
        const wb = await req('GET', `/api/messages/${w}/attachment`, bob);
        const wc = await req('GET', `/api/messages/${w}/attachment`, carol);
        const wa = await req('GET', `/api/messages/${w}/attachment`, alice);
        check('P1', wb.status === 404 && wc.status === 404, `a withheld line's photo: Bob (who blocked her) and Carol → 404 (got ${wb.status}, ${wc.status})`);
        check('P1-control', wa.status === 200 && wa.body?.data === ph2.ciphertext, `…and its sender still → 200 (got ${wa.status})`);
    }

    // ── P2: no photo whose decode is a pixel bomb ──
    {
        const dan = member('FfDan');
        const post = (photo: string) => req('POST', '/api/marketplace/posts', dan, { type: 'offer', category: 'food', title: 'Px', description: 'px', credits: 0, priceType: 'fixed', authorPublicKey: dan.pk, lat: -28.55, lng: 153.5, photos: [photo] });
        const bomb = await post(du('image/png', bombPng(20000, 20000)));
        check('P2', bomb.status === 400, `a 20000x20000 PNG listing photo → 400 (got ${bomb.status})`);
        const wbomb = await post(du('image/webp', await webpLossless(16383, 16383)));
        check('P2', wbomb.status === 400, `a 16383x16383 WebP listing photo → 400 (got ${wbomb.status})`);
        const jbomb = await post(du('image/jpeg', await jpeg(8000, 8000)));
        check('P2', jbomb.status === 400, `an 8000x8000 JPEG listing photo (500k base64 chars) → 400 (got ${jbomb.status})`);
        const av = await req('POST', '/api/profile/update', dan, { avatar: du('image/png', bombPng(20000, 20000)) });
        check('P2', av.status === 400, `the same PNG as an avatar → 400 (got ${av.status})`);
        for (const [what, w, h] of [['a phone portrait 800x1067', 800, 1067], ['a long phone screenshot 800x4444', 800, 4444], ['a web photo 800x600', 800, 600], ['a strip 2200x100', 2200, 100], ['2048x2048', 2048, 2048]] as [string, number, number][]) {
            const r = await post(du('image/jpeg', await jpeg(w, h)));
            check('P2-control', r.status === 200, `${what} → 200 (got ${r.status} ${r.status !== 200 ? JSON.stringify(r.body) : ''})`);
        }
    }

    console.log(`\n${passed}/${run} passed; failing: ${[...new Set(fails)].join(' ') || 'none'}`);
    process.exit(fails.length ? 1 : 0);
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 400_000).unref();
main().catch(e => { console.error('DRIVER ERROR', e); process.exit(3); });
