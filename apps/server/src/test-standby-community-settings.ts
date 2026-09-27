/**
 * Test Suite: a standby keeps the community's own settings without applying them, and a take-over installs them (G5 of
 * scratch/global-node/DESIGN-standby-takeover-gaps-opus.md; config/community-settings.ts).
 *
 * Every node is its own process with its own data dir (takeover-test-harness.ts) serving its real HTTPS server; the admin
 * acts through it with the password. The standby pulls through its real puller (services/backup-puller.ts `pullNow`) from
 * the main server's real backup routes, through a door here that can serve the next copy it asks for from a payload the
 * main server signed; it takes over through the real routes and restarts itself. Nothing leaves this machine: the
 * directory the promoted server publishes to is a door here too.
 *
 *  1. The main server M sets its community up: a name, place and contacts, a currency display, thresholds, directory
 *     choices with its contacts and member count OFF and a service area, a pricing source and seasonality, a snapshot
 *     schedule, and an accepted non-zero audit baseline (the test node's -9.82 kind).
 *  2. A standby S with settings of its own takes its first copy: it keeps M's record, and its own name, contacts,
 *     directory choices, thresholds, gateway and baseline stay its own.
 *  3. M changes its phone and stops publishing its health (a save of that one switch, which leaves the others as they
 *     were: before, it published the contacts and member count M had turned off), and sets its gateway (other origins
 *     for its web app, a switch, the request limit, and an admin IP allowlist of its own): the next delta brings the new
 *     record, applied to nothing.
 *  4. A standby S2 promoted by hand (its role changed in .env, no take-over) installs M's settings at its first boot as
 *     a main server, and its ledger audit holds the ledger to M's baseline; installed once: a later change on S2 stays.
 *  5. A record signed by M that names settings of one server (the admin password, the replication token and main
 *     server, the role, the identity epoch, the web address, the importer's format, an avatar key, a profile switch, an
 *     admin IP allowlist) and a value the standby can't take: kept without any of them, and S's own settings unchanged.
 *  6. M is killed; S takes over with the recovery code. The preview no longer says the settings will be missing. After
 *     the restart every community setting is M's (the one with a value it couldn't take is S's own), and no setting of
 *     one server came from the record: the admin password is the community's, from the keys; the replication token,
 *     pull interval, avatar key and importer format are S's; the main server and its token are gone; the identity epoch
 *     is the bundle's plus one; the admin IP allowlist is S's own.
 *  7. The promotion audit ran on M's baseline: "the ledger adds up" (before, S's own baseline: "does NOT add up").
 *  8. The directory publisher on the promoted server sends the community's name and area, and not its contacts, member
 *     count or health, which the community had turned off; nothing of S's own name or contacts.
 *
 * Run:
 *   ENABLE_PEER_CONNECTORS=true BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-standby-community-settings.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawnNode, post, runNodeChild, serveCommands, inspectNode, type NodeProc } from './takeover-test-harness.js';

delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // the nodes' own self-signed certificates

const SCRIPT = fileURLToPath(import.meta.url);
const PW_MAIN = 'Settings-Main-Pw-5520!';
const PW_STANDBY = 'Settings-Standby-Pw-118!';
const PW_STANDBY2 = 'Settings-Standby2-Pw-406!';

// ── The node processes' commands ───────────────────────────────────────────────────────────

/** No node reaches anything but this machine: a push to Expo is answered here, anything else refused and counted. */
function guardFetch(): { blocked: string[] } {
    const seen = { blocked: [] as string[] };
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return real(input, init);
        if (url.hostname === 'exp.host') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        seen.blocked.push(url.hostname);
        throw new Error(`this suite reaches nothing off this machine (${url.hostname})`);
    }) as typeof fetch;
    return seen;
}

