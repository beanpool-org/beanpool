/**
 * Every web slot that holds a list photo is its photo's containing block (review of #2853, finding 2). While a photo
 * loads, ListPhoto's <img> is out of the layout and covers its containing block (lib/use-list-photo-steps.ts
 * HIDDEN_UNTIL_DRAWN); with a slot that is not positioned, that block was some ancestor: on Home's wide tiles the whole
 * card, and `main` scrolled sideways (1215 px for 800) until the photos drew. jsdom has no layout, so this reads the
 * source: the element each `<ListPhoto` sits straight in must be `relative` (a class, or `position: 'relative'`).
 * A slot drawn from the Market's style box (`className={LIST_PHOTO}`, components/market-card-shell.ts) is read as the
 * box's own class string, from the module, so the box's slot is held to the same rule.
 * e2e/list-photo-slot-check.mjs measures the same in Chromium.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as box from './market-card-shell';

const SRC = path.resolve(__dirname, '..');

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) return sources(full);
        return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [full] : [];
    });
}

/** The opening tag `<ListPhoto` sits straight in, or null when something other than a tag comes before it. */
function slotOf(text: string, at: number): string | null {
    const before = text.slice(0, at).replace(/\s+$/, '');
    if (!before.endsWith('>')) return null;
    const tags = [...before.slice(-8000).matchAll(/<([a-z][a-z0-9]*)[\s>]/g)];
    const last = tags[tags.length - 1];
    if (!last) return null;
    return before.slice(-8000).slice(last.index);
}

/** `className={NAME}` for one of the style box's class strings, written out as that string; anything else as it is. */
function resolved(slot: string): string {
    return slot.replace(/className=\{([A-Z_]+)\}/g, (whole, name: string) => {
        const value = (box as Record<string, unknown>)[name];
        return typeof value === 'string' ? `className="${value}"` : whole;
    });
}

const uses = sources(SRC).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return [...text.matchAll(/<ListPhoto\b/g)].map((m) => ({
        where: `${path.relative(SRC, file)}:${text.slice(0, m.index).split('\n').length}`,
        slot: slotOf(text, m.index!),
    }));
});

describe("every list photo's slot is its containing block", () => {
    it('finds the callers', () => {
        // Home (2), the deals list (4), the visitor card, the map's stacked list, a shop, a profile, a chat, the map's preview (2).
        expect(uses.length).toBeGreaterThanOrEqual(13);
    });

    it.each(uses.map((u) => [u.where, u.slot] as const))('%s sits straight in a relative slot', (_where, slot) => {
        expect(slot).not.toBeNull();
        expect(resolved(slot!)).toMatch(/className=[{"`][^>]*\brelative\b|position:\s*'relative'/);
    });

    it('the check sees a slot that is not positioned', () => {
        const bad = '<div className="w-full h-24 overflow-hidden">\n    <ListPhoto photo={p} fallback={null} />';
        expect(slotOf(bad, bad.indexOf('<ListPhoto'))).not.toMatch(/\brelative\b/);
        const none = '<button className="relative">\n    <span>photo</span>\n    {x}\n    <ListPhoto photo={p} fallback={null} />';
        expect(slotOf(none, none.indexOf('<ListPhoto'))).toBeNull();
        // A style-box slot is read as the box's string: LIST_PHOTO is positioned, LIST_TEXT is not, an unknown name stays.
        const boxSlot = (name: string) => `<span className={${name}}>\n    <ListPhoto photo={p} fallback={null} />`;
        const read = (name: string) => resolved(slotOf(boxSlot(name), boxSlot(name).indexOf('<ListPhoto'))!);
        expect(read('LIST_PHOTO')).toMatch(/\brelative\b/);
        expect(read('LIST_TEXT')).not.toMatch(/\brelative\b/);
        expect(read('NOT_IN_THE_BOX')).toBe('<span className={NOT_IN_THE_BOX}>');
    });
});
