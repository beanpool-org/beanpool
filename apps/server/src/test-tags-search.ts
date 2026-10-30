/**
 * Tags on the node (DESIGN-owner-seeding-tags-fable.md §4.5-§4.8, slice T2): `posts.tags`, their words in search_keywords,
 * the tag filter, and the copies that carry them. Members act over REAL HTTPS through the real signature middleware.
 *
 *   1. the builder: a tag folds its id's words, its English label, every tag above it, its aliases and its synonym keys; a
 *      tag the library does not know adds nothing; a Russian title's words survive it (a Cyrillic key in a map is found,
 *      where the ASCII strip deleted every such letter) and a comma no longer glues two words into none ("eggs,milk");
 *      a listing holding "constructor" or "toString" is made, not refused (the map's own keys only)
 *   2. a listing made with tags carries them; one made without (an old app) carries no `tags` field, as before; an unknown
 *      id is refused in words, six tags are refused, the same id twice is one, a list that is not one is refused
 *   3. search: a Russian-titled listing tagged lemon is found by the tag's word (lemon), an alias (citrus), an ancestor
 *      (fruit), and by its own Russian word; an untagged listing is not found by them
 *   4. the filter: by id (lemon, not lime), by prefix (food.fruit finds both, food finds both, food.fr finds neither), an
 *      unknown id finds nothing, garbage in tags= is a 400; q and tags OR'd (q=limón&tags=food.fruit.lemon finds the
 *      English listing tagged lemon and the Spanish one titled limón)
 *   5. an edit: new tags give new words, [] clears them, a tag the listing already holds passes though the library has no
 *      such id, any other unknown id is refused
 *   6. the once-only keywords backfill: stale words written again with the tags, updated_at untouched, the index finds
 *      them; with its marker set, it never runs again
 *   7. a standby's import carries tags (an update and an insert); the export leaves them out of an untagged listing
 *   8. a peer: the listings offered carry tags; a peer's tags are kept (a well-formed id from a newer library included, a
 *      malformed one dropped, five at most), and the cached listing is found by its tags' words and by the filter
 *   9. the LIKE filter measured on 5,000 listings (the median ms is printed for the PR)
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-tags-search.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, getPosts, exportSyncState, importRemoteState, setNodeRole, keywordsWithTagsOnce,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { startP2P } from './p2p.js';
import { localFetch } from './keepalive-test-fetch.js';
import { setMemberPhoto, generateSearchKeywords } from '@beanpool/engine';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { cacheRemoteListings, listingsForPeer } from './federation-listings.js';
import { postSearchKeywords } from './engine/search-keywords.js';
import { TEST_PHOTO } from './post-test-helper.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e: any) { console.error(`  (threw: ${e?.message})`); return undefined; }
}

let BASE = '';

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, ?, 'TEST', 'active')`).run(id.pk, name, new Date(Date.now() - 60 * 86_400_000).toISOString(), owner.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await localFetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}

async function offer(author: Id, title: string, extra: Record<string, unknown> = {}): Promise<Res> {
    return call('POST', author, '/api/marketplace/posts', {
        type: 'offer', category: 'food', title, description: '', credits: 0, priceType: 'fixed', authorPublicKey: author.pk,
        lat: -28.55, lng: 153.5, photos: [TEST_PHOTO], ...extra,
    });
}
async function found(viewer: Id, query: string): Promise<string[]> {
    const r = await call('GET', viewer, `/api/marketplace/posts?${query}&limit=200`);
    return Array.isArray(r.body) ? r.body.map((p: any) => p.id as string) : [];
}
const row = (id: string) => db.prepare('SELECT tags, search_keywords, updated_at FROM posts WHERE id = ?').get(id) as
    { tags: string; search_keywords: string; updated_at: string } | undefined;
const words = (s: string | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

async function main(): Promise<void> {
    console.log('\n=== Tags on the node (slice T2) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bea = member('Bea');

    // ── 1. the builder ────────────────────────────────────────────────────────────────────────
    console.log('── 1. the builder ──');
    const lemon = words(attempt(() => postSearchKeywords('Свежие лимоны', '', 'food', ['food.fruit.lemon'])));
    assert(['food', 'fruit', 'lemon', 'produce', 'citrus', 'tree'].every(w => lemon.has(w)),
        `a tag folds its id's words, label, ancestors and aliases (${[...lemon].join(' ')})`);
    const unknown = attempt(() => postSearchKeywords('x', '', 'food', ['food.fruit.not-in-the-library']));
    assert(unknown === 'food', `a tag the library does not know adds nothing (${unknown})`);
    const cyrillic = words(attempt(() => generateSearchKeywords('Свежие яйца', 'с фермы', 'food', { 'яйца': ['eggs'] })));
    assert(cyrillic.has('eggs'), `a Russian title's words survive the builder: a Cyrillic key is found (${[...cyrillic].join(' ')})`);
    const comma = words(attempt(() => postSearchKeywords('Eggs,milk', '', 'food')));
    assert(comma.has('poultry') && comma.has('dairy'), `"eggs,milk" is two words, each with its synonyms (${[...comma].join(' ')})`);
    const glued = words(attempt(() => generateSearchKeywords('Pumpkin тыква seeds', '', 'garden', { 'pumpkin seeds': ['pepitas'] })));
    assert(!glued.has('pepitas'), 'a Russian word between two English words keeps them apart (no false "pumpkin seeds")');
    const proto = await offer(ann, 'constructor toString valueOf');
    assert(proto.status === 200, `a listing holding "constructor" or "toString" is made (${proto.status} ${proto.text.slice(0, 120)})`);

    // ── 2. the door ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. making a listing with tags ──');
    const ruLemon = await offer(ann, 'Свежие лимоны', { tags: ['food.fruit.lemon', 'food.fruit.lemon'] });
    const ruId = ruLemon.body?.post?.id as string;
    assert(ruLemon.status === 200 && JSON.stringify(ruLemon.body.post.tags) === '["food.fruit.lemon"]',
        `a listing made with tags carries them, the same id twice as one (${ruLemon.status} ${JSON.stringify(ruLemon.body?.post?.tags)})`);
    assert(row(ruId)?.tags === 'food.fruit.lemon', `stored space-separated (${row(ruId)?.tags})`);
    const lime = await offer(ann, 'Limes from the tree', { tags: ['food.fruit.lime'] });
    const limeId = lime.body?.post?.id as string;
    const plain = await offer(ann, 'Lemon cake');
    const plainId = plain.body?.post?.id as string;
    assert(plain.status === 200 && !('tags' in (plain.body.post ?? {})) && row(plainId)?.tags === '',
        'a listing made without tags (an app older than tags) carries no tags field, and stores none');
    const eggs = await offer(ann, 'Eggs from the farm', { tags: ['food.eggs'] });
    const eggsId = eggs.body?.post?.id as string;
    const bad = await offer(ann, 'Bad tag', { tags: ['food.fruit.nope'] });
    assert(bad.status === 400 && /There is no tag "food\.fruit\.nope"/.test(String(bad.body?.error)), `an unknown id is refused in words (${bad.status} ${bad.body?.error})`);
    const six = await offer(ann, 'Six tags', { tags: ['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.apple', 'food.fruit.pear', 'food.fruit.fig'] });
    assert(six.status === 400 && /at most 5 tags/.test(String(six.body?.error)), `six tags are refused (${six.status} ${six.body?.error})`);
    const five = await offer(ann, 'Five tags', { tags: ['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.apple', 'food.fruit.pear'] });
    assert(five.status === 200 && five.body.post.tags.length === 5, `five are made (${five.status})`);
    const notList = await offer(ann, 'Not a list', { tags: 'food.fruit.lemon' });
    assert(notList.status === 400 && /list of tag ids/.test(String(notList.body?.error)), `tags that are not a list are refused (${notList.status} ${notList.body?.error})`);
    const fiveId = five.body?.post?.id as string;

    // ── 3. search by the tags' words ──────────────────────────────────────────────────────────
    console.log('\n── 3. search finds a tagged listing by its tags\' words ──');
    for (const q of ['lemon', 'citrus', 'fruit']) {
        const ids = await found(bea, `q=${q}`);
        assert(ids.includes(ruId), `q=${q} finds the Russian-titled listing tagged lemon`);
    }
    assert((await found(bea, `q=${encodeURIComponent('лимоны')}`)).includes(ruId), 'and its own Russian word finds it');
    assert(!(await found(bea, 'q=citrus')).includes(eggsId), 'an alias of lemon does not find the eggs');
    assert((await found(bea, 'q=poultry')).includes(eggsId), 'and an alias of eggs does');

    // ── 4. the filter ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. the tag filter ──');
    const byLemon = await found(bea, 'tags=food.fruit.lemon');
    assert(byLemon.includes(ruId) && !byLemon.includes(limeId) && !byLemon.includes(plainId) && byLemon.includes(fiveId),
        'by id: the listings tagged lemon, not lime, not the untagged "Lemon cake"');
    const byFruit = await found(bea, 'tags=food.fruit');
    assert(byFruit.includes(ruId) && byFruit.includes(limeId) && !byFruit.includes(eggsId), 'by prefix: food.fruit finds lemon and lime, not eggs');
    const byFood = await found(bea, 'tags=food');
    assert(byFood.includes(ruId) && byFood.includes(limeId) && byFood.includes(eggsId) && !byFood.includes(plainId), 'food finds every food tag, not the untagged');
    assert((await found(bea, 'tags=food.fr')).length === 0, 'a partial segment (food.fr) finds nothing');
    assert((await found(bea, 'tags=food.fruit.not-a-tag')).length === 0, 'an id the library does not know finds nothing');
    assert((await found(bea, 'tags=food.fruit.lemon,food.eggs')).includes(eggsId), 'two ids are OR\'d');
    for (const garbage of ['%25', 'FOOD', 'food..fruit', 'a.b.c.d', Array.from({ length: 21 }, (_, i) => `food.x${i}`).join(',')]) {
        const r = await call('GET', bea, `/api/marketplace/posts?tags=${garbage}`);
        assert(r.status === 400, `tags=${garbage.slice(0, 30)} is a 400 (${r.status})`);
    }
    const twice = await call('GET', bea, '/api/marketplace/posts?tags=food&tags=garden');
    assert(twice.status === 400, `tags given twice is a 400 (${twice.status})`);
    const es = await offer(ann, 'Limón de mi huerta');
    const esId = es.body?.post?.id as string;
    const enLemon = await offer(ann, 'Fresh garden produce', { tags: ['food.fruit.lemon'] });
    const enId = enLemon.body?.post?.id as string;
    const either = await found(bea, `q=${encodeURIComponent('limón')}&tags=food.fruit.lemon`);
    assert(either.includes(esId) && either.includes(enId) && !either.includes(limeId),
        'q=limón&tags=food.fruit.lemon finds the Spanish listing by its word and the English one by its tag, not the lime');
    assert(!(await found(bea, `q=${encodeURIComponent('limón')}`)).includes(enId), 'without tags=, limón does not find the English listing');

    // ── 5. an edit ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. editing the tags ──');
    const edit = (tags: unknown) => call('POST', ann, '/api/marketplace/posts/update', { id: ruId, authorPublicKey: ann.pk, tags });
    let r = await edit(['food.fruit.lime']);
    assert(r.status === 200 && row(ruId)?.tags === 'food.fruit.lime' && words(row(ruId)?.search_keywords).has('lime') && !words(row(ruId)?.search_keywords).has('lemon'),
        `new tags give new words (${r.status} ${row(ruId)?.search_keywords})`);
    assert((await found(bea, 'q=lime')).includes(ruId) && !(await found(bea, 'tags=food.fruit.lemon')).includes(ruId), 'search and filter follow the edit');
    r = await call('POST', ann, '/api/marketplace/posts/update', { id: ruId, authorPublicKey: ann.pk, title: 'Свежие лаймы' });
    assert(r.status === 200 && row(ruId)?.tags === 'food.fruit.lime' && words(row(ruId)?.search_keywords).has('citrus'), 'an edit that names no tags keeps them and their words');
    r = await edit([]);
    assert(r.status === 200 && row(ruId)?.tags === '' && !words(row(ruId)?.search_keywords).has('citrus') && !('tags' in (r.body?.post ?? {})),
        `[] clears them, and their words (${row(ruId)?.search_keywords})`);
    db.prepare(`UPDATE posts SET tags = 'food.fruit.retired-kind' WHERE id = ?`).run(ruId);
    r = await edit(['food.fruit.retired-kind', 'food.fruit.lemon']);
    assert(r.status === 200 && row(ruId)?.tags === 'food.fruit.retired-kind food.fruit.lemon', `a tag the listing already holds passes though the library has no such id (${r.status})`);
    r = await edit(['food.fruit.other-unknown']);
    assert(r.status === 400, `any other unknown id is refused (${r.status} ${r.body?.error})`);

    // ── 6. the once-only backfill ─────────────────────────────────────────────────────────────
    console.log('\n── 6. the once-only keywords backfill ──');
    const marker = () => db.prepare(`SELECT value FROM node_config WHERE key = 'migration_search_keywords_tags_v1'`).get();
    assert(!!marker(), 'the boot ran it once and left its marker');
    const stamp = '2001-02-03T04:05:06.007Z';
    db.prepare(`UPDATE posts SET search_keywords = 'stale', updated_at = ? WHERE id = ?`).run(stamp, eggsId);
    db.prepare(`DELETE FROM node_config WHERE key = 'migration_search_keywords_tags_v1'`).run();
    attempt(() => keywordsWithTagsOnce());
    assert(words(row(eggsId)?.search_keywords).has('poultry') && row(eggsId)?.updated_at === stamp && !!marker(),
        `stale words are written again with the tag's, updated_at untouched (${row(eggsId)?.updated_at})`);
    assert((await found(bea, 'q=poultry')).includes(eggsId), 'and the index finds them');
    db.prepare(`UPDATE posts SET search_keywords = 'stale' WHERE id = ?`).run(eggsId);
    attempt(() => keywordsWithTagsOnce());
    assert(row(eggsId)?.search_keywords === 'stale', 'with its marker set it never runs again');
    db.prepare(`UPDATE posts SET search_keywords = ? WHERE id = ?`).run(postSearchKeywords('Eggs from the farm', '', 'food', ['food.eggs']), eggsId);

    // ── 7. a standby ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. a standby\'s copy carries tags ──');
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4293/p2p/${nodeId}`);
    const payload: any = await exportSyncState(nodeId);
    const exLime = (payload.posts ?? []).find((p: any) => p.id === limeId);
    const exPlain = (payload.posts ?? []).find((p: any) => p.id === plainId);
    assert(JSON.stringify(exLime?.tags) === '["food.fruit.lime"]' && exPlain && !('tags' in exPlain),
        `the export carries a tagged listing's tags and none for an untagged one (${JSON.stringify(exLime?.tags)})`);
    db.prepare(`UPDATE posts SET tags = '', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(limeId);
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(eggsId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(eggsId);
    setNodeRole('backup');
    try { await importRemoteState(payload); } catch (e: any) { console.error(`  (import threw: ${e?.message})`); }
    setNodeRole('primary');
    assert(row(limeId)?.tags === 'food.fruit.lime', `the standby holds the tags (update) (${row(limeId)?.tags})`);
    assert(row(eggsId)?.tags === 'food.eggs' && words(row(eggsId)?.search_keywords).has('poultry'), `and a listing it never had, with its words (insert) (${row(eggsId)?.tags})`);
    const exTampered = { ...exLime, id: limeId, tags: ['food.fruit.lime', 'NOT VALID', 'x'.repeat(300)], updatedAt: new Date(Date.now() + 60_000).toISOString() };
    setNodeRole('backup');
    try { await importRemoteState({ ...payload, posts: [exTampered] }); } catch (e: any) { console.error(`  (import threw: ${e?.message})`); }
    setNodeRole('primary');
    assert(row(limeId)?.tags === 'food.fruit.lime', `a malformed id in a copy is dropped (${row(limeId)?.tags})`);
    await p2p.stop();

    // ── 8. a peer ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. a linked community\'s listings carry tags ──');
    const PEER = '12D3KooWTagsPeer0000000000000000000000000000000000';
    db.prepare(`UPDATE posts SET reach = 'everywhere' WHERE id IN (?, ?)`).run(limeId, plainId);
    const offered = listingsForPeer(PEER);
    const offLime = offered.find(l => l.id === limeId), offPlain = offered.find(l => l.id === plainId);
    assert(JSON.stringify(offLime?.tags) === '["food.fruit.lime"]' && !!offPlain && !('tags' in offPlain),
        `the listings offered to a peer carry tags, none on an untagged one (${JSON.stringify(offLime?.tags)})`);
    const remoteAuthor = newId('Remy').pk;
    const remote = (id: string, title: string, tags?: unknown) => ({
        id, type: 'offer', category: 'food', title, description: '', credits: 0, priceType: 'fixed', authorPublicKey: remoteAuthor,
        authorCallsign: 'Remy', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...(tags !== undefined ? { tags } : {}),
    });
    const cached = cacheRemoteListings(PEER, 'https://peer.example', [
        remote('r1', 'Спелые апельсины', ['food.fruit.orange', 'food.fruit.from-a-newer-library', 'Not Valid', 'food.fruit.lime', 'food.fruit.apple', 'food.fruit.pear', 'food.fruit.fig']),
        remote('r2', 'An old peer\'s listing'),
    ]);
    const r1 = db.prepare(`SELECT id, tags, search_keywords FROM posts WHERE origin_node = ? AND title = ?`).get('https://peer.example', 'Спелые апельсины') as any;
    const r2 = db.prepare(`SELECT tags FROM posts WHERE origin_node = ? AND title = ?`).get('https://peer.example', 'An old peer\'s listing') as any;
    assert(cached.cached === 2 && r1?.tags === 'food.fruit.orange food.fruit.from-a-newer-library food.fruit.lime food.fruit.apple food.fruit.pear',
        `a peer's tags are kept: a newer library's id too, a malformed one dropped, five at most (${r1?.tags})`);
    assert(r2?.tags === '', 'a peer older than tags sends none, and its listing is cached as before');
    assert(words(r1?.search_keywords).has('citrus'), `the cached listing's words include its tags' (${r1?.search_keywords})`);
    const peerRead = attempt(() => getPosts({ query: 'citrus', viewerPubkey: bea.pk, limit: 200 }).map(p => p.id)) ?? [];
    const peerFilter = attempt(() => getPosts({ tags: ['food.fruit.orange'], viewerPubkey: bea.pk, limit: 200 }).map(p => p.id)) ?? [];
    assert(peerRead.includes(r1?.id) && peerFilter.includes(r1?.id), 'and it is found by them and by the filter');

    // ── 9. the LIKE filter on 5,000 listings ──────────────────────────────────────────────────
    console.log('\n── 9. the tag filter measured on 5,000 listings ──');
    const pool = ['food.fruit.lemon', 'food.fruit.lime', 'food.eggs', 'food.dairy.milk', 'garden', 'tools'];
    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, tags, search_keywords)
                               VALUES (?, 'offer', 'food', ?, '', 0, ?, 1, 'active', ?, 'food')`);
    db.transaction(() => {
        for (let i = 0; i < 5000; i++) {
            const tags = i % 3 === 0 ? '' : [pool[i % pool.length], pool[(i * 7) % pool.length]].filter((t, k, a) => a.indexOf(t) === k).join(' ');
            insert.run(`bulk-${i}`, `Bulk listing ${i}`, ann.pk, tags);
        }
    })();
    const total = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
    const time = (fn: () => unknown, runs = 25): number => {
        const ms: number[] = [];
        for (let i = 0; i < runs; i++) { const t = process.hrtime.bigint(); fn(); ms.push(Number(process.hrtime.bigint() - t) / 1e6); }
        return ms.sort((a, b) => a - b)[Math.floor(runs / 2)];
    };
    const likeOnly = time(() => db.prepare(`SELECT COUNT(*) FROM posts p WHERE (' ' || p.tags || ' ') LIKE ? OR (' ' || p.tags || ' ') LIKE ?`).get('% food.fruit %', '% food.fruit.%'));
    const scanOnly = time(() => db.prepare(`SELECT COUNT(*) FROM posts p WHERE p.category = ?`).get('food'));
    const page = time(() => getPosts({ tags: ['food.fruit'], viewerPubkey: bea.pk, limit: 50 }));
    const pageNone = time(() => getPosts({ viewerPubkey: bea.pk, limit: 50 }));
    const pageBoth = time(() => getPosts({ query: 'lemon', tags: ['food.fruit.lemon'], viewerPubkey: bea.pk, limit: 50 }));
    console.log(`  MEASURED (${total} listings, median of 25): the LIKE alone ${likeOnly.toFixed(2)} ms (a plain category scan ${scanOnly.toFixed(2)} ms);`
        + ` a page of 50 by tags=food.fruit ${page.toFixed(2)} ms, with no filter ${pageNone.toFixed(2)} ms, q+tags ${pageBoth.toFixed(2)} ms`);
    assert(likeOnly < 50 && page < 250, `the filter stays cheap on ${total} listings (LIKE ${likeOnly.toFixed(2)} ms, page ${page.toFixed(2)} ms)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
