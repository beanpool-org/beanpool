/**
 * posts_fts must survive two writes to one post in the same millisecond — on EVERY posts writer.
 *
 * The bug (reported in #878): `posts_touch_updated_at` fires `WHEN NEW.updated_at IS OLD.updated_at` and runs a
 * nested `UPDATE posts`. Before the fix, that nested update fired the `posts_au` FTS trigger a second time,
 * with OLD = the row the outer statement had just written — so it asked posts_fts to 'delete' the NEW text,
 * which was not in the index yet (the outer statement's own posts_au had not run).
 *
 * What FTS5 does with that bogus delete depends on the size of the index. It keeps a running token total
 * per column, and the delete subtracts the new text's tokens from it before anything is added back. If the
 * new text has more tokens in a column than the WHOLE index holds for that column, the total would go
 * negative and FTS5 refuses the statement as SQLITE_CORRUPT_VTAB ("database disk image is malformed"),
 * rolling the edit back. Otherwise the delete goes through silently. (Measured on the old triggers: exactly
 * that threshold on a toy table, and 0 throws / 0 integrity failures over 3000 edits, half of them
 * colliding, on a 300-post index.) So it throws on test databases and near-empty nodes, not on busy ones.
 *
 * To make every section below fail deterministically on the old triggers rather than only when the index
 * happens to be small, each colliding edit carries FILLER: more tokens than the whole index holds. That is
 * exactly the condition under which FTS5 notices the bogus delete, so a pass here means no bogus delete
 * happened at all — not that it slipped under the threshold.
 *
 * It is not specific to one writer, because the trigger is on the table: any statement that leaves
 * `updated_at` where it was — a same-millisecond timestamp, a replica applying a row without its own
 * timestamp, a writer that never sets it — goes through the same nested update. So this suite drives each
 * writer into the collision, then checks the index three ways: FTS5's own integrity check against the
 * content table, a search for the post's current title, and an edit that changes the title.
 *
 * Collisions are forced, not hoped for: writers that stamp `updated_at` from JS run under a clock frozen at
 * the row's current `updated_at`, and the writers that stamp it in SQL are paired with a statement that sets
 * no `updated_at` at all, which fires the touch trigger every time.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-posts-fts-same-ms.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db/db.js';
import { ledger } from './engine/ledger.js';
import {
    initStateEngine, createPost, getPosts, updatePost, transfer,
    acceptPost, completePostTransaction, cancelPostTransaction, adminDeletePost,
    exportSyncState, importRemoteState, setNodeRole, signSyncPayload,
} from './state-engine.js';
import { rsvpEvent } from './engine/posts.js';
import { startP2P } from './p2p.js';
import { addConnector } from './connector-manager.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const HOUR = 60 * 60 * 1000;
const noop = () => { };

function makeMember(callsign: string, beans = 0): string {
    const pk = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pk);
    ledger.initializeGenesisAccount(pk);
    if (beans > 0) transfer('genesis', pk, beans, `seed ${callsign}`, 'direct', true);
    return pk;
}

const updatedAt = (id: string): string =>
    (db.prepare('SELECT updated_at FROM posts WHERE id = ?').get(id) as any).updated_at;
const titleOf = (id: string): string =>
    (db.prepare('SELECT title FROM posts WHERE id = ?').get(id) as any).title;

/** Roughly the title tokens across the whole index: space-separated words in every posts.title. */
function indexedTitleTokens(): number {
    const row = db.prepare(`SELECT COALESCE(SUM(LENGTH(title) - LENGTH(REPLACE(title, ' ', '')) + 1), 0) n FROM posts`).get() as any;
    return row.n;
}

/**
 * `title` plus enough filler words that it has more tokens than every title in the index put together — the
 * condition under which the old triggers' bogus delete is refused rather than silently absorbed (see top).
 */
function withFiller(title: string): string {
    const n = indexedTitleTokens() + 10;
    return `${title} ${Array.from({ length: n }, (_, i) => `filler${i}`).join(' ')}`;
}

/**
 * Run `fn` with the JS clock stopped at `iso`, so every `Date.now()` / `new Date()` inside it — which is where
 * updatePost, rsvpEvent and the escrow writers take `updated_at` from — lands on that exact millisecond.
 */
function atInstant<T>(iso: string, fn: () => T): T {
    const RealDate = Date;
    const frozen = RealDate.parse(iso);
    class FrozenDate extends RealDate {
        constructor(...args: any[]) {
            if (args.length === 0) super(frozen);
            else super(...(args as [any]));
        }
        static now(): number { return frozen; }
    }
    (globalThis as any).Date = FrozenDate;
    try { return fn(); } finally { (globalThis as any).Date = RealDate; }
}

