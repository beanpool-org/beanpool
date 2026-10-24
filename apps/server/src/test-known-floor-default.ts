/**
 * The known floor on by default (Marty, board, 21 Oct: "Yes, on by default"; config/known-floor.ts, engine known-floor.ts):
 * a mixed community needs no setup, and nothing changes until an admin confirms someone.
 *
 *   0. the global profile (Beans off, before any Bean moves): the dial reads off whatever its row says, the owner can't
 *      switch it on (409 beans_off, under How this community works) and that writes nothing, a confirmed member holds no known grant, and the join screen
 *      asks no consent
 *   1. a fresh node: no row, and the dial reads on in the settings, a member's panel and the join screen's terms; a
 *      confirmed member with one live offer has a limit of the known floor, exactly -1,000; an unconfirmed member's is 0;
 *      a member with 2,100 earned reads -2,000 as with the dial off (no saved cap, nobody confirmed: nobody's limit moves)
 *   2. the owner switches it off: an 'off' row, logged; the confirmed member's grant is 0 and her limit 0; back on: the row
 *      is removed, logged, and her -1,000 is back
 *   3. the copy every standby is sent carries the 'off' row; a standby keeps it with nothing left out, and installing the
 *      kept record (a take-over's step) writes it, and removes it again for a record from a community with the dial on
 *   4. nobody is confirmed without an admin's act: an invite and a tiered genesis invite redeemed confirm nobody; the only
 *      writes of a confirmation in the server's and the engine's code are names-list.ts confirmMember (the admin routes)
 *      and confirmByInvite (an invite an admin bound to a names-list entry)
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-known-floor-default.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;
process.env.ADMIN_PASSWORD = 'KnownDefault123!';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, createPost, getBalance } from './state-engine.js';
import { startHttpsServer, resetAdminRateLimit } from './https-server.js';
import { ownerSessionHeaders } from './admin-auth-test-harness.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { initAdminPassword } from './config/local-config.js';
import { resetAdminAuthTarpit } from './admin-auth.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { getProfileSwitches } from './config/node-profile.js';
import { readCommunitySettings, parseCommunitySettings, keepMainServerCommunitySettings, installCommunitySettings, keptCommunitySettings } from './config/community-settings.js';
import { db } from './db/db.js';
import { setMemberPhoto, confirmationDialOn, memberKnownGrant, CONFIRMATION_DIAL_KEY } from '@beanpool/engine';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}
function require_(cond: boolean, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`precondition failed: ${msg}`);
}

let BASE = '';
const DAY = 86_400_000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
type Id = { pk: string; priv: crypto.KeyObject; name: string };
type Res = { status: number; body: any };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`;

function keypair(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), priv: privateKey, name };
}

function makeMember(name: string): Id {
    const id = keypair(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status)
                VALUES (?, ?, ?, 'genesis', 'TEST', 'active')`).run(id.pk, name, ago(30 * DAY));
    setMemberPhoto(db, id.pk, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

/** A confirmation row as the names list's admin routes write one (engine/names-list.ts confirmMember). */
function confirm(member: Id, by: Id): void {
    db.prepare(`INSERT INTO confirmations (id, member_pubkey, entry_id, confirmed_by, needs_second) VALUES (?, ?, ?, ?, 0)`)
        .run(crypto.randomBytes(16).toString('hex'), member.pk, crypto.randomBytes(16).toString('hex'), by.pk);
}

const dialRow = () => (db.prepare('SELECT value FROM node_config WHERE key = ?').get(CONFIRMATION_DIAL_KEY) as { value: string } | undefined)?.value ?? null;
const confirmationCount = () => (db.prepare('SELECT COUNT(*) AS n FROM confirmations').get() as { n: number }).n;

async function call(method: string, id: Id | null, urlPath: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
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
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${urlPath.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.priv).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${urlPath}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}

/** Every .ts file of the server's and the engine's own code: no suite, harness, fixture or unit test. */
function sourceFiles(): string[] {
    const roots = [SRC, path.resolve(SRC, '../../../packages/beanpool-engine/src')];
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (e.name === '__tests__' || e.name === '__fixtures__' || e.name === 'node_modules') continue;
                walk(p);
            } else if (e.name.endsWith('.ts') && !e.name.startsWith('test-') && !e.name.endsWith('.test.ts') && !e.name.endsWith('-test-harness.ts') && !e.name.endsWith('.d.ts')) {
                out.push(p);
            }
        }
    };
    roots.forEach(walk);
    return out;
}

