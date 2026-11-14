/**
 * This community's typed tags, offered as members type, and the owners' and admins' rules on them
 * (DESIGN-tags-free-entry-fable.md §3 and §5, slice F3): engine/free-tags.ts, GET /api/free-tags, and
 * /api/local/admin/free-tags. Members and admins act over REAL HTTPS through the real signature and admin middleware.
 *
 *   1. the threshold both ways: one author's new listing is not offered; a second author's is; one author's tag a week
 *      old with no open report is; the same with an open report is not
 *  1b. the week is one listing's own with the word, not the listing's age: an author who edits a new word onto a
 *      month-old listing waits the week (a fake clock), so does one whose listing was paused long ago and came back, and a
 *      word whose listing was taken down starts again at its next edit; a second author's edit offers it at once; the
 *      Manager's first seen is that time
 *  1c. a report and a takedown follow the word (real routes): an author who moves a reported word to a new listing and
 *      takes it off, or deletes, the reported one waits while the report is open and the new listing's own week; a
 *      moderator's takedown holds the author's copy elsewhere for a week, counted from the takedown even when the report is
 *      upheld 8 or 6 days after the author moved the word away; a deleted account's listings keep no day
 *   2. what is counted: a listing hidden by reports, taken down, inactive, cancelled, a group's or one person's, a peer's,
 *      or by a paused or suspended author lends nothing
 *   3. the count is made at most once a minute, and a rule set is seen at once
 *   4. members only: unsigned 401, a stranger 403, a paused member 403; the answer is the offered tags, most used first
 *   5. the owners' and admins' page: counts and first seen, never who; a moderator and a stranger refused
 *   6. hide: never offered; merge: offered as the library tag whatever its counts; clear: as before; every change an ADMIN
 *      line, a rule standing already changes nothing; garbage refused in words; a token cannot set one
 *   7. a standby: the rule table is a plain table its copy carries, a cleared rule a tombstone; a standby refuses a rule
 *   8. the table (real routes): for each way the word leaves a reported listing (edit off, pause, delete, a moderator's
 *      takedown, a report-hide) × the uphold before the move, 3 or 8 days after it, with or without taking it down, or the
 *      report left open: the author's copy elsewhere is not offered until a week after the latest of the move and the
 *      uphold, nor ever while the report is open; the unreported control is offered after its own week
 *   9. "Did you mean …?" (slice F5): GET /api/free-tags?q= names the library tag a word is the label of in any of the 25
 *      languages: a Portuguese, Russian or Japanese label on a Spanish device, with or without its accents, a plural; none
 *      for a top's label, an unknown word, a word no listing could carry, two q's; members only; the map's size and heap
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-free-tag-suggestions.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the node's own self-signed certificate

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, setNodeRole, grantNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { localFetch } from './keepalive-test-fetch.js';
import { setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTO } from './post-test-helper.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { TABLES } from './engine/replication-manifest.js';
import { scrubPostsOf } from './engine/post-scrub.js';
import {
    FREE_TAG_COUNT_MS, FREE_TAG_OFFER_DAYS, forgetFreeTagCounts, freeTagCounts, libraryLabelCount, offeredFreeTags, setFreeTagRule,
} from './engine/free-tags.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
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
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}
const session = (who: Id, role: 'owner' | 'admin' | 'moderator') => ({ 'X-Admin-Session': consumeHandshakeToken(mintHandshakeToken(who.pk, role).handshakeToken).sessionId! });

interface Res { status: number; body: any; text: string }
async function call(method: 'GET' | 'POST', id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await localFetch(`${BASE}${urlPath}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, text };
}
const show = (r: Res) => `${r.status} ${r.text.slice(0, 200)}`;

async function offer(author: Id, title: string, freeTags: string[], extra: Record<string, unknown> = {}): Promise<string> {
    const r = await call('POST', author, '/api/marketplace/posts', {
        type: 'offer', category: 'general', title, description: '', price_c: 0, priceType: 'fixed', authorPublicKey: author.pk,
        lat: -28.55, lng: 153.5, photos: [TEST_PHOTO], freeTags, ...extra,
    });
    const id = r.body?.id ?? r.body?.post?.id;
    if (typeof id !== 'string') console.error(`  (offer ${title}: ${show(r)})`);
    return id;
}
const age = (postId: string, days: number) => db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(new Date(Date.now() - days * 86_400_000).toISOString(), postId);
const report = (postId: string, reporter: Id) => db.prepare(`INSERT INTO abuse_reports (id, reporter_pubkey, target_pubkey, target_post_id, reason, status)
    SELECT ?, ?, author_pubkey, id, 'offensive', 'pending' FROM posts WHERE id = ?`).run(crypto.randomUUID(), reporter.pk, postId);
const offeredNow = () => { forgetFreeTagCounts(); return offeredFreeTags().map((t) => t.tag); };
const DAY = 86_400_000;
/** The tags offered as if the clock read `at` (engine/free-tags.ts takes its clock as an argument). */
const offeredAt = (at: number) => { forgetFreeTagCounts(); return offeredFreeTags(at).map((t) => t.tag); };
/** An author's edit through the real route, with their signature: POST /api/marketplace/posts/update. */
const editTags = (author: Id, postId: string, freeTags: string[]) =>
    call('POST', author, '/api/marketplace/posts/update', { id: postId, authorPublicKey: author.pk, freeTags });
