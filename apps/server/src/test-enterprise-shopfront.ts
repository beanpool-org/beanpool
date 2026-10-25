/**
 * The enterprise shopfront's data on the server (slice E2 of scratch/tools/DESIGN-shops-round3-enterprise-shopfront-fable.md
 * §4, §5, §6, and S1's growth in §6: Featured; Marty's answers of 23 Oct 2026: ANY keeper edits About, the logo and
 * Featured, only the LEAD edits the name and the purpose; the keepers' own Offer categories shown automatically, members
 * only; six on the shelf).
 *
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. who may change the face (PUT /api/treasury/:t/profile): unsigned, a key that is no member, a member who keeps
 *      nothing here and a keeper of another enterprise are refused and write nothing, a taken name from them included
 *      (no answer says which names are taken); a key that is no enterprise, a member's or one made up, is 404 alike; any
 *      keeper sets About and the logo; a keeper who doesn't lead may not rename or change the purpose, in a sentence; the
 *      lead and a node admin may; a muted keeper and a closed enterprise are refused
 *   2. the bounds: About up to 600 characters, cleared by an empty one; the name 2 to 100 characters, refused when it
 *      folds to another account's (a member's or an enterprise's), its own in another case allowed; a purpose up to its
 *      limit and never empty; the logo under the photo rule (a picture, never someone's URL), charged to the keeper who
 *      sends it, never cleared; the node's own photo address sent back changes nothing; each field not text refused; a
 *      PUT naming nothing refused; profile_updated_at stamped, and a PUT that changes nothing stamps nothing
 *   3. the shop and the chat follow a rename: GET /api/shops/:id and the keepers' GET /api/treasury/:t/shop say the new
 *      name, and so does its chat opened before (GET /api/treasury/:t/thread, the conversation both apps title it by);
 *      a crowdfund and a Commons proposal start with no About (their description is their purpose), their own edits
 *      (POST /api/crowdfund/projects/update, /api/commons/projects/update) leave the keepers' About as written, and
 *      their chat follows the rename those edits make
 *   4. the detail (GET /api/treasury/:t): `since` and `about`; its shop as a member reads it at GET /api/shops/:id (its
 *      category and how it deals: S5's category chip and "How we deal"), and to anyone else its category and counts only; each keeper's tier, rating, trades and the categories of
 *      their own live Offers for everyone here (never a paused one, a Need, one for one person, an ended one); the
 *      enterprise's categories, the union with its own; every figure as the engine has it. Members only: unsigned, a key
 *      that is no member and a visitor's row get none of it (refused by the read gate with read auth on; with it off, the
 *      page without the badges and categories), and the engine's own gate says the same for each reader
 *   5. Featured (PUT /api/marketplace/posts/:id/feature): an Offer in its shop, by its author or a keeper of the
 *      enterprise that posted it; refused, writing nothing, to anyone else in one answer whether the listing is there or
 *      not; on a Need, an Offer in no shop and an ended one, in a sentence; six on the shelf, the seventh refused until
 *      one comes off, a paused one keeping its place; un-featured the same way; out of the shop or the shop closed, the
 *      stamp goes; a muted author can't feature and can un-feature; an enterprise suspended or wound up can neither, as
 *      its shop routes refuse it (403 enterprise_closed, their words), while its keeper's own Offer stays theirs; the
 *      stamp is the member's read's and not a visitor's; its keepers read its Offers as it would (`author=`, the Manage
 *      console's read): a paused one with its stamp, and all of them while it is paused for the season, which nobody
 *      else reads; a member bound as a keeper or unbound is never confirmed (304) the copy they held of the other view
 *   6. a standby: a whole copy carries each listing's stamp and the chat's new name; a delta carries a new name, About, purpose, logo and a stamp
 *      cleared, and the standby's copy of the enterprise's shop says the new name
 *
 * Local only: it talks to the server it starts on localhost, and to nothing else.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-enterprise-shopfront.ts
 * and with read auth opted out (scripts/server-suites.mjs VARIANTS): ENFORCE_READ_AUTH=false …
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;
/** The run with read auth opted out (VARIANTS): the detail's own gate answers a non-member, not the read gate. */
const OPEN_READS = process.env.ENFORCE_READ_AUTH === 'false';
if (!OPEN_READS) delete process.env.ENFORCE_READ_AUTH;
process.env.ADMIN_PASSWORD = 'ShopfrontPass123!';

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, exportSyncState, signSyncPayload, importRemoteState, setNodeRole, reconcileLedgerFromDb,
    adminAssignTreasuryOperator, getMemberTrustProfile, getMemberTrustStats, treasuryKeepers, pausePost, resumePost, removePost,
    purgeMemberSelf, pauseEnterprise, resumeEnterprise,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { setMemberPhoto, guestPost } from '@beanpool/engine';
import { tierForCredit } from '@beanpool/core';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { getMemberPhotoUsageForTests } from './engine/photo-upload-budget.js';
import { ledger } from './engine/ledger.js';
import { startP2P } from './p2p.js';
import { pinMainServerForTests } from './standby-pin-test-helper.js';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
/** A step that throws on a tree without the shopfront (no such column, no such export) fails its assertion, not the run. */
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
function member(name: string, opts: { visitor?: boolean } = {}): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor)
                VALUES (?, ?, ?, ?, 'TEST', 'active', ?)`).run(id.pk, name, WEEK_AGO(), owner.pk, opts.visitor ? 1 : 0);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, ?)').run(id.pk, ledger.getCurrentEpoch());
    return id;
}

type Method = 'GET' | 'PUT' | 'DELETE' | 'POST';
interface Res { status: number; body: any; text: string; etag?: string | null }
async function call(method: Method, id: Id | null, route: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
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
    return { status: res.status, body: parsed, text, etag: res.headers.get('etag') };
}
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 220)}`;
/** A refusal in a sentence: its code, and words a member can read that end as a sentence does. */
const sentence = (r: Res, status: number, code: string) =>
    r.status === status && r.body?.code === code && typeof r.body?.error === 'string' && r.body.error.length > 12 && /[.!]$/.test(r.body.error);

// ── a picture: a 1×1 PNG of one colour, made here, so each is a different photo ────────────────────
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
function png(r: number, g: number, b: number): string {
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(typed));
        return Buffer.concat([len, typed, crc]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b]))), chunk('IEND', Buffer.alloc(0))]);
    return `data:image/png;base64,${bytes.toString('base64')}`;
}

// ── what is kept, read straight from the database ─────────────────────────────────────────────────
interface FaceRow { callsign: string; purpose: string | null; bio: string | null; profile_updated_at: string | null; updated_at: string; joined_at: string; photo: string | null }
const faceOf = (pk: string) => db.prepare(`SELECT m.callsign, m.purpose, m.bio, m.profile_updated_at, m.updated_at, m.joined_at, mp.photo
    FROM members m LEFT JOIN member_photos mp ON mp.public_key = m.public_key WHERE m.public_key = ?`).get(pk) as FaceRow;
