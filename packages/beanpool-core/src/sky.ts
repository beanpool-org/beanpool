/**
 * Sun and moon for Home's `sky` card (scratch/home/CARD-FRAME-DESIGN-fable.md §4, slice F5), worked out on the device:
 * no request, no data, no dependency. The moon from Meeus, *Astronomical Algorithms* (2nd ed. 1998): the true new moon
 * of ch. 49 for its age, the phase angle of ch. 48 for how much is lit. The sun from NOAA's solar equations (the Global
 * Monitoring Laboratory's solar calculator, after Meeus ch. 25 and 28): its altitude through the day, so sunrise and
 * sunset are where it crosses −0.833° (refraction and the sun's half-width), and a polar day or night is simply a day
 * with no crossing. Tested against USNO and JPL Horizons values (__tests__/sky.test.ts).
 *
 * Times are moments (ms since 1970, UTC); the caller's clock turns them into hours and minutes, by default the device's
 * own time zone (a member travelling sees their own clock). "Today" is the device's own day unless the caller names one.
 *
 * Pure: no I/O, no Node built-ins, no regular expressions (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Julian day of 1970-01-01T00:00Z. */
const UNIX_EPOCH_JD = 2440587.5;
/** Julian day of J2000.0 (2000-01-01T12:00). */
const J2000_JD = 2451545;
/** Terrestrial minus universal time in the 2020s (about 69 s): the moon's tables run on the first, our clocks on the second. */
const DELTA_T_DAYS = 69 / 86_400;
/** The sun's altitude at sunrise and sunset, in degrees: 34′ of refraction and 16′ of half-width below the horizon. */
const HORIZON_DEG = -0.833;

/** The mean length of a lunar month, new moon to new moon, in days. */
export const SYNODIC_MONTH_DAYS = 29.530588861;

const sin = (d: number) => Math.sin(d * RAD);
const cos = (d: number) => Math.cos(d * RAD);
const deg360 = (d: number) => ((d % 360) + 360) % 360;
const julianDay = (ms: number) => ms / DAY_MS + UNIX_EPOCH_JD;

// ── The moon ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type MoonPhase =
    | 'new' | 'waxing-crescent' | 'first-quarter' | 'waxing-gibbous' | 'full' | 'waning-gibbous' | 'last-quarter' | 'waning-crescent';

export const MOON_PHASE_NAMES: Readonly<Record<MoonPhase, string>> = {
    'new': 'New moon',
    'waxing-crescent': 'Waxing crescent',
    'first-quarter': 'First quarter',
    'waxing-gibbous': 'Waxing gibbous',
    'full': 'Full moon',
    'waning-gibbous': 'Waning gibbous',
    'last-quarter': 'Last quarter',
    'waning-crescent': 'Waning crescent',
};

/** The moon as seen from the northern hemisphere (lit on the right while waxing). */
const MOON_NORTH: Readonly<Record<MoonPhase, string>> = {
    'new': '\u{1F311}', 'waxing-crescent': '\u{1F312}', 'first-quarter': '\u{1F313}', 'waxing-gibbous': '\u{1F314}',
    'full': '\u{1F315}', 'waning-gibbous': '\u{1F316}', 'last-quarter': '\u{1F317}', 'waning-crescent': '\u{1F318}',
};
/** From the southern hemisphere the moon is the other way round (lit on the left while waxing). */
const MOON_SOUTH: Readonly<Record<MoonPhase, string>> = {
    ...MOON_NORTH,
    'waxing-crescent': MOON_NORTH['waning-crescent'], 'first-quarter': MOON_NORTH['last-quarter'], 'waxing-gibbous': MOON_NORTH['waning-gibbous'],
    'waning-gibbous': MOON_NORTH['waxing-gibbous'], 'last-quarter': MOON_NORTH['first-quarter'], 'waning-crescent': MOON_NORTH['waxing-crescent'],
};

/** The picture of the moon as it looks from that side of the equator. */
export const moonPicture = (phase: MoonPhase, latitude: number): string => (latitude < 0 ? MOON_SOUTH : MOON_NORTH)[phase];

