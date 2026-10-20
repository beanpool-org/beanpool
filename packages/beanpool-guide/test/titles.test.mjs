import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_DIR, sourceGuides, titleProblems } from '../scripts/build.mjs';
import { loadGuide, GUIDE_LANGS } from '../src/guide.mjs';
import {
    guideSourceHash, displayColumns, titleCap, titleEntries, readGuideTitles, checkGuideTitles, draftGuideTitles,
    TITLES_FILE, TITLE_FLOOR_COLUMNS,
} from '../src/titles.mjs';

// The guide's titles and summaries in the member's language (slice S5a): content/<lang>/manifest.json, checked against
// the English on the pages as they stand. What the apps then show is tested in apps/native/utils/__tests__/guide.test.ts
// and guide-words-render.test.ts, and apps/pwa/src/components/MemberGuide.test.tsx.

const guide = sourceGuides().guide;
const page = slug => guide.guides.find(p => p.slug === slug);
const section = id => guide.sections.find(s => s.id === id);
const entry = english => text => ({ text, sourceHash: guideSourceHash(english) });
/** A check of these files (by language) over the real guide; every other language has an empty file. */
const checkWith = files => checkGuideTitles(guide, { files: Object.fromEntries(GUIDE_LANGS.map(l => [l, files[l] ?? { sections: {}, pages: {} }])) });
const problemsWith = file => checkWith({ pt: file }).problems;

test('every language has its titles file, and the files as committed check', () => {
    for (const lang of GUIDE_LANGS) assert.ok(fs.existsSync(path.join(CONTENT_DIR, lang, TITLES_FILE)), `content/${lang}/${TITLES_FILE}`);
    const read = readGuideTitles(CONTENT_DIR);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(checkGuideTitles(guide, read).problems, []);
    assert.deepEqual(titleProblems(guide), []);
});

test("a language's folder is not a section, and no section may take a language's name", () => {
    assert.ok(!guide.sections.some(s => GUIDE_LANGS.includes(s.id)));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-titles-'));
    try {
        const page = '---\nslug: one\ntitle: One\nsummary: The first page.\nrelated: two\n---\nWords.\n';
        fs.mkdirSync(path.join(dir, 'about'));
        fs.writeFileSync(path.join(dir, 'about', 'one.md'), page);
        fs.writeFileSync(path.join(dir, 'about', 'two.md'), page.replace('slug: one', 'slug: two').replace('related: two', 'related: one'));
        fs.mkdirSync(path.join(dir, 'pt'));
        fs.writeFileSync(path.join(dir, 'pt', TITLES_FILE), '{}');
        const manifest = sections => fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ sections }));
        manifest([{ id: 'about', title: 'About', summary: 'About it.', pages: ['one', 'two'] }]);
        assert.deepEqual(loadGuide(dir).sections.map(s => s.id), ['about']);
        fs.renameSync(path.join(dir, 'about'), path.join(dir, 'id'));
        manifest([{ id: 'id', title: 'About', summary: 'About it.', pages: ['one', 'two'] }]);
        assert.throws(() => loadGuide(dir, { aboutSection: null }), /section id "id" is a language's folder/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test("a source hash is the first 16 hex digits of the English's sha256 (core's guideSourceHash hashes the same)", () => {
    assert.equal(guideSourceHash('abc'), 'ba7816bf8f01cfea');
    assert.equal(guideSourceHash('Mercado — café'), crypto.createHash('sha256').update(Buffer.from('Mercado — café', 'utf8')).digest('hex').slice(0, 16));
    assert.notEqual(guideSourceHash('Market'), guideSourceHash('Market '));
});

test('the lines a language translates: each section title and summary, each page title and summary, and help lines', () => {
    const lines = titleEntries(guide);
    const helps = guide.guides.filter(p => p.help).length;
    assert.equal(lines.length, guide.sections.length * 2 + guide.guides.length * 2 + helps);
    assert.ok(helps > 0);
    assert.deepEqual(lines[0], { kind: 'section', id: guide.sections[0].id, field: 'title', key: `sections.${guide.sections[0].id}.title`, english: guide.sections[0].title });
});

