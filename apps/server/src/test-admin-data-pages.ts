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
 *
 * Run: SERVER_SUITES_ONLY=test-admin-data-pages TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
process.env.ADMIN_PASSWORD = 'TestAdminDataPages123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, grantNodeRole, revokeNodeRole } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';
import { mintHandshakeToken, consumeHandshakeToken } from './admin-key-auth.js';
import { resetAdminAuthTarpit } from './admin-auth.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';
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
    const insertAccount = db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`);
    const insertToken = db.prepare(`INSERT OR IGNORE INTO push_tokens (public_key, token_id, token_box, platform) VALUES (?, ?, 'box', ?)`);
    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at)
        VALUES (?, 'offer', 'misc', ?, ?, 10, ?, 'active', 1, ?, ?)`);
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
    initAdminPassword();
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

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
