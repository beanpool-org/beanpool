/**
 * OWNER-ADMIN-LIMITS (Marty, 31 Oct, with Damo, an owner on global refused a 6th upcoming gig: "make it the same as the posts
 * limits setting"): for a member whose node role is owner or admin NOW, every content-creation limit is the owners' "Owner
 * and admin limit" (agent/limits.ts agentPostsPerDay, stored key unchanged; engine/owner-admin-limit.ts), set to 7 here.
 * On the real engine and its database, through the same functions the routes call (writer-bounds' asserts, createPost).
 *
 *   1. Posts a day: a member's 101st is refused as before; an owner's and an admin's 8th, naming the owners' 7; with it at
 *      120 an admin's 101st goes (past a member's 100); a moderator keeps a member's 100; posts an owner's assistant made
 *      (created_via 'assistant:…') never count against the owner's own.
 *   2. Upcoming events: a member's 6th is refused as before; an owner's and an admin's 8th, naming 7; an enterprise's events by
 *      its keeper's role (an owner keeper 7, a member keeper 5); a group's pool at an owner's 7, after which a member posting
 *      there is refused (the pool is full past a member's 5); a moderator keeps a member's 5.
 *   3. Polls: a member's 2nd active poll is refused as before; an owner's 4th at a setting of 3, naming it; the node-wide 5
 *      active polls holds for an owner at 7, unchanged.
 *   4. Groups a day: a member's 6th is refused as before; an owner's 6th and 7th go and the 8th is refused, naming 7.
 *   5. Enterprises: a member's 4th in a day, and 21st running, refused as before; an owner's 4th to 7th in a day go and the
 *      8th is refused, naming 7; an owner with 7 running from before is refused the 8th, naming 7 at a time.
 *   6. Demotion: an admin made a member again is held to a member's numbers at once (posts, events, groups, enterprises,
 *      polls); made admin again, the setting at once.
 *   7. The one-active-poll index (db.ts makeActivePollIndexPlain): a plain index after boot; a node's old UNIQUE one is
 *      replaced once; an older image's `CREATE UNIQUE INDEX IF NOT EXISTS` on it is a no-op with an owner's 2 open polls.
 *   8. Invites (Marty, 31 Oct ~20:35): a member's 21st in a day, and 51st unused, refused as before; an owner's and an
 *      admin's 8th, unused and in a day, naming 7; with it at 120 an admin's 21st and a 51st unused go; a moderator keeps a
 *      member's numbers; what was made in Settings still doesn't count; an offline ticket by the maker's role (7, a member 20).
 *   9. Pulse links by hand (the same): a member's 51st refused as before; an owner's 8th, naming 7; with it at 120 an admin's
 *      51st goes; a moderator keeps 50; items synced or harvested are neither counted here nor moved by the setting.
 *  10. Demotion again, for both: an admin made a member again is held to 20 invites a day, 50 unused, a ticket's 20 and
 *      50 links at once; made admin again, the setting at once.
 *
 * Local only: nothing leaves the box.
 *
 * Run: SERVER_SUITES_ONLY=test-owner-admin-limits TEST_ALL_JOBS=2 node scripts/run-server-suites.mjs
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
delete process.env.CF_RECORD_NAME;
delete process.env.NODE_PROFILE;

import crypto from 'node:crypto';
import { setMemberPhoto } from '@beanpool/engine';
import { db, makeActivePollIndexPlain } from './db/db.js';
import { initStateEngine, createPost, createTreasury, adminAssignTreasuryOperator, generateInvite } from './state-engine.js';
import { grantNodeRole, revokeNodeRole } from './engine/node-roles.js';
import {
    assertMayMakeInvite, assertMayPostToday, assertMayStartEnterprise, assertMayStartGroupToday, assertMaySubmitToPulse,
    pulseHarvestAllowance, pulseSyncAllowance, ticketJoinRefusal, WriterLimitError,
} from './engine/writer-bounds.js';
import { addChannel } from './engine/creator-channels.js';
import { setAgentPostsPerDay, AGENT_POSTS_PER_DAY_DEFAULT, agentPostsPerDay } from './agent/limits.js';
import { WRITER_LIMITS } from './config/writer-limits.js';

let run = 0, passed = 0;
function assert(cond: boolean, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else console.error(`✗ FAIL: ${msg}`);
}

const AVATAR = 'data:image/png;base64,iVBORw0KGgo=';
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const HOUR = 60 * 60 * 1000;
const inHours = (h: number) => new Date(Date.now() + h * HOUR).toISOString();
const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
const OWNERS_SETTING = /\("Owner and admin limit" in Settings\)/;

function makeMember(callsign: string): string {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at)
                VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).run(pub, callsign);
    setMemberPhoto(db, pub, AVATAR);
    db.prepare(`INSERT OR IGNORE INTO accounts (public_key, balance, last_demurrage_epoch) VALUES (?, 0, 0)`).run(pub);
    return pub;
}

/** What a call throws, or '' when it goes. */
function refusal(fn: () => unknown): string {
    try { fn(); return ''; } catch (e) { return (e as Error)?.message ?? String(e); }
}
function codeOf(fn: () => unknown): string {
    try { fn(); return ''; } catch (e) { return e instanceof WriterLimitError ? e.code : 'not a WriterLimitError'; }
}

