/**
 * Every BeanPool registrar name this community's key has held: node_config `registrarNames`, one entry per host
 * (design scratch/registrar/DESIGN-lost-name-audience-opus.md §4.1, L1).
 *
 * Marty's rule (2026-09-24): a community never loses its own name through a check, a bug or a stale registrar. Before
 * this record the node forgot a name at once in three places: Settings' status check wiped the saved address and the
 * tunnel token when the registrar answered `none` (a registrar that lost its data, or ran with the wrong database,
 * answers that to every key); a live answer naming another name replaced the old one; and Take offline dropped it.
 * Members' apps that still reached the community by that name were then refused (421), or a node with no other name
 * fell back to `unconfigured` and accepted any host.
 *
 * So:
 *  - ONE writer, recordRegistrarAnswer(), called with every registrar answer the node acts on: the public-address
 *    agent's (services/public-address-agent.ts) and Settings' status, claim and Take offline (routes/public-address.ts).
 *  - No answer ever deletes an entry. `none`, `released`, `revoked`, `blocked` and `paused` are written on the entry
 *    and the name stays. The name the node stores as its `publicAddress` is `current`; one it stored before is
 *    `former`. A live answer naming another name makes that one current and the old one former.
 *  - Take offline (this node's own release) records when, and until when the registrar holds the name for this key:
 *    its answer's `held_until`, and nothing when the answer gives none. A release answer without one means the registrar
 *    freed the name at once (a withdrawn gated claim, an older Worker's `revoked`), so no hold is invented here (#1247's
 *    review, 4115220670). The name stays accepted either way (decision D-B, pending Marty; stopping it needs L3).
 *  - Only real registrar names are recorded: one label of 3-32 characters under beanpool.org, as the registrar's own
 *    NAME_RE allows (apps/registrar/src/index.js). A host any answer, stored address or take-over envelope names outside
 *    that is never recorded, so a misbehaving or mis-pointed registrar can't make one permanent (4115220781); such a host
 *    is still accepted while it is the stored `publicAddress` (item 1 of own-addresses.ts), as before.
 *
 * engine/own-addresses.ts accepts every entry, current and former, whatever its status (item 4), and publishes only
 * the current one. The record travels in the take-over envelope beside `ownerAddresses`, so a promoted standby
 * accepts the same names.
 *
 * Bounded: at most MAX_REGISTRAR_NAMES entries (a name is recorded only after the registrar gave it to this key, so
 * reaching that takes as many successful claims), each field a short string. A full record adds no new name, and
 * forgets none.
 */

import { audienceOf } from '@beanpool/core';
import { getNodeConfig, updateNodeConfig, type NodeConfig } from '../state-engine.js';
import { logger } from '../logger.js';

export type RegistrarNameRole = 'current' | 'former';

export interface RegistrarName {
    /** The host members' apps sign for: `<name>.beanpool.org`. */
    address: string;
    /** `current`: the name stored as this node's `publicAddress`, one at most. `former`: a name it held before. */
    role: RegistrarNameRole;
    /** The registrar's latest word on it: live, pending, paused, blocked, released, revoked, none, … */
    status: string;
    /** The registrar's reason for that status, when it gave one. */
    reason: string | null;
    /** When this node first recorded it (ISO). */
    since: string;
    /** When it last became former (ISO), or null while it is current. */
    formerSince: string | null;
    /** Until when the registrar holds it for this key after this node released it (ISO), or null. */
    heldUntil: string | null;
    /** When this node released it itself (Settings → Take offline), or null. Taking it back clears it. */
    releasedByUsAt: string | null;
    /** When this node's own claim of another name made it former, or null. */
    renamedByUsAt: string | null;
}

