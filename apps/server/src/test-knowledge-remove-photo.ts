/**
 * Take one picture off a page of Local knowledge (DESIGN-learn-web-pictures-fable.md §9 slice 3; Marty, 22 Nov 2026, "All six
 * of Fable's picks", Question 1 (d)): an owner's or admin's Edit sends the pictures it keeps, each as the page gave it, and the
 * rest come off for everyone, through the listing's own photo change (engine/posts.ts writePostPhotoRows). Through the real
 * HTTPS stack and its signature middleware, with real Ed25519 identities. Nothing leaves this machine.
 *
 * The design's table, one row a case, each on a page made fresh with pictures 1, 2, 3 (three different images) and the node's
 * credits on 1 and 3 (publishKnowledge's `credits`, as Approve gives them):
 *
 *  1. Nothing said (an old app, a 1.4.7 phone): 1 2 3, 📷 1 and 📷 3; nothing deleted, no address moves.
 *  2. Keeps 1 2 3: the same.
 *  3. Keeps 1 3: 1 3, 📷 1 and 📷 2 (picture 3's credit follows it); picture 2's address answers 404 at once, its stored copy goes.
 *  4. Keeps 2 3: 2 3, 📷 2; picture 1's stored copy is deleted after the change, unless another row still names it.
 *  5. Keeps 2: 2, no credit.
 *  6. Keeps none: no picture (the apps show the topic's), no credit.
 *  7. A member, a moderator: refused, nothing changes.
 *  8. A new picture in an Edit (a data URL, another page's photo, not a list): refused in words, nothing changes.
 *  9. Two admins: the second saves a list made before the first's removal: 409 "This page's photos changed. Open it again.",
 *     nothing removed; the second's Edit with no list still saves its words.
 * 10. A page that isn't showing: 404 "isn't showing any more".
 * 11. The standby: a copy after the change carries the kept pictures, the renumbered credits and a tombstone for each slot
 *     emptied, so a standby holds the same, and a promoted one too; a standby refuses the Edit.
 * 12. A member's page with its own photos: the same rules, no credits.
 * 13. A 1.4.7 phone's Edit: every source row back as label and link, credit rows included, and no picture list: pictures and
 *     credits as they were, once each, in their order.
 * 13b. Two admins, one on a 1.4.7 phone whose Edit was opened before the other took picture 1 (or 3) off: after the phone's
 *     save no row of the removed picture's credit is anywhere on the page, and every "📷 n" left is a credit row naming its
 *     own picture (review of #3353). An admin's own source to a Commons file page, in their own words, stays.
 * 13c. Every other way sources come in, each from a form opened before picture 1 came off (or sending its credit shape): a
 *     member's fix and its approval, Approve with changes on a fix, an owner's own page, a member's new suggestion and Approve
 *     with changes on it, an assistant's draft. None writes the credit's shape as a source; a member's own source to a Commons
 *     file page stays.
 * 14. Where the line is (engine/knowledge.ts creditShaped): every label the node writes (each open licence, a maker, none, one
 *     cut short) on every Commons file page it writes is dropped, a hidden character in its head included; a Commons file page
 *     in a person's own words, a camera with no number, and a "📷 n ·" label on any other address stay.
 *
 * Run: SERVER_SUITES_ONLY=test-knowledge-remove-photo TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import sharp from 'sharp';
import { knowledgeCreditLabel, type KnowledgePhotoCredit } from '@beanpool/core';
import { ensureGenesis } from './genesis.js';
import { initTls } from './services/tls.js';
import { initStateEngine, broadcast, exportSyncState } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { registerMemberInternal } from './engine/members.js';
import { grantNodeRole } from './engine/node-roles.js';
import { claimGrantor } from './claim-code.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { cleanKnowledgeInput, publishKnowledge } from './engine/knowledge.js';
import { KNOWLEDGE_ABOUT, checkAssistantKnowledgeDraft } from './engine/knowledge-drafts.js';
import { COMMONS_OPEN_LICENCES, commonsFilePage } from './agent/commons-pictures.js';
import { getImageStore } from './storage/image-store.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = { ...headers };
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');

const WORDS = {
    title: 'The lookout over the bay',
    body: 'Park at the top gate.\nThe track is steep after rain.',
    topic: 'good-to-know',
    place: 'The headland',
    sources: [{ url: 'https://parks.example/headland', label: 'Parks: the headland' }],
    lang: 'en',
};
const credit = (file: string, maker: string, licence: string): KnowledgePhotoCredit => ({
    url: `https://commons.wikimedia.org/wiki/File:${file}`,
    file: `File:${file}`,
    maker,
    licence,
    licenceUrl: licence === 'CC BY 4.0' ? 'https://creativecommons.org/licenses/by/4.0/' : 'https://creativecommons.org/licenses/by-sa/4.0/',
    restrictions: [],
    readAt: '2026-11-22T00:00:00.000Z',
});
const C1 = credit('Lookout_one.jpg', 'Ana Maker', 'CC BY 4.0');
const C3 = credit('Lookout_three.jpg', 'Cy Maker', 'CC BY-SA 4.0');

interface PhotoRow { order_num: number; updated_at: string; storage_key: string | null; sha256: string | null; photo_data: string | null }
const photoRows = (id: string) => db.prepare('SELECT order_num, updated_at, storage_key, sha256, photo_data FROM post_photos WHERE post_id = ? ORDER BY order_num').all(id) as PhotoRow[];
const bytesOf = (r: PhotoRow) => r.sha256 ?? r.photo_data ?? '';
const storedRow = (id: string) => db.prepare('SELECT knowledge_sources, title, author_pubkey, active FROM posts WHERE id = ?').get(id) as { knowledge_sources: string | null; title: string; author_pubkey: string; active: number };
/** The page's credit rows as stored: [picture number, Commons file, label]. */
const creditsOf = (id: string): [number, string, string][] =>
    (JSON.parse(storedRow(id).knowledge_sources ?? '[]') as any[]).filter((s) => s.photo !== undefined).map((s) => [s.photo, s.credit?.file, s.label]);
