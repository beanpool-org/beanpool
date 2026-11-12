// Dark's doodle tiles and banner (slice T5; Marty, 12 Nov 2026: "Dark has no green"), held to the library.
//
// scripts/bake-dark-doodle.mjs bakes them from Classic dark's art. This reads the COMMITTED files, decodes them and
// fails when:
//   - a Dark tile's ground (its most common colour) is not the library's brandGrounds('night').doodle.ground, to within
//     one level per channel (a lossy tile cannot show #17191c exactly: the bake's header says why);
//   - the doodle's line does not stand off its ground as far as Classic dark's does (the "lift"), or is not the library's line;
//   - the tile has green in it (Classic's has, and the same check fails on Classic's);
//   - a file is bigger than the Classic file it stands in for, or the phone's and the web's copies differ (the banner's too, and the
//     phone's Classic banner must be the web's, or one baked banner would not stand in for both);
//   - the banner's gaps are not the library's web.banner once the header's black wash is on, or it has green in it;
//   - the bake would write over a Classic or Light file.
// Each check can fail: the last test of each group runs it on the wrong input and asserts it is red.
//
//   node --test scripts/dark-doodle.test.mjs      (reads @beanpool/core's dist: build core first)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import {
    BANNER, BANNER_MAX_BYTES, GROUND_TOLERANCE, HEADER_WASH, TILES,
    contrast, hexToRgb, lineLift, luminance, mostCommonColour,
} from './bake-dark-doodle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { brandGrounds } = await import(pathToFileURL(path.join(ROOT, 'packages/beanpool-core/dist/brand-colours.js')).href);
const at = (rel) => path.join(ROOT, rel);
const decode = async (rel) => {
    const { data, info } = await sharp(at(rel)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
};
const within = (a, b, levels) => a.every((v, i) => Math.abs(v - b[i]) <= levels);

const NIGHT = brandGrounds('night');
const CLASSIC = brandGrounds('dark');
const LIGHT = brandGrounds('light');

/** Share of pixels that are greener than a blue-grey: green above the mean of red and blue by more than a level. */
function greenShare(data) {
    let n = 0, green = 0;
    for (let i = 0; i < data.length; i += 3) { n++; if (data[i + 1] - (data[i] + data[i + 2]) / 2 > 1) green++; }
    return green / n;
}

// The four Dark tile files, and the Classic tile each stands in for (1x and 2x).
const DARK_TILES = TILES.flatMap((t) => t.to.map((to) => ({ to, classic: t.from, size: t.size })));
const NIGHT_GROUND = hexToRgb(NIGHT.doodle.ground);

test('the library holds Dark\'s doodle at Classic dark\'s lightness (the rule the tiles are baked by)', () => {
    assert.ok(contrast(luminance(...NIGHT_GROUND), luminance(...hexToRgb(CLASSIC.doodle.ground))) < 1.01, 'ground');
    assert.ok(contrast(luminance(...hexToRgb(NIGHT.doodle.line)), luminance(...hexToRgb(CLASSIC.doodle.line))) < 1.01, 'line');
});

for (const { to, classic, size } of DARK_TILES) {
    test(`${to}: ${size}px, and its ground is the library's (within ${GROUND_TOLERANCE} level of ${NIGHT.doodle.ground})`, async () => {
        const tile = await decode(to);
        assert.equal(tile.width, size);
        assert.equal(tile.height, size);
        const ground = mostCommonColour(tile.data);
        assert.ok(within(ground, NIGHT_GROUND, GROUND_TOLERANCE), `ground ${ground} is not within ${GROUND_TOLERANCE} of ${NIGHT_GROUND}`);
        assert.ok(contrast(luminance(...ground), luminance(...NIGHT_GROUND)) < 1.01, 'the ground reads the same as the library\'s');
    });

    test(`${to}: the doodle stands off its ground as far as Classic dark's does (the lift), on the library's line`, async () => {
        const tile = await decode(to);
        const base = await decode(classic);
        const lift = lineLift(tile.data, mostCommonColour(tile.data));
        const was = lineLift(base.data, hexToRgb(CLASSIC.doodle.ground));
        assert.ok(Math.abs(lift.ratio - was.ratio) < 0.02, `lift ${lift.ratio.toFixed(3)}:1 against Classic dark's ${was.ratio.toFixed(3)}:1`);
        assert.ok(Math.abs(lift.pixels / was.pixels - 1) < 0.05, `${lift.pixels} line pixels against Classic's ${was.pixels}`);
        // And the line is the library's: the median line pixel of the @2x tile is what doodle.line records.
        if (size === 1780) {
            const lit = [];
            const g = luminance(...mostCommonColour(tile.data));
            for (let i = 0; i < tile.data.length; i += 3) {
                const px = [tile.data[i], tile.data[i + 1], tile.data[i + 2]];
                const l = luminance(...px);
                if (contrast(l, g) >= 1.3) lit.push([l, px]);
            }
            lit.sort((a, b) => a[0] - b[0]);
            const median = lit[lit.length >> 1][1];
            assert.ok(within(median, hexToRgb(NIGHT.doodle.line), 3), `median line ${median} is not near ${NIGHT.doodle.line}`);
        }
    });

    test(`${to}: no green (a charcoal doodle, not Classic's olive one)`, async () => {
        const tile = await decode(to);
        const share = greenShare(tile.data);
        // 4:2:0 chroma noise at the line edges leaves about 1 % a level greener than blue-grey; Classic's is every pixel.
        assert.ok(share < 0.05, `${(share * 100).toFixed(1)} % of the pixels are green`);
    });

    test(`${to}: no bigger than the Classic dark tile it stands in for`, () => {
        assert.ok(fs.statSync(at(to)).size <= fs.statSync(at(classic)).size, `${to} is bigger than ${classic}`);
    });
}

test('the phone\'s and the web\'s copies of a Dark tile are the same bytes', () => {
    for (const t of TILES) {
        const [first, ...rest] = t.to.map((rel) => fs.readFileSync(at(rel)));
        for (const other of rest) assert.ok(first.equals(other), `${t.to.join(' and ')} differ`);
    }
});

test('the phone\'s and the web\'s copies of Dark\'s banner are the same bytes, and the phone\'s Classic banner is the web\'s (so one baked banner stands in for both)', () => {
    assert.ok(fs.readFileSync(at(BANNER.phone)).equals(fs.readFileSync(at(BANNER.to))), `${BANNER.phone} and ${BANNER.to} differ`);
    assert.ok(fs.readFileSync(at(BANNER.phoneFrom)).equals(fs.readFileSync(at(BANNER.from))), `${BANNER.phoneFrom} and ${BANNER.from} differ`);
});

test('the ground check can fail: Classic dark\'s and Light\'s tiles are not Dark\'s ground, and Classic dark\'s tile is green', async () => {
    const classic = await decode('apps/native/assets/images/pattern-dark@2x.webp');
    assert.ok(!within(mostCommonColour(classic.data), NIGHT_GROUND, GROUND_TOLERANCE), 'Classic dark\'s tile passes as Dark\'s ground');
    const light = await decode('apps/native/assets/images/pattern-light@2x.webp');
    assert.ok(!within(mostCommonColour(light.data), NIGHT_GROUND, GROUND_TOLERANCE), 'Light\'s tile passes as Dark\'s ground');
    assert.ok(greenShare(classic.data) > 0.5, 'the green check does not see Classic dark\'s olive');
});

test('the sampler reads Classic\'s tiles to within the lossy noise of the library\'s grounds (so it is not vacuous)', async () => {
    for (const [rel, ground] of [
        ['apps/native/assets/images/pattern-dark.webp', CLASSIC.doodle.ground], ['apps/native/assets/images/pattern-dark@2x.webp', CLASSIC.doodle.ground],
        ['apps/native/assets/images/pattern-light.webp', LIGHT.doodle.ground], ['apps/native/assets/images/pattern-light@2x.webp', LIGHT.doodle.ground],
    ]) {
        const tile = await decode(rel);
        const got = mostCommonColour(tile.data);
        assert.ok(within(got, hexToRgb(ground), 2), `${rel}: ${got} against ${ground}`);
    }
});

test('the lift check can fail: Classic light\'s tile does not lift as Classic dark\'s does', async () => {
    const dark = await decode('apps/native/assets/images/pattern-dark@2x.webp');
    const light = await decode('apps/native/assets/images/pattern-light@2x.webp');
    const a = lineLift(dark.data, hexToRgb(CLASSIC.doodle.ground)).ratio;
    const b = lineLift(light.data, hexToRgb(LIGHT.doodle.ground)).ratio;
    assert.ok(Math.abs(a - b) >= 0.02, `${a} and ${b} are within the lift check's band, so it could not tell them apart`);
});

test('the banner: 640px, no bigger than Classic\'s, charcoal (no green), and under the header\'s wash its gaps are the library\'s web.banner', async () => {
    const banner = await decode(BANNER.to);
    assert.equal(banner.width, 640);
    assert.equal(banner.height, 640);
    assert.ok(fs.statSync(at(BANNER.to)).size <= BANNER_MAX_BYTES, 'bigger than Classic\'s banner');
    assert.ok(fs.statSync(at(BANNER.to)).size <= fs.statSync(at(BANNER.from)).size, 'bigger than the file it stands in for');
    let maxGreen = -999;
    for (let i = 0; i < banner.data.length; i += 3) maxGreen = Math.max(maxGreen, banner.data[i + 1] - (banner.data[i] + banner.data[i + 2]) / 2);
    assert.ok(maxGreen <= 2, `a pixel is ${maxGreen} levels greener than blue-grey`);
    const shown = mostCommonColour(banner.data).map((v) => v * (1 - HEADER_WASH));
    assert.ok(within(shown, hexToRgb(NIGHT.web.banner), 1), `the header shows ${shown}, the library's web.banner is ${NIGHT.web.banner}`);
});

test('the banner check can fail: Classic\'s banner is green and is not web.banner under the wash', async () => {
    const neon = await decode(BANNER.from);
    let maxGreen = -999;
    for (let i = 0; i < neon.data.length; i += 3) maxGreen = Math.max(maxGreen, neon.data[i + 1] - (neon.data[i] + neon.data[i + 2]) / 2);
    assert.ok(maxGreen > 2, 'the green check does not see the neon banner');
    const shown = mostCommonColour(neon.data).map((v) => v * (1 - HEADER_WASH));
    assert.ok(!within(shown, hexToRgb(NIGHT.web.banner), 1), 'Classic\'s banner passes as Dark\'s');
});

test('the bake writes only new Dark files: never a Classic or Light tile, nor Classic\'s banner', () => {
    const outputs = [...TILES.flatMap((t) => t.to), BANNER.to, BANNER.phone];
    const inputs = [...TILES.map((t) => t.from), BANNER.from, BANNER.phoneFrom];
    for (const out of outputs) {
        assert.ok(!inputs.includes(out), `${out} is an input`);
        assert.match(path.basename(out), /night/, `${out} is not named for Dark`);
        assert.doesNotMatch(path.basename(out), /pattern-(light|dark)|neon-vines/, `${out} is a Classic or Light name`);
    }
});
