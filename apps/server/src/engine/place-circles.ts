/**
 * The place circle (Lounge L2 with doors S8, scratch/fable-design/DESIGN-global-lounge-fable.md §3.3): people waiting for a
 * community in the same place are put in one group once three of them said they'd help start one. It introduces them
 * and nothing more: an ordinary group on the global node, with no money, no routing and no word from this node about
 * anyone. When a community starts, a member's own app sends their knock only if they tap Ask to join (knocks go phone → the
 * new node).
 *
 *   - **"I'd help start one here"** is one flag on a place watch (`place_watches.would_help`, engine/place-watches.ts): the
 *     same 0.1° cell, the same limit of 3, nothing else stored.
 *   - **Forming** (runPlaceCircles, each directory mirror run): a helper within about CIRCLE_RADIUS_KM of a circle still
 *     open, with someone in it, joins it; three or more helpers around one cell with no such circle and no listed community
 *     that near get one group. Nobody is in two: a helper with flags in two cells is in the first circle that takes them
 *     (clusterHelpers).
 *   - **Ending**: a listed community first seen within CIRCLE_RADIUS_KM of an open circle retires it, once. Its members
 *     are told, its flags go (or the next run would form it again), and CIRCLE_CHAT_KEEP_MS later the group closes as a
 *     group closed by a vote does (group_closures), read-only, its row kept.
 *
 * ## What a count may say
 *
 * The reads of waiting people are public, on purpose: a stranger deciding whether to start one should see they are not
 * alone. Three rules keep that from telling anyone where anyone is.
 *
 *   1. **Nothing below CIRCLE_MIN_PEOPLE**, not even "a few": entry §2.5's "a few" for one watcher is a yes/no on that
 *      watcher's cell, and a yes/no is all a bisection needs (broadcast-reach oracle, #1965).
 *   2. **A fixed tile, not a circle around the point** (waitingNear). A count of "within 25 km of any point you name" can be
 *      differenced: 3 at one point and 4 at the next says one person is in the crescent between them, and that person
 *      is below the floor however high the floor is. Each person is in exactly one DEMAND_TILE_DEG tile and each tile has
 *      one number, so no two reads can be subtracted to single anyone out.
 *   3. **Members' cells stay here.** `groups.place_cell` is in no response or push. A circle is `invite_only`, so an
 *      outsider's read of it is the same 404 as no group at all: the only thing an outsider learns is rule 2's number.
 *
 * ## An open registry
 *
 * Anyone with a node key can publish a row (engine/place-watches.ts header), so a row near a circle can retire it. That
 * costs the circle a line on its card and a clock: its chat stands for 30 days and its members can say "I'd help" again.
 * A retiring row gets no knock unless the member taps. Nothing goes from a member's device to the row's address, no knock
 * and no status read, until they tap Ask to join on the retired card, and "Remind me to join when it starts" is a wish on
 * that device that sends nothing. The tap sends one signed knock, and the row then has what any knock gives a community:
 * their key and name in the request, and their IP address from the connection.
 * Retiring takes only what the notices take (firstSightings: listed, placed, not a flood), and a push never carries the
 * row's name or place: the name is on the card of someone already in the circle, as it is on the Find card.
 *
 * Nothing here runs on a local community: only the mirror calls runPlaceCircles (services/directory-mirror.ts), and only
 * on a main server with `directoryMirror` on. A standby gets the rows with the rest of the group.
 */
import { db } from '../db/db.js';
import { GROUP_START_PAUSED, haversineKm, isNodeMember, isSuspendedAccount } from '@beanpool/engine';
import { CIRCLE_MIN_PEOPLE, GROUP_KIND_CIRCLE, pushNoticeWords, word, type CircleCard, type CircleCommunity, type CircleDemand } from '@beanpool/core';
import { firstSightings } from './directory-cache.js';
import { hasBlocked } from './member-blocks.js';
import { PLACE_WATCH_FLOOD, PLACE_WATCH_NOTICE_KEEP_MS, SightingIndex, type BroadcastFn, type PushFn } from './place-watches.js';