/** The moment of the true new moon of lunation `k` (0 = 6 Jan 2000), in ms, from Meeus ch. 49 (to about a minute). */
export function newMoonAt(k: number): number {
    const T = k / 1236.85;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
    const E = 1 - 0.002516 * T - 0.0000074 * T2;
    const M = 2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3;
    const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
    const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
    const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;
    const fix =
        -0.4072 * sin(Mp) + 0.17241 * E * sin(M) + 0.01608 * sin(2 * Mp) + 0.01039 * sin(2 * F)
        + 0.00739 * E * sin(Mp - M) - 0.00514 * E * sin(Mp + M) + 0.00208 * E * E * sin(2 * M) - 0.00111 * sin(Mp - 2 * F)
        - 0.00057 * sin(Mp + 2 * F) + 0.00056 * E * sin(2 * Mp + M) - 0.00042 * sin(3 * Mp) + 0.00042 * E * sin(M + 2 * F)
        + 0.00038 * E * sin(M - 2 * F) - 0.00024 * E * sin(2 * Mp - M) - 0.00017 * sin(Om) - 0.00007 * sin(Mp + 2 * M)
        + 0.00004 * sin(2 * Mp - 2 * F) + 0.00004 * sin(3 * M) + 0.00003 * sin(Mp + M - 2 * F) + 0.00003 * sin(2 * Mp + 2 * F)
        - 0.00003 * sin(Mp + M + 2 * F) + 0.00003 * sin(Mp - M + 2 * F) - 0.00002 * sin(Mp - M - 2 * F)
        - 0.00002 * sin(3 * Mp + M) + 0.00002 * sin(4 * Mp);
    return (jde + fix - DELTA_T_DAYS - UNIX_EPOCH_JD) * DAY_MS;
}

/** The moon's elongation from the sun at a moment, in degrees (0 new, 90 first quarter, 180 full), from Meeus ch. 48. */
function moonElongation(ms: number): number {
    const T = (julianDay(ms) + DELTA_T_DAYS - J2000_JD) / 36525;
    const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
    const D = 297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000;
    const M = 357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000;
    const Mp = 134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000;
    // 180° less the phase angle i of Meeus (48.4).
    return deg360(D + 6.289 * sin(Mp) - 2.1 * sin(M) + 1.274 * sin(2 * D - Mp) + 0.658 * sin(2 * D) + 0.214 * sin(2 * Mp) + 0.11 * sin(D));
}

export interface MoonState {
    /** Days since the last new moon. */
    age: number;
    /** How much of the disc is lit, 0 to 1. */
    lit: number;
    phase: MoonPhase;
    waxing: boolean;
}

/** Each of the four named moments is named for about a day: half a day's motion of the moon from the sun either side. */
const NAMED_MOMENT_DEG = 6;

/** The moon at a moment: its age from the true new moon before it, how much is lit, and the phase's name. */
export function moonAt(ms: number): MoonState {
    let k = Math.floor((julianDay(ms) - 2451550.09766) / SYNODIC_MONTH_DAYS);
    while (newMoonAt(k) > ms) k--;
    while (newMoonAt(k + 1) <= ms) k++;
    const age = (ms - newMoonAt(k)) / DAY_MS;
    const elongation = moonElongation(ms);
    const lit = (1 - cos(elongation)) / 2;
    const near = (target: number) => Math.abs(((elongation - target + 540) % 360) - 180) < NAMED_MOMENT_DEG;
    const waxing = elongation < 180;
    let phase: MoonPhase;
    if (near(0)) phase = 'new';
    else if (near(90)) phase = 'first-quarter';
    else if (near(180)) phase = 'full';
    else if (near(270)) phase = 'last-quarter';
    else if (waxing) phase = elongation < 90 ? 'waxing-crescent' : 'waxing-gibbous';
    else phase = elongation < 270 ? 'waning-gibbous' : 'waning-crescent';
    return { age, lit, phase, waxing };
}

// ── The sun ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The sun's declination (degrees) and the equation of time (minutes) at a moment, by NOAA's equations. */
function sunAt(ms: number): { declination: number; equationOfTime: number } {
    const T = (julianDay(ms) - J2000_JD) / 36525;
    const L0 = deg360(280.46646 + T * (36000.76983 + T * 0.0003032));
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
    const omega = 125.04 - 1934.136 * T;
    const lambda = L0 + C - 0.00569 - 0.00478 * sin(omega);
    const epsilon0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const epsilon = epsilon0 + 0.00256 * cos(omega);
    const declination = Math.asin(sin(epsilon) * sin(lambda)) / RAD;
    const y = Math.tan((epsilon / 2) * RAD) ** 2;
    const eqRad = y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M);
    return { declination, equationOfTime: (4 * eqRad) / RAD };
}

