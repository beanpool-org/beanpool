/**
 * The tool's own tests: its document's rules (docs/tools-template.md step 3). The template's checks (the manifest, the
 * fixtures, every version read cleanly) run for every registered tool in core's __tests__/tools-template.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { SCAFFOLD_MAX_ITEMS, emptyScaffoldDoc, readScaffoldDoc } from '../doc.js';

describe('the document', () => {
    it('reads anything that is not a document as empty, and never throws', () => {
        for (const raw of [undefined, null, 0, 'x', [], {}, { v: 'one' }, { v: 0 }]) expect(readScaffoldDoc(raw)).toEqual(emptyScaffoldDoc());
    });

    it('keeps at most its bound of items', () => {
        const items = Array.from({ length: SCAFFOLD_MAX_ITEMS + 5 }, (_, n) => ({ id: `i${n}`, name: 'x', addedAt: '2026-10-20T00:00:00.000Z' }));
        expect(readScaffoldDoc({ v: 1, items }).items).toHaveLength(SCAFFOLD_MAX_ITEMS);
    });
});