const countOf = (tag: string) => { forgetFreeTagCounts(); return freeTagCounts().find((t) => t.tag === tag); };
const adminLines = (since: number) => (db.prepare("SELECT message FROM system_logs WHERE category = 'ADMIN' AND id > ? ORDER BY id").all(since) as { message: string }[]).map((r) => r.message);
const lastLogId = () => ((db.prepare('SELECT MAX(id) AS id FROM system_logs').get() as { id: number | null }).id ?? 0);

async function main(): Promise<void> {
    console.log('\n=== Typed tags offered here, and the rules on them (slice F3) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ann = member('Ann');
    const bea = member('Bea');
    const cas = member('Cas');
    const dee = member('Dee');

    // ── 1. the threshold ──────────────────────────────────────────────────────────────────────
    console.log('── 1. two authors, or one for a week with no open report ──');
    const annNew = await offer(ann, 'A lamp', ['vintage']);
    assert(!offeredNow().includes('vintage') && countOf('vintage')?.listings === 1, `one author's new listing is not offered (${JSON.stringify(countOf('vintage'))})`);
    await offer(ann, 'A second lamp', ['vintage']);
    assert(!offeredNow().includes('vintage') && countOf('vintage')?.authors === 1, 'nor two listings by the same author');
    await offer(bea, 'A chair', ['Vintage']);
    assert(offeredNow().includes('vintage') && countOf('vintage')?.authors === 2, `a second author's listing offers it (${JSON.stringify(countOf('vintage'))})`);

    const fixieAt = Date.now();
    const oldOne = await offer(cas, 'A bike', ['fixie']);
    assert(!offeredAt(fixieAt + (FREE_TAG_OFFER_DAYS - 1) * DAY).includes('fixie'), 'one author for six days: not yet');
    const weekOn = fixieAt + (FREE_TAG_OFFER_DAYS + 1) * DAY;
    assert(offeredAt(weekOn).includes('fixie'), 'one author for over a week with no report: offered');
    report(oldOne, dee);
    assert(!offeredAt(weekOn).includes('fixie'), 'the same with an open report on it: not offered');
    db.prepare("UPDATE abuse_reports SET status = 'reviewed' WHERE target_post_id = ?").run(oldOne);
    assert(offeredAt(weekOn).includes('fixie'), 'the report dismissed: offered again');

    // ── 1b. the week runs from the word ───────────────────────────────────────────────────────
    console.log('\n── 1b. the week runs from when the word first appeared on a live listing ──');
    const monthOld = await offer(ann, 'An old lamp', []);
    age(monthOld, 30);
    const editedAt = Date.now();
    const edit = await editTags(ann, monthOld, ['probeword']);
    assert(edit.status === 200, `an author edits a new word onto a month-old listing (${show(edit)})`);
    assert(!offeredNow().includes('probeword'), `one author's edited-in word is not offered at once (${JSON.stringify(countOf('probeword'))})`);
    const probeSeen = Date.parse(countOf('probeword')?.firstSeen ?? '');
    assert(probeSeen >= editedAt - 1_000 && probeSeen <= Date.now() + 1_000, `its first seen is the edit, not the listing's day (${countOf('probeword')?.firstSeen})`);
    assert(!offeredAt(editedAt + (FREE_TAG_OFFER_DAYS - 1) * DAY).includes('probeword'), 'six days after the edit: not yet');
    assert(offeredAt(editedAt + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes('probeword'), 'a week after the edit, with no report: offered');

    const deskOld = await offer(cas, 'An old desk', []);
    age(deskOld, 30);
    await editTags(cas, deskOld, ['second word']);
    assert(!offeredNow().includes('second word'), "one author's edit: not offered…");
    const beaDesk = await offer(bea, 'A desk lamp', []);
    const beaEdit = await editTags(bea, beaDesk, ['Second Word']);
    assert(beaEdit.status === 200 && offeredNow().includes('second word') && countOf('second word')?.authors === 2,
        `…a second author's edit offers it at once (${JSON.stringify(countOf('second word'))})`);

    const kettle = await offer(dee, 'A kettle put away', ['paused word']);
    const pausedAt = Date.now();
    // Paused as a shop closed for now pauses its listings (engine/shops.ts), and long ago: the listing is a month old.
    db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(kettle);
    age(kettle, 30);
    assert(countOf('paused word') === undefined, 'a word on a paused listing is not counted');
    db.prepare("UPDATE posts SET status = 'active' WHERE id = ?").run(kettle);
    const backOn = pausedAt + (FREE_TAG_OFFER_DAYS + 1) * DAY;
    forgetFreeTagCounts();
    const backSeen = Date.parse(freeTagCounts(backOn).find((t) => t.tag === 'paused word')?.firstSeen ?? '');
    assert(!offeredAt(backOn).includes('paused word') && backSeen >= backOn - 1_000,
        `the listing back on eight days later: the week starts then (${Number.isFinite(backSeen) ? new Date(backSeen).toISOString() : 'none'})`);
    assert(offeredAt(backOn + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes('paused word'), 'and a week after that: offered');

    const teapot = await offer(dee, 'A teapot', ['gone word']);
    assert(countOf('gone word')?.listings === 1, 'a word on one listing…');
    // …first seen a month ago (so a stamp kept across the take-down would pass the week at once)…
    db.prepare("UPDATE free_tag_seen SET first_seen = ? WHERE tag = 'gone word'").run(new Date(Date.now() - 30 * DAY).toISOString());
    db.prepare("UPDATE posts SET removed_by_moderator_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(teapot);
    const another = await offer(dee, 'Another teapot', []);
    age(another, 30);
    const goneAt = Date.now();
    await editTags(dee, another, ['gone word']);
    const goneSeen = Date.parse(countOf('gone word')?.firstSeen ?? '');
    assert(goneSeen >= goneAt - 1_000, `…taken down, then edited onto another: its week starts again at the edit, with no count between (${countOf('gone word')?.firstSeen})`);
    assert(!offeredAt(goneAt + (FREE_TAG_OFFER_DAYS - 1) * DAY).includes('gone word'), 'six days on: not yet');

    // ── 1c. a report and a takedown follow the word ───────────────────────────────────────────
    console.log('\n── 1c. a report or a takedown follows the word to another listing ──');
    const eve = member('Eve');
    const fay = member('Fay');
    const kit = member('Kit');
    grantNodeRole(kit.pk, 'moderator', owner.pk);
    /** A member's report through the real route, POST /api/reports, and its id. */
    const fileReport = async (reporter: Id, postId: string, author: Id): Promise<string | undefined> => {
        const r = await call('POST', reporter, '/api/reports', { reporterPubkey: reporter.pk, targetPubkey: author.pk, targetPostId: postId, reason: 'offensive' });
        if (r.status >= 300) console.error(`  (report on ${postId}: ${show(r)})`);
        return (db.prepare('SELECT id FROM abuse_reports WHERE target_post_id = ? AND reporter_pubkey = ? ORDER BY created_at DESC').get(postId, reporter.pk) as { id: string } | undefined)?.id;
    };
    const reportStatus = (id: string | undefined) => (db.prepare('SELECT status FROM abuse_reports WHERE id = ?').get(id ?? '') as { status: string } | undefined)?.status;
    /** The word's day moved back, as if the only listing carrying it had carried it `days` (the 'gone word' case's way). */
    const stampBack = (tag: string, days: number) => db.prepare('UPDATE free_tag_seen SET first_seen = ? WHERE tag = ?').run(new Date(Date.now() - days * DAY).toISOString(), tag);

    // The author moves a reported word to a new listing, then takes it off the reported one.
    const poster = await offer(eve, 'A poster', ['dodgeword']);
    stampBack('dodgeword', FREE_TAG_OFFER_DAYS + 1);
    assert(offeredNow().includes('dodgeword'), 'one listing has carried a word eight days with no report: offered');
    const dodgeReport = await fileReport(dee, poster, eve);
    assert(!!dodgeReport && !offeredNow().includes('dodgeword'), `a member reports that listing (POST /api/reports): not offered (${JSON.stringify(countOf('dodgeword'))})`);
    const fresh = await offer(eve, 'Another poster', []);
    const movedAt = Date.now();
    const moved = await editTags(eve, fresh, ['dodgeword']);
    assert(moved.status === 200 && !offeredNow().includes('dodgeword'), `its author edits the word onto a new listing: not offered (${show(moved)})`);
    const dropped = await editTags(eve, poster, []);
    assert(dropped.status === 200 && reportStatus(dodgeReport) === 'pending', `…and takes it off the reported one; the report is still open (${show(dropped)}, ${reportStatus(dodgeReport)})`);
    assert(!offeredNow().includes('dodgeword'), `the word is not offered: the report on the listing that carried it follows the word (${JSON.stringify(countOf('dodgeword'))})`);
    assert(!offeredAt(movedAt + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes('dodgeword'), 'nor a week after the move, while that report is open');
    const dismissed = await call('POST', null, `/api/local/admin/reports/${dodgeReport}/dismiss`, {}, session(kit, 'moderator'));
    assert(dismissed.status === 200 && !offeredNow().includes('dodgeword'), `a moderator dismisses the report: the new listing's own week still runs (${show(dismissed)})`);
    assert(offeredAt(movedAt + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes('dodgeword'), 'and a week after the move, with no report open: offered');

    // The same, with the reported listing deleted by its author (no count runs at the delete).
    const flyer = await offer(eve, 'A flyer', ['dropword']);
    stampBack('dropword', FREE_TAG_OFFER_DAYS + 1);
    await fileReport(dee, flyer, eve);
    await offer(eve, 'Another flyer', ['dropword']);
    const removed = await call('POST', eve, '/api/marketplace/posts/remove', { id: flyer, authorPublicKey: eve.pk });
    assert(removed.status === 200 && !offeredNow().includes('dropword'), `the reported listing deleted by its author, the word on a new one: not offered (${show(removed)})`);

    // A moderator takes the reported listing down; the author's other listing carries the word.
    const banner = await offer(fay, 'A banner', ['takeword']);
    stampBack('takeword', FREE_TAG_OFFER_DAYS + 1);
    const banner2At = Date.now();
    await offer(fay, 'Another banner', ['takeword']);
    const takeReport = await fileReport(dee, banner, fay);
    assert(!offeredNow().includes('takeword'), 'a word on a reported listing and a new one by the same author: not offered');
    const takedown = await call('POST', null, `/api/local/admin/reports/${takeReport}/action`, { deletePost: true }, session(kit, 'moderator'));
    const tookDownAt = Date.now();
    const bannerRow = db.prepare('SELECT removed_by_moderator_at FROM posts WHERE id = ?').get(banner) as { removed_by_moderator_at: string | null } | undefined;
    assert(takedown.status === 200 && !!bannerRow?.removed_by_moderator_at && reportStatus(takeReport) === 'actioned',
        `a moderator upholds the report and takes the listing down (${show(takedown)})`);
    assert(!offeredNow().includes('takeword'), `the word on the author's other listing is not offered at once (${JSON.stringify(countOf('takeword'))})`);
    assert(!offeredAt(banner2At + (FREE_TAG_OFFER_DAYS - 1) * DAY).includes('takeword'), 'nor six days on');
    assert(offeredAt(tookDownAt + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes('takeword'),
        'a week after the takedown, the other listing having carried it that week with no report: offered (an owner or admin hides a word for good)');
    // A report upheld after its author moved the word away: the takedown's week counts from the takedown, not from the move.
    const upheldAfterMove = async (author: Id, tag: string, daysSinceMove: number) => {
        const sign = await offer(author, `A sign ${daysSinceMove}`, [tag]);
        stampBack(tag, FREE_TAG_OFFER_DAYS + 1);
        assert(offeredNow().includes(tag), `${tag}: one listing has carried it eight days with no report: offered`);
        const upReport = await fileReport(dee, sign, author);
        const other = await offer(author, `Another sign ${daysSinceMove}`, []);
        const onOther = await editTags(author, other, [tag]);
        const offSign = await editTags(author, sign, []);
        // The move made `daysSinceMove` days ago, the suite's own way: the new listing's stamp and the reported one's gone time moved back.
        const back = new Date(Date.now() - daysSinceMove * DAY).toISOString();
        db.prepare('UPDATE free_tag_seen SET first_seen = ? WHERE tag = ? AND post_id = ?').run(back, tag, other);
        db.prepare('UPDATE free_tag_seen SET gone_at = ? WHERE tag = ? AND post_id = ?').run(back, tag, sign);
        assert(onOther.status === 200 && offSign.status === 200 && reportStatus(upReport) === 'pending' && !offeredNow().includes(tag),
            `${tag}: the author moved it to a new listing and off the reported one ${daysSinceMove} days ago, the report still open: not offered (${show(offSign)})`);
        const upheld = await call('POST', null, `/api/local/admin/reports/${upReport}/action`, { deletePost: true }, session(kit, 'moderator'));
        const upheldAt = Date.now();
        assert(upheld.status === 200 && reportStatus(upReport) === 'actioned', `${tag}: a moderator upholds the report and takes the listing down (${show(upheld)})`);
        assert(!offeredNow().includes(tag), `${tag}: upheld ${daysSinceMove} days after the move, not offered right after the takedown (${JSON.stringify(countOf(tag))})`);
        assert(!offeredAt(upheldAt + (FREE_TAG_OFFER_DAYS - 1) * DAY).includes(tag), `${tag}: nor six days after the takedown`);
        assert(offeredAt(upheldAt + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes(tag), `${tag}: a week after the takedown, with no report open: offered`);
    };
    await upheldAfterMove(member('Gus'), 'upword', FREE_TAG_OFFER_DAYS + 1);
    await upheldAfterMove(member('Hal'), 'laterword', FREE_TAG_OFFER_DAYS - 1);

    const faysDays = () => (db.prepare('SELECT COUNT(*) AS n FROM free_tag_seen s JOIN posts p ON p.id = s.post_id WHERE p.author_pubkey = ?').get(fay.pk) as { n: number }).n;
    const faysBefore = faysDays();
    db.transaction(() => { scrubPostsOf(fay.pk, new Date().toISOString()); })();
    assert(faysBefore > 0 && faysDays() === 0, `a member's account deleted: their listings keep no typed tag's day (${faysBefore} → ${faysDays()})`);

    // ── 2. what is counted ────────────────────────────────────────────────────────────────────
    console.log('\n── 2. only live, public listings made here by an active author ──');
    const lends = async (label: string, change: (a: string, b: string) => void, undo: (a: string, b: string) => void) => {
        const tag = `shed ${label.replace(/[^a-z ]/gi, '').toLowerCase().split(' ').slice(0, 3).join(' ')}`;
        const a = await offer(ann, `Shed A ${label}`, [tag]);
        const b = await offer(dee, `Shed B ${label}`, [tag]);
        const before = offeredNow().includes(tag);
        change(a, b);
        const after = offeredNow().includes(tag);
        assert(before && !after && (countOf(tag)?.listings ?? 0) <= 1, `${label}: lends nothing (${before} → ${after})`);
        undo(a, b);
    };
    await lends('hidden by reports', (_a, b) => db.prepare("UPDATE posts SET hidden_by_reports_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(b), () => {});
    await lends('removed by a moderator', (_a, b) => db.prepare("UPDATE posts SET removed_by_moderator_at = '2026-01-01T00:00:00Z' WHERE id = ?").run(b), () => {});
    await lends('inactive', (_a, b) => db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(b), () => {});
    await lends('cancelled', (_a, b) => db.prepare("UPDATE posts SET status = 'cancelled' WHERE id = ?").run(b), () => {});
    await lends('a group listing', (_a, b) => db.prepare("UPDATE posts SET audience_scope = 'group' WHERE id = ?").run(b), () => {});
    await lends("a peer's listing", (_a, b) => db.prepare("UPDATE posts SET origin_node = 'peer-node' WHERE id = ?").run(b), () => {});
    await lends('paused author', () => db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(dee.pk),
        () => db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(dee.pk));
    await lends('suspended author', () => db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(dee.pk),
        () => db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(dee.pk));
    db.prepare("UPDATE posts SET free_tags = 'not json' WHERE id = ?").run(annNew);
    forgetFreeTagCounts();
    let threw = '';
    try { freeTagCounts(); } catch (e) { threw = (e as Error).message; }
    assert(!threw, `a row holding something that is not JSON is skipped, not thrown (${threw || 'no throw'})`);
    db.prepare(`UPDATE posts SET free_tags = '["vintage"]' WHERE id = ?`).run(annNew);

    // ── 3. the cache ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. made at most once a minute; a rule is seen at once ──');
    forgetFreeTagCounts();
    const t0 = Date.now();
    const first = freeTagCounts(t0).length;
    await offer(ann, 'A rug', ['kilim']);
    await offer(bea, 'A rug too', ['kilim']);
    assert(freeTagCounts(t0 + 30_000).length === first, 'half a minute later the same count is read');
    assert(freeTagCounts(t0 + FREE_TAG_COUNT_MS + 1).some((t) => t.tag === 'kilim'), 'past the minute it is made again');
    freeTagCounts(t0 + FREE_TAG_COUNT_MS + 2);
    setFreeTagRule(owner.pk, 'kilim', 'hide');
    assert(!offeredFreeTags(t0 + FREE_TAG_COUNT_MS + 3).some((t) => t.tag === 'kilim'), 'a hide set inside the minute is seen at once');
    setFreeTagRule(owner.pk, 'kilim', 'clear');

    // ── 4. members only ───────────────────────────────────────────────────────────────────────
    console.log('\n── 4. GET /api/free-tags: members only ──');
    forgetFreeTagCounts();
    const unsigned = await call('GET', null, '/api/free-tags');
    assert(unsigned.status === 401, `unsigned: 401 (${show(unsigned)})`);
    const stranger = await call('GET', newId('Stranger'), '/api/free-tags');
    // The read gate refuses a key that is no member before the route (https-server.ts); the route says the same if it is reached.
    assert(stranger.status === 403 && /^not_a?_?member$/.test(stranger.body?.code ?? ''), `a stranger: 403 (${show(stranger)})`);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(cas.pk);
    const paused = await call('GET', cas, '/api/free-tags');
    assert(paused.status === 403 && paused.body?.code === 'not_active', `a paused member: 403 not_active (${show(paused)})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(cas.pk);
    const ok = await call('GET', bea, '/api/free-tags');
    const tags = Array.isArray(ok.body?.tags) ? ok.body.tags : [];
    assert(ok.status === 200 && tags.some((t: any) => t.tag === 'vintage' && t.listings === 3) && !tags.some((t: any) => 'authors' in t || 'firstSeen' in t),
        `a member: the offered tags with their counts, no authors or dates (${show(ok)})`);
    const counts = tags.map((t: any) => t.listings);
    assert(counts.every((n: number, i: number) => i === 0 || counts[i - 1] >= n), 'most used first');

    // ── 5. the owners' and admins' page ───────────────────────────────────────────────────────
    console.log('\n── 5. the Tags page: counts, never who ──');
    const ada = member('Ada');
    grantNodeRole(ada.pk, 'admin', owner.pk);
    const mo = member('Mo');
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const page = await call('GET', null, '/api/local/admin/free-tags', undefined, session(ada, 'admin'));
    const vintage = (page.body?.tags ?? []).find((t: any) => t.tag === 'vintage');
    assert(page.status === 200 && vintage?.listings === 3 && vintage?.authors === 2 && typeof vintage?.firstSeen === 'string' && vintage?.offered === true && vintage?.rule === null,
        `an admin reads each tag's listings, authors and first seen (${JSON.stringify(vintage)})`);
    assert(!page.text.includes(ann.pk) && !page.text.includes(bea.pk), "and no member's key");
    const probe = (page.body?.tags ?? []).find((t: any) => t.tag === 'probeword');
    const monthOldMade = Date.parse((db.prepare('SELECT created_at FROM posts WHERE id = ?').get(monthOld) as { created_at: string }).created_at);
    assert(Date.parse(probe?.firstSeen ?? '') >= editedAt - 1_000 && Date.parse(probe?.firstSeen ?? '') > monthOldMade + 29 * DAY,
        `the page's first seen of an edited-in word is the edit, not the listing's day (${JSON.stringify(probe)})`);
    const unoffered = (page.body?.tags ?? []).find((t: any) => t.tag === 'shed hidden by reports');
    assert(unoffered?.offered === false, `a tag not offered is listed too, said so (${JSON.stringify(unoffered)})`);
    const byMod = await call('GET', null, '/api/local/admin/free-tags', undefined, session(mo, 'moderator'));
    assert(byMod.status === 403, `a moderator: 403 (${show(byMod)})`);
    const byNobody = await call('GET', null, '/api/local/admin/free-tags');
    assert(byNobody.status === 401 || byNobody.status === 403, `no session: refused (${show(byNobody)})`);

    // ── 6. hide, merge, clear ─────────────────────────────────────────────────────────────────
    console.log('\n── 6. hide, merge, clear ──');
    const rule = (tag: string, action: string, body: unknown = {}, headers: Record<string, string> = session(ada, 'admin')) =>
        call('POST', null, `/api/local/admin/free-tags/${encodeURIComponent(tag)}/${action}`, body, headers);
    let mark = lastLogId();
    const hide = await rule('Vintage', 'hide');
    assert(hide.status === 200 && hide.body?.tag === 'vintage' && hide.body?.rule === 'hide' && hide.body?.changed === true, `hide, by any spelling of the tag (${show(hide)})`);
    assert(!offeredNow().includes('vintage') && !(await call('GET', bea, '/api/free-tags')).body.tags.some((t: any) => t.tag === 'vintage'), 'never offered once hidden');
    const ruleRow = db.prepare('SELECT action, into_tag, set_by FROM free_tag_rules WHERE tag = ?').get('vintage') as any;
    assert(ruleRow?.action === 'hide' && ruleRow?.into_tag === null && ruleRow?.set_by === ada.pk, `in the admin's name (${JSON.stringify(ruleRow)})`);
    assert(adminLines(mark).some((l) => l.includes('"vintage"') && l.includes('hidden from suggestions') && l.includes(ada.pk.slice(0, 12))), `an ADMIN line (${adminLines(mark).join(' | ')})`);
    mark = lastLogId();
    const again = await rule('vintage', 'hide');
    assert(again.status === 200 && again.body?.changed === false && adminLines(mark).length === 0, 'a rule standing already changes and logs nothing');

    const lone = await offer(dee, 'Lemons by the bag', ['limones']);
    assert(!offeredNow().includes('limones'), 'a tag on one new listing is not offered…');
    mark = lastLogId();
    const merge = await rule('limones', 'merge', { into: 'food.fruit.lemon' });
    assert(merge.status === 200 && merge.body?.rule === 'merge' && merge.body?.mergeInto === 'food.fruit.lemon', `merge into a library tag (${show(merge)})`);
    const merged = (await call('GET', bea, '/api/free-tags')).body.tags.find((t: any) => t.tag === 'limones');
    assert(merged?.mergeInto === 'food.fruit.lemon', `…until merged: offered as the library tag whatever its counts (${JSON.stringify(merged)})`);
    assert(adminLines(mark).some((l) => l.includes('"limones"') && l.includes('merged into food.fruit.lemon')), 'an ADMIN line');
    assert(JSON.parse((db.prepare('SELECT free_tags FROM posts WHERE id = ?').get(lone) as any).free_tags)[0] === 'limones', 'the listing keeps its text');

    for (const [label, tag, action, body, code] of [
        ['a tag no listing could carry', 'call 0412 345 678', 'hide', {}, 'not_a_tag'],
        ['a one-letter tag', 'x', 'hide', {}, 'not_a_tag'],
        ['a merge into no library tag', 'limones', 'merge', { into: 'food.fruit.not-a-tag' }, 'not_library'],
        ['a merge into a top', 'limones', 'merge', { into: 'food' }, 'not_library'],
        ['a merge with nothing to merge into', 'limones', 'merge', {}, 'not_library'],
    ] as const) {
        const r = await rule(tag, action, body);
        assert(r.status === 400 && r.body?.code === code && typeof r.body?.error === 'string' && r.body.error.length > 10, `${label}: 400 ${code}, in words (${show(r)})`);
    }
    const wrongAction = await rule('limones', 'promote');
    assert(wrongAction.status === 400 && wrongAction.body?.code === 'bad_action', `an action that is none: 400 bad_action, in words (${show(wrongAction)})`);
    const wrongUnsigned = await call('POST', null, '/api/local/admin/free-tags/limones/promote', {});
    assert(wrongUnsigned.status === 401, `and without a session it is the sign-in that answers, before the action is read (${show(wrongUnsigned)})`);
    const byToken = await rule('retro', 'hide', {}, ownerTokenHeaders('admin', owner.pk));
    assert(byToken.status === 403 && byToken.body?.code === 'key_session_only', `an automation token cannot set one (${show(byToken)})`);
    const modRule = await rule('retro', 'hide', {}, session(mo, 'moderator'));
    assert(modRule.status === 403, `nor a moderator (${show(modRule)})`);
    const byOwner = await rule('retro', 'hide', {}, session(owner, 'owner'));
    assert(byOwner.status === 200 && byOwner.body?.changed === true, `an owner can (${show(byOwner)})`);

    mark = lastLogId();
    const clear = await rule('vintage', 'clear');
    assert(clear.status === 200 && clear.body?.rule === null && clear.body?.changed === true && offeredNow().includes('vintage'), `clear: offered again (${show(clear)})`);
    assert(adminLines(mark).some((l) => l.includes('"vintage"') && l.includes('rule cleared')), 'an ADMIN line');
    const page2 = await call('GET', null, '/api/local/admin/free-tags', undefined, session(ada, 'admin'));
    const retro = (page2.body?.tags ?? []).find((t: any) => t.tag === 'retro');
    assert(retro?.rule === 'hide' && retro?.listings === 0 && retro?.firstSeen === null, `a rule on a tag no listing carries now is still on the page (${JSON.stringify(retro)})`);

    // ── 7. a standby ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 7. a standby ──');
    const entry = TABLES.free_tag_rules as any;
    assert(entry?.plain === true && ['tag', 'action', 'into_tag', 'set_by', 'set_at', 'updated_at'].every((c) => entry.columns.includes(c)),
        'free_tag_rules is a plain table a standby copies, every column');
    assert((TABLES.free_tag_seen as any)?.kind === 'local', 'free_tag_seen is each server\'s own: a standby stamps the words it sees');
    assert(!!db.prepare("SELECT 1 FROM tombstones WHERE table_name = 'free_tag_rules' AND row_key = 'vintage'").get(), 'the cleared rule left a tombstone, so a standby drops it too');
    const stamped = db.prepare('SELECT updated_at FROM free_tag_rules WHERE tag = ?').get('limones') as { updated_at: string | null } | undefined;
    assert(typeof stamped?.updated_at === 'string' && stamped.updated_at.length > 10, `its watermark is stamped (${stamped?.updated_at})`);
    const rulesBefore = JSON.stringify(db.prepare('SELECT * FROM free_tag_rules ORDER BY tag').all());
    setNodeRole('backup');
    try {
        const onStandby = await rule('fixie', 'hide');
        assert(onStandby.status === 409 && onStandby.body?.code === 'standby', `a standby refuses a rule (${show(onStandby)})`);
        let thrown = '';
        try { setFreeTagRule(ada.pk, 'fixie', 'hide'); } catch (e) { thrown = (e as Error).name; }
        assert(thrown === 'StandbyLedgerError', `and so does the writer under it (${thrown || 'no throw'})`);
        assert(JSON.stringify(db.prepare('SELECT * FROM free_tag_rules ORDER BY tag').all()) === rulesBefore, 'nothing written');
    } finally {
        setNodeRole('primary');
    }

    // ── 8. the table: every way the word leaves a reported listing × when the report is upheld ──────────
    console.log('\n── 8. a reported word waits a week after the latest of the move and the uphold, whatever the way ──');
    type Way = 'edit off' | 'pause' | 'delete' | 'takedown' | 'report-hide';
    type When = 'before the move' | '3 days after' | '8 days after' | 'never (pending)';
    const WAYS: Way[] = ['edit off', 'pause', 'delete', 'takedown', 'report-hide'];
    const WHENS: { when: When; days: number | null }[] = [
        { when: 'before the move', days: -1 }, { when: '3 days after', days: 3 }, { when: '8 days after', days: 8 }, { when: 'never (pending)', days: null },
    ];
    const tableRows: string[] = [];
    let caseNo = 0;
    const tagFor = (n: number) => `tbl${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`;
    /** Every time this case wrote at or before `upTo` (real), moved back `ms`: the case's earlier events, as if they were that long ago. */
    const shiftBack = (tag: string, a: string, c: string, upTo: string, ms: number) => {
        const back = (col: string) => `${col} = CASE WHEN ${col} IS NOT NULL AND ${col} <= @upTo THEN strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${col}) - @days) ELSE ${col} END`;
        const p = { upTo, days: ms / DAY };
        db.prepare(`UPDATE free_tag_seen SET ${back('first_seen')}, ${back('gone_at')} WHERE tag = @tag AND post_id IN (@a, @c)`).run({ ...p, tag, a, c });
        db.prepare(`UPDATE posts SET ${back('removed_by_moderator_at')}, ${back('hidden_by_reports_at')} WHERE id = @a`).run({ ...p, a });
        db.prepare(`UPDATE abuse_reports SET ${back('created_at')}, ${back('updated_at')} WHERE target_post_id = @a`).run({ ...p, a });
    };
    /** The way the word leaves the reported listing `a`, through its real route (a report-hide as auto-moderation stamps it). */
    const leave = async (way: Way, author: Id, a: string): Promise<number> => {
        if (way === 'edit off') return (await editTags(author, a, [])).status;
        if (way === 'pause') return (await call('POST', author, '/api/marketplace/posts/pause', { postId: a, authorPublicKey: author.pk })).status;
        if (way === 'delete') return (await call('POST', author, '/api/marketplace/posts/remove', { id: a, authorPublicKey: author.pk })).status;
        if (way === 'takedown') return (await call('POST', null, `/api/local/admin/posts/${a}/delete`, {}, session(ada, 'admin'))).status;
        // The global profile's auto-hide needs reporters in three circles of established members (engine/auto-moderation.ts):
        // stamped here as evaluateAutoHide stamps it, on a live listing, as section 2 does.
        return db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ? AND active = 1 AND hidden_by_reports_at IS NULL').run(new Date().toISOString(), a).changes ? 200 : 409;
    };
    const runCase = async (way: Way | null, when: When, days: number | null, deletePost: boolean | null) => {
        const n = caseNo++;
        const tag = tagFor(n);
        const author = member(`Tab${n}`);
        const reporter = member(`Rep${n}`);
        const a = await offer(author, `Reported ${n}`, [tag]);
        stampBack(tag, FREE_TAG_OFFER_DAYS + 1);
        const carried = offeredNow().includes(tag);
        const reportId = way ? await fileReport(reporter, a, author) : undefined;
        const c = await offer(author, `New ${n}`, []);
        const steps: string[] = [];
        const uphold = async () => {
            const r = await call('POST', null, `/api/local/admin/reports/${reportId}/action`, { deletePost }, session(ada, 'admin'));
            steps.push(`uphold ${r.status}${r.status === 200 ? '' : ` ${r.text.slice(0, 80)}`}`);
            offeredNow(); // a count at the real time, so a listing that left is marked gone now, not at a probe's later clock
        };
        const move = async () => {
            const onC = await editTags(author, c, [tag]);
            const off = way ? await leave(way, author, a) : (await editTags(author, a, [])).status;
            steps.push(`move ${onC.status}/${off}`);
            offeredNow();
        };
        let lastAt: number;
        if (days !== null && days < 0) {
            await uphold();
            const upTo = new Date().toISOString();
            lastAt = Date.now();
            await move();
            shiftBack(tag, a, c, upTo, -days * DAY);
        } else {
            await move();
            if (days !== null) {
                const upTo = new Date().toISOString();
                lastAt = Date.now();
                await uphold();
                shiftBack(tag, a, c, upTo, days * DAY);
            } else {
                lastAt = Date.now();
            }
        }
        const end = Date.now();
        const status = reportStatus(reportId) ?? 'none';
        const pending = status === 'pending';
        const atOnce = offeredNow().includes(tag);
        let ok: boolean;
        let seen: string;
        if (pending) {
            const at8 = offeredAt(end + (FREE_TAG_OFFER_DAYS + 1) * DAY);
            const at15 = offeredAt(end + (2 * FREE_TAG_OFFER_DAYS + 1) * DAY).includes(tag);
            ok = carried && !atOnce && !at8.includes(tag) && !at15;
            seen = `at once ${atOnce}, +8d ${at8.includes(tag)}, +15d ${at15}`;
        } else {
            const justBefore = offeredAt(lastAt + FREE_TAG_OFFER_DAYS * DAY - 3_600_000).includes(tag);
            const after = offeredAt(end + FREE_TAG_OFFER_DAYS * DAY + 60_000).includes(tag);
            ok = carried && !atOnce && !justBefore && after;
            seen = `at once ${atOnce}, week-1h ${justBefore}, week+1m ${after}`;
        }
        // A takedown closes every open report on the listing (moderation-notices.ts closeOpenReportsOnPost): left open, it is actioned at the move.
        const label = way === null ? 'unreported control (edit off)'
            : `${way}, ${days === null ? `report left open${pending ? '' : ' (the takedown closes it)'}` : `upheld ${when} {deletePost:${deletePost}}`}`;
        const expect = pending ? 'not offered while the report is open' : 'offered a week after the latest event, not before';
        tableRows.push(`| ${label} | ${steps.join(', ')} | ${status} | ${expect} | ${seen} | ${ok ? 'pass' : 'FAIL'} |`);
        assert(ok, `${label}: ${expect} (${steps.join(', ')}; report ${status}; ${seen})`);
    };
    await runCase(null, 'never (pending)', null, null);
    for (const way of WAYS) {
        for (const { when, days } of WHENS) {
            if (days === null) await runCase(way, when, null, null);
            else for (const deletePost of [true, false]) await runCase(way, when, days, deletePost);
        }
    }
    console.log('\n| case | routes (status) | report after | expected | measured | result |\n|---|---|---|---|---|---|');
    for (const row of tableRows) console.log(row);

    // ── 9. "Did you mean …?" from every language's labels (slice F5) ────────────────────────────────
    console.log('\n── 9. GET /api/free-tags?q=: the library tag a word is the label of in any of the 25 languages ──');
    const es = { 'X-Language': 'es' };
    const asked = async (q: string, who: Id | null = bea, extra: Record<string, string> = es) =>
        call('GET', who, `/api/free-tags?q=${encodeURIComponent(q)}`, undefined, extra);
    const heapBefore = (globalThis as { gc?: () => void }).gc ? ((globalThis as { gc: () => void }).gc(), process.memoryUsage().heapUsed) : process.memoryUsage().heapUsed;
    const builtAt = performance.now();
    const labels = libraryLabelCount();
    const buildMs = performance.now() - builtAt;
    const heapAfter = (globalThis as { gc?: () => void }).gc ? ((globalThis as { gc: () => void }).gc(), process.memoryUsage().heapUsed) : process.memoryUsage().heapUsed;
    console.log(`  label map: ${labels} folded labels, built in ${buildMs.toFixed(0)} ms, heap ${((heapAfter - heapBefore) / 1024).toFixed(0)} KiB after${(globalThis as { gc?: unknown }).gc ? ' (gc before and after)' : ' (no --expose-gc: rough)'}`);
    assert(labels > 5000, `the map holds every language's labels, folded (${labels})`);
    for (const [q, want, why] of [
        ['laranja', 'food.fruit.orange', 'a Portuguese label on a Spanish device'],
        ['Laranjas', 'food.fruit.orange', 'its plural, any case'],
        ['maçã', 'food.fruit.apple', 'a Portuguese label with its accents'],
        ['maca', 'food.fruit.apple', 'the same without them'],
        ['limão-siciliano', 'food.fruit.lemon', 'a Portuguese compound label'],
        ['limão', 'food.fruit.lime', "Portuguese's own lime, not Spanish lemon"],
        ['апельсин', 'food.fruit.orange', 'a Russian label'],
        ['オレンジ', 'food.fruit.orange', 'a Japanese label'],
        ['lemons', 'food.fruit.lemon', 'an English plural'],
    ] as const) {
        const r = await asked(q);
        assert(r.status === 200 && r.body?.library === want && !('tags' in (r.body ?? {})), `${why}: "${q}" → ${want} (${show(r)})`);
    }
    for (const [q, why] of [
        ['zzqx unheard', 'a word no language labels'],
        ['food & produce', "a top's label: the category is its own field"],
        ['call 0412 345 678', 'a word no listing could carry'],
        ['x', 'one letter'],
    ] as const) {
        const r = await asked(q);
        assert(r.status === 200 && r.body?.library === null, `${why}: "${q}" → null (${show(r)})`);
    }
    const twice = await call('GET', bea, '/api/free-tags?q=laranja&q=limão', undefined, es);
    assert(twice.status === 200 && twice.body?.library === null, `two q's are no word (${show(twice)})`);
    const noLanguage = await asked('laranja', bea, {});
    assert(noLanguage.body?.library === 'food.fruit.orange', `no X-Language: the same answer (${show(noLanguage)})`);
    const listAgain = await call('GET', bea, '/api/free-tags');
    assert(listAgain.status === 200 && Array.isArray(listAgain.body?.tags) && !('library' in listAgain.body),
        `without q the answer is the offered tags, as before (${show(listAgain)})`);
    const unsignedQ = await asked('laranja', null);
    assert(unsignedQ.status === 401 && !('library' in (unsignedQ.body ?? {})), `unsigned: 401, no library (${show(unsignedQ)})`);
    const strangerQ = await asked('laranja', newId('Stranger2'));
    assert(strangerQ.status === 403 && !('library' in (strangerQ.body ?? {})), `a stranger: 403, no library (${show(strangerQ)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
