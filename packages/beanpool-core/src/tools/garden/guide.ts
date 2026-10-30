/**
 * The planting guide's rules (scratch/tools/DESIGN-grow-food-fable.md §2–§3, slice G0), shared by the phone's and the
 * web's screens so the two never disagree: a crop's sowing and first-harvest months for a zone and hemisphere, what to
 * sow now and soon, and the zone a member's place or their own choice gives. Months are 0 (January) to 11 (December)
 * and a window is a 12-bit mask, bit 0 January. Pure: no I/O.
 *
 * Optional help for new growers, never a gate (Marty, 18 Oct): experienced growers know their seasons, and nothing
 * else in the app reads this.
 */
import { DATE_WORDS, PSEUDO_LANG, currentLanguage, pseudoLocalise, t } from '../../words.js';
import { CROPS, type Crop } from './crops.js';
import { HEMISPHERE_WORDS, gardenZone, hemisphereOf, zoneAt, type GardenZoneId, type Hemisphere } from './zones.js';

export const ALL_MONTHS = 0xfff;

/** A window as written in the table ('3-5', '10-2', '3-4,9', '1-12', '') as a mask; anything malformed is empty. */
export function monthsMask(text: string): number {
    let mask = 0;
    if (!text.trim()) return 0;
    for (const part of text.split(',')) {
        const m = /^\s*(\d{1,2})(?:\s*-\s*(\d{1,2}))?\s*$/.exec(part);
        if (!m) return 0;
        const from = Number(m[1]);
        const to = m[2] === undefined ? from : Number(m[2]);
        if (from < 1 || from > 12 || to < 1 || to > 12) return 0;
        for (let k = 0; k < 12; k++) {
            const month = ((from - 1 + k) % 12);
            mask |= 1 << month;
            if (month === to - 1) break;
        }
    }
    return mask;
}

/** A mask turned by `by` months (by 6 for the other hemisphere). */
export const shiftMonths = (mask: number, by: number): number => {
    const n = ((by % 12) + 12) % 12;
    return ((mask << n) | (mask >>> (12 - n))) & ALL_MONTHS;
};

/** Whether month `m` (0..11) is in a mask. */
export const inMonths = (mask: number, m: number): boolean => (mask & (1 << (((m % 12) + 12) % 12))) !== 0;

/** Average days in a month, for turning days to harvest into months. */
const MONTH_DAYS = 30.44;

export interface PlantingWindows {
    /** When to sow (or plant a piece, slip or clove) outdoors here; 0 where the zone doesn't grow it outdoors. */
    sow: number;
    /** When the first harvest comes from a sowing in that window. */
    harvest: number;
}

/**
 * When to sow a crop in a zone and hemisphere, and when its first harvest follows: the table's northern window,
 * six months on in the south (the seasons turn; in the tropics the rains roughly follow the sun too, which is why the
 * crop page says the rains decide more than the month). The harvest band is each sowing month moved on by the crop's
 * days to harvest, fewest to most.
 */
export function plantingWindows(zone: GardenZoneId, hemisphere: Hemisphere, crop: Crop): PlantingWindows {
    const north = monthsMask(crop.sow[zone] ?? '');
    const sow = hemisphere === 'south' ? shiftMonths(north, 6) : north;
    if (sow === 0) return { sow: 0, harvest: 0 };
    const first = Math.round(crop.days[0] / MONTH_DAYS);
    const last = Math.max(first, Math.round(crop.days[1] / MONTH_DAYS));
    let harvest = 0;
    for (let by = first; by <= last && harvest !== ALL_MONTHS; by++) harvest |= shiftMonths(sow, by);
    return { sow, harvest };
}

/** Weeks to the first harvest, fewest to most, for "Harvest in 10–14 weeks". */
export function harvestWeeks(crop: Crop): [number, number] {
    return [Math.max(1, Math.round(crop.days[0] / 7)), Math.max(1, Math.round(crop.days[1] / 7))];
}

