/**
 * Measure a sealed backup of a ~200 MB database: time per phase and event-loop lag (sealed-keys.md §2.2, the
 * slice 3 row of §10: "measured seal time and event-loop lag on a 200 MB db, numbers in the PR").
 *
 * Not a test (no pass/fail): it prints numbers. The database is filled with random blobs so gzip cannot shrink it
 * and the sealer sees close to the full 200 MB — the worst case for the pure-JS cipher.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/bench-sealed-backup.ts [targetMB]
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const targetMb = Number(process.argv[2]) || 200;

async function main() {
    const dataDir = process.env.BEANPOOL_DATA_DIR!;
    if (!dataDir) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const { initStateEngine, seedGenesisMember } = await import('./state-engine.js');
    const { db } = await import('./db/db.js');
    const { ensureGenesis } = await import('./genesis.js');
    const { generateKeyPair, privateKeyToProtobuf } = await import('@libp2p/crypto/keys');
    const { makeRecoveryCode } = await import('./services/takeover-envelope.js');
    const { createSealedBackup, openSealedFileTo } = await import('./services/sealed-backup.js');
    const { writeDbSnapshot } = await import('./services/snapshot-scheduler.js');
    const { ed25519 } = await import('@noble/curves/ed25519.js');

    initStateEngine();
    await ensureGenesis();
    fs.writeFileSync(path.join(dataDir, 'libp2p_key'), privateKeyToProtobuf(await generateKeyPair('Ed25519')));
    seedGenesisMember(Buffer.from(ed25519.getPublicKey(crypto.randomBytes(32))).toString('hex'), 'Owner');
    const code = await makeRecoveryCode();

    console.log(`Filling the database to ~${targetMb} MB with random blobs…`);
    db.exec('CREATE TABLE IF NOT EXISTS bench_fill (id INTEGER PRIMARY KEY, blob BLOB)');
    const ins = db.prepare('INSERT INTO bench_fill (blob) VALUES (?)');
    const rows = Math.ceil((targetMb * 1024 * 1024) / 65536);
    db.transaction(() => { for (let i = 0; i < rows; i++) ins.run(crypto.randomBytes(65536)); })();
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbSize = fs.statSync(path.join(dataDir, 'state.db')).size;

    // Event-loop lag: the histogram (10 ms resolution) and a 10 ms heartbeat's worst gap, per phase.
    const h = monitorEventLoopDelay({ resolution: 10 });
    let worstGap = 0;
    let last = performance.now();
    const beat = setInterval(() => { const now = performance.now(); worstGap = Math.max(worstGap, now - last - 10); last = now; }, 10);
    const phase = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
        h.reset(); h.enable(); worstGap = 0; last = performance.now();
        const t0 = performance.now();
        const out = await fn();
        const ms = performance.now() - t0;
        h.disable();
        // A phase with no await never lets a timer fire, so nothing is sampled: it holds the loop for all of it.
        const sampled = ((h as any).count ?? 0) > 0;
        console.log(`${name.padEnd(46)} ${(ms / 1000).toFixed(2).padStart(7)} s   ` + (sampled
            ? `worst stall ${worstGap.toFixed(0)} ms (a 10 ms heartbeat's lateness) · delay histogram p50 ${(h.percentile(50) / 1e6).toFixed(1)} / p99 ${(h.percentile(99) / 1e6).toFixed(1)} ms incl. the 10 ms sampling interval`
            : `synchronous: holds the event loop for the whole ${ms.toFixed(0)} ms`));
        return out;
    };

    console.log(`\nNode ${process.version} · ${process.platform}/${process.arch} · database ${(dbSize / 1048576).toFixed(1)} MB\n`);
    const snap = path.join(dataDir, 'bench-vacuum.db');
    await phase('VACUUM INTO alone (sync, pre-existing step)', () => writeDbSnapshot(snap));
    fs.rmSync(snap, { force: true });

    const out = path.join(dataDir, 'bench.bpsealed');
    let bytes = 0;
    await phase('whole /backup: VACUUM + tar -czf + seal + write', async () => {
        const b = await createSealedBackup();
        await pipeline(b.body, fs.createWriteStream(out));
        bytes = fs.statSync(out).size;
    });
    console.log(`  sealed file ${(bytes / 1048576).toFixed(1)} MB`);

    // The seal stage on its own: the same tar re-sealed, streamed to nowhere.
    const { sealEnvelopeStream } = await import('@beanpool/core');
    const opened = path.join(dataDir, 'bench.opened.tar.gz');
    await phase('restore side: open the sealed file to a tar', () => openSealedFileTo(out, { type: 'code', code: code.code }, opened));
    const tarBytes = fs.statSync(opened).size;
    await phase(`seal stage alone: ${(tarBytes / 1048576).toFixed(0)} MB tar → sealed stream`, async () => {
        const { readSealingInputs } = await import('./services/takeover-envelope.js');
        const i = readSealingInputs();
        if (!i.ok) throw new Error(i.message);
        const s = sealEnvelopeStream(fs.createReadStream(opened, { highWaterMark: 1 << 20 }), {
            kind: 'backup', communityId: i.communityId, nodePeerId: i.identity.peerId,
            recipients: { owners: i.owners, codes: i.code ? [i.code] : [] }, signingKey: i.identity.seed,
        });
        await pipeline(s, new Writable({ write(_c, _e, cb) { cb(); } }));
    });
    clearInterval(beat);
    console.log(`\nSeal throughput ≈ ${(tarBytes / 1048576).toFixed(0)} MB per the "seal stage alone" time above.`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
