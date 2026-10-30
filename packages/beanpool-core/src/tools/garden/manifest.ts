/**
 * Your garden's manifest (DESIGN-tool-template-fable.md §3.2; grow-food slice G0: the planting guide). What the Tools
 * screen, its shelf and Home read. The plan, reminders and the Offer door come with G1 and G2, each adding its
 * permission then.
 *
 * What leaves the device: nothing. `place` reads a place the app already has (the community's, the member's rough
 * area, or the device's last known one where location is already allowed) and the zone is worked out here from the
 * bundled map; no permission is asked and the place is sent nowhere. No 'node-copy': the document stays on the device.
 */
import { word, wordn } from '../../words.js';
import type { ToolScreenProps } from '../host.js';
import type { ToolLine, ToolManifest, ToolPermission } from '../manifest.js';
import { GARDEN_DOC_VERSION, emptyGardenDoc, readGardenDoc, type GardenDoc } from './doc.js';
import { sowNow, zoneLineValues } from './guide.js';

export const GARDEN_PERMISSIONS = ['place'] as const satisfies readonly ToolPermission[];
export type GardenPermission = (typeof GARDEN_PERMISSIONS)[number];
/** What each of its screens is drawn with: the host, narrowed to its permissions. */
export type GardenScreenProps = ToolScreenProps<GardenDoc, GardenPermission>;

/** The month of a moment on the device's own calendar (0..11). */
const monthOf = (now: number) => new Date(now).getMonth();

/** Home's lines: what to sow this month in the climate the member chose, or the card's own line before they choose. */
export function gardenHomeLines(doc: GardenDoc, now: number): ToolLine[] {
    const { zone, hemisphere } = doc.settings;
    if (!zone) return [{ key: word('What to sow this month, for your climate.'), screen: 'main' }];
    const hemi = hemisphere ?? 'north';
    const n = sowNow(zone, hemi, monthOf(now)).length;
    return [
        { key: wordn('{n} crop to sow this month', '{n} crops to sow this month'), n, screen: 'main' },
        { key: word('{zone}, {hemisphere}'), values: zoneLineValues(zone, hemi), screen: 'zone' },
    ];
}

export const GARDEN: ToolManifest<GardenDoc> = {
    id: 'garden',
    name: word('Your garden'),
    line: word('What to sow when, for your climate.'),
    icon: '🌱',
    shelf: 'stock',
    categories: ['food', 'garden'],
    owner: 'member',
    permissions: GARDEN_PERMISSIONS,
    doc: { version: GARDEN_DOC_VERSION, empty: emptyGardenDoc, read: readGardenDoc },
    screens: ['main', 'crop', 'zone'],
    row: (doc) => (doc.settings.zone
        ? { key: word('{zone}, {hemisphere}'), values: zoneLineValues(doc.settings.zone, doc.settings.hemisphere ?? 'north') }
        : null),
    examples: [word('Tomatoes'), word('Cassava'), word('Lettuce')],
    homeCard: {
        line: word('What to sow this month, for your climate.'),
        lines: gardenHomeLines,
    },
};
