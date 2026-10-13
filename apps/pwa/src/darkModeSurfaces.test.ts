/**
 * Dark mode: no light slab or dark ink left behind. A className that paints a light surface (bg-white, a 50/100 tint)
 * or a near-black ink (text-nature-900 and the like) has to say what it becomes in dark mode, or in dark mode it is a
 * white box on a dark page, or a name that vanishes on a dark panel (the rating form's name measured 1.49:1). Swept
 * 13 Oct 2026 (lane dark-pwa): Market's edit, rating and report forms, its error panels and badges, the Map's photo
 * picker and disabled Post button, and Settings' node test result.
 *
 * The few that stay light in both themes on purpose are listed in ALLOWED, each with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname);

const LIGHT = /(?<![\w:/-])(bg-white|bg-gray-(?:50|100|200)|bg-slate-(?:50|100)|bg-oat-(?:50|100|200)|bg-nature-(?:50|100)|bg-(?:red|amber|yellow|green|blue|emerald|orange)-(?:50|100)|text-gray-(?:700|800|900)|text-nature-(?:800|900|950)|text-slate-(?:800|900)|text-black)(?![\w/-])/g;

/** [file, a piece of the className that marks the one place] — light in both themes on purpose. */
const ALLOWED: Array<[string, string, string]> = [
    ['App.tsx', 'bg-white text-amber-900', 'a white button on the amber banner, which is amber in both themes'],
    ['components/FormerAddressBanner.tsx', 'bg-white text-amber-900', 'the same white button on the same amber banner'],
    ['components/ImageLightbox.tsx', 'rounded-full focus-visible', 'the photo dots on the lightbox, which is black in both themes'],
    ['pages/InvitePage.tsx', 'bg-white rounded-xl p-4 inline-block', 'the QR code needs its white quiet zone to scan'],
    ['pages/SettingsPage.tsx', 'block rounded-full bg-white shadow-md', 'the knob of a switch'],
];

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return files(p);
        return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [p] : [];
    });
}

describe('dark mode surfaces', () => {
    it('every light surface or dark ink in a className has a dark: partner', () => {
        const found: string[] = [];
        for (const file of files(SRC)) {
            const rel = path.relative(SRC, file).split(path.sep).join('/');
            const src = fs.readFileSync(file, 'utf8');
            const attr = /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g;
            let m: RegExpExecArray | null;
            while ((m = attr.exec(src))) {
                const cls = m[1] ?? m[2] ?? m[3] ?? '';
                if (ALLOWED.some(([f, piece]) => f === rel && cls.includes(piece))) continue;
                for (const hit of cls.matchAll(LIGHT)) {
                    const kind = hit[1].split('-')[0];
                    if (!cls.includes(`dark:${kind}-`)) {
                        found.push(`${rel}:${src.slice(0, m.index).split('\n').length} ${hit[1]}`);
                    }
                }
            }
        }
        expect(found).toEqual([]);
    });
});
