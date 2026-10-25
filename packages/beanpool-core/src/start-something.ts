/**
 * The Start something sheet's rows, order and navigation targets (Fable 5.1 design §3.2, §3.5, §5 S1, S2).
 * Pure row table used by Commons '+' on every section and chip on both apps.
 */

import { word, type WordKey } from './words.js';

export type StartRowKey = 'chat' | 'project' | 'enterprise' | 'decision' | 'poll' | 'event';
export type StartRowSection = 'commons' | 'market';

export interface StartRow {
    key: StartRowKey;
    emoji: string;
    title: WordKey;
    line: WordKey;
    standingLine?: WordKey;
    section: StartRowSection;
}

export interface StartRowsOptions {
    canPropose?: boolean;
    decisionsPreview?: boolean;
    enterprisesPreview?: boolean;
}

export interface StartNodeFeatures {
    beans?: boolean;
    enterprises?: boolean;
    decisions?: boolean;
}

/**
 * Ordered rows for the Start something sheet/dialog, following the community shape:
 * - Chat group: always
 * - Project & Enterprise: only where enterprisesOn and not in preview
 * - Decision: where decisionsOn (or decisions preview); standing line when !canPropose
 * - In the Market: Poll & Event
 */
export function startRows(features: StartNodeFeatures | null | undefined, options?: StartRowsOptions): StartRow[] {
    const rows: StartRow[] = [];

    // 1. Chat group
    rows.push({
        key: 'chat',
        emoji: '👥',
        title: word('Chat group'),
        line: word('A place to talk with some people. Holds no Beans.'),
        section: 'commons',
    });

    // 2. Project & Enterprise (only where enterprisesOn and not enterprisesPreview)
    const showEnterprises = (features?.beans !== false && features?.enterprises !== false) && !options?.enterprisesPreview;
    if (showEnterprises) {
        rows.push({
            key: 'project',
            emoji: '🌱',
            title: word('Project'),
            line: word('A goal in Beans, a leader, usually an end date.'),
            section: 'commons',
        });
        rows.push({
            key: 'enterprise',
            emoji: '🏛️',
            title: word('Enterprise'),
            line: word('Keeps going and trades. Its keepers run it.'),
            section: 'commons',
        });
    }

    // 3. Decision (where decisionsOn or decisionsPreview)
    const showDecision = (features?.decisions !== false) || !!options?.decisionsPreview;
    if (showDecision) {
        const canPropose = options?.canPropose ?? true;
        let standingLine: WordKey | undefined;
        // Not in the decisions preview (the global showcase): decisions are off there and a tap explains where they live.
        if (!canPropose && !options?.decisionsPreview) {
            standingLine = features?.beans !== false
                ? word('Opens after your first completed trade.')
                : word('Node admins propose here.');
        }
        rows.push({
            key: 'decision',
            emoji: '🗳️',
            title: word('Decision'),
            line: word('A binding vote for the whole community.'),
            standingLine,
            section: 'commons',
        });
    }

    // 4. In the Market
    rows.push({
        key: 'poll',
        emoji: '📊',
        title: word('Poll'),
        line: word('A quick question for everyone. Open vote.'),
        section: 'market',
    });
    rows.push({
        key: 'event',
        emoji: '📅',
        title: word('Event'),
        line: word("A time and a place. People say they're going."),
        section: 'market',
    });

    return rows;
}
