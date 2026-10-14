/**
 * The friends list's Message and Remove friend buttons are 48dp touch targets (memory product-audience-small-screens:
 * 48dp at 320dp with 1.3× text). They were 40×40 with no hitSlop, so a thumb aimed at ✕ on an old phone could miss it
 * or land on 💬 beside it. Read from people.tsx's own styles; the name beside them keeps one line and gives way
 * (cardHeader is flex 1, minWidth 0), so the two 48dp buttons fit the 320dp row.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = fs.readFileSync(path.join(__dirname, '../../app/(tabs)/people.tsx'), 'utf8');

/** The `name: { … }` style line in people.tsx's StyleSheet. */
function style(name: string): string {
    const line = SRC.split('\n').find((l) => l.trimStart().startsWith(`${name}: {`));
    if (!line) throw new Error(`no style ${name} in people.tsx`);
    return line;
}

const size = (line: string, key: 'width' | 'height') => Number(new RegExp(`\\b${key}: (\\d+)`).exec(line)?.[1] ?? 0);

describe('the friends list row', () => {
    for (const name of ['msgBtn', 'removeFriendBtn']) {
        it(`${name} is at least 48dp each way`, () => {
            expect(size(style(name), 'width')).toBeGreaterThanOrEqual(48);
            expect(size(style(name), 'height')).toBeGreaterThanOrEqual(48);
        });
    }

    it('Remove friend is the ✕ button with its label', () => {
        expect(SRC).toMatch(/accessibilityLabel="Remove friend"[\s\S]{0,300}style=\{styles\.removeFriendBtn\}/);
    });

    it('the name gives way to the buttons at 320dp (one line, a flexible column)', () => {
        expect(style('cardHeader')).toMatch(/flex: 1, minWidth: 0/);
        expect(SRC).toMatch(/<Text style=\{styles\.callsign\} numberOfLines=\{1\}>\{item\.callsign\}<\/Text>/);
    });
});
