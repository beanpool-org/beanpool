/**
 * The owner's count (notifications N6; @beanpool/core notify-reach.ts): POST /api/local/admin/data's `counts.notify`,
 * "Members a phone can notify: {n} of {m}" on the owner console's Members page.
 *
 *   1. Through the real middleware, with an owner's automation token: one member of each kind moves the count as core's
 *      rule says. A member with an iPhone, with an Android, with both, and a suspended member with a phone count as
 *      phones; a member with only a browser's token row, only a web push subscription, or nothing counts as a member with
 *      none. The community's own account, a visitor, a retired duplicate and a removed member, each holding a phone's
 *      token, add nothing to either number.
 *   2. The count names nobody: no seeded key or callsign is anywhere in the counts.
 *   3. It never says more members than the counts' own members, nor more phones than members.
 *   4. A request with no credential is refused, with no counts.
 *
 * Run: SERVER_SUITES_ONLY=test-notify-reach-count TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { ownerTokenHeaders } from './admin-auth-test-harness.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}

let BASE = '';
async function post(path: string, headers: Record<string, string>, body: unknown = {}): Promise<{ status: number; text: string; json: any }> {
    const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, text, json };
}

const seeded: Array<{ pub: string; callsign: string }> = [];
/** One members row with these tokens and this standing; its key and callsign are kept, to look for them in the answer. */
function seed(label: string, opts: { tokens?: string[]; webPush?: boolean; status?: string; treasury?: boolean; visitor?: boolean; retired?: boolean } = {}): string {
    const pub = crypto.randomBytes(32).toString('hex');
    const callsign = `Riverside${label}${seeded.length}`;
    seeded.push({ pub, callsign });
    db.prepare(`INSERT INTO members (public_key, callsign, status, joined_at, invited_by, invite_code, is_treasury, is_visitor)
        VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'genesis', 'seed', ?, ?)`)
        .run(pub, callsign, opts.status ?? 'active', opts.treasury ? 1 : 0, opts.visitor ? 1 : 0);
    (opts.tokens ?? []).forEach((platform, i) => {
        db.prepare(`INSERT INTO push_tokens (public_key, token_id, token_box, platform) VALUES (?, ?, 'box', ?)`).run(pub, `tok-${label}-${i}`, platform);
    });
    if (opts.webPush) {
        db.prepare(`INSERT INTO web_push_subscriptions (public_key, sub_id, sub_box, kind) VALUES (?, ?, 'box', 'member')`).run(pub, crypto.randomBytes(32).toString('hex'));
    }
    if (opts.retired) db.prepare(`INSERT INTO retired_accounts (member_pubkey, retired_by) VALUES (?, 'seed')`).run(pub);
    return pub;
}

async function main() {
    console.log('Running the owner\'s count test...\n');
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const owner = ownerTokenHeaders('admin');

    const read = async () => {
        const r = await post('/api/local/admin/data', owner, { lists: 'none' });
        if (r.status !== 200) throw new Error(`the summary answered ${r.status}: ${r.text.slice(0, 200)}`);
        return r.json.counts;
    };

    // ── 1. Each kind of row moves the count as the rule says ──
    console.log('── 1. Each kind of row, through the real middleware ──');
    const before = await read();
    assert(Number.isInteger(before?.notify?.phones) && Number.isInteger(before?.notify?.members),
        `the summary's counts carry the owner's count (${JSON.stringify(before?.notify)})`);

    seed('Ios', { tokens: ['ios'] });
    seed('Android', { tokens: ['android'] });
    seed('BothPhones', { tokens: ['ios', 'android'] });
    seed('Suspended', { tokens: ['android'], status: 'suspended' });
    seed('UpperCase', { tokens: ['IOS'] });
    seed('BrowserToken', { tokens: ['web'] });
    seed('WebPushOnly', { webPush: true });
    seed('Nothing');
    seed('Treasury', { tokens: ['ios'], treasury: true });
    seed('Visitor', { tokens: ['ios'], visitor: true });
    seed('Retired', { tokens: ['android'], status: 'disabled', retired: true });
    seed('Pruned', { tokens: ['ios'], status: 'pruned' });

    const after = await read();
    const dPhones = after.notify.phones - before.notify.phones;
    const dMembers = after.notify.members - before.notify.members;
    assert(dPhones === 5, `five phones more: an iPhone, an Android, both on one member (once), a suspended member's, an 'IOS' row (got ${dPhones})`);
    assert(dMembers === 8, `eight members more: those five, a browser's token row only, a web push only, nothing (got ${dMembers})`);
    assert(after.members - before.members === 11,
        `the list's own count (treasury, visitor and retired rows in it, the removed one not) moved by 11 (got ${after.members - before.members})`);

    // ── 2. Names nobody ──
    console.log('\n── 2. A count, never names ──');
    const countsText = JSON.stringify(after);
    const named = seeded.filter(s => countsText.includes(s.pub) || countsText.includes(s.callsign));
    assert(named.length === 0, `no seeded key or callsign is in the counts (${named.map(s => s.callsign).join(', ') || 'none'})`);
    assert(JSON.stringify(Object.keys(after.notify).sort()) === JSON.stringify(['members', 'phones']),
        `the owner's count is two numbers and nothing else (${Object.keys(after.notify).join(', ')})`);

    // ── 3. Never more than the counts' own members ──
    console.log('\n── 3. Within the counts\' own members ──');
    assert(after.notify.members <= after.members && after.notify.phones <= after.notify.members,
        `phones ≤ members ≤ the list's members (${after.notify.phones} ≤ ${after.notify.members} ≤ ${after.members})`);

    // ── 4. Refused without a credential ──
    console.log('\n── 4. No credential, no count ──');
    const none = await post('/api/local/admin/data', {}, { lists: 'none' });
    assert(none.status === 401 && !none.text.includes('"notify"'), `no credential: 401, no counts (got ${none.status})`);

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
