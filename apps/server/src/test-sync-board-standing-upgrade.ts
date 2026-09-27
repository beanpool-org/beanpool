/**
 * The upgrade to members.board_standing_changed_at leaves no phone with a wrong Market (card f8, 2026-09-27).
 *
 * The Market delta's author half read members.updated_at before this version and reads members.board_standing_changed_at
 * from it (engine posts.ts getPosts). Phones hold cursors from before the upgrade, so the node fills the column once, as
 * it gains it (db.ts backfillBoardStanding): the upgrade's time for a member off the board then, their updated_at for
 * everyone else.
 *
 * The fixture is a node from before the column (a booted node with the column, its index, its trigger and its one-time
 * marker taken away) holding, from before the upgrade:
 *   - Hana, on holiday since two hours ago, and Farm, an enterprise paused two hours ago;
 *   - Ben, away then and back since half an hour ago, and Olly, whose row last changed two hours ago;
 * each with an offer, and Carol's phones, whose next delta asks from an hour ago. One phone is from a node that never read
 * the author's row (before #1238): it holds all four offers live. The other is from a node that did: it holds Hana's,
 * Farm's and Ben's as paused (it synced while Ben was away) and Olly's live.
 *
 * Booted on this version, over real HTTP:
 *   - the column is filled: Hana's and Farm's with the upgrade's time, Ben's and Olly's with their updated_at; no
 *     updated_at moves, and the marker is written;
 *   - Carol's next delta carries Hana's and Farm's offers as paused, Ben's live, and not Olly's; after it each phone's
 *     Market is the board. An unsigned delta from the same cursor carries the same offers;
 *   - after the upgrade, Ben's bio edit moves no standing: a delta from just before it doesn't carry his offer.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-sync-board-standing-upgrade.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function signedHeaders(method: string, urlPath: string, body: string, id: Id): Record<string, string> {
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${body}`;
    return {
        'X-Public-Key': id.pubKeyHex,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
}

async function getJson(urlPath: string, id: Id | null): Promise<any[]> {
    const res = await fetch(`${BASE}${urlPath}`, { headers: id ? signedHeaders('GET', urlPath, '', id) : {} });
    if (res.status !== 200) throw new Error(`GET ${urlPath} → ${res.status} ${await res.text()}`);
    return res.json() as Promise<any[]>;
}

async function postJson(urlPath: string, payload: unknown, id: Id): Promise<number> {
    const body = JSON.stringify(payload);
    const res = await fetch(`${BASE}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...signedHeaders('POST', urlPath, body, id) },
        body,
    });
    await res.text();
    return res.status;
}

/** The phone's feed query (apps/native utils/events.ts EVENT_TYPES_QUERY). */
const TYPES = 'types=offer,need,poll,event';
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60_000;

