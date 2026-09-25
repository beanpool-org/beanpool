/**
 * A member's own standing, `GET /api/community/me` (G11-e, design G11 §6): what the web app's "Your account is new"
 * card reads. Over REAL HTTPS through the real signature middleware; "the clock" is faked by moving joined_at back.
 *
 *   1. local profile (NODE_PROFILE unset): a member who joined just now is not on probation (exemptBecause 'off'),
 *      and still sees the rule as data (endsWhen) and every limit with used / remaining / resetsAt
 *   2. global profile, a new member: after a post with 2 photos and a conversation opened with someone new, on
 *      probation with posts 1 used / 2 left, photos 2 / 3, new people 1 / 9, each resetsAt a day after the use; an
 *      untouched limit has resetsAt null; ageEndsAt 3 days after joining; 1 of 3 kept posts; endsWhen 72 h / 3 posts;
 *      the answer is private, no-store
 *   3. global profile, a member past the rule (10 days, 3 kept posts): not on probation, exemptBecause null
 *   4. global profile, a node role (a moderator who joined just now, no posts): not on probation, exemptBecause 'role'
 *   5. nobody reads anyone else's: unsigned → 401 (with or without an X-Public-Key naming a member); a signed key that
 *      is not a member here → 403; a member's signature under another member's X-Public-Key → refused; a member who
 *      names someone else in the query string gets their OWN standing; there is no /api/community/me/:publicKey
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-community-me.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_WS_AUTH;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
const HOUR = 60 * 60 * 1000, DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
/** Within a minute of `expected`: the test's clock and the node's are the same clock, a few requests apart. */
const near = (iso: unknown, expected: number) => typeof iso === 'string' && Math.abs(Date.parse(iso) - expected) < 60_000;

