/**
 * Shared by test-standby-paged-copies.ts and test-standby-paged-copies-pacing.ts (not a suite itself): the commands a main
 * server's or a standby's own process answers in those suites (takeover-test-harness.ts runNodeChild), each run inside
 * that node's process. Nothing leaves this machine: every node's fetch answers only localhost.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runNodeChild, serveCommands } from './takeover-test-harness.js';

/** No node reaches anything but this machine (a push to Expo, the update check's ask of GitHub, are answered here). */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        if (url.hostname === 'api.github.com') return new Response('{}', { status: 404 });
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

/** Boot as index.ts does and answer these commands, and `extra`, as a node of those suites. Never returns. */
export async function runPagedCopyChild(extra: Record<string, (args: any) => Promise<unknown>> = {}): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            seedGenesisMember(a.genesis, 'Gwen');
            setReplicationToken(a.replicationToken);
            return true;
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        'set-primary-url': async (a: { url: string }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig({ backupPrimaryUrl: a.url });
            return true;
        },
        /** This process's environment, live (the puller reads its paces and intervals at each pull); null removes one. */
        'set-env': async (a: { vars: Record<string, string | null> }) => {
            for (const [k, v] of Object.entries(a.vars)) {
                if (v === null) delete process.env[k];
                else process.env[k] = v;
            }
            return true;
        },
        /** One pull of the kind the loop makes next; `whole` asks the routine whole copy. */
        pull: async (a: { whole?: boolean }) => {
            const { pullNow, getBackupStatus } = await import('./services/backup-puller.js');
            const before = getBackupStatus().lastFullReconcileAt;
            const was = [process.env.BACKUP_RECONCILE_EVERY_MS, process.env.BACKUP_BIG_COPY_EVERY_MS];
            if (a.whole) {
                process.env.BACKUP_RECONCILE_EVERY_MS = '1';
                process.env.BACKUP_BIG_COPY_EVERY_MS = '1';
            }
            await new Promise((r) => setTimeout(r, 5));
            const result = await pullNow();
            if (a.whole) {
                for (const [k, v] of [['BACKUP_RECONCILE_EVERY_MS', was[0]], ['BACKUP_BIG_COPY_EVERY_MS', was[1]]] as const) {
                    if (v === undefined) delete process.env[k];
                    else process.env[k] = v;
                }
            }
            const s = getBackupStatus();
            return {
                ok: result.ok, error: result.error ?? null, staged: result.staged === true, mode: s.lastPullMode ?? null,
                landedWhole: s.lastFullReconcileAt !== before, lastWholePages: s.lastWholePages,
            };
        },
        /** The force-resync an operator runs from Settings. */
        resync: async () => {
            const { requestResync } = await import('./services/backup-puller.js');
            return requestResync();
        },
        /** The puller's start as index.ts makes it; its loop stopped at once: the suite pulls by hand. */
        'boot-puller': async () => {
            const { initBackupPuller, stopBackupPuller, getBackupStatus } = await import('./services/backup-puller.js');
            initBackupPuller();
            stopBackupPuller();
            return getBackupStatus().cursor;
        },
        /** Every table in `tables`, counted and hashed row for row; the format record, the cursor and the ledger's total. */
        snapshot: async (a: { tables: string[] }) => {
            const { db } = await import('./db/db.js');
            const tables: Record<string, { count: number; hash: string }> = {};
            for (const t of a.tables) {
                const rows = (db.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[])
                    .map(({ last_active_at: _l, ...rest }) => JSON.stringify(rest)).sort();
                tables[t] = { count: rows.length, hash: crypto.createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16) };
            }
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            const cursor = (db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'backup:primary'`).get() as { c: string } | undefined)?.c ?? null;
            return {
                tables, format: cfg('replica_format'), cursor,
                ledgerSum: (db.prepare('SELECT COALESCE(SUM(balance), 0) AS s FROM accounts').get() as { s: number }).s,
            };
        },
        /**
         * M's pricing guide made now and its worker stopped (pricing-aggregator.ts): the worker rewrites the guide's rows 5 s
         * after every start, which would move them between a copy's snapshot and a step's look at S.
         */
        'settle-pricing': async () => {
            const { runPricingAggregationCycle, stopPricingAggregatorWorker } = await import('./pricing-aggregator.js');
            stopPricingAggregatorWorker();
            runPricingAggregationCycle();
            return true;
        },
        /** The copied tables' hashes as the whole-copy check makes them (engine/replica-hashes.ts). */
        hashes: async () => {
            const { tableContentHashes } = await import('./engine/replica-hashes.js');
            return tableContentHashes().tables;
        },
        /** This standby's record of its copies, and the report its next pull sends (services/standby-copy-record.ts). */
        record: async () => {
            const { readCopyRecord, standbyReport } = await import('./services/standby-copy-record.js');
            // The report first: it writes the record, and its id, when there is none yet.
            const report = standbyReport() as any;
            const r = readCopyRecord() as any;
            return {
                id: r.id, lastOutcome: r.lastOutcome, lastWhy: r.lastWhy, fails: r.failedImportsInARow, lastWhole: r.lastWhole,
                lastLeftOut: r.lastLeftOut ?? null, lastWholeCopy: r.lastWholeCopy ?? null,
                report: { why: report.why, leftOut: report.leftOut ?? null, exact: report.exact, differs: report.differs },
            };
        },
        sql: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).run(...(a.args ?? [])).changes;
        },
        rows: async (a: { sql: string; args?: unknown[] }) => {
            const { db } = await import('./db/db.js');
            return db.prepare(a.sql).all(...(a.args ?? []));
        },
        /** `n` rows written in one go behind the routes, each a new key starting `flood-`. */
        flood: async (a: { kind: 'messages' | 'long-messages' | 'posts'; n: number; conversationId?: string; author?: string }) => {
            const { db } = await import('./db/db.js');
            const now = () => new Date().toISOString();
            db.transaction(() => {
                for (let i = 0; i < a.n; i++) {
                    const id = `flood-${crypto.randomUUID()}`;
                    if (a.kind === 'posts') {
                        db.prepare(`INSERT INTO posts (id, type, category, title, description, credits, author_pubkey, created_at, updated_at) VALUES (?, 'offer', 'food', ?, 'a flood', 1, ?, ?, ?)`)
                            .run(id, `Flood ${i}`, a.author, now(), now());
                    } else {
                        const words = a.kind === 'messages' ? Buffer.from(`line ${i}`) : crypto.randomBytes(1500);
                        db.prepare(`INSERT INTO messages (id, conversation_id, author_pubkey, ciphertext, nonce, type, timestamp, updated_at) VALUES (?, ?, ?, ?, ?, 'text', ?, ?)`)
                            .run(id, a.conversationId, a.author, words.toString('base64'), crypto.randomBytes(24).toString('base64'), now(), now());
                    }
                }
            })();
            return true;
        },
        /** The flood's rows gone from this server, as a delete that writes no tombstone. */
        unflood: async () => {
            const { db } = await import('./db/db.js');
            return db.prepare(`DELETE FROM messages WHERE id LIKE 'flood-%'`).run().changes + db.prepare(`DELETE FROM posts WHERE id LIKE 'flood-%'`).run().changes;
        },
        /** A friendship ended on this server, with its tombstone, as the route ends one. */
        unfriend: async (a: { owner: string; friend: string }) => {
            const { removeFriend } = await import('./state-engine.js');
            return removeFriend(a.owner, a.friend);
        },
        rekey: async (a: { oldPk: string; newPk: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const { code } = issueRekeyCode(a.oldPk, a.operator);
            return completeRekey(a.oldPk, a.newPk, code, a.operator).success;
        },
        /** A whole copy being built here: its stager's PID; and what the data directory holds of copies. */
        staging: async () => {
            const stager: { copyStaging?: () => { pid: number | null } | null } | null = await import('./services/stager.js').catch(() => null);
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const staging = path.join(dir, 'staging');
            return {
                building: stager?.copyStaging?.() ?? null, staging: fs.existsSync(staging), ready: fs.existsSync(path.join(staging, 'READY')),
                previous: fs.existsSync(path.join(dir, 'state.previous.db')),
                pages: fs.existsSync(path.join(staging, 'pages')) ? fs.readdirSync(path.join(staging, 'pages')).length : 0,
            };
        },
        /** This standby's own things, which no copy brings: they must come through a swap. */
        own: async () => {
            const { db } = await import('./db/db.js');
            const cfg = (k: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? null;
            return {
                marker: (db.prepare(`SELECT COUNT(*) AS n FROM system_logs WHERE message LIKE '%paged-copies-marker%'`).get() as { n: number }).n,
                otherCursor: (db.prepare(`SELECT last_synced_at AS c FROM sync_cursors WHERE peer_id = 'test:elsewhere'`).get() as { c: string } | undefined)?.c ?? null,
                roles: db.prepare('SELECT member_pubkey, role FROM node_roles ORDER BY member_pubkey').all(),
                avatarKey: cfg('avatarKeySecret'),
                standbyHealthNote: cfg('appAddressStaffSeen'),
            };
        },
        'plant-own': async (a: { owner: string }) => {
            const { db } = await import('./db/db.js');
            const { logger } = await import('./logger.js');
            logger.info('SYS', 'paged-copies-marker: a line this standby logged itself');
            db.prepare(`INSERT OR REPLACE INTO sync_cursors (peer_id, last_synced_at, last_sync_attempt_at) VALUES ('test:elsewhere', '2026-01-02T03:04:05.000Z', '2026-01-02T03:04:05.000Z')`).run();
            db.prepare(`INSERT OR REPLACE INTO node_config (key, value) VALUES ('appAddressStaffSeen', '{"seen":"by this standby"}')`).run();
            // A role of this standby's own (the take-over bundle brings the main server's; this one is the standby's).
            db.prepare(`INSERT OR REPLACE INTO node_roles (member_pubkey, role, granted_by) VALUES (?, 'admin', 'test')`).run(a.owner);
            return true;
        },
        /** The database's files, in bytes. */
        files: async () => {
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const size = (f: string) => (fs.existsSync(path.join(dir, f)) ? fs.statSync(path.join(dir, f)).size : 0);
            return { db: size('state.db'), wal: size('state.db-wal') };
        },
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        /** M's recovery code and take-over envelope (services/takeover-envelope.ts). */
        'make-envelope': async () => {
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            const made = await makeRecoveryCode();
            const st = await flushTakeoverChecks();
            return { code: made.code, envelopeId: st.envelopeId };
        },
        envelope: async () => {
            const { pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            return pullTakeoverEnvelopeNow();
        },
        'takeover-restart-off': async () => {
            const t = await import('./services/takeover.js');
            t.setTakeoverRestartForTests(() => { /* the suite starts the next one */ });
            return true;
        },
        role: async () => {
            const { getNodeRole } = await import('./state-engine.js');
            return getNodeRole();
        },
        fetches: async () => fetches,
        ...extra,
    });
}
