/**
 * A trade's lines in a direct message (Beans held in trust, released, cancelled) take the colour library's deal roles,
 * never a colour of their own. Marty, 15 Oct, on a web DM in dark: "hard to read the transactional info". The lines
 * were rgba washes with #065f46 / #991b1b words, 1.5-2.2:1 over the dark chat. lib/systemLineColours.test.ts measures
 * the roles; this reads MessagesPage's system-line block and fails on any hex or rgba there.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(__dirname, 'pages/MessagesPage.tsx'), 'utf8');

/** From `if (isSystem) {` to the first `return (` after it: where a system line picks its colours. */
function systemLineBlock(): string {
    const start = SRC.indexOf('if (isSystem) {');
    const end = SRC.indexOf('return (', start);
    if (start < 0 || end < 0) throw new Error('no system-line block in MessagesPage.tsx');
    return SRC.slice(start, end);
}

describe("a trade's lines in a DM take the colour library's roles", () => {
    it('the system-line block names no hex or rgba colour', () => {
        expect(systemLineBlock().match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) ?? []).toEqual([]);
    });

    it('it takes its colours from systemLineColours (the deal roles)', () => {
        expect(systemLineBlock()).toMatch(/systemLineColours\(msg\.systemType\)/);
    });
});