/**
 * How the caller acts on the registrar's answer:
 *  - `stored`: it stores the answer as the node's `publicAddress` (the agent's persist, Settings' claim, a live status
 *    answer). The name it gives becomes current. `claim` too, and it is the node's own act: the name it displaces is
 *    marked renamed by us.
 *  - `status`: it doesn't store it. Written on the entry it names, or on the current one when it names none (`none`);
 *    never adds a name.
 *  - `released`: Settings → Take offline answered. The name released (the answer's, else the current one) becomes
 *    former, with when and until when it is held.
 */
export type RegistrarAnswerUse = 'stored' | 'claim' | 'status' | 'released';

export const MAX_REGISTRAR_NAMES = 50;
/** The registrar's hold on a name its owner released (RELEASE_COOLOFF_S), when its answer doesn't say. */
const REGISTRAR_ZONE = 'beanpool.org';

let version = 0;
/** Moves on every write, so a cached list of this community's names (own-addresses.ts) is read again at once. */
export function registrarNamesVersion(): number {
    return version;
}

const hostOf = (input: unknown): string | null => {
    if (typeof input !== 'string') return null;
    const host = audienceOf(input);
    return host && host.length <= 253 ? host : null;
};

/** A host the registrar can give: one label of 3-32 characters (its NAME_RE) under beanpool.org. */
const REGISTRAR_NAME_HOST = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])\.beanpool\.org$/;
export const isRegistrarNameHost = (host: string | null): host is string => !!host && REGISTRAR_NAME_HOST.test(host);

/**
 * The registrar name a registrar answer (or a stored `publicAddress`) names: `<name>.beanpool.org`, else its hostname,
 * and only when that is a host the registrar can give (isRegistrarNameHost); otherwise null.
 */
export function registrarHostOf(answer: unknown): string | null {
    if (!answer || typeof answer !== 'object') return null;
    const a = answer as Record<string, unknown>;
    if (typeof a.name === 'string' && a.name.trim()) {
        const n = a.name.trim();
        const host = hostOf(n.includes('.') ? n : `${n}.${REGISTRAR_ZONE}`);
        if (host) return isRegistrarNameHost(host) ? host : null;
    }
    const host = hostOf(a.hostname);
    return isRegistrarNameHost(host) ? host : null;
}

const word = (v: unknown, fallback: string): string =>
    typeof v === 'string' && /^[a-z][a-z0-9_-]{0,31}$/i.test(v.trim()) ? v.trim().toLowerCase() : fallback;
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
const isoOrNull = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** The registrar's `held_until` (unix seconds), as an ISO time, or null when it gave none that could be one. */
function heldUntilOf(v: unknown, now: number): string | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const ms = v * 1000;
    // No more than a year on: a hold is 30 days.
    return ms > 0 && ms <= now + 366 * 86_400_000 ? new Date(ms).toISOString() : null;
}

function entryOf(raw: unknown): RegistrarName | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const address = hostOf(r.address);
    if (!isRegistrarNameHost(address)) return null;
    return {
        address,
        role: r.role === 'current' ? 'current' : 'former',
        status: word(r.status, 'unknown'),
        reason: text(r.reason),
        since: isoOrNull(r.since) ?? new Date(0).toISOString(),
        formerSince: isoOrNull(r.formerSince),
        heldUntil: isoOrNull(r.heldUntil),
        releasedByUsAt: isoOrNull(r.releasedByUsAt),
        renamedByUsAt: isoOrNull(r.renamedByUsAt),
    };
}

/** The record as stored (or as a take-over envelope carried it): each host once, one current at most, bounded. */
export function parseRegistrarNames(stored: unknown): RegistrarName[] {
    if (!Array.isArray(stored)) return [];
    const out: RegistrarName[] = [];
    for (const raw of stored) {
        const e = entryOf(raw);
        if (!e || out.some((x) => x.address === e.address)) continue;
        if (e.role === 'current' && out.some((x) => x.role === 'current')) e.role = 'former';
        out.push(e);
        if (out.length >= MAX_REGISTRAR_NAMES) break;
    }
    return out;
}

