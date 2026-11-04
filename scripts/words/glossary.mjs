// glossary.mjs — reads scripts/words/GLOSSARY.csv (translation slice T0, scratch/fable-design/DESIGN-translation-tooling-fable.md §4).
//
// The glossary is a CSV so a person can edit it in a sheet and Weblate can import it later (T3). One row per term:
//
//   term, meaning, flags, <one column per language that has renderings: es, pt, fr, ru, …>
//
// - term      the English word as a sentence uses it; it matches whole words, with a plural, in any case ("group" matches Group,
//             groups, GROUP) unless the row is flagged `name`.
// - meaning   one line: what the word means in BeanPool (never the two words Marty has ruled out: see FORBIDDEN_IN_MEANINGS).
// - flags     `;`-separated: `untranslatable` (stays as written in every language), `forbidden` (never appears in a translation),
//             `name` (matches only the capitalised or upper-case word: "Offer" is the post, "offer" is the verb; "Home" is the
//             screen, "home address" is not; not where the capital only opens a sentence before a lower-case word, "Offer to help",
//             "Needs you", "People who joined", nor in a heading in capitals), and notes for translators: `terminology`, `money`,
//             `safety`, `operator`.
//             A typed word (an upper-case `untranslatable` row like CONFIRM) matches only where the sentence says to type it.
// - language  the rendering, then ` | ` and its allowed variants. Empty = no rendering yet (nothing is checked, nothing is invented).
//             A `forbidden` row lists the renderings that are ruled out. A trailing `~` is a stem: any word that starts with it.
//
// The checks are core's (packages/beanpool-core/src/words-check.ts, checkCatalogRules); this file only reads and validates the table,
// so moving the catalogs to PO later changes the catalog reader and not this one.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GLOSSARY_FILE = 'scripts/words/GLOSSARY.csv';
export const GLOSSARY_FLAGS = Object.freeze(['untranslatable', 'forbidden', 'name', 'terminology', 'money', 'safety', 'operator']);
/** Words that may not stand in a meaning (Marty: not in any words, in any language). The forbidden rows' own term cells are exempt. */
export const FORBIDDEN_IN_MEANINGS = /resilien|surviv/i;
const FIXED_COLUMNS = ['term', 'meaning', 'flags'];

/** RFC 4180 rows: quoted fields may hold commas, quotes ("" is one) and line breaks. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (c === '"') quoted = false;
            else field += c;
        } else if (c === '"' && field === '') {
            quoted = true;
        } else if (c === ',') {
            row.push(field); field = '';
        } else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some((f) => f !== '')) rows.push(row);
            row = [];
        } else {
            field += c;
        }
    }
    row.push(field);
    if (row.some((f) => f !== '')) rows.push(row);
    return rows;
}

/** A CSV field: quoted when it holds a comma, a quote or a line break. */
export function csvField(value) {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * The glossary as core's `GlossaryTerm`s, and what is wrong with the file. `langs` are the tags a column may be named by (core's LANGS
 * but en). Problems are strings for words:check; a file with problems still returns the rows it could read.
 */
export function parseGlossary(text, langs) {
    const problems = [];
    const rows = parseCsv(text);
    if (rows.length === 0) return { terms: [], problems: [`${GLOSSARY_FILE}: empty`] };
    const header = rows[0].map((h) => h.trim());
    FIXED_COLUMNS.forEach((name, i) => {
        if (header[i] !== name) problems.push(`${GLOSSARY_FILE}: column ${i + 1} must be "${name}", not "${header[i] ?? ''}"`);
    });
    const langCols = [];
    header.slice(FIXED_COLUMNS.length).forEach((h, i) => {
        if (!langs.includes(h)) problems.push(`${GLOSSARY_FILE}: column "${h}" is not one of ${langs.join(', ')}`);
        else if (langCols.some((c) => c.lang === h)) problems.push(`${GLOSSARY_FILE}: column "${h}" appears twice`);
        else langCols.push({ lang: h, index: FIXED_COLUMNS.length + i });
    });
    const terms = [];
    const seen = new Set();
    rows.slice(1).forEach((cells, n) => {
        const at = `${GLOSSARY_FILE}:${n + 2}`;
        const [term = '', meaning = '', flagText = ''] = cells.map((c) => c.trim());
        if (cells.length > header.length) problems.push(`${at}: ${cells.length} fields, the header has ${header.length} (quote a field that holds a comma)`);
        if (!term) { problems.push(`${at}: no term`); return; }
        if (seen.has(term)) problems.push(`${at}: "${term}" is already a row`);
        seen.add(term);
        if (!meaning) problems.push(`${at}: "${term}" has no meaning`);
        if (FORBIDDEN_IN_MEANINGS.test(meaning)) problems.push(`${at}: the meaning of "${term}" uses a word we do not use`);
        const flags = flagText.split(';').map((f) => f.trim()).filter(Boolean);
        for (const f of flags) if (!GLOSSARY_FLAGS.includes(f)) problems.push(`${at}: "${term}": flag "${f}" is not one of ${GLOSSARY_FLAGS.join(', ')}`);
        if (flags.includes('forbidden') && flags.includes('untranslatable')) problems.push(`${at}: "${term}" cannot be both forbidden and untranslatable`);
        const renderings = {};
        for (const { lang, index } of langCols) {
            const forms = (cells[index] ?? '').split('|').map((f) => f.trim()).filter(Boolean);
            if (forms.length) renderings[lang] = forms;
        }
        terms.push({ term, meaning, flags, renderings });
    });
    return { terms, problems };
}

export function readGlossary(langs, root = path.resolve(HERE, '../..')) {
    const file = path.join(root, GLOSSARY_FILE);
    if (!fs.existsSync(file)) return { terms: [], problems: [`${GLOSSARY_FILE}: missing`] };
    return parseGlossary(fs.readFileSync(file, 'utf8'), langs);
}

/** A rendering as a person reads it: a stem ("хранител~") shows as "хранител…" (the word's ending changes). */
const shownForm = (form) => (form.endsWith('~') ? `${form.slice(0, -1)}…` : form);

/** The glossary as Markdown for a drafting brief (draft.mjs --briefs): every term, what it means, and this language's rendering. */
export function glossaryForBrief(terms, lang) {
    const lines = [`| Term | Meaning | Flags | In ${lang} |`, '| --- | --- | --- | --- |'];
    const cell = (s) => s.replace(/\|/g, '\\|');
    for (const t of terms) {
        const forms = (t.renderings[lang] ?? []).map(shownForm);
        let shown;
        if (t.flags.includes('untranslatable')) shown = 'keep exactly as written';
        else if (t.flags.includes('forbidden')) shown = `never use${forms.length ? `: ${forms.join(', ')}` : ''}`;
        else if (forms.length) shown = forms[0] + (forms.length > 1 ? ` (also fine: ${forms.slice(1).join(', ')})` : '');
        else shown = '_no rendering yet: pick one plain word and use it every time_';
        lines.push(`| ${cell(t.term)} | ${cell(t.meaning)} | ${t.flags.join(', ')} | ${cell(shown)} |`);
    }
    return lines.join('\n');
}