/** The sun's altitude above the horizon at a place and moment, in degrees (no refraction). Longitude east is positive. */
export function sunAltitude(latitude: number, longitude: number, ms: number): number {
    const { declination, equationOfTime } = sunAt(ms);
    const utcMinutes = (((ms % DAY_MS) + DAY_MS) % DAY_MS) / 60_000;
    const hourAngle = (utcMinutes + equationOfTime + 4 * longitude) / 4 - 180;
    const s = sin(latitude) * sin(declination) + cos(latitude) * cos(declination) * cos(hourAngle);
    return Math.asin(Math.max(-1, Math.min(1, s))) / RAD;
}

export interface SunDay {
    /** The sun's first rising in the day, or null when it doesn't rise in it. */
    rise: number | null;
    /** Its last setting in the day, or null when it doesn't set in it. */
    set: number | null;
    /** With neither: up all day (a polar day) or down all day (a polar night). Null when it rises or sets. */
    allDay: 'up' | 'down' | null;
}

/** How often the day is looked at before a crossing is narrowed down. Noon and midnight are always looked at too. */
const STEP_MS = 10 * 60_000;

/**
 * When the sun rises and sets at a place within a day (`from` to `to`, ms): where its altitude crosses the horizon,
 * found by looking every ten minutes and at the sun's own noon and midnight (its highest and lowest, so a dip of a few
 * minutes isn't missed), then halving to the second. A day with no crossing is a polar day or night.
 */
export function sunDay(latitude: number, longitude: number, from: number, to: number): SunDay {
    const above = (ms: number) => sunAltitude(latitude, longitude, ms) - HORIZON_DEG;
    const times: number[] = [];
    for (let t = from; t < to; t += STEP_MS) times.push(t);
    times.push(to - 1);
    // The sun's own noon on each UTC date the day touches, and the midnights either side.
    for (let day = Math.floor(from / DAY_MS) * DAY_MS - DAY_MS; day <= to + DAY_MS; day += DAY_MS) {
        const noon = day + (720 - 4 * longitude - sunAt(day + DAY_MS / 2).equationOfTime) * 60_000;
        for (const t of [noon - DAY_MS / 2, noon, noon + DAY_MS / 2]) if (t > from && t < to - 1) times.push(t);
    }
    times.sort((a, b) => a - b);
    let rise: number | null = null;
    let set: number | null = null;
    let prevT = times[0];
    let prevA = above(prevT);
    let highest = prevA;
    for (let i = 1; i < times.length; i++) {
        const t = times[i];
        const a = above(t);
        if (a > highest) highest = a;
        if ((prevA < 0) !== (a < 0)) {
            let lo = prevT, hi = t;
            const rising = prevA < 0;
            while (hi - lo > 1000) {
                const mid = (lo + hi) / 2;
                if ((above(mid) < 0) === rising) lo = mid;
                else hi = mid;
            }
            const at = Math.round((lo + hi) / 2);
            if (rising) {
                if (rise === null) rise = at;
            } else set = at;
        }
        prevT = t;
        prevA = a;
    }
    const allDay = rise === null && set === null ? (highest >= 0 ? 'up' : 'down') : null;
    return { rise, set, allDay };
}

// ── The card ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A place on Earth, in degrees. */
export interface SkyPlace {
    lat: number;
    lng: number;
}

/** A place from whatever an answer carries (`{ lat, lng }` or `{ lat, lon }`), or null for anything that isn't one. */
export function readSkyPlace(raw: unknown): SkyPlace | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const lat = r.lat;
    const lng = r.lng ?? r.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat, lng };
}

/** The sky card's settings: whose place it shows. */
export type SkySettings = { place: 'community' | 'me' };

/** The sky card's settings, tolerant: anything but `me` is the community's place (the default). */
export function readSkySettings(raw: unknown): SkySettings {
    const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    return { place: s.place === 'me' ? 'me' : 'community' };
}

