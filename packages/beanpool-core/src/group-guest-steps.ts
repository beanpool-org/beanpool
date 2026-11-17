/**
 * A guest in a group hosted by another community: what their phone sends after the host's roster (slice G1b:
 * scratch/fable-design/DESIGN-cross-chat-voice-fable.md §4.2; the host's side is the server's engine/group-guests.ts, the
 * guest's own server's engine/group-guest-home.ts). One function for both apps (G2), so the phone and the web app take the
 * same step from the same roster.
 *
 * The host sends the roster at every change of who is in the chat, and after a guest's item came back `epoch-stale`. It
 * carries the names in the chat (members and guests: exactly the keys an epoch must wrap to) and the current epoch: null
 * (the group has none yet), stale (a new one is due), or not stale with its signed record and this guest's own wrap. The
 * guest's server keeps the latest for each group by host (step 1); their phone waits for it after `epoch-stale` (step 2);
 * then guestEpochStep says which of two things to send:
 *
 *   3. the epoch is null or stale: make the next epoch over exactly the members' and guests' keys, and send it as
 *      `group-epoch` (`join` for the guest's first, after their yes; `rotate` after that);
 *   4. the epoch is not stale: open the key from the guest's wrap, and send the line again under that epoch.
 *
 * Nothing here trusts the roster further than a member trusts their own server's: the record's signature and the key's
 * commitment are checked as they open (openMyGroupKey), and the host checks an epoch against its own roster.
 */
import {
    makeGroupEpochRecord, openMyGroupKey, type GroupEpochRecord, type GroupServedWrap,
} from './group-crypto.js';

const KEY_HEX = /^[0-9a-f]{64}$/;

/** One wrap as the host sends it: the record's own, to this guest. */
export interface GuestRosterWrap { recipient: string; wrapper: string; ephPub: string; nonce: string; wrapped: string }

/** The current epoch, as a roster carries it. */
export type GuestRosterEpoch =
    | null
    | { current: number; stale: true }
    | { current: number; stale: false; record: GroupEpochRecord; wraps: GuestRosterWrap[] };

/**
 * The names of people no longer in the chat whose lines a guest there may have (engine/group-guests.ts formerInChat; WALK
 * nov17b finding (a): a fellow guest who left or was removed was named by a key fragment on a guest's phone). Names only:
 * none of these keys is one an epoch wraps to, and nothing here ever goes into `members` or `guests`.
 */
export interface GuestRosterFormer {
    /** Members who wrote in the chat and are out of it now (left, taken out, no longer members): their name as the chat names them. */
    members: Array<{ key: string; name: string }>;
    /** Guests who wrote in the chat and are out of it now: their card's name, their community, and where they stand at the host (`left`, `removed`, or `invited` again). */
    guests: Array<{ key: string; home: string; name: string; state: string }>;
}

/** What the host sends a guest's home at every change of the chat's names (engine/group-guests.ts queueGroupRoster). */
export interface GuestRoster {
    name: string;
    members: Array<{ key: string; name: string }>;
    guests: Array<{ key: string; home: string; name: string }>;
    epoch: GuestRosterEpoch;
    /** People no longer in the chat whose lines its guests may have, named (GuestRosterFormer); absent when the host sent none. */
    former?: GuestRosterFormer;
}

/** At most this many names of each kind are read from a roster's `former` (the host sends at most ROSTER_FORMER_MAX in all). */
export const GUEST_ROSTER_FORMER_READ = 200;

const isKeyList = (v: unknown, extra: (o: Record<string, unknown>) => boolean): boolean =>
    Array.isArray(v) && v.every((o) => !!o && typeof o === 'object' && KEY_HEX.test(String((o as { key?: unknown }).key)) && extra(o as Record<string, unknown>));

/** A roster's `former`, read: each name that is one kept, anything else left out (a name never costs the roster). */
function readFormer(v: unknown): GuestRosterFormer {
    const o = v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    const named = (x: unknown): x is Record<string, string> => !!x && typeof x === 'object'
        && KEY_HEX.test(String((x as { key?: unknown }).key)) && typeof (x as { name?: unknown }).name === 'string';
    const members = (Array.isArray(o.members) ? o.members : []).filter(named).slice(0, GUEST_ROSTER_FORMER_READ)
        .map((m) => ({ key: m.key, name: m.name }));
    const guests = (Array.isArray(o.guests) ? o.guests : []).filter((g): g is Record<string, string> => named(g) && typeof g.home === 'string' && typeof g.state === 'string')
        .slice(0, GUEST_ROSTER_FORMER_READ).map((g) => ({ key: g.key, home: g.home, name: g.name, state: g.state }));
    return { members, guests };
}

