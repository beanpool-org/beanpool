/**
 * Members' photos out of their rows (the global node's load rehearsal, 2026-10-02: report §6.2 and §8 item 1).
 *
 * A photo sat inline in members.avatar_url, ~27 KB of base64 each, and the full member list every phone reads on its first
 * sync and hourly read every member's photo to version its URL: at ~6,400 members with photos one such request ran a
 * 256 MB heap out of memory, and Docker's restart and the phones' re-sync made it a crash loop. Photos are in
 * member_photos now; the members row keeps the URL's version (avatar_ref) and the photo's size (avatar_bytes).
 *
 * Every server here is the real one, in a process of its own (this file, run as a child), so running out of heap ends
 * the child, not the suite:
 *   1. The heap. N members with a photo each, given by the profile route's own writer (state-engine updateProfile), on a
 *      server held to a small heap: one full GET /api/members answers, with the heap's peak under a bound. On origin/main
 *      09c2588d the same request ended the process (measured: FATAL ERROR, heap out of memory).
 *   2. An upgraded node says what it said. A database from before the move, its photos inline, one member for every kind
 *      of value a live node's avatar_url holds, booted: each member's URL in the full list and in a delta (both apps'
 *      sync), in the community members list, the avatar route's answer (status, type, ETag, bytes) and the profile page's
 *      photo are what the old code made of the inline value (the rules kept below as the oracle); a reader with no member
 *      key is refused the list as before.
 *   3. A photo set, changed and removed by a member through POST /api/profile/update: each time the list's URL, the
 *      delta, the avatar route and the row's reference follow; nothing reads the photo to answer a list.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-member-photos-out-of-rows.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.ENFORCE_READ_AUTH;

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);

/** A JPEG the photo rules take (its structure walks), about `size` bytes: what a phone sends, as a data URL. */
function jpeg(size: number, seed = 1): Buffer {
    const head = Buffer.from([
        0xff, 0xd8,
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
        0xff, 0xdb, 0x00, 0x43, 0x00, ...Array(64).fill(0x08),
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x00, 0x02, 0x00, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00, 0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ...Array(12).fill(0x01),
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    ]);
    const body = Buffer.alloc(Math.max(0, size - head.length - 2));
    for (let i = 0; i < body.length; i++) body[i] = ((i * 7 + seed) % 254) + 1; // never 0xFF: no marker inside
    return Buffer.concat([head, body, Buffer.from([0xff, 0xd9])]);
}
const dataUrl = (b: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${b.toString('base64')}`;
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

type Key = { pk: string; priv: string };
function newKey(): Key {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') };
}

// ── The children ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Members with photos, each by the profile route's own writer: what N members setting a photo leave in the database. */
async function seedPhotos(a: { n: number; reader: string }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    se.initStateEngine();
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status) VALUES (?, ?, ?, ?, 'active')`);
    const photo = dataUrl(jpeg(20_000));
    insert.run(a.reader, 'Reader', '2026-01-01T00:00:00.000Z', 'INV-READER');
    for (let i = 0; i < a.n; i++) {
        const pk = crypto.createHash('sha256').update(`heap member ${i}`).digest('hex');
        insert.run(pk, `Heap${i}`, new Date(Date.UTC(2026, 0, 2) + i * 1000).toISOString(), `INV-${i}`);
        se.updateProfile(pk, { avatar: photo });
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * A database from before photos left the members rows: booted as a fresh one, then made into the old shape (the photo
 * inline in members.avatar_url; no reference, size or member_photos), with one member per kind of stored value.
 */
async function seedLegacy(a: { reader: string; kinds: [string, string, string | null][] }): Promise<void> {
    const se = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    se.initStateEngine();
    db.exec(`DROP TRIGGER members_touch_updated_at; DROP TABLE member_photos;
             ALTER TABLE members DROP COLUMN avatar_ref; ALTER TABLE members DROP COLUMN avatar_bytes;
             ALTER TABLE members ADD COLUMN avatar_url TEXT;`);
    const insert = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invite_code, status, avatar_url, profile_updated_at)
                               VALUES (?, ?, ?, ?, 'active', ?, ?)`);
    insert.run(a.reader, 'Reader', '2026-01-01T00:00:00.000Z', 'INV-READER', null, null);
    a.kinds.forEach(([pk, , value], i) => insert.run(pk, `Kind${i}`, '2026-02-01T00:00:00.000Z', `INV-K${i}`, value, '2026-03-01T00:00:00.000Z'));
    db.pragma('wal_checkpoint(TRUNCATE)');
}

/** The real server, on port 0, reporting its heap's peak (sampled every 5 ms) when asked on stdin. */
async function serve(): Promise<void> {
    const { initTls } = await import('./services/tls.js');
    const { initAdminPassword } = await import('./config/local-config.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer } = await import('./https-server.js');
    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const port = await startHttpsServer(0);
    let peak = 0;
    setInterval(() => { const h = process.memoryUsage().heapUsed; if (h > peak) peak = h; }, 5).unref();
    const say = (m: unknown) => process.stdout.write(`@@ ${JSON.stringify(m)}\n`);
    say({ ready: true, port });
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
        if (line === 'peak') { say({ peak }); peak = process.memoryUsage().heapUsed; }
        if (line === 'exit') process.exit(0);
    });
}

const role = process.argv[2];
if (role === 'seed-photos' || role === 'seed-legacy' || role === 'serve') {
    const args = role === 'serve' ? null : JSON.parse(process.argv[3]);
    (role === 'seed-photos' ? seedPhotos(args) : role === 'seed-legacy' ? seedLegacy(args) : serve()).then(
        () => { if (role !== 'serve') process.exit(0); },
        (e) => { console.error(e); process.exit(1); },
    );
} else {
    main().catch((e) => { console.error(e); process.exit(1); });
}

// ── The orchestrator ─────────────────────────────────────────────────────────────────────────────────────────────────

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** This file again, as a child: `role`, its args, on `dataDir`; the node flags it runs with (tsx's) and `nodeFlags`. */
function child(role: string, dataDir: string, args: unknown, nodeFlags: string[] = []): ChildProcess {
    return spawn(process.execPath, [...nodeFlags, ...process.execArgv, HERE, role, ...(args === null ? [] : [JSON.stringify(args)])], {
        cwd: path.dirname(path.dirname(HERE)),
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
}

async function runToEnd(role: string, dataDir: string, args: unknown): Promise<void> {
    const p = child(role, dataDir, args);
    let out = '';
    p.stdout!.on('data', (b) => { out += b; });
    p.stderr!.on('data', (b) => { out += b; });
    const code = await new Promise<number | null>((r) => p.on('exit', r));
    if (code !== 0) throw new Error(`${role} exited ${code}:\n${out.slice(-3000)}`);
}

interface Server { base: string; ask: (line: string) => Promise<any>; output: () => string; exited: () => boolean; stop: () => Promise<void> }

async function startServer(dataDir: string, heapMb: number): Promise<Server> {
    const p = child('serve', dataDir, null, [`--max-old-space-size=${heapMb}`]);
    let out = '';
    let dead = false;
    const replies: ((m: any) => void)[] = [];
    let readyResolve!: (m: any) => void;
    const ready = new Promise<any>((r) => { readyResolve = r; });
    const exited = new Promise<void>((r) => p.on('exit', () => { dead = true; r(); }));
    readline.createInterface({ input: p.stdout! }).on('line', (line) => {
        out += line + '\n';
        if (!line.startsWith('@@ ')) return;
        const m = JSON.parse(line.slice(3));
        if (m.ready) readyResolve(m); else replies.shift()?.(m);
    });
    p.stderr!.on('data', (b) => { out += b; });
    const first = await Promise.race([ready, exited.then(() => null)]);
    if (!first) throw new Error(`the server exited before it was ready:\n${out.slice(-3000)}`);
    return {
        base: `https://localhost:${first.port}`,
        ask: (line) => new Promise((r) => { replies.push(r); p.stdin!.write(line + '\n'); }),
        output: () => out,
        exited: () => dead,
        stop: async () => { if (!dead) { p.stdin!.write('exit\n'); await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]); if (!dead) p.kill('SIGKILL'); } },
    };
}