test('a good translation counts; the rest of the language shows its English', () => {
    const market = section('market');
    const home = page('home');
    const r = checkWith({ pt: {
        _meta: { language: 'pt', reviewed: false },
        sections: { market: { title: entry(market.title)('Mercado'), summary: entry(market.summary)('Encontrar e publicar Ofertas e Pedidos.') } },
        pages: { home: { title: entry(home.title)('Início'), help: entry(home.help)('O seu painel.') } },
    } });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.counts.pt, { translated: 4, stale: 0, missing: r.counts.pt.total - 4, total: titleEntries(guide).length });
    assert.equal(r.counts.es.translated, 0);
});

test('every key is a real section or page, and every field one the English has', () => {
    const home = page('home');
    const noHelp = guide.guides.find(p => !p.help);
    assert.ok(noHelp, 'a page without a help line');
    const problems = problemsWith({
        sections: { markets: { title: entry('Market')('Mercado') } },
        pages: {
            'no-such-page': { title: entry('x')('y') },
            home: { subtitle: entry(home.title)('Início') },
            [noHelp.slug]: { help: entry('x')('Uma linha.') },
        },
    });
    assert.equal(problems.length, 4, problems.join('\n'));
    assert.match(problems[0], /sections\.markets: the guide has no section "markets"/);
    assert.match(problems[1], /pages\.no-such-page: the guide has no page "no-such-page"/);
    assert.match(problems[2], /pages\.home\.subtitle: a page translates title, summary, help only/);
    assert.match(problems[3], new RegExp(`pages\\.${noHelp.slug}\\.help: the English page has no help to translate`));
    assert.match(problemsWith({ sections: { market: { help: entry('x')('y') } } })[0], /a section translates title, summary only/);
    assert.match(problemsWith({ chapters: {} })[0], /"chapters" is not part of a titles file/);
    assert.match(problemsWith([])[0], /an object with "sections" and "pages"/);
});

test('an entry is { text, sourceHash } and nothing else, its hash 16 hex digits', () => {
    const t = section('market').title;
    for (const bad of ['Mercado', { text: 'Mercado' }, { text: 'Mercado', sourceHash: guideSourceHash(t), reviewed: true }, null]) {
        assert.match(problemsWith({ sections: { market: { title: bad } } })[0] ?? '', /\{ "text": "<translation>", "sourceHash": "<hash of the English>" \}/, JSON.stringify(bad));
    }
    assert.match(problemsWith({ sections: { market: { title: { text: 'Mercado', sourceHash: 'ABC' } } } })[0], /"sourceHash" is 16 hex digits/);
});

test('placeholders none, one line, no markup beyond **bold**, within the limits the apps take', () => {
    const market = section('market');
    const home = page('home');
    const title = text => problemsWith({ sections: { market: { title: entry(market.title)(text) } } });
    assert.match(title('Mercado de {name}')[0], /has a \{placeholder\} or a brace/);
    assert.match(title('Mercado\nnovo')[0], /is one line/);
    assert.match(title(' Mercado')[0], /starts or ends with a space/);
    assert.match(title('<b>Mercado</b>')[0], /HTML is not supported/);
    assert.match(title('[Mercado](https://x.example)')[0], /links are not supported/);
    assert.match(title('**Mercado**')[0], /marks 1 bold run\(s\) with \*\*; the English marks 0/);
    assert.match(title('')[0], /"text" is the translation/);
    const summary = problemsWith({ pages: { home: { summary: entry(home.summary)('a'.repeat(301)) } } });
    assert.match(summary[0], /is 301 characters; the apps take 300 at most/);
    const help = problemsWith({ pages: { home: { help: entry(home.help)('a'.repeat(161)) } } });
    assert.match(help[0], /is 161 characters; the apps take 160 at most/);
});