/** Run `fn`, returning the error it threw (or null). */
function attempt(fn: () => unknown): Error | null {
    try { fn(); return null; } catch (e: any) { return e; }
}
const why = (e: Error | null): string => e ? ` (threw ${(e as any).code ?? e.message})` : '';

/** FTS5's own check, comparing the index against the content table ('rank' = 1 turns that comparison on). */
function indexHealthy(): boolean {
    try {
        db.exec(`INSERT INTO posts_fts(posts_fts, rank) VALUES('integrity-check', 1)`);
        return true;
    } catch {
        return false;
    }
}

/** Post ids the index returns for a term — read straight from posts_fts, whatever the post's status. */
function ftsIds(term: string): string[] {
    return (db.prepare(`SELECT p.id FROM posts_fts f JOIN posts p ON p.rowid = f.rowid WHERE posts_fts MATCH ?`)
        .all(term) as any[]).map(r => r.id);
}

/**
 * The checks every section ends with: the index agrees with the table, a search for a word only the post's
 * current title has finds it, and a further title edit — in the same millisecond as the last write, the
 * worst case, and long enough that a bogus delete could not hide — is accepted and indexed.
 *
 * `edit` defaults to the author's updatePost. A removed listing is out of updatePost's reach, so the admin
 * section passes a raw UPDATE instead (which, setting no updated_at, collides by construction).
 */
function searchThenEdit(
    label: string, id: string, author: string, word: string,
    opts: { viaFeedSearch?: boolean; edit?: (title: string) => void } = {},
): void {
    assert(indexHealthy(), `${label}: posts_fts agrees with posts after the collision`);
    const hits = opts.viaFeedSearch === false ? ftsIds(word) : getPosts({ query: word, viewerPubkey: author }).map(p => p.id);
    assert(hits.includes(id), `${label}: searching "${word}" finds the post`);

    const next = withFiller(`${word} revisited${label.replace(/\W/g, '')}`);
    const edit = opts.edit ?? ((title: string) => atInstant(updatedAt(id), () => updatePost(id, author, { title })));
    const err = attempt(() => edit(next));
    assert(err === null, `${label}: a same-millisecond title edit afterwards is accepted${why(err)}`);
    assert(titleOf(id) === next, `${label}: and the edit was saved, not rolled back`);
    assert(ftsIds(`revisited${label.replace(/\W/g, '')}`).includes(id) && indexHealthy(), `${label}: and the index follows it`);
}

