/**
 * The welcome page is the one screen that scrolls the document, and #root is one viewport tall, so its wallpaper stopped
 * at the fold (Marty, 2 Nov 2026: "the background doodle stops halfway down the page"). Measured on byron: page 2095 px,
 * #root 800 px. A wrapper paints its own layer from #root's corner, banner included, and the legal line, now over the doodles, keeps a
 * solid ground and a link that reads at 4.5:1 in light (the old #3b82f6 fallback was 3.68:1 on white).
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

describe('the welcome page wallpaper', () => {
    const app = read('App.tsx');
    const page = read('pages/WelcomePage.tsx');
    const css = read('index.css');

    it('reaches the bottom of the page', () => {
        const wrapper = app.indexOf('className="page-wallpaper"');
        expect(wrapper).toBeGreaterThan(-1);
        // The banner sits inside the layer: above it, the layer would start lower than #root and the doodles double up.
        expect(app.indexOf('<FormerAddressBanner />', wrapper)).toBeGreaterThan(wrapper);
        expect(app.indexOf('<WelcomePage ', wrapper)).toBeGreaterThan(app.indexOf('<FormerAddressBanner />', wrapper));
        expect(page).not.toContain('page-wallpaper');
    });

    it('.page-wallpaper is painted wherever #root is', () => {
        const selectors = css.match(/#root, \.page-overlay[^{]*\{/g) ?? [];
        expect(selectors.length).toBeGreaterThanOrEqual(5);
        for (const s of selectors) expect(s).toContain('.page-wallpaper');
        expect(css).toContain(':root[data-save-data="true"] .page-wallpaper');
    });

    it('the legal line keeps a solid ground over the doodles', () => {
        expect(page).toMatch(/data-testid="welcome-legal" className="[^"]*\bbg-white\b[^"]*\bdark:bg-nature-900\b/);
        expect(page).not.toContain('#3b82f6');
    });
});
