/**
 * The website's phone pictures (e2e/demo/web-sizes.mjs): twenty files, the names the website's markup asks for, 360 and 720 wide,
 * WebP, under the 1 MB budget at the highest quality that fits. No emulator: the raw pictures are drawn here, noisy enough that
 * the quality has to matter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { MIN_QUALITY, WEBP_QUALITY, WEB_BUDGET_BYTES, makeWebSizes, webp } from '../web-sizes.mjs';
import { SCHEMES, SHOTS, rawName, webName } from '../shots.mjs';

let dir = '';

/** A 1080 x 1920 picture of seeded noise: the same bytes every run, and no more compressible than a photograph. */
async function noisy(seed: string): Promise<Buffer> {
    const bytes = Buffer.alloc(1080 * 1920 * 3);
    let state = crypto.createHash('sha256').update(seed).digest();
    for (let i = 0; i < bytes.length; i += 32) {
        state = crypto.createHash('sha256').update(state).digest();
        state.copy(bytes, i, 0, Math.min(32, bytes.length - i));
    }
    return sharp(bytes, { raw: { width: 1080, height: 1920, channels: 3 } }).blur(8).png().toBuffer();
}

beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-sizes-test-'));
    for (const shot of SHOTS.filter((s: { web: string | null }) => s.web)) {
        for (const scheme of SCHEMES) fs.writeFileSync(path.join(dir, rawName(shot, scheme)), await noisy(`${shot.id}-${scheme}`));
    }
}, 120_000);

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('web-sizes', () => {
    it('makes the twenty files the website names, 360 and 720 wide, 9:16, in WebP, under the budget', async () => {
        const { files, total, withinBudget } = await makeWebSizes(dir, WEB_BUDGET_BYTES, 0);
        const expected = [];
        for (const shot of SHOTS.filter((s: { web: string | null }) => s.web)) for (const scheme of SCHEMES) for (const w of [360, 720]) expected.push(webName(shot, scheme, w));
        expect(files.map((f: { name: string }) => f.name).sort()).toEqual(expected.sort());
        expect(files).toHaveLength(20);
        expect(files.every((f: { name: string }) => /^phone-(home|market|listing|deal|ledger)-(light|dark)-(360|720)\.webp$/.test(f.name))).toBe(true);
        for (const f of files as { name: string; buf: Buffer }[]) {
            const meta = await sharp(f.buf).metadata();
            const width = Number(f.name.match(/-(\d+)\.webp$/)![1]);
            expect([meta.format, meta.width, meta.height]).toEqual(['webp', width, (width * 16) / 9]);
        }
        expect(withinBudget).toBe(true);
        expect(total).toBeLessThan(WEB_BUDGET_BYTES);
    }, 180_000);

    it('keeps the design\'s quality 80 while it fits and steps down only when it does not', async () => {
        const roomy = await makeWebSizes(dir, 50_000_000, 0);
        expect(roomy.quality).toBe(WEBP_QUALITY);
        const tight = await makeWebSizes(dir, roomy.total - 1, 0);
        expect(tight.quality).toBeLessThan(WEBP_QUALITY);
        expect(tight.quality).toBeGreaterThanOrEqual(MIN_QUALITY);
        expect(tight.total).toBeLessThan(roomy.total);
    }, 300_000);

    it('says so when even the lowest quality does not fit', async () => {
        const hopeless = await makeWebSizes(dir, 1000, 0);
        expect(hopeless.withinBudget).toBe(false);
        expect(hopeless.quality).toBe(MIN_QUALITY);
    }, 300_000);

    it('encodes one picture at the width asked', async () => {
        const buf: Buffer = await webp(fs.readFileSync(path.join(dir, rawName(SHOTS[0], 'light'))), 360);
        expect((await sharp(buf).metadata()).width).toBe(360);
    });
});