let n = 0;
/** A post from the app, as POST /api/marketplace/posts makes it (its limit: assertMayPostToday, the route's beforeWrite). */
const ownPost = (pub: string, createdVia?: string) => createPost('offer', 'food', `Jar ${++n}`, 'From the app.', 1, 'fixed', pub, -28.55, 153.5, [PHOTO], false, undefined, false,
    { beforeWrite: createdVia ? undefined : () => assertMayPostToday(pub), createdVia });
/** Posts until one is refused or `max` are made: how many went, and the refusal. */
function postUntil(pub: string, max: number): { made: number; refused: string } {
    let made = 0;
    for (let i = 0; i < max; i++) {
        const r = refusal(() => ownPost(pub));
        if (r) return { made, refused: r };
        made++;
    }
    return { made, refused: '' };
}

const newEvent = (author: string, extra: Record<string, unknown> = {}) => createPost('event', 'community', `Gig ${++n}`, 'Live music', 0, 'fixed', author, -28.55, 153.5, [PHOTO], false, undefined, false,
    { eventStartAt: inHours(24 + (n % 48)), eventPlaceName: 'The hall', ...extra } as any);
function eventsUntil(author: string, max: number, extra: Record<string, unknown> = {}): { made: number; refused: string } {
    let made = 0;
    for (let i = 0; i < max; i++) {
        const r = refusal(() => newEvent(author, extra));
        if (r) return { made, refused: r };
        made++;
    }
    return { made, refused: '' };
}

const newPoll = (author: string) => createPost('poll', 'community', `Which day ${++n}?`, '', 0, 'fixed', author, undefined, undefined, undefined, false, undefined, false,
    { pollOptions: [{ id: '1', text: 'Saturday' }, { id: '2', text: 'Sunday' }] });
function pollsUntil(author: string, max: number): { made: number; refused: string } {
    let made = 0;
    for (let i = 0; i < max; i++) {
        const r = refusal(() => newPoll(author));
        if (r) return { made, refused: r };
        made++;
    }
    return { made, refused: '' };
}
const closeAllPolls = () => db.prepare(`UPDATE posts SET status = 'completed' WHERE type = 'poll'`).run();

/** A group `member` started `hoursAgo` (the rows assertMayStartGroupToday reads, as the groups route writes them). */
function seedGroup(member: string, hoursAgo = 1): void {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by, created_at) VALUES (?, ?, ?, ?, ?)`).run(id, `Group ${id.slice(0, 6)}`, `g-${id}`, member, ago(hoursAgo));
}

/** An enterprise `member` started `hoursAgo` (its row, and its thread opened in their name, as createTreasury's route does). */
function seedEnterprise(member: string, hoursAgo = 1): void {
    const pub = crypto.randomBytes(32).toString('hex');
    db.prepare(`INSERT INTO members (public_key, callsign, joined_at, status, updated_at, is_treasury) VALUES (?, ?, ?, 'active', ?, 1)`)
        .run(pub, `Shop ${pub.slice(0, 6)}`, ago(hoursAgo), ago(hoursAgo));
    db.prepare(`INSERT INTO conversations (id, type, name, created_by, created_at) VALUES (?, 'enterprise_thread', 'Shop', ?, ?)`).run(pub, member, ago(hoursAgo));
}

/** A new invite code, as POST /api/invite/generate makes it (its limit: assertMayMakeInvite, the route's beforeWrite). */
const newInvite = (pub: string) => generateInvite(pub, undefined, () => assertMayMakeInvite(pub));
function invitesUntil(pub: string, max: number): { made: number; refused: string } {
    let made = 0;
    for (let i = 0; i < max; i++) {
        const r = refusal(() => newInvite(pub));
        if (r) return { made, refused: r };
        made++;
    }
    return { made, refused: '' };
}

let seeded = 0;
/** `count` invite codes of `member`'s nobody used, made `hoursAgo` (`issuedBy`: made in Settings, routes/community.ts). */
function seedInvites(member: string, count: number, hoursAgo = 48, issuedBy: string | null = null): void {
    const add = db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, issued_by) VALUES (?, ?, ?, ?)`);
    for (let i = 0; i < count; i++) add.run(`INV-${String(++seeded).padStart(4, '0')}-SEED`, member, ago(hoursAgo), issuedBy);
}
/** `count` of `inviter`'s offline tickets someone joined with in the last hour: a ticket's row is keyed on its 16-hex hash. */
function seedTicketJoins(inviter: string, count: number, joiner: string): void {
    const add = db.prepare(`INSERT INTO invite_codes (code, created_by, created_at, used_by, used_at) VALUES (?, ?, ?, ?, ?)`);
    for (let i = 0; i < count; i++) add.run(crypto.randomBytes(8).toString('hex'), inviter, ago(1), joiner, ago(1));
}

