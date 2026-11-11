/**
 * The owner console's data, paged (capacity report 5 Nov 2026, bottleneck 3): POST /api/local/admin/data built every
 * member and every post in one answer, on the main thread, with no cap: 5 s and 11.6 MB at 10,000 members, and out of
 * heap at 100,000.
 *
 *   1. At 1,000 members the whole answer is still sent to a reader that asks for it (an older console), and is big: it
 *      is measured here, against which the rest is bounded.
 *   2. `lists: 'none'` answers the summary: counts, no member, profile, post or member stats, and its size does not grow
 *      with the members.
 *   3. /admin/data/members: a page holds at most `limit` members, its size is bounded by the page size, a walk meets
 *      every member exactly once and in join order, `total` is the walk's count, a search narrows it, and a cursor the
 *      node never handed out is refused. The rows are the whole answer's rows, field for field (nothing newly sent).
 *   4. /admin/data/posts: the same for posts.
 *   5. Past 1,000 members the whole answer is refused, plainly (413, `admin_data_paged`, the counts and where the pages
 *      are), never cut short in silence.
 *   6. Every credential is answered by the page routes exactly as by /admin/data: none, a wrong password, a member with
 *      no role, a moderator (403), an admin who is not an owner (let in: the data was always admin level), an owner.
 *   7. A posts walk whose last page is exactly full ends on it: the read looks one row past the page, as the members'
 *      pages do, so no cursor leads to an empty page.
 *   8. The prune-branch confirmation's figures, GET /branches/:pubkey/prune: on a node bigger than a page, a branch whose
 *      root is on page 1 and whose members are on the last pages is counted whole, with its debts and surpluses, as the
 *      prune then settles them with the Commons; the same owners as the prune, each look in the access log, no names.
 *      Where the community votes, a branch of one (a direct removal only its vote makes) is refused its figures as the
 *      prune refuses it, with no figure and no look logged; a branch of more than one still gets them.
 *
 * Run: SERVER_SUITES_ONLY=test-admin-data-pages TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole, reconcileLedgerFromDb, getCommonsBalanceExact } from './state-engine.js';
import { ledger } from './engine/ledger.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ownerTokenHeaders, ownerSessionHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { setSwitchOverride } from './config/node-profile.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';
/**
 * The story's figures are Beans; the node's are whole hundredths (1 Bean = 100): `hc` turns a Beans figure into hundredths
 * for a row or a check. A money figure the node answers is named `*_c` (DESIGN-atomic-beans-fable.md §1 Wire).
 */
const hc = (beans: number) => Math.round(beans * 100);
async function post(path: string, headers: Record<string, string>, body: unknown = {}): Promise<{ status: number; bytes: number; ms: number; json: any }> {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    const ms = performance.now() - t0;
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, bytes: Buffer.byteLength(text), ms, json };
}

