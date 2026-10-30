/**
 * MCP owner slice S2, the seeding reads (design §2.2; agent/owner-reads.ts): categories, listings_search, community_area. End to
 * end with the official TypeScript MCP SDK client over REAL HTTPS through the real Koa middleware; nothing here contacts
 * anything but the server it starts.
 *
 *   1. Every answer swept: no member's key (the owner's, another member's, an enterprise's), no URL, no other member's name.
 *   2. listings_search sees what the owner's Market sees and no more: a public listing of another member's (as "another
 *      member"), the owner's own ("me") and the bakery's they keep ("enterprise:<ref>"); never a group post outside their
 *      groups, a direct post between two others, a post hidden by reports, another member's paused listing or a removed one.
 *      Its titles only with include_text, fenced. q finds by word.
 *   3. community_area: the community's centre to two decimals (never the manager's exact pin), the radius, and this
 *      community's own public events' place names, each at its pin rounded to 3 decimals, fenced; never a member's area or the
 *      exact pin of a member's listing, never a group's event's place.
 *   4. A token not ticked "May post for me" lists none of these tools and is refused one (an admin's: test-admin-mcp.ts).
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-reads TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
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
import { PRICING_CATEGORIES } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost, updateNodeConfig } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { grantNodeRole } from './engine/node-roles.js';
import { setMemberArea } from './engine/member-area.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { enterpriseRef } from './agent/owner-posts.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

interface Key { pub: string; priv: crypto.KeyObject }
function keypair(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey };
}

async function makeToken(owner: string, canPost: boolean): Promise<string> {
    const res = await fetch(`${BASE}/api/local/admin/agent/grants`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerPhoneSessionHeaders(owner) },
        body: JSON.stringify({ name: canPost ? 'Seeder' : 'Reader only', canPost }),
    });
    return ((await res.json()) as any)?.token ?? '';
}

async function connect(token: string): Promise<Client> {
    const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const READ_TOOLS = ['categories', 'listings_search', 'community_area', 'my_posts'];

async function main(): Promise<void> {
    console.log('\n=== An owner\'s seeding assistant reads (MCP owner S2) ===\n');
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-reads-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair(), mia = keypair(), ned = keypair(), admin = keypair();
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
    addMember(ned, 'Ned Elsewhere');
    addMember(admin, 'Adele Admin');
    grantNodeRole(admin.pub, 'admin', 'SYSTEM');
    const bakery = keypair().pub;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, 'Olive Bakery Co-op', ?, ?, 'inv-test', 'active', 1)`).run(bakery, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(bakery);
    setMemberPhoto(db, bakery, AVATAR);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bakery, owner.pub);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(owner.pub);
    clearEnterpriseFloorCache(db);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });
    // The manager's pin, set at a home to the metre: an assistant reads it to two decimals, as a member's app does.
    updateNodeConfig({ serviceRadius: { lat: -28.551234, lng: 153.509876, radiusKm: 25 } } as any);
    // Mia's own area: no assistant reads it.
    setMemberArea(mia.pub, { lat: -28.612345, lng: 153.456789 });

    const buf = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const tiny = `data:image/jpeg;base64,${buf.toString('base64')}`;
    const post = (title: string, author: string, lat = -28.55, lng = 153.5) => createPost('offer', 'food', title, 'Words.', 2, 'fixed', author, lat, lng, [tiny], false)!.id;
    const miaPublic = post('Sourdough starter from Mia', mia.pub, -28.567891, 153.512345);
    const ownersOwn = post('Sourdough loaves from Olive', owner.pub);
    const bakerys = post('Sourdough rye from the bakery', bakery);
    const groupPost = post('Sourdough for the choir only', mia.pub);
    db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = 'g-choir' WHERE id = ?").run(groupPost);
    const directPost = post('Sourdough for Ned only', mia.pub);
    db.prepare("UPDATE posts SET audience_scope = 'direct', target_pubkey = ? WHERE id = ?").run(ned.pub, directPost);
    const hidden = post('Sourdough hidden by reports', mia.pub);
    db.prepare("UPDATE posts SET hidden_by_reports_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(hidden);
    const paused = post('Sourdough on holiday', mia.pub);
    db.prepare("UPDATE posts SET status = 'paused' WHERE id = ?").run(paused);
    const removed = post('Sourdough taken down', mia.pub);
    db.prepare("UPDATE posts SET active = 0, status = 'cancelled' WHERE id = ?").run(removed);
    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    try {
        resetAdminAuthTarpit();
        const seeder = await connect(await makeToken(owner.pub, true));
        // Events, made as the apps make them (through create_event): a public one in person (its place on its card), and one
        // moved to a group (not this community's public board).
        const soon = new Date(Date.now() + 5 * DAY).toISOString();
        const event = async (title: string, placeName: string, lat: number, lng: number): Promise<string> => {
            const r = await seeder.callTool({ name: 'create_event', arguments: {
                title, description: 'Words.', start_at: soon, timezone: 'Australia/Brisbane', place_name: placeName, lat, lng, photos: [tiny],
            } });
            return structured(r)?.postId ?? `not made: ${errorText(r)}`;
        };
        const swap = await event('Seed swap', 'The old bowls club', -28.554321, 153.500456);
        const choirEvent = await event('Choir practice', '14 Hidden Lane', -28.6, 153.6);
        db.prepare("UPDATE posts SET audience_scope = 'group', target_group_id = 'g-choir' WHERE id = ?").run(choirEvent);
        assert(!swap.startsWith('not made') && !choirEvent.startsWith('not made'), `two events made (${swap}; ${choirEvent})`);
        const names = (await seeder.listTools()).tools.map(t => t.name);
        assert(READ_TOOLS.every(n => names.includes(n)), `a ticked owner's assistant lists ${READ_TOOLS.join(', ')} (${names.length} tools)`);
        const FORBIDDEN = [owner.pub, mia.pub, ned.pub, bakery, admin.pub];
        const sweep = (label: string, value: unknown) => {
            const json = JSON.stringify(value);
            const leaks = [
                ...FORBIDDEN.filter(k => json.includes(k)).map(k => `key ${k.slice(0, 8)}`),
                ...(/https?:\/\//i.test(json) ? ['a URL'] : []),
                ...['Mia Neighbour', 'Ned Elsewhere', 'Adele Admin', 'Olive Bakery'].filter(n => json.includes(n)),
            ];
            assert(leaks.length === 0, `${label}: no key, URL or other member's name (${leaks.join(', ') || 'clean'})`);
        };

        // ── categories ───────────────────────────────────────────────────────────────────────────────
        const cats = structured(await seeder.callTool({ name: 'categories', arguments: {} }));
        assert((cats?.categories ?? []).length === PRICING_CATEGORIES.length && cats.categories.every((c: any) => typeof c.id === 'string' && typeof c.label === 'string'),
            `categories lists the ${PRICING_CATEGORIES.length} Market categories with labels`);
        sweep('categories', cats);

        // ── listings_search ──────────────────────────────────────────────────────────────────────────
        const plain = structured(await seeder.callTool({ name: 'listings_search', arguments: { kind: 'offer', limit: 50 } }));
        const ids = new Set((plain?.listings ?? []).map((l: any) => l.postId));
        const byOf = (id: string) => (plain?.listings ?? []).find((l: any) => l.postId === id)?.by;
        assert(ids.has(miaPublic) && ids.has(ownersOwn) && ids.has(bakerys)
            && byOf(miaPublic) === 'another member' && byOf(ownersOwn) === 'me' && byOf(bakerys) === `enterprise:${enterpriseRef(bakery)}`,
            `listings_search sees a public listing of another member's, the owner's own and the bakery's, each by who (${[byOf(miaPublic), byOf(ownersOwn), byOf(bakerys)].join(', ')})`);
        const notSeen = { groupPost, directPost, hidden, paused, removed };
        const seenWrongly = Object.entries(notSeen).filter(([, id]) => ids.has(id)).map(([k]) => k);
        assert(seenWrongly.length === 0, `and no more than the owner's Market: no group post outside their groups, no direct post between others, nothing hidden, paused or removed (${seenWrongly.join(', ') || 'none'})`);
        assert((plain?.listings ?? []).every((l: any) => !('title' in l)) && !('_notice' in (plain ?? {})), 'without include_text, no titles');
        sweep('listings_search', plain);
        const withText = structured(await seeder.callTool({ name: 'listings_search', arguments: { q: 'starter', include_text: true } }));
        const hit = (withText?.listings ?? []) as any[];
        assert(hit.length === 1 && hit[0].postId === miaPublic && hit[0].title?.untrusted === true && /Sourdough starter from Mia/.test(hit[0].title.text)
            && /<<<MEMBER-TEXT [0-9a-f]{8}: listing .+, title\./.test(hit[0].title.text) && typeof withText._notice === 'string',
            `q finds by word; with include_text the title is fenced (${hit.length})`);
        sweep('listings_search with text', { ...withText, listings: hit.map(l => ({ ...l, title: String(l.title?.text ?? '').replace('Sourdough starter from Mia', '') })) });

        // ── community_area ───────────────────────────────────────────────────────────────────────────
        const area = structured(await seeder.callTool({ name: 'community_area', arguments: {} }));
        const areaJson = JSON.stringify(area);
        assert(area?.centre?.lat === -28.55 && area?.centre?.lng === 153.51 && area?.radiusKm === 25,
            `the community's centre to two decimals, never the manager's exact pin (${JSON.stringify(area?.centre)}, ${area?.radiusKm} km)`);
        const places = (area?.eventPlaces ?? []) as any[];
        assert(places.length === 1 && /The old bowls club/.test(places[0].name?.text ?? '') && places[0].name?.untrusted === true && places[0].lat === -28.554 && places[0].lng === 153.5,
            `this community's public event's place name, fenced, its pin rounded to 3 decimals (${JSON.stringify(places.map(p => [p.lat, p.lng]))})`);
        assert(!/Hidden Lane/.test(areaJson) && !areaJson.includes('-28.612') && !areaJson.includes('153.456') && !areaJson.includes('-28.567891') && !areaJson.includes('-28.551234'),
            "never a group event's place, a member's area, a member's listing's pin, or the exact community pin");
        sweep('community_area', area);
        await seeder.close().catch(() => {});

        // ── not ticked, or an admin's ────────────────────────────────────────────────────────────────
        const reader = await connect(await makeToken(owner.pub, false));
        const readerNames = (await reader.listTools()).tools.map(t => t.name);
        const refused = await reader.callTool({ name: 'listings_search', arguments: {} });
        assert(READ_TOOLS.every(n => !readerNames.includes(n)) && refused.isError === true,
            `a token not ticked "May post for me" lists none of them, and is refused one (${errorText(refused)})`);
        await reader.close().catch(() => {});
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