/**
 * Every registrar name this key has held: the record, and the stored `publicAddress`'s name when the record doesn't
 * have it yet (a node from before the record, or a take-over envelope sealed before it travelled).
 */
export function registrarNames(config: NodeConfig = getNodeConfig(), now = Date.now()): RegistrarName[] {
    const list = parseRegistrarNames((config as any).registrarNames);
    const pa = config.publicAddress;
    const host = registrarHostOf(pa);
    if (host && !list.some((e) => e.address === host) && list.length < MAX_REGISTRAR_NAMES) {
        const current = !list.some((e) => e.role === 'current');
        list.push({
            address: host, role: current ? 'current' : 'former', status: word((pa as any)?.status, 'unknown'), reason: null,
            since: new Date(now).toISOString(), formerSince: null, heldUntil: null, releasedByUsAt: null, renamedByUsAt: null,
        });
    }
    return list;
}

/**
 * The one writer of the record. Called with every registrar answer the node acts on, BEFORE the caller changes the
 * stored `publicAddress` (the name stored until now is recorded first, so the answer can only add to it). Never
 * deletes an entry. Returns the record as it now stands.
 */
export function recordRegistrarAnswer(answer: unknown, use: RegistrarAnswerUse, now = Date.now()): RegistrarName[] {
    const config = getNodeConfig();
    const before = JSON.stringify(parseRegistrarNames((config as any).registrarNames));
    const list = registrarNames(config, now);
    const at = new Date(now).toISOString();
    const a = (answer && typeof answer === 'object' ? answer : {}) as Record<string, unknown>;
    const host = registrarHostOf(a);
    const status = word(a.status, use === 'released' ? 'released' : 'unknown');
    const reason = text(a.reason);
    const find = (h: string | null) => (h ? list.find((e) => e.address === h) : undefined);
    const current = () => list.find((e) => e.role === 'current');
    const makeFormer = (e: RegistrarName) => {
        if (e.role === 'former') return;
        e.role = 'former';
        e.formerSince = at;
    };

    if (use === 'stored' || use === 'claim') {
        if (host) {
            let entry = find(host);
            if (!entry) {
                if (list.length >= MAX_REGISTRAR_NAMES) {
                    logger.warn('AUTH', `Registrar names: ${host} was not recorded, because ${MAX_REGISTRAR_NAMES} names already are. `
                        + 'None of them is forgotten; this one is accepted while it is the stored address.');
                } else {
                    entry = { address: host, role: 'former', status, reason, since: at, formerSince: null, heldUntil: null, releasedByUsAt: null, renamedByUsAt: null };
                    list.push(entry);
                }
            }
            if (entry) {
                for (const e of list) {
                    if (e === entry || e.role !== 'current') continue;
                    makeFormer(e);
                    if (use === 'claim') e.renamedByUsAt = at;
                }
                entry.role = 'current';
                entry.formerSince = null;
                entry.status = status;
                entry.reason = reason;
                // Stored again, it is this community's in use: a hold from an earlier release is over (taken back).
                entry.releasedByUsAt = null;
                entry.heldUntil = null;
                entry.renamedByUsAt = null;
            }
        }
    } else if (use === 'status') {
        // Only a name already recorded: an answer the node doesn't store never adds one.
        const entry = host ? find(host) : current();
        if (entry) {
            entry.status = status;
            entry.reason = reason;
            const held = heldUntilOf(a.held_until, now);
            if (held) entry.heldUntil = held;
        }
    } else {
        const entry = find(host) ?? current();
        if (entry) {
            makeFormer(entry);
            entry.status = status;
            entry.reason = reason;
            entry.releasedByUsAt = at;
            entry.heldUntil = heldUntilOf(a.held_until, now);
        }
    }

    if (JSON.stringify(list) !== before) {
        updateNodeConfig({ registrarNames: list });
        version++;
    }
    return list;
}
