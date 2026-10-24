/**
 * A group invitation reaches the member invited (tester report 24 Oct, item 6: an invite showed only as an INVITED badge
 * deep in Commons, with no push, no count and no line in Needs you) — over a REAL HTTPS round trip, through the
 * signature middleware. The convenor invites with POST /api/groups/:id/members; the member answers with
 * POST /api/groups/:id/join or DELETE /api/groups/:id/members/:self; a convenor withdraws with the same DELETE.
 *
 * Verifies:
 *  1. The push: one, of kind `group.invite`, to the member invited and no one else (not the convenor, not another
 *     convenor, not the group's members, not a member outside it); the lock screen shows the kind's fixed words, and
 *     nothing that left names the group or the convenor.
 *  2. Its details (GET /api/notices/push/:id) name the group and the convenor and land on the invitation — for the member
 *     invited only: another member, the convenor and a member of the group get 404, an unsigned read 401.
 *  3. Home's Needs you: one line for the member's open invitation, landing on it, for an app that opens it (lands=invite);
 *     none for an older app, and none for anyone else. GET /api/your-groups lists it beside the member's chats.
 *  4. The line goes when the invitation is accepted, declined or withdrawn; several are one counted line, landing on
 *     the list; none for a group its members closed or while the member's account is suspended.
 *  5. What sends no push: an invitation already open, one withdrawn and made again within the hour (one push an hour), a
 *     member who has blocked the convenor (the invitation still stands, and shows), a member with chat notifications
 *     off, and someone who had asked to join and is admitted by the invitation.
 *  6. The one-push-an-hour guard keeps at most GROUP_INVITE_PUSHES_KEPT: a wave of more invitations within the hour
 *     leaves it at that (it doesn't grow without end), and the newest pair is still held to one push.
 *
 * Expo is answered here: nothing leaves this machine.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_ROLE;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, registerPushToken, inviteGroupMember, groupInvitePushesKept, GROUP_INVITE_PUSHES_KEPT } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { addBlocks } from './engine/member-blocks.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { PUSH_NOTICE_KINDS, PUSH_NOTICE_TITLE } from '@beanpool/core';

// Expo is answered here, so every push is measured without leaving this machine; nothing else off it is reached.
const realFetch = globalThis.fetch;
const expo: any[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        expo.push(...msgs);
        return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-group-invite-notify: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject; name: string; token: string };
const DAY = 86400_000;

function makeMember(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    const joinedAt = new Date(Date.now() - 30 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`).run(pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 50, 0)`).run(pubKeyHex);
    const token = `ExponentPushToken[gi-${callsign}-${pubKeyHex.slice(0, 6)}]`;
    registerPushToken(pubKeyHex, token, 'android');
    return { pubKeyHex, privateKey, name: callsign, token };
}

/** A group led by `lead`; the rest active in it with the roles given. Dated from now. */
function makeGroup(name: string, joinPolicy: 'open' | 'request_to_join' | 'invite_only', lead: Id, others: Array<{ id: Id; role: 'convenor' | 'member' | 'observer' }> = []): string {
    const gid = crypto.randomUUID();
    const created = new Date(Date.now() - 10 * DAY).toISOString();
    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                VALUES (?, ?, ?, 'social', ?, ?, ?, ?, ?)`)
        .run(gid, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${gid.slice(0, 6)}`, lead.pubKeyHex, lead.pubKeyHex, joinPolicy, created, created);
    for (const [i, p] of [{ id: lead, role: 'convenor' as const }, ...others].entries()) {
        const at = new Date(Date.now() - (9 - i * 0.1) * DAY).toISOString();
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at)
                    VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(gid, p.id.pubKeyHex, p.role, at, at, at);
    }
    return gid;
}

type Signed = { status: number; body: any };

