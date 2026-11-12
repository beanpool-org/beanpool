/**
 * The seller's fields for a price for each one on the phone (DESIGN-per-item-price-fable.md §2.4, §2.5, slice P4): the create form
 * (app/new-listing.tsx) and the edit form (app/post/[id].tsx). The rules, the live line and the bodies are core's per-item-form
 * (tested in packages/beanpool-core), so this file checks what the phone adds: that it hears the node's `perItem` answer, and that
 * the two screens use core's rules rather than their own. The screens themselves can't be drawn here (vitest.config.ts: logic, not
 * screens), so the source blocks read them and say what they cannot show; the screens were opened on the emulator (see the PR).
 */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Device modules, stubbed at the boundary (vitest.config.ts): the signer's random bytes and the phone's storage.
vi.mock('expo-crypto', () => ({ getRandomBytes: vi.fn((len: number) => new Uint8Array(len)) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
    default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}), removeItem: vi.fn(async () => {}) },
}));
import { readNodeProfile } from '../node-profile';
import { perItemOffered, priceUnitsOffered } from '@beanpool/core';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf-8');

describe('the node says it takes up an Offer priced for each one', () => {
    it('the phone hears `perItem: true`, and Each is then offered right after Total (red if the key is not in the phone\'s FEATURE_KEYS)', () => {
        const on = readNodeProfile({ profile: 'local', features: { beans: true, escrow: true, perItem: true } })!;
        expect(on.features.perItem).toBe(true);
        expect(perItemOffered(on.features)).toBe(true);
        expect(priceUnitsOffered(on.features, 'offer')).toEqual(['fixed', 'each', 'hourly', 'daily', 'weekly', 'monthly']);
    });

    it('a node that says nothing, or false, or a string, offers no Each (red if Each shows before every slice is merged)', () => {
        for (const features of [{ beans: true }, { beans: true, perItem: false }, { beans: true, perItem: 'true' }]) {
            const p = readNodeProfile({ profile: 'local', features })!;
            expect(perItemOffered(p.features)).toBe(false);
            expect(priceUnitsOffered(p.features, 'offer')).not.toContain('each');
        }
        expect(priceUnitsOffered(readNodeProfile({})!.features, 'offer')).not.toContain('each');
    });
});

