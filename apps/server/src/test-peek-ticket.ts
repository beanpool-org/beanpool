/**
 * The peek ticket (front doors S6, scratch/fable-design/DESIGN-entry-points-fable.md §3.4; engine/peek-tickets.ts,
 * routes/peek.ts). Over REAL HTTPS through the real signature middleware, read auth on, a local community as it ships:
 *
 *   1. a member asks for a link (POST /api/peek, signed): a 22-character ticket, seven days; unsigned, a non-member and a
 *      post a visitor could not be shown (a group's, a direct one, one hidden by reports, a paused one, a gone one) refused
 *   2. the one read a ticket opens (GET /api/marketplace/posts/:id?peek=), unsigned and signed by a non-member: `{ post }`
 *      and nothing else, through guestPost: no member's key or name, no face, no typed place, no place finer than its
 *      area, no join link or private note, nobody going; its photo loads; never cached; HEAD too
 *   3. what a ticket never opens, each answered exactly as the same caller is answered with no ticket at all: a forged
 *      ticket, a malformed one, two of them, another post, the board, a read by `?id=`, a post's chat
 *   4. Stop sharing: only the member who shared it; their list names the post, never the ticket; stopped, it opens nothing
 *   5. run out (seven days), the post taken down, the sharer no longer a member: each opens nothing
 *   6. the owners' switch "Members may share listings outside the community": off stops every link and refuses new ones,
 *      `features.shareOutside` goes; on again, the old links stay stopped and a new one works; a private preview opens
 *      nothing
 *   7. the share page (`/?post=&peek=`): plain HTML, no script, Open Graph tags with the photo, the doors per device
 *      (Android: the app by intent, falling back to Google Play with the peek in the referrer; iPhone: beanpool://peek;
 *      a computer: the browser), names nobody; a member's browser goes to the web app; a link that opens nothing is the
 *      community's card
 *   8. at most 50 links open at once per member
 *
 * Fail-first: on origin/main every section fails (there is no /api/peek, the read is gated, `/` redirects).
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-peek-ticket.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.GLOBAL_COMMUNITY_URL;
delete process.env.DIRECTORY_UNLISTED;
delete process.env.PRIVATE_PREVIEW;
process.env.REGISTRAR_URL = 'http://127.0.0.1:1';
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:1/directory-register';
process.env.ADMIN_PASSWORD = 'PeekTicketAdmin123!';

import crypto from 'node:crypto';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const HOST = 'peek-test.example.org';
const NAME = 'Sentinelvale Commons';
// The listing's place, and what any rounding finer than its area (0.1°) would print: none may appear.
const PLACE = { lat: -37.0657, lng: 144.2169 };
const PLACE_DIGITS = ['37.0657', '144.2169', '-37.07', '144.22', '37.066', '144.217'];
const DAY = 86_400_000;
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

interface Id { pk: string; priv: crypto.KeyObject }
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey };
}

let beforeCall: () => void = () => {};
interface Res { status: number; text: string; body: any; headers: Headers }
async function call(method: string, path: string, opts: { id?: Id | null; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
    beforeCall();
    const bodyString = opts.body === undefined ? '' : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.id.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), opts.id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? bodyString : undefined, redirect: 'manual' });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* HTML, or empty */ }
    return { status: res.status, text, body, headers: res.headers };
}
const get = (path: string, id: Id | null = null, headers?: Record<string, string>) => call('GET', path, { id, headers });

