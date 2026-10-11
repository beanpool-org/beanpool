/**
 * A chat group's vote (DESIGN-group-decisions §2.2–§2.6, slice S3) — over a REAL HTTPS round trip, through the signature
 * middleware. The group is the PATH's; the actor is the signer; the tick carries a vote out. Fixtures are dated from now.
 *
 * Verifies (§4 row S3):
 *  - A guild of 5 replaces its lead convenor by 3–2, closing early once all have voted; turnout only while open.
 *  - An observer reads the group's votes but is refused a vote and a proposal; someone outside the group gets 404.
 *  - A convenor's removal of a voter mid-vote doesn't swing it (the vote stands, the roll keeps them); leaving drops it.
 *  - Closing the group voids its other open votes; it then takes nobody new, no new vote and no chat line; "Your
 *    groups" shows it closed.
 *  - A former member (left, or removed) reads only the votes they were on; one opened after they went is 404.
 *  - Home's vote line lands on the group for an app that opens it (lands=group), and an older app gets none.
 *  - The candidate guard answers only a convenor: an outsider or a member is refused as for anyone (#1777 R1); the 30-day
 *    silence vote's candidate is held as a lead vote's is (R3); the vote's membership writes stamp past the row (R2).
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import {
    initStateEngine, tickDecisions, removeGroupMember, joinGroup, postGroupThreadMessage, createPost, requestPost, setMemberRole, GROUP_CLOSED,
    setUserStatusRow, registerPushToken,
    GROUP_LEAD_CANDIDATE_HELD, setGroupRoleByVote, replaceGroupLeadByVote, removeGroupMemberByVote,
} from './state-engine.js';
import { GROUP_CLOSED_TO_POSTS } from './engine/posts.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { GROUP_NOT_ON_ROLL, GROUP_OBSERVER_NO_VOTE, GROUP_CLOSED_VOID, GROUP_ALREADY_VOTED, GROUP_CLOSED_LINE, executeDecision } from './decisions-engine.js';
import { setChatMute } from './engine/chat-mutes.js';
import { PUSH_NOTICE_KINDS } from '@beanpool/core';

// Expo is answered here, so the group push is measured without leaving this machine; nothing else off it is reached.
const realFetch = globalThis.fetch;
const expo: any[] = [];
globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (url.startsWith('https://exp.host')) {
        const msgs = JSON.parse(String(init?.body ?? '[]'));
        expo.push(...msgs);
        return new Response(JSON.stringify({ data: msgs.map(() => ({ status: 'ok', id: crypto.randomUUID() })) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (!url.startsWith('https://localhost')) throw new Error(`test-decisions-group: refused a request off this machine: ${url}`);
    return realFetch(input, init);
}) as typeof fetch;

let BASE = '';
let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ FAIL: ${msg}`); }
}

type Id = { pubKeyHex: string; privateKey: crypto.KeyObject };
const DAY = 86400_000;

function keypair(): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const pubKeyHex = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
    return { pubKeyHex, privateKey };
}

function makeMember(callsign: string, balance = 50): Id {
    const id = keypair();
    const joinedAt = new Date(Date.now() - 30 * DAY).toISOString();
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, earned_credit)
                VALUES (?, ?, ?, 'active', 100)`).run(id.pubKeyHex, callsign, joinedAt);
    db.prepare(`INSERT INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, ?, 0)`).run(id.pubKeyHex, balance);
    return id;
}

type Signed = { status: number; body: any; error?: string; etag?: string | null; replay: () => Promise<{ status: number; body: any }> };

/** The replay-proof scheme the real middleware requires: method + path (without its query) + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body: unknown, id: Id | null, extra: Record<string, string> = {}): Promise<Signed> {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = { ...extra };
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
        headers['X-Public-Key'] = id.pubKeyHex;
        headers['X-Signature'] = crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64');
        headers['X-Timestamp'] = String(ts);
        headers['X-Nonce'] = nonce;
    }
    const send = async () => {
        const res = await fetch(`${BASE}${path}`, { method, headers, body: method === 'GET' ? undefined : bodyString });
        let json: any;
        try { json = await res.json(); } catch { /* not JSON */ }
        return { status: res.status, body: json, etag: res.headers.get('etag') };
    };
    const first = await send();
    return { ...first, error: first.body?.error, replay: send };
}