/** The replay-proof scheme the real middleware requires: method + path (without its query) + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST' | 'DELETE', path: string, body: unknown, id: Id | null): Promise<Signed> {
    resetGatewayRateLimit();
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(`${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
    let json: any;
    try { json = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body: json };
}

const invite = (g: string, by: Id, who: Id, role = 'member') => signedFetch('POST', `/api/groups/${g}/members`, { targetPubkey: who.pubKeyHex, role }, by);
const accept = (g: string, who: Id) => signedFetch('POST', `/api/groups/${g}/join`, {}, who);
const removeFrom = (g: string, by: Id, who: Id) => signedFetch('DELETE', `/api/groups/${g}/members/${who.pubKeyHex}`, {}, by);
const home = (who: Id, lands = 'enterprise,group,invite') => signedFetch('GET', `/api/home?cards=needs${lands ? `&lands=${lands}` : ''}`, null, who);
const inviteLine = (h: Signed) => (h.body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'invite');
const yourInvites = async (who: Id) => (await signedFetch('GET', '/api/your-groups', null, who)).body?.invites;

/** Waits for the push work done after the answer (setImmediate, then the batch to Expo) to have left. */
async function settle(until?: () => boolean): Promise<void> {
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 25));
        if (until?.()) return;
    }
}
const pushesTo = (who: Id) => expo.filter(m => m.to === who.token);

