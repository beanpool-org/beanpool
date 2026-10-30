#!/usr/bin/env node
// from-synonyms.mjs — builds packages/beanpool-core/src/tags/library.ts, the one controlled tag library, from the hand-written
// synonym map it replaces (frozen in packages/beanpool-core/src/__tests__/fixtures/synonym-map-before-tags.json), the pricing
// catalog's kinds of things and the grow-food crop list (DESIGN-owner-seeding-tags-fable.md §4.1, §4.6, slice T1).
//
//   node scripts/tags/from-synonyms.mjs          writes library.ts; refuses when a synonym key would search differently
//
// A one-off: once the library is written, it is the source and a change to it is a PR (§4.3). It stays so the build of the
// library can be read and re-run while T2 and T3 move the node and the apps onto the library.
//
// The tree below is hand-curated: the 17 tops are the Market's categories; each group lists the synonym keys placed in it
// (`a=b` puts the two keys on one tag, labelled by the first) and the new tags it gains (`+Label`). Every tag gets:
//   words    the words for it AND everything under it (a group's "fruit"); kept only where every key under it had them,
//            so no key searches for more than it did;
//   aliases  more words for it alone (lemon's "citrus", "tree");
//   synonymKeys  the synonym map's keys that land on it, written as they were (scripts/tags/to-synonyms.mjs makes the map
//            again from these: each key's words = its ancestors' words, its own words and its aliases, less the key itself).
// The script checks every key against the old map before it writes, and splits an `a=b` pair that would not search the same.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OLD = JSON.parse(fs.readFileSync(path.join(ROOT, 'packages/beanpool-core/src/__tests__/fixtures/synonym-map-before-tags.json'), 'utf8'));
const OUT = path.join(ROOT, 'packages/beanpool-core/src/tags/library.ts');

