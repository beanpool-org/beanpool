/**
 * What a forum topic links: slice F9's server part, through the real HTTPS stack and its signature middleware
 * (scratch/fable-design/DESIGN-forums-fable.md §4, §10.2 to §10.5, §21 F9 "a link never shows what its reader could not
 * already see"; engine/forum-links.ts holds the rule).
 *
 *  1. Close the class: ONE table over (link kind: group, listing, event, Need, Learn page) x (target state: live, hidden,
 *     removed, private) x (reader: the topic's writer, a member of the group, a member outside it, a moderator outside it, a
 *     member who blocked the thing's maker, a member who blocked the topic's writer, a removed member, a visitor) -> shown
 *     with the thing's id and title, or a placeholder holding its kind alone (no id, no title, no photo), or no topic at all.
 *     The answer's bytes never hold a placeholder's title or id. The same cells drive GET /api/forum/linked: the topic is
 *     named exactly where the link shows, and the answer is the empty list otherwise.
 *  2. Writing: only the topic's writer links; only their own listing and a group they are in; something they cannot see is
 *     refused exactly as an id nobody has; three a topic, the Decision chip's row included; linking twice changes nothing;
 *     its writer or an owner takes one off, nobody else; a removed topic takes its links with it.
 *  3. Make this a Need: the writer's Need linked to the topic reads as a Need its writer made, and the Need's side names the
 *     topic ("Talked about in the forum").
 *  4. A topic in a group's section: its links reach nobody outside the group, nor do the topics that link a thing.
 *  5. The worldwide community: a Learn page cannot be linked (Learn is off there), and the public pages carry no links.
 *  6. A standby refuses a link (503 `standby`) and reads the links from its copy as the main server does.
 *  7. The topics that link one thing are read by an index on (kind, target_id), not a scan (GET /api/forum/linked).
 *
 * Run: mkdir -p .th && TMPDIR=.th SERVER_SUITES_ONLY="test-forum-links" node ../../scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;
delete process.env.NODE_PROFILE_ALLOW_CHANGE_FROM;

import crypto from 'node:crypto';
import { initTls } from './services/tls.js';
import { initStateEngine, seedGenesisMember, grantNodeRole, broadcast, createPost } from './state-engine.js';
import { startHttpsServer } from './https-server.js';
import { db } from './db/db.js';
import { setNodeRole } from './config/node-role.js';
import { setSwitchOverride } from './config/node-profile.js';
import { resetGatewayRateLimit } from './gateway-rate-limit.js';
import { pruneAuthAttempts } from './auth-rate-limit.js';
import { markForumTold, resetForumStartersCheckForTests } from './engine/forum.js';
import { publishKnowledge } from './engine/knowledge.js';
import { signRequest, SIGNED_FOR_HEADER, signedForHost } from './signed-request-test-helper.js';
import { TEST_PHOTO } from './post-test-helper.js';
import { FORUM_LIMITS, forumPublicShapeProblems } from '@beanpool/core';
import { setMemberPhoto } from '@beanpool/engine';

let BASE = '';
let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ ${msg}`);
}
function require_(cond: unknown, msg: string): void {
    assert(cond, msg);
    if (!cond) throw new Error(`setup failed: ${msg}`);
}

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

interface Id { pk: string; priv: crypto.KeyObject; name: string }
function newId(name: string): Id {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    return { pk: (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex'), priv: privateKey, name };
}
let owner: Id;
/** A member who joined 60 days ago (known in the forum), told the forum is public. */
function member(name: string): Id {
    const id = newId(name);
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, invited_by, invite_code, status) VALUES (?, ?, ?, ?, 'TEST', 'active')`)
        .run(id.pk, name, ago(60 * DAY), owner.pk);
    db.prepare('INSERT OR IGNORE INTO accounts (public_key, balance_c, last_demurrage_epoch) VALUES (?, 0, 0)').run(id.pk);
    setMemberPhoto(db, id.pk, 'https://example.com/a.jpg');
    markForumTold(id.pk);
    return id;
}

interface Res { status: number; body: any; text: string; headers: Headers }
async function call(id: Id | null, method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Res> {
    pruneAuthAttempts(Date.now() + 120_000);
    resetGatewayRateLimit();
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const h: Record<string, string> = {};
    if (method !== 'GET') h['Content-Type'] = 'application/json';
    if (id) {
        const ts = Date.now();
        const nonce = crypto.randomBytes(16).toString('hex');
        h['X-Public-Key'] = id.pk;
        h['X-Signature'] = signRequest(id.priv, { method, path: urlPath.split('?')[0], timestamp: ts, nonce, body: raw });
        h[SIGNED_FOR_HEADER] = signedForHost();
        h['X-Timestamp'] = String(ts);
        h['X-Nonce'] = nonce;
    }
    const res = await fetch(`${BASE}${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : raw });
    const text = await res.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    return { status: res.status, body: parsed, text, headers: res.headers };
}
const show = (r: Res | null) => (r ? `${r.status} ${r.text.slice(0, 220)}` : '-');
/** A mark no key, id or other word holds: z and q are not hex. */
const mark = () => `zq${crypto.randomBytes(4).toString('hex').replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)])}`;
/** A new topic; its row then dated two days back, so the many this suite makes never meet the writer's 10 a day. */
async function startTopic(id: Id, body: Record<string, unknown>): Promise<Res> {
    const r = await call(id, 'POST', '/api/forum/topics', body);
    if (r.status === 201) db.prepare('UPDATE forum_topics SET created_at = ? WHERE id = ?').run(ago(2 * DAY), r.body.topic.id);
    return r;
}
const linkTo = (id: Id, topic: string, kind: string, targetId: string, on?: boolean) =>
    call(id, 'POST', `/api/forum/topics/${topic}/links`, on === undefined ? { kind, targetId } : { kind, targetId, on });