let seeded = 0;
/** `n` more members, each with a few posts' worth of text in their row, a push token on some, the door's on some. */
function seedMembers(n: number, postsEach = 0) {
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, bio)
        VALUES (?, ?, 'active', ?, ?, 'seed', ?)`);
    const insertAccount = db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`);
    const insertToken = db.prepare(`INSERT OR IGNORE INTO push_tokens (public_key, token_id, token_box, platform) VALUES (?, ?, 'box', ?)`);
    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status, active, created_at, updated_at)
        VALUES (?, 'offer', 'misc', ?, ?, 1000, ?, 'active', 1, ?, ?)`); // 10 Beans
    db.transaction(() => {
        for (let i = 0; i < n; i++) {
            const k = seeded++;
            const pub = `seed${String(k).padStart(6, '0')}${crypto.randomBytes(26).toString('hex')}`.slice(0, 64);
            // Several members share a join time, so the key decides their order.
            const joined = new Date(Date.UTC(2026, 0, 1) + Math.floor(k / 3) * 60_000).toISOString();
            insertMember.run(pub, `Seeded ${k}`, joined, k % 5 === 0 ? 'open:google' : 'genesis', `A member seeded to make the list big, number ${k}.`);
            insertAccount.run(pub);
            if (k % 4 === 0) insertToken.run(pub, `tok-${k}`, k % 8 === 0 ? 'ios' : 'android');
            for (let j = 0; j < postsEach; j++) insertPost.run(`seedpost-${k}-${j}`, `Seeded offer ${k}.${j}`, 'Fresh eggs from the back yard, ask.', pub, joined, joined);
        }
    })();
}

function liveMemberCount(): number {
    return db.prepare(`SELECT COUNT(*) FROM members WHERE status != 'pruned'`).pluck().get() as number;
}

function adminSession(role: 'owner' | 'admin' | 'moderator'): { pub: string; headers: Record<string, string> } {
    const pub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
        VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'genesis')`).run(pub, `${role}-${pub.slice(0, 6)}`);
    grantNodeRole(pub, role, 'SYSTEM');
    const { handshakeToken } = mintHandshakeToken(pub, role);
    const s = consumeHandshakeToken(handshakeToken);
    if (!s.ok || !s.sessionId) throw new Error(`could not open a ${role} session: ${s.error}`);
    return { pub, headers: { 'X-Admin-Session': s.sessionId } };
}

