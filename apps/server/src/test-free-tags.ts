/**
 * The tags a member types, on the node (DESIGN-tags-free-entry-fable.md §2, §4, §5, slice F1): `posts.free_tags`, their words
 * in search_keywords, the `free=` filter, and the copies that carry them. Members act over REAL HTTPS through the real
 * signature middleware.
 *
 *   1. the migration: on a database from before F1 the column comes in with no row rewritten and no page added; nothing in
 *      the file's schema reads it or calls a connection function; a handle with no functions registered (what an older image
 *      is, as far as this file goes) writes and edits a post, and the default applies
 *   2. the builder: a tag's words and its joined compound; none adds nothing
 *   3. the door: the stored form, and every refusal in words (too short, too long, five words, six tags, each contact shape,
 *      emoji-only, a control character, a comma, not a list, too long together); a refused listing is not made
 *   4. search: found by a word, a prefix, a joined compound, accent-folded, an event, an unspaced run; in the index as a title
 *      word is, and only the listing that carries it
 *   5. the filter: exact, as stored, OR'd, q OR free OR tags; polls and blocked authors stay out, a listing hidden by reports
 *      stays out; garbage is a 400; a board of untagged listings answers 200 (json_each('') throws), so does a row
 *      that holds something that is not JSON
 *   6. an edit: naming none keeps them, [] and null clear them, words follow, a tag it holds passes, a refusal writes nothing
 *   7. a free tag cannot reach a library id, nor a library id a free tag
 *   8. a standby: export, an update and an insert, a main server older than F1, a tampered copy held to the rule
 *   9. a peer: offered, kept to the rule, found, a peer older than F1 as before
 *  10. the boot's writers keep the words; a deleted member's tags go; a visitor reads them
 *  11. the json_each filter measured on 5,000 listings (the median ms is printed for the PR)
 *
 * What the suite cannot do is run an older build: the rollback on main's real build (a boot on this file, a write, a copy
 * with the field in it) is run by hand from the PR's recipe, and its output is in the PR.
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-free-tags.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, getPosts, exportSyncState, importRemoteState, setNodeRole, keywordsWithTagsOnce,
    generateSearchKeywords,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { startP2P } from './p2p.js';
import { localFetch } from './keepalive-test-fetch.js';
import { setMemberPhoto, guestPost } from '@beanpool/engine';
import { pinMainServerForTests } from './standby-pin-test-helper.js';
import { cacheRemoteListings, listingsForPeer } from './federation-listings.js';
import { postSearchKeywords } from './engine/search-keywords.js';
import { scrubPostsOf } from './engine/post-scrub.js';
import { addBlocks, removeBlock } from './engine/member-blocks.js';
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

interface Res { status: number; body: any; text: string; etag: string | null }
async function call(method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
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
    return { status: res.status, body: parsed, text, etag: res.headers.get('etag') };
}

async function offer(author: Id, title: string, extra: Record<string, unknown> = {}): Promise<Res> {
    return call('POST', author, '/api/marketplace/posts', {
        type: 'offer', category: 'general', title, description: '', credits: 0, priceType: 'fixed', authorPublicKey: author.pk,
        lat: -28.55, lng: 153.5, photos: [TEST_PHOTO], ...extra,
    });
}
async function found(viewer: Id, query: string): Promise<string[]> {
    const r = await call('GET', viewer, `/api/marketplace/posts?${query}&limit=200`);
    if (!Array.isArray(r.body)) console.error(`  (${query}: ${r.status} ${r.text.slice(0, 120)})`);
    return Array.isArray(r.body) ? r.body.map((p: any) => p.id as string) : [];
}
const q = (word: string) => `q=${encodeURIComponent(word)}`;
const free = (...tags: string[]) => `free=${encodeURIComponent(tags.join(','))}`;
const row = (id: string) => db.prepare('SELECT tags, free_tags, search_keywords, updated_at FROM posts WHERE id = ?').get(id) as
    { tags: string; free_tags: string; search_keywords: string; updated_at: string } | undefined;
const words = (s: string | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

/** A file with `posts` as the node's oldest supported shape has it, before F1's ALTER, and 5,000 rows. */
function migrationProbe(): void {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'free-tags-migration-'));
    const file = path.join(dir, 'state.db');
    const old = new Database(file);
    old.exec(`CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '')`);
    const add = old.prepare('INSERT INTO posts (id, title) VALUES (?, ?)');
    old.transaction(() => { for (let i = 0; i < 5000; i++) add.run(`p${i}`, `A listing of a good length, number ${i}`); })();
    const pages = (old.pragma('page_count', { simple: true }) as number);
    old.prepare(`ALTER TABLE posts ADD COLUMN free_tags TEXT NOT NULL DEFAULT ''`).run();
    const after = (old.pragma('page_count', { simple: true }) as number);
    assert(after === pages, `the ALTER rewrites no row: ${pages} pages before, ${after} after, on 5,000 listings`);
    assert((old.prepare(`SELECT COUNT(*) AS c FROM posts WHERE free_tags = ''`).get() as any).c === 5000, 'and every existing row reads \'\'');
    old.close();
    fs.rmSync(dir, { recursive: true, force: true });
}

