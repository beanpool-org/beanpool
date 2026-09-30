/**
 * A phone that synced before a node's listing-photo URLs changed gets every listing again at its next sync.
 *
 * A local community serves a listing's photo only to a URL carrying its key (PR #1286, engine/photo-keys.ts). The phone
 * keeps the photo URLs it was handed in its own copy of the listings and syncs by cursor (`updatedAfter`, apps/native
 * services/pillar-sync.ts): the node sends it only the listings that changed. Keying the photos changed every URL and
 * no listing, so a phone that synced before kept the keyless URLs for good, and every thumbnail went blank (test node,
 * 2026-09-30). The same happens whenever the URLs change shape: keys switched off again, or a new secret (a restore
 * from a backup older than it). So the boot that changes the shape records when (node_config.photoKeysSince) and a sync
 * whose cursor is older is answered with every listing.
 *
 * Every node boot is a REAL server in its own process (its own process group) on one data dir, over real HTTPS through
 * the real signature middleware; the phone is played by the core request builder the apps use, and asks exactly what
 * the phone's sync asks (`limit=1000&sync=true&types=…`, its cursor the time of its last sync less five minutes).
 *
 *  1. Keys off (ENFORCE_READ_AUTH=false), a new node: it records the open shape and nothing to heal (no photo yet, so
 *     no sync is answered whole for it). Alice lists three offers with a photo (their times set back an hour, so a
 *     cursor from now leaves them out). The phone syncs whole: keyless URLs that open. It also asks its next delta once,
 *     so it holds that URL's ETag.
 *  2. Restart with keys on (the default). photoKeysSince is recorded, later than the phone's last sync. The phone's
 *     next delta, with the old cursor, answers every listing, each URL keyed and opening (200), where the keyless URLs
 *     it held are 404. The same delta URL sent with the ETag it held is answered 200 in full, never a 304. A phone whose
 *     cursor is newer than photoKeysSince gets a normal delta: only the listing edited since.
 *  3. Restart with nothing changed: both records are kept (photoKeysSince set back ten minutes before it, standing in
 *     for time passing). The phone's next delta is a delta again: the edited listings only.
 *  4. The secret gone (a restore from a backup older than it), restart: a new secret, a new photoKeysSince, and the
 *     phone's next delta answers every listing with new keys; the old keyed URLs are 404.
 *  5. Keys off again, restart: every listing again, keyless, each opening.
 *  6. A standby (NODE_ROLE=backup) promoted by hand: its first boot as the main server is a new shape (a phone that
 *     synced from the server it replaced holds that server's URLs), so every listing again, keyed, each opening.
 *
 * Past 200 listings (review of b7b96309, finding 1), each on a data dir of its own, keys off then on. A heal answer is
 * the delta as main sends it, then at most PHOTO_HEAL_PAGE_ROWS (200) listings more (review of a6b65b84, finding 2: a
 * phone on a slow link must fit one answer in its 30 s budget); the delta each answer should carry is read in the node
 * with main's own read (`deltaIds`), so the heal part of an answer is what is left.
 *  7. 260 listings with a photo, the oldest of them Hank's, who goes on holiday after the phone's last sync: the phone's
 *     next sync carries its delta (Hank's listing paused) and 200 more; the sync after it, 30 s later and still inside
 *     the phone's five-minute overlap, the other 60: all 260 healed, keyed. The sync after that is a delta again.
 *  8. 150 live listings with a photo and 100 newer finished ones: the phone's next sync heals all 150 live ones, and the
 *     finished ones over the next. A listing for Cara alone reaches Cara's heal and not Bob's: each reader's own
 *     audience, as a first sync.
 *  9. 1,500 listings, 1,450 with a photo, three of them edited after the phone's last sync: a phone that syncs every
 *     30 s through the five-minute overlap after the change (review of a6b65b84, finding 1) gets each heal page once,
 *     never the same page again, and no answer is past the delta plus 200 rows or 250 KB. A sync whose answer never
 *     arrived (the same cursor again) gets that same page, not the one after it, and never the first page again. A
 *     restart that changes nothing keeps the heal going. All 1,450 healed over eight syncs; then only deltas, and the
 *     heal's record goes. Cara's phone, syncing every ten minutes (past the overlap from its second sync), heals all
 *     1,450 too, a retry again getting the same page.
 *
 * 10. A take-over that finishes at boot promotes a standby in the same process (services/takeover.ts
 *     resumeTakeoverAtBoot, after the state engine recorded the standby's shape): the phone's old cursor heals at once,
 *     with no restart after (finding 2).
 *
 * A key's other device, and a pull the phone throws away (review of fe4c27ce, finding 1). Simulated phones, each holding
 * the keyless URLs of every listing, on a node whose photoKeysSince is set two hours back:
 * 11. Two phones on one key sync in turn, every 30 s each and 15 s apart, from just after the change; once with the
 *     second phone the last to sync before the change, once with the first. 40 and 150 listings: neither keeps a stale
 *     URL. 600: each gets the first page and one of the two after it. And when the first phone syncs once and stops,
 *     the second heals all 600.
 * 12. An epoch-aware phone after a take-over: its first pull (old cursor) is answered and thrown away, then it pulls
 *     whole with no cursor (the 200 listings updated last), then syncs every 30 s. 600 live listings with a photo, 100
 *     newer finished ones with a photo and 50 without: all 700 with a photo heal.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-photo-keys-resync.ts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const PW = 'Photo-Keys-Resync-Pw-6613!';
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+n1z9zwAAAABJRU5ErkJggg==';
const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

// ── The node process ───────────────────────────────────────────────────────────────────────

function reply(msg: Record<string, unknown>): void {
    process.stdout.write('@@ ' + JSON.stringify(msg) + '\n');
}

async function child(): Promise<void> {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    delete process.env.CF_API_TOKEN;
    delete process.env.CF_ZONE_ID;
    const { initAdminPassword } = await import('./config/local-config.js');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    const { db } = await import('./db/db.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    if (process.env.PKR_PROMOTE_IN_PROCESS === '1') {
        // A take-over's "role" step finished at this boot, after the state engine read the role as a standby's
        // (index.ts: initStateEngine, then resumeTakeoverAtBoot), as test-schema-upgrade plays it.
        const { updateLocalConfig } = await import('./config/local-config.js');
        const { resumeTakeoverAtBoot } = await import('./services/takeover.js');
        updateLocalConfig({ nodeRole: 'primary' });
        resumeTakeoverAtBoot();
    }
    const port = await startHttpsServer(0);
    const row = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

    const commands: Record<string, (a: any) => unknown> = {
        seed: (a: { owner: { pk: string; callsign: string }; members: { pk: string; callsign: string }[] }) => {
            se.seedGenesisMember(a.owner.pk, a.owner.callsign);
            db.prepare("INSERT OR IGNORE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'owner', 'genesis')").run(a.owner.pk);
            for (const m of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at, invited_by, invite_code, avatar_url)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now', '-30 days'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', ?, ?)`)
                    .run(m.pk, m.callsign, `INV-${m.callsign.toUpperCase()}`, TINY_PNG);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(m.pk);
            }
            return true;
        },
        // The listings, their photos and their authors' standing an hour older (or `minutesAgo`): a cursor from now leaves
        // them out.
        backdate: (a: { minutesAgo?: number }) => {
            const ago = new Date(Date.now() - (a.minutesAgo ?? 60) * MIN).toISOString();
            db.prepare('UPDATE posts SET created_at = ?, updated_at = ?').run(ago, ago);
            db.prepare('UPDATE post_photos SET updated_at = ?').run(ago);
            db.prepare('UPDATE members SET board_standing_changed_at = ?').run(ago);
            return ago;
        },
        records: () => ({ shape: row('photoKeysShape'), since: row('photoKeysSince'), secret: row('photoKeySecret') }),
        // `count` listings like `template` (its photo rows too, when `photo`), by `author`, each a minute older than the one
        // before from `newestMinutesAgo`, with `status` (and `active` 1 while it is open), and audience `direct` to
        // `target` when given. Their authors' standing is from the same hour. Returns their ids, newest first.
        bulk: (a: { template: string; author: string; count: number; newestMinutesAgo: number; status?: string; photo?: boolean; prefix: string; target?: string }) => {
            const cols = (db.prepare('PRAGMA table_info(posts)').all() as { name: string }[]).map((c) => c.name);
            const set: Record<string, string> = {
                id: '@id', title: '@title', author_pubkey: '@author', created_at: '@at', updated_at: '@at', status: '@status', active: '@active',
                ...(a.target ? { audience_scope: "'direct'", target_pubkey: '@target' } : {}),
            };
            const copy = db.prepare(`INSERT INTO posts (${cols.join(', ')}) SELECT ${cols.map((c) => set[c] ?? c).join(', ')} FROM posts WHERE id = @template`);
            const photos = db.prepare(`INSERT INTO post_photos (post_id, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime)
                                       SELECT ?, photo_data, order_num, updated_at, storage_key, sha256, bytes, mime FROM post_photos WHERE post_id = ?`);
            const ids: string[] = [];
            const status = a.status ?? 'active';
            db.transaction(() => {
                for (let i = 0; i < a.count; i++) {
                    const pid = `${a.prefix}-${String(i).padStart(5, '0')}`;
                    const at = new Date(Date.now() - (a.newestMinutesAgo + i) * MIN).toISOString();
                    copy.run({ id: pid, title: `${a.prefix} ${i}`, author: a.author, at, status, active: status === 'active' ? 1 : 0, template: a.template, ...(a.target ? { target: a.target } : {}) });
                    if (a.photo !== false) photos.run(pid, a.template);
                    ids.push(pid);
                }
            })();
            return ids;
        },
        // These listings' times set to `minutesAgo`.
        setTime: (a: { ids: string[]; minutesAgo: number }) => {
            const at = new Date(Date.now() - a.minutesAgo * MIN).toISOString();
            const put = db.prepare('UPDATE posts SET created_at = ?, updated_at = ? WHERE id = ?');
            for (const pid of a.ids) put.run(at, at, pid);
            return at;
        },
        holiday: (a: { pk: string; on: boolean }) => se.setHolidayMode(a.pk, a.on).ok,
        heals: () => db.prepare('SELECT COUNT(*) AS n FROM photo_url_heals').get(),
        // Every listing's photo URLs as `pk`'s sync reads it now: what a healed phone holds.
        photosFor: (a: { pk: string }) => Object.fromEntries(se.getPosts({
            types: ['offer', 'need', 'poll', 'event'], excludeEvents: false, viewerPubkey: a.pk, includeHidden: !!se.nodeRoleOf(a.pk),
            includeVoters: true, beansOnly: false, sync: true,
        } as Parameters<typeof se.getPosts>[0]).map((p) => [p.id, p.photos ?? []])),
        // The ids of the delta main sends the phone's pull (its types, sync, a member's read) for `updatedAfter`: what a
        // heal answer carries first.
        deltaIds: (a: { pk: string; updatedAfter: string }) => se.getPosts({
            types: ['offer', 'need', 'poll', 'event'], excludeEvents: false, viewerPubkey: a.pk, includeHidden: !!se.nodeRoleOf(a.pk),
            includeVoters: true, beansOnly: false, limit: 200, offset: 0, updatedAfter: a.updatedAfter, sync: true,
        } as Parameters<typeof se.getPosts>[0]).map((p) => p.id),
        // Time passing, as the node's records see it: photoKeysSince moved back by `ms`, read at the next boot.
        ageSince: (a: { ms: number }) => {
            const since = row('photoKeysSince');
            if (!since) return null;
            const aged = new Date(Date.parse(since) - a.ms).toISOString();
            db.prepare("UPDATE node_config SET value = ? WHERE key = 'photoKeysSince'").run(aged);
            return aged;
        },
        // A restore from a backup made before the node had its secret.
        dropSecret: () => db.prepare("DELETE FROM node_config WHERE key = 'photoKeySecret'").run().changes,
        resetLimits: () => {
            resetGatewayRateLimit();
            pruneAuthAttempts(Date.now() + 120_000);
            return true;
        },
    };

    const rl = readline.createInterface({ input: process.stdin });
    rl.on('line', async (line) => {
        let id = 0;
        try {
            const msg = JSON.parse(line);
            id = msg.id;
            const fn = commands[msg.cmd];
            if (!fn) throw new Error(`no such command ${msg.cmd}`);
            reply({ reply: id, result: await fn(msg.args || {}) });
        } catch (e: any) {
            reply({ reply: id, error: e?.message || String(e) });
        }
    });
    rl.on('close', () => process.exit(0));
    reply({ ready: true, port });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

interface Node {
    port: number;
    proc: ChildProcess;
    output: () => string;
    send: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
}

const started: Node[] = [];
let seq = 0;

/** One boot of the node, on the one data dir, in its own process group so teardown kills exactly what it started. */
function boot(env: Record<string, string | undefined>, dir = 'node'): Promise<Node> {
    const dataDir = path.join(process.env.BEANPOOL_DATA_DIR!, dir);
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ADMIN_PASSWORD: PW };
    for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'ENFORCE_WS_AUTH', 'ENFORCE_READ_AUTH', 'NODE_PROFILE', 'NODE_ROLE', 'PKR_PROMOTE_IN_PROCESS']) delete childEnv[k];
    Object.assign(childEnv, env);
    const proc = spawn(process.execPath, [...process.execArgv, SCRIPT, '--child'], { env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let out = '';
    const waiting = new Map<number, (m: any) => void>();
    const rl = readline.createInterface({ input: proc.stdout! });
    return new Promise((resolve, reject) => {
        rl.on('line', (line) => {
            out += line + '\n';
            if (!line.startsWith('@@ ')) return;
            const msg = JSON.parse(line.slice(3));
            if (msg.ready) {
                const node: Node = {
                    port: msg.port, proc, output: () => out,
                    send: (cmd, args = {}) => new Promise((res, rej) => {
                        const id = ++seq;
                        waiting.set(id, (m) => {
                            waiting.delete(id);
                            if (m.error) rej(new Error(`${cmd}: ${m.error}`)); else res(m.result);
                        });
                        proc.stdin!.write(JSON.stringify({ id, cmd, args }) + '\n');
                    }),
                };
                started.push(node);
                resolve(node);
            } else if (typeof msg.reply === 'number') {
                waiting.get(msg.reply)?.(msg);
            }
        });
        proc.stderr!.on('data', (d) => { out += d.toString(); });
        proc.on('exit', (code) => reject(new Error(`the node exited (${code}) before it was ready\n${out.slice(-3000)}`)));
    });
}

/** Stops a boot as Docker does (SIGTERM to its group), and waits for it to be gone. */
async function stop(node: Node): Promise<void> {
    if (node.proc.exitCode !== null || node.proc.signalCode !== null) return;
    const gone = new Promise<void>((r) => node.proc.once('exit', () => r()));
    try { process.kill(-node.proc.pid!, 'SIGTERM'); } catch { /* already gone */ }
    const timer = setTimeout(() => { try { process.kill(-node.proc.pid!, 'SIGKILL'); } catch { /* gone */ } }, 8000);
    await gone;
    clearTimeout(timer);
}

function stopAll(): void {
    for (const n of started) {
        try { if (n.proc.pid && n.proc.exitCode === null && n.proc.signalCode === null) process.kill(-n.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
}

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

async function section(n: string, body: () => Promise<void>): Promise<void> {
    console.log(`\n── ${n} ──`);
    try {
        await body();
    } catch (e: any) {
        assert(false, `section ${n} ran to the end (${e?.stack || e})`);
    }
}

interface Reply { status: number; body: any; text: string; etag: string | null }

function call(node: Node, method: string, reqPath: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
    return new Promise((resolve) => {
        const req = https.request({
            host: 'localhost', port: node.port, path: reqPath, method, rejectUnauthorized: false,
            headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let parsed: any = null;
                try { parsed = JSON.parse(text); } catch { parsed = text; }
                const etag = res.headers.etag;
                resolve({ status: res.statusCode || 0, body: parsed, text, etag: typeof etag === 'string' ? etag : null });
            });
        });
        req.on('error', (e) => resolve({ status: 0, body: { networkError: e.message }, text: '', etag: null }));
        if (body !== undefined) req.write(body);
        req.end();
    });
}
const show = (r: Reply) => `${r.status} ${r.text.slice(0, 160)}`;

async function main(): Promise<void> {
    if (process.argv.includes('--child')) return child();
    if (!process.env.BEANPOOL_DATA_DIR) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const core = await import('@beanpool/core');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    type Id = { pk: string; sign: ReturnType<typeof core.ed25519Signer>; callsign: string };
    const id = (callsign: string): Id => {
        const seed = new Uint8Array(crypto.randomBytes(32));
        return { pk: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'), sign: core.ed25519Signer(seed), callsign };
    };
    const owner = id('Olive'), alice = id('Alice'), bob = id('Bob'), cara = id('Cara'), hank = id('Hank');
    const dan = id('Dan'), eve = id('Eve');

    /** A request as a current app signs it (format 2, for the host it connects to), sent to the node. */
    async function signed(node: Node, who: Id, method: string, reqPath: string, payload?: unknown, extra: Record<string, string> = {}): Promise<Reply> {
        const body = payload === undefined ? '' : JSON.stringify(payload);
        const headers = await core.buildBoundRequestHeaders({ method, url: `https://localhost:${node.port}${reqPath}`, body, publicKeyHex: who.pk, sign: who.sign });
        return call(node, method, reqPath, { ...headers, ...extra }, payload === undefined ? undefined : body);
    }

    // The phone's posts pull (services/pillar-sync.ts), with its cursor: its last sync less five minutes.
    const TYPES = 'types=offer%2Cneed%2Cpoll%2Cevent';
    const pullPath = (lastSync: number | null) => `/api/marketplace/posts?limit=1000&sync=true&${TYPES}`
        + (lastSync === null ? '' : `&updatedAfter=${encodeURIComponent(new Date(lastSync - 5 * MIN).toISOString())}`);
    const pull = (node: Node, who: Id, lastSync: number | null, extra: Record<string, string> = {}) => signed(node, who, 'GET', pullPath(lastSync), undefined, extra);
    const ours = (r: Reply) => (Array.isArray(r.body) ? r.body : []).filter((p: any) => listingIds.includes(p.id));
    const idsOf = (r: Reply) => ours(r).map((p: any) => p.id).sort();
    const photoOf = (r: Reply, postId: string) => ours(r).find((p: any) => p.id === postId)?.photos?.[0] as string | undefined;
    const keyed = (u: string | undefined) => !!u && /[?&]k=[A-Za-z0-9_-]{22}$/.test(u);
    /** Every URL as an <img> asks it: unsigned. */
    const opens = async (node: Node, urls: (string | undefined)[]) => {
        const statuses: number[] = [];
        for (const u of urls) statuses.push(u ? (await call(node, 'GET', u)).status : 0);
        return statuses;
    };
    const listingIds: string[] = [];

    let node!: Node;
    let lastSync = 0;
    let heldUrls: (string | undefined)[] = [];
    let heldEtag: string | null = null;
    let heldDeltaPath = '';
    let since2 = '';

    try {
        await section('1. keys off: the phone holds keyless URLs', async () => {
            node = await boot({ ENFORCE_READ_AUTH: 'false' });
            const fresh = await node.send('records');
            assert(fresh.shape === 'open' && fresh.since === new Date(0).toISOString(),
                `a new node, with no listing photo yet, records the open shape and nothing to heal (${fresh.shape} ${fresh.since})`);
            await node.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [alice, bob, cara].map((m) => ({ pk: m.pk, callsign: m.callsign })) });
            for (const title of ['Resync lemons', 'Resync ladder', 'Resync seedlings']) {
                await node.send('resetLimits');
                const made = await signed(node, alice, 'POST', '/api/marketplace/posts', {
                    type: 'offer', category: 'other', title, description: `${title}, a test offer`, authorPublicKey: alice.pk,
                    lat: -28.5, lng: 153.5, photos: [TINY_PNG],
                });
                assert(made.status === 200 && made.body?.post?.id, `Alice lists "${title}" with a photo (${show(made)})`);
                if (made.body?.post?.id) listingIds.push(made.body.post.id);
            }
            await node.send('backdate');
            const whole = await pull(node, bob, null);
            assert(whole.status === 200 && idsOf(whole).length === 3, `the phone's first sync reads all three listings (${whole.status}, ${idsOf(whole).length})`);
            heldUrls = listingIds.map((pid) => photoOf(whole, pid));
            assert(heldUrls.length === 3 && heldUrls.every((u) => !!u && !u.includes('k=')), `with keys off, their photo URLs carry no key (${heldUrls[0]})`);
            const statuses = await opens(node, heldUrls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `and each opens (${statuses.join(', ')})`);
            lastSync = Date.now();
            // Its next delta, asked once here: the phone's HTTP cache keeps this URL's ETag and sends it by itself.
            await new Promise((r) => setTimeout(r, 5));
            heldDeltaPath = pullPath(lastSync);
            const delta = await signed(node, bob, 'GET', heldDeltaPath);
            heldEtag = delta.etag;
            assert(delta.status === 200 && !!heldEtag, `the phone's delta URL answers with an ETag (${delta.status} ${heldEtag})`);
            await stop(node);
        });

        await section('2. keys on: the next delta answers every listing, keyed', async () => {
            node = await boot({});
            const rec = await node.send('records');
            since2 = rec.since;
            assert(typeof rec.shape === 'string' && rec.shape.startsWith('keyed:') && !rec.shape.includes(rec.secret),
                `the node records the URLs' shape as keyed, and not its secret (${rec.shape})`);
            assert(!!rec.since && Date.parse(rec.since) > lastSync, `and photoKeysSince, later than the phone's last sync (${rec.since})`);

            const old = await opens(node, heldUrls);
            assert(old.length === 3 && old.every((s) => s === 404), `the keyless URLs the phone holds are 404 now (${old.join(', ')})`);

            const next = await pull(node, bob, lastSync);
            assert(next.status === 200 && idsOf(next).length === 3,
                `the phone's next sync, by its old cursor, reads every listing, as a first sync would (${next.status}, ${idsOf(next).length} of 3)`);
            const urls = listingIds.map((pid) => photoOf(next, pid));
            assert(urls.length === 3 && urls.every(keyed), `each with a keyed photo URL (${urls.join(' ')})`);
            const statuses = await opens(node, urls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `and each opens (${statuses.join(', ')})`);

            const revalidated = await signed(node, bob, 'GET', heldDeltaPath, undefined, heldEtag ? { 'If-None-Match': heldEtag } : {});
            assert(revalidated.status === 200 && idsOf(revalidated).length === 3 && listingIds.every((pid) => keyed(photoOf(revalidated, pid))),
                `the delta URL the phone asked before, sent with the ETag it holds, is answered 200 in full, never a 304 (${revalidated.status}, ${idsOf(revalidated).length})`);
            if (revalidated.etag) {
                const again = await signed(node, bob, 'GET', heldDeltaPath, undefined, { 'If-None-Match': revalidated.etag });
                assert(again.status === 304, `that full answer's own ETag confirms it (${again.status}): a platform cache then hands back the full body`);
            }

            // Another phone, whose cursor is newer than photoKeysSince, gets a delta: only what changed since.
            await node.send('resetLimits');
            const edit = await signed(node, alice, 'POST', '/api/marketplace/posts/update', { id: listingIds[0], title: 'Resync lemons, edited', authorPublicKey: alice.pk });
            assert(edit.status === 200, `Alice edits her first listing (${show(edit)})`);
            const newer = await signed(node, cara, 'GET', `/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(new Date(Date.parse(since2) + 1).toISOString())}`);
            assert(newer.status === 200 && idsOf(newer).join() === [listingIds[0]].join(),
                `a phone whose cursor is newer than photoKeysSince gets a normal delta: the edited listing only (${idsOf(newer).length})`);
            assert(keyed(photoOf(newer, listingIds[0])), 'with its keyed URL');

            heldUrls = urls;
            lastSync = Date.now();
            // Ten minutes pass, as the node's records see it (read at the next boot).
            await node.send('ageSince', { ms: 10 * MIN });
            await stop(node);
        });

        await section('3. a restart that changes nothing: the next sync is a delta again', async () => {
            node = await boot({});
            const rec = await node.send('records');
            assert(rec.since === new Date(Date.parse(since2) - 10 * MIN).toISOString() && rec.shape?.startsWith('keyed:'),
                `the restart keeps photoKeysSince and the shape as they were (${rec.since})`);
            await node.send('resetLimits');
            const edit = await signed(node, alice, 'POST', '/api/marketplace/posts/update', { id: listingIds[1], title: 'Resync ladder, edited', authorPublicKey: alice.pk });
            assert(edit.status === 200, `Alice edits her second listing (${show(edit)})`);
            const next = await pull(node, bob, lastSync);
            assert(next.status === 200 && idsOf(next).join() === [listingIds[0], listingIds[1]].sort().join(),
                `the phone's next sync is a delta again: the two edited listings, not the third (${idsOf(next).length})`);
            const statuses = await opens(node, heldUrls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `the keyed URLs it holds still open (${statuses.join(', ')})`);
            lastSync = Date.now();
            assert(await node.send('dropSecret') === 1, 'setup: the secret is gone, as after a restore from a backup older than it');
            await stop(node);
        });

        await section('4. a new secret: every listing again, with new keys', async () => {
            node = await boot({});
            const rec = await node.send('records');
            assert(!!rec.since && Date.parse(rec.since) > lastSync, `a new secret records a new photoKeysSince (${rec.since})`);
            const old = await opens(node, heldUrls);
            assert(old.length === 3 && old.every((s) => s === 404), `the URLs keyed with the old secret are 404 (${old.join(', ')})`);
            const next = await pull(node, bob, lastSync);
            const urls = listingIds.map((pid) => photoOf(next, pid));
            assert(next.status === 200 && idsOf(next).length === 3 && urls.every(keyed) && urls.every((u, i) => u !== heldUrls[i]),
                `the phone's next sync reads every listing, with new keys (${idsOf(next).length} of 3)`);
            const statuses = await opens(node, urls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `and each opens (${statuses.join(', ')})`);
            lastSync = Date.now();
            await stop(node);
        });

        await section('5. keys off again: every listing again, keyless', async () => {
            node = await boot({ ENFORCE_READ_AUTH: 'false' });
            const rec = await node.send('records');
            assert(rec.shape === 'open' && !!rec.since && Date.parse(rec.since) > lastSync, `the shape is open, and photoKeysSince moves (${rec.since})`);
            const next = await pull(node, bob, lastSync);
            const urls = listingIds.map((pid) => photoOf(next, pid));
            assert(next.status === 200 && idsOf(next).length === 3 && urls.every((u) => !!u && !u.includes('k=')),
                `the phone's next sync reads every listing, keyless (${idsOf(next).length} of 3)`);
            const statuses = await opens(node, urls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `and each opens (${statuses.join(', ')})`);
            lastSync = Date.now();
            await stop(node);
        });

        await section('6. a standby promoted to main server: every listing again', async () => {
            // Keys on again, and the phone synced from this main server since.
            node = await boot({});
            const synced = await pull(node, bob, lastSync);
            assert(synced.status === 200 && idsOf(synced).length === 3 && listingIds.every((pid) => keyed(photoOf(synced, pid))),
                `setup: keys on again, the phone reads every listing keyed (${idsOf(synced).length} of 3)`);
            lastSync = Date.now();
            await node.send('ageSince', { ms: 10 * MIN }); // ten minutes pass
            await stop(node);
            node = await boot({ NODE_ROLE: 'backup' });
            const standby = await node.send('records');
            assert(typeof standby.shape === 'string' && standby.shape.startsWith('keyed:') && standby.shape.endsWith('@standby'),
                `a standby records its shape as a standby's (${standby.shape})`);
            await stop(node);
            node = await boot({});
            const rec = await node.send('records');
            assert(rec.shape?.startsWith('keyed:') && !rec.shape.endsWith('@standby') && Date.parse(rec.since) > lastSync,
                `its first boot as the main server is a new shape, with a new photoKeysSince (${rec.shape} ${rec.since})`);
            const next = await pull(node, bob, lastSync);
            const urls = listingIds.map((pid) => photoOf(next, pid));
            assert(next.status === 200 && idsOf(next).length === 3 && urls.length === 3 && urls.every(keyed),
                `a phone that synced from the server it replaced reads every listing, keyed (${idsOf(next).length} of 3)`);
            const statuses = await opens(node, urls);
            assert(statuses.length === 3 && statuses.every((s) => s === 200), `and each opens (${statuses.join(', ')})`);
            await stop(node);
        });

        // ── Past 200 listings (finding 1 of the review of b7b96309) ──
        const rowsOf = (r: Reply): any[] => (Array.isArray(r.body) ? r.body : []);
        const pause = () => new Promise((r) => setTimeout(r, 5));
        /** A node on data dir `dir`, keys off: Olive, Alice, Bob, Cara and Hank, and Alice's one listing with a photo. */
        const freshNode = async (dir: string): Promise<string> => {
            node = await boot({ ENFORCE_READ_AUTH: 'false' }, dir);
            await node.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [alice, bob, cara, hank].map((m) => ({ pk: m.pk, callsign: m.callsign })) });
            await node.send('resetLimits');
            const made = await signed(node, alice, 'POST', '/api/marketplace/posts', {
                type: 'offer', category: 'other', title: 'Template', description: 'Template, a test offer', authorPublicKey: alice.pk,
                lat: -28.5, lng: 153.5, photos: [TINY_PNG],
            });
            assert(made.status === 200 && made.body?.post?.id, `setup: Alice lists one offer with a photo (${show(made)})`);
            await node.send('backdate');
            return made.body?.post?.id;
        };
        /** How many of `ids` the answers carry with a keyed photo URL. */
        const healedIn = (answers: Reply[], ids: string[]) => {
            const byId = new Map<string, any>();
            for (const r of answers) for (const p of rowsOf(r)) byId.set(p.id, p);
            return ids.filter((pid) => keyed(byId.get(pid)?.photos?.[0])).length;
        };

        /** The delta main sends `who`'s pull for the phone's last sync `lastSync`: what a heal answer carries first. */
        const deltaOf = async (who: Id, lastSync: number): Promise<Set<string>> =>
            new Set(await node.send('deltaIds', { pk: who.pk, updatedAfter: new Date(lastSync - 5 * MIN).toISOString() }));
        /** The ids an answer carries past its delta: its heal page. */
        const healPart = (r: Reply, delta: Set<string>) => rowsOf(r).map((p) => p.id as string).filter((pid) => !delta.has(pid));
        const PAGE = 200;
        const bytesOf = (r: Reply) => Buffer.byteLength(r.text);

        await section('7. 260 listings: the next two syncs heal every one, and each carries what the delta would', async () => {
            const template = await freshNode('many');
            const more: string[] = await node.send('bulk', { template, author: alice.pk, count: 258, newestMinutesAgo: 61, prefix: 'many' });
            // Hank's one listing, the oldest on the node.
            const hanks: string[] = await node.send('bulk', { template, author: hank.pk, count: 1, newestMinutesAgo: 2000, prefix: 'hank' });
            const all = [template, ...more, ...hanks];
            assert(all.length === 260, `setup: 260 listings with a photo (${all.length})`);
            await pull(node, bob, null); // the phone's first sync (it holds what it holds: the node can't tell)
            const synced = Date.now();
            await pause();
            assert(await node.send('holiday', { pk: hank.pk, on: true }) === true, "Hank goes on holiday after the phone's last sync");
            await stop(node);

            node = await boot({}, 'many');
            const delta = await deltaOf(bob, synced);
            const next = await pull(node, bob, synced);
            const page1 = healPart(next, delta);
            assert(next.status === 200 && delta.has(hanks[0]) && rowsOf(next).slice(0, delta.size).every((p) => delta.has(p.id)),
                `the phone's next sync carries the delta first, as main sends it (${next.status}, ${delta.size} rows, Hank's among them)`);
            assert(page1.length > 0 && page1.length <= PAGE, `and at most ${PAGE} listings past it (${page1.length}, ${rowsOf(next).length} rows in all)`);
            const hankRow = rowsOf(next).find((p) => p.id === hanks[0]);
            assert(hankRow?.status === 'paused', `Hank's listing, the oldest, arrives paused, as the delta carries it (${hankRow?.status})`);
            // The phone finished that sync; its next, 30 s on, is still inside its five-minute overlap.
            const lastSync = Date.now();
            const second = await pull(node, bob, lastSync);
            const page2 = healPart(second, await deltaOf(bob, lastSync));
            const healed = healedIn([next, second], all);
            assert(second.status === 200 && healed === 260 && !page2.some((pid) => page1.includes(pid)),
                `the sync after it carries the rest, none of the first page again: all 260 healed, each keyed (${healed} of 260, ${page2.length} more)`);
            const byId = new Map<string, { photos?: string[] }>([...rowsOf(next), ...rowsOf(second)].map((p) => [p.id, p]));
            const sample = [all[0], all[100], all[200], all[259]].map((pid) => byId.get(pid)?.photos?.[0]);
            const statuses = await opens(node, sample);
            assert(statuses.length === 4 && statuses.every((st) => st === 200), `a sample of them opens (${statuses.join(', ')})`);
            // Ten minutes on (the phone's cursor past photoKeysSince): a delta again.
            const later = await pull(node, bob, Date.now() + 10 * MIN);
            assert(later.status === 200 && rowsOf(later).length === 0, `the sync after that is a delta again: nothing changed since (${rowsOf(later).length})`);
            await stop(node);
        });

        await section('8. 150 live listings and 100 newer finished ones: every live one heals first', async () => {
            const template = await freshNode('mix');
            await node.send('setTime', { ids: [template], minutesAgo: 400 });
            const live: string[] = [template, ...await node.send('bulk', { template, author: alice.pk, count: 149, newestMinutesAgo: 200, prefix: 'live' })];
            const done: string[] = await node.send('bulk', { template, author: alice.pk, count: 50, newestMinutesAgo: 61, status: 'completed', prefix: 'done' });
            const gone: string[] = await node.send('bulk', { template, author: alice.pk, count: 50, newestMinutesAgo: 111, status: 'cancelled', prefix: 'gone' });
            const forCara: string[] = await node.send('bulk', { template, author: alice.pk, count: 1, newestMinutesAgo: 70, prefix: 'cara', target: cara.pk });
            assert(live.length === 150 && done.length + gone.length === 100, `setup: 150 live listings with a photo, 100 newer finished ones (${live.length}, ${done.length + gone.length})`);
            await pull(node, bob, null);
            const synced = Date.now();
            await stop(node);

            node = await boot({}, 'mix');
            const next = await pull(node, bob, synced);
            assert(next.status === 200 && healedIn([next], live) === 150,
                `the phone's next sync heals all 150 live listings (${next.status}, ${healedIn([next], live)} of 150)`);
            const lastSync = Date.now();
            const second = await pull(node, bob, lastSync);
            assert(healedIn([next, second], [...done, ...gone]) === 100,
                `and the 100 finished ones after them, over its next sync too (${healedIn([next, second], [...done, ...gone])})`);
            assert(![...rowsOf(next), ...rowsOf(second)].some((p) => p.id === forCara[0]), "a listing for Cara alone is not in Bob's: his own audience, as his first sync");
            const caras = await pull(node, cara, synced);
            assert(healedIn([caras], forCara) === 1 && healedIn([caras], live) === 150, `and it is in Cara's, with every live one (${healedIn([caras], forCara)}, ${healedIn([caras], live)})`);
            await stop(node);
        });

        await section('9. 1,500 listings: a phone syncing every 30 s gets each heal page once, a lost answer again', async () => {
            const template = await freshNode('big');
            await node.send('setTime', { ids: [template], minutesAgo: 3000 });
            // With no photo, and newer than every listing with one: a newest-first page would start with them.
            const bare: string[] = await node.send('bulk', { template, author: alice.pk, count: 50, newestMinutesAgo: 61, photo: false, prefix: 'bare' });
            const photoIds: string[] = [template, ...await node.send('bulk', { template, author: alice.pk, count: 1449, newestMinutesAgo: 111, prefix: 'big' })];
            assert(photoIds.length === 1450 && bare.length === 50, `setup: 1,500 listings, 1,450 with a photo and 50 without (${photoIds.length}, ${bare.length})`);
            await pull(node, bob, null);
            await pull(node, cara, null);
            const synced = Date.now();
            await pause();
            // Three listings edited after the phones' last sync: the delta each heal answer carries first.
            const edited = [photoIds[5], photoIds[700], photoIds[1400]];
            await node.send('setTime', { ids: edited, minutesAgo: 0 });
            await stop(node);

            node = await boot({}, 'big');
            const sinceMs = Date.parse((await node.send('records')).since);
            assert(sinceMs > synced, `setup: photoKeysSince is later than the phones' last sync (${new Date(sinceMs).toISOString()})`);

            // Bob's phone: its first sync after the change by its old cursor, then one every 30 s, each a success (its
            // cursor, its last sync less five minutes, moves only then). The first ten are older than photoKeysSince.
            const received: Reply[] = [];
            const pages: string[][] = [];
            const deltas: Set<string>[] = [];
            let lastSync = synced;
            let overlapBytes = 0, overlapSyncs = 0, lost: string[] = [], retried: string[] = [], retriedSame = false;
            for (let k = 0; k < 14; k++) {
                if (k === 5) {
                    // A restart that changes nothing, between two of its syncs.
                    await stop(node);
                    node = await boot({}, 'big');
                }
                const delta = await deltaOf(bob, lastSync);
                if (k === 3) {
                    // This answer never reaches the phone (its 30 s ran out): the phone asks again with the same cursor.
                    const dropped = await pull(node, bob, lastSync);
                    lost = healPart(dropped, delta);
                    const again = await pull(node, bob, lastSync);
                    retried = healPart(again, delta);
                    retriedSame = again.text === dropped.text;
                }
                const r = await pull(node, bob, lastSync);
                if (lastSync - 5 * MIN < sinceMs) { overlapBytes += bytesOf(r); overlapSyncs++; }
                received.push(r); deltas.push(delta); pages.push(healPart(r, delta));
                assert(r.status === 200, `sync ${k + 1} answers (${r.status})`);
                lastSync = sinceMs + k * 30_000 + 1000;
            }
            console.log(`   heal pages: ${pages.map((p) => p.length).join(', ')}; bytes: ${received.map(bytesOf).join(', ')}; the ${overlapSyncs} syncs inside the overlap carried ${overlapBytes} bytes`);
            const maxRows = Math.max(...received.map((r, i) => rowsOf(r).length - deltas[i].size));
            const maxBytes = Math.max(...received.map(bytesOf));
            assert(received.every((r, i) => rowsOf(r).length <= deltas[i].size + PAGE && pages[i].length <= PAGE),
                `no answer carries more than its delta and ${PAGE} listings (at most ${maxRows} past the delta)`);
            assert(maxBytes < 250_000, `the largest answer is under 250 KB (${maxBytes} bytes)`);
            assert(deltas[0].size >= 3 && edited.every((pid) => rowsOf(received[0]).slice(0, deltas[0].size).some((p) => p.id === pid)),
                `the first answer starts with the delta, the three edited listings in it (${deltas[0].size})`);
            const seen = new Map<string, number>();
            for (const page of pages) for (const pid of page) seen.set(pid, (seen.get(pid) ?? 0) + 1);
            const twice = [...seen.values()].filter((n) => n > 1).length;
            assert(twice === 0, `no listing comes in two heal pages: each page once, through the five-minute overlap (${twice} came twice)`);
            const withPages = pages.filter((p) => p.length > 0).length;
            assert(withPages === 8 && pages.slice(8).every((p) => p.length === 0),
                `the heal goes over eight syncs, and every sync after them is its delta alone (${pages.map((p) => p.length).join(', ')})`);
            const healed = healedIn(received, photoIds);
            assert(healed === 1450, `every one of the 1,450 listings with a photo healed, keyed (${healed} of 1450)`);
            const before = new Set(pages.slice(0, 3).flat());
            assert(lost.length > 0 && !lost.some((pid) => before.has(pid)) && lost.join() === retried.join() && retriedSame,
                `an answer that never arrived is sent again, byte for byte, to the same cursor: the page after the ones the phone holds, not the first (${lost.length}, ${retried.length})`);
            assert(pages[3].join() === lost.join(), `and the phone's own sync with that cursor gets that page too: no page skipped (${pages[3].length})`);
            const heals = await node.send('heals');
            assert(heals?.n === 0, `the heal is done and its record gone once the phone's cursor is past photoKeysSince (${heals?.n})`);

            // Cara's phone syncs every ten minutes: from its second sync on, its cursor is past photoKeysSince.
            const caraAnswers: Reply[] = [];
            const caraPages: string[][] = [];
            let caraLast = synced;
            let caraRetry = false;
            for (let k = 0; k < 10; k++) {
                const delta = await deltaOf(cara, caraLast);
                const r = await pull(node, cara, caraLast);
                if (k === 2) {
                    const again = await pull(node, cara, caraLast);
                    caraRetry = again.text === r.text && healPart(again, delta).length > 0;
                }
                caraAnswers.push(r); caraPages.push(healPart(r, delta));
                caraLast = sinceMs + (k + 1) * 10 * MIN;
            }
            const caraSeen = new Set<string>();
            let caraTwice = 0;
            for (const page of caraPages) for (const pid of page) { if (caraSeen.has(pid)) caraTwice++; caraSeen.add(pid); }
            assert(healedIn(caraAnswers, photoIds) === 1450 && caraTwice === 0 && caraPages.every((p) => p.length <= PAGE),
                `Cara's phone, syncing every ten minutes, heals all 1,450 too, page by page (${healedIn(caraAnswers, photoIds)}, ${caraTwice} twice, ${caraPages.map((p) => p.length).join(', ')})`);
            assert(caraRetry, 'and her sync sent again with the same cursor gets the same page, byte for byte');
            await stop(node);
        });

        await section('10. a take-over finished at boot, in process: the old cursor heals at once', async () => {
            const template = await freshNode('resume');
            await stop(node);
            node = await boot({}, 'resume');
            const synced1 = await pull(node, bob, null);
            assert(synced1.status === 200 && keyed(rowsOf(synced1).find((p) => p.id === template)?.photos?.[0]),
                'setup: the phone syncs from the main server, keyed');
            const synced = Date.now();
            await stop(node);
            // This server as a standby (its own secret, its shape a standby's), then time passes: its photoKeysSince is
            // older than the phone's last sync, as a standby that has run a while.
            node = await boot({ NODE_ROLE: 'backup' }, 'resume');
            const standby = await node.send('records');
            assert(standby.shape?.endsWith('@standby'), `setup: a standby's shape (${standby.shape})`);
            await node.send('ageSince', { ms: 60 * MIN });
            await stop(node);
            // The take-over's role step finishes at this boot, after the state engine recorded the standby's shape.
            node = await boot({ NODE_ROLE: 'backup', PKR_PROMOTE_IN_PROCESS: '1' }, 'resume');
            const rec = await node.send('records');
            assert(rec.shape?.startsWith('keyed:') && !rec.shape.endsWith('@standby') && Date.parse(rec.since) > synced,
                `promoted in process, it records a main server's shape and a new photoKeysSince at once (${rec.shape} ${rec.since})`);
            const next = await pull(node, bob, synced);
            assert(next.status === 200 && healedIn([next], [template]) === 1,
                `the phone's old cursor is answered whole at once, keyed, with no restart after (${next.status}, ${healedIn([next], [template])} of 1)`);
            await stop(node);
        });

        // ── A key's other device, and a pull the phone throws away (review of fe4c27ce, finding 1) ──
        // Simulated phones on a node whose photoKeysSince is set two hours back, so each phone's clock (its syncs, its
        // cursor: its last successful sync less five minutes) runs from photoKeysSince without waiting.
        const cursorAt = (at: number) => new Date(at - 5 * MIN).toISOString();
        /** A phone: the photo URLs it holds per listing, and its last successful sync (the cursor it sends, less 5 min). */
        class Phone {
            held = new Map<string, string[]>();
            constructor(public who: Id, public lastSync: number, held: Record<string, string[]>) {
                for (const [pid, photos] of Object.entries(held)) this.held.set(pid, photos);
            }
            /** One sync that succeeds at phone time `at`: what it reads is written, and its cursor moves. */
            async sync(at: number): Promise<Reply> {
                const r = await signed(node, this.who, 'GET', `/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(cursorAt(this.lastSync))}`);
                if (r.status === 200) {
                    for (const p of rowsOf(r)) this.held.set(p.id, p.photos ?? []);
                    this.lastSync = at;
                }
                return r;
            }
            /** The listings with a photo whose URLs here aren't the node's now: each a 404 on this phone. */
            stale(current: Record<string, string[]>): string[] {
                return Object.entries(current)
                    .filter(([pid, photos]) => photos.length > 0 && JSON.stringify(this.held.get(pid) ?? []) !== JSON.stringify(photos))
                    .map(([pid]) => pid);
            }
        }
        /**
         * A node on data dir `dir` with `n` listings with a photo (Alice's, five hours old and older), `finished` finished
         * ones with a photo (three hours) and `bare` without (four hours); the phones' keyless URLs read with keys off;
         * then keys on, and photoKeysSince set two hours back. Returns photoKeysSince and the URLs a phone holds.
         */
        const changedNode = async (dir: string, n: number, extra: { finished?: number; bare?: number } = {}) => {
            node = await boot({ ENFORCE_READ_AUTH: 'false' }, dir);
            await node.send('seed', { owner: { pk: owner.pk, callsign: owner.callsign }, members: [alice, bob, cara, hank, dan, eve].map((m) => ({ pk: m.pk, callsign: m.callsign })) });
            await node.send('resetLimits');
            const made = await signed(node, alice, 'POST', '/api/marketplace/posts', {
                type: 'offer', category: 'other', title: 'Template', description: 'Template, a test offer', authorPublicKey: alice.pk,
                lat: -28.5, lng: 153.5, photos: [TINY_PNG],
            });
            const template = made.body?.post?.id as string;
            // Older than photoKeysSince will be, standing included: no sync's delta carries them again.
            await node.send('backdate', { minutesAgo: 300 });
            if (n > 1) await node.send('bulk', { template, author: alice.pk, count: n - 1, newestMinutesAgo: 301, prefix: `${dir}-live` });
            if (extra.bare) await node.send('bulk', { template, author: alice.pk, count: extra.bare, newestMinutesAgo: 240, photo: false, prefix: `${dir}-bare` });
            if (extra.finished) await node.send('bulk', { template, author: alice.pk, count: extra.finished, newestMinutesAgo: 180, status: 'completed', prefix: `${dir}-done` });
            const held: Record<string, string[]> = await node.send('photosFor', { pk: bob.pk });
            await stop(node);
            node = await boot({}, dir);
            await node.send('ageSince', { ms: 2 * HOUR });
            await stop(node);
            node = await boot({}, dir);
            const since = Date.parse((await node.send('records')).since);
            return { since, held };
        };
        /**
         * Two phones on `who`'s key syncing in turn, every 30 s each, 15 s apart, from 10 s after photoKeysSince; the one
         * that synced last before the change is `lastBefore`. With `aStops`, phone A syncs once and no more. Returns how
         * many listings with a photo each phone holds a stale URL for.
         */
        const twoPhones = async (who: Id, since: number, held: Record<string, string[]>, lastBefore: 'A' | 'B', aStops = false) => {
            const A = new Phone(who, lastBefore === 'B' ? since - 60_000 : since - 30_000, held);
            const B = new Phone(who, lastBefore === 'B' ? since - 30_000 : since - 60_000, held);
            let aSyncs = 0;
            for (let step = 0; step < 48; step++) {
                const phone = step % 2 === 0 ? A : B;
                if (phone === A && aStops && aSyncs >= 1) continue;
                if (phone === A) aSyncs++;
                const r = await phone.sync(since + 10_000 + step * 15_000);
                if (r.status !== 200) throw new Error(`a sync answered ${r.status}`);
            }
            const current: Record<string, string[]> = await node.send('photosFor', { pk: who.pk });
            return { a: A.stale(current).length, b: B.stale(current).length };
        };

        for (const n of [40, 150, 600]) {
            await section(`11. ${n} listings, two phones on one key syncing in turn: each phone's first sync after the change gets the first page`, async () => {
                const { since, held } = await changedNode(`two${n}`, n);
                // Bob's second phone synced last before the change; Cara's first phone did.
                const bLast = await twoPhones(bob, since, held, 'B');
                const aLast = await twoPhones(cara, since, held, 'A');
                console.log(`   stale per phone (A / B): B synced last before the change ${bLast.a} / ${bLast.b}; A did ${aLast.a} / ${aLast.b}`);
                if (n <= 200) {
                    assert(bLast.a === 0 && bLast.b === 0 && aLast.a === 0 && aLast.b === 0,
                        `a node of one page: neither phone keeps a stale photo URL, whichever synced last before the change (${bLast.a} / ${bLast.b}, ${aLast.a} / ${aLast.b})`);
                } else {
                    // Three pages: each phone gets the first; the two after it go to whichever phone syncs next, one each.
                    assert([bLast.a, bLast.b, aLast.a, aLast.b].every((st) => st <= n - 400),
                        `each phone gets the first page and one of the two after it, whichever synced last before the change (${bLast.a} / ${bLast.b}, ${aLast.a} / ${aLast.b} stale of ${n})`);
                    // Phone A syncs once and stops: phone B heals every listing.
                    const bStops = await twoPhones(dan, since, held, 'B', true);
                    const aStops = await twoPhones(eve, since, held, 'A', true);
                    assert(bStops.b === 0 && aStops.b === 0,
                        `when phone A syncs once and stops, phone B heals every listing, whichever synced last before the change (${bStops.b}, ${aStops.b} stale of ${n})`);
                }
                await stop(node);
            });
        }

        await section('12. a take-over: the pull the phone throws away, then its whole pull, heal every listing', async () => {
            // 600 live listings with a photo, 100 finished ones with a photo and 50 without, both newer than the live ones.
            const { since, held } = await changedNode('takeover', 600, { finished: 100, bare: 50 });
            const P = new Phone(bob, since - 60_000, held);
            // The epoch-aware phone's first pull after a take-over carries its old cursor. The node answers it (the first
            // page, noted for Bob's key); the phone sees the new epoch, throws the answer away and pulls whole, no cursor.
            const thrown = await signed(node, bob, 'GET', `/api/marketplace/posts?limit=1000&sync=true&${TYPES}&updatedAfter=${encodeURIComponent(cursorAt(P.lastSync))}`);
            const whole = await pull(node, bob, null);
            for (const p of rowsOf(whole)) P.held.set(p.id, p.photos ?? []);
            P.lastSync = since + 20_000;
            const wholeIds = new Set(rowsOf(whole).map((p) => p.id));
            const missed = rowsOf(thrown).filter((p) => !wholeIds.has(p.id)).length;
            assert(thrown.status === 200 && whole.status === 200 && rowsOf(whole).length === 200 && missed > 0,
                `setup: the whole pull reads the 200 listings updated last, not all of the page thrown away (${rowsOf(whole).length}; ${missed} of ${rowsOf(thrown).length} not in it)`);
            for (let k = 0; k < 12; k++) await P.sync(since + 50_000 + k * 30_000);
            const current: Record<string, string[]> = await node.send('photosFor', { pk: bob.pk });
            const withPhoto = Object.values(current).filter((p) => p.length > 0).length;
            const stale = P.stale(current);
            assert(withPhoto === 700 && stale.length === 0,
                `the phone's syncs after its whole pull heal every listing with a photo (${stale.length} stale of ${withPhoto})`);
            await stop(node);
        });
    } finally {
        stopAll();
    }

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) {
        process.exitCode = 1;
        if (node) console.error(node.output().slice(-4000));
    }
}

main().catch((e) => {
    console.error(e);
    stopAll();
    process.exit(1);
});
