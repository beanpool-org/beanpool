/**
 * How an event's time reads, for both apps and the node's push text (design: scratch/global-node/DESIGN-event-times-fable.md
 * §1, §4, §6). No Intl here and no zone arithmetic: the node turns the host's clock + zone into the instant
 * (@beanpool/engine event-time.ts) and sends all three; a client passes in its own rendering of the instant as
 * "YYYY-MM-DDTHH:MM" (from the Date getters it already uses), and everything below is string work on those.
 *
 * In person, the place's clock leads and the reader's own follows only when the two differ. Online, the reader's own clock
 * leads, always with the words "your time".
 */

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** A wall clock as the node stores it: "2026-10-16T20:50". */
export const LOCAL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * The current IANA id for each old spelling an engine's Intl still answers with: its canonical ids are CLDR's, which keep
 * the old names (Node 22.23 and 26.5, ICU 78.3, tzdata 2026a and 2026c, measured on both: `Europe/Kyiv` resolves to
 * `Europe/Kiev`). These are the 19 a pin's lookup can answer. The node stores the current one (@beanpool/engine
 * canonicalZone, and the picker list), so a zone has one spelling in the database whichever spelling a client sent.
 */
export const CURRENT_ZONE_IDS: Readonly<Record<string, string>> = {
    'America/Buenos_Aires': 'America/Argentina/Buenos_Aires',
    'America/Catamarca': 'America/Argentina/Catamarca',
    'America/Cordoba': 'America/Argentina/Cordoba',
    'America/Jujuy': 'America/Argentina/Jujuy',
    'America/Mendoza': 'America/Argentina/Mendoza',
    'Pacific/Enderbury': 'Pacific/Kanton',
    'Pacific/Truk': 'Pacific/Chuuk',
    'Pacific/Ponape': 'Pacific/Pohnpei',
    'Asia/Saigon': 'Asia/Ho_Chi_Minh',
    'Asia/Rangoon': 'Asia/Yangon',
    'Africa/Asmera': 'Africa/Asmara',
    'Asia/Katmandu': 'Asia/Kathmandu',
    'America/Louisville': 'America/Kentucky/Louisville',
    'America/Indianapolis': 'America/Indiana/Indianapolis',
    'America/Godthab': 'America/Nuuk',
    'Atlantic/Faeroe': 'Atlantic/Faroe',
    'America/Coral_Harbour': 'America/Atikokan',
    'Europe/Kiev': 'Europe/Kyiv',
    'Asia/Calcutta': 'Asia/Kolkata',
};

/**
 * Old zone names, by their last segment, to the name the place uses now. The node stores current ids (CURRENT_ZONE_IDS), so
 * this is for the label of an id spelled the old way anywhere else (a node from before that, another device's Intl).
 */
const PLACE_NAME_ALIASES: Readonly<Record<string, string>> = {
    Kiev: 'Kyiv', Uzhgorod: 'Kyiv', Zaporozhye: 'Kyiv',
    Calcutta: 'Kolkata', Saigon: 'Ho Chi Minh', Katmandu: 'Kathmandu', Rangoon: 'Yangon', Dacca: 'Dhaka',
    Thimbu: 'Thimphu', Ulan_Bator: 'Ulaanbaatar', Chungking: 'Chongqing', Ujung_Pandang: 'Makassar', Macao: 'Macau',
    Ashkhabad: 'Ashgabat', Tel_Aviv: 'Jerusalem', Asmera: 'Asmara', Godthab: 'Nuuk', Faeroe: 'Faroe',
    Truk: 'Chuuk', Yap: 'Chuuk', Ponape: 'Pohnpei', Enderbury: 'Kanton', Coral_Harbour: 'Atikokan',
};

/** Last segments of real zone ids that are not the name of a place a stranger would know (a county, a mine, a code). */
const NOT_PLACES: ReadonlySet<string> = new Set([
    'Center', 'New_Salem', 'Beulah', 'Knox', 'Marengo', 'Petersburg', 'Tell_City', 'Vevay', 'Vincennes', 'Winamac',
    'ComodRivadavia',
]);

function parseLocal(local: string): { y: number; mo: number; d: number; h: number; mi: number } | null {
    const m = LOCAL_CLOCK_RE.exec(local);
    if (!m) return null;
    return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

/** A wall clock read as if it were UTC, in ms: two of these subtract to minutes on the clock. */
export function localClockMs(local: string): number {
    const p = parseLocal(local);
    return p ? Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) : NaN;
}

/**
 * How far the zone's clock was ahead of UTC at the event's start, in minutes, from the stored pair alone (local minus
 * instant). NaN when either is missing or unreadable.
 */
export function offsetMinutesOf(startLocal: string | null | undefined, startAt: string | null | undefined): number {
    if (!startLocal || !startAt) return NaN;
    const diff = localClockMs(startLocal) - Date.parse(startAt);
    return Number.isFinite(diff) ? Math.round(diff / 60000) : NaN;
}