async function child(): Promise<void> {
    const fetches = guardFetch();
    await runNodeChild({
        ...serveCommands,
        'setup-primary': async (a: { replicationToken: string; genesis: string }) => {
            const { seedGenesisMember } = await import('./engine/members.js');
            const { setReplicationToken } = await import('./config/local-config.js');
            const { makeRecoveryCode, flushTakeoverChecks } = await import('./services/takeover-envelope.js');
            seedGenesisMember(a.genesis, 'Gwen');
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
        /**
         * A standby's settings of its own, as its operator set them: its name, place, contacts, gateway (its own admin IP
         * allowlist), thresholds, pull interval, a replication token for standbys of its own, and its directory choices.
         */
        'set-own': async (a: { name: string; callsign: string; email: string; allowlist: string[]; ownToken: string }) => {
            const { updateLocalConfig, setReplicationToken, DEFAULT_THRESHOLDS, DEFAULT_GATEWAY_CONFIG } = await import('./config/local-config.js');
            const { updateNodeConfig } = await import('./state-engine.js');
            updateLocalConfig({
                callsign: a.callsign, communityName: a.name, location: { lat: 51.5, lng: -0.12 }, contactEmail: a.email, contactPhone: '+44 20 7946 0000',
                gateway: { ...DEFAULT_GATEWAY_CONFIG, corsAllowedOrigins: ['https://standby.example'], adminIpAllowlist: a.allowlist },
                thresholds: { ...DEFAULT_THRESHOLDS, circulationEpochDays: 20 }, backupPullSeconds: 30,
            });
            setReplicationToken(a.ownToken);
            updateNodeConfig({ serviceRadius: { lat: 51.5, lng: -0.12, radiusKm: 50 }, directoryPushIntervalHours: 24 });
            return true;
        },
        /** A local-config.json field no route sets (the currency display), or a change after a promotion. */
        'set-local': async (a: { patch: Record<string, unknown> }) => {
            const { updateLocalConfig } = await import('./config/local-config.js');
            updateLocalConfig(a.patch as any);
            return true;
        },
        /** One pull of the kind the loop makes next, and the take-over envelope. */
        pull: async () => {
            const { pullNow, pullTakeoverEnvelopeNow } = await import('./services/backup-puller.js');
            const result = await pullNow();
            const envelope = await pullTakeoverEnvelopeNow();
            return { ...result, envelope };
        },
        /** The settings as this server uses them, the record it keeps, and what it would tell the directory. */
        settings: async () => {
            const { db } = await import('./db/db.js');
            const { getLocalConfig } = await import('./config/local-config.js');
            const { getNodeConfig, getDirectoryInfo } = await import('./state-engine.js');
            // A server from before the record has no module for it: it keeps nothing.
            const settings: any = await import('./config/community-settings.js').catch(() => ({}));
            const rows = db.prepare('SELECT key, value FROM node_config ORDER BY key').all() as { key: string; value: string }[];
            return {
                localConfig: getLocalConfig(),
                rows: Object.fromEntries(rows.map((r) => [r.key, r.value])),
                blob: getNodeConfig(),
                kept: typeof settings.keptCommunitySettings === 'function' ? settings.keptCommunitySettings() : null,
                directory: getDirectoryInfo(),
            };
        },
        /** Whether a password is this server's admin password now. */
        'admin-password-is': async (a: { password: string }) => {
            const { getLocalConfig, verifyPassword } = await import('./config/local-config.js');
            const c = getLocalConfig();
            return !!(c.adminHash && c.salt && verifyPassword(a.password, c.adminHash, c.salt));
        },
        /** An old bug's drift, as a raw write, for the admin to accept as the audit baseline. */
        drift: async (a: { publicKey: string; amount: number }) => {
            const { db } = await import('./db/db.js');
            const { reconcileLedgerFromDb } = await import('./state-engine.js');
            db.prepare('UPDATE accounts SET balance = balance + ? WHERE public_key = ?').run(a.amount, a.publicKey);
            reconcileLedgerFromDb();
            return true;
        },
        /**
         * M's real copy, with its settings record carrying settings of one server at every level, a key named `__proto__`,
         * and a value no standby can take. Signed with M's own key: only the standby's check stands between it and them.
         */
        'forge-settings': async () => {
            const { exportSyncState, signSyncPayload } = await import('./state-engine.js');
            const { getPrivateKey } = await import('./p2p.js');
            const { peerIdFromPrivateKey } = await import('@libp2p/peer-id');
            const payload: any = await exportSyncState(peerIdFromPrivateKey(getPrivateKey()).toString());
            delete payload.signature;
            delete payload.publicKey;
            const rec = payload.communitySettings ?? { localConfig: {}, nodeConfig: {}, directory: {} };
            Object.assign(rec.localConfig, {
                adminHash: 'f'.repeat(128), salt: 'e'.repeat(64), isLocked: false, totpEnabled: true, totpSecret: 'EVILSECRET',
                backupPrimaryUrl: 'https://evil.example', backupReplicationToken: 'evil-token', backupPullSeconds: 5,
                replicationTokenHash: 'd'.repeat(128), replicationTokenSalt: 'c'.repeat(64), replicationTokenOnly: false,
                nodeRole: 'backup', identityEpoch: 99, identityReplaced: null, recoveryCode: null,
            });
            rec.localConfig.gateway = { ...(rec.localConfig.gateway ?? {}), adminIpAllowlist: ['0.0.0.0', '*'] };
            rec.localConfig.thresholds = { ...(rec.localConfig.thresholds ?? {}), notAThreshold: 7 };
            Object.defineProperty(rec.localConfig, '__proto__', { value: { isLocked: false, nodeRole: 'backup' }, enumerable: true });
            Object.assign(rec.nodeConfig, {
                publicAddress: JSON.stringify({ hostname: 'evil.example' }), replica_format: '0', 'nodeProfile.beans': 'false',
                avatarKeySecret: 'ab'.repeat(32), node_config: '{}', recovery_seal_cleared: 'evil',
                pricing_show_seasonality: 'maybe', // a value no standby can take
            });
            Object.assign(rec.directory, {
                publicAddress: { hostname: 'evil.example', tunnelToken: 'evil' }, ownerAddresses: ['evil.example'], registrarNames: [],
                lastDirectoryPush: '2000-01-01T00:00:00.000Z',
            });
            payload.communitySettings = rec;
            payload.generatedAt = new Date().toISOString();
            return signSyncPayload(payload);
        },
        /** The ledger conservation audit (promotionSanityCheck), run now. */
        'ledger-audit': async () => {
            const { promotionSanityCheck } = await import('./state-engine.js');
            return promotionSanityCheck();
        },
        /** One push to the directory registry, as the publisher's timer makes it. */
        'directory-push': async () => {
            const { pushDirectoryNow } = await import('./services/directory-publisher.js');
            return pushDirectoryNow();
        },
        inspect: async () => inspectNode({}),
        checkpoint: async () => {
            const { db } = await import('./db/db.js');
            db.pragma('wal_checkpoint(TRUNCATE)');
            return true;
        },
        fetches: async () => fetches,
    });
}

// ── The orchestrator ───────────────────────────────────────────────────────────────────────

let testsRun = 0;
let testsPassed = 0;
function assert(cond: unknown, msg: string): void {
    testsRun++;
    if (cond) {
        testsPassed++;
        console.log(`✓ ${msg}`);
    } else {
        console.error(`✗ ${msg}`);
    }
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`cannot go on: ${msg}`);
}

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}

