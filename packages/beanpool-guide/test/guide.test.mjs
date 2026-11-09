import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { check, BUNDLED_JSON, WEBSITE_DIR, CONTENT_DIR, OPERATORS_DIR, OPERATORS_JSON, OPERATORS_WEBSITE_DIR, OPERATOR_PAGES_ON_WEBSITE, expectedOutputs, sourceGuides } from '../scripts/build.mjs';
import { parseGuideMarkdown, renderWebsite, renderOperatorsWebsite, contentHash, loadGuide, GUIDE_SCHEMA, GUIDE_LANGS, loadLanguagePages, checkLanguagePages, renderLanguageWebsite, guideBodyHash, guideSourceHash, renderGuideSitemap, OG_IMAGE_URL, OG_LOCALES } from '../src/guide.mjs';

// Two copies of each collection are tested. What a page SAYS is pinned on the pages themselves (sourceGuides), so the
// PR that changes the words changes the pin with them. The website and the bundles are tested on the PUBLISHED copy
// (expectedOutputs), which the director publishes after merge; a pin on its words would break at publish instead.

test('every generated file (app bundle and website) is exactly what the source produces', () => {
    assert.deepEqual(check(), []);
});

test("the app's bundled guide.json and the website's guide.json are the same bytes", () => {
    const bundled = fs.readFileSync(BUNDLED_JSON, 'utf8');
    const website = fs.readFileSync(path.join(WEBSITE_DIR, 'guide.json'), 'utf8');
    assert.equal(bundled, website);
    const guide = JSON.parse(bundled);
    assert.equal(guide.schema, GUIDE_SCHEMA);
    assert.equal(guide.hash, contentHash({ sections: guide.sections, guides: guide.guides }));
});

test('the website has a page for every guide, rendered from the same blocks the app shows', () => {
    const { guide } = expectedOutputs();
    for (const g of guide.guides) {
        const html = fs.readFileSync(path.join(WEBSITE_DIR, `${g.slug}.html`), 'utf8');
        for (const b of g.blocks) {
            const texts = b.type === 'ul' ? b.items : [b.text];
            for (const t of texts) {
                // The plain words of every block appear on the page (bold markers become <strong>).
                const firstWords = t.replace(/\*\*/g, '').split(' ').slice(0, 4).join(' ');
                const escaped = firstWords.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                assert.ok(html.replace(/<\/?strong>/g, '').includes(escaped), `${g.slug}.html is missing "${firstWords}"`);
            }
        }
    }
});

test('the app sheet finds the guides it links to', () => {
    const { guide } = sourceGuides();
    const about = guide.sections.find(s => s.id === 'about');
    assert.deepEqual(about.slugs, ['how-it-works', 'rules', 'faq', 'whats-new']);
});

test('the manual: every section has pages, every page has Related pages that exist, the website lists them all', () => {
    const pages = sourceGuides().guide;
    assert.ok(pages.sections.length >= 9, 'about + the eight manual sections');
    for (const want of ['getting-started', 'market', 'map', 'talk', 'pulse', 'commons', 'ledger', 'settings']) {
        assert.ok(pages.sections.some(s => s.id === want), `section ${want}`);
    }
    const { guide } = expectedOutputs();
    const slugs = new Set(guide.guides.map(g => g.slug));
    const index = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');
    for (const s of guide.sections) assert.ok(index.includes(`href="#${s.id}"`), `table of contents links ${s.id}`);
    for (const g of guide.guides) {
        assert.ok(g.related.length >= 1, `${g.slug} lists Related pages`);
        for (const r of g.related) assert.ok(slugs.has(r), `${g.slug} → ${r}`);
        assert.ok(index.includes(`href="${g.slug}.html"`), `index links ${g.slug}`);
        const html = fs.readFileSync(path.join(WEBSITE_DIR, `${g.slug}.html`), 'utf8');
        for (const r of g.related) assert.ok(html.includes(`href="${r}.html"`), `${g.slug}.html links related ${r}`);
    }
});

test("front matter: a title and a summary no longer than the apps' validateGuide takes (120 and 300 characters)", () => {
    // The apps refuse a whole manual for one page over these (packages/beanpool-core member-guide.ts validate), so the
    // build refuses the page first: a summary of 331 characters once made the operator manual in Settings null (#1427).
    const page = (title, summary) => `---\nslug: a\ntitle: ${title}\nsummary: ${summary}\nrelated: b\n---\n\nText\n`;
    assert.equal(parseGuideMarkdown(page('T'.repeat(120), 'S'.repeat(300)), 'x.md').summary.length, 300);
    assert.throws(() => parseGuideMarkdown(page('T', 'S'.repeat(301)), 'x.md'), /summary is 301 characters; the apps take 300 at most/);
    assert.throws(() => parseGuideMarkdown(page('T'.repeat(121), 'S'), 'x.md'), /title is 121 characters; the apps take 120 at most/);
    for (const g of [...sourceGuides().guide.guides, ...sourceGuides().manual.guides]) {
        assert.ok(g.summary.length <= 300 && g.title.length <= 120, `${g.slug}: title ${g.title.length}, summary ${g.summary.length} characters`);
    }
});

test('front matter: related must name real pages, video must be a video id', () => {
    const fm = extra => `---\nslug: a\ntitle: T\nsummary: S\n${extra}---\n\nText\n`;
    assert.deepEqual(parseGuideMarkdown(fm('related: b, c\n'), 'x.md').related, ['b', 'c']);
    assert.equal(parseGuideMarkdown(fm('related: b\nvideo: tgsN2LiUVa0\n'), 'x.md').video, 'tgsN2LiUVa0');
    assert.throws(() => parseGuideMarkdown(fm(''), 'x.md'), /related/);
    assert.throws(() => parseGuideMarkdown(fm('related: a\n'), 'x.md'), /itself/);
    assert.throws(() => parseGuideMarkdown(fm('related: b\nvideo: https://youtu.be/x\n'), 'x.md'), /video/);
    assert.throws(() => parseGuideMarkdown(fm('related: b\nlink: x\n'), 'x.md'), /unknown/);
});

test('member-facing words: no internal names, no code words, beans not Ʀ, badges not tiers', () => {
    // English pages get every rule below; a translation (content/<lang>/…) only the ones that hold in any language: these
    // are English words (French "effectué" contains "effect"; "quorum" is plain Italian), each language's own words are
    // checked by the drafting round and its meaning checks.
    const files = fs.readdirSync(CONTENT_DIR, { recursive: true }).map(String).filter(f => f.endsWith('.md'));
    const isTranslation = (f) => GUIDE_LANGS.includes(f.split(path.sep)[0]);
    const join = (list) => list.map(f => fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8')).join('\n');
    const text = join(files.filter(f => !isTranslation(f))) + fs.readFileSync(path.join(CONTENT_DIR, 'manifest.json'), 'utf8');
    const translated = join(files.filter(isTranslation));
    assert.ok(translated.length > 0 || !files.some(isTranslation));
    for (const [re, why] of [[/Ʀ/, 'the currency is beans'], [/conservingTransaction|pubkey/i, 'internal or technical word']]) {
        const m = re.exec(translated);
        assert.equal(m, null, `found "${m?.[0]}" in a translated page — ${why}`);
    }
    const banned = [
        [/Ʀ/, 'the currency is beans'],
        [/\bnodes?\b/i, 'say "your community\'s server"'],
        [/conservingTransaction|escrow|quadratic|franchise|quorum|demurrage|treasury|pubkey|public key/i, 'internal or technical word'],
        [/Decision types?|effect|touches/i, 'internal Decision vocabulary'],
        [/\btiers?\b/i, 'call them trust badges'],
        [/\b(unlock|unlocks) at (Resident|Steward|Elder)\b/i, 'badges gate nothing'],
    ];
    for (const [re, why] of banned) {
        const m = re.exec(text);
        assert.equal(m, null, `found "${m?.[0]}" — ${why}`);
    }
});

test('§1.3: legacy vouching words and phrases are absent across the guide and operator manual', () => {
    const files = [
        ...fs.readdirSync(CONTENT_DIR, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(CONTENT_DIR, f)),
        ...fs.readdirSync(OPERATORS_DIR, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(OPERATORS_DIR, f)),
    ];
    const banned = [
        [/\bVouched in by\b/i, 'replaced by "Invited by" (§1.3)'],
        [/\bAppointed vouchers?\b/i, 'appointed vouchers term removed (§1.3)'],
        [/\bPromote\b(?:\*\*)?\s+and\s+(?:\*\*)?Demote\b/i, 'Promote and Demote removed (§1.3)'],
        [/\bgive or take away vouching\b/i, 'vouching decisions removed (§1.3)'],
        [/\bchoosing who may vouch\b/i, 'choosing who may vouch removed (§1.3)'],
        [/\bVouch for Member\b/i, 'old profile vouch button removed (§1.3)'],
        [/\bLight \(25\)/i, 'old preset names removed (§1.3)'],
        [/\b(give|gives|giving)\s+(?:a\s+member|members)\s+the\s+right\s+to\s+vouch\b/i, 'decision effect removed (§1.3)'],
        [/\b(take|takes|taking)\s+away\s+the\s+right\s+to\s+vouch\b/i, 'decision effect removed (§1.3)'],
        [/\b25, 50 or 100\b/i, 'presets are 25, 50, 75 or 100 (§4)'],
    ];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        for (const [re, why] of banned) {
            const m = re.exec(text);
            assert.equal(m, null, `found "${m?.[0]}" in ${path.relative(path.resolve(CONTENT_DIR, '..'), file)} — ${why}`);
        }
    }
});