const ownOf = (id: string) => (JSON.parse(storedRow(id).knowledge_sources ?? '[]') as any[]).filter((s) => s.photo === undefined).map((s) => s.url);
const tombstonesOf = (id: string) => (db.prepare(`SELECT row_key FROM tombstones WHERE table_name = 'post_photos' AND row_key LIKE ? ORDER BY row_key`).all(`${id}|%`) as { row_key: string }[]).map((r) => r.row_key);
const label = (n: number, c: KnowledgePhotoCredit) => `📷 ${n} · ${c.maker} · ${c.licence}`;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function picture(r: number, g: number, b: number): Promise<string> {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
}

async function main(): Promise<void> {
    await ensureGenesis();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    const owen = newId('Owen');
    const claim = claimGrantor(crypto.randomBytes(4).toString('hex'));
    require_(!!registerMemberInternal(broadcast, owen.pk, owen.name, null, claim), 'Owen claims the community: its first member');
    grantNodeRole(owen.pk, 'owner', claim);
    const OWNER = () => ownerPhoneSessionHeaders(owen.pk);
    const [ada, mod, mel] = ['Ada', 'Mod', 'Mel'].map(newId);
    for (const who of [ada, mod, mel]) {
        const made = await call(owen, 'POST', '/api/invite/generate', { publicKey: owen.pk });
        const joined = await call(who, 'POST', '/api/invite/redeem', { code: made.body?.invite?.code, publicKey: who.pk, callsign: who.name });
        require_(made.status === 200 && joined.status === 200, `${who.name} joins with Owen's invite`);
    }
    for (const [who, role] of [[ada, 'admin'], [mod, 'moderator']] as const) {
        require_((await call(null, 'POST', '/api/local/admin/node-roles', { pubkey: who.pk, role }, OWNER())).status === 200, `${who.name} is made ${role}`);
    }
    for (const who of [owen, ada, mod, mel]) db.prepare("UPDATE members SET avatar_ref = 'bundled://fox' WHERE public_key = ?").run(who.pk);

    const P1 = await picture(200, 30, 30);
    const P2 = await picture(30, 200, 30);
    const P3 = await picture(30, 30, 200);

    /** A page fresh from the node: pictures 1, 2, 3 and the node's credits on 1 and 3, as Approve makes one. */
    const freshPage = () => {
        const post = publishKnowledge(broadcast, owen.pk, { ...WORDS, photos: [P1, P2, P3] }, { credits: [{ photo: 1, credit: C1 }, { photo: 3, credit: C3 }] });
        const rows = photoRows(post.id);
        require_(rows.length === 3 && new Set(rows.map(bytesOf)).size === 3, 'a fresh page holds three different pictures');
        return { id: post.id, rows, bytes: rows.map(bytesOf) };
    };
    /** The page as the web reads it (lib/learn.ts getLearnPost): its photo addresses are what the Edit form is given. */
    const readPage = async (id: string, as: Id = owen) => {
        const r = await call(as, 'GET', `/api/marketplace/posts?type=knowledge&id=${encodeURIComponent(id)}`);
        return (Array.isArray(r.body) ? r.body : []).find((p: any) => p?.id === id) ?? null;
    };
    const edit = (as: Id, id: string, extra: Record<string, unknown> = {}) => call(as, 'POST', `/api/knowledge/posts/${id}/edit`, { ...WORDS, ...extra });
    const relative = (u: string) => u.replace(/^https?:\/\/[^/]+/, '');
    const objectThere = (key: string | null) => !!key && getImageStore().head(key) !== null;
    /** The pictures a page holds now, each named 1, 2 or 3 by its bytes as the fresh page held them. */
    const picturesOf = (id: string, bytes: string[]) => photoRows(id).map((r) => bytes.indexOf(bytesOf(r)) + 1);

    // ── 1. Nothing said (an old app) ──────────────────────────────────────────────────────────
    console.log('── 1. an Edit that sends no picture list ──');
    {
        const p = freshPage();
        const r = await edit(owen, p.id, { title: 'The lookout, words only' });
        const rows = photoRows(p.id);
        assert(r.status === 200 && storedRow(p.id).title === 'The lookout, words only', `1. the words save (${show(r)})`);
        assert(same(picturesOf(p.id, p.bytes), [1, 2, 3]), `1. pictures 1 2 3 (${picturesOf(p.id, p.bytes)})`);
        assert(same(creditsOf(p.id).map(([n, f]) => [n, f]), [[1, C1.file], [3, C3.file]]), `1. credits 📷 1 and 📷 3 (${JSON.stringify(creditsOf(p.id))})`);
        assert(same(rows.map((x) => x.updated_at), p.rows.map((x) => x.updated_at)) && tombstonesOf(p.id).length === 0 && p.rows.every((x) => objectThere(x.storage_key)),
            '1. nothing deleted: no tombstone, every stored copy there, no address moved');
    }

    // ── 2. Keeps 1 2 3 ────────────────────────────────────────────────────────────────────────
    console.log('── 2. an Edit that keeps every picture ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        require_(page?.photos?.length === 3, 'the page reads with three photo addresses');
        const r = await edit(owen, p.id, { photos: page.photos });
        assert(r.status === 200 && same(picturesOf(p.id, p.bytes), [1, 2, 3]), `2. pictures 1 2 3 (${show(r)})`);
        assert(same(creditsOf(p.id).map(([n, f]) => [n, f]), [[1, C1.file], [3, C3.file]]), '2. credits 📷 1 and 📷 3');
        assert(same(photoRows(p.id).map((x) => x.updated_at), p.rows.map((x) => x.updated_at)) && tombstonesOf(p.id).length === 0 && p.rows.every((x) => objectThere(x.storage_key)),
            '2. nothing deleted, no address moved');
        const relativeKept = await edit(ada, p.id, { photos: page.photos.map(relative) });
        assert(relativeKept.status === 200 && same(picturesOf(p.id, p.bytes), [1, 2, 3]), `2. an admin's list of the same addresses without the node in front: kept (${show(relativeKept)})`);
    }

    // ── 3. Keeps 1 3 ──────────────────────────────────────────────────────────────────────────
    console.log('── 3. keeps 1 3 ──');
    let row3: { id: string; before: number; addressOf2: string } | null = null;
    {
        const p = freshPage();
        const page = await readPage(p.id);
        const before = Date.now() - 1;
        const opened2 = await call(mel, 'GET', relative(page.photos[1]));
        require_(opened2.status === 200, `a member opens picture 2 before (${opened2.status})`);
        const r = await edit(owen, p.id, { photos: [page.photos[0], page.photos[2]] });
        assert(r.status === 200 && same(picturesOf(p.id, p.bytes), [1, 3]), `3. pictures 1 3 (${show(r)} → ${picturesOf(p.id, p.bytes)})`);
        assert(same(creditsOf(p.id), [[1, C1.file, label(1, C1)], [2, C3.file, label(2, C3)]]), `3. credits 📷 1 = picture 1's, 📷 2 = picture 3's, renumbered (${JSON.stringify(creditsOf(p.id))})`);
        assert(same(ownOf(p.id), ['https://parks.example/headland']), '3. the page\'s own source stays, before the credits');
        const gone = await call(mel, 'GET', relative(page.photos[1]));
        assert(gone.status === 404, `3. picture 2's address answers 404 at once (${gone.status})`);
        assert(!objectThere(p.rows[1].storage_key) && objectThere(p.rows[0].storage_key) && objectThere(p.rows[2].storage_key),
            "3. picture 2's stored copy is deleted after the change; 1's and 3's stay");
        assert(same(tombstonesOf(p.id), [`${p.id}|2`]), `3. the emptied slot is a tombstone, for a standby (${tombstonesOf(p.id)})`);
        const reread = await readPage(p.id, mel);
        assert(reread?.photos?.length === 2 && same(reread.knowledge.sources.filter((s: any) => s.photo !== undefined).map((s: any) => [s.photo, s.label]), [[1, label(1, C1)], [2, label(2, C3)]]),
            `3. a member reads two pictures and the two credit lines (${JSON.stringify(reread?.knowledge?.sources)})`);
        const answer = r.body?.post;
        assert(answer?.photos?.length === 2 && answer.photos.every((u: string) => !page.photos.includes(u)), '3. the answer carries the page as it now is, every address new');
        row3 = { id: p.id, before, addressOf2: page.photos[1] };
    }
    {
        // The same on a page whose stored rows name no sha256 (an object stored before its row kept one): each is its own picture.
        const p = freshPage();
        db.prepare('UPDATE post_photos SET sha256 = NULL WHERE post_id = ?').run(p.id);
        const page = await readPage(p.id);
        const r = await edit(owen, p.id, { photos: [page.photos[0], page.photos[2]] });
        assert(r.status === 200 && same(creditsOf(p.id).map(([n, f]) => [n, f]), [[1, C1.file], [2, C3.file]]),
            `3. rows with no sha256: 📷 1 = picture 1's, 📷 2 = picture 3's, never one picture's credit on another (${JSON.stringify(creditsOf(p.id))})`);
    }

    // ── 4. Keeps 2 3 ──────────────────────────────────────────────────────────────────────────
    console.log('── 4. keeps 2 3 ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        const r = await edit(ada, p.id, { photos: [page.photos[1], page.photos[2]] });
        assert(r.status === 200 && same(picturesOf(p.id, p.bytes), [2, 3]), `4. an admin: pictures 2 3 (${show(r)})`);
        assert(same(creditsOf(p.id), [[2, C3.file, label(2, C3)]]), `4. credits 📷 2 = picture 3's (${JSON.stringify(creditsOf(p.id))})`);
        assert(!objectThere(p.rows[0].storage_key), "4. picture 1's stored copy is deleted after the change");
        // Unless another row still names it (storage/image-columns.ts deleteStoredObjects): a row of another post planted on it.
        const q = freshPage();
        const qPage = await readPage(q.id);
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime) VALUES ('planted-other-post', NULL, 0, ?, ?, ?, 1, 'image/png')`)
            .run(new Date().toISOString(), q.rows[0].storage_key, q.rows[0].sha256);
        const r2 = await edit(owen, q.id, { photos: [qPage.photos[1], qPage.photos[2]] });
        assert(r2.status === 200 && same(picturesOf(q.id, q.bytes), [2, 3]) && objectThere(q.rows[0].storage_key),
            "4. a stored copy another row still names stays when its picture comes off this page");
        db.prepare("DELETE FROM post_photos WHERE post_id = 'planted-other-post'").run();
    }

    // ── 5. Keeps 2 ────────────────────────────────────────────────────────────────────────────
    console.log('── 5. keeps 2 ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        const r = await edit(owen, p.id, { photos: [page.photos[1]] });
        assert(r.status === 200 && same(picturesOf(p.id, p.bytes), [2]) && creditsOf(p.id).length === 0, `5. picture 2 alone, no credit (${show(r)} ${JSON.stringify(creditsOf(p.id))})`);
        assert(same(tombstonesOf(p.id), [`${p.id}|1`, `${p.id}|2`]), '5. both emptied slots are tombstones');
    }

    // ── 6. Keeps none ─────────────────────────────────────────────────────────────────────────
    console.log('── 6. keeps none ──');
    {
        const p = freshPage();
        const r = await edit(owen, p.id, { photos: [] });
        const reread = await readPage(p.id, mel);
        assert(r.status === 200 && photoRows(p.id).length === 0 && creditsOf(p.id).length === 0, `6. no picture, no credit (${show(r)})`);
        assert(reread && (reread.photos ?? []).length === 0 && same(reread.knowledge.sources.map((s: any) => s.url), ['https://parks.example/headland']),
            '6. the page reads with no photo (the apps draw its topic\'s picture) and its own source only');
        assert(p.rows.every((x) => !objectThere(x.storage_key)), '6. every stored copy is deleted');
    }

    // ── 7. A member, a moderator ──────────────────────────────────────────────────────────────
    console.log('── 7. who may ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        for (const who of [mel, mod]) {
            const r = await edit(who, p.id, { photos: [page.photos[0]] });
            assert(r.status === 403 && r.body?.code === 'admins_only' && same(picturesOf(p.id, p.bytes), [1, 2, 3]) && creditsOf(p.id).length === 2 && tombstonesOf(p.id).length === 0,
                `7. ${who.name}: 403, nothing changes (${show(r)})`);
        }
        const unsigned = await call(null, 'POST', `/api/knowledge/posts/${p.id}/edit`, { ...WORDS, photos: [] });
        assert(unsigned.status === 401 && photoRows(p.id).length === 3, `7. unsigned: 401, nothing changes (${unsigned.status})`);
    }

    // ── 8. A new picture sent in an Edit ──────────────────────────────────────────────────────
    console.log('── 8. a new picture ──');
    {
        const p = freshPage();
        const other = freshPage();
        const page = await readPage(p.id);
        const otherPage = await readPage(other.id);
        const cases: Array<[string, unknown, number, string]> = [
            ['a picture as a data URL', [page.photos[0], P2], 400, 'new_photo'],
            ['only a new picture', [P1], 400, 'new_photo'],
            ["another page's photo", [page.photos[0], otherPage.photos[1]], 400, 'new_photo'],
            ['an address off any photo', ['https://elsewhere.example/a.jpg'], 400, 'new_photo'],
            ['a number', [1, 3], 400, 'bad_photos'],
            ['not a list', page.photos[0], 400, 'bad_photos'],
        ];
        for (const [what, photos, status, code] of cases) {
            const r = await edit(owen, p.id, { title: 'Swapped', photos });
            assert(r.status === status && r.body?.code === code && /never add one/.test(r.body?.error ?? '') && storedRow(p.id).title === WORDS.title
                && same(picturesOf(p.id, p.bytes), [1, 2, 3]) && creditsOf(p.id).length === 2,
                `8. ${what}: ${status} ${code}, in words, nothing changes (${show(r)})`);
        }
    }

    // ── 9. Two admins ─────────────────────────────────────────────────────────────────────────
    console.log('── 9. two admins ──');
    {
        const p = freshPage();
        const adaOpened = await readPage(p.id, ada);
        const owenOpened = await readPage(p.id, owen);
        const first = await edit(owen, p.id, { photos: [owenOpened.photos[0], owenOpened.photos[2]] });
        require_(first.status === 200 && same(picturesOf(p.id, p.bytes), [1, 3]), 'Owen takes picture 2 off');
        const afterFirst = { pictures: picturesOf(p.id, p.bytes), credits: creditsOf(p.id), rows: photoRows(p.id) };
        for (const [what, list] of [
            ['Ada takes picture 3 off a form opened before', [adaOpened.photos[0], adaOpened.photos[1]]],
            ['Ada keeps the same two Owen kept, from a form opened before', [adaOpened.photos[0], adaOpened.photos[2]]],
            ['Ada keeps picture 1 alone, from a form opened before', [adaOpened.photos[0]]],
        ] as const) {
            const r = await edit(ada, p.id, { photos: list });
            assert(r.status === 409 && r.body?.code === 'photos_changed' && r.body?.error === 'This page’s photos changed. Open it again.',
                `9. ${what}: 409 "This page's photos changed. Open it again." (${show(r)})`);
            assert(same(picturesOf(p.id, p.bytes), afterFirst.pictures) && same(creditsOf(p.id), afterFirst.credits)
                && same(photoRows(p.id).map((x) => x.updated_at), afterFirst.rows.map((x) => x.updated_at)) && storedRow(p.id).title === WORDS.title,
                '9. and nothing removed, nothing else changed');
        }
        const wordsOnly = await edit(ada, p.id, { title: 'Ada\'s words, no list' });
        assert(wordsOnly.status === 200 && storedRow(p.id).title === 'Ada\'s words, no list' && same(picturesOf(p.id, p.bytes), [1, 3]),
            `9. Ada's Edit with no list saves its words and leaves Owen's pictures (${show(wordsOnly)})`);
        const reopened = await readPage(p.id, ada);
        const second = await edit(ada, p.id, { photos: [reopened.photos[0]] });
        assert(second.status === 200 && same(picturesOf(p.id, p.bytes), [1]) && same(creditsOf(p.id), [[1, C1.file, label(1, C1)]]),
            `9. opened again, Ada's list is taken: picture 1, 📷 1 (${show(second)})`);
    }

    // ── 10. A page that isn't showing ─────────────────────────────────────────────────────────
    console.log('── 10. a page that isn\'t showing ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        require_((await call(owen, 'POST', `/api/knowledge/posts/${p.id}/take-down`, { reasonCategory: 'misleading' })).status === 200, 'Owen takes the page down');
        const r = await edit(ada, p.id, { photos: [page.photos[0]] });
        assert(r.status === 404 && r.body?.code === 'not_found' && /isn’t showing any more/.test(r.body?.error ?? ''), `10. 404, "isn't showing any more" (${show(r)})`);
    }

    // ── 11. The standby ───────────────────────────────────────────────────────────────────────
    console.log('── 11. the standby ──');
    {
        require_(!!row3, 'row 3 ran');
        const { id, before, addressOf2 } = row3!;
        const delta = await exportSyncState('test-knowledge-remove-photo', new Date(before).toISOString()) as any;
        const post = (delta.posts as any[] | undefined)?.find((x) => x.id === id);
        const deltaCredits = (JSON.parse(post?.knowledgeColumns?.sources ?? '[]') as any[]).filter((s) => s.photo !== undefined).map((s) => [s.photo, s.credit?.file]);
        assert(!!post && same(deltaCredits, [[1, C1.file], [2, C3.file]]), `11. the next copy carries the page with its credits renumbered (${JSON.stringify(deltaCredits)})`);
        const deltaPhotos = ((delta.photos as any[] | undefined) ?? []).filter((x) => x.post_id === id).map((x) => x.order_num).sort();
        const deltaTombs = ((delta.tombstones as any[] | undefined) ?? []).filter((x) => x.tableName === 'post_photos' && x.rowKey.startsWith(`${id}|`)).map((x) => x.rowKey);
        assert(same(deltaPhotos, [0, 1]) && same(deltaTombs, [`${id}|2`]),
            `11. and the two kept pictures in their new slots, and slot 2 as a tombstone, so a standby holds the same (${JSON.stringify({ deltaPhotos, deltaTombs })})`);
        const whole = await exportSyncState('test-knowledge-remove-photo') as any;
        const wholePhotos = ((whole.photos as any[] | undefined) ?? []).filter((x) => x.post_id === id);
        assert(wholePhotos.length === 2 && !wholePhotos.some((x) => x.order_num === 2), '11. a whole copy (what a take-over promotes) holds the two kept pictures only');
        const page = await readPage(id);
        setNodeRole('backup');
        const onStandby = await edit(owen, id, { photos: [page.photos[0]] });
        setNodeRole('primary');
        assert(onStandby.status === 503 && onStandby.body?.code === 'standby' && photoRows(id).length === 2, `11. a standby refuses the Edit, 503, nothing removed (${show(onStandby)})`);
        assert(typeof addressOf2 === 'string', '11. (picture 2\'s old address was read)');
    }

    // ── 12. A member's page with its own photos ───────────────────────────────────────────────
    console.log('── 12. a member\'s page ──');
    {
        const post = publishKnowledge(broadcast, owen.pk, { ...WORDS, title: 'Mel\'s swimming hole', photos: [P1, P2] }, { writer: mel.pk });
        const bytes = photoRows(post.id).map(bytesOf);
        const page = await readPage(post.id);
        const memberTries = await edit(mel, post.id, { photos: [page.photos[1]] });
        assert(memberTries.status === 403 && photoRows(post.id).length === 2, `12. Mel, its writer and a member: 403 (${show(memberTries)})`);
        const r = await edit(owen, post.id, { title: 'Mel\'s swimming hole', photos: [page.photos[1]] });
        assert(r.status === 200 && same(picturesOf(post.id, bytes), [2]) && creditsOf(post.id).length === 0 && storedRow(post.id).author_pubkey === mel.pk,
            `12. Owen keeps Mel's second photo: picture 2, no credit, Mel still its writer (${show(r)})`);
    }

    // ── 13. A 1.4.7 phone's Edit ──────────────────────────────────────────────────────────────
    console.log('── 13. a 1.4.7 phone ──');
    {
        const p = freshPage();
        const page = await readPage(p.id);
        // As android-v1.4.7's components/learn/learn-keep.ts editBody sends it: every source row the page drew, credit rows
        // included, as trimmed label and link (learn-write.ts knowledgeFormBody), no photos, no lang.
        const rows = (page.knowledge.sources as any[]).map((s) => ({ url: String(s.url).trim(), label: String(s.label ?? '').trim() }));
        require_(rows.length === 3, 'the phone draws three rows: one own, two credits');
        const phoneBody = { title: 'The lookout, from the phone', body: WORDS.body, topic: WORDS.topic, place: WORDS.place, sources: rows, freeTags: [] };
        const r = await call(owen, 'POST', `/api/knowledge/posts/${p.id}/edit`, phoneBody);
        assert(r.status === 200 && storedRow(p.id).title === 'The lookout, from the phone', `13. accepted (${show(r)})`);
        assert(same(picturesOf(p.id, p.bytes), [1, 2, 3]) && same(photoRows(p.id).map((x) => x.updated_at), p.rows.map((x) => x.updated_at)),
            '13. pictures 1 2 3, in their order, no address moved');
        assert(same(creditsOf(p.id), [[1, C1.file, label(1, C1)], [3, C3.file, label(3, C3)]]) && same(ownOf(p.id), ['https://parks.example/headland']),
            `13. credits 📷 1 and 📷 3 once each, the own source once (${storedRow(p.id).knowledge_sources})`);
    }

    // As android-v1.4.7 sends a page's rows back (row 13): every row it drew, credit rows included, as trimmed label and link.
    const phoneRowsOf = (page: any): { url: string; label: string }[] => (page.knowledge.sources as any[]).map((s) => ({ url: String(s.url).trim(), label: String(s.label ?? '').trim() }));
    const storedList = (id: string): any[] => JSON.parse(storedRow(id).knowledge_sources ?? '[]');
    /** Every "📷" row the page reads is a credit row (it carries `photo`) whose label names that same number. */
    const cameraRowsAreCredits = async (id: string) => {
        const reread = await readPage(id, mel);
        const camera = ((reread?.knowledge?.sources ?? []) as any[]).filter((s) => String(s.label ?? '').trim().startsWith('📷'));
        return { ok: camera.every((s) => Number.isInteger(s.photo) && String(s.label).startsWith(`📷 ${s.photo} · `)), labels: camera.map((s) => `${s.photo ?? '-'}:${s.label}`) };
    };
    const PARKS = WORDS.sources[0].url;
    /** A person's own source to a file page on Commons, in their own words: never a credit, always kept. */
    const MAP_SOURCE = { url: 'https://commons.wikimedia.org/wiki/File:Headland_map.png', label: 'Map of the headland, Wikimedia Commons' };

    // ── 13b. A 1.4.7 phone's Edit opened before another admin takes a picture off (review of #3353) ─────────────────
    console.log('── 13b. a 1.4.7 phone opened before a picture came off ──');
    for (const [taken, keep, takenCredit, wantCredits] of [
        [1, [1, 2], C1, [[2, C3.file, label(2, C3)]]],
        [3, [0, 1], C3, [[1, C1.file, label(1, C1)]]],
    ] as const) {
        const p = freshPage();
        const adaOpened = await readPage(p.id, ada);
        const stale = phoneRowsOf(adaOpened);
        require_(stale.length === 3 && stale.some((s) => s.url === takenCredit.url), "Ada's phone draws one own row and two credit rows");
        const owenOpened = await readPage(p.id, owen);
        const off = await edit(owen, p.id, { photos: keep.map((i) => owenOpened.photos[i]) });
        require_(off.status === 200 && !storedList(p.id).some((s) => s.url === takenCredit.url), `Owen takes picture ${taken} off on the web, its credit with it`);
        const r = await call(ada, 'POST', `/api/knowledge/posts/${p.id}/edit`,
            { title: 'Ada saves from the phone', body: WORDS.body, topic: WORDS.topic, place: WORDS.place, sources: [...stale, MAP_SOURCE], freeTags: [] });
        assert(r.status === 200 && storedRow(p.id).title === 'Ada saves from the phone' && same(picturesOf(p.id, p.bytes), taken === 1 ? [2, 3] : [1, 2]),
            `13b. picture ${taken}: Ada's stale phone Edit saves its words, Owen's pictures stay (${show(r)})`);
        assert(!storedList(p.id).some((s) => s.url === takenCredit.url || String(s.label).includes(takenCredit.maker)),
            `13b. picture ${taken}: no row of its credit comes back, as a credit or as a source (${storedRow(p.id).knowledge_sources})`);
        assert(same(creditsOf(p.id), wantCredits), `13b. picture ${taken}: the credit left is its own picture's, numbered by its place (${JSON.stringify(creditsOf(p.id))})`);
        const camera = await cameraRowsAreCredits(p.id);
        assert(camera.ok && camera.labels.length === 1, `13b. picture ${taken}: every 📷 the page reads is a credit row naming its own number (${camera.labels.join(' | ')})`);
        assert(same(ownOf(p.id), [PARKS, MAP_SOURCE.url]), `13b. picture ${taken}: the own source and Ada's Commons map, in her own words, stay (${JSON.stringify(ownOf(p.id))})`);
    }

    // ── 13c. Every other way sources come in ──────────────────────────────────────────────────
    console.log('── 13c. every other way sources come in ──');
    {
        const STALE_C1 = { url: C1.url, label: label(1, C1) };
        const MEL_SOURCE = { url: 'https://commons.wikimedia.org/wiki/File:Headland_walk.jpg', label: 'The headland walk on Wikimedia Commons' };
        const draftSources = (id: string): string[] =>
            (JSON.parse((db.prepare('SELECT sources FROM knowledge_drafts WHERE id = ?').get(id) as { sources: string | null } | undefined)?.sources ?? '[]') as any[]).map((s) => s.url);
        const p = freshPage();
        const melOpened = phoneRowsOf(await readPage(p.id, mel));
        const owenOpened = await readPage(p.id, owen);
        require_((await edit(owen, p.id, { photos: [owenOpened.photos[1], owenOpened.photos[2]] })).status === 200, 'Owen takes picture 1 off');
        const want = [[2, C3.file, label(2, C3)]];

        // A member's fix, from a 1.4.7 phone opened before: every row it drew, and a source of her own.
        const fix = await call(mel, 'POST', '/api/knowledge/drafts', { fixOf: p.id, note: 'The walk has its own page', title: WORDS.title, body: WORDS.body, topic: WORDS.topic, place: WORDS.place, sources: [...melOpened, MEL_SOURCE] });
        const fixId = fix.body?.draft?.id;
        assert(fix.status === 201 && same(draftSources(fixId), [PARKS, MEL_SOURCE.url]), `13c. Suggest a fix: the fix keeps the own row and Mel's Commons page, no credit (${show(fix)} ${JSON.stringify(draftSources(fixId))})`);
        const fixOk = await call(owen, 'POST', `/api/knowledge/drafts/${fixId}/approve`, {});
        assert(fixOk.status === 200 && same(creditsOf(p.id), want) && same(ownOf(p.id), [PARKS, MEL_SOURCE.url]) && (await cameraRowsAreCredits(p.id)).ok,
            `13c. the fix approved: 📷 2 is picture 3's, Mel's source written (${show(fixOk)} ${storedRow(p.id).knowledge_sources})`);

        // Approve with changes on a fix: the owner's form, opened before, sends every row back.
        const fix2 = await call(mel, 'POST', '/api/knowledge/drafts', { fixOf: p.id, note: 'Nothing but this note' });
        const fix2Id = fix2.body?.draft?.id;
        require_(fix2.status === 201, `Mel sends a second fix (${show(fix2)})`);
        const fix2Ok = await call(owen, 'POST', `/api/knowledge/drafts/${fix2Id}/approve`, { sources: [...melOpened, MEL_SOURCE] });
        assert(fix2Ok.status === 200 && same(creditsOf(p.id), want) && same(ownOf(p.id), [PARKS, MEL_SOURCE.url]) && (await cameraRowsAreCredits(p.id)).ok,
            `13c. Approve with changes on a fix: no credit comes back as a source (${show(fix2Ok)} ${storedRow(p.id).knowledge_sources})`);

        // An owner's own page, sent with a credit's shape.
        const own = await call(owen, 'POST', '/api/knowledge/posts', { ...WORDS, title: "Owen's own lookout page", sources: [WORDS.sources[0], STALE_C1, MEL_SOURCE] });
        const ownId = own.body?.post?.id;
        assert(own.status === 201 && same(ownOf(ownId), [PARKS, MEL_SOURCE.url]) && creditsOf(ownId).length === 0,
            `13c. an owner's own page: the credit's shape dropped, the Commons page in its own words kept (${show(own)})`);

        // A member's new suggestion, then Approve with changes on it.
        const sug = await call(mel, 'POST', '/api/knowledge/drafts', { ...WORDS, title: "Mel's lookout notes", sources: [WORDS.sources[0], STALE_C1, MEL_SOURCE] });
        const sugId = sug.body?.draft?.id;
        assert(sug.status === 201 && same(draftSources(sugId), [PARKS, MEL_SOURCE.url]), `13c. a member's new suggestion: no credit's shape kept (${show(sug)} ${JSON.stringify(draftSources(sugId))})`);
        const sugOk = await call(owen, 'POST', `/api/knowledge/drafts/${sugId}/approve`, { sources: [WORDS.sources[0], { url: C3.url, label: label(1, C3) }, MEL_SOURCE] });
        const sugPage = sugOk.body?.post?.id;
        assert(sugOk.status === 200 && same(ownOf(sugPage), [PARKS, MEL_SOURCE.url]) && creditsOf(sugPage).length === 0,
            `13c. Approve with changes on it: a page with no picture writes no credit (${show(sugOk)})`);

        // An assistant's draft (the door asks this before it files one).
        const k = checkAssistantKnowledgeDraft('remove-photo-test-grant', { ...WORDS, about: KNOWLEDGE_ABOUT[0], sources: [WORDS.sources[0], STALE_C1, MEL_SOURCE] });
        assert(same(k.sources.map((s) => s.url), [PARKS, MEL_SOURCE.url]), `13c. an assistant's draft: the credit's shape dropped (${JSON.stringify(k.sources)})`);
    }

    // ── 14. Where the line is ─────────────────────────────────────────────────────────────────
    console.log('── 14. where the line is ──');
    {
        const keeps = (row: { url: string; label: string }) => cleanKnowledgeInput({ ...WORDS, sources: [row] }).sources.length === 1;
        const files = ['Lookout_one.jpg', 'Przełęcz pod Kopą, 2019.jpg', 'Jane: a portrait (1).png'].map(commonsFilePage);
        const makers = ['Ana Maker', '', 'Jane Doe & Co '.repeat(12)];
        const dropped: Array<[string, { url: string; label: string }]> = [];
        for (const l of COMMONS_OPEN_LICENCES) {
            for (const [n, maker] of makers.entries()) dropped.push([`📷 ${n + 1}, ${l.name}, maker ${maker ? `${maker.length} letters` : 'none'}`, { url: files[n], label: knowledgeCreditLabel(n + 1, maker, l.name) }]);
        }
        dropped.push(
            ['a hidden character in its head', { url: files[0], label: `📷\u200b 1 · Ana Maker · CC BY 4.0` }],
            ['its link over http', { url: files[0].replace('https:', 'http:'), label: label(1, C1) }],
            ["its link's host in capitals", { url: files[0].replace('commons.wikimedia.org', 'COMMONS.WIKIMEDIA.ORG'), label: label(1, C1) }],
        );
        for (const [what, row] of dropped) assert(!keeps(row), `14. dropped: the node's credit shape, ${what} (${row.label.slice(0, 40)})`);
        const kept: Array<[string, { url: string; label: string }]> = [
            ['a Commons file page in a person\'s own words', MAP_SOURCE],
            ['the file page of a credit taken off, in a person\'s own words', { url: C1.url, label: 'Where the first photo came from' }],
            ['a camera with no number', { url: C1.url.replace('Lookout_one', 'Lookout_dawn'), label: '📷 The lookout at dawn' }],
            ['a "📷 n ·" label on any other address', { url: 'https://parks.example/photo-2', label: '📷 2 · Parks staff · CC BY 4.0' }],
        ];
        for (const [what, row] of kept) assert(keeps(row), `14. kept: ${what}`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
