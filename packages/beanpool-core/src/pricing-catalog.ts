/**
 * Community Beans Pricing Catalog & Utilities (#206).
 *
 * Provides a standardized catalog of ~500 community goods and services,
 * baseline pricing guidelines, category taxonomy, outlier safety filters,
 * and multiplier calculations.
 */

export type PricingCategory =
    | 'food'
    | 'services'
    | 'labour'
    | 'tools'
    | 'goods'
    | 'garden'
    | 'housing'
    | 'transport'
    | 'education'
    | 'arts'
    | 'health'
    | 'care'
    | 'animals'
    | 'tech'
    | 'energy'
    | 'mindset'
    | 'general';

export interface PricingCategoryMeta {
    id: PricingCategory;
    label: string;
    emoji: string;
    description: string;
}

export const PRICING_CATEGORIES: PricingCategoryMeta[] = [
    { id: 'food', label: 'Food & Produce', emoji: '🥕', description: 'Fresh farm produce, eggs, honey, bread, pantry staples, and prepared meals' },
    { id: 'services', label: 'Services & Trade', emoji: '🤝', description: 'Plumbing, electrical, carpentry, repairs, fabrication, and professional services' },
    { id: 'labour', label: 'Labour & Help', emoji: '👷', description: 'Gardening help, property sitting, firewood splitting, and heavy lifting' },
    { id: 'tools', label: 'Tools & Hardware', emoji: '🛠️', description: 'Tool hire, power equipment, garden machinery, and workshop gear' },
    { id: 'goods', label: 'Goods & Materials', emoji: '📦', description: 'Homewares, kitchenware, furniture, building supplies, and clothing' },
    { id: 'garden', label: 'Plants & Garden', emoji: '🌻', description: 'Seedlings, fruit trees, compost, mulch, seeds, and cuttings' },
    { id: 'housing', label: 'Housing & Space', emoji: '🏠', description: 'Guest rooms, shed storage, campsite, and workshop bench access' },
    { id: 'transport', label: 'Transport & Rides', emoji: '🚗', description: 'Rides, trailer hire, deliveries, and vehicle/cargo bike share' },
    { id: 'education', label: 'Education & Lessons', emoji: '📚', description: 'Music lessons, tutoring, design consults, and classes' },
    { id: 'arts', label: 'Arts & Crafts', emoji: '🎨', description: 'Handmade crafts, pottery, sewing, painting, and creative work' },
    { id: 'health', label: 'Health & Wellness', emoji: '🌿', description: 'Herbal remedies, natural care, wellness consults, and bodywork' },
    { id: 'care', label: 'Care & Family', emoji: '❤️', description: 'Babysitting, child care, prams, baby gear, and elder support' },
    { id: 'animals', label: 'Animals & Pets', emoji: '🐾', description: 'Poultry, hay, pet sitting, dog walking, and animal care' },
    { id: 'tech', label: 'Tech & Digital', emoji: '💻', description: 'Phone repair, computing, home WiFi, 3D printing, and digital support' },
    { id: 'energy', label: 'Energy & Firewood', emoji: '☀️', description: 'Firewood, kindling, solar consults, and off-grid power solutions' },
    { id: 'mindset', label: 'Mindset & Wisdom', emoji: '📜', description: 'Philosophy, mutual aid, daily pulse essays, community mindset' },
    { id: 'general', label: 'General & Community', emoji: '🌱', description: 'Event gear, venue space, marquee, sound hire, and community items' },
];

export const LEGACY_CATEGORY_ALIASES: Record<string, PricingCategory> = {
    food_produce: 'food',
    prepared_meals: 'food',
    tools_hardware: 'tools',
    labour_services: 'labour',
    skilled_trade: 'services',
    tech_digital: 'tech',
    transport_vehicles: 'transport',
    housing_space: 'housing',
    education_arts: 'education',
    household_goods: 'goods',
    kids_baby: 'care',
    animals_pet: 'animals',
    plants_garden: 'garden',
    events_community: 'general',
    raw_materials: 'goods',
};

