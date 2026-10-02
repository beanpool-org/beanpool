import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, BUNDLED_JSON, WEBSITE_DIR, CONTENT_DIR, OPERATORS_DIR, OPERATORS_JSON, OPERATORS_WEBSITE_DIR, PUBLISH_OPERATORS_WEBSITE, expectedOutputs, sourceGuides } from '../scripts/build.mjs';
import { parseGuideMarkdown, renderWebsite, renderOperatorsWebsite, contentHash, loadGuide, GUIDE_SCHEMA } from '../src/guide.mjs';

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

test('a text change changes the hash (which publishing turns into a higher version)', () => {
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
    const { guide, manual } = sourceGuides();
    const memberSlugs = new Set(guide.guides.map(g => g.slug));
    // Distinct slugs, so a page name never means two different pages in search results or links.
    for (const p of manual.guides) assert.ok(!memberSlugs.has(p.slug), `${p.slug} is in both collections`);
});

test('the operator manual covers what an operator needs, and the (unpublished) website renderer lists and renders every page', () => {
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
    const { manual } = sourceGuides();
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

test('website has no operator images and no operator content', () => {
    const webFiles = fs.readdirSync(WEBSITE_DIR, { recursive: true }).map(String);
    assert.ok(!webFiles.some(f => f.includes('operators')), 'no operators in website folder');
    assert.ok(!webFiles.some(f => f.endsWith('.webp')), 'no operator webp images in website folder');
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
        "Whoever runs the server can change what it stores and what it tells each phone, and with the owner password can make any key an admin or move an account to a new key. The admins' phones don't take its word: a phone gives the list's keys only to a key its admin checked in person, or that an admin it trusts checked, and takes a new key only from such a key. Whoever runs the server can stop the list from working, delete it, and see who opened it and when. On its own it can't read a name. It needs an admin to check the wrong phone in person, or an admin who was removed to work with it (below).",
        // The fifth deciding review's BLOCKING finding (52e1a759), in the design addendum's (e) words: the new key protects
        // what the phones that took it write, and the limit is per phone.
        "When an admin stops being one, the next admin who holds the keys to open the list makes a new key without them, and their phone sends it to the other admins. Nothing written from then on by a phone that has taken the new key can be read with the keys the person had. What they already saw, they keep, as with a paper list.",
        "When an admin loses their phone, tell another admin the same day: they tap Remove @X's old key. Until that is done, whoever has the phone can read what is written. The admin's new phone is checked in person once, and the keys are sent to it. Names written under a key that only the lost phone held can't be opened by anyone: the app counts them, and your paper copy is how they come back.",
        "What this doesn't protect against: checking the wrong person's phone (your phone then trusts their key and sends them the names); an admin's phone someone else gets into; a lost phone before an admin removes its key; a PDF or a note an admin writes; and an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had.",
        // Design Addendum 2 (§3): the removal check is Remove by hand; the comparison only shows two phones are shown different things.
        "Every admin's phone learns of a removal when it opens the list, unless the server hides it. After an admin is removed, each admin looks at the admins their phone shows: a phone that still shows the removed admin taps Remove @X's old key. Whatever the server says, that phone then makes a new key without them or writes nothing. Two phones that show different list keys are being shown different things: add no names until they match, and tell your admins.",
        // The design addendum's (e): the vouched history gives a way forward through any admin whose phone opens the list.
        "A key made by someone no admin your phone trusts has checked. Meet that admin, or an admin whose phone already opens the list, and check each other's phones.",
        // Round 7 (the re-review's guide :61): what Take @name's history does with the other history's keys.
        "Your phone keeps the other history's keys, reads with them and passes them on to the admins it trusts, but never writes under them again unless the server's history comes back to them. An admin your phone had removed stays removed: before it writes, it makes a new key without them.",
        // Decided with the design (§12 Q3): the 12 words alone don't make a lost phone safe.
        "The 12 words alone aren't enough for an admin whose phone was lost",
    ]) assert.ok(operators.includes(sentence), `running-a-known-community says: ${sentence.slice(0, 70)}…`);
    assert.ok(members.includes("Whoever runs the server can't read it. The admins' phones give the list's keys only to admins whose phones another admin has checked in person, and take new keys only from them. That rests on the admins: an admin who checks the wrong person's phone, an admin's phone someone gets into, or a lost phone before the admins remove its key, can let someone else read the names. So can an admin's phone that whoever runs the server keeps from learning that an admin was removed: until it learns, what it writes can be read with the keys the removed admin had. An admin whose phone still shows the removed admin removes their key by hand, and that phone then makes a new key without them or writes nothing."),
        'what-the-admins-can-see says the members\' sentence');
    for (const gone of [/remembers it/i, /first (use|time a phone opens)/i, /whoever (first )?shares/i, /carried over/i, /seals? (every entry|them) again/i, /sealed again under/i,
        /any admin can (\*\*)?start a new key/i, /working with whoever runs/i, /removed admin working with/i,
        /can't read a name without an admin checking the wrong phone/i, /Nothing written from then on can be read/i,
        /To be sure, meet another admin and compare the list key/i, /they should show the same one/i,
        /Admins check for that by meeting and comparing their phones/i, /for reading only/i, /stay on it, for reading/i]) {
        assert.doesNotMatch(`${operators}\n${members}`, gone);
    }
});
