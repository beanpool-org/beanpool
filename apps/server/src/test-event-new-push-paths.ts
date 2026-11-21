/**
 * The push "There is a new event in your community." (`event.new`, engine/event-new-push.ts, notifications NEa), closed as
 * a class: ONE table over every door an event comes through, or comes back through, by every kind of member, so that each
 * is told exactly once or not at all. Over REAL HTTPS through the real signature middleware where an app's door is a
 * route, on a local node as it ships.
 *
 * Why (PR #3323's first full run): two suites whose own setup posted an event for everyone counted the new push among the
 * pushes they were about. Neither was a wrong push, but nothing held the whole set of doors to "once". This does.
 *
 * Rows, the doors: the members' route both apps post through; an enterprise's route, a keeper posting; an owner's
 * assistant; a member's copy from another community; a group's own event; the same event sent again with its id (an app's
 * retry); an edit of a live event; a repeating event rolling to its next date; an event hidden by reports and put back;
 * a post on a standby. Rows that tell: the two routes, once each. Every other row: nobody.
 *
 * Columns, the members: its host (the keeper, for an enterprise's); a member; a member who has blocked the host; a member
 * on holiday (quiet); a member with Marketplace Activity off (the category the push rides: muted); a member with this
 * switch off; a member told of another new event an hour ago (the daily cap). Only "a member" is ever told.
 *
 * And the one door in code: `noticeNewEvent` is called from state-engine's createPost and nowhere else, so a row that
 * tells nobody because it never comes through createPost (an edit, a roll, a put-back, a sync or a federation copy, which
 * write the posts table themselves) goes red here the day someone calls it from there too.
 *
 * Run: via scripts/run-server-suites.mjs (SERVER_SUITES_ONLY=test-event-new-push-paths)
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setMemberPhoto } from '@beanpool/engine';
import { TEST_PHOTOS } from './post-test-helper.js';
import { localFetch } from './keepalive-test-fetch.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { Y27 } from './future-year-test-helper.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}
const show = (v: unknown) => JSON.stringify(v)?.slice(0, 400);
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const SERVER_SRC = path.dirname(fileURLToPath(import.meta.url));

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string };

async function main(): Promise<void> {
    console.log('\n=== event.new: every door x every kind of member, told exactly once or not at all ===\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { putPushTokenRow } = await import('./services/push-token-seal.js');
    const { addBlocks } = await import('./engine/member-blocks.js');
    const { rollDueSeries } = await import('./engine/event-series-roll.js');
    const { getNodeRole, setNodeRole } = await import('./config/node-role.js');

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

    const tokenOf = (name: string) => `ExponentPushToken[paths-${name}]`;
    function makeIdentity(name: string): Id {
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
        db.prepare(`INSERT OR IGNORE INTO members (public_key, callsign, status, joined_at, updated_at)
                    VALUES (?, ?, 'active', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
            .run(pubKeyHex, name, new Date(Date.now() - 60 * DAY).toISOString());
        setMemberPhoto(db, pubKeyHex, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pubKeyHex);
        putPushTokenRow(pubKeyHex, tokenOf(name), 'android');
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
        return { status: res.status, body: json, error: json?.error as string | undefined };
    }

    // ── The members: one of each kind (the columns) ───────────────────────────────────────────────────────────────────
    const host = makeIdentity('Hana');      // its host, and the keeper of the enterprise below
    const member = makeIdentity('Mel');     // a member: the only one ever told
    const blocker = makeIdentity('Bo');     // has blocked the host
    const quiet = makeIdentity('Qui');      // on holiday
    const muted = makeIdentity('Mut');      // Marketplace Activity off
    const off = makeIdentity('Off');        // this switch off
    const toldToday = makeIdentity('Tod');  // told of another new event an hour ago
    addBlocks(blocker.pubKeyHex, [host.pubKeyHex]);
    setPref(quiet.pubKeyHex, 'holiday_mode', 'true');
    setPref(muted.pubKeyHex, 'notify_marketplace', 'false');
    const turnedOff = await signed('POST', '/api/members/preferences', { publicKey: off.pubKeyHex, preferences: { notify_new_events: false } }, off);
    assert(turnedOff.status === 200, `set up: a member turns the switch off through the preferences route (${turnedOff.status} ${turnedOff.error ?? ''})`);
    const enterprise = se.createTreasury('Riverside Bakery', AVATAR, 0, { leadKeeperPubkey: host.pubKeyHex }).publicKey;
    se.reconcileLedgerFromDb();
    const columns = [
        { who: host, name: 'its host', told: false },
        { who: member, name: 'a member', told: true },
        { who: blocker, name: 'a member who blocked the host', told: false },
        { who: quiet, name: 'a member on holiday', told: false },
        { who: muted, name: 'a member with Marketplace Activity off', told: false },
        { who: off, name: 'a member with this switch off', told: false },
        { who: toldToday, name: 'a member told of a new event an hour ago', told: false },
    ];

    const stampKey = 'event_new_push.sentAt';
    /** Each row starts from the same day: nobody told today but `toldToday`, told an hour ago. */
    const freshDay = () => {
        db.prepare('DELETE FROM member_preferences WHERE pref_key = ?').run(stampKey);
        setPref(toldToday.pubKeyHex, stampKey, String(Math.floor(Date.now() / 1000) - 3600));
    };
    const mark = (): number => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM push_notices').get() as { m: number }).m;
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); await new Promise(r => setTimeout(r, 50)); };
    const eventBody = (title: string, extra: Record<string, unknown> = {}) => ({
        type: 'event', category: 'community', title, description: 'Words', lat: -28.6, lng: 153.5,
        eventStartAt: inHours(48), eventEndAt: inHours(50), eventPlaceName: 'Riverside Hall', photos: TEST_PHOTOS, ...extra,
    });
    const viaRoute = async (title: string, extra: Record<string, unknown> = {}): Promise<{ id: string | undefined; status: number; error?: string }> => {
        const r = await signed('POST', '/api/marketplace/posts', { ...eventBody(title, extra), authorPublicKey: host.pubKeyHex }, host);
        return { id: r.body?.post?.id ?? r.body?.id, status: r.status, error: r.error };
    };
    const engineOpts = { eventStartAt: inHours(30), eventEndAt: inHours(31), eventPlaceName: 'Riverside Hall' };
    const viaEngine = (title: string, opts: Record<string, unknown> = {}) =>
        se.createPost('event', 'community', title, '', 0, 'fixed', host.pubKeyHex, -28.6, 153.5, TEST_PHOTOS, false, undefined, undefined, { ...engineOpts, ...opts });
    /** A member holds at most five upcoming events (engine/posts.ts): each row's events go once the row is read. */
    const clearHostsEvents = () => db.prepare("UPDATE posts SET status = 'cancelled', active = 0 WHERE type = 'event' AND author_pubkey IN (?, ?)").run(host.pubKeyHex, enterprise);

    // ── The doors (the rows). `before` runs outside the count (it may itself tell: an edit needs a live event first). ──
    type Row = { door: string; tells: boolean; before?: () => Promise<unknown>; act: (made: any) => Promise<unknown> };
    const rows: Row[] = [
        {
            door: "the members' route both apps post through (POST /api/marketplace/posts)", tells: true,
            act: async () => { const r = await viaRoute('Hana hosts a seed swap'); if (!r.id) throw new Error(`no event: ${r.status} ${r.error}`); },
        },
        {
            door: "an enterprise's route, its keeper posting (POST /api/treasury/:treasury/event)", tells: true,
            act: async () => {
                const r = await signed('POST', `/api/treasury/${enterprise}/event`, eventBody('The bakery hosts a tasting'), host);
                if (r.status !== 200 && r.status !== 201) throw new Error(`no event: ${r.status} ${r.error}`);
            },
        },
        {
            door: "an owner's assistant (posts.created_via)", tells: false,
            act: async () => viaEngine('An assistant hosts', { createdVia: 'assistant:paths-grant' }),
        },
        {
            door: "a member's copy of another community's event (engine/event-copy.ts)", tells: false,
            act: async () => viaEngine('A copy from away', { shownCopy: { host: '', postId: null, price: null, takesQuestions: false } }),
        },
        {
            door: "a group's own event", tells: false,
            act: async () => {
                const crew = se.createGroup({ name: `Crew ${crypto.randomUUID().slice(0, 6)}`, joinPolicy: 'open', createdBy: host.pubKeyHex });
                for (const c of columns) if (c.who !== host) se.joinGroup(crew.id, c.who.pubKeyHex);
                return viaEngine('Crew only', { audienceScope: 'group', targetGroupId: crew.id });
            },
        },
        {
            door: "the same event sent again with its id (an app's retry)", tells: false,
            before: async () => {
                const id = crypto.randomUUID();
                const r = await viaRoute('Hana hosts a retry', { id });
                if (r.id !== id) throw new Error(`no event: ${r.status} ${r.error}`);
                return id;
            },
            act: async (id: string) => viaRoute('Hana hosts a retry', { id }),
        },
        {
            door: 'an edit of a live event (its title and its times)', tells: false,
            before: async () => viaEngine('Hana hosts a picnic')!.id,
            act: async (id: string) => se.updatePost(id, host.pubKeyHex, { title: 'Hana hosts a bigger picnic', eventStartAt: inHours(72), eventEndAt: inHours(74) } as any),
        },
        {
            door: 'a repeating event rolling to its next date (engine/event-series-roll.ts)', tells: false,
            before: async () => viaEngine('Hana hosts a weekly walk', {
                eventStartAt: undefined, eventEndAt: undefined,
                eventStartLocal: `${Y27}-10-01T08:00`, eventEndLocal: `${Y27}-10-01T09:00`, eventTz: 'Australia/Sydney',
                eventRepeat: { freq: 'weekly', interval: 1, byDay: 'FR' },
            })!.id,
            act: async (id: string) => {
                const was = (db.prepare('SELECT event_start_at FROM posts WHERE id = ?').get(id) as { event_start_at: string }).event_start_at;
                rollDueSeries(undefined, Date.parse(`${Y27}-10-02T00:00:00.000Z`));
                const now = (db.prepare('SELECT event_start_at FROM posts WHERE id = ?').get(id) as { event_start_at: string }).event_start_at;
                if (!(now > was)) throw new Error(`the series did not roll (${was} → ${now})`);
            },
        },
        {
            door: 'an event hidden by reports and put back', tells: false,
            before: async () => {
                const id = viaEngine('Hana hosts a swap meet')!.id;
                db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), id);
                return id;
            },
            act: async (id: string) => {
                const r = se.restoreHiddenPost(id);
                if (r !== 'restored') throw new Error(`not put back: ${r}`);
            },
        },
        {
            door: 'a post on a standby (node role backup)', tells: false,
            act: async () => {
                const was = getNodeRole();
                setNodeRole('backup');
                try { return viaEngine('Posted on a standby'); } finally { setNodeRole(was); }
            },
        },
    ];

    for (const row of rows) {
        const made = row.before ? await row.before() : undefined;
        await settle();
        freshDay();
        const since = mark();
        expo.length = 0;
        let failed: string | null = null;
        try { await row.act(made); } catch (e: any) { failed = e?.message ?? String(e); }
        await settle();
        assert(failed === null, `${row.door}: the door works (${failed ?? 'ok'})`);
        const notices = (db.prepare("SELECT recipient FROM push_notices WHERE kind = 'event.new' AND rowid > ?").all(since) as { recipient: string }[]).map(r => r.recipient);
        const cells: string[] = [];
        let rowRight = true;
        for (const c of columns) {
            const want = row.tells && c.told ? 1 : 0;
            const kept = notices.filter(pk => pk === c.who.pubKeyHex).length;
            // Only this push: a door may rightly send another of its own (putting a post back tells its author so).
            const phone = expo.filter(m => m?.to === tokenOf(c.who.name) && m?.data?.k === 'event.new');
            const right = kept === want && phone.length === want;
            if (!right) rowRight = false;
            cells.push(`${c.name}: ${kept} kept, ${phone.length} to the phone${right ? '' : ` (want ${want})`}`);
        }
        // The day's cap is stamped on exactly those told: a stamp on anyone else would keep the next event from them, for
        // nothing (the dispatcher's own filters may still keep the push away, so the stamp is the only trace of such a slip).
        const stamped = (db.prepare('SELECT public_key AS pk, pref_value AS v FROM member_preferences WHERE pref_key = ?').all(stampKey) as { pk: string; v: string }[])
            .filter(r => r.pk !== toldToday.pubKeyHex || Number(r.v) > Math.floor(Date.now() / 1000) - 3000)
            .map(r => columns.find(c => c.who.pubKeyHex === r.pk)?.name ?? r.pk.slice(0, 6)).sort();
        const toldNames = columns.filter(c => row.tells && c.told).map(c => c.name).sort();
        assert(show(stamped) === show(toldNames), `${row.door}: the day's cap is stamped on exactly those told (${show(stamped)})`);
        const strangers = notices.filter(pk => !columns.some(c => c.who.pubKeyHex === pk));
        assert(rowRight && strangers.length === 0,
            `${row.door}: ${row.tells ? 'a member is told exactly once, and nobody else' : 'nobody is told'} (${cells.join('; ')}${strangers.length ? `; ${strangers.length} others` : ''})`);
        // A standby writes no stamp either: a promoted standby's members are not owed a day of silence.
        if (row.door.startsWith('a post on a standby')) {
            const stamped = (db.prepare('SELECT COUNT(*) AS n FROM member_preferences WHERE pref_key = ? AND public_key != ?').get(stampKey, toldToday.pubKeyHex) as { n: number }).n;
            assert(stamped === 0, `a post on a standby stamps nobody (${stamped})`);
        }
        clearHostsEvents();
    }

    // ── The one door in code ──────────────────────────────────────────────────────────────────────────────────────────
    const callers: string[] = [];
    for (const file of fs.readdirSync(SERVER_SRC, { recursive: true }) as string[]) {
        if (!file.endsWith('.ts') || /(^|\/)test-|__tests__|-test-|\.test\./.test(file)) continue;
        const src = fs.readFileSync(path.join(SERVER_SRC, file), 'utf8');
        for (const m of src.matchAll(/\bnoticeNewEvent\s*\(/g)) {
            const before = src.slice(0, m.index);
            if (/export function\s*$/.test(before)) continue; // its own definition
            const fn = [...before.matchAll(/export function (\w+)\s*\(/g)].at(-1)?.[1] ?? '?';
            callers.push(`${file}:${fn}`);
        }
    }
    assert(show(callers) === show(['state-engine.ts:createPost']),
        `noticeNewEvent is called from state-engine's createPost alone: an edit, a roll, a put-back, a sync or a federation copy never tells (${show(callers)})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