/** A member's signed GET or POST, as the apps send one (the older request format, which every node still takes). */
async function call(base: string, method: 'GET' | 'POST', route: string, key: Key | null, body?: unknown): Promise<{ status: number; text: string; headers: Headers; bytes: Buffer }> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers: Record<string, string> = raw ? { 'Content-Type': 'application/json' } : {};
    if (key) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const priv = crypto.createPrivateKey({ key: Buffer.from(key.priv, 'base64'), format: 'der', type: 'pkcs8' });
        Object.assign(headers, {
            'X-Public-Key': key.pk,
            'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), priv).toString('base64'),
            'X-Timestamp': String(ts), 'X-Nonce': nonce,
        });
    }
    const res = await fetch(`${base}${route}`, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(120_000) });
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, text: bytes.toString('utf8'), headers: res.headers, bytes };
}

// The old code's rules, kept here as the oracle: what origin/main 09c2588d made of a value stored in members.avatar_url.

/** @beanpool/core avatarUrlFor (no member-only keys on this node). */
function oldUrl(pk: string, stored: string | null): string | null {
    if (!stored || !stored.trim() || /^\/api\/avatar\//i.test(stored.trim()) || /^[a-z][a-z0-9+.-]*:\/\/[^/]*\/api\/avatar\//i.test(stored.trim())) return null;
    const trimmed = stored.trim();
    if (trimmed.startsWith('bundled://')) return stored;
    return `/api/avatar/${pk}?size=thumb&v=${crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 8)}`;
}

/** engine/avatar.ts AvatarService.getAvatar's answer (status, and for a 200 the bytes, type and ETag). */
function oldAvatar(stored: string | null): { status: number; bytes?: Buffer; type?: string; etag?: string } {
    if (!stored || !stored.trim()) return { status: 404 };
    const raw = stored.trim();
    if (raw.startsWith('bundled://')) {
        // Where the route looks for a shipped picture, from the server's directory (apps/server): a build may have put it there.
        const file = `avatar_${raw.slice('bundled://'.length).replace(/-/g, '_')}.jpg`;
        const serverDir = path.dirname(path.dirname(HERE));
        const found = [path.join(serverDir, 'public', 'avatars', file), path.join(serverDir, 'apps', 'server', 'public', 'avatars', file),
            path.join(serverDir, 'apps', 'pwa', 'public', 'avatars', file)].find((f) => fs.existsSync(f));
        if (!found) return { status: 404 };
        const fileBytes = fs.readFileSync(found);
        return { status: 200, bytes: fileBytes, type: 'image/jpeg', etag: `"${crypto.createHash('sha256').update(fileBytes).digest('hex').slice(0, 16)}"` };
    }
    let bytes: Buffer;
    const m = raw.match(/^data:([^;,]+);base64,([\s\S]*)$/i);
    if (m) {
        const mime = m[1].toLowerCase().trim();
        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/jpg'].includes(mime)) return { status: 400 };
        bytes = Buffer.from(m[2], 'base64');
    } else if (/^data:/i.test(raw)) return { status: 404 };
    else bytes = Buffer.from(raw, 'base64');
    const type = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? 'image/jpeg'
        : bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png' : null;
    if (!type) return { status: 404 };
    return { status: 200, bytes, type, etag: `"${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}"` };
}

async function main(): Promise<void> {
    const root = fs.mkdtempSync(path.join(process.env.BEANPOOL_DATA_DIR || os.tmpdir(), 'member-photos-'));

    // ── 1. The heap ──────────────────────────────────────────────────────────────────────────────────────────────────
    // 4,000 members with a 20 KB photo each (27 KB stored), and a 128 MB heap: on origin/main the list's peak was about
    // 45 MB plus 28 KB a photo (measured at 6,400 photos: 220 MB), so one request ran it out of heap.
    console.log('\n— 1. one full member list at 4,000 members with photos, from a server held to a 128 MB heap —');
    const N = 4_000, HEAP_MB = 128, BOUND_MB = 96;
    const reader = newKey();
    const heapDir = path.join(root, 'heap');
    fs.mkdirSync(heapDir, { recursive: true });
    const t0 = Date.now();
    await runToEnd('seed-photos', heapDir, { n: N, reader: reader.pk });
    console.log(`  (seeded ${N} photos by updateProfile in ${Date.now() - t0} ms; state.db ${(fs.statSync(path.join(heapDir, 'state.db')).size / 2 ** 20).toFixed(0)} MB)`);
    const heapServer = await startServer(heapDir, HEAP_MB);
    let crashed = false;
    try {
        await heapServer.ask('peak');
        const f0 = performance.now();
        let full: Awaited<ReturnType<typeof call>> | null = null;
        let failed = '';
        try { full = await call(heapServer.base, 'GET', '/api/members', reader); } catch (e: any) { failed = String(e?.cause?.code || e?.message || e); }
        const ms = performance.now() - f0;
        const peak = heapServer.exited() ? NaN : (await heapServer.ask('peak')).peak / 2 ** 20;
        const fatal = heapServer.output().split('\n').filter((l) => /FATAL|heap out of memory/.test(l)).slice(0, 2).join(' | ');
        crashed = heapServer.exited();
        const list = full?.status === 200 ? JSON.parse(full.text) as any[] : [];
        const photoMembers = list.filter((m) => /^Heap\d+$/.test(m.callsign));
        assert(!crashed && full?.status === 200 && photoMembers.length === N && list.some((m) => m.publicKey === reader.pk),
            `the server answers the full list (${full?.status ?? failed}, ${list.length} members, ${((full?.bytes.length ?? 0) / 2 ** 20).toFixed(1)} MB, ${ms.toFixed(0)} ms)${fatal ? `: ${fatal}` : ''}`);
        assert(peak < BOUND_MB, `and its heap peaks at ${peak.toFixed(0)} MB while it does, under ${BOUND_MB} MB of its ${HEAP_MB} MB`);
        assert(photoMembers.length === N && photoMembers.every((m) => /^\/api\/avatar\/[0-9a-f]{64}\?size=thumb&v=[0-9a-f]{8}$/.test(m.avatarUrl)),
            'every member with a photo has its versioned URL');
    } finally {
        await heapServer.stop();
    }
    if (crashed) {
        // Origin/main ends here: the rest needs member_photos.
        console.log(`\n${passed}/${run} passed`);
        process.exit(1);
    }

    // ── 2. An upgraded node says what it said ────────────────────────────────────────────────────────────────────────
    console.log('\n— 2. a node from before the move, booted: every reader gets what the old code made of each inline value —');
    const photoA = dataUrl(jpeg(9_000, 3));
    const KINDS: [string, string | null][] = [
        ['a JPEG as a data URL', photoA],
        ['a photo with blanks around it', `\n ${dataUrl(jpeg(4_000, 5))}  `],
        ['a PNG as a data URL', dataUrl(PNG_1PX, 'image/png')],
        ['a legacy bare-base64 JPEG', jpeg(3_000, 7).toString('base64')],
        ['a JPEG whose type says image/jpg', dataUrl(jpeg(2_000, 9), 'image/jpg')],
        ['a hostile type (SVG)', `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`],
        ['a data URL that is not base64', 'data:image/svg+xml,%3Csvg%3E'],
        ['bytes that are no image', `data:image/jpeg;base64,${Buffer.from('not a jpeg at all').toString('base64')}`],
        ['a shipped picture', 'bundled://leaf'],
        ['a link', 'https://example.org/me.jpg'],
        ['this node\'s own avatar address', '/api/avatar/abc?size=thumb'],
        ['blanks', '   '],
        ['no avatar', null],
    ];
    const kinds = KINDS.map(([label, value]) => [newKey().pk, label, value] as [string, string, string | null]);
    const legacyDir = path.join(root, 'legacy');
    fs.mkdirSync(legacyDir, { recursive: true });
    const member = newKey();
    await runToEnd('seed-legacy', legacyDir, { reader: member.pk, kinds });
    const server = await startServer(legacyDir, 256);
    try {
        assert(/Members' photos are in member_photos now: 10 moved, 2 that were no photo left out/.test(server.output()),
            `the boot moved the photos out of the rows (${(server.output().match(/Members' photos are in member_photos now:[^\n]*/) || ['nothing said'])[0]})`);
        const full = JSON.parse((await call(server.base, 'GET', '/api/members', member)).text) as any[];
        const delta = JSON.parse((await call(server.base, 'GET', '/api/members?updatedAfter=2026-02-15T00:00:00.000Z', member)).text) as any[];
        const community = JSON.parse((await call(server.base, 'GET', '/api/community/members', member)).text) as any;
        const communityList: any[] = Array.isArray(community) ? community : community?.members ?? [];
        for (const [pk, label, value] of kinds) {
            const want = oldUrl(pk, value);
            const inFull = full.find((m) => m.publicKey === pk)?.avatarUrl;
            const inDelta = delta.find((m) => m.publicKey === pk)?.avatarUrl;
            const inCommunity = communityList.find((m) => m.publicKey === pk)?.avatarUrl;
            assert(inFull === want && inDelta === want && inCommunity === want,
                `${label}: the full list, the delta and the community list give ${want === null ? 'no URL' : 'its URL'}, as before (${inFull}, ${inDelta}, ${inCommunity})`);
            const was = oldAvatar(value);
            const got = await call(server.base, 'GET', `/api/avatar/${pk}?size=thumb`, null);
            const same = got.status === was.status && (was.status !== 200
                || (got.bytes.equals(was.bytes!) && got.headers.get('content-type') === was.type && got.headers.get('etag') === was.etag));
            assert(same, `${label}: the avatar route answers ${was.status}${was.status === 200 ? ' with the same bytes, type and ETag' : ''}, as before (${got.status} ${got.headers.get('content-type') ?? ''})`);
            if (oldUrl(pk, value) !== null) {
                const profile = JSON.parse((await call(server.base, 'GET', `/api/profile/${pk}`, member)).text);
                assert(profile?.avatar === value, `${label}: the profile page hands the photo out as it is stored, as before`);
            }
        }
        const stranger = await call(server.base, 'GET', '/api/members', null);
        assert(stranger.status === 401 && !stranger.text.includes('avatar'), `an unsigned reader is refused the list, as before (${stranger.status})`);

        // ── 3. A member sets, changes and removes their photo ────────────────────────────────────────────────────────
        console.log('\n— 3. a photo set, changed and removed through POST /api/profile/update —');
        const listedUrl = async () => JSON.parse((await call(server.base, 'GET', '/api/members', member)).text).find((m: any) => m.publicKey === member.pk)?.avatarUrl ?? null;
        const deltaUrl = async (since: string) => JSON.parse((await call(server.base, 'GET', `/api/members?updatedAfter=${encodeURIComponent(since)}`, member)).text)
            .find((m: any) => m.publicKey === member.pk)?.avatarUrl;
        const served = async () => await call(server.base, 'GET', `/api/avatar/${member.pk}?size=thumb`, null);
        const steps: [string, string | null][] = [['sets a photo', dataUrl(jpeg(12_000, 11))], ['changes it', dataUrl(jpeg(15_000, 13))], ['removes it', null]];
        let lastUrl: string | null = null;
        for (const [label, avatar] of steps) {
            const since = new Date(Date.now() - 1).toISOString();
            const upd = await call(server.base, 'POST', '/api/profile/update', member, { avatar });
            const url = await listedUrl();
            const fromDelta = await deltaUrl(since);
            const got = await served();
            const want = avatar === null ? null : oldUrl(member.pk, avatar);
            assert(upd.status === 200 && url === want && fromDelta === want && url !== lastUrl,
                `the member ${label}: the list's URL is ${want === null ? 'gone' : 'the new one'} at once (${url}), and the next delta carries it (${fromDelta})`);
            assert(avatar === null ? got.status === 404 : got.status === 200 && got.bytes.equals(Buffer.from(avatar.split(',')[1], 'base64')),
                `and the avatar route serves ${avatar === null ? 'nothing (404)' : 'the new photo'} (${got.status}, ${got.bytes.length} bytes)`);
            lastUrl = url;
        }
    } finally {
        await server.stop();
    }

    fs.rmSync(root, { recursive: true, force: true });
    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}
