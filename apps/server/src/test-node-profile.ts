/**
 * The node profile (config/node-profile.ts): NODE_PROFILE decides, node_config only mirrors it, overrides tune the
 * switches, and /api/community/info reports what this build really does.
 *
 *   1. parsing: unset, empty or spaces → local; `global` in any case, with spaces → global; anything else → local
 *      with ONE log line however often it is read
 *   2. the per-profile defaults (design §4.2)
 *   3. boot over a database restored from a global node, with NODE_PROFILE unset: the boot REFUSES (G1: run as local,
 *      a global node would switch Beans on for strangers) and the record stays global; started once with
 *      NODE_PROFILE_ALLOW_CHANGE_FROM=global it runs local, the record is rewritten, the boot log says so; a record
 *      changed at runtime changes nothing either
 *   4. GET /api/community/info through the real HTTPS stack, unsigned and signed, on both profiles: `profile`, the six
 *      `features` exactly, and every field it had before
 *   5. node_config overrides change the configured switch (and the boot log reports them), bad ones are ignored with
 *      a log line, and a switch this build doesn't have yet stays pinned, so the API never advertises it
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx src/test-node-profile.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
// Whatever the shell running the suite has set, the suite starts from a node with no profile configured.
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';

const PORT = 8719;
const BASE = `https://localhost:${PORT}`;
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

/** Runs fn and returns what it wrote to console.log / console.warn, still printing it. */
function capture(fn: () => void): { logs: string[]; warns: string[] } {
    const logs: string[] = [], warns: string[] = [];
    const log = console.log, warn = console.warn;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); log(...a); };
    console.warn = (...a: unknown[]) => { warns.push(a.join(' ')); warn(...a); };
    try { fn(); } finally { console.log = log; console.warn = warn; }
    return { logs, warns };
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };

async function getInfo(id?: Id): Promise<{ status: number; body: any }> {
    const path = '/api/community/info';
    const headers: Record<string, string> = {};
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`GET\n${path}\n${ts}\n${nonce}\n`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { headers });
    return { status: res.status, body: await res.json() };
}

// What this build does on each profile until G2 (open join), G4 (distance search) and G6 (knocks) land. The PR that
// builds one of these changes its line here, with the test that proves it. G1 built Beans off: on global, Beans,
// escrow and enterprises are off (this database's ledger has never moved; test-global-no-beans covers one that has).
const BUILT_TODAY = {
    local: { beans: true, escrow: true, enterprises: true, openJoin: false, knocks: false, distanceSearch: false },
    global: { beans: false, escrow: false, enterprises: false, openJoin: false, knocks: false, distanceSearch: false },
};

