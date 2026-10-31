/**
 * Tags T4: an owner's assistant tags what it posts, from the library first (DESIGN-tags-free-entry-fable.md §8's T4 row, §5;
 * DESIGN-owner-seeding-tags-fable.md §2.2, §2.6). End to end with the official TypeScript MCP SDK client over REAL HTTPS
 * through the real Koa middleware; nothing here contacts anything but the server it starts.
 *
 *   1. The tools' words: every create and update_post takes `tags` and `free_tags` and says library first, free tags only for
 *      what the library lacks, and never a list of tags in the description; tags_search is listed only for a ticked owner.
 *   2. tags_search reads the library the pickers read: ids with their English label and path, a plural and two words found,
 *      a category narrows it, a top is never offered, nothing found says so; refused in words without a word to look for.
 *   3. Both kinds carried, on every create (an Offer, a Need, an event, an enterprise's Offer, Need and event), in the column
 *      each belongs in, as the Market's read gives them; a post with no tags is made as before.
 *   4. Refusals in the tool's words: an unknown id with the three nearest; each free-tag refusal naming the field and the tag;
 *      nothing made, nothing counted, and no photo fetched or used up by a refused call.
 *   5. A seeded listing is found by its tag's word, by its alias, by a free tag's word, and by the Market's exact filters.
 *   6. update_post: an edit that names no tags keeps both kinds; one that names one kind leaves the other; [] clears; null is
 *      refused and clears nothing; a tag the listing already carries passes, as in the apps; refused edits change nothing
 *      and are not counted; an event's tags too.
 *   7. my_posts says what each post carries, its typed tags fenced, so an edit can send the whole new list.
 *
 * Run: SERVER_SUITES_ONLY=test-mcp-owner-tags TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
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
import { FREE_TAGS_MAX, POST_TAGS_MAX, PRICING_CATEGORIES, TAG_TOPS, isTagId, type TagDef } from '@beanpool/core';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost } from './state-engine.js';
import { updateLocalConfig, getLocalConfig } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { ownerPhoneSessionHeaders } from './admin-auth-test-harness.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { db } from './db/db.js';
import { resetAgentLimits } from './agent/limits.js';
import { enterpriseRef } from './agent/owner-posts.js';
import { AGENT_TOOLS, toolsFor, type AgentGrant } from './agent/tools.js';

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

/** The Market's read, signed as a member's phone signs it, through the real middleware. */
async function market(reader: Key, query: string): Promise<any[]> {
    resetGatewayRateLimit();
    const urlPath = `/api/marketplace/posts?${query}`;
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const res = await fetch(`${BASE}${urlPath}`, {
        headers: {
            'X-Public-Key': reader.pub, 'X-Timestamp': String(ts), 'X-Nonce': nonce,
            'X-Signature': crypto.sign(null, Buffer.from(`GET\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n`), reader.priv).toString('base64'),
        },
    });
    const body = await res.json().catch(() => null);
    if (!Array.isArray(body)) console.error(`  (${query}: ${res.status} ${JSON.stringify(body)?.slice(0, 120)})`);
    return Array.isArray(body) ? body : [];
}

/** A section of its own, with the door's 60 calls a minute given back: this suite makes more than a minute's calls. */
function section(title: string): void {
    resetAgentLimits();
    console.log(title);
}

const structured = (r: any): any => r?.structuredContent ?? null;
const errorText = (r: any): string => (r?.content as any)?.[0]?.text ?? '';
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const DAY = 86_400_000;
const row = (id: string) => db.prepare('SELECT tags, free_tags, search_keywords, title, created_via FROM posts WHERE id = ?').get(id) as
    { tags: string; free_tags: string; search_keywords: string; title: string; created_via: string } | undefined;
const postCount = (): number => (db.prepare('SELECT COUNT(*) AS c FROM posts').get() as { c: number }).c;

