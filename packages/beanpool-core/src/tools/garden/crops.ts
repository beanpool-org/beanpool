/**
 * Your garden's crop table (scratch/tools/DESIGN-grow-food-fable.md §2.2, slice G0): about 50 of the crops most grown
 * worldwide, chosen for Africa, South and Southeast Asia, Latin America and the Pacific as much as for Europe and North
 * America (Marty, 18 Oct: cassava, millet, sorghum, taro and cowpeas beside tomatoes and carrots). Our own facts, CC0
 * (NOTICE), written conservatively from general horticulture: a general guide, right to about a month, and the screen
 * says so. A gardener reads it before launch (§2.4).
 *
 * Each crop: its name (through t()), one emoji, the days from sowing (or planting a piece, slip or clove) to the first
 * harvest, and when to sow it in each of the seven zones, for the NORTHERN hemisphere, as months 1 to 12: '3-5' is
 * March to May, '10-2' October to February, '3-4,9' two windows, '' not outdoors in that zone (under cover at most, so
 * the guide never offers it there). The southern hemisphere is the same six months on (guide.ts). Sowing early in a cold
 * zone means in trays indoors, planted out once the frosts are over.
 *
 * Perennials and trees (banana, plantain, papaya, citrus) come in a later slice, with planting windows only. Members add
 * their own crops in G1 (Marty, 18 Oct): this table is never the whole of what anyone grows.
 */
import { word, type WordKey } from '../../words.js';
import type { GardenZoneId } from './zones.js';

export interface Crop {
    /** Stable: a planting (G1) and a member's own notes name it by this. */
    id: string;
    name: WordKey;
    icon: string;
    /** Days from sowing to the first harvest, fewest to most. */
    days: readonly [number, number];
    /** When to sow, per zone · northern hemisphere (see above). */
    sow: Readonly<Record<GardenZoneId, string>>;
}

/** The zones in the order each row below lists them. */
const ORDER: readonly GardenZoneId[] = ['tropical-wet', 'tropical-seasonal', 'dry', 'warm', 'mild', 'cold', 'short'];

type Windows = readonly [string, string, string, string, string, string, string];

function crop(id: string, name: WordKey, icon: string, days: readonly [number, number], w: Windows): Crop {
    const sow = Object.fromEntries(ORDER.map((z, i) => [z, w[i]])) as Record<GardenZoneId, string>;
    return { id, name, icon, days, sow };
}

