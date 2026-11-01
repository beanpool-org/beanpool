/**
 * The welcome page is the one screen that scrolls the document, and #root is one viewport tall, so its wallpaper stopped
 * at the fold (Marty, 2 Nov 2026: "the background doodle stops halfway down the page"). Measured on byron: page 2095 px,
 * #root 800 px. The page paints its own layer, and the legal line, now over the doodles, keeps a solid ground.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

describe('the welcome page wallpaper', () => {
    const page = read('pages/WelcomePage.tsx');
    const css = read('index.css');

    it('reaches the bottom of the page', () => {
        expect(page).toMatch(/data-testid="welcome-page" className="[^"]*\bpage-wallpaper\b/);
    });

    it('.page-wallpaper is painted wherever #root is', () => {
        const selectors = css.match(/#root, \.page-overlay[^{]*\{/g) ?? [];
        expect(selectors.length).toBeGreaterThanOrEqual(5);
        for (const s of selectors) expect(s).toContain('.page-wallpaper');
        expect(css).toContain(':root[data-save-data="true"] .page-wallpaper');
    });

    it('the legal line keeps a solid ground over the doodles', () => {
        expect(page).toMatch(/data-testid="welcome-legal" className="[^"]*\bbg-white\b[^"]*\bdark:bg-nature-900\b/);
    });
});
