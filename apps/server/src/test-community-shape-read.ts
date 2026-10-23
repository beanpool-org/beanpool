/**
 * How this community works, slice S1 (config/community-shape.ts; scratch/fable-design/DESIGN-community-shape-settings-fable.md
 * §7 S1): one read of the community's structural settings, and the log their changes will be written to. No behaviour
 * change: nothing here writes a setting.
 *
 *   1. For every stored combination (profile × the operator's overrides × the door and known-floor rows × private preview
 *      × held back from the directory × the read-auth escape hatches × ledger moved), each setting's value is what the
 *      node's own gates do (getNodeFeatures, assertFeatureOn, assertBeansOn, mayInviteHere, the known floor's readers,
 *      pushDirectoryNow's hold-backs, the door setting's refusal); its configured value and source are the stored rows; a
 *      lock is there exactly where the gate refuses the change it names (probed by making the change and rolling it back);
 *      and the read writes nothing.
 *   2. Every profile switch has a place in the shape, and every lock code appears, each with a sentence.
 *   3. The log: community_settings_log and the known floor's community lines, newest first, at most 50; `version` is the
 *      newest community_settings_log id.
 *   4. Over HTTPS, through the real middleware: an owner, an admin, a read token and an admin token read it; a moderator,
 *      a backups token, a member and nobody can't; the answer is readShape's and is never cached; and in five states the
 *      real routes (a member's invite, a stranger's request to join, a visitor's Market) do what the shape says.
 *   5. The answers the design names are unchanged: GET /api/node/config, /api/community/info, /api/community/me, /api/home
 *      and /api/local/admin/known-floor answer the same before and after the shape is read, and the members' features
 *      carry nothing new (`knownFloor` waits on Marty's answer to the design's Q7).
 *   6. A standby answers from its copy of the main server's settings, never its own rows, and says it is a standby; with
 *      no copy yet it says so and reads its own, which is what a promotion would run with.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-community-shape-read.ts
 */
import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Shape, ShapeLock, ShapeSetting } from './config/community-shape.js';