describe('the create form (app/new-listing.tsx) reads core\'s rules', () => {
    const src = read('../../app/new-listing.tsx');

    it('the unit button cycles core\'s list, which has Each only on an Offer on a node that says so (red if the screen keeps its own five)', () => {
        expect(src).toContain('priceUnitsOffered(nodeFeatures, postType)');
        expect(src).not.toMatch(/const types = \['fixed', 'hourly', 'daily', 'weekly', 'monthly'\]/);
    });

    it('Total -> Each carries the figure into the price for all and focuses the price for one (red if the carry-over is dropped)', () => {
        expect(src).toContain('carryTotalToEach(');
        expect(src).toContain('priceInputRef.current?.focus()');
        expect(src).toMatch(/if \(postPriceType === 'fixed'\)/);
    });

    it('the extra fields and the refusal come from core, and a refused count or price for all stops the post with its sentence (red if the screen sends without asking)', () => {
        expect(src).toContain('perItemCreateFields(');
        expect(src).toContain('<PerItemFields');
        expect(src).toMatch(/if \(item && !item\.ok\) errors\.add/);
        expect(src).toContain('item.refusal.text');
    });

    it('the body carries the unit, the count and the price for all of them (and no Repeatable) only for Each (red if they leak to other units)', () => {
        // The unit in force (`postPriceType`) is the picked one only where core's list has it, so 'each' never goes for a Need.
        expect(src).toContain('const postPriceType: string = (priceUnits as readonly string[]).includes(pickedPriceType) ? pickedPriceType');
        expect(src).toContain('price_type: postFormPriceType(postPriceType, nodeFeatures),');
        expect(src).toMatch(/\.\.\.\(item && item\.ok \? \{ unitsLeft: item\.fields\.unitsLeft/);
        expect(src).toContain('repeatable: postRepeatable && !eachChosen ? 1 : 0');
    });

    it('Repeatable is not drawn on Each, and a draft keeps the count and the price for all (red if either is lost)', () => {
        expect(src).toMatch(/\{!eachChosen && \(\s*<Pressable[^>]*accessibilityState=\{\{ selected: postRepeatable \}\}/);
        expect(src).toContain('postItemCount, postItemLot, postRepeatable');
        expect(src).toContain('setPostItemCount(typeof d.postItemCount');
    });

    it('PRICE FOR ONE labels the price box on Each, and the fee line is the Each one (red if the old fee sentence stays)', () => {
        expect(src).toContain('eachChosen ? perItemLines.priceForOne() : t(\'Price\')');
        expect(src).toContain('perItemFeeLine(');
    });
});

describe('the edit form (app/post/[id].tsx) reads core\'s rules and the node\'s count', () => {
    const src = read('../../app/post/[id].tsx');

    it('opens a listing priced each on the count the NODE holds, not the phone\'s copy, and closes if it can\'t be read (red if the form opens on a count it never saw)', () => {
        expect(src).toContain('getListingItems(post.id)');
        expect(src).toContain('setEditItemLoading(post.price_type === \'each\')');
        expect(src).toMatch(/editItemLoading \|\| !editTitle\.trim\(\)/);
        expect(src).toContain("t(\"Your community couldn't be reached. Try again.\")");
    });

    it('saves through core: the count read as unitsLeftWas, a refusal stops the save with its sentence (red if the screen builds its own body)', () => {
        expect(src).toContain('perItemEditFields(');
        expect(src).toContain('...(itemSave && itemSave.ok ? itemSave.fields : {})');
        expect(src).toContain("price_type: editEach ? 'each' : editUnit");
        expect(src).toContain('repeatable: editEach ? false : editRepeatable');
    });

    it('a count that changed under the seller is the node\'s sentence, the box shows what is left, and the save stays open (red if it closes as saved)', () => {
        expect(src).toContain("e?.code === 'units_changed' && typeof e.unitsLeft === 'number'");
        expect(src).toContain("perItemRefusalText({ code: 'units_changed', count: e.unitsLeft })");
        expect(src).toContain('setEditItemCount(String(e.unitsLeft))');
    });

    it('the held-for-buyers note and the stored price for another number come from core (red if the note counts money)', () => {
        expect(src).toContain('perItemHeldNote(itemsHeldIn(deals.held.map((m) => m.tx)))');
        expect(src).toContain('perItemLotForOtherLine(');
    });

    it('Total -> Each carries the figure over here too, and Repeatable is not drawn on Each', () => {
        expect(src).toContain('carryTotalToEach(');
        expect(src).toMatch(/\{!editEach && \(\s*<Pressable\s+accessibilityRole="button"\s+accessibilityState=\{\{ selected: editRepeatable \}\}/);
    });
});

describe('the phone\'s calls to the node (utils/db.ts)', () => {
    const src = read('../db.ts');

    it('createPost sends the count and the price for all only for Each (red if they go with other units)', () => {
        expect(src).toMatch(/post\.price_type === 'each' && typeof post\.unitsLeft === 'number' \? \{ unitsLeft: post\.unitsLeft, \.\.\.\(post\.lot \? \{ lot: post\.lot \} : \{\}\) \}/);
    });

    it('updatePost sends the count, the count read, and the price for all only for Each, and `lot` only when named (red if absent turns into null and clears it)', () => {
        const at = src.indexOf("...(updates.price_type === 'each' ? {");
        expect(at).toBeGreaterThan(0);
        const block = src.slice(at, at + 400);
        expect(block).toContain('unitsLeft: updates.unitsLeft');
        expect(block).toContain('updates.unitsLeftWas !== undefined');
        expect(block).toContain('updates.lot !== undefined');
    });

    it('a refusal carries how many are left now (`unitsLeft`) beside its code, for units_changed', () => {
        expect(src).toContain("if (typeof errJson.unitsLeft === 'number') nodeUnitsLeft = errJson.unitsLeft;");
        expect(src).toContain('if (nodeUnitsLeft !== undefined) err.unitsLeft = nodeUnitsLeft;');
    });
});
