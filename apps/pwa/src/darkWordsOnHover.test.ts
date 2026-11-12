/**
 * Words drawn on --bg-hover must read in every dark look (slice T3; T1's "found on the way", item 2).
 *
 * --bg-hover is the grey ramp's step 800 in Classic and in Dark. The accent as WORDS (`ink.accent`) is #c0ccc0 there in
 * Classic, 5.25:1, and Dark's blue #4cc2ff, 4.35:1: under the 4.5 bar. Three places drew the accent on it (the bell's back
 * arrow and its Clear all; the chat's drop hint). They now take the quiet chip's own pair in a dark look, `chip.quiet.ink`,
 * which is judged on its own tint (ramp 800) in every set: Classic's value is the same #c0ccc0, so Classic is unchanged.
 * Light keeps the accent, as it always had.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND_SETS, brandColours, brandGrounds, brandScheme, contrastRatio } from '@beanpool/core/brand-colours';

const read = (file: string) => fs.readFileSync(path.join(__dirname, file), 'utf8');

describe('the quiet chip ink reads on --bg-hover in every dark set; the accent as words does not in Dark', () => {
    const dark = BRAND_SETS.filter(set => brandScheme(set) === 'dark');

    it.each(dark)('%s: chip.quiet.ink on ramp 800 clears 4.5', (set) => {
        const hover = brandGrounds(set).web.ramp['800'];
        expect(contrastRatio(brandColours(set).chip.quiet.ink, hover)).toBeGreaterThanOrEqual(4.5);
    });

    it('Classic: the quiet ink is the very colour the accent words had, so nothing there changes', () => {
        const c = brandColours('dark');
        expect(c.chip.quiet.ink).toBe(c.ink.accent);
    });

    it('can fail: Dark\'s accent words on --bg-hover are under 4.5 (4.35), which is why the three places moved', () => {
        const hover = brandGrounds('night').web.ramp['800'];
        expect(contrastRatio(brandColours('night').ink.accent, hover)).toBeLessThan(4.5);
    });
});

describe('the three places', () => {
    it('the bell\'s back arrow and Clear all take the quiet ink in a dark look, and keep the accent in Light', () => {
        const src = read('components/NeedsYouIcons.tsx');
        const withHover = src.match(/text-bp-ink-accent[^"]*hover:bg-bg-hover/g) ?? [];
        expect(withHover.length).toBe(2);
        for (const cls of withHover) expect(cls).toContain('dark:text-bp-chip-quiet-ink');
    });

    it('the chat\'s drop hint keeps the accent fill in Light and takes the quiet ink in a dark look', () => {
        const src = read('pages/MessagesPage.tsx');
        const hint = src.slice(src.indexOf('data-testid="chat-drop-hint"'), src.indexOf('Drop the picture to send it'));
        expect(hint).toContain('text-bp-accent-fill dark:text-bp-chip-quiet-ink');
        expect(hint).not.toMatch(/color:\s*'var\(--bp-accent-fill\)'/);
    });
});
