/**
 * Starter drafts for a member's first Offer (scratch/fable-design/DESIGN-cold-start-trades-fable.md §3, Pick 2, slice O1;
 * Marty, 4 Nov 2026: "All Fable's picks").
 *
 * An Offer is the gate to buying, to posting a Need and to spending room, and a blank six-field form is where newcomers
 * stop. So "Post your first Offer" will open a sheet of three drafts drawn from the categories the member starred, and a tap
 * will open the composer filled in. This file is the drafts and the rule that picks them: words only, bundled so it works
 * with no connection and no data, one file for both apps (the phone and the web draw the same three rows). The sheet and
 * its door are slice O2; nothing here draws, stores or posts anything.
 *
 * - **A draft is words, never a post.** No photo, no place, no name, no price the member did not see. The composer still asks
 *   for the photo and the place, and Post is still the member's tap (market-photos-mandatory, no auto-posting). A draft is
 *   written to read as a whole listing if the member changes nothing: no "…", no blank to fill, no placeholder.
 * - **Nothing fake.** Each draft is a kind of help or thing a neighbour really might offer. Nobody but the member who opens
 *   the sheet ever sees it, and it costs nothing to ignore.
 * - **The stars choose the drafts, and only for their owner.** `starterOffersFor` reads the list of starred category ids the
 *   phone already holds (Home's What are you into? card); it never reads another member's stars and shows no count.
 * - **Words.** Every title and description is a `word()` key: the app shows it through `t()` where it draws it. Both are
 *   written without the glossary's terms (Beans, Offer, Need, community, event…) so a translation never has to guess one.
 */

import { PRICING_CATEGORIES, type PricingCategory } from './pricing-catalog.js';
import { word, type WordKey } from './words.js';

/**
 * How a draft is priced. `hourly` and `fixed` are the composer's own price types. `free` is a `fixed` price of nothing (the
 * Tool shed's List sheet makes a Free fee the same way: its `postPriceType` is `fixed`, its credits 0), and a draft that can
 * be lent is always `free`.
 *
 * There is no `daily` or `weekly`, on purpose: a node keeps a fee per day or per week only on a loan
 * (apps/server/src/routes/marketplace.ts, "Any other listing is one fee or by the hour"; test-lendable-offers.ts pins it),
 * and the composer sends no `lendable`. A draft that is not lent and opened as "/ Dy" would be stored as one Total at one
 * day's price, so the member would post something other than what the draft said. What the pricing guide prices per day or
 * per night (a ladder, a trailer, a stay for a pet) is a `fixed` price, and the draft's own words say it is for one day or
 * one night ("to hire for the day", "for a night"): then the Total is true as it stands.
 */
export type StarterPriceType = 'hourly' | 'fixed' | 'free';

/** One starter draft, as the table keeps it. */
export interface StarterOffer {
    /** The row's label and the composer's title. A `word()` key: shown through t(). A whole listing title as it stands. */
    title: WordKey;
    /** The composer's description. A `word()` key: shown through t(). A whole description as it stands. */
    description: WordKey;
    priceType: StarterPriceType;
    /** A loan: the Offer is lendable (one borrower at a time). Only a `free` draft is. */
    lendable?: boolean;
    /**
     * English words that find this draft's figure in the pricing guide, never shown and never translated:
     * `pricingHintFor(items, draft.category, draft.guide)` gives the guide's price in Beans as `credits`. Take only that
     * figure and the draft's own `priceType`: the hint's `priceType` can be per day, per week or per month, which a node
     * keeps only on a loan, and the draft's own words already say what the figure is for. (An owner can re-unit a guide item
     * on their node: `pricingItemFor` gives the unit, so the sheet can drop a figure whose unit is not the one this draft's
     * words name.) The draft's own title cannot find it: it is shown in the member's language, and "An hour of help" shares
     * no telling word with any item in the guide. Absent on a `free` draft, and on a paid one only where the guide has no
     * item in the category at all (Health & Wellness, Mindset & Wisdom): the sheet shows no figure for it and the
     * composer's own "View the Community Pricing Guide" is the member's to open.
     */
    guide?: string;
}