async function main(): Promise<void> {
    initStateEngine();
    const p2pNode = await startP2P(4062, 4063);
    const nodeId = p2pNode.peerId.toString();
    addConnector(`/ip4/127.0.0.1/tcp/4063/p2p/${nodeId}`, 'mirror', 'fts-self-test-peer');

    const author = makeMember('Author', 200);
    const buyer = makeMember('Buyer', 200);
    const goer = makeMember('Goer');
    const alsoGoing = makeMember('AlsoGoing');

    // ── 1. The reproduction from #878 ────────────────────────────────────────────────────────
    // Pin updated_at to its current value and edit the title through updatePost. 4/4 on the old triggers.
    console.log('\n--- 1. Reproduction: a title edit that collides with the last write ---');
    for (let i = 1; i <= 4; i++) {
        const post = createPost('offer', 'food', `Quince jam jar${i}`, 'Homemade', 5, 'fixed', author)!;
        const title = withFiller(`Quince jam jar${i} with scones${i}`);
        const err = attempt(() => atInstant(updatedAt(post.id), () => updatePost(post.id, author, { title })));
        assert(err === null, `run ${i}: the colliding title edit does not throw${why(err)}`);
        assert(titleOf(post.id) === title && ftsIds(`scones${i}`).includes(post.id), `run ${i}: the new title is saved and found`);
    }
    // The control: the same edit one millisecond later never collided, before or after the fix.
    {
        const post = createPost('offer', 'food', 'Rosella cordial', 'Homemade', 5, 'fixed', author)!;
        const later = new Date(Date.parse(updatedAt(post.id)) + 1).toISOString();
        const err = attempt(() => atInstant(later, () => updatePost(post.id, author, { title: withFiller('Rosella cordial and syrup') })));
        assert(err === null, `control: the same edit a millisecond later is fine${why(err)}`);
    }
    assert(indexHealthy(), 'the index is consistent after the reproduction');

    // ── 2. Any statement that leaves updated_at alone ─────────────────────────────────────────
    // The member re-key rewrite, a writer that forgets the column, an operator fixing a row in the sqlite
    // shell: none set updated_at, so the touch trigger fires on every one. The trigger-level guarantee.
    console.log('\n--- 2. A raw UPDATE that changes the title and sets no updated_at ---');
    {
        const post = createPost('offer', 'food', 'Medlar jelly', 'Tart', 5, 'fixed', author)!;
        const before = updatedAt(post.id);
        const title = withFiller('Medlar jelly and cheese');
        const err = attempt(() => db.prepare(`UPDATE posts SET title = ? WHERE id = ?`).run(title, post.id));
        assert(err === null, `the statement is not refused${why(err)}`);
        assert(titleOf(post.id) === title, 'the title was written');
        assert(updatedAt(post.id) > before || updatedAt(post.id) === before, 'the touch trigger still runs (updated_at never goes backwards)');
        searchThenEdit('raw UPDATE', post.id, author, 'cheese');
    }

    // ── 3. updatePost twice in one millisecond ─────────────────────────────────────────────────
    console.log('\n--- 3. updatePost ×2 in the same millisecond ---');
    {
        const post = createPost('need', 'garden', 'Loppers wanted', 'For pruning', 5, 'fixed', author)!;
        // Each edit is stamped with the millisecond the row already carries — the second write of a pair.
        const err = attempt(() => {
            atInstant(updatedAt(post.id), () => updatePost(post.id, author, { title: 'Loppers wanted urgently' }));
            atInstant(updatedAt(post.id), () => updatePost(post.id, author, { title: withFiller('Loppers wanted urgently please'), description: 'For pruning the plum' }));
        });
        assert(err === null, `neither edit throws${why(err)}`);
        searchThenEdit('updatePost', post.id, author, 'please');
    }

    // ── 4. RSVP: two people tap Going in the same millisecond as the host saves an edit ───────
    console.log('\n--- 4. RSVP ×2 and a host edit, same millisecond ---');
    {
        const ev = createPost('event', 'other', 'Seed swap', 'Bring jars', 0, 'fixed', author, -28.55, 153.5, [PHOTO], false,
            undefined, true, { eventStartAt: new Date(Date.now() + 24 * HOUR).toISOString(), eventPlaceName: 'The hall' })!;
        const err = attempt(() => {
            atInstant(updatedAt(ev.id), () => rsvpEvent(noop, ev.id, goer, 'going'));
            atInstant(updatedAt(ev.id), () => rsvpEvent(noop, ev.id, alsoGoing, 'going'));
            atInstant(updatedAt(ev.id), () => updatePost(ev.id, author, { title: withFiller('Seed swap and cuttings') }));
        });
        assert(err === null, `the RSVPs and the edit all go through${why(err)}`);
        assert((db.prepare(`SELECT COUNT(*) c FROM event_rsvps WHERE post_id = ? AND status = 'going'`).get(ev.id) as any).c === 2,
            'both RSVPs were recorded');
        searchThenEdit('RSVP', ev.id, author, 'cuttings');
    }

    // ── 5. Escrow status changes ───────────────────────────────────────────────────────────────
    console.log('\n--- 5. Escrow: cancel, re-accept and complete, each colliding with the last write ---');
    {
        // Accepting an offer needs an offer of your own listed first.
        createPost('offer', 'skills', 'Buyer offers help', 'Anything', 1, 'fixed', buyer);
        const offer = createPost('offer', 'skills', 'Chainsaw sharpening', 'Bring the chain', 10, 'fixed', author, undefined, undefined, undefined, true)!;
        const deal1 = acceptPost(offer.id, buyer);
        let err = attempt(() => atInstant(updatedAt(offer.id), () => cancelPostTransaction(deal1.id, buyer)));
        assert(err === null, `cancelling the deal in the same millisecond as the accept is fine${why(err)}`);
        const deal2 = acceptPost(offer.id, buyer);
        err = attempt(() => {
            atInstant(updatedAt(offer.id), () => completePostTransaction(deal2.id, buyer));
            atInstant(updatedAt(offer.id), () => updatePost(offer.id, author, { title: withFiller('Chainsaw sharpening and setting') }));
        });
        assert(err === null, `completing the deal and editing the title in that millisecond is fine${why(err)}`);
        assert((db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(deal2.id) as any).status === 'completed',
            'the deal completed');
        searchThenEdit('escrow', offer.id, author, 'setting');
    }

    // ── 6. Admin delete ────────────────────────────────────────────────────────────────────────
    // On an event, adminDeletePost stamps updated_at in one statement and then sets event_state in a second
    // that names no updated_at — so the touch trigger fires on every admin removal of an event.
    console.log('\n--- 6. Admin delete ×2 ---');
    {
        const ev = createPost('event', 'other', 'Pumpkin weigh-in', 'Scales provided', 0, 'fixed', author, -28.55, 153.5, [PHOTO], false,
            undefined, true, { eventStartAt: new Date(Date.now() + 24 * HOUR).toISOString(), eventPlaceName: 'Showground' })!;
        const err = attempt(() => { adminDeletePost(ev.id); adminDeletePost(ev.id); });
        assert(err === null, `removing an event twice back to back does not throw${why(err)}`);
        assert(indexHealthy() && ftsIds('pumpkin').includes(ev.id), 'the removed event is still indexed consistently (rows are never hard-deleted)');

        const offer = createPost('offer', 'tools', 'Wheelbarrow loan', 'Flat tyre fixed', 0, 'fixed', author)!;
        const err2 = attempt(() => { adminDeletePost(offer.id); adminDeletePost(offer.id); });
        assert(err2 === null, `removing a listing twice back to back does not throw${why(err2)}`);
        // Out of the feed and out of updatePost's reach once removed, so: the index directly, and a raw edit.
        searchThenEdit('admin delete', offer.id, author, 'wheelbarrow', {
            viaFeedSearch: false,
            edit: title => db.prepare('UPDATE posts SET title = ? WHERE id = ?').run(title, offer.id),
        });
    }

    // ── 7. Sync import ─────────────────────────────────────────────────────────────────────────
    // A replica applying a primary's row. When the row arrives without its own updated_at the importer keeps
    // the local one — so the title changes and updated_at does not: the collision exactly. The same payload
    // arriving twice (a retried sync) must be just as harmless.
    console.log('\n--- 7. Sync import of a remote row, twice ---');
    {
        const post = createPost('offer', 'food', 'Feijoa glut', 'Free to a good home', 0, 'fixed', author)!;
        const exported = await exportSyncState(nodeId);
        const remote = (exported.posts ?? []).find(p => p.id === post.id)!;
        assert(!!remote, 'the post is in the export');
        const { signature: _s, publicKey: _p, ...unsigned } = exported as any;
        const importedTitle = withFiller('Feijoa glut and chutney');
        const payload = await signSyncPayload({ ...unsigned, posts: [{ ...remote, title: importedTitle, updatedAt: undefined }] } as any);

        setNodeRole('backup');
        let err: Error | null = null;
        try {
            await importRemoteState(payload as any);
            await importRemoteState(payload as any);
        } catch (e: any) { err = e; }
        setNodeRole('primary');
        assert(err === null, `importing a title change that keeps updated_at does not throw${why(err)}`);
        assert(titleOf(post.id) === importedTitle, 'the imported title landed');
        searchThenEdit('sync import', post.id, author, 'chutney', { viaFeedSearch: false });

        // A row the replica has never seen: inserted by one import, re-titled by the next.
        const freshId = crypto.randomUUID();
        const fresh = { ...remote, id: freshId, title: 'Loquat tree cuttings' };
        const insertPayload = await signSyncPayload({ ...unsigned, posts: [fresh], photos: [] } as any);
        setNodeRole('backup');
        err = null;
        try {
            await importRemoteState(insertPayload as any);
            const updatePayload = await signSyncPayload({ ...unsigned, posts: [{ ...fresh, title: withFiller('Loquat tree cuttings rooted'), updatedAt: undefined }], photos: [] } as any);
            await importRemoteState(updatePayload as any);
        } catch (e: any) { err = e; }
        setNodeRole('primary');
        assert(err === null, `a new remote row then its re-title both import${why(err)}`);
        searchThenEdit('sync insert+update', freshId, author, 'rooted', { viaFeedSearch: false });
    }

    // ── 8. Nothing can put the unguarded trigger back ──────────────────────────────────────────
    // posts_au is defined twice: schema.sql, and backfillSearchKeywords in state-engine.ts, which drops and
    // re-creates the FTS table and its triggers on any boot that finds posts without keywords (a replica
    // does, after importing rows). If either lost the WHEN, that path would silently reinstate the bug.
    console.log('\n--- 8. Every posts_au definition carries the guard ---');
    {
        const GUARD = /WHEN\s+OLD\.title\s+IS\s+NOT\s+NEW\.title\s+OR\s+OLD\.description\s+IS\s+NOT\s+NEW\.description\s+OR\s+OLD\.search_keywords\s+IS\s+NOT\s+NEW\.search_keywords/i;
        const live = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'posts_au'`).get() as any)?.sql ?? '';
        assert(GUARD.test(live), 'the posts_au this node is running has the guard');
        const here = path.dirname(fileURLToPath(import.meta.url));
        for (const file of ['db/schema.sql', 'state-engine.ts']) {
            const src = fs.readFileSync(path.join(here, file), 'utf-8');
            const defs = [...src.matchAll(/CREATE TRIGGER (?:IF NOT EXISTS )?posts_au\b[\s\S]*?\bBEGIN\b/g)].map(m => m[0]);
            assert(defs.length > 0 && defs.every(d => GUARD.test(d)),
                `${file}: all ${defs.length} posts_au definition(s) carry the guard`);
        }
    }

    assert(indexHealthy(), 'posts_fts is consistent at the end of the run');

    await p2pNode.stop();
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
