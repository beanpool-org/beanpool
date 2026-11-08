/**
 * The store caption band (e2e/demo/frame.mjs, DESIGN-app-screenshots-fable.md §4): sizes, no alpha, the same bytes twice.
 * Needs no emulator and no node: the raw picture is drawn here, flat colours with a mark in each corner, so a shot that landed
 * in the wrong place or the wrong way up shows in the pixels.
 *
 * The drawing tests need the Chromium Playwright carries (CI installs it only in the browser shards); where it is not there
 * they are skipped, and the layout, shot-list and page tests still run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import sharp from 'sharp';
// @ts-expect-error -- plain ES modules (no types): the tools the store pictures are made with
import { DARK_GROUND, STORE_SIZES, frameHtml, frameLayout, frameShots, readBrand } from '../frame.mjs';
// @ts-expect-error -- plain ES module
import { SHOTS, rawName, storeName, webName } from '../shots.mjs';

// Whether Chromium starts here (not whether a path exists: Playwright runs a headless shell build by default).
const haveChromium = await (async () => { try { await (await chromium.launch()).close(); return true; } catch { return false; } })();
const drawing = haveChromium ? it : it.skip;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const hexOf = (rgb: number[]) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** A fixed 1080 x 1920 "phone": a blue field, a red mark at the top left, a green one at the bottom right. */
async function rawPhone(): Promise<Buffer> {
    const mark = (background: string) => sharp({ create: { width: 120, height: 120, channels: 3, background } }).png().toBuffer();
    return sharp({ create: { width: 1080, height: 1920, channels: 3, background: '#2040c0' } })
        .composite([
            { input: await mark('#ff0000'), left: 0, top: 0 },
            { input: await mark('#00ff00'), left: 960, top: 1800 },
        ])
        .png().toBuffer();
}

describe('frameLayout', () => {
    it.each([['play', 1080, 1920], ['appstore', 1320, 2868]])('%s: the shot, the band and the bottom margin add up to the page', (store, w, h) => {
        const L = frameLayout(store, { width: 1080, height: 1920 });
        expect(L.size).toEqual({ width: w, height: h });
        expect(L.shotY).toBe(L.band);
        expect(L.shotX * 2 + L.shotW).toBe(w);
        for (const n of [L.shotW, L.shotH, L.band, L.captionPx, L.radius]) expect(Number.isInteger(n)).toBe(true);
        expect(L.shotY + L.shotH).toBeLessThanOrEqual(h);
        expect(h - (L.shotY + L.shotH)).toBe(Math.round(w * 0.037));
    });

    it("is the design's 56 px caption and 36 px corners on the 1080 px picture, scaled by width on the wider one", () => {
        const play = frameLayout('play', { width: 1080, height: 1920 });
        expect([play.captionPx, play.radius]).toEqual([56, 36]);
        const store = frameLayout('appstore', { width: 1320, height: 2868 });
        expect(store.captionPx).toBe(Math.round((56 * 1320) / 1080));
        expect(store.radius).toBe(Math.round((36 * 1320) / 1080));
    });

    it('keeps a band for the caption when the raw picture is taller than the page can hold', () => {
        const L = frameLayout('play', { width: 1000, height: 3000 });
        expect(L.band).toBeGreaterThanOrEqual(Math.round(1920 * 0.1));
        expect(L.shotW).toBeLessThan(1080 - 2 * Math.round(1080 * 0.07));
    });

    it('refuses a store it does not know', () => {
        expect(() => frameLayout('huawei', { width: 1080, height: 1920 })).toThrow(/no store size/);
    });
});

