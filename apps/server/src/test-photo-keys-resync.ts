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
        // The listings, their photos and their authors' standing an hour older: a cursor from now leaves them out.
        backdate: () => {
            const ago = new Date(Date.now() - HOUR).toISOString();
            db.prepare('UPDATE posts SET created_at = ?, updated_at = ?').run(ago, ago);
            db.prepare('UPDATE post_photos SET updated_at = ?').run(ago);
            db.prepare('UPDATE members SET board_standing_changed_at = ?').run(ago);
            return ago;
        },
        records: () => ({ shape: row('photoKeysShape'), since: row('photoKeysSince'), secret: row('photoKeySecret') }),
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
function boot(env: Record<string, string | undefined>): Promise<Node> {
    const dataDir = path.join(process.env.BEANPOOL_DATA_DIR!, 'node');
    fs.mkdirSync(dataDir, { recursive: true });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, BEANPOOL_DATA_DIR: dataDir, ADMIN_PASSWORD: PW };
    for (const k of ['CF_RECORD_NAME', 'BEANPOOL_ADDRESSES', 'ENFORCE_WS_AUTH', 'ENFORCE_READ_AUTH', 'NODE_PROFILE', 'NODE_ROLE']) delete childEnv[k];
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
    const owner = id('Olive'), alice = id('Alice'), bob = id('Bob'), cara = id('Cara');

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