const row = (id: string) => db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as any;
const groupRow = (id: string) => db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as any;
const roleOf = (g: string, pk: string) => (db.prepare('SELECT role, status FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, pk) as any);

/** A group: the first person leads it as a convenor; then convenors, members and observers as given. Dated from now. */
function makeGroup(name: string, people: Array<{ id: Id; role: 'convenor' | 'member' | 'observer' }>, category = 'guild'): string {
    const gid = crypto.randomUUID();
    const created = new Date(Date.now() - 10 * DAY).toISOString();
    db.prepare(`INSERT INTO groups (id, name, slug, category, created_by, lead_pubkey, join_policy, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
        .run(gid, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${gid.slice(0, 6)}`, category, people[0].id.pubKeyHex, people[0].id.pubKeyHex, created, created);
    people.forEach((p, i) => {
        const at = new Date(Date.now() - (9 - i * 0.1) * DAY).toISOString();
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status, joined_at, role_since, updated_at)
                    VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(gid, p.id.pubKeyHex, p.role, at, at, at);
    });
    return gid;
}

function propose(g: string, by: Id, body: Record<string, unknown>) {
    return signedFetch('POST', `/api/groups/${g}/decisions`, {
        title: 'A group vote', description: 'Because the group needs to decide this.', ...body,
    }, by);
}
const vote = (g: string, id: string, by: Id, support: boolean) => signedFetch('POST', `/api/groups/${g}/decisions/${id}/vote`, { support }, by);
const detail = (g: string, id: string, by: Id) => signedFetch('GET', `/api/groups/${g}/decisions/${id}`, null, by);
const list = (g: string, by: Id) => signedFetch('GET', `/api/groups/${g}/decisions`, null, by);

function hasNoSplit(t: any): boolean {
    return !!t && !('yes' in t) && !('no' in t) && !('yesWeight' in t) && !('noWeight' in t) && !('supportRatio' in t);
}

async function main(): Promise<void> {
    console.log('\nA chat group\'s vote, over real HTTPS\n');
    await initTls();
    initStateEngine();
    BASE = `https://localhost:${await startHttpsServer(0)}`;

    const outsider = makeMember('Olive');

    // ── 1. A guild of 5 replaces its lead by 3–2; an observer is refused; an outsider gets 404 ──────────────
    const [lead, conv, m1, m2, m3, obs] = [makeMember('Lou'), makeMember('Cas'), makeMember('Mia'), makeMember('Max'), makeMember('Meg'), makeMember('Obi')];
    const g1 = makeGroup('Weavers Guild', [{ id: lead, role: 'convenor' }, { id: conv, role: 'convenor' }, { id: m1, role: 'member' },
        { id: m2, role: 'member' }, { id: m3, role: 'member' }, { id: obs, role: 'observer' }]);

    const p1 = await propose(g1, conv, { effect: 'replace_lead_convenor', subject: m1.pubKeyHex, title: 'Mia leads the guild' });
    const d1 = p1.body?.decision?.id as string;
    assert(p1.status === 200 && p1.body?.decision?.scopeKind === 'group' && p1.body.decision.scopeId === g1,
        `a convenor opens a vote to make Mia the lead (got ${p1.status} ${p1.error ?? ''})`);
    const electors = db.prepare('SELECT member_pubkey FROM decision_electors WHERE decision_id = ?').all(d1) as any[];
    assert(electors.length === 5 && !electors.some(e => e.member_pubkey === obs.pubKeyHex),
        `the roll is the 5 members and convenors, the observer off it (got ${electors.length})`);

    const obsVote = await vote(g1, d1, obs, true);
    assert(obsVote.status === 400 && obsVote.error === GROUP_NOT_ON_ROLL, `an observer's vote is refused (got ${obsVote.status} ${obsVote.error})`);
    const obsPropose = await propose(g1, obs, { effect: 'close_group' });
    assert(obsPropose.status === 400 && obsPropose.error === GROUP_OBSERVER_NO_VOTE, `an observer's proposal is refused (got ${obsPropose.status} ${obsPropose.error})`);
    const obsList = await list(g1, obs);
    assert(obsList.status === 200 && obsList.body?.onRoll === false && obsList.body?.canPropose === false && obsList.body.decisions?.length === 1,
        `an observer reads the group's votes, with no propose button (got ${obsList.status} ${JSON.stringify({ onRoll: obsList.body?.onRoll, canPropose: obsList.body?.canPropose })})`);
    for (const [what, res] of [
        ['list', await list(g1, outsider)], ['detail', await detail(g1, d1, outsider)],
        ['vote', await vote(g1, d1, outsider, true)], ['propose', await propose(g1, outsider, { effect: 'close_group' })],
    ] as Array<[string, Signed]>) {
        assert(res.status === 404, `someone outside the group gets 404 on the ${what} (got ${res.status})`);
    }
    assert((await signedFetch('GET', `/api/groups/${g1}/decisions`, null, null)).status === 401, 'an unsigned read is refused by the middleware');

    // Home: an app that opens a group's screen gets the line landing on the group; an older app gets none.
    const voteLine = (h: Signed) => (h.body?.cards?.needs?.items ?? []).find((i: any) => i.kind === 'vote');
    const homeOld = await signedFetch('GET', '/api/home?cards=needs', null, m2);
    const homeEnt = await signedFetch('GET', '/api/home?cards=needs&lands=enterprise', null, m2);
    const homeNew = await signedFetch('GET', '/api/home?cards=needs&lands=group', null, m2);
    assert(homeOld.status === 200 && !voteLine(homeOld) && !voteLine(homeEnt),
        `an app that can't open a group gets no line for the group's vote (got ${JSON.stringify(voteLine(homeOld) ?? voteLine(homeEnt))})`);
    assert(voteLine(homeNew)?.target?.to === 'group' && voteLine(homeNew)?.target?.id === g1,
        `lands=group lands the line on the group (got ${JSON.stringify(voteLine(homeNew))})`);
    const homeObs = await signedFetch('GET', '/api/home?cards=needs&lands=group', null, obs);
    assert(!voteLine(homeObs), 'an observer is never asked to vote');

    await vote(g1, d1, conv, true); await vote(g1, d1, m1, true); await vote(g1, d1, lead, false); await vote(g1, d1, m3, false);
    const open1 = await detail(g1, d1, m2);
    assert(open1.status === 200 && hasNoSplit(open1.body?.decision?.tally) && open1.body.decision.tally.voted === 4 && open1.body.decision.tally.roll === 5,
        `while open the card shows turnout only (got ${JSON.stringify(open1.body?.decision?.tally)})`);
    const again = await vote(g1, d1, m3, true);
    assert(again.status === 400 && again.error === GROUP_ALREADY_VOTED, `a vote can't be changed (got ${again.status} ${again.error})`);
    await vote(g1, d1, m2, true);
    tickDecisions();
    assert(row(d1).status === 'executed' && groupRow(g1).lead_pubkey === m1.pubKeyHex && roleOf(g1, m1.pubKeyHex).role === 'convenor'
        && roleOf(g1, lead.pubKeyHex).role === 'convenor',
        `3–2 makes Mia the lead convenor at once (all voted), Lou stays a convenor (got ${row(d1).status} ${row(d1).execution_reason ?? ''})`);
    const closed1 = await detail(g1, d1, m2);
    assert(closed1.body?.decision?.tally?.yes === 3 && closed1.body.decision.tally.no === 2, `Yes and No show once closed (got ${JSON.stringify(closed1.body?.decision?.tally)})`);

    // ── 2. A convenor's mid-vote removal doesn't swing it; leaving drops the vote ────────────────────────────────
    const [gl, a, b, c, dd] = [makeMember('Gil'), makeMember('Ada'), makeMember('Bea'), makeMember('Cy'), makeMember('Dot')];
    const g2 = makeGroup('Seed Circle', [{ id: gl, role: 'convenor' }, { id: a, role: 'member' }, { id: b, role: 'member' },
        { id: c, role: 'member' }, { id: dd, role: 'member' }], 'social');
    const d2 = (await propose(g2, a, { effect: 'set_join_policy', params: { policy: 'invite_only' } })).body?.decision?.id as string;
    await vote(g2, d2, a, true); await vote(g2, d2, b, true); await vote(g2, d2, c, false); await vote(g2, d2, dd, false);
    // The lead removes Bea, a Yes, mid-vote. If the removal dropped her vote it would be 1–2; it stands.
    removeGroupMember(g2, gl.pubKeyHex, b.pubKeyHex);
    assert(roleOf(g2, b.pubKeyHex).status === 'removed', 'the lead removed Bea from the group');
    const mid2 = await detail(g2, d2, a);
    assert(mid2.body?.decision?.tally?.voted === 4 && mid2.body.decision.tally.roll === 5,
        `the removed voter stays on the roll and her vote stands (got ${JSON.stringify(mid2.body?.decision?.tally)})`);
    tickDecisions();
    assert(row(d2).status === 'open', `2–2 with one to vote is not settled yet (got ${row(d2).status})`);
    await vote(g2, d2, gl, true);
    tickDecisions();
    assert(row(d2).status === 'executed' && groupRow(g2).join_policy === 'invite_only',
        `3–2 sets the join rule to invite only (got ${row(d2).status} ${row(d2).execution_reason ?? ''}, ${groupRow(g2).join_policy})`);

    // A member who leaves on their own drops from the roll, their vote with them.
    const d2b = (await propose(g2, c, { effect: 'set_group_role', subject: a.pubKeyHex, params: { role: 'convenor' } })).body?.decision?.id as string;
    await vote(g2, d2b, dd, true);
    removeGroupMember(g2, dd.pubKeyHex, dd.pubKeyHex);
    const mid2b = await detail(g2, d2b, a);
    assert(mid2b.body?.decision?.tally?.voted === 0 && mid2b.body.decision.tally.roll === 3,
        `a member who leaves drops from the roll and their vote is dropped (got ${JSON.stringify(mid2b.body?.decision?.tally)})`);

    // ── 3. A former member reads only the votes they were on ───────────────────────────────────────────────
    const d2c = (await propose(g2, gl, { effect: 'close_group', title: 'Opened after they went' })).body?.decision?.id as string;
    for (const [who, id] of [['removed', b], ['left', dd]] as Array<[string, Id]>) {
        const l = await list(g2, id);
        const ids = (l.body?.decisions ?? []).map((x: any) => x.id);
        assert(l.status === 200 && ids.includes(d2) && !ids.includes(d2c), `a ${who} member's list has the vote they were on and not the newer one (got ${l.status} ${ids.length})`);
        assert((await detail(g2, d2c, id)).status === 404 && (await vote(g2, d2c, id, true)).status === 404,
            `a ${who} member gets 404 on a vote opened after they went`);
    }
    assert((await detail(g2, d2, b)).status === 200, 'the removed member still reads the vote she was on the roll of');

    // ── 4. Closing voids the rest; a closed group takes nobody new and no vote; "Your groups" shows it closed ──
    const [p, q, r] = [makeMember('Pia'), makeMember('Quin'), makeMember('Rae')];
    const g3 = makeGroup('Tool Guild', [{ id: p, role: 'convenor' }, { id: q, role: 'member' }, { id: r, role: 'member' }]);
    const other = (await propose(g3, p, { effect: 'set_join_policy', params: { policy: 'request_to_join' } })).body?.decision?.id as string;
    const closeIt = (await propose(g3, q, { effect: 'close_group', title: 'Close the guild' })).body?.decision?.id as string;
    // The guild's live posts, to see the close cancel them as a delete does (#1777 review N3): an offer someone has asked
    // for, and an event; and a member's feed, cached before the close.
    for (const k of [p, q, r]) db.prepare("UPDATE members SET avatar_ref = 'test-photo' WHERE public_key = ?").run(k.pubKeyHex);
    const groupOnly = { audienceScope: 'group' as const, targetGroupId: g3 };
    const drill = createPost('offer', 'general', 'Guild drill', 'A drill to lend', 5, 'fixed', p.pubKeyHex, undefined, undefined, undefined, false, undefined, false, groupOnly);
    createPost('offer', 'general', 'Guild ladder', 'A ladder to lend', 5, 'fixed', q.pubKeyHex, undefined, undefined, undefined, false, undefined, false, groupOnly);
    const asked = requestPost(drill!.id, q.pubKeyHex);
    const soon = Date.now() + 3 * 86400_000;
    const meet = createPost('event', 'general', 'Guild meet', 'The monthly meet', 0, 'fixed', p.pubKeyHex, -28.55, 153.5, undefined, false, undefined, false,
        { ...groupOnly, eventStartAt: new Date(soon).toISOString(), eventEndAt: new Date(soon + 7200_000).toISOString() });
    const feedBefore = await signedFetch('GET', '/api/marketplace/posts', null, r);
    assert(!!drill && !!meet && asked?.status === 'requested' && JSON.stringify(feedBefore.body).includes(drill!.id) && !!feedBefore.etag,
        `the guild has an offer asked for and an event, and Rae's feed shows them (got ${asked?.status} ${feedBefore.status} ${feedBefore.etag})`);
    assert(!!other && !!closeIt, 'two votes open in the guild');
    await vote(g3, closeIt, p, true);
    tickDecisions();
    assert(row(closeIt).status === 'open', `1 of 3 yes is not settled (status ${row(closeIt).status})`);
    await vote(g3, closeIt, q, true);
    tickDecisions();
    // 2 of 3 Yes already clears 60% whatever the third says (2 of 3 is 67%), so it closes at once.
    assert(row(closeIt).status === 'executed' && !!db.prepare('SELECT 1 FROM group_closures WHERE group_id = ?').get(g3),
        `2–0 of 3 closes the guild at once (got ${row(closeIt).status} ${row(closeIt).execution_reason ?? row(closeIt).execution_error ?? ''})`);
    assert(row(other).status === 'execution_void' && row(other).execution_reason === GROUP_CLOSED_VOID,
        `closing voids the group's other open vote (got ${row(other).status} ${row(other).execution_reason})`);
    assert(!!groupRow(g3), 'the group row stays');
    // A vote the close voided, forced back to passed and carried out after it, is void too: nothing reopens the group.
    db.prepare("UPDATE decisions SET status = 'passed' WHERE id = ?").run(other);
    executeDecision(other);
    assert(row(other).status === 'execution_void' && row(other).execution_reason === GROUP_CLOSED_VOID
        && !!db.prepare('SELECT 1 FROM group_closures WHERE group_id = ?').get(g3),
        `a stale passed vote carried out after the close is void; the group stays closed (got ${row(other).status} ${row(other).execution_reason})`);
    const postRow = (id: string) => db.prepare('SELECT active, status, event_state, target_group_id FROM posts WHERE id = ?').get(id) as any;
    const tradeRow = db.prepare('SELECT status FROM marketplace_transactions WHERE id = ?').get(asked.id) as any;
    assert(postRow(drill!.id).status === 'cancelled' && postRow(drill!.id).active === 0 && postRow(drill!.id).target_group_id === g3
        && postRow(meet!.id).event_state === 'cancelled' && tradeRow?.status === 'rejected',
        `closing cancels the guild's posts as a delete does: the event too, and the deal asked for is declined (got ${JSON.stringify({ drill: postRow(drill!.id), meet: postRow(meet!.id), trade: tradeRow })})`);
    const feedAfter = await signedFetch('GET', '/api/marketplace/posts', null, r, { 'If-None-Match': feedBefore.etag! });
    assert(feedAfter.status === 200 && !JSON.stringify(feedAfter.body).includes(drill!.id) && feedAfter.etag !== feedBefore.etag,
        `a feed cached before the close is answered afresh, without the posts (got ${feedAfter.status}, ${feedBefore.etag} → ${feedAfter.etag})`);
    let joinErr = '';
    try { joinGroup(g3, outsider.pubKeyHex); } catch (e: any) { joinErr = e.message; }
    assert(joinErr === GROUP_CLOSED, `a closed group takes nobody new (got ${joinErr})`);
    let postErr = '';
    try { postGroupThreadMessage(g3, p.pubKeyHex, { text: 'hello' } as any); } catch (e: any) { postErr = e.message; }
    assert(postErr === GROUP_CLOSED, `a closed group takes no new chat line (got ${postErr})`);
    // No new post of any kind: an offer, a need, a poll or an event, from the engine or over HTTP (#1777 review B2).
    for (const type of ['offer', 'need', 'poll', 'event'] as const) {
        let err = '', made: unknown = null;
        try {
            made = createPost(type, 'general', `A ${type} after the close`, `A ${type} posted after the guild closed`, type === 'offer' || type === 'need' ? 5 : 0,
                'fixed', q.pubKeyHex, undefined, undefined, undefined, false, undefined, false, { audienceScope: 'group', targetGroupId: g3 });
        } catch (e: any) { err = e.message; }
        assert(!made && err === GROUP_CLOSED_TO_POSTS, `a closed group takes no new ${type} (got ${made ? 'created' : err})`);
    }
    const httpPost = await signedFetch('POST', '/api/marketplace/posts', { type: 'offer', category: 'general', title: 'Offer after close',
        description: 'An offer posted after the close.', credits: 3, priceType: 'fixed', authorPublicKey: r.pubKeyHex, audienceScope: 'group', targetGroupId: g3 }, r);
    assert(httpPost.status === 400 && httpPost.body?.error === GROUP_CLOSED_TO_POSTS,
        `nor over HTTP (got ${httpPost.status} ${JSON.stringify(httpPost.body)})`);
    assert(!(db.prepare("SELECT 1 FROM posts WHERE target_group_id = ? AND active = 1").get(g3)), 'the closed guild has no live post');
    const after = await propose(g3, p, { effect: 'set_join_policy', params: { policy: 'invite_only' } });
    assert(after.status === 400, `a closed group takes no new vote (got ${after.status} ${after.error ?? ''})`);
    const closedList = await list(g3, r);
    assert(closedList.status === 200 && !!closedList.body?.closedAt && closedList.body.canPropose === false,
        `the group's votes say it is closed (got ${JSON.stringify({ closedAt: closedList.body?.closedAt, canPropose: closedList.body?.canPropose })})`);
    // The chat and the group read say so too, and the chat has a line saying it closed (#1777 review N2).
    const chat3 = await signedFetch('GET', `/api/groups/${g3}/chat`, null, r);
    const closeLine = (chat3.body?.messages ?? []).find((m: any) => m.systemType === 'GROUP_CLOSED');
    assert(chat3.status === 200 && chat3.body.canPost === false && chat3.body.readOnly === true && !!chat3.body.closedAt,
        `the closed group's chat says it takes no line (got ${JSON.stringify({ s: chat3.status, canPost: chat3.body?.canPost, readOnly: chat3.body?.readOnly, closedAt: chat3.body?.closedAt })})`);
    assert((closeLine?.text ?? closeLine?.ciphertext) === GROUP_CLOSED_LINE, `and it has the line saying the members closed it (got ${JSON.stringify(closeLine ?? null)})`);
    const info3 = await signedFetch('GET', `/api/groups/${g3}`, null, r);
    assert(info3.status === 200 && info3.body?.readOnly === true && !!info3.body?.closedAt,
        `the group read says it is closed (got ${JSON.stringify({ s: info3.status, readOnly: info3.body?.readOnly, closedAt: info3.body?.closedAt })})`);
    const info1 = await signedFetch('GET', `/api/groups/${g1}`, null, m2);
    assert(info1.status === 200 && info1.body?.readOnly === false && info1.body?.closedAt === null, `an open group's read says it is open (got ${info1.status} ${info1.body?.readOnly})`);
    const yours = await signedFetch('GET', '/api/your-groups', null, r);
    const items: any[] = Array.isArray(yours.body) ? yours.body : (yours.body?.chats ?? yours.body?.items ?? yours.body?.groups ?? []);
    const mine3 = items.find(i => i.id === g3);
    assert(yours.status === 200 && !!mine3?.closedAt && mine3.readOnly === true,
        `"Your groups" shows the closed group as closed (got ${JSON.stringify(mine3 ? { closedAt: mine3.closedAt, readOnly: mine3.readOnly } : yours.body)?.slice(0, 200)})`);
    const open3 = items.find(i => i.id === g1);
    assert(!items.some(i => i.id === g1) || !open3?.closedAt, 'an open group is not shown closed');

    // ── 5. The lead can't remove or demote the person a vote may make the lead (#1777 review N4, decision (a)) ──
    const [ld, cv, ma, mb, mc] = [makeMember('Lin5'), makeMember('Cyd5'), makeMember('Ada5'), makeMember('Bo5'), makeMember('Cy5')];
    const g5 = makeGroup('Seed Guild', [{ id: ld, role: 'convenor' }, { id: cv, role: 'convenor' }, { id: ma, role: 'member' }, { id: mb, role: 'member' }, { id: mc, role: 'member' }]);
    const forBo = (await propose(g5, ma, { effect: 'replace_lead_convenor', subject: mb.pubKeyHex, title: 'Bo leads' })).body?.decision?.id as string;
    const forCyd = (await propose(g5, mc, { effect: 'replace_lead_convenor', subject: cv.pubKeyHex, title: 'Cyd leads' })).body?.decision?.id as string;
    assert(!!forBo && !!forCyd, 'two votes on the lead are open in the guild');
    let removeErr = '', demoteErr = '', toObserverErr = '';
    try { removeGroupMember(g5, ld.pubKeyHex, mb.pubKeyHex); } catch (e: any) { removeErr = e.message; }
    try { setMemberRole(g5, ld.pubKeyHex, cv.pubKeyHex, 'member'); } catch (e: any) { demoteErr = e.message; }
    try { setMemberRole(g5, ld.pubKeyHex, mb.pubKeyHex, 'observer'); } catch (e: any) { toObserverErr = e.message; }
    assert(removeErr === GROUP_LEAD_CANDIDATE_HELD && roleOf(g5, mb.pubKeyHex)?.status === 'active',
        `the lead can't remove the candidate of an open lead vote (got ${removeErr || 'removed'})`);
    assert(demoteErr === GROUP_LEAD_CANDIDATE_HELD && toObserverErr === GROUP_LEAD_CANDIDATE_HELD
        && roleOf(g5, cv.pubKeyHex)?.role === 'convenor' && roleOf(g5, mb.pubKeyHex)?.role === 'member',
        `nor lower a candidate's role (got ${demoteErr || 'demoted'} / ${toObserverErr || 'made an observer'})`);
    let promoteErr = '';
    try { setMemberRole(g5, ld.pubKeyHex, mb.pubKeyHex, 'convenor'); setMemberRole(g5, ld.pubKeyHex, mc.pubKeyHex, 'observer'); } catch (e: any) { promoteErr = e.message; }
    assert(!promoteErr && roleOf(g5, mb.pubKeyHex)?.role === 'convenor' && roleOf(g5, mc.pubKeyHex)?.role === 'observer',
        `raising a candidate, or changing someone who isn't one, is as before (got ${promoteErr || 'ok'})`);
    for (const v of [ma, mb, cv]) await vote(g5, forBo, v, true);
    tickDecisions();
    assert(row(forBo).status === 'executed' && groupRow(g5).lead_pubkey === mb.pubKeyHex,
        `so the members' vote carries: Bo is the lead (got ${row(forBo).status} ${row(forBo).execution_reason ?? ''})`);

    // R1: only a convenor is answered with the hold. Anyone else gets what they get for anyone (403), so a refusal tells an
    // outsider nothing about who an open lead vote's candidate is. forCyd is still open, with Cyd its candidate.
    const out5 = makeMember('Out5');
    const outDelCand = await signedFetch('DELETE', `/api/groups/${g5}/members/${cv.pubKeyHex}`, {}, out5);
    const outDelOther = await signedFetch('DELETE', `/api/groups/${g5}/members/${ma.pubKeyHex}`, {}, out5);
    const outPatchCand = await signedFetch('PATCH', `/api/groups/${g5}/members/${cv.pubKeyHex}`, { role: 'member' }, out5);
    const outPatchOther = await signedFetch('PATCH', `/api/groups/${g5}/members/${ld.pubKeyHex}`, { role: 'member' }, out5);
    assert(row(forCyd).status === 'open' && outDelCand.status === 403 && outDelCand.status === outDelOther.status && outDelCand.error === outDelOther.error
        && outPatchCand.status === 403 && outPatchCand.status === outPatchOther.status && outPatchCand.error === outPatchOther.error,
        `an outsider removing or demoting the candidate is answered as for anyone else (got ${outDelCand.status}/${outDelOther.status}, ${outPatchCand.status}/${outPatchOther.status}: ${outDelCand.error})`);
    const memPatchCand = await signedFetch('PATCH', `/api/groups/${g5}/members/${cv.pubKeyHex}`, { role: 'member' }, ma);
    const memPatchOther = await signedFetch('PATCH', `/api/groups/${g5}/members/${ld.pubKeyHex}`, { role: 'member' }, ma);
    assert(memPatchCand.status === 403 && memPatchCand.status === memPatchOther.status && memPatchCand.error === memPatchOther.error,
        `so is a plain member (got ${memPatchCand.status}/${memPatchOther.status})`);
    const convDelCand = await signedFetch('DELETE', `/api/groups/${g5}/members/${cv.pubKeyHex}`, {}, mb);
    assert(convDelCand.status === 400 && convDelCand.error === GROUP_LEAD_CANDIDATE_HELD && roleOf(g5, cv.pubKeyHex)?.status === 'active',
        `a convenor is still held, over HTTP (got ${convDelCand.status} ${convDelCand.error})`);

    // R3: the 30-day silence vote's candidate is held the same way, while that vote is active.
    const [l7, c7, a7, q7] = ['Lin7', 'Cyd7', 'Ada7', 'Quin7'].map(n => makeMember(n));
    const g7 = makeGroup('Quiet Guild', [{ id: l7, role: 'convenor' }, { id: c7, role: 'convenor' }, { id: a7, role: 'member' }, { id: q7, role: 'member' }]);
    const silenceId = crypto.randomUUID();
    db.prepare(`INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, status, deadline_at)
                VALUES (?, ?, ?, ?, ?, 'active', ?)`).run(silenceId, g7, l7.pubKeyHex, q7.pubKeyHex, a7.pubKeyHex, new Date(Date.now() + 14 * DAY).toISOString());
    let silRemoveErr = '', silDemoteErr = '';
    try { removeGroupMember(g7, c7.pubKeyHex, q7.pubKeyHex); } catch (e: any) { silRemoveErr = e.message; }
    try { setMemberRole(g7, c7.pubKeyHex, q7.pubKeyHex, 'observer'); } catch (e: any) { silDemoteErr = e.message; }
    assert(silRemoveErr === GROUP_LEAD_CANDIDATE_HELD && silDemoteErr === GROUP_LEAD_CANDIDATE_HELD
        && roleOf(g7, q7.pubKeyHex)?.status === 'active' && roleOf(g7, q7.pubKeyHex)?.role === 'member',
        `no convenor can remove or demote the silence vote's candidate (got ${silRemoveErr || 'removed'} / ${silDemoteErr || 'demoted'})`);
    db.prepare("UPDATE group_convenor_proposals SET status = 'cancelled', closed_reason = 'convenor_returned' WHERE id = ?").run(silenceId);
    let silAfterErr = '';
    try { setMemberRole(g7, c7.pubKeyHex, q7.pubKeyHex, 'observer'); } catch (e: any) { silAfterErr = e.message; }
    assert(!silAfterErr && roleOf(g7, q7.pubKeyHex)?.role === 'observer', `once that vote has closed, they change as before (got ${silAfterErr || 'ok'})`);

    // R2: a vote's membership writes stamp the row strictly past its last stamp, as every membership writer does: a row
    // stamped ahead (a clock step, a promoted standby behind the main) must not leave the vote's change behind it.
    const [l8, b8, c8, d8] = ['Lin8', 'Bo8', 'Cy8', 'Dee8'].map(n => makeMember(n));
    const g8 = makeGroup('Stamp Guild', [{ id: l8, role: 'convenor' }, { id: b8, role: 'member' }, { id: c8, role: 'member' }, { id: d8, role: 'member' }]);
    const ahead = new Date(Date.now() + 5 * 60_000).toISOString();
    const stampOf = (pk: string) => (db.prepare('SELECT updated_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g8, pk) as any).updated_at as string;
    for (const k of [b8, c8, d8]) db.prepare('UPDATE group_members SET updated_at = ? WHERE group_id = ? AND member_pubkey = ?').run(ahead, g8, k.pubKeyHex);
    setGroupRoleByVote(g8, b8.pubKeyHex, 'convenor');
    replaceGroupLeadByVote(g8, c8.pubKeyHex);
    removeGroupMemberByVote(g8, d8.pubKeyHex);
    assert(stampOf(b8.pubKeyHex) > ahead && stampOf(c8.pubKeyHex) > ahead && stampOf(d8.pubKeyHex) > ahead
        && roleOf(g8, b8.pubKeyHex)?.role === 'convenor' && roleOf(g8, d8.pubKeyHex)?.status === 'removed',
        `a role vote, a lead vote and a removal by vote each stamp past the row's ${ahead} (got ${stampOf(b8.pubKeyHex)}, ${stampOf(c8.pubKeyHex)}, ${stampOf(d8.pubKeyHex)})`);

    // The candidate suspended mid-vote is off the roll by the time it is carried out: void, and the lead is unchanged.
    const [ld6, cv6, a6, b6, c6] = ['Lin6', 'Cyd6', 'Ada6', 'Bo6', 'Cy6'].map(n => makeMember(n));
    const g6 = makeGroup('Root Guild', [{ id: ld6, role: 'convenor' }, { id: cv6, role: 'convenor' }, { id: a6, role: 'member' }, { id: b6, role: 'member' }, { id: c6, role: 'member' }]);
    const forCy = (await propose(g6, a6, { effect: 'replace_lead_convenor', subject: c6.pubKeyHex, title: 'Cy leads' })).body?.decision?.id as string;
    for (const v of [a6, cv6, b6]) await vote(g6, forCy, v, true);
    setUserStatusRow(c6.pubKeyHex, 'disabled');
    tickDecisions();
    assert(row(forCy).status === 'execution_void' && groupRow(g6).lead_pubkey === ld6.pubKeyHex,
        `a lead candidate suspended mid-vote: void, the lead unchanged (got ${row(forCy).status} ${row(forCy).execution_reason ?? ''})`);
    setUserStatusRow(c6.pubKeyHex, 'active');

    // ── 6. The push when a vote opens: one per elector, never the proposer, a muted member or an observer; names nobody ──
    const [lf, af, bf, cf, of] = ['FLouSecret', 'FAdaSecret', 'FBeaSecret', 'FCySecret', 'FObiSecret'].map(n => makeMember(n));
    const gf = makeGroup('Secret Weavers', [{ id: lf, role: 'convenor' }, { id: af, role: 'member' }, { id: bf, role: 'member' }, { id: cf, role: 'member' }, { id: of, role: 'observer' }]);
    for (const [i, k] of [lf, af, bf, cf, of].entries()) registerPushToken(k.pubKeyHex, `ExponentPushToken[gd-${i}-${k.pubKeyHex.slice(0, 6)}]`, 'android');
    registerPushToken(bf.pubKeyHex, 'ExponentPushToken[gd-bea-second]', 'ios');
    setChatMute(gf, cf.pubKeyHex, 'always');
    expo.length = 0;
    const noticesBefore = (db.prepare("SELECT COUNT(*) AS c FROM push_notices WHERE kind = 'decision.open'").get() as any).c as number;
    const opened = await propose(gf, af, { effect: 'remove_group_member', subject: bf.pubKeyHex, title: 'Remove FBeaSecret for spam', description: 'FBeaSecret keeps posting spam here.' });
    for (let i = 0; i < 40 && expo.length < 3; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 100));
    const tos = expo.map(m => String(m.to));
    assert(opened.status === 200 && expo.length === 3 && tos.some(t => t.includes('gd-0-')) && tos.some(t => t.includes('gd-bea-second'))
        && tos.some(t => t.includes('gd-2-')) && !tos.some(t => /gd-[134]-/.test(t)),
        `the lead and Bea's two phones are told; not the proposer, the member who muted the chat, or the observer (got ${opened.status}, ${expo.length} messages)`);
    const wire = JSON.stringify(expo);
    assert(!/Secret|Weavers|spam/.test(wire) && expo.every(m => m.body === PUSH_NOTICE_KINDS['decision.open'].body),
        `what reaches Expo names nobody, no group and no title (got ${wire.slice(0, 200)})`);
    const notices = db.prepare("SELECT recipient, title, body, data FROM push_notices WHERE kind = 'decision.open'").all().slice(noticesBefore) as any[];
    assert(notices.length === 2 && new Set(notices.map(n => n.recipient)).size === 2 && notices.every(n => !/FBea|spam|FLou|FAda/.test(`${n.title} ${n.body} ${n.data}`)),
        `one stored notice per elector told, naming nobody (got ${notices.length})`);

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A CHAT GROUP CAN VOTE ON ITS LEAD, ITS RULES AND CLOSING.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
