/**
 * The price units an owner's assistant may set (agent/owner-posts.ts AGENT_PRICE_TYPES), pinned to what the apps offer for
 * the same listing (#3378 deciding review, NON-BLOCKING 3). End to end with the official TypeScript MCP SDK client over REAL
 * HTTPS through the real Koa middleware; nothing here contacts anything but the server it starts.
 *
 * WHAT CHANGED for the assistant in #3378. Before it, create_offer, create_need, create_enterprise_listing and
 * create_group_post kept `hourly` and turned every other price_type into `fixed`, silently: an owner who asked for a
 * listing "per day" got a fixed total, and a unit the node doesn't know was posted as one too. Now each stores the unit it
 * is sent when the apps' own forms offer it for that listing (Total, per hour, per day, per week, per month; per year and
 * per kilo only once PRICE_UNITS_KG_YEAR_BUILT is true, as the apps' forms follow features.priceUnitsKgYear), and refuses
 * any other in words with nothing written. Each (`each`) stays refused: the apps offer it, but it needs a count the
 * assistant can't send (DESIGN-per-item-price-fable.md §7). update_post holds to the same list (test-mcp-owner-edit §6).
 *
 *   1. The tools' schemas name exactly the units the apps' forms offer an Offer and a Need on this node, Each aside.
 *   2. Every unit × create_offer, create_need, create_enterprise_listing, create_group_post (Offer and Need) × update_post:
 *      one the apps offer is stored as sent; any other is refused in words and nothing is written. No price_type is Total.
 *   3. The ledger audit is the same after as before: no Bean moved.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-price-units TEST_ALL_JOBS=1 node scripts/run-server-suites.mjs
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
import { PRICE_UNITS, priceUnitsOffered, type PriceUnit } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, runLedgerAudit, seedGenesisMember } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { db } from './db/db.js';
import { resetAgentLimits } from './agent/limits.js';
import { AGENT_PRICE_TYPES, enterpriseRef } from './agent/owner-posts.js';
import { PRICE_UNITS_KG_YEAR_BUILT } from './config/node-profile.js';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
function section(title: string): void { console.log(`\n${title}`); }

const keypair = (): string => crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const row = (id: string): any => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
const postCount = (): number => (db.prepare('SELECT COUNT(*) n FROM posts').get() as { n: number }).n;

async function jpeg(width: number, height: number): Promise<string> {
    const buf = await sharp({ create: { width, height, channels: 3, background: { r: 120, g: 160, b: 60 } } }).jpeg({ quality: 80 }).toBuffer();
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
    if (typeof url === 'string' && url.startsWith('https://exp.host/')) return new Response('{"data":[]}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (typeof url === 'string' && !url.startsWith('https://localhost')) throw new Error(`test-mcp-owner-price-units: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

async function main(): Promise<void> {
    console.log("\n=== an owner's assistant sets the price units the apps offer, and no others ===");
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-units-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    updateLocalConfig({ aiAssistantsAllowed: true, agentPostsPerDay: 1000 });
    const owner = keypair();
    seedGenesisMember(owner, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner);
    setMemberPhoto(db, owner, AVATAR);
    const bakery = keypair();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, 'Olive Bakery Co-op', ?, ?, 'inv-test', 'active', 1)`).run(bakery, longAgo, owner);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(bakery);
    setMemberPhoto(db, bakery, AVATAR);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bakery, owner);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(owner);
    clearEnterpriseFloorCache(db);
    const groupId = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO groups (id, name, slug, description, category, created_by, lead_pubkey, join_policy, created_at, updated_at) VALUES (?, 'Seed savers', 'seeds', '', 'social', ?, ?, 'open', ?, ?)`)
        .run(groupId, owner, owner, now, now);
    db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, updated_at) VALUES (?, ?, 'convenor', 'active', ?, ?)`).run(groupId, owner, now, now);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const auditBefore = runLedgerAudit();

    try {
        resetAdminAuthTarpit();
        const grant = await (await realFetch(`${BASE}/api/local/admin/agent/grants`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', ...ownerPhoneSessionHeaders(owner) }, body: JSON.stringify({ name: "Olive's Claude", canPost: true }),
        })).json() as any;
        const client = new Client({ name: 'beanpool-test-assistant', version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${grant?.token}` } } }));
        let calls = 0;
        const tool = (name: string, args: Record<string, unknown>) => { if (++calls % 30 === 0) resetAgentLimits(); return client.callTool({ name, arguments: args }); };
        const photo = await jpeg(400, 300);
        const listing = (title: string, extra: Record<string, unknown> = {}) => ({
            title, description: 'Seeded for the community.', category: 'food', beans: 3, lat: -28.55, lng: 153.5, photos: [photo], ...extra,
        });

        // ── 1. The schemas name what the apps' forms offer ───────────────────────────────────────────
        section("── 1. The tools' price units are the apps' (Each aside) ──");
        // The node's own features answer, as both apps read it: the forms offer priceUnitsOffered(features, kind).
        const info = await (await realFetch(`${BASE}/api/community/info`)).json() as any;
        const appsOffer = (kind: 'offer' | 'need'): PriceUnit[] => priceUnitsOffered(info?.features, kind).filter((u) => u !== 'each');
        assert(JSON.stringify(appsOffer('offer')) === JSON.stringify(appsOffer('need')) && JSON.stringify([...AGENT_PRICE_TYPES]) === JSON.stringify(appsOffer('offer')),
            `AGENT_PRICE_TYPES ${JSON.stringify(AGENT_PRICE_TYPES)} is what the apps' forms offer an Offer and a Need on this node, Each aside (${JSON.stringify(appsOffer('offer'))})`);
        assert(PRICE_UNITS_KG_YEAR_BUILT || (!AGENT_PRICE_TYPES.includes('yearly') && !AGENT_PRICE_TYPES.includes('per_kg')),
            'per year and per kilo stay out while PRICE_UNITS_KG_YEAR_BUILT is false, as the apps\' forms hide them (features.priceUnitsKgYear absent)');
        const tools = (await client.listTools()).tools;
        for (const name of ['create_offer', 'create_need', 'create_enterprise_listing', 'create_group_post', 'update_post']) {
            const schema = (tools.find((t) => t.name === name)?.inputSchema as any)?.properties?.price_type;
            assert(JSON.stringify(schema?.enum) === JSON.stringify([...AGENT_PRICE_TYPES]), `${name}'s price_type enum is AGENT_PRICE_TYPES (${JSON.stringify(schema?.enum)})`);
        }

        // ── 2. Every unit, on every tool that sets one ──────────────────────────────────────────────
        section('── 2. Every unit × every tool: stored as sent where the apps offer it, refused in words otherwise ──');
        // A Need needs an Offer of its maker's own first, the engine's rule for every Need: one each, as the owner and the bakery.
        const firstOffer = structured(await tool('create_offer', listing('Lemons from the tree')))?.postId as string;
        const firstBakery = structured(await tool('create_enterprise_listing', listing('Rye loaves', { kind: 'offer', as_enterprise: enterpriseRef(bakery) })))?.postId as string;
        assert(row(firstOffer)?.price_type === 'fixed' && row(firstBakery)?.price_type === 'fixed', 'no price_type sent is Total (fixed), on a member\'s listing and an enterprise\'s');
        const groupFirst = structured(await tool('create_group_post', { group_id: groupId, kind: 'offer', title: 'Saved bean seeds', category: 'food', beans: 2, photos: [photo] }))?.postId as string;
        assert(row(groupFirst)?.price_type === 'fixed', 'a group post with no price_type is Total (fixed)');

        type Maker = { name: string; make: (unit: string) => Promise<any> };
        const MAKERS: Maker[] = [
            { name: 'create_offer', make: (u) => tool('create_offer', listing(`Offer ${u}`, { price_type: u })) },
            { name: 'create_need', make: (u) => tool('create_need', listing(`Need ${u}`, { price_type: u })) },
            { name: 'create_enterprise_listing offer', make: (u) => tool('create_enterprise_listing', listing(`Bakery offer ${u}`, { kind: 'offer', price_type: u, as_enterprise: enterpriseRef(bakery) })) },
            { name: 'create_enterprise_listing need', make: (u) => tool('create_enterprise_listing', listing(`Bakery need ${u}`, { kind: 'need', price_type: u, as_enterprise: enterpriseRef(bakery) })) },
            { name: 'create_group_post offer', make: (u) => tool('create_group_post', { group_id: groupId, kind: 'offer', title: `Group offer ${u}`, category: 'food', beans: 2, price_type: u, photos: [photo] }) },
            { name: 'create_group_post need', make: (u) => tool('create_group_post', { group_id: groupId, kind: 'need', title: `Group need ${u}`, category: 'food', beans: 2, price_type: u, photos: [photo] }) },
        ];
        // Every unit the node knows, and one it doesn't.
        for (const unit of [...PRICE_UNITS, 'per_litre']) {
            const takes = (AGENT_PRICE_TYPES as readonly string[]).includes(unit);
            for (const m of MAKERS) {
                const before = postCount();
                const r = await m.make(unit);
                const id = structured(r)?.postId as string | undefined;
                if (takes) {
                    assert(!r.isError && !!id && row(id)?.price_type === unit,
                        `${m.name} price_type ${unit}: stored as ${unit}${['daily', 'weekly', 'monthly'].includes(unit) ? ' (it was stored as fixed before #3378)' : ''} (${errorText(r) || row(id ?? '')?.price_type})`);
                } else {
                    assert(r.isError === true && /price_type must be one of/.test(errorText(r)) && postCount() === before,
                        `${m.name} price_type ${unit}: refused in words, nothing written (${errorText(r).slice(0, 90)})`);
                }
            }
            const before = row(firstOffer)?.price_type;
            const edited = await tool('update_post', { post_id: firstOffer, price_type: unit });
            if (takes) {
                assert(!edited.isError && row(firstOffer)?.price_type === unit, `update_post price_type ${unit}: stored as sent (${errorText(edited) || 'ok'})`);
            } else {
                assert(edited.isError === true && /price type must be one of/.test(errorText(edited)) && row(firstOffer)?.price_type === before,
                    `update_post price_type ${unit}: refused in words, the listing keeps ${before} (${errorText(edited).slice(0, 90)})`);
            }
        }

        // ── 3. No Bean moved ────────────────────────────────────────────────────────────────────────
        section('── 3. The ledger ──');
        const auditAfter = runLedgerAudit();
        assert(auditAfter.ok && auditAfter.drift === auditBefore.drift, `the ledger audit is the same after as before (drift ${auditBefore.drift} → ${auditAfter.drift})`);
        await client.close();
    } catch (err) {
        console.error(err);
        process.exitCode = 1;
    }
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run && process.exitCode !== 1 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
