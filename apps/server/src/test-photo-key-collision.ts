/**
 * One post's photos are never another's to delete, and a members' photo is kept by no shared cache
 * (scratch/reviews/FABLE-sec-images.md, 2026-10-01: HIGH, MEDIUM and a NOTE).
 *
 * A post's id is the caller's when they send one, and its photos are stored under it (`posts/<id>/<n>-<sha8>.<ext>`,
 * storage/image-store.ts postPhotoKey). The key builder used to STRIP what a key segment cannot hold and cut the id at
 * 128, so `X!`, `X ` and `X` were one directory: a member who copied a listing's photo into a post with such an id, then
 * edited it, deleted the other member's photo object, and that listing answered 503 for ever. Now an id is refused,
 * never stripped, and an object some row still names is never deleted.
 *
 * The real server over TLS, through the real signature middleware, on a local community (every listing's photo keyed).
 * Vera posts a photo; Mallory tries to reach it.
 *
 *  1. An id that would strip or cut down to Vera's (`V!`, `V `, a 129th character), and her id in capitals (one directory
 *     with hers on a disk that folds case): refused, 400 with the shape error. Mallory's edit of the post if it was
 *     made (it is not, here) and Vera's photo still serves, its object still in the store.
 *  2. Vera's own id with another photo: refused before anything is stored, 400 with the "taken" error, and Vera's
 *     directory in the store holds her objects and no other.
 *  3. A row from before this change that names Vera's object (a post whose id the old key builder stripped to hers):
 *     its author's edit takes the photo off it, and Vera's object stays, because her row still names it; so it does when
 *     the row names it in other capitals. Asking is an index lookup. An object no other row names still goes.
 *  4. Headers. A keyed photo: `private, max-age=31536000, immutable`. A board listing's photo where the listings are a
 *     public read: `public, max-age=31536000, immutable`, as before; a group's listing there is still `private`. A
 *     message's attachment: `private, no-store`.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-key-collision.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.CF_API_TOKEN;
delete process.env.CF_ZONE_ID;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { lockedDm } from './dm-test-payload.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const DAY = 24 * 60 * 60 * 1000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
/** A second picture (one red pixel). */
const RED_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGM4IScHAAK2AQU0pnWqAAAAAElFTkSuQmCC';
const IMMUTABLE = 'max-age=31536000, immutable';

type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

let beforeCall: () => void = () => {};
type Res = { status: number; body: any; bytes: Buffer; cache: string | null };
async function get(p: string, id?: Id): Promise<Res> {
    beforeCall();
    const res = await fetch(`${BASE}${p}`, { headers: id ? signedHeaders('GET', p, '', id) : {} });
    const bytes = Buffer.from(await res.arrayBuffer());
    let body: any;
    try { body = JSON.parse(bytes.toString('utf8')); } catch { /* an image */ }
    return { status: res.status, body, bytes, cache: res.headers.get('cache-control') };
}
async function post(p: string, payload: unknown, id: Id): Promise<Res> {
    beforeCall();
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', p, body, id) }, body });
    const bytes = Buffer.from(await res.arrayBuffer());
    let json: any;
    try { json = JSON.parse(bytes.toString('utf8')); } catch { /* not JSON */ }
    return { status: res.status, body: json, bytes, cache: res.headers.get('cache-control') };
}
const pathOf = (url: string) => url.replace(/^https?:\/\/[^/]+/, '');