// [top id, the category's word() label as pricing-catalog.ts has it, candidate words for the whole top, groups]
// group: [slug, label, candidate words, keys and new tags (space-separated; a multi-word key in quotes)]
const TREE = [
    ['food', 'Food & Produce', ['food', 'produce'], [
        ['fruit', 'Fruit', ['fruit', 'produce'], 'lemon lime orange mandarin grapefruit banana apple pear mango avocado passionfruit fig guava papaya pawpaw watermelon rockmelon strawberry blueberry raspberry mulberry grape persimmon pomegranate jackfruit dragonfruit coconut plum peach nectarine apricot cherry +Melon'],
        ['vegetables', 'Vegetables', ['vegetable', 'produce'], 'tomato carrot potato "sweet potato" pumpkin zucchini cucumber lettuce spinach kale silverbeet chard broccoli cauliflower cabbage beetroot onion garlic chilli capsicum corn beans peas eggplant asparagus celery leek radish turnip parsnip "spring onion" ginger turmeric mushroom +Cassava +Taro +Yams +Okra +Bitter gourd +Bok choy +Water spinach +Jute mallow +Amaranth +Cowpeas +Pigeon peas +Broad beans +Squash +Salad greens +Veggie box'],
        ['eggs', 'Eggs', [], 'egg'],
        ['honey', 'Honey', [], 'honey'],
        ['dairy', 'Milk and dairy', ['dairy', 'farm'], 'milk cheese butter yoghurt cream'],
        ['bakery', 'Bread and baking', ['baking'], 'bread sourdough flour +Cakes +Pies +Muffins +Cookies +Pizza'],
        ['grains', 'Grains and pantry', ['grain'], 'pasta rice oats granola +Sorghum +Millet +Soybeans'],
        ['preserves', 'Preserves and ferments', [], 'jam chutney pickles sauerkraut kimchi sauce'],
        ['drinks', 'Drinks', ['drink'], 'kombucha kefir juice tea coffee'],
        ['nuts-oils', 'Nuts and oils', [], 'nuts macadamia almond walnut pecan olive "olive oil" "coconut oil" +Peanuts'],
        ['herbs', 'Herbs and spices', ['herb'], 'herb spice basil rosemary thyme mint parsley coriander oregano lemongrass'],
        ['meat', 'Meat', ['meat', 'protein'], 'meat beef lamb pork sausage'],
        ['seafood', 'Fish and seafood', ['seafood', 'protein'], 'fish prawns crab oyster'],
        ['meals', 'Meals and snacks', [], 'catering +Cooked meals +Soup +Dumplings'],
    ]],
    ['garden', 'Plants & Garden', ['garden'], [
        ['seedlings', 'Seedlings and seeds', ['growing'], 'seedlings=seedling seeds cuttings bulbs'],
        ['plants', 'Plants', ['plant'], 'flower rose orchid fern succulent cactus palm bamboo native +Sunflowers'],
        ['trees', 'Trees', ['tree'], '"fruit tree" +Grafted trees'],
        ['soil', 'Soil and compost', ['soil'], 'compost manure mulch "potting mix" "worm farm" worms topsoil +Compost tea +Mushroom compost'],
        ['beds', 'Beds and growing', ['growing'], '"vegetable garden" "raised bed" "garden bed" greenhouse trellis'],
        ['landscape', 'Lawn and landscape', [], 'lawn turf gravel sand pavers'],
        ['irrigation', 'Irrigation', [], 'irrigation'],
    ]],
    ['labour', 'Labour & Help', [], [
        ['garden-help', 'Garden help', ['garden'], 'mowing landscaping pruning weeding mulching spraying'],
        ['help', 'Odd jobs and help', [], 'handyman +Firewood splitting +Heavy lifting +Gutter cleaning'],
        ['cleaning', 'Cleaning and laundry', ['domestic'], 'cleaning=cleaner ironing laundry +Window cleaning +Carpet cleaning'],
        ['land', 'Land work', [], '"tree removal" arborist bobcat excavation demolition +Post hole digging'],
    ]],
    ['services', 'Services & Trade', [], [
        ['trades', 'Trades', ['trades'], 'plumbing=plumber electrical=electrician carpentry=carpenter painting=painter tiling roofing welding fencing concreting plastering bricklaying locksmith glazier +Fabrication'],
        ['repairs', 'Repairs and sharpening', [], '+Knife sharpening +Tool sharpening'],
        ['sewing', 'Sewing and alterations', [], 'sewing tailor +Clothes mending'],
        ['vehicles', 'Vehicle services', ['vehicle'], 'mechanic "car service" "smash repair" detailing'],
        ['business', 'Business and office', [], 'bookkeeping tax printing translation'],
    ]],
    ['tools', 'Tools & Hardware', ['tool'], [
        ['hand', 'Hand tools', ['hand tool'], 'hammer screwdriver pliers spanner shovel rake hoe +Mechanic tool set'],
        ['power', 'Power tools', ['power tool'], 'drill saw chainsaw sander grinder welder +Circular saw'],
        ['garden', 'Garden tools', ['garden'], 'mower "whipper snipper" "hedge trimmer" blower wheelbarrow secateurs loppers'],
        ['machines', 'Machines', ['machine'], '"pressure washer" compressor +Cement mixer +Post hole digger +Carpet cleaner'],
        ['ladders', 'Ladders', [], 'ladder'],
    ]],
    ['goods', 'Goods & Materials', [], [
        ['furniture', 'Furniture', ['furniture'], 'furniture table chair desk bookshelf wardrobe couch=sofa bed'],
        ['bedding', 'Bedding and linen', [], 'mattress blanket towel'],
        ['home', 'Home and decor', ['home', 'decor'], 'lamp rug curtains +Baskets'],
        ['kitchen', 'Kitchenware', ['kitchen'], 'pots pan crockery +Jars +Mugs'],
        ['clothing', 'Clothing and shoes', ['clothing'], 'clothes shoes boots jacket'],
        ['books-toys', 'Books and toys', [], 'books toys'],
        ['outdoor', 'Sport and outdoor', [], 'surfboard kayak camping tent backpack fishing'],
        ['materials', 'Building materials', ['building'], 'timber +Building supplies'],
    ]],
    ['housing', 'Housing & Space', [], [
        ['homes', 'Rooms and homes', ['housing'], 'room rental "share house" "granny flat" cabin cottage +Guest room'],
        ['stays', 'Camping and caravans', [], 'caravan campsite'],
        ['space', 'Space and storage', [], 'storage shed garage studio office +Workshop bench'],
    ]],
    ['transport', 'Transport & Rides', ['transport'], [
        ['rides', 'Rides', ['ride'], 'ride=lift carpool +Airport ride'],
        ['delivery', 'Delivery and moving', [], 'delivery courier moving removalist towing freight'],
        ['bikes', 'Bikes', ['cycling'], 'bike=bicycle +Cargo bike +Bike servicing'],
        ['vehicles', 'Trailers and floats', [], 'trailer +Horse float'],
    ]],
    ['education', 'Education & Lessons', ['education'], [
        ['lessons', 'Lessons and tutoring', [], 'tutoring=tutor lessons math science reading writing language'],
        ['courses', 'Courses and workshops', ['class'], 'workshop course +Permaculture design +Sewing classes'],
        ['mentoring', 'Mentoring and coaching', [], 'mentoring coaching'],
    ]],
    ['arts', 'Arts & Crafts', [], [
        ['art', 'Art and design', ['art'], '"painting art" drawing illustration photography videography "graphic design"'],
        ['crafts', 'Crafts', ['craft'], 'pottery ceramics woodwork weaving knitting crochet jewellery candle soap'],
        ['music', 'Music', ['music'], 'music guitar piano drums ukulele singing band DJ'],
    ]],
    ['health', 'Health & Wellness', [], [
        ['bodywork', 'Massage and bodywork', ['therapy'], 'massage acupuncture chiropractic physiotherapy reiki'],
        ['natural', 'Natural health', ['natural'], 'naturopath herbalist "essential oils" "herbal tea" nutrition +Herbal remedies'],
        ['fitness', 'Fitness and movement', ['exercise'], 'yoga pilates fitness "personal training" swimming "martial arts"'],
        ['mind', 'Mind and wellbeing', [], 'meditation counselling'],
        ['first-aid', 'First aid', ['safety'], '"first aid"'],
    ]],
    ['care', 'Care & Family', ['care'], [
        ['children', 'Children', ['kids', 'children'], 'babysitting childcare=nanny +Prams +Baby gear +Baby clothes'],
        ['support', 'Elders and disability', ['support'], '"aged care" "disability support" companionship respite'],
        ['home', 'Home help', [], '"home help" "meal prep" "house sitting"'],
    ]],
    ['animals', 'Animals & Pets', [], [
        ['pets', 'Pets', ['pet'], 'dog=puppy cat=kitten rabbit "guinea pig" bird "fish tank"'],
        ['poultry', 'Poultry', ['poultry'], 'chicken duck +Laying hens'],
        ['livestock', 'Livestock', ['livestock'], 'goat sheep cow horse'],
        ['bees', 'Bees', ['bees'], 'beehive +Bee colonies'],
        ['feed', 'Feed and grazing', ['feed'], 'hay feed +Grazing'],
        ['care', 'Animal care', [], 'vet farrier grooming "pet sitting" "dog walking"'],
    ]],
    ['tech', 'Tech & Digital', ['tech'], [
        ['devices', 'Devices', ['device'], 'computer laptop phone tablet printer'],
        ['internet', 'Internet', ['internet'], 'wifi internet +Mesh network'],
        ['repair', 'Tech repair', ['repair'], '"IT support" "data recovery" "phone repair" "computer repair" +Screen replacement'],
        ['digital', 'Digital and web', ['digital'], 'website "web design" programming "3D printing"'],
    ]],
    ['energy', 'Energy & Firewood', ['energy'], [
        ['firewood', 'Firewood and fuel', ['fuel'], 'firewood biochar +Kindling'],
        ['solar', 'Solar', ['solar'], 'solar "solar panel" inverter battery +Off-grid power'],
        ['power', 'Power and heat', ['power'], 'generator "EV charging" LED "hot water" insulation'],
    ]],
    ['mindset', 'Mindset & Wisdom', [], [
        ['ideas', 'Ideas and wisdom', [], '+Philosophy +Essays +Mutual aid +Community mindset'],
    ]],
    ['general', 'General & Community', ['general'], [
        ['events', 'Events', ['event'], 'event party "market stall" +Market day'],
        ['hire', 'Event hire', ['hire'], '+Marquee +Sound hire +Trestle tables +Projector +Venue space'],
        ['sharing', 'Sharing', [], 'barter=swap free donation volunteer'],
    ]],
];