test("a translated page stamped with the English hash has the English page's headings, in count and order, in every language", () => {
    // A translation's source-hash names the English it was drafted from. When it equals the English body hash, the apps and
    // the website show the page as current, with no "This page is newer in English" note. A stamp written over a page that
    // still lacks a section hides the gap from every reader (#2922's deciding pass: rules and polls, in all 24 languages),
    // so a page keeps its old stamp until the whole page is drafted.
    const bySlug = new Map(loadGuide(CONTENT_DIR).guides.map(g => [g.slug, g]));
    const headings = (page) => page.blocks.filter(b => b.type === 'h2' || b.type === 'h3').map(b => b.type);
    const wrong = [];
    let current = 0;
    for (const lang of GUIDE_LANGS) {
        const langDir = path.join(CONTENT_DIR, lang);
        if (!fs.existsSync(langDir)) continue;
        for (const f of fs.readdirSync(langDir, { recursive: true }).map(String).filter(f => f.endsWith('.md')).sort()) {
            const file = `content/${lang}/${f.split(path.sep).join('/')}`;
            const page = parseGuideMarkdown(fs.readFileSync(path.join(langDir, f), 'utf8'), file, { isTranslated: true });
            const english = bySlug.get(page.slug);
            if (!english || page.sourceHash !== guideBodyHash(english)) continue;
            current++;
            const want = headings(english);
            const got = headings(page);
            if (want.join() !== got.join()) {
                wrong.push(want.length === got.length
                    ? `${file}: stamped current, but its headings are in another order than the English page's`
                    : `${file}: stamped current, but it has ${got.length} headings where the English page has ${want.length}`);
            }
        }
    }
    assert.ok(current > 0, 'no translated page is stamped current, so this test checks nothing');
    assert.deepEqual(wrong, []);
});

test('parser: the supported subset', () => {
    const g = parseGuideMarkdown('---\nslug: a-b\ntitle: T\nsummary: S\nrelated: c\n---\n\n## H\n\nOne\ntwo **bold**.\n\n- x\n- y\n\n### Sub\n', 'x.md');
    assert.deepEqual(g.blocks, [
        { type: 'h2', text: 'H' },
        { type: 'p', text: 'One two **bold**.' },
        { type: 'ul', items: ['x', 'y'] },
        { type: 'h3', text: 'Sub' },
    ]);
});

test('parser: anything richer is an error, not silently printed', () => {
    const wrap = body => `---\nslug: a\ntitle: T\nsummary: S\nrelated: b\n---\n\n${body}\n`;
    for (const body of ['See [the site](https://x.org).', '<b>hi</b>', '1. first', '* star', '> quote', '# Title', '**open', '| a | b |', 'an *italic* word', '- item\n  more']) {
        assert.throws(() => parseGuideMarkdown(wrap(body), 'x.md'), undefined, body);
    }
    assert.throws(() => parseGuideMarkdown('no front matter', 'x.md'));
    assert.throws(() => parseGuideMarkdown('---\nslug: Bad Slug\ntitle: T\nsummary: S\nrelated: b\n---\n\nText\n', 'x.md'));
});

test('website rendering escapes text', () => {
    const guide = {
        schema: 2, version: 1, hash: 'h',
        sections: [{ id: 'about', title: 'About', summary: 'S', slugs: ['a', 'b'] }],
        guides: [
            { slug: 'a', title: 'A & B', summary: 'S', section: 'about', related: ['b'], blocks: [{ type: 'p', text: '1 < 2 and **bold**' }] },
            { slug: 'b', title: 'B', summary: 'S', section: 'about', related: ['a'], blocks: [{ type: 'p', text: 'x' }] },
        ],
    };
    const html = renderWebsite(guide)['a.html'];
    assert.ok(html.includes('<p>1 &lt; 2 and <strong>bold</strong></p>'));
    assert.ok(html.includes('<h1>A &amp; B</h1>'));
});

test('a text change changes the hash (which publishing turns into a higher version)', () => {
    const a = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'x' }] }];
    const b = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'y' }] }];
    assert.notEqual(contentHash(a), contentHash(b));
});

// ─── The operator manual (operators/) ─────────────────────────────────────────

