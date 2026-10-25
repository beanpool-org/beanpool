/**
 * A shop's banner: its one photo, which its keepers choose (scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §0 row 4, §3, §5; Marty, 24 Oct 2026, of the enterprise page: "the banner is blank just a building icon"). An enterprise's
 * any keeper sets, as its category and How we deal; a member's shop's, its owner (the member's shop page is the same layout).
 *
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. set: a keeper puts a photo on the enterprise's shop (PUT /api/treasury/:t/shop { photo }) and a member on their own
 *      (PUT /api/shops/mine { photo }); it is kept out of the shop's row (shop_photos, its reference in shops.photo_ref),
 *      its metadata stripped, and charged to the member who sent it; the shop's read (GET /api/shops/:id) and the
 *      enterprise's page (GET /api/treasury/:t) carry its URL, which serves the photo, unsigned as an <img> asks, and
 *      only with its key
 *   2. replace: a new photo is a new URL and the old one opens nothing; the photo's own URL sent back, and a change that
 *      names no photo, keep it and charge nothing
 *   3. clear: `photo: null` takes it down with a tombstone, and its URL opens nothing
 *   4. who may: unsigned, a member who keeps nothing here, a keeper of another enterprise and a community admin who
 *      doesn't keep it (as for its category and How we deal) are refused and nothing is stored; a muted keeper can't put one
 *      up and can take one down; a closed enterprise's shop can't change
 *   5. the caps: what is no picture (someone's URL, an SVG, a shipped picture's name, a face's URL, text), more pixels than
 *      a node stores, and more bytes than a photo may hold are refused, nothing stored and nothing charged
 *   6. a close takes it: closing the shop, and closing the account, delete the photo with a tombstone
 *   7. old rows: a shop with no photo reads as none and its photo route answers 404; a visitor's view never carries one
 *   8. a standby: a whole copy carries the reference and the photo verbatim; a delta carries a photo put up, one replaced
 *      and one taken down (its tombstone); the standby serves what it holds
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-shop-banner.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'ShopBannerPass123!';

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, exportSyncState, signSyncPayload, importRemoteState, setNodeRole, reconcileLedgerFromDb,
    adminAssignTreasuryOperator, purgeMemberSelf,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { setMemberPhoto } from '@beanpool/engine';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getMemberPhotoUsageForTests } from './engine/photo-upload-budget.js';
import { emptyCopiedTables } from './engine/copied-tables.js';
import { ledger } from './engine/ledger.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without the banner (no such column, no such export) fails its assertion, not the run. */
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

// ── members and signed requests ─────────────────────────────────────────────────────────────────
interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
const WEEK_AGO = () => new Date(Date.now() - 7 * 86_400_000).toISOString();
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, WEEK_AGO(), owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, ledger.getCurrentEpoch());
    return id;
}

