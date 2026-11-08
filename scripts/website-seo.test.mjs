// beanpool.org in search and in link previews: Open Graph + Twitter card tags on every page the builder manages (not the 404
// page), the home page's structured data in every language, and the share image they point at. This fails when:
//   - a page (English or translated) has no og:/twitter: tags, or they do not say the page's own title, description and address;
//     the 404 page has any; a title with quotes or an ampersand breaks out of its attribute;
//   - building twice changes a page, or the tags change an English page's content hash (every translation would turn stale);
//   - the home page (English or translated) has no JSON-LD, it does not parse, lacks Organization, WebSite or SoftwareApplication,
//     or its store links are not the ones the page's own badges carry;
//   - apps/website/og-image.png is not a 1200 x 630 PNG under 200 KB.
// No browser, no network.
//
//   node --test scripts/website-seo.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    ALL_PAGES,
    LANGS,
    OG_IMAGE_URL,
    OG_LOCALES,
    buildJsonLd,
    buildSocialTags,
    checkOgImage,
    formatEnglishPage,
    pageContentHash,
    pageUrl,
    readPageSummary
} from './website-build.mjs';

const WEBSITE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'website');
const read = (lang, page) => fs.readFileSync(path.join(WEBSITE_DIR, lang === 'en' ? '' : lang, page), 'utf8');
const metaTags = (html) => [...html.matchAll(/<meta\s+(?:property="og:|name="twitter:)[^>]*>/g)].map((m) => m[0]);
const metaContent = (html, key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`))?.[1];
const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const jsonLd = (html) => {
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, 'exactly one ld+json script');
    return JSON.parse(blocks[0][1]);
};

test('every English and translated page has Open Graph tags with its own title, description, address and the share image', () => {
    for (const lang of LANGS) {
        for (const page of ALL_PAGES) {
            const file = lang === 'en' ? page : `${lang}/${page}`;
            if (lang !== 'en' && !fs.existsSync(path.join(WEBSITE_DIR, file))) continue;
            const html = read(lang, page);
            if (page === '404.html') {
                assert.deepEqual(metaTags(html), [], `${file} must have no link-preview tags`);
                continue;
            }
            const { title, description } = readPageSummary(html);
            assert.equal(unescape(metaContent(html, 'og:title') ?? ''), title, `${file} og:title`);
            if (description) assert.equal(unescape(metaContent(html, 'og:description')), description, `${file} og:description`);
            else assert.equal(metaContent(html, 'og:description'), undefined, `${file} has no description to repeat`);
            assert.equal(metaContent(html, 'og:url'), pageUrl(page, lang), `${file} og:url`);
            assert.equal(metaContent(html, 'og:type'), 'website');
            assert.equal(metaContent(html, 'og:site_name'), 'BeanPool');
            assert.equal(metaContent(html, 'og:image'), OG_IMAGE_URL);
            assert.equal(metaContent(html, 'og:image:width'), '1200');
            assert.equal(metaContent(html, 'og:image:height'), '630');
            assert.ok(metaContent(html, 'og:image:alt'), `${file} og:image:alt`);
            assert.equal(metaContent(html, 'og:locale'), OG_LOCALES[lang]);
            assert.equal(metaContent(html, 'twitter:card'), 'summary_large_image');
            assert.equal(metaTags(html).length, description ? 11 : 10, `${file} tag count`);
        }
    }
});

test('og:url is the page\'s canonical address', () => {
    for (const [lang, page] of [['en', 'index.html'], ['en', 'rules.html'], ['de', 'index.html'], ['ar', 'help.html']]) {
        const html = read(lang, page);
        assert.equal(metaContent(html, 'og:url'), html.match(/<link rel="canonical" href="([^"]*)">/)[1]);
    }
});

test('titles and descriptions with quotes, ampersands and angle brackets stay inside their attributes', () => {
    const html = [
        '<!DOCTYPE html><html lang="en"><head>',
        '<title>Tom &amp; Jerry — "the</b> best" &lt;app&gt;</title>',
        '<meta name="description" content="She said &quot;hi&quot; &amp; left; 5 &lt; 6">',
        '</head><body></body></html>'
    ].join('\n');
    const tags = buildSocialTags(html, 'rules.html', 'fr');
    assert.match(tags, /<meta property="og:title" content="Tom &amp; Jerry — &quot;the&lt;\/b&gt; best&quot; &lt;app&gt;">/);
    assert.match(tags, /<meta property="og:description" content="She said &quot;hi&quot; &amp; left; 5 &lt; 6">/);
    // the page still has exactly the tags it should: nothing broke out of an attribute
    const out = formatEnglishPage('rules.html', html);
    assert.equal(metaTags(out).length, 11);
    assert.equal(unescape(metaContent(out, 'og:title')), 'Tom & Jerry — "the</b> best" <app>');
});

test('building twice changes nothing, and the tags leave every English page\'s content hash as it was', () => {
    for (const page of ALL_PAGES) {
        const html = read('en', page);
        assert.equal(formatEnglishPage(page, html), html, `${page} is stable under a second build`);
        const bare = html
            .replace(/[ \t]*<meta\s+(?:property="og:|name="twitter:)[^>]*>[ \t]*\n?/g, '')
            .replace(/[ \t]*<script type="application\/ld\+json">[\s\S]*?<\/script>[ \t]*\n?/g, '');
        assert.equal(pageContentHash(html), pageContentHash(bare), `${page} content hash must ignore the generated tags`);
    }
});

test('the home page has JSON-LD with Organization, WebSite and SoftwareApplication, in English and a translation', () => {
    for (const lang of ['en', 'fr', 'ja']) {
        const html = read(lang, 'index.html');
        const data = jsonLd(html);
        assert.equal(data['@context'], 'https://schema.org');
        const byType = Object.fromEntries(data['@graph'].map((n) => [n['@type'], n]));
        assert.deepEqual(Object.keys(byType).sort(), ['Organization', 'SoftwareApplication', 'WebSite']);

        assert.equal(byType.Organization.name, 'The BeanPool Project');
        assert.equal(byType.Organization.url, 'https://beanpool.org/');
        assert.equal(byType.Organization.logo, 'https://beanpool.org/bean.png');
        assert.deepEqual(byType.Organization.sameAs, ['https://github.com/beanpool-org/beanpool']);

        assert.equal(byType.WebSite.name, 'BeanPool');
        assert.equal(byType.WebSite.url, pageUrl('index.html', lang));
        assert.equal(byType.WebSite.inLanguage, lang);

        const app = byType.SoftwareApplication;
        assert.equal(app.name, 'BeanPool');
        assert.equal(app.operatingSystem, 'Android, iOS, Web');
        assert.equal(app.offers.price, '0');
        assert.equal(app.url, 'https://beanpool.org/');
        assert.deepEqual(app.installUrl, [
            'https://play.google.com/store/apps/details?id=org.beanpool.pillar',
            'https://apps.apple.com/au/app/bean-pool/id6761870086'
        ]);
        // every store link in the data is one the page's own badges carry
        for (const link of app.installUrl) assert.ok(html.includes(`href="${link}`), `${lang}: badge for ${link}`);
    }
});

test('only the home page carries structured data, and a page without store links cannot build it', () => {
    for (const lang of LANGS) {
        for (const page of ALL_PAGES) {
            const file = path.join(WEBSITE_DIR, lang === 'en' ? '' : lang, page);
            if (!fs.existsSync(file)) continue;
            assert.equal(fs.readFileSync(file, 'utf8').includes('application/ld+json'), page === 'index.html', `${lang}/${page}`);
        }
    }
    assert.throws(() => buildJsonLd('<html></html>', 'en'), /Google Play and App Store links/);
});

test('the share image is a 1200 x 630 PNG under 200 KB', () => {
    assert.deepEqual(checkOgImage(), []);
    assert.deepEqual(checkOgImage(path.join(WEBSITE_DIR, 'missing.png')).length, 1);
    assert.equal(checkOgImage(path.join(WEBSITE_DIR, 'bean.png')).length > 0, true, 'a 512 x 512 file is refused');
});
