/**
 * Who decides a removal: the community's rule (scratch/fable-design/DESIGN-removal-jury-fable.md §6; Marty accepted all ten
 * answers 29 Oct). A pause opens a vote on removing the member (decisions-engine.ts pauseMember); this says who votes on it.
 *
 *   - `automatic`: a jury drawn at random once the eligible pool reaches JURY_LINE (100), everyone until then.
 *   - `everyone`: every member who could vote, the rule removal by vote S1–S6 built (25% turnout, 66%, at least 3 Yes).
 *   - `jury`: a jury whatever the size, for a pool of at least JURY_MIN_POOL (36, three juries' worth): locked below it
 *     (`pool_too_small`, config/community-shape.ts), and a pause made while the pool is under it is decided by everyone.
 *
 * Decided once per case, at the pause, from that day's pool, and recorded on the vote (`params.decider`), so changing this,
 * or the community crossing the line, changes nothing about a vote already open.
 *
 * ## The default, for now
 *
 * The design's default is `automatic`. Until the apps can show a jury (slice J3: the juror's buttons, the turnout line,
 * Check the draw), the default is `everyone`, so nothing changes for a community that never chose: J1 and J2 ship behind
 * this setting, and J3 turns the default to `automatic`. A choice an owner makes is always stored, even `everyone`, so
 * that change of default never overrides one.
 *
 * ## What travels
 *
 * A node_config row (`removal_decider`), one of the community's own settings (config/community-settings.ts): a standby
 * keeps the main server's, and a take-over installs it. Changed only under How this community works, by an owner
 * (config/community-shape-write.ts).
 */
import { JURY_LINE, JURY_MIN_POOL } from '@beanpool/core';
import { db } from '../db/db.js';

export type RemovalDecider = 'automatic' | 'everyone' | 'jury';

export const REMOVAL_DECIDER_KEY = 'removal_decider';
/** Until slice J3 (see the header): `everyone`, so nothing changes for a community that never chose. */
export const DEFAULT_REMOVAL_DECIDER: RemovalDecider = 'everyone';
/** Every rule. */
export const REMOVAL_DECIDERS: readonly RemovalDecider[] = ['automatic', 'everyone', 'jury'];

export function isRemovalDecider(v: unknown): v is RemovalDecider {
    return v === 'automatic' || v === 'everyone' || v === 'jury';
}

let warnedBadRow: string | null = null;

/** A `removal_decider` row's value as the rule it sets (null: no row). Anything else reads as the default, said once. */
export function removalDeciderFromRow(value: string | null): RemovalDecider {
    if (value === null) return DEFAULT_REMOVAL_DECIDER;
    if (isRemovalDecider(value)) return value;
    if (warnedBadRow !== value) {
        warnedBadRow = value;
        console.warn(`⚠️  node_config ${REMOVAL_DECIDER_KEY}=${JSON.stringify(value)} is not a rule (automatic, everyone or jury), so removals here are decided as by default (${DEFAULT_REMOVAL_DECIDER}).`);
    }
    return DEFAULT_REMOVAL_DECIDER;
}

export function removalDeciderRow(): string | null {
    const row = db.prepare('SELECT value FROM node_config WHERE key = ?').get(REMOVAL_DECIDER_KEY) as { value: string | null } | undefined;
    return row?.value ?? null;
}

/** This community's rule: its row, or the default when there is none. */
export function removalDecider(): RemovalDecider {
    return removalDeciderFromRow(removalDeciderRow());
}

/** Set the rule. Always a row, the default included, so a later change of default never overrides an owner's choice. */
export function setRemovalDecider(rule: RemovalDecider): void {
    if (!isRemovalDecider(rule)) throw new Error(`${String(rule)} is not a rule for who decides a removal`);
    db.prepare('INSERT INTO node_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(REMOVAL_DECIDER_KEY, rule);
}

/** Who decides a case paused today, from the rule and the size of today's eligible pool. */
export function deciderFor(rule: RemovalDecider, poolSize: number): 'jury' | 'everyone' {
    if (rule === 'everyone') return 'everyone';
    return poolSize >= (rule === 'jury' ? JURY_MIN_POOL : JURY_LINE) ? 'jury' : 'everyone';
}
