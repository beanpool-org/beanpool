/**
 * A direct message is never stored readable (PR #1283 review): the privacy policy tells members "the server stores
 * direct messages in a form only the two of you can read", and that has to hold for every line a member writes.
 * Over REAL HTTPS through the real signature middleware:
 *
 *   1. a member's `plaintext-v1` line into a DM is refused 400 `dm_not_encrypted`, with the plain line old apps show,
 *      and nothing is stored; so is every other form that is not the encrypted one (a short nonce, a ciphertext that
 *      is not base64, one shorter than the AEAD tag, a missing prefix); an encrypted line is stored exactly as sent
 *   2. an edit follows the same rule; the message is untouched by a refused one
 *   3. a photo: an encrypted caption over a readable picture is refused; both encrypted is stored
 *   4. every DM is held to it: one tied to a listing (the old per-post DM), and a conversation of any other kind that
 *      reaches the DM store
 *   5. a DM opened with a name (the phone's old "decline with a message") is refused: those words go as a message
 *   6. what stays readable, as designed: a group chat line through either route and its edit, an event chat and an
 *      enterprise discussion (node-readable, plaintext-v1); the deal notices the node writes into a DM; a removed
 *      message's tombstone; the message the operator writes from the node's admin page
 *
 * Run: ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-dm-never-plaintext.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, seedGenesisMember, createGroup, createTreasury, createPost, injectSystemMessage, adminSendMessage,
} from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { resetChatRateLimit } from './chat-rate-limit.js';
import { lockedDm } from './dm-test-payload.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

const AVATAR = 'https://example.com/a.jpg';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');
/** What the phone and the web app sent until now whenever they could not find the other person's key. */
const readable = (s: string) => ({ ciphertext: b64(s), nonce: 'plaintext-v1' });

