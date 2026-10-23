/**
 * How this community works, slice S2: the one place its owners change it (config/community-shape-write.ts, POST
 * /api/local/admin/community-shape; scratch/fable-design/DESIGN-community-shape-settings-fable.md §2.4, §2.5, §3.4, §6.1,
 * §7 S2, §8.2).
 *
 *   1. Who: an owner's key session, the phone's hand-off within its step-up, the password with 2FA. Never an admin, a
 *      moderator, an automation token of any scope, a member or nobody; and the phone's hand-off past its step-up. Each
 *      refusal writes nothing.
 *   2. Each setting the route takes, written through the node's own setter, so the node's gates follow it at once; one log
 *      line per setting changed and none for one sent unchanged; an owner alert (`sec.settings`) for every change, the
 *      owner's own included; and, for a members' rule, one notice kept for every member who keeps notices, in the fixed
 *      sentence with the owner's note quoted after it. The directory switches tell no member.
 *   3. Every lock: each change it refuses answers 409 with the lock's own sentence and code, and NOTHING is written (the
 *      database snapshotted around it), no owner is alerted and no member told. A lock this request lifts or sets is read
 *      where the request leaves the node (requests to join and invites, the known floor and Beans).
 *   4. Every bad request answers 400 and writes nothing, the good changes beside a bad one included (all or nothing).
 *   5. The known floor: its own checks for the amounts, its own log kept too, and the shape reading the change once.
 *   6. The global kind, and a ledger that has moved.
 *   7. A standby changes nothing (409), and what is written travels as before (the profile record, the community
 *      settings record, the log's plain rows).
 *   8. The old ways in: `acceptKnocks`, `dmRequests` and `door` on POST /api/local/admin/node/config are refused (400,
 *      nothing written), and POST /api/local/admin/known-floor is gone; the reads stay.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-community-shape-write.ts
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Shape } from './config/community-shape.js';

// The flags the server reads at import, set before anything is imported (every import below is dynamic).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.DIRECTORY_UNLISTED;
process.env.ADMIN_PASSWORD = 'CommunityShapeWrite123!';
// The suites' seam (scripts/server-suites.mjs sets it too): the password from .env, as on a node from before claim codes.
process.env.BEANPOOL_SUITE_ENV_PASSWORD = '1';
// A directory push that got past every hold-back would go here: a closed port on this machine, never the registry.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:9/directory-register';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; headers: Headers };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 240)}`;
const DAY = 86_400_000;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

async function main(): Promise<void> {
    console.log('How this community works: the write path (S2)\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { ownerSessionHeaders, ownerTokenHeaders, ownerPhoneSessionHeaders, seedOwnerForTests, turnOn2faForTests } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken, backdateAdminSessionForTests } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto } = await import('@beanpool/engine');
    const np = await import('./config/node-profile.js');
    const { getDoor, mayInviteHere } = await import('./config/door.js');
    const { knownFloorSettings } = await import('./config/known-floor.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { readCommunitySettings } = await import('./config/community-settings.js');
    const { setSecurityAlertHandler } = await import('./services/security-signal.js');
    const { readShape } = await import('./config/community-shape.js');
    const { SHAPE_NOTE_MAX, memberNoticeBody, memberNoticeBodies, memberNoticeTitle } = await import('./config/community-shape-write.js');
    const { NOTICE_LIMITS } = await import('./engine/kept-notices.js');

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    function makeMember(name: string, extra: { visitor?: boolean; treasury?: boolean; status?: string } = {}): Id {
        const id = keypair(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status, is_visitor, is_treasury)
                    VALUES (?, ?, ?, 'genesis', 'TEST', ?, ?, ?)`).run(id.pk, name, ago(30 * DAY), extra.status ?? 'active', extra.visitor ? 1 : 0, extra.treasury ? 1 : 0);
        setMemberPhoto(db, id.pk, AVATAR);
        db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
        return id;
    }
    function sessionHeaders(pub: string, role: 'owner' | 'admin' | 'moderator'): Record<string, string> {
        const { handshakeToken } = mintHandshakeToken(pub, role);
        const s = consumeHandshakeToken(handshakeToken);
        if (!s.ok || !s.sessionId) throw new Error(`could not open a test key session: ${s.error}`);
        return { 'X-Admin-Session': s.sessionId };
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
        return { status: res.status, body: json, headers: res.headers };
    }

    se.seedGenesisMember(keypair('Founder').pk, 'Founder');
    const owenPk = seedOwnerForTests('Owen');
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const mo = makeMember('Mo');
    grantNodeRole(mo.pk, 'moderator', 'SYSTEM');
    const sam = makeMember('Sam');
    const kim = makeMember('Kim');
    // Who keeps no notice: a visitor's row, an enterprise's key, a closed account.
    const visitor = makeMember('Visitor', { visitor: true });
    const treasury = makeMember('Treasury', { treasury: true });
    const gone = makeMember('Gone', { status: 'pruned' });
    updateLocalConfig({ communityName: 'Riverside Commons' });

    const PATH = '/api/local/admin/community-shape';
    const owner = ownerSessionHeaders(owenPk);
    const post = (body: unknown, headers: Record<string, string> = owner, id: Id | null = null) => call('POST', id, PATH, body, headers);
    const change = (changes: Record<string, unknown>, note?: string) => post(note === undefined ? { changes } : { changes, note });

    // ── What a refusal must leave as it was ───────────────────────────────────────────────────────
    const OVERRIDE_PREFIX = 'nodeProfile.';
    const setOverrideRow = (name: string, on: boolean | null) => {
        if (on === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(OVERRIDE_PREFIX + name);
        else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OVERRIDE_PREFIX + name, String(on));
    };
    const clearOverrides = () => db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run(OVERRIDE_PREFIX.length, OVERRIDE_PREFIX);
    const rowOf = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    const snapshot = () => JSON.stringify({
        nodeConfig: db.prepare('SELECT key, value FROM node_config ORDER BY key').all(),
        shapeLog: db.prepare('SELECT * FROM community_settings_log ORDER BY id').all(),
        floorLog: db.prepare('SELECT * FROM known_floor_log ORDER BY id').all(),
        notices: db.prepare('SELECT id FROM moderation_notices ORDER BY id').all(),
    });
    const alerts: { key: string; detail: string; actor?: string; actorRole?: string }[] = [];
    setSecurityAlertHandler((n) => { alerts.push({ key: n.key, detail: n.detail, actor: n.actor, actorRole: n.actorRole }); });
    const noticeMark = () => (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM moderation_notices').get() as { m: number }).m;
    const noticesSince = (mark: number) => db.prepare('SELECT recipient, title, body, data FROM moderation_notices WHERE rowid > ? ORDER BY rowid').all(mark) as
        { recipient: string; title: string; body: string; data: string }[];
    const logMark = () => (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM community_settings_log').get() as { m: number }).m;
    const linesSince = (mark: number) => db.prepare('SELECT * FROM community_settings_log WHERE id > ? ORDER BY id').all(mark) as any[];
    // Every member who keeps notices: not a visitor's row, an enterprise's key (the Commons' included), a closed account,
    // or the node's own SYSTEM row.
    const keepers = () => (db.prepare(`SELECT public_key FROM members WHERE status != 'disabled' AND status != 'pruned' AND public_key != 'SYSTEM'
                                       AND COALESCE(is_visitor, 0) = 0 AND COALESCE(is_treasury, 0) = 0 ORDER BY public_key`).all() as { public_key: string }[])
        .map((m) => m.public_key);
    /** Each member's notices since `mark`: the bodies they were told, in order, all members alike. */
    const toldEach = (mark: number): string[] | null => {
        const byMember = new Map<string, string[]>();
        for (const x of noticesSince(mark)) byMember.set(x.recipient, [...(byMember.get(x.recipient) ?? []), x.body]);
        const all = keepers().map((pk) => JSON.stringify(byMember.get(pk) ?? []));
        return byMember.size === keepers().length && all.every((b) => b === all[0]) ? JSON.parse(all[0]) : null;
    };
    const SENT = (s: string) => `Your community's owners changed how it works: ${s}`;

    /** A refusal: its status and code, the sentence, and nothing written, alerted or told. */
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
    const lockWhy = (sh: Shape, setting: keyof Shape['settings']) => (sh.settings[setting] as { lock: { why: string } | null } | undefined)?.lock?.why ?? '(no lock)';

    // ── 1. Who ───────────────────────────────────────────────────────────────────────────────────
    console.log('── 1. only an owner changes how it works ──');
    const flip = { decisions: false };
    // Every credential made first: making a token is itself a change the suite must not count as the route's.
    const asModerator = sessionHeaders(mo.pk, 'moderator'), asAdmin = sessionHeaders(ada.pk, 'admin');
    const adminToken = ownerTokenHeaders('admin', owenPk), readToken = ownerTokenHeaders('read', owenPk), backupsToken = ownerTokenHeaders('backups', owenPk);
    const phone = ownerPhoneSessionHeaders(owenPk), freshPhone = ownerPhoneSessionHeaders(owenPk);
    await refusedClean('nobody', () => post({ changes: flip }, {}), 401, null);
    {
        const before = snapshot(), alertsBefore = alerts.length;
        const r = await post({ changes: flip }, {}, sam);
        assert((r.status === 401 || r.status === 403) && snapshot() === before && alerts.length === alertsBefore, `a member who is no admin: refused, nothing written (${show(r)})`);
    }
    await refusedClean('a moderator', () => post({ changes: flip }, asModerator), 403, null);
    await refusedClean('an admin', () => post({ changes: flip }, asAdmin), 403, null, 'Only an owner of this community can change how it works');
    await refusedClean('an admin automation token', () => post({ changes: flip }, adminToken), 403, 'token_not_allowed');
    const readTok = await refusedClean('a read automation token', () => post({ changes: flip }, readToken), 403, null);
    assert(!readTok.body?.shape, 'a read token gets no shape back from a change');
    await refusedClean('a backups automation token', () => post({ changes: flip }, backupsToken), 403, null);
    backdateAdminSessionForTests(phone['X-Admin-Session'], 6 * 60_000);
    await refusedClean("the phone's hand-off six minutes after its unlock", () => post({ changes: flip }, phone), 403, 'step_up_required');
    const fresh = await post({ changes: { decisions: false } }, freshPhone);
    assert(fresh.status === 200 && np.getConfiguredSwitches().decisions === false, `the phone's hand-off just after its unlock changes it (${show(fresh)})`);
    const keyAgain = await change({ decisions: true });
    assert(keyAgain.status === 200 && np.getConfiguredSwitches().decisions === true && rowOf(OVERRIDE_PREFIX + 'decisions') === null,
        `an owner's key session changes it, and back to the default removes the row (${show(keyAgain)})`);

    // ── 2. Each setting, logged, alerted and told ────────────────────────────────────────────────
    console.log('\n── 2. each change: written, logged, the owners alerted, the members told ──');
    let mark = logMark(), nMark = noticeMark(), aMark = alerts.length;
    const joinAdmins = await change({ join: 'admins' }, '  Summer   visitors ');
    let lines = linesSince(mark);
    assert(joinAdmins.status === 200 && joinAdmins.body?.told === 'members' && getDoor() === 'admins' && !mayInviteHere(sam.pk) && mayInviteHere(ada.pk),
        `only admins invite: the door the invite gates read is admins (${show(joinAdmins)})`);
    assert(lines.length === 1 && lines[0].setting === 'join' && lines[0].old_value === 'members' && lines[0].new_value === 'admins'
        && lines[0].actor_pubkey === owenPk && lines[0].actor_role === 'owner' && lines[0].note === 'Summer visitors',
        `one log line: join members → admins, by the owner's key, with the note as one line (${JSON.stringify(lines)})`);
    assert(isDeepStrictEqual(joinAdmins.body?.shape, JSON.parse(JSON.stringify(readShape()))) && joinAdmins.body.shape.version === lines[0].id,
        `the answer is the shape as it now is, its version the new line (${joinAdmins.body?.shape?.version})`);
    let told = alerts.slice(aMark);
    assert(told.length === 1 && told[0].key === 'sec.settings' && told[0].detail.includes('Who can join') && told[0].actor === owenPk && told[0].actorRole === 'owner',
        `the owners are alerted, sec.settings, naming the setting (${JSON.stringify(told)})`);
    let notices = noticesSince(nMark);
    const wantBody = `${SENT('only the admins invite people now.')}\n\nFrom the owners: “Summer visitors”`;
    assert(notices.length === keepers().length && isDeepStrictEqual(notices.map((n) => n.recipient).sort(), keepers())
        && notices.every((n) => n.title === 'How this community works has changed' && n.body === wantBody && JSON.parse(n.data).kind === 'community_shape'),
        `every member who keeps notices has one, the fixed sentence with the note quoted after it (${notices.length} of ${keepers().length}: ${JSON.stringify(notices[0]?.body)})`);
    assert(notices.some((n) => n.recipient === sam.pk) && !notices.some((n) => [visitor.pk, treasury.pk, gone.pk].includes(n.recipient)),
        'Sam has it; a visitor\'s row, an enterprise\'s key and a closed account do not');
    assert(memberNoticeTitle() === 'How this community works has changed', 'the title is the design\'s');

    mark = logMark(); nMark = noticeMark(); aMark = alerts.length;
    const again = await change({ join: 'admins', decisions: true });
    assert(again.status === 200 && again.body?.told === 'nobody' && linesSince(mark).length === 0 && noticeMark() === nMark && alerts.length === aMark,
        `values sent as they are change nothing: no line, no alert, no notice (${show(again)})`);

    // Paused keeps the door as it was; un-pausing keeps it too.
    mark = logMark(); nMark = noticeMark();
    const paused = await change({ join: 'paused' });
    assert(paused.status === 200 && np.getConfiguredSwitches().invites === false && !np.getNodeFeatures().invites && rowOf('door') === 'admins'
        && np.getNodeFeatures().knocks === false && paused.body.shape.settings.join.value === 'paused',
        `paused: invites off (and requests to join with them), the door row kept as it was (${show(paused)})`);
    assert(isDeepStrictEqual(toldEach(nMark), [SENT('no new members are being taken for now.')]), 'members are told no new members are being taken');
    await refusedClean('requests to join while paused (invites_off)', () => change({ knocks: false }), 409, 'invites_off', lockWhy(readShape(), 'knocks'));
    const unpause = await change({ join: 'admins' });
    assert(unpause.status === 200 && np.getConfiguredSwitches().invites === true && rowOf(OVERRIDE_PREFIX + 'invites') === null && getDoor() === 'admins',
        `un-paused to only admins: invites back to the default, the door still admins (${show(unpause)})`);
    await change({ join: 'paused' });
    const lifted = await change({ join: 'members', knocks: false });
    assert(lifted.status === 200 && getDoor() === 'members' && rowOf('door') === null && np.getNodeFeatures().invites && np.getConfiguredSwitches().knocks === false,
        `paused → any member with requests to join off, in one request: the lock it lifts doesn't refuse it (${show(lifted)})`);
    await refusedClean('pausing and changing requests to join in one request (invites_off)', () => change({ join: 'paused', knocks: true }), 409, 'invites_off');
    assert(np.getNodeFeatures().invites && getDoor() === 'members', 'and invites are as they were: nothing of it was written');

    // Several at once: a line each, one alert, one notice with each members' rule.
    mark = logMark(); nMark = noticeMark(); aMark = alerts.length;
    const several = await change({ knocks: true, decisions: false, dmRequests: true, shareEmail: true, probation: true });
    lines = linesSince(mark);
    assert(several.status === 200 && isDeepStrictEqual(lines.map((l) => `${l.setting}:${l.old_value}>${l.new_value}`),
        ['knocks:off>on', 'dmRequests:off>on', 'decisions:on>off', 'probation:off>on', 'shareEmail:off>on']),
        `one line per setting changed, in the route's order (${JSON.stringify(lines.map((l) => l.setting))})`);
    const f = np.getNodeFeatures();
    assert(f.knocks && !f.decisions && f.dmRequests === true && f.probation && se.getNodeConfig().publishContactEmail === true,
        `the node's own readers follow each one (${JSON.stringify({ knocks: f.knocks, decisions: f.decisions, dm: f.dmRequests, probation: f.probation })})`);
    told = alerts.slice(aMark);
    assert(told.length === 1 && ['Requests to join', 'Community votes', 'First message from someone new', 'Share email', 'Limits on new accounts'].every((n) => told[0].detail.includes(n)),
        `one alert names every setting (${told[0]?.detail})`);
    const severalSaid = [SENT('people who find this community can ask to join.'), SENT('a first message from someone new now waits until you accept it.'),
        SENT('community votes are off; the moderators look after things.'), SENT('new accounts have limits for their first days.')];
    const severalTold = toldEach(nMark);
    assert(isDeepStrictEqual(severalTold, memberNoticeBodies(severalSaid, null)) && severalTold!.every((b) => b.length <= NOTICE_LIMITS.body)
        && severalSaid.every((x) => severalTold!.join('\n').includes(x)) && !severalTold!.join('\n').includes('email'),
        `every member is told each members' rule in a whole sentence, in notices a kept one can hold, and nothing of the directory's email switch (${JSON.stringify(severalTold)})`);

    // The rest of the switches, back again.
    nMark = noticeMark();
    const back = await change({ decisions: true, dmRequests: false, probation: false, autoHide: true, autoMute: true });
    const f2 = np.getNodeFeatures();
    assert(back.status === 200 && f2.decisions && !('dmRequests' in f2) && !f2.probation && f2.autoHideReports && f2.autoMute,
        `votes on, message requests and new-account limits off, both safety switches on (${show(back)})`);
    assert(isDeepStrictEqual(toldEach(nMark), memberNoticeBodies([SENT('every message now arrives straight away.'), SENT('community votes are on.'),
        SENT('new accounts no longer have limits for their first days.'), SENT('reported posts are hidden until a moderator looks.'),
        SENT('repeat offenders are muted automatically.')], null)), `members are told each in its own sentence (${JSON.stringify(toldEach(nMark))})`);
    nMark = noticeMark();
    await change({ autoHide: false, autoMute: false });
    assert(isDeepStrictEqual(toldEach(nMark), [[SENT('reported posts stay up until a moderator looks.'), SENT('repeat offenders are no longer muted automatically.')].join('\n')]),
        'and when they go off again');

    // The directory: written, logged, alerted, and no member told.
    mark = logMark(); nMark = noticeMark(); aMark = alerts.length;
    const dir = await change({ listed: false, shareLocation: false, shareMemberCount: false, sharePhone: true, shareHealth: false, shareEmail: false });
    const n = se.getNodeConfig();
    assert(dir.status === 200 && dir.body?.told === 'nobody' && noticeMark() === nMark && alerts.length === aMark + 1 && linesSince(mark).length === 6
        && np.getConfiguredSwitches().publishToDirectory === false && !n.publishLocation && !n.publishMembers && n.publishContactPhone === true && !n.publishHealth && !n.publishContactEmail,
        `the directory's switches: written and logged, the owners alerted, no member told (${show(dir)})`);
    assert(dir.body.shape.settings.shareLocation.source === 'owner' && dir.body.shape.settings.listed.value === false, 'and the shape reads them');
    await change({ listed: true, shareLocation: true, shareMemberCount: true, sharePhone: false, shareHealth: true });
    assert(readShape().settings.shareLocation.source === 'default' && rowOf(OVERRIDE_PREFIX + 'publishToDirectory') === null, 'back to their defaults, they read as the defaults again');

    // Beans off, on a local community nothing has moved in yet (design Q1).
    nMark = noticeMark();
    const beansOff = await change({ beans: false });
    assert(beansOff.status === 200 && !np.getNodeFeatures().beans && !np.getProfileSwitches().escrow,
        `a local community whose ledger never moved switches Beans off, escrow with them (${show(beansOff)})`);
    assert(isDeepStrictEqual(toldEach(nMark), [SENT('Beans are off, so there are no prices, sends or credit here.')]), 'and its members are told');
    await refusedClean('the known floor with no Beans (beans_off)', () => change({ knownFloor: { floor: 1300 } }), 409, 'beans_off', lockWhy(readShape(), 'knownFloor'));
    await refusedClean('the known floor\'s dial with no Beans (beans_off)', () => change({ knownFloor: { on: true } }), 409, 'beans_off');
    nMark = noticeMark();
    const beansBack = await change({ beans: true, knownFloor: { floor: 1300 } });
    assert(beansBack.status === 200 && np.getNodeFeatures().beans && knownFloorSettings().knownFloor === 1300 && knownFloorSettings().confirmation,
        `Beans on and the known floor moved in one request: the lock it lifts doesn't refuse it (${show(beansBack)})`);
    assert(isDeepStrictEqual(toldEach(nMark), [[SENT('Beans are on.'), SENT('confirmed members can owe up to 1,300 Beans now (the known floor).')].join('\n')]),
        `members are told both: with Beans back, the dial that read off without them is on again (${JSON.stringify(toldEach(nMark))})`);
    await refusedClean('Beans off and the known floor moved in one request (beans_off)', () => change({ beans: false, knownFloor: { floor: 1400 } }), 409, 'beans_off');
    assert(np.getNodeFeatures().beans, 'and Beans stayed on: nothing of it was written');

    // ── 3. The private preview and the server's env ─────────────────────────────────────────────
    console.log('\n── 3. the locks of the server\'s env ──');
    process.env.PRIVATE_PREVIEW = '1';
    const inPreview = readShape();
    await refusedClean('who can join in a private preview (private_preview)', () => change({ join: 'paused' }), 409, 'private_preview', lockWhy(inPreview, 'join'));
    await refusedClean('requests to join in a private preview (private_preview)', () => change({ knocks: false }), 409, 'private_preview', lockWhy(inPreview, 'knocks'));
    await refusedClean('a good change beside a locked one (all or nothing)', () => change({ decisions: false, join: 'admins' }), 409, 'private_preview');
    assert(np.getConfiguredSwitches().decisions === true, 'votes stayed on');
    const previewVotes = await change({ decisions: false });
    assert(previewVotes.status === 200 && !np.getNodeFeatures().decisions, `what the preview doesn't lock still changes (${show(previewVotes)})`);
    await change({ decisions: true });
    process.env.PRIVATE_PREVIEW = '';

    process.env.DIRECTORY_UNLISTED = '1';
    await change({ listed: false });
    await refusedClean('Listed on while DIRECTORY_UNLISTED holds every push back (server_env)', () => change({ listed: true }), 409, 'server_env', /DIRECTORY_UNLISTED/);
    process.env.DIRECTORY_UNLISTED = '';
    const relisted = await change({ listed: true });
    assert(relisted.status === 200 && np.getConfiguredSwitches().publishToDirectory === true, `without it, Listed goes on (${show(relisted)})`);
    process.env.DIRECTORY_UNLISTED = '1';
    const unlistOk = await change({ listed: false });
    assert(unlistOk.status === 200 && np.getConfiguredSwitches().publishToDirectory === false, `and off is never refused (${show(unlistOk)})`);
    process.env.DIRECTORY_UNLISTED = '';
    await change({ listed: true });

    // ── 4. Bad requests ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. a bad request writes nothing ──');
    await refusedClean('no changes', () => post({}), 400, 'no_changes');
    await refusedClean('changes that are no object', () => post({ changes: [{ knocks: false }] }), 400, 'no_changes');
    await refusedClean('an empty change', () => change({}), 400, 'no_changes');
    await refusedClean('a setting that is none', () => change({ fees: true }), 400, 'bad_setting');
    for (const key of ['openDoor', 'preview', 'visitors', 'connections']) {
        await refusedClean(`${key}: the server's, not changed here`, () => change({ [key]: false }), 400, 'not_changeable');
    }
    await refusedClean('12 words at the door of a community with no open door', () => change({ wordsDoor: true }), 400, 'not_changeable');
    await refusedClean('the open door as who can join, in the door\'s own words', () => change({ join: 'open' }), 409, 'door_open_refused', /strangers would hold credit/);
    await refusedClean('a switch that is no true or false', () => change({ knocks: 'no' }), 400, 'bad_setting');
    await refusedClean('a good change beside a bad one (all or nothing)', () => change({ decisions: false, autoMute: 'yes' }), 400, 'bad_setting');
    await refusedClean(`a note longer than ${SHAPE_NOTE_MAX}`, () => change({ decisions: false }, 'x'.repeat(SHAPE_NOTE_MAX + 1)), 400, 'bad_note');
    await refusedClean('a note that is no sentence', () => post({ changes: { decisions: false }, note: 42 }), 400, 'bad_note');
    await refusedClean('the known floor above the cap', () => change({ knownFloor: { floor: 4000, cap: 3000 } }), 400, 'floor_above_cap');
    await refusedClean('a cap past the most', () => change({ knownFloor: { cap: 9000 } }), 400, 'bad_cap');
    await refusedClean('a known floor below nothing', () => change({ knownFloor: { floor: -1 } }), 400, 'bad_amount');
    await refusedClean('a known floor with a field it has not', () => change({ knownFloor: { amount: 1 } }), 400, 'bad_setting');
    await refusedClean('a known floor that is no object', () => change({ knownFloor: 1500 }), 400, 'bad_setting');
    const longOk = await change({ decisions: false }, 'y'.repeat(SHAPE_NOTE_MAX));
    assert(longOk.status === 200 && linesSince(logMark() - 1)[0]?.note?.length === SHAPE_NOTE_MAX, `a note of ${SHAPE_NOTE_MAX} is taken (${longOk.status})`);
    await change({ decisions: true });

    // A notice too long to keep is split, never left unkept.
    const many = Array.from({ length: 6 }, (_, i) => SENT(`rule ${i} has a sentence long enough that six of them make more than one kept notice can hold.`));
    const bodies = memberNoticeBodies(many, 'z'.repeat(SHAPE_NOTE_MAX));
    assert(bodies.length > 1 && bodies.every((b) => b.length <= NOTICE_LIMITS.body) && bodies.join('\n').includes('z'.repeat(SHAPE_NOTE_MAX))
        && many.every((s) => bodies.some((b) => b.includes(s))),
        `a request with many members' rules is told in notices each a kept notice can hold, every sentence and the note in one of them (${bodies.map((b) => b.length).join(', ')})`);
    assert(memberNoticeBodies([SENT('Beans are on.')], 'hi').length === 1 && memberNoticeBody([SENT('Beans are on.')], 'hi') === `${SENT('Beans are on.')}\n\nFrom the owners: “hi”`,
        'one change with a note is one notice');

    // ── 5. The known floor ───────────────────────────────────────────────────────────────────────
    console.log('\n── 5. the known floor ──');
    const floorLogMark = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM known_floor_log').get() as { m: number }).m;
    mark = logMark(); nMark = noticeMark();
    const dialOff = await change({ knownFloor: { on: false } });
    assert(dialOff.status === 200 && knownFloorSettings().confirmation === false && dialOff.body.shape.settings.knownFloor.value.on === false,
        `the dial off (${show(dialOff)})`);
    assert(isDeepStrictEqual(toldEach(nMark), [SENT('confirmed members no longer have a known floor, and go back to the credit they have earned.')]), 'members are told');
    nMark = noticeMark();
    const dialOn = await change({ knownFloor: { on: true, floor: 1500 } }, 'Welcome, neighbours');
    lines = linesSince(mark);
    assert(dialOn.status === 200 && knownFloorSettings().confirmation && knownFloorSettings().knownFloor === 1500, `the dial on and the floor moved (${show(dialOn)})`);
    assert(isDeepStrictEqual(lines.map((l) => `${l.setting}:${l.old_value}>${l.new_value}`), ['knownFloor.on:on>off', 'knownFloor.on:off>on', 'knownFloor.floor:1300>1500']),
        `a line for each part that changed (${JSON.stringify(lines.map((l) => l.setting))})`);
    assert(isDeepStrictEqual(toldEach(nMark), [`${SENT('confirmed members can owe up to 1,500 Beans now (the known floor).')}\n\nFrom the owners: “Welcome, neighbours”`]),
        'members are told the floor they can owe up to, with the note');
    const floorLines = db.prepare(`SELECT action, old_value, new_value, at, actor_pubkey FROM known_floor_log
                                   WHERE member_pubkey IS NULL AND rowid > ? ORDER BY rowid`).all(floorLogMark) as any[];
    assert(isDeepStrictEqual(floorLines.map((l) => `${l.action}:${l.old_value}>${l.new_value}`), ['confirmation:on>off', 'confirmation:off>on', 'known_floor:1300>1500'])
        && floorLines.every((l, i) => l.at === lines[i].at && l.actor_pubkey === owenPk),
        `the known floor's own log keeps its lines too, stamped as the shape's (${JSON.stringify(floorLines)})`);
    const shapeLog = readShape().log.filter((l) => l.setting.startsWith('knownFloor.'));
    assert(shapeLog.length >= 3 && shapeLog.slice(0, 3).every((l) => l.kept === 'community_settings_log')
        && shapeLog.filter((l) => l.at === lines[2].at).length === 2 && shapeLog[0].note === 'Welcome, neighbours',
        `the shape reads each change once, from its own log with the note (${JSON.stringify(shapeLog.slice(0, 4).map((l) => [l.kept, l.setting, l.note]))})`);
    assert(!readShape().log.some((l) => l.kept === 'known_floor_log'),
        'every known-floor change here came through the shape route, so none of its known_floor_log twins is read');
    const getFloor = await call('GET', null, '/api/local/admin/known-floor', undefined, owner);
    assert(getFloor.status === 200 && getFloor.body?.knownFloor === 1500 && getFloor.body?.log?.some((l: any) => l.action === 'known_floor' && l.newValue === '1500'),
        `GET /api/local/admin/known-floor still reads the settings and its log (${getFloor.status})`);
    nMark = noticeMark();
    const capOnly = await change({ knownFloor: { cap: 3000 } });
    assert(capOnly.status === 200 && capOnly.body?.told === 'nobody' && knownFloorSettings().creditCap === 3000 && noticeMark() === nMark,
        `the cap alone tells no member: it is not theirs to read (${show(capOnly)})`);
    await change({ knownFloor: { on: false } });
    nMark = noticeMark();
    const floorWhileOff = await change({ knownFloor: { floor: 1200 } });
    assert(floorWhileOff.status === 200 && floorWhileOff.body?.told === 'nobody' && noticeMark() === nMark, 'nor the floor moved with the dial off: it changes nobody\'s limit');
    await change({ knownFloor: { on: true, floor: 1000, cap: 2000 } });

    // ── 6. The global kind; a ledger that has moved ─────────────────────────────────────────────
    console.log('\n── 6. the global kind, and a ledger that has moved ──');
    clearOverrides();
    process.env.NODE_PROFILE = 'global';
    let g = readShape();
    await refusedClean('who can join on the global kind (profile)', () => change({ join: 'admins' }), 409, 'profile', lockWhy(g, 'join'));
    await refusedClean('Beans on while the open door is set (profile)', () => change({ beans: true }), 409, 'profile', lockWhy(g, 'beans'));
    await refusedClean('Listed on the global kind (profile)', () => change({ listed: true }), 409, 'profile', lockWhy(g, 'listed'));
    await refusedClean('requests to join where invites are off (invites_off)', () => change({ knocks: true }), 409, 'invites_off');
    nMark = noticeMark();
    const words = await change({ wordsDoor: false });
    assert(words.status === 200 && np.getConfiguredSwitches().ssoRequiredForJoin === true && !np.getNodeFeatures().wordsDoor,
        `the global kind's 12-words door off: a sign-in only (${show(words)})`);
    assert(isDeepStrictEqual(toldEach(nMark), [SENT('people join with a sign-in only now.')]), 'members are told');
    nMark = noticeMark();
    await change({ wordsDoor: true });
    assert(np.getNodeFeatures().wordsDoor && isDeepStrictEqual(toldEach(nMark), [SENT('people can join with 12 secret words now, without a sign-in.')]), 'and on again');
    process.env.PRIVATE_PREVIEW = '1';
    g = readShape();
    await refusedClean('the 12-words door in a private preview (private_preview)', () => change({ wordsDoor: false }), 409, 'private_preview', lockWhy(g, 'openDoor'));
    process.env.PRIVATE_PREVIEW = '';
    process.env.NODE_PROFILE = '';

    se.transfer('genesis', sam.pk, 5, 'the ledger moves', 'direct', true);
    np.forgetLedgerHistory();
    assert(np.ledgerHistory() !== null, 'the ledger has moved');
    await refusedClean('Beans off once the ledger has moved (ledger_moved)', () => change({ beans: false }), 409, 'ledger_moved', lockWhy(readShape(), 'beans'));
    process.env.NODE_PROFILE = 'global';
    g = readShape();
    assert(g.settings.openDoor.lock?.code === 'ledger_moved', 'on the global kind the open door is shut for good');
    await refusedClean('the 12-words door with the open door shut (ledger_moved)', () => change({ wordsDoor: false }), 409, 'ledger_moved', lockWhy(g, 'openDoor'));
    await refusedClean('who can join where the open door is set and shut (ledger_moved)', () => change({ join: 'members' }), 409, 'ledger_moved', lockWhy(g, 'join'));
    const beansOnGlobal = await change({ beans: true });
    assert(beansOnGlobal.status === 200, `Beans on, once they have moved anyway, is no lock's to refuse (${show(beansOnGlobal)})`);
    clearOverrides();
    process.env.NODE_PROFILE = '';

    // ── 7. A standby; what travels ───────────────────────────────────────────────────────────────
    console.log('\n── 7. a standby changes nothing; what is written travels ──');
    const sent = await change({ join: 'admins', knocks: false });
    assert(sent.status === 200, 'only admins invite, and no requests to join');
    const record = np.readProfileRecord();
    const settings = readCommunitySettings();
    assert(record.overrides.knocks === 'false' && settings.nodeConfig.door === 'admins',
        `the profile record and the community settings record carry them, as a standby and a take-over read them (${JSON.stringify({ knocks: record.overrides.knocks, door: settings.nodeConfig.door })})`);
    const payload = await se.exportSyncState('community-shape-write-suite') as { plainTables?: Record<string, unknown[]> };
    assert((payload.plainTables?.community_settings_log ?? []).length === (db.prepare('SELECT COUNT(*) AS c FROM community_settings_log').get() as { c: number }).c,
        'the copy a standby is sent carries every log line');
    setNodeRole('backup');
    await refusedClean('an owner on a standby', () => change({ join: 'members' }), 409, 'standby', /standby/);
    await refusedClean('an admin on a standby', () => post({ changes: { join: 'members' } }, sessionHeaders(ada.pk, 'admin')), 403, null);
    setNodeRole('primary');

    // ── 8. The old ways in ───────────────────────────────────────────────────────────────────────
    console.log('\n── 8. the old ways in are closed ──');
    const CONFIG = '/api/local/admin/node/config';
    for (const [field, value] of [['acceptKnocks', true], ['dmRequests', true], ['door', 'members']] as const) {
        const r = await refusedClean(`${field} on node/config, beside a directory switch`, () => call('POST', null, CONFIG, { [field]: value, publishHealth: false }, owner),
            400, 'moved_to_community_shape', /How this community works/);
        assert(r.body?.setting === ({ acceptKnocks: 'knocks', dmRequests: 'dmRequests', door: 'join' } as const)[field], `it names the shape's setting (${r.body?.setting})`);
    }
    const plainSave = await call('POST', null, CONFIG, { publishHealth: false }, sessionHeaders(ada.pk, 'admin'));
    assert(plainSave.status === 200 && se.getNodeConfig().publishHealth === false && typeof plainSave.body?.acceptKnocks === 'boolean',
        `node/config still saves the directory switches it has, for an admin too (${show(plainSave)})`);
    await call('POST', null, CONFIG, { publishHealth: true }, owner);
    {
        const before = snapshot();
        const r = await call('POST', null, '/api/local/admin/known-floor', { confirmation: false }, owner);
        assert((r.status === 404 || r.status === 405) && snapshot() === before && knownFloorSettings().confirmation,
            `POST /api/local/admin/known-floor is gone: nothing runs, the dial stays on (${show(r)})`);
    }
    const cfgRead = await call('GET', null, '/api/node/config', undefined, owner);
    assert(cfgRead.status === 200 && cfgRead.body?.acceptKnocks === false && cfgRead.body?.door === 'admins' && cfgRead.body?.dmRequests === false,
        `GET /api/node/config still answers acceptKnocks, door and dmRequests (${show(cfgRead)})`);

    // ── 9. The password, with 2FA, is an owner's ─────────────────────────────────────────────────
    console.log('\n── 9. the password ──');
    const twoFa = turnOn2faForTests(process.env.ADMIN_PASSWORD!);
    mark = logMark(); aMark = alerts.length;
    const pw = await post({ changes: { join: 'members' } }, twoFa.headers());
    lines = linesSince(mark);
    assert(pw.status === 200 && getDoor() === 'members' && lines.length === 1 && lines[0].actor_pubkey === 'owner:password'
        && alerts.slice(aMark).some((a) => a.actor === 'owner:password' && a.actorRole === 'admin password'),
        `the password with a current code changes it, logged and alerted as the password (${show(pw)})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
