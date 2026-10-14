/**
 * Test Suite: the host lets people in to an event's note and chat (scratch/global-node/DESIGN-global-member-privacy-fable.md
 * §2 and §7 slice 2, from the privacy review of 2026-10-14, M1: "A throwaway account taps Going and is given the host's
 * private note and the event chat").
 *
 * Boots the real server and goes through the real middleware over HTTPS, signed:
 *   1. A local community (NODE_PROFILE unset): an event made with no choice does not wait for the host; Going opens the
 *      note and the chat as before, with the old notice; the post carries no `eventHostLetsIn`; let-in is refused.
 *   2. The global node: an event made with no choice waits for the host (and one made unticked does not). Going is one tap
 *      and counted; until the host lets them in the member gets no note (by id, the listing, Home) and the chat answers 403
 *      `waiting_for_host` to a read and a post, never "Only the host and people going"; they have no seat in the chat's
 *      participants. The host is told once an hour at most. The host's own friend is let in on Going. Let in → the note,
 *      the chat with the let-in notice, a seat, a push to the member; take back → waiting again; Interested → Going keeps
 *      it; Not going loses it; `everyone` lets in only those Going now; a member not Going is 400, a non-host 403, an
 *      outsider to a group's event 404, an ended event 410, a cancelled one 409. The chat's participants are only those who
 *      may read it (the #1939 review's N6). Unticking on edit lets everyone Going in, with no push, and leaves one system
 *      line in the chat, "The host opened this chat to everyone going." (Marty, 15 Oct), which the host can't remove;
 *      ticking again takes the waiting out of the chat and writes no line. The generic GET /api/messages/:id answers
 *      someone waiting with the same words and code (the #1953 review's N5). A member removed from a group's event's
 *      group is never let in, alone or with everyone, and is not pushed (N2).
 *   3. The operator's override `nodeProfile.openMembership = false` on the global node: a new event does not wait.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-event-host-lets-in)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { localFetch } from './keepalive-test-fetch.js';
import { toldPush, type ToldPush } from './push-notice-test-harness.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}

function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

type Answer = { status: number; body: any };
async function call(method: 'GET' | 'POST', p: string, id: Id, payload?: unknown): Promise<Answer> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const res = await localFetch(`${BASE}${p}`, {
        method,
        headers: { ...signedHeaders(method, p, body, id), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
    });
    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed };
}

const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const FORBIDDEN = 'Only the host and people going can open this event chat';
const NOTE = 'Blue gate, number 12, code 4321';

async function main() {
    console.log('The host lets people in to the note and the chat...\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { NODE_PROFILE_KEY } = await import('./config/node-profile.js');
    const { updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { EVENT_THREAD_NOTICE, EVENT_THREAD_NOTICE_LET_IN, EVENT_CHAT_OPENED_TEXT, EVENT_CHAT_OPENED_SYSTEM_TYPE } = await import('./engine/event-thread.js');
    const { resetEventWaitingPushes, scrubEndedEvents } = await import('./engine/posts.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const { stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
    stopPricingAggregatorWorker();
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    // Every push as its member is told it (push-notice-test-harness.ts).
    const sent: ToldPush[] = [];
    const realFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: any, init: any) => {
        if (String(url).includes('exp.host')) {
            sent.push(...JSON.parse(init.body).map((m: any) => toldPush(db, m)));
            return { ok: true, status: 200, json: async () => ({}) } as any;
        }
        return realFetch(url, init);
    };

    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    const joined = new Date(Date.now() - 400 * 24 * HOUR).toISOString();
    const member = (name: string): Id => {
        const id = keypair();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, updated_at)
                    VALUES (?, ?, 'active', ?, 'genesis', 'TEST', 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(id.pubKeyHex, name, joined);
        setMemberPhoto(db, id.pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pubKeyHex);
        putPushTokenRow(id.pubKeyHex, `ExponentPushToken[${name}]`, 'android');
        return id;
    };
    const hana = member('Hana');     // the host
    const fred = member('Fred');     // on Hana's friends list
    const sam = member('Sam');       // a stranger
    const tia = member('Tia');       // another stranger
    const uma = member('Uma');       // taps Going after "Let everyone in"
    const omar = member('Omar');     // never Going
    db.prepare(`INSERT INTO friends (owner_pubkey, friend_pubkey) VALUES (?, ?)`).run(hana.pubKeyHex, fred.pubKeyHex);

    const makeEvent = async (title: string, extra: Record<string, unknown> = {}): Promise<Answer> =>
        call('POST', '/api/marketplace/posts', hana, {
            type: 'event', category: 'community', title, description: 'Bring gloves',
            authorPublicKey: hana.pubKeyHex, lat: -28.65, lng: 153.56,
            eventStartAt: inHours(48), eventEndAt: inHours(50), eventPlaceName: 'Bangalow Hall', eventPrivateNote: NOTE,
            ...extra,
        });
    const byId = async (postId: string, who: Id) => (await call('GET', `/api/marketplace/posts?id=${postId}`, who)).body?.posts?.[0]
        ?? (await call('GET', `/api/marketplace/posts?id=${postId}`, who)).body?.[0];
    const rsvp = (postId: string, who: Id, status: 'going' | 'interested' | null) =>
        call('POST', `/api/marketplace/posts/${postId}/rsvp`, who, { status });
    const chat = (postId: string, who: Id) => call('GET', `/api/marketplace/posts/${postId}/chat`, who);
    const say = (postId: string, who: Id, text: string) => call('POST', `/api/marketplace/posts/${postId}/chat/message`, who, { text });
    const letIn = (postId: string, who: Id, body: Record<string, unknown>) => call('POST', `/api/marketplace/posts/${postId}/let-in`, who, body);
    const seat = (postId: string, who: Id) => !!db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id = ? AND public_key = ?').get(postId, who.pubKeyHex);
    const flagOf = (postId: string) => (db.prepare('SELECT event_host_lets_in AS f FROM posts WHERE id = ?').get(postId) as any)?.f;
    const letInAtOf = (postId: string, who: Id) => (db.prepare('SELECT let_in_at AS t FROM event_rsvps WHERE post_id = ? AND member_pubkey = ?').get(postId, who.pubKeyHex) as any)?.t ?? null;

    // ── 1. A local community ──
    console.log('── 1. A local community (NODE_PROFILE unset) ──');
    const local = await makeEvent('Local working bee');
    const localId = local.body?.post?.id ?? local.body?.id;
    assert(local.status === 200 || local.status === 201, `an event is made over HTTP (${local.status} ${JSON.stringify(local.body).slice(0, 120)})`);
    assert(flagOf(localId) === 0, 'made with no choice on a local community, it does not wait for the host (stored 0)');
    const localHostView = await byId(localId, hana);
    assert(localHostView && !('eventHostLetsIn' in localHostView), 'the post carries no eventHostLetsIn where it is off (bodies as before)');
    await rsvp(localId, sam, 'going');
    const localChat = await chat(localId, sam);
    assert(localChat.status === 200 && localChat.body?.privateNote === NOTE && localChat.body?.notice === EVENT_THREAD_NOTICE,
        'Going opens the chat and the note at once, with the old notice');
    const localSam = await byId(localId, sam);
    assert(localSam?.eventPrivateNote === NOTE && !('myLetIn' in localSam), 'the note is on the post for Going, and no myLetIn');
    assert(seat(localId, sam), 'Going takes a seat in the chat');
    const notAsked = await letIn(localId, hana, { memberPublicKey: sam.pubKeyHex });
    assert(notAsked.status === 400 && /doesn't wait for the host/.test(notAsked.body?.error || ''), `let-in on an event that doesn't wait is 400 (${notAsked.status})`);

    // ── 2. The global node ──
    console.log('\n── 2. The global node (NODE_PROFILE=global) ──');
    process.env.NODE_PROFILE = 'global';
    const info = await call('GET', '/api/community/info', hana);
    assert(info.body?.features?.openMembership === true, 'features.openMembership is true');
    const made = await makeEvent('Garden dinner');
    const ev = made.body?.post?.id ?? made.body?.id;
    assert(!!ev && flagOf(ev) === 1, `made with no choice on the global node, it waits for the host (stored 1; ${made.status})`);
    const unticked = await makeEvent('Park clean-up', { eventHostLetsIn: false });
    const evOpen = unticked.body?.post?.id ?? unticked.body?.id;
    assert(!!evOpen && flagOf(evOpen) === 0, 'made unticked on the global node, it does not wait (the host may untick)');
    const hostView = await byId(ev, hana);
    assert(hostView?.eventHostLetsIn === true && hostView?.eventPrivateNote === NOTE, 'the host reads the flag and their own note');

    const before = await chat(ev, sam);
    assert(before.status === 403 && before.body?.error === FORBIDDEN && !before.body?.code, 'before Going: the old refusal, no code');

    sent.length = 0;
    resetEventWaitingPushes();
    const going = await rsvp(ev, sam, 'going');
    assert(going.status === 200 && going.body?.post?.myRsvp === 'going' && going.body?.post?.goingCount === 1,
        'Going is one tap and is counted');
    assert(going.body?.post?.myLetIn === false && !('eventPrivateNote' in (going.body?.post ?? {})),
        'the answer says they wait, and carries no note');
    const waitRead = await chat(ev, sam);
    assert(waitRead.status === 403 && waitRead.body?.code === 'waiting_for_host' && waitRead.body?.error !== FORBIDDEN,
        `the chat answers 403 waiting_for_host, never "Only the host and people going" (${JSON.stringify(waitRead.body)})`);
    const waitSay = await say(ev, sam, 'hello?');
    assert(waitSay.status === 403 && waitSay.body?.code === 'waiting_for_host', 'a line from someone waiting is refused the same way');
    const samView = await byId(ev, sam);
    assert(samView && !('eventPrivateNote' in samView) && samView.myLetIn === false && samView.eventHostLetsIn === true,
        'by id: no note, myLetIn false');
    const listing = await call('GET', '/api/marketplace/posts?type=event', sam);
    const listed = (listing.body?.posts ?? listing.body ?? []).find((p: any) => p.id === ev);
    assert(listed && !('eventPrivateNote' in listed), 'the listing carries no note');
    const syncRead = await call('GET', '/api/marketplace/posts?type=event&updatedAfter=1970-01-01T00:00:00.000Z', sam);
    const synced = (syncRead.body?.posts ?? syncRead.body ?? []).find((p: any) => p.id === ev);
    assert(synced && !('eventPrivateNote' in synced), `the sync read carries no note (${syncRead.status}, ${Array.isArray(syncRead.body) ? 'array' : Object.keys(syncRead.body ?? {}).join(',')}, ${JSON.stringify(syncRead.body).slice(0, 200)})`);
    const home = await call('GET', '/api/home?lat=-28.65&lng=153.56', sam);
    assert(home.status === 200 && !JSON.stringify(home.body).includes(NOTE), 'Home carries no note');
    assert(!seat(ev, sam), 'someone waiting has no seat in the chat (their key is not handed to the others)');
    const hostPushes = sent.filter(p => p.to === 'ExponentPushToken[Hana]');
    assert(hostPushes.length === 1 && /1 person is waiting to be let in to Garden dinner/.test(hostPushes[0]?.body || ''),
        `the host is told someone is waiting (${hostPushes.map(p => p.body).join(' | ')})`);
    await rsvp(ev, tia, 'going');
    assert(sent.filter(p => p.to === 'ExponentPushToken[Hana]').length === 1, 'a second Going within the hour: no second push');

    const friend = await rsvp(ev, fred, 'going');
    assert(friend.body?.post?.myLetIn === true && friend.body?.post?.eventPrivateNote === NOTE, "the host's friend is let in on Going");
    assert((await chat(ev, fred)).status === 200 && seat(ev, fred), 'and reads the chat, with a seat');

    const outsiderLetIn = await letIn(ev, omar, { memberPublicKey: sam.pubKeyHex });
    assert(outsiderLetIn.status === 403, `a member who isn't the host can't let anyone in (${outsiderLetIn.status})`);
    const notGoing = await letIn(ev, hana, { memberPublicKey: omar.pubKeyHex });
    assert(notGoing.status === 400 && /haven't tapped Going/.test(notGoing.body?.error || ''), 'letting in someone not Going is 400');

    sent.length = 0;
    const letSam = await letIn(ev, hana, { memberPublicKey: sam.pubKeyHex });
    const samRow = (letSam.body?.post?.eventRsvps ?? []).find((r: any) => r.memberPubkey === sam.pubKeyHex);
    assert(letSam.status === 200 && !!samRow?.letInAt, 'the host lets Sam in: the answer shows when');
    const tiaRow = (letSam.body?.post?.eventRsvps ?? []).find((r: any) => r.memberPubkey === tia.pubKeyHex);
    assert(tiaRow && tiaRow.letInAt === null, 'and Tia still waiting');
    const samPush = sent.filter(p => p.to === 'ExponentPushToken[Sam]');
    assert(samPush.length === 1 && samPush[0]?.body === 'Hana let you in to Garden dinner' && samPush[0]?.data?.postId === ev,
        `Sam is told, and the push opens the event (${samPush.map(p => p.body).join(' | ')})`);
    const inChat = await chat(ev, sam);
    assert(inChat.status === 200 && inChat.body?.privateNote === NOTE && inChat.body?.notice === EVENT_THREAD_NOTICE_LET_IN,
        'Sam reads the chat and the note, with the let-in notice');
    const parts: string[] = inChat.body?.conversation?.participants ?? [];
    assert(parts.includes(sam.pubKeyHex) && parts.includes(fred.pubKeyHex) && !parts.includes(tia.pubKeyHex),
        "the chat's participants are the people who may read it: not Tia, who waits (N6)");
    assert((await byId(ev, sam))?.eventPrivateNote === NOTE, 'the note is on the post for Sam now');
    assert((await say(ev, sam, 'See you there')).status === 201, 'and Sam can post');

    const back = await letIn(ev, hana, { memberPublicKey: sam.pubKeyHex, letIn: false });
    assert(back.status === 200 && letInAtOf(ev, sam) === null, 'the host takes it back');
    const afterBack = await chat(ev, sam);
    assert(afterBack.status === 403 && afterBack.body?.code === 'waiting_for_host' && !seat(ev, sam), 'Sam waits again, seat gone');

    await letIn(ev, hana, { memberPublicKey: sam.pubKeyHex });
    await rsvp(ev, sam, 'interested');
    const interested = await chat(ev, sam);
    assert(interested.status === 403 && interested.body?.error === FORBIDDEN && !interested.body?.code, 'Interested: the plain refusal, no waiting code');
    await rsvp(ev, sam, 'going');
    assert(letInAtOf(ev, sam) !== null && (await chat(ev, sam)).status === 200, 'Interested → Going keeps the let-in');
    await rsvp(ev, sam, null);
    await rsvp(ev, sam, 'going');
    assert(letInAtOf(ev, sam) === null && (await chat(ev, sam)).body?.code === 'waiting_for_host', 'Not going loses it: Going again waits');
    const generic = await call('GET', `/api/messages/${ev}`, sam);
    assert(generic.status === 403 && generic.body?.code === 'waiting_for_host' && generic.body?.error !== FORBIDDEN,
        `the generic messages route says they wait too, with the code (${JSON.stringify(generic.body)})`);

    const all = await letIn(ev, hana, { everyone: true });
    assert(all.status === 200 && all.body?.changed === 2 && letInAtOf(ev, sam) && letInAtOf(ev, tia), '"Let everyone in" lets in the two waiting');
    await rsvp(ev, uma, 'going');
    assert(letInAtOf(ev, uma) === null && (await chat(ev, uma)).body?.code === 'waiting_for_host', 'someone Going later still waits');

    // Unticked on edit: silent, everyone Going is in; ticked again: the ones not let in leave the chat.
    sent.length = 0;
    const untick = await call('POST', '/api/marketplace/posts/update', hana, { id: ev, authorPublicKey: hana.pubKeyHex, eventHostLetsIn: false });
    assert(untick.status === 200 && flagOf(ev) === 0, 'the host unticks it on edit');
    assert((await chat(ev, uma)).status === 200 && seat(ev, uma), 'everyone Going reads the chat now, with a seat');
    const state = (db.prepare('SELECT event_state FROM posts WHERE id = ?').get(ev) as any)?.event_state;
    assert(state === 'scheduled' && sent.length === 0, 'the edit sends no UPDATED and no push');
    const opened = ((await chat(ev, uma)).body?.messages ?? []).filter((m: any) => m.type === 'system');
    assert(opened.length === 1 && opened[0].ciphertext === EVENT_CHAT_OPENED_TEXT && opened[0].systemType === EVENT_CHAT_OPENED_SYSTEM_TYPE
        && opened[0].authorPubkey === 'SYSTEM' && EVENT_CHAT_OPENED_TEXT === 'The host opened this chat to everyone going.',
        `the chat says the host opened it to everyone going, one system line (${JSON.stringify(opened)})`);
    const removeOpened = await call('POST', `/api/marketplace/posts/${ev}/chat/remove`, hana, { messageId: opened[0]?.id });
    assert(removeOpened.status >= 400 && ((await chat(ev, uma)).body?.messages ?? []).some((m: any) => m.id === opened[0]?.id && m.type === 'system'),
        `the host can't remove that line (${removeOpened.status})`);
    await call('POST', '/api/marketplace/posts/update', hana, { id: ev, authorPublicKey: hana.pubKeyHex, eventHostLetsIn: true });
    assert(flagOf(ev) === 1 && !seat(ev, uma) && (await chat(ev, uma)).body?.code === 'waiting_for_host' && seat(ev, sam),
        'ticked again: Uma, not let in, waits and loses the seat; Sam keeps it');
    assert(((await chat(ev, sam)).body?.messages ?? []).filter((m: any) => m.type === 'system').length === 1, 'ticking again writes no line');

    // A group's event, to someone outside the group: as an id nobody has.
    const group = se.createGroup({ name: 'Quiet Circle', slug: 'quiet-circle-lets-in', description: 'Invite only', joinPolicy: 'invite_only', createdBy: hana.pubKeyHex });
    const gev = await makeEvent('Circle supper', { audienceScope: 'group', targetGroupId: group.id });
    const gid = gev.body?.post?.id ?? gev.body?.id;
    const outsider = await letIn(gid, omar, { memberPublicKey: sam.pubKeyHex });
    assert(!!gid && outsider.status === 404, `an outsider to a group's event gets 404 (${outsider.status})`);
    // N2: Tia and Uma are in the group and Going; Tia is removed from the group and keeps her Going row.
    for (const m of [tia, uma]) db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')").run(group.id, m.pubKeyHex);
    await rsvp(gid, tia, 'going');
    await rsvp(gid, uma, 'going');
    db.prepare("UPDATE group_members SET status = 'removed' WHERE group_id = ? AND member_pubkey = ?").run(group.id, tia.pubKeyHex);
    sent.length = 0;
    const removedOne = await letIn(gid, hana, { memberPublicKey: tia.pubKeyHex });
    assert(removedOne.status === 400 && /can't see this event/.test(removedOne.body?.error || '') && letInAtOf(gid, tia) === null,
        `a member removed from the group can't be let in (${removedOne.status} ${removedOne.body?.error})`);
    const groupAll = await letIn(gid, hana, { everyone: true });
    assert(groupAll.status === 200 && groupAll.body?.changed === 1 && letInAtOf(gid, uma) !== null && letInAtOf(gid, tia) === null,
        `"Let everyone in" lets in Uma, not Tia, who was removed (${groupAll.body?.changed})`);
    assert(sent.some(p => p.to === 'ExponentPushToken[Uma]') && !sent.some(p => p.to === 'ExponentPushToken[Tia]'),
        `Tia is not pushed the title of an event she can't see (${sent.map(p => p.to).join(', ')})`);

    // Ended and cancelled.
    db.prepare('UPDATE posts SET event_end_at = ? WHERE id = ?').run(new Date(Date.now() - HOUR).toISOString(), evOpen);
    db.prepare('UPDATE posts SET event_host_lets_in = 1 WHERE id = ?').run(evOpen);
    const ended = await letIn(evOpen, hana, { everyone: true });
    assert(ended.status === 410, `an ended event is 410 (${ended.status})`);
    const toCancel = (await makeEvent('Called off')).body;
    const cid = toCancel?.post?.id ?? toCancel?.id;
    await rsvp(cid, sam, 'going');
    await call('POST', '/api/marketplace/posts/remove', hana, { id: cid, authorPublicKey: hana.pubKeyHex });
    const cancelled = await letIn(cid, hana, { memberPublicKey: sam.pubKeyHex });
    assert(cancelled.status === 409, `a cancelled event is 409 (${cancelled.status})`);

    // The 30-day scrub takes the RSVPs, and the let-in with them.
    db.prepare('UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?').run(new Date(Date.now() - 40 * 24 * HOUR).toISOString(), new Date(Date.now() - 39 * 24 * HOUR).toISOString(), ev);
    scrubEndedEvents();
    assert(!db.prepare('SELECT 1 FROM event_rsvps WHERE post_id = ?').get(ev), 'the scrub deletes the RSVPs and their let-ins');

    // ── 3. The operator's override ──
    console.log('\n── 3. nodeProfile.openMembership = false on the global node ──');
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`${NODE_PROFILE_KEY}.openMembership`, 'false');
    const overridden = await makeEvent('Overridden');
    const oid = overridden.body?.post?.id ?? overridden.body?.id;
    assert(!!oid && flagOf(oid) === 0, 'a new event made with no choice does not wait');
    db.prepare('DELETE FROM node_config WHERE key = ?').run(`${NODE_PROFILE_KEY}.openMembership`);
    delete process.env.NODE_PROFILE;

    (globalThis as any).fetch = realFetch;
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
