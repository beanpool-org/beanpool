/**
 * The Tool shed fixtures, read by generic tests (__tests__/tools-template.test.ts)
 * and never shipped.
 */
import type { ToolFixtures } from '../check.js';
import {
    THINGS_LEND_TERMS_CHARS,
    THINGS_MAX_ITEMS,
    THINGS_NAME_CHARS,
    THINGS_OWNER_NOTE_CHARS,
    THINGS_REPLACEMENT_VALUE_CHARS,
    emptyThingsDoc,
    type Thing,
    type ThingsDoc,
} from './doc.js';

const NOW = Date.parse('2026-10-20T09:00:00.000Z');

const thing = (n: number, name: string, overrides: Partial<Thing> = {}): Thing => ({
    id: `t-${n}`,
    name,
    category: 'tools',
    condition: 'good',
    replacementValue: '100 Beans',
    lendTerms: 'Return clean and in good order.',
    lendMaxDays: 14,
    createdAt: new Date(NOW - n * 86_400_000).toISOString(),
    updatedAt: new Date(NOW - n * 86_400_000).toISOString(),
    ...overrides,
});

const small: ThingsDoc = {
    v: 1,
    things: [
        thing(1, 'Cordless drill', { postId: 'post-1' }),
        thing(2, 'Step ladder', {
            lentTo: {
                name: 'Alice',
                since: new Date(NOW - 2 * 86_400_000).toISOString(),
                backAround: new Date(NOW + 5 * 86_400_000).toISOString(),
            },
        }),
        thing(3, 'Camping tent'),
    ],
};

const fullThings: Thing[] = Array.from({ length: THINGS_MAX_ITEMS }, (_, n) =>
    thing(n + 1, `Tool ${n + 1} - ${'x'.repeat(THINGS_NAME_CHARS - 15)}`, {
        replacementValue: '150 Beans',
        lendTerms: 'Standard lending terms apply to all borrowed tools.',
        ownerNote: 'Stored in shed cupboard B.',
        ...(n % 3 === 0
            ? { postId: `post-${n + 1}` }
            : n % 3 === 1
            ? {
                  lentTo: {
                      name: `Borrower ${n + 1}`,
                      since: new Date(NOW - (n + 1) * 3600_000).toISOString(),
                      backAround: new Date(NOW + (n + 1) * 3600_000).toISOString(),
                  },
              }
            : {}),
    }),
);

const full: ThingsDoc = {
    v: 1,
    things: fullThings,
};

export const FIXTURES: ToolFixtures<ThingsDoc> = {
    stored: [
        { name: 'version 1', raw: small, reads: small },
        {
            name: 'version 1 with broken item and long fields',
            raw: {
                v: 1,
                things: [
                    { id: 'broken-no-name' },
                    null,
                    'not an item',
                    thing(1, 'y'.repeat(200), {
                        replacementValue: 'r'.repeat(100),
                        lendTerms: 't'.repeat(500),
                        ownerNote: 'n'.repeat(1000),
                    }),
                ],
            },
            reads: {
                v: 1,
                things: [
                    thing(1, 'y'.repeat(THINGS_NAME_CHARS), {
                        replacementValue: 'r'.repeat(THINGS_REPLACEMENT_VALUE_CHARS),
                        lendTerms: 't'.repeat(THINGS_LEND_TERMS_CHARS),
                        ownerNote: 'n'.repeat(THINGS_OWNER_NOTE_CHARS),
                    }),
                ],
            },
        },
        { name: 'not a document', raw: 'garbage', reads: emptyThingsDoc() },
        { name: 'empty object', raw: {}, reads: emptyThingsDoc() },
    ],
    docs: { empty: emptyThingsDoc(), small, full },
    now: NOW,
};