/** The files under apps/website/guide/operators/, relative to it, sorted. */
const operatorWebsiteFiles = () => fs.readdirSync(OPERATORS_WEBSITE_DIR, { recursive: true, withFileTypes: true })
    .filter(d => d.isFile()).map(d => path.relative(OPERATORS_WEBSITE_DIR, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/')).sort();
const OPERATOR_WEBSITE_FILES = ['first-time-setup.html', 'images/cold-start.webp'];

test("only First-time setup of the operator manual is on the website: that page and its one picture, nothing else", () => {
    // The guard for Marty's decision of 2026-09-19: the manual ships in node Settings, and the website copy waits until
    // the security weak spots it describes are fixed. Reversed for First-time setup alone (pick 8, 2026-10-13). Widen
    // this only together with OPERATOR_PAGES_ON_WEBSITE in build.mjs.
    assert.deepEqual(OPERATOR_PAGES_ON_WEBSITE, ['first-time-setup'], 'only First-time setup is published until the brake weak spots are fixed');
    assert.deepEqual(operatorWebsiteFiles(), OPERATOR_WEBSITE_FILES,
        'apps/website/guide/operators/ holds only First-time setup and its picture (Marty, 2026-09-19; pick 8, 2026-10-13)');
    const { out, manual } = expectedOutputs();
    assert.deepEqual(Object.keys(out).filter(f => f.startsWith(OPERATORS_WEBSITE_DIR + path.sep))
        .map(f => path.relative(OPERATORS_WEBSITE_DIR, f).split(path.sep).join('/')).sort(), OPERATOR_WEBSITE_FILES);
    // The published page links no other operator page, no operator index, and carries no copy of the whole manual.
    const page = fs.readFileSync(path.join(OPERATORS_WEBSITE_DIR, 'first-time-setup.html'), 'utf8');
    for (const g of manual.guides.filter(p => p.slug !== 'first-time-setup')) {
        assert.ok(!page.includes(`href="${g.slug}.html"`), `first-time-setup.html links the unpublished ${g.slug}`);
    }
    assert.ok(!page.includes('href="index.html"'), 'first-time-setup.html links no operator index');
    assert.ok(page.includes('<li><strong>Signing in to Settings</strong> (in Settings, under Manual)</li>'), 'an unpublished Related page is named, not linked');
    assert.ok(page.includes('<img src="images/cold-start.webp"'), 'first-time-setup.html shows its picture');
    assert.ok(page.includes('beanpool claim'), 'first-time-setup.html walks the claim');
    assert.ok(fs.readFileSync(path.join(OPERATORS_WEBSITE_DIR, 'images/cold-start.webp')).equals(fs.readFileSync(path.join(OPERATORS_DIR, 'images/cold-start.webp'))),
        'the picture is the bytes Settings shows');
    const members = fs.readFileSync(path.join(WEBSITE_DIR, 'index.html'), 'utf8');
    assert.ok(!members.includes('operators/'), "the members' guide links no operator pages");
    assert.ok(members.includes("Its manual is in your server's Settings"), "the members' guide says where the manual is");
    for (const f of fs.readdirSync(WEBSITE_DIR)) {
        if (f.endsWith('.html') || f.endsWith('.json')) {
            assert.ok(!fs.readFileSync(path.join(WEBSITE_DIR, f), 'utf8').includes('guide/operators'), `${f} points at guide/operators`);
        }
    }
});

test("the operator manual: Settings' bundled operators.json is well formed", () => {
    const manual = JSON.parse(fs.readFileSync(OPERATORS_JSON, 'utf8'));
    assert.equal(manual.schema, GUIDE_SCHEMA);
    assert.equal(manual.hash, contentHash({ sections: manual.sections, guides: manual.guides }));
});

test("the operator manual is a separate collection: the members' guide carries none of its pages", () => {
    const { guide, manual } = sourceGuides();
    const memberSlugs = new Set(guide.guides.map(g => g.slug));
    // Distinct slugs, so a page name never means two different pages in search results or links.
    for (const p of manual.guides) {
        assert.ok(!memberSlugs.has(p.slug), `${p.slug} is in both collections`);
    }
});

test('the operator manual covers what an operator needs, and the website renderer, given every page, lists and renders them all', () => {
    const slugs = new Set(sourceGuides().manual.guides.map(g => g.slug));
    for (const want of ['first-time-setup', 'signing-in', 'roles', 'members-and-invites', 'reports-and-takedowns', 'disputes',
        'decisions-and-emergencies', 'enterprises-and-keepers', 'pulse-and-announcements', 'backups-and-replicas',
        'updates-and-health', 'rate-limits', 'what-the-server-sees', 'feedback', 'troubleshooting']) {
        assert.ok(slugs.has(want), `operator page ${want}`);
    }
    // Rendered in memory: the renderer is kept working for the day the website copy is switched on.
    const { manual } = expectedOutputs();
    const site = renderOperatorsWebsite(manual);
    assert.equal(site['operators.json'], fs.readFileSync(OPERATORS_JSON, 'utf8'), "the website's operators.json would be Settings' bytes");
    const index = site['index.html'];
    for (const s of manual.sections) assert.ok(index.includes(`href="#${s.id}"`), `contents links ${s.id}`);
    for (const g of manual.guides) {
        assert.ok(index.includes(`href="${g.slug}.html"`), `index links ${g.slug}`);
        const html = site[`${g.slug}.html`].replace(/<\/?strong>/g, '');
        for (const b of g.blocks) {
            if (b.type === 'img') {
                assert.ok(html.includes(`<img src="${b.src}"`), `${g.slug}.html renders img ${b.src}`);
                if (b.href) {
                    assert.ok(html.includes(`<a href="${b.href}.html">`), `${g.slug}.html links img to ${b.href}`);
                }
                continue;
            }
            for (const t of b.type === 'ul' ? b.items : [b.text]) {
                const firstWords = t.replace(/\*\*/g, '').split(' ').slice(0, 4).join(' ')
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                assert.ok(html.includes(firstWords), `${g.slug}.html is missing "${firstWords}"`);
            }
        }
        for (const r of g.related) assert.ok(html.includes(`href="${r}.html"`), `${g.slug}.html links related ${r}`);
        // The site's stylesheet and home page sit two folders up.
        assert.ok(html.includes('href="../../style.css'), `${g.slug}.html finds the stylesheet`);
    }
    const members = renderWebsite(expectedOutputs().guide, { operatorManualOnWeb: true })['index.html'];
    assert.ok(members.includes('href="operators/index.html"'), "once published, the members' guide links the operator manual");
});

test('the website renderer, given some pages, writes only those and names the rest without linking them', () => {
    const { manual } = expectedOutputs();
    // Settings map links a picture to nearly every page: a good test of pictures pointing at unpublished pages.
    const only = ['settings-map', 'the-settings-screens'];
    const site = renderOperatorsWebsite(manual, { only });
    assert.deepEqual(Object.keys(site).sort(), ['settings-map.html', 'the-settings-screens.html'], 'no index, no operators.json, no other page');
    const map = manual.guides.find(g => g.slug === 'settings-map');
    const html = site['settings-map.html'];
    const linked = map.blocks.filter(b => b.type === 'img' && b.href);
    assert.ok(linked.some(b => !only.includes(b.href)) && linked.some(b => only.includes(b.href)), 'the test page links both kinds');
    for (const b of linked) {
        assert.ok(html.includes(`<img src="${b.src}"`), `renders img ${b.src}`);
        assert.equal(html.includes(`<a href="${b.href}.html">`), only.includes(b.href), `img ${b.src} links ${b.href} only if it is published`);
    }
    for (const slug of map.related) {
        const r = manual.guides.find(g => g.slug === slug);
        assert.equal(html.includes(`href="${slug}.html"`), only.includes(slug), `Related ${slug} is a link only if it is published`);
        if (!only.includes(slug)) assert.ok(html.includes(`<strong>${r.title}</strong> (in Settings, under Manual)`), `Related ${slug} is named`);
    }
    assert.ok(!html.includes('href="index.html"'), 'no link to an operator index that is not there');
    assert.ok(html.includes('Only this part of it is on the website'), 'the foot says the rest is in Settings');
    assert.throws(() => renderOperatorsWebsite(manual, { only: ['no-such-page'] }), /no page "no-such-page"/);
});

test('operator words: beans not Ʀ, badges gate nothing', () => {
    const text = fs.readdirSync(OPERATORS_DIR, { recursive: true }).filter(f => String(f).endsWith('.md'))
        .map(f => fs.readFileSync(path.join(OPERATORS_DIR, String(f)), 'utf8')).join('\n')
        + fs.readFileSync(path.join(OPERATORS_DIR, 'manifest.json'), 'utf8');
    for (const [re, why] of [
        [/Ʀ/, 'the currency is beans'],
        [/\btiers?\b/i, 'call them trust badges'],
        [/\b(unlock|unlocks|requires?) (the )?(Resident|Steward|Elder)\b/i, 'badges gate nothing'],
    ]) {
        const m = re.exec(text);
        assert.equal(m, null, `found "${m?.[0]}" — ${why}`);
    }
});

// Design case 19 (DESIGN-standby-pin-fable.md D5, D6 P3): a standby's main server is pinned from its own shell with a
// pairing code (beanpool pair); there is no mirror link, and a bare token never pairs one.
test('operator words: a standby is paired from its shell, never by a mirror connector or a token given to it', () => {
    for (const f of fs.readdirSync(OPERATORS_DIR, { recursive: true }).filter(f => String(f).endsWith('.md'))) {
        const text = fs.readFileSync(path.join(OPERATORS_DIR, String(f)), 'utf8').replace(/\*\*/g, '').replace(/\s+/g, ' ');
        for (const gone of [/mirror connector/i, /give it the token/i]) {
            const m = gone.exec(text);
            assert.equal(m, null, `${f} says "${m?.[0]}": a standby is paired with beanpool pair and a pairing code`);
        }
    }
    const { manual } = sourceGuides();
    const page = manual.guides.find((g) => g.slug === 'backups-and-replicas');
    const words = page.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).join('\n').replace(/\*\*/g, '');
    for (const said of ['docker compose exec beanpool-node beanpool pair', 'beanpool pair --follow-new-server', 'Which server a standby trusts',
        'A take-over needs no new pairing']) {
        assert.ok(words.includes(said), `backups-and-replicas says: ${said}`);
    }
});

// Review 4302869943: docker compose restart keeps the container's old environment, so a change to .env takes
// docker compose up -d. A paragraph that changes .env (or the server's environment) never says to restart instead.
test('operator words: a change to .env is applied with docker compose up -d, never a restart', () => {
    const restartStep = /\brestart (the server|the standby|it|again)\b|\band restart\b|docker compose restart/i;
    const said = [];
    for (const f of fs.readdirSync(OPERATORS_DIR, { recursive: true }).filter(f => String(f).endsWith('.md'))) {
        for (const paragraph of fs.readFileSync(path.join(OPERATORS_DIR, String(f)), 'utf8').split('\n')) {
            if (!/\.env\b|server's environment/.test(paragraph)) continue;
            const m = restartStep.exec(paragraph.replace(/\*\*/g, ''));
            if (m) said.push(`${f}: "${m[0]}"`);
        }
    }
    assert.deepEqual(said, [], 'after a change to .env, say docker compose up -d: a restart keeps the old setting');
    const { manual } = sourceGuides();
    const page = manual.guides.find((g) => g.slug === 'showcase');
    const words = page.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).join('\n').replace(/\*\*/g, '');
    for (const step of ['GLOBAL_COMMUNITY_URL=https://global.example.org, and run docker compose up -d',
        'set GLOBAL_COMMUNITY_URL=off and run docker compose up -d']) {
        assert.ok(words.includes(step), `showcase says: ${step}`);
    }
});

test('the operator manual has no concept-guide section; the members\' guide still must', () => {
    const { manual } = sourceGuides();
    assert.ok(!manual.sections.some(s => s.id === 'about'));
    assert.throws(() => loadGuide(OPERATORS_DIR), /needs the "about" section/);
});

test('check() reports a stray file in the website folder, including any operator page that is not published', () => {
    const existed = fs.existsSync(OPERATORS_WEBSITE_DIR);
    fs.mkdirSync(OPERATORS_WEBSITE_DIR, { recursive: true });
    const stray = path.join(OPERATORS_WEBSITE_DIR, 'signing-in.html');
    fs.writeFileSync(stray, 'x');
    try {
        assert.ok(check().some(p => p.includes('operators/signing-in.html')));
    } finally {
        fs.rmSync(stray);
        if (!existed) fs.rmSync(OPERATORS_WEBSITE_DIR, { recursive: true });
    }
});

test('parser: inline images and linked images', () => {
    const wrap = body => `---\nslug: a\ntitle: T\nsummary: S\nrelated: b\n---\n\n${body}\n`;
    const g = parseGuideMarkdown(wrap('![My screenshot](images/pic.webp)\n\n[![Linked screenshot](images/link.webp)](target-page)'), 'x.md', { allowImages: true });
    assert.deepEqual(g.blocks, [
        { type: 'img', src: 'images/pic.webp', alt: 'My screenshot' },
        { type: 'img', src: 'images/link.webp', alt: 'Linked screenshot', href: 'target-page' },
    ]);
});

test('images are rejected in members\' guide markdown', () => {
    const wrap = body => `---\nslug: a\ntitle: T\nsummary: S\nrelated: b\n---\n\n${body}\n`;
    assert.throws(
        () => parseGuideMarkdown(wrap('![Screenshot](images/pic.webp)'), 'content/a.md'),
        /images are only allowed in the operator manual/
    );
    assert.throws(
        () => parseGuideMarkdown(wrap('[![Screenshot](images/pic.webp)](other)'), 'content/a.md'),
        /images are only allowed in the operator manual/
    );
});

test("the members' guide build fails on a page with a picture", () => {
    const tmp = fs.mkdtempSync(path.join(path.dirname(CONTENT_DIR), 'tmp-guide-test-'));
    try {
        fs.cpSync(CONTENT_DIR, tmp, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
        const sec = manifest.sections[0];
        const file = path.join(tmp, sec.id, `${sec.pages[0]}.md`);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + '\n![A screenshot](images/pic.webp)\n');
        assert.doesNotThrow(() => loadGuide(CONTENT_DIR));
        assert.throws(() => loadGuide(tmp),
            new RegExp(`${sec.id}/${sec.pages[0]}\\.md:\\d+: images are only allowed in the operator manual`));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('validation: referenced image must exist on disk and linked href must be a valid slug', () => {
    const tmp = fs.mkdtempSync(path.join(path.dirname(OPERATORS_DIR), 'tmp-guide-test-'));
    try {
        fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
            sections: [{ id: 'sec', title: 'Sec', summary: 'Summary', pages: ['p1', 'p2'] }]
        }));
        fs.mkdirSync(path.join(tmp, 'sec'));
        fs.writeFileSync(path.join(tmp, 'sec', 'p2.md'),
            '---\nslug: p2\ntitle: P2\nsummary: S\nrelated: p1\n---\n\nText\n');
        // 1. Missing image
        fs.writeFileSync(path.join(tmp, 'sec', 'p1.md'),
            '---\nslug: p1\ntitle: P1\nsummary: S\nrelated: p2\n---\n\n![Missing](images/missing.webp)\n');
        assert.throws(() => loadGuide(tmp, { aboutSection: null, allowImages: true }), /image "images\/missing\.webp" does not exist/);

        // 2. Image exists, but invalid linked href
        fs.mkdirSync(path.join(tmp, 'images'));
        fs.writeFileSync(path.join(tmp, 'images', 'pic.webp'), 'fake-bytes');
        fs.writeFileSync(path.join(tmp, 'sec', 'p1.md'),
            '---\nslug: p1\ntitle: P1\nsummary: S\nrelated: p2\n---\n\n[![Linked](images/pic.webp)](non-existent-slug)\n');
        assert.throws(() => loadGuide(tmp, { aboutSection: null, allowImages: true }), /linked image target "non-existent-slug" does not exist/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('website has no operator images and no operator content but First-time setup and its picture', () => {
    const webFiles = fs.readdirSync(WEBSITE_DIR, { recursive: true, withFileTypes: true }).filter(d => d.isFile())
        .map(d => path.relative(WEBSITE_DIR, path.join(d.parentPath ?? d.path, d.name)).split(path.sep).join('/'));
    assert.deepEqual(webFiles.filter(f => f.includes('operators')).sort(), OPERATOR_WEBSITE_FILES.map(f => `operators/${f}`), 'only First-time setup in the website folder');
    assert.deepEqual(webFiles.filter(f => f.endsWith('.webp')), ['operators/images/cold-start.webp'], "only First-time setup's picture in the website folder");
});

// ─── Versions: set when the director publishes, never in a manifest ───────────

test('a manifest that holds "version" is refused: a version is set when the collection is published', () => {
    const tmp = fs.mkdtempSync(path.join(path.dirname(OPERATORS_DIR), 'tmp-guide-test-'));
    try {
        fs.cpSync(OPERATORS_DIR, tmp, { recursive: true });
        const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
        fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ version: 76, ...manifest }, null, 2));
        assert.throws(() => loadGuide(tmp, { aboutSection: null, allowImages: true }), /remove "version"/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('publishing raises a version by one exactly where the text or its schema changed, and starts a new collection at 1', async () => {
    const { nextPublished, publishedGuides } = await import('../scripts/build.mjs');
    const published = publishedGuides();
    const asPages = g => ({ ...structuredClone(g), version: null });
    assert.deepEqual(nextPublished(published, { guide: asPages(published.guide), manual: asPages(published.manual) }), published);

    const edited = asPages(published.guide);
    edited.guides[0].blocks = [{ type: 'p', text: 'Changed.' }];
    edited.hash = contentHash({ sections: edited.sections, guides: edited.guides });
    const next = nextPublished(published, { guide: edited, manual: asPages(published.manual) });
    assert.equal(next.guide.version, published.guide.version + 1);
    assert.deepEqual(next.guide.guides[0].blocks, [{ type: 'p', text: 'Changed.' }]);
    assert.deepEqual(next.manual, published.manual);

    const reshaped = { ...asPages(published.manual), schema: published.manual.schema + 1 };
    assert.equal(nextPublished(published, { guide: asPages(published.guide), manual: reshaped }).manual.version, published.manual.version + 1);
    assert.equal(nextPublished({ guide: null, manual: published.manual }, { guide: edited, manual: asPages(published.manual) }).guide.version, 1);
});


// The names list's trust model (scratch/global-node/DESIGN-names-list-trust-fable.md §9, matrix F6): its pages say exactly
// the design's sentences, true under its proof, and none of the promises the earlier model made.
test("the names list's pages say the design's sentences, and none of the old promises", () => {
    const { guide, manual } = sourceGuides();
    const words = (g) => g.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).join('\n').replace(/\*\*/g, '');
    const operators = words(manual.guides.find((g) => g.slug === 'running-a-known-community'));
    const members = words(guide.guides.find((g) => g.slug === 'what-the-admins-can-see'));
    for (const sentence of [
        "Only your owners and admins can read the names, on their own phones. Each name is sealed on an admin's phone before it is sent. A backup, a snapshot, a standby's copy, a stolen database and BeanPool hold nothing readable.",
        "Whoever runs the server can change what it stores and what it tells each phone, and with the owner password can make any key an admin or move an account to a new key. The admins' phones don't take its word: a phone gives the list's keys only to a key its admin checked, on a call or in person, or that an admin it trusts checked, and takes a new key only from such a key. Whoever runs the server can stop the list from working, delete it, and see who opened it and when. On its own it can't read a name. It needs an admin to check the wrong phone's code, or an admin who was removed to work with it (below).",
        // The fifth deciding review's BLOCKING finding (52e1a759), in the design addendum's (e) words: the new key protects
        // what the phones that took it write, and the limit is per phone.
        "When an admin stops being one, the next admin who holds the keys to open the list makes a new key without them, and their phone sends it to the other admins. Nothing written from then on by a phone that has taken the new key can be read with the keys the person had. What they already saw, they keep, as with a paper list.",
        "When an admin loses their phone, tell another admin the same day: they tap Remove @X's old key. Until that is done, whoever has the phone can read what is written. The admin's new phone's code is checked once, on a call or in person, and the keys are sent to it. Names written under a key that only the lost phone held can't be opened by anyone: the app counts them, and your paper copy is how they come back.",
        "What this doesn't protect against: checking the wrong person's phone (your phone then trusts their key and sends them the names); an admin's phone someone else gets into; a lost phone before an admin removes its key; a PDF or a note an admin writes; and an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had.",
        // Design Addendum 2 (§3): the removal check is Remove by hand; the comparison only shows two phones are shown different things.
        "Every admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, each admin looks at the admins their phone shows: a phone that still shows the removed admin taps Remove @X's old key. Whatever the server says, that phone then makes a new key without them or writes nothing. Two phones that show different list keys are being shown different things: add no names until they match, and tell your admins.",
        // The design addendum's (e): the vouched history gives a way forward through any admin whose phone opens the list.
        // Round 12: a phone keeps the keys it takes, for the history it follows (B8, H3).
        "Each name stays sealed under the key it was written with, and every admin's phone keeps every key it takes for the key history it follows.",
        // Design Addendum 4 (§4): the stop at a maker this phone had removed, and Follow from it.
        "A key made by someone no admin your phone trusts has checked. Check codes with that admin, or with an admin whose phone already opens the list, on a call or in person. If your phone had removed that admin's key, checking their phone admits them again; checking another admin's phone doesn't, and your phone then makes a new key without them before it writes. Where nobody can be reached, a phone that has opened the list before can tap Follow the server's history: your phone takes the key for its place only, trusts nobody new, and, if it had removed an admin and the key that removed them isn't in the server's history, makes a new key without them before it writes.",
        "Whenever a phone opens the list and names it saw before are no longer there, and the log shows no admin deleting them, it says how many. A server put back to an older copy does that, and so does a standby that took over from one, whether or not a key changed in between. The missing names are sealed rows that may still be on the other copy: whoever runs the servers can copy them back, and the admins' phones still hold the keys they were written under, so they open again. Otherwise, the paper copy.",
        // Design Addendum 3 (§5): Follow the server's history replaces Take @name's history; the standby paragraph names it.
        "The server shows a key history your phone didn't take. A standby that took over from an older copy, where an admin's phone then made a new key, does that; so does whoever runs the server changing the history. Ask your admins what happened. Tap Follow the server's history: your phone keeps the other history's keys, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them. An admin your phone had removed stays removed: unless the key that removed them on your phone is in the server's history, your phone makes a new key without them before it writes.",
        "If the standby's copy was older than the main server's, the phones say how many names are missing; if the key history is older too, they say so and can put it back. If an admin's phone made a new key on the standby first, the other phones say the server shows a different key history and offer to follow it (see When the app refuses).",
        // Decided with the design (§12 Q3): the 12 words alone don't make a lost phone safe.
        "The 12 words alone aren't enough for an admin whose phone was lost",
        // Round 15 (Marty, 2026-10-03): admins check each other at a distance; the code is read out on a call, or scanned together.
        "Admins trust each other by checking each other's code. You don't need to meet. Open the names list on both phones and tap Check an admin's code (or Check @name's code). Each phone shows its own key as a QR code and 20 digits. On a call, read your 20 digits out and type in theirs; if you're together, scan each other's QR code instead. Do it only when you know it's the other admin you're talking to.",
        "Make them an admin first, then check each other's code once, on a call or in person.",
    ]) assert.ok(operators.includes(sentence), `running-a-known-community says: ${sentence.slice(0, 70)}…`);
    assert.ok(members.includes("Whoever runs the server can't read it. The admins' phones give the list's keys only to admins whose phones another admin has checked, on a call or in person, and take new keys only from them. That rests on the admins: an admin who checks the wrong person's phone, an admin's phone someone gets into, or a lost phone before the admins remove its key, can let someone else read the names. So can an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had. An admin whose phone still shows the removed admin removes their key by hand, and that phone then makes a new key without them or writes nothing."),
        'what-the-admins-can-see says the members\' sentence');
    for (const gone of [/remembers it/i, /first (use|time a phone opens)/i, /whoever (first )?shares/i, /carried over/i, /seals? (every entry|them) again/i, /sealed again under/i,
        /any admin can (\*\*)?start a new key/i, /working with whoever runs/i, /removed admin working with/i,
        /can't read a name without an admin checking the wrong phone/i, /Nothing written from then on can be read/i,
        /To be sure, meet another admin and compare the list key/i, /they should show the same one/i,
        /Admins check for that by meeting and comparing their phones/i, /for reading only/i, /stay on it, for reading/i,
        /every admin's phone holds every key it was sent/i,
        /Take @/, /take their history/i, /an admin whose phone has the server's history can (check yours|meet you)/i, /only at a meeting/i,
        // Round 15: no sentence asks admins to meet; a check is on a call or in person.
        /by meeting/i, /\bmeet (that|and|every|them|one|an|@)/i, /in front of you/i, /(?<!on a call or )in person/i,
        // Round 16 (:40): "Check each other" is the check screen's title, not a button; the button is Check an admin's code.
        /tap Check each other/i]) {
        assert.doesNotMatch(`${operators}\n${members}`, gone);
    }
});

test("no page promises a community's answers line before the directory carries it (front doors S1; S13 adds it)", () => {
    // The live directory drops the `answers` field and no screen shows it yet (director, 27 Oct): no guide page may say
    // a card shows how promptly a community answers, nor the operator rule behind it, until S13 ships them together.
    const { guide, manual } = sourceGuides();
    const words = (g) => g.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).join('\n').replace(/\*\*/g, '');
    const said = [...guide.guides, ...manual.guides]
        .filter((g) => /answers within a week|answered requests lately|how promptly/i.test(words(g)))
        .map((g) => g.slug);
    assert.deepEqual(said, []);
});

test("Find your community's pin is described as decided (Lounge L1, Fable 29 Oct 2026): a waiting request or a watch, then Got it; no \"No answer came\"", () => {
    const { guide } = sourceGuides();
    const words = (g) => g.blocks.flatMap((b) => (b.type === 'ul' ? b.items : [b.text])).join('\n');
    const decided = "After your first 30 days it stays while a request to join is waiting for an answer or you have a watch for a community near you. When a community no longer holds your request, the card says so; tap **Got it** and the card can be moved or removed again.";
    for (const slug of ['home', 'finding-a-community']) {
        const page = guide.guides.find((g) => g.slug === slug);
        assert.ok(page, `${slug} is a page`);
        assert.ok(words(page).includes(decided), `${slug} says the decided sentences`);
    }
    // The community's own card says the same line as the Home card now (KNOCK_MESSAGES.none); the old one is retired everywhere.
    assert.ok(words(guide.guides.find((g) => g.slug === 'finding-a-community')).includes('**This request is no longer open. You can ask again.**'));
    const retired = guide.guides.filter((g) => /No answer came|for as long as (you have )?an open request|is open; with neither/i.test(words(g))).map((g) => g.slug);
    assert.deepEqual(retired, []);
});

test('invites I3: the two old inviter sentences are absent from every page; privacy names the role word, the card and the hide switch', () => {
    // "Invited directly by the system admin" was a server bug (it hid any inviter with a node role), and "Vetted by the
    // admin at sign-up" went with it. Every page, in every language folder and the operator manual, is read.
    const files = [
        ...fs.readdirSync(CONTENT_DIR, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(CONTENT_DIR, f)),
        ...fs.readdirSync(OPERATORS_DIR, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(OPERATORS_DIR, f)),
    ];
    assert.ok(files.length > 100, `read ${files.length} pages`);
    const found = [];
    for (const file of files) {
        const text = fs.readFileSync(file, 'utf8').replace(/\*\*/g, '');
        for (const gone of [/invited directly by the system admin/i, /vetted by the admin at sign-up/i]) {
            if (gone.test(text)) found.push(`${path.relative(path.resolve(CONTENT_DIR, '..'), file)}: ${gone.source}`);
        }
    }
    assert.deepEqual(found, []);
    const privacy = fs.readFileSync(path.join(CONTENT_DIR, 'settings', 'privacy.md'), 'utf8');
    assert.ok(privacy.includes('**Invited by marty · owner**'), 'privacy names the role word');
    assert.ok(privacy.includes('**Invited with an owner’s invite card**'), 'privacy names the owner\'s invite card');
    assert.ok(privacy.includes('**Show who invited me to other members**'), 'privacy names the hide switch');
    // Who you brought in (I3 round 2): any member reads the invite tree (GET /api/invite/tree; the web's Invites, Tree),
    // so the page must not say only you, the owners and the admins see the people you invited.
    const broughtIn = privacy.split('\n').find(l => l.startsWith('- **Who you brought in:**')) ?? '';
    assert.ok(broughtIn, 'privacy has the Who you brought in bullet');
    assert.doesNotMatch(broughtIn, /Only you, the owners and the admins see it/);
    assert.match(broughtIn, /any member can open the invite tree/);
    assert.match(broughtIn, /\*\*Invites\*\*, then \*\*Tree\*\*/);
});

test('the manual names no removed button, page or route (owner-delete: no wipe, no snapshot delete, no legacy page, restore from the shell)', () => {
    const gone = ['Wipe & Reset', 'Factory reset', 'Delete snapshot', 'Legacy Settings', '/settings-legacy', '/api/local/admin/restore'];
    const pages = fs.readdirSync(OPERATORS_DIR, { recursive: true }).filter(f => String(f).endsWith('.md'));
    assert.ok(pages.length > 20, `found ${pages.length} manual pages`);
    const found = [];
    for (const f of pages) {
        const text = fs.readFileSync(path.join(OPERATORS_DIR, f), 'utf8').toLowerCase();
        for (const w of gone) if (text.includes(w.toLowerCase())) found.push(`${f}: ${w}`);
    }
    assert.deepEqual(found, []);
});

test('translated page front matter: source-hash must be 16 hex digits, required when isTranslated', () => {
    const valid = [
        '---',
        'slug: home',
        'title: Inicio',
        'summary: Un resumen en español.',
        'related: rules',
        'source-hash: 0123456789abcdef',
        '---',
        '',
        'El cuerpo de la página.',
    ].join('\n');
    const parsed = parseGuideMarkdown(valid, 'es/getting-started/home.md', { isTranslated: true });
    assert.equal(parsed.slug, 'home');
    assert.equal(parsed.title, 'Inicio');
    assert.equal(parsed.sourceHash, '0123456789abcdef');
    assert.equal(parsed['source-hash'], '0123456789abcdef');

    // Missing source-hash
    const missingHash = valid.replace('source-hash: 0123456789abcdef\n', '');
    assert.throws(() => parseGuideMarkdown(missingHash, 'es/getting-started/home.md', { isTranslated: true }), /front matter needs "source-hash"/);

    // Invalid source-hash format
    const badHash = valid.replace('0123456789abcdef', 'not-a-hex-hash');
    assert.throws(() => parseGuideMarkdown(badHash, 'es/getting-started/home.md', { isTranslated: true }), /"source-hash" must be 16 hex digits/);

    const shortHash = valid.replace('0123456789abcdef', '01234567');
    assert.throws(() => parseGuideMarkdown(shortHash, 'es/getting-started/home.md', { isTranslated: true }), /"source-hash" must be 16 hex digits/);

    // Unknown front matter field
    const unknownField = valid.replace('---', '---\nextra: value');
    assert.throws(() => parseGuideMarkdown(unknownField, 'es/getting-started/home.md', { isTranslated: true }), /unknown front matter "extra"/);
});

test('checkLanguagePages validates structure, slugs, source-hash and related links', () => {
    const englishGuide = loadGuide(CONTENT_DIR);
    const homePage = englishGuide.guides.find(g => g.slug === 'home');
    const validHash = guideBodyHash(homePage);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-lang-check-'));
    try {
        const esDir = path.join(dir, 'es');
        fs.mkdirSync(path.join(esDir, 'getting-started'), { recursive: true });
        fs.writeFileSync(path.join(esDir, 'manifest.json'), '{ "sections": {}, "pages": {} }');

        // Valid page
        const pageContent = [
            '---',
            'slug: home',
            'title: Inicio',
            'summary: Resumen.',
            'related: rules',
            `source-hash: ${validHash}`,
            '---',
            '',
            'Cuerpo.',
        ].join('\n');
        fs.writeFileSync(path.join(esDir, 'getting-started', 'home.md'), pageContent);

        assert.deepEqual(checkLanguagePages(dir, 'es', englishGuide), []);

        // Stray file directly in language folder
        fs.writeFileSync(path.join(esDir, 'random.txt'), 'hello');
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /random\.txt: a language's folder holds only manifest\.json/);
        fs.rmSync(path.join(esDir, 'random.txt'));

        // Invalid section name
        fs.mkdirSync(path.join(esDir, 'non-existent-section'), { recursive: true });
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /"non-existent-section" is not a section in the guide/);
        fs.rmSync(path.join(esDir, 'non-existent-section'), { recursive: true });

        // Non-.md file in section folder
        fs.writeFileSync(path.join(esDir, 'getting-started', 'notes.txt'), 'notes');
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /only \.md files are allowed/);
        fs.rmSync(path.join(esDir, 'getting-started', 'notes.txt'));

        // Slug not in that section
        fs.writeFileSync(path.join(esDir, 'getting-started', 'rules.md'), pageContent.replace('slug: home', 'slug: rules'));
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /"rules" is not a page in section "getting-started"/);
        fs.rmSync(path.join(esDir, 'getting-started', 'rules.md'));

        // Slug mismatch between filename and front matter
        fs.writeFileSync(path.join(esDir, 'getting-started', 'home.md'), pageContent.replace('slug: home', 'slug: faq'));
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /slug "faq" must match the file name "home"/);

        // Invalid related page
        fs.writeFileSync(path.join(esDir, 'getting-started', 'home.md'), pageContent.replace('related: rules', 'related: non-existent-page'));
        assert.match(checkLanguagePages(dir, 'es', englishGuide)[0], /related page "non-existent-page" does not exist in the guide/);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadLanguagePages and renderLanguageWebsite render HTML and guide.json, showing stale note when behind', () => {
    const englishGuide = loadGuide(CONTENT_DIR);
    const homePage = englishGuide.guides.find(g => g.slug === 'home');
    const validHash = guideBodyHash(homePage);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-lang-render-'));
    try {
        const ruDir = path.join(dir, 'ru');
        fs.mkdirSync(path.join(ruDir, 'getting-started'), { recursive: true });
        fs.writeFileSync(path.join(ruDir, 'manifest.json'), '{ "sections": {}, "pages": {} }');

        // Page with older source-hash (stale/behind)
        const staleHash = '0000000000000000';
        const pageContent = [
            '---',
            'slug: home',
            'title: Главная',
            'summary: Описание.',
            'related: rules',
            `source-hash: ${staleHash}`,
            '---',
            '',
            'Текст на русском.',
        ].join('\n');
        fs.writeFileSync(path.join(ruDir, 'getting-started', 'home.md'), pageContent);

        const loaded = loadLanguagePages(dir, 'ru', englishGuide, { version: 1 });
        assert.ok(loaded);
        assert.equal(loaded.language, 'ru');
        assert.equal(loaded.version, 1);
        assert.equal(loaded.guides.length, 1);
        assert.equal(loaded.guides[0].slug, 'home');
        assert.equal(loaded.guides[0].sourceHash, staleHash);

        const rendered = renderLanguageWebsite(loaded, englishGuide);
        assert.ok(rendered['guide.json']);
        assert.ok(rendered['home.html']);
        assert.ok(rendered['home.html'].includes('<html lang="ru">'));
        assert.ok(rendered['home.html'].includes('This page is newer in English.'));
        assert.ok(rendered['home.html'].includes('Текст на русском.'));
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadLanguagePages preserves canonical section and slug order defined by englishGuide', () => {
    const englishGuide = loadGuide(CONTENT_DIR);
    const firstSec = englishGuide.sections[0];
    const secondSec = englishGuide.sections[1];
    if (!firstSec || !secondSec || firstSec.slugs.length < 2) return;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-lang-order-'));
    try {
        const ptDir = path.join(dir, 'pt');
        // Intentionally create second section first on filesystem
        fs.mkdirSync(path.join(ptDir, secondSec.id), { recursive: true });
        fs.mkdirSync(path.join(ptDir, firstSec.id), { recursive: true });

        const makePage = (slug, related) => [
            '---',
            `slug: ${slug}`,
            `title: Título ${slug}`,
            'summary: Resumo.',
            `related: ${related}`,
            'source-hash: 0123456789abcdef',
            '---',
            '',
            `Texto de ${slug}.`,
        ].join('\n');

        // Intentionally write slugs in reverse order
        const [s1, s2] = [firstSec.slugs[0], firstSec.slugs[1]];
        fs.writeFileSync(path.join(ptDir, firstSec.id, `${s2}.md`), makePage(s2, s1));
        fs.writeFileSync(path.join(ptDir, firstSec.id, `${s1}.md`), makePage(s1, s2));
        const s3 = secondSec.slugs[0];
        fs.writeFileSync(path.join(ptDir, secondSec.id, `${s3}.md`), makePage(s3, s1));

        const loaded = loadLanguagePages(dir, 'pt', englishGuide, { version: 1 });
        assert.ok(loaded);
        // Sections must match english order
        assert.deepEqual(loaded.sections.map(s => s.id), [firstSec.id, secondSec.id]);
        // Slugs in first section must match english order, not alphabetical or creation order
        assert.deepEqual(loaded.sections[0].slugs, [s1, s2]);
        assert.deepEqual(loaded.guides.map(g => g.slug), [s1, s2, s3]);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loadLanguagePages falls back to English section title and summary when manifest translations are stale', () => {
    const englishGuide = loadGuide(CONTENT_DIR);
    const sec = englishGuide.sections[0];
    const slug = sec.slugs[0];

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-lang-titles-'));
    try {
        const esDir = path.join(dir, 'es');
        fs.mkdirSync(path.join(esDir, sec.id), { recursive: true });

        // manifest with a fresh title translation and a stale summary translation
        const manifest = {
            sections: {
                [sec.id]: {
                    title: { text: 'Título Traducido', sourceHash: guideSourceHash(sec.title) },
                    summary: { text: 'Resumen Obsoleto', sourceHash: '0000000000000000' },
                },
            },
            pages: {},
        };
        fs.writeFileSync(path.join(esDir, 'manifest.json'), JSON.stringify(manifest));

        const relatedSlug = slug === 'rules' ? 'home' : 'rules';
        const pageContent = [
            '---',
            `slug: ${slug}`,
            'title: Página',
            'summary: Resumen.',
            `related: ${relatedSlug}`,
            `source-hash: ${guideSourceHash('test')}`,
            '---',
            '',
            'Cuerpo en español.',
        ].join('\n');
        fs.writeFileSync(path.join(esDir, sec.id, `${slug}.md`), pageContent);

        const loaded = loadLanguagePages(dir, 'es', englishGuide, { version: 1 });
        assert.ok(loaded);
        const loadedSec = loaded.sections.find(s => s.id === sec.id);
        assert.ok(loadedSec);
        // Valid sourceHash adopts translation:
        assert.equal(loadedSec.title, 'Título Traducido');
        // Stale sourceHash falls back to English:
        assert.equal(loadedSec.summary, sec.summary);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the members\' guide: Commons pages mention "Start something" and describe what it offers (Fable 5.1 §4.1, §5 S5)', () => {
    const { guide } = sourceGuides();
    const textOf = (slug) => {
        const p = guide.guides.find(g => g.slug === slug);
        assert.ok(p, `guide page "${slug}" exists`);
        return p.blocks.flatMap(b => b.type === 'ul' ? b.items : [b.text]).join('\n');
    };

    for (const slug of ['enterprises', 'groups', 'decisions', 'polls', 'events']) {
        const text = textOf(slug);
        assert.ok(text.includes('Start something'), `${slug}.md must mention "Start something"`);
    }
});


test("the members' guide: a copy of an event is the phone's and the browser's to look after (#2731)", () => {
    const { guide } = sourceGuides();
    const page = guide.guides.find(g => g.slug === 'events');
    assert.ok(page, 'the guide page "events" exists');
    const text = page.blocks.flatMap(b => b.type === 'ul' ? b.items : [b.text]).join('\n');
    assert.ok(text.includes("your phone or browser puts it back up when you're back"), 'a browser brings a copy it ticked back up too');
    assert.ok(!text.includes("and your phone puts it back up"), 'not the phone alone');
});

test("the operators' manual: a member shows a copy from their phone or browser (#2731)", () => {
    const page = fs.readFileSync(path.join(OPERATORS_DIR, 'server', 'address-and-peers.md'), 'utf8');
    assert.ok(page.includes('on the global community from their phone or browser, by their own key'), 'the web app has the tick too');
});

test("the members' guide: what the key vault keeps says only what the code does (#2683 deciding pass)", () => {
    const { guide } = sourceGuides();
    const page = guide.guides.find(g => g.slug === 'recovery');
    assert.ok(page, 'the guide page "recovery" exists');
    const text = page.blocks.flatMap(b => b.type === 'ul' ? b.items : [b.text]).join('\n');

    // The vault is told which community when a copy is made (the keyholder reads it from the deposit box) and when a voucher
    // is shown. It keeps neither, but whoever holds its secret can test community keys against the fingerprint.
    assert.ok(!text.includes("doesn't know which community"), 'it is told, and keeps nothing that says: it is not that it can\'t know');
    assert.ok(text.includes('Nothing the key vault keeps says which community that is.'));
    assert.ok(text.includes("Anyone with the running vault's secret could still work the community out"));

    // A hold's requester_key is whichever key asked: on a phone holding another account, that account's (rekey-redeem beginRekey).
    assert.ok(!text.includes("the new phone's one-time key"), 'not always a one-time key');
    assert.ok(text.includes("then it is the public half of that account's key"));
});

// ─── Lights-out mode, slice H0 (scratch/fable-design/DESIGN-lights-out-plain-ip-fable.md §3.3-3.7 and §5): the two manual
// pages for the owner, and the member page for the hall. They are pinned on the pages, as the rest of this file is. ───

const LIGHTS_OUT_PAGES = [
    { collection: 'manual', slug: 'before-the-lights-go-out' },
    { collection: 'manual', slug: 'when-the-lights-go-out' },
    { collection: 'guide', slug: 'in-the-hall' },
];
const blockTexts = (page) => page.blocks.flatMap(b => b.type === 'ul' ? b.items : b.type === 'img' ? [b.alt] : [b.text]);
const wholePage = (page) => [page.title, page.summary, page.help ?? '', ...blockTexts(page)].join('\n');
const lightsOutPage = ({ collection, slug }) => {
    const page = sourceGuides()[collection].guides.find(g => g.slug === slug);
    assert.ok(page, `the ${collection} page "${slug}" exists`);
    return page;
};
const headings = (page) => page.blocks.filter(b => b.type === 'h2' || b.type === 'h3').map(b => b.text);
/** The blocks between a heading and the next heading of the same or a higher level. */
const underHeading = (page, heading) => {
    const start = page.blocks.findIndex(b => (b.type === 'h2' || b.type === 'h3') && b.text === heading);
    assert.ok(start >= 0, `${page.slug} has the heading "${heading}"`);
    const level = page.blocks[start].type;
    const out = [];
    for (const b of page.blocks.slice(start + 1)) {
        if (b.type === 'h2' || (b.type === 'h3' && level === 'h3')) break;
        out.push(b);
    }
    return out;
};
const textsOf = (blocks) => blocks.flatMap(b => b.type === 'ul' ? b.items : b.text ? [b.text] : []);

test('lights-out: the three pages exist, are listed in their sections, and relate only to pages of their own collection', () => {
    const sources = sourceGuides();
    for (const where of LIGHTS_OUT_PAGES) {
        const page = lightsOutPage(where);
        const own = new Set(sources[where.collection].guides.map(g => g.slug));
        for (const r of page.related) assert.ok(own.has(r), `${page.slug} relates to ${r}, a page of the ${where.collection}`);
        assert.ok(page.related.length >= 1);
    }
    const manualServer = sources.manual.sections.find(s => s.id === 'server');
    assert.ok(manualServer.slugs.includes('before-the-lights-go-out') && manualServer.slugs.includes('when-the-lights-go-out'), "the manual's Running the server section lists both");
    assert.ok(sources.guide.sections.find(s => s.id === 'getting-started').slugs.includes('in-the-hall'), "the members' Getting started lists In the hall");
    // The two manual pages point at each other: the checklist is read before, the steps on the day.
    assert.ok(lightsOutPage(LIGHTS_OUT_PAGES[0]).related.includes('when-the-lights-go-out'));
    assert.ok(lightsOutPage(LIGHTS_OUT_PAGES[1]).related.includes('before-the-lights-go-out'));
    // Only First-time setup of the manual is on the website (OPERATOR_PAGES_ON_WEBSITE): neither manual page is.
    assert.ok(!OPERATOR_PAGES_ON_WEBSITE.includes('before-the-lights-go-out') && !OPERATOR_PAGES_ON_WEBSITE.includes('when-the-lights-go-out'));
});

test('lights-out: "resilience" and "survival" are in none of the pages, their titles or summaries (Marty)', () => {
    for (const where of LIGHTS_OUT_PAGES) {
        const text = wholePage(lightsOutPage(where));
        const m = /resilien\w*|surviv\w*/i.exec(text);
        assert.equal(m, null, `${where.slug} says "${m?.[0]}"`);
    }
});

test('lights-out: no page claims what is not built yet; each says "Coming with the next release" where it needs the switch, the hall door or the poster page', () => {
    for (const where of LIGHTS_OUT_PAGES) {
        assert.ok(/coming with the next release/i.test(wholePage(lightsOutPage(where))), `${where.slug} says what comes with the next release`);
    }
    // The member page says it near the top: the first thing a member reads says the hall door is not there yet.
    const member = lightsOutPage(LIGHTS_OUT_PAGES[2]);
    assert.ok(/coming with the next release/i.test(textsOf(member.blocks).slice(0, 3).join(' ')), 'In the hall says it near the top');
    // Nothing is put on the website by this slice: neither manual page is published there.
    for (const where of LIGHTS_OUT_PAGES.slice(0, 2)) assert.ok(!fs.existsSync(path.join(OPERATORS_WEBSITE_DIR, `${where.slug}.html`)));
});

test('lights-out, Before the lights go out: the three must-haves come first, in order (the software, a backup on the laptop, the recovery code)', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[0]);
    const h = headings(page);
    const must = h.indexOf('The three things you cannot do without');
    const then = h.indexOf('Then, in this order');
    assert.ok(must >= 0 && then > must, 'the must-haves are before everything else');
    assert.deepEqual(h.slice(must + 1, then), ['1. The software is on the laptop', '2. A backup is on the laptop', '3. The recovery code is on paper']);
    assert.equal(h.indexOf('Read this first'), 0, 'and the page opens on what it is for');
    // Each must-have is steps: one action, and what you see.
    const software = textsOf(underHeading(page, '1. The software is on the laptop')).join('\n');
    for (const need of ['docker compose pull', 'NODE_ROLE=backup', 'docker compose up -d']) assert.ok(software.includes(need), `step: ${need}`);
    const backup = textsOf(underHeading(page, '2. A backup is on the laptop')).join('\n');
    for (const need of ['beanpool pair', 'Replication Access', 'Download Sovereign Database', '.bpsealed']) assert.ok(backup.includes(need), `step: ${need}`);
    const code = textsOf(underHeading(page, '3. The recovery code is on paper')).join('\n');
    for (const need of ['Make a recovery code', 'Check a code', 'away from the laptop']) assert.ok(code.includes(need), `step: ${need}`);
});

test('lights-out: every list of steps on the two manual pages runs Step 1, Step 2, … with no gap', () => {
    for (const where of LIGHTS_OUT_PAGES.slice(0, 2)) {
        const page = lightsOutPage(where);
        let lists = 0;
        for (const b of page.blocks) {
            if (b.type !== 'ul') continue;
            const steps = b.items.map(i => /^\*\*Step (\d+)\.\*\*/.exec(i)?.[1]);
            if (steps.every(s => s === undefined)) continue;
            lists++;
            assert.ok(steps.every(s => s !== undefined), `${where.slug}: a list of steps holds only steps: ${b.items[0]}`);
            assert.deepEqual(steps.map(Number), steps.map((_, i) => i + 1), `${where.slug}: steps run 1..n in "${b.items[0].slice(0, 40)}"`);
        }
        assert.ok(lists >= 3, `${where.slug} has its step lists`);
    }
});

test("lights-out: the checklist's four lines are the poster's four lines, word for word (packages/beanpool-core lights-out-poster.ts)", () => {
    const poster = fs.readFileSync(path.resolve(CONTENT_DIR, '..', '..', 'beanpool-core', 'src', 'lights-out-poster.ts'), 'utf8');
    const said = {};
    for (const m of poster.matchAll(/\b(airplane|joinWifi|scanApp|scanAndroid):\s*word\((['"])(.*?)\2\)/g)) said[m[1]] = m[3];
    assert.deepEqual(Object.keys(said), ['airplane', 'joinWifi', 'scanApp', 'scanAndroid']);
    const manual = lightsOutPage(LIGHTS_OUT_PAGES[0]);
    assert.deepEqual(textsOf(underHeading(manual, 'The four lines on the poster')).filter(t => Object.values(said).includes(t)), Object.values(said));
    // The member page has the same four lines, in bold.
    const member = blockTexts(lightsOutPage(LIGHTS_OUT_PAGES[2])).join('\n');
    for (const line of Object.values(said)) assert.ok(member.includes(`**${line}**`), `In the hall has "${line}"`);
});

test('lights-out, When the lights go out: both paths, the owner step a standby needs, the two rules, the way back and the Byron line', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[1]);
    const h = headings(page);
    for (const want of ['Path A: the laptop was your standby', 'Path B: you have a locked backup file', 'Reaching Settings and the switch with no internet',
        "Show the poster, and say the record's age", 'What stays refused in the hall', 'When the internet comes back', 'What must never happen']) {
        assert.ok(h.includes(want), `heading "${want}"`);
    }
    const all = wholePage(page);
    // The two rules of the take-over (design §2.7, §3.6; the Opus L4 warning).
    assert.ok(all.includes('Two copies must never be live at once.'));
    assert.ok(all.includes('There is no merging.'));
    // Path A: a standby has no owner of its own, so the owner step comes BEFORE Settings and the take-over (test-no-mothership step 8).
    const a = textsOf(underHeading(page, 'Path A: the laptop was your standby'));
    const at = (needle) => a.findIndex(i => i.includes(needle));
    assert.ok(at('beanpool recover --key') >= 0 && at('http://127.0.0.1:8080/settings') > at('beanpool recover --key'), 'owner first, then Settings');
    assert.ok(at('Take over as the main server') > at('http://127.0.0.1:8080/settings'), 'then the take-over');
    assert.ok(at('The main server is gone, and nobody will start it again') > at('Take over as the main server'), "with the manual's own tick");
    // Path B needs no phone and no Settings: a stopped node, the restore from the shell, the code typed at the prompt.
    const b = textsOf(underHeading(page, 'Path B: you have a locked backup file')).join('\n');
    for (const need of ['docker compose stop beanpool-node', 'beanpool restore /data/FILE.bpsealed', 'Never put it on the command line', 'docker compose up -d']) assert.ok(b.includes(need), `path B: ${need}`);
    // Reaching the switch: the owner's own ways, the shell and the laptop's loopback, and never a member.
    const ways = textsOf(underHeading(page, 'Reaching Settings and the switch with no internet')).join('\n');
    for (const need of ['beanpool lights-out on', 'http://127.0.0.1:8080/settings', "authenticator", 'Manage', "a member's phone is refused"]) assert.ok(ways.includes(need), `reaching the switch: ${need}`);
    // The way back, with the Byron line: a tunnel on the host moves no address, so the old server is stopped by hand.
    const back = textsOf(underHeading(page, 'When the internet comes back')).join('\n');
    for (const need of ['Byron', 'docker compose stop beanpool-node', 'Never start the old main server again', 'read-only', 'one copy is the community, and the other is retired whole']) assert.ok(back.includes(need), `the way back: ${need}`);
});

// The checklist makes the laptop a standby (NODE_ROLE=backup). A standby refuses every trade and send
// (apps/server/src/config/node-role.ts assertLedgerWritable), and nothing in the shell restore writes `nodeRole`
// (sealed-backup.ts applyBundle writes only the admin, 2FA and break-glass fields). Path A's take-over writes it itself
// (services/takeover.ts); path B has no take-over, so it needs a step of its own (Opus review of #2823, finding 1).
test('lights-out, path B: the laptop is made the main server after the restore and before docker compose up -d (a standby refuses every trade)', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[1]);
    const b = textsOf(underHeading(page, 'Path B: you have a locked backup file'));
    const at = (needle) => b.findIndex(i => i.includes(needle));
    const stop = at('docker compose stop beanpool-node');
    const restore = at('beanpool restore /data/FILE.bpsealed');
    const typed = at('Type the recovery code at the prompt');
    const role = at('NODE_ROLE=primary');
    const up = at('docker compose up -d');
    for (const [name, i] of Object.entries({ stop, restore, typed, role, up })) assert.ok(i >= 0, `path B has the step: ${name}`);
    assert.ok(stop < restore && restore < typed, 'stop, then the restore, then the code typed at its prompt');
    assert.ok(role > typed, 'the role is changed AFTER the restore (the restore counts the standby\'s pin only while the role is still backup)');
    assert.ok(up > role, 'and BEFORE docker compose up -d, which is what starts the laptop with the new role');
    // One action in the step, and what you see after it; it changes the very line the checklist added.
    const step = b[role];
    assert.ok(/^\*\*Step \d+\.\*\*/.test(step), 'it is a numbered step');
    assert.ok(step.includes('NODE_ROLE=backup') && step.includes('.env'), 'it changes the .env line NODE_ROLE=backup that Before the lights go out added');
    assert.ok(step.includes('You see:'), 'and says what you see after it');
    assert.ok(!step.includes('docker compose up -d'), 'one action: starting the laptop is the next step, not this one');
    assert.ok(/after the restore|never before/i.test(step), 'and says why the order matters');
    // The checklist is what puts NODE_ROLE=backup there: the two pages agree.
    const before = textsOf(underHeading(lightsOutPage(LIGHTS_OUT_PAGES[0]), '1. The software is on the laptop')).join('\n');
    assert.ok(before.includes('NODE_ROLE=backup'));
    // A restore done from Settings with an owner's phone (no recovery code) leaves the same standby: the page says to do the step then too.
    const phone = b.find(i => i.includes('Restore from a locked backup')) ?? '';
    assert.ok(phone.includes('NODE_ROLE=primary') && phone.includes('docker compose up -d'), 'the restore from Settings is followed by the same role change and the same start');
});

// A laptop that was never paired has a community of its own (index.ts ensureGenesis runs on every boot, whatever the role), so
// `beanpool restore` (apps/server/src/restore-command.ts, otherCommunity) warns "This backup is from a DIFFERENT community" and
// asks "Type yes to go on:" BEFORE the code prompt. That question is not secret: it shows what is typed (shell-prompt.ts mutes only
// `secret`). A page that goes straight from the restore to "type the recovery code" has the owner type it there, in plain text, in
// front of the hall, and then the restore refuses (Opus review of #2823, 3 Nov, second round).
test('lights-out, path B: the "Type yes" question of a never-paired laptop has its own step, before the code, and the code is never typed there', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[1]);
    const b = textsOf(underHeading(page, 'Path B: you have a locked backup file'));
    const at = (needle) => b.findIndex(i => i.includes(needle));
    const restore = at('beanpool restore /data/FILE.bpsealed');
    const yes = at('Type yes to go on');
    const typed = at('Type the recovery code at the prompt');
    const role = at('NODE_ROLE=primary');
    for (const [name, i] of Object.entries({ restore, yes, typed })) assert.ok(i >= 0, `path B has: ${name}`);
    // The step that answers the question is its own step, after the restore (which asks it) and before the code step.
    const answer = b.findIndex((i, n) => n > restore && /^\*\*Step \d+\.\*\*/.test(i) && /type yes/i.test(i));
    assert.ok(answer > restore && answer < typed, 'a step of its own answers "Type yes to go on", after the restore and before the code is typed');
    assert.ok(answer !== restore, 'and it is not folded into the restore step');
    // What the owner sees at the restore: the warning the page used to leave out, and that the code prompt can come at once.
    assert.ok(b[restore].includes('DIFFERENT community') && b[restore].includes('Type yes to go on'), 'the restore step says what a never-paired laptop shows');
    assert.ok(/at once/.test(b[restore]), 'and that a paired standby is asked for the code at once');
    // The yes step: why the warning is true, that nothing but yes goes there, and what comes next.
    const step = b[answer];
    assert.ok(step.includes('made a community of its own') && step.includes('the backup replaces it'), 'it says why the warning is true of this laptop');
    assert.ok(/never the recovery code/i.test(step) && step.includes('shows what you type'), 'it says the recovery code is never typed at that question, because it shows what is typed');
    assert.ok(step.includes('You see:') && step.includes('not shown as you type'), 'it says what you see next: the code request that is not shown as you type');
    assert.ok(/carry on/.test(step), 'and what to do when the question did not come');
    // The code step names the prompt that hides what is typed, and the order holds: restore, yes, code, role.
    assert.ok(b[typed].includes('not shown as you type') && b[typed].includes('Never put it on the command line'), 'the code goes only at the prompt that is not shown');
    assert.ok(restore < answer && answer < typed && typed < role, 'restore, then yes, then the code, then the role');
    // The steps after the new one are renumbered: the Settings-restore paragraph points at the role step and the start step by number.
    const num = (s) => Number(/^\*\*Step (\d+)\./.exec(s)?.[1]);
    const phone = b.find(i => i.includes('Restore from a locked backup')) ?? '';
    assert.deepEqual([...phone.matchAll(/as in Step (\d+)/g)].map(m => Number(m[1])), [num(b[role]), num(b[at('docker compose up -d')])],
        'the Settings-restore paragraph points at the right steps for the role and the start');
});

test('lights-out, path B step 1 names the folder the compose file mounts: the folder named data, beside docker-compose.yml', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[1]);
    const step = textsOf(underHeading(page, 'Path B: you have a locked backup file')).find(i => i.startsWith('**Step 1.**')) ?? '';
    assert.ok(step.includes('the folder named data, beside docker-compose.yml'), 'the file goes in the folder named data');
    assert.ok(!/next to docker-compose\.yml/.test(step), 'never "next to docker-compose.yml", which reads as the same folder as the compose file');
    // The compose file mounts ./data at /data, which is where the restore command reads /data/FILE.bpsealed.
    const compose = fs.readFileSync(path.resolve(CONTENT_DIR, '..', '..', '..', 'docker-compose.yml'), 'utf8');
    assert.ok(/-\s*\.\/data:\/data\b/.test(compose), 'docker-compose.yml mounts ./data at /data');
});

