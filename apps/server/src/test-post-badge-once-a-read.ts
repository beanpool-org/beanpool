/**
 * A member's board read works out each author's badge once, not once a post, and says exactly what it said before.
 *
 * Found in the global node's load model (scratch/global-node/LOAD-MODEL-2026-10-05.md, CPU profile): the author's trust
 * profile behind each post card's badge (rowToPost → getMemberTrustProfile → getMemberTrustStats) was 6.3% of the
 * node's CPU, worked out again for every post on the page, on the market, the map, the phone's sync and Home's market
 * card. A read now keeps the badges it has worked out, by author, for the rest of that read only (getPosts'
 * tierByAuthor): the read runs at one database state, so an author's badge is the same for each of their posts. Nothing
 * is kept between reads, so a change shows at the next one.
 *
 * Boots the real server on the global profile and reads through the real middleware over HTTPS, signed as a member:
 *   1. The same bytes, through several states (tiers set, trades completed, a line frozen, a vouch, a tier taken back):
 *      for the board, a deep page, the map, a sync read and a category, each post's badge is the author's badge worked
 *      out fresh at that state, and the body is that, byte for byte.
 *   2. What a read works out: a warm board read of 60 posts by 12 authors works out each author's trust profile once
 *      (on origin/main once a post: 60).
 *   3. The CPU of a member's board read, over 100 reads in this process (client included), printed, with no bound.
 *
 * On origin/main section 2 fails; section 1 passes there by design (it pins the bytes).
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-post-badge-once-a-read.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
process.env.NODE_PROFILE = 'global';

import crypto from 'node:crypto';
import fs from 'node:fs';
import { localFetch } from './keepalive-test-fetch.js';

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
function signedHeaders(id: Id, method: string, path: string, body = ''): Record<string, string> {
    const ts = String(Date.now()), nonce = crypto.randomBytes(16).toString('hex');
    const sig = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${body}`), id.privateKey).toString('base64');
    return { 'X-Public-Key': id.pubKeyHex, 'X-Signature': sig, 'X-Timestamp': ts, 'X-Nonce': nonce };
}

async function main() {
    console.log("A member's board read works out each author's badge once...\n");
    const { initTls } = await import('./services/tls.js');
    const se: any = await import('./state-engine.js');
    const { startHttpServer } = await import('./http-server.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { initAdminPassword, updateGatewayConfig, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
    const { db } = await import('./db/db.js');
    const { getMemberTrustProfile } = await import('@beanpool/engine');
    const { tierForCredit } = await import('@beanpool/core');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const httpPort = await startHttpServer(0);
    await startHttpsServer(0);
    const BASE = `http://127.0.0.1:${httpPort}`;
    updateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, rateLimiting: { enabled: false, maxRequestsPerMinute: 120 } });

    const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, ?, 'active', ?, 'seed', 'seed')`);
    const insertAccount = db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)');
    const authors: Id[] = [];
    for (let i = 0; i < 12; i++) {
        const id = keypair();
        insertMember.run(id.pubKeyHex, `Badge${i}`, iso(-(60 + i) * 86_400_000));
        insertAccount.run(id.pubKeyHex);
        authors.push(id);
    }
    const reader = keypair();
    insertMember.run(reader.pubKeyHex, 'BadgeReader', iso(-90 * 86_400_000));
    insertAccount.run(reader.pubKeyHex);

    const insertPost = db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at,
                active, status, lat, lng) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 1, 'active', ?, ?)`);
    const cats = ['food', 'goods', 'services', 'skills', 'housing', 'transport'];
    const postIds: string[] = [];
    for (let i = 0; i < 60; i++) {
        const id = `pbo-post-${i}`;
        const at = iso(-i * 60_000);
        insertPost.run(id, i % 4 === 3 ? 'need' : 'offer', cats[i % cats.length], `Listing ${i}`, `A listing for the badge suite, number ${i}.`,
            authors[i % 12].pubKeyHex, at, at, -28.55 + ((i * 37) % 100) / 100 - 0.5, 153.5 + ((i * 53) % 100) / 100 - 0.5);
        postIds.push(id);
    }
    const insertTrade = db.prepare(`INSERT INTO marketplace_transactions (id, post_id, buyer_pubkey, seller_pubkey, credits, status, created_at, completed_at)
                VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`);
    let trades = 0;
    const trade = (seller: number, buyer: number, credits: number) =>
        insertTrade.run(`pbo-trade-${trades++}`, postIds[seller], authors[buyer].pubKeyHex, authors[seller].pubKeyHex, credits, iso(-86_400_000), iso(-86_400_000));

    async function memberRead(query: Record<string, string> = {}): Promise<{ status: number; text: string }> {
        const qs = new URLSearchParams(query).toString();
        const path = `/api/marketplace/posts${qs ? `?${qs}` : ''}`;
        const res = await localFetch(`${BASE}${path}`, { headers: { 'cf-connecting-ip': '198.51.100.9', ...signedHeaders(reader, 'GET', path) } });
        return { status: res.status, text: await res.text() };
    }
    // Each author's badge worked out fresh, as rowToPost did for every post before this change.
    const badgeOf = (pk: string) => { try { return tierForCredit(getMemberTrustProfile(db, pk).tierCredit).minCredit; } catch { return 0; } };

    // Every time a trust profile is worked out: getMemberTrustStats' first statement, run once a profile.
    const Statement = Object.getPrototypeOf(db.prepare('SELECT 1')) as { get: (...a: unknown[]) => unknown };
    const realGet = Statement.get;
    let profiles = 0;
    Statement.get = function (this: { source: string }, ...args: unknown[]) {
        if (this.source === 'SELECT joined_at FROM members WHERE public_key = ?') profiles++;
        return realGet.apply(this, args);
    };

    console.log('— 1. the same bytes, through several states —');
    const reads: Array<[string, Record<string, string>]> = [
        ['the board', {}],
        ['a deep page', { limit: '20', offset: '25' }],
        ['the map, nearest first', { lat: '-28.55', lng: '153.5' }],
        ['a sync read', { sync: 'true', limit: '200' }],
        ['a category', { category: 'food' }],
    ];
    const states: Array<[string, () => void]> = [
        ['as seeded', () => {}],
        ['tiers set', () => { se.adminSetTier(authors[0].pubKeyHex, 'Resident'); se.adminSetTier(authors[1].pubKeyHex, 'Steward'); }],
        ['trades completed', () => { for (let i = 0; i < 30; i++) trade(2 + (i % 5), (i + 7) % 12, 40 + i * 7); }],
        ['a line frozen', () => { db.prepare('UPDATE members SET credit_frozen = 1 WHERE public_key = ?').run(authors[2].pubKeyHex); }],
        ['a vouch', () => { db.prepare('UPDATE members SET elder_vouched_by = ?, vouch_credit = 50 WHERE public_key = ?').run(authors[0].pubKeyHex, authors[9].pubKeyHex); }],
        ['a tier taken back', () => { se.adminSetTier(authors[1].pubKeyHex, 'Newcomer'); }],
    ];
    const seenBadges = new Set<number>();
    for (const [state, change] of states) {
        change();
        for (const [what, query] of reads) {
            const got = await memberRead(query);
            let posts: any[] = [];
            try { posts = JSON.parse(got.text); } catch { /* the assert below says so */ }
            const list = Array.isArray(posts) ? posts : [];
            for (const p of list) if (typeof p.authorEnergyCycled === 'number') seenBadges.add(p.authorEnergyCycled);
            const fresh = list.map(p => ({ ...p, authorEnergyCycled: badgeOf(p.authorPublicKey) }));
            const want = JSON.stringify(fresh);
            assert(got.status === 200 && list.length > 0 && got.text === want,
                `${state}, ${what}: every badge is the author's worked out fresh, byte for byte (${got.status}, ${list.length} posts, ${got.text.length} bytes)`);
        }
    }
    assert(seenBadges.size >= 3, `the reads carried several different badges (${[...seenBadges].sort((a, b) => a - b).join(', ')})`);

    console.log("\n— 2. what a member's board read works out —");
    await memberRead({ limit: '60' });
    profiles = 0;
    const board = await memberRead({ limit: '60' });
    const worked = profiles;
    const onPage = JSON.parse(board.text) as any[];
    const authorsOnPage = new Set(onPage.map(p => p.authorPublicKey)).size;
    assert(board.status === 200 && onPage.length === 60 && authorsOnPage === 12,
        `the board read holds 60 posts by 12 authors (${onPage.length} posts, ${authorsOnPage} authors)`);
    // The reader's own standing may be read once by the route; nothing else works out a profile.
    assert(worked >= authorsOnPage && worked <= authorsOnPage + 1,
        `a warm board read of 60 posts by 12 authors works out ${worked} trust profiles (once an author; on origin/main once a post, 60)`);

    console.log("\n— 3. the CPU a member's board read costs —");
    const cpu: number[] = [];
    for (let r = 0; r < 100; r++) {
        const c0 = process.cpuUsage();
        await memberRead({ limit: '60' });
        const c = process.cpuUsage(c0);
        cpu.push((c.user + c.system) / 1000);
    }
    const sorted = [...cpu].sort((x, y) => x - y);
    const line = `a member's board read of 60 posts by 12 authors: ${worked} profiles worked out; median ${sorted[50].toFixed(2)} ms, p90 ${sorted[90].toFixed(2)} ms of CPU (client included)`;
    console.log(`  ${line}`);
    // For a before/after: the runner keeps no log of a suite that passes.
    if (process.env.BADGE_SUITE_REPORT) fs.appendFileSync(process.env.BADGE_SUITE_REPORT, line + '\n');

    Statement.get = realGet;
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