/** How far from a circle's cell a helper belongs to it, and a community retires it. */
export const CIRCLE_RADIUS_KM = 25;
/** A retired circle's chat stays this long, then the group closes. */
export const CIRCLE_CHAT_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
/** "I'm starting one here" lapses after this long with no community. */
export const CIRCLE_STARTING_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/** A second "I'm starting one here" within this long tells nobody: the row can be tapped on and off. */
export const CIRCLE_STARTING_QUIET_MS = 24 * 60 * 60 * 1000;
/** The side of the tile a public count covers, in degrees: about 55 km north to south. See the header, rule 2. */
export const DEMAND_TILE_DEG = 0.5;
/** group_closures.decision_id for a circle's close: no Decision closed it. */
export const CIRCLE_CLOSED_BY = 'place-circle';

export const CIRCLE_NOT_YOURS = word('Only someone in this circle can do that.');
export const CIRCLE_ENDED = word('This circle has finished.');
export const CIRCLE_ALREADY_STARTING = word('Someone here is already starting one.');

export interface CircleCallbacks {
    broadcast: BroadcastFn;
    dispatchPushNotification: PushFn;
    /** Someone a circle may hold: a member here, not suspended. */
    maySit: (pubkey: string) => boolean;
    /** Makes the group, with `createdBy` its first convenor. Returns its id. */
    createCircle: (createdBy: string, placeCell: string) => string;
    addToCircle: (groupId: string, pubkey: string) => void;
    closeCircle: (groupId: string) => void;
}

export interface CircleRun { formed: number; joined: number; retired: number; closed: number }

// ── the count ────────────────────────────────────────────────────────────────────────────────────────────────────

const tileStart = (v: number): number => Math.floor(v / DEMAND_TILE_DEG) * DEMAND_TILE_DEG;

/** How many people are waiting in the tile holding this point, and how many of them would help (see the header). */
export function waitingNear(point: { lat: number; lng: number }): CircleDemand {
    const lat = tileStart(point.lat);
    const lng = tileStart(point.lng);
    const row = db.prepare(`SELECT COUNT(DISTINCT pubkey) AS waiting, COUNT(DISTINCT CASE WHEN would_help = 1 THEN pubkey END) AS helping
                            FROM place_watches WHERE lat >= ? AND lat < ? AND lng >= ? AND lng < ?`)
        .get(lat, lat + DEMAND_TILE_DEG, lng, lng + DEMAND_TILE_DEG) as { waiting: number; helping: number };
    return { waiting: row.waiting >= CIRCLE_MIN_PEOPLE ? row.waiting : null, helping: row.helping >= CIRCLE_MIN_PEOPLE ? row.helping : null };
}

// ── who goes in which circle ─────────────────────────────────────────────────────────────────────────────────────

const cellOf = (lat: number, lng: number): string => `${lat},${lng}`;

