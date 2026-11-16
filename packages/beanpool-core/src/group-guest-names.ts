/**
 * The names a group's chat gives its guests' lines, on a member's device (slice G2 part 2; WALK 3, 16 Nov: a guest who left
 * was named by a key fragment on their old lines, because the host lists only the guests asked or in). One rule for both
 * apps: **a guest's line is named by the newest row this device has for that key, in every state (in, left, removed).**
 *
 * The host's list (`GET /api/groups/:id/guests`) is the newest word for everyone on it. This device also keeps the last row
 * it read for every guest, so a guest no longer listed (they left, a convenor removed them, the group closed, the owners
 * turned guests off) keeps their name on the lines they wrote, with "no longer in this group" beside it, as a member who
 * left keeps theirs.
 *
 * Only `shown` (the guests in the chat by the host's list read now) may be given a key (each app's keyring
 * noteShownRoster) or offered as a mention. `named` only names lines: a key never goes to a row the device remembers.
 */
import { guestNameLine } from './group-guest-chat.js';

/** A guest as the host lists them (engine/group-guests.ts GuestView). */
export interface GuestListed { key: string; home: string; name: string; state: string }

/** A row a group chat names lines by (each app's DisplayRosterRow): `gone` puts "no longer in this group" beside the name. */
export interface GuestNameRow { memberPubkey: string; callsign: string; gone?: boolean }

export interface GuestNameRows {
    /** In the chat, by the host's list read now: named, and the only guests a key may go to. */
    shown: GuestNameRow[];
    /** Every other guest this device has a row for: named on their lines only, never given a key. */
    named: GuestNameRow[];
}

/** A guest's row as this device keeps it: `state` as the host last listed them, `out` once a list read no longer has them. */
interface KeptGuest { name: string; home: string; state: string; at: number }

/** Guests a device keeps names for, per group; past it, the rows that changed longest ago go. */
export const GUEST_NAMES_KEPT = 200;
/** Where each app keeps them, beside its outside chats: `<this>:<group id>`. */
export const GUEST_NAMES_META = 'guest-names';

const KEY_HEX = /^[0-9a-f]{64}$/;

function readKept(json: string | null | undefined): Map<string, KeptGuest> {
    const out = new Map<string, KeptGuest>();
    if (!json) return out;
    try {
        const o = JSON.parse(json) as unknown;
        if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
        for (const [key, v] of Object.entries(o as Record<string, unknown>)) {
            const g = v as Partial<KeptGuest> | null;
            if (!KEY_HEX.test(key) || !g || typeof g.name !== 'string' || typeof g.home !== 'string' || typeof g.state !== 'string' || !Number.isFinite(g.at)) continue;
            out.set(key, { name: g.name, home: g.home, state: g.state, at: g.at as number });
        }
    } catch { /* nothing kept that reads */ }
    return out;
}

const keptJson = (kept: Map<string, KeptGuest>) => JSON.stringify(Object.fromEntries([...kept].sort(([a], [b]) => (a < b ? -1 : 1))));

/**
 * The rows a group's chat names its guests' lines by (the file's header), and what this device keeps now.
 *
 * `listed`: the host's list read now, or null when it couldn't be read. Read: each listed row replaces the one kept for its
 * key; everyone kept and not listed is out; `shown` are those listed `in`, in the host's order. Not read: nobody is
 * `shown`, and each guest is named by the row kept here, "no longer in this group" only beside one this device last saw
 * out. `json`: the rows to keep, or null when nothing changed.
 */
export function guestNameRows(kept: string | null | undefined, listed: readonly GuestListed[] | null, now: number): GuestNameRows & { json: string | null } {
    const rows = readKept(kept);
    const before = keptJson(rows);
    const valid = (listed ?? []).filter((g): g is GuestListed => !!g && typeof g.key === 'string' && KEY_HEX.test(g.key)
        && typeof g.name === 'string' && typeof g.home === 'string' && typeof g.state === 'string');
    for (const g of valid) {
        const was = rows.get(g.key);
        // The newest row wins. Its time moves only when it changed, so reading the same list again keeps nothing new.
        if (!was || was.name !== g.name || was.home !== g.home || was.state !== g.state) rows.set(g.key, { name: g.name, home: g.home, state: g.state, at: now });
    }
    if (listed) {
        const on = new Set(valid.map((g) => g.key));
        for (const [key, g] of rows) if (!on.has(key) && g.state !== 'out') rows.set(key, { ...g, state: 'out', at: now });
    }
    const keep = new Map([...rows].sort(([a, x], [b, y]) => y.at - x.at || (a < b ? -1 : 1)).slice(0, GUEST_NAMES_KEPT));
    const shownKeys = new Set(listed ? valid.filter((g) => g.state === 'in').map((g) => g.key) : []);
    const shown = [...shownKeys].map((key) => ({ memberPubkey: key, callsign: guestNameLine(rows.get(key)!.name, rows.get(key)!.home) }));
    const named: GuestNameRow[] = [];
    for (const [key, g] of keep) {
        if (!shownKeys.has(key)) named.push({ memberPubkey: key, callsign: guestNameLine(g.name, g.home), gone: listed ? true : g.state !== 'in' });
    }
    const json = keptJson(keep);
    return { shown, named, json: json === before ? null : json };
}