// A synonym key's label where its word alone would mislead or read badly as a tag.
const LABELS = {
    beans: 'Green beans', egg: 'Eggs', nuts: 'Nuts', math: 'Maths', native: 'Native plants', phone: 'Phones', bird: 'Pet birds',
    palm: 'Palms', feed: 'Animal feed', free: 'Free', 'painting art': 'Painting (art)', seedlings: 'Seedlings', cleaner: 'Cleaners', painter: 'Painters', tutor: 'Tutors', worms: 'Worms',
    peas: 'Peas', ride: 'Rides', bike: 'Bikes', dog: 'Dogs', cat: 'Cats', herb: 'Herbs', spice: 'Spices', meat: 'Meat', pots: 'Pots and pans',
    pan: 'Frying pans', toys: 'Toys', books: 'Books', clothes: 'Clothes', shoes: 'Shoes', boots: 'Boots', LED: 'LED lights', DJ: 'DJ',
    'IT support': 'IT support', 'EV charging': 'EV charging', '3D printing': '3D printing', 'fish tank': 'Fish tanks', tax: 'Tax help',
    printing: 'Printing', reading: 'Reading', writing: 'Writing', language: 'Languages', lessons: 'Lessons', event: 'Events',
    party: 'Parties', room: 'Rooms', rental: 'Rentals', office: 'Office space', studio: 'Studio space', storage: 'Storage', computer: 'Computers',
    laptop: 'Laptops', tablet: 'Tablets', printer: 'Printers', battery: 'Batteries', candle: 'Candles', sausage: 'Sausages',
    prawns: 'Prawns', oyster: 'Oysters', crab: 'Crabs', pickles: 'Pickles', sauce: 'Sauces', bulbs: 'Bulbs', cuttings: 'Cuttings',
    seeds: 'Seeds', flower: 'Flowers', rose: 'Roses', orchid: 'Orchids', fern: 'Ferns', succulent: 'Succulents', cactus: 'Cactus',
    'fruit tree': 'Fruit trees', 'raised bed': 'Raised beds', 'garden bed': 'Garden beds', 'solar panel': 'Solar panels',
    'guinea pig': 'Guinea pigs', chicken: 'Chickens', duck: 'Ducks', goat: 'Goats', sheep: 'Sheep', cow: 'Cows', horse: 'Horses',
    rabbit: 'Rabbits', table: 'Tables', chair: 'Chairs', desk: 'Desks', bed: 'Beds', lamp: 'Lamps', rug: 'Rugs', towel: 'Towels',
    blanket: 'Blankets', jacket: 'Jackets', tent: 'Tents', backpack: 'Backpacks', kayak: 'Kayaks', surfboard: 'Surfboards',
    trailer: 'Trailers', ladder: 'Ladders', mower: 'Mowers', drill: 'Drills', saw: 'Saws', hammer: 'Hammers', shovel: 'Shovels',
    rake: 'Rakes', hoe: 'Hoes', welder: 'Welders', generator: 'Generators', compressor: 'Compressors', grinder: 'Grinders',
    sander: 'Sanders', spanner: 'Spanners', pliers: 'Pliers', screwdriver: 'Screwdrivers', blower: 'Leaf blowers', loppers: 'Loppers',
    secateurs: 'Secateurs', wheelbarrow: 'Wheelbarrows', 'hedge trimmer': 'Hedge trimmers', 'pressure washer': 'Pressure washers',
    'whipper snipper': 'Line trimmers', inverter: 'Inverters', mattress: 'Mattresses', bookshelf: 'Bookshelves', wardrobe: 'Wardrobes',
    couch: 'Couches', crockery: 'Crockery', curtains: 'Curtains', sofa: 'Sofas', vet: 'Vet care',
};

