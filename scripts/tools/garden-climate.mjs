#!/usr/bin/env node
// garden-climate.mjs — writes Your garden's climate layer (packages/beanpool-core/src/tools/garden/climate-layer.ts) from
// Beck et al. (2023)'s Köppen-Geiger map at 0.5° (CC BY 4.0, https://doi.org/10.6084/m9.figshare.21789074): the file
// 1991_2020/koppen_geiger_0p5.tif inside koppen_geiger_tif.zip. Run once by hand when the map is updated; nothing in the
// apps or the tests fetches it.
//
//   node scripts/tools/garden-climate.mjs <koppen_geiger_0p5.tif>
//
// The map's 30 classes become Your garden's seven zones (garden/zones.ts KOPPEN_ZONES, the same table), then one
// run-length string over the grid, row by row from the north-west corner: each run is its zone's letter (a = sea or no
// data, b..h = the zones in GARDEN_ZONES order) and its length in base 28 written with 0-9 and i-z (no a..h, so a run
// ends where the next letter starts), the length left out when it is 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'packages/beanpool-core/src/tools/garden/climate-layer.ts');

// Beck et al.'s legend, 1..30 (legend.txt in the zip), to the zone letters b..h; 0 (sea, no data) is a.
const CLASSES = ['Af', 'Am', 'Aw', 'BWh', 'BWk', 'BSh', 'BSk', 'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
    'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd', 'Dfa', 'Dfb', 'Dfc', 'Dfd', 'ET', 'EF'];
// As garden/zones.ts KOPPEN_ZONES, by zone index (1 = tropical-wet … 7 = short).
const ZONE_OF = {
    Af: 1, Am: 1, Aw: 2, As: 2, BWh: 3, BWk: 3, BSh: 3, BSk: 3, Cfa: 4, Cwa: 4, Csa: 4,
    Cfb: 5, Cwb: 5, Csb: 5, Cfc: 5, Cwc: 5, Csc: 5, Dfa: 6, Dfb: 6, Dwa: 6, Dwb: 6, Dsa: 6, Dsb: 6,
    Dfc: 7, Dfd: 7, Dwc: 7, Dwd: 7, Dsc: 7, Dsd: 7, ET: 7, EF: 7,
};
const LETTERS = 'abcdefgh';
const DIGITS = '0123456789ijklmnopqrstuvwxyz';

/** TIFF LZW (MSB-first codes, 256 clear, 257 end, one code early to widen). */
function lzwDecode(input, expected) {
    const out = new Uint8Array(expected);
    let pos = 0;
    let bit = 0;
    const read = (width) => {
        let code = 0;
        for (let i = 0; i < width; i++) {
            const byte = input[bit >> 3];
            if (byte === undefined) return 257;
            code = (code << 1) | ((byte >> (7 - (bit & 7))) & 1);
            bit++;
        }
        return code;
    };
    let dict = [];
    const reset = () => { dict = Array.from({ length: 258 }, (_, i) => (i < 256 ? [i] : null)); };
    reset();
    let width = 9;
    let prev = null;
    for (;;) {
        const code = read(width);
        if (code === 257) break;
        if (code === 256) { reset(); width = 9; prev = null; continue; }
        const entry = code < dict.length && dict[code] ? dict[code] : prev ? prev.concat([prev[0]]) : null;
        if (!entry) throw new Error(`Not an LZW stream (code ${code}).`);
        for (const v of entry) if (pos < expected) out[pos++] = v;
        if (prev) dict.push(prev.concat([entry[0]]));
        prev = entry;
        width = dict.length >= 2047 ? 12 : dict.length >= 1023 ? 11 : dict.length >= 511 ? 10 : 9;
    }
    return out;
}

