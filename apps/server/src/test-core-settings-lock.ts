/**
 * Core settings, slice C1 (the server half): set once, then locked (config/core-settings.ts; POST
 * /api/local/admin/community-shape `lock` and `code`; scratch/fable-design/DESIGN-core-settings-fable.md §8, §10.1 C1;
 * Marty's five answers, 31 Oct 2026). Every request goes through the real HTTPS server and its middleware.
 *
 *   1. Before the lock: the shape names the Core settings, no lock and the place; a Core change and a mixed request ask
 *      nothing, as before (older apps and live nodes keep working); the phone's /me tells an owner and an admin it is not
 *      confirmed, and a moderator and a member nothing.
 *   2. Confirm and lock, refused, each with nothing written, nobody alerted or told: no place on a local community
 *      (place_needed); an admin, a moderator, a member, nobody, an automation token of every scope, the phone's hand-off
 *      past its step-up; `lock` other than true; an everyday change beside it.
 *   3. Confirm and lock by an owner, with a change: the change, the row, a line per change then `core.lock`, stamped
 *      alike; one owner alert; members told of the change only. Again: 409 core_locked, nothing written. With no change
 *      (the row removed by hand: no route removes it): the row and `core.lock` alone, one alert, nobody told.
 *   4. Locked, a Core change without a fresh proof is refused in the fresh proof's words, nothing written: a computer's
 *      key session (phone_required), the phone's hand-off 91 s after Manage (step_up_required), the password's session
 *      with no code (401) or a used one, an admin, every automation token. A request refused anyway (a bad value, a mixed
 *      request) never asks the code, nor spends it. Called without the route's proof, the write refuses on its own
 *      (core_proof_needed).
 *   5. Locked, with the proof: the phone's hand-off just after Manage, the password with a current code (`code`, the
 *      X-Fresh-Proof header, or inline). Each is written with a `core.unlock` line naming the setting before its own,
 *      stamped alike, one owner alert naming the change, members told. The known floor asks it for any of its parts.
 *   6. Locked, everyday changes ask nothing; who can join is two: pausing and un-pausing to the same door ask nothing, a
 *      door change asks the proof, un-paused to the other door too. A Core setting sent unchanged writes nothing.
 *   7. join.door under every stored door row and pause; the phone's /me says locked and since when.
 *   8. A standby reads its copy's lock, and confirms nothing (409 standby). The global kind needs no place.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-core-settings-lock.ts
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.DIRECTORY_UNLISTED;
process.env.ADMIN_PASSWORD = 'CoreSettingsLock123!';
process.env.BEANPOOL_SUITE_ENV_PASSWORD = '1';
// A directory push that got past every hold-back would go here: a closed port on this machine, never the registry.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:9/directory-register';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 260)}`;
const DAY = 86_400_000;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

async function main(): Promise<void> {
    console.log('Core settings C1: the lock, and fresh proof on a locked Core change\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { ownerTokenHeaders, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests, createPasswordSession, PHONE_HANDOFF_IDLE_TTL_MS } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const { setNodeRole } = await import('./config/node-role.js');
    const { getDoor } = await import('./config/door.js');
    const { keepMainServerCommunitySettings, KEPT_COMMUNITY_SETTINGS_KEY, readCommunitySettings, parseCommunitySettings } = await import('./config/community-settings.js');
    const { setSecurityAlertHandler } = await import('./services/security-signal.js');
    const { readShape } = await import('./config/community-shape.js');
    const { applyShapeChanges, ShapeChangeError, CORE_PLACE_NEEDED, CORE_LOCKED_ALREADY } = await import('./config/community-shape-write.js');
    const { CORE_SETTINGS, CORE_SETTINGS_LOCK_KEY, isCoreChange } = await import('./config/core-settings.js');
    const { NODE_CONFIG_KEYS } = await import('./engine/replication-manifest.js');
    const { getConfiguredSwitches } = await import('./config/node-profile.js');
    /** The switches as set (the profile's defaults and the overrides). */
    const np = () => getConfiguredSwitches();

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    function makeMember(name: string): Id {
        const id = keypair(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`)
            .run(id.pk, name, ago(30 * DAY));
        setMemberPhoto(db, id.pk, 'data:image/png;base64,iVBORw0KGgo=');
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
        return id;
    }
    /** A key session: a computer's, or the phone's Manage hand-off (whose unlock is now). */
    function keySession(pub: string, role: 'owner' | 'admin' | 'moderator', phone = false): string {
        const s = consumeHandshakeToken(mintHandshakeToken(pub, role).handshakeToken, Date.now(), phone ? { idleTtlMs: PHONE_HANDOFF_IDLE_TTL_MS } : {});
        if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
        return s.sessionId;
    }
    async function call(method: string, id: Id | null, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
        resetGatewayRateLimit();
        resetAdminRateLimit();
        resetAdminAuthTarpit();
        pruneAuthAttempts(Date.now() + 120_000);
        const bodyString = body === undefined ? '' : JSON.stringify(body);
        const headers: Record<string, string> = { ...extra };
        if (id) {
            const ts = Date.now();
            const nonce = crypto.randomBytes(16).toString('hex');
            headers['X-Public-Key'] = id.pk;
            headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
            headers['X-Timestamp'] = String(ts);
            headers['X-Nonce'] = nonce;
        }
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
        let json: any; try { json = await res.json(); } catch { /* empty */ }
        return { status: res.status, body: json };
    }

    se.seedGenesisMember(keypair('Founder').pk, 'Founder');
    const owen = makeMember('Owen');
    grantNodeRole(owen.pk, 'owner', 'SYSTEM');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const mo = makeMember('Mo');
    grantNodeRole(mo.pk, 'moderator', 'SYSTEM');
    const sam = makeMember('Sam');
    updateLocalConfig({ communityName: 'Riverside Commons' });

    const PATH = '/api/local/admin/community-shape';
    const asComputer = () => ({ 'X-Admin-Session': keySession(owen.pk, 'owner') });
    const asPhone = () => ({ 'X-Admin-Session': keySession(owen.pk, 'owner', true) });
    /** The phone's hand-off whose unlock is `ms` old. */
    const asPhoneAgo = (ms: number) => {
        const sid = keySession(owen.pk, 'owner', true);
        backdateAdminSessionForTests(sid, ms);
        return { 'X-Admin-Session': sid };
    };
    const asAdmin = () => ({ 'X-Admin-Session': keySession(ada.pk, 'admin') });
    const asModerator = () => ({ 'X-Admin-Session': keySession(mo.pk, 'moderator') });
    const post = (body: unknown, headers: Record<string, string>) => call('POST', null, PATH, body, headers);

    const rowOf = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    const lockRow = () => rowOf(CORE_SETTINGS_LOCK_KEY);
    const unlockByHand = () => db.prepare('DELETE FROM node_config WHERE key = ?').run(CORE_SETTINGS_LOCK_KEY);
    const snapshot = () => JSON.stringify({
        nodeConfig: db.prepare('SELECT key, value FROM node_config ORDER BY key').all(),
        shapeLog: db.prepare('SELECT * FROM community_settings_log ORDER BY id').all(),
        floorLog: db.prepare('SELECT * FROM known_floor_log ORDER BY id').all(),
        notices: db.prepare('SELECT id FROM moderation_notices ORDER BY id').all(),
    });
    const alerts: { key: string; detail: string; actor?: string }[] = [];
    setSecurityAlertHandler((n) => { alerts.push({ key: n.key, detail: n.detail, actor: n.actor }); });
    const logMark = () => (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM community_settings_log').get() as { m: number }).m;
    const linesSince = (mark: number) => db.prepare('SELECT * FROM community_settings_log WHERE id > ? ORDER BY id').all(mark) as any[];
    const noticeMark = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM moderation_notices').get() as { m: number }).m;
    const noticesSince = (mark: number) => db.prepare('SELECT recipient, body FROM moderation_notices WHERE rowid > ?').all(mark) as { recipient: string; body: string }[];
    const placeIt = () => se.updateNodeConfig({ serviceRadius: { lat: -28.55, lng: 153.5, radiusKm: 20 } } as any);
    const unplaceIt = () => { se.updateNodeConfig({ serviceRadius: undefined } as any); updateLocalConfig({ location: null }); };

    /** A refusal: its status and code, and nothing written, alerted or told. */
    async function refusedClean(label: string, send: () => Promise<Res>, status: number, code: string | null, why?: RegExp | string): Promise<Res> {
        const before = snapshot();
        const alertsBefore = alerts.length;
        const r = await send();
        const sentence = typeof r.body?.error === 'string' ? r.body.error : '';
        const whyOk = why === undefined ? true : typeof why === 'string' ? sentence === why : why.test(sentence);
        assert(r.status === status && (code === null || r.body?.code === code) && whyOk && snapshot() === before && alerts.length === alertsBefore,
            `${label}: ${status}${code ? ` ${code}` : ''}, nothing written, nobody alerted or told (${show(r)})`);
        return r;
    }

    // ── 1. Before the lock ──────────────────────────────────────────────────────────────────────
    console.log('── 1. before the lock: nothing changes ──');
    let sh = readShape();
    assert(isDeepStrictEqual([...sh.core.settings], ['join', 'wordsDoor', 'beans', 'knownFloor', 'voucherBudget', 'memberGift', 'decisions', 'shareOutside', 'recoveryCopies'])
        && sh.core.settings === CORE_SETTINGS,
        `the shape names the nine Core settings (voucher budget, slice V5, the ninth), the constant itself (${JSON.stringify(sh.core.settings)})`);
    assert(sh.core.lock === null && isDeepStrictEqual(sh.core.place, { needed: true, set: false }),
        `not locked, and a local community needs its place, not set yet (${JSON.stringify(sh.core)})`);
    for (const s of sh.core.settings) assert(s in sh.settings || s === 'wordsDoor', `${s} is a setting of the shape`);
    const shapeRead = await call('GET', null, PATH, undefined, asAdmin());
    assert(shapeRead.status === 200 && isDeepStrictEqual(shapeRead.body?.core, JSON.parse(JSON.stringify(readShape().core))),
        `an admin reads the same core through the route (${show(shapeRead)})`);
    let mark = logMark();
    let r = await post({ changes: { decisions: false } }, asComputer());
    assert(r.status === 200 && np().decisions === false && linesSince(mark).every((l) => !String(l.setting).startsWith('core.')),
        `unlocked, a Core change from a computer's session asks nothing, as before (${show(r)})`);
    r = await post({ changes: { decisions: true, probation: true } }, asComputer());
    assert(r.status === 200 && np().decisions === true && np().probation === true,
        `unlocked, a Core and an everyday setting in one request are taken, as before (${show(r)})`);
    await post({ changes: { probation: false } }, asComputer());
    for (const [who, id, expect] of [['an owner', owen, true], ['an admin', ada, true], ['a moderator', mo, false], ['a member', sam, false]] as const) {
        const me = await call('GET', id, '/api/node-admin/me');
        assert(me.status === 200 && (expect ? isDeepStrictEqual(me.body?.coreSettings, { locked: false }) : !('coreSettings' in (me.body ?? {}))),
            `/api/node-admin/me, ${who}: ${expect ? 'not confirmed' : 'nothing about core settings'} (${show(me)})`);
    }

    // ── 2. Confirm and lock, refused ────────────────────────────────────────────────────────────
    console.log('\n── 2. confirm and lock, refused ──');
    await refusedClean('a local community with no place', () => post({ changes: {}, lock: true }, asPhone()), 409, 'place_needed', CORE_PLACE_NEEDED);
    placeIt();
    assert(readShape().core.place.set === true, 'its place set (the service area), the shape says so');
    unplaceIt();
    updateLocalConfig({ location: { lat: -28.55, lng: 153.5 } });
    assert(readShape().core.place.set === true, "or the node's own place");
    unplaceIt();
    placeIt();
    await refusedClean('an admin', () => post({ changes: {}, lock: true }, asAdmin()), 403, null);
    await refusedClean('a moderator', () => post({ changes: {}, lock: true }, asModerator()), 403, null);
    await refusedClean('a member, signed', () => call('POST', sam, PATH, { changes: {}, lock: true }), 401, null);
    await refusedClean('nobody', () => post({ changes: {}, lock: true }, {}), 401, null);
    for (const scope of ['read', 'admin', 'backups', 'agent'] as const) {
        await refusedClean(`an automation token (${scope}) made by the owner`, () => post({ changes: {}, lock: true }, ownerTokenHeaders(scope, owen.pk)), 403, null);
    }
    await refusedClean("the phone's hand-off past its step-up (6 min)", () => post({ changes: {}, lock: true }, asPhoneAgo(6 * 60_000)), 403, 'step_up_required');
    for (const lock of [false, 'yes', 1, null] as const) {
        await refusedClean(`lock: ${JSON.stringify(lock)}`, () => post({ changes: {}, lock }, asPhone()), 400, 'bad_lock');
    }
    await refusedClean('an everyday change beside it', () => post({ changes: { probation: true }, lock: true }, asPhone()), 400, 'one_kind_per_request', /Confirm and lock takes the core settings only/);
    await refusedClean('a Core and an everyday change beside it', () => post({ changes: { decisions: false, autoMute: true }, lock: true }, asPhone()), 400, 'one_kind_per_request');
    await refusedClean('no changes and no lock', () => post({}, asPhone()), 400, 'no_changes');
    await refusedClean('a bad value beside it', () => post({ changes: { beans: 'off' }, lock: true }, asPhone()), 400, 'bad_setting');

    // ── 3. Confirm and lock ─────────────────────────────────────────────────────────────────────
    console.log('\n── 3. confirm and lock ──');
    mark = logMark();
    let aMark = alerts.length;
    let nMark = noticeMark();
    r = await post({ changes: { decisions: false }, lock: true, note: 'Moderators look after things for now.' }, asComputer());
    let lines = linesSince(mark);
    const row = JSON.parse(lockRow() ?? 'null');
    assert(r.status === 200 && np().decisions === false && row?.by === owen.pk && typeof row?.at === 'string',
        `an owner's computer confirms and locks with a change: the change and the row, by the owner (${show(r)}; row ${lockRow()})`);
    assert(lines.length === 2 && lines[0].setting === 'decisions' && lines[0].new_value === 'off' && lines[1].setting === 'core.lock'
        && lines[1].new_value === 'locked' && lines[1].old_value === null && lines.every((l) => l.at === row.at && l.actor_pubkey === owen.pk),
        `a line for the change, then core.lock, stamped as the row (${JSON.stringify(lines.map((l) => [l.setting, l.old_value, l.new_value, l.at === row?.at]))})`);
    const told = noticesSince(nMark);
    assert(r.body?.told === 'members' && told.length > 0 && told.every((n) => /community votes are off/.test(n.body) && !/lock/i.test(n.body)),
        `members are told of the change, and nothing of the lock (${told.length} notices: ${told[0]?.body})`);
    let newAlerts = alerts.slice(aMark);
    assert(newAlerts.length === 1 && newAlerts[0].key === 'sec.settings' && /^The core settings were confirmed and locked, by an owner, with Community votes \(Decisions\) changed\./.test(newAlerts[0].detail)
        && !newAlerts[0].detail.includes('Owen'),
        `one owner alert, which names no one (${JSON.stringify(newAlerts)})`);
    sh = readShape();
    assert(isDeepStrictEqual(sh.core.lock, { at: row.at, by: owen.pk, byCallsign: 'Owen' }) && isDeepStrictEqual(r.body?.shape?.core, JSON.parse(JSON.stringify(sh.core))),
        `the shape reads it locked, when and by whom, and the answer is the shape (${JSON.stringify(sh.core.lock)})`);
    await refusedClean('confirm and lock again', () => post({ changes: {}, lock: true }, asPhone()), 409, 'core_locked', CORE_LOCKED_ALREADY);
    await refusedClean('confirm and lock again, with a change', () => post({ changes: { decisions: true }, lock: true }, asPhone()), 409, 'core_locked');
    const meLocked = await call('GET', owen, '/api/node-admin/me');
    assert(isDeepStrictEqual(meLocked.body?.coreSettings, { locked: true, at: row.at }), `/me tells the owner it is locked, and since when (${show(meLocked)})`);
    const meAdmin = await call('GET', ada, '/api/node-admin/me');
    assert(isDeepStrictEqual(meAdmin.body?.coreSettings, { locked: true, at: row.at }), `and the admin (${show(meAdmin)})`);

    unlockByHand();
    mark = logMark(); aMark = alerts.length; nMark = noticeMark();
    const before = JSON.stringify(db.prepare("SELECT key, value FROM node_config WHERE key != ? AND key NOT LIKE 'replica%' ORDER BY key").all(CORE_SETTINGS_LOCK_KEY));
    r = await post({ lock: true }, asPhone());
    lines = linesSince(mark);
    const after = JSON.stringify(db.prepare("SELECT key, value FROM node_config WHERE key != ? AND key NOT LIKE 'replica%' ORDER BY key").all(CORE_SETTINGS_LOCK_KEY));
    assert(r.status === 200 && r.body?.told === 'nobody' && lockRow() !== null && before === after,
        `(the row removed by hand) confirm and lock with nothing changed, \`changes\` left out: the row alone (${show(r)})`);
    assert(lines.length === 1 && lines[0].setting === 'core.lock' && noticesSince(nMark).length === 0,
        `one core.lock line, and nobody told (${JSON.stringify(lines.map((l) => l.setting))})`);
    newAlerts = alerts.slice(aMark);
    assert(newAlerts.length === 1 && newAlerts[0].detail === "The core settings were confirmed and locked, by an owner. Every change to one from now on asks for an owner's proof.",
        `one owner alert (${JSON.stringify(newAlerts)})`);
    unlockByHand();
    r = await post({ changes: {}, lock: true }, asPhone());
    assert(r.status === 200 && lockRow() !== null, `\`changes: {}\` confirms the same (${show(r)})`);
    unlockByHand();
    r = await post({ changes: { decisions: false }, lock: true }, asPhone());
    assert(r.status === 200 && r.body?.told === 'nobody' && lockRow() !== null,
        `a Core setting sent as it is, with the lock: confirmed, nobody told (${show(r)})`);

    // ── 4. Locked: a Core change without a fresh proof ──────────────────────────────────────────
    console.log('\n── 4. locked: a Core change without a fresh proof is refused ──');
    const twoFa = turnOn2faForTests(process.env.ADMIN_PASSWORD!);
    const pwSession = () => ({ 'X-Admin-Session': createPasswordSession().sessionId });
    const turnOn = { changes: { decisions: true } };
    await refusedClean("a computer's key session", () => post(turnOn, asComputer()), 403, 'phone_required');
    await refusedClean("the phone's hand-off 91 s after Manage (inside its step-up)", () => post(turnOn, asPhoneAgo(91_000)), 403, 'step_up_required', 'Press Manage on your phone again, then make this change within 90 seconds.');
    await refusedClean("the password's session, with no code", () => post(turnOn, pwSession()), 401, null, /to change a core setting$/);
    await refusedClean("the password's session, with a wrong code", () => post({ ...turnOn, code: '000000' }, pwSession()), 401, null);
    await refusedClean('an admin', () => post(turnOn, asAdmin()), 403, null);
    for (const scope of ['read', 'admin', 'backups', 'agent'] as const) {
        await refusedClean(`an automation token (${scope}) made by the owner`, () => post(turnOn, ownerTokenHeaders(scope, owen.pk)), 403, null);
    }
    // Refused anyway: never asks the code, and never spends it.
    const kept = twoFa.code();
    await refusedClean('a bad value, with a code', () => post({ changes: { decisions: 'on' }, code: kept }, pwSession()), 400, 'bad_setting');
    await refusedClean('a Core and an everyday change, with a code', () => post({ changes: { decisions: true, autoMute: true }, code: kept }, pwSession()),
        400, 'one_kind_per_request', /^Change a core setting on its own: this request changes Community votes \(Decisions\), which is a core setting, and Repeat offenders muted automatically, which is not\./);
    {
        const b = snapshot();
        let threw: unknown = null;
        try { applyShapeChanges({ actor: owen.pk, actorRole: 'owner' }, turnOn); } catch (e) { threw = e; }
        assert(threw instanceof ShapeChangeError && threw.status === 403 && threw.code === 'core_proof_needed' && snapshot() === b,
            `called without the route's proof, the write refuses on its own, nothing written (${(threw as Error)?.message})`);
    }

    // ── 5. Locked: with the proof ────────────────────────────────────────────────────────────────
    console.log('\n── 5. locked: with the fresh proof ──');
    /** A Core change made with a proof: written, `core.unlock` before its line, stamped alike, one alert naming it. */
    async function provenChange(label: string, changes: Record<string, unknown>, headers: Record<string, string>, extra: Record<string, unknown>,
        unlocked: string, alertWords: RegExp): Promise<Res> {
        const m = logMark(), a = alerts.length, n = noticeMark();
        const res = await post({ changes, ...extra }, headers);
        const ls = linesSince(m);
        assert(res.status === 200 && ls.length >= 2 && ls[0].setting === 'core.unlock' && ls[0].old_value === null && ls[0].new_value === unlocked
            && ls.slice(1).every((l) => l.setting.split('.')[0] === unlocked) && ls.every((l) => l.at === ls[0].at),
            `${label}: written, after a core.unlock line naming ${unlocked}, stamped alike (${show(res)}; ${JSON.stringify(ls.map((l) => [l.setting, l.old_value, l.new_value]))})`);
        const al = alerts.slice(a);
        assert(al.length === 1 && /^A core setting was unlocked and changed, by an owner: /.test(al[0].detail) && alertWords.test(al[0].detail) && !al[0].detail.includes('Owen'),
            `${label}: one owner alert, naming the change and no one (${al[0]?.detail})`);
        void n;
        return res;
    }
    nMark = noticeMark();
    await provenChange("the phone's hand-off just after Manage", { decisions: true }, asPhone(), {}, 'decisions', /Community votes \(Decisions\) \(off → on\)/);
    assert(np().decisions === true && noticesSince(nMark).some((x) => /community votes are on/.test(x.body)), 'votes are on, and members are told');
    assert(lockRow() !== null && readShape().core.lock !== null, 'and the group is locked still: the next change asks again');
    await refusedClean('the next change, from a computer', () => post({ changes: { decisions: false } }, asComputer()), 403, 'phone_required');
    // The code sent with the two requests refused anyway (section 4) was never spent: it changes votes now, nothing between
    // having cleared the server's memory of used codes (twoFa.code() clears it).
    await provenChange('the password, with a current code (`code`), the one sent with the refused requests', { decisions: false }, pwSession(), { code: kept },
        'decisions', /\(on → off\)/);
    await refusedClean('the same code again: spent', () => post({ changes: { decisions: true }, code: kept }, pwSession()), 401, null);
    await provenChange('the password, with a code in X-Fresh-Proof', { decisions: true }, { ...pwSession(), 'X-Fresh-Proof': twoFa.code() }, {}, 'decisions', /\(off → on\)/);
    await provenChange('the password with a code inline (X-Admin-TOTP)', { shareOutside: false }, twoFa.headers(), {}, 'shareOutside', /Members may share listings outside the community \(on → off\)/);
    {
        // With the node's 2FA off, the password gives no fresh proof. It never gets that far: turning 2FA off ends the
        // password's sessions (401), and one opened after is held to the 2FA setup card by the middleware (sign-in step 7c),
        // before requireFreshProof's own fail-closed refusal.
        updateLocalConfig({ totpEnabled: false, totpSecret: null });
        await refusedClean("the password's session with the node's 2FA off (held to the 2FA setup)", () => post({ changes: { decisions: true }, code: '123456' }, pwSession()),
            403, 'totp_setup_required');
        updateLocalConfig({ totpEnabled: true, totpSecret: twoFa.secret });
    }
    await provenChange('Beans, from the phone', { beans: false }, asPhone(), {}, 'beans', /Beans \(on → off\)/);
    await provenChange('Beans back on', { beans: true }, asPhone(), {}, 'beans', /Beans \(off → on\)/);
    await refusedClean('the known floor, its floor alone, from a computer', () => post({ changes: { knownFloor: { floor: 1300 } } }, asComputer()), 403, 'phone_required');
    await refusedClean('the known floor, its cap alone, from a computer', () => post({ changes: { knownFloor: { cap: 3000 } } }, asComputer()), 403, 'phone_required');
    await refusedClean('the known floor, its dial alone, from a computer', () => post({ changes: { knownFloor: { on: false } } }, asComputer()), 403, 'phone_required');
    await provenChange('the known floor, floor and cap, from the phone', { knownFloor: { floor: 1300, cap: 3000 } }, asPhone(), {}, 'knownFloor',
        /Known floor for confirmed members, the floor \(\d+ → 1300\); Known floor for confirmed members, the cap \(\d+ → 3000\)/);
    await refusedClean("where members' copies go, from a computer", () => post({ changes: { recoveryCopies: 'none' } }, asComputer()), 403, 'phone_required');
    await provenChange("where members' copies go, from the phone", { recoveryCopies: 'none' }, asPhone(), {}, 'recoveryCopies', /\(vault → none\)/);
    {
        // Two Core settings in one request: one proof, a core.unlock line before each.
        const m = logMark();
        const both = await post({ changes: { decisions: false, recoveryCopies: 'vault' } }, asPhone());
        const ls = linesSince(m).map((l) => `${l.setting}:${l.new_value}`);
        assert(both.status === 200 && isDeepStrictEqual(ls, ['core.unlock:decisions', 'decisions:off', 'core.unlock:recoveryCopies', 'recoveryCopies:vault']),
            `two Core settings in one request: a core.unlock line before each (${show(both)}; ${ls.join(', ')})`);
    }

    // ── 6. Locked: everyday settings, and who can join ──────────────────────────────────────────
    console.log('\n── 6. locked: everyday settings ask nothing; who can join is two ──');
    mark = logMark(); aMark = alerts.length;
    r = await post({ changes: { probation: true } }, asComputer());
    lines = linesSince(mark);
    assert(r.status === 200 && np().probation === true && lines.length === 1 && lines[0].setting === 'probation'
        && /^How this community works was changed, by an owner: Limits on new accounts\./.test(alerts.slice(aMark)[0]?.detail ?? ''),
        `an everyday setting from a computer: written, no core.unlock line, the alert as before (${show(r)})`);
    r = await post({ changes: { autoHide: true, autoMute: true } }, asComputer());
    assert(r.status === 200 && np().autoHideReports === true && np().autoMute === true, `two everyday settings in one request (${show(r)})`);
    for (const [label, changes] of [['votes sent as they are', { decisions: false }], ['the door sent as it is', { join: 'members' }]] as const) {
        const b = snapshot();
        const res = await post({ changes }, asComputer());
        assert(res.status === 200 && res.body?.told === 'nobody' && snapshot() === b, `a Core setting ${label}: no change, nothing asked or written (${show(res)})`);
    }
    mark = logMark();
    r = await post({ changes: { join: 'paused' } }, asComputer());
    assert(r.status === 200 && np().invites === false && linesSince(mark).every((l) => l.setting !== 'core.unlock'),
        `pausing new members from a computer: an everyday change (${show(r)})`);
    assert(readShape().settings.join.door === 'members', 'paused, join.door keeps the door it had');
    await refusedClean('un-paused to the other door, from a computer', () => post({ changes: { join: 'admins' } }, asComputer()), 403, 'phone_required');
    r = await post({ changes: { join: 'members' } }, asComputer());
    assert(r.status === 200 && np().invites === true && getDoor() === 'members', `un-paused to the door it had, from a computer (${show(r)})`);
    await refusedClean('the door changed, from a computer', () => post({ changes: { join: 'admins' } }, asComputer()), 403, 'phone_required');
    await provenChange('the door changed, from the phone', { join: 'admins' }, asPhone(), {}, 'join', /Who can join \(members → admins\)/);
    r = await post({ changes: { join: 'paused' } }, asComputer());
    assert(r.status === 200 && readShape().settings.join.door === 'admins', `paused again from a computer, the door kept (${show(r)})`);
    await provenChange('un-paused to the other door, from the phone', { join: 'members' }, asPhone(), {}, 'join', /Who can join \(paused → members\)/);
    await refusedClean('a pause beside a Core change', () => post({ changes: { join: 'paused', decisions: true } }, asPhone()), 400, 'one_kind_per_request');
    for (const [setting, to, door, core] of [
        ['join', 'paused', 'members', false], ['join', 'members', 'members', false], ['join', 'admins', 'members', true],
        ['join', 'members', 'admins', true], ['knownFloor.cap', '3000', 'members', true], ['probation', 'on', 'members', false],
        ['removalDecider', 'everyone', 'members', false], ['listed', 'off', 'members', false], ['wordsDoor', 'on', 'members', true],
    ] as const) {
        assert(isCoreChange(setting, to, door) === core, `isCoreChange(${setting} → ${to}, door ${door}) is ${core}`);
    }

    // ── 7. join.door, every stored combination ──────────────────────────────────────────────────
    console.log('\n── 7. join.door ──');
    const setRow = (key: string, value: string | null) => {
        if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
        else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    };
    const doorWas = rowOf('door'), invitesWas = rowOf('nodeProfile.invites');
    for (const door of [null, 'members', 'admins', 'garbage'] as const) {
        for (const invites of [null, 'true', 'false'] as const) {
            setRow('door', door);
            setRow('nodeProfile.invites', invites);
            const j = readShape().settings.join;
            const want = door === 'admins' ? 'admins' : 'members';
            assert(j.door === want && (invites === 'false' ? j.configured === 'paused' : j.configured === want),
                `door row ${door ?? 'none'}, invites ${invites ?? 'default'}: join.door ${want} (${j.door}, configured ${j.configured})`);
        }
    }
    setRow('door', doorWas);
    setRow('nodeProfile.invites', invitesWas);

    // ── 8. A standby, the record, and the global kind ──────────────────────────────────────────
    console.log('\n── 8. a standby, the record, the global kind ──');
    const record = readCommunitySettings();
    assert(record.nodeConfig.core_settings_lock === lockRow() && NODE_CONFIG_KEYS.core_settings_lock?.kind === 'community-settings',
        `the community settings record carries the row, as the replication manifest says (${record.nodeConfig.core_settings_lock})`);
    const parsed = parseCommunitySettings({ localConfig: {}, nodeConfig: { core_settings_lock: '{"at":"soon","by":"x"}' }, directory: {} });
    assert(parsed !== null && !('core_settings_lock' in parsed.record.nodeConfig) && parsed.left.some((l) => l.includes('core_settings_lock')),
        `a row that isn't a lock is left out of a standby's copy (${JSON.stringify(parsed?.left)})`);
    setRow(KEPT_COMMUNITY_SETTINGS_KEY, null);
    const ownLock = lockRow();
    unlockByHand();
    setNodeRole('backup');
    assert(readShape().core.lock === null, 'a standby with no copy and no row of its own reads unlocked');
    const copied = keepMainServerCommunitySettings({
        localConfig: {}, nodeConfig: { core_settings_lock: JSON.stringify({ at: '2026-11-03T08:00:00.000Z', by: ada.pk }) }, directory: {},
    }, '2026-11-03T09:00:00.000Z');
    assert(copied.kept, "the main server's record is kept, as a copy brings it");
    assert(isDeepStrictEqual(readShape().core.lock, { at: '2026-11-03T08:00:00.000Z', by: ada.pk, byCallsign: 'Ada' }) && lockRow() === null,
        `a standby reads its copy's lock, its own rows untouched (${JSON.stringify(readShape().core.lock)})`);
    const meStandby = await call('GET', owen, '/api/node-admin/me');
    assert(isDeepStrictEqual(meStandby.body?.coreSettings, { locked: true, at: '2026-11-03T08:00:00.000Z' }), `and so does /me there (${show(meStandby)})`);
    await refusedClean('confirm and lock on a standby', () => post({ changes: {}, lock: true }, asPhone()), 409, 'standby');
    await refusedClean('a Core change on a standby, with the proof', () => post({ changes: { decisions: true } }, asPhone()), 409, 'standby');
    setNodeRole('primary');
    setRow(KEPT_COMMUNITY_SETTINGS_KEY, null);
    setRow(CORE_SETTINGS_LOCK_KEY, '{"not":"a lock"}');
    assert(isDeepStrictEqual(readShape().core.lock, { at: null, by: null, byCallsign: null }),
        'a row that is not a lock still locks (fail closed), when and by whom unknown');
    await refusedClean('a Core change under that row, from a computer', () => post({ changes: { decisions: true } }, asComputer()), 403, 'phone_required');
    setRow(CORE_SETTINGS_LOCK_KEY, ownLock);

    unlockByHand();
    unplaceIt();
    process.env.NODE_PROFILE = 'global';
    sh = readShape();
    assert(isDeepStrictEqual(sh.core.place, { needed: false, set: false }), `the global kind needs no place (${JSON.stringify(sh.core.place)})`);
    r = await post({ changes: {}, lock: true }, asPhone());
    assert(r.status === 200 && lockRow() !== null, `the global kind confirms and locks with no place (${show(r)})`);
    process.env.NODE_PROFILE = '';

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
