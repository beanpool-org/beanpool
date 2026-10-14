/**
 * A newcomer's first post where Beans are off (the global node), and the same rules kept where they are on.
 *
 * The global node's join card says "Post what you can offer and what you need", and the node refused both: a Need until the
 * member had listed an Offer (CONTRIBUTION_REQUIRED), and any post, poll or event until they had a profile photo
 * (rehearsal 2026-10-14 B4; global privacy review M2 and S6). Both rules guard a community's credit; where Beans are off
 * there is none, so neither applies there. Over REAL HTTPS, through the signature middleware, with signed members:
 *
 *   1. A local community (Beans on), fresh: a member with no photo is refused an Offer and a poll with the photo
 *      sentence; with a photo, a Need is 400 CONTRIBUTION_REQUIRED and their balance says isBlockedFromTrading; once
 *      they list an Offer, the Need goes through. Unchanged.
 *   2. The same database as the global profile (Beans off, the ledger never moved): a brand-new member with no photo
 *      posts a Need (200), another a poll, another an event; the member refused in 1 posts a Need with no Offer; nobody's
 *      balance says isBlockedFromTrading. A display name is still needed.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-global-first-post.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
process.env.ADMIN_PASSWORD = 'Global-First-Post-Admin-61!';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO_ERROR = 'Please set a profile photo before using the marketplace. Tap your profile to add one.';

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; callsign: string };

async function call(method: 'GET' | 'POST', path: string, body: unknown, id: Id | null) {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
}

async function main() {
    const { db, initSchema } = await import('./db/db.js');
    const { mirrorNodeProfileAtBoot, getNodeFeatures } = await import('./config/node-profile.js');
    const { CONTRIBUTION_REQUIRED_ERROR } = await import('@beanpool/engine');

    initSchema();
    const { initAdminPassword } = await import('./config/local-config.js');
    initAdminPassword();
    const se = await import('./state-engine.js');
    await se.initStateEngine();
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    /** A member as a join leaves one: a name, an account at 0, and a photo only when asked for. */
    const member = (callsign: string, photo = false): Id => {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, updated_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`)
            .run(pubKeyHex, callsign);
        if (photo) setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pubKeyHex);
        return { pubKeyHex, privateKey, callsign };
    };
    const post = (who: Id, body: Record<string, unknown>) =>
        call('POST', '/api/marketplace/posts', { category: 'general', description: 'Anything helps', ...body, authorPublicKey: who.pubKeyHex }, who);
    const need = (who: Id) => post(who, { type: 'need', title: 'Help moving a couch' });
    const poll = (who: Id) => post(who, {
        type: 'poll', title: 'Which day suits?', description: 'Pick one',
        pollOptions: [{ id: 'sat', text: 'Saturday' }, { id: 'sun', text: 'Sunday' }], durationDays: 7,
    });
    const event = (who: Id) => post(who, {
        type: 'event', title: 'Seed swap', lat: -28.5, lng: 153.5,
        eventStartAt: new Date(Date.now() + 30 * 3600_000).toISOString(),
    });
    const blocked = async (who: Id) => (await call('GET', `/api/ledger/balance/${who.pubKeyHex}`, null, who)).body?.isBlockedFromTrading;

    // ── 1. A local community: Beans on ──
    console.log('── 1. a local community (Beans on) ──');
    assert(getNodeFeatures().beans === true, 'Beans are on');
    const ana = member('Ana');
    const anaOffer = await post(ana, { type: 'offer', title: 'Lemons' });
    assert(anaOffer.status === 400 && anaOffer.body?.error === PHOTO_ERROR, `no photo: an Offer is refused with the photo sentence (${anaOffer.status} ${JSON.stringify(anaOffer.body)})`);
    const anaPoll = await poll(ana);
    assert(anaPoll.status === 400 && anaPoll.body?.error === PHOTO_ERROR, `no photo: a poll is refused too (${anaPoll.status} ${JSON.stringify(anaPoll.body)})`);
    const anaEvent = await event(ana);
    assert(anaEvent.status === 400 && anaEvent.body?.error === PHOTO_ERROR, `no photo: an event is refused too (${anaEvent.status} ${JSON.stringify(anaEvent.body)})`);

    const ben = member('Ben', true);
    const benNeed = await need(ben);
    assert(benNeed.status === 400 && benNeed.body?.error === CONTRIBUTION_REQUIRED_ERROR,
        `a photo, no Offer: a Need is 400 CONTRIBUTION_REQUIRED (${benNeed.status} ${JSON.stringify(benNeed.body)})`);
    assert(await blocked(ben) === true, 'and Ben\'s balance says isBlockedFromTrading');
    const benOffer = await post(ben, { type: 'offer', title: 'Spare jars' });
    assert(benOffer.status === 200, `Ben lists an Offer (${benOffer.status} ${JSON.stringify(benOffer.body)})`);
    const benNeed2 = await need(ben);
    assert(benNeed2.status === 200, `then his Need goes through (${benNeed2.status} ${JSON.stringify(benNeed2.body)})`);
    assert(await blocked(ben) === false, 'and he is no longer blocked');
    const cat = member('Cat', true);
    assert(await blocked(cat) === true, 'a member with no Offer is still blocked, as before');

    // ── 2. The global profile: Beans off ──
    console.log('\n── 2. NODE_PROFILE=global (Beans off) ──');
    process.env.NODE_PROFILE = 'global';
    await mirrorNodeProfileAtBoot();
    const info = await call('GET', '/api/community/info', null, cat);
    assert(info.status === 200 && info.body?.profile === 'global' && info.body?.features?.beans === false,
        `the node is global with Beans off (${info.status} ${info.body?.profile} ${JSON.stringify(info.body?.features?.beans)})`);

    const dan = member('Dan');
    const danNeed = await need(dan);
    assert(danNeed.status === 200 && danNeed.body?.post?.type === 'need',
        `a brand-new member with no photo and no Offer posts a Need → 200 (${danNeed.status} ${JSON.stringify(danNeed.body?.error ?? danNeed.body?.post?.type)})`);
    assert(await blocked(dan) === false, 'his balance does not say isBlockedFromTrading');
    const eve = member('Eve');
    const evePoll = await poll(eve);
    assert(evePoll.status === 200 && evePoll.body?.post?.type === 'poll', `another, no photo, asks a poll → 200 (${evePoll.status} ${JSON.stringify(evePoll.body?.error ?? '')})`);
    const fay = member('Fay');
    const fayEvent = await event(fay);
    assert(fayEvent.status === 200 && fayEvent.body?.post?.type === 'event', `another, no photo, makes an event → 200 (${fayEvent.status} ${JSON.stringify(fayEvent.body?.error ?? '')})`);
    const gus = member('Gus');
    const gusOffer = await post(gus, { type: 'offer', title: 'Tomato seedlings' });
    assert(gusOffer.status === 200, `another, no photo, lists an Offer → 200 (${gusOffer.status} ${JSON.stringify(gusOffer.body?.error ?? '')})`);

    const catNeed = await need(cat);
    assert(catNeed.status === 200, `Cat, blocked in 1, posts a Need with no Offer (${catNeed.status} ${JSON.stringify(catNeed.body?.error ?? '')})`);
    assert(await blocked(cat) === false, 'and her balance no longer says isBlockedFromTrading');

    const nameless = member('');
    const namelessNeed = await need(nameless);
    assert(namelessNeed.status === 400 && /display name/.test(namelessNeed.body?.error ?? ''),
        `a display name is still needed (${namelessNeed.status} ${JSON.stringify(namelessNeed.body)})`);
    delete process.env.NODE_PROFILE;

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ Where Beans are off a newcomer\'s first post is a Need, with or without a photo; where they are on, the rules hold.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
