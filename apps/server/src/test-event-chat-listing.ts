/**
 * An event's chat in the chat list (Marty, 16 Nov 2026: "yes only when someone posts and only if you are going or
 * interested"): listed, on both apps and under every chip, only once someone has posted a line in it AND the member is one
 * of its readers (the host, or Going and let in: engine/event-thread.ts canReadEventThread). Its unread lines count towards
 * a badge only while it is listed. Group, enterprise and direct chats are unchanged.
 *
 * Interested: the chat is the host's and Going's alone (docs/events-on-the-map.md decision 17; its notice says "Visible to
 * the host, everyone going, and this node's operator"), so an Interested member can't open it and it is never in their list.
 * Widening that is a privacy call this slice does not make.
 *
 * Every row goes through the real middleware: GET /api/messages/conversations/:pk (the web's Messages list and its chips),
 * GET /api/your-groups (the phone's Talk → Groups, the web's Projects → Yours), GET /api/me/unread (both apps' badge, and
 * the count every push carries).
 *
 * The table: (no line / a line someone posted / a system line only) × (host, going, interested, not going), then the RSVP
 * changes: Interested → Going → Interested → Going → not going, and a first line arriving while Going.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH', 'ENFORCE_LEDGER_AUTH', 'NODE_PROFILE', 'PRIVATE_PREVIEW']) delete process.env[k];
if (process.env.READ_AUTH === 'off') process.env.ENFORCE_READ_AUTH = 'false';
process.env.DISABLE_UPDATE_CHECK = 'true';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';

let run = 0, passed = 0;
const fails: string[] = [];
function check(id: string, cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ [${id}] ${msg}`); } else { fails.push(id); console.error(`✗ [${id}] ${msg}`); }
}
let BASE = '';
const DAY = 86400_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = { method, path: p.split('?')[0], timestamp: ts, nonce, body };
    return { 'X-Public-Key': id.pk, [SIGNED_FOR_HEADER]: signedForHost(), 'X-Signature': signRequest(id.privateKey, canonical), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
}
let beforeCall: () => void = () => {};
async function req(method: string, p: string, id?: Id, body?: any): Promise<{ status: number; body: any }> {
    beforeCall();
    const s = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = id ? signedHeaders(method, p, s, id) : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : s });
    const t = await res.text(); let json: any; try { json = JSON.parse(t); } catch { json = t; }
    return { status: res.status, body: json };
}

type Role = 'host' | 'going' | 'interested' | 'not going';
type Lines = 'no line' | 'a posted line' | 'a system line only';

async function main(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { resetChatRateLimit } = await import('./chat-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); resetChatRateLimit(); };
    await initTls(); se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    console.log(`read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'OFF' : 'ON'}`);
    let n = 0;
    const member = (callsign: string): Id => {
        const id = newId();
        n++;
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`).run(id.pk, `${callsign}${n}`, new Date(Date.now() - 60 * DAY).toISOString(), `INV-LST-${n}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };
    const newEvent = async (host: Id, title: string): Promise<string> => {
        const ev = await req('POST', '/api/marketplace/posts', host, { type: 'event', title, description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), photos: [TINY_PNG] });
        const id = ev.body?.post?.id;
        if (!id) throw new Error(`event not made: ${ev.status} ${JSON.stringify(ev.body).slice(0, 160)}`);
        return id;
    };
    const rsvp = async (id: string, who: Id, status: 'going' | 'interested' | null) => {
        const r = await req('POST', `/api/marketplace/posts/${id}/rsvp`, who, { status });
        if (r.status !== 200) throw new Error(`rsvp ${status} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    };
    const post = async (id: string, who: Id, text: string) => {
        const r = await req('POST', `/api/marketplace/posts/${id}/chat/message`, who, { text });
        if (r.status !== 200 && r.status !== 201) throw new Error(`line → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    };
    /** A system line as the node writes one (engine/event-thread.ts writeEventOpenedLine): no person posted it. */
    const systemLine = (id: string) => {
        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, system_type, metadata, timestamp)
                    VALUES (?, ?, 'SYSTEM', ?, '00000', 'system', 'event_opened_to_going', ?, ?)`)
            .run(crypto.randomUUID(), id, 'The host opened this chat to everyone going.', JSON.stringify({ postId: id }), new Date().toISOString());
    };

    /** Where the event's chat shows for `who`: each list, and the badge's count. */
    const seen = async (id: string, who: Id) => {
        const convs = await req('GET', `/api/messages/conversations/${who.pk}`, who);
        const c = (convs.body?.conversations ?? []).find((x: any) => x.id === id);
        const yours = await req('GET', '/api/your-groups', who);
        const y = (yours.body?.items ?? []).find((x: any) => x.conversationId === id);
        const unread = await req('GET', '/api/me/unread', who);
        const listedTotal = (convs.body?.conversations ?? []).reduce((s: number, x: any) => s + (x.unreadCount || 0), 0);
        return {
            ok: convs.status === 200 && yours.status === 200 && unread.status === 200,
            inMessages: !!c,
            inGroups: !!y,
            unreadHere: (c?.unreadCount ?? 0) + (y?.unreadCount ?? 0),
            totalUnread: convs.body?.totalUnread ?? -1,
            listedTotal,
            groupsTotal: yours.body?.totalUnread ?? -1,
            badge: unread.body?.unread ?? -1,
            status: `${convs.status}/${yours.status}/${unread.status}`,
        };
    };
    const say = (s: Awaited<ReturnType<typeof seen>>) =>
        `Messages ${s.inMessages ? 'listed' : 'not'}, Groups ${s.inGroups ? 'listed' : 'not'}, unread ${s.unreadHere}, totalUnread ${s.totalUnread}, Groups total ${s.groupsTotal}, badge ${s.badge} (${s.status})`;
    const expectListed = (tag: string, s: Awaited<ReturnType<typeof seen>>, listed: boolean, unread: number, what: string) => {
        check(tag, s.ok && s.inMessages === listed && s.inGroups === listed, `${what}: ${listed ? 'listed' : 'not listed'} in both lists (${say(s)})`);
        // The badge and both lists' totals hold only what the lists show: the member's other chats have no lines, so any
        // number here is this event's.
        check(`${tag}-badge`, s.ok && s.badge === unread && s.totalUnread === unread && s.listedTotal === unread && s.groupsTotal === unread,
            `${what}: badge ${unread} on every count, never from a chat that isn't listed (${say(s)})`);
    };

    // ── The table: lines × role ──
    const LINES: Lines[] = ['no line', 'a posted line', 'a system line only'];
    const ROLES: Role[] = ['host', 'going', 'interested', 'not going'];
    for (const lines of LINES) {
        for (const role of ROLES) {
            const host = member('LstHost'), poster = member('LstPoster'), me = member('LstMe');
            const id = await newEvent(host, `Lst ${lines} ${role}`);
            await rsvp(id, poster, 'going');
            if (role === 'going' || role === 'interested') await rsvp(id, me, role);
            if (lines === 'a posted line') await post(id, poster, 'Who is bringing chairs?');
            if (lines === 'a system line only') systemLine(id);
            const who = role === 'host' ? host : me;
            const listed = lines === 'a posted line' && (role === 'host' || role === 'going');
            expectListed(`T ${lines} / ${role}`, await seen(id, who), listed, listed ? 1 : 0, `${lines}, ${role}`);
        }
    }

    // ── RSVP changes on a chat that already has a line ──
    {
        const host = member('LstChHost'), poster = member('LstChPoster'), me = member('LstChMe');
        const id = await newEvent(host, 'Lst changes');
        await rsvp(id, poster, 'going');
        await post(id, poster, 'See you there');
        await rsvp(id, me, 'interested');
        expectListed('R1', await seen(id, me), false, 0, 'Interested in an event whose chat has a line');
        await rsvp(id, me, 'going');
        expectListed('R2', await seen(id, me), true, 1, 'then Going');
        await rsvp(id, me, 'interested');
        expectListed('R3', await seen(id, me), false, 0, 'then Interested again');
        await rsvp(id, me, 'going');
        expectListed('R4', await seen(id, me), true, 1, 'Going once more');
        await rsvp(id, me, null);
        expectListed('R5', await seen(id, me), false, 0, 'then Not going');
        const chat = await req('GET', `/api/marketplace/posts/${id}/chat`, host);
        check('R5-control', chat.status === 200, `the host still opens the chat from the event (got ${chat.status})`);
    }

    // ── Going, and the first line arrives ──
    {
        const host = member('LstFirstHost'), me = member('LstFirstMe');
        const id = await newEvent(host, 'Lst first line');
        await rsvp(id, me, 'going');
        expectListed('F1', await seen(id, me), false, 0, 'Going, nobody has posted yet');
        expectListed('F1-host', await seen(id, host), false, 0, 'the host, nobody has posted yet');
        const open = await req('GET', `/api/marketplace/posts/${id}/chat`, me);
        check('F1-control', open.status === 200, `…and the chat still opens from the event (got ${open.status})`);
        await post(id, host, 'Gate code is on the note');
        expectListed('F2', await seen(id, me), true, 1, 'the host posts the first line');
        expectListed('F2-host', await seen(id, host), true, 0, 'the host, after their own first line (no badge from their own line)');
    }

    // ── Where the host lets people in: Going and waiting is not a reader ──
    {
        const host = member('LstLetHost'), poster = member('LstLetPoster'), me = member('LstLetMe');
        const id = await newEvent(host, 'Lst let in');
        db.prepare('UPDATE posts SET event_host_lets_in = 1 WHERE id = ?').run(id);
        await post(id, host, 'Welcome');
        await rsvp(id, poster, 'going');
        await rsvp(id, me, 'going');
        expectListed('L1', await seen(id, me), false, 0, 'Going, waiting for the host to let them in');
    }

    // ── Other chats unchanged: a direct chat with no line stays listed ──
    {
        const a = member('LstDmA'), b = member('LstDmB');
        const made = await req('POST', '/api/messages/conversation', a, { type: 'dm', participants: [a.pk, b.pk], createdBy: a.pk });
        const convId = made.body?.conversation?.id ?? made.body?.id;
        const list = await req('GET', `/api/messages/conversations/${a.pk}`, a);
        check('D1', made.status === 200 && !!(list.body?.conversations ?? []).find((x: any) => x.id === convId),
            `a direct chat with no line is listed as before (made ${made.status}, listed ${!!(list.body?.conversations ?? []).find((x: any) => x.id === convId)})`);
    }

    console.log(`\n${passed}/${run} passed; failing: ${[...new Set(fails)].join(' | ') || 'none'}`);
    process.exit(fails.length ? 1 : 0);
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 280_000).unref();
main().catch(e => { console.error('DRIVER ERROR', e); process.exit(3); });