async function main(): Promise<void> {
    console.log('\nA group invitation reaches the member invited, over real HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const [cleo, cas, gus, mia, nat] = ['Cleo', 'Cas', 'Gus', 'Mia', 'Nat'].map(makeMember);
    const garden = makeGroup('Secret Garden Club', 'invite_only', cleo, [{ id: cas, role: 'convenor' }, { id: gus, role: 'member' }]);

    // ── 1. The push: to the member invited, and no one else ───────────────────────────────────────────────────
    expo.length = 0;
    const sent = await invite(garden, cleo, mia);
    await settle(() => expo.length > 0);
    await settle();
    assert(sent.status === 200 && sent.body?.member?.status === 'invited', `Cleo invites Mia (got ${sent.status} ${sent.body?.error ?? ''})`);
    assert(expo.length === 1 && pushesTo(mia).length === 1,
        `one push, to Mia's phone: not Cleo's, Cas's, Gus's or Nat's (got ${expo.length}: ${expo.map(m => m.to).join(', ')})`);
    const push = pushesTo(mia)[0];
    assert(push?.data?.k === 'group.invite', `its kind is group.invite (got ${push?.data?.k})`);
    assert(push?.title === PUSH_NOTICE_TITLE && typeof PUSH_NOTICE_KINDS[push?.data?.k as keyof typeof PUSH_NOTICE_KINDS]?.body === 'string'
        && push?.body === PUSH_NOTICE_KINDS[push.data.k as keyof typeof PUSH_NOTICE_KINDS].body,
        `the lock screen shows "BeanPool" and the kind's fixed sentence (got ${push?.title} / ${push?.body})`);
    const wire = JSON.stringify(expo);
    assert(!/Secret|Garden|Cleo/.test(wire) && !wire.includes(garden) && !wire.includes(cleo.pubKeyHex),
        'nothing that left names the group, its id or the convenor');

    // ── 2. Its details: for Mia only ──────────────────────────────────────────────────────────────────────────
    const noticeId = String(push?.data?.i ?? '');
    const mine = await signedFetch('GET', `/api/notices/push/${noticeId}`, null, mia);
    assert(mine.status === 200 && mine.body?.kind === 'group.invite' && mine.body?.data?.screen === 'invite' && mine.body?.data?.groupId === garden,
        `Mia reads the details, which land on the invitation (got ${mine.status} ${JSON.stringify(mine.body?.data)})`);
    assert(/Secret Garden Club/.test(mine.body?.title ?? '') && /Cleo/.test(mine.body?.body ?? ''),
        `the details name the group and who invited her (got "${mine.body?.title}" / "${mine.body?.body}")`);
    for (const [who, label] of [[nat, 'a member outside the group'], [cleo, 'the convenor who invited her'], [gus, 'a member of the group']] as Array<[Id, string]>) {
        const r = await signedFetch('GET', `/api/notices/push/${noticeId}`, null, who);
        assert(r.status === 404 && !JSON.stringify(r.body ?? {}).includes('Garden'), `${label} gets 404 for the notice (got ${r.status})`);
    }
    assert((await signedFetch('GET', `/api/notices/push/${noticeId}`, null, null)).status === 401, 'an unsigned read of the notice is refused (401)');

    // ── 3. Needs you: Mia's line, for an app that opens it; nobody else's ──────────────────────────────────────
    const miaHome = await home(mia);
    const line = inviteLine(miaHome);
    assert(miaHome.status === 200 && line?.count === 1 && line?.target?.to === 'invite' && line?.target?.id === garden && line?.accent === false,
        `Mia's Needs you has one invitation line, landing on it (got ${miaHome.status} ${JSON.stringify(line)})`);
    assert(line?.label === "You're invited to join Secret Garden Club", `it names the group (got "${line?.label}")`);
    const older = await home(mia, 'enterprise,group');
    const oldest = await home(mia, '');
    assert(older.status === 200 && !inviteLine(older) && oldest.status === 200 && !inviteLine(oldest),
        'an app that does not say it opens an invitation (no lands=invite) gets no such line');
    for (const who of [cleo, cas, gus, nat]) {
        const h = await home(who);
        assert(h.status === 200 && !inviteLine(h), `${who.name}'s Needs you has no invitation line`);
    }
    const listed = await yourInvites(mia);
    assert(Array.isArray(listed) && listed.length === 1 && listed[0].groupId === garden && listed[0].name === 'Secret Garden Club',
        `GET /api/your-groups lists Mia's open invitation beside her chats (got ${JSON.stringify(listed)})`);
    const natListed = await yourInvites(nat);
    assert(Array.isArray(natListed) && natListed.length === 0, `and lists none for Nat (got ${JSON.stringify(natListed)})`);

    // An invitation already open sends nothing more.
    expo.length = 0;
    const again = await invite(garden, cas, mia);
    await settle();
    assert(again.status === 200 && expo.length === 0, `inviting Mia again while her invitation is open sends no push (got ${again.status}, ${expo.length})`);

    // ── 4. Accepted, declined, withdrawn: the line goes ────────────────────────────────────────────────────────
    const joined = await accept(garden, mia);
    assert(joined.status === 200 && joined.body?.member?.status === 'active', `Mia accepts (got ${joined.status} ${joined.body?.error ?? ''})`);
    const afterJoin = await home(mia);
    assert(!inviteLine(afterJoin) && (await yourInvites(mia))?.length === 0, 'accepted: the line and the listing are gone');

    const ola = makeMember('Ola');
    await invite(garden, cleo, ola);
    assert(inviteLine(await home(ola))?.count === 1, 'Ola has an invitation line');
    const declined = await removeFrom(garden, ola, ola);
    assert(declined.status === 200 && !inviteLine(await home(ola)) && (await yourInvites(ola))?.length === 0,
        `declined (Ola leaves the row): the line is gone (got ${declined.status} ${declined.body?.error ?? ''})`);

    expo.length = 0;
    await invite(garden, cleo, nat);
    await settle(() => pushesTo(nat).length > 0);
    assert(inviteLine(await home(nat))?.count === 1 && pushesTo(nat).length === 1, 'Nat is invited, and told once');
    const withdrawn = await removeFrom(garden, cleo, nat);
    assert(withdrawn.status === 200 && !inviteLine(await home(nat)) && (await yourInvites(nat))?.length === 0,
        `withdrawn (Cleo removes the invitation): the line is gone (got ${withdrawn.status} ${withdrawn.body?.error ?? ''})`);
    // Withdrawn and made again within the hour: the invitation stands, the push doesn't repeat.
    await invite(garden, cleo, nat);
    await settle();
    assert(inviteLine(await home(nat))?.count === 1 && pushesTo(nat).length === 1,
        `invited again within the hour: the line is back, and no second push (got ${pushesTo(nat).length})`);

    // Several: one counted line, landing on the list.
    const pip = makeMember('Pip');
    const choir = makeGroup('Choir', 'request_to_join', cas);
    await invite(garden, cleo, pip);
    await invite(choir, cas, pip);
    const two = inviteLine(await home(pip));
    assert(two?.count === 2 && two?.target?.to === 'invites' && two?.label === "You're invited to join 2 groups",
        `two invitations are one line, landing on the list (got ${JSON.stringify(two)})`);
    assert((await yourInvites(pip))?.length === 2, 'and both are listed');

    // A group its members closed takes nobody new: its invitation asks nothing.
    db.prepare('INSERT INTO group_closures (group_id, decision_id, closed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(choir, crypto.randomUUID(), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const oneLeft = inviteLine(await home(pip));
    assert(oneLeft?.count === 1 && oneLeft?.target?.id === garden, `a closed group's invitation drops out of the line (got ${JSON.stringify(oneLeft)})`);

    // A suspended account accepts nothing until it ends (engine joinGroup): no line asks it to.
    db.prepare("UPDATE members SET status = 'disabled' WHERE public_key = ?").run(pip.pubKeyHex);
    const paused = await home(pip);
    assert(paused.status === 200 && !inviteLine(paused) && (await yourInvites(pip))?.length === 0,
        `while Pip's account is suspended, no invitation line (got ${paused.status} ${JSON.stringify(inviteLine(paused))})`);
    db.prepare("UPDATE members SET status = 'active' WHERE public_key = ?").run(pip.pubKeyHex);
    assert(inviteLine(await home(pip))?.count === 1, 'and it is back once the suspension ends');

    // ── 5. What sends no push ──────────────────────────────────────────────────────────────────────────────────
    const zed = makeMember('Zed');
    addBlocks(zed.pubKeyHex, [cleo.pubKeyHex]);
    expo.length = 0;
    const blockedInvite = await invite(garden, cleo, zed);
    await settle();
    assert(blockedInvite.status === 200 && pushesTo(zed).length === 0 && inviteLine(await home(zed))?.count === 1,
        `Zed has blocked Cleo: her invitation stands and shows, with no push (got ${blockedInvite.status}, ${pushesTo(zed).length} pushes)`);

    const wen = makeMember('Wen');
    db.prepare("INSERT OR REPLACE INTO member_preferences (public_key, pref_key, pref_value) VALUES (?, 'notify_chat', 'false')").run(wen.pubKeyHex);
    await invite(garden, cleo, wen);
    await settle();
    assert(pushesTo(wen).length === 0 && inviteLine(await home(wen))?.count === 1, 'Wen turned chat notifications off: no push, the line still shows');

    const ray = makeMember('Ray');
    const club = makeGroup('Book Club', 'request_to_join', cleo);
    const asked = await accept(club, ray);
    assert(asked.status === 200 && asked.body?.member?.status === 'pending_approval', `Ray asks to join the book club (got ${asked.status})`);
    const admitted = await invite(club, cleo, ray);
    await settle();
    assert(admitted.body?.member?.status === 'active' && pushesTo(ray).length === 0 && !inviteLine(await home(ray)),
        `inviting Ray, who had asked, admits him: no invitation push and no line (got ${admitted.body?.member?.status}, ${pushesTo(ray).length})`);

    // ── 6. An invitation wave: the guard stays at its size ─────────────────────────────────────────────────────
    // Straight to the engine, not over HTTPS: the size is what's measured, and 10,000 signed round trips would only be slow.
    const wave = makeGroup('Big Choir', 'invite_only', cleo);
    const insertMember = db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit) VALUES (?, ?, ?, 'active', 100)`);
    const many: string[] = [];
    db.transaction(() => {
        for (let i = 0; i < GROUP_INVITE_PUSHES_KEPT + 50; i++) {
            const key = crypto.randomBytes(32).toString('hex');
            insertMember.run(key, `Wave${i}`, new Date(Date.now() - 30 * DAY).toISOString());
            many.push(key);
        }
    })();
    for (const [i, key] of many.entries()) {
        inviteGroupMember(wave, cleo.pubKeyHex, key);
        if (i % 200 === 0) await new Promise(r => setImmediate(r));
    }
    const ivy = makeMember('Ivy');
    expo.length = 0;
    await invite(wave, cleo, ivy);
    await settle(() => pushesTo(ivy).length > 0);
    assert(groupInvitePushesKept() === GROUP_INVITE_PUSHES_KEPT && pushesTo(ivy).length === 1,
        `${many.length + 1} invitations within the hour: the guard keeps ${GROUP_INVITE_PUSHES_KEPT} (got ${groupInvitePushesKept()}), and Ivy, the last, is told (got ${pushesTo(ivy).length})`);
    await removeFrom(wave, cleo, ivy);
    await invite(wave, cleo, ivy);
    await settle();
    assert(pushesTo(ivy).length === 1 && groupInvitePushesKept() === GROUP_INVITE_PUSHES_KEPT,
        `the newest pair is still held: Ivy, withdrawn and invited again, gets no second push (got ${pushesTo(ivy).length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A GROUP INVITATION REACHES THE MEMBER INVITED, AND ONLY THEM.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
