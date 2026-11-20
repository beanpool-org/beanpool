/**
 * The push "There is a new event in your community." (`event.new`; scratch/fable-design/DESIGN-notify-and-backup-asks-fable-
 * amend2.md §9 question 6, §12.3 slice NEa; Marty, 21 Nov 2026, "yes all ten": small and capped, at most one a day, its own
 * switch, on by default). Over REAL HTTPS through the real signature middleware, on a local node as it ships.
 *
 *   1. the recipient rule: a new event for everyone reaches the members who may be told, and nobody else: not its host, not
 *      one with the switch off or Marketplace Activity off, not one with no phone or browser here, not one who blocked the
 *      host or whom the host blocked, not a suspended, paused or pruned account, not one on holiday, not a visitor's row,
 *      not an enterprise's account; a member with only a browser here is told
 *   2. the push names nothing: fixed words, and nothing of the event in what goes to Expo; its details (the recipient's
 *      alone) say where a tap lands and nothing else
 *   3. the daily cap, per recipient, on the server: a second event that day (from the same host or another, or two at once)
 *      reaches nobody already told; a member not yet told still is; the cap holds when the notices kept for the member are
 *      thinned; a day later the member is told again
 *   4. which posts: an Offer, a Need, a group's own event, an event for one person, an owner's assistant's event and a
 *      member's copy of another community's event tell nobody of a new event
 *   5. the switch: `notify_new_events` served on by default, turned off and on through the preferences route; the cap's
 *      stamp is never served and no app can set it
 *   6. where: `features.newEventPush` on a local community, and nothing on the global one, where an event tells nobody
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-event-new-push)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SENTENCE = 'There is a new event in your community.';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string };

async function main(): Promise<void> {
    console.log('\n=== The push when someone posts a new event (notifications NEa) ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const { getNodeFeatures } = await import('./config/node-profile.js');
    // A tree without the push (origin/main) runs every step anyway, so each fails as an assertion rather than an abort.
    const pushed: any = await import('./engine/event-new-push.js' as string).catch(() => ({}));

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

    function makeIdentity(name: string, opts: { phone?: boolean } = {}): Id {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                    VALUES (?, ?, 'active', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, name, new Date(Date.now() - 60 * DAY).toISOString());
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        if (opts.phone !== false) putPushTokenRow(pubKeyHex, `ExponentPushToken[${name}]`, 'android');
        return { pubKeyHex, privateKey, name };
    }
    function setPref(pk: string, key: string, value: string): void {
        db.prepare('INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, ?, ?) ON CONFLICT(public_key, pref_key) DO UPDATE SET pref_value = excluded.pref_value')
            .run(pk, key, value);
    }
    /** A browser row of the given kind; its box opens for nobody here, so nothing is sent to it, but it is registered. */
    function browserOnly(pk: string, kind: 'member' | 'asker'): void {
        db.prepare('INSERT INTO web_push_subscriptions (public_key, sub_id, sub_box, lang, kind) VALUES (?, ?, ?, NULL, ?)')
            .run(pk, crypto.randomBytes(32).toString('hex'), 'sealed-for-nobody-here', kind);
    }
    async function signed(method: 'GET' | 'POST', pathAndQuery: string, body: unknown, id: Id) {
        resetGatewayRateLimit();
        const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = { method, path: pathAndQuery.split('?')[0], timestamp: ts, nonce, body: bodyString };
        const headers: Record<string, string> = {
            'X-Public-Key': id.pubKeyHex,
            'X-Signature': signRequest(id.privateKey, canonical),
            [SIGNED_FOR_HEADER]: signedForHost(),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        };
        if (method === 'POST') headers['Content-Type'] = 'application/json';
        const res = await localFetch(`${BASE}${pathAndQuery}`, { method, headers, body: method === 'POST' ? bodyString : undefined });
        const text = await res.text();
        let json: any;
        try { json = JSON.parse(text); } catch { /* empty */ }
        return { status: res.status, body: json, text, error: json?.error as string | undefined };
    }

    let n = 0;
    /** An event, posted through the route the apps use. */
    const event = async (who: Id, body: Record<string, unknown> = {}): Promise<string> => {
        n++;
        const r = await signed('POST', '/api/marketplace/posts', {
            type: 'event', category: 'community', title: `${who.name} event ${n}`, description: 'Private description words',
            authorPublicKey: who.pubKeyHex, lat: -28.6, lng: 153.5, eventStartAt: inHours(48), eventEndAt: inHours(50),
            eventPlaceName: 'Riverside Hall', photos: TEST_PHOTOS, ...body,
        }, who);
        const id = r.body?.post?.id ?? r.body?.id;
        if (!id) throw new Error(`could not post an event: ${r.status} ${r.error}`);
        return id as string;
    };
    /** Whom the node told of a new event, from the notices it kept for each recipient (written as it sends). */
    const toldSince = (since: number): string[] => (db.prepare(
        "SELECT recipient FROM push_notices WHERE kind = 'event.new' AND rowid > ? ORDER BY rowid",
    ).all(since) as { recipient: string }[]).map(r => r.recipient);
    const mark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
    const names = (pks: string[], ids: Id[]) => pks.map(pk => ids.find(i => i.pubKeyHex === pk)?.name ?? pk.slice(0, 6));
    const settle = () => new Promise(r => setTimeout(r, 50));
    const stampKey = pushed.NEW_EVENT_PUSH_STAMP_KEY ?? 'event_new_push.sentAt';
    const fresh = () => db.prepare('DELETE FROM member_preferences WHERE pref_key = ?').run(stampKey);

    // ── Who is here ───────────────────────────────────────────────────────────────────────────────────────────────────
    const ana = makeIdentity('Ana');                    // the host
    const gil = makeIdentity('Gil');                    // told
    const hal = makeIdentity('Hal');                    // told
    const web = makeIdentity('Web', { phone: false });  // told: a browser with notifications on, no phone
    const off = makeIdentity('Off');                    // the switch off (through the route, below)
    const mkt = makeIdentity('Mkt');                    // Marketplace Activity off
    const nop = makeIdentity('Nop', { phone: false });  // no phone, and only a browser that asked to join, here
    const blk = makeIdentity('Blk');                    // has blocked Ana
    const byA = makeIdentity('ByA');                    // Ana has blocked them
    const sus = makeIdentity('Sus');                    // suspended
    const pau = makeIdentity('Pau');                    // paused (an admin's pause: 'disabled')
    const pru = makeIdentity('Pru');                    // pruned
    const hol = makeIdentity('Hol');                    // on holiday
    const vis = makeIdentity('Vis');                    // a visitor's row
    const ent = makeIdentity('Ent');                    // an enterprise's account
    const ben = makeIdentity('Ben');                    // a second host
    const all = [ana, gil, hal, web, off, mkt, nop, blk, byA, sus, pau, pru, hol, vis, ent, ben];
    browserOnly(web.pubKeyHex, 'member');
    browserOnly(nop.pubKeyHex, 'asker');
    setPref(mkt.pubKeyHex, 'notify_marketplace', 'false');
    addBlocks(blk.pubKeyHex, [ana.pubKeyHex]);
    addBlocks(ana.pubKeyHex, [byA.pubKeyHex]);
    db.prepare("UPDATE members SET status = 'suspended' WHERE public_key = ?").run(sus.pubKeyHex);
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(pau.pubKeyHex);
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(pru.pubKeyHex);
    setPref(hol.pubKeyHex, 'holiday_mode', 'true');
    db.prepare('UPDATE members SET is_visitor = 1 WHERE public_key = ?').run(vis.pubKeyHex);
    db.prepare('UPDATE members SET is_treasury = 1 WHERE public_key = ?').run(ent.pubKeyHex);
    se.reconcileLedgerFromDb();

    // ── 5 (first half). The switch, through the preferences route ──────────────────────────────────────────────────
    const prefsBefore = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(prefsBefore.status === 200 && prefsBefore.body?.notify_new_events === 'true',
        `"When someone posts a new event" is served on by default (${prefsBefore.status} ${show(prefsBefore.body?.notify_new_events)})`);
    const turnOff = await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { notify_new_events: false } }, off);
    const prefsOff = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(turnOff.status === 200 && prefsOff.body?.notify_new_events === 'false',
        `a member turns it off through the preferences route, and it reads off (${turnOff.status} ${turnOff.error ?? ''} ${show(prefsOff.body?.notify_new_events)})`);

    // ── 1. The recipient rule ──────────────────────────────────────────────────────────────────────────────────────
    let since = mark();
    expo.length = 0;
    const first = await event(ana, { title: 'Ana hosts a seed swap at 12 Short St' });
    await settle();
    const told = toldSince(since);
    assert(told.length === 4 && [ben, gil, hal, web].every(i => told.includes(i.pubKeyHex)),
        `a new event for everyone reaches exactly the four members who may be told, one of them with only a browser here (${show(names(told, all))})`);
    for (const [who, why] of [
        [ana, 'its host'], [off, 'a member with the switch off'], [mkt, 'a member with Marketplace Activity off'],
        [nop, 'a member with no phone and no browser of their own here'], [blk, 'a member who has blocked the host'],
        [byA, 'a member the host has blocked'], [sus, 'a suspended member'], [pau, 'a paused member'], [pru, 'a pruned account'],
        [hol, 'a member on holiday'], [vis, "a visitor's row"], [ent, "an enterprise's account"],
    ] as const) {
        assert(!told.includes(who.pubKeyHex), `never ${why}`);
    }

    // ── 2. Nothing of the host or the event leaves in the push ────────────────────────────────────────────────────
    const sent = expo.filter(m => m?.data?.k === 'event.new');
    assert(sent.length === 3 && sent.every(m => m.title === 'BeanPool' && m.body === SENTENCE),
        `what goes to Expo is the fixed title and sentence, one per phone (${show(sent.map(m => [m.title, m.body]))})`);
    const wire = JSON.stringify(sent);
    assert(!/Ana|Short St|seed swap|Riverside|Private description/.test(wire) && !wire.includes(first) && !wire.includes(ana.pubKeyHex),
        `and it carries no name, no title, no place, no post id and no key (${wire.slice(0, 300)})`);
    const details = db.prepare("SELECT data, title, body FROM push_notices WHERE kind = 'event.new' AND recipient = ?").get(gil.pubKeyHex) as any;
    assert(!!details && JSON.parse(details.data).postId === first && JSON.parse(details.data).screen === 'post'
        && Object.keys(JSON.parse(details.data)).sort().join(',') === 'postId,screen'
        && !/Ana|Short St|seed swap|Riverside/.test(`${details.title} ${details.body} ${details.data}`),
        `its details, the recipient's alone, open the event and say nothing else (${show(details)})`);

    // ── 3. The daily cap, per recipient ────────────────────────────────────────────────────────────────────────────
    since = mark();
    await event(ana, { title: 'Ana hosts a working bee' });
    await settle();
    assert(toldSince(since).length === 0, `a second event from the same host that day reaches nobody (${show(names(toldSince(since), all))})`);
    since = mark();
    await event(ben, { title: 'Ben hosts a repair cafe' });
    await settle();
    const cafe = toldSince(since);
    // Ana (its host the first time), and the two kept from Ana by a block, are told of Ben's: a block is between two people.
    assert(cafe.length === 3 && [ana, blk, byA].every(i => cafe.includes(i.pubKeyHex)),
        `another host's event that day reaches only those not yet told, and never one already told (${show(names(cafe, all))})`);

    const kim = makeIdentity('Kim');
    const lou = makeIdentity('Lou');
    all.push(kim, lou);
    since = mark();
    await Promise.all([event(ben, { title: 'Ben hosts a picnic' }), event(ana, { title: 'Ana hosts a walk' })]);
    await settle();
    const twoAtOnce = toldSince(since);
    assert(twoAtOnce.filter(pk => pk === kim.pubKeyHex).length === 1 && twoAtOnce.filter(pk => pk === lou.pubKeyHex).length === 1
        && twoAtOnce.length === 2,
        `the cap is each recipient's: two events at once reach the two not yet told once each, and nobody told before (${show(names(twoAtOnce, all))})`);

    // The notices kept for a member are thinned to their newest hundred (engine/push-notices.ts): the cap is not those.
    db.prepare("DELETE FROM push_notices WHERE recipient = ? AND kind = 'event.new'").run(gil.pubKeyHex);
    since = mark();
    await event(ben, { title: 'Ben hosts a film night' });
    await settle();
    assert(!toldSince(since).includes(gil.pubKeyHex), "with the notices kept for a member gone, the day's cap still holds for them");

    // A day later.
    const dayAgo = String(Math.floor(Date.now() / 1000) - 24 * 3600 - 60);
    db.prepare('UPDATE member_preferences SET pref_value = ? WHERE pref_key = ? AND public_key = ?').run(dayAgo, stampKey, gil.pubKeyHex);
    since = mark();
    await event(ben, { title: 'Ben hosts a talk' });
    await settle();
    assert(show(toldSince(since)) === show([gil.pubKeyHex]),
        `a day after being told, a member is told again, and the others still wait their day (${show(names(toldSince(since), all))})`);

    // ── 4. Which posts tell nobody ─────────────────────────────────────────────────────────────────────────────────
    fresh();
    since = mark();
    se.createPost('offer', 'garden', 'Ana offers seedlings', '', 1000, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS);
    se.createPost('need', 'garden', 'Ana needs a rake', '', 1000, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS);
    await settle();
    assert(toldSince(since).length === 0, 'an Offer and a Need tell nobody of a new event');

    const eventOpts = { eventStartAt: inHours(30), eventEndAt: inHours(31), eventPlaceName: 'Riverside Hall' };
    const crew = se.createGroup({ name: 'Garden crew', joinPolicy: 'open', createdBy: ana.pubKeyHex });
    const groupEvent = se.createPost('event', 'community', 'Crew only', '', 0, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
        false, undefined, undefined, { ...eventOpts, audienceScope: 'group', targetGroupId: crew.id });
    await settle();
    assert(!!groupEvent && toldSince(since).length === 0, `a group's own event tells nobody of it (${show(names(toldSince(since), all))})`);

    // An event is for the community or a group (engine/posts.ts): one for one person is refused, and tells nobody.
    let directRefused = false;
    try {
        se.createPost('event', 'community', 'For Hal only', '', 0, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
            false, undefined, undefined, { ...eventOpts, audienceScope: 'direct', targetPubkey: hal.pubKeyHex });
    } catch {
        directRefused = true;
    }
    await settle();
    assert(directRefused && toldSince(since).length === 0, `an event for one person is refused, and tells nobody (${show(names(toldSince(since), all))})`);

    const assistantEvent = se.createPost('event', 'community', 'An assistant hosts', '', 0, 'fixed', ana.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
        false, undefined, undefined, { ...eventOpts, createdVia: 'assistant:test-grant' });
    await settle();
    assert(!!assistantEvent && toldSince(since).length === 0, `an event an owner's assistant made tells nobody (${show(names(toldSince(since), all))})`);

    assert(typeof pushed.noticeNewEvent === 'function', 'the sender is there to call');
    const copyCalls: unknown[] = [];
    const spy = (...args: unknown[]) => { copyCalls.push(args); return 1; };
    // An event for everyone (it tells the members as it is made), then, with the day's stamps gone, the same event handed
    // over as a member's copy from another community (engine/event-copy.ts, `shownCopy`), and as itself.
    const forCopy = se.createPost('event', 'community', 'Ben hosts a swap', '', 0, 'fixed', ben.pubKeyHex, -28.6, 153.5, TEST_PHOTOS,
        false, undefined, undefined, eventOpts);
    fresh();
    const copyTold = pushed.noticeNewEvent?.({ id: forCopy?.id, author: ben.pubKeyHex, copied: true }, spy) ?? -1;
    const realTold = pushed.noticeNewEvent?.({ id: forCopy?.id, author: ben.pubKeyHex }, spy) ?? -1;
    assert(copyTold === 0 && realTold > 0 && copyCalls.length === 1,
        `a member's copy of another community's event tells nobody; the same call for an event made here does (${copyTold}, ${realTold}, ${copyCalls.length})`);
    fresh();

    // Fresh hosts from here: a member holds at most five upcoming events at a time (engine/posts.ts).
    const cal = makeIdentity('Cal');
    const dee = makeIdentity('Dee');
    all.push(cal, dee);
    since = mark();
    await event(cal, { title: 'Cal hosts a market day' });
    await settle();
    assert(toldSince(since).length >= 3, `setup sanity: with the day's stamps gone, an event reaches its members again (${show(names(toldSince(since), all))})`);

    // ── 5 (second half). On again; the stamp is nobody's to read or set ─────────────────────────────────────────
    await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { notify_new_events: true } }, off);
    fresh();
    since = mark();
    await event(dee, { title: 'Dee hosts a quiz' });
    await settle();
    assert(toldSince(since).includes(off.pubKeyHex), 'turned back on, the member is told again');
    const served = await signed('GET', `/api/members/preferences?publicKey=${off.pubKeyHex}`, undefined, off);
    assert(served.status === 200 && !(stampKey in (served.body ?? {})), `the cap's stamp is never served (${show(Object.keys(served.body ?? {}))})`);
    const reset = await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { [stampKey]: '0' } }, off);
    assert(reset.status === 400, `no app can set the cap's stamp to be told again (${reset.status} ${reset.error ?? ''})`);

    // ── 6. Where ────────────────────────────────────────────────────────────────────────────────────────────────────
    const info = await signed('GET', '/api/community/info', undefined, gil);
    assert(info.body?.features?.newEventPush === true, `a local community says newEventPush (${show(info.body?.features?.newEventPush)})`);
    process.env.NODE_PROFILE = 'global';
    try {
        assert(getNodeFeatures().newEventPush === undefined, 'the global community says nothing of it');
        fresh();
        const globalCalls: unknown[] = [];
        const globalTold = pushed.noticeNewEvent?.({ id: first, author: ana.pubKeyHex }, (...args: unknown[]) => { globalCalls.push(args); return 1; }) ?? -1;
        assert(globalTold === 0 && globalCalls.length === 0, 'and an event there tells nobody: Home and the map show events, no buzz');
    } finally {
        delete process.env.NODE_PROFILE;
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
