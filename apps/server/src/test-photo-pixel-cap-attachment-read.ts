/**
 * Failing-first checks for the PHOTOS fixes:
 *   - P1: a chat photo goes to the people in its conversation only, for stored and withheld lines alike
 *   - P2: pixel cap at ingestion (MAX_STORED_PIXELS 2048x2048) for listing photos and avatars
 *   - the #2079 review: a visitor's row gets the photos in its DMs, the route deciding (B2); four bytes after a JPEG's SOI
 *     and a GIF's images bigger than its screen hide nothing (B3, B4); the pixel refusal has its own sentence on every
 *     route that applies the cap, and the format refusal keeps its own (B5)
 *
 * Extracted from the photos review verification (zz-ff.ts). Fails on origin/main, passes with the fixes.
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-photo-pixel-cap-attachment-read.ts
 * and again with READ_AUTH=off (scripts/server-suites.mjs runs both).
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
/**
 * A JPEG with `FF 00 hi lo` after its SOI, `hi lo` the offset of its first DHT after the SOF (#2079 review B3). libjpeg
 * skips the four bytes as extraneous, and so does the node's strip; a walk that reads `FF 00` as a segment jumps past the SOF.
 */
function ff00AfterSoi(j: Buffer): Buffer {
    let pos = 2, sofSeen = false;
    while (pos + 4 <= j.length) {
        const m = j[pos + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) sofSeen = true;
        else if (m === 0xc4 && sofSeen) break;
        pos += 2 + j.readUInt16BE(pos + 2);
    }
    if ((pos >> 8) === 0xff || (pos & 0xff) === 0xff) throw new Error('setup: the offset has an FF byte');
    return Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0x00, pos >> 8, pos & 0xff]), j.subarray(2)]);
}
/**
 * A GIF: its logical screen, then each image on it, the LZW data of each a clear and an end code (#2079 review B4). Before
 * every image after the first, a NETSCAPE2.0 block (kept by the strip) whose second sub-block holds the bytes of an image
 * descriptor of 30000 × 30000: inside a sub-block they are no image, and a walk must skip them.
 */