async function main(): Promise<void> {
    console.log('\n=== An owner\'s assistant tags what it posts (Tags T4) ===\n');
    const webRoot = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), 'bp-mcp-tags-'));
    fs.mkdirSync(path.join(webRoot, 'public'), { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'public', 'index.html'), '<!doctype html><title>BeanPool</title>');
    process.chdir(webRoot);

    await initTls();
    initStateEngine();
    const owner = keypair(), mia = keypair();
    seedGenesisMember(owner.pub, 'Olive');
    const longAgo = new Date(Date.now() - 60 * DAY).toISOString();
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(longAgo, owner.pub);
    setMemberPhoto(db, owner.pub, AVATAR);
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'Mia Neighbour', 'active', ?, ?, 'inv-test')`).run(mia.pub, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(mia.pub);
    setMemberPhoto(db, mia.pub, AVATAR);
    const bakery = keypair().pub;
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_treasury)
                VALUES (?, 'Olive Bakery Co-op', ?, ?, 'inv-test', 'active', 1)`).run(bakery, longAgo, owner.pub);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(bakery);
    setMemberPhoto(db, bakery, AVATAR);
    db.prepare('INSERT INTO treasury_operators (treasury_pubkey, member_pubkey) VALUES (?, ?)').run(bakery, owner.pub);
    db.prepare('UPDATE members SET can_operate = 1 WHERE public_key = ?').run(owner.pub);
    clearEnterpriseFloorCache(db);
    updateLocalConfig({ gateway: { ...(getLocalConfig().gateway ?? {}), rateLimiting: { enabled: true, maxRequestsPerMinute: 100000 } } as any });

    const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: 180, g: 120, b: 60 } } }).jpeg({ quality: 80 }).toBuffer();
    const photo = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const { startHttpsServer } = await import('./https-server.js');
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    try {
        resetAdminAuthTarpit();
        const token = await makeToken(owner.pub, true);
        const seeder = await connect(token);
        const offer = (title: string, extra: Record<string, unknown> = {}) => ({
            title, description: 'Seeded for the community.', category: 'food', beans: 3, lat: -28.55, lng: 153.5, photos: [photo], ...extra,
        });
        const inPerson = (title: string, extra: Record<string, unknown> = {}) => ({
            title, description: 'A morning at the hall.', start_at: new Date(Date.now() + 5 * DAY).toISOString(), timezone: 'Australia/Brisbane',
            place_name: 'The bowls club', lat: -28.55, lng: 153.5, photos: [photo], ...extra,
        });
        const call = (name: string, args: Record<string, unknown>) => seeder.callTool({ name, arguments: args });
        const info = async () => structured(await call('connection_info', {}));

        // ── 1. the tools' words ──────────────────────────────────────────────────────────────────────
        section('── 1. the tools\' words ──');
        const tools = (await seeder.listTools()).tools;
        const TAKES_TAGS = ['create_offer', 'create_need', 'create_event', 'create_enterprise_listing', 'update_post'];
        const taking = TAKES_TAGS.map((n) => tools.find((t) => t.name === n));
        const propsOf = (t: any): Record<string, any> => t?.inputSchema?.properties ?? {};
        assert(taking.every((t) => propsOf(t).tags?.type === 'array' && propsOf(t).free_tags?.type === 'array'), 'every create and update_post takes tags and free_tags, each a list');
        assert(taking.every((t) => propsOf(t).tags?.maxItems === POST_TAGS_MAX && propsOf(t).free_tags?.maxItems === FREE_TAGS_MAX), `at most ${POST_TAGS_MAX} of each, as the node holds them`);
        assert(taking.every((t) => !(t?.inputSchema as any)?.required?.includes('tags') && !(t?.inputSchema as any)?.required?.includes('free_tags')),
            'neither is required: a listing posts with none, as in the composer');
        assert(taking.every((t) => /tags_search/.test(propsOf(t).tags?.description ?? '') && /librar/i.test(propsOf(t).tags?.description ?? '')
            && /only for what the library lacks/.test(propsOf(t).free_tags?.description ?? '')),
            'the fields say it: library ids from tags_search first, free tags only for what the library lacks');
        assert(taking.every((t) => /library/.test(t?.description ?? '') && /free_tags/.test(t?.description ?? '')), 'and so does each tool\'s description');
        assert(taking.every((t) => /never .*tags/i.test(propsOf(t).description?.description ?? '')), `the description field says tags never go in it (${propsOf(taking[0]).description?.description})`);
        // A list replaces: an assistant told otherwise would send the one tag to add, and lose the rest.
        const updateWords = tools.find((t) => t.name === 'update_post')?.description ?? '';
        assert(/whole new list/.test(updateWords) && !/does not name stay/.test(updateWords), `update_post's description says a list it sends replaces the old one (${updateWords.match(/[^.;]*(?:whole new list|does not name)[^.;]*/)?.[0]})`);
        const welcome = seeder.getInstructions() ?? '';
        assert(/library/.test(welcome) && /tags_search/.test(welcome) && /free_tags/.test(welcome) && /never .*description/i.test(welcome), 'the welcome says it too, where it says how to give photos');
        const search = tools.find((t) => t.name === 'tags_search');
        assert(!!search && search.annotations?.readOnlyHint === true && (search.inputSchema as any)?.required?.includes('q') && !/Member-written text/.test(search.description ?? ''),
            'tags_search is a read, q required, with no member text in it');

        // A token not ticked "May post for me", and an admin's: no such tool.
        const reader = await connect(await makeToken(owner.pub, false));
        const readerNames = (await reader.listTools()).tools.map((t) => t.name);
        const readerCall = await reader.callTool({ name: 'tags_search', arguments: { q: 'lemon' } });
        assert(!readerNames.includes('tags_search') && readerCall.isError === true, `a token not ticked lists no tags_search and is refused it (${errorText(readerCall)})`);
        await reader.close().catch(() => {});
        const grant = (role: 'owner' | 'admin', canPost: boolean): AgentGrant => ({ id: 'g', name: 'g', member: owner.pub, role, via: 'token', createdAt: 0, expiresAt: null, canPost });
        const adminTool = AGENT_TOOLS.find((t) => t.name === 'tags_search');
        const adminAnswer = adminTool ? await adminTool.run(grant('admin', true), { q: 'lemon' }, 'b') : null;
        assert(!toolsFor(grant('admin', true)).some((t) => t.name === 'tags_search') && adminAnswer?.ok === false,
            `an admin's assistant has no tags_search, and is refused it in words (${adminAnswer?.ok === false ? adminAnswer.error : 'answered'})`);

        // ── 2. tags_search ───────────────────────────────────────────────────────────────────────────
        section('── 2. tags_search ──');
        const searched = async (args: Record<string, unknown>) => (structured(await call('tags_search', args))?.tags ?? []) as Array<{ id: string; label: string; path: string }>;
        const lemon = await searched({ q: 'lemon' });
        assert(lemon[0]?.id === 'food.fruit.lemon' && lemon[0]?.label === 'Lemon' && lemon[0]?.path === 'Food & Produce > Fruit > Lemon',
            `q finds the id, its English label and its path (${JSON.stringify(lemon[0])})`);
        assert((await searched({ q: 'citrus' })).some((t) => t.id === 'food.fruit.lime'), 'by an alias too');
        assert((await searched({ q: 'lemons' }))[0]?.id === 'food.fruit.lemon', 'an English plural finds its singular');
        const twoWords = (await searched({ q: 'fresh sourdough bread' })).map((t) => t.id);
        assert(twoWords.includes('food.bakery.sourdough') && twoWords.includes('food.bakery.bread'), `words the library has no one label for are looked up each (${twoWords.slice(0, 5).join(', ')})`);
        const inFood = await searched({ q: 'tree', limit: 50 });
        const inGarden = await searched({ q: 'tree', category: 'garden', limit: 50 });
        assert(inFood.some((t) => t.id.startsWith('food.')) && inGarden.length > 0 && inGarden.every((t) => t.id.startsWith('garden.')), `category narrows it (${inGarden.slice(0, 3).map((t) => t.id).join(', ')})`);
        assert((await searched({ q: 'tree', limit: 2 })).length === 2, 'limit holds');
        const tops = new Set(TAG_TOPS.map((t: TagDef) => t.id));
        assert(!(await searched({ q: 'food', limit: 50 })).some((t) => tops.has(t.id)), 'a top is never offered: the category is its own field');
        assert(PRICING_CATEGORIES.every((c) => tops.has(c.id)), 'every Market category is a top of the library, so `category` narrows every one');
        const none = structured(await call('tags_search', { q: 'zzqx' }));
        assert(none?.returned === 0 && /free_tags/.test(none?.note ?? ''), `nothing found says so, and that free_tags is for that (${none?.note})`);
        // The library has it, only not there: told "nothing matches", an assistant would type a free twin of a library tag.
        const elsewhere = structured(await call('tags_search', { q: 'lemon', category: 'tools' }));
        assert(elsewhere?.returned === 0 && /without category/.test(elsewhere?.note ?? '') && !/free_tags/.test(elsewhere?.note ?? ''),
            `a tag outside the category asked: the note says so, and never sends it to free_tags (${elsewhere?.note})`);
        const shortQ = await call('tags_search', { q: 'a' });
        const noQ = await call('tags_search', {});
        const badCategory = await call('tags_search', { q: 'lemon', category: 'weapons' });
        assert(shortQ.isError === true && /q is/.test(errorText(shortQ)) && noQ.isError === true && /q is/.test(errorText(noQ)) && badCategory.isError === true && /category must be one of/.test(errorText(badCategory)),
            `one letter, no q, or a made-up category → refused in words (${errorText(shortQ)} | ${errorText(badCategory)})`);

        // ── 3. both kinds carried ────────────────────────────────────────────────────────────────────
        section('── 3. both kinds carried ──');
        const both = { tags: ['food.fruit.lemon'], free_tags: ['#Home Grown', 'Meyer'] };
        const made = await call('create_offer', offer('Fruit from the old tree', both));
        const offerId = structured(made)?.postId as string;
        assert(row(offerId)?.tags === 'food.fruit.lemon' && row(offerId)?.free_tags === '["home grown","meyer"]',
            `create_offer stores each kind in its own column, the typed ones as core's rule stores them (${errorText(made) || JSON.stringify(row(offerId))})`);
        assert(row(offerId)?.created_via?.startsWith('assistant:') === true, 'still made by the assistant');
        const asRead = (await market(mia, `id=${offerId}`))[0];
        assert(JSON.stringify(asRead?.tags) === '["food.fruit.lemon"]' && JSON.stringify(asRead?.freeTags) === '["home grown","meyer"]',
            `the Market's read gives a member both (${JSON.stringify([asRead?.tags, asRead?.freeTags])})`);
        const need = await call('create_need', offer('Jars for marmalade', { tags: ['food.fruit.orange'], free_tags: ['wide mouth'] }));
        const needId = structured(need)?.postId as string;
        assert(row(needId)?.tags === 'food.fruit.orange' && row(needId)?.free_tags === '["wide mouth"]', `create_need carries both (${errorText(need)})`);
        const event = await call('create_event', inPerson('Citrus swap', { tags: ['food.fruit.mandarin'], free_tags: ['bring a bag'] }));
        const eventId = structured(event)?.postId as string;
        assert(row(eventId)?.tags === 'food.fruit.mandarin' && row(eventId)?.free_tags === '["bring a bag"]', `create_event carries both (${errorText(event)})`);
        const as_enterprise = enterpriseRef(bakery);
        const eOffer = await call('create_enterprise_listing', offer('Bakery rye', { kind: 'offer', as_enterprise, tags: ['food.bakery.sourdough'], free_tags: ['stone milled'] }));
        const eOfferId = structured(eOffer)?.postId as string;
        assert(row(eOfferId)?.tags === 'food.bakery.sourdough' && row(eOfferId)?.free_tags === '["stone milled"]', `an enterprise's Offer carries both (${errorText(eOffer)})`);
        const eNeed = await call('create_enterprise_listing', offer('Bakery flour', { kind: 'need', as_enterprise, tags: ['food.bakery.bread'], free_tags: ['by the sack'] }));
        const eNeedId = structured(eNeed)?.postId as string;
        assert(row(eNeedId)?.tags === 'food.bakery.bread' && row(eNeedId)?.free_tags === '["by the sack"]', `an enterprise's Need carries both (${errorText(eNeed)})`);
        const eEvent = await call('create_event', inPerson('Bakery open day', { as_enterprise, tags: ['food.bakery.sourdough'], free_tags: ['free tasting'] }));
        const eEventId = structured(eEvent)?.postId as string;
        assert(row(eEventId)?.tags === 'food.bakery.sourdough' && row(eEventId)?.free_tags === '["free tasting"]', `an enterprise's event carries both (${errorText(eEvent)})`);
        const plain = await call('create_offer', offer('Quince, no tags at all'));
        const plainId = structured(plain)?.postId as string;
        assert(row(plainId)?.tags === '' && row(plainId)?.free_tags === '', `a post with no tags is made as before (${errorText(plain) || 'made'})`);
        const nulled = await call('create_offer', offer('Medlars, tags sent as null', { tags: null, free_tags: null }));
        assert(!nulled.isError && row(structured(nulled)?.postId)?.tags === '', `a create that sends null for either is a post with none, as a client that fills every field sends (${errorText(nulled) || 'made'})`);

        // ── 4. refusals in the tool's words ──────────────────────────────────────────────────────────
        section('── 4. refusals in the tool\'s words ──');
        const postsBefore = postCount();
        const dayBefore = (await info())?.posts?.today;
        const typo = await call('create_offer', offer('Should not post', { tags: ['food.fruit.lemons'] }));
        const named = errorText(typo).match(/[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){1,2}/g)?.filter((id) => id !== 'food.fruit.lemons') ?? [];
        assert(typo.isError === true && /^tags: /.test(errorText(typo)) && errorText(typo).includes('"food.fruit.lemons"') && /tags_search/.test(errorText(typo)) && /free_tags/.test(errorText(typo)),
            `an unknown id is refused naming the field, the id, tags_search and free_tags (${errorText(typo)})`);
        assert(named.length === 3 && new Set(named).size === 3 && named.every(isTagId) && named[0] === 'food.fruit.lemon', `with the three nearest, real ids, the closest first (${named.join(', ')})`);
        const nearestOf = async (id: string): Promise<string[]> => {
            const r = await call('create_offer', offer('Should not post', { tags: [id] }));
            return (errorText(r).match(/[a-z][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*){1,2}/g) ?? []).filter((x) => x !== id);
        };
        assert((await nearestOf('food.fruit.lemmon'))[0] === 'food.fruit.lemon', 'a misspelt id: the closest spelling');
        assert((await nearestOf('sourdough'))[0] === 'food.bakery.sourdough', 'a plain word for an id: the tag it names');
        const made3 = await nearestOf('nothing.like.this-at-all');
        assert(made3.length === 3 && made3.every(isTagId), `an id like nothing still gets three real ones (${made3.join(', ')})`);
        const zzz = 'a'.repeat(5000);
        const huge = await call('create_offer', offer('Should not post', { tags: [zzz] }));
        assert(huge.isError === true && !errorText(huge).includes(zzz) && errorText(huge).length < 600, `an id of 5,000 characters is refused, cut short in the answer (${errorText(huge).length} characters)`);
        const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
            ['tags as one string', { tags: 'food.fruit.lemon' }, /^tags .*list/],
            ['an id that is not text', { tags: [7] }, /^tags .*list/],
            ['six library tags', { tags: ['food.fruit.lemon', 'food.fruit.lime', 'food.fruit.orange', 'food.fruit.mandarin', 'food.fruit.apple', 'food.fruit.pear'] }, /^tags: at most 5/],
            ['free_tags as one string', { free_tags: 'second hand' }, /^free_tags .*list/],
            ['a free tag that is not text', { free_tags: [7] }, /^free_tags .*list/],
            ['six free tags', { free_tags: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] }, /^free_tags: at most 5/],
            ['one letter', { free_tags: ['a'] }, /^free_tags: "a".*two letters or numbers/],
            ['31 characters', { free_tags: ['x'.repeat(31)] }, /^free_tags: "x+".*30 characters/],
            ['five words', { free_tags: ['one two three four five'] }, /^free_tags: "one two three four five".*four words/],
            ['a phone number', { free_tags: ['call 0412 345 678'] }, /^free_tags: "call 0412 345 678".*not a contact/],
            ['an email', { free_tags: ['me@example.org'] }, /^free_tags: .*not a contact/],
            ['a web address', { free_tags: ['example.com'] }, /^free_tags: .*not a contact/],
            ['an @handle', { free_tags: ['@olive'] }, /^free_tags: .*not a contact/],
            ['a comma', { free_tags: ['music, live'] }, /^free_tags: .*comma/],
            ['a hidden character', { free_tags: ['so​ft'] }, /^free_tags: .*hidden/],
            ['five tags too long together', { free_tags: ['"'.repeat(28) + 'aa', '"'.repeat(28) + 'bb', '"'.repeat(28) + 'cc', '"'.repeat(28) + 'dd', '"'.repeat(28) + 'ee'] }, /^free_tags: .*too long together/],
        ];
        for (const [label, extra, pattern] of refusals) {
            const r = await call('create_offer', offer('Should not post', extra));
            assert(r.isError === true && pattern.test(errorText(r)), `${label} → refused in the tool's words (${errorText(r).slice(0, 110)})`);
        }
        assert(postCount() === postsBefore && (await info())?.posts?.today === dayBefore, 'nothing was made and none of the day\'s posts were used');
        for (const [name, args] of [['create_need', offer('No', { tags: ['nope'] })], ['create_event', inPerson('No', { free_tags: ['a'] })], ['create_enterprise_listing', offer('No', { kind: 'offer', as_enterprise, tags: ['nope'] })]] as const) {
            const r = await call(name, args);
            assert(r.isError === true && /^(free_)?tags: /.test(errorText(r)), `${name} is held the same way (${errorText(r).slice(0, 80)})`);
        }
        assert(postCount() === postsBefore, 'and they made nothing either');
        // A refused tag comes before the photos: an address not fetched, an upload not used up, the day's photos not touched.
        const photosBefore = (await info())?.photos?.today;
        const upload = await fetch(`${BASE}/mcp/photos`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpeg) });
        const photoId = ((await upload.json()) as any)?.photoId as string;
        const photosNow = (await info())?.photos?.today;
        const uploadRefused = await call('create_offer', offer('Should not post', { photos: undefined, photo_ids: [photoId], tags: ['nope'] }));
        const addressRefused = await call('create_offer', offer('Should not post', { photos: undefined, photo_urls: ['https://example.invalid/a.jpg'], free_tags: ['a'] }));
        assert(uploadRefused.isError === true && /^tags: /.test(errorText(uploadRefused)) && addressRefused.isError === true && /^free_tags: /.test(errorText(addressRefused))
            && (await info())?.photos?.today === photosNow, `a tag refused before the photos: nothing fetched (${photosBefore} → ${photosNow}, the one upload)`);
        const uploadUsed = await call('create_offer', offer('Figs, with the photo the refused call held', { photos: undefined, photo_ids: [photoId], tags: ['food.fruit.fig'] }));
        assert(!uploadUsed.isError, `and the upload is still there for the next call (${errorText(uploadUsed) || 'made'})`);

        // ── 5. found by its tags' words ──────────────────────────────────────────────────────────────
        section('── 5. found by its tags\' words ──');
        const foundBy = async (q: string): Promise<string[]> => ((structured(await call('listings_search', { q, limit: 50 }))?.listings ?? []) as any[]).map((l) => l.postId);
        assert((await foundBy('lemon')).includes(offerId), 'a seeded listing is found by its tag\'s word, which is not in its title or description');
        assert((await foundBy('citrus')).includes(offerId), 'by the tag\'s alias');
        assert((await foundBy('fruit')).includes(offerId) && (await foundBy('meyer')).includes(offerId) && (await foundBy('grown')).includes(offerId), 'by a word above it, and by a free tag\'s words');
        const markedLemon = (await market(mia, `tags=${encodeURIComponent('food.fruit.lemon')}`)).map((p) => p.id);
        const markedFree = (await market(mia, `free=${encodeURIComponent('home grown')}`)).map((p) => p.id);
        assert(markedLemon.includes(offerId) && markedFree.includes(offerId) && !markedFree.includes(plainId), 'and by the Market\'s exact filters, tapped as a chip');
        assert((await market(mia, 'q=meyer')).some((p) => p.id === offerId), 'a member\'s own search finds it the same way');

        // ── 6. update_post ───────────────────────────────────────────────────────────────────────────
        section('── 6. update_post ──');
        const edit = (args: Record<string, unknown>) => call('update_post', { post_id: offerId, ...args });
        const noTags = await edit({ title: 'Fruit from the very old tree' });
        assert(!noTags.isError && row(offerId)?.title === 'Fruit from the very old tree' && row(offerId)?.tags === 'food.fruit.lemon' && row(offerId)?.free_tags === '["home grown","meyer"]',
            `an update that names no tags keeps both kinds (${errorText(noTags) || JSON.stringify(row(offerId))})`);
        assert((await foundBy('citrus')).includes(offerId) && (await foundBy('meyer')).includes(offerId), 'and it is still found by their words');
        const before = structured(noTags)?.editsToday as number;
        const onlyLibrary = await edit({ tags: ['food.fruit.apple'] });
        assert(!onlyLibrary.isError && row(offerId)?.tags === 'food.fruit.apple' && row(offerId)?.free_tags === '["home grown","meyer"]' && JSON.stringify(structured(onlyLibrary)?.changed) === '["tags"]',
            `one that names tags replaces them and leaves the typed ones (${errorText(onlyLibrary) || row(offerId)?.tags})`);
        assert((await foundBy('lemon')).every((id) => id !== offerId) && (await foundBy('apple')).includes(offerId), 'the old tag\'s word no longer finds it, the new one does');
        const onlyFree = await edit({ free_tags: ['Cox orange'] });
        assert(!onlyFree.isError && row(offerId)?.free_tags === '["cox orange"]' && row(offerId)?.tags === 'food.fruit.apple', `one that names free_tags leaves the library's (${errorText(onlyFree) || row(offerId)?.free_tags})`);
        assert((await foundBy('meyer')).every((id) => id !== offerId) && (await foundBy('cox')).includes(offerId), 'and the search moves with them');
        const clearedFree = await edit({ free_tags: [] });
        assert(!clearedFree.isError && row(offerId)?.free_tags === '' && row(offerId)?.tags === 'food.fruit.apple', `[] clears that kind alone (${errorText(clearedFree) || 'cleared'})`);
        const clearedLibrary = await edit({ tags: [], free_tags: ['heritage'] });
        assert(!clearedLibrary.isError && row(offerId)?.tags === '' && row(offerId)?.free_tags === '["heritage"]', `both at once (${errorText(clearedLibrary) || 'ok'})`);
        await edit({ tags: ['food.fruit.apple'] });
        const editsAt = (await edit({ free_tags: ['heritage', 'cider'] }));
        const counted = structured(editsAt)?.editsToday as number;
        assert(counted > before, `each counted as an edit (${before} → ${counted})`);
        for (const [label, args, pattern] of [
            ['tags: null', { tags: null }, /^tags .*\[\].*leave it out/],
            ['free_tags: null', { free_tags: null }, /^free_tags .*\[\].*leave it out/],
            ['an unknown id', { tags: ['food.fruit.apples'] }, /^tags: .*food\.fruit\.apple/],
            ['a contact', { free_tags: ['ring 0412 345 678'] }, /^free_tags: .*not a contact/],
            ['six free tags', { free_tags: ['aa', 'bb', 'cc', 'dd', 'ee', 'ff'] }, /^free_tags: at most 5/],
            ['a refused tag beside a good title', { title: 'Changed anyway', tags: ['nope'] }, /^tags: /],
        ] as const) {
            const r = await edit(args);
            assert(r.isError === true && pattern.test(errorText(r)) && row(offerId)?.tags === 'food.fruit.apple' && row(offerId)?.free_tags === '["heritage","cider"]' && row(offerId)?.title === 'Fruit from the very old tree',
                `${label} → refused in words, nothing changed (${errorText(r).slice(0, 90)})`);
        }
        const thenCounted = structured(await edit({ title: 'Fruit from the very old tree' }))?.editsToday as number;
        assert(thenCounted === counted + 1, `none of those counted as an edit (${counted} → ${thenCounted})`);
        const refusedPhoto = await edit({ photo_urls: ['https://example.invalid/b.jpg'], tags: ['nope'] });
        assert(refusedPhoto.isError === true && /^tags: /.test(errorText(refusedPhoto)), 'an edit\'s tags are held before its photos are fetched');
        // A tag the listing already carries passes, as in the apps, which send every field back: an id a newer library dropped, a
        // typed tag from before a stricter rule.
        db.prepare(`UPDATE posts SET tags = 'food.fruit.retired-kind', free_tags = '["x"]' WHERE id = ?`).run(offerId);
        const sentBack = await edit({ tags: ['food.fruit.retired-kind', 'food.fruit.pear'], free_tags: ['x', 'orchard'] });
        assert(!sentBack.isError && row(offerId)?.tags === 'food.fruit.retired-kind food.fruit.pear' && row(offerId)?.free_tags === '["x","orchard"]',
            `what a listing already carries is sent back and stays (${errorText(sentBack) || row(offerId)?.tags})`);
        const eventEdit = await call('update_post', { post_id: eventId, tags: ['food.fruit.lime'], free_tags: [] });
        assert(!eventEdit.isError && row(eventId)?.tags === 'food.fruit.lime' && row(eventId)?.free_tags === '', `an event's tags are edited too (${errorText(eventEdit) || 'edited'})`);
        const eventWrong = await call('update_post', { post_id: eventId, category: 'food' });
        assert(eventWrong.isError === true && /tags/.test(errorText(eventWrong)), `an event's refusal names tags among what it may send (${errorText(eventWrong)})`);
        const enterpriseEdit = await call('update_post', { post_id: eOfferId, free_tags: ['wood fired'] });
        assert(!enterpriseEdit.isError && row(eOfferId)?.free_tags === '["wood fired"]' && row(eOfferId)?.tags === 'food.bakery.sourdough', `an enterprise's listing too (${errorText(enterpriseEdit) || 'edited'})`);
        const nothing = await call('update_post', { post_id: offerId });
        assert(nothing.isError === true && /tags/.test(errorText(nothing)) && /free_tags/.test(errorText(nothing)), `no field at all: the refusal names them (${errorText(nothing)})`);

        // ── 7. my_posts ──────────────────────────────────────────────────────────────────────────────
        section('── 7. my_posts ──');
        const mine = (structured(await call('my_posts', { limit: 50 }))?.posts ?? []) as any[];
        const tagged = mine.find((p) => p.postId === offerId);
        const untagged = mine.find((p) => p.postId === plainId);
        assert(JSON.stringify(tagged?.tags) === '["food.fruit.retired-kind","food.fruit.pear"]' && tagged?.freeTags?.untrusted === true
            && /<<<MEMBER-TEXT [0-9a-f]{8}: post .+, free tags\./.test(tagged?.freeTags?.text ?? '') && /x, orchard/.test(tagged?.freeTags?.text ?? ''),
            `my_posts says what a post carries, its typed tags fenced (${JSON.stringify(tagged?.tags)})`);
        assert(JSON.stringify(untagged?.tags) === '[]' && untagged?.freeTags === null, 'none on a post with none');

        // The Market's own posts, made in the app, stay out of reach as before.
        const ownApp = createPost('offer', 'food', 'Olive\'s own jam, from the app', 'From the phone.', 2, 'fixed', owner.pub, -28.55, 153.5, [photo], false, undefined, undefined, { tags: ['food.fruit.apple'] })!.id;
        const notMine = await call('update_post', { post_id: ownApp, tags: [] });
        assert(notMine.isError === true && row(ownApp)?.tags === 'food.fruit.apple', `a post made in the app keeps its tags (${errorText(notMine)})`);
        await seeder.close().catch(() => {});
    } catch (e) {
        console.error(e);
        process.exitCode = 1;
    } finally {
        console.log(`\n${passed}/${run} passed`);
        process.exit(process.exitCode ?? 0);
    }
}

main().catch((e) => { console.error(e); console.log(`\n${passed}/${run} passed`); process.exit(1); });