async function main(): Promise<void> {
    console.log('\n=== The peek ticket: one post shared outside the community (S6) ===\n');
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const createPost = wrapCreatePost(se.createPost);
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { APP_DOCUMENT_CSP } = await import('./app-document-csp.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    beforeCall = () => { resetGatewayRateLimit(); resetAdminRateLimit(); resetAdminAuthTarpit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    initAdminPassword();
    se.initStateEngine();
    const OWNER = (await import('./admin-auth-test-harness.js')).ownerSessionHeaders();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    // ── the community: three members, each with a face; listings, an event, a group's and a direct post ─────────
    const TEST_FACE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`)
            .run(id.pk, callsign, new Date(Date.now() - 30 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)').run(id.pk, 0);
        setMemberPhoto(db, id.pk, TEST_FACE);
        return id;
    };
    const alice = member('SentinelAlice');
    const bob = member('SentinelBob');
    const carol = member('SentinelCarol');
    const outsider = newId();
    const people = [alice, bob, carol];
    const NAMES = ['SentinelAlice', 'SentinelBob', 'SentinelCarol'];

    updateLocalConfig({ communityName: NAME } as any);
    se.updateNodeConfig({
        publicAddress: { mode: 'own', hostname: HOST, status: 'live', since: new Date().toISOString() },
    } as any);

    const offer = createPost('offer', 'tools', 'Sentinel ladder to lend', 'A tall ladder.\nLight enough to carry.', 5, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    const other = createPost('offer', 'food', 'Sentinel lemons to give', 'Lemons, any amount.', 2, 'fixed', bob.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    const startAt = new Date(Date.now() + 3 * DAY).toISOString();
    const endAt = new Date(Date.now() + 3 * DAY + 2 * 3_600_000).toISOString();
    const event = createPost('event', 'social', 'Sentinel working bee', 'Bring gloves.', 0, 'fixed', bob.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {
        eventStartAt: startAt, eventEndAt: endAt, eventPlaceName: '42 Sentinel Crescent', eventPrivateNote: 'Gate code 4417',
    });
    const groupPost = createPost('offer', 'tools', 'Sentinel group drill', 'For the group.', 1, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = 'g-sentinel' WHERE id = ?").run(groupPost.id);
    const directPost = createPost('offer', 'tools', 'Sentinel direct saw', 'For one.', 1, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    db.prepare("UPDATE posts SET audience_scope = 'direct', target_pubkey = ? WHERE id = ?").run(bob.pk, directPost.id);
    const hiddenPost = createPost('offer', 'tools', 'Sentinel hidden thing', 'Reported.', 1, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), hiddenPost.id);
    const pausedPost = createPost('offer', 'tools', 'Sentinel paused thing', 'Paused.', 1, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(pausedPost.id);

    /** What a ticket holder must never read, in a body. */
    const leaks = (text: string): string[] => {
        const found: string[] = [];
        for (const p of people) if (text.includes(p.pk)) found.push('a member key');
        for (const n of NAMES) if (text.includes(n)) found.push(`the name ${n}`);
        for (const d of PLACE_DIGITS) if (text.includes(d)) found.push(`the place ${d}`);
        if (text.includes('/api/avatar/')) found.push('a face URL');
        if (text.includes('42 Sentinel Crescent')) found.push('the typed place');
        if (text.includes('Gate code 4417')) found.push('the private note');
        return found;
    };

    const peekRead = (postId: string, ticket: string, id: Id | null = null) => get(`/api/marketplace/posts/${postId}?peek=${encodeURIComponent(ticket)}`, id);
    const share = (id: Id | null, postId: string) => call('POST', '/api/peek', { id, body: { postId } });

    // ── 1. a member asks for a link ────────────────────────────────────────────────────────────
    console.log('── 1. a member asks for a link to one post ──');
    const made = await share(alice, offer.id);
    const T1: string = made.body?.ticket;
    assert(made.status === 201 && /^[A-Za-z0-9_-]{22}$/.test(T1 ?? '') && made.body?.postId === offer.id && typeof made.body?.id === 'string',
        `POST /api/peek, signed by a member: 201 with a 22-character ticket for that post (${made.status} ${made.text.slice(0, 120)})`);
    const lasts = Date.parse(made.body?.expiresAt) - Date.now();
    assert(lasts > 7 * DAY - 60_000 && lasts <= 7 * DAY, `it runs out in seven days (${Math.round(lasts / 3_600_000)} h)`);
    const stored = db.prepare('SELECT ticket_hash, sharer_pubkey, post_id FROM peek_tickets WHERE id = ?').get(made.body?.id) as any;
    assert(!!stored && stored.ticket_hash === crypto.createHash('sha256').update(T1).digest('hex') && stored.sharer_pubkey === alice.pk
        && !JSON.stringify(db.prepare('SELECT * FROM peek_tickets').all()).includes(T1),
        'the node keeps the ticket\'s SHA-256, the post and the sharer, never the ticket itself');
    const unsignedShare = await share(null, offer.id);
    assert(unsignedShare.status === 401, `unsigned: refused (${unsignedShare.status})`);
    const outsiderShare = await share(outsider, offer.id);
    assert(outsiderShare.status === 403 && outsiderShare.body?.code === 'not_a_member', `a key that is no member: 403 not_a_member (${outsiderShare.status} ${outsiderShare.body?.code})`);
    for (const [label, p] of [['a group\'s post', groupPost], ['a direct post', directPost], ['a post hidden by reports', hiddenPost], ['a paused listing', pausedPost]] as const) {
        const r = await share(alice, p.id);
        assert(r.status === 403 && r.body?.code === 'not_shareable', `${label}: 403 not_shareable (${r.status} ${r.body?.code})`);
    }
    const noSuch = await share(alice, crypto.randomUUID());
    const badId = await share(alice, '../etc');
    assert(noSuch.status === 403 && badId.status === 403 && noSuch.body?.code === 'not_shareable', `a post that isn't there, or no post id: 403 not_shareable (${noSuch.status}, ${badId.status})`);
    // Any member may share a post everyone here sees, not only its author.
    const bobsShare = await share(bob, offer.id);
    const T2: string = bobsShare.body?.ticket;
    assert(bobsShare.status === 201 && T2 !== T1, `another member shares the same post: their own ticket (${bobsShare.status})`);

    // ── 2. the one read a ticket opens ─────────────────────────────────────────────────────────
    console.log('\n── 2. the read a ticket opens: that post, under the visitors\' rules ──');
    for (const [who, id] of [['unsigned', null], ['a non-member signer', outsider]] as const) {
        const r = await peekRead(offer.id, T1, id);
        const p = r.body?.post;
        assert(r.status === 200 && !!p && Object.keys(r.body).join() === 'post', `${who}: 200 { post } and nothing else (${r.status} ${r.text.slice(0, 80)})`);
        assert(p?.id === offer.id && p?.title === 'Sentinel ladder to lend' && p?.type === 'offer' && p?.credits === 5,
            `${who}: the listing itself: its title, kind and price`);
        assert(p?.authorPublicKey === 'hidden' && p?.authorCallsign === '' && p?.authorAvatarUrl === null && !('acceptedBy' in (p ?? {})),
            `${who}: nobody in it: the author hidden, no name, no face`);
        assert(Math.abs(p?.lat - Math.round(PLACE.lat * 10) / 10) < 1e-9 && Math.abs(p?.lng - Math.round(PLACE.lng * 10) / 10) < 1e-9,
            `${who}: the place at its area (${p?.lat}, ${p?.lng})`);
        const found = leaks(r.text);
        assert(found.length === 0, `${who}: no member key or name, no face, no place finer than its area${found.length ? ` — ${found.join(', ')}` : ''}`);
        assert(/private/.test(r.headers.get('cache-control') ?? '') && /no-store/.test(r.headers.get('cache-control') ?? ''),
            `${who}: never kept by a cache (${r.headers.get('cache-control')})`);
    }
    const photoUrl: string | undefined = (await peekRead(offer.id, T1)).body?.post?.photos?.[0];
    const photo = photoUrl ? await get(photoUrl) : null;
    assert(!!photoUrl && /[?&]k=/.test(photoUrl) && photo?.status === 200 && /^image\//.test(photo.headers.get('content-type') ?? ''),
        `its photo loads from the URL the read hands out (the listing's key in it): ${photo?.status}`);
    const head = await call('HEAD', `/api/marketplace/posts/${offer.id}?peek=${T1}`);
    assert(head.status === 200 && head.text === '', `HEAD with the ticket: 200, no body (${head.status})`);
    const evMade = await share(carol, event.id);
    const ev = await peekRead(event.id, evMade.body?.ticket);
    const evp = ev.body?.post;
    assert(ev.status === 200 && evp?.type === 'event' && evp?.eventStartAt === startAt
        && !('eventPlaceName' in (evp ?? {})) && !('eventPrivateNote' in (evp ?? {})) && !('eventRsvps' in (evp ?? {})) && !('eventLink' in (evp ?? {}))
        && leaks(ev.text).length === 0,
        `an event: when it is, and no typed place, private note, join link or who is going (${ev.status}${leaks(ev.text).length ? ` — ${leaks(ev.text).join(', ')}` : ''})`);

    // ── 3. what a ticket never opens ───────────────────────────────────────────────────────────
    console.log('\n── 3. what a ticket never opens: each as the same caller is answered with no ticket at all ──');
    const plain = { unsigned: await get(`/api/marketplace/posts/${offer.id}`), outsider: await get(`/api/marketplace/posts/${offer.id}`, outsider) };
    assert(plain.unsigned.status === 401 && plain.unsigned.body?.code === 'members_only' && plain.outsider.status === 403 && plain.outsider.body?.code === 'members_only',
        `no ticket: the listings' members-only answer (unsigned ${plain.unsigned.status}, a non-member ${plain.outsider.status})`);
    const sameAsNoTicket = (r: Res, who: 'unsigned' | 'outsider') => r.status === plain[who].status && r.text === plain[who].text;
    const forged = crypto.randomBytes(16).toString('base64url');
    const cases: Array<[string, string]> = [
        ['a forged ticket', `/api/marketplace/posts/${offer.id}?peek=${forged}`],
        ['a ticket one character off', `/api/marketplace/posts/${offer.id}?peek=${T1.slice(0, 21)}${T1[21] === 'A' ? 'B' : 'A'}`],
        ['a malformed ticket', `/api/marketplace/posts/${offer.id}?peek=${T1}x`],
        ['the ticket twice', `/api/marketplace/posts/${offer.id}?peek=${T1}&peek=${T1}`],
        ['the ticket on another post', `/api/marketplace/posts/${other.id}?peek=${T1}`],
        ['the ticket on a group\'s post', `/api/marketplace/posts/${groupPost.id}?peek=${T1}`],
        ['the ticket on the board', `/api/marketplace/posts?peek=${T1}`],
        ['the ticket on a read by id', `/api/marketplace/posts?id=${offer.id}&peek=${T1}`],
        ['the ticket on the post\'s chat', `/api/marketplace/posts/${offer.id}/chat?peek=${T1}`],
        ['the ticket on the post id in capitals', `/API/marketplace/posts/${offer.id}?peek=${T1}`],
    ];
    for (const [label, path] of cases) {
        for (const [who, id] of [['unsigned', null], ['outsider', outsider]] as const) {
            const r = await get(path, id);
            const base = path.split('?')[0];
            const expected = base === `/api/marketplace/posts/${offer.id}` || base === `/api/marketplace/posts/${other.id}` || base === `/api/marketplace/posts/${groupPost.id}`;
            const ok = expected ? sameAsNoTicket(r, who) : r.status >= 400 && leaks(r.text).length === 0 && !r.text.includes('Sentinel ladder');
            assert(ok, `${label}, ${who === 'unsigned' ? 'unsigned' : 'a non-member signer'}: nothing opened (${r.status} ${r.text.slice(0, 90)})`);
        }
    }
    // A forged row (the ticket's hash beside a group's post) still opens nothing: the post must be one a visitor could see.
    const forgedRowTicket = crypto.randomBytes(16).toString('base64url');
    db.prepare('INSERT INTO peek_tickets (id, ticket_hash, post_id, sharer_pubkey, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run('forged-row', crypto.createHash('sha256').update(forgedRowTicket).digest('hex'), groupPost.id, alice.pk, new Date().toISOString(), new Date(Date.now() + DAY).toISOString());
    assert(sameAsNoTicket(await get(`/api/marketplace/posts/${groupPost.id}?peek=${forgedRowTicket}`), 'unsigned'),
        'a ticket row beside a group\'s post (written straight to the table) still opens nothing');
    db.prepare("DELETE FROM peek_tickets WHERE id = 'forged-row'").run();
    // A member signing the read is held to the ticket too.
    const memberNoTicket = await get(`/api/marketplace/posts/${offer.id}?peek=${forged}`, bob);
    assert(memberNoTicket.status === 403 && memberNoTicket.body?.code === 'members_only' && leaks(memberNoTicket.text).length === 0,
        `a member with a forged ticket: 403, nothing (${memberNoTicket.status})`);

    // ── 4. Stop sharing ────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Stop sharing ──');
    const aliceList = await get('/api/peek/mine', alice);
    const row = (aliceList.body?.shares ?? []).find((s: any) => s.postId === offer.id);
    assert(aliceList.status === 200 && !!row && row.title === 'Sentinel ladder to lend' && row.id === made.body?.id && !aliceList.text.includes(T1)
        && !(aliceList.body?.shares ?? []).some((s: any) => s.postId === event.id),
        `her list: her link, with the post's title, never the ticket, and none of anyone else's (${aliceList.status})`);
    const unsignedList = await get('/api/peek/mine');
    const outsiderList = await get('/api/peek/mine', outsider);
    assert(unsignedList.status === 401 && outsiderList.status === 403, `the list is a member's own read (unsigned ${unsignedList.status}, a non-member ${outsiderList.status})`);
    const bobStopsHers = await call('POST', '/api/peek/stop', { id: bob, body: { id: made.body?.id } });
    assert(bobStopsHers.status === 404 && (await peekRead(offer.id, T1)).status === 200, `another member can't stop her link: 404, and it still opens (${bobStopsHers.status})`);
    const stop = await call('POST', '/api/peek/stop', { id: alice, body: { id: made.body?.id } });
    assert(stop.status === 200 && stop.body?.stopped === true, `she stops it: 200 (${stop.status})`);
    for (const [who, id] of [['unsigned', null], ['outsider', outsider]] as const) {
        assert(sameAsNoTicket(await peekRead(offer.id, T1, id), who), `stopped, ${who === 'unsigned' ? 'unsigned' : 'a non-member signer'}: answered as with no ticket`);
    }
    assert((await peekRead(offer.id, T2)).status === 200, 'Bob\'s link to the same post still opens: stopping one stops only that one');
    const again = await call('POST', '/api/peek/stop', { id: alice, body: { id: made.body?.id } });
    assert(again.status === 404 && !((await get('/api/peek/mine', alice)).body?.shares ?? []).some((s: any) => s.id === made.body?.id),
        `stopped twice: 404; it leaves her list (${again.status})`);

    // ── 5. run out, taken down, the sharer gone ────────────────────────────────────────────────
    console.log('\n── 5. seven days, a post taken down, a sharer no longer a member ──');
    const runOut = await share(alice, other.id);
    db.prepare('UPDATE peek_tickets SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), runOut.body?.id);
    assert(sameAsNoTicket(await peekRead(other.id, runOut.body?.ticket), 'unsigned'), 'run out: answered as with no ticket');
    const gone = createPost('offer', 'tools', 'Sentinel gone thing', 'Soon gone.', 1, 'fixed', alice.pk, PLACE.lat, PLACE.lng, undefined, false, undefined, false, {});
    const goneShare = await share(alice, gone.id);
    assert((await peekRead(gone.id, goneShare.body?.ticket)).status === 200, 'a fresh link opens before its post goes');
    se.removePost(gone.id, alice.pk);
    assert(sameAsNoTicket(await peekRead(gone.id, goneShare.body?.ticket), 'unsigned'), 'its post taken down: answered as with no ticket');
    const goneRow = ((await get('/api/peek/mine', alice)).body?.shares ?? []).find((s: any) => s.postId === gone.id);
    assert(!!goneRow, 'a link to a post taken down stays in her list until it ends, so she can see it and stop it');
    const carolShare = await share(carol, other.id);
    assert((await peekRead(other.id, carolShare.body?.ticket)).status === 200, 'Carol\'s link opens while she is a member');
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(carol.pk);
    assert(sameAsNoTicket(await peekRead(other.id, carolShare.body?.ticket), 'unsigned'), 'Carol no longer a member: her links open nothing');
    assert(sameAsNoTicket(await peekRead(event.id, evMade.body?.ticket), 'unsigned'), 'all of them');
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(carol.pk);

    // ── 6. the owners' switch ──────────────────────────────────────────────────────────────────
    console.log('\n── 6. "Members may share listings outside the community" ──');
    const info = await get('/api/community/info');
    assert(info.body?.features?.shareOutside === true, `on by default on a local community: features.shareOutside (${JSON.stringify(info.body?.features?.shareOutside)})`);
    const shapeBefore = await call('GET', '/api/local/admin/community-shape', { headers: OWNER });
    assert(shapeBefore.body?.settings?.shareOutside?.value === true && shapeBefore.body?.settings?.shareOutside?.source === 'profile',
        `How this community works reads it: on, the kind's default (${JSON.stringify(shapeBefore.body?.settings?.shareOutside)})`);
    const live = await share(alice, offer.id);
    assert((await peekRead(offer.id, live.body?.ticket)).status === 200, 'a link opens while it is on');
    const off = await call('POST', '/api/local/admin/community-shape', { headers: OWNER, body: { changes: { shareOutside: false } } });
    assert(off.status === 200 && off.body?.shape?.settings?.shareOutside?.value === false && off.body?.told === 'members',
        `the owner turns it off: 200, and members are told (${off.status} ${off.body?.told})`);
    assert(sameAsNoTicket(await peekRead(offer.id, live.body?.ticket), 'unsigned') && sameAsNoTicket(await peekRead(offer.id, T2), 'unsigned'),
        'off: every link opens nothing');
    const offShare = await share(alice, offer.id);
    assert(offShare.status === 403 && offShare.body?.code === 'share_outside_off', `off: a new link is refused, 403 share_outside_off (${offShare.status} ${offShare.body?.code})`);
    assert((await get('/api/community/info')).body?.features?.shareOutside === undefined, 'off: features.shareOutside is gone, so the apps offer only the members\' link');
    const mine = await get('/api/peek/mine', alice);
    assert(mine.status === 200 && (mine.body?.shares ?? []).length === 0, `off: her list is empty, every link stopped (${(mine.body?.shares ?? []).length})`);
    const on = await call('POST', '/api/local/admin/community-shape', { headers: OWNER, body: { changes: { shareOutside: true } } });
    assert(on.status === 200 && on.body?.shape?.settings?.shareOutside?.value === true, `on again: 200 (${on.status})`);
    assert(sameAsNoTicket(await peekRead(offer.id, live.body?.ticket), 'unsigned') && sameAsNoTicket(await peekRead(offer.id, T2), 'unsigned'),
        'on again: the links stopped by turning it off stay stopped');
    const fresh = await share(alice, offer.id);
    assert(fresh.status === 201 && (await peekRead(offer.id, fresh.body?.ticket)).status === 200, 'on again: a new link opens');
    process.env.PRIVATE_PREVIEW = '1';
    const inPreview = await peekRead(offer.id, fresh.body?.ticket);
    const previewShare = await share(alice, offer.id);
    const previewInfo = await get('/api/community/info');
    process.env.PRIVATE_PREVIEW = '';
    assert(inPreview.status >= 400 && !inPreview.body?.post && !inPreview.text.includes('Sentinel ladder') && previewShare.status === 403
        && previewInfo.body?.features?.shareOutside === undefined,
        `a private preview shows visitors nothing: the link opens nothing, none is made, the apps offer none (${inPreview.status} ${inPreview.body?.code}, ${previewShare.status})`);
    assert((await peekRead(offer.id, fresh.body?.ticket)).status === 200, 'the preview over, the link opens again (it was never stopped)');

    // ── 7. the share page ──────────────────────────────────────────────────────────────────────
    console.log('\n── 7. the share page at the community\'s address ──');
    const pagePath = `/?post=${offer.id}&peek=${fresh.body?.ticket}`;
    const page = await get(pagePath, null, { 'User-Agent': ANDROID_UA });
    assert(page.status === 200 && /text\/html/.test(page.headers.get('content-type') ?? '') && page.text.includes('data-testid="peek-post"'),
        `a stranger's phone: the share page, not a redirect (${page.status} ${page.headers.get('location') ?? ''})`);
    assert(!/<script/i.test(page.text) && page.headers.get('content-security-policy') === APP_DOCUMENT_CSP && page.headers.get('referrer-policy') === 'no-referrer',
        'no script, the web app\'s document policy, and no page it links to is told its address');
    assert(/no-store/.test(page.headers.get('cache-control') ?? ''), 'never cached: a stopped link stops at once');
    const og = (prop: string) => new RegExp(`<meta property="og:${prop}" content="([^"]*)"`).exec(page.text)?.[1]?.replace(/&amp;/g, '&') ?? null;
    assert(og('title') === 'Sentinel ladder to lend' && (og('description') ?? '').includes(`On BeanPool, in ${NAME}`),
        `Open Graph: the title, and "On BeanPool, in ${NAME}" (${og('title')} | ${og('description')})`);
    const ogImage = og('image');
    assert(!!ogImage && ogImage.startsWith(`https://${HOST}/api/marketplace/posts/${offer.id}/photos/0`) && /[?&]k=/.test(ogImage),
        `Open Graph: the photo, at the community's own address, with the key that opens it (${ogImage})`);
    assert(page.text.includes(`A member of ${NAME} shared this with you`) && page.text.includes(`Names and faces appear when you join ${NAME}.`),
        'it says a member shared it, and that names and faces appear on joining');
    const pageLeaks = leaks(page.text);
    assert(pageLeaks.length === 0, `the page names nobody, and places nothing finer than the area${pageLeaks.length ? ` — ${pageLeaks.join(', ')}` : ''}`);
    const href = (html: string, door: string) => new RegExp(`<a [^>]*data-door="${door}"[^>]*href="([^"]*)"`).exec(html)?.[1]?.replace(/&amp;/g, '&') ?? null;
    const appLink = href(page.text, 'app');
    assert(!!appLink && appLink.startsWith('intent://peek?') && appLink.includes(`post=${offer.id}`) && appLink.includes(`peek=${fresh.body?.ticket}`)
        && appLink.includes('scheme=beanpool;package=org.beanpool.pillar;') && appLink.includes('S.browser_fallback_url='),
        `Android: Open in the BeanPool app opens its peek screen, falling back to Google Play (${appLink?.slice(0, 80)})`);
    const store = href(page.text, 'store');
    const referrer = store ? new URL(store).searchParams.get('referrer') : null;
    assert(!!store && store.startsWith('https://play.google.com/store/apps/details?id=org.beanpool.pillar') && referrer === `peek=${fresh.body?.ticket}&post=${offer.id}&server=https://${HOST}`,
        `Android: Get the app carries the peek through the install, in Google Play's referrer (${referrer})`);
    assert(href(page.text, 'browser') === `/app?post=${offer.id}&peek=${fresh.body?.ticket}`, 'See it in your browser: the web app\'s one-post peek');
    const iphone = await get(pagePath, null, { 'User-Agent': IPHONE_UA });
    assert(href(iphone.text, 'app')?.startsWith('beanpool://peek?') === true && href(iphone.text, 'store') === 'https://apps.apple.com/app/id6761870086',
        'iPhone: the app by its own scheme, and the App Store');
    const desktop = await get(pagePath, null, { 'User-Agent': DESKTOP_UA });
    assert(href(desktop.text, 'app') === null && href(desktop.text, 'store') === null && !!href(desktop.text, 'browser'),
        'a computer: See it in your browser, and no phone doors');
    const memberBrowser = await get(pagePath, null, { Cookie: 'bp_account_here=1' });
    assert(memberBrowser.status === 302 && memberBrowser.headers.get('location') === `/app${pagePath.slice(1)}`,
        `a browser that keeps an account here: to the web app, as any ?post= (${memberBrowser.status} ${memberBrowser.headers.get('location')})`);
    const stale = await get(`/?post=${offer.id}&peek=${forged}`, null, { 'User-Agent': ANDROID_UA });
    assert(stale.status === 200 && stale.text.includes('data-testid="community-card"') && !stale.text.includes('Sentinel ladder') && !stale.text.includes('/photos/'),
        `a link that opens nothing: the community's card, and nothing of the post (${stale.status})`);

    // ── 8. how many at once ────────────────────────────────────────────────────────────────────
    console.log('\n── 8. at most 50 links open at once ──');
    const { PEEK_TICKETS_LIVE_MAX } = await import('@beanpool/core');
    const open = ((await get('/api/peek/mine', bob)).body?.shares ?? []).length;
    let lastOk = 0;
    for (let i = open; i < PEEK_TICKETS_LIVE_MAX; i++) if ((await share(bob, other.id)).status === 201) lastOk++;
    const over = await share(bob, other.id);
    assert(open + lastOk === PEEK_TICKETS_LIVE_MAX && over.status === 429 && over.body?.code === 'too_many_shares',
        `the ${PEEK_TICKETS_LIVE_MAX + 1}st: 429 too_many_shares (${over.status} ${over.body?.code})`);
    const oneOff = ((await get('/api/peek/mine', bob)).body?.shares ?? [])[0];
    await call('POST', '/api/peek/stop', { id: bob, body: { id: oneOff?.id } });
    assert((await share(bob, other.id)).status === 201, 'one stopped: another may be shared');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