interface Answer { status: number; body: any }

/** A call to a node's real HTTPS server, signed by `as`, with the admin password in `admin`, or neither. */
async function api(base: string, method: 'GET' | 'POST', route: string, opts: { as?: Id; admin?: string; body?: unknown } = {}): Promise<Answer> {
    const raw = method === 'GET' ? '' : JSON.stringify(opts.body ?? {});
    const headers: Record<string, string> = {};
    if (opts.as) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = opts.as.pk;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${route.split('?')[0]}\n${ts}\n${nonce}\n${raw}`), opts.as.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (opts.admin) headers['X-Admin-Password'] = opts.admin;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const res = await fetch(`${base}${route}`, { method, headers, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body };
}

const brief = (a: Answer) => `${a.status} ${JSON.stringify(a.body)?.slice(0, 160)}`;
function built(what: string, a: Answer): any {
    require_(a.status >= 200 && a.status < 300, `M: ${what} (${brief(a)})`);
    return a.body;
}
const j = (v: unknown) => JSON.stringify(v ?? null);

/**
 * The main server as its standbys reach it: every request passed to its real backup routes, except that a step can have
 * the next copy a standby asks for answered with a payload M signed. The standby's own puller fetches, checks, imports it.
 */
interface MainServerDoor { url: string; next: (body: unknown) => void; waiting: () => number; close: () => Promise<void> }
async function mainServerDoor(target: string): Promise<MainServerDoor> {
    const queued: unknown[] = [];
    const server = http.createServer((req, res) => {
        void (async () => {
            try {
                if (req.url?.startsWith('/api/local/admin/sync-') && queued.length > 0) {
                    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Node-Role': 'primary' });
                    res.end(JSON.stringify(queued.shift()));
                    return;
                }
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const headers: Record<string, string> = {};
                for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && (k.startsWith('x-') || k === 'content-type')) headers[k] = v;
                const r = await fetch(target + req.url, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
                const out: Record<string, string> = { 'Content-Type': r.headers.get('content-type') ?? 'application/json' };
                const role = r.headers.get('x-node-role');
                if (role) out['X-Node-Role'] = role;
                res.writeHead(r.status, out);
                res.end(Buffer.from(await r.arrayBuffer()));
            } catch (e: any) {
                res.writeHead(502);
                res.end(String(e?.message || e));
            }
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        next: (body) => { queued.push(body); },
        waiting: () => queued.length,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

/** The public directory registry, on this machine: every body the promoted server sends it. */
async function directoryRegistry(): Promise<{ url: string; bodies: any[]; close: () => Promise<void> }> {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(c as Buffer);
            try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { bodies.push(null); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        })();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/directory-register`,
        bodies,
        close: () => new Promise<void>((r) => server.close(() => r())),
    };
}

type Settings = { localConfig: any; rows: Record<string, string>; blob: any; kept: any; directory: any };