export function normalizeCategory(category: string | undefined | null): PricingCategory {
    if (!category) return 'general';
    const trimmed = category.trim().toLowerCase();
    if (trimmed in LEGACY_CATEGORY_ALIASES) {
        return LEGACY_CATEGORY_ALIASES[trimmed];
    }
    const valid = PRICING_CATEGORIES.some(c => c.id === trimmed);
    if (valid) return trimmed as PricingCategory;
    return 'general';
}

export type PricingTrend = 'up' | 'down' | 'stable';
export type PricingConfidence = 'high' | 'medium' | 'low'; // 🟢 high (3+), 🟡 medium (1-2), 🔴 low (0 / default)

export interface PricingGuideItem {
    id: string;
    category: PricingCategory;
    emoji: string;
    name: string;
    description: string;
    priceBeans: number; // Base reference price
    unit?: string;      // e.g. "dozen", "hr", "day", "kg", "tray", "load"
    isPinned?: boolean;
    confidenceCount?: number;
    trend?: PricingTrend;
    seasonalityHint?: string;
    thumbnailUrl?: string;
    updatedAt?: string;
}

export interface PricingReport {
    id: string;
    itemId: string;
    reporterPubkey?: string;
    reportType: 'too_high' | 'too_low' | 'other';
    comment?: string;
    createdAt: string;
}

export interface PricingConfig {
    dataSource: 'local' | 'federation' | 'all';
    showSeasonality: boolean;     // default: true
}

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
    dataSource: 'local',
    showSeasonality: true,
};


/**
 * Filters out joke or outlier prices:
 * Ignores any price that is <= 0 or > 5x the baseline reference price.
 */
export function filterPriceOutliers(prices: number[], baselinePrice: number): number[] {
    if (prices.length === 0) return [];
    const maxAllowed = Math.max(baselinePrice * 5, 10);
    const minAllowed = Math.max(1, Math.round(baselinePrice * 0.1));
    return prices.filter(p => p >= minAllowed && p <= maxAllowed);
}

/**
 * Calculates trimmed average or median from a set of observed prices.
 */
export function aggregateObservedPrice(prices: number[], baselinePrice: number): {
    price: number;
    count: number;
    confidence: PricingConfidence;
} {
    const valid = filterPriceOutliers(prices, baselinePrice);
    if (valid.length === 0) {
        return { price: baselinePrice, count: 0, confidence: 'low' };
    }

    // Sort to compute median / trimmed mean
    valid.sort((a, b) => a - b);
    const count = valid.length;

    let aggregate: number;
    if (count === 1) {
        // Blend single observation with baseline to prevent 1 listing from swinging price excessively
        aggregate = Math.round((valid[0] + baselinePrice) / 2);
    } else if (count === 2) {
        aggregate = Math.round((valid[0] + valid[1]) / 2);
    } else {
        // Trim 1 highest and 1 lowest if 4 or more
        const trimmed = count >= 4 ? valid.slice(1, -1) : valid;
        const sum = trimmed.reduce((acc, v) => acc + v, 0);
        aggregate = Math.round(sum / trimmed.length);
    }

    const confidence: PricingConfidence = count >= 3 ? 'high' : count >= 1 ? 'medium' : 'low';
    return { price: Math.max(1, aggregate), count, confidence };
}