const linked = (id: Id | null, kind: string, targetId: string) => call(id, 'GET', `/api/forum/linked?kind=${kind}&id=${encodeURIComponent(targetId)}`);

async function main(): Promise<void> {
    await initTls();
    initStateEngine();
    const port = await startHttpsServer(0);
    BASE = `https://localhost:${port}`;

    owner = newId('Olive');
    seedGenesisMember(owner.pk, 'Olive');
    setMemberPhoto(db, owner.pk, 'https://example.com/o.jpg');
    markForumTold(owner.pk);
    // Wes writes the topics; Eve makes the events and the Learn pages; Gil is in the private group; Nan is not; Mo moderates
    // the forum and is in no group; Bea is in the private group and blocked Eve; Bob blocked Wes; Rex is removed.
    const [wes, eve, gil, nan, mo, bea, bob, rex] = ['Wes', 'Eve', 'Gil', 'Nan', 'Mo', 'Bea', 'Bob', 'Rex'].map((n) => member(n));
    grantNodeRole(mo.pk, 'moderator', owner.pk);
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(bea.pk, eve.pk);
    db.prepare('INSERT INTO member_blocks (owner_pubkey, blocked_pubkey) VALUES (?, ?)').run(bob.pk, wes.pk);
    // Rex: a member the community removed. His key signs nothing here.
    db.prepare("UPDATE members SET status = 'pruned' WHERE public_key = ?").run(rex.pk);

    const PRIV = 'grp-quiet-f9';
    const addGroup = (id: string, name: string, policy: string, members: Id[]) => {
        db.prepare(`INSERT INTO groups (id, name, slug, created_by, lead_pubkey, join_policy) VALUES (?, ?, ?, ?, ?, ?)`).run(id, name, `${id}-slug`, wes.pk, wes.pk, policy);
        members.forEach((m, i) => db.prepare('INSERT INTO group_members (group_id, member_pubkey, role, status, from_epoch) VALUES (?, ?, ?, ?, 1)')
            .run(id, m.pk, i === 0 ? 'convenor' : 'member', 'active'));
    };
    addGroup(PRIV, 'Quiet circle', 'invite_only', [wes, eve, gil, bea]);

    const general = ((await call(wes, 'GET', '/api/forum')).body?.sections ?? []).find((s: any) => s.starter === 'general')?.id as string;
    require_(general, 'the local forum has General');

    // ── 1. The table ────────────────────────────────────────────────────────────────────────────
    console.log('── 1. the table: kind x state x reader ──');
    type Kind = 'group' | 'listing' | 'event' | 'need' | 'learn';
    type State = 'live' | 'hidden' | 'removed' | 'private';
    const soon = Date.now() + 3 * DAY;
    const eventOpts = { eventStartAt: new Date(soon).toISOString(), eventEndAt: new Date(soon + 7200_000).toISOString() };
    const priv = { audienceScope: 'group' as const, targetGroupId: PRIV };
    /** Makes one target for a cell, linkable by Wes; returns its id, its title and what turns it into the cell's state after linking. */
    function makeTarget(kind: Kind, state: State): { id: string; title: string; after: () => void; undo?: () => void } {
        const title = `${kind} ${state} ${mark()}`;
        if (kind === 'group') {
            const id = `grp-${mark()}`;
            addGroup(id, title, state === 'private' ? 'invite_only' : 'open', state === 'private' ? [wes, gil, bea] : [wes]);
            return {
                id, title, after: () => {
                    if (state === 'hidden') db.prepare("INSERT INTO group_closures (group_id, decision_id, closed_at) VALUES (?, 'd-close', ?)").run(id, new Date().toISOString());
                    if (state === 'removed') {
                        db.prepare('DELETE FROM group_members WHERE group_id = ?').run(id);
                        db.prepare('DELETE FROM groups WHERE id = ?').run(id);
                    }
                },
            };
        }
        if (kind === 'learn') {
            if (state === 'private') {
                // A Learn page has no audience of its own: its "private" is Learn switched off, as on the worldwide community.
                const id = publishKnowledge(broadcast, owner.pk, { title, body: 'Bring glass and cans sorted.', topic: 'local-services' }, { writer: eve.pk }).id;
                return { id, title, after: () => setSwitchOverride('knowledge', false), undo: () => setSwitchOverride('knowledge', true) };
            }
            const id = publishKnowledge(broadcast, owner.pk, { title, body: 'Bring glass and cans sorted.', topic: 'local-services' }, { writer: eve.pk }).id;
            return {
                id, title, after: () => {
                    if (state === 'hidden') db.prepare('UPDATE posts SET removed_by_moderator_at = ? WHERE id = ?').run(new Date().toISOString(), id);
                    if (state === 'removed') db.prepare('UPDATE posts SET active = 0 WHERE id = ?').run(id);
                },
            };
        }
        const type = kind === 'need' ? 'need' : kind === 'event' ? 'event' : 'offer';
        const author = kind === 'event' ? eve : wes;
        const post = createPost(type, 'general', title, 'Words about it.', 0, 'fixed', author.pk, -28.5, 153.5, [TEST_PHOTO], false, undefined, false,
            { ...(kind === 'event' ? eventOpts : {}), ...(state === 'private' ? priv : {}) });
        require_(!!post, `${author.name} makes the ${kind} for "${state}"`);
        const id = post!.id;
        return {
            id, title, after: () => {
                if (state === 'hidden') db.prepare('UPDATE posts SET hidden_by_reports_at = ? WHERE id = ?').run(new Date().toISOString(), id);
                if (state === 'removed') db.prepare("UPDATE posts SET active = 0, removed_by_moderator_at = ? WHERE id = ?").run(new Date().toISOString(), id);
            },
        };
    }
    const readers: { name: string; id: Id | null }[] = [
        { name: 'writer', id: wes }, { name: 'group member', id: gil }, { name: 'outside the group', id: nan }, { name: 'moderator', id: mo },
        { name: 'blocked the maker', id: bea }, { name: 'blocked the writer', id: bob }, { name: 'removed member', id: rex }, { name: 'visitor', id: null },
    ];
    /** What the reader should read: shown, a placeholder, or no topic at all. Written from the design, never from the code. */
    function want(kind: Kind, state: State, reader: string): 'shown' | 'placeholder' | 'no topic' {
        if (reader === 'blocked the writer' || reader === 'removed member' || reader === 'visitor') return 'no topic';
        const maker = kind === 'event' || kind === 'learn' ? 'eve' : 'wes';
        // Blocks hold for people's things (listings, events, pages), never for a group.
        if (kind !== 'group' && maker === 'eve' && reader === 'blocked the maker') return 'placeholder';
        const inGroup = reader === 'writer' || reader === 'group member' || reader === 'blocked the maker';
        switch (state) {
            case 'live': return 'shown';
            // Closed by its Decision; hidden by reports (its author alone still reads their own); a page taken down.
            case 'hidden': return (kind === 'listing' || kind === 'need') && reader === 'writer' ? 'shown' : 'placeholder';
            case 'removed': return 'placeholder';
            // An invite-only group, a group's listing or event: its members only. Learn switched off: nobody.
            case 'private': return kind === 'learn' ? 'placeholder' : inGroup ? 'shown' : 'placeholder';
        }
    }
    const KINDS: Kind[] = ['group', 'listing', 'event', 'need', 'learn'];
    const STATES: State[] = ['live', 'hidden', 'removed', 'private'];
    const miss: string[] = [];
    let cells = 0;
    for (const kind of KINDS) {
        for (const state of STATES) {
            const target = makeTarget(kind, state);
            const t = await startTopic(wes, { sectionId: general, title: `About ${kind} ${state}`, words: 'Have a look.' });
            require_(t.status === 201, `Wes starts a topic for ${kind} ${state} (${show(t)})`);
            const T = t.body.topic.id as string;
            const apiKind = kind === 'need' ? 'listing' : kind;
            const made = await linkTo(wes, T, apiKind, target.id);
            require_(made.status === 200 && made.body?.topic?.links?.[0]?.shown === true && made.body.topic.links[0].id === target.id,
                `Wes links the ${kind} (${state}) while he can see it (${show(made)})`);
            target.after();
            for (const r of readers) {
                cells++;
                const expected = want(kind, state, r.name);
                const read = await call(r.id, 'GET', `/api/forum/topics/${T}`);
                const lk = await linked(r.id, apiKind, target.id);
                const links = read.body?.topic?.links as any[] | undefined;
                const named = Array.isArray(lk.body?.topics) && lk.body.topics.some((x: any) => x.id === T);
                let got: string;
                if (read.status !== 200) got = 'no topic';
                else if (links?.length === 1 && links[0].shown === true && links[0].id === target.id && links[0].title === target.title) got = 'shown';
                else if (links?.length === 1 && links[0].shown === false && links[0].kind === apiKind && Object.keys(links[0]).sort().join() === 'kind,shown') got = 'placeholder';
                else got = `odd: ${JSON.stringify(links)}`;
                const leak = expected !== 'shown' && (read.text.includes(target.title) || read.text.includes(target.id) || lk.text.includes(target.title));
                const lookupOk = expected === 'shown' ? lk.status === 200 && named : !named && !lk.text.includes(target.title);
                if (got !== expected || leak || !lookupOk) miss.push(`${kind}/${state}/${r.name}: want ${expected}, got ${got}${leak ? ' LEAK' : ''}${lookupOk ? '' : ` linked=${show(lk)}`}`);
            }
            target.undo?.();
        }
    }
    assert(miss.length === 0,
        `1. (group, listing, event, Need, Learn page) x (live, hidden, removed, private) x (writer, group member, outside, moderator, blocked the maker, blocked the writer, removed, visitor): shown only as each could already see it, else a placeholder with its kind alone, and /api/forum/linked agrees (${cells} cells${miss.length ? `: ${miss.slice(0, 8).join(' | ')}` : ''})`);

    // ── 2. Writing ──────────────────────────────────────────────────────────────────────────────
    console.log('\n── 2. writing ──');
    const open = `grp-open-${mark()}`;
    addGroup(open, 'Garden crew', 'open', [eve]);
    const wesOffer = createPost('offer', 'general', `Spare ladder ${mark()}`, 'Long ladder', 0, 'fixed', wes.pk, -28.5, 153.5, [TEST_PHOTO])!;
    const eveOffer = createPost('offer', 'general', `Eve's spade ${mark()}`, 'A spade', 0, 'fixed', eve.pk, -28.5, 153.5, [TEST_PHOTO])!;
    const eveEvent = createPost('event', 'general', `Working bee ${mark()}`, 'Bring gloves', 0, 'fixed', eve.pk, -28.5, 153.5, [TEST_PHOTO], false, undefined, false, eventOpts)!;
    const quietEvent = createPost('event', 'general', `Quiet meet ${mark()}`, 'Members only', 0, 'fixed', eve.pk, -28.5, 153.5, [TEST_PHOTO], false, undefined, false, { ...eventOpts, ...priv })!;
    const page = publishKnowledge(broadcast, owner.pk, { title: `Tip hours ${mark()}`, body: 'Open Saturdays.', topic: 'local-services' }).id;
    const w = await startTopic(wes, { sectionId: general, title: 'Ladder swap', words: 'Who needs one?' });
    require_(w.status === 201, `Wes starts a topic (${show(w)})`);
    const W = w.body.topic.id as string;
    const notWriter = await linkTo(gil, W, 'event', eveEvent.id);
    assert(notWriter.status === 403 && notWriter.body?.code === 'not_yours', `2. only the topic's writer links (${show(notWriter)})`);
    const othersListing = await linkTo(wes, W, 'listing', eveOffer.id);
    assert(othersListing.status === 403 && othersListing.body?.code === 'not_yours_to_link', `2. only the writer's own listings (${show(othersListing)})`);
    const notInGroup = await linkTo(wes, W, 'group', open);
    assert(notInGroup.status === 403 && notInGroup.body?.code === 'not_yours_to_link', `2. only a group the writer is in (${show(notInGroup)})`);
    const nanTopic = await startTopic(nan, { sectionId: general, title: 'Nan asks', words: 'Anything on?' });
    const N = nanTopic.body?.topic?.id as string;
    const unseen = await linkTo(nan, N, 'event', quietEvent.id);
    const nobody = await linkTo(nan, N, 'event', 'p-nobody-has-this');
    const unseenGroup = await linkTo(nan, N, 'group', PRIV);
    const nobodyGroup = await linkTo(nan, N, 'group', 'grp-nobody-has-this');
    assert(unseen.status === 404 && unseen.body?.code === 'link_not_found' && unseen.text === nobody.text && unseenGroup.text === nobodyGroup.text && unseenGroup.status === 404,
        `2. an event or a group the writer cannot see is refused exactly as an id nobody has (${show(unseen)} / ${show(unseenGroup)})`);
    const badKind = await linkTo(wes, W, 'decision', 'd-1');
    assert(badKind.status === 400, `2. the Decision chip keeps its own route; a kind outside the four is refused (${show(badKind)})`);
    const a = await linkTo(wes, W, 'listing', wesOffer.id);
    const b = await linkTo(wes, W, 'event', eveEvent.id);
    const again = await linkTo(wes, W, 'event', eveEvent.id);
    const c = await linkTo(wes, W, 'learn', page);
    assert(a.status === 200 && b.status === 200 && again.status === 200 && c.status === 200 && c.body?.topic?.links?.length === 3,
        `2. three links, linking one twice changes nothing (${show(c)})`);
    const fourth = await linkTo(wes, W, 'group', PRIV);
    assert(fourth.status === 409 && fourth.body?.code === 'topic_links', `2. a fourth is refused (${show(fourth)})`);
    db.prepare(`INSERT INTO decisions (id, author_pubkey, title, description, touches, effect, franchise, closes_at)
        VALUES ('d-f9', ?, 'Fix the hall', 'Fix it.', 'pool', 'spend', '1m1v', ?)`).run(owner.pk, new Date(Date.now() + 7 * DAY).toISOString());
    const chip = await call(wes, 'POST', `/api/forum/topics/${W}/decision`, { decisionId: 'd-f9' });
    assert(chip.status === 409 && chip.body?.code === 'topic_links', `2. the Decision chip counts among the three (${show(chip)})`);
    const offByOther = await linkTo(gil, W, 'learn', page, false);
    assert(offByOther.status === 403, `2. nobody but its writer, an owner or an admin takes a link off (${show(offByOther)})`);
    // A muted writer links nothing new, and may still take their own off (it says nothing to anyone, as removing a post).
    db.prepare('UPDATE members SET moderation_muted_until = ? WHERE public_key = ?').run(new Date(Date.now() + DAY).toISOString(), wes.pk);
    const mutedOn = await linkTo(wes, W, 'group', PRIV);
    const mutedOff = await linkTo(wes, W, 'learn', page, false);
    const mutedBack = await linkTo(wes, W, 'learn', page);
    db.prepare('UPDATE members SET moderation_muted_until = NULL WHERE public_key = ?').run(wes.pk);
    assert(mutedOn.status === 403 && mutedOn.body?.code === 'moderation_muted' && mutedOff.status === 200 && mutedOff.body?.topic?.links?.length === 2 && mutedBack.status === 403,
        `2. a muted writer adds no link but takes their own off (${show(mutedOn)} / ${show(mutedOff)})`);
    const relink = await linkTo(wes, W, 'learn', page);
    require_(relink.status === 200 && relink.body?.topic?.links?.length === 3, `Wes links the page again once the mute ends (${show(relink)})`);
    const offByOwner = await linkTo(owner, W, 'learn', page, false);
    assert(offByOwner.status === 200 && offByOwner.body?.topic?.links?.length === 2, `2. an owner takes one off (${show(offByOwner)})`);
    const roomAgain = await call(wes, 'POST', `/api/forum/topics/${W}/decision`, { decisionId: 'd-f9' });
    assert(roomAgain.status === 200 && roomAgain.body?.topic?.decision?.id === 'd-f9', `2. with room again the Decision chip goes on (${show(roomAgain)})`);
    const list = await call(gil, 'GET', `/api/forum/topics?section=${general}`);
    assert(list.status === 200 && (list.body?.topics ?? []).every((x: any) => x.links === undefined), '2. a list row carries no links (a topic\'s own read does)');
    // A topic its writer removes (with another's reply, so it stays blanked) takes its links with it.
    const r1 = await call(gil, 'POST', `/api/forum/topics/${W}/replies`, { words: 'I need one.' });
    require_(r1.status === 201, `Gil replies (${show(r1)})`);
    const opening = (await call(wes, 'GET', `/api/forum/topics/${W}`)).body?.posts?.[0]?.id as string;
    const removed = await call(wes, 'POST', `/api/forum/posts/${opening}/remove`);
    const afterRemove = await call(gil, 'GET', `/api/forum/topics/${W}`);
    const rowsLeft = db.prepare("SELECT COUNT(*) FROM forum_links WHERE topic_id = ? AND kind != 'decision'").pluck().get(W) as number;
    assert(removed.status === 200 && afterRemove.body?.topic?.links?.length === 0 && rowsLeft === 0 && !afterRemove.text.includes(wesOffer.title),
        `2. a removed topic takes its links with it (${show(afterRemove)})`);
    const lookupGone = await linked(gil, 'listing', wesOffer.id);
    assert(lookupGone.status === 200 && lookupGone.body?.topics?.length === 0, '2. and the listing no longer names it');

    // ── 3. Make this a Need ─────────────────────────────────────────────────────────────────────
    console.log('\n── 3. Make this a Need ──');
    const ask = await startTopic(wes, { sectionId: general, title: 'Who can fix a mower?', words: 'Mine will not start.' });
    const A = ask.body?.topic?.id as string;
    const need = createPost('need', 'general', 'Who can fix a mower?', 'Mine will not start.', 0, 'fixed', wes.pk, -28.5, 153.5, [TEST_PHOTO])!;
    const asNeed = await linkTo(wes, A, 'listing', need.id);
    const chipNeed = asNeed.body?.topic?.links?.[0];
    assert(asNeed.status === 200 && chipNeed?.shown === true && chipNeed.listingType === 'need' && chipNeed.byWriter === true && typeof chipNeed.photo === 'string',
        `3. the Need its writer made reads as theirs, a Need, with its photo ("Posted as a Need") (${show(asNeed)})`);
    const talked = await linked(nan, 'listing', need.id);
    assert(talked.status === 200 && talked.body?.topics?.length === 1 && talked.body.topics[0].id === A && talked.body.topics[0].title === 'Who can fix a mower?',
        `3. the Need's side names the topic for any member ("Talked about in the forum") (${show(talked)})`);
    const eventChip = (await call(nan, 'GET', `/api/forum/topics/${A}`)).body?.topic?.links?.[0];
    assert(eventChip?.byWriter === true && eventChip.startAt === null, '3. a listing carries no start; byWriter says its writer made it');

    // ── 4. A topic in a group's section ─────────────────────────────────────────────────────────
    console.log('\n── 4. a group\'s section ──');
    const sec = await call(owner, 'POST', '/api/forum/sections', { name: 'Quiet talk', groupId: PRIV });
    require_(sec.status === 201, `an owner makes the private group's section (${show(sec)})`);
    const gs = await startTopic(wes, { sectionId: sec.body.section.id, title: 'Our working bee', words: 'See the event.' });
    const G = gs.body?.topic?.id as string;
    const gl = await linkTo(wes, G, 'event', eveEvent.id);
    require_(gl.status === 200, `Wes links a public event in the group's section (${show(gl)})`);
    const outsider = await call(nan, 'GET', `/api/forum/topics/${G}`);
    const outsiderLookup = await linked(nan, 'event', eveEvent.id);
    const insiderLookup = await linked(gil, 'event', eveEvent.id);
    assert(outsider.status === 404 && !(outsiderLookup.body?.topics ?? []).some((x: any) => x.id === G) && insiderLookup.body?.topics?.some((x: any) => x.id === G),
        `4. outside the group neither the topic nor its link is named; inside it is (${show(outsiderLookup)})`);

    // ── 5. The worldwide community ──────────────────────────────────────────────────────────────
    console.log('\n── 5. the worldwide community ──');
    process.env.NODE_PROFILE = 'global';
    for (const t of ['forum_links', 'forum_post_photos', 'forum_posts', 'forum_topics', 'forum_sections']) db.prepare(`DELETE FROM ${t}`).run();
    db.prepare("DELETE FROM node_config WHERE key = 'forum.startersMade'").run();
    resetForumStartersCheckForTests();
    const skills = ((await call(owner, 'GET', '/api/forum')).body?.sections ?? []).find((s: any) => s.starter === 'skills')?.id as string;
    require_(skills, 'the worldwide forum has Skills & how-to');
    const gt = await startTopic(owner, { sectionId: skills, title: 'Ladders', words: 'Borrow one.' });
    const GT = gt.body?.topic?.id as string;
    const ownerOffer = createPost('offer', 'general', `Olive's ladder ${mark()}`, 'Ladder', 0, 'fixed', owner.pk, -28.5, 153.5, [TEST_PHOTO])!;
    const learnOnGlobal = await linkTo(owner, GT, 'learn', page);
    assert(learnOnGlobal.status === 404 && learnOnGlobal.body?.code === 'link_not_found', `5. Learn is off on the worldwide community: no page links (${show(learnOnGlobal)})`);
    const gLink = await linkTo(owner, GT, 'listing', ownerOffer.id);
    require_(gLink.status === 200, `the owner links their listing (${show(gLink)})`);
    const pub = await call(null, 'GET', `/api/forum/public/topics/${GT}`);
    assert(pub.status === 200 && pub.body?.topic && forumPublicShapeProblems('topic', pub.body.topic).length === 0 && !pub.text.includes(ownerOffer.title) && !pub.text.includes(ownerOffer.id),
        `5. the public pages carry no links (${show(pub)})`);
    const plain = await call(null, 'GET', `/forum/t/${GT}`);
    assert(plain.status === 200 && !plain.text.includes(ownerOffer.title), '5. nor does the plain page');
    delete process.env.NODE_PROFILE;

    // ── 6. A standby ────────────────────────────────────────────────────────────────────────────
    console.log('\n── 6. a standby ──');
    setNodeRole('backup');
    const onStandby = await linkTo(owner, GT, 'listing', ownerOffer.id, false);
    const readStandby = await call(owner, 'GET', `/api/forum/topics/${GT}`);
    setNodeRole('primary');
    assert(onStandby.status === 503 && onStandby.body?.code === 'standby', `6. a standby refuses a link (${show(onStandby)})`);
    assert(readStandby.status === 200 && readStandby.body?.topic?.links?.[0]?.id === ownerOffer.id, '6. and reads the links from its copy as the main server does');
    assert(FORUM_LIMITS.topicLinks === 3, 'three things a topic (core)');

    // ── 7. The topics that link one thing are found by their target ────────────────────────────
    // "Talked about in the forum" reads GET /api/forum/linked on every listing page: by an index on (kind, target_id), never
    // a scan of every topic's links (deciding review of #3237).
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT topic_id FROM forum_links WHERE kind = ? AND target_id = ?`).all('listing', 'x') as { detail: string }[])
        .map((r) => r.detail).join(' | ');
    assert(/USING (COVERING )?INDEX idx_forum_links_target/.test(plan), `7. the linked topics are read by idx_forum_links_target (${plan})`);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    console.log('⭐️ A forum link never shows its reader anything they could not already see.');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
