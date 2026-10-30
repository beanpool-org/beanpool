/**
 * Your garden's fixtures, read by the generic tests (core's __tests__/tools-template.test.ts) and never shipped: nothing but
 * a test imports this file. `stored` keeps one stored value of every version the tool ever wrote (add one at each
 * version, never remove one); `docs` are what the screens are drawn with, `full` as big as the tool lets it grow.
 */
import type { ToolFixtures } from '../check.js';
import type { GardenDoc } from './doc.js';

const NOW = Date.parse('2026-10-20T09:00:00.000Z');

const small: GardenDoc = { v: 1, settings: { zone: 'warm', hemisphere: 'south' } };
// G0 keeps one choice of climate and nothing else: the full document is a choice, as big as the small one.
const full: GardenDoc = { v: 1, settings: { zone: 'tropical-seasonal', hemisphere: 'north' } };

export const FIXTURES: ToolFixtures<GardenDoc> = {
    stored: [
        { name: 'version 1', raw: small, reads: small },
        { name: 'version 1 with a zone this build does not know', raw: { v: 1, settings: { zone: 'lunar', hemisphere: 'south' } }, reads: { v: 1, settings: { hemisphere: 'south' } } },
        { name: 'version 1 without settings', raw: { v: 1 }, reads: { v: 1, settings: {} } },
        { name: 'not a document', raw: 'garbage', reads: { v: 1, settings: {} } },
    ],
    docs: { empty: { v: 1, settings: {} }, small, full },
    now: NOW,
};