type Method = 'GET' | 'PUT' | 'POST';
interface Res { status: number; body: any; text: string }
async function call(method: Method, id: Id | null, route: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;
/** A refusal in a sentence: its code, and words a member can read that end as a sentence does. */
const sentence = (r: Res, status: number, code: string) =>
    r.status === status && r.body?.code === code && typeof r.body?.error === 'string' && r.body.error.length > 12 && /[.!]$/.test(r.body.error);

/** An image URL fetched as an <img> fetches it: unsigned, nothing but the URL. */
async function image(url: unknown): Promise<{ status: number; type: string | null; bytes: Buffer }> {
    if (typeof url !== 'string' || !url.startsWith('/api/')) return { status: 0, type: null, bytes: Buffer.alloc(0) };
    const res = await fetch(`${BASE}${url}`);
    return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}
const withoutKey = (url: unknown) => String(url ?? '').replace(/[?&]k=[^&]*/, '');
const withKey = (url: unknown, k: string) => `${withoutKey(url)}&k=${k}`;

// ── pictures: PNGs made here, so each is a different photo ───────────────────────────────────────
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(bytes: Buffer): number {
    let c = 0xffffffff;
    for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
    return Buffer.concat([len, typed, crc]);
}
/** A `width` × `height` PNG of one colour (RGB), with `text` in a tEXt chunk when given. */
function pngBytes(r: number, g: number, b: number, opts: { width?: number; height?: number; text?: string; noise?: boolean } = {}): Buffer {
    const width = opts.width ?? 1, height = opts.height ?? 1;
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
    const raw = opts.noise
        ? Buffer.concat(Array.from({ length: height }, () => { const n = crypto.randomBytes(1 + width * 3); n[0] = 0; return n; }))
        : Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
        ...(opts.text ? [chunk('tEXt', Buffer.from(`Comment\0${opts.text}`, 'latin1'))] : []),
        chunk('IDAT', zlib.deflateSync(raw, { level: opts.noise ? 0 : 6 })), chunk('IEND', Buffer.alloc(0))]);
}
const dataUrl = (bytes: Buffer) => `data:image/png;base64,${bytes.toString('base64')}`;
const png = (r: number, g: number, b: number) => dataUrl(pngBytes(r, g, b, { width: 4, height: 2 }));
/** The bytes a stored data URL holds. */
const bytesOf = (stored: string | null | undefined) => Buffer.from(String(stored ?? '').replace(/^data:[^,]*;base64,/, ''), 'base64');

// ── what is kept, read straight from the database ─────────────────────────────────────────────────
const shopIdOf = (who: string) => (db.prepare('SELECT id FROM shops WHERE owner_pubkey = ?').get(who) as { id: string } | undefined)?.id ?? '';
const photoRefOf = (shopId: string) => attempt(() => (db.prepare('SELECT photo_ref FROM shops WHERE id = ?').get(shopId) as { photo_ref: string | null } | undefined)?.photo_ref ?? null) ?? null;
const storedPhotoOf = (shopId: string) => attempt(() => (db.prepare('SELECT photo FROM shop_photos WHERE shop_id = ?').get(shopId) as { photo: string } | undefined)?.photo ?? null) ?? null;
const photoTomb = (shopId: string) => (db.prepare("SELECT deleted_at FROM tombstones WHERE table_name = 'shop_photos' AND row_key = ?").get(shopId) as { deleted_at: string } | undefined)?.deleted_at ?? null;
const shopColumns = () => (db.prepare('SELECT name FROM pragma_table_info(?)').all('shops') as { name: string }[]).map(c => c.name);
const usage = (who: Id) => getMemberPhotoUsageForTests(who.pk).usedBytes;
/** Everything a banner is kept as, for "nothing changed". */
const keptOf = (shopId: string) => JSON.stringify({ ref: photoRefOf(shopId), photo: storedPhotoOf(shopId) });

const treasuryShop = (t: string) => `/api/treasury/${t}/shop`;
const MINE = '/api/shops/mine';
const shopPath = (id: string) => `/api/shops/${id}`;

