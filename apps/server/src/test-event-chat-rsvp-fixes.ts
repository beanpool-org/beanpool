/**
 * Event chat participants, cancelled/ended RSVP withdrawal, series roll window, and year bounds (E1, E3, E5, M5).
 * Failing-first checks from verify-audit-photos-events.md.
 *
 * 1. E1: GET /api/messages/:id and GET /api/messages/conversations/:pk filter event chat participants
 *    (canReadEventThread), leaving out former group members who left or were removed.
 * 2. E3: "Not going" (status: null) is allowed on cancelled and ended events so a member can withdraw.
 * 3. E5: A repeating series is rolled if due before an edit and before an RSVP in the window between end and minute roll.
 * 4. M5: Event times are bounded to year <= 9999; parseEventTime refuses year 10000+.
 *
 * Run: BEANPOOL_SUITE_ENV_PASSWORD=1 BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx apps/server/src/test-event-chat-rsvp-fixes.ts
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
for (const k of ['CF_RECORD_NAME', 'CF_API_TOKEN', 'CF_ZONE_ID', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH', 'ENFORCE_LEDGER_AUTH', 'NODE_PROFILE', 'PRIVATE_PREVIEW']) delete process.env[k];
if (process.env.READ_AUTH === 'off') process.env.ENFORCE_READ_AUTH = 'false';
process.env.DISABLE_UPDATE_CHECK = 'true';

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';

let run = 0, passed = 0;
const fails: string[] = [];
function check(id: string, cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ [${id}] ${msg}`); } else { fails.push(id); console.error(`✗ [${id}] ${msg}`); }
}
let BASE = '';
const DAY = 86400_000, HOUR = 3600_000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
type Id = { pk: string; privateKey: crypto.KeyObject };
function newId(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
}
function signedHeaders(method: string, p: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${p.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return { 'X-Public-Key': id.pk, 'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'), 'X-Timestamp': String(ts), 'X-Nonce': nonce };
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

async function main(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    beforeCall = () => { resetGatewayRateLimit(); pruneAuthAttempts(Date.now() + 120_000); };
    await initTls(); se.initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;
    console.log(`read auth ${process.env.ENFORCE_READ_AUTH === 'false' ? 'OFF' : 'ON'}`);
    const member = (callsign: string): Id => {
        const id = newId();
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'seed', ?)`).run(id.pk, callsign, new Date(Date.now() - 60 * DAY).toISOString(), `INV-${callsign.toUpperCase()}`);
        setMemberPhoto(db, id.pk, TINY_PNG);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
        return id;
    };

    // ── E1: an event chat's participants, the same on every route ──
    {
        const host = member('FfHost'), eve = member('FfEve'), gus = member('FfGus');
        const g = se.createGroup({ name: 'Ff club', createdBy: host.pk, joinPolicy: 'invite_only' } as any);
        for (const m of [eve, gus]) db.prepare("INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, 'member', 'active')").run(g.id, m.pk);
        const ev = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff bee', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), audienceScope: 'group', targetGroupId: g.id });
        const id = ev.body?.post?.id;
        await req('POST', `/api/marketplace/posts/${id}/rsvp`, eve, { status: 'going' });
        await req('POST', `/api/marketplace/posts/${id}/rsvp`, gus, { status: 'going' });
        se.removeGroupMember(g.id, eve.pk, eve.pk);
        const one = await req('GET', `/api/messages/${id}`, gus);
        check('E1', one.status === 200 && !one.body?.conversation?.participants?.includes(eve.pk), `GET /api/messages/:id as Gus leaves out Eve, who left the group (got ${JSON.stringify(one.body?.conversation?.participants?.map((p: string) => p === eve.pk ? 'EVE' : p.slice(0, 4)))})`);
        for (const who of [gus, host]) {
            const list = await req('GET', `/api/messages/conversations/${who.pk}`, who);
            const c = (list.body?.conversations ?? []).find((x: any) => x.id === id);
            check('E1', !!c && !c.participants.includes(eve.pk), `the conversations list of ${who === gus ? 'Gus' : 'the host'} leaves her out too (got ${c ? c.participants.includes(eve.pk) : 'not listed'})`);
        }
        const chat = await req('GET', `/api/marketplace/posts/${id}/chat`, gus);
        check('E1-control', chat.status === 200 && !chat.body?.conversation?.participants?.includes(eve.pk) && chat.body?.conversation?.participants?.includes(gus.pk), 'the event chat route already does');
    }

    // ── E3: Not going, on a cancelled or ended event ──
    {
        const host = member('FfWdHost'), grace = member('FfGrace'), hal = member('FfHal');
        const ev = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff far', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + 300 * DAY).toISOString() });
        const id = ev.body?.post?.id;
        await req('POST', `/api/marketplace/posts/${id}/rsvp`, grace, { status: 'going' });
        await req('POST', '/api/marketplace/posts/remove', host, { id, authorPublicKey: host.pk });
        const wd = await req('POST', `/api/marketplace/posts/${id}/rsvp`, grace, { status: null });
        const left = db.prepare('SELECT 1 FROM event_rsvps WHERE post_id=? AND member_pubkey=?').get(id, grace.pk);
        const seat = db.prepare('SELECT 1 FROM conversation_participants WHERE conversation_id=? AND public_key=?').get(id, grace.pk);
        const tomb = db.prepare("SELECT 1 FROM tombstones WHERE table_name='event_rsvps' AND row_key=?").get(`${id}|${grace.pk}`);
        check('E3', wd.status === 200 && !left && !seat && !!tomb, `Grace takes her name off a cancelled event → 200, row and chat seat gone, tombstone written (got ${wd.status} ${JSON.stringify(wd.body).slice(0, 80)}, row ${!!left}, seat ${!!seat}, tomb ${!!tomb})`);
        const back = await req('POST', `/api/marketplace/posts/${id}/rsvp`, grace, { status: 'going' });
        check('E3-control', back.status === 400, `…but can't say Going to it again (got ${back.status})`);
        const ev2 = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff past', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: new Date(Date.now() + DAY).toISOString() });
        const id2 = ev2.body?.post?.id;
        await req('POST', `/api/marketplace/posts/${id2}/rsvp`, hal, { status: 'going' });
        db.prepare('UPDATE posts SET event_start_at=?, event_end_at=? WHERE id=?').run(new Date(Date.now() - 3 * HOUR).toISOString(), new Date(Date.now() - HOUR).toISOString(), id2);
        const wd2 = await req('POST', `/api/marketplace/posts/${id2}/rsvp`, hal, { status: null });
        check('E3', wd2.status === 200, `Hal takes his name off an ended event → 200 (got ${wd2.status} ${JSON.stringify(wd2.body).slice(0, 80)})`);
        const back2 = await req('POST', `/api/marketplace/posts/${id2}/rsvp`, hal, { status: 'interested' });
        check('E3-control', back2.status === 400, `…but can't mark it Interested again (got ${back2.status})`);
    }

    // ── E5: a series between its date's end and the minute roll ──
    {
        const host = member('FfRlHost'), ivy = member('FfIvy');
        const now = new Date();
        const daysToSat = ((6 - now.getUTCDay()) + 7) % 7 || 7;
        const sat = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToSat));
        const ymd = sat.toISOString().slice(0, 10), prev = new Date(sat.getTime() - 7 * DAY).toISOString().slice(0, 10);
        const s = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff weekly', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartLocal: `${ymd}T18:00`, eventEndLocal: `${ymd}T19:00`, eventTz: 'Australia/Brisbane', eventRepeat: { freq: 'weekly', interval: 1, byDay: 'SA' } });
        const id = s.body?.post?.id;
        const endMs = Date.now() - 20_000;
        db.prepare('UPDATE posts SET event_start_at=?, event_end_at=?, event_start_local=?, event_end_local=? WHERE id=?').run(new Date(endMs - HOUR).toISOString(), new Date(endMs).toISOString(), `${prev}T18:00`, `${prev}T19:00`, id);
        const e = await req('POST', '/api/marketplace/posts/update', host, { id, authorPublicKey: host.pk, description: 'Changed' });
        check('E5', e.status === 200, `the host edits a weekly series 20 s after a date ended, before the minute roll → 200 (got ${e.status} ${JSON.stringify(e.body).slice(0, 80)})`);
        const r = await req('POST', `/api/marketplace/posts/${id}/rsvp`, ivy, { status: 'going' });
        const stamped = db.prepare('SELECT occurrence_at FROM event_rsvps WHERE post_id=? AND member_pubkey=?').get(id, ivy.pk) as any;
        const cur = db.prepare('SELECT event_start_at, event_start_local FROM posts WHERE id=?').get(id) as any;
        check('E5', r.status === 200 && stamped?.occurrence_at === cur.event_start_at && cur.event_start_local.startsWith(ymd), `Ivy says Going in the same window → 200, for the NEXT date (${ymd}) (got ${r.status}, stamped ${stamped?.occurrence_at}, current ${cur.event_start_local})`);
    }

    // ── M5: a start past year 9999 ──
    {
        const host = member('FfFar');
        const r = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff 10000', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: '+010000-01-01T10:00:00.000Z' });
        check('M5', r.status === 400, `a start in year 10000 (stored as "+010000-…", which sorts before every real date) → 400 (got ${r.status})`);
        const ok = await req('POST', '/api/marketplace/posts', host, { type: 'event', title: 'Ff 9999', description: 'x', authorPublicKey: host.pk, lat: -28.55, lng: 153.5, eventStartAt: '9999-12-31T10:00:00.000Z' });
        check('M5-control', ok.status === 200, `9999-12-31 stays allowed (No far-future limit, docs/events-on-the-map.md) (got ${ok.status})`);
    }

    console.log(`\n${passed}/${run} passed; failing: ${[...new Set(fails)].join(' ') || 'none'}`);
    process.exit(fails.length ? 1 : 0);
}
setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 300_000).unref();
main().catch(e => { console.error('DRIVER ERROR', e); process.exit(3); });
