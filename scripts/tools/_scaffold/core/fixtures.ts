/**
 * The tool's fixtures, read by the generic tests (core's __tests__/tools-template.test.ts) and never shipped: nothing but
 * a test imports this file. `stored` keeps one stored value of every version the tool ever wrote (add one at each
 * version, never remove one); `docs` are what the screens are drawn with, `full` as big as the tool lets it grow.
 */
import type { ToolFixtures } from '../check.js';
import { SCAFFOLD_MAX_ITEMS, SCAFFOLD_NAME_CHARS, type ScaffoldDoc } from './doc.js';

const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const item = (n: number, name: string) => ({ id: `i${n}`, name, addedAt: new Date(NOW - n * 86_400_000).toISOString() });

const small: ScaffoldDoc = { v: 1, items: [item(1, 'Ladder'), item(2, 'Tent')] };
const full: ScaffoldDoc = {
    v: 1,
    items: Array.from({ length: SCAFFOLD_MAX_ITEMS }, (_, n) => item(n, 'x'.repeat(SCAFFOLD_NAME_CHARS))),
};

export const FIXTURES: ToolFixtures<ScaffoldDoc> = {
    stored: [
        { name: 'version 1', raw: small, reads: small },
        { name: 'version 1 with a broken item and a long name', raw: { v: 1, items: [{ id: 'a' }, item(3, 'y'.repeat(200))] }, reads: { v: 1, items: [item(3, 'y'.repeat(SCAFFOLD_NAME_CHARS))] } },
        { name: 'not a document', raw: 'garbage', reads: { v: 1, items: [] } },
    ],
    docs: { empty: { v: 1, items: [] }, small, full },
    now: NOW,
};
