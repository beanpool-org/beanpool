/**
 * Only people who were in a group before its lead went quiet can vote in a new lead (Marty, board card
 * group-lead-vote-global, 2026-09-28, on every node). On a node anyone can join with a sign-in account, one person
 * with several accounts could otherwise join an abandoned open group and vote themselves in.
 *
 * The rule (engine/group-succession.ts): a member takes part only if their membership began by the end of the UTC day
 * of the lead's last activity, and a convenor only if they became one by then. Everyone else is not in the vote at
 * all — they can't propose, stand or vote, and they aren't counted in its size, so they can neither carry nor block it.
 *
 * Every step goes over HTTP through the real signature middleware.
 *
 *  1. The members' vote: members who joined before the lead went quiet propose, vote and decide it. A member who
 *     joined after, and ten more new accounts, can't propose, stand or vote (refused), aren't counted, and the vote
 *     closes early on the members who were there, with the chat saying who votes.
 *  2. The convenors' vote: convenors appointed after the lead went quiet — someone in the group from before, and a
 *     newcomer — can't propose, stand or vote and aren't counted.
 *  3. When every convenor but the lead was appointed after the silence, it is the members' vote.
 *  4. Leaving and joining again after the silence starts a new membership: that member no longer takes part.
 *  5. A re-key after the silence keeps the membership's time: the member's new key takes part.
 *  6. A group where nobody was there before the lead went quiet: no vote can open, and the node says why.
 *  7. Proposals from before this rule: the rule applies at their next count. One whose candidate came later closes
 *     with a line in the chat saying why; one whose proposer came later runs on, counting only the members who
 *     were there.
 *  8. Unchanged: 14 days, settled at the deadline; the lead coming back cancels the vote.
 *  9. The day, not the instant: someone the lead let in with their last act, later on that same day, takes part;
 *     someone who joined the next day does not; everyone, the lead included, is served the same day.
 *
 *   BEANPOOL_DATA_DIR=$(mktemp -d) pnpm exec tsx apps/server/src/test-groups-succession-electorate.ts
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.ENFORCE_READ_AUTH;
delete process.env.ENFORCE_WS_AUTH;
delete process.env.NODE_PROFILE;
process.env.ADMIN_PASSWORD = 'ElectoratePass123!';

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, createGroup, joinGroup, setMemberRole, seedGenesisMember, tickGroupSuccession, GROUP_SUCCESSION_WINDOW_MS } from './state-engine.js';
import { issueRekeyCode } from './engine/member-wizards.js';
import { startHttpsServer } from './https-server.js';
import { initAdminPassword } from './config/local-config.js';
import { db } from './db/db.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

let BASE = '';
const DAY = 24 * 60 * 60 * 1000;
const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Id = { pk: string; privateKey: crypto.KeyObject; callsign: string };

function keypair(callsign: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'), privateKey, callsign };
}

function makeMember(callsign: string): Id {
    const id = keypair(callsign);
    db.prepare(
        `INSERT INTO members (public_key, callsign, joined_at, avatar_url, status, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    ).run(id.pk, callsign, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(id.pk);
    return id;
}

async function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, id: Id, body?: unknown) {
    const bodyString = body === undefined ? '' : JSON.stringify(body);
    const ts = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const canonical = `${method}\n${path.split('?')[0]}\n${ts}\n${nonce}\n${bodyString}`;
    const headers: Record<string, string> = {
        'X-Public-Key': id.pk,
        'X-Signature': crypto.sign(null, Buffer.from(canonical), id.privateKey).toString('base64'),
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? bodyString : undefined });
    let json: any; try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
}
const show = (r: { status: number; body: any }) => `${r.status} ${JSON.stringify(r.body)?.slice(0, 300)}`;

/** These people have been in the group, in the roles they hold, since `at`. */
function since(groupId: string, who: Id[], at: string): void {
    // A node from before this change has no role_since; the fixtures still run there, so the suite shows what it fails on.
    const hasRoleSince = (db.prepare('PRAGMA table_info(group_members)').all() as { name: string }[]).some(c => c.name === 'role_since');
    for (const p of who) {
        db.prepare('UPDATE group_members SET joined_at = ? WHERE group_id = ? AND member_pubkey = ?').run(at, groupId, p.pk);
        if (hasRoleSince) db.prepare('UPDATE group_members SET role_since = ? WHERE group_id = ? AND member_pubkey = ?').run(at, groupId, p.pk);
    }
}
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();
/** The lead's last activity on the node, `at`. */
function quietSince(lead: Id, at: string): void {
    db.prepare('UPDATE members SET last_active_at = ?, joined_at = ? WHERE public_key = ?').run(at, at, lead.pk);
}
const utcMidnight = (iso: string) => new Date(Math.floor(Date.parse(iso) / DAY) * DAY).toISOString();
const dayText = (iso: string) => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const role = (g: string, p: Id) => (db.prepare('SELECT role FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, p.pk) as any)?.role;
const leadOf = (g: string) => (db.prepare('SELECT lead_pubkey FROM groups WHERE id = ?').get(g) as any)?.lead_pubkey;
const proposalsIn = (g: string) => (db.prepare('SELECT COUNT(*) AS n FROM group_convenor_proposals WHERE group_id = ?').get(g) as any).n as number;
const ballotsBy = (who: Id[]) => who.reduce((n, p) => n + ((db.prepare('SELECT COUNT(*) AS n FROM group_convenor_votes WHERE voter_pubkey = ?').get(p.pk) as any).n as number), 0);
const lastLine = (g: string) => (db.prepare("SELECT ciphertext FROM messages WHERE conversation_id = ? AND type = 'system' ORDER BY rowid DESC LIMIT 1").get(g) as any)?.ciphertext ?? '';
const sameSet = (a: unknown, b: Id[]) => Array.isArray(a) && a.length === b.length && b.every(p => a.includes(p.pk));

function groupOf(name: string, lead: Id, members: Id[]): string {
    const g = createGroup({ name, createdBy: lead.pk, joinPolicy: 'open' } as any).id;
    for (const m of members) joinGroup(g, m.pk);
    return g;
}

async function main(): Promise<void> {
    console.log('Only people who were in a group before its lead went quiet vote in a new lead\n');
    initAdminPassword();
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;
    const founder = keypair('FounderEL');
    seedGenesisMember(founder.pk, founder.callsign);

    // ── 1. The members' vote ─────────────────────────────────────────────────────────────────────
    console.log('── 1. The members who were there decide it; a newcomer and a crowd of new accounts change nothing');
    {
        const lark = makeMember('Lark'); const ash = makeMember('Ash'); const bay = makeMember('Bay'); const cove = makeMember('Cove');
        const g = groupOf('Tool library EL', lark, [ash, bay, cove]);
        since(g, [lark, ash, bay, cove], daysAgo(60));
        const quietAt = daysAgo(40);
        quietSince(lark, quietAt);
        const by = dayText(quietAt);

        const late = makeMember('Late');
        const joined = await call('POST', `/api/groups/${g}/join`, late);
        const crowd = Array.from({ length: 10 }, (_, i) => makeMember(`Crowd${i}`));
        const crowdJoins = await Promise.all(crowd.map(p => call('POST', `/api/groups/${g}/join`, p)));
        assert(joined.status === 200 && crowdJoins.every(r => r.status === 200),
            `setup: a member and ten new accounts join the open group after its lead went quiet (${show(joined)})`);

        const seen = await call('GET', `/api/groups/${g}/succession`, ash);
        const s = seen.body?.silence;
        assert(seen.status === 200 && s?.isEligible === true && s?.electorate === 'members' && seen.body?.canPropose === true,
            `a member from before can propose (${show(seen)})`);
        assert(s?.votersJoinedBy === utcMidnight(quietAt), `the node says who votes: members who joined by the lead's last active day (${s?.votersJoinedBy})`);
        assert(sameSet(seen.body?.voters, [ash, bay, cove]), `the voters are Ash, Bay and Cove, and none of the eleven who came later (${seen.body?.voters?.length})`);
        const lateView = await call('GET', `/api/groups/${g}/succession`, late);
        assert(lateView.status === 200 && lateView.body?.canPropose === false, `the newcomer is offered no proposal (${show(lateView)})`);

        const lateProposes = await call('POST', `/api/groups/${g}/succession/propose`, late, { candidatePubkey: late.pk });
        assert(lateProposes.status === 403 && new RegExp(`Only members who were in the group by ${esc(by)} can propose`).test(lateProposes.body?.error ?? ''),
            `the newcomer can't propose, and is told why (${show(lateProposes)})`);
        const crowdProposes = await call('POST', `/api/groups/${g}/succession/propose`, crowd[0], { candidatePubkey: ash.pk });
        assert(crowdProposes.status === 403 && proposalsIn(g) === 0, `nor can any of the crowd (${show(crowdProposes)})`);
        const lateStands = await call('POST', `/api/groups/${g}/succession/propose`, ash, { candidatePubkey: late.pk });
        assert(lateStands.status === 400 && new RegExp(`candidate must be one of the members who were in the group by ${esc(by)}`).test(lateStands.body?.error ?? '')
            && proposalsIn(g) === 0, `nor stand as the candidate (${show(lateStands)})`);

        const opened = await call('POST', `/api/groups/${g}/succession/propose`, ash, { candidatePubkey: bay.pk });
        const p = opened.body?.proposal;
        assert(opened.status === 200 && p?.status === 'active' && p?.yesCount === 1 && p?.electorateSize === 3,
            `Ash proposes Bay: 3 may vote, not 14 (${show(opened)})`);
        assert(new RegExp(`Members who were in the group by ${esc(by)} have 14 days to vote; convenors appointed after ${esc(by)} have no vote\\.`).test(lastLine(g)), `the chat says who votes (${lastLine(g)})`);

        const lateVotes = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, late, { choice: 'no' });
        assert(lateVotes.status === 403 && new RegExp(`Only members who were in the group by ${esc(by)} can vote`).test(lateVotes.body?.error ?? ''),
            `the newcomer can't vote (${show(lateVotes)})`);
        const crowdVotes = await Promise.all(crowd.map(c => call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, c, { choice: 'no' })));
        assert(crowdVotes.every(r => r.status === 403) && ballotsBy([late, ...crowd]) === 0, 'nor can the crowd, and no ballot of theirs is kept');

        const coveNo = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, cove, { choice: 'no' });
        assert(coveNo.status === 200 && coveNo.body?.proposal?.status === 'active' && coveNo.body?.proposal?.electorateSize === 3,
            `Cove says no: 1 yes, 1 no, Bay still to answer (${show(coveNo)})`);
        const bayYes = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, bay, { choice: 'yes' });
        assert(bayYes.status === 200 && bayYes.body?.executed === true && leadOf(g) === bay.pk && role(g, lark) === 'member',
            `Bay's yes settles it at once — the eleven who came later are nobody it waits for (${show(bayYes)})`);
        assert(/Members chose Bay as lead convenor \(2 yes, 1 no\)/.test(lastLine(g)), `and the chat says so (${lastLine(g)})`);
    }

    // ── 2. The convenors' vote ───────────────────────────────────────────────────────────────────
    console.log('\n── 2. Convenors appointed after the lead went quiet take no part');
    {
        const lumen = makeMember('Lumen'); const cedar = makeMember('Cedar'); const clay = makeMember('Clay'); const moss = makeMember('Moss');
        const g = groupOf('Seed bank EL', lumen, [cedar, clay, moss]);
        setMemberRole(g, lumen.pk, cedar.pk, 'convenor');
        setMemberRole(g, lumen.pk, clay.pk, 'convenor');
        since(g, [lumen, cedar, clay, moss], daysAgo(60));
        const quietAt = daysAgo(40);
        quietSince(lumen, quietAt);
        const by = dayText(quietAt);
        const newt = makeMember('Newt');
        await call('POST', `/api/groups/${g}/join`, newt);
        // Cedar makes two more convenors after the lead went quiet: Moss, in the group from before, and Newt, new.
        const mossUp = await call('PATCH', `/api/groups/${g}/members/${moss.pk}`, cedar, { role: 'convenor' });
        const newtUp = await call('PATCH', `/api/groups/${g}/members/${newt.pk}`, cedar, { role: 'convenor' });
        assert(mossUp.status === 200 && newtUp.status === 200 && role(g, moss) === 'convenor' && role(g, newt) === 'convenor',
            `setup: Cedar makes Moss and Newt convenors after the lead went quiet (${show(mossUp)}, ${show(newtUp)})`);

        const seen = await call('GET', `/api/groups/${g}/succession`, moss);
        assert(seen.body?.silence?.electorate === 'convenors' && sameSet(seen.body?.voters, [cedar, clay]) && seen.body?.canPropose === false,
            `only Cedar and Clay vote; Moss is offered no proposal (${show(seen)})`);
        const mossProposes = await call('POST', `/api/groups/${g}/succession/propose`, moss, { candidatePubkey: moss.pk });
        assert(mossProposes.status === 403 && new RegExp(`Only convenors appointed by ${esc(by)} can propose`).test(mossProposes.body?.error ?? ''),
            `a convenor appointed since can't propose (${show(mossProposes)})`);
        const newtProposes = await call('POST', `/api/groups/${g}/succession/propose`, newt, { candidatePubkey: newt.pk });
        assert(newtProposes.status === 403 && proposalsIn(g) === 0, `nor can a newcomer made a convenor (${show(newtProposes)})`);
        const mossStands = await call('POST', `/api/groups/${g}/succession/propose`, cedar, { candidatePubkey: moss.pk });
        assert(mossStands.status === 400 && new RegExp(`candidate must be one of the convenors appointed by ${esc(by)}`).test(mossStands.body?.error ?? ''),
            `nor stand (${show(mossStands)})`);

        const opened = await call('POST', `/api/groups/${g}/succession/propose`, cedar, { candidatePubkey: clay.pk });
        const p = opened.body?.proposal;
        assert(opened.status === 200 && p?.electorateSize === 2, `Cedar proposes Clay: 2 may vote, not 4 (${show(opened)})`);
        assert(new RegExp(`The other convenors appointed by ${esc(by)} have 14 days to vote`).test(lastLine(g)), `the chat says who votes (${lastLine(g)})`);
        const mossVotes = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, moss, { choice: 'no' });
        const newtVotes = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, newt, { choice: 'no' });
        assert(mossVotes.status === 403 && newtVotes.status === 403 && ballotsBy([moss, newt]) === 0, `neither can vote (${show(mossVotes)})`);
        const clayYes = await call('POST', `/api/groups/${g}/succession/${p?.id}/vote`, clay, { choice: 'yes' });
        assert(clayYes.body?.executed === true && leadOf(g) === clay.pk && role(g, lumen) === 'convenor',
            `Clay's yes carries it, 2 of 2; the old lead stays a convenor (${show(clayYes)})`);
        assert(/Convenors chose Clay as lead convenor \(2 yes, 0 no\)/.test(lastLine(g)), `the chat says so (${lastLine(g)})`);
    }

    // ── 3. Only late convenors: the members vote ─────────────────────────────────────────────────
    console.log('\n── 3. Every other convenor appointed after the silence: it is the members\' vote');
    {
        const lotus = makeMember('Lotus'); const quill = makeMember('Quill'); const pine = makeMember('Pine'); const reed = makeMember('Reed');
        const g = groupOf('Choir EL', lotus, [quill, pine, reed]);
        setMemberRole(g, lotus.pk, quill.pk, 'convenor');
        since(g, [lotus, quill, pine, reed], daysAgo(60));
        const quietAt = daysAgo(40);
        quietSince(lotus, quietAt);
        const pineUp = await call('PATCH', `/api/groups/${g}/members/${pine.pk}`, quill, { role: 'convenor' });
        const quillLeaves = await call('DELETE', `/api/groups/${g}/members/${quill.pk}`, quill);
        assert(pineUp.status === 200 && quillLeaves.status === 200 && role(g, pine) === 'convenor' && !role(g, quill),
            `setup: Quill makes Pine a convenor after the lead went quiet, then leaves (${show(pineUp)}, ${show(quillLeaves)})`);
        const seen = await call('GET', `/api/groups/${g}/succession`, reed);
        assert(seen.body?.silence?.electorate === 'members' && sameSet(seen.body?.voters, [reed]) && seen.body?.canPropose === true,
            `the members vote — Reed — and Pine, a convenor since, does not (${show(seen)})`);
        const pineProposes = await call('POST', `/api/groups/${g}/succession/propose`, pine, { candidatePubkey: pine.pk });
        assert(pineProposes.status === 403 && new RegExp(`Only members who were in the group by ${esc(dayText(quietAt))} can propose a new lead convenor; convenors appointed after ${esc(dayText(quietAt))} can't`).test(pineProposes.body?.error ?? ''),
            `Pine can't propose (${show(pineProposes)})`);
        const reedOffers = await call('POST', `/api/groups/${g}/succession/propose`, reed, { candidatePubkey: reed.pk });
        assert(reedOffers.body?.executed === true && leadOf(g) === reed.pk && role(g, lotus) === 'member' && role(g, pine) === 'convenor',
            `Reed offers and, the only voter, carries it; the silent lead becomes a member (${show(reedOffers)})`);
    }

    // ── 4. Leave and rejoin ──────────────────────────────────────────────────────────────────────
    console.log('\n── 4. Leaving and joining again after the silence is a new membership');
    {
        const lynx = makeMember('Lynx'); const alder = makeMember('Alder'); const birch = makeMember('Birch'); const cress = makeMember('Cress');
        const g = groupOf('Knitters EL', lynx, [alder, birch, cress]);
        since(g, [lynx, alder, birch, cress], daysAgo(60));
        const quietAt = daysAgo(40);
        quietSince(lynx, quietAt);
        const left = await call('DELETE', `/api/groups/${g}/members/${alder.pk}`, alder);
        const back = await call('POST', `/api/groups/${g}/join`, alder);
        const joinedAt = (db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, alder.pk) as any)?.joined_at;
        assert(left.status === 200 && back.status === 200 && Date.parse(joinedAt) > Date.now() - DAY,
            `setup: Alder leaves and joins again; the membership starts now (${joinedAt})`);
        const seen = await call('GET', `/api/groups/${g}/succession`, birch);
        assert(sameSet(seen.body?.voters, [birch, cress]), `Birch and Cress vote; Alder, back since, does not (${seen.body?.voters?.length})`);
        const alderProposes = await call('POST', `/api/groups/${g}/succession/propose`, alder, { candidatePubkey: alder.pk });
        assert(alderProposes.status === 403 && /were in the group by/.test(alderProposes.body?.error ?? ''), `Alder can't propose (${show(alderProposes)})`);
    }

    // ── 5. A re-key keeps the membership's time ──────────────────────────────────────────────────
    console.log('\n── 5. A member who re-keys after the silence still takes part, on the new key');
    {
        const lyre = makeMember('Lyre'); const kestrel = makeMember('Kestrel'); const marram = makeMember('Marram');
        const g = groupOf('Bee club EL', lyre, [kestrel, marram]);
        since(g, [lyre, kestrel, marram], daysAgo(60));
        quietSince(lyre, daysAgo(40));
        const before = (db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, kestrel.pk) as any)?.joined_at;
        const rekey = issueRekeyCode(kestrel.pk, founder.pk);
        const newPhone = keypair('Kestrel');
        const proof = crypto.sign(null, Buffer.from(rekey.code), newPhone.privateKey).toString('base64');
        const done = await call('POST', '/api/member/re-enroll', newPhone, { code: rekey.code, newPublicKey: newPhone.pk, signature: proof });
        const after = (db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND member_pubkey = ?').get(g, newPhone.pk) as any)?.joined_at;
        assert(done.status === 200 && after === before, `setup: Kestrel re-keys; the membership moves to the new key with its time (${show(done)}, ${after})`);
        const seen = await call('GET', `/api/groups/${g}/succession`, newPhone);
        assert(seen.body?.canPropose === true && sameSet(seen.body?.voters, [newPhone, marram]), `the new key takes part (${show(seen)})`);
        const opened = await call('POST', `/api/groups/${g}/succession/propose`, newPhone, { candidatePubkey: marram.pk });
        const yes = await call('POST', `/api/groups/${g}/succession/${opened.body?.proposal?.id}/vote`, marram, { choice: 'yes' });
        assert(opened.status === 200 && yes.body?.executed === true && leadOf(g) === marram.pk, `proposes, and the vote carries (${show(yes)})`);
    }

    // ── 6. Nobody was there before ───────────────────────────────────────────────────────────────
    console.log('\n── 6. A group where nobody was there before the lead went quiet');
    {
        const loom = makeMember('Loom'); const yarrow = makeMember('Yarrow'); const zinnia = makeMember('Zinnia');
        const g = groupOf('Cyclists EL', loom, [yarrow, zinnia]);
        const quietAt = daysAgo(40);
        quietSince(loom, quietAt);
        const seen = await call('GET', `/api/groups/${g}/succession`, yarrow);
        const s = seen.body?.silence;
        assert(seen.status === 200 && s?.isSilent === true && s?.isEligible === false && seen.body?.canPropose === false
            && Array.isArray(seen.body?.voters) && seen.body.voters.length === 0 && s?.votersJoinedBy === utcMidnight(quietAt),
            `the lead is quiet, nobody may vote, and the node serves the day that explains it (${show(seen)})`);
        const tries = await call('POST', `/api/groups/${g}/succession/propose`, yarrow, { candidatePubkey: yarrow.pk });
        assert(tries.status === 400 && new RegExp(`Nobody else in this group can vote on its lead convenor: only members who were in the group by ${esc(dayText(quietAt))} can, and there are none; convenors appointed after ${esc(dayText(quietAt))} can't`).test(tries.body?.error ?? '')
            && proposalsIn(g) === 0, `no vote can open, and the refusal says why in plain words (${show(tries)})`);
    }

    // ── 7. Proposals from before this rule ───────────────────────────────────────────────────────
    console.log('\n── 7. A proposal from before the rule is counted by it');
    {
        const lark2 = makeMember('Lapwing'); const old1 = makeMember('Oak'); const old2 = makeMember('Olive');
        const g = groupOf('Walkers EL', lark2, [old1, old2]);
        since(g, [lark2, old1, old2], daysAgo(60));
        quietSince(lark2, daysAgo(40));
        const late1 = makeMember('Larch'); const late2 = makeMember('Linden');
        joinGroup(g, late1.pk); joinGroup(g, late2.pk);
        // As the old rule allowed: Larch, who joined after the silence, proposed Linden, who did too.
        const legacy = (id: string, candidate: Id, proposer: Id) => {
            const now = new Date().toISOString();
            db.prepare(`INSERT INTO group_convenor_proposals (id, group_id, convenor_pubkey, candidate_pubkey, proposer_pubkey, status, created_at, deadline_at)
                        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(id, g, lark2.pk, candidate.pk, proposer.pk, now, new Date(Date.now() + GROUP_SUCCESSION_WINDOW_MS).toISOString());
            db.prepare("INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, 'yes', ?)").run(id, proposer.pk, now);
        };
        const p1 = crypto.randomUUID();
        legacy(p1, late2, late1);
        const seen = await call('GET', `/api/groups/${g}/succession`, old1);
        const closed = seen.body?.proposals?.find((x: any) => x.id === p1);
        assert(closed?.status === 'cancelled' && closed?.closedReason === 'candidate_ineligible',
            `its candidate came later: it closes at the next count (${JSON.stringify(closed)})`);
        assert(/The vote to make Linden convenor closed: the person proposed can't be chosen: only members who were in the group by .+ can be; convenors appointed after .+ can't\./.test(lastLine(g)),
            `with a line in the chat saying why (${lastLine(g)})`);

        const p2 = crypto.randomUUID();
        legacy(p2, old2, late1);
        db.prepare("INSERT INTO group_convenor_votes (proposal_id, voter_pubkey, choice, voted_at) VALUES (?, ?, 'no', ?)").run(p2, late2.pk, new Date().toISOString());
        const view2 = (await call('GET', `/api/groups/${g}/succession`, old1)).body?.proposals?.find((x: any) => x.id === p2);
        assert(view2?.status === 'active' && view2?.yesCount === 0 && view2?.noCount === 0 && view2?.electorateSize === 2 && view2?.canVote === true,
            `one whose candidate was there runs on: the ballots of the two who came later don't count, and 2 may vote (${JSON.stringify(view2)})`);
        const oakYes = await call('POST', `/api/groups/${g}/succession/${p2}/vote`, old1, { choice: 'yes' });
        assert(oakYes.body?.proposal?.status === 'active' && oakYes.body?.proposal?.yesCount === 1, `Oak's yes: 1 of 2 (${show(oakYes)})`);
        const oliveYes = await call('POST', `/api/groups/${g}/succession/${p2}/vote`, old2, { choice: 'yes' });
        assert(oliveYes.body?.executed === true && leadOf(g) === old2.pk, `Olive's yes carries it (${show(oliveYes)})`);
    }

    // ── 8. The rest of the vote, unchanged ───────────────────────────────────────────────────────
    console.log('\n── 8. 14 days, the deadline, and the lead coming back');
    {
        const lead = makeMember('Lichen'); const d1 = makeMember('Dune'); const d2 = makeMember('Dell'); const d3 = makeMember('Dart');
        const g = groupOf('Repair cafe EL', lead, [d1, d2, d3]);
        since(g, [lead, d1, d2, d3], daysAgo(60));
        quietSince(lead, daysAgo(40));
        const opened = await call('POST', `/api/groups/${g}/succession/propose`, d1, { candidatePubkey: d2.pk });
        const p = opened.body?.proposal;
        const window = Date.parse(p?.deadlineAt) - Date.parse(p?.createdAt);
        assert(opened.status === 200 && Math.abs(window - 14 * DAY) < 1000, `the vote runs 14 days (${show(opened)})`);
        tickGroupSuccession(Date.now() + 13 * DAY);
        const status = () => (db.prepare('SELECT status, closed_reason FROM group_convenor_proposals WHERE id = ?').get(p?.id) as any);
        assert(status()?.status === 'active', 'a day before the deadline it is still open');
        tickGroupSuccession(Date.now() + GROUP_SUCCESSION_WINDOW_MS + 1000);
        assert(status()?.status === 'passed' && leadOf(g) === d2.pk, 'at the deadline, 1 yes and nobody else answering: it passes');

        const lead2 = makeMember('Lupin'); const e1 = makeMember('Elm'); const e2 = makeMember('Ember'); const e3 = makeMember('Esker');
        const g2 = groupOf('Book club EL', lead2, [e1, e2, e3]);
        since(g2, [lead2, e1, e2, e3], daysAgo(60));
        quietSince(lead2, daysAgo(40));
        const opened2 = await call('POST', `/api/groups/${g2}/succession/propose`, e1, { candidatePubkey: e2.pk });
        const back = await call('POST', `/api/groups/${g2}/chat/message`, lead2, { text: 'Sorry, I was away' });
        const view = await call('GET', `/api/groups/${g2}/succession`, e1);
        const p2 = view.body?.proposals?.find((x: any) => x.id === opened2.body?.proposal?.id);
        assert(opened2.status === 200 && back.status === 201 && p2?.status === 'cancelled' && p2?.closedReason === 'convenor_returned',
            `the lead writing in the group's chat cancels the vote (${show(back)}, ${JSON.stringify(p2)})`);
    }

    // ── 9. The day, not the instant ──────────────────────────────────────────────────────────────
    console.log('\n── 9. Anyone in by the end of the lead\'s last active day takes part');
    {
        const lead = makeMember('Larkspur'); const f1 = makeMember('Fern'); const f2 = makeMember('Flax'); const f3 = makeMember('Fig');
        const g = groupOf('Pottery EL', lead, [f1, f2, f3]);
        since(g, [lead], daysAgo(60));
        const day = utcMidnight(daysAgo(40));
        const lastAct = new Date(Date.parse(day) + 10 * 3_600_000).toISOString();          // 10:00 that day
        quietSince(lead, lastAct);
        since(g, [f1], new Date(Date.parse(lastAct) + 5).toISOString());                   // the lead's last act let Fern in
        since(g, [f2], new Date(Date.parse(day) + DAY - 1).toISOString());                // 23:59:59.999 that day
        since(g, [f3], new Date(Date.parse(day) + DAY).toISOString());                    // midnight: the next day
        const seen = await call('GET', `/api/groups/${g}/succession`, f1);
        assert(sameSet(seen.body?.voters, [f1, f2]) && seen.body?.silence?.votersJoinedBy === day,
            `Fern (let in by the lead's last act) and Flax (later that day) vote; Fig, the next day, does not (${JSON.stringify(seen.body?.voters)})`);
        const leadsOwn = await call('GET', `/api/groups/${g}/succession`, lead);
        assert(leadsOwn.body?.silence?.votersJoinedBy === day && leadsOwn.body?.silence?.lastActiveAt === lastAct
            && seen.body?.silence?.lastActiveAt === day,
            `the lead is served the same day, and the exact time only as their own (${leadsOwn.body?.silence?.lastActiveAt}, ${seen.body?.silence?.lastActiveAt})`);
    }

    console.log(`\n${passed}/${run} passed`);
    process.exit(passed === run ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