const words = (s) => s.match(/"[^"]+"|\S+/g) ?? [];
const unq = (s) => s.replace(/^"|"$/g, '');
const slug = (s) => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const setOf = (k) => new Set(OLD[k] ?? []);

/** A group's spec: its keys (`a=b` one tag) first, then its new tags, each "+Label" (a label may hold spaces). */
function parseSpec(spec) {
    const at = spec.search(/(^|\s)\+/);
    const keysPart = at < 0 ? spec : spec.slice(0, at);
    const newPart = at < 0 ? '' : spec.slice(at);
    return {
        keyGroups: words(keysPart).map((w) => unq(w).split('=')),
        newLabels: newPart.split(/(?:^|\s)\+/).map((l) => l.trim()).filter(Boolean),
    };
}

/** Words common to every key in a list (a key never lists itself, so it counts as having its own word), within `candidates`. */
function common(keys, candidates) {
    return candidates.filter((w) => keys.every((k) => setOf(k).has(w) || k === w));
}

const tags = [];
const placed = new Map(); // key → tag id
const problems = [];
const splitPairs = [];

for (const [top, topLabel, topCandidates, groups] of TREE) {
    const specs = groups.map(([, , , spec]) => parseSpec(spec));
    const topWords = common(specs.flatMap((p) => p.keyGroups.flat()), topCandidates);
    tags.push({ id: top, label: topLabel, category: true, words: topWords });
    groups.forEach(([gslug, glabel, gCandidates], gi) => {
        const { keyGroups, newLabels } = specs[gi];
        const gid = `${top}.${gslug}`;
        const gKeys = keyGroups.flat();
        const gWords = common(gKeys, gCandidates).filter((w) => !topWords.includes(w));
        const carry = [...topWords, ...gWords];
        const group = { id: gid, label: glabel, words: gWords };
        tags.push(group);
        const made = new Set();
        /** Put keys on a tag when each of them, made again from the tag, has exactly the words it had. */
        const place = (keys, at) => {
            const all = new Set(keys.flatMap((k) => [...setOf(k)]));
            const aliases = [...all].filter((w) => !carry.includes(w));
            for (const k of keys) {
                const generated = new Set([...carry, ...aliases].filter((w) => w !== k));
                const old = setOf(k);
                if (generated.size !== old.size || ![...old].every((w) => generated.has(w))) return false;
            }
            at.aliases = aliases;
            at.synonymKeys = keys;
            for (const k of keys) placed.set(k, at.id);
            return true;
        };
        // A group with one key and no new tags is a tag at the second level (food.eggs, food.honey).
        if (keyGroups.length === 1 && gKeys.length === 1 && newLabels.length === 0) {
            if (!place(gKeys, group)) problems.push(`${gid}: ${gKeys[0]} cannot be a second-level tag`);
            return;
        }
        const tryPlace = (ks) => {
            const label = LABELS[ks[0]] || cap(ks[0]);
            let id = `${gid}.${slug(label)}`;
            if (made.has(id)) id = `${gid}.${slug(ks[0])}`;
            const t = { id, label };
            if (!place(ks, t)) return null;
            made.add(id);
            return t;
        };
        for (const keys of keyGroups) {
            if (keys.some((k) => placed.has(k))) { problems.push(`${keys.join('=')} placed twice`); continue; }
            const both = tryPlace(keys);
            if (both) { tags.push(both); continue; }
            if (keys.length > 1) splitPairs.push(keys.join('='));
            for (const k of keys) {
                const one = tryPlace([k]);
                if (one) tags.push(one);
                else problems.push(`${gid}: "${k}" lacks a word its group gives (${carry.filter((w) => !setOf(k).has(w) && w !== k).join(', ')})`);
            }
        }
        for (const label of newLabels) {
            const id = `${gid}.${slug(label)}`;
            if (made.has(id)) { problems.push(`${id} twice`); continue; }
            made.add(id);
            tags.push({ id, label });
        }
    });
}
const fixed = tags;

