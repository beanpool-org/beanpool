import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, BUNDLED_JSON, WEBSITE_DIR, CONTENT_DIR, OPERATORS_DIR, OPERATORS_JSON, OPERATORS_WEBSITE_DIR, PUBLISH_OPERATORS_WEBSITE, expectedOutputs } from '../scripts/build.mjs';
import { parseGuideMarkdown, renderWebsite, renderOperatorsWebsite, contentHash, loadGuide, GUIDE_SCHEMA } from '../src/guide.mjs';

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
    const { guide } = expectedOutputs();
    const about = guide.sections.find(s => s.id === 'about');
    assert.deepEqual(about.slugs, ['how-it-works', 'rules', 'faq', 'whats-new']);
});

test('the manual: every section has pages, every page has Related pages that exist, the website lists them all', () => {
    const { guide } = expectedOutputs();
    const slugs = new Set(guide.guides.map(g => g.slug));
    assert.ok(guide.sections.length >= 9, 'about + the eight manual sections');
    for (const want of ['getting-started', 'market', 'map', 'talk', 'pulse', 'commons', 'ledger', 'settings']) {
        assert.ok(guide.sections.some(s => s.id === want), `section ${want}`);
    }
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
    const text = fs.readdirSync(CONTENT_DIR, { recursive: true }).filter(f => String(f).endsWith('.md'))
        .map(f => fs.readFileSync(path.join(CONTENT_DIR, String(f)), 'utf8')).join('\n')
        + fs.readFileSync(path.join(CONTENT_DIR, 'manifest.json'), 'utf8');
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

test('a text change changes the hash (which forces a version bump)', () => {
    const a = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'x' }] }];
    const b = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'y' }] }];
    assert.notEqual(contentHash(a), contentHash(b));
});

// ─── The operator manual (operators/) ─────────────────────────────────────────

test("the operator manual is not on the website: the build writes none of it and the folder does not exist", () => {
    // The guard for Marty's decision of 2026-09-19: the manual ships in node Settings now, and the website copy waits
    // until the security weak spots it describes are fixed. Remove this only together with the switch in build.mjs.
    assert.equal(PUBLISH_OPERATORS_WEBSITE, false, 'PUBLISH_OPERATORS_WEBSITE must stay off until the brake weak spots are fixed');
    assert.ok(!fs.existsSync(OPERATORS_WEBSITE_DIR),
        'apps/website/guide/operators/ must not exist: the operator manual is not published on beanpool.org (Marty, 2026-09-19)');
    const { out } = expectedOutputs();
    assert.deepEqual(Object.keys(out).filter(f => f.startsWith(OPERATORS_WEBSITE_DIR + path.sep)), []);
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
    const { guide, manual } = expectedOutputs();
    const memberSlugs = new Set(guide.guides.map(g => g.slug));
    // Distinct slugs, so a page name never means two different pages in search results or links.
    for (const p of manual.guides) assert.ok(!memberSlugs.has(p.slug), `${p.slug} is in both collections`);
});

test('the operator manual covers what an operator needs, and the (unpublished) website renderer lists and renders every page', () => {
    const { manual } = expectedOutputs();
    const slugs = new Set(manual.guides.map(g => g.slug));
    for (const want of ['first-time-setup', 'signing-in', 'roles', 'members-and-invites', 'reports-and-takedowns', 'disputes',
        'decisions-and-emergencies', 'enterprises-and-keepers', 'pulse-and-announcements', 'backups-and-replicas',
        'updates-and-health', 'rate-limits', 'what-the-server-sees', 'feedback', 'troubleshooting']) {
        assert.ok(slugs.has(want), `operator page ${want}`);
    }
    // Rendered in memory: the renderer is kept working for the day the website copy is switched on.
    const site = renderOperatorsWebsite(manual);
    assert.equal(site['operators.json'], fs.readFileSync(OPERATORS_JSON, 'utf8'), "the website's operators.json would be Settings' bytes");
    const index = site['index.html'];
    for (const s of manual.sections) assert.ok(index.includes(`href="#${s.id}"`), `contents links ${s.id}`);
    for (const g of manual.guides) {
        assert.ok(index.includes(`href="${g.slug}.html"`), `index links ${g.slug}`);
        const html = site[`${g.slug}.html`].replace(/<\/?strong>/g, '');
        for (const b of g.blocks) {
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

test('the operator manual has no concept-guide section; the members\' guide still must', () => {
    const { manual } = expectedOutputs();
    assert.ok(!manual.sections.some(s => s.id === 'about'));
    assert.throws(() => loadGuide(OPERATORS_DIR), /needs the "about" section/);
});

test('check() reports a stray file in the website folder, including any operator page while publishing is off', () => {
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