const channels = new Map<string, string>();
/** `count` Pulse items of `member`'s added in the last hour, from `source` (the rows assertMaySubmitToPulse reads). */
function seedPulseItems(member: string, count: number, source: 'manual' | 'oauth' | 'autolist' = 'manual'): void {
    const channel = channels.get(member) ?? addChannel({ ownerPubkey: member, platform: 'website', raw: `https://${member.slice(0, 12)}.example.org`, category: 'other' }).id;
    channels.set(member, channel);
    const add = db.prepare(`INSERT INTO pulse_items (id, channel_id, owner_pubkey, platform, url, title, category, source) VALUES (?, ?, ?, 'website', ?, 'A post', 'other', ?)`);
    for (let i = 0; i < count; i++) add.run(`item_${crypto.randomBytes(12).toString('hex')}`, channel, member, `https://example.org/${++seeded}`, source);
}

async function main(): Promise<void> {
    initStateEngine();
    const mem = makeMember('Mel');
    const own = makeMember('Damo');
    const adm = makeMember('Ada');
    const mod = makeMember('Moe');
    grantNodeRole(own, 'owner', 'SYSTEM');
    grantNodeRole(adm, 'admin', own);
    grantNodeRole(mod, 'moderator', own);
    assert(agentPostsPerDay() === AGENT_POSTS_PER_DAY_DEFAULT && AGENT_POSTS_PER_DAY_DEFAULT === 100, 'the owners\' setting is 100 unless set');
    setAgentPostsPerDay(7);

    // ── 1. Posts a day ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 1. Posts a day ---');
    const memPosts = postUntil(mem, 101);
    assert(memPosts.made === WRITER_LIMITS.postsPerDay && /^You can put up 100 new posts in any 24 hours\. You can post again in about/.test(memPosts.refused),
        `a member: 100 posts, the 101st refused as before (${memPosts.made}; ${memPosts.refused})`);
    const ownPosts = postUntil(own, 8);
    assert(ownPosts.made === 7 && /^This community's owners allow 7 new posts in any 24 hours for owners and admins/.test(ownPosts.refused) && OWNERS_SETTING.test(ownPosts.refused),
        `an owner: 7, the 8th refused naming the owners' 7 and the setting (${ownPosts.made}; ${ownPosts.refused})`);
    assert(codeOf(() => assertMayPostToday(own)) === 'posts_per_day', 'with the same code as a member\'s, posts_per_day');
    const admPosts = postUntil(adm, 8);
    assert(admPosts.made === 7 && /^This community's owners allow 7 new posts/.test(admPosts.refused),
        `an admin: 7, the 8th refused naming 7 (${admPosts.made}; ${admPosts.refused})`);
    setAgentPostsPerDay(120);
    const admMore = postUntil(adm, 94);
    assert(admMore.made === 94 && admMore.refused === '', `set to 120, the admin's 8th to 101st all go, past a member's 100 (${admMore.made}; ${admMore.refused})`);
    setAgentPostsPerDay(7);
    const modPosts = postUntil(mod, 8);
    assert(modPosts.made === 8, `a moderator keeps a member's 100: 8 go (${modPosts.made}; ${modPosts.refused})`);
    // An owner's assistant's posts keep their own count (agent/owner-posts.ts): never the owner's own.
    const own2 = makeMember('Olive');
    grantNodeRole(own2, 'owner', own);
    for (let i = 0; i < 9; i++) ownPost(own2, 'assistant:test-grant');
    const own2Posts = postUntil(own2, 8);
    assert(own2Posts.made === 7 && /owners allow 7 new posts/.test(own2Posts.refused),
        `9 posts an owner's assistant made leave all 7 of the owner's own (${own2Posts.made}; ${own2Posts.refused})`);

    // ── 2. Upcoming events ──────────────────────────────────────────────────────────────────────
    console.log('\n--- 2. Upcoming events ---');
    const memEvents = eventsUntil(mem, 6);
    assert(memEvents.made === 5 && memEvents.refused === 'Limit reached: 5 upcoming events at a time',
        `a member: 5 upcoming events, the 6th refused as before (${memEvents.made}; ${memEvents.refused})`);
    const ownEvents = eventsUntil(own, 8);
    assert(ownEvents.made === 7 && ownEvents.refused === 'Limit reached: this community\'s owners allow 7 upcoming events at a time for owners and admins ("Owner and admin limit" in Settings)',
        `an owner (Damo's 6th gig): 7, the 8th refused naming the owners' 7 (${ownEvents.made}; ${ownEvents.refused})`);
    const admEvents = eventsUntil(adm, 8);
    assert(admEvents.made === 7 && /owners allow 7 upcoming events/.test(admEvents.refused), `an admin: 7, the 8th refused (${admEvents.made}; ${admEvents.refused})`);
    const modEvents = eventsUntil(mod, 6);
    assert(modEvents.made === 5 && /^Limit reached: 5 upcoming events/.test(modEvents.refused), `a moderator keeps a member's 5 (${modEvents.made}; ${modEvents.refused})`);
    // An enterprise's pool, by the role of the keeper acting (createdBy, as the treasury routes set it).
    const venue = createTreasury('The Venue', AVATAR, 0).publicKey;
    adminAssignTreasuryOperator(venue, own, 'admin');
    adminAssignTreasuryOperator(venue, mem, 'admin');
    const byMemKeeper = eventsUntil(venue, 6, { createdBy: mem });
    assert(byMemKeeper.made === 5 && /^Limit reached: 5 upcoming events/.test(byMemKeeper.refused),
        `a member keeping an enterprise: its 6th refused at a member's 5 (${byMemKeeper.made}; ${byMemKeeper.refused})`);
    const byOwnKeeper = eventsUntil(venue, 3, { createdBy: own });
    assert(byOwnKeeper.made === 2 && /owners allow 7 upcoming events/.test(byOwnKeeper.refused),
        `an owner keeping the same enterprise: its 6th and 7th go, the 8th refused naming 7 (${byOwnKeeper.made}; ${byOwnKeeper.refused})`);
    // A group's pool, by the role of the member posting to it.
    const groupId = crypto.randomUUID();
    db.prepare(`INSERT INTO groups (id, name, slug, created_by) VALUES (?, 'Gig club', ?, ?)`).run(groupId, `gig-${groupId.slice(0, 8)}`, own);
    for (const [who, role] of [[own, 'convenor'], [mem, 'member']] as const) {
        db.prepare(`INSERT INTO group_members (group_id, member_pubkey, role, status) VALUES (?, ?, ?, 'active')`).run(groupId, who, role);
    }
    const inGroup = { audienceScope: 'group', targetGroupId: groupId };
    const ownGroup = eventsUntil(own, 8, inGroup);
    const memInFull = refusal(() => newEvent(mem, inGroup));
    assert(ownGroup.made === 7 && /owners allow 7 upcoming events/.test(ownGroup.refused) && /^Limit reached: 5 upcoming events/.test(memInFull),
        `a group's pool: an owner posts 7 there, the 8th refused; a member posting there is then refused, the pool past a member's 5 (${ownGroup.made}; ${memInFull})`);

    // ── 3. Polls ────────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 3. Polls ---');
    const memPolls = pollsUntil(mem, 2);
    assert(memPolls.made === 1 && /Rate limit: You can only have 1 active poll at a time/.test(memPolls.refused),
        `a member: 1 active poll, the 2nd refused as before (${memPolls.made}; ${memPolls.refused})`);
    closeAllPolls();
    setAgentPostsPerDay(3);
    const ownPolls = pollsUntil(own, 4);
    assert(ownPolls.made === 3 && ownPolls.refused === 'Rate limit: this community\'s owners allow 3 active polls at a time for owners and admins ("Owner and admin limit" in Settings)',
        `an owner at a setting of 3: 3 open, the 4th refused naming it (${ownPolls.made}; ${ownPolls.refused})`);
    closeAllPolls();
    setAgentPostsPerDay(7);
    const ownPollsAt7 = pollsUntil(own, 7);
    assert(ownPollsAt7.made === 5 && /Rate limit: Node limit of 5 active polls reached/.test(ownPollsAt7.refused),
        `at 7, the community's 5 active polls still holds for an owner, unchanged (${ownPollsAt7.made}; ${ownPollsAt7.refused})`);
    const admAtNodeCap = refusal(() => newPoll(adm));
    assert(/Node limit of 5 active polls/.test(admAtNodeCap), `and for everyone else then (${admAtNodeCap})`);
    closeAllPolls();

    // ── 4. Groups a day ─────────────────────────────────────────────────────────────────────────
    console.log('\n--- 4. Groups a day ---');
    for (let i = 0; i < 5; i++) { seedGroup(mem); seedGroup(own); }
    const memGroup = refusal(() => assertMayStartGroupToday(mem));
    assert(codeOf(() => assertMayStartGroupToday(mem)) === 'groups_per_day' && /^You can start 5 groups in any 24 hours/.test(memGroup),
        `a member with 5 today: the 6th refused as before (${memGroup})`);
    assert(refusal(() => assertMayStartGroupToday(own)) === '', 'an owner with 5 today may start a 6th');
    seedGroup(own); seedGroup(own);
    const ownGroupRefused = refusal(() => assertMayStartGroupToday(own));
    assert(codeOf(() => assertMayStartGroupToday(own)) === 'groups_per_day' && /^This community's owners allow 7 new groups in any 24 hours for owners and admins/.test(ownGroupRefused)
        && OWNERS_SETTING.test(ownGroupRefused), `with 7 today, the owner's 8th refused naming 7 (${ownGroupRefused})`);

    // ── 5. Enterprises ──────────────────────────────────────────────────────────────────────────
    console.log('\n--- 5. Enterprises ---');
    for (let i = 0; i < 3; i++) { seedEnterprise(mem); seedEnterprise(own); }
    const memEnt = refusal(() => assertMayStartEnterprise(mem));
    assert(codeOf(() => assertMayStartEnterprise(mem)) === 'enterprises_per_day' && /^You can start 3 enterprises in any 24 hours/.test(memEnt),
        `a member with 3 today: the 4th refused as before (${memEnt})`);
    assert(refusal(() => assertMayStartEnterprise(own)) === '', 'an owner with 3 today may start a 4th');
    for (let i = 0; i < 4; i++) seedEnterprise(own);
    assert(codeOf(() => assertMayStartEnterprise(own)) === 'enterprises_live', 'with 7 started today and all 7 running, the running count (the same setting) refuses first');
    db.prepare(`UPDATE members SET status = 'completed' WHERE public_key IN
                (SELECT id FROM conversations WHERE type = 'enterprise_thread' AND created_by = ? LIMIT 2)`).run(own);
    const ownEnt = refusal(() => assertMayStartEnterprise(own));
    assert(codeOf(() => assertMayStartEnterprise(own)) === 'enterprises_per_day' && /^This community's owners allow 7 new enterprises in any 24 hours for owners and admins/.test(ownEnt),
        `with 7 today and 2 of them wound up, the owner's 8th today is refused naming 7 (${ownEnt})`);
    const kim = makeMember('Kim');
    for (let i = 0; i < 20; i++) seedEnterprise(kim, 48);
    assert(codeOf(() => assertMayStartEnterprise(kim)) === 'enterprises_live', 'a member with 20 running from before: the 21st refused as before (enterprises_live)');
    const olive = own2;
    for (let i = 0; i < 7; i++) seedEnterprise(olive, 48);
    const oliveLive = refusal(() => assertMayStartEnterprise(olive));
    assert(codeOf(() => assertMayStartEnterprise(olive)) === 'enterprises_live'
        && /^You have started 7 enterprises that are still running\. This community's owners allow 7 at a time for owners and admins \("Owner and admin limit" in Settings\)\. Wind one up/.test(oliveLive),
        `an owner with 7 running from before: the 8th refused naming 7 at a time (${oliveLive})`);

    // ── 6. Demotion and promotion: the role now ─────────────────────────────────────────────────
    console.log('\n--- 6. Demotion ---');
    for (let i = 0; i < 7; i++) seedGroup(adm);
    for (let i = 0; i < 4; i++) seedEnterprise(adm);
    const asAdmin = [refusal(() => assertMayStartGroupToday(adm)), refusal(() => assertMayStartEnterprise(adm))];
    revokeNodeRole(adm, 'admin', own);
    const demoted = {
        post: refusal(() => ownPost(adm)),
        event: refusal(() => newEvent(adm)),
        group: refusal(() => assertMayStartGroupToday(adm)),
        enterprise: refusal(() => assertMayStartEnterprise(adm)),
    };
    assert(/owners allow 7 new groups/.test(asAdmin[0]) && asAdmin[1] === '', `as an admin: the 8th group refused at 7; a 5th enterprise today allowed (${asAdmin.join(' | ')})`);
    assert(/^You can put up 100 new posts in any 24 hours/.test(demoted.post)
        && demoted.event === 'Limit reached: 5 upcoming events at a time'
        && /^You can start 5 groups in any 24 hours/.test(demoted.group)
        && /^You can start 3 enterprises in any 24 hours/.test(demoted.enterprise),
        `made a member again, the admin is held to a member's numbers at once (${Object.values(demoted).join(' | ')})`);
    const demotedPolls = pollsUntil(adm, 2);
    assert(demotedPolls.made === 1 && /1 active poll/.test(demotedPolls.refused), `and to a member's 1 active poll (${demotedPolls.made}; ${demotedPolls.refused})`);
    closeAllPolls();
    grantNodeRole(adm, 'admin', own);
    setAgentPostsPerDay(120);
    const repromoted = { post: refusal(() => ownPost(adm)), group: refusal(() => assertMayStartGroupToday(adm)) };
    assert(repromoted.post === '' && repromoted.group === '', `made admin again with the setting at 120, the setting at once (${Object.values(repromoted).join(' | ')})`);
    setAgentPostsPerDay(AGENT_POSTS_PER_DAY_DEFAULT);

    // ── 7. The one-active-poll index ────────────────────────────────────────────────────────────
    // It was UNIQUE, which held every author to 1 whatever the engine allowed. Now a plain index under the same name.
    console.log('\n--- 7. The active-poll index ---');
    closeAllPolls();
    const uniqueOf = () => (db.prepare(`SELECT "unique" AS u FROM pragma_index_list('posts') WHERE name = 'idx_posts_author_active_poll'`).get() as { u: number } | undefined)?.u;
    assert(uniqueOf() === 0, `the boot leaves the active-poll index a plain one (unique: ${uniqueOf()})`);
    db.exec(`DROP INDEX idx_posts_author_active_poll`);
    db.exec(`CREATE UNIQUE INDEX idx_posts_author_active_poll ON posts(author_pubkey) WHERE type = 'poll' AND status = 'active'`);
    const replaced = makeActivePollIndexPlain();
    assert(replaced === true && uniqueOf() === 0 && makeActivePollIndexPlain() === false, 'a node from before: its unique index is replaced by the plain one, once');
    newPoll(own); newPoll(own);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_author_active_poll ON posts(author_pubkey) WHERE type = 'poll' AND status = 'active'`);
    assert(uniqueOf() === 0, 'an older image\'s schema line, run on it with an owner\'s 2 open polls, finds the name and does nothing (no failed boot)');
    closeAllPolls();

    // ── 8. Invites ──────────────────────────────────────────────────────────────────────────────
    console.log('\n--- 8. Invites ---');
    setAgentPostsPerDay(7);
    const bea = makeMember('Bea');
    const beaInvites = invitesUntil(bea, 21);
    assert(beaInvites.made === WRITER_LIMITS.invitesPerDay && codeOf(() => assertMayMakeInvite(bea)) === 'invites_per_day'
        && /^You can make 20 invites in any 24 hours\. You can make more in about/.test(beaInvites.refused),
        `a member: 20 invites in a day, the 21st refused as before (${beaInvites.made}; ${beaInvites.refused})`);
    const cal = makeMember('Cal');
    seedInvites(cal, WRITER_LIMITS.invitesUnused);
    const calRefused = refusal(() => newInvite(cal));
    assert(codeOf(() => assertMayMakeInvite(cal)) === 'invites_unused' && /^You have 50 invites nobody has used yet, the most one member can hold\./.test(calRefused),
        `a member holding 50 unused: the 51st refused as before (${calRefused})`);
    const iris = makeMember('Iris');
    grantNodeRole(iris, 'owner', own);
    const irisInvites = invitesUntil(iris, 8);
    assert(irisInvites.made === 7 && codeOf(() => assertMayMakeInvite(iris)) === 'invites_unused'
        && /^You have 7 invites nobody has used yet\. This community's owners allow 7 at a time for owners and admins/.test(irisInvites.refused) && OWNERS_SETTING.test(irisInvites.refused),
        `an owner: 7 unused, the 8th refused naming 7 at a time and the setting (${irisInvites.made}; ${irisInvites.refused})`);
    db.prepare(`UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code IN (SELECT code FROM invite_codes WHERE created_by = ? LIMIT 2)`).run(mem, ago(1), iris);
    const irisToday = refusal(() => newInvite(iris));
    assert(codeOf(() => assertMayMakeInvite(iris)) === 'invites_per_day'
        && /^This community's owners allow 7 new invites in any 24 hours for owners and admins/.test(irisToday) && OWNERS_SETTING.test(irisToday),
        `with 2 of them used, the owner's 8th today is refused naming 7 a day (${irisToday})`);
    const jo = makeMember('Jo');
    grantNodeRole(jo, 'admin', own);
    const joInvites = invitesUntil(jo, 8);
    assert(joInvites.made === 7 && /owners allow 7 at a time/.test(joInvites.refused), `an admin: 7, the 8th refused (${joInvites.made}; ${joInvites.refused})`);
    setAgentPostsPerDay(120);
    const joMore = invitesUntil(jo, 14);
    seedInvites(jo, 40);
    const joUnused = refusal(() => newInvite(jo));
    assert(joMore.made === 14 && joUnused === '', `set to 120, the admin's 21st in a day goes, and a 51st unused (${joMore.made}; ${joMore.refused}; ${joUnused})`);
    setAgentPostsPerDay(7);
    const modInvites = invitesUntil(mod, 21);
    assert(modInvites.made === 20 && /^You can make 20 invites in any 24 hours/.test(modInvites.refused),
        `a moderator keeps a member's 20, whatever the setting (${modInvites.made}; ${modInvites.refused})`);
    const kit = makeMember('Kit');
    grantNodeRole(kit, 'admin', own);
    seedInvites(kit, 10, 1, 'owner:password');
    assert(refusal(() => newInvite(kit)) === '', 'what was made in Settings still doesn\'t count against an admin\'s own');
    // An offline ticket counts when someone joins with it, by its maker's role (the words go to the person joining).
    const lou = makeMember('Lou');
    seedTicketJoins(lou, 7, mem);
    const pam = makeMember('Pam');
    grantNodeRole(pam, 'owner', own);
    seedTicketJoins(pam, 6, mem);
    const pamUnder = ticketJoinRefusal(pam);
    seedTicketJoins(pam, 1, mem);
    const pamOver = ticketJoinRefusal(pam) ?? '';
    assert(ticketJoinRefusal(lou) === null && pamUnder === null && /^The member whose invite this is has brought 7 people in today/.test(pamOver),
        `a ticket by its maker's role: a member with 7 joins today passes; an owner's 7th passes and the 8th is refused at 7 (${pamOver})`);
    seedTicketJoins(lou, 13, mem);
    assert(/brought 20 people in today/.test(ticketJoinRefusal(lou) ?? ''), `and a member's is refused at 20, as before (${ticketJoinRefusal(lou)})`);
    setAgentPostsPerDay(120);
    seedTicketJoins(pam, 13, mem);
    assert(ticketJoinRefusal(pam) === null, 'set to 120, an owner\'s 21st ticket join today passes');

    // ── 9. Pulse links by hand ──────────────────────────────────────────────────────────────────
    console.log('\n--- 9. Pulse links by hand ---');
    setAgentPostsPerDay(7);
    const ned = makeMember('Ned');
    seedPulseItems(ned, 49);
    const nedUnder = refusal(() => assertMaySubmitToPulse(ned));
    seedPulseItems(ned, 1);
    const nedOver = refusal(() => assertMaySubmitToPulse(ned));
    assert(nedUnder === '' && codeOf(() => assertMaySubmitToPulse(ned)) === 'pulse_per_day' && /^You can add 50 links to the Pulse in any 24 hours\. You can add more in about/.test(nedOver),
        `a member: 50 links, the 51st refused as before (${nedOver})`);
    const uma = makeMember('Uma');
    grantNodeRole(uma, 'owner', own);
    seedPulseItems(uma, 6);
    const umaUnder = refusal(() => assertMaySubmitToPulse(uma));
    seedPulseItems(uma, 1);
    const umaOver = refusal(() => assertMaySubmitToPulse(uma));
    assert(umaUnder === '' && codeOf(() => assertMaySubmitToPulse(uma)) === 'pulse_per_day'
        && /^This community's owners allow 7 new links to the Pulse in any 24 hours for owners and admins/.test(umaOver) && OWNERS_SETTING.test(umaOver),
        `an owner: 7 links, the 8th refused naming 7 and the setting (${umaOver})`);
    const val = makeMember('Val');
    grantNodeRole(val, 'admin', own);
    seedPulseItems(val, 7);
    const valAt7 = refusal(() => assertMaySubmitToPulse(val));
    setAgentPostsPerDay(120);
    seedPulseItems(val, 43);
    const valAt120 = refusal(() => assertMaySubmitToPulse(val));
    assert(/owners allow 7 new links/.test(valAt7) && valAt120 === '', `an admin: refused at 7; set to 120, the 51st goes (${valAt7})`);
    setAgentPostsPerDay(7);
    seedPulseItems(mod, 7);
    assert(refusal(() => assertMaySubmitToPulse(mod)) === '', 'a moderator keeps a member\'s 50: the 8th link goes at a setting of 7');
    // A sync and the harvester are not hand submissions: their own numbers, for everyone.
    const wes = makeMember('Wes');
    grantNodeRole(wes, 'owner', own);
    seedPulseItems(wes, 9, 'oauth');
    seedPulseItems(wes, 9, 'autolist');
    assert(refusal(() => assertMaySubmitToPulse(wes)) === '' && pulseSyncAllowance(wes) === WRITER_LIMITS.pulseSyncedItemsPerDay - 9
        && pulseHarvestAllowance(wes) === WRITER_LIMITS.pulseHarvestedItemsPerDay - 9,
        `at a setting of 7, 9 synced and 9 harvested use none of an owner's links, and keep their own 300 and 400 (${pulseSyncAllowance(wes)}, ${pulseHarvestAllowance(wes)})`);

    // ── 10. Demotion, for invites and links ─────────────────────────────────────────────────────
    console.log('\n--- 10. Demotion, for invites and links ---');
    setAgentPostsPerDay(120);
    const zed = makeMember('Zed');
    grantNodeRole(zed, 'admin', own);
    seedInvites(zed, WRITER_LIMITS.invitesPerDay, 1);
    seedTicketJoins(zed, WRITER_LIMITS.invitesPerDay, mem);
    seedPulseItems(zed, WRITER_LIMITS.pulseSubmissionsPerDay);
    const asAdminAgain = [refusal(() => assertMayMakeInvite(zed)), ticketJoinRefusal(zed) ?? '', refusal(() => assertMaySubmitToPulse(zed))];
    assert(asAdminAgain.every((r) => r === ''), `as an admin at 120: invite, ticket and link all go (${asAdminAgain.join(' | ')})`);
    revokeNodeRole(zed, 'admin', own);
    const demotedAgain = { invite: refusal(() => assertMayMakeInvite(zed)), ticket: ticketJoinRefusal(zed) ?? '', link: refusal(() => assertMaySubmitToPulse(zed)) };
    assert(/^You can make 20 invites in any 24 hours/.test(demotedAgain.invite) && /brought 20 people in today/.test(demotedAgain.ticket)
        && /^You can add 50 links to the Pulse in any 24 hours/.test(demotedAgain.link),
        `made a member again: 20 invites, a ticket's 20 and 50 links at once (${Object.values(demotedAgain).join(' | ')})`);
    seedInvites(zed, WRITER_LIMITS.invitesUnused - WRITER_LIMITS.invitesPerDay);
    assert(/^You have 50 invites nobody has used yet, the most one member can hold/.test(refusal(() => assertMayMakeInvite(zed))), 'and to a member\'s 50 unused at once');
    grantNodeRole(zed, 'admin', own);
    assert(refusal(() => assertMayMakeInvite(zed)) === '' && refusal(() => assertMaySubmitToPulse(zed)) === '', 'made admin again, the setting at once');
    setAgentPostsPerDay(AGENT_POSTS_PER_DAY_DEFAULT);

    console.log(`\n${passed}/${run} passed`);
    if (passed !== run) process.exit(1);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
