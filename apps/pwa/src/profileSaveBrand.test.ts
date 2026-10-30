/**
 * Phone and web the same (Marty, 25 Oct 2026): the phone's Save Profile is the brand fill (`colors.brand.fill`, #2589), so
 * the web's Save Profile Changes is the commit role, the library's name for that same fill (core brand-colours.ts
 * `commit`), with its own words colour. Before this it was charcoal in light and white in dark.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const PAGE = fs.readFileSync(path.resolve(__dirname, 'pages/ProfilePage.tsx'), 'utf8');

/** The class string of the button whose words are "Save Profile Changes". */
function saveButtonClasses(): string {
    const end = PAGE.indexOf("t('Save Profile Changes')");
    expect(end).toBeGreaterThan(-1);
    const start = PAGE.lastIndexOf('<button', end);
    return PAGE.slice(start, end);
}

describe('web Save Profile Changes', () => {
    it('is the brand fill, as on the phone, in light and dark', () => {
        const classes = saveButtonClasses();
        expect(classes).toContain("'bg-bp-commit-fill text-bp-commit-on hover:bg-bp-commit-hover'");
        expect(classes).not.toContain('bg-nature-900');
        expect(classes).not.toContain('dark:bg-white');
    });
});
