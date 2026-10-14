/**
 * "Change a colour once, every app follows" (docs/brand-colours.md, Marty 14 Oct 2026) holds on the web only while no
 * control paints a brand or status colour from a raw Tailwind shade. tailwind.config.js names the shared library's roles
 * (bg-bp-commit-fill, text-bp-commit-on, bg-bp-chip-ok-tint …) from @beanpool/core/brand-colours; these read every class
 * string in the source and fail when a role-coloured control goes back to a raw shade:
 *
 *   - words on a solid emerald / terra / red / orange / amber fill (a button, a count badge, a price tag) name the role;
 *   - words on a role fill are that role's own `on` (charcoal on gold, never white);
 *   - a small chip (Offer/Need, verified, counts) is a chip role's ink on its tint, not a raw pale shade and a raw ink.
 *
 * A class string is a quoted string or a template literal; a template's fixed text goes with each quoted string in its
 * `${}` branches, so `text-white ${on ? 'bg-emerald-600' : 'bg-nature-300'}` is judged as two buttons.
 *
 * Not judged: neutral greys, page grounds and the wallpaper; words straight on a page (links, notices); bars, dots
 * and rings with no words on them; the web map's pin colours (MapPage, not covered by the library). A genuine non-role
 * use goes in ALLOWED with why.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SRC = path.resolve(__dirname);

/** [file, a piece of the class string that marks the one place, why it is not a role-coloured control]. */
const ALLOWED: Array<[string, string, string]> = [];

const HUES = '(?:emerald|green|terra|red|rose|orange|amber|yellow)';
/** A solid brand or status fill: what white words sat on before the roles. */
const RAW_FILL = new RegExp(`^bg-${HUES}-(?:400|500|600|700|800|900)(?:/\\d+)?$`);
const RAW_TINT = new RegExp(`^bg-${HUES}-(?:50|100|200)(?:/\\d+)?$`);
const RAW_INK = new RegExp(`^text-${HUES}-(?:600|700|800|900)$`);
const ROLE_FILL = /^bg-bp-(cta|commit|action|danger|gold|accent)-fill$/;

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return files(p);
        return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts') ? [p] : [];
    });
}

type ClassString = { where: string; classes: string[] };

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/** Each quoted string inside a `${}`: one branch apiece. */
function quoted(node: ts.Node): string[] {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    const out: string[] = [];
    ts.forEachChild(node, (child) => { out.push(...quoted(child)); });
    return out;
}

