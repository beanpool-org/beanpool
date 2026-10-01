/**
 * Test Suite: a standby copies the names list as it is, sealed, and a take-over keeps it working (community modes slice
 * 2; engine/names-list.ts; the four plain tables of schema.sql §22e).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * sign their own requests, and this suite plays the admins' phones with @beanpool/core. The standby pulls through its real
 * puller (services/backup-puller.ts) from the main server's real backup routes, and takes over through the real routes
 * with the recovery code, restarting itself. Nothing leaves this machine.
 *
 *  1. On the main server M, Owen's phone makes the list's key for Owen and Ada, two entries are added, Ada confirms Mel
 *     against one and reads the list, and Owen asks for two admins to confirm.
 *  2. A standby S takes its first copy: its four tables hold exactly M's rows, sealed text and wraps, stamps included, and
 *     no byte of its database is a planted name. On S's own server the list opens for nobody (409 `standby`): a read
 *     writes the log, which is the main server's.
 *  3. On M: an entry is edited, another added and deleted, and Mel is re-keyed. The next delta brings all of it: the edit,
 *     the delete (its tombstone), and Mel's confirmation under her new key.
 *  4. M is killed and S takes over with the recovery code. After its restart, Owen's phone opens its own wrap from S and
 *     reads every entry as written on M; Ada's too. The list takes a new entry and a confirmation, the access log holds
 *     M's lines and S's, and two admins to confirm is still the community's setting.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-names-list.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, serveCommands, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Names-Main-Pw-4471!';
const PW_STANDBY = 'Names-Standby-Pw-208!';
const TABLES = ['names_entries', 'names_list_keys', 'confirmations', 'names_access_log'] as const;
/** The planted names: the standby's database must hold none of them. */
const PLANTED = ['Zebedee Quillfeather', 'Ottoline Brackenbury', 'Cornelius Thistlewood', 'Temporary Tamsin'];

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine. */
function guardFetch(): void {
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
}

async function child(): Promise<void> {
    guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; owner: string; members: [string, string][]; admins: string[] }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { db } = await import('./db/db.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            seedGenesisMember(a.owner, 'Owen');
            for (const [key, name] of a.members) {
                db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                            VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'active')`).run(key, name, a.owner, `INV-${name}`);
                db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(key);
            }
            grantNodeRole(a.owner, 'owner', 'owner:password');
            for (const key of a.admins) grantNodeRole(key, 'admin', 'owner:password');
            setReplicationToken(a.replicationToken);
            const made = await makeRecoveryCode();
            await flushTakeoverChecks();
            return { code: made.code };
        },
        'setup-standby': async (a: { primaryUrl: string; replicationToken: string; primaryPeerId: string }) => {
            const { addConnector } = await import('./connector-manager.js');
            const { updateLocalConfig } = await import('./config/local-config.js');
            addConnector(`/ip4/127.0.0.1/tcp/4998/p2p/${a.primaryPeerId}`, 'mirror', 'main-server', undefined, false);
            updateLocalConfig({ backupPrimaryUrl: a.primaryUrl, backupReplicationToken: a.replicationToken });
            return true;
        },
        /** One pull of the kind the loop makes next, and the take-over envelope. */
        pull: async () => {
            const { pullNow, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const result = await pullNow();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, envelope };
        },
        /** Every row of the names list's tables here, in key order; null for a table this server doesn't have. */
        'names-rows': async () => {
            const { db } = await import('./db/db.js');
            const out: Record<string, unknown[] | null> = {};
            for (const t of TABLES) {
                try {
                    const order = t === 'names_list_keys' ? 'holder_pubkey, generation' : 'id';
                    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${order}`).all();
                } catch { out[t] = null; }
            }
            out.tombstones = db.prepare("SELECT table_name, row_key FROM tombstones WHERE table_name IN ('names_entries', 'names_list_keys') ORDER BY row_key").all();
            out.twoAdmins = [(db.prepare("SELECT value FROM node_config WHERE key = 'names_two_admins'").get() as { value: string } | undefined)?.value ?? null];
            return out;
        },
        /** Which planted names, and which sealed fragments, are in this server's database files. */
        scan: async (a: { planted: string[]; sealed: string[] }) => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(PASSIVE)');
            const dir = process.env.BEANPOOL_DATA_DIR!;
            const bytes = ['state.db', 'state.db-wal'].filter((f) => fs.existsSync(path.join(dir, f)))
                .map((f) => fs.readFileSync(path.join(dir, f)).toString('latin1')).join('\n');
            const lower = bytes.toLowerCase();
            return {
                planted: a.planted.filter((p) => lower.includes(Buffer.from(p.toLowerCase(), 'utf8').toString('latin1'))),
                sealed: a.sealed.filter((s) => bytes.includes(s)),
            };
        },
        rekey: async (a: { old: string; next: string; operator: string }) => {
            const { issueRekeyCode, completeRekey } = await import('./engine/member-wizards.js');
            const code = issueRekeyCode(a.old, a.operator).code;
            return completeRekey(a.old, a.next, code, a.operator).success;
        },
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) { testsPassed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}
const j = (v: unknown) => JSON.stringify(v)?.slice(0, 300);