/** A roster as it came (the host's `data`), or null when it is not one. */
export function readGuestRoster(json: unknown): GuestRoster | null {
    const o = json as Record<string, unknown> | null;
    if (!o || typeof o !== 'object' || typeof o.name !== 'string') return null;
    if (!isKeyList(o.members, (m) => typeof m.name === 'string')) return null;
    if (!isKeyList(o.guests, (g) => typeof g.name === 'string' && typeof g.home === 'string')) return null;
    const base = { ...(o as unknown as GuestRoster), ...(o.former !== undefined ? { former: readFormer(o.former) } : {}) };
    const e = o.epoch as Record<string, unknown> | null | undefined;
    if (e === null) return { ...base, epoch: null };
    if (!e || typeof e !== 'object' || !Number.isSafeInteger(e.current) || (e.current as number) < 1 || typeof e.stale !== 'boolean') return null;
    if (e.stale) return { ...base, epoch: { current: e.current as number, stale: true } };
    const record = e.record as GroupEpochRecord | undefined;
    if (!record || typeof record !== 'object' || record.epoch !== e.current || !Array.isArray(e.wraps)) return null;
    return base;
}

/** What a guest's phone sends next, from the latest roster. */
export type GuestEpochStep =
    /** Step 3: the next epoch, made over exactly `recipients` (members and guests), sent as `group-epoch`. */
    | { send: 'group-epoch'; epoch: number; reason: 'join' | 'rotate'; recipients: string[] }
    /** Step 4: the current epoch's key, opened from `wrap`; the line goes again under `epoch`. */
    | { send: 'group-line'; epoch: number; record: GroupEpochRecord; wrap: GuestRosterWrap }
    /** Nothing: the roster doesn't name this guest (they left or were removed), or it says the epoch covers them and holds no wrap for them. */
    | { send: 'nothing'; why: 'not-in-roster' | 'no-wrap' };

/**
 * The step a guest (`me`, their key) takes from `roster`. `joining`: this is their first epoch in the group (the roster
 * after their yes), so a new epoch is their `join` (the newcomer makes it themselves, as an invited member does).
 */
export function guestEpochStep(roster: GuestRoster, me: string, opts: { joining?: boolean } = {}): GuestEpochStep {
    if (!roster.guests.some((g) => g.key === me)) return { send: 'nothing', why: 'not-in-roster' };
    const e = roster.epoch;
    if (e === null || e.stale) {
        const recipients = [...new Set([...roster.members.map((m) => m.key), ...roster.guests.map((g) => g.key)])].sort();
        return { send: 'group-epoch', epoch: e === null ? 1 : e.current + 1, reason: opts.joining || e === null ? 'join' : 'rotate', recipients };
    }
    const wrap = e.wraps.find((w) => w.recipient === me);
    return wrap ? { send: 'group-line', epoch: e.current, record: e.record, wrap } : { send: 'nothing', why: 'no-wrap' };
}

/**
 * Step 3 made: the `group-epoch` item's payload (`{"epoch": <record with its wraps>}`) and the new key, for a guest whose
 * private key is `myEdPrivHex`. The host takes it as a member's (its storeGroupEpoch, `join` or `rotate`).
 */
export function makeGuestEpoch(
    step: Extract<GuestEpochStep, { send: 'group-epoch' }>, groupId: string, me: string, myEdPrivHex: string, createdAt: string,
): { payload: string; groupKey: Uint8Array } {
    const { record, groupKey } = makeGroupEpochRecord({
        myEdPrivHex, groupId, epoch: step.epoch, reason: step.reason, subject: step.reason === 'join' ? me : null, createdAt, recipients: step.recipients,
    });
    return { payload: JSON.stringify({ epoch: record }), groupKey };
}

/**
 * Step 4 made: the current epoch's key, from the guest's wrap, its record's signature and commitment checked. The host's
 * record travels without its group id (it is the notice's `group`); the signature covers it, so a record made for another
 * group doesn't open as this one's.
 */
export function openGuestEpochKey(step: Extract<GuestEpochStep, { send: 'group-line' }>, groupId: string, myEdPrivHex: string): Uint8Array {
    const served: GroupServedWrap = { epoch: step.epoch, wrapper: step.wrap.wrapper, ephPub: step.wrap.ephPub, nonce: step.wrap.nonce, wrapped: step.wrap.wrapped, sig: null };
    return openMyGroupKey({ ...step.record, groupId }, served, myEdPrivHex, { groupId, epoch: step.epoch });
}
