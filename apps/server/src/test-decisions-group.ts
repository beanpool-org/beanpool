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
 *
 * Local only — it talks to the server it starts on localhost and nothing else.
 */

// Self-signed cert in LAN mode → relax TLS verification for the test client only.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, tickDecisions, removeGroupMember, joinGroup, postGroupThreadMessage, createPost, GROUP_CLOSED } from './state-engine.js';
import { GROUP_CLOSED_TO_POSTS } from './engine/posts.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { GROUP_NOT_ON_ROLL, GROUP_OBSERVER_NO_VOTE, GROUP_CLOSED_VOID, GROUP_ALREADY_VOTED } from './decisions-engine.js';

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

type Signed = { status: number; body: any; error?: string; replay: () => Promise<{ status: number; body: any }> };

/** The replay-proof scheme the real middleware requires: method + path (without its query) + timestamp + nonce + body. */
async function signedFetch(method: 'GET' | 'POST', path: string, body: unknown, id: Id | null): Promise<Signed> {
    const bodyString = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const headers: Record<string, string> = {};
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
        return { status: res.status, body: json };
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
    let joinErr = '';
    try { joinGroup(g3, outsider.pubKeyHex); } catch (e: any) { joinErr = e.message; }
    assert(joinErr === GROUP_CLOSED, `a closed group takes nobody new (got ${joinErr})`);
    let postErr = '';
    try { postGroupThreadMessage(g3, p.pubKeyHex, { text: 'hello' } as any); } catch (e: any) { postErr = e.message; }
    assert(postErr === GROUP_CLOSED, `a closed group takes no new chat line (got ${postErr})`);
    // No new post of any kind: an offer, a need, a poll or an event, from the engine or over HTTP (#1777 review B2).
    for (const k of [q, r]) db.prepare("UPDATE members SET avatar_ref = 'test-photo' WHERE public_key = ?").run(k.pubKeyHex);
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
    const yours = await signedFetch('GET', '/api/your-groups', null, r);
    const items: any[] = Array.isArray(yours.body) ? yours.body : (yours.body?.chats ?? yours.body?.items ?? yours.body?.groups ?? []);
    const mine3 = items.find(i => i.id === g3);
    assert(yours.status === 200 && !!mine3?.closedAt && mine3.readOnly === true,
        `"Your groups" shows the closed group as closed (got ${JSON.stringify(mine3 ? { closedAt: mine3.closedAt, readOnly: mine3.readOnly } : yours.body)?.slice(0, 200)})`);
    const open3 = items.find(i => i.id === g1);
    assert(!items.some(i => i.id === g1) || !open3?.closedAt, 'an open group is not shown closed');

    console.log(`\n${passed}/${run} checks passed.`);
    if (passed !== run) throw new Error(`${run - passed} check(s) failed`);
    console.log('⭐️ A CHAT GROUP CAN VOTE ON ITS LEAD, ITS RULES AND CLOSING.');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