const LOCAL = ['callsign', 'communityName', 'location', 'contactEmail', 'contactPhone', 'currencyType', 'currencyValue', 'thresholds'] as const;
const ROWS = ['ledger_audit_baseline', 'ledger_audit_rebaseline_note', 'pricing_data_source', 'pricing_show_seasonality', 'autosnapshot_config'] as const;
const BLOB = ['serviceRadius', 'publishLocation', 'publishMembers', 'publishContacts', 'publishHealth', 'directoryPushIntervalHours'] as const;
/** The gateway without its admin IP allowlist: the community's part of it. */
const communityGateway = (g: any) => (g ? Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'adminIpAllowlist')) : null);

/** Every community setting, as a server uses it, keyed by where it lives. */
function communitySettings(s: Settings): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const f of LOCAL) out[`local-config.${f}`] = s.localConfig[f] ?? null;
    out['local-config.gateway'] = communityGateway(s.localConfig.gateway);
    for (const k of ROWS) out[`node_config.${k}`] = s.rows[k] ?? null;
    for (const f of BLOB) out[`node_config.node_config.${f}`] = s.blob[f] ?? null;
    return out;
}

/** The settings where two servers differ (`only`: just these), as "where: a, b". */
function differing(a: Record<string, unknown>, b: Record<string, unknown>, only?: string[]): string[] {
    return Object.keys(a).filter((k) => (!only || only.includes(k)) && j(a[k]) !== j(b[k])).map((k) => `${k}: ${j(a[k])} vs ${j(b[k])}`);
}
const first = (xs: string[]) => (xs.length === 0 ? 'none' : `${xs.length}: ${xs.slice(0, 5).join(' | ')}`);