// ─────────────────────────────────────────────────────────────────────────────
// Default Seed Catalog (~500 items across 15 categories)
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_PRICING_CATALOG: PricingGuideItem[] = [
    // 🥕 Food & Produce
    { id: 'fp-001', category: 'food', emoji: '🥚', name: 'Free-range Eggs (Dozen)', description: 'Fresh farm eggs from pasture-raised hens', priceBeans: 6, unit: 'dozen' },
    { id: 'fp-002', category: 'food', emoji: '🍞', name: 'Artisan Sourdough Loaf', description: 'Naturally leavened fresh whole wheat or white sourdough', priceBeans: 8, unit: 'loaf' },
    { id: 'fp-003', category: 'food', emoji: '🍯', name: 'Raw Bush Honey (500g)', description: 'Cold-extracted unpasteurized local wildflower honey', priceBeans: 12, unit: 'jar' },
    { id: 'fp-004', category: 'food', emoji: '🥕', name: 'Seasonal Veggie Box (Standard)', description: 'Mixed seasonal greens, roots, and brassicas for 2-4 people', priceBeans: 35, unit: 'box' },
    { id: 'fp-005', category: 'food', emoji: '🥑', name: 'Organic Hass Avocados (1kg)', description: 'Tree-ripened creamy local avocados', priceBeans: 9, unit: 'kg' },
    { id: 'fp-006', category: 'food', emoji: '🍓', name: 'Fresh Strawberries (500g)', description: 'Sweet freshly picked chemical-free berries', priceBeans: 7, unit: 'punnet' },
    { id: 'fp-007', category: 'food', emoji: '🥬', name: 'Crisp Garden Salad Greens (250g)', description: 'Washed baby lettuce, rocket, and mizuna blend', priceBeans: 5, unit: 'bag' },
    { id: 'fp-008', category: 'food', emoji: '🧄', name: 'Heritage Purple Garlic (500g)', description: 'Locally cured pungent heritage garlic bulbs', priceBeans: 14, unit: 'bunch' },
    { id: 'fp-009', category: 'food', emoji: '🍄', name: 'Fresh Oyster Mushrooms (300g)', description: 'Grown on local hardwood sawdust / straw', priceBeans: 10, unit: 'punnet' },
    { id: 'fp-010', category: 'food', emoji: '🍅', name: 'Heirloom Tomatoes (1kg)', description: 'Sun-ripened heritage varieties (brandywine, cherokee)', priceBeans: 8, unit: 'kg', seasonalityHint: 'Plentiful & cheaper in summer/autumn' },
    { id: 'fp-011', category: 'food', emoji: '🌿', name: 'Fresh Culinary Herbs Bundle', description: 'Rosemary, thyme, mint, or basil fresh cut bunch', priceBeans: 4, unit: 'bunch' },
    { id: 'fp-012', category: 'food', emoji: '🍊', name: 'Citrus Box (5kg Oranges/Lemons)', description: 'Juicy backyard Meyer lemons or Valencia oranges', priceBeans: 15, unit: 'box', seasonalityHint: 'High abundance in winter' },
    { id: 'fp-013', category: 'food', emoji: '🫒', name: 'Cold Pressed Extra Virgin Olive Oil (1L)', description: 'Locally grown and cold pressed olive oil', priceBeans: 24, unit: 'bottle' },
    { id: 'fp-014', category: 'food', emoji: '🫑', name: 'Sweet Bell Peppers (1kg)', description: 'Red, yellow, and green garden capsicums', priceBeans: 7, unit: 'kg' },
    { id: 'fp-015', category: 'food', emoji: '🥔', name: 'Dutch Cream / Sebago Potatoes (5kg)', description: 'Freshly dug unwashed cooking potatoes', priceBeans: 12, unit: 'sack' },
    { id: 'fp-016', category: 'food', emoji: '🧅', name: 'Brown / Red Cooking Onions (2kg)', description: 'Cured sweet storage onions', priceBeans: 6, unit: 'bag' },
    { id: 'fp-017', category: 'food', emoji: '🎃', name: 'Kent / Butternut Pumpkin (Whole)', description: 'Sweet roasting pumpkin (~3-4kg)', priceBeans: 8, unit: 'each' },
    { id: 'fp-018', category: 'food', emoji: '🍎', name: 'Crisp Orchard Apples (2kg)', description: 'Pink Lady, Gala, or Granny Smith apples', priceBeans: 9, unit: 'bag' },
    { id: 'fp-019', category: 'food', emoji: '🫐', name: 'Fresh Blueberries (250g)', description: 'Sweet freshly picked organic blueberries', priceBeans: 8, unit: 'punnet' },
    { id: 'fp-020', category: 'food', emoji: '🥒', name: 'Lebanese Cucumbers (1kg)', description: 'Crisp greenhouse or garden cucumbers', priceBeans: 5, unit: 'kg' },

    // 🍽️ Prepared Meals (Food)
    { id: 'pm-001', category: 'food', emoji: '🍲', name: 'Hearty Soup / Stew (1L Jar)', description: 'Nutritious lentil, pumpkin, or bone broth batch meal', priceBeans: 12, unit: 'jar' },
    { id: 'pm-002', category: 'food', emoji: '🍕', name: 'Wood-fired Sourdough Pizza', description: 'Freshly baked 12-inch pizza with local garden toppings', priceBeans: 16, unit: 'each' },
    { id: 'pm-003', category: 'food', emoji: '🥧', name: 'Family Size Savory Pie', description: 'Rich beef & mushroom or roasted vegetable family pie', priceBeans: 22, unit: 'each' },
    { id: 'pm-004', category: 'food', emoji: '🧁', name: 'Fresh Baked Muffin Batch (6x)', description: 'Blueberry, choc chip, or apple cinnamon muffins', priceBeans: 14, unit: 'pack' },
    { id: 'pm-005', category: 'food', emoji: '🎂', name: 'Custom Celebration Cake', description: 'Decorated birthday or gathering sponge/choc cake', priceBeans: 45, unit: 'each' },
    { id: 'pm-006', category: 'food', emoji: '🍱', name: 'Community Lunch Plate', description: 'Single portion hot lunch with salad and grain', priceBeans: 10, unit: 'plate' },
    { id: 'pm-007', category: 'food', emoji: '🫙', name: 'Homemade Fermented Kimchi (500ml)', description: 'Traditional spicy probiotic fermented cabbage', priceBeans: 10, unit: 'jar' },
    { id: 'pm-008', category: 'food', emoji: '🥟', name: 'Handmade Dumplings (Pack of 12)', description: 'Pork & chive or mushroom & ginger dumplings', priceBeans: 15, unit: 'pack' },
    { id: 'pm-009', category: 'food', emoji: '🫓', name: 'Homemade Sourdough Focaccia (Tray)', description: 'Rosemary, sea salt, and olive oil focaccia sheet', priceBeans: 14, unit: 'tray' },
    { id: 'pm-010', category: 'food', emoji: '🍪', name: 'Choc Chunk Cookie Batch (10x)', description: 'Chewy bakery style sourdough chocolate cookies', priceBeans: 12, unit: 'pack' },
    { id: 'pm-011', category: 'food', emoji: '🥘', name: 'Family Lasagna Tray (Serves 6)', description: 'Slow cooked ragu or ricotta roasted veggie lasagna', priceBeans: 32, unit: 'tray' },
    { id: 'pm-012', category: 'food', emoji: '🧃', name: 'Live Kombucha (1L Bottle)', description: 'Ginger, berry, or lemon myrtle sparkling kombucha', priceBeans: 8, unit: 'bottle' },

    // 🔧 Tools & Hardware
    { id: 'th-001', category: 'tools', emoji: '🪚', name: 'Cordless Circular Saw Hire (24hr)', description: '18V cordless saw with charged battery and blade', priceBeans: 15, unit: 'day' },
    { id: 'th-002', category: 'tools', emoji: '🪜', name: 'Extension Ladder Hire (6m / Day)', description: 'Heavy-duty aluminium telescopic extension ladder', priceBeans: 12, unit: 'day' },
    { id: 'th-003', category: 'tools', emoji: '🚜', name: 'Petrol Post Hole Digger (Day Hire)', description: '2-man petrol auger for fencing and tree planting', priceBeans: 35, unit: 'day' },
    { id: 'th-004', category: 'tools', emoji: '🚿', name: 'High Pressure Washer (24hr Hire)', description: 'Petrol or electric washer for driveways and decks', priceBeans: 20, unit: 'day' },
    { id: 'th-005', category: 'tools', emoji: '🪵', name: 'Chainsaw Hire (Petrol 18-inch)', description: 'Sharp chain, bar oil, and safety helmet included', priceBeans: 30, unit: 'day' },
    { id: 'th-006', category: 'tools', emoji: '🌾', name: 'Petrol Brushcutter / Whipper Snipper', description: 'Heavy duty cord and brush blade attachment', priceBeans: 20, unit: 'day' },
    { id: 'th-007', category: 'tools', emoji: '🧱', name: 'Cement Mixer Hire (Electric)', description: 'Portable barrel mixer for concrete and mortar jobs', priceBeans: 25, unit: 'day' },
    { id: 'th-008', category: 'tools', emoji: '🦽', name: 'Heavy Duty Wheelbarrow', description: 'Steel tray puncture-proof tire garden wheelbarrow', priceBeans: 8, unit: 'day' },
    { id: 'th-009', category: 'tools', emoji: '🪛', name: 'Socket & Mechanic Tool Set (48hr)', description: 'Complete metric and imperial ratchet and wrench set', priceBeans: 10, unit: 'hire' },
    { id: 'th-010', category: 'tools', emoji: '🧯', name: 'Carpet & Upholstery Cleaner Machine', description: 'Deep extraction cleaner with pet spot nozzle', priceBeans: 25, unit: 'day' },

    // 👷 Labour & Help
    { id: 'ls-001', category: 'care', emoji: '👶', name: 'Babysitting / Child Care (per hr)', description: 'Experienced and attentive local child care support', priceBeans: 18, unit: 'hr' },
    { id: 'ls-002', category: 'labour', emoji: '🌿', name: 'Lawn Mowing & Edge Trimming (Std Yard)', description: 'Mow front & back lawn with clippings mulched/removed', priceBeans: 30, unit: 'job' },
    { id: 'ls-003', category: 'labour', emoji: '🧹', name: 'General House Cleaning (per hr)', description: 'Thorough dusting, vacuuming, mopping, bathroom clean', priceBeans: 22, unit: 'hr' },
    { id: 'ls-004', category: 'energy', emoji: '🪵', name: 'Firewood Splitting & Stacking (2hr)', description: 'Splitting rounds and stacking cords for winter seasoning', priceBeans: 45, unit: 'session' },
    { id: 'ls-005', category: 'labour', emoji: '🏡', name: 'House / Property Sitting (per night)', description: 'Feed animals, water plants, collect mail, stay overnight', priceBeans: 25, unit: 'night' },
    { id: 'ls-006', category: 'labour', emoji: '🌱', name: 'Garden Weeding & Mulching (per hr)', description: 'Bed weeding, pruning, spreading mulch, soil turning', priceBeans: 20, unit: 'hr' },
    { id: 'ls-007', category: 'labour', emoji: '🧽', name: 'Window Cleaning (Full House Exterior)', description: 'Wash external glass and wipe frames on single storey', priceBeans: 40, unit: 'job' },
    { id: 'ls-008', category: 'labour', emoji: '📦', name: 'Moving & Heavy Lifting Help (per hr)', description: 'Assisting with loading trucks, furniture, or bulky items', priceBeans: 25, unit: 'hr' },
    { id: 'ls-009', category: 'labour', emoji: '🍂', name: 'Gutter Cleaning (Single Storey)', description: 'Clear leaves and flush downpipes before fire season', priceBeans: 35, unit: 'job' },

    // 🤝 Services & Trade
    { id: 'st-001', category: 'services', emoji: '🚰', name: 'Plumbing Repair / Callout (1 hr)', description: 'Fix leaking taps, unblock drains, toilet cistern valve', priceBeans: 45, unit: 'hr' },
    { id: 'st-002', category: 'services', emoji: '⚡', name: 'Electrical Work / Callout (1 hr)', description: 'Power point replacement, light fixture wiring, switchboard', priceBeans: 50, unit: 'hr' },
    { id: 'st-003', category: 'services', emoji: '🪚', name: 'Carpentry & Handyman Work (per hr)', description: 'Decking repairs, door hanging, shelving, custom timber', priceBeans: 35, unit: 'hr' },
    { id: 'st-004', category: 'services', emoji: '🚲', name: 'Bicycle Full Tune-up & Service', description: 'Brake adjust, gear indexing, wheel true, chain lube', priceBeans: 25, unit: 'service' },
    { id: 'st-005', category: 'services', emoji: '🔪', name: 'Kitchen Knife / Tool Sharpening (3x)', description: 'Whetstone precision edge restoration for 3 blades', priceBeans: 12, unit: 'set' },
    { id: 'st-006', category: 'services', emoji: '👨‍🏭', name: 'Welding & Steel Fabrication (1 hr)', description: 'MIG / Arc welding gate repair, bracket fabrication', priceBeans: 40, unit: 'hr' },
    { id: 'st-007', category: 'services', emoji: '⛓️', name: 'Chainsaw Chain Machine Sharpening', description: 'Precision angle ground chain teeth and depth gauges', priceBeans: 8, unit: 'chain' },
    { id: 'st-008', category: 'services', emoji: '🎨', name: 'Interior Wall Painting (Room)', description: 'Patching, priming, and 2 top coats on standard room', priceBeans: 80, unit: 'room' },

    // 💻 Tech & Digital
    { id: 'td-001', category: 'tech', emoji: '📱', name: 'Phone Screen Replacement (Labour)', description: 'Fit replacement glass/OLED screen (parts supplied/separate)', priceBeans: 30, unit: 'repair' },
    { id: 'td-002', category: 'tech', emoji: '💻', name: 'Computer Cleanup / Fresh OS Install', description: 'Virus removal, backup, SSD upgrade or fresh OS setup', priceBeans: 35, unit: 'service' },
    { id: 'td-003', category: 'tech', emoji: '📡', name: 'Home WiFi & Mesh Network Setup', description: 'Configure router, extenders, eliminate dead zones', priceBeans: 30, unit: 'job' },
    { id: 'td-004', category: 'tech', emoji: '🖨️', name: '3D Printing Service (Standard Part)', description: 'PETG / PLA custom bracket or replacement gear print', priceBeans: 12, unit: 'part' },
    { id: 'td-005', category: 'tech', emoji: '🌐', name: 'Basic Community Website / Portfolio', description: 'Simple 3-page mobile-friendly website setup', priceBeans: 75, unit: 'project' },
    { id: 'td-006', category: 'tech', emoji: '📻', name: 'Audio / PA Sound Setup for Event', description: 'Cabling, mixer equalization, microphones, and speakers', priceBeans: 40, unit: 'event' },

    // 🚗 Transport & Vehicles
    { id: 'tv-001', category: 'transport', emoji: '🚙', name: 'Airport / City Return Ride', description: 'Direct pickup and dropoff with luggage capacity', priceBeans: 40, unit: 'trip' },
    { id: 'tv-002', category: 'transport', emoji: '🚚', name: 'Box Trailer Hire (8x5 High Cage / Day)', description: 'Roadworthy caged trailer for green waste or furniture', priceBeans: 20, unit: 'day' },
    { id: 'tv-003', category: 'transport', emoji: '🛻', name: 'Ute Transport Run (Town & Back)', description: 'Driver + utility tray for bulky store pickups', priceBeans: 30, unit: 'trip' },
    { id: 'tv-004', category: 'transport', emoji: '🚲', name: 'Electric Cargo Bike Hire (24hr)', description: 'Includes panniers, child seat option, and charger', priceBeans: 25, unit: 'day' },
    { id: 'tv-005', category: 'transport', emoji: '🐴', name: 'Horse Float / Stock Trailer Hire', description: 'Dual axle partitioned livestock or horse trailer', priceBeans: 45, unit: 'day' },

    // 🏠 Housing & Space
    { id: 'hs-001', category: 'housing', emoji: '🛏️', name: 'Guest Room for Night', description: 'Cozy private bedroom with clean linen and shared amenities', priceBeans: 35, unit: 'night' },
    { id: 'hs-002', category: 'housing', emoji: '🏕️', name: 'Tent Campsite on Acreage (per night)', description: 'Quiet secluded grass camp spot with access to water/toilet', priceBeans: 15, unit: 'night' },
    { id: 'hs-003', category: 'housing', emoji: '🏚️', name: 'Dry Shed Storage (Pallet Space / Month)', description: 'Secure weather-tight storage space for boxes or gear', priceBeans: 20, unit: 'month' },
    { id: 'hs-004', category: 'housing', emoji: '🪵', name: 'Workshop Bench Access (Day)', description: 'Access to workbench, vice, and communal hand tools', priceBeans: 18, unit: 'day' },
    { id: 'hs-005', category: 'housing', emoji: '🐎', name: 'Paddock Grazing / Agistment (Month)', description: 'Fenced pasture with automatic water trough for horse/sheep', priceBeans: 60, unit: 'month' },

    // 📚 Education & Lessons
    { id: 'ea-001', category: 'education', emoji: '🎸', name: 'Guitar / Ukulele Lesson (1 hr)', description: 'Beginner or intermediate chords, fingerstyle, rhythm', priceBeans: 25, unit: 'hr' },
    { id: 'ea-002', category: 'education', emoji: '🎹', name: 'Piano / Keyboard Lesson (1 hr)', description: 'Music theory, classical or contemporary song playing', priceBeans: 30, unit: 'hr' },
    { id: 'ea-003', category: 'education', emoji: '📐', name: 'Maths / Science High School Tutoring', description: 'Exam preparation, homework help, and fundamentals', priceBeans: 28, unit: 'hr' },
    { id: 'ea-004', category: 'education', emoji: '🌱', name: 'Permaculture Garden Design Consult (2hr)', description: 'Property walk, water flow analysis, planting zone map', priceBeans: 55, unit: 'session' },
    { id: 'ea-005', category: 'arts', emoji: '🧵', name: 'Sewing & Garment Mending Class (2hr)', description: 'Learn machine basics, hemming, patching, zipper replacement', priceBeans: 35, unit: 'class' },
    { id: 'ea-006', category: 'arts', emoji: '🎨', name: 'Botanical Watercolour Workshop', description: 'All materials provided for a 2-hour guided painting circle', priceBeans: 30, unit: 'seat' },

    // 📦 Goods & Materials
    { id: 'hg-001', category: 'goods', emoji: '🍳', name: 'Restored Vintage Cast Iron Skillet', description: 'Cleaned, stripped, and 3x seasoned ready to cook', priceBeans: 25, unit: 'each' },
    { id: 'hg-002', category: 'goods', emoji: '☕', name: 'Handmade Ceramic Coffee Mug', description: 'Wheel-thrown stoneware pottery mug by local artisan', priceBeans: 15, unit: 'each' },
    { id: 'hg-003', category: 'goods', emoji: '🫙', name: 'Mason Preserving Jars Lot (Pack of 12)', description: '1L glass jars with clean airtight sealing bands and lids', priceBeans: 18, unit: 'box' },
    { id: 'hg-004', category: 'goods', emoji: '🪑', name: 'Solid Timber Kitchen Chair', description: 'Sturdy sanded and oiled hardwood or pine chair', priceBeans: 20, unit: 'each' },
    { id: 'hg-005', category: 'goods', emoji: '🧺', name: 'Hand-woven Cane Laundry Basket', description: 'Durable natural woven basket with carry handles', priceBeans: 22, unit: 'each' },
    { id: 'rm-002', category: 'goods', emoji: '🪵', name: 'Milled Hardwood Timber Slab (2.4m x 0.4m)', description: 'Kiln dried rough sawn timber slab for bench or tabletop', priceBeans: 60, unit: 'slab' },

    // ❤️ Care & Family
    { id: 'kb-001', category: 'care', emoji: '🚼', name: 'All-Terrain 3-Wheel Running Pram', description: 'Inflatable tires, parent brake, good suspension', priceBeans: 65, unit: 'each' },
    { id: 'kb-002', category: 'care', emoji: '👕', name: 'Baby Clothes Bundle (0–12 Months, 20pcs)', description: 'Clean washed organic cotton onesies, rompers, and socks', priceBeans: 25, unit: 'bundle' },
    { id: 'kb-003', category: 'care', emoji: '🪵', name: 'Montessori Wooden Toy / Block Set', description: 'Natural unvarnished hardwood blocks, stacking rings', priceBeans: 18, unit: 'set' },
    { id: 'kb-004', category: 'care', emoji: '🚲', name: 'Toddler Balance Bike', description: 'Puncture proof tires with adjustable saddle and handlebars', priceBeans: 30, unit: 'each' },

    // 🐾 Animals & Pets
    { id: 'ap-001', category: 'animals', emoji: '🐔', name: 'Point-of-lay Heritage Hen (Isa Brown / Australorp)', description: 'Healthy vaccinated young hen ready to lay eggs daily', priceBeans: 20, unit: 'hen' },
    { id: 'ap-002', category: 'animals', emoji: '🌾', name: 'Prime Lucerne / Pasture Hay Bale', description: 'Tight weed-free green square bale for goats, sheep, horses', priceBeans: 16, unit: 'bale' },
    { id: 'ap-003', category: 'animals', emoji: '🐕', name: 'Dog Walking (45 min Pack Walk)', description: 'Exercise and social stimulation in local park/trails', priceBeans: 15, unit: 'walk' },
    { id: 'ap-004', category: 'animals', emoji: '🐝', name: 'Nucleus Bee Colony (5-Frame Nuc)', description: 'Laying queen with brood, honey stores, and working bees', priceBeans: 140, unit: 'nuc' },

    // 🌻 Plants & Garden
    { id: 'pg-001', category: 'garden', emoji: '🌱', name: 'Heritage Heirloom Seedling Punnet (6x)', description: 'Kale, silverbeet, cos lettuce, or broccoli seedlings', priceBeans: 6, unit: 'punnet' },
    { id: 'pg-002', category: 'garden', emoji: '🌳', name: 'Grafted Fruit Tree Sapling (in 5L Pot)', description: 'Apple, citrus, fig, or plum established rootstock', priceBeans: 35, unit: 'tree' },
    { id: 'pg-003', category: 'garden', emoji: '🪱', name: 'Compost Worm Starter Colony (1,000+ worms)', description: 'Red wigglers with active castings and bedding', priceBeans: 20, unit: 'bucket' },
    { id: 'pg-004', category: 'garden', emoji: '🧪', name: 'Aerated Compost Tea Brew (10L Drum)', description: 'Biologically rich liquid fertilizer for garden soil', priceBeans: 12, unit: 'drum' },
    { id: 'rm-004', category: 'garden', emoji: '🪨', name: 'Aged Mushroom Compost (Trailer Load ~0.7 m³)', description: 'Rich organic matter for soil conditioning and vegetable beds', priceBeans: 35, unit: 'trailer' },

    // ☀️ Energy & Firewood
    { id: 'rm-001', category: 'energy', emoji: '🪵', name: 'Dry Split Hardwood Firewood (1 m³)', description: 'Seasoned ironbark/box hardwood, ready for slow burning', priceBeans: 85, unit: 'm³', seasonalityHint: 'High demand in autumn/winter' },
    { id: 'rm-003', category: 'energy', emoji: '🪵', name: 'Kindling Sack (Heavy Duty Bag)', description: 'Dry pine and hardwood offcuts for easy fire starting', priceBeans: 10, unit: 'bag' },

    // 🌱 General & Community
    { id: 'ec-001', category: 'general', emoji: '🎪', name: 'Party Marquee Gazebo (3m x 6m Hire)', description: 'Waterproof pop-up canopy with sidewalls and weights', priceBeans: 40, unit: 'event' },
    { id: 'ec-002', category: 'general', emoji: '🪑', name: 'Foldable Trestle Tables (Set of 4)', description: 'Heavy-duty 1.8m plastic fold-in-half tables', priceBeans: 18, unit: 'day' },
    { id: 'ec-003', category: 'general', emoji: '📽️', name: 'Outdoor Movie Projector + 100" Screen', description: 'HD projector with HDMI inputs and collapsible canvas screen', priceBeans: 35, unit: 'night' },
];
