/**
 * Measure the recovery seal's one-time VACUUM at boot (services/recovery-seal-key.ts clearCopiesDroppedBeforeSeal), and
 * what secure_delete costs the writes that delete (db.ts), on a database of a given size built the way a node before
 * the seal left it.
 *
 * Not a test (no pass/fail): it prints numbers for the PR.
 *
 *   1. Builds the node's real schema in BEANPOOL_DATA_DIR and fills it to ~targetMB: posts (search-indexed), messages,
 *      members and sign-in recovery copies in the form before the seal, with the churn a running node has (a tenth of
 *      the messages and posts deleted, every copy re-deposited once), secure_delete off, as the code before it ran.
 *   2. Boots it as a main server in a second process (initStateEngine): the key, the wrap, the VACUUM. Prints the boot
 *      time, the VACUUM's own time, the file sizes, and the most disk the boot took (free space sampled every 25 ms
 *      from this process), then boots it again for the time without the VACUUM.
 *   3. On copies of the booted database: the deletes a node does, timed with secure_delete OFF, FAST and ON (interleaved,
 *      twice each): 2,000
 *      re-deposits (dropOlder + insert), a purge of 200 members' messages and copies, and a standby's force-resync
 *      (every replicated table cleared, as clearReplicatedTables does), with the bytes each writes to the WAL.
 *
 * With --standby, instead of 2 and 3: boots it as a STANDBY in a second process, which waits (every copy it holds is in
 * the form before the seal), then hands it a whole copy of a main server that holds no copy (one that deleted every copy
 * before the seal): the copies are removed and the VACUUM runs without being recorded. Prints the time of an import's
 * look with nothing to do, the removal and VACUUM's time, the file sizes and the most disk it took.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/bench-recovery-seal-vacuum.ts [targetMB] [--standby]
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const SCRIPT = fileURLToPath(import.meta.url);
const MODE = process.env.BENCH_SEAL_MODE;

const b64 = (n: number) => crypto.randomBytes(n).toString('base64');
const mb = (n: number) => `${(n / 1048576).toFixed(0)} MB`;
const size = (p: string) => { try { return fs.statSync(p).size; } catch { return 0; } };
const freeBytes = (dir: string) => { const s = fs.statfsSync(dir); return Number(s.bavail) * s.bsize; };

/** Step 1, in this process: the database as the code before the seal left it. */
async function fill(dataDir: string, targetMb: number): Promise<void> {
    const { db, initSchema } = await import('./db/db.js');
    initSchema();
    db.pragma('secure_delete = 0');
    const T = '2026-06-01T00:00:00.000Z';
    // Per MB of file: ~135 posts of ~1.5 KB (with their search index), ~300 messages of ~1.2 KB, and the copies.
    const members = Math.max(200, Math.round(targetMb * 4));
    const posts = Math.round(targetMb * 135);
    const messages = Math.round(targetMb * 300);
    const pks = Array.from({ length: members }, () => crypto.randomBytes(32).toString('hex'));
    const words = 'bread eggs bike repair lessons garden tools firewood childcare lift sewing honey compost seedlings'.split(' ');
    const text = (n: number) => Array.from({ length: n }, () => words[crypto.randomInt(words.length)]).join(' ');
    db.transaction(() => {
        const m = db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code) VALUES (?, ?, 'active', ?, 'genesis', 'genesis')`);
        pks.forEach((pk, i) => m.run(pk, `bench-${i}`, T));
    })();
    const p = db.prepare(`INSERT INTO posts (id, type, category, title, description, author_pubkey) VALUES (?, 'offer', 'general', ?, ?, ?)`);
    for (let start = 0; start < posts; start += 5000) {
        db.transaction(() => {
            for (let i = start; i < Math.min(posts, start + 5000); i++) p.run(`bench-post-${i}`, text(8), text(200), pks[i % members]);
        })();
    }
    db.prepare(`INSERT INTO conversations (id, type, created_by) VALUES ('bench-conv', 'direct', ?)`).run(pks[0]);
    const msg = db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce) VALUES (?, 'bench-conv', ?, ?, ?)`);
    for (let start = 0; start < messages; start += 10000) {
        db.transaction(() => {
            for (let i = start; i < Math.min(messages, start + 10000); i++) msg.run(`bench-msg-${i}`, pks[i % members], b64(880), b64(24));
        })();
    }
    const put = db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
        sso_lookup_hash, sso_lookup_salt, kdf_params, generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');
    const copy = () => JSON.stringify({ alg: 'scrypt-xc20p-single-v1', salt: b64(32), N: 16384, r: 8, p: 1, words: { ct: b64(120), iv: b64(24), tag: b64(16) } });
    for (const generation of [1, 2]) {
        db.transaction(() => {
            for (const pk of pks) {
                dropOlder.run(pk, generation);
                put.run(pk, 'sso', 'google', 1, b64(48), b64(24), b64(16), b64(32), b64(16), copy(), generation, T, T);
                put.run(pk, 'hub', 'node', 2, b64(48), b64(24), b64(16), null, null, null, generation, T, T);
            }
        })();
    }
    // A running node's churn: a tenth of the messages and posts deleted.
    db.prepare("DELETE FROM messages WHERE CAST(substr(id, 11) AS INTEGER) % 10 = 3").run();
    db.prepare("DELETE FROM posts WHERE CAST(substr(id, 12) AS INTEGER) % 10 = 7").run();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const pages = Number(db.pragma('page_count', { simple: true }));
    const free = Number(db.pragma('freelist_count', { simple: true }));
    console.log(`Built ${mb(size(path.join(dataDir, 'state.db')))}: ${members} members, ${posts} posts (${Math.round(posts * 0.9)} kept), `
        + `${messages} messages (${Math.round(messages * 0.9)} kept), ${members * 2} recovery copies; ${free} of ${pages} pages free.`);
    db.close(); // at boot nothing else has the file open
}