test('lights-out, the way back: the laptop that was made the main server is a standby again by NODE_ROLE=backup in a fresh .env', () => {
    const page = lightsOutPage(LIGHTS_OUT_PAGES[1]);
    const back = textsOf(underHeading(page, 'When the internet comes back'));
    const cloud = back.find(i => i.startsWith('**Step 6.**')) ?? '';
    assert.ok(cloud.includes('NODE_ROLE=backup'), 'step 6 says the laptop is set up again as a standby with NODE_ROLE=backup in its .env');
});

test('lights-out, In the hall: what is readable, what is out, the age of the record and the way home', () => {
    const text = blockTexts(lightsOutPage(LIGHTS_OUT_PAGES[2])).join('\n');
    for (const need of [
        "On the hall's Wi-Fi, what you post and your balance can be read by others on that Wi-Fi",
        '**Your messages stay private.**',
        'The record is as of Tue 3 Nov, 14:02. Trades made since then on the old server are not here.',
        'The web app.', 'install the app before the lights go out', 'Your 12 words always work',
        'Nothing you posted in the hall is lost',
    ]) assert.ok(text.includes(need), `In the hall says: ${need}`);
    // The record's age is said as a day and a time, never as "stale" or "out of date" (design §3.5).
    assert.equal(/\bstale\b|out of date/i.exec(text), null);
});

