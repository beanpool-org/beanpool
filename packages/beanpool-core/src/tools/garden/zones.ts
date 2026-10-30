/**
 * Your garden's seven plain climate zones (scratch/tools/DESIGN-grow-food-fable.md §2.2, slice G0), the Köppen-Geiger
 * classes each one gathers, and the zone of a place, worked out on the device from the bundled coarse map
 * (climate.table.ts: Beck et al. 2023, CC BY 4.0, at 0.5°, about 55 km a cell). Nothing is asked of a server: the
 * place never leaves the device. Coasts, valleys and mountains will sometimes come out wrong, so every screen that
 * shows the zone has Change. Pure: no I/O.
 *
 * The zone mapping is ours and CC0 (NOTICE): any community may copy it into its own guide.
 */
import { word, type WordKey } from '../../words.js';
import { CLIMATE_GRID, CLIMATE_RUNS } from './climate.table.js';

export type GardenZoneId = 'tropical-wet' | 'tropical-seasonal' | 'dry' | 'warm' | 'mild' | 'cold' | 'short';
export type Hemisphere = 'north' | 'south';

export interface GardenZone {
    id: GardenZoneId;
    /** Its name in the zone line ("Warm temperate, southern hemisphere"). */
    name: WordKey;
    /** One line under it in Change. */
    line: WordKey;
}

/** The zones, warmest first: the order of Change and of the climate layer's letters b..h. */
export const GARDEN_ZONES: readonly GardenZone[] = [
    { id: 'tropical-wet', name: word('Wet tropical'), line: word('Warm all year, with rain in most months.') },
    { id: 'tropical-seasonal', name: word('Tropical wet and dry'), line: word('Warm all year, with a wet season and a dry season.') },
    { id: 'dry', name: word('Dry'), line: word('Little rain: water decides what grows.') },
    { id: 'warm', name: word('Warm temperate'), line: word('Hot summers and mild winters.') },
    { id: 'mild', name: word('Mild temperate'), line: word('Mild summers and light frosts.') },
    { id: 'cold', name: word('Cold temperate'), line: word('Warm summers and hard winters.') },
    { id: 'short', name: word('Short season'), line: word('Far north or high mountains: a short summer.') },
];

export const GARDEN_ZONE_IDS: readonly GardenZoneId[] = GARDEN_ZONES.map((z) => z.id);

export const isGardenZone = (v: unknown): v is GardenZoneId => typeof v === 'string' && (GARDEN_ZONE_IDS as readonly string[]).includes(v);
export const isHemisphere = (v: unknown): v is Hemisphere => v === 'north' || v === 'south';

export const gardenZone = (id: GardenZoneId): GardenZone => GARDEN_ZONES.find((z) => z.id === id) ?? GARDEN_ZONES[0];

/** The hemisphere's words in the zone line. */
export const HEMISPHERE_WORDS: Readonly<Record<Hemisphere, WordKey>> = {
    north: word('northern hemisphere'),
    south: word('southern hemisphere'),
};

/** Each Köppen-Geiger class's zone (§2.2): the table the climate layer was written with (scripts/tools/garden-climate.mjs). */
export const KOPPEN_ZONES: Readonly<Record<string, GardenZoneId>> = {
    Af: 'tropical-wet', Am: 'tropical-wet',
    Aw: 'tropical-seasonal', As: 'tropical-seasonal',
    BWh: 'dry', BWk: 'dry', BSh: 'dry', BSk: 'dry',
    Cfa: 'warm', Cwa: 'warm', Csa: 'warm',
    Cfb: 'mild', Cwb: 'mild', Csb: 'mild', Cfc: 'mild', Cwc: 'mild', Csc: 'mild',
    Dfa: 'cold', Dfb: 'cold', Dwa: 'cold', Dwb: 'cold', Dsa: 'cold', Dsb: 'cold',
    Dfc: 'short', Dfd: 'short', Dwc: 'short', Dwd: 'short', Dsc: 'short', Dsd: 'short', ET: 'short', EF: 'short',
};