/**
 * The place the card shows: the community's own (the Home answer's `community.place`), else the member's area, else the
 * device's last known place where the app already has one. `place: 'me'` puts the member's own first. Null: no place
 * is known, and the card isn't drawn.
 */
export function skyPlaceFor(
    settings: SkySettings,
    known: { community?: unknown; member?: unknown; device?: unknown },
): SkyPlace | null {
    const community = readSkyPlace(known.community);
    const member = readSkyPlace(known.member);
    const device = readSkyPlace(known.device);
    return settings.place === 'me' ? member ?? device ?? community : community ?? member ?? device;
}

/** Hours (0–23) and minutes of a moment on some clock. */
export type SkyClock = (ms: number) => { hours: number; minutes: number };

/** The device's own clock (its time zone). */
export const deviceClock: SkyClock = (ms) => {
    const d = new Date(ms);
    return { hours: d.getHours(), minutes: d.getMinutes() };
};

/** The device's own day around a moment: its local midnight to the next (23 or 25 hours on a clock-change day). */
export function deviceDay(now: number): { from: number; to: number } {
    const d = new Date(now);
    return { from: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), to: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() };
}

const nearestMinute = (ms: number) => Math.round(ms / 60_000) * 60_000;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
/** "6:12", "17:48": the 24-hour clock, as the card shows it. */
const shown = (clock: SkyClock, ms: number) => {
    const { hours, minutes } = clock(nearestMinute(ms));
    return `${hours}:${pad2(minutes)}`;
};
/** "6:12 am", "5:48 pm": as a screen reader says it. */
const spoken = (clock: SkyClock, ms: number) => {
    const { hours, minutes } = clock(nearestMinute(ms));
    return `${hours % 12 === 0 ? 12 : hours % 12}:${pad2(minutes)} ${hours < 12 ? 'am' : 'pm'}`;
};

export interface SkyToday {
    place: SkyPlace;
    moon: MoonState;
    sun: SunDay;
    /** The moon's picture, as it looks from the place's side of the equator. */
    picture: string;
    /** The card's line: "🌔 Waxing gibbous, 72% · Sunrise 6:12 · Sunset 17:48". */
    text: string;
    /** The same in words for a screen reader, no picture: "Moon waxing gibbous, 72 percent lit. Sunrise 6:12 am. Sunset 5:48 pm." */
    label: string;
}

/**
 * The sun and moon at a place today, in words. `now` is the moment; `day` the day the sun's times are for (the device's
 * own by default); `clock` turns a moment into hours and minutes (the device's own by default).
 */
export function skyToday(place: SkyPlace, now: number, opts: { day?: { from: number; to: number }; clock?: SkyClock } = {}): SkyToday {
    const clock = opts.clock ?? deviceClock;
    const day = opts.day ?? deviceDay(now);
    const moon = moonAt(now);
    const sun = sunDay(place.lat, place.lng, day.from, day.to);
    const percent = Math.round(moon.lit * 100);
    const name = MOON_PHASE_NAMES[moon.phase];
    const picture = moonPicture(moon.phase, place.lat);
    let sunText: string;
    let sunSaid: string;
    if (sun.allDay === 'up') {
        sunText = 'Sun up all day';
        sunSaid = 'Sun up all day.';
    } else if (sun.allDay === 'down') {
        sunText = 'Sun down all day';
        sunSaid = 'Sun down all day.';
    } else {
        sunText = `${sun.rise === null ? 'No sunrise today' : `Sunrise ${shown(clock, sun.rise)}`} · ${sun.set === null ? 'No sunset today' : `Sunset ${shown(clock, sun.set)}`}`;
        sunSaid = `${sun.rise === null ? 'No sunrise today.' : `Sunrise ${spoken(clock, sun.rise)}.`} ${sun.set === null ? 'No sunset today.' : `Sunset ${spoken(clock, sun.set)}.`}`;
    }
    return {
        place, moon, sun, picture,
        text: `${picture} ${name}, ${percent}% · ${sunText}`,
        label: `${moon.phase === 'new' || moon.phase === 'full' ? name : `Moon ${name.charAt(0).toLowerCase()}${name.slice(1)}`}, ${percent} percent lit. ${sunSaid}`,
    };
}