test('the per-language title cap: 35 % over the English in display columns, a wide character counting two, never under 14', () => {
    assert.equal(displayColumns('Mercado'), 7);
    assert.equal(displayColumns('マーケット'), 10);
    assert.equal(displayColumns('시장'), 4);
    assert.equal(displayColumns('बाज़ार'), 3); // the vowel signs and the nukta take no column of their own
    const long = guide.guides.reduce((a, b) => (b.title.length > a.title.length ? b : a));
    const cap = titleCap(long.title);
    assert.equal(cap, Math.ceil(long.title.length * 1.35));
    const pageTitle = text => problemsWith({ pages: { [long.slug]: { title: entry(long.title)(text) } } });
    assert.deepEqual(pageTitle('a'.repeat(cap)), []);
    assert.match(pageTitle('a'.repeat(cap + 1))[0], new RegExp(`is ${cap + 1} columns wide; this title takes ${cap} at most`));
    // The same cap in Japanese holds half the characters.
    assert.deepEqual(pageTitle('語'.repeat(Math.floor(cap / 2))), []);
    assert.match(pageTitle('語'.repeat(Math.floor(cap / 2) + 1))[0], /columns wide; this title takes/);
    // A one-word English title may still take a natural translation, up to one line of the narrowest row.
    const map = section('map');
    assert.equal(titleCap(map.title), TITLE_FLOOR_COLUMNS);
    const sectionTitle = text => problemsWith({ sections: { map: { title: entry(map.title)(text) } } });
    assert.deepEqual(sectionTitle('Mapa do bairro'), []);
    assert.match(sectionTitle('Mapa do bairros')[0], /is 15 columns wide; this title takes 14 at most/);
});

test('a line drafted from English that has changed is stale: listed for the drafting round, never a failure', () => {
    const market = section('market');
    const r = checkWith({ pt: { sections: { market: {
        title: entry('Marketplace')('Um título muito mais longo do que o inglês permite agora'),
        summary: entry(market.summary)('Encontrar e publicar.'),
    } } } });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.stale.pt, [{ key: 'sections.market.title', english: market.title }]);
    assert.equal(r.counts.pt.translated, 1);
    assert.equal(r.counts.pt.stale, 1);
    // A stale line is still held to the shape the apps take.
    assert.match(checkWith({ pt: { sections: { market: { title: entry('Marketplace')('Mercado {x}') } } } }).problems[0], /placeholder/);
});

test('the drafting round gets every missing and stale line in the file\'s own shape, with the English to translate', () => {
    const market = section('market');
    const empty = draftGuideTitles(guide, { sections: {}, pages: {} });
    assert.equal(Object.keys(empty.sections).length, guide.sections.length);
    assert.equal(Object.keys(empty.pages).length, guide.guides.length);
    assert.deepEqual(empty.sections.market.title, { text: market.title, sourceHash: guideSourceHash(market.title) });
    assert.deepEqual(draftGuideTitles(guide, null), empty);
    const some = draftGuideTitles(guide, { sections: { market: {
        title: entry(market.title)('Mercado'),
        summary: entry('An older summary.')('Um resumo antigo.'),
    } } });
    assert.equal(some.sections.market.title, undefined);
    assert.deepEqual(some.sections.market.summary, { text: market.summary, sourceHash: guideSourceHash(market.summary) });
    // The draft, translated as it stands, checks.
    assert.deepEqual(problemsWith(empty), []);
});

test('a missing file, a stray file in a language folder, and a file that is not JSON are each refused', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-titles-'));
    try {
        for (const lang of GUIDE_LANGS) {
            fs.mkdirSync(path.join(dir, lang));
            fs.writeFileSync(path.join(dir, lang, TITLES_FILE), '{ "sections": {}, "pages": {} }');
        }
        assert.deepEqual(readGuideTitles(dir).problems, []);
        fs.rmSync(path.join(dir, 'pt', TITLES_FILE));
        fs.writeFileSync(path.join(dir, 'es', 'market.md'), '---');
        fs.writeFileSync(path.join(dir, 'fr', TITLES_FILE), '{ "sections": ');
        const { files, problems } = readGuideTitles(dir);
        assert.equal(problems.length, 3, problems.join('\n'));
        assert.match(problems[0], /content\/es\/market\.md: a language's folder holds only manifest\.json/);
        assert.match(problems[1], /content\/pt\/manifest\.json is missing/);
        assert.match(problems[2], /content\/fr\/manifest\.json is not JSON/);
        assert.equal(files.pt, null);
        assert.equal(files.fr, null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