async function main(): Promise<void> {
    console.log('\n=== A shop\'s banner: its one photo, its keepers\' to choose ===\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const shops: any = await import('./engine/shops.js');

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive'); // the node's admin, who keeps nothing here
    const lou = member('LouSentinel');   // leads the enterprise
    const kit = member('KitSentinel');   // keeps it
    const mo = member('MoSentinel');     // keeps it, muted later
    const max = member('MaxSentinel');   // a member who keeps nothing here, with a shop of his own
    const ida = member('IdaSentinel');   // keeps another enterprise
    reconcileLedgerFromDb();

    const started = await call('POST', lou, '/api/enterprise', { name: 'Lou Repairs Sentinel', purpose: 'Fixing bikes and phones.' });
    const ent: string = started.body?.publicKey;
    if (!ent) throw new Error(`setup: Lou could not start an enterprise: ${show(started)}`);
    const other: string = (await call('POST', ida, '/api/enterprise', { name: 'Ida Works Sentinel', purpose: 'Joinery.' })).body?.publicKey;
    if (!other) throw new Error('setup: Ida could not start an enterprise');
    for (const k of [kit, mo]) adminAssignTreasuryOperator(ent, k.pk, 'admin');
    const entShop = shopIdOf(ent);
    if (!entShop) throw new Error('setup: the enterprise has no shop');

    // ── 7 (first, while every shop is as S1 left it). old rows ──────────────────────────────────
    console.log('── old rows: a shop with no photo ──');
    assert(shopColumns().includes('photo_ref'), `shops has a photo_ref column (${shopColumns().join(' ')})`);
    assert(attempt(() => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shop_photos'").get()) !== undefined,
        'the photos are kept in shop_photos, out of the shop\'s row');
    const plainRead = await call('GET', lou, shopPath(entShop));
    assert(plainRead.status === 200 && 'photoUrl' in (plainRead.body ?? {}) && plainRead.body.photoUrl === null,
        `a shop with no photo reads as none: photoUrl null (${show(plainRead)})`);
    const noPhoto = await image(`/api/shops/${entShop}/photo?v=x&k=${'a'.repeat(22)}`);
    assert(noPhoto.status === 404, `and its photo route answers 404 (${noPhoto.status})`);

    // ── 1. set ──────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 1. set ──');
    const first = dataUrl(pngBytes(200, 40, 40, { width: 8, height: 4, text: 'GPS 28.55S 153.50E' }));
    const kitBefore = usage(kit);
    const set = await call('PUT', kit, treasuryShop(ent), { photo: first });
    const firstUrl: string = set.body?.shop?.photoUrl;
    assert(set.status === 200 && typeof firstUrl === 'string' && firstUrl.startsWith(`/api/shops/${entShop}/photo?`) && /[?&]k=/.test(firstUrl),
        `any keeper puts a photo on the enterprise's shop, and the answer carries its keyed URL (${show(set)})`);
    const stored = storedPhotoOf(entShop);
    assert(typeof stored === 'string' && stored.startsWith('data:image/png;base64,') && typeof photoRefOf(entShop) === 'string',
        `it is kept in shop_photos with its reference on the shop's row (${photoRefOf(entShop)})`);
    assert(typeof stored === 'string' && !bytesOf(stored).includes(Buffer.from('GPS 28.55S')) && bytesOf(first).includes(Buffer.from('GPS 28.55S')),
        'its metadata is stripped before it is kept');
    const shopRow = attempt(() => db.prepare('SELECT * FROM shops WHERE id = ?').get(entShop) as Record<string, unknown>);
    assert(typeof stored === 'string' && !!shopRow && !Object.values(shopRow).some(v => typeof v === 'string' && v.startsWith('data:')), 'and never inline in the shop\'s row');
    assert(usage(kit) - kitBefore === bytesOf(first).length, `charged to the keeper who sent it (${usage(kit) - kitBefore} of ${bytesOf(first).length} bytes)`);
    const served = await image(firstUrl);
    assert(served.status === 200 && served.type === 'image/png' && served.bytes.equals(bytesOf(stored)),
        `its URL serves the photo, unsigned as an <img> asks (${served.status} ${served.type} ${served.bytes.length})`);
    const keyless = await image(withoutKey(firstUrl));
    const wrongKey = await image(withKey(firstUrl, 'b'.repeat(22)));
    assert(keyless.status === 404 && wrongKey.status === 404, `and only with its key (${keyless.status}, ${wrongKey.status})`);
    const read = await call('GET', max, shopPath(entShop));
    const page = await call('GET', max, `/api/treasury/${ent}`);
    assert(read.status === 200 && read.body?.photoUrl === firstUrl && page.status === 200 && page.body?.shop?.photoUrl === firstUrl,
        `a member's read of the shop and the enterprise's page carry it (${show(read)} | ${page.status} ${page.body?.shop?.photoUrl})`);
    const keepersRead = await call('GET', lou, treasuryShop(ent));
    assert(keepersRead.status === 200 && keepersRead.body?.shop?.photoUrl === firstUrl, `and the keepers' own read (${show(keepersRead)})`);

    const maxPhoto = png(10, 120, 200);
    const maxBefore = usage(max);
    const own = await call('PUT', max, MINE, { photo: maxPhoto });
    const maxShop: string = own.body?.shop?.id ?? '';
    const ownUrl: string = own.body?.shop?.photoUrl;
    assert(own.status === 200 && !!maxShop && typeof ownUrl === 'string' && storedPhotoOf(maxShop) !== null && usage(max) - maxBefore === bytesOf(maxPhoto).length,
        `a member puts one on their own shop, opening it, charged to them (${show(own)})`);
    const ownServed = await image(ownUrl);
    const ownRead = await call('GET', lou, shopPath(maxShop));
    assert(ownServed.status === 200 && ownServed.bytes.equals(bytesOf(storedPhotoOf(maxShop))) && ownRead.body?.photoUrl === ownUrl,
        `and every member reads it (${ownServed.status}; ${show(ownRead)})`);

    // ── 2. replace ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. replace ──');
    const second = png(40, 200, 40);
    const replaced = await call('PUT', lou, treasuryShop(ent), { photo: second });
    const secondUrl: string = replaced.body?.shop?.photoUrl;
    assert(replaced.status === 200 && typeof secondUrl === 'string' && secondUrl !== firstUrl && bytesOf(storedPhotoOf(entShop)).equals(bytesOf(second)),
        `a new photo replaces it, under a new URL (${show(replaced)})`);
    const oldOpens = await image(firstUrl);
    const newOpens = await image(secondUrl);
    assert(oldOpens.status === 404 && newOpens.status === 200 && newOpens.bytes.equals(bytesOf(second)),
        `the old URL opens nothing, the new one the new photo (${oldOpens.status}, ${newOpens.status})`);
    const louBefore = usage(lou);
    const keptSecond = keptOf(entShop);
    const sentBack = await call('PUT', kit, treasuryShop(ent), { photo: secondUrl, howToDeal: 'Ring the bell.' });
    const absolute = await call('PUT', kit, treasuryShop(ent), { photo: `https://some.node${secondUrl}` });
    const noPhotoNamed = await call('PUT', lou, treasuryShop(ent), { category: 'services' });
    assert(sentBack.status === 200 && absolute.status === 200 && noPhotoNamed.status === 200 && keptOf(entShop) === keptSecond
        && noPhotoNamed.body?.shop?.photoUrl === secondUrl && usage(lou) === louBefore,
        `its own URL sent back, and a change that names no photo, keep it and charge nothing (${show(sentBack)} | ${show(absolute)} | ${show(noPhotoNamed)})`);
    const otherShopUrl = await call('PUT', kit, treasuryShop(ent), { photo: ownUrl });
    assert(sentence(otherShopUrl, 400, 'photo_refused') && keptOf(entShop) === keptSecond,
        `another shop's photo URL is no photo of this one, refused in a sentence (${show(otherShopUrl)})`);

    // ── 3. clear ────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. clear ──');
    const cleared = await call('PUT', kit, treasuryShop(ent), { photo: null });
    assert(cleared.status === 200 && cleared.body?.shop?.photoUrl === null && photoRefOf(entShop) === null && storedPhotoOf(entShop) === null && !!photoTomb(entShop),
        `photo null takes it down, with a tombstone (${show(cleared)})`);
    assert((await image(secondUrl)).status === 404, 'and its URL opens nothing');
    const clearedAgain = await call('PUT', kit, treasuryShop(ent), { photo: '' });
    assert(clearedAgain.status === 200 && clearedAgain.body?.shop?.photoUrl === null, `an empty one is none too (${show(clearedAgain)})`);
    const back = await call('PUT', lou, treasuryShop(ent), { photo: second });
    const backUrl: string = back.body?.shop?.photoUrl;
    assert(back.status === 200 && typeof backUrl === 'string' && (await image(backUrl)).status === 200, `and one can go up again (${show(back)})`);

    // ── 4. who may ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. who may ──');
    const kept = keptOf(entShop);
    const attempts: Array<[string, Res]> = [
        ['unsigned', await call('PUT', null, treasuryShop(ent), { photo: png(1, 2, 3) })],
        ['a member who keeps nothing here', await call('PUT', max, treasuryShop(ent), { photo: png(1, 2, 3) })],
        ['a keeper of another enterprise', await call('PUT', ida, treasuryShop(ent), { photo: png(1, 2, 3) })],
        ['a community admin who doesn\'t keep it', await call('PUT', owner, treasuryShop(ent), { photo: png(1, 2, 3) })],
        ['a member who keeps nothing here, taking it down', await call('PUT', max, treasuryShop(ent), { photo: null })],
    ];
    for (const [who, r] of attempts) {
        assert((r.status === 401 || r.status === 403) && keptOf(entShop) === kept, `${who}: refused, nothing stored (${show(r)})`);
    }
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), mo.pk);
    const mutedUp = await call('PUT', mo, treasuryShop(ent), { photo: png(9, 9, 9) });
    assert(mutedUp.status === 403 && mutedUp.body?.code === 'moderation_muted' && keptOf(entShop) === kept, `a muted keeper can't put one up (${show(mutedUp)})`);
    const mutedDown = await call('PUT', mo, treasuryShop(ent), { photo: null });
    assert(mutedDown.status === 200 && photoRefOf(entShop) === null, `and can take one down (${show(mutedDown)})`);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(mo.pk);
    await call('PUT', lou, treasuryShop(ent), { photo: second });
    const otherShopId = shopIdOf(other);
    for (const status of ['suspended', 'completed']) {
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, other);
        const closedSet = await call('PUT', ida, treasuryShop(other), { photo: png(7, 7, 7) });
        assert(sentence(closedSet, 403, 'enterprise_closed') && storedPhotoOf(otherShopId) === null,
            `${status}: its keeper can't change its shop's photo (${show(closedSet)})`);
    }
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(other);

    // ── 5. the caps ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the caps ──');
    const keptCaps = keptOf(entShop);
    const kitCaps = usage(kit);
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    const notPictures: Array<[string, unknown]> = [
        ['someone else\'s URL', 'https://example.com/banner.jpg'],
        ['an SVG', svg],
        ['a shipped picture\'s name', 'bundled://avatar-1'],
        ['a member\'s face URL', `/api/avatar/${lou.pk}?size=thumb&v=1`],
        ['text that is no picture', 'not a picture at all'],
        ['a number', 42],
    ];
    for (const [what, photo] of notPictures) {
        const r = await call('PUT', kit, treasuryShop(ent), { photo });
        assert(sentence(r, 400, 'photo_refused') && keptOf(entShop) === keptCaps, `${what}: refused in a sentence, nothing stored (${show(r)})`);
    }
    const tooManyPixels = dataUrl(pngBytes(1, 1, 1, { width: 3000, height: 3000 }));
    const pixels = await call('PUT', kit, treasuryShop(ent), { photo: tooManyPixels });
    assert(sentence(pixels, 400, 'photo_refused') && /pixel/i.test(pixels.body?.error ?? '') && keptOf(entShop) === keptCaps,
        `more pixels than a node stores: refused in the pixel rule's words (${show(pixels)})`);
    // A photo past MAX_PICTURE_BYTES (2 MB): over HTTP its body is past the request cap first; the engine refuses it too.
    const huge = dataUrl(pngBytes(0, 0, 0, { width: 900, height: 820, noise: true }));
    const overHttp = await call('PUT', kit, treasuryShop(ent), { photo: huge });
    assert(overHttp.status === 413 && keptOf(entShop) === keptCaps, `more bytes than a photo may hold, over HTTP: 413, nothing stored (${overHttp.status})`);
    let engineRefusal: any = null;
    try { shops.changeShop(ent, { photo: huge }, { enterprise: true, actor: kit.pk }); } catch (e) { engineRefusal = e; }
    assert(engineRefusal?.status === 413 && engineRefusal?.code === 'photo_too_large' && /[.!]$/.test(engineRefusal?.message ?? '') && keptOf(entShop) === keptCaps,
        `and in the engine, in a sentence (${engineRefusal?.code}: ${engineRefusal?.message})`);
    assert(usage(kit) === kitCaps, `nothing refused is charged (${usage(kit) - kitCaps})`);

    // ── 6. a close takes it ─────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a close takes it ──');
    const closed = await call('POST', max, `${MINE}/close`, {});
    assert(closed.status === 200 && storedPhotoOf(maxShop) === null && !!photoTomb(maxShop), `closing a shop deletes its photo, with a tombstone (${show(closed)})`);
    assert((await image(ownUrl)).status === 404, 'and its URL opens nothing');
    const zed = member('ZedSentinel');
    const zedShop: string = (await call('PUT', zed, MINE, { photo: png(200, 200, 0) })).body?.shop?.id ?? '';
    attempt(() => purgeMemberSelf(zed.pk));
    assert(!!zedShop && storedPhotoOf(zedShop) === null && !!photoTomb(zedShop), 'an account closed takes its shop\'s photo, with a tombstone');

    // ── 7. a visitor's view ─────────────────────────────────────────────────────────────────────
    console.log('\n── 7. a visitor\'s view ──');
    const visitorView = attempt(() => shops.visitorShop(shops.shopById(entShop)));
    assert(!!visitorView && !('photoUrl' in visitorView) && JSON.stringify(Object.keys(visitorView).sort()) === JSON.stringify(['category', 'counts', 'id']),
        `a visitor's view of a shop never carries its photo (${JSON.stringify(visitorView)})`);
    const stranger = await call('GET', null, shopPath(entShop));
    assert((stranger.status === 401 || stranger.status === 403) && !stranger.text.includes('/photo'), `nor does a stranger's read here (${show(stranger)})`);

    // ── 8. a standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. a standby ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4291/p2p/${nodeId}`);
    const annie = member('AnnieSentinel');
    await call('PUT', annie, MINE, { photo: png(30, 60, 90) });
    const annieShop = shopIdOf(annie.pk);
    const everyPhoto = () => attempt(() => db.prepare('SELECT shop_id, photo, updated_at FROM shop_photos ORDER BY shop_id').all()) ?? [];
    const everyRef = () => db.prepare('SELECT id, photo_ref FROM shops ORDER BY id').all();
    const mainPhotos = JSON.stringify(everyPhoto());
    const mainRefs = JSON.stringify(attempt(everyRef) ?? []);
    const whole: any = await exportSyncState(nodeId);
    const exported: any[] = whole.plainTables?.shop_photos ?? [];
    assert(exported.length === 2 && JSON.stringify(exported.map(r => ({ shop_id: r.shop_id, photo: r.photo, updated_at: r.updated_at })).sort((a, b) => (a.shop_id < b.shop_id ? -1 : 1))) === mainPhotos,
        `a whole copy carries every photo verbatim (${exported.length})`);
    assert((whole.plainTables?.shops ?? []).some((s: any) => s.id === entShop && s.photo_ref === photoRefOf(entShop)), 'and each shop\'s reference');
    const wholeCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(whole));
    attempt(() => emptyCopiedTables(db));
    assert(JSON.stringify(everyPhoto()) === '[]', 'a new standby holds none');
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(wholeCopy, { full: true }); } catch (e: any) { importError = e?.message || String(e); }
    const standbyRead = await call('GET', lou, shopPath(entShop));
    const standbyServed = await image(standbyRead.body?.photoUrl);
    const standbyRefused = await call('PUT', lou, treasuryShop(ent), { photo: png(5, 5, 5) });
    setNodeRole('primary');
    reconcileLedgerFromDb();
    assert(importError === '' && JSON.stringify(everyPhoto()) === mainPhotos && JSON.stringify(attempt(everyRef) ?? []) === mainRefs,
        `the standby holds them exactly, row for row (${importError || `${everyPhoto().length} photos`})`);
    assert(standbyServed.status === 200 && standbyServed.bytes.equals(bytesOf(storedPhotoOf(entShop))) && standbyRefused.status === 409,
        `serves what it holds, and refuses a change, 409 (${standbyServed.status}; ${show(standbyRefused)})`);

    // A delta: one put up, one replaced, one taken down.
    const since = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const before = { photos: everyPhoto(), shops: db.prepare('SELECT * FROM shops ORDER BY id').all() as Record<string, unknown>[] };
    await call('PUT', kit, treasuryShop(ent), { photo: png(250, 250, 250) });
    await call('PUT', annie, MINE, { photo: null });
    await call('PUT', ida, treasuryShop(other), { photo: png(80, 40, 160) });
    const afterPhotos = JSON.stringify(everyPhoto());
    const afterRefs = JSON.stringify(attempt(everyRef) ?? []);
    const delta: any = await exportSyncState(nodeId, since);
    const dPhotos: any[] = delta.plainTables?.shop_photos ?? [];
    const dTomb = (delta.tombstones ?? []).find((t: any) => t.tableName === 'shop_photos' && t.rowKey === annieShop);
    assert(JSON.stringify(dPhotos.map(r => r.shop_id).sort()) === JSON.stringify([entShop, otherShopId].sort()) && !!dTomb,
        `a delta carries the photo put up, the one replaced and the one taken down's tombstone (${dPhotos.length}, ${!!dTomb})`);
    // The standby as it was before the delta, each row at an old stamp, so the copy's rows are the newer.
    attempt(() => db.transaction(() => {
        db.prepare('DELETE FROM shop_photos').run();
        const putPhoto = db.prepare("INSERT INTO shop_photos (shop_id, photo, updated_at) VALUES (?, ?, '2000-01-01T00:00:00.000Z')");
        for (const p of before.photos as any[]) putPhoto.run(p.shop_id, p.photo);
        db.prepare('DELETE FROM shops').run();
        const cols = Object.keys(before.shops[0] ?? {});
        const ins = db.prepare(`INSERT INTO shops (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
        for (const s of before.shops) ins.run(...cols.map(k => (k === 'updated_at' ? '2000-01-01T00:00:00.000Z' : s[k])));
        db.prepare("DELETE FROM tombstones WHERE table_name = 'shop_photos' AND row_key = ?").run(annieShop);
    })());
    const deltaCopy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta));
    setNodeRole('backup');
    importError = '';
    try { await importRemoteState(deltaCopy); } catch (e: any) { importError = e?.message || String(e); }
    const sEnt = await call('GET', max, shopPath(entShop));
    const sAnnie = await call('GET', max, shopPath(annieShop));
    const sEntServed = await image(sEnt.body?.photoUrl);
    setNodeRole('primary');
    assert(importError === '' && JSON.stringify(everyPhoto()) === afterPhotos && JSON.stringify(attempt(everyRef) ?? []) === afterRefs,
        `the standby follows: the new photo in, the replaced one replaced, the taken-down one gone (${importError || `${everyPhoto().length} photos`})`);
    assert(sEntServed.status === 200 && sEntServed.bytes.equals(bytesOf(png(250, 250, 250))) && sAnnie.status === 200 && sAnnie.body?.photoUrl === null,
        `and answers as the main server does (${sEntServed.status}; ${show(sAnnie)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log("⭐️ A shop's banner is its one photo: its keepers' to choose, kept out of its row, keyed, and copied whole.");
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ the suite stopped:', e);
    process.exit(1);
});