async function get(path: string, headers: Record<string, string>): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}${path}`, { headers });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json };
}

async function walkMembers(headers: Record<string, string>, limit: number, q?: string): Promise<{ keys: string[]; pages: number; maxPageBytes: number; maxPageMs: number; total: number; rows: any[] }> {
    const keys: string[] = [];
    const rows: any[] = [];
    let cursor: string | null = null, pages = 0, maxPageBytes = 0, maxPageMs = 0, total = -1;
    do {
        const r = await post('/api/local/admin/data/members', headers, { limit, cursor, ...(q ? { q } : {}) });
        if (r.status !== 200) throw new Error(`a members page answered ${r.status}: ${JSON.stringify(r.json)?.slice(0, 200)}`);
        pages++;
        maxPageBytes = Math.max(maxPageBytes, r.bytes);
        maxPageMs = Math.max(maxPageMs, r.ms);
        if (r.json.members.length > limit) throw new Error(`a page of ${limit} held ${r.json.members.length}`);
        keys.push(...r.json.members.map((m: any) => m.publicKey));
        rows.push(...r.json.members);
        total = r.json.total;
        cursor = r.json.nextCursor;
        if (pages > 10_000) throw new Error('the walk never ended');
    } while (cursor);
    return { keys, pages, maxPageBytes, maxPageMs, total, rows };
}

async function main() {
    console.log('Running the paged owner-console data test...\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const owner = ownerTokenHeaders('admin');

    // ── 1. The whole answer at 1,000 members ──
    console.log('── 1. The whole answer, at the most it is still sent whole ──');
    seedMembers(1_000 - liveMemberCount(), 2);
    assert(liveMemberCount() === 1_000, `1,000 members seeded (${liveMemberCount()})`);
    const whole = await post('/api/local/admin/data', owner);
    assert(whole.status === 200 && Array.isArray(whole.json?.members) && whole.json.members.length === 1_000 && Array.isArray(whole.json.posts),
        `an older console that asks for the lists still gets them whole at 1,000 members (${whole.status}, ${whole.json?.members?.length} members, ${whole.json?.posts?.length} posts)`);
    console.log(`   the whole answer: ${(whole.bytes / 1024).toFixed(0)} KB in ${whole.ms.toFixed(0)} ms`);
    assert(whole.bytes > 1_000_000, `…and it is big: ${(whole.bytes / 1024).toFixed(0)} KB, over 1 MB, for 1,000 members`);

    // ── 2. The summary ──
    console.log('\n── 2. The summary: counts, no lists ──');
    const summary = await post('/api/local/admin/data', owner, { lists: 'none' });
    console.log(`   the summary: ${(summary.bytes / 1024).toFixed(1)} KB in ${summary.ms.toFixed(0)} ms`);
    assert(summary.status === 200 && summary.json && !('members' in summary.json) && !('profiles' in summary.json) && !('posts' in summary.json) && !('memberStats' in summary.json),
        `lists: 'none' sends no member, profile, post or member stats (keys: ${Object.keys(summary.json ?? {}).join(', ')})`);
    const counts = summary.json?.counts;
    const doorWhole = whole.json.members.filter((m: any) => String(m.invitedBy ?? '').startsWith('open:')).length;
    const treasuriesWhole = whole.json.members.filter((m: any) => m.isTreasury).length;
    const ownersWhole = whole.json.members.filter((m: any) => m.nodeRole === 'owner').length;
    const tally = (p: string) => whole.json.members.filter((m: any) => (p === 'web' ? ['web', 'pwa'].includes(m.platform) : p === 'unknown' ? !['ios', 'android', 'web', 'pwa'].includes(m.platform) : m.platform === p)).length;
    assert(counts?.members === 1_000 && counts.doorMembers === doorWhole && counts.treasuries === treasuriesWhole && counts.owners === ownersWhole,
        `its counts are what the screens counted from the whole list: ${JSON.stringify(counts)} (door ${doorWhole}, treasuries ${treasuriesWhole}, owners ${ownersWhole})`);
    assert(['ios', 'android', 'web', 'unknown'].every(p => counts?.platforms?.[p] === tally(p)),
        `…and the platforms' tally too (${JSON.stringify(counts?.platforms)})`);
    for (const k of ['health', 'reports', 'reportCount', 'escrowDisputesCount', 'knockCount', 'tradeTotals', 'commonsBalance']) {
        assert(JSON.stringify(summary.json?.[k]) === JSON.stringify(whole.json[k]), `the summary's ${k} is the whole answer's`);
    }
    assert(summary.bytes < whole.bytes / 50, `the summary is a fiftieth of the whole answer or less (${summary.bytes} B against ${whole.bytes} B)`);

    // ── 3. The members' pages ──
    console.log('\n── 3. The members, a page at a time ──');
    const walk = await walkMembers(owner, 100);
    console.log(`   ${walk.pages} pages; the biggest ${(walk.maxPageBytes / 1024).toFixed(0)} KB, the slowest ${walk.maxPageMs.toFixed(0)} ms`);
    const wholeKeys = whole.json.members.map((m: any) => m.publicKey);
    assert(walk.keys.length === 1_000 && new Set(walk.keys).size === 1_000, `the walk meets 1,000 members, each once (${walk.keys.length}, ${new Set(walk.keys).size} different)`);
    assert(wholeKeys.every((k: string) => walk.keys.includes(k)), 'every member the whole answer listed is in the walk');
    assert(walk.total === 1_000 && walk.pages === 10, `total says 1,000, and 100 a page takes 10 pages, the last handing out no cursor (${walk.total}, ${walk.pages})`);
    const joinedOrder = walk.rows.every((m: any, i: number) => i === 0
        || `${walk.rows[i - 1].joinedAt ?? ''}\u0000${walk.rows[i - 1].publicKey}` < `${m.joinedAt ?? ''}\u0000${m.publicKey}`);
    assert(joinedOrder, 'oldest joined first, the key deciding a tie: a total order');
    assert(walk.maxPageBytes < whole.bytes / 6, `a page of 100 is bounded by its size: ${walk.maxPageBytes} B, under a sixth of the whole answer`);
    const byKey = new Map(whole.json.members.map((m: any) => [m.publicKey, m]));
    const sameRows = walk.rows.every((m: any) => JSON.stringify(Object.keys(m).sort()) === JSON.stringify(Object.keys(byKey.get(m.publicKey) as object).sort())
        && JSON.stringify(m) === JSON.stringify(byKey.get(m.publicKey)));
    assert(sameRows, "each page's row is the whole answer's row for that member, field for field: nothing newly sent");
    const page1 = await post('/api/local/admin/data/members', owner, { limit: 100 });
    const pageKeys = new Set(page1.json.members.map((m: any) => m.publicKey));
    const profKeys = page1.json.profiles.map((p: any) => p.publicKey);
    assert(profKeys.length === 100 && profKeys.every((k: string) => pageKeys.has(k)), "a page's profiles are its members' profiles");
    const wholeProfiles = new Map(whole.json.profiles.map((p: any) => [p.publicKey, p]));
    assert(page1.json.profiles.every((p: any) => JSON.stringify(p) === JSON.stringify(wholeProfiles.get(p.publicKey))), '…as the whole answer gave them (no contact details, the photo as its URL)');
    assert(Object.keys(page1.json.memberStats).length === 100 && Object.entries(page1.json.memberStats).every(([k, v]) => pageKeys.has(k) && JSON.stringify(v) === JSON.stringify(whole.json.memberStats[k])),
        "a page's member stats are its members', as the whole answer gave them");
    const big = await post('/api/local/admin/data/members', owner, { limit: 100_000 });
    assert(big.status === 200 && big.json.members.length === 200, `a page asked for 100,000 holds the most a page holds, 200 (${big.json?.members?.length})`);
    const dflt = await post('/api/local/admin/data/members', owner, {});
    assert(dflt.status === 200 && dflt.json.members.length === 100 && typeof dflt.json.nextCursor === 'string', 'no size asked: 100, and a cursor to the next');
    const found = await walkMembers(owner, 50, 'Seeded 12');
    const want = whole.json.members.filter((m: any) => String(m.callsign).includes('Seeded 12')).length;
    assert(found.keys.length === want && found.total === want && want > 0, `a search walks only the members it matches (${found.keys.length} of ${want})`);
    const forged = await post('/api/local/admin/data/members', owner, { cursor: 'not-a-cursor' });
    assert(forged.status === 400 && forged.json?.code === 'bad_cursor', `a cursor this node never handed out is refused (${forged.status})`);

    // ── 4. The posts' pages ──
    console.log('\n── 4. The posts, a page at a time ──');
    const postKeys: string[] = [];
    let cursor: string | null = null, postPages = 0, maxPostPage = 0;
    do {
        const r = await post('/api/local/admin/data/posts', owner, { limit: 100, cursor });
        assert(r.status === 200 && r.json.posts.length <= 100, `posts page ${postPages + 1}: ${r.status}, ${r.json?.posts?.length} posts`);
        if (r.status !== 200) break;
        maxPostPage = Math.max(maxPostPage, r.bytes);
        postKeys.push(...r.json.posts.map((p: any) => p.id));
        cursor = r.json.nextCursor;
        postPages++;
    } while (cursor && postPages < 1_000);
    const wholePostIds = whole.json.posts.map((p: any) => p.id);
    assert(postKeys.length === wholePostIds.length && new Set(postKeys).size === postKeys.length && wholePostIds.every((id: string) => postKeys.includes(id)),
        `the posts' walk meets every post the whole answer listed, each once (${postKeys.length} of ${wholePostIds.length})`);
    const firstPosts = await post('/api/local/admin/data/posts', owner, { limit: 100 });
    const wholePosts = new Map(whole.json.posts.map((p: any) => [p.id, p]));
    assert(firstPosts.json.posts.every((p: any) => JSON.stringify(p) === JSON.stringify(wholePosts.get(p.id))), "a page's post is the whole answer's, field for field");
    assert(maxPostPage < whole.bytes / 6, `a page of 100 posts is bounded by its size (${maxPostPage} B)`);
    const forgedPost = await post('/api/local/admin/data/posts', owner, { cursor: 'nope' });
    assert(forgedPost.status === 400 && forgedPost.json?.code === 'bad_cursor', `a posts cursor this node never handed out is refused (${forgedPost.status})`);

    // ── 7. A full last page of posts hands out no cursor ──
    console.log('\n── 7. A posts walk ends on a full last page ──');
    // Posts enough to fill their last page of 50 exactly.
    const fill = (50 - (postKeys.length % 50)) % 50;
    const author = whole.json.members[0].publicKey;
    const insertFill = db.prepare(`INSERT INTO posts (id, type, category, title, description, price_c, author_pubkey, status, active, created_at, updated_at)
        VALUES (?, 'offer', 'misc', ?, 'Fills the last page.', 500, ?, 'active', 1, '2025-06-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z')`); // 5 Beans
    for (let i = 0; i < fill; i++) insertFill.run(`fillpost-${i}`, `Fill ${i}`, author);
    const fullPages = (postKeys.length + fill) / 50;
    const sizes: number[] = [];
    let lastCursor: string | null = 'start';
    cursor = null;
    do {
        const r = await post('/api/local/admin/data/posts', owner, { limit: 50, cursor });
        if (r.status !== 200) { assert(false, `a posts page of 50 answered ${r.status}`); break; }
        sizes.push(r.json.posts.length);
        cursor = r.json.nextCursor;
        lastCursor = cursor;
    } while (cursor && sizes.length < 1_000);
    assert(Number.isInteger(fullPages) && sizes.length === fullPages && sizes.every(n => n === 50) && lastCursor === null,
        `${postKeys.length + fill} posts at 50 a page: ${fullPages} full pages, the last with no cursor, no empty page after it (pages: ${sizes.length}, the last ${sizes[sizes.length - 1]})`);

    // ── 5. Past the size the whole answer is sent at ──
    console.log('\n── 5. Past 1,000 members: refused plainly, and the pages carry it ──');
    seedMembers(2_500);
    const members = liveMemberCount();
    const refused = await post('/api/local/admin/data', owner);
    assert(refused.status === 413 && refused.json?.code === 'admin_data_paged' && refused.json.counts?.members === members
        && /too many to send in one answer/.test(refused.json.error) && refused.json.pages?.members === '/api/local/admin/data/members',
        `an older console asking for the lists of ${members} members is told so: ${refused.status} ${JSON.stringify(refused.json)?.slice(0, 220)}`);
    assert(refused.bytes < 2_000, `…in a small answer (${refused.bytes} B), with nothing built`);
    const summary2 = await post('/api/local/admin/data', owner, { lists: 'none' });
    assert(summary2.status === 200 && summary2.json.counts.members === members && summary2.bytes < summary.bytes + 512,
        `the summary at ${members} members is no bigger (${summary2.bytes} B against ${summary.bytes} B at 1,000)`);
    const walk2 = await walkMembers(owner, 200);
    console.log(`   ${walk2.pages} pages of 200; the biggest ${(walk2.maxPageBytes / 1024).toFixed(0)} KB, the slowest ${walk2.maxPageMs.toFixed(0)} ms`);
    assert(walk2.keys.length === members && new Set(walk2.keys).size === members && walk2.total === members,
        `the walk at ${members} members meets each once (${walk2.keys.length}, ${new Set(walk2.keys).size} different, total ${walk2.total})`);
    assert(walk2.maxPageBytes < 2.5 * walk.maxPageBytes, `a page of 200 stays bounded by its size as the node grows (${walk2.maxPageBytes} B)`);
    // A member who joins during a walk is met at its end, and nobody twice.
    const half = await post('/api/local/admin/data/members', owner, { limit: 200 });
    seedMembers(1);
    const joined = db.prepare(`SELECT public_key FROM members ORDER BY joined_at DESC, public_key DESC LIMIT 1`).pluck().get() as string;
    const rest: string[] = [];
    let c: string | null = half.json.nextCursor;
    while (c) { const r = await post('/api/local/admin/data/members', owner, { limit: 200, cursor: c }); rest.push(...r.json.members.map((m: any) => m.publicKey)); c = r.json.nextCursor; }
    const all = [...half.json.members.map((m: any) => m.publicKey), ...rest];
    assert(all.length === members + 1 && new Set(all).size === all.length && all[all.length - 1] === joined,
        `a member who joined mid-walk is met once, at the end (${all.length} of ${members + 1})`);

    // ── 6. Every credential, as /admin/data answers it ──
    console.log('\n── 6. Who may read the pages: whoever may read /admin/data ──');
    const admin = adminSession('admin');
    const mod = adminSession('moderator');
    const lapsed = adminSession('moderator');
    revokeNodeRole(lapsed.pub, 'moderator', admin.pub);
    const creds: Array<[string, Record<string, string>]> = [
        ['no credential', {}],
        ['a wrong password', { 'X-Admin-Password': 'not-the-password' }],
        ['a member with no role', lapsed.headers],
        ['a moderator', mod.headers],
        ['an admin who is not an owner', admin.headers],
        ['an owner', owner],
    ];
    for (const [who, h] of creds) {
        resetAdminAuthTarpit();
        const data = await post('/api/local/admin/data', h, { lists: 'none' });
        resetAdminAuthTarpit();
        const m = await post('/api/local/admin/data/members', h, { limit: 5 });
        resetAdminAuthTarpit();
        const p = await post('/api/local/admin/data/posts', h, { limit: 5 });
        const allowed = who === 'an owner' || who === 'an admin who is not an owner';
        assert(m.status === data.status && p.status === data.status && (allowed ? data.status === 200 : data.status === 401 || data.status === 403),
            `${who}: /admin/data ${data.status}, members page ${m.status}, posts page ${p.status}`);
        if (!allowed) assert(!JSON.stringify(m.json ?? {}).includes('Seeded') && !JSON.stringify(p.json ?? {}).includes('Seeded'), `${who}: no member or post in the refusal`);
    }
    const modData = await post('/api/local/admin/data/members', mod.headers, {});
    assert(modData.status === 403 && modData.json?.moderator === true, `a moderator is refused the members page as /admin/data refuses them (${modData.status})`);

    // ── 8. The prune-branch confirmation, from the node ──
    console.log('\n── 8. The figures a branch prune is confirmed on: the whole branch, from the node ──');
    const epoch = ledger.getCurrentEpoch();
    const branchMember = (callsign: string, joined: string, invitedBy: string, beans: number, status = 'active') => {
        const pub = crypto.randomBytes(32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, ?, ?, ?, 'seed')`)
            .run(pub, callsign, status, joined, invitedBy);
        db.prepare(`INSERT INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, ?, ?)`).run(pub, hc(beans), epoch);
        return pub;
    };
    // The root joined before every seeded member, so it is on page 1; the members it brought in joined after them all, so
    // they are on the last pages. One it brought in is pruned already, and the member they brought in is not.
    const root = branchMember('Branch Root', '2025-01-01T00:00:00.000Z', 'genesis', 40);
    const kidA = branchMember('Branch Kid A', '2027-01-01T00:00:00.000Z', root, -25.5);
    const kidB = branchMember('Branch Kid B', '2027-01-01T00:01:00.000Z', root, 10);
    const grandkid = branchMember('Branch Grandkid', '2027-01-01T00:02:00.000Z', kidA, -100);
    const gone = branchMember('Branch Gone', '2027-01-01T00:03:00.000Z', root, 0, 'pruned');
    const underGone = branchMember('Branch Under Gone', '2027-01-01T00:04:00.000Z', gone, 5);
    reconcileLedgerFromDb();
    const branchKeys = [root, kidA, kidB, grandkid, underGone];
    const firstPage = await post('/api/local/admin/data/members', owner, { limit: 100 });
    const onFirst = new Set(firstPage.json.members.map((m: any) => m.publicKey));
    assert(onFirst.has(root) && branchKeys.slice(1).every(k => !onFirst.has(k)) && typeof firstPage.json.nextCursor === 'string',
        `the premise: page 1 of ${liveMemberCount()} members holds the branch's root and none of the members under it`);
    const ownerSession = ownerSessionHeaders();
    const looksBefore = db.prepare(`SELECT COUNT(*) FROM health_access_log WHERE action = 'offboard_preview'`).pluck().get() as number;
    const preview = await get(`/api/local/admin/branches/${root}/prune`, ownerSession);
    assert(preview.status === 200 && preview.json?.members === 5 && preview.json.badDebt_c === hc(125.5) && preview.json.surplus_c === hc(55) && preview.json.net_c === hc(-70.5),
        `an owner reads the whole branch: 5 members (the pruned one left out, the one under them in), 125.5 bad debt, 55 surplus, -70.5 net (${preview.status} ${JSON.stringify(preview.json)})`);
    assert(JSON.stringify(Object.keys(preview.json ?? {}).sort()) === JSON.stringify(['badDebt_c', 'members', 'net_c', 'surplus_c']),
        `totals only: no names, no keys (${Object.keys(preview.json ?? {}).join(', ')})`);
    const looks = db.prepare(`SELECT subject_pubkey FROM health_access_log WHERE action = 'offboard_preview' ORDER BY rowid DESC LIMIT 5`).pluck().all() as string[];
    const looksAfter = db.prepare(`SELECT COUNT(*) FROM health_access_log WHERE action = 'offboard_preview'`).pluck().get() as number;
    assert(looksAfter - looksBefore === 5 && branchKeys.every(k => looks.includes(k)),
        `each balance in the totals is a look in the owners' access log, as the offboarding preview's is (${looksAfter - looksBefore} lines)`);
    // A branch of one is an owner's to prune where the community does not vote (the switch off: the global node, or an
    // operator who turned votes off). This node is local, where it votes by default: 8b reads the same with the switch on.
    setSwitchOverride('decisions', false);
    const leaf = await get(`/api/local/admin/branches/${kidB}/prune`, ownerSession);
    setSwitchOverride('decisions', true);
    assert(leaf.status === 200 && leaf.json?.members === 1 && leaf.json.surplus_c === hc(10) && leaf.json.badDebt_c === 0 && leaf.json.net_c === hc(10),
        `a branch of one: 1 member, 10 surplus (${JSON.stringify(leaf.json)})`);
    const nobody = await get(`/api/local/admin/branches/${'ab'.repeat(32)}/prune`, ownerSession);
    assert(nobody.status === 404, `a key that is no member's: 404 (${nobody.status})`);
    // The same owners as the prune itself: whoever the prune refuses is refused the figures too, and told nothing of them.
    for (const [who, h] of [
        ['no credential', {}],
        ['a wrong password', { 'X-Admin-Password': 'not-the-password' }],
        ['a member with no role', lapsed.headers],
        ['a moderator', mod.headers],
        ['an admin who is not an owner', admin.headers],
        ["an owner's automation token", owner],
    ] as Array<[string, Record<string, string>]>) {
        resetAdminAuthTarpit();
        const r = await get(`/api/local/admin/branches/${root}/prune`, h);
        resetAdminAuthTarpit();
        const pruneTry = await post(`/api/local/admin/branches/${root}/prune`, h, {});
        assert((r.status === 401 || r.status === 403) && r.status === pruneTry.status && !('members' in (r.json ?? {})) && !('net' in (r.json ?? {})) && !('net_c' in (r.json ?? {})),
            `${who}: refused the figures (${r.status}) as the prune refuses them (${pruneTry.status}), with none of them`);
    }
    const stillThere = db.prepare(`SELECT COUNT(*) FROM members WHERE public_key IN (SELECT value FROM json_each(?)) AND status != 'pruned'`).pluck().get(JSON.stringify(branchKeys));
    assert(stillThere === 5, 'and none of those refusals pruned anyone');
    // The prune then settles what the figures said: the Commons moves by `net`, and every one of the five is pruned.
    const commonsBefore = getCommonsBalanceExact();
    const pruned = await post(`/api/local/admin/branches/${root}/prune`, ownerSession, {});
    const commonsMoved = getCommonsBalanceExact() - commonsBefore; // whole hundredths, exact
    const prunedNow = db.prepare(`SELECT COUNT(*) FROM members WHERE public_key IN (SELECT value FROM json_each(?)) AND status = 'pruned'`).pluck().get(JSON.stringify(branchKeys));
    assert(pruned.status === 200 && commonsMoved === hc(-70.5) && commonsMoved === preview.json?.net_c && prunedNow === preview.json.members,
        `the owner's prune removes the ${prunedNow} members the figures counted and moves the Commons by their net, ${commonsMoved} hundredths (${pruned.status} ${JSON.stringify(pruned.json)})`);

    // Where the community votes, a branch of one is a direct removal only its vote makes (branchRemovalRefusal): the
    // figures are refused as the prune and the offboarding preview refuse it, before any balance is read, so the owner
    // learns nothing of that member's balance and the owners' log shows no look "while removing them".
    console.log('\n── 8b. Where the community votes: a branch of one is refused its figures, before any balance is read ──');
    setSwitchOverride('decisions', true);
    const voteLeaf = branchMember('Vote Leaf', '2027-02-01T00:00:00.000Z', 'genesis', -42.17);
    const voteRoot = branchMember('Vote Root', '2027-02-01T00:01:00.000Z', 'genesis', 8);
    const voteKid = branchMember('Vote Kid', '2027-02-01T00:02:00.000Z', voteRoot, -3);
    reconcileLedgerFromDb();
    const leafLooks = () => db.prepare(`SELECT COUNT(*) FROM health_access_log WHERE action = 'offboard_preview' AND subject_pubkey = ?`).pluck().get(voteLeaf) as number;
    const allLooks = () => db.prepare(`SELECT COUNT(*) FROM health_access_log WHERE action = 'offboard_preview'`).pluck().get() as number;
    const leafLooksBefore = leafLooks();
    const allLooksBefore = allLooks();
    const voteFigures = await get(`/api/local/admin/branches/${voteLeaf}/prune`, ownerSession);
    const votePrune = await post(`/api/local/admin/branches/${voteLeaf}/prune`, ownerSession, {});
    const voteOffboard = await get(`/api/local/admin/members/${voteLeaf}/offboard/preview`, ownerSession);
    assert(voteFigures.status === 400 && voteFigures.json?.code === 'removal_is_the_vote' && typeof voteFigures.json?.error === 'string',
        `a leaf member at -42.17: the figures are refused, removal_is_the_vote (${voteFigures.status} ${JSON.stringify(voteFigures.json)})`);
    assert(votePrune.status === 400 && votePrune.json?.code === voteFigures.json?.code && votePrune.json?.error === voteFigures.json?.error
        && voteOffboard.status === 400 && voteOffboard.json?.code === voteFigures.json?.code,
        `in the words the prune (${votePrune.status}) and the offboarding preview (${voteOffboard.status}) refuse it in`);
    assert(['members', 'badDebt', 'surplus', 'net', 'badDebt_c', 'surplus_c', 'net_c'].every(k => !(k in (voteFigures.json ?? {})))
        && !JSON.stringify(voteFigures.json ?? {}).includes('42.17') && !JSON.stringify(voteFigures.json ?? {}).includes(String(hc(42.17))),
        `none of the figures, and not the member's balance, in the refusal (${Object.keys(voteFigures.json ?? {}).join(', ')})`);
    assert(leafLooks() === leafLooksBefore && allLooks() === allLooksBefore,
        `no look in the owners' access log for a removal the node refuses (${allLooks() - allLooksBefore} new lines)`);
    const voteBranch = await get(`/api/local/admin/branches/${voteRoot}/prune`, ownerSession);
    assert(voteBranch.status === 200 && voteBranch.json?.members === 2 && voteBranch.json.badDebt_c === hc(3) && voteBranch.json.surplus_c === hc(8) && voteBranch.json.net_c === hc(5)
        && allLooks() - allLooksBefore === 2,
        `a branch of more than one, an owner's to prune where the community votes, still gets its figures and its 2 looks (${voteBranch.status} ${JSON.stringify(voteBranch.json)})`);
    const voteStill = db.prepare(`SELECT COUNT(*) FROM members WHERE public_key IN (?, ?, ?) AND status != 'pruned'`).pluck().get(voteLeaf, voteRoot, voteKid);
    assert(voteStill === 3, 'and nobody was pruned by those reads or the refused prune');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