function gif(sw: number, sh: number, frames: { left?: number; top?: number; w: number; h: number }[]): Buffer {
    const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    const out: number[] = [...Buffer.from('GIF89a', 'latin1'), ...u16(sw), ...u16(sh), 0x80, 0, 0, 0, 0, 0, 255, 255, 255];
    frames.forEach((f, i) => {
        if (i > 0) out.push(0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 10, 0x2c, 0, 0, 0, 0, 0x30, 0x75, 0x30, 0x75, 0, 0);
        out.push(0x2c, ...u16(f.left ?? 0), ...u16(f.top ?? 0), ...u16(f.w), ...u16(f.h), 0, 2, 1, 0x2c, 0);
    });
    out.push(0x3b);
    return Buffer.from(out);
}
/** The pixel refusal's own sentence, for this many pixels (#2079 review B5): never the format sentence. */
const tooBig = (w: number, h: number) => `That photo is too big to show on phones (${w} × ${h} pixels). Crop it and try again.`;
const errorOf = (r: { body: any }) => String(r.body?.message ?? r.body?.error ?? '');

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

    // ── P1 for a visitor's row (#2079 review B2): "they receive messages", photos included; the route decides ──
    {
        const { registerVisitor } = await import('./engine/members.js');
        const erin = member('FfErin'), visitor = newId(), otherVisitor = newId();
        registerVisitor(visitor.pk, 'FfVisitor');
        registerVisitor(otherVisitor.pk, 'FfVisitorTwo');
        const conv = se.createConversation('dm', [erin.pk, visitor.pk], erin.pk)!;
        const sendPhoto = async (from: Id) => {
            const ph = lockedDm(256);
            const s = await req('POST', '/api/messages/send', from, { conversationId: conv.id, authorPubkey: from.pk, ...lockedDm(), type: 'image', attachment: { data: ph.ciphertext, nonce: ph.nonce } });
            return { id: s.body?.message?.id as string, cipher: ph.ciphertext, status: s.status };
        };
        const toVisitor = await sendPhoto(erin);
        const got = await req('GET', `/api/messages/${toVisitor.id}/attachment`, visitor);
        check('B2', got.status === 200 && got.body?.data === toVisitor.cipher, `a visitor's row gets the photo a member sent it → 200 (got ${got.status} ${got.status !== 200 ? JSON.stringify(got.body) : ''})`);
        const own = await sendPhoto(visitor);
        const ownGot = await req('GET', `/api/messages/${own.id}/attachment`, visitor);
        check('B2', own.status === 200 && ownGot.status === 200 && ownGot.body?.data === own.cipher, `…and its own photo → 200 (sent ${own.status}, got ${ownGot.status})`);
        const outside = await req('GET', `/api/messages/${toVisitor.id}/attachment`, otherVisitor);
        check('B2', outside.status === 404, `a visitor's row outside the DM → 404, as for no photo (got ${outside.status})`);
        // Erin blocks it: its next photo is a withheld line, kept for it alone.
        await req('POST', '/api/blocks', erin, { targetPubkey: visitor.pk });
        const withheld = await sendPhoto(visitor);
        const inMessages = !!db.prepare('SELECT 1 FROM messages WHERE id = ?').get(withheld.id);
        const wv = await req('GET', `/api/messages/${withheld.id}/attachment`, visitor);
        const we = await req('GET', `/api/messages/${withheld.id}/attachment`, erin);
        check('B2', withheld.status === 200 && !inMessages && wv.status === 200 && wv.body?.data === withheld.cipher,
            `its own withheld photo → 200, as a stored one (sent ${withheld.status}, withheld ${!inMessages}, got ${wv.status})`);
        check('B2-control', we.status === 404, `…and the member who blocked it → 404 (got ${we.status})`);
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

        // B3: a JPEG whose bytes after SOI start FF 00 hi lo is the honest JPEG to every decoder, and to the node's strip.
        const lie = ff00AfterSoi(await jpeg(8000, 8000));
        const jl = await post(du('image/jpeg', lie));
        check('B3', jl.status === 400 && errorOf(jl) === tooBig(8000, 8000), `an 8000x8000 JPEG with FF 00 hi lo after its SOI, as a listing photo → 400 (got ${jl.status} ${JSON.stringify(errorOf(jl))})`);
        const jla = await req('POST', '/api/profile/update', dan, { avatar: du('image/jpeg', lie) });
        check('B3', jla.status === 400 && errorOf(jla) === tooBig(8000, 8000), `…and as an avatar → 400 (got ${jla.status} ${JSON.stringify(errorOf(jla))})`);

        // B4: a GIF is as big as its biggest image on the screen, not its screen alone.
        const lyingGif = gif(64, 64, [{ w: 20000, h: 20000 }]);
        const ga = await req('POST', '/api/profile/update', dan, { avatar: du('image/gif', lyingGif) });
        check('B4', ga.status === 400 && errorOf(ga) === tooBig(20000, 20000), `a GIF with a 64x64 screen and a 20000x20000 first image, as an avatar → 400 (got ${ga.status} ${JSON.stringify(errorOf(ga))})`);
        const gg = await req('POST', '/api/groups', dan, { name: 'Ff gif group', avatarUrl: du('image/gif', lyingGif) });
        check('B4', gg.status === 400 && errorOf(gg) === tooBig(20000, 20000), `…and as a group's picture → 400 (got ${gg.status} ${JSON.stringify(errorOf(gg))})`);
        const laterGif = gif(64, 64, [{ w: 64, h: 64 }, { left: 10, top: 20, w: 3000, h: 3000 }]);
        const gl = await req('POST', '/api/profile/update', dan, { avatar: du('image/gif', laterGif) });
        check('B4', gl.status === 400 && errorOf(gl) === tooBig(3010, 3020), `a GIF whose second image runs to 3010x3020, past an extension block → 400 (got ${gl.status} ${JSON.stringify(errorOf(gl))})`);
        const honestGif = gif(64, 64, [{ w: 64, h: 64 }, { left: 8, top: 8, w: 32, h: 32 }]);
        const gh = await req('POST', '/api/profile/update', dan, { avatar: du('image/gif', honestGif) });
        check('B4-control', gh.status === 200, `a two-image GIF inside its 64x64 screen, the extension's look-alike descriptor skipped → 200 (got ${gh.status} ${gh.status !== 200 ? JSON.stringify(gh.body) : ''})`);

        // B5: the pixel refusal says so in its own plain words, on every route that applies the cap; the format refusal keeps its own.
        check('B5', bomb.body?.error === tooBig(20000, 20000), `the 20000x20000 listing photo's refusal says why (got ${JSON.stringify(bomb.body?.error)})`);
        check('B5', errorOf(av) === tooBig(20000, 20000) && av.body?.error === 'avatar_too_big', `…and the avatar's (got ${JSON.stringify(av.body)})`);
        const long = await post(du('image/jpeg', await jpeg(800, 5300)));
        check('B5', long.status === 400 && long.body?.error === tooBig(800, 5300), `a long phone screenshot 800x5300 → 400 with the pixel sentence, not the format one (got ${long.status} ${JSON.stringify(long.body?.error)})`);
        const notAPicture = du('image/jpeg', Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(64)]));
        const fmt = await post(notAPicture);
        check('B5-control', fmt.status === 400 && fmt.body?.error === 'Each photo must be a JPEG, PNG or WebP image', `a HEIC labelled JPEG keeps the format sentence (got ${fmt.status} ${JSON.stringify(fmt.body?.error)})`);
        const bomb20k = du('image/png', bombPng(20000, 20000));
        const bare = await req('POST', '/api/profile/update', dan, { avatar: bombPng(20000, 20000).toString('base64') });
        check('B5', bare.status === 400 && errorOf(bare) === tooBig(20000, 20000), `an avatar in bare base64 → 400 with the pixel sentence (got ${bare.status} ${JSON.stringify(errorOf(bare))})`);
        const okGroup = await req('POST', '/api/groups', dan, { name: 'Ff picture group', avatarUrl: du('image/jpeg', await jpeg(128, 128)) });
        const gid = okGroup.body?.id ?? okGroup.body?.group?.id;
        const gp = await req('PATCH', `/api/groups/${gid}`, dan, { avatarUrl: bomb20k });
        check('B5', !!gid && gp.status === 400 && errorOf(gp) === tooBig(20000, 20000), `a group's new picture → 400 with the pixel sentence (made ${okGroup.status}, got ${gp.status} ${JSON.stringify(errorOf(gp))})`);
        const cf = await req('POST', '/api/crowdfund/projects', dan, { creatorPubkey: dan.pk, title: 'Ff fund', description: 'd', goalAmount: 100, photos: [bomb20k] });
        check('B5', cf.status === 400 && errorOf(cf) === tooBig(20000, 20000), `a crowdfund photo → 400 with the pixel sentence (got ${cf.status} ${JSON.stringify(errorOf(cf))})`);
        const ent = await req('POST', '/api/enterprise', dan, { name: 'Ff Enterprise', avatar: bomb20k, purpose: 'p' });
        check('B5', ent.status === 400 && errorOf(ent) === tooBig(20000, 20000), `an enterprise's photo → 400 with the pixel sentence (got ${ent.status} ${JSON.stringify(errorOf(ent))})`);
        const kn = await req('POST', '/api/join/knock', newId(), { callsign: 'FfKnocker', message: 'Hello, I live nearby and would like to join.', avatar: du('image/gif', lyingGif) });
        check('B5', kn.status === 400 && errorOf(kn) === tooBig(20000, 20000), `a knock's picture → 400 with the pixel sentence (got ${kn.status} ${JSON.stringify(kn.body)})`);
    }

    console.log(`\n${passed}/${run} passed; failing: ${[...new Set(fails)].join(' ') || 'none'}`);
    process.exit(fails.length ? 1 : 0);
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 400_000).unref();
main().catch(e => { console.error('DRIVER ERROR', e); process.exit(3); });
