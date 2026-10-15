#!/usr/bin/env node
// generate-date-words.mjs — writes packages/beanpool-core/src/words-dates.ts: the month and day names, the date and time
// patterns and the decimal separator of every language in LANGS except English, from CLDR as Node's ICU carries it.
//
//   node scripts/words/generate-date-words.mjs            regenerate (run it by hand; the output is committed)
//   node scripts/words/generate-date-words.mjs --check    exit 1 when the committed file differs from what ICU gives now
//
// One-off by design: the apps never call Intl at runtime (Hermes implements it only partly, and the 320 px tests need the
// same text on every runtime), so CLDR is copied into a table once and the table is what ships. The words tests compare
// the table with ICU again; when a new Node's CLDR renames a month, that test says so, and this script is how to re-check.
//
// Western digits everywhere for v1: every tag is formatted with -u-nu-latn (and -u-ca-gregory, so fa is not given the
// Persian calendar). bn and fa default to their own digits in CLDR; DateWords.digits can switch them on later as data.
//
// English is not generated: words.ts writes it by hand, because the apps have always printed "3 Oct" and "Sat 3 Oct",
// which is neither en-US nor en-GB.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = 'packages/beanpool-core/src/words-dates.ts';

/** Read from words.ts, so the list of languages has one home. */
function langs() {
    const src = fs.readFileSync(path.join(ROOT, 'packages/beanpool-core/src/words.ts'), 'utf8');
    const m = src.match(/export const LANGS = Object\.freeze\(\[([^\]]+)\]/);
    if (!m) throw new Error('LANGS not found in words.ts');
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

const intlTag = (lang) => `${lang}-u-ca-gregory-nu-latn`;
const parts = (lang, opts, d) => new Intl.DateTimeFormat(intlTag(lang), { ...opts, timeZone: 'UTC' }).formatToParts(d);
const part = (lang, opts, d, type) => parts(lang, opts, d).find((p) => p.type === type).value;

/** A pattern from ICU's parts: the day, month, year and weekday become tokens; the rest is kept as written. */
function pattern(lang, opts) {
    const d = new Date(Date.UTC(2026, 9, 15, 9, 5)); // Thu 15 Oct 2026, 09:05: no field equals another
    return parts(lang, opts, d).map((p) => {
        if (p.type === 'day') return '{d}';
        if (p.type === 'month') return /^\d+$/.test(p.value) ? '{m}' : '{M}';
        if (p.type === 'year') return '{y}';
        if (p.type === 'weekday') return '{W}';
        if (p.type === 'hour') return '{H}';
        if (p.type === 'minute') return '{mm}';
        if (p.type === 'literal') return p.value.replace(/[{}]/g, '');
        throw new Error(`${lang}: unexpected part ${p.type}`);
    }).join('');
}

const OPTS = {
    'day-month': (w) => ({ day: 'numeric', month: w }),
    'day-month-year': (w) => ({ day: 'numeric', month: w, year: 'numeric' }),
    'weekday-day-month': (w) => ({ weekday: w, day: 'numeric', month: w }),
};

/** A weekday table on its own, kept only where it differs from the one inside a date (de "Do" / "Do."). */
const standalone = (name, inDate, alone) => (alone.some((x, i) => x !== inDate[i]) ? { [name]: alone } : {});

export function generate(lang) {
    const months = (opts) => Array.from({ length: 12 }, (_, m) => part(lang, opts, new Date(Date.UTC(2026, m, 15, 12)), 'month'));
    // 11 Oct 2026 is a Sunday. Inside a date (de "Do., 15. Okt.") and on its own (de "Do") can differ.
    const days = (opts) => Array.from({ length: 7 }, (_, i) => part(lang, opts, new Date(Date.UTC(2026, 9, 11 + i, 12)), 'weekday'));
    const patterns = {};
    for (const width of ['short', 'long']) {
        patterns[width] = {};
        for (const [name, opts] of Object.entries(OPTS)) patterns[width][name] = pattern(lang, opts(width));
    }
    // fa writes a month before a year with the ezafe ("ژانویهٔ 2026"): kept only where it differs.
    const monthsWithYear = {};
    for (const width of ['short', 'long']) {
        const withYear = months({ day: 'numeric', month: width, year: 'numeric' });
        const plain = width === 'long' ? months({ day: 'numeric', month: 'long' }) : months({ day: 'numeric', month: 'short' });
        if (withYear.some((m, i) => m !== plain[i])) monthsWithYear[width] = withYear;
    }
    const decimal = new Intl.NumberFormat(intlTag(lang)).formatToParts(1.5).find((p) => p.type === 'decimal').value;
    return {
        monthsLong: months({ day: 'numeric', month: 'long' }),
        monthsShort: months({ day: 'numeric', month: 'short' }),
        monthsStandalone: months({ month: 'long' }),
        ...(Object.keys(monthsWithYear).length ? { monthsWithYear } : {}),
        daysShort: days({ weekday: 'short', day: 'numeric', month: 'short' }),
        daysLong: days({ weekday: 'long', day: 'numeric', month: 'long' }),
        ...standalone('daysShortStandalone', days({ weekday: 'short', day: 'numeric', month: 'short' }), days({ weekday: 'short' })),
        ...standalone('daysLongStandalone', days({ weekday: 'long', day: 'numeric', month: 'long' }), days({ weekday: 'long' })),
        patterns,
        time: pattern(lang, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
        decimal,
        digits: null,
        caps: lang === 'tr' ? 'turkic' : lang === 'el' ? 'greek' : 'upper',
    };
}

/** Render with the table the way words.ts does, to prove the table reproduces ICU before it is written. */
function render(w, d, name, width) {
    const fill = (tpl) => tpl
        .replace('{d}', String(d.getUTCDate())).replace('{m}', String(d.getUTCMonth() + 1)).replace('{y}', String(d.getUTCFullYear()))
        .replace('{M}', ((name === 'day-month-year' && w.monthsWithYear?.[width]) || (width === 'long' ? w.monthsLong : w.monthsShort))[d.getUTCMonth()])
        .replace('{W}', (width === 'long' ? w.daysLong : w.daysShort)[d.getUTCDay()])
        .replace('{H}', String(d.getUTCHours()).padStart(2, '0')).replace('{mm}', String(d.getUTCMinutes()).padStart(2, '0'));
    return name === 'time' ? fill(w.time) : fill(w.patterns[width][name]);
}

function verify(lang, w) {
    const bad = [];
    for (let m = 0; m < 12; m++) {
        for (const day of [1, 9, 15, 28]) {
            const d = new Date(Date.UTC(2026, m, day, m * 2 % 24, day * 2 % 60));
            for (const width of ['short', 'long']) {
                for (const [name, opts] of Object.entries(OPTS)) {
                    const want = new Intl.DateTimeFormat(intlTag(lang), { ...opts(width), timeZone: 'UTC' }).format(d);
                    const got = render(w, d, name, width);
                    if (got !== want) bad.push(`${lang} ${name} ${width} ${d.toISOString()}: ${JSON.stringify(got)} ≠ ICU ${JSON.stringify(want)}`);
                }
            }
            for (const width of ['short', 'long']) {
                const alone = (width === 'long' ? w.daysLongStandalone ?? w.daysLong : w.daysShortStandalone ?? w.daysShort)[d.getUTCDay()];
                const wantAlone = new Intl.DateTimeFormat(intlTag(lang), { weekday: width, timeZone: 'UTC' }).format(d);
                if (alone !== wantAlone) bad.push(`${lang} weekday ${width} ${d.toISOString()}: ${alone} ≠ ICU ${wantAlone}`);
            }
            const want = new Intl.DateTimeFormat(intlTag(lang), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' }).format(d);
            if (render(w, d, 'time') !== want) bad.push(`${lang} time ${d.toISOString()}: ${render(w, d, 'time')} ≠ ICU ${want}`);
        }
    }
    return bad;
}

export function source() {
    const out = {};
    const problems = [];
    for (const lang of langs().filter((l) => l !== 'en')) {
        out[lang] = generate(lang);
        problems.push(...verify(lang, out[lang]));
    }
    if (problems.length) throw new Error(`the table cannot reproduce ICU:\n${problems.slice(0, 20).join('\n')}`);
    const body = Object.entries(out).map(([lang, w]) => `    ${JSON.stringify(lang)}: ${JSON.stringify(w)},`).join('\n');
    return [
        '// GENERATED by scripts/words/generate-date-words.mjs from CLDR ' + process.versions.cldr + ' (ICU ' + process.versions.icu + '). Do not edit by hand:',
        '// change the script and run it again. English is in words.ts (written by hand: the apps\' own "3 Oct").',
        '// Western digits (nu-latn) and the Gregorian calendar for every language in v1.',
        '',
        "import type { DateWords, Lang } from './words.js';",
        '',
        '/** Every language but English, from CLDR. */',
        "export const CLDR_DATE_WORDS: Readonly<Record<Exclude<Lang, 'en'>, DateWords>> = {",
        body,
        '};',
        '',
    ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const text = source();
    const file = path.join(ROOT, OUT);
    if (process.argv.includes('--check')) {
        const same = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').slice(1).join('\n') === text.split('\n').slice(1).join('\n');
        console.log(same ? `${OUT}: matches ICU ${process.versions.icu}` : `${OUT}: differs from ICU ${process.versions.icu}; re-check it`);
        process.exitCode = same ? 0 : 1;
    } else {
        fs.writeFileSync(file, text);
        console.log(`${OUT}: ${langs().length - 1} languages from CLDR ${process.versions.cldr}`);
    }
}