//                                                                          wet trop.  wet/dry     dry            warm           mild          cold         short
export const CROPS: readonly Crop[] = [
    // Fruiting vegetables
    crop('tomato', word('Tomatoes'), '🍅', [90, 120], ['10-2', '9-12', '2-4', '2-4', '3-4', '3-4', '']),
    crop('chilli', word('Chillies and capsicums'), '🌶️', [90, 150], ['1-12', '5-7,10-11', '2-4', '2-4', '2-3', '3', '']),
    crop('eggplant', word('Eggplants'), '🍆', [100, 140], ['1-12', '5-7,10-11', '2-4', '2-4', '3', '', '']),
    crop('cucumber', word('Cucumbers'), '🥒', [50, 70], ['1-12', '5-8,10-11', '2-4,8-9', '3-6', '4-6', '5-6', '']),
    crop('bitter-gourd', word('Bitter gourd'), '🥒', [55, 70], ['1-12', '5-8', '3-6', '4-6', '', '', '']),
    crop('pumpkin', word('Pumpkins and squash'), '🎃', [90, 120], ['1-12', '5-7', '3-5', '3-6', '4-6', '5-6', '']),
    crop('zucchini', word('Zucchini'), '🥒', [45, 60], ['1-12', '5-7,10-11', '2-4,8-9', '3-7', '4-6', '5-6', '6']),
    crop('watermelon', word('Water melons'), '🍉', [80, 100], ['11-3', '9-12', '2-4', '3-5', '4-5', '', '']),
    crop('melon', word('Melons'), '🍈', [80, 100], ['11-3', '9-12', '2-4', '3-5', '4-5', '', '']),
    crop('okra', word('Okra'), '🌱', [55, 70], ['1-12', '5-7', '3-6', '4-6', '', '', '']),
    crop('maize', word('Maize (corn)'), '🌽', [70, 110], ['1-12', '5-7', '3-5', '3-6', '4-6', '5-6', '']),
    crop('sunflower', word('Sunflower'), '🌻', [80, 100], ['1-12', '5-7,10', '3-6', '3-6', '4-6', '5-6', '']),
    // Beans and peas
    crop('bush-bean', word('Bush beans'), '🌱', [50, 65], ['1-12', '5-7,9-10', '2-4,8-9', '3-8', '4-7', '5-7', '6']),
    crop('climbing-bean', word('Climbing beans'), '🌱', [60, 80], ['1-12', '5-7', '3-4,8', '3-7', '4-6', '5-6', '']),
    crop('cowpea', word('Cowpeas'), '🌱', [60, 90], ['1-12', '5-8', '4-7', '4-7', '', '', '']),
    crop('pigeon-pea', word('Pigeon peas'), '🌱', [120, 180], ['1-12', '5-7', '5-7', '4-5', '', '', '']),
    crop('groundnut', word('Peanuts (groundnuts)'), '🥜', [100, 140], ['3-6', '5-7', '4-6', '4-5', '', '', '']),
    crop('soybean', word('Soybeans'), '🌱', [90, 120], ['1-12', '5-7', '4-6', '4-6', '5', '5-6', '']),
    crop('pea', word('Peas'), '🌱', [60, 80], ['', '10-12', '10-2', '2-3,9-10', '3-6', '4-5', '5-6']),
    crop('broad-bean', word('Broad beans'), '🌱', [80, 150], ['', '10-11', '10-12', '9-11', '2-4,10-11', '4-5', '5-6']),
    // Grains
    crop('rice', word('Rice'), '🌾', [100, 150], ['1-12', '5-7', '', '4-6', '', '', '']),
    crop('sorghum', word('Sorghum'), '🌾', [100, 130], ['', '5-7', '4-7', '4-6', '', '', '']),
    crop('millet', word('Millet'), '🌾', [70, 100], ['', '5-7', '5-7', '4-6', '5', '5-6', '']),
    // Leaves
    crop('amaranth', word('Amaranth'), '🌿', [30, 50], ['1-12', '4-8', '3-8', '4-8', '5-7', '5-6', '']),
    crop('jute-mallow', word('Jute mallow'), '🌿', [40, 60], ['1-12', '4-8', '4-8', '4-7', '', '', '']),
    crop('water-spinach', word('Water spinach'), '🌿', [30, 45], ['1-12', '4-10', '4-8', '4-8', '', '', '']),
    crop('bok-choy', word('Bok choy'), '🥬', [45, 60], ['1-12', '9-2', '2-3,9-10', '2-4,8-10', '4-8', '5-8', '6-7']),
    crop('lettuce', word('Lettuce'), '🥬', [45, 65], ['11-2', '10-1', '2-4,9-10', '2-5,8-10', '3-8', '4-8', '5-7']),
    crop('spinach', word('Spinach'), '🥬', [40, 50], ['', '10-12', '2-3,9-11', '2-4,9-10', '3-5,8-9', '4-5,8', '5-7']),
    crop('chard', word('Silverbeet (chard)'), '🥬', [50, 60], ['11-2', '9-12', '2-4,9-10', '2-5,8-10', '3-8', '4-7', '5-6']),
    crop('cabbage', word('Cabbage and kale'), '🥬', [80, 120], ['', '9-11', '1-2,8-10', '2-3,7-9', '3-6', '4-5', '5-6']),
    crop('broccoli', word('Broccoli'), '🥦', [70, 100], ['', '9-11', '1-2,8-10', '2-3,7-9', '3-6', '4-5', '5-6']),
    // Roots, bulbs and tubers
    crop('carrot', word('Carrots'), '🥕', [70, 100], ['11-2', '10-12', '1-3,9-11', '2-4,8-10', '3-7', '4-6', '5-6']),
    crop('beetroot', word('Beetroot'), '🌱', [55, 70], ['11-2', '10-12', '2-4,9-10', '2-4,8-10', '3-7', '4-6', '5-6']),
    crop('radish', word('Radishes'), '🌱', [25, 40], ['11-2', '10-1', '1-4,9-11', '2-5,8-10', '3-9', '4-8', '5-7']),
    crop('turnip', word('Turnips'), '🌱', [40, 60], ['', '10-12', '2-3,9-10', '2-3,8-10', '3-8', '4-7', '5-7']),
    crop('onion', word('Onions'), '🧅', [100, 150], ['11-1', '10-12', '1-2,9-11', '9-11', '2-4', '3-4', '5']),
    crop('spring-onion', word('Spring onions'), '🧅', [60, 80], ['1-12', '1-12', '2-4,9-11', '2-10', '3-9', '4-8', '5-7']),
    crop('leek', word('Leeks'), '🧅', [120, 150], ['', '10-11', '2-3,9-10', '2-4,9', '2-5', '3-4', '']),
    crop('garlic', word('Garlic'), '🧄', [180, 240], ['', '10-11', '9-11', '9-11', '9-11', '9-10', '8-9']),
    crop('potato', word('Potatoes'), '🥔', [90, 120], ['', '10-11', '2-3,9-10', '1-3,8-9', '3-5', '4-5', '5-6']),
    crop('sweet-potato', word('Sweet potatoes'), '🍠', [110, 150], ['1-12', '5-7', '4-6', '4-6', '', '', '']),
    crop('cassava', word('Cassava'), '🌱', [240, 365], ['1-12', '5-7', '', '', '', '', '']),
    crop('taro', word('Taro'), '🌱', [180, 300], ['1-12', '5-7', '', '4-5', '', '', '']),
    crop('yam', word('Yams'), '🍠', [240, 300], ['2-5', '3-5', '', '', '', '', '']),
    crop('ginger', word('Ginger'), '🌱', [240, 300], ['2-5', '4-6', '', '3-5', '', '', '']),
    crop('turmeric', word('Turmeric'), '🌱', [240, 300], ['2-5', '4-6', '', '3-5', '', '', '']),
    // Herbs
    crop('coriander', word('Coriander'), '🌿', [40, 60], ['11-2', '10-1', '1-3,9-11', '2-4,9-10', '3-8', '4-7', '6']),
    crop('basil', word('Basil'), '🌿', [50, 75], ['1-12', '5-11', '3-5,8-9', '3-6', '4-6', '5', '']),
    crop('parsley', word('Parsley'), '🌿', [70, 90], ['11-2', '10-12', '2-3,9-10', '2-4,8-10', '3-7', '4-6', '5-6']),
    crop('mint', word('Mint'), '🌿', [60, 90], ['1-12', '5-10', '2-4,9-10', '3-5,9-10', '3-6,9', '4-6', '6']),
    crop('lemongrass', word('Lemon grass'), '🌿', [120, 180], ['1-12', '5-7', '3-5', '3-5', '', '', '']),
];

/** A crop by its id, or undefined for one this build doesn't have (a newer app's, or a member's own in G1). */
export const cropById = (id: string): Crop | undefined => CROPS.find((c) => c.id === id);