describe('the shot list', () => {
    it('is seven screens, in order, each caption six words or fewer, the Ledger the one dark one', () => {
        expect(SHOTS.map((s: { n: number }) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        for (const s of SHOTS as { caption: string }[]) expect(s.caption.split(/\s+/).length).toBeLessThanOrEqual(6);
        expect((SHOTS as { id: string; store: string }[]).filter((s) => s.store === 'dark').map((s) => s.id)).toEqual(['ledger']);
    });

    it("names the files the way the website's markup and the store folders expect", () => {
        expect(rawName(SHOTS[0], 'dark')).toBe('1-home-dark.png');
        expect(storeName(SHOTS[6])).toBe('07-ledger.png');
        expect(webName(SHOTS[3], 'light', 360)).toBe('phone-deal-light-360.webp');
        expect((SHOTS as { web: string | null }[]).filter((s) => s.web).map((s) => s.web)).toEqual(['home', 'market', 'listing', 'deal', 'ledger']);
    });
});

describe('the brand colours', () => {
    it("come from the built core: the oat page and the website's dark ground", async () => {
        const brand = await readBrand();
        expect(brand.light.ground).toMatch(/^#[0-9a-f]{6}$/i);
        expect(brand.light.ground.toLowerCase()).not.toBe('#ffffff');
        expect(brand.dark.ground).toBe(DARK_GROUND);
        expect(brand.light.edge).toMatch(/^#[0-9a-f]{6}$/i);
        expect(brand.dark.edge).toMatch(/^#[0-9a-f]{6}$/i);
    });

    it('reach the page, with the design\'s caption size and corners', async () => {
        const brand = await readBrand();
        const html = frameHtml({ caption: 'A caption', scheme: 'light', shotUrl: 'data:,', layout: frameLayout('play', { width: 1080, height: 1920 }), brand });
        for (const colour of [brand.light.ground, brand.light.caption, brand.light.edge]) expect(html).toContain(colour);
        expect(html).toContain('font: 700 56px');
        expect(html).toContain('border-radius: 36px');
    });

    it('escapes the caption', () => {
        const brand = { light: { ground: '#f6f4f0', caption: '#1d231d', edge: '#dce3dc' }, dark: { ground: DARK_GROUND, caption: '#ffffff', edge: '#434e43' } };
        const html = frameHtml({ caption: '<b>Swaps & more</b>', scheme: 'light', shotUrl: 'data:,', layout: frameLayout('play', { width: 1080, height: 1920 }), brand });
        expect(html).toContain('&lt;b&gt;Swaps &amp; more&lt;/b&gt;');
    });
});

describe('frameShots (drawn by Chromium)', () => {
    let raw: Buffer;
    let brand: Awaited<ReturnType<typeof readBrand>>;
    beforeAll(async () => { raw = await rawPhone(); brand = await readBrand(); });

    drawing.each([['play', 1080, 1920], ['appstore', 1320, 2868]])('%s: exactly %i x %i, 24-bit PNG, no alpha', async (store, w, h) => {
        const [{ png }] = await frameShots([{ shot: raw, caption: 'Agree a price in Beans', scheme: 'light', store }], { brand });
        const meta = await sharp(png).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual(['png', w, h]);
        expect(meta.channels).toBe(3);
        expect(meta.hasAlpha).toBe(false);
        // PNG IHDR: bit depth 8 and colour type 2 (truecolour, no alpha) are bytes 24 and 25.
        expect([png[24], png[25]]).toEqual([8, 2]);
    }, 60_000);

    drawing('gives the same bytes twice for the same input', async () => {
        const job = { shot: raw, caption: 'Every trade in your own Ledger', scheme: 'dark', store: 'play' };
        const [a] = await frameShots([job], { brand });
        const [b, c] = await frameShots([job, { ...job, scheme: 'light' }], { brand });
        expect(sha(a.png)).toBe(sha(b.png));
        expect(sha(b.png)).not.toBe(sha(c.png));
    }, 60_000);

    drawing('lays the picture out as the layout says: ground at the edge, the raw below the caption, not flipped', async () => {
        const [{ png, layout }] = await frameShots([{ shot: raw, caption: "See what's near you", scheme: 'light', store: 'play' }], { brand });
        const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        const at = (x: number, y: number) => hexOf([...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)]);
        expect(at(2, 2)).toBe(brand.light.ground.toLowerCase());
        expect(at(info.width - 3, info.height - 3)).toBe(brand.light.ground.toLowerCase());
        // The red mark is the raw's top left, the green its bottom right: inside the framed shot, scaled.
        const k = layout.shotW / 1080;
        expect(at(layout.shotX + Math.round(40 * k), layout.shotY + Math.round(40 * k))).toBe('#ff0000');
        expect(at(layout.shotX + layout.shotW - Math.round(40 * k), layout.shotY + layout.shotH - Math.round(40 * k))).toBe('#00ff00');
        expect(at(layout.shotX + Math.round(540 * k), layout.shotY + Math.round(960 * k))).toBe('#2040c0');
        // The corner of the shot is rounded: its very corner pixel is still the ground, not the shot.
        expect(at(layout.shotX, layout.shotY)).not.toBe('#ff0000');
    }, 60_000);

    drawing("the dark picture stands on the website's dark ground", async () => {
        const [{ png }] = await frameShots([{ shot: raw, caption: 'Every trade in your own Ledger', scheme: 'dark', store: 'play' }], { brand });
        const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
        expect(hexOf([...data.subarray(0, 3)])).toBe(DARK_GROUND);
        expect(info.width).toBe(STORE_SIZES.play.width);
    }, 60_000);

    drawing('draws a caption: the band is not blank', async () => {
        const [{ png, layout }] = await frameShots([{ shot: raw, caption: 'Agree a price in Beans', scheme: 'light', store: 'play' }], { brand });
        const band = await sharp(png).extract({ left: 0, top: 0, width: 1080, height: layout.band }).raw().toBuffer();
        const ground = brand.light.ground.toLowerCase();
        let inked = 0;
        for (let i = 0; i < band.length; i += 3) if (hexOf([band[i], band[i + 1], band[i + 2]]) !== ground) inked++;
        expect(inked).toBeGreaterThan(2000);
    }, 60_000);
});