function parseCell(cell: string | null): { lat: number; lng: number } | null {
    const [lat, lng] = (cell ?? '').split(',').map(Number);
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

export interface HelperWatch { pubkey: string; lat: number; lng: number }
export interface HelperCluster { lat: number; lng: number; members: string[] }

interface Cell { c: { lat: number; lng: number }; extraKm: 0; people: string[] }

/**
 * The groups of helpers a run would make, `helpers` given oldest first. Each cell in the order it was first asked for
 * takes everyone not yet placed within CIRCLE_RADIUS_KM of it, once that is CIRCLE_MIN_PEOPLE or more: everyone in a
 * cluster is near its cell, and nobody is in two, whichever of their cells came first. Each cluster's members are
 * oldest first. Compares each cell only with the cells near it (SightingIndex).
 */
export function clusterHelpers(helpers: readonly HelperWatch[]): HelperCluster[] {
    const cells = new Map<string, Cell>();
    const firstAsked = new Map<string, number>();
    helpers.forEach((h, i) => {
        const key = cellOf(h.lat, h.lng);
        const cell = cells.get(key) ?? { c: { lat: h.lat, lng: h.lng }, extraKm: 0, people: [] };
        cell.people.push(h.pubkey);
        cells.set(key, cell);
        if (!firstAsked.has(h.pubkey)) firstAsked.set(h.pubkey, i);
    });
    const index = new SightingIndex<Cell>([...cells.values()]);
    const placed = new Set<string>();
    const clusters: HelperCluster[] = [];
    for (const anchor of cells.values()) {
        const { lat, lng } = anchor.c;
        const people = new Set<string>();
        index.near(lat, lng, CIRCLE_RADIUS_KM, cell => {
            if (haversineKm(lat, lng, cell.c.lat, cell.c.lng) > CIRCLE_RADIUS_KM) return;
            for (const pk of cell.people) if (!placed.has(pk)) people.add(pk);
        });
        if (people.size < CIRCLE_MIN_PEOPLE) continue;
        for (const pk of people) placed.add(pk);
        clusters.push({ lat, lng, members: [...people].sort((a, b) => firstAsked.get(a)! - firstAsked.get(b)!) });
    }
    return clusters;
}

interface OpenCircle { id: string; cell: { lat: number; lng: number }; createdAt: string }

/** Not closed: where an operator has turned votes on, a circle's members can close it, and that sets no circle_done_at. */
const NOT_CLOSED = 'NOT EXISTS (SELECT 1 FROM group_closures c WHERE c.group_id = g.id)';

/** The circles no community has retired and no vote has closed, oldest first. */
function openCircles(): OpenCircle[] {
    const rows = db.prepare(`SELECT g.id, g.place_cell, g.created_at FROM groups g WHERE g.kind = ? AND g.circle_done_at IS NULL AND ${NOT_CLOSED} ORDER BY g.created_at, g.id`)
        .all(GROUP_KIND_CIRCLE) as { id: string; place_cell: string | null; created_at: string }[];
    return rows.flatMap(r => {
        const cell = parseCell(r.place_cell);
        return cell ? [{ id: r.id, cell, createdAt: r.created_at }] : [];
    });
}

/**
 * Whether a listed community has a place within CIRCLE_RADIUS_KM of here: then there is one to join, and no circle to make.
 * Bounded north and south only (a degree of latitude is 111 km): longitudes wrap at ±180°, and a run asks this a few times.
 */
function communityNear(cell: { lat: number; lng: number }): boolean {
    const span = CIRCLE_RADIUS_KM / 110;
    const rows = db.prepare('SELECT lat, lng FROM directory_cache WHERE listed = 1 AND lat BETWEEN ? AND ? AND lng IS NOT NULL')
        .all(cell.lat - span, cell.lat + span) as { lat: number; lng: number }[];
    return rows.some(r => haversineKm(cell.lat, cell.lng, r.lat, r.lng) <= CIRCLE_RADIUS_KM);
}

const hasAnyBlock = (a: string, b: string): boolean => hasBlocked(a, b) || hasBlocked(b, a);

/** Whether `pubkey` and anyone in this group have blocked each other. A block is never undone by being introduced. */
function blockedInCircle(groupId: string, pubkey: string): boolean {
    const rows = db.prepare(`SELECT member_pubkey FROM group_members WHERE group_id = ? AND status IN ('active', 'invited', 'pending_approval')`)
        .all(groupId) as { member_pubkey: string }[];
    return rows.some(r => hasAnyBlock(pubkey, r.member_pubkey));
}

/** Tells these people about their circle: a generic notice, one live and one push each. No place, name or count in it. */
export function tellCircle(cb: Pick<CircleCallbacks, 'broadcast' | 'dispatchPushNotification'>, groupId: string, people: readonly string[]): void {
    const { title, body } = pushNoticeWords('community.circle');
    const data = { kind: 'place_circle', groupId };
    for (const pubkey of people) {
        try {
            cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data }, [pubkey]);
        } catch (e: any) {
            console.warn('[Place circles] Live notice failed:', e?.message || e);
        }
        try {
            cb.dispatchPushNotification([pubkey], 'SYSTEM', title, body, data, 'marketplace', 'community.circle');
        } catch (e: any) {
            console.warn('[Place circles] Push failed:', e?.message || e);
        }
    }
}

