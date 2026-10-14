/**
 * `beanpool recover` (node sign-in design step 4): the shell command that makes a member an owner when every owner's
 * key is gone, in place of deleting data/local-config.json (which also lost the community's name, gateway, thresholds,
 * 2FA, break-glass mode and the replication token).
 *
 * End to end against a node data dir: the command runs as its own process (as `docker compose exec` runs it beside a
 * live node), on the database and config the node uses.
 *   1. An unknown key, a visitor and a pruned member are refused, and nothing changes.
 *   2. A member is made owner, attributed to server:recover; local-config.json is byte for byte the same.
 *   3. The command prints a break-glass code once; the stored hash matches it.
 *   4. A notice is left for the node: delivered once as a critical community announcement and a SECURITY log line,
 *      then gone, so it is never announced twice.
 *   5. Running it again for the same owner makes a new code; the code it printed before no longer works.
 *   6. A member named by @callsign; an unknown callsign is refused.
 *
 * Run: BEANPOOL_DATA_DIR=$(mktemp -d) node --import tsx src/test-beanpool-recover.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { initStateEngine } from './state-engine.js';
import { db } from './db/db.js';
import { updateLocalConfig } from './config/local-config.js';
import { breakGlassCodeMatches } from './break-glass-code.js';
import { deliverRecoverNotices } from './recover-command.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const DATA_DIR = process.env.BEANPOOL_DATA_DIR!;
if (!DATA_DIR) throw new Error('BEANPOOL_DATA_DIR must be set');
const SRC = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(DATA_DIR, 'local-config.json');

function cli(...args: string[]) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(SRC, 'recover-cli.ts'), ...args], {
        env: { ...process.env, BEANPOOL_DATA_DIR: DATA_DIR }, encoding: 'utf8', timeout: 60_000,
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const pk = () => crypto.randomBytes(32).toString('hex');
const roleRow = (key: string) => db.prepare('SELECT role, granted_by, break_glass_hash FROM node_roles WHERE member_pubkey = ?').get(key) as
    { role: string; granted_by: string; break_glass_hash: string | null } | undefined;
const notices = () => fs.readdirSync(DATA_DIR).filter(f => f.startsWith('recover-notice-'));

initStateEngine();
updateLocalConfig({
    communityName: 'Recover Test', contactEmail: 'ops@example.org',
    replicationTokenHash: 'a'.repeat(64), replicationTokenSalt: 'b'.repeat(32), breakGlassMode: true,
} as any);
const configBefore = fs.readFileSync(CONFIG);

// Joined members (an invite is what the command asks for; how they joined does not matter here).
const addMember = (key: string, callsign: string, status = 'active') => db.prepare(
    'INSERT INTO members (public_key, callsign, status, joined_at) VALUES (?, ?, ?, ?)').run(key, callsign, status, new Date().toISOString());
const ALICE = pk();
addMember(ALICE, 'alice');
const PRUNED = pk();
addMember(PRUNED, 'gone', 'pruned');

async function main() {
    // 1. Refusals
    const unknown = cli('recover', '--key', pk());
    assert(unknown.code !== 0, `an unknown key is refused (exit ${unknown.code})`);
    assert(/no member/i.test(unknown.out), 'the refusal says there is no such member');
    const pruned = cli('recover', '--key', PRUNED);
    assert(pruned.code !== 0 && !roleRow(PRUNED), 'a pruned member is refused and gets no role');
    const noArgs = cli('recover');
    assert(noArgs.code !== 0 && /--key/.test(noArgs.out), 'with no key it explains how to use it and changes nothing');
    assert(notices().length === 0, 'a refusal leaves no notice for the community');

    // 2 + 3. Alice is made owner
    const first = cli('recover', '--key', ALICE);
    assert(first.code === 0, `recover for a member exits 0 (exit ${first.code})`);
    const row = roleRow(ALICE);
    assert(row?.role === 'owner', 'the member is now an owner');
    assert(row?.granted_by === 'server:recover', 'the grant is attributed to server:recover');
    const code1 = first.out.match(/bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/)?.[0];
    assert(!!code1, 'it prints a break-glass code for the new owner');
    assert(!!code1 && !!row?.break_glass_hash && (await breakGlassCodeMatches(code1, row.break_glass_hash)) !== 'no',
        'the stored hash matches the printed code');
    const made = db.prepare('SELECT break_glass_made_at AS at, break_glass_made_by AS by FROM node_roles WHERE member_pubkey = ?').get(ALICE) as { at: string | null; by: string | null } | undefined;
    assert(made?.by === 'recover' && !!made?.at && Math.abs(Date.now() - Date.parse(made.at)) < 60_000,
        `Settings can show the code was made by beanpool recover, and when (${JSON.stringify(made)})`);
    assert(fs.readFileSync(CONFIG).equals(configBefore), 'local-config.json is unchanged (name, contact, token, break-glass mode)');

    // 4. The notice and the log line
    assert(notices().length === 1, 'one notice is left for the node');
    const announced: { title: string; body: string; severity: string }[] = [];
    const logged: string[] = [];
    const deps = {
        announce: (title: string, body: string, severity: 'critical') => { announced.push({ title, body, severity }); },
        log: (msg: string) => { logged.push(msg); },
    };
    assert(deliverRecoverNotices(deps) === 1, 'the node delivers the one notice');
    assert(announced.length === 1 && announced[0].severity === 'critical', 'it is a critical community announcement');
    assert(/@alice/.test(announced[0]?.body ?? '') && /server/i.test(announced[0]?.body ?? ''),
        'the announcement names the member and says it was done on the server');
    assert(logged.length === 1 && logged[0].includes(ALICE.slice(0, 12)), 'a SECURITY log line names the key');
    assert(notices().length === 0, 'the notice file is gone after delivery');
    assert(deliverRecoverNotices(deps) === 0 && announced.length === 1, 'a delivered notice is never announced again');

    // 5. A second run replaces the code
    const second = cli('recover', '--key', ALICE);
    const code2 = second.out.match(/bg-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/)?.[0];
    const row2 = roleRow(ALICE);
    assert(second.code === 0 && !!code2 && code2 !== code1, 'running it again prints a new code');
    assert(!!row2?.break_glass_hash && (await breakGlassCodeMatches(code1!, row2.break_glass_hash)) === 'no',
        'the code printed before no longer works');
    assert(!!row2?.break_glass_hash && (await breakGlassCodeMatches(code2!, row2.break_glass_hash)) !== 'no', 'the new code works');
    assert(fs.readFileSync(CONFIG).equals(configBefore), 'local-config.json is still unchanged');

    // 6. By callsign
    const BOB = pk();
    addMember(BOB, 'Bob');
    const byName = cli('recover', '--key', '@bob');
    assert(byName.code === 0 && roleRow(BOB)?.role === 'owner', '@callsign (any case) finds the member and makes them owner');
    const BOB_OLD = pk();
    addMember(BOB_OLD, 'bob', 'pruned');
    const again = cli('recover', '--key', '@BOB');
    assert(again.code === 0, 'a pruned member with the same callsign does not make @callsign ambiguous');
    const nobody = cli('recover', '--key', '@nobody');
    assert(nobody.code !== 0 && /no member @nobody/i.test(nobody.out), 'an unknown @callsign is refused');
    deliverRecoverNotices(deps);

    // 7. An admin made owner: their sessions end (session_epoch moves, as grantNodeRole does) and phones' delta reads
    //    carry the new role (profile_updated_at moves). An owner run again changes neither.
    const CARA = pk();
    addMember(CARA, 'cara');
    db.prepare("INSERT INTO node_roles (member_pubkey, role, granted_by, session_epoch) VALUES (?, 'admin', 'owner:password', 3)").run(CARA);
    db.prepare('UPDATE members SET profile_updated_at = ? WHERE public_key = ?').run('2020-01-01T00:00:00.000Z', CARA);
    const promoted = cli('recover', '--key', CARA);
    const caraRole = db.prepare('SELECT role, session_epoch FROM node_roles WHERE member_pubkey = ?').get(CARA) as { role: string; session_epoch: number };
    const caraAt = (db.prepare('SELECT profile_updated_at AS at FROM members WHERE public_key = ?').get(CARA) as { at: string }).at;
    assert(promoted.code === 0 && caraRole.role === 'owner', 'an admin is made owner');
    assert(caraRole.session_epoch === 4, `their admin sessions end: session_epoch 3 → ${caraRole.session_epoch}`);
    assert(caraAt > '2020-01-01T00:00:00.000Z', 'their row moves, so phones see the new role');
    cli('recover', '--key', CARA);
    const caraAgain = db.prepare('SELECT session_epoch FROM node_roles WHERE member_pubkey = ?').get(CARA) as { session_epoch: number };
    assert(caraAgain.session_epoch === 4, 'an owner run again keeps their sessions (session_epoch unchanged)');
    deliverRecoverNotices(deps);

    // 8. Beside a node that is writing: another process holds the write lock for 1.5 s; recover waits it out (busy
    //    timeout) instead of failing at once with SQLITE_BUSY.
    const DEV = pk();
    addMember(DEV, 'dev');
    const holder = spawn(process.execPath, ['-e', `
        const D = require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
        const c = new D(${JSON.stringify(path.join(DATA_DIR, 'state.db'))});
        c.exec('BEGIN IMMEDIATE'); c.prepare("UPDATE members SET bio = bio WHERE public_key = ?").run(${JSON.stringify(DEV)});
        process.stdout.write('locked\\n');
        setTimeout(() => { c.exec('COMMIT'); c.close(); }, 1500);`], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise<void>((resolve) => holder.stdout!.on('data', (d) => { if (String(d).includes('locked')) resolve(); }));
    const t0 = Date.now();
    const busy = cli('recover', '--key', DEV);
    const waited = Date.now() - t0;
    assert(busy.code === 0 && roleRow(DEV)?.role === 'owner', `beside a writer holding the lock, recover waits and succeeds (exit ${busy.code}, ${waited} ms${busy.code ? ': ' + busy.out.split('\\n')[0] : ''})`);
    await new Promise((r) => holder.once('exit', r));
    deliverRecoverNotices(deps);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exitCode = 1;
}

// The node's timers keep the loop alive, so the suite ends itself.
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