/** Step 2's second process: boot as a main server and say how long it took. */
async function bootChild(): Promise<void> {
    const t0 = performance.now();
    const { initStateEngine } = await import('./state-engine.js');
    const tImported = performance.now();
    initStateEngine();
    const t1 = performance.now();
    const { db } = await import('./db/db.js');
    const cleared = (db.prepare("SELECT value FROM node_config WHERE key = 'recovery_seal_cleared'").get() as any)?.value ?? null;
    // Written and drained before the exit: a pipe is written asynchronously, and a boot logs a lot at this size.
    await new Promise<void>(resolve => process.stdout.write(
        `\nRESULT ${JSON.stringify({ importMs: tImported - t0, initStateEngineMs: t1 - tImported, cleared })}\n`, () => resolve()));
}

/** The --standby second process: a standby at boot, then a whole copy of a main server that holds no copy. */
async function standbyChild(): Promise<void> {
    const { initStateEngine } = await import('./state-engine.js');
    initStateEngine();
    const seal = await import('./services/recovery-seal-key.js');
    const { db } = await import('./db/db.js');
    const count = () => db.prepare('SELECT COUNT(*) FROM recovery_shares').pluck().get() as number;
    const clearedNow = () => (db.prepare("SELECT value FROM node_config WHERE key = 'recovery_seal_cleared'").get() as any)?.value ?? null;
    const rows = count();
    const tLook = performance.now();
    seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy: null }); // after a delta: the look, nothing to do
    const lookMs = performance.now() - tLook;
    const t0 = performance.now();
    seal.clearCopiesDroppedBeforeSeal({ standby: true, wholeCopy: [] }); // the whole copy: every copy removed, then the VACUUM
    const wholeCopyMs = performance.now() - t0;
    await new Promise<void>(resolve => process.stdout.write(
        `\nRESULT ${JSON.stringify({ rows, lookMs, wholeCopyMs, left: count(), cleared: clearedNow() })}\n`, () => resolve()));
}

