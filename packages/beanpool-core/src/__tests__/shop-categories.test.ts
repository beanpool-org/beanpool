/**
 * A shop picks one of the Market's categories (Marty, 25 Oct 2026: "Seems like it should have used the categories already
 * present?"): one list for shops and listings, and the one table in core of what became of the fourteen shop kinds
 * (shops.ts SHOP_CATEGORY_KINDS): each old kind moved into exactly one category, and every category shows the tools of the
 * kind nearest it, so no shop lost a tool and Tech shows what Repairs did.
 */
import { describe, expect, it } from 'vitest';
import type { HomeNodeFacts } from '../home-frame.js';
import { PRICING_CATEGORIES } from '../pricing-catalog.js';
import { SHOP_CATEGORIES, SHOP_CATEGORY_KINDS, isShopCategory, shopCategoryOfKind } from '../shops.js';
import { TOOLS, TOOL_SHELVES, toolsMore, toolsOnShelf } from '../tools/index.js';

/** The fourteen kinds a shop could have before categories (tools/manifest.ts SHOP_KINDS at 41485b7a). */
const KINDS_BEFORE = ['tools', 'food', 'baking', 'repairs', 'crafts', 'lessons', 'care', 'rides', 'rooms', 'buying', 'seeds', 'energy', 'animals', 'labour'];
/** Each tool's shop kinds before categories (its manifest's shopKinds at 41485b7a). */
const TOOL_KINDS_BEFORE: Record<string, readonly string[] | 'all'> = { things: ['tools', 'seeds', 'rooms'] };

const local: HomeNodeFacts = { profile: 'local', features: { beans: true } };

describe('the categories a shop picks from', () => {
    it("are the Market's seventeen, in its order, by the ids its listings keep", () => {
        expect(SHOP_CATEGORIES).toEqual(PRICING_CATEGORIES.map((c) => c.id));
        expect(SHOP_CATEGORIES).toHaveLength(17);
        expect(SHOP_CATEGORIES).toContain('tech');
    });

    it('isShopCategory: one of them exactly, never an old kind that is no category, a capital, a legacy alias or a non-string', () => {
        for (const c of SHOP_CATEGORIES) expect(isShopCategory(c), c).toBe(true);
        for (const v of ['baking', 'repairs', 'Tech', ' tech', 'tech_digital', '', null, undefined, 7, {}]) expect(isShopCategory(v), String(v)).toBe(false);
    });
});

describe('the one table (SHOP_CATEGORY_KINDS)', () => {
    it('names every category, and nothing else', () => {
        expect(Object.keys(SHOP_CATEGORY_KINDS).sort()).toEqual([...SHOP_CATEGORIES].sort());
    });

    it('every old kind moved into exactly one category', () => {
        const moved = Object.values(SHOP_CATEGORY_KINDS).flatMap((row) => row.kinds as readonly string[]);
        expect([...moved].sort()).toEqual([...KINDS_BEFORE].sort());
        expect(new Set(moved).size).toBe(moved.length);
    });

    it('shopCategoryOfKind: each old kind to its category (as a stored shop and an old app\'s save are read); anything else to none', () => {
        expect(Object.fromEntries(KINDS_BEFORE.map((k) => [k, shopCategoryOfKind(k)]))).toEqual({
            tools: 'tools', food: 'food', baking: 'food', repairs: 'services', crafts: 'arts', lessons: 'education', care: 'care',
            rides: 'transport', rooms: 'housing', buying: 'goods', seeds: 'garden', energy: 'energy', animals: 'animals', labour: 'labour',
        });
        for (const v of ['weapons', 'tech', 'Tools', '', null, undefined, 3]) expect(shopCategoryOfKind(v), String(v)).toBeNull();
    });

    it("each category's tools are its nearest old kind's: its own kind's where one moved into it; Tech as Repairs, Health as Care, Mindset as Lessons, General as Tools", () => {
        for (const [category, row] of Object.entries(SHOP_CATEGORY_KINDS)) {
            expect(KINDS_BEFORE, category).toContain(row.toolsLike);
            if (row.kinds.length > 0) expect(row.kinds as readonly string[], category).toContain(row.toolsLike);
        }
        expect(SHOP_CATEGORY_KINDS.tech.toolsLike).toBe('repairs');
        expect(SHOP_CATEGORY_KINDS.services.toolsLike).toBe('repairs');
        expect(SHOP_CATEGORY_KINDS.health.toolsLike).toBe('care');
        expect(SHOP_CATEGORY_KINDS.mindset.toolsLike).toBe('lessons');
        expect(SHOP_CATEGORY_KINDS.general.toolsLike).toBe('tools');
    });
});

describe('every category has its tools', () => {
    it("a tool is on a category's shelf exactly when it was on the shelf of the category's nearest old kind", () => {
        for (const tool of TOOLS) {
            const before = TOOL_KINDS_BEFORE[tool.id];
            if (!before) continue;
            for (const category of SHOP_CATEGORIES) {
                const was = before === 'all' || before.includes(SHOP_CATEGORY_KINDS[category].toolsLike);
                const onShelf = toolsOnShelf(tool.shelf, category, 'member', local).some((t) => t.id === tool.id);
                expect(onShelf, `${tool.id} for ${category}`).toBe(was);
            }
        }
    });

    it('the Tool shed is on the shelves of Tools, Garden, Housing and General, and under More tools for the rest, Tech among them', () => {
        const shedOn = SHOP_CATEGORIES.filter((c) => toolsOnShelf('stock', c, 'member', local).some((t) => t.id === 'things'));
        expect(shedOn).toEqual(['tools', 'garden', 'housing', 'general']);
        expect(toolsMore('tech', 'member', local).map((t) => t.id)).toContain('things');
    });

    it('for every category, a reader has every tool this node can have: on a shelf, or under More tools, never lost', () => {
        for (const reader of ['member', 'enterprise'] as const) {
            const every = TOOL_SHELVES.flatMap((shelf) => toolsOnShelf(shelf, null, reader, local)).map((t) => t.id).sort();
            for (const category of SHOP_CATEGORIES) {
                const shown = [...TOOL_SHELVES.flatMap((shelf) => toolsOnShelf(shelf, category, reader, local)), ...toolsMore(category, reader, local)];
                expect(shown.map((t) => t.id).sort(), `${reader} ${category}`).toEqual(every);
            }
        }
    });
});