// The flags the server reads at import, set before anything is imported (every import below is dynamic).
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
delete process.env.PRIVATE_PREVIEW;
delete process.env.DIRECTORY_UNLISTED;
process.env.ADMIN_PASSWORD = 'CommunityShape123!';
// A directory push that got past every hold-back would go here: a closed port on this machine, never the registry.
process.env.DIRECTORY_REGISTRY_URL = 'http://127.0.0.1:9/directory-register';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any; headers: Headers };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`;
const DAY = 86_400_000;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

/** Collects every state a property disagrees in, and asserts once for the whole matrix. */
class Tally {
    private readonly seen = new Map<string, { checked: number; wrong: number; examples: string[] }>();
    check(property: string, ok: boolean, detail: () => string): void {
        const t = this.seen.get(property) ?? { checked: 0, wrong: 0, examples: [] };
        this.seen.set(property, t);
        t.checked++;
        if (ok) return;
        t.wrong++;
        if (t.examples.length < 3) t.examples.push(detail());
    }
    report(): void {
        for (const [property, t] of this.seen) {
            assert(t.wrong === 0, `${property}: right in ${t.checked - t.wrong} of ${t.checked} states${t.wrong ? `; wrong in ${t.wrong}, e.g. ${t.examples.join(' | ')}` : ''}`);
        }
    }
}

async function main(): Promise<void> {
    console.log('How this community works: the read model (S1)\n');
    const { initTls } = await import('./services/tls.js');
    const se = await import('./state-engine.js');
    const { startHttpsServer, resetAdminRateLimit } = await import('./https-server.js');
    const { ownerSessionHeaders, ownerTokenHeaders } = await import('./admin-auth-test-harness.js');
    const { mintHandshakeToken, consumeHandshakeToken } = await import('./admin-key-auth.js');
    const { grantNodeRole } = await import('./engine/node-roles.js');
    const { resetGatewayRateLimit } = await import('./gateway-rate-limit.js');
    const { initAdminPassword, updateLocalConfig } = await import('./config/local-config.js');
    const { resetAdminAuthTarpit } = await import('./admin-auth.js');
    const { pruneAuthAttempts } = await import('./auth-rate-limit.js');
    const { db } = await import('./db/db.js');
    const { setMemberPhoto, confirmationDialOn, knownFloor, savedCreditCap } = await import('@beanpool/engine');
    const { CREDIT_CAP_MAX } = await import('@beanpool/core');
    const np = await import('./config/node-profile.js');
    const { getDoor, mayInviteHere, doorSettingRefusal } = await import('./config/door.js');
    const { knownFloorSettings, setKnownFloorSettings, KnownFloorError } = await import('./config/known-floor.js');
    const { pushDirectoryNow } = await import('./services/directory-publisher.js');
    const { isPrivatePreview } = await import('./config/private-preview.js');
    const { ENABLE_PEER_CONNECTORS } = await import('./connector-manager.js');
    const { setNodeRole } = await import('./config/node-role.js');
    const { keepMainServerCommunitySettings, KEPT_COMMUNITY_SETTINGS_KEY } = await import('./config/community-settings.js');
    const shape = await import('./config/community-shape.js');
    const { readShape, SHAPE_LOCK_CODES, SHAPE_SWITCH_PLACES } = shape;

    initAdminPassword();
    await initTls();
    se.initStateEngine();
    const BASE = `https://localhost:${await startHttpsServer(0)}`;

    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
    function makeMember(name: string): Id {
        const id = keypair(name);
        db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                    VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
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

    const founder = keypair('Founder');
    se.seedGenesisMember(founder.pk, founder.name);
    const ada = makeMember('Ada');
    grantNodeRole(ada.pk, 'admin', 'SYSTEM');
    const sam = makeMember('Sam');
    const mo = makeMember('Mo');
    grantNodeRole(mo.pk, 'moderator', 'SYSTEM');
    const stranger = keypair('Stranger');

    // ── State setting, all through the stores the node reads ───────────────────────────────────
    const OVERRIDE_PREFIX = 'nodeProfile.';
    const setOverrideRow = (name: string, on: boolean) =>
        db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OVERRIDE_PREFIX + name, String(on));
    const setRow = (key: string, value: string | null) => {
        if (value === null) db.prepare('DELETE FROM node_config WHERE key = ?').run(key);
        else db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    };
    const rowOf = (key: string) => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
    const storedNodeConfig = () => { try { return JSON.parse(rowOf('node_config') ?? '{}'); } catch { return {}; } };
    const snapshot = () => JSON.stringify({
        nodeConfig: db.prepare('SELECT key, value FROM node_config ORDER BY key').all(),
        shapeLog: db.prepare('SELECT COUNT(*) AS n FROM community_settings_log').get(),
        floorLog: db.prepare('SELECT COUNT(*) AS n FROM known_floor_log').get(),
    });

    type HeldBack = 'named' | 'unnamed' | 'unlisted' | 'probation' | 'never';
    type Hatch = '' | 'ENFORCE_READ_AUTH' | 'ENFORCE_WS_AUTH';
    interface State {
        profile: 'local' | 'global';
        overrides: Record<string, boolean>;
        /** The door row, and the known-floor rows that go with it in this state. */
        rows: 'none' | 'admins' | 'bad';
        preview: boolean;
        heldBack: HeldBack;
        hatch: Hatch;
        ledger: boolean;
    }
    const ROWS = {
        none: { door: null, confirmation: null, known_floor: null, credit_cap: null },
        admins: { door: 'admins', confirmation: 'off', known_floor: null, credit_cap: null },
        // A row the node can't read as a door reads as any member; a floor and a cap of the owner's own.
        bad: { door: 'everyone', confirmation: null, known_floor: '1500', credit_cap: '3000' },
    } as const;
    const OVERRIDE_SETS: Record<string, boolean>[] = [
        {},
        { invites: false },
        { knocks: false },
        { invites: true, knocks: true },
        { beans: false },
        { beans: true },
        { openJoin: true },
        { openJoin: true, invites: false },
        { decisions: false, probation: true, autoHideReports: true, autoMute: true },
        { publishToDirectory: false },
        { publishToDirectory: true, guestListingsOnly: true },
        { guestListingsOnly: false, ssoRequiredForJoin: true },
        { openMembership: true, membersOnDemand: false, retention: true },
        { escrow: false, crowdfund: false, announceJoins: false },
    ];
    // local-config.json and the node_config object are written only when this state's differ from the last one's.
    let lastName: string | null = null, lastDirectory = '';
    function setState(st: State): void {
        process.env.NODE_PROFILE = st.profile === 'global' ? 'global' : '';
        db.prepare('DELETE FROM node_config WHERE substr(key, 1, ?) = ?').run(OVERRIDE_PREFIX.length, OVERRIDE_PREFIX);
        for (const [k, v] of Object.entries(st.overrides)) setOverrideRow(k, v);
        for (const [k, v] of Object.entries(ROWS[st.rows])) setRow(k, v);
        process.env.PRIVATE_PREVIEW = st.preview ? '1' : '';
        process.env.DIRECTORY_UNLISTED = st.heldBack === 'unlisted' ? '1' : '';
        const name = st.heldBack === 'unnamed' ? '' : 'Riverside Commons';
        if (name !== lastName) { updateLocalConfig({ communityName: name }); lastName = name; }
        const directory = {
            directoryPushIntervalHours: st.heldBack === 'never' ? 0 : 12,
            publicAddress: st.heldBack === 'probation'
                ? { name: 'riverside', mode: 'tunnel' as const, hostname: 'riverside.beanpool.org', status: 'live', probation: true }
                : null,
        };
        if (JSON.stringify(directory) !== lastDirectory) { se.updateNodeConfig(directory); lastDirectory = JSON.stringify(directory); }
        delete process.env.ENFORCE_READ_AUTH;
        delete process.env.ENFORCE_WS_AUTH;
        if (st.hatch) process.env[st.hatch] = 'false';
    }
    function clearState(): void {
        setState({ profile: 'local', overrides: {}, rows: 'none', preview: false, heldBack: 'named', hatch: '', ledger: false });
    }

    // A change made and rolled back: what the gate does with it, and nothing kept.
    const ROLLBACK = new Error('rollback');
    function probe<T>(change: () => void, read: () => T): T {
        let out: T | undefined;
        try {
            db.transaction(() => { change(); out = read(); throw ROLLBACK; })();
        } catch (e) {
            if (e !== ROLLBACK) throw e;
        }
        return out as T;
    }
    const featureOn = (name: Parameters<typeof np.assertFeatureOn>[0]) => { try { np.assertFeatureOn(name); return true; } catch { return false; } };
    const beansOn = () => { try { np.assertBeansOn(); return true; } catch { return false; } };

    // ── 1. The matrix ───────────────────────────────────────────────────────────────────────────
    console.log('── 1. every stored combination: the shape says what the gates do ──');
    const tally = new Tally();
    const locksSeen = new Map<string, ShapeLock>();
    const lockOf = (setting: ShapeSetting<unknown> | undefined) => setting?.lock?.code ?? null;
    const noteLocks = (sh: Shape) => {
        const all: ShapeSetting<unknown>[] = [...Object.values(sh.settings).filter(Boolean) as ShapeSetting<unknown>[], ...sh.kindOnly];
        for (const s of all) if (s.lock) locksSeen.set(s.lock.code, s.lock);
    };
    let states = 0;

    async function checkState(st: State): Promise<void> {
        setState(st);
        states++;
        const label = () => JSON.stringify(st);
        const before = snapshot();
        const sh = readShape();
        tally.check('the read writes nothing', snapshot() === before, label);
        noteLocks(sh);
        const S = sh.settings;
        const features = np.getNodeFeatures();
        const cfg = np.getConfiguredSwitches() as unknown as Record<string, boolean>;
        const eff = np.getProfileSwitches() as unknown as Record<string, boolean>;
        const preview = isPrivatePreview();
        const owned = (name: string) => (name in st.overrides ? 'owner' : 'profile');

        tally.check('kind is the server\'s NODE_PROFILE', sh.kind === st.profile, label);
        tally.check('a main server is no standby', sh.standby === false, label);

        // Who can join: the invite gates.
        const invitesOn = featureOn('invites');
        const memberMay = mayInviteHere(sam.pk), adminMay = mayInviteHere(ada.pk);
        const join = features.openJoin && !invitesOn ? 'open' : !invitesOn ? 'paused' : !memberMay && adminMay ? 'admins' : 'members';
        tally.check('join.value is what the invite gates and the open door do', S.join.value === join, () => `${label()} shape=${S.join.value} gates=${join}`);
        const doorRow = ROWS[st.rows].door;
        const configuredJoin = cfg.openJoin && !cfg.invites ? 'open' : !cfg.invites ? 'paused' : doorRow === 'admins' ? 'admins' : 'members';
        tally.check('join.configured is the stored door and invites', S.join.configured === configuredJoin, () => `${label()} shape=${S.join.configured} stored=${configuredJoin}`);
        const joinSource = configuredJoin === 'open' ? ('openJoin' in st.overrides || 'invites' in st.overrides ? 'owner' : 'profile')
            : configuredJoin === 'paused' ? owned('invites') : doorRow === 'admins' ? 'owner' : 'default';
        tally.check('join.source', S.join.source === joinSource, () => `${label()} shape=${S.join.source} want=${joinSource}`);
        const doorRefusal = doorSettingRefusal('admins')?.code ?? null;
        const joinLock = preview ? 'private_preview' : doorRefusal === 'door_set_by_profile' ? 'profile'
            : configuredJoin === 'open' && !features.openJoin ? 'ledger_moved' : null;
        tally.check('join.lock is where the door, the preview or the ledger refuses a change', lockOf(S.join) === joinLock, () => `${label()} shape=${lockOf(S.join)} want=${joinLock}`);
        tally.check('the door the shape reads is getDoor\'s', (S.join.value === 'open') === (getDoor() === 'open'), label);

        // The open door, and the 12-words door beside it.
        tally.check('openDoor.value is features.openJoin', S.openDoor.value === features.openJoin, label);
        tally.check('openDoor.configured', S.openDoor.configured === cfg.openJoin && S.openDoor.source === owned('openJoin'), label);
        const doorWouldOpen = probe(() => setOverrideRow('openJoin', true), () => np.getNodeFeatures().openJoin);
        const openDoorLock = doorWouldOpen ? null : preview ? 'private_preview' : 'ledger_moved';
        tally.check('openDoor.lock is where opening the door would not take', lockOf(S.openDoor) === openDoorLock, () => `${label()} shape=${lockOf(S.openDoor)} want=${openDoorLock}`);
        if (cfg.openJoin) {
            const words = S.wordsDoor;
            tally.check('wordsDoor is there wherever the open door is set on', !!words, label);
            tally.check('wordsDoor.value is features.wordsDoor', words?.value === features.wordsDoor, label);
            tally.check('wordsDoor.configured', words?.configured === !cfg.ssoRequiredForJoin && words?.source === owned('ssoRequiredForJoin'), label);
            const wordsLock = !cfg.ssoRequiredForJoin && !features.wordsDoor ? openDoorLock : null;
            tally.check('wordsDoor.lock is the open door\'s', lockOf(words) === wordsLock, () => `${label()} shape=${lockOf(words)} want=${wordsLock}`);
        } else {
            tally.check('no wordsDoor where the open door is set off', S.wordsDoor === undefined, label);
        }

        // Requests to join.
        tally.check('knocks.value is the knock gate', S.knocks.value === features.knocks && S.knocks.value === featureOn('knocks'), label);
        tally.check('knocks.configured', S.knocks.configured === cfg.knocks && S.knocks.source === owned('knocks'), label);
        const knocksWouldTake = probe(() => setOverrideRow('knocks', true), () => np.getNodeFeatures().knocks);
        const knocksLock = knocksWouldTake ? null : preview ? 'private_preview' : 'invites_off';
        tally.check('knocks.lock is where turning requests on would not take', lockOf(S.knocks) === knocksLock, () => `${label()} shape=${lockOf(S.knocks)} want=${knocksLock}`);

        // The private preview: the server's own.
        tally.check('preview.value is the preview gate', S.preview.value === preview && S.preview.value === (features.privatePreview === true), label);
        tally.check('preview is set on the server', S.preview.source === 'server' && lockOf(S.preview) === 'server_env', label);

        // Beans, and what holds Beans.
        tally.check('beans.value is the Beans gate', S.beans.value === features.beans && S.beans.value === beansOn(), label);
        tally.check('beans.configured', S.beans.configured === cfg.beans && S.beans.source === owned('beans'), label);
        const beansWouldStayOn = probe(() => setOverrideRow('beans', false), () => np.getNodeFeatures().beans);
        tally.check('beans.lock is where switching Beans off would not take', lockOf(S.beans) === (beansWouldStayOn ? 'ledger_moved' : null),
            () => `${label()} shape=${lockOf(S.beans)} stillOn=${beansWouldStayOn}`);
        tally.check('beans.includes are the escrow, enterprise, treasury and crowdfund gates', isDeepStrictEqual(S.beans.includes,
            { escrow: featureOn('escrow'), enterprises: featureOn('enterprises'), treasuries: featureOn('treasuries'), crowdfund: featureOn('crowdfund') }), label);

        // The known floor: its readers, the settings route's answer, and its own refusal.
        const kf = knownFloorSettings();
        tally.check('knownFloor.value is the known floor\'s readers', isDeepStrictEqual(S.knownFloor.value,
            { on: confirmationDialOn(db), floor: knownFloor(db), cap: savedCreditCap(db), capMax: CREDIT_CAP_MAX }), () => `${label()} ${JSON.stringify(S.knownFloor.value)}`);
        tally.check('knownFloor.value is what GET /api/local/admin/known-floor answers', S.knownFloor.value.on === kf.confirmation
            && S.knownFloor.value.floor === kf.knownFloor && S.knownFloor.value.cap === kf.creditCap && S.knownFloor.value.capMax === kf.creditCapMax, label);
        const r = ROWS[st.rows];
        tally.check('knownFloor.configured is the stored rows', S.knownFloor.configured.on === (r.confirmation !== 'off')
            && S.knownFloor.configured.floor === kf.knownFloor && S.knownFloor.configured.cap === kf.creditCap
            && S.knownFloor.source === (r.confirmation || r.known_floor || r.credit_cap ? 'owner' : 'default'), label);
        let floorRefused: string | null = null;
        try {
            probe(() => setKnownFloorSettings('probe', { confirmation: true }), () => null);
        } catch (e) {
            if (!(e instanceof KnownFloorError)) throw e;
            floorRefused = e.code;
        }
        tally.check('knownFloor.lock is where the dial refuses to turn on', lockOf(S.knownFloor) === (floorRefused === 'no_beans' ? 'beans_off' : null),
            () => `${label()} shape=${lockOf(S.knownFloor)} refused=${floorRefused}`);

        // Message requests (#2392): a switch this build may not have yet.
        if ('dmRequests' in cfg) {
            tally.check('dmRequests.value', S.dmRequests?.value === eff.dmRequests && S.dmRequests?.configured === cfg.dmRequests, label);
        } else {
            tally.check('no dmRequests where the build has no such switch', S.dmRequests === undefined, label);
        }

        // Decisions and the three safety switches.
        tally.check('decisions.value is the Decisions gate', S.decisions.value === features.decisions && S.decisions.value === featureOn('decisions'), label);
        tally.check('decisions.configured', S.decisions.configured === cfg.decisions && S.decisions.source === owned('decisions') && S.decisions.lock === null, label);
        for (const [key, sw] of [['probation', 'probation'], ['autoHide', 'autoHideReports'], ['autoMute', 'autoMute']] as const) {
            const s = S[key];
            tally.check(`${key}.value is features.${sw}`, s.value === features[sw] && s.configured === cfg[sw] && s.source === owned(sw) && s.lock === null, label);
        }

        // Listed: what a push does (it stops at a hold-back before it reaches the network; here the P2P node is never up, so
        // a push that would go stops there instead), and the schedule's Never, which only the timer reads.
        if (st.hatch === '' && st.rows === 'none') {
            const pushed = await pushDirectoryNow() as { success: boolean; error?: string; heldBack?: string };
            const interval = se.getNodeConfig().directoryPushIntervalHours;
            const wouldGo = pushed.error === 'P2P node not ready';
            tally.check('listed.value is whether a push goes, on the schedule', S.listed.value === (wouldGo && interval !== 0), () => `${label()} shape=${S.listed.value} push=${JSON.stringify(pushed)} interval=${interval}`);
            const listedLock = pushed.heldBack === 'unlisted' ? 'server_env'
                : eff.publishToDirectory && interval === 0 ? 'schedule_never'
                : pushed.heldBack ? 'held_back' : null;
            tally.check('listed.lock is the push\'s hold-back, or the schedule', lockOf(S.listed) === listedLock, () => `${label()} shape=${lockOf(S.listed)} want=${listedLock}`);
        }
        tally.check('listed.configured is publishToDirectory', S.listed.configured === cfg.publishToDirectory && S.listed.source === owned('publishToDirectory'), label);

        // What the directory is sent.
        const n = se.getNodeConfig();
        const stored = storedNodeConfig();
        for (const [key, field] of [['shareLocation', 'publishLocation'], ['shareMemberCount', 'publishMembers'], ['shareEmail', 'publishContactEmail'],
            ['sharePhone', 'publishContactPhone'], ['shareHealth', 'publishHealth']] as const) {
            const s = S[key];
            tally.check(`${key} is getNodeConfig().${field}`, s.value === n[field] && s.configured === n[field] && s.lock === null
                && s.source === (field in stored ? 'owner' : 'default'), label);
        }

        // Visitors.
        const hatches = np.guestViewAuthFlagsOff();
        const visitors = preview ? 'nothing' : hatches.length ? 'open' : eff.guestListingsOnly ? 'listings' : 'nothing';
        tally.check('visitors.value', S.visitors.value === visitors, () => `${label()} shape=${S.visitors.value} want=${visitors}`);
        tally.check('visitors.configured', S.visitors.configured === (cfg.guestListingsOnly ? 'listings' : 'nothing') && S.visitors.source === owned('guestListingsOnly'), label);
        const visitorsLock = preview ? 'private_preview' : hatches.length ? 'auth_hatch_open' : null;
        tally.check('visitors.lock', lockOf(S.visitors) === visitorsLock, () => `${label()} shape=${lockOf(S.visitors)} want=${visitorsLock}`);
        if (visitorsLock === 'auth_hatch_open') tally.check('the open hatch is named', hatches.every((f) => S.visitors.lock!.why.includes(`${f}=false`)), label);

        // Connections to other communities.
        tally.check('connections is ENABLE_PEER_CONNECTORS', S.connections.value === ENABLE_PEER_CONNECTORS && S.connections.source === 'server' && lockOf(S.connections) === 'server_env', label);

        // What the server's kind sets, listed where it differs from a local community's.
        const local = np.profileDefaults('local') as unknown as Record<string, boolean>;
        for (const id of shape.KIND_ONLY_SWITCHES) {
            const entry = sh.kindOnly.find((k) => k.id === id);
            const differs = eff[id] !== local[id];
            tally.check(`kindOnly lists ${id} exactly where it differs from a local community`, !!entry === differs, label);
            if (entry) tally.check(`kindOnly ${id} is the switch`, entry.value === eff[id] && entry.configured === cfg[id] && entry.source === owned(id), label);
        }
        const onDemand = sh.kindOnly.find((k) => k.id === 'membersOnDemand');
        if (onDemand) {
            const stays = probe(() => setOverrideRow('membersOnDemand', false), () => np.getNodeFeatures().membersOnDemand === true);
            tally.check('membersOnDemand.lock is where switching it off would not take', lockOf(onDemand) === (stays ? 'open_membership' : null), label);
        }
        tally.check('features say membersOnDemand where the shape does', (features.membersOnDemand === true) === eff.membersOnDemand, label);
    }

    async function matrix(ledger: boolean): Promise<void> {
        for (const profile of ['local', 'global'] as const) for (const overrides of OVERRIDE_SETS) for (const rows of ['none', 'admins', 'bad'] as const)
            for (const preview of [false, true]) for (const heldBack of ['named', 'unnamed', 'unlisted', 'probation', 'never'] as const)
                for (const hatch of ['', 'ENFORCE_READ_AUTH', 'ENFORCE_WS_AUTH'] as const) {
                    await checkState({ profile, overrides, rows, preview, heldBack, hatch, ledger });
                }
    }
    await matrix(false);
    // The ledger moves, once and for good, as a member's first trade moves it.
    clearState();
    se.transfer('genesis', sam.pk, 5, 'the ledger moves', 'direct', true);
    np.forgetLedgerHistory();
    assert(np.ledgerHistory() !== null, 'the ledger has moved');
    await matrix(true);
    tally.report();
    assert(states === 2 * 2 * OVERRIDE_SETS.length * 3 * 2 * 5 * 3, `the matrix ran ${states} states`);
    clearState();

    // ── 2. Every switch placed, every lock spoken ──────────────────────────────────────────────
    console.log('\n── 2. every profile switch has a place; every lock has words ──');
    for (const profile of ['local', 'global'] as const) {
        const names = Object.keys(np.profileDefaults(profile));
        const unplaced = names.filter((n) => !(n in SHAPE_SWITCH_PLACES));
        assert(unplaced.length === 0, `every ${profile} profile switch has a place in the shape (unplaced: ${unplaced.join(', ') || 'none'})`);
    }
    const sample = readShape();
    const placesExist = Object.entries(SHAPE_SWITCH_PLACES).filter(([sw, place]) =>
        !(place === 'kindOnly' ? (shape.KIND_ONLY_SWITCHES as readonly string[]).includes(sw) : place === 'dmRequests' || place === 'wordsDoor' || place in sample.settings));
    assert(placesExist.length === 0, `every place named is a setting the shape has (wrong: ${placesExist.map(([s, p]) => `${s}→${p}`).join(', ') || 'none'})`);
    const withoutStandby = SHAPE_LOCK_CODES.filter((c) => c !== 'standby');
    const unseen = withoutStandby.filter((c) => !locksSeen.has(c));
    assert(unseen.length === 0, `every lock code but the standby's appears in the matrix (unseen: ${unseen.join(', ') || 'none'})`);
    const wordless = [...locksSeen.values()].filter((l) => typeof l.why !== 'string' || l.why.trim().length < 20 || (l.unlock !== undefined && l.unlock.trim() === ''));
    assert(wordless.length === 0, `every lock says why in a sentence, and an unlock says what (${wordless.map((l) => l.code).join(', ') || 'all do'})`);

    // ── 3. The log ─────────────────────────────────────────────────────────────────────────────
    console.log('\n── 3. the log ──');
    assert(readShape().log.length === 0 && readShape().version === 0, 'with nothing changed, the log is empty and the version 0');
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const insertShapeLine = db.prepare(`INSERT INTO community_settings_log (actor_pubkey, actor_role, setting, old_value, new_value, note, at)
                                        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < 55; i++) insertShapeLine.run(founder.pk, 'owner', 'join', 'members', 'admins', null, at(200 - i));
    insertShapeLine.run(founder.pk, 'owner', 'join', 'admins', 'members', 'Summer visitors', at(3));
    const insertFloorLine = db.prepare('INSERT INTO known_floor_log (id, actor_pubkey, action, member_pubkey, old_value, new_value, at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertFloorLine.run(crypto.randomBytes(16).toString('hex'), founder.pk, 'known_floor', null, '1000', '1500', at(2));
    // Neither of these is the community's shape: one member's exception, and the health panel's line.
    insertFloorLine.run(crypto.randomBytes(16).toString('hex'), ada.pk, 'exception_raised', sam.pk, 'default', '1200', at(1));
    insertFloorLine.run(crypto.randomBytes(16).toString('hex'), founder.pk, 'health_debt_line', null, '50', '60', at(1));
    const logged = readShape();
    const newestId = (db.prepare('SELECT MAX(id) AS id FROM community_settings_log').get() as { id: number }).id;
    assert(logged.version === newestId && newestId === 56, `version is the newest community_settings_log id (${logged.version})`);
    assert(logged.log.length === 50, `the log keeps the newest 50 lines (${logged.log.length})`);
    const [first, second] = logged.log;
    assert(first?.kept === 'known_floor_log' && first.setting === 'knownFloor.floor' && first.from === '1000' && first.to === '1500' && first.actor === founder.pk,
        `newest first: the known floor's community line, as a known-floor change (${JSON.stringify(first)})`);
    assert(second?.kept === 'community_settings_log' && second.setting === 'join' && second.from === 'admins' && second.to === 'members'
        && second.note === 'Summer visitors' && second.actorRole === 'owner' && second.actorCallsign === founder.name,
        `then the community_settings_log line, with its note, role and the actor's callsign (${JSON.stringify(second)})`);
    assert(!logged.log.some((l) => l.setting.startsWith('exception') || l.setting.startsWith('health')), 'no member\'s exception and no health line is in it');
    assert(logged.log.every((l, i) => i === 0 || l.at <= logged.log[i - 1].at), 'every line is no newer than the one above it');

    // ── 4. Over HTTPS ──────────────────────────────────────────────────────────────────────────
    console.log('\n── 4. who reads it, over HTTPS ──');
    clearState();
    const PATH = '/api/local/admin/community-shape';
    const owner = ownerSessionHeaders();
    const ownerRead = await call('GET', null, PATH, undefined, owner);
    assert(ownerRead.status === 200 && isDeepStrictEqual(ownerRead.body, JSON.parse(JSON.stringify(readShape()))), `an owner reads readShape's answer (${ownerRead.status})`);
    assert((ownerRead.headers.get('cache-control') ?? '').includes('no-store'), `and it is never cached (${ownerRead.headers.get('cache-control')})`);
    const adminRead = await call('GET', null, PATH, undefined, sessionHeaders(ada.pk, 'admin'));
    assert(adminRead.status === 200 && adminRead.body?.settings?.join?.value === 'members', `an admin reads it (${adminRead.status})`);
    const readToken = await call('GET', null, PATH, undefined, ownerTokenHeaders('read'));
    assert(readToken.status === 200 && !!readToken.body?.settings, `a read token reads it (${readToken.status})`);
    const adminToken = await call('GET', null, PATH, undefined, ownerTokenHeaders('admin'));
    assert(adminToken.status === 200, `an admin token reads it (${adminToken.status})`);
    const backupsToken = await call('GET', null, PATH, undefined, ownerTokenHeaders('backups'));
    assert(backupsToken.status === 403, `a backups token can't (${show(backupsToken)})`);
    const modRead = await call('GET', null, PATH, undefined, sessionHeaders(mo.pk, 'moderator'));
    assert(modRead.status === 403 && !modRead.body?.settings, `a moderator can't (${show(modRead)})`);
    const memberRead = await call('GET', sam, PATH);
    assert((memberRead.status === 401 || memberRead.status === 403) && !memberRead.body?.settings, `a member who is no admin can't (${show(memberRead)})`);
    const nobody = await call('GET', null, PATH);
    assert(nobody.status === 401 && !nobody.body?.settings, `nor can nobody (${show(nobody)})`);

    console.log('\n── 4b. the real routes agree with it ──');
    const invite = () => call('POST', sam, '/api/invite/generate', { publicKey: sam.pk });
    const knock = () => call('GET', stranger, '/api/join/knock/status');
    const visitorMarket = () => call('GET', null, '/api/marketplace/posts');
    const shapeNow = async () => (await call('GET', null, PATH, undefined, owner)).body as Shape;

    // A. A local community as it starts.
    let sh = await shapeNow();
    let inv = await invite(), kn = await knock(), mk = await visitorMarket();
    assert(sh.settings.join.value === 'members' && inv.status === 200, `A. "any member invites": a member's invite is made (${show(inv)})`);
    assert(sh.settings.knocks.value === true && kn.status !== 404, `A. requests to join on: the request route answers (${show(kn)})`);
    assert(sh.settings.visitors.value === 'nothing' && (mk.status === 401 || mk.status === 403), `A. visitors see nothing: a visitor's Market is refused (${show(mk)})`);

    // B. Only admins invite.
    setRow('door', 'admins');
    sh = await shapeNow();
    inv = await invite();
    assert(sh.settings.join.value === 'admins' && sh.settings.join.source === 'owner' && inv.status === 403 && inv.body?.code === 'admins_only',
        `B. "only admins invite": a member's invite is refused admins_only (${show(inv)})`);
    setRow('door', null);

    // C. Paused: invites off.
    setOverrideRow('invites', false);
    sh = await shapeNow();
    inv = await invite();
    kn = await knock();
    assert(sh.settings.join.value === 'paused' && inv.status === 404 && inv.body?.code === 'feature_off', `C. paused: a member's invite is 404 feature_off (${show(inv)})`);
    assert(sh.settings.knocks.value === false && sh.settings.knocks.lock?.code === 'invites_off' && kn.status === 404,
        `C. and requests to join are off with it, locked invites_off: the request route is 404 (${show(kn)})`);
    clearState();

    // D. A private preview.
    process.env.PRIVATE_PREVIEW = '1';
    sh = await shapeNow();
    inv = await invite();
    kn = await knock();
    mk = await visitorMarket();
    assert(sh.settings.join.value === 'admins' && sh.settings.join.lock?.code === 'private_preview' && inv.status === 403,
        `D. preview: only admins invite, locked private_preview; a member's invite is refused (${show(inv)})`);
    assert(sh.settings.knocks.value === false && sh.settings.knocks.lock?.code === 'private_preview' && kn.status === 403 && kn.body?.code === 'private_preview',
        `D. nobody can ask to join: the request route answers the preview (${show(kn)})`);
    assert(sh.settings.visitors.value === 'nothing' && sh.settings.visitors.lock?.code === 'private_preview' && mk.status === 403 && mk.body?.code === 'private_preview',
        `D. visitors see nothing: a visitor's Market answers the preview (${show(mk)})`);
    clearState();

    // E. The global community's kind.
    process.env.NODE_PROFILE = 'global';
    sh = await shapeNow();
    inv = await invite();
    mk = await visitorMarket();
    const info = await call('GET', null, '/api/community/info');
    assert(sh.kind === 'global' && sh.settings.join.value === 'paused' && inv.status === 404,
        `E. global, after the ledger moved: the open door stays shut and invites are off, so nobody joins; an invite is 404 (${sh.settings.join.value}; ${show(inv)})`);
    assert(sh.settings.join.lock?.code === 'ledger_moved' && sh.settings.openDoor.value === false && info.body?.features?.openJoin === false,
        `E. the shape says why (ledger_moved) and the apps are told the door is shut (${JSON.stringify(sh.settings.join.lock)})`);
    assert(sh.settings.visitors.value === 'listings' && mk.status === 200 && !!mk.headers.get('x-beanpool-view'),
        `E. visitors see the listings: a visitor's Market answers, marked as a visitor's view (${mk.status} ${mk.headers.get('x-beanpool-view')})`);
    clearState();

    // ── 5. The answers the design names are unchanged ─────────────────────────────────────────
    console.log('\n── 5. the existing answers are unchanged ──');
    const answers = async () => ({
        nodeConfig: (await call('GET', null, '/api/node/config', undefined, owner)).body,
        info: (await call('GET', null, '/api/community/info')).body,
        me: (await call('GET', sam, '/api/community/me')).body,
        homeFeatures: (await call('GET', sam, '/api/home')).body?.features,
        knownFloor: (await call('GET', null, '/api/local/admin/known-floor', undefined, owner)).body,
    });
    const SETUPS: [string, () => void][] = [
        ['a local community', () => clearState()],
        ['one with only admins inviting and the dial off', () => { setRow('door', 'admins'); setRow('confirmation', 'off'); }],
        ['the global kind in a preview', () => { clearState(); process.env.NODE_PROFILE = 'global'; process.env.PRIVATE_PREVIEW = '1'; }],
    ];
    for (const [label, setup] of SETUPS) {
        setup();
        const before = await answers();
        for (let i = 0; i < 3; i++) await call('GET', null, PATH, undefined, owner);
        readShape();
        const after = await answers();
        assert(isDeepStrictEqual(before, after), `${label}: node/config, community/info, community/me, home's features and known-floor answer the same after the shape is read`);
        const features = after.me?.features ?? {};
        const want = Object.keys({ ...np.getNodeFeatures(), door: getDoor() }).sort();
        assert(isDeepStrictEqual(Object.keys(features).sort(), want) && !('knownFloor' in features),
            `${label}: a member's features carry exactly the node's, and no knownFloor (${Object.keys(features).length} fields)`);
        assert(isDeepStrictEqual(Object.keys(after.homeFeatures ?? {}).sort(), want), `${label}: and so do Home's`);
        assert(after.nodeConfig?.acceptKnocks === np.getProfileSwitches().knocks && after.nodeConfig?.door === getDoor(),
            `${label}: node/config still answers acceptKnocks and door (${after.nodeConfig?.acceptKnocks}, ${after.nodeConfig?.door})`);
    }
    clearState();

    // ── 6. A standby ───────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a standby answers from its copy ──');
    setRow(KEPT_COMMUNITY_SETTINGS_KEY, null);
    setNodeRole('backup');
    const noCopy = readShape();
    assert(noCopy.standby === true && noCopy.copiedAt === null && noCopy.settings.join.value === 'members' && noCopy.settings.knownFloor.value.on === true,
        `with no copy yet it says so, and reads its own rows: what a promotion would run with (${noCopy.copiedAt}, ${noCopy.settings.join.value})`);
    const copied = keepMainServerCommunitySettings({
        localConfig: { communityName: 'Riverside Commons' },
        nodeConfig: { door: 'admins', confirmation: 'off', known_floor: '1200', credit_cap: '2500' },
        directory: { publishLocation: false, publishMembers: true, publishContactEmail: true, publishContactPhone: false, publishHealth: false, directoryPushIntervalHours: 0 },
    }, '2026-10-23T08:00:00.000Z');
    assert(copied.kept, 'the main server\'s settings are kept, as a copy brings them');
    const own = { door: rowOf('door'), confirmation: rowOf('confirmation'), location: se.getNodeConfig().publishLocation };
    const standbyBefore = snapshot();
    const fromCopy = readShape();
    assert(snapshot() === standbyBefore && rowOf('door') === own.door && rowOf('confirmation') === own.confirmation,
        'the read writes nothing on a standby, its own rows included');
    assert(fromCopy.standby === true && fromCopy.copiedAt === '2026-10-23T08:00:00.000Z', `it says it is a standby, and when its copy is from (${fromCopy.copiedAt})`);
    assert(fromCopy.settings.join.value === 'admins' && fromCopy.settings.join.configured === 'admins' && fromCopy.settings.join.source === 'owner',
        `who can join is the copy's, only admins, though its own row says any member (${fromCopy.settings.join.value}; own door row ${own.door})`);
    assert(isDeepStrictEqual(fromCopy.settings.knownFloor.value, { on: false, floor: 1200, cap: 2500, capMax: CREDIT_CAP_MAX }),
        `the known floor is the copy's: off, 1,200, cap 2,500 (${JSON.stringify(fromCopy.settings.knownFloor.value)}; own dial row ${own.confirmation})`);
    assert(fromCopy.settings.shareLocation.value === false && fromCopy.settings.shareEmail.value === true && fromCopy.settings.shareHealth.value === false,
        `what the directory is sent is the copy's (location ${fromCopy.settings.shareLocation.value}; its own ${own.location})`);
    assert(fromCopy.settings.listed.value === false && fromCopy.settings.listed.lock?.code === 'standby' && fromCopy.settings.listed.lock.why.length > 20,
        `Listed: a standby never publishes, and says so (${JSON.stringify(fromCopy.settings.listed.lock)})`);
    locksSeen.set('standby', fromCopy.settings.listed.lock!);
    assert(SHAPE_LOCK_CODES.every((c) => locksSeen.has(c)), 'with the standby\'s, every lock code has appeared');
    const standbyHttp = await call('GET', null, PATH, undefined, owner);
    assert(standbyHttp.status === 200 && standbyHttp.body?.standby === true && standbyHttp.body?.settings?.join?.value === 'admins',
        `over HTTPS the standby answers the same (${show(standbyHttp)})`);
    setNodeRole('primary');
    const mainAgain = readShape();
    assert(mainAgain.standby === false && mainAgain.copiedAt === undefined && mainAgain.settings.join.value === 'members',
        `back as a main server it reads its own rows again (${mainAgain.settings.join.value})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
    process.exit();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
