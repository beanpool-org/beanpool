/**
 * Your garden's one document (docs/tools-template.md step 3; DESIGN-tool-template-fable.md §3.2). In slice G0 it holds
 * only the member's own choice of climate (Change): the zone and hemisphere they picked, which beat the place the app
 * worked them out from. Nothing worked out from a place is written here; with no choice made it stays empty. G1 adds
 * the plan (plantings, tasks) beside `settings` and raises the version.
 *
 * Kept on the device only: the manifest doesn't ask for 'node-copy', so nothing of it reaches the community's server.
 */
import { isGardenZone, isHemisphere, type GardenZoneId, type Hemisphere } from './zones.js';

export const GARDEN_DOC_VERSION = 1;

export interface GardenSettings {
    /** The zone the member chose in Change; none: the one their place gives. */
    zone?: GardenZoneId;
    /** The hemisphere chosen with it. */
    hemisphere?: Hemisphere;
}

export interface GardenDoc {
    v: number;
    settings: GardenSettings;
}

export const emptyGardenDoc = (): GardenDoc => ({ v: GARDEN_DOC_VERSION, settings: {} });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The settings, their unknown keys kept; a zone or hemisphere this build doesn't know is left out. */
function readSettings(raw: unknown): GardenSettings {
    if (!isPlainObject(raw)) return {};
    const { zone, hemisphere, ...rest } = raw;
    return {
        ...rest,
        ...(isGardenZone(zone) ? { zone } : {}),
        ...(isHemisphere(hemisphere) ? { hemisphere } : {}),
    };
}

/**
 * Any stored value as this build's document: tolerant, never throws, empty() for anything unreadable. A newer version
 * (from a newer app on another device) is read for what this build knows and keeps every key it doesn't, so writing it
 * back loses nothing.
 */
export function readGardenDoc(raw: unknown): GardenDoc {
    if (!isPlainObject(raw) || typeof raw.v !== 'number' || !Number.isInteger(raw.v) || raw.v < 1) return emptyGardenDoc();
    return { ...raw, v: Math.max(raw.v, GARDEN_DOC_VERSION), settings: readSettings(raw.settings) };
}

/** The document with the member's choice of climate, or with it cleared ("Use my place"). Every other key kept. */
export function withGardenClimate(doc: GardenDoc, choice: { zone: GardenZoneId; hemisphere: Hemisphere } | null): GardenDoc {
    const rest: GardenSettings = { ...doc.settings };
    delete rest.zone;
    delete rest.hemisphere;
    return { ...doc, settings: choice ? { ...rest, zone: choice.zone, hemisphere: choice.hemisphere } : rest };
}