function runBoot(dataDir: string, role: 'primary' | 'backup' = 'primary', mode = 'boot'): Promise<{ result: any; peakExtra: number; log: string }> {
    const before = freeBytes(dataDir);
    let lowest = before;
    const sampler = setInterval(() => { lowest = Math.min(lowest, freeBytes(dataDir)); }, 25);
    const child = spawn(process.execPath, [...process.execArgv, SCRIPT], {
        env: { ...process.env, BEANPOOL_DATA_DIR: dataDir, NODE_ROLE: role, BENCH_SEAL_MODE: mode },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    return new Promise((resolve, reject) => child.on('exit', (code) => {
        clearInterval(sampler);
        const line = out.split('\n').reverse().find(l => l.startsWith('RESULT '));
        if (code !== 0 || !line) return reject(new Error(`boot exited ${code}: ${err.slice(-1500)}`));
        resolve({ result: JSON.parse(line.slice(7)), peakExtra: before - lowest, log: (out + err).split('\n').filter(l => l.includes('Recovery seal')).join('\n') });
    }));
}

/** Step 3: the deletes, on a fresh copy of the booted database per setting. */
function deletes(booted: string, work: string, setting: 'OFF' | 'FAST' | 'ON'): Record<string, string> {
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const dbPath = path.join(work, 'state.db');
    fs.copyFileSync(booted, dbPath);
    if (fs.existsSync(`${booted}-wal`)) fs.copyFileSync(`${booted}-wal`, `${dbPath}-wal`);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = OFF'); // as db.ts runs it
    db.pragma('wal_autocheckpoint = 0'); // so the WAL's size is what each step wrote
    db.pragma(`secure_delete = ${setting}`);
    const out: Record<string, string> = {};
    const timed = (name: string, fn: () => void) => {
        db.pragma('wal_checkpoint(TRUNCATE)');
        const t0 = performance.now();
        fn();
        const ms = performance.now() - t0;
        out[name] = `${ms.toFixed(0)} ms, ${mb(size(`${dbPath}-wal`))} WAL`;
    };
    const pks = db.prepare("SELECT DISTINCT owner_pubkey FROM recovery_shares WHERE holder_type = 'sso'").pluck().all() as string[];
    const dropOlder = db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ? AND generation < ?');
    const put = db.prepare(`INSERT INTO recovery_shares (owner_pubkey, holder_type, holder_ref, share_index, encrypted_share, share_iv, share_tag,
        kdf_params, generation) VALUES (?, 'sso', 'google', 1, ?, ?, ?, '{"alg":"node-wrap-xc20p-v1","inner":"scrypt-xc20p-single-v1"}', ?)`);
    timed('2,000 re-deposits', () => {
        for (let i = 0; i < 2000; i++) {
            const pk = pks[i % pks.length];
            db.transaction(() => { dropOlder.run(pk, 3 + i); put.run(pk, b64(300), b64(24), b64(16), 3 + i); })();
        }
    });
    timed('purge of 200 members', () => {
        for (const pk of pks.slice(0, 200)) {
            db.transaction(() => {
                db.prepare('DELETE FROM messages WHERE author_pubkey = ?').run(pk);
                db.prepare('DELETE FROM recovery_shares WHERE owner_pubkey = ?').run(pk);
            })();
        }
    });
    timed('force-resync clear', () => {
        db.transaction(() => {
            for (const t of ['members', 'posts', 'conversations', 'messages', 'recovery_shares']) db.prepare(`DELETE FROM ${t}`).run();
        })();
    });
    db.close();
    fs.rmSync(work, { recursive: true, force: true });
    return out;
}

async function main(): Promise<void> {
    const dataDir = process.env.BEANPOOL_DATA_DIR;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const targetMb = Number(process.argv[2]) || 50;
    const dbPath = path.join(dataDir, 'state.db');
    const t0 = performance.now();
    await fill(dataDir, targetMb);
    console.log(`(built in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);

    if (process.argv.includes('--standby')) {
        const sb = await runBoot(dataDir, 'backup', 'standby');
        const r = sb.result;
        console.log(`\nStandby: ${r.rows} copies in the old form at boot; an import's look with nothing to do ${r.lookMs.toFixed(1)} ms; `
            + `the whole copy of a main server holding none: removal and VACUUM ${(r.wholeCopyMs / 1000).toFixed(2)} s, ${r.left} copies left, `
            + `recorded: ${r.cleared === null ? 'no' : r.cleared}; state.db now ${mb(size(dbPath))}; most extra disk taken ${mb(sb.peakExtra)}.`);
        console.log(sb.log);
        return;
    }

    const first = await runBoot(dataDir);
    const c = first.result.cleared ? JSON.parse(first.result.cleared) : null;
    console.log(`\nUpgrade boot (key, wrap, VACUUM): initStateEngine ${(first.result.initStateEngineMs / 1000).toFixed(2)} s, `
        + `of which the VACUUM and its checkpoint ${c ? `${c.seconds} s` : 'did not run'}; state.db ${c ? `${mb(c.bytesBefore)} → ${mb(c.bytesAfter)}` : '-'}; `
        + `most extra disk taken during the boot ${mb(first.peakExtra)}.`);
    console.log(first.log);
    const second = await runBoot(dataDir);
    console.log(`Next boot (nothing to do): initStateEngine ${(second.result.initStateEngineMs / 1000).toFixed(2)} s.`);

    console.log('\nDeletes on the booted database, by secure_delete (each on a fresh copy, WAL bytes each step wrote):');
    const work = path.join(dataDir, 'deletes');
    // Interleaved, twice each, so the page cache and the disk's own noise show as the spread between the rounds.
    for (const setting of ['OFF', 'FAST', 'ON', 'OFF', 'FAST', 'ON'] as const) {
        console.log(`  ${setting.padEnd(4)} ${JSON.stringify(deletes(dbPath, work, setting))}`);
    }
}

if (MODE === 'standby') {
    standbyChild().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else if (MODE === 'boot') {
    bootChild().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
} else {
    main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