let BASE = '';

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, avatar_url, status)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'TEST', ?, 'active')`).run(id.pk, name, owner.pk, AVATAR);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    return id;
}

interface Res { status: number; body: any }
async function call(method: 'GET' | 'POST', signer: Id, path: string, body?: unknown): Promise<Res> {
    resetGatewayRateLimit();
    resetChatRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': signer.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), signer.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* empty or not JSON */ }
    return { status: res.status, body: parsed };
}

const rowOf = (id: string) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as any;
const countIn = (conversationId: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n;
const refusedAsUnlocked = (r: Res) => r.status === 400 && r.body?.code === 'dm_not_encrypted'
    && typeof r.body?.error === 'string' && r.body.error.includes("wasn't locked");

async function main(): Promise<void> {
    console.log('\n=== A direct message is never stored readable ===\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    const ana = member('Ana');
    const ben = member('Ben');

    const opened = await call('POST', ana, '/api/messages/conversation', { type: 'dm', participants: [ana.pk, ben.pk], createdBy: ana.pk });
    const dmId: string = opened.body?.conversation?.id;
    if (!dmId) throw new Error(`setup: could not open the DM (${opened.status} ${JSON.stringify(opened.body)})`);
    const send = (who: Id, conversationId: string, payload: object) =>
        call('POST', who, '/api/messages/send', { conversationId, authorPubkey: who.pk, ...payload });

    // ── 1. a line ────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. a line into a DM ──');
    const before = countIn(dmId);
    const plain = await send(ana, dmId, readable('meet at the gate at 6'));
    assert(refusedAsUnlocked(plain), `a plaintext-v1 line is refused 400 dm_not_encrypted, in words an old app can show (got ${plain.status} ${JSON.stringify(plain.body)})`);
    assert(countIn(dmId) === before, 'and nothing was stored');
    assert(!(db.prepare("SELECT 1 FROM messages WHERE ciphertext = ?").get(b64('meet at the gate at 6'))), 'the words are nowhere in the database');

    const good = lockedDm();
    const forms: Array<[string, object]> = [
        ['a nonce with the prefix and a 12-byte body', { ciphertext: good.ciphertext, nonce: 'x25519-xc20p-v2:' + crypto.randomBytes(12).toString('base64') }],
        ['a nonce with the prefix and a body that is not base64', { ciphertext: good.ciphertext, nonce: 'x25519-xc20p-v2:' + '!'.repeat(32) }],
        ['the 24 bytes without the prefix', { ciphertext: good.ciphertext, nonce: crypto.randomBytes(24).toString('base64') }],
        ['a ciphertext that is words, not base64', { ciphertext: 'meet at the gate', nonce: good.nonce }],
        ['a ciphertext shorter than the AEAD tag', { ciphertext: crypto.randomBytes(8).toString('base64'), nonce: good.nonce }],
        ['a ciphertext in URL-safe base64', { ciphertext: Buffer.from([0xfb, 0xff, ...crypto.randomBytes(30)]).toString('base64url'), nonce: good.nonce }],
        ['a legacy "plaintext" nonce', { ciphertext: b64('hello'), nonce: 'plaintext' }],
        ['a nonce that is not a string', { ciphertext: good.ciphertext, nonce: 42 }],
    ];
    for (const [what, payload] of forms) {
        const r = await send(ana, dmId, payload);
        assert(refusedAsUnlocked(r), `${what} is refused (got ${r.status} ${r.body?.code ?? r.body?.error ?? ''})`);
    }
    assert(countIn(dmId) === before, 'none of them was stored');

    const locked = await send(ana, dmId, good);
    const lockedId: string = locked.body?.message?.id;
    assert(locked.status === 200 && !!lockedId, `an encrypted line is stored (got ${locked.status} ${JSON.stringify(locked.body?.error ?? '')})`);
    assert(rowOf(lockedId)?.ciphertext === good.ciphertext && rowOf(lockedId)?.nonce === good.nonce, 'exactly as sent');
    const emptyCaption = lockedDm(16);
    const tagOnly = await send(ben, dmId, emptyCaption);
    assert(tagOnly.status === 200, `a ciphertext that is only the 16-byte tag (an empty caption) is stored (got ${tagOnly.status})`);
    const read = await call('GET', ben, `/api/messages/${dmId}`);
    assert(read.status === 200 && read.body.messages.some((m: any) => m.id === lockedId && m.nonce === good.nonce),
        'and Ben reads it back from the node as it was sent');

    // ── 2. an edit ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. an edit ──');
    const plainEdit = await call('POST', ana, '/api/messages/edit', { messageId: lockedId, ...readable('actually 7') });
    assert(refusedAsUnlocked(plainEdit), `a plaintext-v1 edit is refused 400 dm_not_encrypted (got ${plainEdit.status} ${JSON.stringify(plainEdit.body)})`);
    assert(rowOf(lockedId)?.ciphertext === good.ciphertext && rowOf(lockedId)?.nonce === good.nonce && !rowOf(lockedId)?.edited_at,
        'and the message is untouched');
    const newWords = lockedDm();
    const lockedEdit = await call('POST', ana, '/api/messages/edit', { messageId: lockedId, ...newWords });
    assert(lockedEdit.status === 200 && rowOf(lockedId)?.ciphertext === newWords.ciphertext && rowOf(lockedId)?.nonce === newWords.nonce,
        `an encrypted edit is stored (got ${lockedEdit.status} ${JSON.stringify(lockedEdit.body?.error ?? '')})`);

    // ── 3. a photo ───────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. a photo ──');
    const beforePhoto = countIn(dmId);
    const picture = lockedDm(600);
    const readablePicture = await send(ana, dmId, {
        ...lockedDm(16), type: 'image',
        attachment: { data: b64('data:image/jpeg;base64,/9j/4AAQ'), nonce: 'plaintext-v1', mime: 'image/jpeg' },
    });
    assert(refusedAsUnlocked(readablePicture), `an encrypted caption over a readable picture is refused (got ${readablePicture.status} ${readablePicture.body?.code ?? ''})`);
    assert(countIn(dmId) === beforePhoto, 'and neither the line nor the picture was stored');
    const readableCaption = await send(ana, dmId, {
        ...readable('look at this'), type: 'image', attachment: { data: picture.ciphertext, nonce: picture.nonce, mime: 'image/jpeg' },
    });
    assert(refusedAsUnlocked(readableCaption), `a readable caption over an encrypted picture is refused (got ${readableCaption.status})`);
    const photo = await send(ana, dmId, {
        ...lockedDm(16), type: 'image', attachment: { data: picture.ciphertext, nonce: picture.nonce, mime: 'image/jpeg' },
    });
    const photoId: string = photo.body?.message?.id;
    assert(photo.status === 200 && !!photoId, `an encrypted caption and picture are stored (got ${photo.status} ${JSON.stringify(photo.body?.error ?? '')})`);
    assert((db.prepare('SELECT nonce FROM message_attachments WHERE message_id = ?').get(photoId) as any)?.nonce === picture.nonce,
        'with the picture\'s own nonce');

    // ── 4. every DM ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. every kind of DM ──');
    const listing = createPost('offer', 'other', 'Ladder to lend', 'An old ladder', 0, 'fixed', ben.pk)!;
    const legacyDm = crypto.randomUUID();
    db.prepare(`INSERT INTO conversations (id, type, post_id, created_by) VALUES (?, 'dm', ?, ?)`).run(legacyDm, listing.id, ana.pk);
    for (const pk of [ana.pk, ben.pk]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(legacyDm, pk);
    const plainOnListing = await send(ana, legacyDm, readable('is the ladder free?'));
    assert(refusedAsUnlocked(plainOnListing), `a DM tied to a listing refuses a plaintext-v1 line too (got ${plainOnListing.status} ${plainOnListing.body?.code ?? ''})`);
    const lockedOnListing = await send(ana, legacyDm, lockedDm());
    assert(lockedOnListing.status === 200, `and stores an encrypted one (got ${lockedOnListing.status})`);

    const oddKind = crypto.randomUUID();
    db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES (?, 'direct', ?)`).run(oddKind, ana.pk);
    for (const pk of [ana.pk, ben.pk]) db.prepare('INSERT INTO conversation_participants (conversation_id, public_key) VALUES (?, ?)').run(oddKind, pk);
    const plainOdd = await send(ana, oddKind, readable('hello'));
    assert(refusedAsUnlocked(plainOdd), `a conversation of any other kind that reaches the DM store is held to the same rule (got ${plainOdd.status})`);

    // ── 5. a name on a DM ────────────────────────────────────────────────────────────────────────
    console.log('\n── 5. a name on a DM ──');
    const cal = member('Cal');
    const named = await call('POST', cal, '/api/messages/conversation',
        { type: 'dm', participants: [cal.pk, ben.pk], createdBy: cal.pk, name: 'Sorry, I found one elsewhere' });
    assert(named.status === 400, `a DM opened with a name (the old decline message) is refused 400 (got ${named.status} ${JSON.stringify(named.body)})`);
    assert(!(db.prepare("SELECT 1 FROM conversations WHERE name = ?").get('Sorry, I found one elsewhere')), 'and the words are nowhere in the database');
    const unnamed = await call('POST', cal, '/api/messages/conversation', { type: 'dm', participants: [cal.pk, ben.pk], createdBy: cal.pk });
    assert(unnamed.status === 200 && !!unnamed.body?.conversation?.id, `the same DM opened without one is fine (got ${unnamed.status})`);

    // ── 6. what stays readable, as designed ──────────────────────────────────────────────────────
    console.log('\n── 6. what stays readable ──');
    const group = createGroup({ name: 'Seed Library', joinPolicy: 'request_to_join', createdBy: ana.pk });
    const oldAppGroupLine = await send(ana, group.id, readable('seeds are in'));
    const oldAppGroupLineId: string = oldAppGroupLine.body?.message?.id;
    assert(oldAppGroupLine.status === 200 && rowOf(oldAppGroupLineId)?.nonce === 'plaintext-v1',
        `a group chat line through the send route old apps use is still plaintext-v1 (got ${oldAppGroupLine.status} ${JSON.stringify(oldAppGroupLine.body?.error ?? '')})`);
    const groupLine = await call('POST', ana, `/api/groups/${group.id}/chat/message`, { text: 'swap day on Saturday' });
    assert(groupLine.status === 201 && decode(rowOf(groupLine.body?.message?.id)?.ciphertext ?? '') === 'swap day on Saturday',
        `a group chat line through the group's route is stored readable (got ${groupLine.status})`);
    const groupEdit = await call('POST', ana, '/api/messages/edit', { messageId: oldAppGroupLineId, ...readable('seeds are in the hall') });
    assert(groupEdit.status === 200 && decode(rowOf(oldAppGroupLineId)?.ciphertext ?? '') === 'seeds are in the hall',
        `a group chat edit in plaintext-v1 is still accepted (got ${groupEdit.status} ${JSON.stringify(groupEdit.body?.error ?? '')})`);

    const event = createPost('event', 'community', 'Working bee', 'Bring gloves', 0, 'fixed', ben.pk, -28.55, 153.5, [], false, undefined, false,
        { eventStartAt: inHours(24), eventPlaceName: 'The hall' })!;
    const eventLine = await call('POST', ben, `/api/marketplace/posts/${event.id}/chat/message`, { text: 'gloves by the door' });
    assert(eventLine.status === 201 && rowOf(eventLine.body?.message?.id)?.nonce === 'plaintext-v1',
        `an event chat line is stored readable, as the event chat says (got ${eventLine.status} ${JSON.stringify(eventLine.body?.error ?? '')})`);

    const { publicKey: bakery } = createTreasury('Bakery', AVATAR, 300, { leadKeeperPubkey: ana.pk });
    const threadLine = await call('POST', ben, `/api/enterprise/${bakery}/thread/message`, { text: 'bread on Fridays?' });
    assert(threadLine.status === 201 && rowOf(threadLine.body?.message?.id)?.nonce === 'plaintext-v1',
        `an enterprise discussion line is stored readable, as the thread says (got ${threadLine.status} ${JSON.stringify(threadLine.body?.error ?? '')})`);

    injectSystemMessage(listing.id, 'ESCROW_FUNDED', { amount: 5 } as any, ana.pk, ben.pk);
    const notice = db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND type = 'system' ORDER BY timestamp DESC LIMIT 1").get(dmId) as any;
    assert(notice?.ciphertext === '5 Beans placed in escrow.' && notice?.nonce === '00000',
        `the node still writes its deal notice into the pair's DM, readable (got ${JSON.stringify(notice?.ciphertext)})`);
    const withNotice = await call('GET', ana, `/api/messages/${dmId}`);
    assert(withNotice.body?.messages?.some((m: any) => m.id === notice?.id), 'and Ana reads it there');

    const gone = await call('POST', ana, '/api/messages/delete', { messageId: lockedId });
    assert(gone.status === 200 && rowOf(lockedId)?.type === 'removed' && rowOf(lockedId)?.nonce === 'plaintext-v1',
        `deleting a line still leaves the node's plaintext-v1 tombstone (got ${gone.status} ${rowOf(lockedId)?.type})`);
    assert(rowOf(lockedId)?.ciphertext !== newWords.ciphertext, 'which no longer holds the encrypted words');

    const dee = member('Dee');
    adminSendMessage(dee.pk, 'Welcome to the community');
    const adminLine = db.prepare(`
        SELECT m.* FROM messages m JOIN conversation_participants cp ON cp.conversation_id = m.conversation_id AND cp.public_key = ?
        ORDER BY m.timestamp DESC LIMIT 1`).get(dee.pk) as any;
    assert(adminLine?.nonce === 'plaintext-v1' && decode(adminLine?.ciphertext ?? '') === 'Welcome to the community',
        'the message the operator writes on the node\'s admin page is still stored as written');

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