let BASE = '';

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
/** A member who joined `daysAgo` days ago, with a profile photo (posting needs one). */
function member(name: string, daysAgo: number): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, ?, ?, 'TEST', 'https://example.com/a.jpg', 'active')`).run(id.pk, name, ago(daysAgo * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any; headers: Headers }
/** A request signed by `signer`; `claim` is the X-Public-Key it goes out under (the signer's own unless a test lies). */
async function call(method: 'GET' | 'POST', signer: Id | null, path: string, body?: unknown, opts: { claim?: string; headers?: Record<string, string> } = {}): Promise<Res> {
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (signer) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.claim ?? signer.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
}
const me = (id: Id) => call('GET', id, '/api/community/me');

const photo = (seed: string) => {
    // A JPEG the metadata strip can walk (see test-global-moderation): SOI, a scan header, a scan with no 0xFF, EOI.
    const scan = crypto.createHash('sha512').update(seed).digest().map(b => (b === 0xff ? 0xfe : b));
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]), scan, Buffer.from([0xff, 0xd9])]);
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
let n = 0;
const post = (id: Id, extra: Record<string, unknown> = {}) =>
    call('POST', id, '/api/marketplace/posts', { type: 'offer', category: 'other', title: `${id.name} offer ${++n}`, description: 'An offer', credits: 0, authorPublicKey: id.pk, ...extra });
/** A post written straight into the engine two days ago: kept, and out of every window. */
function oldPost(id: Id, title: string): void {
    const p = createPost('offer', 'other', title, `${title} description`, 0, 'fixed', id.pk)!;
    db.prepare('UPDATE posts SET created_at = ? WHERE id = ?').run(ago(2 * DAY), p.id);
}

async function main(): Promise<void> {
    console.log('\n=== A member\'s own standing: GET /api/community/me (G11-e) ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');

    // ── 1. local profile ─────────────────────────────────────────────────────────────────────────
    console.log('── 1. local profile ──');
    const lou = member('Lou', 0);
    const local = await me(lou);
    const lp = local.body?.probation;
    assert(local.status === 200 && lp?.onProbation === false && lp?.exemptBecause === 'off',
        `local: a member who joined just now is not on probation, because it is off here (got ${local.status} ${JSON.stringify({ o: lp?.onProbation, e: lp?.exemptBecause })})`);
    assert(lp?.endsWhen?.hours === 72 && lp?.endsWhen?.keptPosts === 3,
        `local: the rule is there as data, 72 hours and 3 kept posts (got ${JSON.stringify(lp?.endsWhen)})`);
    assert(lp?.limits?.posts?.limit === 3 && lp?.limits?.posts?.used === 0 && lp?.limits?.posts?.remaining === 3 && lp?.limits?.posts?.resetsAt === null,
        `local: posts 0 used, 3 left, nothing to reset (got ${JSON.stringify(lp?.limits?.posts)})`);

    // ── 2. global profile: a new member ──────────────────────────────────────────────────────────
    console.log('\n── 2. global profile: a new member ──');
    process.env.NODE_PROFILE = 'global';
    const nia = member('Nia', 0);
    const niaJoined = Date.parse((db.prepare('SELECT joined_at FROM members WHERE public_key = ?').get(nia.pk) as { joined_at: string }).joined_at);
    const before = await me(nia);
    assert(before.status === 200 && before.body?.probation?.onProbation === true && before.body?.probation?.exemptBecause === null
        && before.body?.probation?.limits?.posts?.remaining === 3 && before.body?.probation?.limits?.photos?.remaining === 5
        && before.body?.probation?.limits?.new_dm_recipients?.remaining === 10,
        `a member who joined just now is on probation with every allowance left (got ${before.status} ${JSON.stringify(before.body?.probation)?.slice(0, 240)})`);
    const posted = await post(nia, { photos: [photo('a'), photo('b')] });
    const postedAt = Date.now();
    assert(posted.status === 200, `setup: Nia posts an offer with 2 photos (${posted.status} ${posted.body?.error ?? ''})`);
    const zed = member('Zed', 40);
    const opened = await call('POST', nia, '/api/messages/conversation', { type: 'dm', participants: [nia.pk, zed.pk], createdBy: nia.pk });
    const openedAt = Date.now();
    assert(opened.status === 200, `setup: Nia opens a conversation with Zed, who she has never reached (${opened.status} ${opened.body?.error ?? ''})`);

    const after = await me(nia);
    const p = after.body?.probation;
    assert(after.status === 200 && after.body?.publicKey === nia.pk && p?.onProbation === true && p?.exemptBecause === null,
        `Nia reads her own standing: on probation (got ${after.status} ${JSON.stringify({ k: after.body?.publicKey?.slice(0, 8), o: p?.onProbation, e: p?.exemptBecause })})`);
    assert(p?.limits?.posts?.limit === 3 && p?.limits?.posts?.used === 1 && p?.limits?.posts?.remaining === 2 && near(p?.limits?.posts?.resetsAt, postedAt + DAY),
        `posts: 1 used, 2 left, one back a day after the post (got ${JSON.stringify(p?.limits?.posts)})`);
    assert(p?.limits?.photos?.limit === 5 && p?.limits?.photos?.used === 2 && p?.limits?.photos?.remaining === 3 && near(p?.limits?.photos?.resetsAt, postedAt + DAY),
        `photos: 2 used, 3 left, back a day after the post (got ${JSON.stringify(p?.limits?.photos)})`);
    assert(p?.limits?.new_dm_recipients?.limit === 10 && p?.limits?.new_dm_recipients?.used === 1 && p?.limits?.new_dm_recipients?.remaining === 9
        && near(p?.limits?.new_dm_recipients?.resetsAt, openedAt + DAY),
        `new people: 1 reached, 9 left, back a day after the opening (got ${JSON.stringify(p?.limits?.new_dm_recipients)})`);
    assert(near(p?.ageEndsAt, niaJoined + 3 * DAY) && p?.keptPosts === 1 && p?.keptPostsNeeded === 3 && p?.endsWhen?.hours === 72 && p?.endsWhen?.keptPosts === 3,
        `it ends 3 days after joining, and she has 1 of the 3 kept posts it needs (got ${JSON.stringify({ a: p?.ageEndsAt, k: p?.keptPosts, n: p?.keptPostsNeeded, w: p?.endsWhen })})`);
    const cache = after.headers.get('cache-control') ?? '';
    assert(/private/.test(cache) && /no-store/.test(cache), `the answer is one member's own: private, no-store (got "${cache}")`);

    // A reply is never limited, and a line to Zed now is to someone already reached: still 1.
    const lineToZed = await call('POST', nia, '/api/messages/send', { conversationId: opened.body?.conversation?.id, authorPubkey: nia.pk, ciphertext: 'aGk=', nonce: 'bm9uY2U=' });
    assert(lineToZed.status === 200 && (await me(nia)).body?.probation?.limits?.new_dm_recipients?.used === 1,
        `a line to Zed after opening it counts nobody new: still 1 (${lineToZed.status})`);

    // ── 3. past the rule ─────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. global profile: past the rule ──');
    const oli = member('Oli', 10);
    for (let i = 0; i < 3; i++) oldPost(oli, `Oli kept ${i}`);
    const oliMe = (await me(oli)).body?.probation;
    assert(oliMe?.onProbation === false && oliMe?.exemptBecause === null && oliMe?.keptPosts === 3,
        `10 days in with 3 kept posts: not on probation, and not exempt, just past it (got ${JSON.stringify({ o: oliMe?.onProbation, e: oliMe?.exemptBecause, k: oliMe?.keptPosts })})`);
    const ivy = member('Ivy', 10);
    assert((await me(ivy)).body?.probation?.onProbation === true, '10 days in with no posts: still on probation (fewer than 3 kept)');

    // ── 4. a node role ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. global profile: a node role ──');
    const mo = member('Mo', 0);
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    const moMe = (await me(mo)).body?.probation;
    assert(moMe?.onProbation === false && moMe?.exemptBecause === 'role',
        `a moderator who joined just now is exempt: the owner trusted them (got ${JSON.stringify({ o: moMe?.onProbation, e: moMe?.exemptBecause })})`);

    // ── 5. nobody reads anyone else's ────────────────────────────────────────────────────────────
    console.log('\n── 5. nobody reads anyone else\'s ──');
    const unsigned = await call('GET', null, '/api/community/me');
    assert(unsigned.status === 401 && unsigned.body?.probation === undefined, `unsigned → 401, no standing (got ${unsigned.status})`);
    const claimOnly = await call('GET', null, '/api/community/me', undefined, { headers: { 'X-Public-Key': nia.pk } });
    assert(claimOnly.status === 401 && claimOnly.body?.probation === undefined,
        `an X-Public-Key naming Nia with no signature → 401, not Nia's standing (got ${claimOnly.status})`);
    const outsider = newId('Out');
    const notMember = await me(outsider);
    assert(notMember.status === 403 && notMember.body?.probation === undefined, `a signed key that is not a member here → 403 (got ${notMember.status})`);
    const forged = await call('GET', zed, '/api/community/me', undefined, { claim: nia.pk });
    assert(forged.status >= 400 && forged.body?.probation === undefined,
        `Zed's signature under Nia's key is refused, and hands back nothing (got ${forged.status})`);
    const byQuery = await call('GET', zed, `/api/community/me?publicKey=${nia.pk}&pubkey=${nia.pk}&actor=${nia.pk}`);
    assert(byQuery.status === 200 && byQuery.body?.publicKey === zed.pk && byQuery.body?.probation?.limits?.posts?.used === 0,
        `Zed naming Nia in the query string gets his OWN standing, not hers (got ${byQuery.status} ${byQuery.body?.publicKey?.slice(0, 8)})`);
    const byPath = await call('GET', zed, `/api/community/me/${nia.pk}`);
    assert(byPath.body?.probation === undefined && byPath.status >= 400,
        `there is no /api/community/me/:publicKey to read Nia's through (got ${byPath.status})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