const missing = Object.keys(OLD).filter((k) => !placed.has(k));
if (missing.length) problems.push(`keys not placed: ${missing.join(', ')}`);
const ids = fixed.map((t) => t.id);
const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
if (dup.length) problems.push(`duplicate ids: ${dup.join(', ')}`);
for (const id of ids) if (!/^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*){0,2}$/.test(id)) problems.push(`bad id ${id}`);

if (splitPairs.length) console.log(`split (would not search the same as one tag): ${splitPairs.join(', ')}`);
if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
}

const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const arr = (a) => `[${a.map(q).join(', ')}]`;
const line = (t) => {
    const f = [`id: ${q(t.id)}`, `en: word(${q(t.label)}${t.category ? '' : ", 'tag'"})`];
    if (t.words?.length) f.push(`words: ${arr(t.words)}`);
    if (t.aliases?.length) f.push(`aliases: ${arr(t.aliases)}`);
    if (t.synonymKeys?.length) f.push(`synonymKeys: ${arr(t.synonymKeys)}`);
    return `    { ${f.join(', ')} },`;
};

const out = `/**
 * The tag library: one controlled list of the kinds of things a listing can be, the same on every node, both apps and the
 * assistant (DESIGN-owner-seeding-tags-fable.md §4). GENERATED once by scripts/tags/from-synonyms.mjs from the synonym map
 * it replaces; from now on this file is the source, and a change to it is a reviewed PR (§4.3). After a change, run
 * \`node scripts/tags/to-synonyms.mjs\`: synonyms.ts is made from this file.
 *
 * - \`id\`: language-neutral, lowercase ASCII, \`top.group.item\` (at most three levels). The tops are the Market's 17
 *   categories (pricing-catalog.ts), so a tag's root is its category. An id never changes meaning.
 * - \`en\`: the label, a word() key (context \`tag\`; a top reuses its category's label), so it is translated with the words.
 * - \`words\`: English words for the tag and everything under it ("fruit" for every fruit).
 * - \`aliases\`: more English words for this tag alone (lemon: "citrus", "tree"). Cross-cutting words are aliases, not levels.
 * - \`synonymKeys\`: the synonym map's keys that land on this tag, as they were written. to-synonyms.mjs makes the map from
 *   them, so search finds what it found before the library; they go with synonyms.ts (§4.6).
 */
import { word, type WordKey } from '../words.js';

export interface TagDef {
    readonly id: string;
    readonly en: WordKey;
    readonly words?: readonly string[];
    readonly aliases?: readonly string[];
    readonly synonymKeys?: readonly string[];
}

export const TAG_LIBRARY: readonly TagDef[] = Object.freeze([
${fixed.map(line).join('\n')}
]);
`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);
const depth = (n) => fixed.filter((t) => t.id.split('.').length === n).length;
console.log(`wrote ${path.relative(ROOT, OUT)}: ${fixed.length} tags (${depth(1)} tops, ${depth(2)} groups and second-level tags, ${depth(3)} items); ${placed.size} synonym keys placed`);
