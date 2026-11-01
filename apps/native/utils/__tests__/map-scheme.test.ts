/**
 * What decides the phone map's light and dark, and what keeps the dark one easy to read (utils/map-scheme.ts). Marty, 2 Nov,
 * on 1.2.87: "the darker version is too dark and the light map is not light".
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { contrastRatio } from '@beanpool/core';
import { DARK_MAP, darkMapStyle, hidePoisStyle, mapIsDark, mapSchemeKey } from '../map-scheme';

describe('which scheme the map shows', () => {
    it('follows the app until the pill picks', () => {
        expect(mapIsDark('light', null)).toBe(false);
        expect(mapIsDark('dark', null)).toBe(true);
    });

    it('keeps the pill\'s pick, either way, while the theme it was picked under lasts', () => {
        expect(mapIsDark('dark', { theme: 'dark', dark: false })).toBe(false);
        expect(mapIsDark('light', { theme: 'light', dark: true })).toBe(true);
    });

    it('gives the pill\'s pick up when the app\'s theme changes', () => {
        expect(mapIsDark('dark', { theme: 'light', dark: false })).toBe(true);
        expect(mapIsDark('light', { theme: 'dark', dark: true })).toBe(false);
    });
});

describe('when a scheme needs a new map', () => {
    it('on Android, always: the base is fixed when the map is created', () => {
        expect(mapSchemeKey('android', true)).not.toBe(mapSchemeKey('android', false));
    });

    it('on iOS, never: Apple\'s map takes the scheme live, so a remount would only blink', () => {
        expect(mapSchemeKey('ios', true)).toBe(mapSchemeKey('ios', false));
    });
});

const styled = (feature: string | undefined, element: string) =>
    darkMapStyle.filter((s) => s.featureType === feature && 'elementType' in s && s.elementType === element)
        .map((s) => (s.stylers[0] as { color?: string }).color)
        .find(Boolean);

describe('the dark map', () => {
    const land = styled(undefined, 'geometry')!;
    const water = styled('water', 'geometry')!;
    const road = styled('road', 'geometry')!;
    const highway = styled('road.highway', 'geometry')!;
    const label = styled(undefined, 'labels.text.fill')!;
    const outline = styled(undefined, 'labels.text.stroke')!;
    /** The style as it was on 1.2.87, which Marty found too dark. */
    const WAS = { land: '#242f3e', label: '#746855' };

    it('paints with the colours it names', () => {
        expect({ land, water, road, highway, label, outline }).toEqual({
            land: DARK_MAP.land, water: DARK_MAP.water, road: DARK_MAP.road, highway: DARK_MAP.highway,
            label: DARK_MAP.label, outline: DARK_MAP.labelOutline,
        });
    });

    it('is less dark than the one Marty found too dark, and still a dark map', () => {
        expect(contrastRatio(land, '#000000')).toBeGreaterThan(contrastRatio(WAS.land, '#000000') * 1.2);
        expect(contrastRatio(land, '#ffffff')).toBeGreaterThan(5);
    });

    it('reads its labels at a glance, on land and on the water', () => {
        expect(contrastRatio(WAS.label, WAS.land)).toBeLessThan(4.5); // what it replaces
        expect(contrastRatio(label, land)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(DARK_MAP.roadLabel, DARK_MAP.road)).toBeLessThan(contrastRatio(DARK_MAP.roadLabel, DARK_MAP.labelOutline));
        expect(contrastRatio(DARK_MAP.roadLabel, land)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(label, water)).toBeGreaterThanOrEqual(7);
    });

    it('keeps land, water and roads apart', () => {
        expect(contrastRatio(land, water)).toBeGreaterThanOrEqual(1.5);
        expect(contrastRatio(road, land)).toBeGreaterThanOrEqual(2);
        expect(contrastRatio(highway, land)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(highway, road)).toBeGreaterThanOrEqual(1.2);
    });

    it('hides Google\'s POI markers as the light map does', () => {
        for (const rule of hidePoisStyle) expect(darkMapStyle).toContainEqual(rule);
    });
});

describe('every map in the app', () => {
    const NATIVE_ROOT = join(__dirname, '..', '..');
    const sources = (dir: string): string[] => readdirSync(join(NATIVE_ROOT, dir)).flatMap((name) => {
        const file = join(dir, name);
        if (statSync(join(NATIVE_ROOT, file)).isDirectory()) return sources(file);
        return /\.tsx$/.test(name) ? [file] : [];
    });
    /** Each `<MapView …>` opening tag. The wrapper's and web's own files define it rather than draw a map. */
    const maps = ['app', 'components'].flatMap(sources)
        .filter((file) => !/components\/Map(\.web)?\.tsx$/.test(file))
        .flatMap((file) => {
            const src = readFileSync(join(NATIVE_ROOT, file), 'utf8');
            return [...src.matchAll(/<MapView\s*\n[\s\S]*?\n\s*>\s*\n/g)].map((m) => ({ file, tag: m[0] }));
        });

    it('finds the four it should', () => {
        expect(maps.map((m) => m.file).sort()).toEqual([
            'app/(tabs)/map.tsx', 'app/new-listing.tsx', 'components/NewEventModal.tsx', 'components/RadiusPickerModal.tsx',
        ]);
    });

    // Left out, the library sends 'system': the phone's night mode, not the app's theme, picks the base.
    it('says which scheme it wants, so the phone\'s night mode does not pick it', () => {
        for (const { file, tag } of maps) expect(tag, file).toMatch(/userInterfaceStyle=/);
    });

    it('is a new map when the scheme changes', () => {
        for (const { file, tag } of maps) expect(tag, file).toMatch(/key=\{mapSchemeKey\(Platform\.OS, /);
    });

    it('draws dark with the one dark style', () => {
        for (const { file, tag } of maps) expect(tag, file).toMatch(/customMapStyle=\{[^}]*darkMapStyle/);
    });
});
