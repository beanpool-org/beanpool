/**
 * The push "Someone in your community asked for something you're into." (`market.asked`;
 * scratch/fable-design/DESIGN-cold-start-trades-fable.md §2.1, §2.4, slice N3; Marty, 4 Nov 2026: "All Fable's picks": on
 * by default, at most one a day, starred categories only, a switch in Settings → Notifications). Over REAL HTTPS through
 * the real signature middleware, on a local node as it ships.
 *
 *   1. the recipient rule: a new Need reaches the members who starred its category and have a phone here, and nobody else:
 *      not its author, not a member who starred another category, not one with the switch off or Marketplace Activity off,
 *      not one with no phone, not one who blocked the author or whom the author blocked, not a suspended, paused or
 *      pruned account, not one on holiday, not a visitor's row
 *   2. the push names nobody: fixed words, and nothing of the Need in what goes to Expo; its details (the recipient's
 *      alone) say where a tap lands and nothing else
 *   3. the daily cap, per recipient, on the server: a second Need that day (from the same asker or another, or two at once)
 *      reaches nobody already told; a member not yet told still is; the cap holds when the notices kept for the member
 *      are thinned; a day later the member is told again
 *   4. which posts: an Offer, a Need an owner's assistant made, and a Need for a group or one person tell nobody
 *   5. the switch: `notify_asked` served on by default, turned off and on through the preferences route; the cap's stamp is
 *      never served and no app can set it
 *   6. where: `features.askedPush` on a local community with Beans on, and nothing on the global one
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-asked-push)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SENTENCE = "Someone in your community asked for something you're into.";

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string };

async function main(): Promise<void> {
    console.log('\n=== The push when a neighbour asks (cold start N3) ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const { getNodeFeatures } = await import('./config/node-profile.js');
    // A tree without the push (origin/main) runs every step anyway, so each fails as an assertion rather than an abort.
    const asked: any = await import('./engine/asked-push.js' as string).catch(() => ({}));

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    // What goes to Expo, as it goes (the dispatcher's only way out).
    const expo: any[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (input: any, init?: any) => {
        const url = String(input instanceof Request ? input.url : input);
        if (new URL(url).hostname === 'exp.host') {
            const batch = JSON.parse(init?.body ?? '[]');
            expo.push(...batch);
            return new Response(JSON.stringify({ data: batch.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200 });
        }
        return realFetch(input, init);
    };

    function makeIdentity(name: string, opts: { stars?: string[]; phone?: boolean } = {}): Id {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                    VALUES (?, ?, 'active', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, name, new Date(Date.now() - 60 * DAY).toISOString());
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        if (opts.stars) setPref(pubKeyHex, 'interests', JSON.stringify(opts.stars));
        if (opts.phone !== false) putPushTokenRow(pubKeyHex, `ExponentPushToken[${name}]`, 'android');
        return { pubKeyHex, privateKey, name };
    }
    function setPref(pk: string, key: string, value: string): void {
        db.prepare('INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value')
            .run(pk, key, value);
    }
    async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id) {
        resetGatewayRateLimit();
        const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${pathAndQuery.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        const headers: Record<string, string> = {
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: json, text, error: json?.error as string | undefined };
    }

    const offered = new Set<string>();
    let n = 0;
    const post = async (who: Id, type: 'offer' | 'need', body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type, category: 'garden', title: `${who.name} ${type} ${n}`, description: 'Private description words', credits: 20, priceType: 'fixed',
            authorPublicKey: who.pubKeyHex, photos: TEST_PHOTOS, lat: -28.6, lng: 153.5, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post a ${type}: ${r.status} ${r.error}`);
        return id as string;
    };
    /** A member's Offer first (a Need needs a listed Offer where Beans are on), in a category nobody stars. */
    const offerFirst = async (who: Id) => {
        if (offered.has(who.pubKeyHex)) return;
        await post(who, 'offer', { category: 'other', title: `${who.name} offers` });
        offered.add(who.pubKeyHex);
    };
    const need = async (who: Id, body: Record<string, unknown> = {}): Promise<string> => { await offerFirst(who); return post(who, 'need', body); };
    /** Whom the node told of a neighbour's Need, from the notices it kept for each recipient (written as it sends). */
    const toldSince = (since: number): string[] => (db.prepare(
        "SELECT recipient FROM push_notices WHERE kind = 'market.asked' AND rowid > ? ORDER BY rowid",
    ).all(since) as { recipient: string }[]).map(r => r.recipient);
    const mark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
    const names = (pks: string[], ids: Id[]) => pks.map(pk => ids.find(i => i.pubKeyHex === pk)?.name ?? pk.slice(0, 6));
    const settle = () => new Promise(r => setTimeout(r, 50));

    // ── Who is here ───────────────────────────────────────────────────────────────────────────────────────────────────
    const ana = makeIdentity('Ana', { stars: ['garden'] });              // the asker; starred it too
    const gil = makeIdentity('Gil', { stars: ['tools', 'garden'] });     // told
    const hal = makeIdentity('Hal', { stars: ['garden'] });              // told
    const tia = makeIdentity('Tia', { stars: ['tools'] });               // another category
    const off = makeIdentity('Off', { stars: ['garden'] });              // the switch off (through the route, below)
    const mkt = makeIdentity('Mkt', { stars: ['garden'] });              // Marketplace Activity off
    const nop = makeIdentity('Nop', { stars: ['garden'], phone: false }); // no phone here
    const blk = makeIdentity('Blk', { stars: ['garden'] });              // has blocked Ana
    const byA = makeIdentity('ByA', { stars: ['garden'] });              // Ana has blocked them
    const sus = makeIdentity('Sus', { stars: ['garden'] });              // suspended
    const pau = makeIdentity('Pau', { stars: ['garden'] });              // paused (an admin's pause: 'disabled')
    const pru = makeIdentity('Pru', { stars: ['garden'] });              // pruned
    const hol = makeIdentity('Hol', { stars: ['garden'] });              // on holiday
    const vis = makeIdentity('Vis', { stars: ['garden'] });              // a visitor's row
    const ben = makeIdentity('Ben', { stars: ['food'] });                // a second asker
    const all = [ana, gil, hal, tia, off, mkt, nop, blk, byA, sus, pau, pru, hol, vis, ben];
    setPref(mkt.pubKeyHex, 'notify_marketplace', 'false');
    addBlocks(blk.pubKeyHex, [ana.pubKeyHex]);
    addBlocks(ana.pubKeyHex, [byA.pubKeyHex]);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sus.pubKeyHex);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(pau.pubKeyHex);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(pru.pubKeyHex);
    setPref(hol.pubKeyHex, 'holiday_mode', 'true');
    db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(vis.pubKeyHex);
    se.reconcileLedgerFromDb();

    // ── 5 (first half). The switch, through the preferences route ──────────────────────────────────────────────────
    const prefsBefore = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(prefsBefore.status === 200 && prefsBefore.body?.notify_asked === 'true',
        `"When a neighbour asks for something I'm into" is served on by default (${prefsBefore.status} ${show(prefsBefore.body?.notify_asked)})`);
    const turnOff = await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { notify_asked: false } }, off);
    const prefsOff = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(turnOff.status === 200 && prefsOff.body?.notify_asked === 'false',
        `a member turns it off through the preferences route, and it reads off (${turnOff.status} ${turnOff.error ?? ''} ${show(prefsOff.body?.notify_asked)})`);

    // ── 1. The recipient rule ──────────────────────────────────────────────────────────────────────────────────────
    await offerFirst(ana);
    await offerFirst(ben);
    let since = mark();
    expo.length = 0;
    const first = await need(ana, { title: 'Ana needs a bed dug at 12 Short St', category: 'garden', credits: 40 });
    await settle();
    const told = toldSince(since);
    assert(told.length === 2 && told.includes(gil.pubKeyHex) && told.includes(hal.pubKeyHex),
        `a new garden Need reaches exactly the two members who starred garden, have a phone here and may be told (${show(names(told, all))})`);
    for (const [who, why] of [
        [ana, 'its author'], [tia, 'a member who starred another category'], [off, 'a member with the switch off'],
        [mkt, 'a member with Marketplace Activity off'], [nop, 'a member with no phone here'], [blk, 'a member who has blocked the asker'],
        [byA, 'a member the asker has blocked'], [sus, 'a suspended member'], [pau, 'a paused member'], [pru, 'a pruned account'],
        [hol, 'a member on holiday'], [vis, "a visitor's row"],
    ] as const) {
        assert(!told.includes(who.pubKeyHex), `never ${why}`);
    }

    // ── 2. Nothing of the asker or the Need leaves in the push ────────────────────────────────────────────────────
    const sent = expo.filter(m => m?.data?.k === 'market.asked');
    assert(sent.length === 2 && sent.every(m => m.title === 'BeanPool' && m.body === SENTENCE),
        `what goes to Expo is the fixed title and sentence, one per phone (${show(sent.map(m => [m.title, m.body]))})`);
    const wire = JSON.stringify(sent);
    // The price by value, never as a bare "40" in the wire: a random notice id or a timestamp can hold those digits (#2937).
    const leaves = (v: unknown): unknown[] => v && typeof v === 'object' ? Object.values(v as object).flatMap(leaves) : [v];
    const priced = sent.flatMap(leaves).some(v => v === 40 || v === '40' || (typeof v === 'string' && /\b40\s*(Beans|Ʀ)/.test(v)));
    assert(!/Ana|Short St|bed dug|garden|Private description/.test(wire) && !priced && !wire.includes(first) && !wire.includes(ana.pubKeyHex),
        `and it carries no name, no title, no category, no price, no post id and no key (${wire.slice(0, 300)})`);
    const details = db.prepare("SELECT recipient, data, title, body FROM push_notices WHERE kind = 'market.asked' AND recipient = ?").get(gil.pubKeyHex) as any;
    assert(!!details && JSON.parse(details.data).postId === first && JSON.parse(details.data).screen === 'post'
        && !/Ana|Short St|bed dug/.test(`${details.title} ${details.body} ${details.data}`),
        `its details, the recipient's alone, open the Need and name nobody (${show(details)})`);

    // ── 3. The daily cap, per recipient ────────────────────────────────────────────────────────────────────────────
    since = mark();
    await need(ana, { title: 'Ana needs mulch', category: 'garden' });
    assert(toldSince(since).length === 0, `a second Need from the same asker that day reaches nobody (${show(names(toldSince(since), all))})`);
    since = mark();
    await need(ben, { title: 'Ben needs a hedge cut', category: 'garden' });
    const hedge = toldSince(since);
    // Ana (its author the first time), and the two kept from Ana by a block, are told of Ben's: a block is between two people.
    assert(hedge.length === 3 && [ana, blk, byA].every(i => hedge.includes(i.pubKeyHex)),
        `another asker's Need that day reaches only those not yet told, and never one already told (${show(names(hedge, all))})`);

    const kim = makeIdentity('Kim', { stars: ['garden'] });
    const lou = makeIdentity('Lou', { stars: ['garden'] });
    all.push(kim, lou);
    since = mark();
    await Promise.all([need(ben, { title: 'Ben needs compost', category: 'garden' }), need(ana, { title: 'Ana needs a rake', category: 'garden' })]);
    const twoAtOnce = toldSince(since);
    assert(twoAtOnce.filter(pk => pk === kim.pubKeyHex).length === 1 && twoAtOnce.filter(pk => pk === lou.pubKeyHex).length === 1
        && twoAtOnce.length === 2,
        `the cap is each recipient's: two Needs at once reach the two not yet told once each, and nobody told before (${show(names(twoAtOnce, all))})`);

    // The notices kept for a member are thinned to their newest hundred (engine/push-notices.ts): the cap is not those.
    db.prepare("DELETE FROM push_notices WHERE recipient = ? AND kind = 'market.asked'").run(gil.pubKeyHex);
    since = mark();
    await need(ben, { title: 'Ben needs stakes', category: 'garden' });
    assert(!toldSince(since).includes(gil.pubKeyHex), 'with the notices kept for a member gone, the day\'s cap still holds for them');

    // A day later.
    const stampKey = asked.ASKED_PUSH_STAMP_KEY ?? 'asked_push.sentAt';
    const dayAgo = String(Math.floor(Date.now() / 1000) - 24 * 3600 - 60);
    db.prepare('UPDATE member_preferences SET pref_value = ? WHERE pref_key = ? AND public_key = ?').run(dayAgo, stampKey, gil.pubKeyHex);
    since = mark();
    await need(ben, { title: 'Ben needs a spade', category: 'garden' });
    assert(show(toldSince(since)) === show([gil.pubKeyHex]),
        `a day after being told, a member is told again, and the others still wait their day (${show(names(toldSince(since), all))})`);

    // ── 4. Which posts tell nobody ─────────────────────────────────────────────────────────────────────────────────
    const fresh = () => db.prepare('DELETE FROM member_preferences WHERE pref_key = ?').run(stampKey);
    fresh();
    since = mark();
    await post(ana, 'offer', { title: 'Ana offers seedlings', category: 'garden' });
    assert(toldSince(since).length === 0, 'an Offer in a starred category tells nobody');

    const assistantNeed = se.createPost('need', 'garden', 'An assistant asks', '', 10, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
        false, undefined, undefined, { createdVia: 'assistant:test-grant' });
    assert(!!assistantNeed && toldSince(since).length === 0, `a Need an owner's assistant made tells nobody (${show(names(toldSince(since), all))})`);

    const directNeed = se.createPost('need', 'garden', 'For Hal only', '', 10, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
        false, undefined, undefined, { audienceScope: 'direct', targetPubkey: hal.pubKeyHex });
    assert(!!directNeed && toldSince(since).length === 0, `a Need for one person tells nobody else of it, nor them by this push (${show(names(toldSince(since), all))})`);
    assert(typeof asked.needAsksNeighbours === 'function'
        && asked.needAsksNeighbours({ id: 'x', type: 'need', status: 'active', category: 'garden', author: ana.pubKeyHex, audienceScope: 'group' }) === false
        && asked.needAsksNeighbours({ id: 'x', type: 'need', status: 'active', category: 'garden', author: ana.pubKeyHex, copied: true }) === false
        && asked.needAsksNeighbours({ id: 'x', type: 'need', status: 'active', category: 'garden', author: ana.pubKeyHex, audienceScope: 'public' }) === true,
        "a group's Need and a copy from another community tell nobody; a Need for the whole community does");

    since = mark();
    await need(ben, { title: 'Ben needs a wheelbarrow', category: 'garden' });
    assert(toldSince(since).length >= 2, `setup sanity: with the day's stamps gone, a Need reaches its members again (${show(names(toldSince(since), all))})`);

    // ── 5 (second half). On again; the stamp is nobody's to read or set ─────────────────────────────────────────
    await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { notify_asked: true } }, off);
    fresh();
    since = mark();
    await need(ben, { title: 'Ben needs twine', category: 'garden' });
    assert(toldSince(since).includes(off.pubKeyHex), 'turned back on, the member is told again');
    const served = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(served.status === 200 && !(stampKey in (served.body ?? {})), `the cap's stamp is never served (${show(Object.keys(served.body ?? {}))})`);
    const reset = await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { [stampKey]: '0' } }, off);
    assert(reset.status === 400, `no app can set the cap's stamp to be told again (${reset.status} ${reset.error ?? ''})`);

    // ── 6. Where ────────────────────────────────────────────────────────────────────────────────────────────────────
    const info = await signed('GET', '/api/community/info', undefined, gil);
    assert(info.body?.features?.askedPush === true, `a local community with Beans on says askedPush (${show(info.body?.features?.askedPush)})`);
    process.env.NODE_PROFILE = 'global';
    try {
        assert(getNodeFeatures().askedPush === undefined, 'the global community says nothing of it');
        assert(typeof asked.needAsksNeighbours === 'function'
            && asked.needAsksNeighbours({ id: 'x', type: 'need', status: 'active', category: 'garden', author: ana.pubKeyHex }) === false,
            'and a Need there tells nobody: the lounge gets the card, not the buzz');
    } finally {
        delete process.env.NODE_PROFILE;
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