/** A draft as the sheet receives it: the table's entry with the category it came from and an id for a row's key. */
export interface StarterDraft extends StarterOffer {
    category: PricingCategory;
    /** `<category>.<position, from 1>`: stable across languages, for a row's key and test id. */
    id: string;
}

/** How many drafts the sheet shows. */
export const STARTER_OFFER_COUNT = 3;

/**
 * Three drafts for each of the 17 categories, in the order a neighbour is likelier to offer them: the first is what the
 * category's chip says to most people. Each entry reads, as it stands, as a whole listing (see the file's header).
 */
export const STARTER_OFFERS: Readonly<Record<PricingCategory, readonly StarterOffer[]>> = Object.freeze({
    food: [
        { title: word('Bread baked at home'), description: word('Fresh bread, baked at home. Message me to arrange a pickup.'), priceType: 'fixed', guide: 'Artisan Sourdough Loaf' },
        { title: word('A home-cooked meal'), description: word('A meal cooked with care at home. Tell me about any foods to avoid.'), priceType: 'fixed', guide: 'Community Lunch Plate' },
        { title: word('Honey and preserves'), description: word('Honey, jam or pickles from my kitchen. Message me to see what is ready.'), priceType: 'fixed', guide: 'Raw Bush Honey' },
    ],
    services: [
        { title: word('Handy repairs'), description: word('I can fix things around the house. Tell me what is broken and I will take a look.'), priceType: 'hourly', guide: 'Carpentry Handyman Work' },
        { title: word('Bike tune-up'), description: word('Brakes, gears and chain checked and adjusted. Message me to book a time.'), priceType: 'fixed', guide: 'Bicycle Full Tune-up Service' },
        { title: word('Knife and tool sharpening'), description: word('A sharp edge on kitchen knives and garden tools. Drop them off or message me.'), priceType: 'fixed', guide: 'Kitchen Knife Tool Sharpening' },
    ],
    labour: [
        { title: word('An hour of help'), description: word('An extra pair of hands for jobs around the house or yard. Tell me what and when.'), priceType: 'hourly', guide: 'Moving Heavy Lifting Help' },
        { title: word('Cleaning and tidying'), description: word('A thorough clean or tidy-up of your home. Tell me what needs doing and when.'), priceType: 'hourly', guide: 'General House Cleaning' },
        { title: word('House sitting'), description: word('I can mind your home for a night: plants, pets and the mail. Message me for dates.'), priceType: 'fixed', guide: 'House Property Sitting' },
    ],
    tools: [
        { title: word('Lend a tool'), description: word('A tool from my shed, free to borrow. Message me to say which one and for how long.'), priceType: 'free', lendable: true },
        { title: word('Hire out a ladder'), description: word('A sturdy ladder to hire for the day. Message me to arrange pickup and return.'), priceType: 'fixed', guide: 'Extension Ladder Hire' },
        { title: word('Power tool hire'), description: word('Power tools to hire for the day, charged and ready. Message me for what I have.'), priceType: 'fixed', guide: 'Cordless Circular Saw' },
    ],
    goods: [
        { title: word('Free to a good home'), description: word('Something in good shape that I no longer need. Message me if it would help you.'), priceType: 'free' },
        { title: word('Furniture and homewares'), description: word('Furniture or homewares in good shape, cleaned and ready to go.'), priceType: 'fixed', guide: 'Solid Timber Kitchen Chair' },
        { title: word('Timber and materials'), description: word('Timber and other building materials, ready to collect. Message me for what I have.'), priceType: 'fixed', guide: 'Milled Hardwood Timber Slab' },
    ],
    garden: [
        { title: word('Extra from the garden'), description: word('Spare seedlings, cuttings and produce from my garden. Message me to arrange pickup.'), priceType: 'fixed', guide: 'Heritage Heirloom Seedling Punnet' },
        { title: word('Compost and mulch'), description: word('Rich compost or mulch for garden beds. Message me for amounts and pickup.'), priceType: 'fixed', guide: 'Aged Mushroom Compost' },
        { title: word('Fruit trees and plants'), description: word('Young fruit trees and plants, potted and ready to plant. Message me to see what I have.'), priceType: 'fixed', guide: 'Grafted Fruit Tree Sapling' },
    ],
    housing: [
        { title: word('Spare room for a night'), description: word('A guest room with clean linen. Message me for dates and what is shared.'), priceType: 'fixed', guide: 'Guest Room Night' },
        { title: word('A place to camp'), description: word('A quiet grassy spot to pitch a tent for a night, with water nearby. Message me for dates.'), priceType: 'fixed', guide: 'Tent Campsite Acreage' },
        { title: word('Workshop bench time'), description: word('Use of my workbench, vice and hand tools for the day. Message me to book.'), priceType: 'fixed', guide: 'Workshop Bench Access' },
    ],
    transport: [
        { title: word('A lift into town'), description: word('I can drive you into town and back. Message me when and where.'), priceType: 'fixed', guide: 'Airport City Return Ride' },
        { title: word('Trailer hire'), description: word('A box trailer to hire for the day. Message me for the size and when it is free.'), priceType: 'fixed', guide: 'Box Trailer' },
        { title: word('Carry it in my ute'), description: word('I can collect and deliver bulky things in my ute. Message me what and where.'), priceType: 'fixed', guide: 'Ute Transport Run Town Back' },
    ],
    education: [
        { title: word('Tutoring by the hour'), description: word('Help with homework, exams or a subject I know well. Message me what you are after.'), priceType: 'hourly', guide: 'Maths Science High School Tutoring' },
        { title: word('Music lessons'), description: word('A first lesson on guitar, piano or another instrument I play. Message me to arrange.'), priceType: 'hourly', guide: 'Guitar Ukulele Lesson' },
        { title: word('Garden design visit'), description: word('I can walk your land and suggest where to plant, build soil and catch water.'), priceType: 'fixed', guide: 'Permaculture Garden Design Consult' },
    ],
    arts: [
        { title: word('A sewing class'), description: word('Learn the basics of sewing and mending. Message me for times.'), priceType: 'fixed', guide: 'Sewing Garment Mending Class' },
        { title: word('A painting workshop'), description: word('A guided painting session with all the materials ready. Message me for dates.'), priceType: 'fixed', guide: 'Botanical Watercolour Workshop' },
        { title: word('Handmade gifts'), description: word('Pottery, knitting, cards or woodwork made by hand. Message me to see what is ready.'), priceType: 'fixed', guide: 'Handmade Ceramic Coffee Mug' },
    ],
    health: [
        { title: word('A stretch session'), description: word('A relaxed stretching session for beginners. Message me for times and place.'), priceType: 'hourly' },
        { title: word('Herbal tea blends'), description: word('Dried herbs blended for tea, grown or gathered by me. Message me to see what is ready.'), priceType: 'fixed' },
        { title: word('A listening ear'), description: word('Time and a cup of tea for someone who needs to talk. Message me whenever.'), priceType: 'free' },
    ],
    care: [
        { title: word('Babysitting'), description: word('Attentive care for your children while you are out. Message me about dates and ages.'), priceType: 'hourly', guide: 'Babysitting Child Care' },
        { title: word("Kids' clothes and gear"), description: word('Clean clothes, toys and gear my children have outgrown. Message me to see.'), priceType: 'fixed', guide: 'Baby Clothes Bundle' },
        { title: word('A visit and a hand'), description: word('A regular visit, an errand or a lift for someone who could use a hand.'), priceType: 'free' },
    ],
    animals: [
        { title: word('Dog walking'), description: word('I can walk your dog while you are out or away. Message me about your dog.'), priceType: 'fixed', guide: 'Dog Walking Pack Walk' },
        { title: word('Pet sitting'), description: word('Feeding, walks and cuddles for a night while you are away. Message me for dates.'), priceType: 'fixed', guide: 'House Property Sitting' },
        { title: word('Eggs from my hens'), description: word('Fresh eggs from my hens, by the dozen. Message me to arrange pickup.'), priceType: 'fixed', guide: 'Free-range Eggs Dozen' },
    ],
    tech: [
        { title: word('Computer or phone help'), description: word('I can sort out a slow computer, a phone problem or a setup. Message me what is wrong.'), priceType: 'fixed', guide: 'Computer Cleanup Install' },
        { title: word('Wifi and network setup'), description: word('Router, extenders and dead spots sorted out. Message me to arrange a visit.'), priceType: 'fixed', guide: 'Home WiFi Mesh Network Setup' },
        { title: word('A simple website'), description: word('A simple, mobile-friendly website for your project or business. Message me what you need.'), priceType: 'fixed', guide: 'Basic Community Website Portfolio' },
    ],
    energy: [
        { title: word('Firewood'), description: word('Dry split firewood, ready to burn. Message me for how much and delivery.'), priceType: 'fixed', guide: 'Dry Split Hardwood Firewood' },
        { title: word('Firewood splitting'), description: word('I can split and stack your firewood. Tell me how much and when.'), priceType: 'fixed', guide: 'Firewood Splitting Stacking' },
        { title: word('Kindling by the bag'), description: word('Dry pine and hardwood offcuts for starting fires. Message me to collect a bag.'), priceType: 'fixed', guide: 'Kindling Sack' },
    ],
    mindset: [
        { title: word('Talk it through'), description: word('Time to talk through an idea, a worry or a big question. Message me whenever it suits.'), priceType: 'free' },
        { title: word('Lend a good book'), description: word('Books that changed my mind, free to borrow. Message me and I will bring one along.'), priceType: 'free', lendable: true },
        { title: word('Think a plan through'), description: word('Help to turn a first idea into clear next steps. Message me to set a time.'), priceType: 'hourly' },
    ],
    general: [
        { title: word('Trestle tables to hire'), description: word('Folding tables to hire for the day, for a party or a stall. Message me for dates.'), priceType: 'fixed', guide: 'Foldable Trestle Tables' },
        { title: word('A marquee to hire'), description: word('A waterproof marquee for a party or a gathering. Message me for dates and size.'), priceType: 'fixed', guide: 'Party Marquee Gazebo' },
        { title: word('Movie night kit'), description: word('A projector and screen for an outdoor movie night. Message me for dates.'), priceType: 'fixed', guide: 'Outdoor Movie Projector Screen' },
    ],
});

