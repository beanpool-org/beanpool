/**
 * What the web map's filter chips say and show, the phone's (apps/native/utils/map-filters.ts), in the web's own terms. Which
 * pins a filter leaves is @beanpool/core's map-type-filter.ts, read by both apps; this file holds the words and the tiles.
 *
 * The category tiles carry the phone's names ('Food', 'Care', …: the phone's constants/categories.ts keys, so the one
 * sentence is translated once) and the emoji the web's own pins wear (lib/marketplace.ts: a post filed under Transport
 * draws 🚗 here, 🚲 on the phone), so a tile matches the pins it keeps.
 */
import { t, word, type MapTypeFilter, type WordKey } from '@beanpool/core';
import { MARKETPLACE_CATEGORIES } from './marketplace';
import { EVENT_WINDOWS } from './events';

export interface MapCategoryChip {
    id: string;
    emoji: string;
    label: WordKey;
}

const PHONE_NAMES: Record<string, WordKey> = {
    food: word('Food'),
    services: word('Services'),
    labour: word('Labour'),
    tools: word('Tools'),
    goods: word('Goods'),
    garden: word('Garden'),
    housing: word('Housing'),
    transport: word('Transport'),
    education: word('Education'),
    arts: word('Arts'),
    health: word('Health'),
    care: word('Care'),
    animals: word('Animals'),
    tech: word('Tech'),
    energy: word('Energy'),
    mindset: word('Mindset'),
    general: word('General'),
};

/** 🏷️ All Categories first, then the 17 post categories in the order the post form lists them. */
export const MAP_CATEGORY_CHIPS: readonly MapCategoryChip[] = [
    { id: 'all', emoji: '🏷️', label: word('All Categories') },
    ...MARKETPLACE_CATEGORIES.map(c => ({ id: c.id as string, emoji: c.emoji as string, label: PHONE_NAMES[c.id] })),
];

/** The collapsed chip's text: the current category, and whether tapping it opens or closes the panel. */
export function mapCategoryChipLabel(category: string, open: boolean): string {
    const c = MAP_CATEGORY_CHIPS.find(x => x.id === category) ?? MAP_CATEGORY_CHIPS[0];
    const values = { emoji: c.emoji, label: t(c.label) };
    return open ? t('{emoji} {label} ▴', values) : t('{emoji} {label} ▾', values);
}

/** The pill's words, as the phone's top row has them. */
export const MAP_TYPE_PILLS: ReadonlyArray<{ id: MapTypeFilter; label: WordKey }> = [
    { id: 'all', label: word('All') },
    { id: 'offers', label: word('Offers') },
    { id: 'needs', label: word('Needs') },
    { id: 'events', label: word('Events') },
];

/** The date chips under Events, in the phone's order: All first, then Today, This weekend, Next 7 days. */
export const MAP_EVENT_WINDOWS = [
    ...EVENT_WINDOWS.filter(w => w.id === 'all'),
    ...EVENT_WINDOWS.filter(w => w.id !== 'all'),
];