async function main() {
    console.log('The upgrade to members.board_standing_changed_at leaves no phone with a wrong Market...\n');
    const dir = process.env.BEANPOOL_DATA_DIR;
    if (!dir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');

    // ── The fixture: a node from before the column ──
    // Booted on this version in its own process (the database module is one per process), then rolled back.
    fs.mkdirSync(dir, { recursive: true });
    const script = path.join(dir, 'boot.mjs');
    fs.writeFileSync(script, `
        import { initSchema } from ${JSON.stringify(path.join(__dirname, 'db', 'db.ts'))};
        initSchema();
        console.log('BOOT_OK');
    `);
    const booted = execFileSync('pnpm', ['exec', 'tsx', script], {
        cwd: path.join(__dirname, '..'), env: { ...process.env, BEANPOOL_DATA_DIR: dir }, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!booted.includes('BOOT_OK')) throw new Error(`the fixture's first boot failed: ${booted}`);

    const carol = keypair(), hana = keypair(), ben = keypair(), olly = keypair();
    const farm = crypto.randomBytes(32).toString('hex');
    const seeded = {
        hana: ago(120 * MIN), farm: ago(120 * MIN), ben: ago(30 * MIN), olly: ago(120 * MIN), carol: ago(180 * MIN),
    };
    const cursor = ago(60 * MIN);
    const offers: Record<string, string> = {};
    {
        const d = new Database(path.join(dir, 'state.db'));
        d.pragma('foreign_keys = OFF');
        d.exec(`DROP TRIGGER IF EXISTS members_touch_board_standing; DROP INDEX IF EXISTS idx_members_board_standing_changed_at;`);
        try { d.exec('ALTER TABLE members DROP COLUMN board_standing_changed_at'); } catch { /* a tree from before it: never had it */ }
        d.prepare("DELETE FROM node_config WHERE key = 'migration_board_standing_v1'").run();
        const hasColumn = (d.prepare('PRAGMA table_info(members)').all() as Array<{ name: string }>).some(c => c.name === 'board_standing_changed_at');
        assert(!hasColumn, 'the fixture is a node from before members.board_standing_changed_at');
        const member = d.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url, updated_at, is_treasury, paused, paused_at)
                                  VALUES (?, ?, 'active', ?, 'seed', ?, 'data:image/png;base64,iVBORw0KGgo=', ?, ?, ?, ?)`);
        const joined = ago(365 * 86_400_000);
        member.run(carol.pubKeyHex, 'ReaderCarol', joined, 'INV-CAROL', seeded.carol, 0, 0, null);
        member.run(hana.pubKeyHex, 'HolidayHana', joined, 'INV-HANA', seeded.hana, 0, 0, null);
        member.run(ben.pubKeyHex, 'BackBen', joined, 'INV-BEN', seeded.ben, 0, 0, null);
        member.run(olly.pubKeyHex, 'OtherOlly', joined, 'INV-OLLY', seeded.olly, 0, 0, null);
        member.run(farm, 'PausedFarm', joined, null, seeded.farm, 1, 1, seeded.farm);
        const pref = d.prepare(`INSERT INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'holiday_mode', ?)`);
        pref.run(hana.pubKeyHex, 'true');
        pref.run(ben.pubKeyHex, 'false');
        // With search keywords, as every listing posted has them: the boot's keyword backfill writes (and so stamps) a row
        // that has none (state-engine.ts backfillSearchKeywords).
        const post = d.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, status, active, created_at, updated_at, search_keywords)
                                VALUES (?, 'offer', 'food', ?, '', 5, ?, 'active', 1, ?, ?, lower(?))`);
        for (const [who, key, title] of [['hana', hana.pubKeyHex, 'Lemons'], ['farm', farm, 'Eggs'], ['ben', ben.pubKeyHex, 'Bread'], ['olly', olly.pubKeyHex, 'Firewood']]) {
            offers[who] = crypto.randomUUID();
            post.run(offers[who], title, key, ago(240 * MIN), ago(240 * MIN), title);
        }
        d.close();
    }

    // ── The upgrade: this version boots on it, and serves ──
    const upgradedAt = new Date().toISOString();
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    console.log('── the column, filled once ──');
    const row = (key: string) => db.prepare('SELECT * FROM members WHERE public_key = ?').get(key) as Record<string, any>;
    const standing = (key: string) => row(key).board_standing_changed_at as string | undefined;
    assert((standing(hana.pubKeyHex) ?? '') >= upgradedAt && (standing(farm) ?? '') >= upgradedAt,
        `Hana (on holiday) and Farm (paused), off the board at the upgrade, have its time (${standing(hana.pubKeyHex)}, ${standing(farm)})`);
    assert(standing(ben.pubKeyHex) === seeded.ben && standing(olly.pubKeyHex) === seeded.olly,
        `Ben (back on the board) and Olly have their updated_at (${standing(ben.pubKeyHex)}, ${standing(olly.pubKeyHex)})`);
    const stamps = [[hana.pubKeyHex, seeded.hana], [farm, seeded.farm], [ben.pubKeyHex, seeded.ben], [olly.pubKeyHex, seeded.olly], [carol.pubKeyHex, seeded.carol]];
    assert(stamps.every(([key, at]) => row(key).updated_at === at), 'no member\'s updated_at moves: the fill stamps no row for delta sync');
    assert(!!db.prepare("SELECT 1 FROM node_config WHERE key = 'migration_board_standing_v1'").get(), 'the one-time marker is written');

    console.log('\n── Carol\'s next delta, from her cursor before the upgrade ──');
    const since = `&updatedAfter=${encodeURIComponent(cursor)}`;
    const delta = await getJson(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}${since}`, carol);
    const statusIn = (rows: any[], id: string) => rows.find(r => r.id === id)?.status as string | undefined;
    assert(statusIn(delta, offers.hana) === 'paused' && statusIn(delta, offers.farm) === 'paused',
        `it carries Hana's and Farm's offers as paused (${statusIn(delta, offers.hana)}, ${statusIn(delta, offers.farm)})`);
    assert(statusIn(delta, offers.ben) === 'active', `and Ben's, live (${statusIn(delta, offers.ben)})`);
    assert(statusIn(delta, offers.olly) === undefined, 'and not Olly\'s, which nothing changed since her cursor');

    const ours = new Set(Object.values(offers));
    const title = (id: string) => (db.prepare('SELECT title FROM posts WHERE id = ?').get(id) as any)?.title;
    const show = (s: Iterable<string>) => [...s].map(title).sort().join(', ');
    const board = new Set((await getJson(`/api/marketplace/posts?limit=200&${TYPES}`, carol)).map(p => p.id as string).filter(id => ours.has(id)));
    const phones: Array<[string, Record<string, string>]> = [
        ['a phone from a node before #1238', { hana: 'active', farm: 'active', ben: 'active', olly: 'active' }],
        ['a phone from a node with #1238', { hana: 'paused', farm: 'paused', ben: 'paused', olly: 'active' }],
    ];
    for (const [which, held] of phones) {
        const rows = new Map(Object.entries(held).map(([who, status]) => [offers[who], status]));
        for (const r of delta) if (ours.has(r.id)) rows.set(r.id, r.status);
        const market = new Set([...rows].filter(([, status]) => status === 'active').map(([id]) => id));
        assert(market.size === board.size && [...market].every(id => board.has(id)),
            `${which}: after that delta its Market is the board (board: ${show(board)} | phone: ${show(market)})`);
    }
    const open = await getJson(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}${since}`, null);
    const carried = (rows: any[]) => rows.map(r => r.id as string).filter(id => ours.has(id)).sort().join(',');
    assert(carried(open) === carried(delta), `an unsigned delta from the same cursor carries the same offers (${show(open.map(r => r.id).filter(id => ours.has(id)))})`);

    console.log('\n── after the upgrade ──');
    const beforeBio = new Date(Date.now() - 1).toISOString();
    await new Promise(r => setTimeout(r, 5));
    const edited = await postJson('/api/profile/update', { bio: 'Bakes on Fridays' }, ben);
    assert(edited === 200 && row(ben.pubKeyHex).updated_at > seeded.ben && standing(ben.pubKeyHex) === seeded.ben,
        `Ben edits his bio over HTTP: his updated_at moves, his standing doesn't (${edited}, ${standing(ben.pubKeyHex)})`);
    const afterBio = await getJson(`/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(beforeBio)}`, null);
    assert(!afterBio.some(r => r.id === offers.ben), 'a delta from just before it doesn\'t carry his offer');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The upgrade leaves no phone with a wrong Market.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
