/**
 * Test Suite: a standby copies the names list as it is, sealed, and a take-over keeps it working (community modes slice
 * 2; engine/names-list.ts; the plain tables of schema.sql §22e; DESIGN-names-list-trust-fable.md §10 E5).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; members
 * sign their own requests, and this suite plays the admins' phones with @beanpool/core. The standby pulls through its real
 * puller (services/backup-puller.ts) from the main server's real backup routes, and takes over through the real routes
 * with the recovery code, restarting itself. Nothing leaves this machine.
 *
 *  1. On the main server M, Owen's phone makes the list's first key (a statement it signs, bound to the community's id);
 *     Owen, Ada and Abe check each other, and Owen's phone sends the others the keys; two entries are added, Ada confirms
 *     Mel against one and reads the list, and Owen asks for two admins to confirm. Each admin's phone keeps its pin.
 *  2. A standby S takes its first copy: its tables hold exactly M's rows, sealed text, statements and shares, stamps
 *     included, and no byte of its database is a planted name. On S's own server the list opens for nobody (409
 *     `standby`): a read writes the log, which is the main server's.
 *  3. On M: an entry is edited, another added and deleted, and Mel is re-keyed. Abe stops being an admin; M marks him;
 *     Owen's phone makes generation 2 without him and sends it to Ada. Nothing is sealed again. The next delta brings
 *     all of it: the edit, the delete (its tombstone), Mel's confirmation under her new key, the new statement, the
 *     shares and the mark.
 *  4. M is killed and S takes over with the recovery code. After its restart, S names the same community, every
 *     statement checks out there, and Owen's and Ada's phones, with the pins they kept from M, are ready on S at once (Abe
 *     still dropped) and read every entry as written on M. A statement Abe signs, written into S's database, is refused.
 *     The list takes a new entry and a confirmation, the phones' shares carry on, the access log holds M's lines and
 *     S's, and two admins to confirm is still the community's setting.
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
const TABLES = ['names_entries', 'names_generations', 'names_shares', 'names_dropped_holders', 'confirmations', 'names_access_log'] as const;
const ORDER: Record<string, string> = { names_generations: 'n', names_shares: 'from_pubkey, to_pubkey', names_dropped_holders: 'holder_pubkey, key_id' };
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
                    out[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER[t] ?? 'id'}`).all();
                } catch { out[t] = null; }
            }
            out.tombstones = db.prepare("SELECT table_name, row_key FROM tombstones WHERE table_name LIKE 'names_%' ORDER BY row_key").all();
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
        'add-admin': async (a: { pubkey: string; callsign: string; invitedBy: string }) => {
            const { db } = await import('./db/db.js');
            const { grantNodeRole } = await import('./engine/node-roles.js');
            db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, 'active')`).run(a.pubkey, a.callsign, a.invitedBy, `INV-${a.callsign}`);
            db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(a.pubkey);
            grantNodeRole(a.pubkey, 'admin', 'owner:password');
            return true;
        },
        'drop-admin': async (a: { pubkey: string }) => {
            const { revokeNodeRole } = await import('./engine/node-roles.js');
            revokeNodeRole(a.pubkey, 'admin', 'owner:password');
            return true;
        },
        /** A statement written straight into this server's database, really signed by `seed`'s key, as whoever runs it can. */
        'plant-generation': async (a: { signer: string; seed: string; communityId: string }) => {
            const core = await import('@beanpool/core');
            const { db } = await import('./db/db.js');
            const cur = db.prepare('SELECT id, n FROM names_generations ORDER BY n DESC LIMIT 1').get() as { id: string; n: number };
            const g = core.makeNamesGeneration({ communityId: a.communityId, n: cur.n + 1, parentId: cur.id, drops: [] }, { publicKey: a.signer, privateKey: a.seed });
            db.prepare('INSERT INTO names_generations (id, n, parent_id, maker, drops, statement, signature) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(g.id, g.n, g.parentId, g.maker, '', g.statement, g.signature);
            return g.id;
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
    const [owen, ada, abe, mel] = ['Owen', 'Ada', 'Abe', 'Mel'].map(newId);
    const keysOf = (id: Id) => ({ publicKey: id.pk, privateKey: id.seedHex });
    /** An admin's phone: its pin, which it keeps whichever server it talks to, and the steps the app runs on opening. */
    class Phone {
        pin: any = null;
        constructor(public id: Id) {}
        async open(base: string): Promise<{ plan: any; state: any; made: number | null; sent: string[] }> {
            const look = async () => {
                const st = await signedCall(base, 'GET', '/api/names/state', this.id);
                if (st.status !== 200) throw new Error(`${this.id.name}'s state: ${st.status} ${j(st.body)}`);
                const r = core.syncNames({ pin: this.pin, state: st.body, me: keysOf(this.id) });
                this.pin = r.pin;
                return { plan: r.plan, state: st.body };
            };
            let r = await look();
            let made: number | null = null;
            if (r.plan.kind === 'make_first' || r.plan.kind === 'make_new') {
                const m = core.makeNamesGenerationFor(this.pin, keysOf(this.id), r.plan.kind === 'make_new' ? r.plan.drops : []);
                this.pin = m.pin;
                made = (await signedCall(base, 'POST', '/api/names/generations', this.id, { statement: m.generation.statement, signature: m.generation.signature })).status;
                r = await look();
            }
            const sent: string[] = [];
            if (r.plan.kind === 'ready') {
                for (const sh of core.namesSharesToSend(this.pin, r.state, keysOf(this.id))) {
                    const done = await signedCall(base, 'POST', '/api/names/shares', this.id, { header: sh.header, signature: sh.signature, box: sh.box });
                    if (done.status === 200) sent.push(sh.to);
                }
            }
            return { ...r, made, sent };
        }
        head(): string { return this.pin.chain[this.pin.chain.length - 1].id; }
        key(id = this.head()): Uint8Array { return core.namesRingKeys(this.pin)[id]; }
    }
    const meet = (a: Phone, b: Phone, communityId: string) => {
        a.pin = core.checkNamesKeyInPerson(a.pin ?? core.emptyNamesPin(communityId, a.id.pk), b.id.pk);
        b.pin = core.checkNamesKeyInPerson(b.pin ?? core.emptyNamesPin(communityId, b.id.pk), a.id.pk);
    };
    const add = async (base: string, p: Phone, name: string, note = '') => {
        const entryId = core.newNamesEntryId();
        const r = await signedCall(base, 'POST', '/api/names/entries', p.id, { id: entryId, ciphertext: core.sealNamesEntry(p.key(), entryId, p.head(), { name, note }), keyId: p.head() });
        return { ...r, entryId };
    };
    const entriesOf = (base: string, id: Id) => signedCall(base, 'GET', '/api/names/entries', id);
    const opened = (p: Phone, list: any) => Object.fromEntries((list?.entries ?? []).map((e: any) => [e.id, core.openNamesEntry(p.key(e.keyId), e.id, e.keyId, e.ciphertext)]));

    try {
        // ── 1. M ──
        console.log('\n— 1. the main server keeps a names list —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, owner: owen.pk, members: [[ada.pk, 'Ada'], [abe.pk, 'Abe'], [mel.pk, 'Mel']], admins: [ada.pk, abe.pk] });
        const mBase = `https://localhost:${await main.send('serve')}`;
        const community = (await signedCall(mBase, 'GET', '/api/names/state', owen)).body?.communityId;
        require_(typeof community === 'string' && community.length > 0, `M names its community (${community})`);
        const [owenP, adaP, abeP] = [owen, ada, abe].map((i) => new Phone(i));
        const first0 = await owenP.open(mBase);
        require_(first0.made === 201 && first0.plan.kind === 'ready', `M: Owen's phone makes the list's first key, a statement it signs (${first0.made})`);
        meet(owenP, adaP, community);
        meet(owenP, abeP, community);
        const sentM = await owenP.open(mBase);
        require_(sentM.sent.length === 2, `M: Owen, Ada and Abe check each other, and Owen's phone sends both the keys (${j(sentM.sent)})`);
        for (const p of [adaP, abeP]) require_((await p.open(mBase)).plan.kind === 'ready', `M: ${p.id.name}'s phone opens the list`);
        const k1 = owenP.head();
        const zeb = await add(mBase, owenP, PLANTED[0], 'Lives by the old cannery');
        const ott = await add(mBase, adaP, PLANTED[1]);
        require_(zeb.status === 201 && ott.status === 201, `M: two entries (${zeb.status} ${ott.status})`);
        const conf = await signedCall(mBase, 'POST', '/api/names/confirmations', ada, { memberPubkey: mel.pk, entryId: ott.entryId });
        require_(conf.status === 201 && conf.body?.status === 'confirmed', `M: Ada confirms Mel (${conf.status} ${j(conf.body)})`);
        require_((await entriesOf(mBase, ada)).status === 200, 'M: Ada reads the list');
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
            // Nobody has stopped being an admin yet: no marks to copy.
            const some = t === 'names_dropped_holders' || (sRows1[t] as unknown[]).length > 0;
            assert(Array.isArray(sRows1[t]) && some && JSON.stringify(sRows1[t]) === JSON.stringify(mRows1[t]),
                `S holds exactly M's ${t}, sealed, stamps and all (${(sRows1[t] as unknown[] | null)?.length ?? 'no table'} rows)`);
        }
        const sealedBits = (sRows1.names_entries as any[]).map((r) => JSON.parse(r.ciphertext).c.slice(0, 40));
        const s1Scan = await standby.send('scan', { planted: PLANTED, sealed: sealedBits });
        assert(s1Scan.planted.length === 0 && s1Scan.sealed.length === sealedBits.length,
            `S's database holds the sealed entries and no planted name (${j(s1Scan)})`);
        const sBase0 = `https://localhost:${await standby.send('serve')}`;
        const onStandby = await signedCall(sBase0, 'GET', '/api/names/state', owen);
        const writeOnStandby = await signedCall(sBase0, 'POST', '/api/names/entries', owen, { id: core.newNamesEntryId(), ciphertext: 'x', keyId: k1 });
        assert(onStandby.status === 409 && onStandby.body?.code === 'standby' && writeOnStandby.status === 409 && writeOnStandby.body?.code === 'standby',
            `on S's own server the list opens for nobody, a read included: 409 standby (${onStandby.status} ${writeOnStandby.status})`);

        // ── 3. Changes on M, and a delta ──
        console.log('\n— 3. an edit, a delete and a re-key on M; the next delta —');
        const edit = await signedCall(mBase, 'PUT', `/api/names/entries/${zeb.entryId}`, ada,
            { ciphertext: core.sealNamesEntry(adaP.key(), zeb.entryId, k1, { name: PLANTED[0], note: 'Moved to Main St' }), keyId: k1 });
        const tmp = await add(mBase, owenP, PLANTED[3]);
        const del = await signedCall(mBase, 'DELETE', `/api/names/entries/${tmp.entryId}`, owen);
        const melNew = newId('Mel');
        const rekeyed = await main.send('rekey', { old: mel.pk, next: melNew.pk, operator: owen.pk });
        require_(edit.status === 200 && tmp.status === 201 && del.status === 200 && rekeyed === true, `M: edited, added and deleted, Mel re-keyed (${edit.status} ${tmp.status} ${del.status})`);
        // Abe stops being an admin: M marks him; Owen's phone makes generation 2 without him and sends it to Ada.
        require_(await main.send('drop-admin', { pubkey: abe.pk }) === true, 'M: Abe stops being an admin');
        const o2 = await owenP.open(mBase);
        const k2 = owenP.head();
        require_(o2.made === 201 && o2.plan.kind === 'ready' && j(o2.sent) === j([ada.pk]), `M: Owen's phone makes generation 2 without Abe and sends it to Ada (${o2.made} ${j(o2.sent)})`);
        require_((await adaP.open(mBase)).plan.kind === 'ready' && adaP.head() === k2, "M: Ada's phone takes it");
        const delta = await standby.send('pull');
        require_(delta.ok === true, `S: the delta lands (${j(delta)})`);
        const mRows2 = await main.send('names-rows');
        const sRows2 = await standby.send('names-rows');
        for (const t of TABLES) assert(JSON.stringify(sRows2[t]) === JSON.stringify(mRows2[t]), `S holds M's ${t} again (${(sRows2[t] as unknown[]).length} rows)`);
        assert(!(sRows2.names_entries as any[]).some((r) => r.id === tmp.entryId)
            && (sRows2.tombstones as any[]).some((r) => r.table_name === 'names_entries' && r.row_key === tmp.entryId), "the deleted entry's tombstone took it off S");
        const sConf = (sRows2.confirmations as any[]).find((r) => r.id === conf.body.id);
        assert(sConf?.member_pubkey === melNew.pk && sConf?.confirmed_by === ada.pk, `Mel's confirmation names her new key on S (${j(sConf)})`);
        const sGens = sRows2.names_generations as any[];
        assert(sGens.length === 2 && sGens[1].id === k2 && sGens[1].drops === abe.pk && sGens.every((g: any) => core.readNamesGeneration(g, community)?.id === g.id),
            `S holds the key history, statement by statement: generation 2 drops Abe, and each still checks out (${sGens.length} statements)`);
        assert((sRows2.names_dropped_holders as any[]).some((r) => r.holder_pubkey === abe.pk && r.key_id === k1) && (sRows2.names_shares as any[]).length >= 3,
            "and the shares and the mark that froze writes until generation 2 came");
        const sEntries = sRows2.names_entries as any[];
        assert(sEntries.every((e) => e.key_id === k1), 'nothing was sealed again: every entry is still under key 1');

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
        const sState = await signedCall(sBase, 'GET', '/api/names/state', owen);
        require_(sState.status === 200 && sState.body.current?.id === k2 && sState.body.newKeyNeeded === false,
            `Owen opens the list on S: generation 2 is current, no new key needed (${sState.status} ${j(sState.body?.current)})`);
        assert(sState.body.settings.twoAdminsToConfirm === true, 'two admins to confirm is still the community\'s setting');
        assert(sState.body.communityId === community && sState.body.generations.length === 2
            && sState.body.generations.every((g: any) => core.readNamesGeneration(g, community)?.id === g.id),
            `E5 S names the same community, and every statement checks out there (${sState.body.generations.length} statements)`);
        const pinsBefore = JSON.stringify([owenP.pin, adaP.pin]);
        const owenS = await owenP.open(sBase);
        const adaS = await adaP.open(sBase);
        assert(owenS.plan.kind === 'ready' && adaS.plan.kind === 'ready' && owenS.made === null && adaS.made === null
            && JSON.stringify([owenP.pin.chain, adaP.pin.chain]) === JSON.stringify(JSON.parse(pinsBefore).map((p: any) => p.chain)),
            `E5 Owen's and Ada's phones, with the pins they kept from M, are ready on S at once, their histories unchanged (${j([owenS.plan, adaS.plan])})`);
        assert(!owenP.pin.trusted.includes(abe.pk) && !adaP.pin.trusted.includes(abe.pk), 'Abe is still dropped on both');
        const owenReads = opened(owenP, (await entriesOf(sBase, owen)).body);
        const adaReads = opened(adaP, (await entriesOf(sBase, ada)).body);
        assert(owenReads[zeb.entryId]?.name === PLANTED[0] && owenReads[zeb.entryId]?.note === 'Moved to Main St' && owenReads[ott.entryId]?.name === PLANTED[1]
            && Object.keys(owenReads).length === 2, `Owen's phone reads every entry as written on M, the edit included (${j(owenReads)})`);
        assert(j(adaReads) === j(owenReads), "and so does Ada's");
        const corn = await add(sBase, adaP, PLANTED[2]);
        assert(corn.status === 201, `the list takes a new entry on S, under key 2 (${corn.status} ${j(corn.body)})`);
        const confS = await signedCall(sBase, 'POST', '/api/names/confirmations', owen, { memberPubkey: melNew.pk, entryId: corn.entryId });
        assert(confS.status === 409 && confS.body?.code === 'already_confirmed',
            `Mel, confirmed on M under her old key, is confirmed on S under her new one: one person, one entry (${confS.status} ${j(confS.body)})`);
        // The phones' shares carry on: a new admin, checked by Owen, gets the keys from S.
        const cy = newId('Cy');
        require_(await standby.send('add-admin', { pubkey: cy.pk, callsign: 'Cy', invitedBy: owen.pk }) === true, 'S: Cy is made an admin');
        const cyP = new Phone(cy);
        meet(owenP, cyP, community);
        const toCy = await owenP.open(sBase);
        assert(toCy.sent.includes(cy.pk) && (await cyP.open(sBase)).plan.kind === 'ready', `E5 auto-shares continue on S: Owen's phone sends Cy the keys, and Cy's phone is ready (${j(toCy.sent)})`);
        const logS = await signedCall(sBase, 'GET', '/api/names/log?limit=200', ada);
        const actions = (logS.body?.log ?? []).map((l: any) => `${l.actorCallsign ?? l.actor}:${l.action}`);
        assert(logS.status === 200 && actions.includes('Ada:confirm') && actions.includes('Owen:key_made') && actions.includes('Ada:add') && actions.includes('Owen:key_shared')
            && actions.filter((a: string) => a === 'Ada:read').length >= 2, `the access log holds M's lines and S's (${actions.join(', ')})`);
        // Abe, dropped on M, really signs a statement off S's current one, written into S's database: Owen's phone refuses it.
        await standby.send('plant-generation', { signer: abe.pk, seed: abe.seedHex, communityId: community });
        const owenVsAbe = await owenP.open(sBase);
        assert(owenVsAbe.plan.kind === 'refused' && owenVsAbe.plan.reason === 'untrusted_maker' && owenVsAbe.plan.maker === abe.pk && owenVsAbe.sent.length === 0,
            `E5 after the take-over, a statement Abe signs is still refused: his drop is in Owen's phone's own history (${j(owenVsAbe.plan)})`);
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
