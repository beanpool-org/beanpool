/**
 * Where a request to join came from (shared-listing door A3, scratch/fable-design/DESIGN-shared-listing-door-fable.md §2.2;
 * Marty, 9 Nov: answerers see the listing's title AND the sharer's name; the listing's author is told nothing). Over REAL
 * HTTPS through the real signature middleware, a local community as it ships (members door, sharing outside on):
 *
 *   1. a stranger's knock carries `peek`, the ticket of the link Sarah shared of Paul's listing: 201 as any knock; the row
 *      keeps the post and Sarah's key, never the ticket (nor its hash); Sarah's link counts one asked
 *   2. the members who answer read the line (`via`: the listing's title as it is now and Sarah's name); a non-member, the
 *      stranger, gets no list; the stranger's status read, the community's card, the directory's fields and the public
 *      directory preview carry nothing of it
 *   3. pushes: Sarah gets "Someone asked to join after a listing you shared." (no name, no listing) and not the plain one;
 *      the owner gets the plain one; Paul, the listing's author, gets nothing
 *   4. a ticket that opens nothing: forged, malformed, not a string, run out, stopped, the sharer gone, sharing switched off:
 *      each knock is taken (201), plain, with no line, and no link's count moves
 *   5. the line goes when the listing is taken down or the sharer leaves; where only admins answer, Sarah reads no list
 *      but her Shared outside still counts
 *   6. the tidy-up clears both columns once the knock is off the list; a prune of the applicant does too
 *   7. a standby copies both columns; a re-key of Sarah moves her key on the knock
 *
 * Fail-first: on origin/main 25 checks fail and section 7 stops at "no such column: via_post_id" (no columns, no `via`, no
 * count, no push of the sharer's own). Section 4's 201s hold there already (a body's `peek` was ignored); its `via: null`
 * and unmoved counts are new, and hold that the resolution never turns a ticket that opens nothing into a refusal.
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) SERVER_SUITES_ONLY=test-knock-provenance node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.PRIVATE_PREVIEW;
delete process.env.PUBLIC_ADDRESS_NAME;
delete process.env.PUBLIC_ADDRESS_AUTO;

import crypto from 'node:crypto';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
const DAY = 86_400_000;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Res { status: number; body: any; text: string }
let beforeCall: () => void = () => {};
async function call(id: Id | null, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Res> {
    beforeCall();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pk;
        headers['X-Signature'] = signRequest(id.priv, { method, path: path.split('?')[0], timestamp: ts, nonce, body: raw });
        headers[SIGNED_FOR_HEADER] = signedForHost();
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await realFetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text };
}
const realFetch = globalThis.fetch;

async function main(): Promise<void> {
    console.log('\n=== Where a request to join came from (shared-listing door A3) ===\n');
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { startP2P } = await import('./p2p.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { wrapCreatePost } = await import('./post-test-helper.js');
    const knocks = await import('./engine/knocks.js');
    const { listingFields } = await import('./engine/directory-promise.js');
    const { emptyCopiedTables } = await import('./engine/copied-tables.js');
    const { pinMainServerForTests } = await import('./standby-pin-test-helper.js');
    const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
    const { updateLocalConfig } = await import('./config/local-config.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const createPost = wrapCreatePost(se.createPost);
    beforeCall = () => { resetGatewayRateLimit(); resetAdminRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };

    await initTls();
    se.initStateEngine();
    const p2p = await startP2P(0, 0);
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    knocks.startTidyingKnocks(DAY); // the tidy-up runs only when section 6 calls it
    updateLocalConfig({ communityName: 'Byronvale Commons' } as any);

    // Every push the server hands to Expo, by token.
    const pushed: any[] = [];
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        const host = new URL(url).hostname;
        if (host === 'exp.host' || host.endsWith('expo.dev')) {
            const batch = JSON.parse(init?.body ?? '[]');
            pushed.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        return realFetch(input, init);
    };
    const settle = () => new Promise(r => setTimeout(r, 60));
    const pushesTo = (token: string) => pushed.filter(p => p.to === token);

    // ── the community: Ada (owner), Sarah (shares), Paul (wrote the listing), Mo (a member who opted in) ──
    const FACE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
    const ada = newId('Ada');
    se.seedGenesisMember(ada.pk, ada.name);
    const member = (name: string): Id => {
        const id = newId(name);
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, ?, ?)`)
            .run(id.pk, name, new Date(Date.now() - 30 * DAY).toISOString(), ada.pk, `INV-${name.toUpperCase()}`);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        setMemberPhoto(db, id.pk, FACE);
        return id;
    };
    const sarah = member('Sarah');
    const paul = member('Paul');
    const mo = member('Mo');
    db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_knocks', 'true')`).run(mo.pk);
    for (const m of [ada, sarah, paul, mo]) putPushTokenRow(m.pk, `ExponentPushToken[${m.name}]`, 'android');

    const TITLE = 'Short-term shelter available';
    const listing = createPost('offer', 'housing', TITLE, 'A room for a week or two.', 0, 'fixed', paul.pk, -28.64, 153.61, undefined, false, undefined, false, {});
    if (!listing) throw new Error('setup: the listing was not created');
    const shareOf = async (who: Id, postId: string) => {
        const r = await call(who, 'POST', '/api/peek', { postId });
        if (r.status !== 201) throw new Error(`setup: sharing failed ${r.status} ${r.text}`);
        return { ticket: r.body.ticket as string, id: r.body.id as string };
    };
    const link = await shareOf(sarah, listing.id);
    const knock = (who: Id, extra: Record<string, unknown> = {}) =>
        call(who, 'POST', '/api/join/knock', { callsign: who.name, message: `Hello, I'm ${who.name} and I live nearby.`, ...extra });
    const rowOf = (pk: string): any => {
        try { return db.prepare('SELECT * FROM join_requests WHERE pubkey = ? ORDER BY created_at DESC LIMIT 1').get(pk); } catch { return undefined; }
    };
    const askedOn = (linkId: string): number | null => {
        try { return (db.prepare('SELECT asked FROM peek_tickets WHERE id = ?').get(linkId) as { asked: number } | undefined)?.asked ?? null; } catch { return null; }
    };
    const freshAddress = () => { try { db.prepare('UPDATE join_requests SET ip_hash = NULL').run(); } catch { /* none */ } };
    const listedFor = async (who: Id) => {
        const r = await call(who, 'GET', '/api/join/knocks');
        return { r, of: (pk: string) => (r.body?.knocks ?? []).find((k: any) => k.pubkey === pk) };
    };

    // ── 1. the knock carries the ticket ──
    console.log('── 1. a knock that came with a shared link ──');
    const tess = newId('Tess');
    pushed.length = 0;
    const tessKnock = await knock(tess, { peek: link.ticket });
    await settle();
    assert(tessKnock.status === 201 && JSON.stringify(tessKnock.body) === JSON.stringify({ knock: { status: 'pending' } }),
        `the stranger's knock with the link's ticket: 201 pending, as any knock (${tessKnock.status} ${tessKnock.text})`);
    const tessRow = rowOf(tess.pk);
    assert(tessRow?.via_post_id === listing.id && tessRow?.via_sharer_pubkey === sarah.pk,
        `the row keeps the post and the sharer's key (${tessRow?.via_post_id} ${tessRow?.via_sharer_pubkey?.slice(0, 8)})`);
    const hash = crypto.createHash('sha256').update(link.ticket).digest('hex');
    const allRows = JSON.stringify(db.prepare('SELECT * FROM join_requests').all());
    assert(!allRows.includes(link.ticket) && !allRows.includes(hash), 'never the ticket, nor its hash');
    assert(askedOn(link.id) === 1, `Sarah's link counts one asked (${askedOn(link.id)})`);
    const mine = await call(sarah, 'GET', '/api/peek/mine');
    const mineRow = (mine.body?.shares ?? []).find((s: any) => s.id === link.id);
    assert(mine.status === 200 && mineRow?.asked === 1 && !JSON.stringify(mine.body).includes(tess.name) && !JSON.stringify(mine.body).includes(tess.pk),
        `her Shared outside says 1 asked from that link, and never who (${mine.status} ${JSON.stringify(mineRow)})`);

    // ── 2. who reads the line, and where it never goes ──
    console.log('\n── 2. the line reads to the members who answer, and nowhere else ──');
    const byAda = await listedFor(ada);
    assert(byAda.r.status === 200 && byAda.of(tess.pk)?.via?.title === TITLE && byAda.of(tess.pk)?.via?.sharer === 'Sarah',
        `the owner reads via: the listing's title and the sharer's name (${JSON.stringify(byAda.of(tess.pk)?.via)})`);
    assert(!JSON.stringify(byAda.r.body).includes(sarah.pk) && !JSON.stringify(byAda.r.body).includes(link.ticket),
        'the list names the sharer, never her key or the ticket');
    const byMo = await listedFor(mo);
    assert(byMo.r.status === 200 && byMo.of(tess.pk)?.via?.sharer === 'Sarah', `a member on a members door reads it too (${byMo.r.status})`);
    const byStranger = await call(tess, 'GET', '/api/join/knocks');
    assert(byStranger.status === 401 || byStranger.status === 403, `the stranger reads no list (${byStranger.status})`);
    const words = [TITLE, 'Sarah', sarah.pk, listing.id, link.ticket];
    const carries = (text: string) => words.filter(w => text.includes(w));
    const tessStatus = await call(tess, 'GET', '/api/join/knock/status');
    assert(tessStatus.status === 200 && tessStatus.body?.status === 'pending' && carries(tessStatus.text).length === 0,
        `the stranger's status read carries nothing of it (${tessStatus.text})`);
    const card = await call(null, 'GET', '/api/community/card');
    assert(card.status === 200 && carries(card.text).length === 0, `the community's card carries nothing of it (${carries(card.text)})`);
    const fields = JSON.stringify(listingFields());
    assert(carries(fields).length === 0, `what the directory push sends carries nothing of it (${fields.slice(0, 160)})`);
    const preview = await call(null, 'GET', '/api/directory/info');
    assert(carries(preview.text).length === 0, `the public directory preview carries nothing of it (${preview.status})`);

    // ── 3. pushes ──
    console.log('\n── 3. who is told ──');
    const toSarah = pushesTo('ExponentPushToken[Sarah]');
    assert(toSarah.length === 1 && toSarah[0].body === 'Someone asked to join after a listing you shared.' && toSarah[0].title === 'BeanPool',
        `Sarah: one push, "Someone asked to join after a listing you shared." (${JSON.stringify(toSarah.map(p => p.body))})`);
    // (Without `to`: the test's own token spells her name.)
    const sentToSarah = JSON.stringify(toSarah.map(({ to: _to, ...rest }) => rest));
    assert(carries(sentToSarah).length === 0 && !sentToSarah.includes(tess.name), `it names nobody and no listing (${sentToSarah.slice(0, 200)})`);
    const sarahNotice = db.prepare(`SELECT kind, data FROM push_notices WHERE recipient = ? ORDER BY rowid DESC LIMIT 1`).get(sarah.pk) as any;
    assert(sarahNotice?.kind === 'community.knock-shared' && JSON.parse(sarahNotice?.data ?? '{}')?.screen === 'shared-outside',
        `its details open her Shared outside (${sarahNotice?.kind} ${sarahNotice?.data})`);
    const toAda = pushesTo('ExponentPushToken[Ada]');
    assert(toAda.length === 1 && toAda[0].body === 'Someone asked to join your community.', `the owner: the plain push (${JSON.stringify(toAda.map(p => p.body))})`);
    assert(pushesTo('ExponentPushToken[Mo]').length === 1, 'a member who opted in: the plain push');
    assert(pushesTo('ExponentPushToken[Paul]').length === 0, "Paul, the listing's author, is told nothing");

    // ── 4. a ticket that opens nothing: the knock is plain, never refused ──
    console.log('\n── 4. a ticket that opens nothing leaves the knock plain ──');
    const plainCases: Array<[string, () => Promise<unknown>]> = [
        ['a forged ticket', async () => crypto.randomBytes(16).toString('base64url')],
        ['a malformed ticket', async () => 'not-a-ticket!'],
        ['a number', async () => 12345],
        ['a long string', async () => 'x'.repeat(5000)],
        ['a run-out ticket', async () => {
            const l = await shareOf(sarah, listing.id);
            db.prepare('UPDATE peek_tickets SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), l.id);
            return l.ticket;
        }],
        ['a stopped ticket', async () => {
            const l = await shareOf(sarah, listing.id);
            await call(sarah, 'POST', '/api/peek/stop', { id: l.id });
            return l.ticket;
        }],
    ];
    for (const [label, ticketFor] of plainCases) {
        freshAddress();
        const who = newId(`Plain${run}`);
        const counts = () => { try { return JSON.stringify(db.prepare('SELECT id, asked FROM peek_tickets ORDER BY id').all()); } catch { return 'none'; } };
        const peek = await ticketFor();
        const beforeTickets = counts();
        pushed.length = 0;
        const r = await knock(who, { peek });
        await settle();
        const row = rowOf(who.pk);
        const listed = (await listedFor(ada)).of(who.pk);
        const afterTickets = counts();
        assert(r.status === 201 && row?.status === 'pending' && row?.via_post_id === null && row?.via_sharer_pubkey === null && listed && listed.via === null
            && afterTickets === beforeTickets && pushesTo('ExponentPushToken[Sarah]').length === 0,
            `${label}: taken (201), plain, no line, no count, no push to Sarah (${r.status} ${row?.via_post_id ?? 'null'} ${JSON.stringify(listed?.via)})`);
    }
    // The sharer gone, and sharing switched off: the ticket stops opening, so the knock is plain.
    freshAddress();
    const zed = member('Zed');
    const zedLink = await shareOf(zed, listing.id);
    se.adminPruneUser(zed.pk, se.COMMUNITY_DECISION_ACTOR);
    const afterZed = newId('AfterZed');
    const afterZedKnock = await knock(afterZed, { peek: zedLink.ticket });
    assert(afterZedKnock.status === 201 && rowOf(afterZed.pk)?.via_sharer_pubkey === null && askedOn(zedLink.id) === 0,
        `a sharer since removed: taken, plain, no count (${afterZedKnock.status})`);

    // ── 5. the line goes when the listing or the sharer does; an admins door ──
    console.log('\n── 5. the line names only what still reads ──');
    db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(listing.id);
    assert((await listedFor(ada)).of(tess.pk)?.via === null, 'the listing taken down: the line goes');
    db.prepare('UPDATE posts SET active = 1 WHERE id = ?').run(listing.id);
    assert((await listedFor(ada)).of(tess.pk)?.via?.title === TITLE, 'back on the board: the line is back');
    db.prepare(`INSERT INTO node_config (key, value) VALUES ('door', 'admins') ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    const sarahList = await call(sarah, 'GET', '/api/join/knocks');
    const sarahMine = (await call(sarah, 'GET', '/api/peek/mine')).body?.shares?.find((s: any) => s.id === link.id);
    assert(sarahList.status === 403 && sarahMine?.asked === 1,
        `where only admins answer: Sarah reads no list (${sarahList.status}), her Shared outside still counts (${sarahMine?.asked})`);
    assert((await listedFor(ada)).of(tess.pk)?.via?.sharer === 'Sarah', 'and the owner still reads the line');
    // On an admins door Sarah is still told, with the same fixed words.
    freshAddress();
    pushed.length = 0;
    const uma = newId('Uma');
    await knock(uma, { peek: link.ticket });
    await settle();
    assert(pushesTo('ExponentPushToken[Sarah]').length === 1 && pushesTo('ExponentPushToken[Sarah]')[0].body === 'Someone asked to join after a listing you shared.'
        && pushesTo('ExponentPushToken[Mo]').length === 0 && askedOn(link.id) === 2,
        `on an admins door Sarah gets her push and her count (${askedOn(link.id)}); members are not told`);
    db.prepare(`DELETE FROM node_config WHERE key = 'door'`).run();
    // Sarah turned her listings' pushes off but asked to hear of requests to join: her own push doesn't go, so the plain one does.
    db.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_marketplace', 'false'), (?, 'notify_knocks', 'true')`).run(sarah.pk, sarah.pk);
    freshAddress();
    pushed.length = 0;
    await knock(newId('Wren'), { peek: link.ticket });
    await settle();
    const wrenToSarah = pushesTo('ExponentPushToken[Sarah]');
    assert(wrenToSarah.length === 1 && wrenToSarah[0].body === 'Someone asked to join your community.',
        `a sharer whose own push is switched off still gets the plain one she asked for (${JSON.stringify(wrenToSarah.map(p => p.body))})`);
    db.prepare(`DELETE FROM member_preferences WHERE public_key = ? AND pref_key IN ('notify_marketplace', 'notify_knocks')`).run(sarah.pk);

    // ── 6. the tidy-up and a prune clear both columns ──
    console.log('\n── 6. cleared once off the list ──');
    const tessId = rowOf(tess.pk)?.id as string;
    const declined = await call(ada, 'POST', `/api/join/knocks/${tessId}/decline`);
    knocks.tidyKnocks();
    const tidied = rowOf(tess.pk);
    assert(declined.status === 200 && tidied?.via_post_id === null && tidied?.via_sharer_pubkey === null && tidied?.callsign === '',
        `declined, then tidied: both columns cleared with what was sent (${declined.status} ${tidied?.via_post_id ?? 'null'})`);
    const umaRow = rowOf(uma.pk);
    assert(umaRow?.via_post_id === listing.id, 'an open knock keeps them through the tidy-up');
    // Uma joins by an ordinary invite and is then pruned: what came with her knock goes.
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, 'Uma', 'active', ?, ?, 'INV-UMA')`)
        .run(uma.pk, new Date().toISOString(), ada.pk);
    knocks.scrubKnocksOf(uma.pk);
    const scrubbed = rowOf(uma.pk);
    assert(scrubbed?.via_post_id === null && scrubbed?.via_sharer_pubkey === null, 'a prune or self-deletion of the applicant clears them too');

    // ── 7. a standby copies both columns; a re-key moves the sharer's key ──
    console.log('\n── 7. replication and a re-key ──');
    freshAddress();
    const vic = newId('Vic');
    await knock(vic, { peek: link.ticket });
    const nodeId = p2p.peerId.toString();
    pinMainServerForTests(`/ip4/127.0.0.1/tcp/4097/p2p/${nodeId}`);
    const cols = 'id, pubkey, callsign, message, avatar, from_node, status, created_at, decided_by, invite_code, decided_at, updated_at, via_post_id, via_sharer_pubkey';
    const expected = JSON.stringify(db.prepare(`SELECT ${cols} FROM join_requests ORDER BY id`).all());
    const payload: any = await se.exportSyncState(nodeId);
    const carried = (payload.joinRequests ?? []).find((r: any) => r.pubkey === vic.pk);
    assert(carried?.viaPostId === listing.id && carried?.viaSharerPubkey === sarah.pk, `the copy carries both (${carried?.viaPostId} ${carried?.viaSharerPubkey?.slice(0, 8)})`);
    emptyCopiedTables(db);
    se.setNodeRole('backup');
    await se.importRemoteState(payload);
    se.setNodeRole('primary');
    const replica = JSON.stringify(db.prepare(`SELECT ${cols} FROM join_requests ORDER BY id`).all());
    assert(replica === expected && rowOf(vic.pk)?.via_sharer_pubkey === sarah.pk, 'the standby holds every knock with both columns as they were');
    const sarahNew = newId('SarahNew');
    completeRekey(sarah.pk, sarahNew.pk, issueRekeyCode(sarah.pk, 'owner:password').code, 'owner:password');
    assert(rowOf(vic.pk)?.via_sharer_pubkey === sarahNew.pk, 'a re-key of Sarah names her new key on the knock');
    assert((await listedFor(ada)).of(vic.pk)?.via?.sharer === 'Sarah', 'and the line still names her');

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit(process.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
