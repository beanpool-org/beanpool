/**
 * How this community works, slice S3: one switch per setting, and what a server from before it stored carried over once
 * at boot (config/community-shape-upgrade.ts; scratch/fable-design/DESIGN-community-shape-settings-fable.md §3, §3.2,
 * §3.3, §7 S3; Marty's answers to Q3, Q4, Q8, 23 Oct).
 *
 *   1. Every stored state a server from before S3 can hold for who joins and being found boots on this code with invites,
 *      requests to join and Listed as that server ran them: the kind (local, global), the private preview, the gateway's
 *      invites switch (not stored, on, off), the operator's invites, knocks and Listed rows, and the directory schedule
 *      (every 12 hours, Never). That server's answer is read from the same stores before the boot, by its own rules: its
 *      gateway answered 503 on every invite and knock route while the switch was off (https-server.ts before S3), and its
 *      publisher set no timer at Never. One state can't stay as it was: the switch off under the private preview, where
 *      owners and admins invite again (the preview's own rule; nothing stops their invites now), and the owners are told
 *      so. A carry is one owner alert (sec.settings) and none where nothing changed; a second boot writes nothing and
 *      tells nobody.
 *   2. The switches with nothing in their place: off at boot, each is told to the owners, and the routes answer past the
 *      gateway (the Market's 503 is gone; the messaging switch never matched a route members' messages use, measured
 *      here). Federation's routes answer only where ENABLE_PEER_CONNECTORS is on: the suite runs with it on, and as a
 *      variant off (scripts/server-suites.mjs).
 *   3. Saving: a gateway save naming a switch that is gone is refused whole (400 gateway_switch_removed, nothing saved),
 *      the gateway reads only servePwa, and Node Identity's route refuses the schedule's 0 (400 bad_interval).
 *   4. A standby's record from a main server before S3, with the old switches and Never in it, is kept as sent; installing
 *      it (a take-over) carries them over as a boot does, and the boot after writes nothing. The record a main server on
 *      this code sends holds none of them.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) ENABLE_PEER_CONNECTORS=true node --import tsx src/test-shape-upgrade.ts
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-shape-upgrade.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// The flags the server reads at import, set before anything is imported (every import below is dynamic).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.DIRECTORY_UNLISTED;
process.env.ADMIN_PASSWORD = 'ShapeUpgrade123!';
process.env.BEANPOOL_SUITE_ENV_PASSWORD = '1';
// A directory push that got past every hold-back would go here: a closed port on this machine, never the registry.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:9/directory-register';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
/** Many cases under one line: each failure printed, one line for all. */
function tally() {
    const fails: string[] = [];
    let n = 0;
    return {
        check(ok: boolean, what: () => string) { n++; if (!ok) fails.push(what()); },
        report(msg: string) {
            for (const f of fails.slice(0, 20)) console.error(`   ✗ ${f}`);
            assert(fails.length === 0, `${msg} (${n - fails.length}/${n})`);
        },
    };
}
const j = (v: unknown) => JSON.stringify(v);
const OLD = ['marketplace', 'messaging', 'federation', 'invites'] as const;