test("ROADMAP: no 'Offline Outbox' or 'Offline Queue' is marked done (nothing in the code queues a post to send later; lights-out H0)", () => {
    const roadmap = fs.readFileSync(path.resolve(CONTENT_DIR, '..', '..', '..', 'ROADMAP.md'), 'utf8').split('\n');
    const lines = roadmap.filter(l => /Offline (Outbox|Queue)/.test(l));
    assert.equal(lines.length, 3, 'the three lines are still there, corrected');
    for (const l of lines) {
        assert.ok(!/^- (✅|\[x\])/.test(l), `not marked done: ${l.slice(0, 60)}`);
        assert.ok(/not built/.test(l), `says it is not built: ${l.slice(0, 60)}`);
    }
});

// ─── Search and link previews: canonical, Open Graph and sitemap.xml ───────────

const guideMeta = (html, key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`))?.[1];
const guideCanonical = html => html.match(/<link rel="canonical" href="([^"]*)">/)?.[1];

test('every guide page carries its own extensionless address as canonical and og:url, with the share image and its language', () => {
    const { guide, out } = expectedOutputs();
    const pages = Object.entries(out).filter(([file]) => file.startsWith(WEBSITE_DIR + path.sep) && file.endsWith('.html'));
    assert.ok(pages.length > guide.guides.length, 'English pages, translations and the manual page');
    for (const [file, html] of pages) {
        const rel = path.relative(WEBSITE_DIR, file).split(path.sep);
        const name = rel.pop();
        const folder = rel.join('/');
        const url = `https://beanpool.org/guide/${folder ? `${folder}/` : ''}${name === 'index.html' ? '' : name.replace(/\.html$/, '')}`;
        assert.equal(guideCanonical(html), url, file);
        assert.equal(guideMeta(html, 'og:url'), url, file);
        assert.equal(guideMeta(html, 'og:image'), 'https://beanpool.org/og-image.jpg');
        assert.equal(guideMeta(html, 'og:image:width'), '1200');
        assert.equal(guideMeta(html, 'og:image:height'), '630');
        assert.equal(guideMeta(html, 'og:type'), 'website');
        assert.equal(guideMeta(html, 'twitter:card'), 'summary_large_image');
        const lang = html.match(/<html lang="([^"]*)"/)[1];
        assert.equal(guideMeta(html, 'og:locale'), OG_LOCALES[lang], file);
        assert.equal(html.match(/<title>([^<]*)<\/title>/)[1], guideMeta(html, 'og:title'), `${file} og:title is its title`);
        assert.equal(html.match(/<meta name="description" content="([^"]*)">/)[1], guideMeta(html, 'og:description'), `${file} og:description is its description`);
    }
});

