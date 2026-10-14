/**
 * Where an event's clock belongs (DESIGN-event-times §2): the zone of its pin, looked up offline, and the list of zones
 * this node accepts.
 *
 * The lookup is @photostructure/tz-lookup (code CC0-1.0, boundaries from timezone-boundary-builder, ODbL; 88 KB, pure JS,
 * no network, so no node needs anything of ours to answer it). It trades accuracy for size: near a border far from towns
 * it can name the neighbour's zone, so the form shows the zone it chose with a picker one tap away, and a zone the app
 * sends is never replaced by this. A pin in the ocean answers `Etc/GMT±n`, which reads as "UTC+1 time".
 */

import tzLookup from '@photostructure/tz-lookup';
import { canonicalZone, offsetMinutesAt, zoneLabel } from '@beanpool/engine';

/** The canonical zone of a point, or null when the point is not one (NaN, out of range). */
export function zoneOfPin(lat: unknown, lng: unknown): string | null {
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    try {
        return canonicalZone(tzLookup(lat, lng));
    } catch {
        return null;
    }
}

export interface ZoneAnswer {
    tz: string;
    label: string;
    offsetMinutes: number;
}

export function describeZone(tz: string, at: number = Date.now()): ZoneAnswer {
    return { tz, label: zoneLabel(tz, at), offsetMinutes: offsetMinutesAt(at, tz) };
}

let zoneList: { at: number; zones: ZoneAnswer[]; etag: string } | null = null;

/**
 * The zones that are an offset, not a place: `UTC` (an online event an old client sent with no zone) and `Etc/GMT-14` …
 * `Etc/GMT+12` (a pin in the ocean). Intl.supportedValuesOf lists none of them (Node 22 and 26, measured), yet the node
 * stores them, so the picker carries them too; each reads as its offset ("UTC+1 time" for `Etc/GMT-1`).
 */
export function offsetZones(): string[] {
    const ids = ['UTC'];
    for (let n = -14; n <= 12; n++) if (n !== 0) ids.push(`Etc/GMT${n > 0 ? '+' : '-'}${Math.abs(n)}`);
    return ids;
}

/**
 * Every zone this node stores, spelled as it stores them (canonicalZone: `Europe/Kyiv`, not `Europe/Kiev`), with its words
 * and its offset now, for the picker: each place Intl knows, then the offset zones. Rebuilt hourly, since an offset moves
 * with DST; the ETag changes with it.
 */
export function acceptedZones(now = Date.now()): { zones: ZoneAnswer[]; etag: string } {
    if (zoneList && now - zoneList.at < 60 * 60 * 1000) return zoneList;
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
    const ids = new Set<string>();
    for (const tz of [...supported, ...offsetZones()]) {
        const id = canonicalZone(tz);
        if (id) ids.add(id);
    }
    const zones = [...ids].map(tz => describeZone(tz, now));
    const hour = Math.floor(now / (60 * 60 * 1000));
    zoneList = { at: now, zones, etag: `"zones-${process.versions.tz ?? 'x'}-${zones.length}-${hour}"` };
    return zoneList;
}
