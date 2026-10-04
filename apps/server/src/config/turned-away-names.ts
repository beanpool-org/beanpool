// Names this server turned away (#1579 review r4175807589): an install request that ended without the name being given
// here, a Settings claim that got no answer in time and was then replaced (another pick, Take offline), a `beanpool claim`
// request replaced by another, a name taken offline. With nothing stored, a registrar answer naming one of them is never
// stored (services/tunnel-connector.ts turnedAwayHere): the community never comes back on a name nobody chose last.
//
// Kept short: the latest TURNED_AWAY_MAX, oldest dropped. Per server, never copied (replication manifest, backups' left-out
// list, the stager's), like addressRequest.

import { getLocalConfig, updateLocalConfig } from './local-config.js';

export const TURNED_AWAY_MAX = 8;

/**
 * Why a name is on the list. `unanswered`: a Settings claim that got no answer in time; it is the owner's latest choice
 * until another write replaces it (settleUnansweredClaims), so it is not turned away until then.
 */
export type TurnedAwayWhy = 'install-request-ended' | 'request-replaced' | 'claim-replaced' | 'taken-offline' | 'unanswered';
export interface TurnedAwayName { name: string; at: number; why: TurnedAwayWhy }

/** The list, oldest first. A node from before it kept one ended install request (endedAddressRequest): read in as the oldest. */
export function turnedAwayList(): TurnedAwayName[] {
    const cfg = getLocalConfig();
    const list = Array.isArray(cfg.turnedAwayNames) ? cfg.turnedAwayNames.filter((e) => e && typeof e.name === 'string') : [];
    const ended = cfg.endedAddressRequest;
    if (ended && typeof ended.name === 'string' && !list.some((e) => e.name === ended.name)) {
        return [{ name: ended.name, at: ended.at, why: 'install-request-ended' as const }, ...list].slice(-TURNED_AWAY_MAX);
    }
    return list.slice(-TURNED_AWAY_MAX);
}

function save(list: TurnedAwayName[]): void {
    updateLocalConfig({ turnedAwayNames: list.slice(-TURNED_AWAY_MAX), endedAddressRequest: null });
}

/** Adds `name` as the newest entry (an older entry for it is dropped). */
export function noteTurnedAway(name: string | null | undefined, why: TurnedAwayWhy): void {
    if (!name) return;
    save([...turnedAwayList().filter((e) => e.name !== name), { name, at: Date.now(), why }]);
}

/** Is `name` turned away here? An unanswered claim not yet replaced is not. */
export function isTurnedAway(name: string): boolean {
    return turnedAwayList().some((e) => e.name === name && e.why !== 'unanswered');
}

/**
 * Another address write replaced every Settings claim that got no answer (the owner claimed `except`, or took the address
 * offline): those names are turned away now.
 */
export function settleUnansweredClaims(except: string | null = null): void {
    const list = turnedAwayList();
    if (!list.some((e) => e.why === 'unanswered' && e.name !== except)) return;
    save(list.flatMap((e) => e.why !== 'unanswered' ? [e] : e.name === except ? [] : [{ ...e, why: 'claim-replaced' as const }]));
}
