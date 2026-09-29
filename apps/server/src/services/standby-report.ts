/**
 * The report a standby sends its main server with each pull (design scratch/global-node/DESIGN-standby-takeover-gaps-
 * opus.md §2 G8): how its last copy went and whether its last whole copy was the main server's exactly. One request
 * header, `X-Standby-Report`, a small JSON object, on the replication-token channel (routes/backup.ts sync-snapshot and
 * sync-delta).
 *
 * The main server trusts it for one thing only: telling the community's owners that their standby needs them
 * (services/standby-health.ts). So it is read strictly: a fixed set of fields, each of a fixed shape and size, times as
 * ages (so neither server's clock matters), reasons as codes from a fixed list, tables by name from the manifest. Anything
 * else and the whole report is ignored. It never carries free text.
 */

import { TABLES } from '../engine/replication-manifest.js';

export const STANDBY_REPORT_HEADER = 'X-Standby-Report';
/** A report longer than this is ignored whole. */
export const STANDBY_REPORT_MAX_CHARS = 2048;
const MAX_AGE_MS = 10 * 365 * 24 * 3600_000;
const MAX_DIFFERS = 40;
/** At most this many tables left out, or refused over, in one report (design §4.2, N4). */
export const MAX_TABLES_NAMED = 10;

/** How the standby's last pull went: its copy landed; the copy came and was refused or failed to import; or no copy came. */
export type PullOutcome = 'ok' | 'refused' | 'fetch-failed';

/**
 * Why, as a code (never the error's own text): refused by the ledger's conservation check, a signature or signer that
 * isn't the main server's, a table the ledger needs whole with more rows than one copy carries (`oversized`, the tables in
 * the report's `oversized`), any other failure to import; and for a copy that never came, a timeout, an unreachable main
 * server, an answer that wasn't a copy, or an HTTP status.
 */
export type WhyCode = 'conservation' | 'signature' | 'oversized' | 'import-error' | 'timeout' | 'network' | 'unparseable' | `http-${number}`;
const WHY = /^(conservation|signature|oversized|import-error|timeout|network|unparseable|http-[1-5]\d\d)$/;

/** What a whole copy found different: a copied table by name, or one of these. */
export const LEDGER_DIFFERS = { ledger: 'ledger', commons: 'commons' } as const;

function differsName(name: unknown): name is string {
    if (typeof name !== 'string') return false;
    if ((Object.values(LEDGER_DIFFERS) as string[]).includes(name)) return true;
    return tableName(name);
}

/** A copied table, by the manifest's name. */
function tableName(name: unknown): name is string {
    if (typeof name !== 'string') return false;
    const entry = Object.prototype.hasOwnProperty.call(TABLES, name) ? TABLES[name] : undefined;
    return !!entry && (entry.kind === 'replicated' || entry.kind === 'replicated-except');
}

/** A report's list of tables: absent (a standby older than the list) is none. */
function tablesOf(v: unknown): string[] | null {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > MAX_TABLES_NAMED || !v.every(tableName)) return null;
    return [...new Set<string>(v)];
}

export interface StandbyReport {
    v: 1;
    /** The standby's own id for these reports (random, 32 hex): a main server with two standbys keeps each apart. */
    id: string;
    /** Its last pull; 'none' before its first. */
    last: PullOutcome | 'none';
    why: WhyCode | null;
    /** Copies that came and were refused or failed to import, in a row, since the last that landed. */
    fails: number;
    /** How long ago its last copy landed, in ms; null: none yet. */
    okAgo: number | null;
    /** How long ago its last whole copy was checked; null: none yet. */
    wholeAgo: number | null;
    /** Whether that whole copy was the main server's exactly; null: none checked yet. */
    exact: boolean | null;
    /** How long ago its last exact whole copy was; null: none yet. */
    exactAgo: number | null;
    /** What that whole copy found different (empty when exact). */
    differs: string[];
    /** Whether the check compared each table's content (the main server sent its hashes), not only the counts. */
    hashed: boolean;
    /**
     * That whole copy didn't match, and the standby is mending it by itself: it asked for its held force-resync, and no
     * check since has given a verdict (services/standby-copy-record.ts). The main server tells nobody of it yet.
     */
    healing: boolean;
    /**
     * Tables the standby's copies leave out, because this server holds more rows of them than one copy carries (design
     * scratch/global-node/DESIGN-replica-flood-bounds-opus.md §5): stale there, the rest copied. At most MAX_TABLES_NAMED.
     */
    leftOut: string[];
    /**
     * Tables the ledger needs whole that this server holds more rows of than one copy carries: the standby refuses every
     * whole copy (deltas may still land) and keeps the last one it took. At most MAX_TABLES_NAMED.
     */
    oversized: string[];
}

const age = (v: unknown): v is number | null => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_AGE_MS);