async function main(): Promise<void> {
    const root = process.env.BEANPOOL_DATA_DIR;
    if (!root) throw new Error('Set BEANPOOL_DATA_DIR to a throwaway directory');
    const dir = (n: string) => path.join(root, n);
    const nodes: NodeProc[] = [];
    const closers: (() => Promise<void>)[] = [];
    const started = Date.now();
    const replicationToken = crypto.randomBytes(32).toString('hex');
    const env = (pw: string, role: string, extra: Record<string, string> = {}) => ({
        ADMIN_PASSWORD: pw, NODE_ROLE: role, NODE_ENV: 'test', BACKUP_RECONCILE_EVERY_MS: '86400000', ...extra,
    });
    const gwen = newId('Gwen');
    const [ann, bo] = ['Ann', 'Bo'].map(newId);
    const refused: string[] = [];

    try {
        // ── 1. M sets its community up ──
        console.log('\n— 1. the main server sets its community up —');
        const main = await spawnNode(SCRIPT, dir('main'), env(PW_MAIN, 'primary'));
        nodes.push(main);
        const setup = await main.send('setup-primary', { replicationToken, genesis: gwen.pk });
        const m = `https://localhost:${await main.send('serve')}`;
        const A = (route: string, body: unknown) => api(m, 'POST', route, { admin: PW_MAIN, body });
        for (const who of [ann, bo]) {
            const inv = built(`Gwen makes an invite for ${who.name}`, await api(m, 'POST', '/api/invite/generate', { as: gwen, body: { publicKey: gwen.pk } }));
            built(`${who.name} joins with it`, await api(m, 'POST', '/api/invite/redeem', { body: { code: inv.invite?.code ?? inv.code, publicKey: who.pk, callsign: who.name } }));
        }
        built('the community names itself, its place and its contacts', await A('/api/local/update-identity', {
            callsign: 'riverbend', communityName: 'Riverbend Commons', lat: -33.71, lng: 151.1, contactEmail: 'hello@riverbend.example', contactPhone: '+61 2 5550 0101',
        }));
        built('it keeps its contacts and member count out of the directory, and draws its service area', await A('/api/local/admin/node/config', {
            publishContacts: false, publishMembers: false, serviceRadius: { lat: -33.71, lng: 151.1, radiusKm: 9 }, directoryPushIntervalHours: 6,
        }));
        built('it sets its own thresholds', await A('/api/admin/thresholds', { circulationEpochDays: 45, washTradingMinTxns: 6 }));
        built('its pricing guide reads every linked community, without seasons', await A('/api/pricing-guide/admin/config', { dataSource: 'federation', showSeasonality: false }));
        built('its snapshot schedule', await A('/api/local/admin/snapshots/config', { enabled: false, intervalHours: 6, keep: 3 }));
        await main.send('set-local', { patch: { currencyType: 'text', currencyValue: 'Seeds' } });
        built('an old bug left 0.1 Beans of drift', { status: (await main.send('drift', { publicKey: gwen.pk, amount: 0.1 })) ? 200 : 500, body: {} });
        built('the admin accepts it as the audit baseline', await A('/api/local/admin/ledger-rebaseline', { reason: 'Drift from an old bug, checked by hand' }));
        let mSettings: Settings = await main.send('settings');
        require_(mSettings.rows.ledger_audit_baseline && Math.abs(Number(mSettings.rows.ledger_audit_baseline) - 0.1) < 1e-9,
            `M: its accepted baseline is 0.1 (${mSettings.rows.ledger_audit_baseline})`);

        // ── 2. S, with settings of its own, and its first copy ──
        console.log('\n— 2. a standby with settings of its own takes its first copy —');
        fs.mkdirSync(dir('standby'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby'), 'genesis.json'));
        let standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup'));
        nodes.push(standby);
        const door = await mainServerDoor(main.base);
        closers.push(door.close);
        await standby.send('setup-standby', { primaryUrl: door.url, replicationToken, primaryPeerId: main.ready.peerId });
        await standby.send('set-own', {
            name: 'Standby Seven', callsign: 'standby-7', email: 'ops@standby.example', allowlist: ['198.51.100.9'], ownToken: crypto.randomBytes(32).toString('hex'),
        });
        const sOwn: Settings = await standby.send('settings');
        const sOwnCommunity = communitySettings(sOwn);
        const mCommunity1 = communitySettings(mSettings);
        assert(differing(mCommunity1, sOwnCommunity).length >= 15,
            `S's own settings differ from M's in nearly every field, so each one below means something (${first(differing(mCommunity1, sOwnCommunity))})`);
        const firstPull = await standby.send('pull');
        require_(firstPull.ok === true, `S's first copy lands (${firstPull.ok ? 'imported' : firstPull.error})`);
        let sNow: Settings = await standby.send('settings');
        assert(differing(sOwnCommunity, communitySettings(sNow)).length === 0,
            `while a standby, S keeps its own name, place, contacts, currency, thresholds, gateway, directory choices, baseline, pricing and snapshots (changed: ${first(differing(sOwnCommunity, communitySettings(sNow)))})`);
        assert(sNow.directory?.contactEmail === 'ops@standby.example' && sNow.directory?.name === 'Standby Seven',
            `what S would tell the directory is still its own (${j({ name: sNow.directory?.name, email: sNow.directory?.contactEmail })})`);
        const kept1 = sNow.kept;
        assert(kept1 && kept1.installedAt === null && kept1.record?.localConfig?.communityName === 'Riverbend Commons'
            && kept1.record?.directory?.publishContacts === false && kept1.record?.nodeConfig?.ledger_audit_baseline === mSettings.rows.ledger_audit_baseline,
            `S keeps M's record, not installed: its name, its choice not to publish contacts, its baseline (${j(kept1 && { installedAt: kept1.installedAt, name: kept1.record?.localConfig?.communityName, publishContacts: kept1.record?.directory?.publishContacts, baseline: kept1.record?.nodeConfig?.ledger_audit_baseline })})`);

        // ── 3. M changes its settings; a delta brings them ──
        console.log('\n— 3. the main server changes its settings; a delta brings them —');
        built('M changes its phone number', await A('/api/local/update-identity', { contactPhone: '+61 2 5550 0199' }));
        built('and stops publishing its health', await A('/api/local/admin/node/config', { publishHealth: false }));
        // The last admin call on M's HTTPS server: its admin IP allowlist names an address this machine is not.
        built('it sets its gateway: another origin for its web app, messaging off, a request limit, an admin IP allowlist', await A('/api/local/admin/gateway', {
            corsAllowedOrigins: ['https://app.riverbend.example'], features: { messaging: false }, rateLimiting: { enabled: true, maxRequestsPerMinute: 300 },
            adminIpAllowlist: ['203.0.113.7'],
        }));
        mSettings = await main.send('settings');
        const mCommunity = communitySettings(mSettings);
        require_(mSettings.localConfig.gateway?.adminIpAllowlist?.[0] === '203.0.113.7' && mSettings.blob.publishHealth === false,
            `M: its gateway and its health choice are set (${j({ gateway: mSettings.localConfig.gateway, publishHealth: mSettings.blob.publishHealth })})`);
        // Before, the route passed the fields a request left out on as undefined, the stored object dropped them, and each
        // switch read unset as "publish": this save published M's contacts and member count and dropped its service area.
        assert(mSettings.blob.publishContacts === false && mSettings.blob.publishMembers === false && mSettings.blob.serviceRadius?.radiusKm === 9
            && mSettings.blob.directoryPushIntervalHours === 6,
            `a save that changes one directory switch leaves the others as the community set them (${j({ contacts: mSettings.blob.publishContacts, members: mSettings.blob.publishMembers, radius: mSettings.blob.serviceRadius, every: mSettings.blob.directoryPushIntervalHours })})`);
        const delta = await standby.send('pull');
        require_(delta.ok === true, `the delta lands (${delta.ok ? 'imported' : delta.error})`);
        sNow = await standby.send('settings');
        assert(differing(sOwnCommunity, communitySettings(sNow)).length === 0 && j(sNow.localConfig.gateway?.adminIpAllowlist) === j(['198.51.100.9']),
            `still S's own after the delta (changed: ${first(differing(sOwnCommunity, communitySettings(sNow)))}; its allowlist ${j(sNow.localConfig.gateway?.adminIpAllowlist)})`);
        assert(sNow.kept?.record?.localConfig?.contactPhone === '+61 2 5550 0199' && sNow.kept?.record?.directory?.publishHealth === false
            && sNow.kept?.record?.localConfig?.gateway?.corsAllowedOrigins?.[0] === 'https://app.riverbend.example'
            && !('adminIpAllowlist' in (sNow.kept?.record?.localConfig?.gateway ?? {})),
            `the kept record is M's new one, its gateway without M's admin IP allowlist (${j(sNow.kept?.record?.localConfig?.gateway)})`);

        // ── 4. A standby promoted by hand ──
        console.log('\n— 4. a standby promoted by hand installs the settings at its first boot as a main server —');
        fs.mkdirSync(dir('standby2'), { recursive: true });
        fs.copyFileSync(path.join(dir('main'), 'genesis.json'), path.join(dir('standby2'), 'genesis.json'));
        let standby2 = await spawnNode(SCRIPT, dir('standby2'), env(PW_STANDBY2, 'backup'));
        nodes.push(standby2);
        await standby2.send('setup-standby', { primaryUrl: main.base, replicationToken, primaryPeerId: main.ready.peerId });
        await standby2.send('set-own', {
            name: 'Standby Two', callsign: 'standby-2', email: 'ops2@standby.example', allowlist: ['192.0.2.44'], ownToken: crypto.randomBytes(32).toString('hex'),
        });
        const s2Own = communitySettings(await standby2.send('settings'));
        const s2Pull = await standby2.send('pull');
        require_(s2Pull.ok === true, `S2's first copy lands (${s2Pull.ok ? 'imported' : s2Pull.error})`);
        assert(differing(s2Own, communitySettings(await standby2.send('settings'))).length === 0, 'S2 keeps its own settings while a standby');
        await standby2.send('checkpoint');
        await standby2.kill('SIGTERM');
        standby2 = await spawnNode(SCRIPT, dir('standby2'), env(PW_STANDBY2, 'primary'));
        nodes.push(standby2);
        require_(standby2.ready.role === 'primary', `S2 starts as a main server, with no take-over (${standby2.ready.role})`);
        let s2: Settings = await standby2.send('settings');
        assert(differing(mCommunity, communitySettings(s2)).length === 0,
            `every community setting is M's (differing: ${first(differing(mCommunity, communitySettings(s2)))})`);
        assert(j(s2.localConfig.gateway?.adminIpAllowlist) === j(['192.0.2.44']) && s2.kept?.installedAt,
            `S2 keeps its own admin IP allowlist, and the record says when it was installed (${j({ allowlist: s2.localConfig.gateway?.adminIpAllowlist, installedAt: s2.kept?.installedAt })})`);
        const s2Audit = await standby2.send('ledger-audit');
        assert(s2Audit.ok === true && Math.abs(s2Audit.baseline - 0.1) < 1e-9 && Math.abs(s2Audit.drift) < 0.01,
            `its ledger audit holds the ledger to M's accepted baseline: it adds up (${j(s2Audit)})`);
        await standby2.send('set-local', { patch: { communityName: 'Renamed After Promotion' } });
        await standby2.send('checkpoint');
        await standby2.kill('SIGTERM');
        standby2 = await spawnNode(SCRIPT, dir('standby2'), env(PW_STANDBY2, 'primary'));
        nodes.push(standby2);
        s2 = await standby2.send('settings');
        assert(s2.localConfig.communityName === 'Renamed After Promotion',
            `installed once: a change made after the promotion stays across the next start (${j(s2.localConfig.communityName)})`);
        refused.push(...(await standby2.send('fetches')).blocked);
        await standby2.kill('SIGTERM');

        // ── 5. A record naming settings of one server ──
        console.log('\n— 5. a record signed by the main server that names settings of one server —');
        const sBefore: Settings = await standby.send('settings');
        door.next(await main.send('forge-settings'));
        const forged = await standby.send('pull');
        require_(forged.ok === true && door.waiting() === 0, `the forged copy is served and lands (${forged.ok ? 'imported' : forged.error})`);
        sNow = await standby.send('settings');
        const rec = sNow.kept?.record ?? {};
        const sections: [string, string[]][] = [
            ['localConfig', [...LOCAL, 'gateway']], ['nodeConfig', [...ROWS]], ['directory', [...BLOB]],
        ];
        const foreign = sections.flatMap(([name, allowed]) => Object.keys(rec[name] ?? {}).filter((k) => !allowed.includes(k)).map((k) => `${name}.${k}`));
        assert(sNow.kept && foreign.length === 0 && !('adminIpAllowlist' in (rec.localConfig?.gateway ?? {})) && !('notAThreshold' in (rec.localConfig?.thresholds ?? {})),
            `S keeps the record without one setting of one server in it, at any level (foreign: ${foreign.join(', ') || 'none'}; gateway ${j(rec.localConfig?.gateway)})`);
        assert(sNow.kept && !('pricing_show_seasonality' in (rec.nodeConfig ?? {})) && rec.localConfig?.communityName === 'Riverbend Commons',
            `a value it can't take is left out, and the rest is kept (${j(rec.nodeConfig)})`);
        const perServer = (s: Settings) => ({
            adminHash: s.localConfig.adminHash, salt: s.localConfig.salt, isLocked: s.localConfig.isLocked, totpEnabled: s.localConfig.totpEnabled ?? null,
            backupPrimaryUrl: s.localConfig.backupPrimaryUrl, backupReplicationToken: s.localConfig.backupReplicationToken, backupPullSeconds: s.localConfig.backupPullSeconds,
            replicationTokenHash: s.localConfig.replicationTokenHash, nodeRole: s.localConfig.nodeRole ?? null, identityEpoch: s.localConfig.identityEpoch ?? null,
            publicAddress: s.blob.publicAddress ?? null, ownerAddresses: s.blob.ownerAddresses ?? null, replica_format: s.rows.replica_format ?? null,
            avatarKeySecret: s.rows.avatarKeySecret ?? null, profileBeans: s.rows['nodeProfile.beans'] ?? null, sealCleared: s.rows.recovery_seal_cleared ?? null,
            allowlist: s.localConfig.gateway?.adminIpAllowlist ?? null,
        });
        assert(j(perServer(sBefore)) === j(perServer(sNow)) && differing(sOwnCommunity, communitySettings(sNow)).length === 0,
            `and S's own settings, of one server and of the community, are as they were (${j(perServer(sNow)).slice(0, 200)})`);

        // ── 6. The take-over ──
        console.log('\n— 6. the main server is killed; the standby takes over with the recovery code —');
        refused.push(...(await main.send('fetches')).blocked);
        await main.kill('SIGKILL');
        const registry = await directoryRegistry();
        closers.push(registry.close);
        const opened = await post(standby.base, '/api/local/admin/takeover/open', { code: setup.code }, { 'X-Admin-Password': PW_STANDBY });
        require_(opened.status === 200 && opened.body.success, `the code opens the keys (${opened.status} ${JSON.stringify(opened.body).slice(0, 160)})`);
        const missing: string[] = opened.body.preview.missing ?? [];
        assert(!missing.some((line) => /settings/i.test(line) && !/notification settings/.test(line)),
            `the preview no longer says the community's settings will be missing (${j(missing)})`);
        refused.push(...(await standby.send('fetches')).blocked);
        const confirmed = await post(standby.base, '/api/local/admin/takeover/confirm', { sessionId: opened.body.preview.sessionId, confirm: true }, { 'X-Admin-Password': PW_STANDBY });
        require_(confirmed.status === 200, `confirm (${confirmed.status})`);
        require_(await standby.exited === 0, 'the standby restarts itself');
        standby = await spawnNode(SCRIPT, dir('standby'), env(PW_STANDBY, 'backup', { DIRECTORY_REGISTRY_URL: registry.url }));
        nodes.push(standby);
        require_(standby.ready.role === 'primary' && standby.ready.peerId === main.ready.peerId && standby.ready.auditRan === true,
            `promoted: the main server's PeerId, and its audit ran (${j({ role: standby.ready.role, audit: standby.ready.auditRan })})`);
        const sAfter: Settings = await standby.send('settings');
        const expected = { ...mCommunity, 'node_config.pricing_show_seasonality': sOwnCommunity['node_config.pricing_show_seasonality'] };
        assert(differing(expected, communitySettings(sAfter)).length === 0,
            `every community setting is M's; the one the record carried a value S couldn't take is S's own (differing: ${first(differing(expected, communitySettings(sAfter)))})`);
        assert(sAfter.blob.publishContacts === false && sAfter.blob.publishMembers === false && sAfter.blob.publishHealth === false,
            `a community that chose not to publish its contacts, member count or health still doesn't (${j({ contacts: sAfter.blob.publishContacts, members: sAfter.blob.publishMembers, health: sAfter.blob.publishHealth })})`);
        const after = perServer(sAfter);
        const own = perServer(sBefore);
        const oneServer = [
            ['the admin password is the community\'s, from the keys', (await standby.send('admin-password-is', { password: PW_MAIN })) === true && after.adminHash !== 'f'.repeat(128)],
            ['the replication token for standbys of its own is S\'s', after.replicationTokenHash === own.replicationTokenHash],
            ['its pull interval is S\'s', after.backupPullSeconds === own.backupPullSeconds],
            ['it copies from nobody: the main server and its token are gone', after.backupPrimaryUrl === null && after.backupReplicationToken === null],
            ['its role is the main server\'s', after.nodeRole === 'primary'],
            ['its identity epoch is the bundle\'s plus one', after.identityEpoch === 1],
            ['the web address is not the record\'s', !/evil/.test(j(after.publicAddress)) && !/evil/.test(j(after.ownerAddresses))],
            ['the importer\'s format and the avatar key are S\'s', after.replica_format === own.replica_format && after.avatarKeySecret === own.avatarKeySecret],
            ['the seal record is not the record\'s', after.sealCleared !== 'evil'],
            ['no profile switch came from the record', after.profileBeans === null],
            ['the admin IP allowlist is S\'s own', j(after.allowlist) === j(['198.51.100.9'])],
            ['two-factor is the community\'s (off), not the record\'s', !after.totpEnabled],
        ] as const;
        const wrong = oneServer.filter(([, ok]) => !ok).map(([what]) => what);
        assert(wrong.length === 0, `no setting of one server came from the record (wrong: ${wrong.join('; ') || 'none'}; ${j(after).slice(0, 240)})`);
        const inspected = await standby.send('inspect');
        const step = inspected.progress.steps.find((st: any) => st.step === 'community-settings');
        assert(step?.done === true && /Riverbend Commons/.test(step.detail ?? '') && sAfter.kept?.installedAt,
            `the take-over's community-settings step installed them, and says so (${j(step ?? null)})`);

        // ── 7. The promotion audit ──
        console.log('\n— 7. the promotion audit —');
        const audit = inspected.lastPromotionAudit;
        const auditStep = inspected.progress.steps.find((st: any) => st.step === 'audit');
        assert(audit?.ok === true && Math.abs(audit.drift) < 0.01 && /adds up/.test(auditStep?.detail ?? '') && !/NOT/.test(auditStep?.detail ?? ''),
            `the audit after the restart holds the ledger to M's baseline: it adds up (${j({ audit, step: auditStep?.detail })})`);

        // ── 8. The directory ──
        console.log('\n— 8. the directory publisher on the promoted server —');
        const pushed = await standby.send('directory-push');
        const body = registry.bodies.at(-1);
        assert(pushed.success === true && registry.bodies.length === 1, `one push reaches the directory (${j(pushed)}; ${registry.bodies.length} received)`);
        assert(body?.callsign === 'Riverbend Commons' && body?.name === 'riverbend' && j(body?.serviceRadius) === j(mSettings.blob.serviceRadius),
            `it sends the community's name and service area (${j({ callsign: body?.callsign, name: body?.name, serviceRadius: body?.serviceRadius })})`);
        assert(body && body.communityName === null && body.contactEmail === null && body.contactPhone === null && body.memberCount === null
            && body.version === null && body.status === null,
            `and not its contacts, member count or health, which the community turned off (${j(body && { communityName: body.communityName, contactEmail: body.contactEmail, contactPhone: body.contactPhone, memberCount: body.memberCount, version: body.version })})`);
        assert(!/Standby Seven|standby-7|ops@standby\.example|\+44 20 7946/.test(j(body)), 'nothing of the standby\'s own name or contacts');

        refused.push(...(await standby.send('fetches')).blocked);
        assert(refused.length === 0, `nothing reached off this machine (refused: ${refused.join(', ') || 'none'})`);
    } finally {
        for (const n of nodes) await n.kill();
        for (const c of closers) await c();
    }

    console.log(`\n${testsPassed}/${testsRun} checks passed in ${Math.round((Date.now() - started) / 1000)} s.`);
    if (testsPassed !== testsRun) throw new Error(`${testsRun - testsPassed} check(s) failed`);
    console.log('⭐️ A standby keeps the community\'s settings, and a take-over installs them and nothing of one server.');
}

if (process.argv.includes('--child')) {
    child().catch((e) => {
        console.error('child failed:', e);
        process.exit(1);
    });
} else {
    main().then(() => process.exit(0)).catch((e) => {
        console.error('❌ Test failed:', e?.message || e);
        process.exit(1);
    });
}