/** The crops to sow in month `m`, in the table's order. */
export function sowNow(zone: GardenZoneId, hemisphere: Hemisphere, m: number, crops: readonly Crop[] = CROPS): Crop[] {
    return crops.filter((c) => inMonths(plantingWindows(zone, hemisphere, c).sow, m));
}

/** The crops whose window opens in the next `ahead` months and not now (the guide's "Soon"), in the table's order. */
export function sowSoon(zone: GardenZoneId, hemisphere: Hemisphere, m: number, ahead = 2, crops: readonly Crop[] = CROPS): Crop[] {
    return crops.filter((c) => {
        const { sow } = plantingWindows(zone, hemisphere, c);
        if (inMonths(sow, m)) return false;
        for (let k = 1; k <= ahead; k++) if (inMonths(sow, m + k)) return true;
        return false;
    });
}

/** The crops this zone grows outdoors at some time of year (the guide's "All crops"); the rest aren't offered there. */
export function growsHere(zone: GardenZoneId, crops: readonly Crop[] = CROPS): Crop[] {
    return crops.filter((c) => monthsMask(c.sow[zone] ?? '') !== 0);
}

/** The crops of a list A to Z by their names in the language shown. */
export function cropsByName(crops: readonly Crop[]): Crop[] {
    const lang = currentLanguage();
    const collator = (() => { try { return new Intl.Collator(lang); } catch { return null; } })();
    const named = crops.map((c) => ({ c, name: t(c.name) }));
    named.sort((a, b) => (collator ? collator.compare(a.name, b.name) : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return named.map((x) => x.c);
}

// ── The zone line ───────────────────────────────────────────────────────────────────────────────────────────────

/** Where a zone came from: the member's own choice, or a place the app already had (the host's `place`). */
export type ZoneSource = 'chosen' | 'community' | 'area' | 'device';

export interface ZoneFix {
    zone: GardenZoneId;
    hemisphere: Hemisphere;
    source: ZoneSource;
}

/**
 * The guide's zone: the member's own choice when they made one (Change), else the zone of the place the app already
 * has, else null (the guide asks them to choose; nothing is guessed).
 */
export function gardenZoneFix(
    chosen: { zone?: GardenZoneId; hemisphere?: Hemisphere } | null | undefined,
    place: { lat: number; lng: number; source: 'community' | 'area' | 'device' } | null | undefined,
): ZoneFix | null {
    if (chosen?.zone) return { zone: chosen.zone, hemisphere: chosen.hemisphere ?? (place ? hemisphereOf(place.lat) : 'north'), source: 'chosen' };
    if (!place) return null;
    const zone = zoneAt(place.lat, place.lng);
    if (!zone) return null;
    return { zone, hemisphere: chosen?.hemisphere ?? hemisphereOf(place.lat), source: place.source };
}

/** The zone line's values, in the language shown, for t('{zone} · {hemisphere}', …) (a Tools row, a Home line). */
export function zoneLineValues(zone: GardenZoneId, hemisphere: Hemisphere): { zone: string; hemisphere: string } {
    return { zone: t(gardenZone(zone).name), hemisphere: t(HEMISPHERE_WORDS[hemisphere]) };
}

/** The zone line in plain words: "Warm temperate · southern hemisphere". */
export function zoneLineText(zone: GardenZoneId, hemisphere: Hemisphere): string {
    return t('{zone} · {hemisphere}', zoneLineValues(zone, hemisphere));
}

const ENGLISH_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A month's short name in the language shown (the date words' own; the pseudo-locale marks it, as formatDate does). */
export function monthShortName(m: number): string {
    const i = ((m % 12) + 12) % 12;
    const lang = currentLanguage();
    if (lang === PSEUDO_LANG) return pseudoLocalise(ENGLISH_MONTHS[i]);
    return DATE_WORDS[lang as keyof typeof DATE_WORDS]?.monthsShort[i] ?? ENGLISH_MONTHS[i];
}

/**
 * A window in words, each run of months from its first to its last: "Feb – Apr", "Nov – Feb, Jun", "All year". Null for
 * no months. Runs wrap over the new year, and are listed from the earliest in the year that starts one.
 */
export function monthsText(mask: number): string | null {
    const m = mask & ALL_MONTHS;
    if (m === 0) return null;
    if (m === ALL_MONTHS) return t('All year');
    const runs: string[] = [];
    for (let start = 0; start < 12; start++) {
        if (!inMonths(m, start) || inMonths(m, start - 1)) continue;
        let end = start;
        while (inMonths(m, end + 1)) end++;
        runs.push(end === start ? monthShortName(start) : t('{from} – {to}', { from: monthShortName(start), to: monthShortName(end) }));
    }
    return runs.join(', ');
}

// ── What the screens show (both apps draw these, so the two never disagree) ─────────────────────────────────────

/** The guide's lists for a zone in month `m`: Sow now, Soon (with the month each opens), and every crop grown here A to Z. */
export interface GuideView {
    now: Crop[];
    soon: Array<{ crop: Crop; from: number }>;
    all: Crop[];
}

export function guideView(zone: GardenZoneId, hemisphere: Hemisphere, m: number, crops: readonly Crop[] = CROPS): GuideView {
    const soon = sowSoon(zone, hemisphere, m, 2, crops).map((crop) => {
        const { sow } = plantingWindows(zone, hemisphere, crop);
        let k = 1;
        while (k < 12 && !inMonths(sow, m + k)) k++;
        return { crop, from: (m + k) % 12 };
    });
    return { now: cropsByName(sowNow(zone, hemisphere, m, crops)), soon, all: cropsByName(growsHere(zone, crops)) };
}

/** A crop's row under Sow now: how long to its first harvest, short enough for a row's one line. */
export function harvestLine(crop: Crop): string {
    const [from, to] = harvestWeeks(crop);
    return from === to ? t('Ready in about {n} weeks', { n: from }) : t('Ready in {from}–{to} weeks', { from, to });
}

/** The same on a crop's page, under "From sowing to first harvest". */
export function weeksText(crop: Crop): string {
    const [from, to] = harvestWeeks(crop);
    return from === to ? t('About {n} weeks', { n: from }) : t('{from} to {to} weeks', { from, to });
}

/** A crop's row under Soon: the month its window opens. */
export const soonLine = (from: number): string => t('Sow from {month}', { month: monthShortName(from) });

/** Where the zone line came from, under it. */
export function zoneSourceText(source: ZoneSource): string {
    switch (source) {
        case 'chosen': return t('You chose this.');
        case 'community': return t("From your community's place.");
        case 'area': return t('From your area.');
        default: return t("From this phone's last known place.");
    }
}

/** One crop's page: its windows in words and the one note its zone needs, if any. */
export interface CropPage {
    sow: string | null;
    harvest: string | null;
    weeks: string;
    note: string | null;
}

export function cropPage(crop: Crop, zone: GardenZoneId, hemisphere: Hemisphere): CropPage {
    const w = plantingWindows(zone, hemisphere, crop);
    const note = w.sow === 0 ? t('Not usually grown outdoors in this climate.')
        : zone === 'tropical-wet' || zone === 'tropical-seasonal' ? t('In the tropics the rains decide more than the month does.')
            : zone === 'dry' ? t('In a dry climate, water decides more than the month does.')
                : null;
    return { sow: monthsText(w.sow), harvest: monthsText(w.harvest), weeks: weeksText(crop), note };
}

/** The sentence at the foot of every guide screen (§2.1). */
export const guideGeneralLine = (): string => t('A general guide for your climate. Your neighbours know your patch better.');

/** The climate map's attribution (CC BY 4.0), shown on the guide and in Change. */
export const climateCreditLine = (): string => t('Climate map: {source}', { source: 'Beck et al. (2023), CC BY 4.0' });

/** Each zone's emoji in Change. */
export const ZONE_ICONS: Readonly<Record<GardenZoneId, string>> = {
    'tropical-wet': '🌴', 'tropical-seasonal': '🌦️', dry: '🌵', warm: '☀️', mild: '🌤️', cold: '❄️', short: '🏔️',
};