interface Id { pk: string; priv: crypto.KeyObject; seedHex: string; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return {
        pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
        priv: privateKey,
        seedHex: (privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).subarray(-32).toString('hex'),
        name,
    };
}

/** A member's signed request to a node's real HTTPS server. */
async function signedCall(base: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, id: Id, body?: unknown): Promise<{ status: number; body: any }> {
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), id.priv).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

async function main(): Promise<void> {
    const core = await import('@beanpool/core');
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (name: string) => path.join(root, name);
    const nodes: NodeProc[] = [];
    const env = (pw: string, role: string) => ({ ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000' });
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const [owen, ada, mel] = ['Owen', 'Ada', 'Mel'].map(newId);

    /** What an admin's phone does with the list on the server at `base`. */
    const phone = (base: string) => ({
        state: (id: Id) => signedCall(base, 'GET', '/api/names/state', id),
        entries: (id: Id) => signedCall(base, 'GET', '/api/names/entries', id),
        keyOf: async (id: Id, generation: number) => {
            const s = await signedCall(base, 'GET', '/api/names/state', id);
            const wrap = (s.body?.myKeys ?? []).find((k: any) => k.generation === generation);
            if (!wrap) throw new Error(`${id.name} holds no wrap of generation ${generation} (${s.status} ${j(s.body)})`);
            return core.unwrapNamesListKey(wrap, id.seedHex, id.pk, generation);
        },
        add: async (id: Id, key: Uint8Array, generation: number, name: string, note = '') => {
            const entryId = core.newNamesEntryId();
            const r = await signedCall(base, 'POST', '/api/names/entries', id,
                { id: entryId, ciphertext: core.sealNamesEntry(key, entryId, generation, { name, note }), keyGeneration: generation });
            return { ...r, entryId };
        },
    });
    const opened = (key: Uint8Array, list: any) => Object.fromEntries((list?.entries ?? []).map((e: any) => [e.id, core.openNamesEntry(key, e.id, e.keyGeneration, e.ciphertext)]));

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server keeps a names list —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, owner: owen.pk, members: [[ada.pk, 'Ada'], [mel.pk, 'Mel']], admins: [ada.pk] });
        const mBase = `https://localhost:${await main.send('serve')}`;
        const M = phone(mBase);
        const k1 = core.newNamesListKey();
        const made = await signedCall(mBase, 'POST', '/api/names/key', owen, {
            generation: 1, wraps: [owen, ada].map((h) => ({ holder: h.pk, ...core.wrapNamesListKey(k1, h.pk, 1) })),
        });
        require_(made.status === 201, `M: Owen's phone makes the list's key for Owen and Ada (${made.status} ${j(made.body)})`);
        const zeb = await M.add(owen, k1, 1, PLANTED[0], 'Lives by the old cannery');
        const ott = await M.add(ada, await M.keyOf(ada, 1), 1, PLANTED[1]);
        require_(zeb.status === 201 && ott.status === 201, `M: two entries (${zeb.status} ${ott.status})`);
        const conf = await signedCall(mBase, 'POST', '/api/names/confirmations', ada, { memberPubkey: mel.pk, entryId: ott.entryId });
        require_(conf.status === 201 && conf.body?.status === 'confirmed', `M: Ada confirms Mel (${conf.status} ${j(conf.body)})`);
        require_((await M.entries(ada)).status === 200, 'M: Ada reads the list');
        const two = await signedCall(mBase, 'POST', '/api/names/settings', owen, { twoAdminsToConfirm: true });
        require_(two.status === 200 && two.body?.twoAdminsToConfirm === true, `M: Owen asks for two admins to confirm (${two.status})`);

        // ── 2. S's first copy ──
        console.log('\n— 2. a standby takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        await standby.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        const first = await standby.send('pull');
        require_(first.ok === true, `S: its first copy lands (${j(first)})`);
        const mRows1 = await main.send('names-rows');
        const sRows1 = await standby.send('names-rows');
        for (const t of TABLES) {
            assert(Array.isArray(sRows1[t]) && (sRows1[t] as unknown[]).length > 0 && j(sRows1[t]) === j(mRows1[t]) && JSON.stringify(sRows1[t]) === JSON.stringify(mRows1[t]),
                `S holds exactly M's ${t}, sealed, stamps and all (${(sRows1[t] as unknown[] | null)?.length ?? 'no table'} rows)`);
        }
        const sealedBits = (sRows1.names_entries as any[]).map((r) => JSON.parse(r.ciphertext).c.slice(0, 40));
        const s1Scan = await standby.send('scan', { planted: PLANTED, sealed: sealedBits });
        assert(s1Scan.planted.length === 0 && s1Scan.sealed.length === sealedBits.length,
            `S's database holds the sealed entries and no planted name (${j(s1Scan)})`);
        const sBase0 = `https://localhost:${await standby.send('serve')}`;
        const onStandby = await signedCall(sBase0, 'GET', '/api/names/state', owen);
        const writeOnStandby = await signedCall(sBase0, 'POST', '/api/names/entries', owen, { id: core.newNamesEntryId(), ciphertext: 'x', keyGeneration: 1 });
        assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && writeOnStandby.status === 409 && writeOnStandby.body?.code === 'standby',
            `on S's own server the list opens for nobody, a read included: 409 standby (${onStandby.status} ${writeOnStandby.status})`);

        // ── 3. Changes on M, and a delta ──
        console.log('\n— 3. an edit, a delete and a re-key on M; the next delta —');
        const edit = await signedCall(mBase, 'PUT', `/api/names/entries/${zeb.entryId}`, ada,
            { ciphertext: core.sealNamesEntry(k1, zeb.entryId, 1, { name: PLANTED[0], note: 'Moved to Main St' }), keyGeneration: 1 });
        const tmp = await M.add(owen, k1, 1, PLANTED[3]);
        const del = await signedCall(mBase, 'DELETE', `/api/names/entries/${tmp.entryId}`, owen);
        const melNew = newId('Mel');
        const rekeyed = await main.send('rekey', { old: mel.pk, next: melNew.pk, operator: owen.pk });
        require_(edit.status === 200 && tmp.status === 201 && del.status === 200 && rekeyed === true, `M: edited, added and deleted, Mel re-keyed (${edit.status} ${tmp.status} ${del.status})`);
        const delta = await standby.send('pull');
        require_(delta.ok === true, `S: the delta lands (${j(delta)})`);
        const mRows2 = await main.send('names-rows');
        const sRows2 = await standby.send('names-rows');
        for (const t of TABLES) assert(JSON.stringify(sRows2[t]) === JSON.stringify(mRows2[t]), `S holds M's ${t} again (${(sRows2[t] as unknown[]).length} rows)`);
        assert(!(sRows2.names_entries as any[]).some((r) => r.id === tmp.entryId)
            && (sRows2.tombstones as any[]).some((r) => r.table_name === 'names_entries' && r.row_key === tmp.entryId), "the deleted entry's tombstone took it off S");
        const sConf = (sRows2.confirmations as any[]).find((r) => r.id === conf.body.id);
        assert(sConf?.member_pubkey === melNew.pk && sConf?.confirmed_by === ada.pk, `Mel's confirmation names her new key on S (${j(sConf)})`);

        // ── 4. The take-over ──
        console.log('\n— 4. M is killed; S takes over with the recovery code —');
        await standby.send('pull');
        await main.kill('SIGKILL');
        const openedTk = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(openedTk.status === 200 && openedTk.body.success, `the code opens the keys (${openedTk.status} ${j(openedTk.body)})`);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: openedTk.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'S restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        require_(standby.ready.role === 'primary', `S is the main server now (${standby.ready.role})`);
        const sBase = `https://localhost:${await standby.send('serve')}`;
        const S = phone(sBase);
        const sState = await S.state(owen);
        require_(sState.status === 200 && sState.body.generation === 1 && sState.body.newKeyNeeded === false,
            `Owen opens the list on S: generation 1, no new key needed (${sState.status} ${j(sState.body)})`);
        assert(sState.body.settings.twoAdminsToConfirm === true, 'two admins to confirm is still the community\'s setting');
        const owenK = await S.keyOf(owen, 1);
        const adaK = await S.keyOf(ada, 1);
        const owenReads = opened(owenK, (await S.entries(owen)).body);
        const adaReads = opened(adaK, (await S.entries(ada)).body);
        assert(owenReads[zeb.entryId]?.name === PLANTED[0] && owenReads[zeb.entryId]?.note === 'Moved to Main St' && owenReads[ott.entryId]?.name === PLANTED[1]
            && Object.keys(owenReads).length === 2, `Owen's phone reads every entry as written on M, the edit included (${j(owenReads)})`);
        assert(j(adaReads) === j(owenReads), "and so does Ada's");
        const corn = await S.add(ada, adaK, 1, PLANTED[2]);
        assert(corn.status === 201, `the list takes a new entry on S (${corn.status} ${j(corn.body)})`);
        const confS = await signedCall(sBase, 'POST', '/api/names/confirmations', owen, { memberPubkey: melNew.pk, entryId: corn.entryId });
        assert(confS.status === 409 && confS.body?.code === 'already_confirmed',
            `Mel, confirmed on M under her old key, is confirmed on S under her new one: one person, one entry (${confS.status} ${j(confS.body)})`);
        const logS = await signedCall(sBase, 'GET', '/api/names/log?limit=200', ada);
        const actions = (logS.body?.log ?? []).map((l: any) => `${l.actorCallsign ?? l.actor}:${l.action}`);
        assert(logS.status === 200 && actions.includes('Ada:confirm') && actions.includes('Owen:key_made') && actions.includes('Ada:add')
            && actions.filter((a: string) => a === 'Ada:read').length >= 2, `the access log holds M's lines and S's (${actions.join(', ')})`);
    } finally {
        for (const n of nodes) await n.kill();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby copies the names list as it is, sealed, and a take-over keeps it working.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        console.log(`\n${testsPassed}/${testsRun} checks passed.`);
        process.exit(1);
    });
}