test('the guide shares its image, address and language codes with the rest of the site', async () => {
    const site = await import('../../../scripts/website-build.mjs');
    assert.equal(OG_IMAGE_URL, site.OG_IMAGE_URL);
    assert.deepEqual(OG_LOCALES, site.OG_LOCALES);
    assert.deepEqual(Object.keys(OG_LOCALES), ['en', ...GUIDE_LANGS]);
});

test('the share tags escape a title and a description with quotes and ampersands', () => {
    const guide = {
        schema: 2, version: 1, hash: 'h',
        sections: [{ id: 'about', title: 'About', summary: 'S', slugs: ['a'] }],
        guides: [{ slug: 'a', title: 'Tom & "Jerry"', summary: 'It\'s "free" & <fair>', section: 'about', related: [], blocks: [{ type: 'p', text: 'x' }] }],
    };
    const html = renderWebsite(guide)['a.html'];
    assert.ok(html.includes('<meta property="og:title" content="Tom &amp; &quot;Jerry&quot; — BeanPool members\' guide">'));
    assert.ok(html.includes('<meta property="og:description" content="It\'s &quot;free&quot; &amp; &lt;fair&gt;">'));
    assert.equal(guideCanonical(html), 'https://beanpool.org/guide/a');
});

test('sitemap.xml lists every guide page in every language, with the language alternates and the manual page', () => {
    const { out } = expectedOutputs();
    const sitemap = out[path.join(WEBSITE_DIR, 'sitemap.xml')];
    assert.ok(sitemap, 'the build writes apps/website/guide/sitemap.xml');
    assert.ok(sitemap.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'));
    assert.ok(sitemap.endsWith('</urlset>\n'));
    const locs = [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
    assert.equal(new Set(locs).size, locs.length, 'no address twice');
    const canonicals = Object.entries(out)
        .filter(([file]) => file.startsWith(WEBSITE_DIR + path.sep) && file.endsWith('.html'))
        .map(([, html]) => guideCanonical(html));
    assert.deepEqual([...locs].sort(), [...canonicals].sort(), 'the sitemap lists exactly the pages the guide writes, by their canonical address');
    assert.ok(locs.includes('https://beanpool.org/guide/'));
    assert.ok(locs.includes('https://beanpool.org/guide/operators/first-time-setup'));
    // a page in several languages names each of them and x-default (English); the manual's page has no alternates
    const block = url => sitemap.split('  <url>\n').find(b => b.startsWith(`    <loc>${url}</loc>`));
    const home = block('https://beanpool.org/guide/home');
    assert.ok(home.includes('hreflang="en" href="https://beanpool.org/guide/home"/>'));
    assert.ok(home.includes('hreflang="x-default" href="https://beanpool.org/guide/home"/>'));
    for (const lang of GUIDE_LANGS.filter(l => locs.includes(`https://beanpool.org/guide/${l}/home`))) {
        assert.ok(home.includes(`hreflang="${lang}" href="https://beanpool.org/guide/${lang}/home"/>`), lang);
    }
    assert.ok(!block('https://beanpool.org/guide/operators/first-time-setup').includes('xhtml:link'));
});

test('renderGuideSitemap: alternates only for the languages that have the page; English index first', () => {
    const xml = renderGuideSitemap({ '': ['b.html', 'index.html', 'a.html'], fr: ['a.html'], ja: ['a.html', 'b.html'], operators: ['setup.html'] });
    const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
    assert.deepEqual(locs, [
        'https://beanpool.org/guide/',
        'https://beanpool.org/guide/a', 'https://beanpool.org/guide/fr/a', 'https://beanpool.org/guide/ja/a',
        'https://beanpool.org/guide/b', 'https://beanpool.org/guide/ja/b',
        'https://beanpool.org/guide/operators/setup',
    ]);
    const a = xml.split('  <url>\n').find(b => b.startsWith('    <loc>https://beanpool.org/guide/a</loc>'));
    assert.deepEqual([...a.matchAll(/hreflang="([^"]*)"/g)].map(m => m[1]), ['en', 'fr', 'ja', 'x-default']);
    const b = xml.split('  <url>\n').find(blk => blk.startsWith('    <loc>https://beanpool.org/guide/b</loc>'));
    assert.deepEqual([...b.matchAll(/hreflang="([^"]*)"/g)].map(m => m[1]), ['en', 'ja', 'x-default']);
});

test("robots.txt points search engines at the guide's sitemap as well as the site's", () => {
    const robots = fs.readFileSync(path.join(WEBSITE_DIR, '..', 'robots.txt'), 'utf8');
    assert.ok(robots.includes('Sitemap: https://beanpool.org/sitemap.xml\n'));
    assert.ok(robots.includes('Sitemap: https://beanpool.org/guide/sitemap.xml\n'));
});