/** A report as the header carries it, or null when it isn't one: then it is ignored, whole. */
export function parseStandbyReport(raw: unknown): StandbyReport | null {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > STANDBY_REPORT_MAX_CHARS) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const r = parsed as Record<string, unknown>;
    if (r.v !== 1) return null;
    if (typeof r.id !== 'string' || !/^[0-9a-f]{32}$/.test(r.id)) return null;
    const last = r.last;
    if (last !== 'ok' && last !== 'refused' && last !== 'fetch-failed' && last !== 'none') return null;
    if (!(r.why === null || (typeof r.why === 'string' && WHY.test(r.why)))) return null;
    const fails = r.fails;
    if (typeof fails !== 'number' || !Number.isInteger(fails) || fails < 0 || fails > 1_000_000) return null;
    const { okAgo, wholeAgo, exactAgo, exact, differs, hashed, healing } = r;
    if (!age(okAgo) || !age(wholeAgo) || !age(exactAgo)) return null;
    if (!(exact === null || typeof exact === 'boolean')) return null;
    if (!Array.isArray(differs) || differs.length > MAX_DIFFERS || !differs.every(differsName)) return null;
    if (typeof hashed !== 'boolean' || typeof healing !== 'boolean') return null;
    const leftOut = tablesOf(r.leftOut);
    const oversized = tablesOf(r.oversized);
    if (!leftOut || !oversized) return null;
    return {
        v: 1, id: r.id, last, why: r.why as WhyCode | null, fails, okAgo, wholeAgo,
        exact, exactAgo, differs: [...new Set<string>(differs)], hashed, healing: exact === false && healing, leftOut, oversized,
    };
}

// ── Plain words, for the owners' notice and the take-over preview ─────────────────────────

const TABLE_WORDS: Record<string, string> = {
    members: 'members',
    posts: 'listings',
    post_photos: 'listing photos',
    projects: 'crowdfunding projects',
    ratings: 'ratings',
    accounts: 'accounts',
    transactions: 'payments',
    marketplace_transactions: 'deals',
    friends: 'friend lists',
    conversations: 'chats',
    conversation_participants: 'who is in each chat',
    messages: 'chat messages',
    abuse_reports: 'reports',
    creator_channels: 'creator channels',
    pulse_items: 'Daily Pulse items',
    recovery_shares: 'sign-in recovery copies',
    settlements: 'settlements with other communities',
    poll_votes: 'poll votes',
    event_rsvps: 'event replies',
    groups: 'groups',
    group_members: 'group members',
    open_joins: 'open-door joins',
    place_watches: 'place watches',
    directory_cache: 'the communities directory',
    join_requests: 'requests to join',
    moderation_notices: 'moderation notices',
    member_blocks: 'block lists',
    invalidated_keys: 'replaced keys',
    treasury_operators: 'who keeps each enterprise',
    enterprise_pledges: "keepers' pledges",
    member_preferences: "members' settings",
    deferred_wage_claims: "keepers' wages owed",
    invite_codes: 'invites',
    tombstones: 'deletions',
    [LEDGER_DIFFERS.ledger]: "members' balances",
    [LEDGER_DIFFERS.commons]: 'the Commons',
};

/** The tables whose words (TABLE_WORDS) name one thing rather than many: "the communities directory", not "chat messages". */
const ONE_THING = new Set(['conversation_participants', 'directory_cache', 'treasury_operators', LEDGER_DIFFERS.commons]);

/** "it" or "them" for what differsInWords says of these tables: by its words, "chat messages" are them, however many tables. */
export function pronounOf(tables: readonly string[]): 'it' | 'them' {
    return tables.length === 1 && ONE_THING.has(tables[0]) ? 'it' : 'them';
}

/** "members' balances, listings and chat messages". */
export function differsInWords(differs: string[]): string {
    const words = differs.map((d) => TABLE_WORDS[d] ?? d.replace(/_/g, ' '));
    if (words.length <= 1) return words[0] ?? 'nothing';
    return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function whyInWords(why: string | null): string {
    if (!why) return 'for a reason it did not record';
    if (why === 'conservation') return "the copy would have changed the ledger's total, so the ledger check refused it";
    if (why === 'signature') return "the copy's signature was not the main server's";
    if (why === 'oversized') return 'the main server holds more rows of a table the ledger needs whole than one copy carries';
    if (why === 'import-error') return 'the copy could not be written';
    if (why === 'timeout') return 'the main server did not answer in time';
    if (why === 'network') return 'the main server could not be reached';
    if (why === 'unparseable') return "the main server's answer was not a copy";
    const http = /^http-(\d{3})$/.exec(why);
    if (http) return `the main server answered HTTP ${http[1]}`;
    return why;
}

/** "2026-09-28 14:03 UTC": one way, on both servers and every screen that shows the server's words. */
export function timeInWords(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) return 'never';
    return new Date(ms).toISOString().replace('T', ' ').replace(/:\d\d\.\d{3}Z$/, ' UTC');
}
