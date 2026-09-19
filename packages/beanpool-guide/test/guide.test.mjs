import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { check, BUNDLED_JSON, WEBSITE_DIR, CONTENT_DIR, expectedOutputs } from '../scripts/build.mjs';
import { parseGuideMarkdown, renderWebsite, contentHash, GUIDE_SCHEMA } from '../src/guide.mjs';

test('every generated file (app bundle and website) is exactly what the source produces', () => {
    assert.deepEqual(check(), []);
});

test("the app's bundled guide.json and the website's guide.json are the same bytes", () => {
    const bundled = fs.readFileSync(BUNDLED_JSON, 'utf8');
    const website = fs.readFileSync(path.join(WEBSITE_DIR, 'guide.json'), 'utf8');
    assert.equal(bundled, website);
    const guide = JSON.parse(bundled);
    assert.equal(guide.schema, GUIDE_SCHEMA);
    assert.equal(guide.hash, contentHash(guide.guides));
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
    const slugs = guide.guides.map(g => g.slug);
    for (const s of ['how-it-works', 'rules', 'faq', 'whats-new']) assert.ok(slugs.includes(s), s);
});

test('member-facing words: no internal names, no code words, beans not Ʀ, badges not tiers', () => {
    const text = fs.readdirSync(CONTENT_DIR).filter(f => f.endsWith('.md'))
        .map(f => fs.readFileSync(path.join(CONTENT_DIR, f), 'utf8')).join('\n');
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
    const g = parseGuideMarkdown('---\nslug: a-b\ntitle: T\nsummary: S\n---\n\n## H\n\nOne\ntwo **bold**.\n\n- x\n- y\n\n### Sub\n', 'x.md');
    assert.deepEqual(g.blocks, [
        { type: 'h2', text: 'H' },
        { type: 'p', text: 'One two **bold**.' },
        { type: 'ul', items: ['x', 'y'] },
        { type: 'h3', text: 'Sub' },
    ]);
});

test('parser: anything richer is an error, not silently printed', () => {
    const wrap = body => `---\nslug: a\ntitle: T\nsummary: S\n---\n\n${body}\n`;
    for (const body of ['See [the site](https://x.org).', '<b>hi</b>', '1. first', '* star', '> quote', '# Title', '**open', '| a | b |', 'an *italic* word', '- item\n  more']) {
        assert.throws(() => parseGuideMarkdown(wrap(body), 'x.md'), undefined, body);
    }
    assert.throws(() => parseGuideMarkdown('no front matter', 'x.md'));
    assert.throws(() => parseGuideMarkdown('---\nslug: Bad Slug\ntitle: T\nsummary: S\n---\n\nText\n', 'x.md'));
});

test('website rendering escapes text', () => {
    const guide = { schema: 1, version: 1, hash: 'h', guides: [{ slug: 'a', title: 'A & B', summary: 'S', blocks: [{ type: 'p', text: '1 < 2 and **bold**' }] }] };
    const html = renderWebsite(guide)['a.html'];
    assert.ok(html.includes('<p>1 &lt; 2 and <strong>bold</strong></p>'));
    assert.ok(html.includes('<h1>A &amp; B</h1>'));
});

test('a text change changes the hash (which forces a version bump)', () => {
    const a = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'x' }] }];
    const b = [{ slug: 'a', title: 'T', summary: 'S', blocks: [{ type: 'p', text: 'y' }] }];
    assert.notEqual(contentHash(a), contentHash(b));
});