function formCircles(cb: CircleCallbacks): Pick<CircleRun, 'formed' | 'joined'> {
    const run = { formed: 0, joined: 0 };
    const helpers = db.prepare('SELECT pubkey, lat, lng FROM place_watches WHERE would_help = 1 ORDER BY created_at, id').all() as HelperWatch[];
    if (helpers.length < 1) return run;
    const open = openCircles();
    const seated = new Set((db.prepare(`SELECT DISTINCT gm.member_pubkey AS pk FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE g.kind = ? AND g.circle_done_at IS NULL AND ${NOT_CLOSED} AND gm.status != 'removed'`).all(GROUP_KIND_CIRCLE) as { pk: string }[]).map(r => r.pk));

    // Someone new near a circle that already exists joins it: there is one to join. A circle nobody is in is not one: they
    // would be seated alone, with no convenor, and told people want to meet them. They go on waiting, for the forming below.
    const peopled = open.filter(o => activeMembers(o.id).some(pk => cb.maySit(pk)));
    const index = new SightingIndex(peopled.map(o => ({ c: o.cell, extraKm: 0, circle: o })));
    const removedFrom = db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'removed'`);
    for (const h of helpers) {
        if (seated.has(h.pubkey) || !cb.maySit(h.pubkey)) continue;
        let best: { id: string; km: number } | null = null;
        index.near(h.lat, h.lng, CIRCLE_RADIUS_KM, s => {
            const km = haversineKm(h.lat, h.lng, s.c.lat, s.c.lng);
            if (km <= CIRCLE_RADIUS_KM && (!best || km < best.km) && !removedFrom.get(s.circle.id, h.pubkey) && !blockedInCircle(s.circle.id, h.pubkey)) best = { id: s.circle.id, km };
        });
        const nearest = best as { id: string; km: number } | null;
        if (!nearest) continue;
        cb.addToCircle(nearest.id, h.pubkey);
        tellCircle(cb, nearest.id, [h.pubkey]);
        seated.add(h.pubkey);
        run.joined++;
    }

    // Only those who may sit: a suspended helper counts toward nobody's three.
    for (const cluster of clusterHelpers(helpers.filter(h => !seated.has(h.pubkey) && cb.maySit(h.pubkey)))) {
        const cell = { lat: cluster.lat, lng: cluster.lng };
        if (communityNear(cell)) continue;
        // Earliest first, leaving out the later of two who have blocked each other.
        const seats: string[] = [];
        for (const pk of cluster.members) {
            if (!seats.some(other => hasAnyBlock(pk, other))) seats.push(pk);
        }
        if (seats.length < CIRCLE_MIN_PEOPLE) continue;
        const id = cb.createCircle(seats[0], cellOf(cell.lat, cell.lng));
        for (const pk of seats.slice(1)) cb.addToCircle(id, pk);
        tellCircle(cb, id, seats);
        run.formed++;
    }
    return run;
}

// ── how a circle ends ────────────────────────────────────────────────────────────────────────────────────────────

/** Takes "I'd help" off this member's watches near the circle: they are told, or they left, and no run puts them back. */
function clearHelpNear(pubkeys: readonly string[], cell: { lat: number; lng: number }, now: string): void {
    const flagged = db.prepare('SELECT id, lat, lng FROM place_watches WHERE pubkey = ? AND would_help = 1');
    const clear = db.prepare('UPDATE place_watches SET would_help = 0, updated_at = ? WHERE id = ?');
    for (const pk of pubkeys) {
        for (const w of flagged.all(pk) as { id: string; lat: number; lng: number }[]) {
            if (haversineKm(cell.lat, cell.lng, w.lat, w.lng) <= CIRCLE_RADIUS_KM) clear.run(now, w.id);
        }
    }
}

const activeMembers = (groupId: string): string[] =>
    (db.prepare(`SELECT member_pubkey FROM group_members WHERE group_id = ? AND status = 'active'`).all(groupId) as { member_pubkey: string }[]).map(r => r.member_pubkey);

function retireCircles(cb: CircleCallbacks, now: string): number {
    const open = openCircles();
    if (open.length === 0) return 0;
    const since = new Date(Date.parse(now) - PLACE_WATCH_NOTICE_KEEP_MS).toISOString();
    const sightings = firstSightings(since, now, PLACE_WATCH_FLOOD).map(c => ({ c, extraKm: 0 }));
    if (sightings.length === 0) return 0;
    const index = new SightingIndex(sightings);
    const retire = db.prepare('UPDATE groups SET circle_done_at = ?, circle_community_key = ?, updated_at = ? WHERE id = ? AND circle_done_at IS NULL');
    // One write: no run looks at a retired circle again, so flags left on it would stay for good and could form it anew.
    const retireOne = db.transaction((circle: OpenCircle, key: string): string[] | null => {
        if (retire.run(now, key, now, circle.id).changes === 0) return null;
        const members = activeMembers(circle.id);
        clearHelpNear(members, circle.cell, now);
        return members;
    });
    let retired = 0;
    for (const circle of open) {
        let found: { key: string; km: number } | null = null;
        index.near(circle.cell.lat, circle.cell.lng, CIRCLE_RADIUS_KM, ({ c }) => {
            // One first seen before the circle was made was near when it formed, or the circle would not have: not news.
            if (c.firstSeenAt <= circle.createdAt) return;
            const km = haversineKm(circle.cell.lat, circle.cell.lng, c.lat, c.lng);
            if (km <= CIRCLE_RADIUS_KM && (!found || km < found.km)) found = { key: c.key, km };
        });
        const nearest = found as { key: string; km: number } | null;
        const members = nearest && retireOne(circle, nearest.key);
        if (!members) continue;
        retired++;
        // The watches' own notice this run told most of them; the rest (invited with no watch, in their quiet day) hear here.
        const told = new Set((db.prepare('SELECT DISTINCT pubkey FROM place_watches WHERE last_notified_at = ?').all(now) as { pubkey: string }[]).map(r => r.pubkey));
        const { title, body } = pushNoticeWords('community.near');
        const data = { kind: 'community_near_you', groupId: circle.id };
        for (const pk of members.filter(m => !told.has(m))) {
            try {
                cb.broadcast({ type: 'system_announcement', title, body, severity: 'info', ...data }, [pk]);
                cb.dispatchPushNotification([pk], 'SYSTEM', title, body, data, 'marketplace', 'community.near');
            } catch (e: any) {
                console.warn('[Place circles] Telling a circle failed:', e?.message || e);
            }
        }
    }
    return retired;
}

function closeRetiredCircles(cb: CircleCallbacks, now: string): number {
    const until = new Date(Date.parse(now) - CIRCLE_CHAT_KEEP_MS).toISOString();
    const due = db.prepare(`SELECT g.id FROM groups g WHERE g.kind = ? AND g.circle_done_at IS NOT NULL AND g.circle_done_at <= ?
        AND NOT EXISTS (SELECT 1 FROM group_closures c WHERE c.group_id = g.id)`).all(GROUP_KIND_CIRCLE, until) as { id: string }[];
    for (const { id } of due) cb.closeCircle(id);
    return due.length;
}

/** The hourly run (services/directory-mirror.ts), after the place watches' own notices: ends what ended, then forms what can. */
export function runPlaceCircles(cb: CircleCallbacks, now: string = new Date().toISOString()): CircleRun {
    const retired = retireCircles(cb, now);
    const closed = closeRetiredCircles(cb, now);
    const lapsed = new Date(Date.parse(now) - CIRCLE_STARTING_KEEP_MS).toISOString();
    db.prepare('UPDATE groups SET circle_starter = NULL, updated_at = ? WHERE kind = ? AND circle_starter IS NOT NULL AND circle_starting_at <= ?')
        .run(now, GROUP_KIND_CIRCLE, lapsed);
    return { ...formCircles(cb), retired, closed };
}

/**
 * Someone left a circle, or was removed. Their flag goes, or the next run puts them straight back, and their "I'm
 * starting one here" goes with them. Their watch stays: they still want to hear when one starts.
 */
export function afterLeavingCircle(groupId: string, pubkey: string): void {
    const row = db.prepare('SELECT kind, place_cell, circle_starter FROM groups WHERE id = ?').get(groupId) as { kind: string | null; place_cell: string | null; circle_starter: string | null } | undefined;
    if (row?.kind !== GROUP_KIND_CIRCLE) return;
    const now = new Date().toISOString();
    const cell = parseCell(row.place_cell);
    if (cell) clearHelpNear([pubkey], cell, now);
    if (row.circle_starter === pubkey) db.prepare('UPDATE groups SET circle_starter = NULL, updated_at = ? WHERE id = ?').run(now, groupId);
}

/**
 * A circle was closed (state-engine closeGroupByVote, inside its transaction). A vote closes one with its flags still up, and
 * the next run would form the same people into a new one: they closed it, so the flags go, as they go when one retires.
 * A retired circle gave up its flags when it retired, so any flag now was said again since, and it stays: the timed close
 * comes this way too, and it is no answer to someone who said "I'd help" after their circle ended.
 */
export function afterClosingCircle(groupId: string): void {
    const row = db.prepare('SELECT kind, place_cell, circle_done_at FROM groups WHERE id = ?').get(groupId) as { kind: string | null; place_cell: string | null; circle_done_at: string | null } | undefined;
    const cell = parseCell(row?.place_cell ?? null);
    if (row?.kind === GROUP_KIND_CIRCLE && !row.circle_done_at && cell) clearHelpNear(activeMembers(groupId), cell, new Date().toISOString());
}

// ── what a member reads ──────────────────────────────────────────────────────────────────────────────────────────

interface CircleRow { id: string; kind: string | null; circle_done_at: string | null; circle_community_key: string | null; circle_starter: string | null; circle_starting_at: string | null }

const isClosed = (groupId: string): boolean => !!db.prepare('SELECT 1 FROM group_closures WHERE group_id = ?').get(groupId);

function isCircleMember(groupId: string, pubkey: string): boolean {
    return !!db.prepare(`SELECT 1 FROM group_members WHERE group_id = ? AND member_pubkey = ? AND status = 'active'`).get(groupId, pubkey);
}

/**
 * Who is starting one here, or null. Only they can take it back, so someone who no longer can holds it for nobody: a prune
 * or a deletion leaves group_members as it was, and a suspension holds it for no one while it lasts.
 */
function standingStarter(row: Pick<CircleRow, 'id' | 'circle_starter'>): string | null {
    const pk = row.circle_starter;
    return pk && isCircleMember(row.id, pk) && isNodeMember(db, pk) && !isSuspendedAccount(db, pk) ? pk : null;
}

/** The community that retired it, from the directory as it stands: its name is the directory's, not a copy of it. */
function circleCommunity(key: string | null): CircleCommunity | null {
    if (!key) return null;
    const row = db.prepare('SELECT community_key, name, node_url, accepting_knocks FROM directory_cache WHERE community_key = ? AND listed = 1').get(key) as
        { community_key: string; name: string | null; node_url: string | null; accepting_knocks: number | null } | undefined;
    if (!row) return null;
    return { key: row.community_key, name: row.name, url: row.node_url, acceptingKnocks: row.accepting_knocks === null ? null : row.accepting_knocks === 1 };
}

function cardOf(row: CircleRow, viewer: string): CircleCard {
    const people = activeMembers(row.id).length;
    const starter = standingStarter(row);
    return {
        people: people >= CIRCLE_MIN_PEOPLE ? people : null,
        starting: !starter ? null : starter === viewer ? 'you' : 'someone',
        doneAt: row.circle_done_at,
        community: circleCommunity(row.circle_community_key),
    };
}

/** A circle as a member of it reads it, or null: anyone else, or a group that is no circle. */
export function circleCardFor(groupId: string, viewer: string | undefined): CircleCard | null {
    if (!viewer) return null;
    const row = db.prepare('SELECT id, kind, circle_done_at, circle_community_key, circle_starter, circle_starting_at FROM groups WHERE id = ?').get(groupId) as CircleRow | undefined;
    if (row?.kind !== GROUP_KIND_CIRCLE || !isCircleMember(groupId, viewer)) return null;
    // Closed by a vote with no community: nothing here to offer or to say. A retired one keeps its line.
    if (!row.circle_done_at && isClosed(groupId)) return null;
    return cardOf(row, viewer);
}

/** The circle a member's Find card shows: the one still open, else the one retired most recently and not yet closed. */
export function circleOfMember(pubkey: string): (CircleCard & { id: string }) | null {
    const row = db.prepare(`SELECT g.id, g.kind, g.circle_done_at, g.circle_community_key, g.circle_starter, g.circle_starting_at
        FROM groups g JOIN group_members gm ON gm.group_id = g.id
        WHERE g.kind = ? AND gm.member_pubkey = ? AND gm.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM group_closures c WHERE c.group_id = g.id)
        ORDER BY g.circle_done_at IS NOT NULL, g.circle_done_at DESC, g.created_at DESC LIMIT 1`).get(GROUP_KIND_CIRCLE, pubkey) as CircleRow | undefined;
    return row ? { id: row.id, ...cardOf(row, pubkey) } : null;
}

export class CircleError extends Error {
    constructor(readonly status: 403 | 404 | 409, message: string) {
        super(message);
        this.name = 'CircleError';
    }
}

/**
 * "I'm starting one here", on or off, by a member of the circle. One at a time (a circle is a few people, and the
 * others can talk), and only the person who said it can take it back. Returns who to tell: the others, the first time
 * in CIRCLE_STARTING_QUIET_MS, so a tap on and off can't ring everyone's phone. A suspended member can't say it: the card
 * would show nobody (standingStarter), after ringing everyone and spending the quiet day. They can still take theirs back.
 */
export function setCircleStarting(groupId: string, pubkey: string, starting: boolean, nowMs: number = Date.now()): { card: CircleCard; tell: string[] } {
    return db.transaction(() => {
        const row = db.prepare('SELECT id, kind, circle_done_at, circle_community_key, circle_starter, circle_starting_at FROM groups WHERE id = ?').get(groupId) as CircleRow | undefined;
        if (row?.kind !== GROUP_KIND_CIRCLE || !isCircleMember(groupId, pubkey)) throw new CircleError(404, CIRCLE_NOT_YOURS);
        if (row.circle_done_at || isClosed(groupId)) throw new CircleError(409, CIRCLE_ENDED);
        if (starting && isSuspendedAccount(db, pubkey)) throw new CircleError(403, GROUP_START_PAUSED);
        const starter = standingStarter(row);
        if (starter && starter !== pubkey) throw new CircleError(409, CIRCLE_ALREADY_STARTING);
        const now = new Date(nowMs).toISOString();
        if (!starting) {
            db.prepare('UPDATE groups SET circle_starter = NULL, updated_at = ? WHERE id = ?').run(now, groupId);
            return { card: cardOf({ ...row, circle_starter: null }, pubkey), tell: [] };
        }
        if (row.circle_starter === pubkey) return { card: cardOf(row, pubkey), tell: [] };
        const lastTold = row.circle_starting_at ? Date.parse(row.circle_starting_at) : NaN;
        const quiet = Number.isFinite(lastTold) && nowMs - lastTold < CIRCLE_STARTING_QUIET_MS;
        db.prepare('UPDATE groups SET circle_starter = ?, circle_starting_at = ?, updated_at = ? WHERE id = ?').run(pubkey, quiet ? row.circle_starting_at : now, now, groupId);
        return { card: cardOf({ ...row, circle_starter: pubkey }, pubkey), tell: quiet ? [] : activeMembers(groupId).filter(m => m !== pubkey) };
    })();
}