/** The zone a Köppen-Geiger class is in, or null for a code that isn't one. */
export const zoneOfKoppen = (code: string): GardenZoneId | null =>
    Object.prototype.hasOwnProperty.call(KOPPEN_ZONES, code) ? KOPPEN_ZONES[code] : null;

/** The hemisphere of a latitude: the equator counts as north, as the layer's rows do. */
export const hemisphereOf = (lat: number): Hemisphere => (lat < 0 ? 'south' : 'north');

// ── The layer ───────────────────────────────────────────────────────────────────────────────────────────────────

const LETTERS = 'abcdefgh';
const DIGITS = '0123456789ijklmnopqrstuvwxyz';

/** The runs as two arrays (each run's first cell, and its zone 0..7), decoded once on first use: about 10,000 runs. */
export interface ClimateRuns {
    starts: Int32Array;
    zones: Uint8Array;
    cells: number;
}

/**
 * The run-length string as runs, or null for one that isn't well formed or doesn't cover `cells` exactly: each run is
 * its zone's letter (a = sea or no data, b..h = GARDEN_ZONES in order) and its length in base 28 (0-9, i-z), left out
 * when it is 1.
 */
export function decodeClimateRuns(text: string, cells: number): ClimateRuns | null {
    const starts: number[] = [];
    const zones: number[] = [];
    let at = 0;
    let i = 0;
    while (i < text.length) {
        const zone = LETTERS.indexOf(text[i]);
        if (zone < 0) return null;
        i++;
        let n = 0;
        let digits = 0;
        while (i < text.length && LETTERS.indexOf(text[i]) < 0) {
            const d = DIGITS.indexOf(text[i]);
            if (d < 0) return null;
            n = n * 28 + d;
            digits++;
            i++;
        }
        const length = digits === 0 ? 1 : n;
        if (length < 1) return null;
        starts.push(at);
        zones.push(zone);
        at += length;
    }
    if (at !== cells) return null;
    return { starts: Int32Array.from(starts), zones: Uint8Array.from(zones), cells };
}

let layer: ClimateRuns | null | undefined;

/** The bundled layer, decoded on first use (null only if the bundled string were broken, which a test refuses). */
export function climateLayer(): ClimateRuns | null {
    if (layer === undefined) layer = decodeClimateRuns(CLIMATE_RUNS, CLIMATE_GRID.cols * CLIMATE_GRID.rows);
    return layer;
}

/** The zone index (0 = sea or no data) of one cell. */
function zoneIndexAt(runs: ClimateRuns, cell: number): number {
    let lo = 0;
    let hi = runs.starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (runs.starts[mid] <= cell) lo = mid;
        else hi = mid - 1;
    }
    return runs.zones[lo];
}

/** How far to look for land around a place that falls in a sea cell (a coast the 55 km grid drew as sea): about 165 km. */
export const COAST_REACH_CELLS = 3;

/**
 * The zone of a place from the bundled map, or null for one out of range or out at sea. A place in a cell the map
 * holds as sea (a coastal town in a coarse cell) takes the nearest land cell within {@link COAST_REACH_CELLS}, ring
 * by ring, the most common zone of the nearest ring winning (ties: the warmer).
 */
export function zoneAt(lat: number, lng: number, runs: ClimateRuns | null = climateLayer()): GardenZoneId | null {
    if (!runs || !Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    const { cols, rows, cellDeg } = CLIMATE_GRID;
    const row = Math.min(rows - 1, Math.floor((90 - lat) / cellDeg));
    const col = Math.min(cols - 1, Math.floor((lng + 180) / cellDeg));
    for (let r = 0; r <= COAST_REACH_CELLS; r++) {
        const counts = new Array<number>(LETTERS.length).fill(0);
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dy), Math.abs(dx)) !== r) continue;
                const y = row + dy;
                if (y < 0 || y >= rows) continue;
                const x = (col + dx + cols) % cols;
                counts[zoneIndexAt(runs, y * cols + x)]++;
            }
        }
        let best = 0;
        for (let z = 1; z < counts.length; z++) if (counts[z] > counts[best] || (best === 0 && counts[z] > 0)) best = z;
        if (best > 0) return GARDEN_ZONE_IDS[best - 1];
    }
    return null;
}
