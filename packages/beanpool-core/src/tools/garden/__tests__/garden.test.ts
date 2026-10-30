/**
 * Your garden G0: the planting guide's rules (DESIGN-grow-food-fable.md §2, slice G0) and the document. The template's
 * checks (the manifest, the fixtures, every version read cleanly) run for every registered tool in core's
 * __tests__/tools-template.test.ts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGS, setLanguage, t } from '../../../words.js';
import { CLIMATE_GRID, CLIMATE_RUNS } from '../climate-layer.js';
import { CROPS, cropById, type Crop } from '../crops.js';
import { GARDEN_DOC_VERSION, emptyGardenDoc, readGardenDoc, withGardenClimate } from '../doc.js';
import {
    ALL_MONTHS, cropPage, cropsByName, gardenZoneFix, growsHere, guideView, harvestLine, harvestWeeks, inMonths, monthShortName, monthsMask,
    monthsText, plantingWindows, shiftMonths, sowNow, sowSoon, zoneLineText,
} from '../guide.js';
import { GARDEN, gardenHomeLines } from '../manifest.js';
import { GARDEN_ZONES, GARDEN_ZONE_IDS, KOPPEN_ZONES, climateLayer, decodeClimateRuns, hemisphereOf, zoneAt, zoneOfKoppen } from '../zones.js';

const crop = (id: string): Crop => {
    const c = cropById(id);
    if (!c) throw new Error(`no crop ${id}`);
    return c;
};
const months = (mask: number) => Array.from({ length: 12 }, (_, m) => m).filter((m) => inMonths(mask, m));
const JAN = 0, FEB = 1, MAR = 2, APR = 3, AUG = 7, SEP = 8, OCT = 9;

describe('plantingWindows', () => {
    it('gives a tomato in a warm temperate zone February to April in the north, and the same six months on in the south', () => {
        const north = plantingWindows('warm', 'north', crop('tomato'));
        const south = plantingWindows('warm', 'south', crop('tomato'));
        expect(months(north.sow)).toEqual([FEB, MAR, APR]);
        expect(months(south.sow)).toEqual([AUG, SEP, OCT]);
        expect(south.sow).toBe(shiftMonths(north.sow, 6));
        expect(south.harvest).toBe(shiftMonths(north.harvest, 6));
    });

    it('puts the first harvest after the sowing by the crop\'s days: tomatoes sown Feb–Apr, picked from about May', () => {
        const { harvest } = plantingWindows('warm', 'north', crop('tomato'));
        // 90 to 120 days: three to four months on from February to April.
        expect(months(harvest)).toEqual([4, 5, 6, 7]);
    });

    it('wraps a window over the new year (lettuce in the wet tropics, November to February)', () => {
        expect(months(plantingWindows('tropical-wet', 'north', crop('lettuce')).sow)).toEqual([JAN, FEB, 10, 11]);
        expect(months(plantingWindows('tropical-wet', 'south', crop('lettuce')).sow)).toEqual([4, 5, 6, 7]);
    });

    it('gives garlic an autumn planting in both hemispheres of a mild temperate zone', () => {
        expect(months(plantingWindows('mild', 'north', crop('garlic')).sow)).toEqual([SEP, OCT, 10]);
        expect(months(plantingWindows('mild', 'south', crop('garlic')).sow)).toEqual([MAR, APR, 4]);
    });

    it('never offers a crop a zone can\'t grow outdoors: cassava in a cold zone, tomatoes in a short season', () => {
        expect(plantingWindows('cold', 'north', crop('cassava'))).toEqual({ sow: 0, harvest: 0 });
        expect(plantingWindows('short', 'south', crop('tomato'))).toEqual({ sow: 0, harvest: 0 });
        expect(growsHere('short').map((c) => c.id)).not.toContain('tomato');
        expect(growsHere('tropical-wet').map((c) => c.id)).toContain('cassava');
    });

    it('grows cassava, millet, sorghum, taro and cowpeas where they grow: Marty\'s crops sit beside tomatoes and carrots', () => {
        for (const id of ['cassava', 'taro', 'cowpea']) expect(plantingWindows('tropical-wet', 'north', crop(id)).sow).not.toBe(0);
        for (const id of ['millet', 'sorghum', 'cowpea', 'cassava']) expect(plantingWindows('tropical-seasonal', 'south', crop(id)).sow).not.toBe(0);
    });

    it('lists what to sow now and soon, and never the same crop in both', () => {
        const now = sowNow('warm', 'south', SEP).map((c) => c.id);
        const soon = sowSoon('warm', 'south', SEP).map((c) => c.id);
        expect(now).toContain('tomato');
        expect(now).not.toContain('garlic');
        expect(now.filter((id) => soon.includes(id))).toEqual([]);
        // Southern March: garlic's window opens in the next two months.
        expect(sowSoon('mild', 'south', 1).map((c) => c.id)).toContain('garlic');
    });

    it('says the weeks to the first harvest', () => {
        expect(harvestWeeks(crop('radish'))).toEqual([4, 6]);
        expect(harvestWeeks(crop('tomato'))).toEqual([13, 17]);
    });
});

describe('the guide in words', () => {
    it('says a window as runs of months, over the new year too', () => {
        setLanguage('en');
        expect(monthsText(monthsMask('2-4'))).toBe('Feb – Apr');
        expect(monthsText(monthsMask('10-2,6'))).toBe('Jan – Feb, Jun, Oct – Dec');
        expect(monthsText(ALL_MONTHS)).toBe('All year');
        expect(monthsText(0)).toBeNull();
    });

    it('draws Sow now, Soon with the month each opens, and every crop grown here', () => {
        setLanguage('en');
        const view = guideView('warm', 'south', SEP);
        expect(view.now.map((c) => c.id)).toContain('tomato');
        const garlic = guideView('mild', 'south', 1).soon.find((s) => s.crop.id === 'garlic');
        expect(garlic?.from).toBe(MAR);
        expect(view.all.length).toBe(growsHere('warm').length);
        expect(harvestLine(crop('tomato'))).toBe('Harvest in 13 to 17 weeks');
        expect(cropPage(crop('cassava'), 'tropical-wet', 'south').note).toBe('In the tropics the rains decide more than the month does.');
        expect(cropPage(crop('cassava'), 'cold', 'north')).toMatchObject({ sow: null, harvest: null, note: 'Not usually grown outdoors in this climate.' });
        expect(cropPage(crop('tomato'), 'warm', 'south').sow).toBe('Aug – Oct');
    });
});

describe('monthsMask', () => {
    it('reads the table\'s windows, and nothing malformed', () => {
        expect(monthsMask('1-12')).toBe(ALL_MONTHS);
        expect(months(monthsMask('3'))).toEqual([MAR]);
        expect(months(monthsMask('3-4,9'))).toEqual([MAR, APR, SEP]);
        expect(months(monthsMask('10-2'))).toEqual([JAN, FEB, 9, 10, 11]);
        for (const bad of ['', ' ', '0-3', '3-13', 'Mar', '3-', '1,,2']) expect(monthsMask(bad)).toBe(0);
    });
});

describe('the zone of a place', () => {
    it('maps every Köppen-Geiger class to one of the seven zones', () => {
        expect(Object.keys(KOPPEN_ZONES)).toHaveLength(31); // Beck et al.'s 30 classes and As, which their map merges into Aw.
        for (const zone of Object.values(KOPPEN_ZONES)) expect(GARDEN_ZONE_IDS).toContain(zone);
        expect(zoneOfKoppen('Cfa')).toBe('warm');
        expect(zoneOfKoppen('Cfb')).toBe('mild');
        expect(zoneOfKoppen('BWh')).toBe('dry');
        expect(zoneOfKoppen('ET')).toBe('short');
        expect(zoneOfKoppen('Zz')).toBeNull();
        expect(zoneOfKoppen('toString')).toBeNull();
    });

    it('finds the zone of places on every continent from the bundled map', () => {
        const cases: Array<[string, number, number, string]> = [
            ['Mullumbimby', -28.55, 153.5, 'warm'],
            ['Castlemaine', -37.07, 144.22, 'mild'],
            ['London', 51.5, -0.12, 'mild'],
            ['Lagos', 6.52, 3.38, 'tropical-seasonal'],
            ['Singapore', 1.35, 103.82, 'tropical-wet'],
            ['Cairo', 30.04, 31.24, 'dry'],
            ['Moscow', 55.75, 37.62, 'cold'],
            ['Dhaka', 23.81, 90.41, 'warm'],
            ['Manila', 14.6, 120.98, 'tropical-wet'],
            ['Kinshasa', -4.32, 15.31, 'tropical-seasonal'],
            ['Nuuk', 64.18, -51.69, 'short'],
        ];
        for (const [name, lat, lng, zone] of cases) expect([name, zoneAt(lat, lng)]).toEqual([name, zone]);
    });

    it('takes the nearest land for a coastal place the coarse map draws as sea, and nothing far out at sea', () => {
        // Sydney's harbour: the 0.5° cell is mostly ocean.
        expect(zoneAt(-33.86, 151.21)).toBe('warm');
        expect(zoneAt(0, -140)).toBeNull(); // the middle of the Pacific
        expect(zoneAt(Number.NaN, 0)).toBeNull();
        expect(zoneAt(91, 0)).toBeNull();
    });

    it('says the hemisphere from the latitude', () => {
        expect(hemisphereOf(-0.1)).toBe('south');
        expect(hemisphereOf(0)).toBe('north');
    });

    it('takes the member\'s own choice over the place, and asks when there is neither', () => {
        const mullum = { lat: -28.55, lng: 153.5, source: 'community' as const };
        expect(gardenZoneFix({}, mullum)).toEqual({ zone: 'warm', hemisphere: 'south', source: 'community' });
        expect(gardenZoneFix({ zone: 'dry', hemisphere: 'north' }, mullum)).toEqual({ zone: 'dry', hemisphere: 'north', source: 'chosen' });
        expect(gardenZoneFix({ zone: 'dry' }, mullum)).toEqual({ zone: 'dry', hemisphere: 'south', source: 'chosen' });
        expect(gardenZoneFix({}, null)).toBeNull();
        expect(gardenZoneFix({}, { lat: 0, lng: -140, source: 'device' })).toBeNull();
    });

    it('says the zone in plain words', () => {
        setLanguage('en');
        expect(zoneLineText('warm', 'south')).toBe('Warm temperate, southern hemisphere');
        expect(zoneLineText('tropical-seasonal', 'north')).toBe('Tropical wet and dry, northern hemisphere');
    });
});

describe('the bundled data', () => {
    it('keeps the climate layer whole and small: every cell of the 0.5° grid, under 30 KB', () => {
        const runs = decodeClimateRuns(CLIMATE_RUNS, CLIMATE_GRID.cols * CLIMATE_GRID.rows);
        expect(runs).not.toBeNull();
        expect(climateLayer()?.cells).toBe(720 * 360);
        expect(CLIMATE_RUNS.length).toBeLessThan(30_000);
        const file = readFileSync(fileURLToPath(new URL('../climate-layer.ts', import.meta.url)));
        expect(file.byteLength).toBeLessThan(100_000);
        expect(file.toString()).toContain('CC BY 4.0');
        expect(file.toString()).toContain('Beck');
    });

    it('refuses a broken layer rather than guessing', () => {
        expect(decodeClimateRuns('b', 2)).toBeNull();
        expect(decodeClimateRuns('bz', 1)).toBeNull();
        expect(decodeClimateRuns('x3', 3)).toBeNull();
        expect(decodeClimateRuns('b2c', 3)).toEqual({ starts: Int32Array.from([0, 2]), zones: Uint8Array.from([1, 2]), cells: 3 });
    });

    it('has about 50 crops, each with an id, a name key, an emoji, days and a window for every zone', () => {
        expect(CROPS.length).toBeGreaterThanOrEqual(45);
        expect(CROPS.length).toBeLessThanOrEqual(60);
        expect(new Set(CROPS.map((c) => c.id)).size).toBe(CROPS.length);
        for (const c of CROPS) {
            expect(c.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
            expect(typeof c.name).toBe('string');
            expect(c.icon.length).toBeGreaterThan(0);
            expect(c.days[0]).toBeGreaterThan(0);
            expect(c.days[1]).toBeGreaterThanOrEqual(c.days[0]);
            expect(Object.keys(c.sow).sort()).toEqual([...GARDEN_ZONE_IDS].sort());
            for (const z of GARDEN_ZONE_IDS) {
                // Every window is well formed (an empty one is '' only), and 12 months a zone.
                if (c.sow[z] !== '') expect([c.id, z, monthsMask(c.sow[z])]).not.toEqual([c.id, z, 0]);
                expect(plantingWindows(z, 'north', c).sow & ~ALL_MONTHS).toBe(0);
            }
            // Each crop grows outdoors somewhere.
            expect(GARDEN_ZONE_IDS.some((z) => c.sow[z] !== '')).toBe(true);
        }
    });

    it('gives every zone something to sow in every month, so the guide is never empty in either hemisphere', () => {
        for (const z of GARDEN_ZONE_IDS) {
            if (z === 'short') continue; // a short season has months with nothing to sow outdoors, and says so
            for (let m = 0; m < 12; m++) {
                for (const h of ['north', 'south'] as const) expect([z, h, m, sowNow(z, h, m).length > 0 || sowSoon(z, h, m).length > 0]).toEqual([z, h, m, true]);
            }
        }
    });

    it('keeps the crop table small (about 10 KB of source)', () => {
        const file = readFileSync(fileURLToPath(new URL('../crops.ts', import.meta.url)));
        expect(file.byteLength).toBeLessThan(16_000);
    });

    it('has seven zones, each with a name and a line', () => {
        expect(GARDEN_ZONES.map((z) => z.id)).toEqual(['tropical-wet', 'tropical-seasonal', 'dry', 'warm', 'mild', 'cold', 'short']);
        for (const z of GARDEN_ZONES) {
            expect(z.name).toBeTruthy();
            expect(z.line).toBeTruthy();
        }
    });

    it('sorts crops by their names in the language shown, and names the months in it', () => {
        setLanguage('en');
        const names = cropsByName(CROPS).map((c) => t(c.name));
        expect(names[0]).toBe('Amaranth');
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
        expect(monthShortName(0)).toBe('Jan');
        expect(monthShortName(13)).toBe('Feb');
        expect(LANGS.length).toBeGreaterThan(1);
    });
});

describe('the document and the manifest', () => {
    it('reads anything that is not a document as empty, and never throws', () => {
        for (const raw of [undefined, null, 0, 'x', [], {}, { v: 'one' }, { v: 0 }]) expect(readGardenDoc(raw)).toEqual(emptyGardenDoc());
    });

    it('keeps a newer version\'s keys whole', () => {
        const newer = { v: GARDEN_DOC_VERSION + 1, plantings: [{ id: 'p1' }], settings: { zone: 'warm', hemisphere: 'south', frost: '09-15' } };
        expect(readGardenDoc(newer)).toEqual(newer);
    });

    it('sets and clears the member\'s choice of climate, keeping every other key', () => {
        const doc = readGardenDoc({ v: 1, settings: { frost: '09-15' }, later: 1 });
        const chosen = withGardenClimate(doc, { zone: 'mild', hemisphere: 'south' });
        expect(chosen.settings).toEqual({ frost: '09-15', zone: 'mild', hemisphere: 'south' });
        expect(withGardenClimate(chosen, null)).toEqual(doc);
    });

    it('asks only for a place the app already has, and keeps nothing on the community\'s server', () => {
        expect(GARDEN.permissions).toEqual(['place']);
        expect(GARDEN.permissions).not.toContain('node-copy');
        expect(GARDEN.screens[0]).toBe('main');
    });

    it('says on Home what to sow this month in the climate chosen, and its own line before a choice', () => {
        setLanguage('en');
        expect(gardenHomeLines(emptyGardenDoc(), Date.UTC(2026, 9, 15))).toEqual([{ key: 'What to sow this month, for your climate.', screen: 'main' }]);
        const lines = gardenHomeLines({ v: 1, settings: { zone: 'warm', hemisphere: 'south' } }, new Date(2026, 8, 15).getTime());
        expect(lines[0].n).toBe(sowNow('warm', 'south', SEP).length);
        expect(lines[1].values).toEqual({ zone: 'Warm temperate', hemisphere: 'southern hemisphere' });
        expect(GARDEN.row({ v: 1, settings: {} }, 0)).toBeNull();
    });
});