/**
 * The categories whose first draft is shown to a member who has starred nothing: labour, tools and the garden, the kinds
 * every community trades first ("An hour of help", "Lend a tool", "Extra from the garden").
 */
export const STARTER_FALLBACK_CATEGORIES: readonly PricingCategory[] = Object.freeze(['labour', 'tools', 'garden'] as const);

const CATEGORY_IDS: ReadonlySet<string> = new Set(PRICING_CATEGORIES.map((c) => c.id));

function draftOf(category: PricingCategory, position: number): StarterDraft {
    // A copy, so a caller changing what it was handed cannot change the table every later call reads.
    return { ...STARTER_OFFERS[category][position], category, id: `${category}.${position + 1}` };
}

/**
 * The (at most three) drafts for a member who has starred `interests`, in the order they starred them. One draft per star,
 * each category's first; if the stars run out before three, a second round takes each category's second, then its third.
 * Nobody has fewer than three to be offered: one star gives that category's three. With nothing starred, or nothing the
 * node knows, the fallback three (labour, tools, garden). An id that is not one of the 17 categories, a repeat, and anything
 * that is not a string are dropped, as the node drops them when it stores the stars.
 *
 * Pure and deterministic: the same stars give the same drafts. Nothing is read from the node, the clock or the language.
 */
export function starterOffersFor(interests: readonly unknown[] | null | undefined): StarterDraft[] {
    const starred: PricingCategory[] = [];
    for (const raw of Array.isArray(interests) ? interests : []) {
        if (typeof raw === 'string' && CATEGORY_IDS.has(raw) && !starred.includes(raw as PricingCategory)) starred.push(raw as PricingCategory);
    }
    if (starred.length === 0) return STARTER_FALLBACK_CATEGORIES.map((category) => draftOf(category, 0));
    const out: StarterDraft[] = [];
    for (let round = 0; out.length < STARTER_OFFER_COUNT && round < STARTER_OFFERS[starred[0]].length; round++) {
        for (const category of starred) {
            if (out.length === STARTER_OFFER_COUNT) break;
            if (round < STARTER_OFFERS[category].length) out.push(draftOf(category, round));
        }
    }
    return out;
}