async function main(): Promise<void> {
    console.log('How this community works: the update (S3)\n');
    const DATA = process.env.BEANPOOL_DATA_DIR;
    if (!DATA) throw new Error('Run with BEANPOOL_DATA_DIR set to an empty directory');
    const CONFIG = path.join(DATA, 'local-config.json');

    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { ownerSessionHeaders, ownerPhoneSessionHeaders, seedOwnerForTests } = await import('./admin-auth-test-harness.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { initAdminPassword, updateLocalConfig, getGatewayConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');
    const np = await import('./config/node-profile.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { readShape } = await import('./config/community-shape.js');
    const { directoryHeldBack, directoryUnlistedByEnv } = await import('./services/directory-publisher.js');
    const cs = await import('./config/community-settings.js');
    const { setSecurityAlertHandler } = await import('./services/security-signal.js');
    const { ENABLE_PEER_CONNECTORS } = await import('./connector-manager.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;
    se.seedGenesisMember(crypto.randomBytes(32).toString('hex'), 'Founder');
    const owenPk = seedOwnerForTests('Owen');
    updateLocalConfig({ communityName: 'Riverside Commons' });

    const alerts: { key: string; detail: string }[] = [];
    setSecurityAlertHandler((n) => { alerts.push({ key: n.key, detail: n.detail }); });

    async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
        resetGatewayRateLimit();
        resetAdminRateLimit();
        resetAdminAuthTarpit();
        pruneAuthAttempts(Date.now() + 120_000);
        const res = await fetch(`${BASE}${p}`, {
            method, headers: { ...headers, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        let json: any; try { json = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: json };
    }

    // ── The stores, as a server from before S3 wrote them ──────────────────────────────────────────
    const readFile = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    /** local-config.json with `features` as the gateway's, written as that server's saveLocalConfig wrote it. */
    const writeGateway = (features: Record<string, boolean> | null) => {
        const c = readFile();
        if (features === null) delete c.gateway;
        else c.gateway = { corsAllowedOrigins: [], adminIpAllowlist: [], features, rateLimiting: { enabled: true, maxRequestsPerMinute: 120 } };
        fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2));
    };
    const storedFeatures = (): Record<string, unknown> => readFile().gateway?.features ?? {};
    const PREFIX = 'nodeProfile.';
    const setRow = (key: string, value: string | null) => {
        if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
        else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    };
    const clearProfileRows = () => db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run(PREFIX.length - 1, 'nodeProfile');
    /** The community's stores as values: what a boot that writes nothing leaves byte for byte. */
    const stores = () => j({ rows: db.prepare('SELECT key, value FROM node_config ORDER BY key').all(), file: fs.readFileSync(CONFIG, 'utf8') });
    const settingsAlerts = (from: number) => alerts.slice(from).filter((a) => a.key === 'sec.settings');

    // ── 1. Who joins and being found, every stored state ─────────────────────────────────────────────
    console.log('\n── 1. every stored state boots as it ran ──');
    type St = {
        profile: 'local' | 'global'; preview: boolean; gw: 'none' | 'on' | 'off';
        invites: 'none' | 'true' | 'false'; knocks: 'none' | 'false'; listed: 'none' | 'true' | 'false'; interval: 12 | 0;
    };
    const t = tally();
    const once = tally();
    const told = tally();
    let states = 0, kept = 0, theOne = 0;
    for (const profile of ['local', 'global'] as const) for (const preview of [false, true]) for (const gw of ['none', 'on', 'off'] as const)
        for (const invites of ['none', 'true', 'false'] as const) for (const knocks of ['none', 'false'] as const)
            for (const listed of ['none', 'true', 'false'] as const) for (const interval of [12, 0] as const) {
                const st: St = { profile, preview, gw, invites, knocks, listed, interval };
                const label = () => j(st);
                states++;
                // The stores.
                process.env.NODE_PROFILE = profile === 'global' ? 'global' : '';
                process.env.PRIVATE_PREVIEW = preview ? '1' : '';
                clearProfileRows();
                for (const [sw, v] of [['invites', invites], ['knocks', knocks], ['publishToDirectory', listed]] as const) setRow(PREFIX + sw, v === 'none' ? null : v);
                se.updateNodeConfig({ directoryPushIntervalHours: interval });
                writeGateway(gw === 'none' ? null : { marketplace: true, messaging: true, federation: true, invites: gw === 'on', servePwa: true });

                // That server's answers, from these stores by its rules, before this code boots on them.
                const P = np.getProfileSwitches();
                const cfgBefore = np.getConfiguredSwitches();
                const gate = gw !== 'off';
                const was = {
                    invites: gate && P.invites,
                    knocks: gate && P.knocks,
                    listed: P.publishToDirectory && interval !== 0 && !directoryUnlistedByEnv() && directoryHeldBack() === null,
                };

                // The boot.
                const a0 = alerts.length;
                se.initStateEngine();
                const after = np.getProfileSwitches();
                const now = { invites: after.invites, knocks: after.knocks, listed: readShape().settings.listed.value };
                const theDeliberate = preview && gw === 'off';
                if (theDeliberate) {
                    theOne++;
                    t.check(j(now) === j({ ...was, invites: true }) && !was.invites,
                        () => `${label()} under the preview, owners and admins invite again and nothing else moves: was ${j(was)}, now ${j(now)}`);
                } else {
                    kept++;
                    t.check(j(now) === j(was), () => `${label()} was ${j(was)}, now ${j(now)}`);
                }
                // What it carried, into which store.
                const cfg = np.getConfiguredSwitches();
                t.check(gw === 'off' ? cfg.invites === false : cfg.invites === cfgBefore.invites,
                    () => `${label()} invites set ${cfg.invites} (before ${cfgBefore.invites})`);
                t.check(interval === 0 ? cfg.publishToDirectory === false && se.getNodeConfig().directoryPushIntervalHours === 12
                    : cfg.publishToDirectory === cfgBefore.publishToDirectory && se.getNodeConfig().directoryPushIntervalHours === 12,
                () => `${label()} Listed set ${cfg.publishToDirectory}, schedule ${se.getNodeConfig().directoryPushIntervalHours}`);
                t.check(OLD.every((k) => !(k in storedFeatures())) && (gw === 'none' || storedFeatures().servePwa === true),
                    () => `${label()} the old switches left the file, servePwa kept: ${j(storedFeatures())}`);
                // The owners: one alert where a carry changed what is set, or what the community does; none elsewhere.
                const wantTold = (gw === 'off' && (cfgBefore.invites || preview)) || interval === 0;
                const got = settingsAlerts(a0);
                told.check(got.length === (wantTold ? 1 : 0) && alerts.length - a0 === got.length,
                    () => `${label()} ${wantTold ? 'one alert' : 'no alert'} wanted, got ${j(alerts.slice(a0))}`);
                if (wantTold && got.length === 1) {
                    const invitesSaid = gw !== 'off' ? !/paused/.test(got[0].detail)
                        : cfgBefore.invites ? /new members are paused/.test(got[0].detail)
                        : preview ? /new members were already paused/.test(got[0].detail) : !/paused/.test(got[0].detail);
                    told.check(invitesSaid
                        && (interval === 0 ? /schedule was Never/.test(got[0].detail) : !/Never/.test(got[0].detail))
                        && (theDeliberate ? /owners and admins can invite people again/.test(got[0].detail) : !/can invite people again/.test(got[0].detail)),
                    () => `${label()} the alert says each carry, and only those: ${got[0].detail}`);
                }
                // Once: the next boot finds nothing, writes nothing, tells nobody.
                const done = stores();
                const a1 = alerts.length;
                se.initStateEngine();
                once.check(stores() === done && alerts.length === a1, () => `${label()} the second boot wrote or told something`);
            }
    t.report(`${states} stored states: invites, requests to join and Listed run as before the update in ${kept}, and in the ${theOne} under the private preview with the old switch off only owners' and admins' invites come back; each carried into its store`);
    told.report('the owners are alerted once where a carry changed something, in words for each carry, and never where nothing changed');
    once.report('a second boot on the same stores writes nothing and tells nobody');
    process.env.NODE_PROFILE = '';
    process.env.PRIVATE_PREVIEW = '';
    clearProfileRows();

    // ── 2. The switches with nothing in their place, and federation's ───────────────────────────────
    console.log('\n── 2. the Market, messages and federation ──');
    // Measured on the code before S3 too: the messaging switch matched /api/messaging, and members' messages are
    // /api/messages, so its 503 never reached them.
    writeGateway({ marketplace: false, messaging: false, federation: false, invites: true, servePwa: true });
    let a0 = alerts.length;
    se.initStateEngine();
    const bootAlerts = settingsAlerts(a0);
    assert(bootAlerts.length === 1 && /Marketplace, which was off: the Market works here again/.test(bootAlerts[0].detail)
        && /P2P Direct Messaging, which was off\. It never stopped messages here/.test(bootAlerts[0].detail)
        && (ENABLE_PEER_CONNECTORS ? /Multi-Node Federation, which was off/.test(bootAlerts[0].detail) : !/Federation/.test(bootAlerts[0].detail)),
    `one alert tells the owners the Market is back, messages never stopped, and federation's routes answer only where ENABLE_PEER_CONNECTORS (${ENABLE_PEER_CONNECTORS}) is on (${j(bootAlerts)})`);
    assert(OLD.every((k) => !(k in storedFeatures())) && j(getGatewayConfig().features) === j({ servePwa: true }),
        `the old switches left the file, and the gateway reads only servePwa (${j(storedFeatures())})`);
    const market = await call('GET', '/api/marketplace/posts');
    assert(market.status !== 503 && !/gateway/i.test(j(market.body)), `the Market answers past the gateway (${market.status} ${j(market.body)?.slice(0, 120)})`);
    const messages = await call('GET', `/api/messages/conversations/${owenPk}`);
    assert(messages.status !== 503 && !/gateway/i.test(j(messages.body)), `members' messages answer past the gateway, as they always did (${messages.status} ${j(messages.body)?.slice(0, 120)})`);
    const fed = await call('GET', '/api/federation/reachable-peers');
    if (ENABLE_PEER_CONNECTORS) {
        assert(fed.status === 200 && Array.isArray(fed.body?.peers), `ENABLE_PEER_CONNECTORS on: federation's routes answer (${fed.status} ${j(fed.body)})`);
    } else {
        assert(fed.status === 503 && fed.body?.code === 'peer_connectors_off' && /off on this server/.test(fed.body?.error ?? ''),
            `ENABLE_PEER_CONNECTORS off: no federation route answers (${fed.status} ${j(fed.body)})`);
        // Another spelling is refused too: matched ignoring case here, and refused before the gate as any other is.
        const FED = await call('GET', '/api/FEDERATION/links');
        assert((FED.status === 503 || FED.status === 404) && !('links' in (FED.body ?? {})), `whatever its case (${FED.status} ${j(FED.body)})`);
    }
    // With nothing stored: the default every node had.
    writeGateway(null);
    a0 = alerts.length;
    se.initStateEngine();
    assert(alerts.length === a0, 'a server that never stored the gateway carries nothing and tells nobody');
    const fedDefault = await call('GET', '/api/federation/reachable-peers');
    assert(ENABLE_PEER_CONNECTORS ? fedDefault.status === 200 : fedDefault.status === 503,
        `its federation routes follow ENABLE_PEER_CONNECTORS alone (${fedDefault.status})`);

    // ── 3. Saving ───────────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. saving ──');
    const owner = ownerSessionHeaders(owenPk);
    for (const k of OLD) {
        const before = fs.readFileSync(CONFIG, 'utf8');
        const r = await call('POST', '/api/local/admin/gateway', { features: { servePwa: true, [k]: true }, corsAllowedOrigins: ['https://app.example'] }, ownerPhoneSessionHeaders(owenPk));
        assert(r.status === 400 && r.body?.code === 'gateway_switch_removed' && j(r.body?.removed) === j([k]) && /How this community works/.test(r.body?.error ?? '')
            && fs.readFileSync(CONFIG, 'utf8') === before,
        `a gateway save naming ${k} is refused whole: nothing saved (${r.status} ${j(r.body)?.slice(0, 160)})`);
    }
    const saved = await call('POST', '/api/local/admin/gateway', { features: { servePwa: true }, corsAllowedOrigins: ['https://app.example'] }, ownerPhoneSessionHeaders(owenPk));
    assert(saved.status === 200 && j(saved.body?.gateway?.features) === j({ servePwa: true }) && getGatewayConfig().corsAllowedOrigins[0] === 'https://app.example',
        `a save of what is left is taken (${saved.status} ${j(saved.body)?.slice(0, 160)})`);
    const read = await call('GET', '/api/local/admin/gateway', undefined, owner);
    assert(read.status === 200 && j(read.body?.features) === j({ servePwa: true }), `the gateway reads servePwa alone (${j(read.body?.features)})`);
    const intervalBefore = stores();
    const never = await call('POST', '/api/local/admin/node/config', { directoryPushIntervalHours: 0 }, owner);
    assert(never.status === 400 && never.body?.code === 'bad_interval' && /switch Listed off under How this community works/.test(never.body?.error ?? '') && stores() === intervalBefore,
        `Node Identity's route refuses the schedule's 0, and says where Listed is (${never.status} ${j(never.body)})`);
    const every6 = await call('POST', '/api/local/admin/node/config', { directoryPushIntervalHours: 6 }, owner);
    assert(every6.status === 200 && se.getNodeConfig().directoryPushIntervalHours === 6, `and takes a schedule (${every6.status})`);

    // ── 4. A standby's record from a main server before S3 ──────────────────────────────────────────
    console.log('\n── 4. a main server from before S3, taken over ──');
    clearProfileRows();
    se.updateNodeConfig({ directoryPushIntervalHours: 12 });
    writeGateway({ marketplace: true, messaging: true, federation: true, invites: true, servePwa: true });
    se.initStateEngine();
    setNodeRole('backup');
    const OLD_RECORD = {
        localConfig: {
            communityName: 'Riverbend',
            gateway: { corsAllowedOrigins: ['https://app.riverbend.example'], features: { marketplace: false, messaging: true, federation: true, invites: false, servePwa: true }, rateLimiting: { enabled: true, maxRequestsPerMinute: 300 } },
        },
        nodeConfig: { door: 'admins' },
        directory: { publishLocation: true, publishMembers: true, publishContactEmail: false, publishContactPhone: false, publishHealth: true, directoryPushIntervalHours: 0 },
    };
    const keptNow = cs.keepMainServerCommunitySettings(OLD_RECORD, '2026-10-24T08:00:00.000Z');
    const record = cs.keptCommunitySettings()?.record;
    const sortedJ = (o: object | undefined) => j(Object.fromEntries(Object.entries(o ?? {}).sort(([a], [b]) => a.localeCompare(b))));
    assert(keptNow.kept && keptNow.left.length === 0 && sortedJ(record?.localConfig.gateway?.features) === sortedJ(OLD_RECORD.localConfig.gateway.features)
        && record?.directory.directoryPushIntervalHours === 0,
    `the standby keeps the record as sent, old switches and Never too: nothing left out (${j(keptNow)})`);
    assert(readShape().standby === true, 'and reads its shape from it');
    a0 = alerts.length;
    const installed = cs.installCommunitySettings();
    const cfg = np.getConfiguredSwitches();
    assert(installed.installed && cfg.invites === false && cfg.publishToDirectory === false && se.getNodeConfig().directoryPushIntervalHours === 12
        && OLD.every((k) => !(k in storedFeatures())) && getGatewayConfig().corsAllowedOrigins[0] === 'https://app.riverbend.example',
    `a take-over installs it and carries it over: paused, not Listed, every 12 hours, the gateway's origin and no old switch (${j({ installed, cfg: { invites: cfg.invites, listed: cfg.publishToDirectory }, file: storedFeatures() })})`);
    const installAlerts = settingsAlerts(a0);
    assert(installAlerts.length === 1 && /new members are paused/.test(installAlerts[0].detail) && /the Market works here again/.test(installAlerts[0].detail)
        && /schedule was Never/.test(installAlerts[0].detail) && !/Messaging/.test(installAlerts[0].detail),
    `the owners are told it once, each carry and only those (${j(installAlerts)})`);
    assert(installed.installed && /carried over from before How this community works/.test(installed.detail), `the take-over's step says so (${installed.installed ? installed.detail : ''})`);
    setNodeRole('primary');
    const afterInstall = stores();
    a0 = alerts.length;
    se.initStateEngine();
    assert(stores() === afterInstall && alerts.length === a0, 'its first boot as the main server writes nothing more and tells nobody');
    const sent = cs.readCommunitySettings();
    assert(j(sent.localConfig.gateway?.features) === j({ servePwa: true }) && sent.directory.directoryPushIntervalHours === 12,
        `the record it sends its own standbys holds no old switch and no Never (${j(sent.localConfig.gateway)})`);
    // And one with the old switches all on: kept, installed, nothing to carry or tell.
    clearProfileRows();
    setNodeRole('backup');
    cs.keepMainServerCommunitySettings({ ...OLD_RECORD, localConfig: { ...OLD_RECORD.localConfig, gateway: { features: { marketplace: true, messaging: true, federation: true, invites: true, servePwa: false } } },
        directory: { ...OLD_RECORD.directory, directoryPushIntervalHours: 6 } }, '2026-10-24T09:00:00.000Z');
    a0 = alerts.length;
    const quiet = cs.installCommunitySettings();
    assert(quiet.installed && np.getConfiguredSwitches().invites === true && np.getConfiguredSwitches().publishToDirectory === true
        && j(storedFeatures()) === j({ servePwa: false }) && settingsAlerts(a0).length === 0,
    `a record with the old switches on carries nothing but their removal, and tells nobody (${j({ file: storedFeatures(), alerts: alerts.slice(a0) })})`);
    setNodeRole('primary');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) process.exitCode = 1;
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => {
    console.error('❌ Test failed:', e);
    process.exit(1);
});
