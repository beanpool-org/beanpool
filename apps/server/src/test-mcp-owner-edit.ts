/**
 * MCP-UPDATE-ALL (Damo via Marty, 2 Nov: "The MCP update_post command should ideally be able to do everything a human could
 * change instead of having to recreate the entire event"): update_post changes what a person's edit changes, through the
 * route's own updatePost. End to end with the official TypeScript MCP SDK client over REAL HTTPS through the real Koa
 * middleware; nothing here contacts anything but the server it starts.
 *
 *   1. The tool's words and schema name every field; my_posts reads back what update_post can change.
 *   2. A listing moves: the pin rounded as a create's, the id kept; found by distance at the new place and no longer at the old.
 *   3. A place the rules refuse: out of range, half a pin, null, nothing written.
 *   4. An event moves: the same id, its RSVPs and its reminder marks; UPDATED, a push to those going, the socket; the community's
 *      places follow; a title edit stays silent.
 *   5. An event's times, zone, end, repeat, online, link, note and who it lets in, each with the engine's own refusals.
 *   6. A listing's terms, shop and lending, each with its refusals.
 *   7. A field on the wrong kind is refused in words, never dropped.
 *   8. Someone else's post, and a grant not ticked "May post for me".
 *   9. A copy: pulled from another community, refused; a member's copy, held to the times and a rounded pin.
 *  10. A live deal holds the price and lets the place move; a paused, a removed, a cancelled and an ended post are refused.
 *  11. The search fields follow, created_via stands, and the day's edits are the most: nothing past them is written.
 *  12. The ledger audit is the same after as before: no Bean moved.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-edit TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setMemberPhoto, clearEnterpriseFloorCache } from '@beanpool/engine';
import { initTls } from './services/tls.js';
import {
    acceptPost, addWsClient, createPost, getPosts, initStateEngine, registerPushToken, removePost, rsvpEvent, runLedgerAudit, seedGenesisMember,
} from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { setMemberArea } from './engine/member-area.js';
import { EVENT_UPDATED_PUSH_TITLE, PRICE_FROZEN_ERROR } from './engine/posts.js';
import { openShop } from './engine/shops.js';
import { toldPush } from './push-notice-test-harness.js';
import { db } from './db/db.js';
import { admitAgentEdit, resetAgentLimits } from './agent/limits.js';
import { enterpriseRef } from './agent/owner-posts.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
function section(title: string): void { console.log(`\n${title}`); }

interface Key { pub: string }
const keypair = (): Key => ({ pub: crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') });

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const settle = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
const row = (id: string): any => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
const fenced = (v: any): string => v?.text ?? '';

async function jpeg(width: number, height: number): Promise<string> {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: 180, g: 120, b: 60 } } }).jpeg({ quality: 80 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

// Every push the node sends is answered here in place of Expo and never sent on, and kept for the checks below.
const pushed: Array<{ to: string; title: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && url.startsWith('https://exp.host/')) {
        for (const m of JSON.parse(String(init?.body ?? '[]'))) pushed.push({ to: m.to, title: toldPush(db, m).title });
        return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
    console.log('\n=== update_post changes what a person\'s edit changes (MCP-UPDATE-ALL) ===');
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-edit-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair(), mia = keypair(), noah = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner.pub);
    setMemberPhoto(db, owner.pub, AVATAR);
    const addMember = (k: Key, callsign: string) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                    VALUES (?, ?, 'active', ?, ?, 'inv-test')`).run(k.pub, callsign, longAgo, owner.pub);
        db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(k.pub);
        setMemberPhoto(db, k.pub, AVATAR);
    };
    addMember(mia, 'Mia Neighbour');
    addMember(noah, 'Noah Neighbour');
    const bakery = keypair().pub;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, 'Olive Bakery Co-op', ?, ?, 'inv-test', 'active', 1)`).run(bakery, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(bakery);
    setMemberPhoto(db, bakery, AVATAR);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bakery, owner.pub);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(owner.pub);
    clearEnterpriseFloorCache(db);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const auditBefore = runLedgerAudit();

    try {
        resetAdminAuthTarpit();
        const makeGrant = async (name: string, canPost: boolean) => {
            const r = await realFetch(`${BASE}/api/local/admin/agent/grants`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerPhoneSessionHeaders(owner.pub) }, body: JSON.stringify({ name, canPost }),
            });
            const body = await r.json() as any;
            return { token: body?.token as string, id: body?.grant?.id as string };
        };
        const A = await makeGrant('Olive\'s Claude', true);
        const B = await makeGrant('Olive\'s other helper', true);
        const R = await makeGrant('Olive\'s reader', false);
        const a = await connect(A.token), b = await connect(B.token), reader = await connect(R.token);
        // The door takes 60 calls a minute, and this suite makes far more: each stretch of 30 starts it again (the day's edits too, until 11).
        let calls = 0;
        const breathe = () => { if (++calls % 30 === 0) resetAgentLimits(); };
        const edit = (args: Record<string, unknown>) => { breathe(); return a.callTool({ name: 'update_post', arguments: args }); };
        const photo = await jpeg(640, 480);
        const listing = (title: string) => ({ title, description: 'Seeded for the community.', category: 'food', beans: 3, lat: -28.55, lng: 153.5, photos: [photo] });
        const inDays = (n: number): string => new Date(Date.now() + n * DAY).toISOString();
        const event = (title: string, extra: Record<string, unknown> = {}) => ({
            title, description: 'Bring gloves.', start_at: inDays(5), end_at: new Date(Date.now() + 5 * DAY + 2 * 3_600_000).toISOString(),
            timezone: 'Australia/Brisbane', place_name: 'The old bowls club', lat: -28.55, lng: 153.5, photos: [photo], ...extra,
        });
        const made = async (tool: string, args: Record<string, unknown>, client: Client = a): Promise<string> => {
            breathe();
            const r = await client.callTool({ name: tool, arguments: args });
            if (r.isError) throw new Error(`${tool} refused: ${errorText(r)}`);
            return structured(r).postId as string;
        };

        // ── 1. The words ─────────────────────────────────────────────────────────────────────────────
        section('── 1. The tool says what it takes ──');
        const tools = (await a.listTools()).tools;
        const update = tools.find((t) => t.name === 'update_post')!;
        const props = Object.keys((update.inputSchema as any).properties ?? {});
        const EVERY_FIELD = ['title', 'description', 'category', 'beans', 'price_type', 'lat', 'lng', 'use_my_area', 'repeatable', 'cash_also_needed', 'shop_id', 'lendable',
            'lend_max_days', 'lend_terms', 'replacement_value', 'start_at', 'end_at', 'timezone', 'place_name', 'online', 'link', 'private_note', 'host_lets_in', 'repeat',
            'repeat_until', 'tags', 'free_tags', 'photo_urls', 'photo_ids', 'photos'];
        assert(EVERY_FIELD.every((f) => props.includes(f)), `update_post's schema names every field (missing: ${EVERY_FIELD.filter((f) => !props.includes(f)).join(', ') || 'none'})`);
        const updateWords = update.description ?? '';
        assert(/keeps its id/.test(updateWords) && /never by removing it/.test(updateWords) && /RSVPs/.test(updateWords) && /refused in words/.test(updateWords) && /never moves Beans/.test(updateWords),
            `update_post's words tell an assistant to move a pin here, and what it keeps (${updateWords.slice(0, 120)}…)`);
        assert(/what update_post can change/.test(tools.find((t) => t.name === 'my_posts')?.description ?? ''), 'my_posts says it reads what update_post can change');
        assert(/on an Offer its shop and lending/.test(updateWords) && !/Need its [^;]*shop/.test(updateWords), 'its words give a shop and lending to an Offer, never a Need');

        // ── 2. A listing moves ───────────────────────────────────────────────────────────────────────
        section('── 2. A listing moves ──');
        const OLD = { lat: -28.55, lng: 153.5 };
        const offerId = await made('create_offer', listing('Lemons from the tree'));
        const moved = await edit({ post_id: offerId, lat: -38.123456, lng: 145.987654 });
        assert(!moved.isError && structured(moved)?.postId === offerId && row(offerId)?.lat === -38.123 && row(offerId)?.lng === 145.988
            && structured(moved)?.lat === -38.123 && structured(moved)?.lng === 145.988,
            `the pin moves, rounded to 100 m as the apps round it, and the answer says where it stands (${errorText(moved) || JSON.stringify(structured(moved))})`);
        assert(JSON.stringify(structured(moved)?.changed) === JSON.stringify(['lat', 'lng']) && row(offerId)?.title === 'Lemons from the tree' && row(offerId)?.credits === 3,
            `only the fields sent change (${JSON.stringify(structured(moved)?.changed)})`);
        const near = (at: { lat: number; lng: number }) => getPosts({ near: { ...at, radiusKm: 5 }, viewerPubkey: mia.pub } as any).map((p) => p.id);
        assert(near({ lat: -38.123, lng: 145.988 }).includes(offerId) && !near(OLD).includes(offerId), 'the old place does not linger: found by distance at the new place, gone from the old');

        setMemberArea(owner.pub, { lat: -28.64312, lng: 153.61274 });
        const toArea = await edit({ post_id: offerId, use_my_area: true });
        assert(!toArea.isError && row(offerId)?.lat === -28.6 && row(offerId)?.lng === 153.6, `use_my_area puts it at the owner's own area, as a create does (${errorText(toArea) || `${row(offerId)?.lat},${row(offerId)?.lng}`})`);
        const both = await edit({ post_id: offerId, use_my_area: true, lat: 1, lng: 2 });
        assert(both.isError === true && /not both/.test(errorText(both)), `use_my_area with a pin → refused in words (${errorText(both)})`);
        const areaOff = await edit({ post_id: offerId, use_my_area: false, title: 'Lemons, Meyer' });
        assert(!areaOff.isError && !structured(areaOff)?.changed.includes('use_my_area'), 'use_my_area: false changes nothing and is not said to have');

        // ── 3. A place the rules refuse ──────────────────────────────────────────────────────────────
        section('── 3. A place the rules refuse ──');
        const before = { lat: row(offerId)?.lat, lng: row(offerId)?.lng };
        for (const [what, args, says] of [
            ['a latitude past the pole', { lat: 95, lng: 153 }, /Latitude must be a number from -90 to 90/],
            ['a longitude past the line', { lat: -28, lng: 181 }, /Longitude must be a number from -180 to 180/],
            ['half a pin', { lat: -28 }, /lng is required/],
            ['the other half', { lng: 153 }, /lat is required/],
            ['a pin that is not a number', { lat: 'north', lng: 153 }, /lat is required as a number/],
            ['a pin taken away', { lat: null, lng: null }, /lat is empty/],
        ] as const) {
            const r = await edit({ post_id: offerId, ...args });
            assert(r.isError === true && says.test(errorText(r)) && row(offerId)?.lat === before.lat && row(offerId)?.lng === before.lng, `${what} → refused in words, unchanged (${errorText(r)})`);
        }

        // ── 4. An event moves ────────────────────────────────────────────────────────────────────────
        section('── 4. An event moves, and keeps its RSVPs ──');
        const eventId = await made('create_event', event('Working bee'));
        registerPushToken(mia.pub, 'ExponentPushToken[mia]', 'android');
        registerPushToken(noah.pub, 'ExponentPushToken[noah]', 'android');
        rsvpEvent(eventId, mia.pub, 'going');
        rsvpEvent(eventId, noah.pub, 'interested');
        const rsvps = () => db.prepare('SELECT member_pubkey, status, occurrence_at FROM event_rsvps WHERE post_id = ? ORDER BY member_pubkey').all(eventId) as any[];
        const rsvpsBefore = JSON.stringify(rsvps());
        db.prepare('INSERT INTO event_reminders_sent (post_id, member_pubkey, offset_min, occurrence_at, sent_at) VALUES (?, ?, 60, ?, NULL)').run(eventId, mia.pub, row(eventId)?.event_start_at);
        const socket = { _memberPubkey: mia.pub, _memberFeed: true, events: [] as any[], send(m: string) { this.events.push(JSON.parse(m)); } };
        addWsClient(socket as any);
        pushed.length = 0;
        const pin = await edit({ post_id: eventId, lat: -28.643519, lng: 153.612414 });
        await settle(60);
        assert(!pin.isError && structured(pin)?.postId === eventId && row(eventId)?.lat === -28.644 && row(eventId)?.lng === 153.612, `an event's pin moves, the same id (${errorText(pin) || JSON.stringify(structured(pin))})`);
        assert(JSON.stringify(rsvps()) === rsvpsBefore && rsvps().length === 2, `its RSVPs stay, one Going and one Interested (${rsvps().map((r) => r.status).join(', ')})`);
        assert(row(eventId)?.event_state === 'updated', `the event reads UPDATED, as for a host's edit (${row(eventId)?.event_state})`);
        assert(pushed.some((p) => p.to === 'ExponentPushToken[mia]' && p.title === EVENT_UPDATED_PUSH_TITLE) && !pushed.some((p) => p.to === 'ExponentPushToken[noah]'),
            `the changed notice goes to those Going and to nobody else (${JSON.stringify(pushed)})`);
        assert(socket.events.some((e) => e.type === 'post_updated' && e.post?.id === eventId), 'the socket says the post changed');
        const places = structured(await a.callTool({ name: 'community_area', arguments: {} }))?.eventPlaces ?? [];
        assert(JSON.stringify(places).includes('-28.644') && !JSON.stringify(places).includes('-28.55'), `community_area reads the new pin, never the old (${JSON.stringify(places).slice(0, 120)})`);
        assert(row(eventId)?.event_place_name === 'The old bowls club', 'a pin moved alone leaves its place name, as a person\'s edit does');
        db.prepare('UPDATE posts SET event_state = \'scheduled\' WHERE id = ?').run(eventId);
        pushed.length = 0;
        const silent = await edit({ post_id: eventId, title: 'Working bee at the club', private_note: 'Gate code 1234' });
        await settle(60);
        assert(!silent.isError && row(eventId)?.event_state === 'scheduled' && pushed.length === 0 && row(eventId)?.event_private_note === 'Gate code 1234',
            `a title and a note edit are silent (${errorText(silent) || row(eventId)?.event_state}, ${pushed.length} pushes)`);
        const acrossId = await made('create_event', event('Moved a long way'));
        const startedAt = row(acrossId)?.event_start_at, clockBefore = row(acrossId)?.event_start_local;
        const across = await edit({ post_id: acrossId, lat: -31.95, lng: 115.86 });
        assert(!across.isError && row(acrossId)?.event_tz === 'Australia/Perth' && row(acrossId)?.event_start_at === startedAt && row(acrossId)?.event_start_local !== clockBefore
            && structured(across)?.timezone === 'Australia/Perth' && structured(across)?.startsLocal === row(acrossId)?.event_start_local,
            `a pin moved into another zone keeps the moment, and the answer says the clock it now shows (${errorText(across) || `${clockBefore} → ${structured(across)?.startsLocal}`})`);
        const named = await edit({ post_id: eventId, place_name: 'The new hall' });
        assert(!named.isError && row(eventId)?.event_place_name === 'The new hall' && row(eventId)?.event_state === 'updated', `a new place name moves it too (${errorText(named) || row(eventId)?.event_state})`);

        // ── 5. An event's own fields ─────────────────────────────────────────────────────────────────
        section('── 5. An event\'s times, repeat, online, note and who it lets in ──');
        const startBefore = row(eventId)?.event_start_at as string;
        const length = Date.parse(row(eventId)?.event_end_at) - Date.parse(startBefore);
        const nextStart = inDays(9);
        const later = await edit({ post_id: eventId, start_at: nextStart });
        const stored = row(eventId);
        assert(!later.isError && stored.event_start_at === nextStart && Date.parse(stored.event_end_at) - Date.parse(nextStart) === length,
            `a new start keeps the event's length (${errorText(later) || stored.event_start_at})`);
        assert(rsvps().every((r) => r.occurrence_at === nextStart) && (db.prepare('SELECT occurrence_at FROM event_reminders_sent WHERE post_id = ?').get(eventId) as any)?.occurrence_at === nextStart,
            'its RSVPs and reminder marks move to the new date');
        assert(structured(later)?.startsLocal === stored.event_start_local && structured(later)?.timezone === 'Australia/Brisbane' && !!structured(later)?.endsLocal,
            `the answer says the clock its members see (${structured(later)?.startsLocal} ${structured(later)?.timezone})`);
        const newEnd = new Date(Date.parse(nextStart) + 3 * 3_600_000).toISOString();
        const ended = await edit({ post_id: eventId, end_at: newEnd });
        assert(!ended.isError && row(eventId)?.event_end_at === newEnd, `a new end (${errorText(ended) || row(eventId)?.event_end_at})`);
        const zoned = await edit({ post_id: eventId, timezone: 'Australia/Perth' });
        assert(!zoned.isError && row(eventId)?.event_tz === 'Australia/Perth' && row(eventId)?.event_start_local === stored.event_start_local && row(eventId)?.event_start_at !== nextStart,
            `a zone sent alone keeps the clock, another moment, as the apps' edit does (${errorText(zoned) || row(eventId)?.event_start_at})`);
        await edit({ post_id: eventId, timezone: 'Australia/Brisbane', start_at: nextStart });
        // 02:30 on the day New York's clocks go forward does not exist there: the same clock moved to its zone is said, as the app says it.
        const gapId = await made('create_event', event('Early start', { start_at: '2040-03-11T02:30:00+10:00', end_at: '2040-03-11T05:00:00+10:00' }));
        const gap = await edit({ post_id: gapId, timezone: 'America/New_York' });
        assert(!gap.isError && structured(gap)?.timeAdjusted?.start?.kind === 'gap' && structured(gap)?.timeAdjusted?.start?.asked === '2040-03-11T02:30' && structured(gap)?.startsLocal === structured(gap)?.timeAdjusted?.start?.saved,
            `a clock the new zone skips is said next to the post, as the route answers it (${errorText(gap) || JSON.stringify(structured(gap)?.timeAdjusted)})`);
        for (const [what, args, says] of [
            ['a start with no offset', { start_at: '2027-01-02T10:00:00' }, /must carry its offset/],
            ['an end with no offset', { end_at: '2027-01-02T12:00:00' }, /must carry its offset/],
            ['a blank start', { start_at: '' }, /start_at is empty/],
            ['a blank end', { end_at: '' }, /end_at is empty/],
            ['a time that is a number', { start_at: 1893456000 }, /must carry its offset/],
            ['a place name that is a number', { place_name: 7 }, /Place name must be text/],
            ['a start already past', { start_at: '2020-01-02T10:00:00Z' }, /An event must start in the future/],
            ['an end before the start', { end_at: '2020-01-02T10:00:00Z' }, /must end after it starts/],
            ['a zone not on the list', { timezone: 'Mars/Olympus' }, /Pick a time zone from the list/],
            ['a blank place name', { place_name: '  ' }, /place_name is empty/],
            ['a place name past the limit', { place_name: 'x'.repeat(81) }, /Place name must be 80 characters or fewer/],
            ['a link on an event in person', { link: 'https://example.org/join' }, /An event in person has no link/],
            ['online that is not true or false', { online: 'yes' }, /online is true or false/],
            ['a null note', { private_note: null }, /private_note is empty/],
            ['a note past the limit', { private_note: 'x'.repeat(1001) }, /note for people going must be 1000 characters or fewer/],
            ['repeat that is not a rule', { repeat: 'weekly' }, /repeat is a rule/],
            ['repeat_until on an event that does not repeat', { repeat_until: '2027-06-01' }, /does not repeat/],
        ] as const) {
            const r = await edit({ post_id: eventId, ...args });
            assert(r.isError === true && says.test(errorText(r)) && row(eventId)?.event_start_at === nextStart && row(eventId)?.event_tz === 'Australia/Brisbane', `${what} → refused in words, unchanged (${errorText(r)})`);
        }
        const lets = await edit({ post_id: eventId, host_lets_in: true });
        assert(!lets.isError && row(eventId)?.event_host_lets_in === 1, `who it lets in (${errorText(lets) || row(eventId)?.event_host_lets_in})`);

        const onDay = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(row(eventId)?.event_start_local + ':00Z').getUTCDay()];
        const notDay = onDay === 'FR' ? 'SA' : 'FR';
        const wrongDay = await edit({ post_id: eventId, repeat: { freq: 'weekly', byDay: notDay } });
        assert(wrongDay.isError === true && row(eventId)?.event_repeat === null, `a rule the event's own date is not on → refused in the engine's words (${errorText(wrongDay)})`);
        const until = new Date(Date.parse(nextStart) + 60 * DAY).toISOString().slice(0, 10);
        const weekly = await edit({ post_id: eventId, repeat: { freq: 'weekly', byDay: onDay }, repeat_until: until });
        assert(!weekly.isError && JSON.parse(row(eventId)?.event_repeat ?? '{}').byDay === onDay && row(eventId)?.event_repeat_until === until, `a repeat and its last date (${errorText(weekly) || row(eventId)?.event_repeat})`);
        const lastDate = await edit({ post_id: eventId, repeat_until: '' });
        assert(!lastDate.isError && row(eventId)?.event_repeat_until === null && !!row(eventId)?.event_repeat, `"" takes the last date off and leaves the rule (${errorText(lastDate) || 'ok'})`);
        const oneOff = await edit({ post_id: eventId, repeat: { freq: 'never' } });
        assert(!oneOff.isError && row(eventId)?.event_repeat === null, `{"freq":"never"} makes it a one-off (${errorText(oneOff) || row(eventId)?.event_repeat})`);

        const onlineId = await made('create_event', event('Planning call'));
        const goOnline = await edit({ post_id: onlineId, online: true, link: 'https://example.org/join' });
        assert(!goOnline.isError && row(onlineId)?.event_online === 1 && row(onlineId)?.lat === null && row(onlineId)?.event_place_name === null && row(onlineId)?.event_link === 'https://example.org/join',
            `online: the pin and the name go, the link comes (${errorText(goOnline) || JSON.stringify(structured(goOnline))})`);
        const noPin = await edit({ post_id: onlineId, lat: -28.5, lng: 153.5 });
        const noName = await edit({ post_id: onlineId, place_name: 'The hall' });
        assert(noPin.isError === true && /An online event has no lat/.test(errorText(noPin)) && noName.isError === true && /An online event has no place_name/.test(errorText(noName)), `a place on an online event → refused in words, never dropped (${errorText(noPin)})`);
        const badLink = await edit({ post_id: onlineId, link: 'ftp://example.org' });
        assert(badLink.isError === true && /must start with https/.test(errorText(badLink)) && row(onlineId)?.event_link === 'https://example.org/join', `a link that is not http → the engine's words (${errorText(badLink)})`);
        const halfBack = await edit({ post_id: onlineId, online: false, lat: -28.5, lng: 153.5 });
        assert(halfBack.isError === true && /place_name is required/.test(errorText(halfBack)) && row(onlineId)?.event_online === 1, `back in person with no place name → refused, as the composers refuse (${errorText(halfBack)})`);
        const noPinBack = await edit({ post_id: onlineId, online: false, place_name: 'The hall' });
        assert(noPinBack.isError === true && /lat is required/.test(errorText(noPinBack)) && row(onlineId)?.event_online === 1, `back in person with no pin → refused (${errorText(noPinBack)})`);
        const back = await edit({ post_id: onlineId, online: false, lat: -28.5, lng: 153.5, place_name: 'The hall' });
        assert(!back.isError && row(onlineId)?.event_online === 0 && row(onlineId)?.lat === -28.5 && row(onlineId)?.event_place_name === 'The hall' && row(onlineId)?.event_link === null,
            `back in person, with its pin and name, the link gone (${errorText(back) || 'ok'})`);

        // ── 6. A listing's own fields ────────────────────────────────────────────────────────────────
        section('── 6. A listing\'s terms, shop and lending ──');
        const terms = await edit({ post_id: offerId, repeatable: true, cash_also_needed: true, price_type: 'hourly', category: 'tools', beans: 7 });
        const t = row(offerId);
        assert(!terms.isError && t?.repeatable === 1 && t?.cash_also_needed === 1 && t?.price_type === 'hourly' && t?.category === 'tools' && t?.credits === 7, `repeatable, cash, price type, category and price (${errorText(terms) || 'ok'})`);
        const offAgain = await edit({ post_id: offerId, repeatable: false, cash_also_needed: false });
        assert(!offAgain.isError && row(offerId)?.repeatable === 0 && row(offerId)?.cash_also_needed === 0, `and false takes them off (${errorText(offAgain) || 'ok'})`);
        const flagText = await edit({ post_id: offerId, repeatable: 'false' });
        const badType = await edit({ post_id: offerId, price_type: 'yearly' });
        assert(flagText.isError === true && /repeatable is true or false/.test(errorText(flagText)) && row(offerId)?.repeatable === 0 && badType.isError === true && /price type must be one of/.test(errorText(badType)) && row(offerId)?.price_type === 'hourly',
            `text for a flag and a made-up price type → refused in words, unchanged (${errorText(flagText)} | ${errorText(badType)})`);

        const shop = openShop(owner.pub);
        const inShop = await edit({ post_id: offerId, shop_id: shop.id });
        assert(!inShop.isError && row(offerId)?.shop_id === shop.id, `into the author's own shop (${errorText(inShop) || row(offerId)?.shop_id})`);
        const outShop = await edit({ post_id: offerId, shop_id: '' });
        assert(!outShop.isError && row(offerId)?.shop_id === null, `"" takes it out (${errorText(outShop) || 'ok'})`);
        const miaShop = openShop(mia.pub);
        const notMineShop = await edit({ post_id: offerId, shop_id: miaShop.id });
        assert(notMineShop.isError === true && row(offerId)?.shop_id === null, `another member's shop → refused in the engine's words (${errorText(notMineShop)})`);

        const earlyTerm = await edit({ post_id: offerId, lend_terms: 'Back by Friday' });
        assert(earlyTerm.isError === true && /this Offer is not lent/.test(errorText(earlyTerm)), `a term on an Offer that is not lent → refused in words, never dropped (${errorText(earlyTerm)})`);
        const hourlyLoan = await edit({ post_id: offerId, lendable: true });
        assert(hourlyLoan.isError === true && /one fee/.test(errorText(hourlyLoan)) && row(offerId)?.lendable === 0, `lending by the hour → the engine's words (${errorText(hourlyLoan)})`);
        const lent = await edit({ post_id: offerId, lendable: true, price_type: 'daily', lend_max_days: 14, lend_terms: 'Back clean', replacement_value: '$120' });
        const l = row(offerId);
        assert(!lent.isError && l?.lendable === 1 && l?.price_type === 'daily' && l?.lend_max_days === 14 && l?.lend_terms === 'Back clean' && l?.replacement_value === '$120' && l?.repeatable === 1,
            `lent, with its terms, repeatable as every lent Offer is (${errorText(lent) || 'ok'})`);
        const numberValue = await edit({ post_id: offerId, replacement_value: 120 });
        const oneShot = await edit({ post_id: offerId, repeatable: false });
        assert(numberValue.isError === true && /in your own currency/.test(errorText(numberValue)) && row(offerId)?.replacement_value === '$120' && oneShot.isError === true && /always repeatable/.test(errorText(oneShot)) && row(offerId)?.repeatable === 1,
            `a number for a replacement value, and a lent Offer made one-off → refused in words (${errorText(numberValue)} | ${errorText(oneShot)})`);
        const noLimit = await edit({ post_id: offerId, lend_max_days: 0, lend_terms: '' });
        assert(!noLimit.isError && row(offerId)?.lend_max_days === null && row(offerId)?.lend_terms === null && row(offerId)?.replacement_value === '$120', `0 and "" take a term off (${errorText(noLimit) || 'ok'})`);

        const stopLending = await edit({ post_id: offerId, lendable: false, repeatable: true });
        assert(!stopLending.isError && row(offerId)?.lendable === 0 && row(offerId)?.lend_max_days === null && row(offerId)?.replacement_value === null && row(offerId)?.repeatable === 1, `lendable: false stops lending, its terms gone (${errorText(stopLending) || 'ok'})`);
        await edit({ post_id: offerId, lendable: true, replacement_value: '$120' });

        // ── 7. The wrong kind ────────────────────────────────────────────────────────────────────────
        section('── 7. A field on the wrong kind ──');
        const needId = await made('create_need', listing('A ladder for a week'));
        const asBakery = await made('create_enterprise_listing', { ...listing('Bakery rye loaves'), kind: 'offer', as_enterprise: enterpriseRef(bakery) });
        const asBakeryEvent = await made('create_event', event('Bakery open day', { as_enterprise: enterpriseRef(bakery) }));
        const unchanged = (id: string) => { const r = row(id); return `${r.title}|${r.lat}|${r.lng}|${r.category}|${r.credits}|${r.updated_at}`; };
        for (const [what, id, args, says] of [
            ['a start on an Offer', offerId, { start_at: inDays(3) }, /An Offer or a Need has no start_at/],
            ['a place name on a Need', needId, { place_name: 'The hall' }, /An Offer or a Need has no place_name/],
            ['online on an enterprise\'s Offer', asBakery, { online: true }, /An Offer or a Need has no online/],
            ['a repeat rule on an Offer', offerId, { repeat: { freq: 'never' } }, /An Offer or a Need has no repeat/],
            ['a note on an Offer', offerId, { private_note: 'Gate code' }, /An Offer or a Need has no private_note/],
            ['a price on an event', eventId, { beans: 4 }, /An event has no beans/],
            ['a category on an event', eventId, { category: 'food' }, /An event has no category/],
            ['repeatable on an event', eventId, { repeatable: true }, /An event has no repeatable/],
            ['a shop on an event', eventId, { shop_id: shop.id }, /An event has no shop_id/],
            ['lending on an event', eventId, { lendable: true }, /An event has no lendable/],
            ['use_my_area on an event', eventId, { use_my_area: true }, /An event has no use_my_area/],
            ['a shop on a Need', needId, { shop_id: shop.id }, /A Need has no shop_id/],
            ['lending on a Need', needId, { lendable: true }, /A Need has no lendable/],
            ['use_my_area on an enterprise\'s Offer', asBakery, { use_my_area: true }, /An enterprise's listing has no use_my_area/],
            ['cash on an enterprise\'s Offer', asBakery, { cash_also_needed: true }, /An enterprise's listing has no cash_also_needed/],
            ['a field no post has', offerId, { latitude: -28.5 }, /update_post has no field latitude/],
        ] as const) {
            const was = unchanged(id);
            const r = await edit({ post_id: id, ...args });
            assert(r.isError === true && says.test(errorText(r)) && unchanged(id) === was, `${what} → refused in words, unchanged (${errorText(r).slice(0, 70)})`);
        }
        const keeper = await edit({ post_id: asBakery, lat: -28.7, lng: 153.4, beans: 6, repeatable: false });
        assert(!keeper.isError && row(asBakery)?.lat === -28.7 && row(asBakery)?.credits === 6 && row(asBakery)?.repeatable === 0 && row(asBakery)?.author_pubkey === bakery, `an enterprise's Offer moves, by the keeper, and stays the enterprise's (${errorText(keeper) || 'ok'})`);
        const keeperEvent = await edit({ post_id: asBakeryEvent, lat: -28.71, lng: 153.41, place_name: 'The bakery' });
        assert(!keeperEvent.isError && row(asBakeryEvent)?.lat === -28.71 && row(asBakeryEvent)?.author_pubkey === bakery, `an enterprise's event too (${errorText(keeperEvent) || 'ok'})`);

        // ── my_posts reads it all back ───────────────────────────────────────────────────────────────
        section('── my_posts reads what an edit can change ──');
        const long = `${'A long description. '.repeat(40)}The end.`;
        await edit({ post_id: needId, description: long });
        const mine = structured(await a.callTool({ name: 'my_posts', arguments: { limit: 50 } }));
        const of = (id: string) => (mine?.posts as any[]).find((p) => p.postId === id);
        const readOffer = of(offerId), readEvent = of(eventId), readOnline = of(onlineId);
        assert(readOffer?.lat === row(offerId)?.lat && readOffer?.lng === row(offerId)?.lng && readOffer?.category === 'tools' && readOffer?.beans === 7 && readOffer?.priceType === 'daily'
            && readOffer?.repeatable === true && readOffer?.cashAlsoNeeded === false && readOffer?.lendable === true && readOffer?.lendMaxDays === null && /\$120/.test(fenced(readOffer?.replacementValue)) && readOffer?.photoCount === 1,
            `a listing's place, terms and lending (${JSON.stringify({ lat: readOffer?.lat, cat: readOffer?.category, price: readOffer?.priceType })})`);
        assert(readEvent?.lat === -28.644 && /The new hall/.test(fenced(readEvent?.placeName)) && readEvent?.startAt === row(eventId)?.event_start_at && readEvent?.endAt === row(eventId)?.event_end_at && readEvent?.startsLocal === row(eventId)?.event_start_local && !!readEvent?.endsLocal && readEvent?.timezone === 'Australia/Brisbane'
            && readEvent?.online === false && /Gate code 1234/.test(fenced(readEvent?.privateNote)) && readEvent?.hostLetsIn === true && readEvent?.repeat === null,
            `an event's place, clock, note and who it lets in (${JSON.stringify({ lat: readEvent?.lat, at: readEvent?.startsLocal })})`);
        await edit({ post_id: onlineId, online: true, link: 'https://example.org/again' });
        const again = structured(await a.callTool({ name: 'my_posts', arguments: { limit: 50 } }));
        const readLink = (again?.posts as any[]).find((p) => p.postId === onlineId);
        assert(readOnline?.online === false && readLink?.online === true && readLink?.lat === null && /example\.org\/again/.test(fenced(readLink?.joinLink)) && readLink?.joinLink?.untrusted === true && readLink?.link === `/?post=${encodeURIComponent(onlineId)}`,
            `an online event's join link, fenced, beside the post's own link (${JSON.stringify(readLink?.link)})`);
        assert(fenced(of(needId)?.description).includes('The end.') && long.length > 500, `a description is read whole, past a list's 500 characters (${long.length})`);
        assert(![owner.pub, bakery, mia.pub, noah.pub].some((k) => JSON.stringify(mine).includes(k)), 'my_posts carries no key, and nothing of who is going');
        assert(readEvent?.placeName?.untrusted === true && readEvent?.privateNote?.untrusted === true && of(needId)?.description?.untrusted === true, 'words typed are fenced');

        // ── 8. Someone else's ────────────────────────────────────────────────────────────────────────
        section('── 8. Someone else\'s post ──');
        const notMine = 'That is not a post this assistant made: edit or remove it in the app. my_posts lists the ones it made.';
        const tiny = await jpeg(240, 200);
        const byB = await made('create_offer', listing('Helper-made marmalade'), b);
        const fromApp = createPost('offer', 'food', 'Olive\'s own jam, from the app', 'From the phone.', 2, 'fixed', owner.pub, -28.55, 153.5, [tiny], false)!.id;
        const miasOwn = createPost('offer', 'food', 'Mia\'s kombucha', 'Scoby too.', 2, 'fixed', mia.pub, -28.55, 153.5, [tiny], false)!.id;
        for (const [label, id] of [['another assistant\'s', byB], ['the owner\'s own from the app', fromApp], ['Mia\'s', miasOwn]] as const) {
            const r = await edit({ post_id: id, lat: -30, lng: 150 });
            assert(r.isError === true && errorText(r) === notMine && row(id)?.lat === -28.55, `${label} post → refused in words, its pin unchanged (${errorText(r).slice(0, 50)})`);
        }
        db.prepare('DELETE FROM treasury_operators WHERE treasury_pubkey = ? AND member_pubkey = ?').run(bakery, owner.pub);
        clearEnterpriseFloorCache(db);
        const noLonger = await edit({ post_id: asBakery, lat: -30, lng: 150 });
        assert(noLonger.isError === true && /no longer keep/.test(errorText(noLonger)) && row(asBakery)?.lat === -28.7, `an enterprise the owner no longer keeps → refused (${errorText(noLonger)})`);
        const notTicked = await reader.callTool({ name: 'update_post', arguments: { post_id: offerId, lat: -30, lng: 150 } });
        assert(notTicked.isError === true && row(offerId)?.lat !== -30, `an assistant not ticked "May post for me" → refused (${errorText(notTicked).slice(0, 70)})`);

        // ── 9. A copy ────────────────────────────────────────────────────────────────────────────────
        section('── 9. A copy ──');
        const pulled = await made('create_offer', listing('Pulled from a peer'));
        db.prepare('UPDATE posts SET origin_node = ? WHERE id = ?').run('peer-community', pulled);
        const onPulled = await edit({ post_id: pulled, lat: -30, lng: 150 });
        assert(onPulled.isError === true && errorText(onPulled) === notMine && row(pulled)?.lat === -28.55, `a copy pulled from another community → refused, unchanged (${errorText(onPulled).slice(0, 50)})`);
        const copyId = await made('create_event', event('Shown on global'));
        db.prepare("UPDATE posts SET shown_from_host = 'byron.example', event_place_name = NULL WHERE id = ?").run(copyId);
        for (const args of [{ place_name: 'The hall' }, { private_note: 'Gate code' }, { host_lets_in: true }]) {
            const r = await edit({ post_id: copyId, ...args });
            assert(r.isError === true && /copy of an event/.test(errorText(r)) && row(copyId)?.event_place_name === null && row(copyId)?.event_private_note === null, `${Object.keys(args)[0]} on a member's copy → refused in words, not left out unsaid (${errorText(r).slice(0, 60)})`);
        }
        const copyTime = inDays(7);
        const copyMoved = await edit({ post_id: copyId, start_at: copyTime, lat: -28.6432, lng: 153.6121 });
        assert(!copyMoved.isError && row(copyId)?.event_start_at === copyTime && row(copyId)?.lat === -28.6 && row(copyId)?.lng === 153.6, `its times move, and its pin rounds to the area, as the route holds a copy (${errorText(copyMoved) || `${row(copyId)?.lat},${row(copyId)?.lng}`})`);

        // ── 10. A live deal, a closed post ───────────────────────────────────────────────────────────
        section('── 10. A live deal and a closed post ──');
        // Free, so the deal holds no Beans and the audit below still reads the same; a change of price is refused all the same.
        const dealId = await made('create_offer', { ...listing('Firewood by the load'), beans: 0, repeatable: true });
        const deal = acceptPost(dealId, mia.pub);
        const beansBefore = row(dealId)?.credits;
        const held = await edit({ post_id: dealId, beans: 9 });
        const heldType = await edit({ post_id: dealId, price_type: 'hourly' });
        assert(held.isError === true && errorText(held) === PRICE_FROZEN_ERROR && heldType.isError === true && errorText(heldType) === PRICE_FROZEN_ERROR && row(dealId)?.credits === beansBefore,
            `a live deal holds the price, in the engine's words (${errorText(held).slice(0, 60)})`);
        const dealMoved = await edit({ post_id: dealId, lat: -28.61, lng: 153.59 });
        const txAfter = db.prepare('SELECT status, credits FROM marketplace_transactions WHERE id = ?').get(deal.id) as any;
        assert(!dealMoved.isError && row(dealId)?.lat === -28.61 && txAfter?.credits === deal.credits, `and lets the place move, as a person's edit does; the deal stands (${errorText(dealMoved) || JSON.stringify(txAfter)})`);

        // A one-off in a deal is out of both apps' edit form, and stays out of this one (status 'pending').
        const oneOffDeal = await made('create_offer', { ...listing('One load of mulch'), beans: 0 });
        acceptPost(oneOffDeal, mia.pub);
        const onPending = await edit({ post_id: oneOffDeal, lat: -30, lng: 150 });
        assert(onPending.isError === true && /pending now/.test(errorText(onPending)) && row(oneOffDeal)?.lat === -28.55, `a one-off held by its deal → refused (${errorText(onPending)})`);

        const pausedId = await made('create_offer', listing('Paused plums'));
        db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(pausedId);
        const onPaused = await edit({ post_id: pausedId, lat: -30, lng: 150 });
        assert(onPaused.isError === true && /paused now/.test(errorText(onPaused)) && row(pausedId)?.lat === -28.55, `a paused post → refused (${errorText(onPaused)})`);
        const removedId = await made('create_offer', listing('Taken-down turnips'));
        removePost(removedId, owner.pub);
        const onRemoved = await edit({ post_id: removedId, lat: -30, lng: 150 });
        assert(onRemoved.isError === true && /removed now/.test(errorText(onRemoved)) && row(removedId)?.lat === -28.55, `a removed post → refused (${errorText(onRemoved)})`);
        const cancelledId = await made('create_event', event('Called off'));
        removePost(cancelledId, owner.pub);
        const onCancelled = await edit({ post_id: cancelledId, lat: -30, lng: 150 });
        assert(onCancelled.isError === true && row(cancelledId)?.lat === -28.55, `a cancelled event → refused (${errorText(onCancelled)})`);
        const overId = await made('create_event', event('Over and done'));
        db.prepare('UPDATE posts SET event_start_at = ?, event_end_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * DAY).toISOString(), new Date(Date.now() - DAY).toISOString(), overId);
        const onOver = await edit({ post_id: overId, lat: -30, lng: 150 });
        assert(onOver.isError === true && /Cannot edit an event that has ended/.test(errorText(onOver)) && row(overId)?.lat === -28.55, `an event that has ended → the engine's words (${errorText(onOver)})`);

        // ── 11. Search, audit, the day's edits ───────────────────────────────────────────────────────
        section('── 11. What stands ──');
        const searchId = await made('create_offer', listing('Quinces in a box'));
        const found = (word: string): boolean => !!db.prepare('SELECT 1 FROM posts_fts f JOIN posts p ON p.rowid = f.rowid WHERE posts_fts MATCH ? AND p.id = ?').get(word, searchId);
        assert(found('quinces'), 'setup: the search index finds it by its words');
        const renamed = await edit({ post_id: searchId, title: 'Medlars in a box', category: 'tools', free_tags: ['orchard gate'], lat: -28.62, lng: 153.58 });
        const words = row(searchId)?.search_keywords as string;
        assert(!renamed.isError && found('medlars') && !found('quinces') && /tools/.test(words) && /orchard/.test(words) && !/food/.test(words), `the search fields follow the edit, the old words gone (${words})`);
        assert([offerId, eventId, asBakery].every((id) => row(id)?.created_via === `assistant:${A.id}`), 'created_via stands after every edit');
        const lines = db.prepare("SELECT metadata FROM system_logs WHERE category = 'AGENT' AND message = 'Assistant wrote' AND metadata LIKE '%update_post%'").all() as Array<{ metadata: string }>;
        assert(lines.length > 0 && !lines.some((l) => /Gate code 1234/.test(l.metadata)), 'each edit is an AGENT line of field names, never their words');
        const nothing = await edit({ post_id: offerId });
        assert(nothing.isError === true && /at least one field/.test(errorText(nothing)) && /start_at|shop_id/.test(errorText(nothing)), `no field → refused, as today (${errorText(nothing).slice(0, 70)})`);
        resetAgentLimits();
        const first = structured(await a.callTool({ name: 'update_post', arguments: { post_id: searchId, title: 'Medlars, boxed' } }))?.editsToday as number;
        await a.callTool({ name: 'update_post', arguments: { post_id: searchId, lat: 95, lng: 153 } });
        const second = structured(await a.callTool({ name: 'update_post', arguments: { post_id: searchId, title: 'Medlars in a crate' } }))?.editsToday as number;
        assert(first === 1 && second === 2, `an edit the engine refuses is given back, not counted (${first}, then ${second})`);
        while (admitAgentEdit(A.id)) { /* to the day's most */ }
        const pinNow = row(eventId)?.lat;
        const full = await edit({ post_id: eventId, lat: -30, lng: 150 });
        assert(full.isError === true && /200 edits today/.test(errorText(full)) && row(eventId)?.lat === pinNow, `over the day's edits → refused in words, the pin unchanged (${errorText(full)})`);
        const otherGrant = await b.callTool({ name: 'update_post', arguments: { post_id: byB, lat: -29, lng: 152 } });
        assert(!otherGrant.isError && row(byB)?.lat === -29, 'the count is each assistant\'s own');

        // ── 12. No Bean moved ────────────────────────────────────────────────────────────────────────
        const auditAfter = runLedgerAudit();
        assert(auditAfter.ok === auditBefore.ok && auditAfter.drift === auditBefore.drift && auditAfter.sumBalances === auditBefore.sumBalances && auditAfter.strandedEscrows === auditBefore.strandedEscrows,
            `the ledger audit is the same after as before (${JSON.stringify(auditBefore)} → ${JSON.stringify(auditAfter)})`);
        await Promise.all([a.close(), b.close(), reader.close()]).catch(() => {});
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
