/**
 * A real node for the web Home check (apps/pwa/e2e/home-check.mjs; DESIGN-home-dashboard-fable.md slice H3), on the
 * local or the global profile. Not a suite: the check starts it, drives the web app it serves in Chromium, and stops it
 * by its PID. Everything the browser meets is the server's own code (GET /api/home, the preferences route, the signature
 * middleware, the socket's doorbells); only the data is seeded here, the way apps/server/src/test-home.ts seeds it.
 *
 * Localhost only: the server's socket guard (loopback-guard-test-harness) refuses any connection elsewhere, and a fetch to
 * another host is refused and logged (`BLOCKED-FETCH`). Pulse items have no thumbnail, so nothing is proxied.
 *
 * Env (set by the check): BEANPOOL_DATA_DIR (a fresh folder), FIXTURE_ROOT (a folder whose `public/` holds the web app
 * build), FIXTURE_PROFILE ('local' | 'global'), FIXTURE_MEMBERS (JSON `[{ "publicKey", "callsign", "joinedDaysAgo" }]`:
 * the browsers' own keys, made members here).
 *
 * Says `FIXTURE_READY {"port":N}` once listening. Takes one JSON request a line on stdin and answers one
 * `FIXTURE_ANSWER {"id":…,"ok":…,"result"|"error":…}` line:
 *   { op: 'sql', sql, params?, all? }   a statement on the node's database
 *   { op: 'post', title, category? }    a new offer by another member, as the node stores and rings it
 *   { op: 'resetLimits' }               the gateway and auth limiters start again
 *
 * Run by the check as: node --import tsx ../pwa/e2e/home-node-harness.ts (cwd apps/server).
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.GOOGLE_CLIENT_IDS;
delete process.env.APPLE_CLIENT_IDS;
delete process.env.BEANPOOL_VAULT_TICKET_KEYS;

import readline from 'node:readline';
import crypto from 'node:crypto';
import { LOOPBACK, installLoopbackGuard } from '../../server/src/loopback-guard-test-harness.js';

installLoopbackGuard();
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === 'https://api.github.com') {
        return new Response(JSON.stringify({ tag_name: 'v0.0.1', html_url: '', body: '', published_at: '' }), { status: 200 });
    }
    if (!LOOPBACK.has(url.hostname)) {
        console.error(`BLOCKED-FETCH ${url.origin}`);
        throw new Error(`home-node-harness: no requests leave this machine (${url.origin})`);
    }
    return realFetch(input, init);
}) as typeof fetch;

const say = (line: string) => process.stdout.write(`${line}\n`);
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const BYRON = { lat: -28.6, lng: 153.6 };
const key = () => crypto.randomBytes(32).toString('hex');

async function main(): Promise<void> {
    const root = process.env.FIXTURE_ROOT;
    if (!root) throw new Error('FIXTURE_ROOT is not set');
    const profile = process.env.FIXTURE_PROFILE === 'global' ? 'global' : 'local';
    const browsers = JSON.parse(process.env.FIXTURE_MEMBERS || '[]') as { publicKey: string; callsign: string; joinedDaysAgo?: number }[];
    process.chdir(root);

    const { initTls } = await import('../../server/src/services/tls.js');
    const se = await import('../../server/src/state-engine.js');
    const { startHttpsServer } = await import('../../server/src/https-server.js');
    const { db } = await import('../../server/src/db/db.js');
    const { pruneAuthAttempts } = await import('../../server/src/auth-rate-limit.js');
    const { resetGatewayRateLimit } = await import('../../server/src/gateway-rate-limit.js');
    const { lockedDm } = await import('../../server/src/dm-test-payload.js');

    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    // As the global node runs, once listening (its background jobs, the directory's mirror among them, stay off).
    if (profile === 'global') process.env.NODE_PROFILE = 'global';

    const owner = key();
    se.seedGenesisMember(owner, 'Olive');
    db.prepare('UPDATE members SET joined_at = ? WHERE public_key = ?').run(ago(120), owner);
    const member = (pk: string, callsign: string, joinedDaysAgo: number, opts: { avatar?: boolean; area?: { lat: number; lng: number } } = {}) => {
        db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, avatar_url, area_lat, area_lng)
                    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
            .run(pk, callsign, ago(joinedDaysAgo), owner, `INV-${callsign.toUpperCase()}`, opts.avatar ? TINY_PNG : null, opts.area?.lat ?? null, opts.area?.lng ?? null);
        db.prepare('INSERT OR REPLACE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(pk);
        return pk;
    };
    for (const b of browsers) member(b.publicKey, b.callsign, b.joinedDaysAgo ?? 1);
    const kofi = member(key(), 'Kofi', 3, { avatar: true, area: { lat: BYRON.lat + 0.02, lng: BYRON.lng } });
    const mere = member(key(), 'Mere', 2, { avatar: true, area: { lat: BYRON.lat - 0.05, lng: BYRON.lng + 0.03 } });
    const tama = member(key(), 'Tama', 60, { avatar: true, area: BYRON });
    se.reconcileLedgerFromDb();

    const beans = profile === 'local';
    const post = (author: string, type: 'offer' | 'need' | 'event', category: string, title: string, credits: number, extra: Record<string, unknown> = {}, at = BYRON) =>
        se.createPost(type, category, title, `${title}. Ask me anything.`, beans && type !== 'event' ? credits : 0, 'fixed', author,
            at.lat + 0.01, at.lng + 0.01, type === 'event' ? undefined : [TINY_PNG], false, undefined, false, extra as any);
    post(tama, 'offer', 'garden', 'Seedlings to give away', 0);
    // A Need comes after the member's own first Offer (the node's rule).
    post(tama, 'need', 'tools', 'Borrow a drill for an afternoon', 5);
    post(kofi, 'offer', 'arts', 'Pottery lessons on Sundays', 20);
    post(kofi, 'offer', 'food', 'Sourdough loaves', 12);
    post(mere, 'event', 'general', 'Seed swap', 0, {
        eventStartAt: new Date(Date.now() + 2 * DAY).toISOString(), eventEndAt: new Date(Date.now() + 2 * DAY + 2 * 3600_000).toISOString(),
        eventPlaceName: 'Town Hall',
    });

    if (profile === 'local' && browsers[0]) {
        const me = browsers[0].publicKey;
        // Waiting on the member: a message from Kofi, unread; a vote that closes in 20 hours. And a group they keep.
        const dm = se.createConversation('dm', [kofi, me], kofi);
        if (dm) { const line = lockedDm(); se.sendMessage(dm.id, kofi, line.ciphertext, line.nonce); }
        db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, status, opens_at, closes_at)
                    VALUES ('dec-home-web', ?, 'A new compost bay', 'At the community garden', 'pool', 'grant', '1m1v', 'open', ?, ?)`)
            .run(tama, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() + 20 * 3600_000).toISOString());
        se.createGroup({ name: 'Garden group', createdBy: me });
        // The Pulse: two items from Kofi's channel, no thumbnail (nothing proxied from elsewhere).
        db.prepare(`INSERT INTO creator_channels (id, owner_pubkey, platform, url, category, created_at, updated_at)
                    VALUES ('chan-home-web', ?, 'rss', 'https://blog.example.org/feed', 'food', ?, ?)`).run(kofi, ago(0), ago(0));
        for (const [i, title, cat] of [[1, 'How our LETS started', 'education'], [2, 'Bread for the whole street', 'food']] as const) {
            db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, external_id, url, title, thumbnail_url, published_at, category, source, muted, curated, created_at, updated_at)
                        VALUES (?, 'chan-home-web', ?, 'rss', ?, ?, ?, NULL, ?, ?, 'autolist', 0, 0, ?, ?)`)
                .run(`item-home-web-${i}`, kofi, `ext-${i}`, `https://blog.example.org/${i}`, title, new Date(Date.now() - i * 3600_000).toISOString(), cat, ago(0), ago(0));
        }
    }
    if (profile === 'global') {
        // The directory the global node mirrors, as its cache holds it: two communities near Byron.
        const row = db.prepare(`INSERT INTO directory_cache (community_key, listed, name, node_url, lat, lng, radius_km, member_count, first_seen_at, updated_at)
                                VALUES (?, 1, ?, ?, ?, ?, 10, ?, ?, ?)`);
        row.run('community-byron', 'Byron Shire BeanPool', 'https://byron.example.org', -28.64, 153.61, 40, ago(30), ago(1));
        row.run('community-lismore', 'Lismore Commons', 'https://lismore.example.org', -28.81, 153.28, 25, ago(30), ago(1));
    }

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', (line) => {
        let id: unknown = null;
        try {
            const req = JSON.parse(line);
            id = req.id;
            let result: unknown = null;
            switch (req.op) {
                case 'sql': {
                    const stmt = db.prepare(String(req.sql));
                    const params = Array.isArray(req.params) ? req.params : [];
                    result = req.all ? stmt.all(...params) : stmt.run(...params);
                    break;
                }
                case 'post': {
                    const p = post(kofi, 'offer', String(req.category ?? 'food'), String(req.title), 8);
                    result = { id: p?.id ?? null };
                    break;
                }
                case 'resetLimits':
                    resetGatewayRateLimit();
                    pruneAuthAttempts(Date.now() + 3600_000);
                    break;
                default:
                    throw new Error(`no op ${String(req.op)}`);
            }
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: true, result })}`);
        } catch (e) {
            say(`FIXTURE_ANSWER ${JSON.stringify({ id, ok: false, error: (e as Error)?.message || String(e) })}`);
        }
    });
    say(`FIXTURE_READY ${JSON.stringify({ port })}`);
}

main().catch((e) => {
    console.error('home-node-harness failed to start:', e);
    process.exit(1);
});