async function main(): Promise<void> {
    console.log('\n=== Free tags on the node (slice F1) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bea = member('Bea');
    const cas = member('Cas');

    // ── 1. the migration ──────────────────────────────────────────────────────────────────────
    console.log('── 1. the migration ──');
    migrationProbe();
    const schemaSql = db.prepare(`SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('trigger', 'index', 'view')`).all() as Array<{ name: string; type: string; sql: string }>;
    const readers = schemaSql.filter(s => /free_tags/.test(s.sql)).map(s => s.name);
    assert(readers.length === 0, `no trigger, index or view in the file names the column (${readers.join(', ') || 'none'})`);
    const column = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'posts'`).get() as { sql: string }).sql.match(/free_tags[^,\n]*/)?.[0] ?? '';
    assert(column.trim() === `free_tags TEXT NOT NULL DEFAULT ''`, `the column is plain text with a constant default (${column.trim()})`);
    const fts = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'posts_fts'`).get() as { sql: string };
    assert(!/free_tags/.test(fts.sql), 'posts_fts is unchanged: no new indexed column');
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    const dbFile = fs.readdirSync(dataDir, { recursive: true }).map(String).find(f => f.endsWith('state.db'));
    if (dbFile) {
        // What an older image is, as far as this file goes: a handle with none of the node's functions, whose INSERT
        // names the columns it knows, and whose UPDATE names the ones it edits.
        const plain = new Database(path.join(dataDir, dbFile));
        const wrote = attempt(() => {
            plain.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, active, status, tags, search_keywords)
                           VALUES ('older-image', 'offer', 'general', 'Made by an older image', '', 0, ?, ?, 1, 'active', '', 'general')`).run(ann.pk, new Date().toISOString());
            plain.prepare(`UPDATE posts SET title = 'Edited by an older image' WHERE id = 'older-image'`).run();
            return true;
        });
        plain.close();
        assert(wrote === true && row('older-image')?.free_tags === '', `a handle with no functions registered inserts and edits a post, and the default applies (${JSON.stringify(row('older-image')?.free_tags)})`);
        assert((await found(bea, q('older'))).includes('older-image'), 'and the listing is found and read as any other');
        db.prepare(`DELETE FROM posts WHERE id = 'older-image'`).run();
    } else {
        assert(false, `the node's file is under BEANPOOL_DATA_DIR (${dataDir})`);
    }

    // ── 2. the builder ────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. the builder ──');
    const built = words(postSearchKeywords('x', '', 'general', [], ['wi-fi router', 'limón', '2nd hand']));
    assert(['general', 'wi', 'fi', 'wifi', 'router', 'limón', '2nd', 'hand'].every(w => built.has(w)), `its words and the joined compound (${[...built].join(' ')})`);
    assert(postSearchKeywords('Fresh lemons', 'from the tree', 'food') === 'food', 'a listing with none has its category alone, as before');
    assert(postSearchKeywords('x', '', 'food', ['food.fruit.lemon']) === postSearchKeywords('x', '', 'food', ['food.fruit.lemon'], []), 'and a library tag alone is as before');
    const synonyms = words(generateSearchKeywords('Fresh lemons', '', 'food', [], ['heirloom']));
    assert(synonyms.has('heirloom') && synonyms.has('citrus'), `the boot's writer holds them beside the synonyms (${[...synonyms].join(' ')})`);

    // ── 3. the door ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. making a listing with free tags ──');
    const laptop = await offer(ann, 'A laptop', { freeTags: ['#2nd Hand', '2ND   hand', 'Limo\u0301n', '  ## Wi-Fi Router  ', 'Excellent Condition'] });
    const laptopId = laptop.body?.post?.id as string;
    assert(laptop.status === 200 && JSON.stringify(laptop.body.post.freeTags) === '["2nd hand","limón","wi-fi router","excellent condition"]',
        `stored as the rule says: no #, lower case, NFC with its accent, one space, the same tag once (${laptop.status} ${JSON.stringify(laptop.body?.post?.freeTags)})`);
    assert(row(laptopId)?.free_tags === '["2nd hand","limón","wi-fi router","excellent condition"]', `a JSON list in its own column (${row(laptopId)?.free_tags})`);
    assert(row(laptopId)?.tags === '', 'and nothing in the library\'s column');
    const reread = (await call('GET', bea, `/api/marketplace/posts?id=${laptopId}`)).body;
    assert(JSON.stringify(reread?.[0]?.freeTags) === JSON.stringify(laptop.body.post.freeTags), 'a reader gets them');
    const plain = await offer(ann, 'A plain chair');
    const plainId = plain.body?.post?.id as string;
    assert(plain.status === 200 && !('freeTags' in (plain.body.post ?? {})) && row(plainId)?.free_tags === '', 'a listing with none (an app older than F1) carries no field and stores \'\'');
    const none = await offer(ann, 'An empty list', { freeTags: [] });
    assert(none.status === 200 && !('freeTags' in (none.body.post ?? {})) && row(none.body.post.id)?.free_tags === '', '[] on a create is none');
    const nulled = await offer(ann, 'A null', { freeTags: null });
    assert(nulled.status === 200 && row(nulled.body.post.id)?.free_tags === '', 'null on a create is none');

    const refused: Array<[string, unknown, RegExp]> = [
        ['one letter', ['a'], /at least two letters or numbers/],
        ['an empty tag', [''], /at least two letters or numbers/],
        ['# alone', ['#'], /at least two letters or numbers/],
        ['emoji only', ['🍋🍋🍋'], /at least two letters or numbers/],
        ['31 characters', ['x'.repeat(31)], /30 characters at most/],
        ['five words', ['one two three four five'], /four words at most/],
        ['six tags', ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'], /^Five tags at most$/],
        ['an @handle', ['@ann'], /not a contact/],
        ['an email', ['ann@example.com'], /not a contact/],
        ['a phone number', ['0412 345 678'], /not a contact/],
        ['a phone number with a code', ['+61 412 345 678'], /not a contact/],
        ['a phone number in slashes', ['0412/345/678'], /not a contact/],
        ['seven digits', ['1234567'], /not a contact/],
        ['a web address', ['https://example.com'], /not a contact/],
        ['a bare domain', ['example.com'], /not a contact/],
        ['www', ['www.example.org'], /not a contact/],
        ['full-width digits', ['０４１２３４５６７８'], /not a contact/],
        ['a control character', ['ab\u0007cd'], /hidden characters/],
        ['a NUL', ['ab\u0000cd'], /hidden characters/],
        ['a text-direction override', ['ab\u202ecd'], /hidden characters/],
        ['a comma', ['wood, fire'], /a comma parts two tags/],
        ['a number in the list', [7], /must be a list of words/],
        ['text that is no list', ['2nd hand'][0], /must be a list of words/],
        ['too long together', ['a', 'b', 'c', 'd', 'e'].map(l => `${l}a${'🍋'.repeat(28)}`), /too long together/],
    ];
    const before = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
    for (const [what, freeTags, says] of refused) {
        const r = await offer(ann, `Refused: ${what}`, { freeTags });
        assert(r.status === 400 && says.test(String(r.body?.error)), `${what} is refused in words (${r.status} ${r.body?.error})`);
    }
    assert((db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c === before, 'and none of them was made');

    const fiveAndFive = await offer(ann, 'Five of each', {
        tags: ['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.apple', 'food.fruit.pear'],
        freeTags: ['aa', 'bb', 'cc', 'dd', 'ee', 'AA'],
    });
    assert(fiveAndFive.status === 200 && fiveAndFive.body.post.tags.length === 5 && fiveAndFive.body.post.freeTags.length === 5, `five of each, a sixth that repeats one being the same tag (${fiveAndFive.status})`);
    const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const event = await call('POST', ann, '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Gathering in the park', description: '', authorPublicKey: ann.pk, lat: -28.55, lng: 153.5,
        eventStartAt: inHours(48), eventEndAt: inHours(50), eventPlaceName: 'The park', photos: [TEST_PHOTO], freeTags: ['Barn Dance'],
    });
    const eventId = event.body?.post?.id as string;
    assert(event.status === 200 && JSON.stringify(event.body.post.freeTags) === '["barn dance"]', `an event carries them through its own door (${event.status} ${event.body?.error ?? ''})`);
    const refusedEvent = await call('POST', ann, '/api/marketplace/posts', {
        type: 'event', category: 'community', title: 'Refused gathering', description: '', authorPublicKey: ann.pk, lat: -28.55, lng: 153.5,
        eventStartAt: inHours(52), eventEndAt: inHours(54), eventPlaceName: 'The park', photos: [TEST_PHOTO], freeTags: ['ann@example.com'],
    });
    assert(refusedEvent.status === 400 && /not a contact/.test(String(refusedEvent.body?.error)), `and is held to the rule there (${refusedEvent.status})`);
    const poll = await call('POST', ann, '/api/marketplace/posts', {
        type: 'poll', category: 'general', title: 'Which barn dance day', description: '', authorPublicKey: ann.pk,
        pollOptions: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], durationDays: 7, freeTags: ['barn dance'],
    });
    const pollId = poll.body?.post?.id as string;
    assert(poll.status === 200 && !!pollId, `a poll takes them as it takes tags (${poll.status} ${poll.body?.error ?? ''})`);

    // ── 4. search ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. search finds a listing by a free tag\'s words ──');
    assert((await found(bea, q('hand'))).includes(laptopId), 'q=hand finds it: a word of a tag, not in its title or description');
    assert((await found(bea, q('excell'))).includes(laptopId), 'q=excell finds it: a prefix');
    assert((await found(bea, q('wifi'))).includes(laptopId), 'q=wifi finds "wi-fi router": the joined compound');
    assert((await found(bea, q('wi-fi'))).includes(laptopId), 'q=wi-fi finds it too, read as the phrase wi fi');
    assert((await found(bea, q('limon'))).includes(laptopId), 'q=limon finds "limón": accent-folded');
    assert((await found(bea, q('limón'))).includes(laptopId), 'q=limón finds it');
    assert((await found(bea, q('LIMÓN'))).includes(laptopId), 'in any case');
    assert((await found(bea, q('#limón'))).includes(laptopId), 'q=#limón finds it: a typed # is punctuation to the index');
    assert(!(await found(bea, q('hand'))).includes(plainId), 'and it does not find the listing without it');
    assert((await found(bea, `${q('barn')}&types=event`)).includes(eventId), 'an event, where the read asks for events');
    assert(!(await found(bea, q('barn'))).includes(pollId), 'polls stay out of a search, as they are');
    const chinese = await offer(ann, 'A computer', { freeTags: ['二手笔记本'] });
    const chineseId = chinese.body?.post?.id as string;
    assert((await found(bea, q('二手'))).includes(chineseId), 'a word of a language written without spaces, at its start: the index\'s prefix');
    assert((await found(bea, q('笔记本'))).includes(chineseId), 'and inside the run: the same scan a title gets');
    const typed = await offer(ann, 'Words typed in the title: heirloom seedlings');
    const inTitle = typed.body?.post?.id as string;
    const tagged = await offer(ann, 'Something else', { freeTags: ['heirloom seedlings'] });
    const inTag = tagged.body?.post?.id as string;
    const both = await found(bea, q('heirloom'));
    assert(both.includes(inTitle) && both.includes(inTag), 'a title word and a free tag are found by the one search');
    assert(row(inTag)?.search_keywords.includes('heirloom') === true && row(inTag)?.free_tags === '["heirloom seedlings"]', 'its words sit in search_keywords, the same FTS column as the library\'s');

    // ── 5. the filter ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the filter ──');
    assert((await call('GET', bea, '/api/marketplace/posts?free=nobody%20has%20this')).status === 200, 'a board of mostly untagged listings answers 200: json_each(\'\') throws, and the read does not');
    const byTag = await found(bea, free('2nd hand'));
    assert(byTag.includes(laptopId) && byTag.length === 1, `free= finds exactly the listing carrying it (${byTag.length})`);
    assert((await found(bea, free('2nd'))).length === 0, 'exact: a word of the tag is not the tag');
    assert((await found(bea, free('2nd han'))).length === 0, 'exact: a prefix is not the tag');
    assert((await found(bea, free('#2ND  Hand'))).includes(laptopId), 'read as it is stored: #, case and spaces are the same tag');
    assert((await found(bea, free('Limo\u0301n'))).includes(laptopId), 'and NFD is the same tag');
    assert((await found(bea, free('limon'))).length === 0, 'but an accent is part of the tag: "limon" is not "limón", as the design stores it');
    const two = await found(bea, free('2nd hand', 'heirloom seedlings'));
    assert(two.includes(laptopId) && two.includes(inTag) && two.length === 2, 'two are OR\'d');
    const lemon = await offer(ann, 'Library lemon', { tags: ['food.fruit.lemon'] });
    const lemonId = lemon.body?.post?.id as string;
    const anyOf = await found(bea, `${q('chair')}&${free('heirloom seedlings')}&tags=food.fruit.lemon`);
    assert(anyOf.includes(plainId) && anyOf.includes(inTag) && anyOf.includes(lemonId) && !anyOf.includes(laptopId), 'q OR free OR tags: a listing any of them finds');
    const qFree = await found(bea, `${q('chair')}&${free('heirloom seedlings')}`);
    assert(qFree.includes(plainId) && qFree.includes(inTag) && !qFree.includes(lemonId), 'q OR free alone');
    const tagFree = await found(bea, `tags=food.fruit.lemon&${free('heirloom seedlings')}`);
    assert(tagFree.includes(lemonId) && tagFree.includes(inTag) && !tagFree.includes(plainId), 'tags OR free alone');
    assert(!(await found(bea, free('barn dance'))).includes(pollId), 'a poll stays out of the filter');
    assert((await found(bea, `${free('barn dance')}&types=event`)).includes(eventId), 'an event is found by it where the read asks for events');
    const onlyPolls = await found(bea, `${free('barn dance')}&type=poll`);
    assert(onlyPolls.includes(pollId), 'a read that asks for polls alone gets one, as a search does');

    const stale = await call('GET', bea, `/api/marketplace/posts?${free('2nd hand')}`);
    addBlocks(bea.pk, [ann.pk]);
    const blockedRead = await call('GET', bea, `/api/marketplace/posts?${free('2nd hand')}`, undefined, stale.etag ? { 'If-None-Match': stale.etag } : {});
    assert(blockedRead.status === 200 && Array.isArray(blockedRead.body) && blockedRead.body.length === 0, `a blocked author's listing leaves the reader's filter, and a copy held from before is not confirmed (${blockedRead.status})`);
    removeBlock(bea.pk, ann.pk);
    db.prepare(`UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?`).run(new Date().toISOString(), laptopId);
    assert(!(await found(bea, free('2nd hand'))).includes(laptopId) && !(await found(bea, q('hand'))).includes(laptopId), 'a listing hidden by reports leaves the filter and the search');
    assert((await found(ann, free('2nd hand'))).includes(laptopId), 'but not for its author');
    db.prepare(`UPDATE posts SET hidden_by_reports_at = NULL WHERE id = ?`).run(laptopId);

    for (const [what, value] of [['six tags', 'aa,bb,cc,dd,ee,ff'], ['a contact', 'ann@example.com'], ['one letter', 'a'], ['a comma alone', ','], ['31 characters', 'x'.repeat(31)], ['a control character', 'a%07b']] as const) {
        const r = await call('GET', bea, `/api/marketplace/posts?free=${value.includes('%') ? value : encodeURIComponent(value)}`);
        assert(r.status === 400, `free= with ${what} is a 400 (${r.status} ${r.body?.error})`);
    }
    const twice = await call('GET', bea, '/api/marketplace/posts?free=aa&free=bb');
    assert(twice.status === 400, `free given twice is a 400 (${twice.status})`);
    db.prepare(`UPDATE posts SET free_tags = 'not json' WHERE id = ?`).run(plainId);
    const badRow = await call('GET', bea, `/api/marketplace/posts?${free('heirloom seedlings')}`);
    assert(badRow.status === 200 && Array.isArray(badRow.body) && badRow.body.length === 1, `a row that holds something that is not JSON cannot fail the read (${badRow.status})`);
    const badRead = await call('GET', bea, `/api/marketplace/posts?id=${plainId}`);
    assert(badRead.status === 200 && !('freeTags' in (badRead.body?.[0] ?? {})), 'and reads as none');
    db.prepare(`UPDATE posts SET free_tags = '' WHERE id = ?`).run(plainId);

    // ── 6. an edit ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. editing them ──');
    const edit = (freeTags: unknown) => call('POST', ann, '/api/marketplace/posts/update', { id: inTag, authorPublicKey: ann.pk, freeTags });
    const stamp = '2001-02-03T04:05:06.007Z';
    db.prepare(`UPDATE posts SET updated_at = ? WHERE id = ?`).run(stamp, inTag);
    let r = await edit(['Rare Breed', '#heirloom seedlings']);
    assert(r.status === 200 && row(inTag)?.free_tags === '["rare breed","heirloom seedlings"]' && words(row(inTag)?.search_keywords).has('rare'), `new tags give new words (${r.status} ${row(inTag)?.search_keywords})`);
    assert(JSON.stringify(r.body?.post?.freeTags) === '["rare breed","heirloom seedlings"]', 'the answer carries them');
    assert((row(inTag)?.updated_at ?? '') > stamp, 'and the edit moves updated_at, so a phone\'s delta and a standby see it');
    r = await edit(['rare breed']);
    assert(r.status === 200 && !words(row(inTag)?.search_keywords).has('heirloom'), `a tag taken off takes its words with it (${row(inTag)?.search_keywords})`);
    assert(!(await found(bea, q('heirloom'))).includes(inTag) && !(await found(bea, free('heirloom seedlings'))).includes(inTag), 'search and filter follow the edit');
    r = await call('POST', ann, '/api/marketplace/posts/update', { id: inTag, authorPublicKey: ann.pk, title: 'A new title' });
    assert(r.status === 200 && row(inTag)?.free_tags === '["rare breed"]' && words(row(inTag)?.search_keywords).has('rare'), 'an edit that names none keeps them and their words');
    r = await edit(['ann@example.com']);
    assert(r.status === 400 && /not a contact/.test(String(r.body?.error)) && row(inTag)?.free_tags === '["rare breed"]', `a refused edit writes nothing (${r.status} ${r.body?.error})`);
    r = await edit(['aa', 'bb', 'cc', 'dd', 'ee', 'ff']);
    assert(r.status === 400 && /Five tags at most/.test(String(r.body?.error)), `six on an edit are refused (${r.status})`);
    db.prepare(`UPDATE posts SET free_tags = '["x"]' WHERE id = ?`).run(inTag);
    r = await edit(['x', 'second tag']);
    assert(r.status === 200 && row(inTag)?.free_tags === '["x","second tag"]', `a tag the listing already holds passes, stored before a rule refused it (${r.status} ${r.body?.error ?? ''})`);
    r = await edit(['y']);
    assert(r.status === 400, `any other such tag is refused (${r.status})`);
    r = await edit([]);
    assert(r.status === 200 && row(inTag)?.free_tags === '' && !('freeTags' in (r.body?.post ?? {})) && !words(row(inTag)?.search_keywords).has('second'), '[] clears them and their words');
    await edit(['back again']);
    r = await edit(null);
    assert(r.status === 200 && row(inTag)?.free_tags === '', 'null clears them too');

    // ── 7. the two columns stay apart ─────────────────────────────────────────────────────────
    console.log('\n── 7. a free tag cannot reach a library id ──');
    const idAsFree = await offer(ann, 'An id typed as a tag', { freeTags: ['food.fruit.lemon'] });
    assert(idAsFree.status === 400, `a library id with its dots is refused as a typed tag (${idAsFree.status} ${idAsFree.body?.error})`);
    const typedLemon = await offer(ann, 'A typed word', { freeTags: ['lemon', 'food'] });
    const typedLemonId = typedLemon.body?.post?.id as string;
    assert(typedLemon.status === 200 && row(typedLemonId)?.tags === '' && !('tags' in (typedLemon.body.post ?? {})), 'a word that names a library tag is stored as a typed tag, and the library\'s column stays empty');
    assert(!(await found(bea, 'tags=food.fruit.lemon')).includes(typedLemonId), 'tags=food.fruit.lemon does not find it');
    assert(!(await found(bea, 'tags=food')).includes(typedLemonId), 'tags=food does not find a typed "food": an id that is one word is no bridge either');
    assert(!(await found(bea, q('citrus'))).includes(typedLemonId), 'it gets none of the library\'s words: an alias of lemon does not find it');
    assert((await found(bea, q('lemon'))).includes(typedLemonId), 'its own word does');
    assert(!(await found(bea, free('lemon'))).includes(lemonId), 'and the reverse: free=lemon does not find a listing tagged lemon from the library');
    const freeAsId = await offer(ann, 'Words sent as a library tag', { tags: ['2nd hand'] });
    assert(freeAsId.status === 400 && /There is no tag/.test(String(freeAsId.body?.error)), `words sent as a library id are refused (${freeAsId.status} ${freeAsId.body?.error})`);
    r = await call('POST', ann, '/api/marketplace/posts/update', { id: typedLemonId, authorPublicKey: ann.pk, tags: ['food.eggs'] });
    assert(r.status === 200 && row(typedLemonId)?.tags === 'food.eggs' && row(typedLemonId)?.free_tags === '["lemon","food"]', 'an edit of one column leaves the other');

    // ── 8. a standby ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 8. a standby\'s copy carries them ──');
    const heldLaptop = row(laptopId)?.free_tags;
    const p2p = await startP2P(0, 0);
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4294/p2p/${nodeId}`);
    const payload: any = await exportSyncState(nodeId);
    const exLaptop = (payload.posts ?? []).find((p: any) => p.id === laptopId);
    const exPlain = (payload.posts ?? []).find((p: any) => p.id === plainId);
    assert(JSON.stringify(exLaptop?.freeTags) === '["2nd hand","limón","wi-fi router","excellent condition"]' && !!exPlain && !('freeTags' in exPlain),
        `the export carries them, and no field for a listing with none (${JSON.stringify(exLaptop?.freeTags)})`);
    db.prepare(`UPDATE posts SET free_tags = '', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(laptopId);
    db.prepare('DELETE FROM post_photos WHERE post_id = ?').run(chineseId);
    db.prepare('DELETE FROM posts WHERE id = ?').run(chineseId);
    const importing = async (p: unknown) => {
        setNodeRole('backup');
        try { await importRemoteState(p as any); } catch (e: any) { console.error(`  (import threw: ${e?.message})`); }
        setNodeRole('primary');
    };
    await importing(payload);
    assert(row(laptopId)?.free_tags === heldLaptop, `the standby holds the bytes the main server holds, which their hash reads (update) (${row(laptopId)?.free_tags})`);
    assert(row(chineseId)?.free_tags === '["二手笔记本"]' && (await found(bea, q('笔记本'))).includes(chineseId), `and a listing it never had, found by them (insert) (${row(chineseId)?.free_tags})`);
    // A copy is signed, so what it carries is set on the row it is made from, the row then taken back to something else.
    const copyHolding = async (stored: string): Promise<unknown> => {
        db.prepare(`UPDATE posts SET free_tags = ?, updated_at = ? WHERE id = ?`).run(stored, new Date(Date.now() + 60_000).toISOString(), laptopId);
        const copy = await exportSyncState(nodeId);
        db.prepare(`UPDATE posts SET free_tags = '["ab"]', updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(laptopId);
        return copy;
    };
    await importing(await copyHolding('["Second copy","ann@example.com","ok tag",7,"x","' + 'a'.repeat(31) + '"]'));
    assert(row(laptopId)?.free_tags === '["second copy","ok tag"]', `a copy is held to the rule, the rest kept (${row(laptopId)?.free_tags})`);
    const notAList: any = await copyHolding('{"a":1}');
    assert(!('freeTags' in ((notAList.posts ?? []).find((p: any) => p.id === laptopId) ?? {})), 'a row holding no list exports no field');
    await importing(notAList);
    assert(row(laptopId)?.free_tags === '', `and arrives as none (${row(laptopId)?.free_tags})`);
    const olderMain: any = await copyHolding('');
    assert(!('freeTags' in ((olderMain.posts ?? []).find((p: any) => p.id === laptopId) ?? {})), 'a listing with none says nothing, as a main server older than F1 says nothing of any');
    await importing(olderMain);
    assert(row(laptopId)?.free_tags === '', 'and a payload that says nothing leaves none: plain assignment, so a tag taken off on the main server is off here too');
    const shown = (await call('GET', bea, `/api/marketplace/posts?id=${laptopId}`)).body?.[0];
    assert(shown?.title === 'A laptop' && !('freeTags' in shown), 'and the listing reads as it did before F1');
    db.prepare(`UPDATE posts SET free_tags = ? WHERE id = ?`).run(heldLaptop, laptopId);
    await p2p.stop();

    // ── 9. a peer ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 9. a linked community\'s listings carry them ──');
    const PEER = '12D3KooWFreeTagsPeer00000000000000000000000000000000';
    db.prepare(`UPDATE posts SET reach = 'everywhere' WHERE id IN (?, ?)`).run(laptopId, plainId);
    const offered = listingsForPeer(PEER);
    const offLaptop = offered.find(l => l.id === laptopId), offPlain = offered.find(l => l.id === plainId);
    assert(JSON.stringify(offLaptop?.freeTags) === JSON.stringify(JSON.parse(heldLaptop ?? '[]')) && !!offPlain && !('freeTags' in offPlain),
        `the listings offered to a peer carry them, none on a listing without (${JSON.stringify(offLaptop?.freeTags)})`);
    const remoteAuthor = newId('Remy').pk;
    const remote = (id: string, title: string, freeTags?: unknown, tags?: unknown) => ({
        id, type: 'offer', category: 'general', title, description: '', credits: 0, priceType: 'fixed', authorPublicKey: remoteAuthor,
        authorCallsign: 'Remy', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...(freeTags !== undefined ? { freeTags } : {}), ...(tags !== undefined ? { tags } : {}),
    });
    const cached = cacheRemoteListings(PEER, 'https://peer.example', [
        remote('r1', 'Old books', ['#Rare Books', 'me@example.com', '0412 345 678', 'https://example.com', 7, 'x', 'first edition', 'aa', 'bb', 'cc', 'dd']),
        remote('r2', 'An old peer\'s listing'),
        remote('r3', 'Garbage in the field', { not: 'a list' }),
        remote('r4', 'Tries to reach a library id', ['food.fruit.lemon', 'lemon'], ['2nd hand', 'food.fruit.lime']),
    ]);
    const rows = db.prepare(`SELECT id, title, tags, free_tags, search_keywords FROM posts WHERE origin_node = ?`).all('https://peer.example') as any[];
    const peerRow = (title: string) => rows.find(p => p.title === title);
    assert(cached.cached === 4 && peerRow('Old books')?.free_tags === '["rare books","first edition","aa","bb","cc"]',
        `held to the rule on the way in: contacts and garbage left out, five at most (${peerRow('Old books')?.free_tags})`);
    assert(peerRow('An old peer\'s listing')?.free_tags === '', 'a peer older than F1 sends none, and its listing is cached as before');
    assert(peerRow('Garbage in the field')?.free_tags === '', 'a field that is no list is none, and costs one field, not the listing');
    assert(peerRow('Tries to reach a library id')?.free_tags === '["lemon"]' && peerRow('Tries to reach a library id')?.tags === 'food.fruit.lime',
        `an id in the typed field is left out, words in the id field are left out, and the columns stay apart (${peerRow('Tries to reach a library id')?.free_tags} / ${peerRow('Tries to reach a library id')?.tags})`);
    assert(words(peerRow('Old books')?.search_keywords).has('edition'), `its words are written as it is cached (${peerRow('Old books')?.search_keywords})`);
    const peerIds = attempt(() => getPosts({ query: 'edition', viewerPubkey: bea.pk, limit: 200 }).map(p => p.id)) ?? [];
    const peerFiltered = attempt(() => getPosts({ free: ['first edition'], viewerPubkey: bea.pk, limit: 200 }).map(p => p.id)) ?? [];
    assert(peerIds.includes(peerRow('Old books')?.id) && peerFiltered.includes(peerRow('Old books')?.id), 'and it is found by them and by the filter');

    // ── 10. the boot's writers, a deleted member, a visitor ───────────────────────────────────
    console.log('\n── 10. the boot, a deleted member, a visitor ──');
    db.prepare(`DELETE FROM node_config WHERE key = 'migration_search_keywords_tags_v1'`).run();
    db.prepare(`UPDATE posts SET search_keywords = 'stale' WHERE id = ?`).run(typedLemonId);
    attempt(() => keywordsWithTagsOnce());
    assert(words(row(typedLemonId)?.search_keywords).has('lemon'), `the once-only pass writes a listing's words with its typed tags (${row(typedLemonId)?.search_keywords})`);
    db.prepare(`UPDATE posts SET search_keywords = '' WHERE id = ?`).run(typedLemonId);
    attempt(() => initStateEngine());
    assert(words(row(typedLemonId)?.search_keywords).has('lemon'), `so does the boot's backfill of a listing with no words (${row(typedLemonId)?.search_keywords})`);
    const stranger = member('Dee');
    const doomed = await offer(stranger, 'Soon gone', { freeTags: ['leaves with me'] });
    const doomedId = doomed.body?.post?.id as string;
    assert((await found(bea, free('leaves with me'))).includes(doomedId), 'a member\'s listing is found by its tag');
    db.transaction(() => scrubPostsOf(stranger.pk, new Date().toISOString()))();
    assert(row(doomedId)?.free_tags === '' && !words(row(doomedId)?.search_keywords).has('leaves'), `a deleted member's tags go with their words (${row(doomedId)?.search_keywords})`);
    assert((await found(bea, free('leaves with me'))).length === 0 && !(await found(bea, q('leaves'))).includes(doomedId), 'and neither the filter nor the search finds it');
    const pollster = member('Eli');
    const hisPoll = await call('POST', pollster, '/api/marketplace/posts', {
        type: 'poll', category: 'general', title: 'Which day suits', description: '', authorPublicKey: pollster.pk,
        pollOptions: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], durationDays: 7, tags: ['food.eggs'], freeTags: ['my own words'],
    });
    const hisPollId = hisPoll.body?.post?.id as string;
    db.prepare(`UPDATE posts SET updated_at = ? WHERE id = ?`).run(stamp, hisPollId);
    db.transaction(() => scrubPostsOf(pollster.pk, new Date().toISOString()))();
    const pollAfter = db.prepare('SELECT title, tags, free_tags, search_keywords, updated_at FROM posts WHERE id = ?').get(hisPollId) as any;
    assert(hisPoll.status === 200 && pollAfter?.title === 'Which day suits' && pollAfter?.tags === 'food.eggs', 'a poll\'s question stays, the community\'s record');
    assert(pollAfter?.free_tags === '' && !words(pollAfter?.search_keywords).has('words') && words(pollAfter?.search_keywords).has('poultry'),
        `but the tags its author typed go with their words, and a library tag's stay (${pollAfter?.search_keywords})`);
    assert(pollAfter?.updated_at > stamp, 'stamped, so a standby\'s delta carries it');
    const seen = (await call('GET', bea, `/api/marketplace/posts?id=${typedLemonId}`)).body?.[0];
    assert(JSON.stringify(guestPost(seen)?.freeTags) === '["lemon","food"]', 'public with the listing: a visitor\'s copy keeps them');

    // ── 11. the filter on 5,000 listings ──────────────────────────────────────────────────────
    console.log('\n── 11. the free= filter measured on 5,000 listings ──');
    const pool = ['2nd hand', 'excellent condition', 'barn dance', 'wi-fi router', 'limón', 'rare books'];
    const insert = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, active, status, free_tags, search_keywords)
                               VALUES (?, 'offer', 'general', ?, '', 0, ?, 1, 'active', ?, 'general')`);
    db.transaction(() => {
        for (let i = 0; i < 5000; i++) {
            const tags = i % 3 === 0 ? '' : JSON.stringify([pool[i % pool.length], pool[(i * 7 + 1) % pool.length]].filter((t, k, a) => a.indexOf(t) === k));
            insert.run(`bulk-${i}`, `Bulk listing ${i}`, ann.pk, tags);
        }
    })();
    const total = (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as any).c;
    const time = (fn: () => unknown, runs = 25): number => {
        const ms: number[] = [];
        for (let i = 0; i < runs; i++) { const t = process.hrtime.bigint(); fn(); ms.push(Number(process.hrtime.bigint() - t) / 1e6); }
        return ms.sort((a, b) => a - b)[Math.floor(runs / 2)];
    };
    const filterOnly = time(() => db.prepare(`SELECT COUNT(*) FROM posts p WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(p.free_tags) THEN p.free_tags END) WHERE value IN (?))`).get('limón'));
    const likeTags = time(() => db.prepare(`SELECT COUNT(*) FROM posts p WHERE (' ' || p.tags || ' ') LIKE ? OR (' ' || p.tags || ' ') LIKE ?`).get('% food.fruit %', '% food.fruit.%'));
    const page = time(() => getPosts({ free: ['limón'], viewerPubkey: bea.pk, limit: 50 }));
    const pageNone = time(() => getPosts({ viewerPubkey: bea.pk, limit: 50 }));
    const pageAll = time(() => getPosts({ query: 'lemon', tags: ['food.fruit.lemon'], free: ['limón'], viewerPubkey: bea.pk, limit: 50 }));
    console.log(`  MEASURED (${total} listings, median of 25): the json_each filter alone ${filterOnly.toFixed(2)} ms (T2's tag LIKE on the same rows ${likeTags.toFixed(2)} ms);`
        + ` a page of 50 by free= ${page.toFixed(2)} ms, with no filter ${pageNone.toFixed(2)} ms, q+tags+free ${pageAll.toFixed(2)} ms`);
    assert(filterOnly < 50 && page < 250, `the filter stays cheap on ${total} listings (json_each ${filterOnly.toFixed(2)} ms, page ${page.toFixed(2)} ms)`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
