/**
 * This community's typed tags, offered as members type, and the owners' and admins' rules on them
 * (DESIGN-tags-free-entry-fable.md §3 and §5, slice F3): engine/free-tags.ts, GET /api/free-tags, and
 * /api/local/admin/free-tags. Members and admins act over REAL HTTPS through the real signature and admin middleware.
 *
 *   1. the threshold both ways: one author's new listing is not offered; a second author's is; one author's listing a week
 *      old with no open report is; the same with an open report is not
 *   2. what is counted: a listing hidden by reports, taken down, inactive, cancelled, a group's or one person's, a peer's,
 *      or by a paused or suspended author lends nothing
 *   3. the count is made at most once a minute, and a rule set is seen at once
 *   4. members only: unsigned 401, a stranger 403, a paused member 403; the answer is the offered tags, most used first
 *   5. the owners' and admins' page: counts and first seen, never who; a moderator and a stranger refused
 *   6. hide: never offered; merge: offered as the library tag whatever its counts; clear: as before; every change an ADMIN
 *      line, a rule standing already changes nothing; garbage refused in words; a token cannot set one
 *   7. a standby: the rule table is a plain table its copy carries, a cleared rule a tombstone; a standby refuses a rule
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
import { FREE_TAG_COUNT_MS, FREE_TAG_OFFER_DAYS, forgetFreeTagCounts, freeTagCounts, offeredFreeTags, setFreeTagRule } from './engine/free-tags.js';

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

    const oldOne = await offer(cas, 'A bike', ['fixie']);
    age(oldOne, FREE_TAG_OFFER_DAYS - 1);
    assert(!offeredNow().includes('fixie'), 'one author for six days: not yet');
    age(oldOne, FREE_TAG_OFFER_DAYS + 1);
    assert(offeredNow().includes('fixie'), 'one author for over a week with no report: offered');
    report(oldOne, dee);
    assert(!offeredNow().includes('fixie'), 'the same with an open report on it: not offered');
    db.prepare("UPDATE abuse_reports SET status = 'reviewed' WHERE target_post_id = ?").run(oldOne);
    assert(offeredNow().includes('fixie'), 'the report dismissed: offered again');

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
    assert(wrongAction.status === 404, `an action that is none: 404 (${show(wrongAction)})`);
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