async function main() {
    const profile = await import('./config/node-profile.js');
    const { parseNodeProfile, getNodeProfile, profileDefaults, getConfiguredSwitches, getProfileSwitches, getNodeFeatures, mirrorNodeProfileAtBoot, NODE_PROFILE_KEY } = profile;

    console.log('── 1. NODE_PROFILE parsing ──');
    const cases: Array<[string | undefined, 'local' | 'global', boolean]> = [
        [undefined, 'local', false],
        ['', 'local', false],
        ['   ', 'local', false],
        ['local', 'local', false],
        ['Local ', 'local', false],
        ['global', 'global', false],
        ['GLOBAL', 'global', false],
        ['  Global\t', 'global', false],
        ['junk', 'local', true],
        ['glob', 'local', true],
        ['global-node', 'local', true],
        ['glo bal', 'local', true],
    ];
    for (const [raw, want, bad] of cases) {
        const r = parseNodeProfile(raw);
        assert(r.profile === want && (r.unrecognised !== null) === bad,
            `NODE_PROFILE=${JSON.stringify(raw)} → ${want}${bad ? ', flagged unrecognised' : ''} (got ${r.profile}, unrecognised ${JSON.stringify(r.unrecognised)})`);
    }
    process.env.NODE_PROFILE = 'glob';
    const junk = capture(() => { for (let i = 0; i < 5; i++) getNodeProfile(); });
    const junkLines = junk.warns.filter(w => w.includes('NODE_PROFILE="glob"'));
    assert(junkLines.length === 1 && /runs as local/.test(junkLines[0]),
        `an unrecognised NODE_PROFILE read 5 times logs exactly one line saying the node runs as local (got ${junkLines.length})`);
    assert(getNodeProfile() === 'local', 'an unrecognised NODE_PROFILE is local');
    delete process.env.NODE_PROFILE;
    const quiet = capture(() => { getNodeProfile(); });
    assert(quiet.warns.length === 0, 'an unset NODE_PROFILE logs nothing');

    console.log('\n── 2. per-profile defaults (design §4.2) ──');
    const local = profileDefaults('local');
    const global = profileDefaults('global');
    assert(!local.openJoin && global.openJoin, 'openJoin: off on local, on on global');
    assert(local.beans && local.escrow && local.enterprises && local.treasuries && local.crowdfund, 'local: Beans, escrow, enterprises, treasuries, crowdfund on');
    assert(!global.beans && !global.escrow && !global.enterprises && !global.treasuries && !global.crowdfund, 'global: Beans, escrow, enterprises, treasuries, crowdfund off');
    assert(local.knocks && !global.knocks, 'knocks: on for a local community (D4), off on the lobby');
    assert(!local.distanceSortDefault && global.distanceSortDefault, 'nearest-first by default: global only');
    assert(!local.directoryMirror && global.directoryMirror, 'directory mirror: global only');
    assert(local.publishToDirectory && !global.publishToDirectory, 'listed in the directory: local as the operator decides; the lobby never');
    assert(!local.probation && !local.autoHideReports && !local.autoMute, 'local: no probation, auto-hide or auto-mute');
    assert(global.probation && global.autoHideReports && global.autoMute, 'global: probation, auto-hide and auto-mute on');
    assert(local.ssoRequiredForJoin && global.ssoRequiredForJoin, 'the open door needs a sign-in (D1 = a)');
    profileDefaults('local').openJoin = true;
    assert(profileDefaults('local').openJoin === false, 'profileDefaults hands out a copy: a caller cannot change the table');

    console.log('\n── 3. boot over a database restored from a global node, NODE_PROFILE unset ──');
    const { db, initSchema } = await import('./db/db.js');
    initSchema();
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(NODE_PROFILE_KEY, 'global');
    const { initStateEngine } = await import('./state-engine.js');
    const { NodeProfileMismatchError, ALLOW_CHANGE_ENV } = profile;
    const mirror = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(NODE_PROFILE_KEY) as { value: string }).value;
    let refused: unknown = null;
    try { initStateEngine(); } catch (e) { refused = e; }
    assert(refused instanceof NodeProfileMismatchError, `the boot refuses: a global node run as local would switch Beans on for strangers (got ${String(refused)})`);
    const why = String((refused as Error | null)?.message ?? '');
    assert(why.includes('NODE_PROFILE=global') && why.includes(`${ALLOW_CHANGE_ENV}=global`),
        `the refusal says what to set, and how to convert on purpose (${why.slice(0, 120)}…)`);
    assert(mirror() === 'global', 'a refused boot leaves the record as it was');
    process.env[ALLOW_CHANGE_ENV] = 'global';
    const boot = capture(() => initStateEngine());
    delete process.env[ALLOW_CHANGE_ENV];
    assert(boot.warns.some(l => l.includes(`${ALLOW_CHANGE_ENV}=global`) && l.includes('on purpose')),
        `started once with ${ALLOW_CHANGE_ENV}=global, the boot says it converts on purpose`);
    assert(getNodeProfile() === 'local', 'the node runs as local: the restored mirror is not the profile');
    assert(mirror() === 'local', `boot rewrote node_config.${NODE_PROFILE_KEY} to local (got ${mirror()})`);
    assert(boot.logs.some(l => l.includes('Node profile: local')), 'the boot log names the profile');
    assert(boot.logs.some(l => l.includes('last ran as "global"') && l.includes('now runs as local')),
        'the boot log says the database last ran as global and NODE_PROFILE decided');

    console.log('\n── 4. GET /api/community/info through the HTTPS stack ──');
    const { initTls } = await import('./services/tls.js');
    const { startHttpsServer } = await import('./https-server.js');
    await initTls();
    await startHttpsServer(PORT);
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const alice: Id = { pubKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey };
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code)
                VALUES (?, 'alice', 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'seed', 'seed')`).run(alice.pubKeyHex);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)').run(alice.pubKeyHex);

    const checkInfo = async (want: 'local' | 'global', label: string) => {
        for (const [who, id] of [['unsigned', undefined], ['signed member', alice]] as const) {
            const r = await getInfo(id);
            assert(r.status === 200, `${label}, ${who}: 200 (got ${r.status})`);
            assert(r.body.profile === want, `${label}, ${who}: profile is ${want} (got ${JSON.stringify(r.body.profile)})`);
            assert(JSON.stringify(r.body.features) === JSON.stringify(BUILT_TODAY[want]),
                `${label}, ${who}: features are exactly what this build does (got ${JSON.stringify(r.body.features)})`);
            const b = r.body;
            assert(typeof b.memberCount === 'number' && typeof b.postCount === 'number' && typeof b.transactionCount === 'number'
                && typeof b.commonsBalance === 'number' && typeof b.currency?.type === 'string' && typeof b.currency?.value === 'string',
                `${label}, ${who}: every field from before is still there, same types`);
        }
    };
    await checkInfo('local', 'NODE_PROFILE unset');
    process.env.NODE_PROFILE = 'global';
    await checkInfo('global', 'NODE_PROFILE=global');
    process.env.NODE_PROFILE = 'GLOBAL ';
    await checkInfo('global', 'NODE_PROFILE="GLOBAL "');
    process.env.NODE_PROFILE = 'lobby';
    await checkInfo('local', 'NODE_PROFILE=lobby (unrecognised)');
    delete process.env.NODE_PROFILE;

    // A backup restored at runtime replaces state.db, mirror included, and restarts. Before that restart, or if the
    // mirror is edited by hand, nothing reads it as the profile.
    db.prepare('UPDATE node_config SET value = ? WHERE key = ?').run('global', NODE_PROFILE_KEY);
    assert(getNodeProfile() === 'local', 'a mirror changed to global at runtime: getNodeProfile() is still local');
    assert((await getInfo()).body.profile === 'local', 'a mirror changed to global at runtime: /api/community/info still says local');

    console.log('\n── 5. node_config overrides ──');
    const setOverride = (name: string, value: string) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
            .run(`${NODE_PROFILE_KEY}.${name}`, value);
    const clearOverrides = () => db.prepare('DELETE FROM node_config WHERE substr(key, 1, 12) = ?').run(`${NODE_PROFILE_KEY}.`);

    setOverride('openJoin', 'true');
    assert(getConfiguredSwitches().openJoin === true, 'local + nodeProfile.openJoin=true: the configured switch is on');
    assert(profileDefaults('local').openJoin === false, 'the override does not change the profile table itself');
    assert(getProfileSwitches().openJoin === false, 'open join is not built yet (G2), so the switch the code reads stays off');
    assert(getNodeFeatures().openJoin === false && (await getInfo()).body.features.openJoin === false,
        '/api/community/info does not advertise open join because an override asked for it');

    process.env.NODE_PROFILE = 'global';
    setOverride('probation', 'false');
    setOverride('knocks', ' TRUE ');
    const tuned = getConfiguredSwitches();
    assert(tuned.probation === false, 'global + nodeProfile.probation=false: the configured default (on) is turned off');
    assert(tuned.knocks === true, 'global + nodeProfile.knocks=" TRUE ": read as true');
    assert(tuned.openJoin === true && tuned.beans === false, 'switches with no override keep the global defaults');
    const reported = capture(() => { mirrorNodeProfileAtBoot(); });
    const overridesLine = reported.logs.find(l => l.includes('Node profile: global')) ?? '';
    assert(/overrides: .*openJoin=true/.test(overridesLine) && /probation=false/.test(overridesLine) && /knocks=true/.test(overridesLine),
        `the boot log reports every override in effect (got ${JSON.stringify(overridesLine)})`);
    assert(reported.logs.some(l => l.includes('Not built yet') && l.includes('knocks=true')),
        'the boot log says which overrides ask for something this build does not have yet');
    assert(mirror() === 'global', 'the mirror follows NODE_PROFILE=global at boot');
    assert(JSON.stringify((await getInfo()).body.features) === JSON.stringify(BUILT_TODAY.global),
        'global with overrides: /api/community/info still reports only what this build does');

    setOverride('beans', 'maybe');
    setOverride('openjoin', 'true');
    const bad = capture(() => { for (let i = 0; i < 3; i++) getConfiguredSwitches(); });
    assert(getConfiguredSwitches().beans === false, 'nodeProfile.beans=maybe is ignored: the global default (off) stands');
    assert(bad.warns.filter(w => w.includes('nodeProfile.beans') && w.includes('not true or false')).length === 1,
        'a bad override value logs one line, however often it is read');
    assert(bad.warns.filter(w => w.includes('nodeProfile.openjoin') && w.includes('not a profile switch')).length === 1,
        'a misspelt switch (openjoin) is ignored with one log line');

    clearOverrides();
    delete process.env.NODE_PROFILE;
    let refusedAgain = false;
    try { mirrorNodeProfileAtBoot(); } catch (e) { refusedAgain = e instanceof NodeProfileMismatchError; }
    assert(refusedAgain && mirror() === 'global', 'after running as global, a boot with NODE_PROFILE unset refuses again');
    process.env[ALLOW_CHANGE_ENV] = 'global';
    mirrorNodeProfileAtBoot();
    delete process.env[ALLOW_CHANGE_ENV];
    assert(JSON.stringify(getConfiguredSwitches()) === JSON.stringify(profileDefaults('local')), 'with no overrides and no NODE_PROFILE, the node is set to the local defaults');
    assert(mirror() === 'local', 'and the mirror is back to local');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ The node profile comes from NODE_PROFILE, and the node reports only what it does.');
}

main().then(() => process.exit(0)).catch(e => { console.error('❌ Test failed:', e); process.exit(1); });