const featuredAtOf = (postId: string) => attempt(() => (db.prepare('SELECT featured_at FROM posts WHERE id = ?').get(postId) as { featured_at: string | null } | undefined)?.featured_at ?? null) ?? null;
const shopIdOf = (owner: string) => (db.prepare('SELECT id FROM shops WHERE owner_pubkey = ?').get(owner) as { id: string } | undefined)?.id ?? '';

const MULLUM = { lat: -28.55, lng: 153.50 };
const profilePath = (t: string) => `/api/treasury/${t}/profile`;
const featurePath = (id: string) => `/api/marketplace/posts/${id}/feature`;

async function main(): Promise<void> {
    console.log(`\n=== The enterprise shopfront's data (E2)${OPEN_READS ? ', read auth opted out' : ''} ===\n`);
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const shopfront: any = await import('./engine/enterprise-shopfront.js').catch(() => null);
    assert(typeof shopfront?.shopfrontOf === 'function', 'engine/enterprise-shopfront.ts exports shopfrontOf');

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive'); // the node's admin
    const lou = member('LouSentinel');   // leads the enterprise
    const kit = member('KitSentinel');   // keeps it, doesn't lead
    const rae = member('RaeSentinel');   // keeps it, with Offers of her own
    const mo = member('MoSentinel');     // keeps it, muted later
    const max = member('MaxSentinel');   // a member who keeps nothing here
    const ida = member('IdaSentinel');   // keeps another enterprise
    const vic = member('VicSentinel', { visitor: true }); // a visitor's row
    const nemo = newId('Nemo');          // a key that is no member here
    reconcileLedgerFromDb();

    const started = await call('POST', lou, '/api/enterprise', { name: 'Lou Repairs Sentinel', purpose: 'Fixing bikes and phones.' });
    const ent: string = started.body?.publicKey;
    if (!ent) throw new Error(`setup: Lou could not start an enterprise: ${show(started)}`);
    const other: string = (await call('POST', ida, '/api/enterprise', { name: 'Ida Works Sentinel', purpose: 'Joinery.' })).body?.publicKey;
    if (!other) throw new Error('setup: Ida could not start an enterprise');
    setMemberPhoto(db, ent, png(10, 20, 30));
    for (const k of [kit, rae, mo]) adminAssignTreasuryOperator(ent, k.pk, 'admin');
    const entShop = shopIdOf(ent);
    if (!entShop) throw new Error('setup: the enterprise has no shop');

    // ── 1. who may change the face ──────────────────────────────────────────────────────────────
    console.log('── 1. who may change the face ──');
    const untouched = JSON.stringify(faceOf(ent));
    const outsiders = [
        await call('PUT', null, profilePath(ent), { about: 'Not ours.' }),
        await call('PUT', nemo, profilePath(ent), { about: 'Not ours.' }),
        await call('PUT', max, profilePath(ent), { about: 'Not ours.' }),
        await call('PUT', ida, profilePath(ent), { about: 'Not ours.' }),
        await call('PUT', vic, profilePath(ent), { about: 'Not ours.' }),
    ];
    assert(outsiders[0].status === 401 && outsiders.slice(1).every(r => r.status === 403) && JSON.stringify(faceOf(ent)) === untouched,
        `unsigned 401; a key that is no member, a member who keeps nothing here, another enterprise's keeper and a visitor 403; nothing written (${outsiders.map(r => r.status).join(', ')})`);
    const probe = await call('PUT', max, profilePath(ent), { name: 'Ida Works Sentinel' });
    assert(probe.status === 403 && probe.body?.code !== 'name_taken', `a taken name from someone who keeps nothing here says nothing of names (${show(probe)})`);
    const notEnt = [await call('PUT', lou, profilePath(max.pk), { about: 'x' }), await call('PUT', lou, profilePath('ab'.repeat(32)), { about: 'x' })];
    assert(notEnt.every(r => r.status === 404) && notEnt[0].text === notEnt[1].text, `a member's key and a made-up one are no enterprise alike (${notEnt.map(show).join(' | ')})`);

    const kitAbout = await call('PUT', kit, profilePath(ent), { about: 'We fix bikes, phones and kettles on Saturdays.' });
    assert(kitAbout.status === 200 && kitAbout.body?.about === 'We fix bikes, phones and kettles on Saturdays.' && faceOf(ent).bio === 'We fix bikes, phones and kettles on Saturdays.',
        `any keeper writes About (${show(kitAbout)})`);
    const kitRename = await call('PUT', kit, profilePath(ent), { name: 'Kit Took It Sentinel' });
    const kitPurpose = await call('PUT', kit, profilePath(ent), { purpose: 'Something else.' });
    const kitBoth = await call('PUT', kit, profilePath(ent), { about: 'Sneaked in.', name: 'Kit Took It Sentinel' });
    assert(sentence(kitRename, 403, 'lead_only') && sentence(kitPurpose, 403, 'lead_only') && sentence(kitBoth, 403, 'lead_only')
        && faceOf(ent).callsign === 'Lou Repairs Sentinel' && faceOf(ent).purpose === 'Fixing bikes and phones.' && faceOf(ent).bio === 'We fix bikes, phones and kettles on Saturdays.',
        `a keeper who doesn't lead may not rename or change the purpose, in a sentence, and a PUT with About beside it writes none of it (${show(kitRename)})`);
    const louRename = await call('PUT', lou, profilePath(ent), { name: 'Lou Fixes Sentinel', purpose: 'Bikes, phones and kettles mended.' });
    assert(louRename.status === 200 && louRename.body?.name === 'Lou Fixes Sentinel' && faceOf(ent).callsign === 'Lou Fixes Sentinel'
        && faceOf(ent).purpose === 'Bikes, phones and kettles mended.', `the lead renames it and says what it is for (${show(louRename)})`);
    const adminRename = await call('PUT', owner, `/api/enterprise/${ent}/profile`, { name: 'Lou Mends Sentinel' });
    assert(adminRename.status === 200 && faceOf(ent).callsign === 'Lou Mends Sentinel', `so may a node admin, by the enterprise's own path too (${show(adminRename)})`);

    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + 86_400_000).toISOString(), mo.pk);
    const muted = await call('PUT', mo, profilePath(ent), { about: 'Muted words.' });
    assert(muted.status === 403 && muted.body?.code === 'moderation_muted' && faceOf(ent).bio === 'We fix bikes, phones and kettles on Saturdays.',
        `a muted keeper is refused (${show(muted)})`);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(other);
    const closed = await call('PUT', ida, profilePath(other), { about: 'Closed words.' });
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(other);
    assert(closed.status === 403 && faceOf(other).bio === null, `a closed enterprise's face can't change (${show(closed)})`);

    // ── 2. the bounds ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the bounds ──');
    const before = JSON.stringify(faceOf(ent));
    const refused = {
        about: await call('PUT', kit, profilePath(ent), { about: 'a'.repeat(601) }),
        short: await call('PUT', lou, profilePath(ent), { name: 'L' }),
        long: await call('PUT', lou, profilePath(ent), { name: 'N'.repeat(101) }),
        member: await call('PUT', lou, profilePath(ent), { name: 'maxsentinel' }),
        enterprise: await call('PUT', lou, profilePath(ent), { name: 'IDA WORKS SENTINEL' }),
        purpose: await call('PUT', lou, profilePath(ent), { purpose: '   ' }),
        purposeLong: await call('PUT', lou, profilePath(ent), { purpose: 'p'.repeat(2001) }),
        notText: await call('PUT', kit, profilePath(ent), { about: 42 }),
        nameNotText: await call('PUT', lou, profilePath(ent), { name: ['Lou'] }),
        nothing: await call('PUT', kit, profilePath(ent), {}),
        logoNull: await call('PUT', kit, profilePath(ent), { avatar: null }),
        logoUrl: await call('PUT', kit, profilePath(ent), { avatar: 'https://example.com/logo.png' }),
        logoBad: await call('PUT', kit, profilePath(ent), { avatar: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' }),
    };
    assert(sentence(refused.about, 400, 'text_too_long') && /600/.test(refused.about.body.error), `About over 600 is refused in a sentence (${show(refused.about)})`);
    assert(sentence(refused.short, 400, 'name_too_short') && sentence(refused.long, 400, 'text_too_long'), `a name under 2 or over 100 is refused (${show(refused.short)} | ${show(refused.long)})`);
    assert(sentence(refused.member, 409, 'name_taken') && sentence(refused.enterprise, 409, 'name_taken'),
        `a name that folds to a member's or another enterprise's is taken, in a sentence (${show(refused.member)} | ${show(refused.enterprise)})`);
    assert(sentence(refused.purpose, 400, 'purpose_required') && sentence(refused.purposeLong, 400, 'text_too_long'), `a purpose is never empty and held to its limit (${show(refused.purpose)})`);
    assert(sentence(refused.notText, 400, 'not_text') && sentence(refused.nameNotText, 400, 'not_text'), `a field that isn't text is refused (${show(refused.notText)})`);
    assert(sentence(refused.nothing, 400, 'nothing_to_change'), `a PUT naming nothing is refused (${show(refused.nothing)})`);
    assert(sentence(refused.logoNull, 400, 'logo_required'), `the logo is never cleared (${show(refused.logoNull)})`);
    assert(refused.logoUrl.status === 400 && refused.logoBad.status === 400 && typeof refused.logoUrl.body?.error === 'string',
        `a logo that is someone's URL or no picture is refused (${show(refused.logoUrl)} | ${show(refused.logoBad)})`);
    assert(JSON.stringify(faceOf(ent)) === before, 'and none of them wrote anything');

    const ownCase = await call('PUT', lou, profilePath(ent), { name: 'LOU MENDS SENTINEL' });
    assert(ownCase.status === 200 && faceOf(ent).callsign === 'LOU MENDS SENTINEL', `its own name in another case is its own (${show(ownCase)})`);
    const cleared = await call('PUT', kit, profilePath(ent), { about: '  ' });
    assert(cleared.status === 200 && cleared.body?.about === null && faceOf(ent).bio === null, 'an empty About clears it');
    const sixHundred = 'é'.repeat(600);
    const fits = await call('PUT', rae, profilePath(ent), { about: sixHundred });
    assert(fits.status === 200 && faceOf(ent).bio === sixHundred, 'About of 600 characters fits, in any script');

    const raeBytesBefore = getMemberPhotoUsageForTests(rae.pk).usedBytes;
    const louBytesBefore = getMemberPhotoUsageForTests(lou.pk).usedBytes;
    const logo = png(200, 40, 40);
    const stampBefore = faceOf(ent).profile_updated_at ?? '';
    await new Promise(r => setTimeout(r, 5));
    const newLogo = await call('PUT', rae, profilePath(ent), { avatar: logo });
    const logoBytes = Buffer.byteLength(logo.split(',')[1], 'base64');
    assert(newLogo.status === 200 && faceOf(ent).photo?.startsWith('data:image/png;base64,') === true && faceOf(ent).photo !== png(10, 20, 30)
        && typeof newLogo.body?.avatarUrl === 'string' && newLogo.body.avatarUrl.includes(ent),
        `any keeper sets the logo: the enterprise's avatar, served by its URL (${show(newLogo)})`);
    assert(getMemberPhotoUsageForTests(rae.pk).usedBytes - raeBytesBefore === logoBytes && getMemberPhotoUsageForTests(lou.pk).usedBytes === louBytesBefore,
        `charged to the keeper who sent it, not the lead (${getMemberPhotoUsageForTests(rae.pk).usedBytes - raeBytesBefore} of ${logoBytes})`);
    assert((faceOf(ent).profile_updated_at ?? '') > stampBefore, 'profile_updated_at is stamped');
    const photoNow = faceOf(ent).photo;
    const sentBack = await call('PUT', kit, profilePath(ent), { avatar: newLogo.body?.avatarUrl ?? `/api/avatar/${ent}` });
    assert(sentBack.status === 200 && faceOf(ent).photo === photoNow, `the node's own address for it sent back changes nothing (${show(sentBack)})`);
    const stillStamp = JSON.stringify(faceOf(ent));
    await new Promise(r => setTimeout(r, 5));
    const same = await call('PUT', kit, profilePath(ent), { about: sixHundred });
    assert(same.status === 200 && JSON.stringify(faceOf(ent)) === stillStamp, 'a PUT that changes nothing stamps nothing');

    // A field sent back as it was stored is no change, though the form sends it trimmed and the row holds it as it was
    // written (#2391 review): a crowdfund's description keeps its textarea's newline as its purpose (db.ts
    // createCrowdfundProject), and a row an older seed filled keeps an About past 600 that nobody here wrote.
    const cfTrail = (await call('POST', lou, '/api/crowdfund/projects', { creatorPubkey: lou.pk, title: 'Lou Trail Sentinel', description: 'Fix bikes for the street.\n', goalAmount: 100 })).body?.project?.id ?? '';
    if (!cfTrail) throw new Error('setup: Lou could not start the crowdfund with a trailing newline');
    adminAssignTreasuryOperator(cfTrail, kit.pk, 'admin');
    const trailStored = faceOf(cfTrail);
    const trailForm = await call('GET', kit, `/api/treasury/${cfTrail}`);
    const kitForm = await call('PUT', kit, profilePath(cfTrail), { name: trailForm.body?.name ?? trailStored.callsign, purpose: trailForm.body?.purpose ?? trailStored.purpose, about: 'Open Saturdays.' });
    assert(trailStored.purpose === 'Fix bikes for the street.\n' && kitForm.status === 200 && faceOf(cfTrail).bio === 'Open Saturdays.'
        && faceOf(cfTrail).purpose === 'Fix bikes for the street.\n' && faceOf(cfTrail).callsign === 'Lou Trail Sentinel',
        `a keeper who doesn't lead sends the whole form back with only a new About: About is written, the purpose stays as stored (${show(kitForm)}; ${JSON.stringify(faceOf(cfTrail).purpose)})`);
    const legacyAbout = `${'Mended wheels. '.repeat(69)}\n`;
    db.prepare('UPDATE members SET bio = ? WHERE public_key = ?').run(legacyAbout, cfTrail);
    const legacyStamp = JSON.stringify(faceOf(cfTrail));
    const louForm = await call('PUT', lou, profilePath(cfTrail), { name: trailStored.callsign, purpose: trailStored.purpose, about: legacyAbout });
    assert(legacyAbout.length > 600 && louForm.status === 200 && JSON.stringify(faceOf(cfTrail)) === legacyStamp,
        `the lead's untouched form over an About an older seed left past 600 is no change, not a refusal (${show(louForm)})`);
    const louLogo = await call('PUT', lou, profilePath(cfTrail), { name: trailStored.callsign, purpose: trailStored.purpose, about: legacyAbout, avatar: png(90, 160, 90) });
    assert(louLogo.status === 200 && faceOf(cfTrail).bio === legacyAbout && faceOf(cfTrail).photo?.startsWith('data:image/png;base64,') === true,
        `and that form with a new logo saves the logo, leaving the About as it was (${show(louLogo)})`);

    // ── 3. the shop follows a rename ────────────────────────────────────────────────────────────
    console.log('\n── 3. the shop and the chat follow a rename ──');
    const chatBefore = await call('GET', kit, `/api/treasury/${ent}/thread`); // opened under the name it has now
    await call('PUT', lou, profilePath(ent), { name: 'Lou Mended Sentinel' });
    const shopRead = await call('GET', max, `/api/shops/${entShop}`);
    const keeperRead = await call('GET', kit, `/api/treasury/${ent}/shop`);
    assert(shopRead.status === 200 && shopRead.body?.name === 'Lou Mended Sentinel' && keeperRead.status === 200 && keeperRead.body?.shop?.name === 'Lou Mended Sentinel',
        `a member's read of its shop and its keepers' say the new name (${show(shopRead)} | ${show(keeperRead)})`);
    const chatAfter = await call('GET', kit, `/api/treasury/${ent}/thread`);
    const chatRow = db.prepare('SELECT name FROM conversations WHERE id = ?').get(ent) as { name: string | null } | undefined;
    assert(chatBefore.status === 200 && chatBefore.body?.conversation?.name === 'LOU MENDS SENTINEL'
        && chatAfter.status === 200 && chatAfter.body?.conversation?.name === 'Lou Mended Sentinel' && chatRow?.name === 'Lou Mended Sentinel',
        `its chat, opened before, says the new name: the thread both apps title it by (${chatBefore.body?.conversation?.name} → ${chatAfter.body?.conversation?.name}; row ${chatRow?.name})`);

    // The older writers of an enterprise's name and purpose: a crowdfund's create and edit (POST /api/crowdfund/projects,
    // …/update) and a Commons proposal's (POST /api/commons/projects, …/update). What it is for is its purpose, so its
    // About starts empty; an edit leaves the keepers' About as they wrote it, and its chat follows the rename.
    const story = `We mend what breaks. ${'Tyres, chains and spokes. '.repeat(40)}`.trim(); // past About's 600, within a purpose
    const cfMade = await call('POST', lou, '/api/crowdfund/projects', { creatorPubkey: lou.pk, title: 'Lou Wheels Sentinel', description: story, goalAmount: 500 });
    const proposed = await call('POST', lou, '/api/commons/projects', { proposerPubkey: lou.pk, title: 'Lou Commons Sentinel', description: 'A shared tool shed for the street.', requestedAmount: 50 });
    const cf: string = cfMade.body?.project?.id ?? '';
    const cp: string = proposed.body?.project?.id ?? '';
    if (!cf || !cp) throw new Error(`setup: Lou could not start a crowdfund and a Commons proposal: ${show(cfMade)} | ${show(proposed)}`);
    const seeded = [await call('GET', max, `/api/treasury/${cf}`), await call('GET', max, `/api/treasury/${cp}`)];
    assert(seeded.every(r => r.status === 200 && r.body?.about === null) && seeded[0].body?.purpose === story && faceOf(cf).bio === null && faceOf(cp).bio === null,
        `a crowdfund and a Commons proposal start with no About: what it is for is its purpose, not its About too (${seeded.map(r => `${r.status} ${JSON.stringify(r.body?.about)?.slice(0, 40)}`).join(' | ')})`);
    const ownAbout = "Our own About, in the keepers' words.";
    const setAbout = [await call('PUT', lou, profilePath(cf), { about: ownAbout }), await call('PUT', lou, profilePath(cp), { about: ownAbout })];
    const threadsBefore = [await call('GET', lou, `/api/treasury/${cf}/thread`), await call('GET', lou, `/api/treasury/${cp}/thread`)]; // opened under the names they have now
    const cfEdit = await call('POST', lou, '/api/crowdfund/projects/update', { id: cf, creatorPubkey: lou.pk, title: 'Lou Spokes Sentinel', description: `${story} (edited)`, goalAmount: 500 });
    const cpEdit = await call('POST', lou, '/api/commons/projects/update', { proposerPubkey: lou.pk, projectId: cp, title: 'Lou Shed Sentinel', description: 'A shared tool shed for two streets.', requestedAmount: 50 });
    const edited = [await call('GET', max, `/api/treasury/${cf}`), await call('GET', max, `/api/treasury/${cp}`)];
    assert(setAbout.every(r => r.status === 200) && cfEdit.status === 200 && cpEdit.status === 200
        && faceOf(cf).purpose === `${story} (edited)` && faceOf(cp).purpose === 'A shared tool shed for two streets.'
        && edited.every(r => r.status === 200 && r.body?.about === ownAbout) && faceOf(cf).bio === ownAbout && faceOf(cp).bio === ownAbout,
        `an edit of the crowdfund or the proposal changes its purpose and leaves its About as its keepers wrote it (${[...setAbout, cfEdit, cpEdit].map(r => r.status).join(', ')}; ${edited.map(r => JSON.stringify(r.body?.about)?.slice(0, 40)).join(' | ')})`);
    const threadsAfter = [await call('GET', lou, `/api/treasury/${cf}/thread`), await call('GET', lou, `/api/treasury/${cp}/thread`)];
    const names = (rs: Res[]) => rs.map(r => r.body?.conversation?.name);
    assert(JSON.stringify(names(threadsBefore)) === JSON.stringify(['Lou Wheels Sentinel', 'Lou Commons Sentinel'])
        && JSON.stringify(names(threadsAfter)) === JSON.stringify([faceOf(cf).callsign, faceOf(cp).callsign])
        && JSON.stringify(names(threadsAfter)) === JSON.stringify(['Lou Spokes Sentinel', 'Lou Shed Sentinel']),
        `and its chat, opened before, follows that rename too (${names(threadsBefore).join(', ')} → ${names(threadsAfter).join(', ')})`);

    // ── 4. the detail ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the detail: the shopfront\'s data, members only ──');
    const memberOffer = async (who: Id, category: string, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
        const r = await call('POST', who, '/api/marketplace/posts', { type: 'offer', category, title, description: `${title}.`, credits: 0,
            authorPublicKey: who.pk, lat: MULLUM.lat, lng: MULLUM.lng, ...extra });
        if (r.status !== 200 || !r.body?.post?.id) throw new Error(`setup: ${who.name} could not post ${title}: ${show(r)}`);
        return r.body.post.id;
    };
    const entOffer = async (by: Id, category: string, title: string, extra: Record<string, unknown> = {}): Promise<string> => {
        const r = await call('POST', by, `/api/treasury/${ent}/offer`, { category, title, credits: 0, lat: MULLUM.lat, lng: MULLUM.lng, ...extra });
        if (r.status !== 200 || !(r.body?.post?.id ?? r.body?.id)) throw new Error(`setup: ${by.name} could not post ${title} for the enterprise: ${show(r)}`);
        return r.body?.post?.id ?? r.body?.id;
    };
    const honey = await memberOffer(rae, 'food', 'Honey');
    await memberOffer(rae, 'tools', 'Spade');
    await memberOffer(rae, 'tools', 'Rake');
    const seeds = await memberOffer(rae, 'garden', 'Seeds');
    await call('POST', rae, '/api/marketplace/posts/pause', { postId: seeds, authorPublicKey: rae.pk });
    await call('POST', rae, '/api/marketplace/posts', { type: 'need', category: 'transport', title: 'A lift', description: 'To town.', credits: 0, authorPublicKey: rae.pk, lat: MULLUM.lat, lng: MULLUM.lng });
    await memberOffer(rae, 'art', 'A portrait for Max', { audienceScope: 'direct', targetPubkey: max.pk });
    const ended = await memberOffer(rae, 'music', 'Old guitar');
    await call('POST', rae, '/api/marketplace/posts/remove', { id: ended, authorPublicKey: rae.pk });
    await memberOffer(lou, 'repairs', 'Puncture fixed');
    await entOffer(lou, 'electronics', 'Phone screen', { shopId: entShop });
    // Rae's record: one completed deal, rated 4; Lou's tier from a grant.
    db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, completed_at)
                VALUES (?, ?, ?, ?, 0, 'completed', ?)`).run(crypto.randomUUID(), honey, max.pk, rae.pk, new Date().toISOString());
    db.prepare(`INSERT INTO ratings (id, target_pubkey, rater_pubkey, role, stars, comment) VALUES (?, ?, ?, 'provider', 4, '')`).run(crypto.randomUUID(), rae.pk, max.pk);
    db.prepare('UPDATE members SET earned_credit = 300 WHERE public_key = ?').run(lou.pk);

    const detail = await call('GET', max, `/api/treasury/${ent}`);
    const keeperOf = (r: Res, pk: string) => (r.body?.keepers ?? []).find((k: any) => k.publicKey === pk);
    const expectKeeper = (pk: string) => {
        const profile = getMemberTrustProfile(pk);
        return { tier: tierForCredit(profile.tierCredit).name, trades: getMemberTrustStats(pk).tradeCount };
    };
    assert(detail.status === 200 && detail.body?.since === faceOf(ent).joined_at && detail.body?.about === sixHundred,
        `\`since\` is when it started, \`about\` its About (${detail.body?.since} / ${faceOf(ent).joined_at})`);
    const raeRow = keeperOf(detail, rae.pk);
    const louRow = keeperOf(detail, lou.pk);
    const kitRow = keeperOf(detail, kit.pk);
    assert(raeRow?.tier === expectKeeper(rae.pk).tier && raeRow?.trades === expectKeeper(rae.pk).trades && raeRow?.trades === 1
        && raeRow?.rating?.average === 4 && raeRow?.rating?.count === 1,
        `a keeper's tier, trades and rating, as the engine has them (${JSON.stringify(raeRow && { tier: raeRow.tier, trades: raeRow.trades, rating: raeRow.rating })})`);
    assert(louRow?.tier === expectKeeper(lou.pk).tier && louRow?.tier !== 'Newcomer' && kitRow?.tier === 'Newcomer' && kitRow?.trades === 0 && kitRow?.rating?.count === 0,
        `each keeper's own (${louRow?.tier}, ${kitRow?.tier})`);
    assert(JSON.stringify(raeRow?.offerCategories) === JSON.stringify(['food', 'tools']) && JSON.stringify(louRow?.offerCategories) === JSON.stringify(['repairs'])
        && JSON.stringify(kitRow?.offerCategories) === JSON.stringify([]),
        `a keeper's categories: their own live Offers for everyone here, once each, never a paused one, a Need, one for one person or an ended one (${JSON.stringify(raeRow?.offerCategories)})`);
    assert(JSON.stringify(detail.body?.offerCategories) === JSON.stringify(['electronics', 'food', 'repairs', 'tools']),
        `the enterprise's: the union with its own (${JSON.stringify(detail.body?.offerCategories)})`);
    const ownRead = await call('GET', rae, `/api/treasury/${ent}`);
    assert(JSON.stringify(keeperOf(ownRead, rae.pk)?.offerCategories) === JSON.stringify(['food', 'tools']),
        'a keeper reading their own row gets the same live ones, not the one they paused');

    // Its shop on its page (S5, round 3 §3: the category chip and "How we deal"): what a member reads of it at GET /api/shops/:id.
    const dressed = await call('PUT', kit, `/api/treasury/${ent}/shop`, { category: 'services', howToDeal: 'Bring it by on a Saturday; pay in Beans when it works.' });
    const withShop = await call('GET', max, `/api/treasury/${ent}`);
    const shopAsRead = await call('GET', max, `/api/shops/${entShop}`);
    assert(dressed.status === 200 && withShop.body?.shop?.id === entShop && withShop.body?.shop?.category === 'services'
        && withShop.body?.shop?.howToDeal === 'Bring it by on a Saturday; pay in Beans when it works.' && withShop.body?.shop?.enterprise === true
        && JSON.stringify(withShop.body?.shop) === JSON.stringify(shopAsRead.body),
        `the detail carries its shop as a member reads it at GET /api/shops/:id: its category and how it deals (${show(dressed)} | ${JSON.stringify(withShop.body?.shop)?.slice(0, 200)})`);

    const badges = ['tier', 'rating', 'trades', 'offerCategories'];
    const strangers: Array<[string, Id | null]> = [['unsigned', null], ['a key that is no member', nemo], ["a visitor's row", vic]];
    for (const [who, id] of strangers) {
        const r = await call('GET', id, `/api/treasury/${ent}`);
        // The badges and the keepers' categories by name. The enterprise's own text listings (`posts`) are the listings'
        // read, public where read auth is off, so their categories are not looked for here.
        const leaked = JSON.stringify(r.body ?? '').match(/"(tier|rating|trades|offerCategories)":/g);
        if (OPEN_READS) {
            assert(r.status === 200 && Array.isArray(r.body?.keepers) && r.body.keepers.length === 4 && !('offerCategories' in r.body)
                && r.body.keepers.every((k: any) => badges.every(f => !(f in k)) && typeof k.callsign === 'string' && typeof k.role === 'string') && !leaked,
                `read auth off, ${who} gets the page with the keepers' names and roles and none of their badges or categories (${r.status}${leaked ? `; leaked ${leaked.join(',')}` : ''})`);
            assert(JSON.stringify(Object.keys(r.body?.shop ?? {}).sort()) === JSON.stringify(['category', 'counts', 'id']) && r.body.shop.category === 'services',
                `and of its shop the category and counts only, as GET /api/shops/:id answers a visitor (${JSON.stringify(r.body?.shop)})`);
        } else {
            assert((r.status === 401 || r.status === 403) && !leaked && !Array.isArray(r.body?.keepers),
                `${who} is refused the detail and gets none of it (${show(r)})`);
        }
    }
    if (shopfront?.shopfrontOf) {
        const keepers = treasuryKeepers(ent);
        const forReader = (reader: string | undefined) => shopfront.shopfrontOf(ent, keepers, reader);
        const gated = [undefined, nemo.pk, vic.pk].map(forReader);
        assert(gated.every((s: any) => !('offerCategories' in s) && s.keepers.every((k: any) => badges.every(f => !(f in k)))),
            "the engine's gate: no reader but a member gets a badge or a category, whatever the read gate says");
        const forMax = forReader(max.pk);
        assert(JSON.stringify(forMax.offerCategories) === JSON.stringify(detail.body?.offerCategories)
            && forMax.keepers.find((k: any) => k.publicKey === rae.pk)?.trades === 1, "and a member's is the detail's");
    } else {
        assert(false, "the engine's gate: no shopfrontOf to ask");
    }
    // An Offer for one person, which Max can see, is still no category under the enterprise: a public listing's only.
    const maxSees = await call('GET', max, `/api/marketplace/posts?author=${rae.pk}`);
    assert(maxSees.status === 200 && (maxSees.body ?? []).some((p: any) => p.category === 'art') && !detail.body?.offerCategories?.includes('art'),
        'an Offer Max may see that was for him alone is no category on the page');

    // ── 5. Featured ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. Featured: six on the shelf ──');
    const maxShop: string = (await call('PUT', max, '/api/shops/mine', {})).body?.shop?.id ?? '';
    const lamp = await memberOffer(max, 'home', 'Lamp', { shopId: maxShop });
    const chair = await memberOffer(max, 'home', 'Chair');
    const needR = await call('POST', max, '/api/marketplace/posts', { type: 'need', category: 'home', title: 'A ladder', description: 'For a day.', credits: 0, authorPublicKey: max.pk, lat: MULLUM.lat, lng: MULLUM.lng });
    const ladderNeed: string = needR.body?.post?.id ?? '';
    const fLamp = await call('PUT', max, featurePath(lamp), { featured: true });
    assert(fLamp.status === 200 && typeof fLamp.body?.featuredAt === 'string' && featuredAtOf(lamp) === fLamp.body.featuredAt,
        `its author features an Offer in their shop (${show(fLamp)})`);
    const listed = await call('GET', kit, `/api/marketplace/posts?shop=${maxShop}`);
    const lampListed = (listed.body ?? []).find((p: any) => p.id === lamp);
    assert(lampListed?.featuredAt === featuredAtOf(lamp) && !('featuredAt' in guestPost(lampListed ?? {})),
        `a member's read of the listings carries the stamp; a visitor's copy never does (${JSON.stringify(lampListed?.featuredAt)})`);
    const notYours = await call('PUT', kit, featurePath(lamp), { featured: false });
    const madeUp = await call('PUT', kit, featurePath('no-such-listing'), { featured: true });
    const unsignedF = await call('PUT', null, featurePath(lamp), { featured: false });
    assert(sentence(notYours, 403, 'feature_not_yours') && madeUp.status === 403 && madeUp.text === notYours.text && unsignedF.status === 401
        && featuredAtOf(lamp) === fLamp.body?.featuredAt,
        `someone else's listing and one that isn't there get one answer, and nothing changes (${show(notYours)} | ${show(madeUp)})`);
    const fChair = await call('PUT', max, featurePath(chair), { featured: true });
    const fNeed = await call('PUT', max, featurePath(ladderNeed), { featured: true });
    const fFlag = await call('PUT', max, featurePath(lamp), { featured: 'yes' });
    assert(sentence(fChair, 400, 'feature_not_in_shop') && sentence(fNeed, 400, 'feature_offers_only') && sentence(fFlag, 400, 'feature_not_a_flag')
        && featuredAtOf(chair) === null && featuredAtOf(ladderNeed) === null,
        `refused in a sentence: an Offer in no shop, a Need, a flag that isn't one (${show(fChair)} | ${show(fNeed)} | ${show(fFlag)})`);
    const fEnded = await call('PUT', rae, featurePath(ended), { featured: true });
    assert(fEnded.status === 400 && featuredAtOf(ended) === null, `an ended Offer can't be featured (${show(fEnded)})`);

    // The enterprise's shelf: any keeper, six at most.
    const shelf: string[] = [];
    for (let i = 1; i <= 8; i++) shelf.push(await entOffer(lou, 'electronics', `Charger ${i}`, { shopId: entShop }));
    const six = [];
    for (const id of shelf.slice(0, 6)) six.push(await call('PUT', i6(id), featurePath(id), { featured: true }));
    function i6(id: string): Id { return shelf.indexOf(id) % 2 === 0 ? kit : rae; }
    const seventh = await call('PUT', kit, featurePath(shelf[6]), { featured: true });
    assert(six.every(r => r.status === 200) && sentence(seventh, 409, 'feature_shelf_full') && /six/i.test(seventh.body?.error ?? '') && featuredAtOf(shelf[6]) === null,
        `keepers feature six of the enterprise's Offers; the seventh is refused in a sentence (${six.map(r => r.status).join(',')}; ${show(seventh)})`);
    const byMax = await call('PUT', max, featurePath(shelf[7]), { featured: true });
    const byIda = await call('PUT', ida, featurePath(shelf[7]), { featured: true });
    assert(byMax.status === 403 && byIda.status === 403 && byMax.text === byIda.text && featuredAtOf(shelf[7]) === null,
        'a member who keeps nothing here and another enterprise\'s keeper can\'t feature one');
    const again = await call('PUT', kit, featurePath(shelf[0]), { featured: true });
    assert(again.status === 200 && again.body?.featuredAt === six[0].body?.featuredAt, 'featuring a featured one again changes nothing');
    const off = await call('PUT', rae, featurePath(shelf[0]), { featured: false });
    const nowFits = await call('PUT', kit, featurePath(shelf[6]), { featured: true });
    assert(off.status === 200 && off.body?.featuredAt === null && featuredAtOf(shelf[0]) === null && nowFits.status === 200,
        `un-featured the same way, which makes room (${show(off)} | ${show(nowFits)})`);
    // A paused one keeps its place: put back up, the shelf would hold seven. (An enterprise's listing is paused and ended
    // here through the engine: the member routes take the author from the signer.)
    const paused = attempt(() => pausePost(shelf[1], ent));
    const whilePaused = await call('PUT', kit, featurePath(shelf[7]), { featured: true });
    assert(paused === true && sentence(whilePaused, 409, 'feature_shelf_full') && featuredAtOf(shelf[1]) !== null,
        `a paused featured Offer keeps its place on the shelf (${show(whilePaused)})`);
    // Its keepers read its Offers as it would when they ask (`keeper=1`, engine readsAsAuthor), the paused one too, as the
    // console's Featured does to count the shelf and take one off; and while it is paused for the season, when everyone
    // else reads none. Anyone who keeps nothing here reads them as the board has them, asking or not (review of #2405,
    // utils/shop.ts readEnterpriseOffers). Its public page's read never asks (utils/shopfront.ts readOwnerListings): a
    // keeper reads there what every member does (PR #2405 review 4355985890).
    const offersRoute = `/api/marketplace/posts?author=${ent}&keeper=1&type=offer&limit=200`;
    const pageRoute = `/api/marketplace/posts?author=${ent}&limit=200`;
    const idsOf = (r: Res): string[] => (Array.isArray(r.body) ? r.body : []).map((p: any) => p.id);
    const kitReads = await call('GET', kit, offersRoute);
    const maxReads = await call('GET', max, offersRoute);
    const kitPage = await call('GET', kit, pageRoute);
    const maxPage = await call('GET', max, pageRoute);
    assert(kitPage.status === 200 && !idsOf(kitPage).includes(shelf[1]) && idsOf(kitPage).includes(shelf[0])
        && JSON.stringify(idsOf(kitPage)) === JSON.stringify(idsOf(maxPage)),
        `on its public page a keeper reads its listings as every member does: no paused Offer (${idsOf(kitPage).join(',')} | ${idsOf(maxPage).join(',')})`);
    const pausedRow = (Array.isArray(kitReads.body) ? kitReads.body : []).find((p: any) => p.id === shelf[1]);
    assert(kitReads.status === 200 && pausedRow?.status === 'paused' && typeof pausedRow?.featuredAt === 'string' && pausedRow.featuredAt === featuredAtOf(shelf[1])
        && maxReads.status === 200 && !idsOf(maxReads).includes(shelf[1]) && idsOf(maxReads).includes(shelf[0]),
        `a keeper reads its paused featured Offer, with its stamp; a member who keeps nothing here doesn't (${show(kitReads)} | ${show(maxReads)})`);
    const seasonPaused = attempt(() => pauseEnterprise(ent, lou.pk).paused);
    const kitInSeason = await call('GET', kit, offersRoute);
    const maxInSeason = await call('GET', max, offersRoute);
    const kitPageInSeason = await call('GET', kit, pageRoute);
    attempt(() => resumeEnterprise(ent, lou.pk));
    assert(seasonPaused === true && kitPageInSeason.status === 200 && idsOf(kitPageInSeason).length === 0,
        `paused for the season, its public page draws a keeper no listings, as it draws every member (${show(kitPageInSeason)})`);
    assert(seasonPaused === true && idsOf(kitInSeason).includes(shelf[0]) && idsOf(kitInSeason).includes(shelf[1])
        && maxInSeason.status === 200 && idsOf(maxInSeason).length === 0,
        `paused for the season, its keepers still read its Offers, and everyone else none (${idsOf(kitInSeason).length} | ${show(maxInSeason)})`);
    // Which view it is goes in the tag: a member bound as a keeper, or unbound, is never confirmed the copy they held.
    const ned = member('NedSentinel');
    const nedBefore = await call('GET', ned, offersRoute);
    adminAssignTreasuryOperator(ent, ned.pk, 'admin');
    const nedKeeps = await call('GET', ned, offersRoute, undefined, { 'If-None-Match': nedBefore.etag ?? '' });
    db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').run(ent, ned.pk);
    const nedLeft = await call('GET', ned, offersRoute, undefined, { 'If-None-Match': nedKeeps.etag ?? '' });
    assert(nedBefore.status === 200 && typeof nedBefore.etag === 'string' && !idsOf(nedBefore).includes(shelf[1])
        && nedKeeps.status === 200 && idsOf(nedKeeps).includes(shelf[1]) && nedLeft.status === 200 && !idsOf(nedLeft).includes(shelf[1]),
        `a member bound as a keeper, then unbound, reads the view that is theirs now, never a 304 of the other (${nedBefore.status}, ${nedKeeps.status}, ${nedLeft.status})`);
    attempt(() => resumePost(shelf[1], ent));
    const removed = attempt(() => removePost(shelf[2], ent));
    const afterEnd = await call('PUT', kit, featurePath(shelf[7]), { featured: true });
    assert(removed === true && afterEnd.status === 200, `an ended one leaves the shelf (${show(afterEnd)})`);
    const fRemoved = await call('PUT', kit, featurePath(shelf[2]), { featured: true });
    assert(sentence(fRemoved, 400, 'feature_ended'), `and can't be featured again, in a sentence (${show(fRemoved)})`);
    const liveFeatured = attempt(() => (db.prepare(`SELECT COUNT(*) AS n FROM posts WHERE shop_id = ? AND featured_at IS NOT NULL AND active = 1 AND status IN ('active', 'pending', 'paused')`).get(entShop) as { n: number }).n);
    assert(liveFeatured === 6, `never more than six that can be on it (${liveFeatured})`);

    const mutedOn = await call('PUT', mo, featurePath(shelf[0]), { featured: true });
    const mutedOff = await call('PUT', mo, featurePath(shelf[3]), { featured: false });
    assert(mutedOn.status === 403 && mutedOn.body?.code === 'moderation_muted' && mutedOff.status === 200 && featuredAtOf(shelf[3]) === null,
        `a muted keeper can't feature one, and can take one off (${show(mutedOn)} | ${show(mutedOff)})`);

    // An enterprise closed or wound up: Featured on its Offers follows its shop routes, by the same words and code; its
    // keeper's own Offer in their own shop is theirs, and someone who keeps nothing hears only that it isn't theirs.
    const otherShop = shopIdOf(other);
    setMemberPhoto(db, other, png(60, 90, 120));
    const otherOffer = async (title: string): Promise<string> => {
        const r = await call('POST', ida, `/api/treasury/${other}/offer`, { category: 'tools', title, credits: 0, lat: MULLUM.lat, lng: MULLUM.lng, shopId: otherShop });
        if (r.status !== 200 || !(r.body?.post?.id ?? r.body?.id)) throw new Error(`setup: Ida could not post ${title} for her enterprise: ${show(r)}`);
        return r.body?.post?.id ?? r.body?.id;
    };
    const plane = await otherOffer('Plane');
    const chisel = await otherOffer('Chisel');
    const idaShop: string = (await call('PUT', ida, '/api/shops/mine', {})).body?.shop?.id ?? '';
    const stool = await memberOffer(ida, 'home', 'Stool', { shopId: idaShop });
    const planeOn = await call('PUT', ida, featurePath(plane), { featured: true });
    if (planeOn.status !== 200) throw new Error(`setup: Ida could not feature Plane: ${show(planeOn)}`);
    const planeAt = featuredAtOf(plane);
    for (const status of ['suspended', 'completed']) {
        db.prepare('UPDATE members SET status = ? WHERE public_key = ?').run(status, other);
        const shopWrite = await call('PUT', ida, `/api/treasury/${other}/shop`, { blurb: 'Still here.' });
        const on = await call('PUT', ida, featurePath(chisel), { featured: true });
        const offR = await call('PUT', ida, featurePath(plane), { featured: false });
        const notTheirs = await call('PUT', max, featurePath(chisel), { featured: true });
        const ownOn = await call('PUT', ida, featurePath(stool), { featured: true });
        const ownOff = await call('PUT', ida, featurePath(stool), { featured: false });
        assert(sentence(shopWrite, 403, 'enterprise_closed') && sentence(on, 403, 'enterprise_closed') && sentence(offR, 403, 'enterprise_closed')
            && on.body.error === shopWrite.body.error && offR.body.error === shopWrite.body.error
            && featuredAtOf(chisel) === null && featuredAtOf(plane) === planeAt,
            `${status}: its keeper can't feature or un-feature its Offers, as its shop routes say, and nothing changes (${show(on)} | ${show(offR)} | ${show(shopWrite)})`);
        assert(sentence(notTheirs, 403, 'feature_not_yours') && notTheirs.text === notYours.text && ownOn.status === 200 && ownOff.status === 200,
            `${status}: someone who keeps nothing hears only that it isn't theirs, and its keeper's own Offer is theirs to feature (${show(notTheirs)} | ${show(ownOn)})`);
    }
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(other);
    const reopened = await call('PUT', ida, featurePath(plane), { featured: false });
    assert(reopened.status === 200 && featuredAtOf(plane) === null, `open again, its keeper can (${show(reopened)})`);

    const outOfShop = await call('POST', max, '/api/marketplace/posts/update', { id: lamp, authorPublicKey: max.pk, shopId: null });
    assert(outOfShop.status === 200 && featuredAtOf(lamp) === null, 'taken out of its shop, it is featured no more');
    await call('POST', max, '/api/marketplace/posts/update', { id: lamp, authorPublicKey: max.pk, shopId: maxShop });
    assert(featuredAtOf(lamp) === null, 'and put back, it is not featured until someone says so');
    await call('PUT', max, featurePath(lamp), { featured: true });
    const closedShop = await call('POST', max, '/api/shops/mine/close', {});
    assert(closedShop.status === 200 && featuredAtOf(lamp) === null, `a shop closed takes every stamp in it (${show(closedShop)})`);
    const zed = member('ZedSentinel');
    const zedShop: string = (await call('PUT', zed, '/api/shops/mine', {})).body?.shop?.id ?? '';
    const vase = await memberOffer(zed, 'home', 'Vase', { shopId: zedShop });
    const zedFeatured = (await call('PUT', zed, featurePath(vase), { featured: true })).body?.featuredAt ?? null;
    attempt(() => purgeMemberSelf(zed.pk));
    assert(typeof zedFeatured === 'string' && featuredAtOf(vase) === null, 'an account closed takes its shop, and every stamp in it');

    // ── 6. a standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a standby ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4291/p2p/${nodeId}`);
    const whole: any = await exportSyncState(nodeId);
    const stamped = attempt(() => db.prepare('SELECT id, featured_at FROM posts WHERE featured_at IS NOT NULL ORDER BY id').all() as { id: string; featured_at: string }[]) ?? [];
    const exportedStamps = (whole.posts ?? []).filter((p: any) => p.featuredAt).map((p: any) => ({ id: p.id, featured_at: p.featuredAt }))
        .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    assert(stamped.length >= 5 && JSON.stringify(exportedStamps) === JSON.stringify(stamped), `a whole copy carries each listing's stamp (${exportedStamps.length} of ${stamped.length})`);
    // A rename moves no stamp on the chat and a delta picks conversations by when they began, so its new name travels in
    // a whole copy, as a group's chat's does (engine/replication-manifest.ts conversations.name, G1b).
    const wholeChat = (whole.conversations ?? []).find((c: any) => c.id === ent);
    assert(wholeChat?.name === faceOf(ent).callsign, `a whole copy carries its chat under its new name (${wholeChat?.name} / ${faceOf(ent).callsign})`);

    const since = new Date().toISOString();
    await new Promise(r => setTimeout(r, 5));
    const finalLogo = png(5, 150, 60);
    await call('PUT', lou, profilePath(ent), { name: 'Lou Standby Sentinel', purpose: 'Mended on a standby too.', about: 'The standby says this.', avatar: finalLogo });
    await call('PUT', kit, featurePath(shelf[4]), { featured: false });
    const putOn = await call('PUT', rae, featurePath(shelf[0]), { featured: true });
    const mainFace = faceOf(ent);
    const delta: any = await exportSyncState(nodeId, since);
    // The standby as it was: the old face and the stamp still on, each at an old stamp, so the copy's rows are the newer.
    db.prepare("UPDATE members SET callsign = 'Lou Mended Sentinel', purpose = 'old', bio = 'old', updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?").run(ent);
    setMemberPhoto(db, ent, png(10, 20, 30));
    db.prepare("UPDATE members SET updated_at = '2000-01-01T00:00:00.000Z' WHERE public_key = ?").run(ent);
    attempt(() => db.prepare("UPDATE posts SET featured_at = '2001-01-01T00:00:00.000Z', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(shelf[4]));
    attempt(() => db.prepare("UPDATE posts SET featured_at = NULL, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(shelf[0]));
    const copy = await signSyncPayload((({ signature: _s, publicKey: _k, ...rest }) => rest)(delta));
    setNodeRole('backup');
    let importError = '';
    try { await importRemoteState(copy); } catch (e: any) { importError = e?.message || String(e); }
    const sShop = await call('GET', max, `/api/shops/${entShop}`);
    setNodeRole('primary');
    const standbyFace = faceOf(ent);
    assert(importError === '' && standbyFace.callsign === 'Lou Standby Sentinel' && standbyFace.purpose === 'Mended on a standby too.'
        && standbyFace.bio === 'The standby says this.' && standbyFace.photo === mainFace.photo && standbyFace.profile_updated_at === mainFace.profile_updated_at,
        `a delta carries the new name, purpose, About, logo and stamp (${importError || JSON.stringify({ ...standbyFace, photo: standbyFace.photo?.slice(0, 30) })})`);
    assert(featuredAtOf(shelf[4]) === null && putOn.status === 200 && featuredAtOf(shelf[0]) === putOn.body?.featuredAt,
        `and a stamp taken off, and one put on (${show(putOn)})`);
    assert(sShop.status === 200 && sShop.body?.name === 'Lou Standby Sentinel', `the standby's copy of the shop says the new name (${show(sShop)})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exit(1);
    console.log("⭐️ An enterprise's face is its keepers' to dress, its name its lead's; its shelf holds six; members see who keeps it.");
    process.exit(0);
}

main().catch((e) => {
    console.error('✗ the suite stopped:', e);
    process.exit(1);
});
