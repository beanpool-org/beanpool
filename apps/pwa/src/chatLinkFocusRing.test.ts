// @vitest-environment jsdom
/**
 * A link in the member's own chat bubble keeps a focus ring that can be seen, in light and in dark (Opus review of #2990, finding 2).
 *
 * The bubble is the accent colour, so the page's accent ring on a link there is accent on accent. index.css draws that link's ring
 * white. In dark the page has its own ring (`:root.dark-theme :focus-visible`, a pale sage) at the same specificity, and where the
 * two are the same the LATER rule wins: the white rule was written first, lost, and the ring measured #c0ccc0 on #809380, 2.0:1.
 *
 * This settles the cascade for that one element the way a browser does, from the source of index.css: every rule with a
 * `:focus-visible` selector that matches the link (matched by the DOM, with `:focus-visible` itself stood in for by `*`, since a
 * test has no keyboard), the highest specificity first, a later rule over an earlier one. It stands for the full measure in
 * Chromium (the review's headless run), which needs a browser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandCssVariableMap } from '@beanpool/core/brand-colours';

const css = readFileSync(resolve(__dirname, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; colour: string; order: number }

/** The innermost `selector { declarations }` blocks that colour an outline and are about :focus-visible, in file order. */
function focusRingRules(): Rule[] {
    const rules: Rule[] = [];
    let order = 0;
    for (const block of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        order++;
        const body = block[2];
        const colour = body.match(/outline-color\s*:\s*([^;!]+?)\s*(?:!important)?\s*(?:;|$)/)?.[1]
            ?? body.match(/outline\s*:\s*[^;]*?([#\w(),.-]+)\s*(?:!important)?\s*(?:;|$)/)?.[1];
        if (!colour) continue;
        // A comma inside :is(a, b) does not end a selector.
        for (const selector of block[1].split(/,(?![^(]*\))/).map((s) => s.trim())) {
            if (selector.includes(':focus-visible')) rules.push({ selector, colour, order });
        }
    }
    return rules;
}

/** (ids, classes + attributes + pseudo-classes, elements) of a selector with no :is/:where/:not in it. */
function specificity(selector: string): [number, number, number] {
    if (/:(is|where|not|has)\(/.test(selector)) throw new Error(`this test does not weigh ${selector}`);
    let [ids, classes, elements] = [0, 0, 0];
    // Each kind is counted, then cut out so the next kind does not count its letters again.
    selector
        .replace(/\[[^\]]*\]/g, () => { classes++; return ' '; })
        .replace(/#[\w-]+/g, () => { ids++; return ' '; })
        .replace(/::[\w-]+/g, () => { elements++; return ' '; })
        .replace(/:[\w-]+/g, () => { classes++; return ' '; })
        .replace(/\.[\w-]+/g, () => { classes++; return ' '; })
        .replace(/[a-zA-Z][\w-]*/g, () => { elements++; return ' '; });
    return [ids, classes, elements];
}

const stronger = (a: [number, number, number], b: [number, number, number]) => {
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
};

/** The ring colour the link in the member's own bubble ends up with. */
function ringOf(link: Element): { selector: string; colour: string } {
    const matching = focusRingRules().filter((r) => {
        // `:focus-visible` is only there when a key moved focus: stand in for it with the element that has it.
        const probe = r.selector.replace(/(^|[\s>+~])(:focus-visible)/g, '$1*').replace(/:focus-visible/g, '');
        try { return link.matches(probe); } catch { return false; }
    });
    expect(matching.length, 'a :focus-visible rule that reaches the link').toBeGreaterThan(0);
    let winner = matching[0];
    for (const r of matching) {
        const bySpecificity = stronger(specificity(r.selector), specificity(winner.selector));
        if (bySpecificity > 0 || (bySpecificity === 0 && r.order > winner.order)) winner = r;
    }
    return winner;
}

describe("a link in the member's own chat bubble: its focus ring is white, in light and in dark", () => {
    let link: HTMLAnchorElement;
    beforeEach(() => {
        document.body.innerHTML = '<div class="bp-bubble-mine"><span><a class="bp-chat-link" href="https://byron.beanpool.org">link</a></span></div>';
        link = document.querySelector('a')!;
    });
    afterEach(() => {
        document.documentElement.classList.remove('dark-theme');
        document.body.innerHTML = '';
    });

    it('in light the white ring wins over the page\'s accent one', () => {
        document.documentElement.classList.remove('dark-theme');
        expect(ringOf(link).colour).toBe('#fff');
    });

    it('in dark the white ring still wins over the dark theme\'s pale one (the same weight, written later, used to win)', () => {
        document.documentElement.classList.add('dark-theme');
        const ring = ringOf(link);
        expect(ring.selector).toContain('.bp-chat-link');
        expect(ring.colour).toBe('#fff');
    });

    it('a link anywhere else keeps the page\'s ring: the accent, which is the pale one in dark and the sage one in light', () => {
        document.body.innerHTML = '<div><a class="bp-chat-link" href="https://byron.beanpool.org">link</a></div>';
        link = document.querySelector('a')!;
        document.documentElement.classList.add('dark-theme');
        expect(ringOf(link).colour).toBe('var(--bp-accent-fill)');
        expect(brandCssVariableMap('dark')['--bp-accent-fill']).toBe('#c0ccc0');
        document.documentElement.classList.remove('dark-theme');
        expect(ringOf(link).colour).toBe('var(--bp-accent-fill)');
        expect(brandCssVariableMap('light')['--bp-accent-fill']).toBe('#647664');
    });
});