/** "UTC+1", "UTC−5", "UTC+5:30", or "UTC" at no offset. */
export function utcOffsetName(offsetMinutes: number): string {
    if (!Number.isFinite(offsetMinutes) || offsetMinutes === 0) return 'UTC';
    const sign = offsetMinutes > 0 ? '+' : '−';
    const abs = Math.abs(offsetMinutes);
    const h = Math.floor(abs / 60);
    const m = abs % 60;
    return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * A zone in plain words: "Sydney time", "Buenos Aires time", "Kyiv time" (from `Europe/Kiev`). A zone that is not a
 * place (`Etc/GMT-1`, `UTC`, `America/North_Dakota/Center`) reads as its offset at the event, "UTC+1 time"; abbreviations
 * like AEDT are never used.
 */
export function zoneLabelFor(tz: string | null | undefined, offsetMinutes: number): string {
    const id = typeof tz === 'string' ? tz.trim() : '';
    const slash = id.lastIndexOf('/');
    const head = slash > 0 ? id.slice(0, id.indexOf('/')) : '';
    const last = slash > 0 ? id.slice(slash + 1) : '';
    if (!last || head === 'Etc' || NOT_PLACES.has(last) || !/^[A-Za-z_\-]+$/.test(last)) {
        return `${utcOffsetName(offsetMinutes)} time`;
    }
    const name = PLACE_NAME_ALIASES[last] ?? last.replace(/_/g, ' ');
    return `${name} time`;
}

function dayOf(local: string): string {
    const p = parseLocal(local)!;
    const weekday = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
    return `${DAYS[weekday]} ${p.d} ${MONTHS[p.mo - 1]}`;
}

function timeOf(local: string): string {
    const p = parseLocal(local)!;
    return `${p.h}:${String(p.mi).padStart(2, '0')}`;
}

function sameDate(a: string, b: string): boolean {
    return a.slice(0, 10) === b.slice(0, 10);
}

/** The two halves of a span, each kept whole when a narrow card wraps (the apps' existing shape). */
function spanParts(start: string, end: string | null): { first: string; second: string; sep: string } {
    if (!end || !parseLocal(end)) return { first: dayOf(start), second: timeOf(start), sep: ' · ' };
    if (sameDate(start, end)) return { first: dayOf(start), second: `${timeOf(start)}–${timeOf(end)}`, sep: ' · ' };
    return { first: `${dayOf(start)} ${timeOf(start)}`, second: `${dayOf(end)} ${timeOf(end)}`, sep: ' – ' };
}

export interface EventWhenInput {
    /** The instant, ISO UTC, as every node has always sent it. */
    startAt?: string | null;
    endAt?: string | null;
    /** The host's clock and its zone, as the node stores them; absent from a node that predates them. */
    startLocal?: string | null;
    endLocal?: string | null;
    tz?: string | null;
    online?: boolean | null;
    /** The reader's device rendering of startAt / endAt, "YYYY-MM-DDTHH:MM". */
    deviceStart: string;
    deviceEnd?: string | null;
}

export interface EventWhenParts {
    first: string;
    second: string;
    sep: string;
    /** In person, when the reader's clock differs from the place's: "Lagos time · 15:50 your time". */
    note: string | null;
    /** Online: the host's own clock, for the detail: "20:50 for the host (Sydney time)". */
    hostLine: string | null;
}

/**
 * The lines an event's time reads as (§4 of the design):
 *   in person, same clock   FRI 16 OCT · 20:50–22:50
 *   in person, other clock  SAT 17 OCT · 20:50–22:50  /  Lagos time · 15:50 your time
 *   ... other date too      SAT 17 OCT · 20:50–22:50  /  Lagos time · SUN 18 OCT 6:50 your time
 *   online                  FRI 16 OCT · 10:50–12:50 your time
 * A node that sends no local clock gives the device's lines, as today. Null when the device start is unreadable.
 */
export function eventWhenParts(input: EventWhenInput): EventWhenParts | null {
    const deviceStart = input.deviceStart;
    if (!parseLocal(deviceStart)) return null;
    const deviceEnd = input.deviceEnd && parseLocal(input.deviceEnd) ? input.deviceEnd : null;
    const placeStart = input.startLocal && parseLocal(input.startLocal) ? input.startLocal : null;
    const placeEnd = input.endLocal && parseLocal(input.endLocal) ? input.endLocal : null;
    const label = input.tz ? zoneLabelFor(input.tz, offsetMinutesOf(placeStart, input.startAt)) : null;

    if (input.online) {
        const own = spanParts(deviceStart, deviceEnd);
        const hostLine = placeStart && label && placeStart !== deviceStart ? `${timeOf(placeStart)} for the host (${label})` : null;
        return { ...own, second: `${own.second} your time`, note: null, hostLine };
    }
    if (!placeStart || !label) return { ...spanParts(deviceStart, deviceEnd), note: null, hostLine: null };

    const place = spanParts(placeStart, placeEnd);
    if (placeStart === deviceStart) return { ...place, note: null, hostLine: null };
    const yours = sameDate(placeStart, deviceStart) ? timeOf(deviceStart) : `${dayOf(deviceStart)} ${timeOf(deviceStart)}`;
    return { ...place, note: `${label} · ${yours} your time`, hostLine: null };
}

/**
 * The place's start in a push or share line: "Sat 20:50 Lagos time". Its weekday is the place's, read from the stored
 * clock, so it is right wherever the phone or the node stands. Null when the node holds no local clock.
 */
export function eventPlaceTimeText(startLocal: string | null | undefined, tz: string | null | undefined, startAt: string | null | undefined): string | null {
    if (!startLocal || !tz || !parseLocal(startLocal)) return null;
    const weekday = dayOf(startLocal).slice(0, 3);
    return `${weekday[0]}${weekday.slice(1).toLowerCase()} ${timeOf(startLocal)} ${zoneLabelFor(tz, offsetMinutesOf(startLocal, startAt))}`;
}

/** A Date's own clock as "YYYY-MM-DDTHH:MM", from its getters (the device's zone): the `deviceStart` the apps pass. */
export function deviceLocalClock(d: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