async function main(): Promise<void> {
    console.log('\n=== One post\'s photos are never another\'s to delete ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { getImageStore } = await import('./storage/image-store.js');
    const photoKeys = await import('./engine/photo-keys.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const store = getImageStore();

    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_ref)
                    VALUES (?, ?, 'active', ?, 'seed', ?, ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const vera = member('KeyVera');
    const mallory = member('KeyMallory');

    const listing = (author: Id, title: string, photos: string[], extra: Record<string, unknown> = {}) =>
        post('/api/marketplace/posts', { type: 'offer', category: 'food', title, description: `${title}, described`, credits: 0, authorPublicKey: author.pk, photos, ...extra }, author);
    const keyOf = (postId: string, n = 0) =>
        (db.prepare('SELECT storage_key FROM post_photos WHERE post_id = ? AND order_num = ?').get(postId, n) as { storage_key: string | null } | undefined)?.storage_key ?? null;
    /** Vera posts a photo; her listing's id, its photo's URL as her read carries it, its key in the store and its bytes. */
    const veraPosts = async (title: string, extra: Record<string, unknown> = {}) => {
        const r = await listing(vera, title, [TINY_PNG], extra);
        const id = r.body?.post?.id as string;
        const url = pathOf(String(r.body?.post?.photos?.[0] ?? ''));
        const key = id ? keyOf(id) : null;
        const served = await get(url);
        if (r.status !== 200 || !key || served.status !== 200) {
            throw new Error(`setup: Vera's listing "${title}" (${r.status} ${JSON.stringify(r.body?.error)}, key ${key}, photo ${served.status})`);
        }
        return { id, url, key, bytes: served.bytes };
    };
    /** Whether Vera's photo is whole: its object in the store and her URL answering 200 with its bytes. */
    const veraIntact = async (v: { url: string; key: string; bytes: Buffer }) => {
        const r = await get(v.url);
        return { ok: !!store.get(v.key) && r.status === 200 && r.bytes.equals(v.bytes), status: r.status };
    };

    // ── 1. an id that strips, cuts or folds down to Vera's ────────────────────────────────────
    console.log('── 1. an id that the old key builder made Vera\'s ──');
    const long = 'a'.repeat(128);
    const variants: Array<{ what: string; ownId?: string; attack: (v: string) => string }> = [
        { what: 'her id and a "!"', attack: (v) => `${v}!` },
        { what: 'her id and a space', attack: (v) => `${v} ` },
        { what: 'her id and a slash', attack: (v) => `${v}/` },
        { what: 'her 128-character id and a 129th', ownId: long, attack: (v) => `${v}b` },
        { what: 'her id in capitals', attack: (v) => v.toUpperCase() },
    ];
    for (const variant of variants) {
        const v = await veraPosts(`Quince jelly (${variant.what})`, variant.ownId ? { id: variant.ownId } : {});
        const attackId = variant.attack(v.id);
        const made = await listing(mallory, `Copied jelly (${variant.what})`, [TINY_PNG], { id: attackId });
        assert(made.status === 400 && /^A post id is up to 128 lowercase letters/.test(String(made.body?.error)),
            `Mallory's post with ${variant.what} as its id is refused, not stripped to Vera's (${made.status} ${JSON.stringify(made.body?.error)})`);
        if (made.status === 200) {
            // The attack, where the id was taken: take the photo off the post, which deletes its object after the commit.
            await post('/api/marketplace/posts/update', { id: made.body.post.id, authorPublicKey: mallory.pk, photos: [] }, mallory);
        }
        const after = await veraIntact(v);
        assert(after.ok, `Vera's photo still serves, its object still in the store (${variant.what}; got ${after.status})`);
    }

    // ── 2. Vera's own id ──────────────────────────────────────────────────────────────────────
    console.log('\n── 2. Vera\'s own id, with another photo ──');
    {
        const v = await veraPosts('Fig preserve');
        const before = store.list(`posts/${v.id}/`).sort();
        const made = await listing(mallory, 'Fig preserve, again', [RED_PNG], { id: v.id });
        assert(made.status === 400 && /^A new post needs an id nothing else has/.test(String(made.body?.error)),
            `Mallory's post with Vera's id is refused as taken (${made.status} ${JSON.stringify(made.body?.error)})`);
        const now = store.list(`posts/${v.id}/`).sort();
        assert(JSON.stringify(now) === JSON.stringify(before),
            `and nothing was stored under Vera's listing for it: ${JSON.stringify(before)} → ${JSON.stringify(now)}`);
        const after = await veraIntact(v);
        assert(after.ok, `Vera's photo still serves (got ${after.status})`);
        const own = (db.prepare('SELECT author_pubkey, title FROM posts WHERE id = ?').get(v.id) as { author_pubkey: string; title: string });
        assert(own.author_pubkey === vera.pk && own.title === 'Fig preserve', 'and her listing is still hers, as it was');
    }

    // ── 3. a row that names Vera's object ─────────────────────────────────────────────────────
    console.log('\n── 3. a row from before this change that names Vera\'s object ──');
    {
        const v = await veraPosts('Medlar cheese');
        // What the old key builder left on a live node: Mallory's post, made with an id it stripped to Vera's, whose photo
        // row names her object. Written as it would be, by hand: nothing makes such a row now.
        const legacy = `legacy-${crypto.randomUUID()}`;
        const ins = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status)
                                VALUES (?, 'offer', 'food', 'Medlar cheese, copied', 'x', 0, ?, ?, 1, 'active')`);
        ins.run(legacy, mallory.pk, new Date().toISOString());
        const vRow = db.prepare('SELECT sha256, bytes, mime FROM post_photos WHERE post_id = ? AND order_num = 0').get(v.id) as { sha256: string; bytes: number; mime: string };
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, 0, ?, ?, ?, ?)`)
            .run(legacy, v.key, vRow.sha256, vRow.bytes, vRow.mime);
        const edit = await post('/api/marketplace/posts/update', { id: legacy, authorPublicKey: mallory.pk, photos: [] }, mallory);
        assert(edit.status === 200 && keyOf(legacy) === null, `Mallory's edit takes the photo off her post (${edit.status} ${JSON.stringify(edit.body?.error)})`);
        const after = await veraIntact(v);
        assert(after.ok, `Vera's object is kept: her row still names it, and her photo serves (got ${after.status})`);

        // The same, by a key that differs from hers only in case: on a disk that folds case it is her file.
        const v2 = await veraPosts('Rowan jelly');
        const folded = `legacy-${crypto.randomUUID()}`;
        ins.run(folded, mallory.pk, new Date().toISOString());
        const v2Row = db.prepare('SELECT sha256, bytes, mime FROM post_photos WHERE post_id = ? AND order_num = 0').get(v2.id) as { sha256: string; bytes: number; mime: string };
        const shouted = v2.key.replace(`posts/${v2.id}/`, `posts/${v2.id.toUpperCase()}/`);
        db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, storage_key, sha256, bytes, mime) VALUES (?, NULL, 0, ?, ?, ?, ?)`)
            .run(folded, shouted, v2Row.sha256, v2Row.bytes, v2Row.mime);
        const edit2 = await post('/api/marketplace/posts/update', { id: folded, authorPublicKey: mallory.pk, photos: [] }, mallory);
        const after2 = await veraIntact(v2);
        assert(edit2.status === 200 && after2.ok, `a row naming her key in other capitals leaves her photo too (${edit2.status}, photo ${after2.status})`);

        // The question is asked before every delete of an object, so it is an index lookup, not a scan of every photo row.
        for (const [table, index] of [['post_photos', 'idx_post_photos_storage_key'], ['message_attachments', 'idx_message_attachments_storage_key']]) {
            const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE storage_key = ? COLLATE NOCASE LIMIT 1`).all(v.key) as { detail: string }[])
                .map((r) => r.detail).join('; ');
            assert(plan.includes(index), `whether a ${table} row names a key is answered from ${index} (${plan})`);
        }

        // And the ordinary case is unchanged: a photo no other row names goes with the edit that drops it.
        const own = await listing(mallory, 'Crab apple jelly', [RED_PNG]);
        const ownKey = keyOf(own.body?.post?.id);
        const dropped = await post('/api/marketplace/posts/update', { id: own.body?.post?.id, authorPublicKey: mallory.pk, photos: [] }, mallory);
        assert(own.status === 200 && !!ownKey && dropped.status === 200 && store.get(ownKey!) === null,
            `an object no other row names is deleted with the photo, as before (${own.status}, ${dropped.status}, ${ownKey})`);
    }

    // ── 4. headers ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. who may keep a copy ──');
    {
        const v = await veraPosts('Damson cheese');
        const r = await get(v.url);
        assert(/[?&]k=/.test(v.url) && r.cache === `private, ${IMMUTABLE}`,
            `a keyed photo (a local community's) is the member's browser's to keep, no shared cache's: ${r.cache}`);

        // A message's photo.
        const conv = se.createConversation('dm', [vera.pk, mallory.pk], vera.pk);
        if (!conv) throw new Error('setup: the DM');
        const photo = lockedDm(64);
        const sent = await post('/api/messages/send', {
            conversationId: conv.id, authorPubkey: vera.pk, ...lockedDm(), type: 'image',
            attachment: { data: photo.ciphertext, nonce: photo.nonce, mime: 'image/jpeg' },
        }, vera);
        const msgId = sent.body?.message?.id;
        const att = await get(`/api/messages/${msgId}/attachment`, mallory);
        assert(sent.status === 200 && att.status === 200 && att.cache === 'private, no-store',
            `a message's attachment is kept by no cache (${sent.status}, ${att.status}, ${att.cache})`);

        // Where the listings are a public read (the boot of a node with reads off): a board listing's photo is anyone's.
        photoKeys.installPhotoKeysAtBoot(false);
        const club = se.createGroup({ name: 'Jelly club', createdBy: vera.pk });
        const board = await veraPosts('Sloe gin jelly');
        const boardRes = await get(board.url);
        assert(!/[?&]k=/.test(board.url) && boardRes.cache === `public, ${IMMUTABLE}`,
            `a board listing's photo on a public-read node is for shared caches too, as before: ${boardRes.cache}`);
        const grp = await veraPosts('Bramble jelly for the club', { audienceScope: 'group', targetGroupId: club.id });
        const grpRes = await get(grp.url);
        assert(/[?&]k=/.test(grp.url) && grpRes.cache === `private, ${IMMUTABLE}`,
            `a group's listing's photo there is still keyed, and private: ${grpRes.cache}`);
    }

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Photo key collision tests PASSED.\n');
}

main().then(() => process.exit(0), (e) => { console.error('❌ Test failed:', e); process.exit(1); });