/** The function each match of `re` sits in, as "file: name". */
function enclosingFunctions(files: string[], re: RegExp): string[] {
    const found: string[] = [];
    for (const f of files) {
        const text = fs.readFileSync(f, 'utf8');
        for (const m of text.matchAll(re)) {
            const before = text.slice(0, m.index);
            const fns = [...before.matchAll(/(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(\w+)/g)];
            const route = [...before.matchAll(/router\.(?:get|post|put|delete)\('([^']+)'/g)];
            const lastFn = fns.at(-1);
            const lastRoute = route.at(-1);
            // A call inside a route handler is named by its route, when the route comes after the last function.
            const name = lastRoute && (!lastFn || (lastRoute.index ?? 0) > (lastFn.index ?? 0)) ? `route ${lastRoute[1]}` : lastFn?.[1] ?? '(top level)';
            found.push(`${path.relative(path.resolve(SRC, '../../..'), f)}: ${name}`);
        }
    }
    return found.sort();
}

async function main(): Promise<void> {
    console.log('The known floor on by default\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const founder = keypair('Founder');
    seedGenesisMember(founder.pk, founder.name);
    const owner = ownerSessionHeaders();
    const ada = makeMember('Ada');
    const read = () => call('GET', null, '/api/local/admin/known-floor', undefined, owner);
    // The dial is changed under How this community works (POST /api/local/admin/community-shape `knownFloor`, slice S2; the
    // known floor's own POST is gone), and read back as the settings.
    const settings = async (body: { confirmation: boolean }) => {
        const r = await call('POST', null, '/api/local/admin/community-shape', { changes: { knownFloor: { on: body.confirmation } } }, owner);
        return r.status === 200 ? { ...r, body: (await read()).body } : r;
    };
    const terms = () => call('GET', null, '/api/community/consent-terms');

    // ── 0. the global profile: Beans off ───────────────────────────────────────────────────────
    console.log('── 0. the global profile ──');
    process.env.NODE_PROFILE = 'global';
    require_(getProfileSwitches().beans === false, 'NODE_PROFILE=global on a node whose ledger has never moved: Beans are off');
    const gia = makeMember('Gia');
    confirm(gia, ada);
    const gRead = await read();
    assert(gRead.status === 200 && gRead.body?.confirmation === false, `the settings read the dial off (${show(gRead)})`);
    assert(confirmationDialOn(db) === false && memberKnownGrant(db, gia.pk) === 0, 'and the engine reads it off: a confirmed member holds no known grant');
    const gOn = await settings({ confirmation: true });
    assert(gOn.status === 409 && gOn.body?.code === 'beans_off', `the owner can't switch it on: the shape's Beans-off lock (${show(gOn)})`);
    assert(dialRow() === null, `and nothing was written (row ${JSON.stringify(dialRow())})`);
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?)').run(CONFIRMATION_DIAL_KEY, 'on');
    assert(confirmationDialOn(db) === false && memberKnownGrant(db, gia.pk) === 0 && (await read()).body?.confirmation === false,
        "an 'on' row (an older version's, a restored copy's) reads off too: Beans off decides");
    const gTerms = await terms();
    assert(gTerms.status === 200 && gTerms.body?.known === false, `the join screen asks no consent (${show(gTerms)})`);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(CONFIRMATION_DIAL_KEY);
    db.prepare('DELETE FROM confirmations WHERE member_pubkey = ?').run(gia.pk);
    delete process.env.NODE_PROFILE;
    require_(getProfileSwitches().beans === true, 'back to the local profile: Beans are on');

    // ── 1. a fresh node ────────────────────────────────────────────────────────────────────────
    console.log('── 1. a fresh node ──');
    const kim = makeMember('Kim');
    const una = makeMember('Una');
    createPost('offer', 'produce', 'Kim mends bikes', 'Bike repairs', 40, 'fixed', kim.pk);
    createPost('offer', 'produce', 'Una bakes', 'Bread', 10, 'fixed', una.pk);
    const gil = makeMember('Gil');
    db.prepare('UPDATE members SET earned_credit = 2100 WHERE public_key = ?').run(gil.pk);
    assert(dialRow() === null, 'a fresh node has no confirmation row');
    const fresh = await read();
    assert(fresh.status === 200 && fresh.body?.confirmation === true && fresh.body?.knownFloor === 1000 && fresh.body?.creditCap === 2000,
        `the settings read: the dial on, known floor 1,000, cap 2,000 (${show(fresh)})`);
    const gilBefore = getBalance(gil.pk).floor;
    const unaBefore = getBalance(una.pk);
    assert(unaBefore.floor === 0 && unaBefore.usableFloor === 0 && gilBefore === -2000,
        `with nobody confirmed, nobody's limit moves: Una 0, Gil (2,100 earned) -2,000 as with the dial off (${unaBefore.floor}, ${gilBefore})`);
    confirm(kim, ada);
    const kimOn = await call('GET', kim, `/api/ledger/balance/${kim.pk}`);
    assert(kimOn.status === 200 && kimOn.body?.floor === -1000 && kimOn.body?.usableFloor === -1000,
        `a confirmed member with one live offer has a limit of the known floor, -1,000 (${show(kimOn)})`);
    const unaOn = await call('GET', una, `/api/ledger/balance/${una.pk}`);
    assert(unaOn.status === 200 && unaOn.body?.floor === 0 && unaOn.body?.usableFloor === 0,
        `an unconfirmed member's is unchanged, 0 (${show(unaOn)})`);
    assert(getBalance(gil.pk).floor === -2000, `and Gil's still -2,000 (${getBalance(gil.pk).floor})`);
    const panel = await call('GET', null, `/api/local/admin/known-floor/member/${kim.pk}`, undefined, owner);
    assert(panel.status === 200 && panel.body?.confirmation === true && panel.body?.confirmed === true && panel.body?.knownGrant === 1000,
        `her panel in the manager: the dial on, confirmed, a known grant of 1,000 (${show(panel)})`);
    const freshTerms = await terms();
    assert(freshTerms.status === 200 && freshTerms.body?.known === true, `the join screen offers the consent: a known community (${show(freshTerms)})`);

    // ── 2. the owner switches it off, and on again ─────────────────────────────────────────────
    console.log('── 2. off, and on again ──');
    const off = await settings({ confirmation: false });
    assert(off.status === 200 && off.body?.confirmation === false, `the owner switches it off (${show(off)})`);
    assert(dialRow() === 'off', `an 'off' row is written (${JSON.stringify(dialRow())})`);
    const kimOff = getBalance(kim.pk);
    assert(memberKnownGrant(db, kim.pk) === 0 && kimOff.floor === 0 && kimOff.usableFloor === 0,
        `the confirmed member's grant is 0, her limit 0 (${JSON.stringify({ grant: memberKnownGrant(db, kim.pk), floor: kimOff.floor, usable: kimOff.usableFloor })})`);
    const panelOff = await call('GET', null, `/api/local/admin/known-floor/member/${kim.pk}`, undefined, owner);
    assert(panelOff.body?.confirmation === false && panelOff.body?.knownGrant === 0, `her panel says off, a grant of 0 (${show(panelOff)})`);
    assert((await terms()).body?.known === false, 'and the join screen asks no consent');
    const logOff = ((await read()).body?.log as Array<{ action: string; oldValue: string; newValue: string }>)?.[0];
    assert(logOff?.action === 'confirmation' && logOff.oldValue === 'on' && logOff.newValue === 'off', `the log: on → off (${JSON.stringify(logOff)})`);
    const again = await settings({ confirmation: false });
    assert(again.status === 200 && ((await read()).body?.log as unknown[]).length === 1, 'switching it off again writes no second line');
    const on = await settings({ confirmation: true });
    assert(on.status === 200 && on.body?.confirmation === true, `the owner switches it back on (${show(on)})`);
    assert(dialRow() === null, `the default removes the row (${JSON.stringify(dialRow())})`);
    assert(memberKnownGrant(db, kim.pk) === 1000 && getBalance(kim.pk).floor === -1000 && getBalance(kim.pk).usableFloor === -1000,
        `her -1,000 is back (${getBalance(kim.pk).floor})`);
    const logOn = ((await read()).body?.log as Array<{ action: string; oldValue: string; newValue: string }>)?.[0];
    assert(logOn?.action === 'confirmation' && logOn.oldValue === 'off' && logOn.newValue === 'on', `the log: off → on (${JSON.stringify(logOn)})`);

    // ── 3. the copy a standby is sent ──────────────────────────────────────────────────────────
    console.log('── 3. the standby\'s copy ──');
    require_((await settings({ confirmation: false })).status === 200 && dialRow() === 'off', 'the owner switches it off again');
    const record = readCommunitySettings();
    assert(record.nodeConfig.confirmation === 'off', `the record every copy carries says 'off' (${JSON.stringify(record.nodeConfig.confirmation)})`);
    const parsed = parseCommunitySettings(JSON.parse(JSON.stringify(record)));
    assert(parsed !== null && parsed.left.length === 0 && parsed.record.nodeConfig.confirmation === 'off',
        `a standby reads it with nothing left out (${JSON.stringify(parsed?.left)})`);
    const kept = keepMainServerCommunitySettings(JSON.parse(JSON.stringify(record)), new Date().toISOString());
    assert(kept.kept === true && kept.left.length === 0 && keptCommunitySettings()?.record.nodeConfig.confirmation === 'off',
        `and keeps it (${JSON.stringify(kept)})`);
    db.prepare('DELETE FROM node_config WHERE key = ?').run(CONFIRMATION_DIAL_KEY);
    const installed = installCommunitySettings();
    assert(installed.installed === true && dialRow() === 'off' && confirmationDialOn(db) === false && memberKnownGrant(db, kim.pk) === 0,
        `installing the kept record (a take-over's step) writes the 'off' row (${JSON.stringify({ installed: installed.installed, row: dialRow() })})`);
    keepMainServerCommunitySettings({ ...JSON.parse(JSON.stringify(record)), nodeConfig: { ...record.nodeConfig, confirmation: null } }, new Date().toISOString());
    installCommunitySettings();
    assert(dialRow() === null && confirmationDialOn(db) === true && getBalance(kim.pk).floor === -1000,
        `a record from a community with the dial on removes it: on, and her -1,000 back (${getBalance(kim.pk).floor})`);

    // ── 4. nobody is confirmed without an admin's act ──────────────────────────────────────────
    console.log('── 4. no confirmation without an admin ──');
    const before = confirmationCount();
    const joy = keypair('Joy');
    const inv = await call('POST', founder, '/api/invite/generate', { publicKey: founder.pk });
    const code = inv.body?.invite?.code ?? inv.body?.code;
    require_(typeof code === 'string', `the founder makes an invite (${show(inv)})`);
    const joyIn = await call('POST', joy, '/api/invite/redeem', { code, publicKey: joy.pk, callsign: 'Joy' });
    require_(joyIn.status === 200, `Joy joins with it (${show(joyIn)})`);
    const lee = keypair('Lee');
    const seed = await call('POST', null, '/api/admin/seed-invite', { type: 'trusted' }, owner);
    require_(typeof seed.body?.code === 'string', `the owner makes a tiered genesis invite (${show(seed)})`);
    const leeIn = await call('POST', lee, '/api/invite/redeem', { code: seed.body.code, publicKey: lee.pk, callsign: 'Lee' });
    require_(leeIn.status === 200, `Lee joins with it (${show(leeIn)})`);
    assert(confirmationCount() === before && memberKnownGrant(db, joy.pk) === 0 && memberKnownGrant(db, lee.pk) === 0,
        `neither join confirmed anyone: still ${before} confirmation(s), no known grant for Joy or Lee`);
    const files = sourceFiles();
    require_(files.some(f => f.endsWith(path.join('engine', 'names-list.ts'))) && files.some(f => f.endsWith(path.join('beanpool-engine', 'src', 'known-floor.ts'))),
        `the scan reads the server's and the engine's code (${files.length} files)`);
    const writes = enclosingFunctions(files, /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+confirmations\b/gi);
    assert(JSON.stringify(writes) === JSON.stringify(['apps/server/src/engine/names-list.ts: confirmByInvite', 'apps/server/src/engine/names-list.ts: confirmMember']),
        `a confirmation is written in two places only: confirmMember and confirmByInvite (${writes.join('; ')})`);
    const confirmCalls = enclosingFunctions(files, /(?<!function )\bconfirmMember\(/g);
    assert(JSON.stringify(confirmCalls) === JSON.stringify([
        'apps/server/src/engine/names-list.ts: confirmToWorkOff',
        'apps/server/src/routes/names-list.ts: route /api/names/confirmations',
    ]), `confirmMember runs for an admin's route only, or Work it off (${confirmCalls.join('; ')})`);
    const workOffCalls = enclosingFunctions(files, /(?<!function )\bconfirmToWorkOff\(/g);
    assert(JSON.stringify(workOffCalls) === JSON.stringify([
        'apps/server/src/routes/names-list.ts: route /api/names/debts/:id/work-off',
    ]), `and Work it off for an admin's route only (${workOffCalls.join('; ')})`);
    const inviteCalls = enclosingFunctions(files, /(?<!function )\bconfirmByInvite\(/g);
    assert(JSON.stringify(inviteCalls) === JSON.stringify([
        'apps/server/src/engine/invites.ts: redeemInvite',
        'apps/server/src/engine/invites.ts: redeemOfflineTicket',
    ]), `confirmByInvite runs only for an invite or ticket bound to an entry (${inviteCalls.join('; ')})`);
    const routes = fs.readFileSync(path.join(SRC, 'routes', 'names-list.ts'), 'utf8');
    assert(/router\.post\('\/api\/names\/confirmations', \(ctx\) => asAdmin\(/.test(routes) && /router\.post\('\/api\/names\/debts\/:id\/work-off', \(ctx\) => asAdmin\(/.test(routes),
        'both routes run as the signing admin (asAdmin)');
    const invites = fs.readFileSync(path.join(SRC, 'engine', 'invites.ts'), 'utf8');
    assert(/const boundEntry = namesEntryId === undefined \? null : assertMayBindInvite\(inviterPubkey, namesEntryId\);/.test(invites),
        "an invite is bound to an entry only by an admin who can open it (assertMayBindInvite), and confirmByInvite checks the maker is one still");

    console.log(`\n${passed}/${run} passed`);
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error(e); process.exit(1); });