function classStrings(): ClassString[] {
    const out: ClassString[] = [];
    for (const file of files(SRC)) {
        const rel = path.relative(SRC, file).split(path.sep).join('/');
        const text = fs.readFileSync(file, 'utf8');
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const where = (node: ts.Node) => `${rel}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
        const visit = (node: ts.Node): void => {
            if (ts.isTemplateExpression(node)) {
                const fixed = words([node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' '));
                const branches = node.templateSpans.flatMap((s) => quoted(s.expression));
                out.push({ where: where(node), classes: fixed });
                for (const b of branches) out.push({ where: where(node), classes: [...fixed, ...words(b)] });
                return;
            }
            if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
                out.push({ where: where(node), classes: words(node.text) });
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return out;
}

const allowed = (cs: ClassString) => {
    const joined = cs.classes.join(' ');
    return ALLOWED.some(([file, piece]) => cs.where.startsWith(`${file}:`) && joined.includes(piece));
};

/** Base (no variant) classes only: `hover:`/`dark:` variants ride with their base. */
const base = (classes: string[]) => classes.filter((c) => !c.includes(':'));

/** Small text, a little padding, rounded: a chip or badge rather than a panel. */
function chipish(classes: string[]): boolean {
    const b = base(classes);
    return b.some((c) => c.startsWith('rounded'))
        && b.some((c) => /^text-(?:xs|\[(?:8|9|10|11|12)px\])$/.test(c))
        && b.some((c) => /^(?:px-(?:1|1\.5|2|2\.5)|py-0\.5|py-px)$/.test(c))
        && !b.some((c) => /^(?:p|px|py)-(?:3|4|5|6)$/.test(c));
}

/** The failures of one rule, with where each is, minus ALLOWED. */
function failures(all: ClassString[], fails: (classes: string[]) => string | null): string[] {
    const found = new Set<string>();
    for (const cs of all) {
        const why = fails(cs.classes);
        if (why && !allowed(cs)) found.add(`${cs.where} ${why}`);
    }
    return [...found];
}

/** White words on a raw brand/status fill. */
export function rawFillUnderWords(classes: string[]): string | null {
    const b = base(classes);
    if (!b.includes('text-white')) return null;
    const fill = b.find((c) => RAW_FILL.test(c));
    return fill ? `text-white on ${fill}` : null;
}

/** Words on a role fill that are not that role's `on`: white on gold, or a raw ink. */
export function wrongWordsOnRoleFill(classes: string[]): string | null {
    const b = base(classes);
    const fill = b.find((c) => ROLE_FILL.test(c));
    if (!fill) return null;
    const role = ROLE_FILL.exec(fill)![1];
    const ink = b.find((c) => /^text-(?:white|black|bp-[a-z-]+|[a-z]+-\d{2,3})(?:\/\d+)?$/.test(c));
    return ink && ink !== `text-bp-${role}-on` ? `${ink} on ${fill}` : null;
}

/** A small chip drawn from a raw pale tint and a raw ink. */
export function rawChip(classes: string[]): string | null {
    if (!chipish(classes)) return null;
    const b = base(classes);
    const tint = b.find((c) => RAW_TINT.test(c));
    const ink = b.find((c) => RAW_INK.test(c));
    return tint && ink ? `chip ${ink} on ${tint}` : null;
}

describe('role-coloured controls take their colours from the brand library', () => {
    const all = classStrings();

    it('reads the class strings', () => {
        expect(all.length).toBeGreaterThan(5000);
    });

    it('no words sit on a raw emerald / terra / red / orange / amber fill: they use bg-bp-<role>-fill', () => {
        expect(failures(all, rawFillUnderWords)).toEqual([]);
    });

    it("words on a role fill are that role's own (text-bp-<role>-on): charcoal on gold, never white", () => {
        expect(failures(all, wrongWordsOnRoleFill)).toEqual([]);
    });

    it('small chips and badges use a chip role (bg-bp-chip-*-tint, text-bp-chip-*-ink), not raw pale shades', () => {
        expect(failures(all, rawChip)).toEqual([]);
    });

    it('catches what it is for, and lets the rest pass', () => {
        expect(rawFillUnderWords(words('px-4 bg-emerald-600 dark:bg-emerald-700 hover:bg-emerald-500 text-white'))).toBe('text-white on bg-emerald-600');
        expect(rawFillUnderWords(words('bg-terra-500/90 text-white'))).toBe('text-white on bg-terra-500/90');
        expect(rawFillUnderWords(words('bg-bp-commit-fill hover:bg-bp-commit-hover text-bp-commit-on'))).toBeNull();
        expect(rawFillUnderWords(words('w-2 h-2 rounded-full bg-emerald-500 animate-pulse'))).toBeNull();
        expect(wrongWordsOnRoleFill(words('bg-bp-gold-fill text-white'))).toBe('text-white on bg-bp-gold-fill');
        expect(wrongWordsOnRoleFill(words('bg-bp-gold-fill hover:bg-bp-gold-hover text-bp-gold-on'))).toBeNull();
        expect(wrongWordsOnRoleFill(words('bg-bp-commit-fill border-bp-commit-fill'))).toBeNull();
        expect(rawChip(words('px-2 py-0.5 rounded-full text-[11px] bg-emerald-100 text-emerald-800'))).toBe('chip text-emerald-800 on bg-emerald-100');
        expect(rawChip(words('p-4 rounded-xl text-sm bg-emerald-50 text-emerald-800'))).toBeNull();
        expect(rawChip(words('px-2 py-0.5 rounded-full text-[11px] bg-bp-chip-ok-tint text-bp-chip-ok-ink'))).toBeNull();
    });
});
