/**
 * The Tool shed manifest (scratch/tools/DESIGN-tool-template-fable.md §1.2, §3.1, slice T1.1):
 * what you own and might lend, and who has them. Pure data and pure functions.
 */
import { word } from '../../words.js';
import type { ToolScreenProps } from '../host.js';
import {
    TOOL_LIMITS,
    type ToolDue,
    type ToolLine,
    type ToolManifest,
    type ToolPermission,
} from '../manifest.js';
import {
    THINGS_DOC_VERSION,
    emptyThingsDoc,
    isLentTo,
    isLiveThing,
    readThingsDoc,
    type ThingsDoc,
} from './doc.js';

export const THINGS_PERMISSIONS = [
    'photos',
    'camera',
    'offer-door',
    'posts',
    'deals',
    'pricing-guide',
    'node-copy',
    'reminders',
] as const satisfies readonly ToolPermission[];

export type ThingsPermission = (typeof THINGS_PERMISSIONS)[number];
export type ThingsScreenProps = ToolScreenProps<ThingsDoc, ThingsPermission>;

export interface ThingsCounts {
    things: number;
    listed: number;
    out: number;
    shelf: number;
    [key: string]: number;
}

/**
 * Counts of things in the shed:
 * - things: active things you own (!gone, {@link isLiveThing}: the number THINGS_MAX_ITEMS caps)
 * - out: things currently lent out (a lentTo this build reads, {@link isLentTo})
 * - listed: things in your shop ready to lend (a string postId, not out)
 * - shelf: things at home not listed or lent (neither)
 * Invariant: things === listed + out + shelf. A newer version's item this build can't read is in none of them; a newer
 * version's field it can't read (kept as it was) counts as if it were not there.
 */
export function thingsCounts(doc: ThingsDoc, _now?: number): ThingsCounts {
    let things = 0;
    let listed = 0;
    let out = 0;
    let shelf = 0;

    for (const t of doc.things ?? []) {
        if (!isLiveThing(t)) continue;
        things++;
        if (isLentTo(t.lentTo)) {
            out++;
        } else if (typeof t.postId === 'string') {
            listed++;
        } else {
            shelf++;
        }
    }

    return { things, listed, out, shelf };
}

/** Alias for thingsCounts matching §3.1 countsOf. */
export const countsOf = thingsCounts;

/**
 * The Home card lines (up to 2 lines):
 * summary of things and what is out, pointing to 'loans' when items are out or 'main' otherwise.
 * Returns empty array when no active things.
 */
export function thingsHomeLines(doc: ThingsDoc, now: number): ToolLine[] {
    const counts = thingsCounts(doc, now);
    if (counts.things === 0) return [];

    if (counts.out > 0) {
        return [
            {
                key: word('{things} things · {out} out'),
                values: { things: counts.things, out: counts.out },
                screen: 'loans',
            },
        ];
    }

    return [
        {
            key: word('{things} things · all in your shed'),
            values: { things: counts.things },
            screen: 'main',
        },
    ];
}

/**
 * Reminders due from now: when something lent outside BeanPool is due back.
 * Up to 10 entries, sorted ascending by at.
 */
export function loansDue(doc: ThingsDoc, now: number): ToolDue[] {
    const dues: ToolDue[] = [];

    for (const t of doc.things ?? []) {
        if (!isLiveThing(t) || !isLentTo(t.lentTo) || typeof t.lentTo.backAround !== 'string') continue;
        const at = Date.parse(t.lentTo.backAround);
        if (!Number.isFinite(at) || at < now) continue;
        dues.push({
            reminder: 'back',
            at,
            key: word('{name} is due back'),
            values: { name: t.name },
            screen: 'loans',
        });
    }

    dues.sort((a, b) => a.at - b.at);
    return dues.slice(0, TOOL_LIMITS.due);
}

export const THINGS: ToolManifest<ThingsDoc> = {
    id: 'things',
    name: word('Tool shed'),
    line: word('Things you own and might lend, and who has them.'),
    icon: '🧰',
    shelf: 'stock',
    shopKinds: ['tools', 'seeds', 'rooms'],
    owner: 'both',
    permissions: THINGS_PERMISSIONS,
    doc: {
        version: THINGS_DOC_VERSION,
        empty: emptyThingsDoc,
        read: readThingsDoc,
        maxBytes: TOOL_LIMITS.docBytes,
    },
    screens: ['main', 'thing', 'edit', 'loans'],
    row: (d, now) => ({
        key: word('{things} things · {listed} in your shop · {out} out'),
        values: thingsCounts(d, now),
    }),
    examples: [word('a drill'), word('a ladder'), word('a tent')],
    guide: 'lending-and-borrowing',
    homeCard: {
        line: word('Your things, and what is out.'),
        lines: thingsHomeLines,
    },
    reminders: {
        list: [{ id: 'back', name: word('When something lent outside BeanPool is due back'), defaultOn: true }],
        due: loansDue,
    },
    needs: { fee: 'beans' },
};