/** The class grid of a one-band 8-bit LZW-tiled GeoTIFF (what Beck et al. ship). */
export function readKoppenGrid(file) {
    const b = fs.readFileSync(file);
    if (b.toString('ascii', 0, 2) !== 'II' || b.readUInt16LE(2) !== 42) throw new Error('Not a little-endian TIFF.');
    const ifd = b.readUInt32LE(4);
    const tags = {};
    for (let i = 0; i < b.readUInt16LE(ifd); i++) {
        const e = ifd + 2 + i * 12;
        const type = b.readUInt16LE(e + 2);
        const count = b.readUInt32LE(e + 4);
        const size = (type === 3 ? 2 : type === 4 ? 4 : type === 12 ? 8 : 1) * count;
        const off = size <= 4 ? e + 8 : b.readUInt32LE(e + 8);
        const vals = [];
        for (let k = 0; k < count && k < 1024; k++) vals.push(type === 3 ? b.readUInt16LE(off + k * 2) : type === 4 ? b.readUInt32LE(off + k * 4) : type === 12 ? b.readDoubleLE(off + k * 8) : b[off + k]);
        tags[b.readUInt16LE(e)] = vals;
    }
    const [W] = tags[256];
    const [H] = tags[257];
    if (tags[258]?.[0] !== 8 || tags[259]?.[0] !== 5 || !tags[322]) throw new Error('Expected an 8-bit LZW-tiled TIFF.');
    const [cell] = tags[33550];
    const [, , , west, north] = tags[33922];
    if (W * cell !== 360 || H * cell !== 180 || west !== -180 || north !== 90) throw new Error('Expected a whole-world grid from -180, 90.');
    const [TW] = tags[322];
    const [TH] = tags[323];
    const across = Math.ceil(W / TW);
    const grid = new Uint8Array(W * H);
    tags[324].forEach((off, t) => {
        const tile = lzwDecode(b.subarray(off, off + tags[325][t]), TW * TH);
        const x0 = (t % across) * TW;
        const y0 = Math.floor(t / across) * TH;
        for (let y = 0; y < TH && y0 + y < H; y++) for (let x = 0; x < TW && x0 + x < W; x++) grid[(y0 + y) * W + x0 + x] = tile[y * TW + x];
    });
    return { cols: W, rows: H, cell, grid };
}

const base28 = (n) => { let s = ''; do { s = DIGITS[n % 28] + s; n = Math.floor(n / 28); } while (n > 0); return s; };

export function encodeZones({ grid }) {
    const zones = Uint8Array.from(grid, (c) => (c === 0 ? 0 : ZONE_OF[CLASSES[c - 1]] ?? 0));
    let text = '';
    for (let i = 0; i < zones.length;) {
        let j = i + 1;
        while (j < zones.length && zones[j] === zones[i]) j++;
        text += LETTERS[zones[i]] + (j - i === 1 ? '' : base28(j - i));
        i = j;
    }
    return text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const file = process.argv[2];
    if (!file) { console.error('Usage: node scripts/tools/garden-climate.mjs <koppen_geiger_0p5.tif>'); process.exit(2); }
    const map = readKoppenGrid(file);
    const runs = encodeZones(map);
    const out = [
        '// GENERATED by scripts/tools/garden-climate.mjs from Beck et al. (2023), 1991–2020, 0.5°. Do not edit by hand.',
        '// Köppen-Geiger map: Beck, H. E., T. R. McVicar, N. Vergopolan, A. Berg, N. J. Lutsko, A. Dufour, Z. Zeng, X. Jiang,',
        '// A. I. J. M. van Dijk and D. G. Miralles, "High-resolution (1 km) Köppen-Geiger maps for 1901–2099 based on constrained',
        '// CMIP6 projections", Scientific Data 10, 724 (2023), https://doi.org/10.6084/m9.figshare.21789074. CC BY 4.0',
        '// (https://creativecommons.org/licenses/by/4.0/). Changed: resampled to 0.5° by its authors, the 30 classes merged into',
        '// seven zones here (zones.ts). The attribution is in NOTICE and on the guide screen.',
        '',
        `/** The grid: ${map.cols} × ${map.rows} cells of ${map.cell}°, row by row from 90° N, 180° W. */`,
        `export const CLIMATE_GRID = { cols: ${map.cols}, rows: ${map.rows}, cellDeg: ${map.cell} } as const;`,
        '',
        '/** The zones as runs (scripts/tools/garden-climate.mjs says how they are written). */',
        `export const CLIMATE_RUNS =\n    '${runs}';`,
        '',
    ].join('\n');
    fs.writeFileSync(OUT, out);
    console.log(`garden-climate: ${map.cols}x${map.rows} cells, ${runs.length} characters of runs, ${Buffer.byteLength(out)} bytes written to ${path.relative(ROOT, OUT)}`);
}
