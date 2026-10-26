// Marty's rule (27 Oct 2026): every domain name is a link, door 1 opens /global, and the website tells the truth
// that the global community is open (no "private preview" left on any English page).
//
// Fails on origin/main:
//   - door 1's href in apps/website/index.html is getting-started.html#global, not /global
//   - English pages still say "private preview", "opens to everyone soon", or "comes soon"
//   - bare domain names in visible text (e.g. global.beanpool.org in getting-started.html, beanpool.org in index.html)
//
// Run:
//   node --test scripts/website-domain-links.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));

const ENGLISH_PAGES = fs.readdirSync(SITE)
    .filter((f) => f.endsWith('.html') && !fs.statSync(path.join(SITE, f)).isDirectory());

// Placeholder patterns that are examples/patterns, not intended to hyperlink
const PLACEHOLDER_PATTERNS = [
    /\byourtown\.beanpool\.org\b/i,
    /\byour\.domain\b/i,
    /\byou@example\.com\b/i,
    /\bexample\.com\b/i,
];

function isPlaceholder(domain, text, index) {
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(domain))) return true;
    // e.g. "ending in .beanpool.org"
    if (index > 0 && text[index - 1] === '.') return true;
    return false;
}

test('door 1 on the home page points to /global', () => {
    const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
    const clean = html.replace(/<!--[\s\S]*?-->/g, '');
    const door1Match = clean.match(/<div\s+class="hero-door">[\s\S]*?<a\s+href="([^"]+)"\s+class="btn\s+btn-primary\s+font-header">Try it now, worldwide<\/a>/);
    assert.ok(door1Match, 'door 1 button exists in hero-door');
    assert.equal(door1Match[1], '/global', 'door 1 href must be /global');
});

test('no English page says "private preview", "opens to everyone soon", or "comes soon" about global', () => {
    const forbidden = [
        /private preview/i,
        /opens to everyone soon/i,
        /asking (?:one near you )?to join comes soon/i,
        /comes soon, when the global community opens/i,
    ];

    for (const page of ENGLISH_PAGES) {
        const html = fs.readFileSync(path.join(SITE, page), 'utf8');
        // Check both visible text and full markup (except old historical notes if any, but S0 cleared all)
        for (const pattern of forbidden) {
            const match = html.match(pattern);
            assert.ok(!match, `${page} must not match ${pattern}: found "${match?.[0]}"`);
        }
    }
});

test('every domain name in visible text across English pages is a hyperlink', () => {
    // Regex matching domain names: foo.org, foo.com, foo.beanpool.org, etc.
    const domainRegex = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:org|com|net|io|app|dev|edu|gov)(?:\/[^\s<>"'`)]*)?)\b/gi;

    for (const page of ENGLISH_PAGES) {
        let content = fs.readFileSync(path.join(SITE, page), 'utf8');
        // Strip comments, head, script, style, code blocks (e.g. bash git clone commands)
        content = content.replace(/<!--[\s\S]*?-->/g, '');
        content = content.replace(/<head\b[\s\S]*?<\/head>/gi, '');
        content = content.replace(/<script\b[\s\S]*?<\/script>/gi, '');
        content = content.replace(/<style\b[\s\S]*?<\/style>/gi, '');
        content = content.replace(/<code\b[\s\S]*?<\/code>/gi, '');

        // Remove <a> tags completely
        while (/<a\b[^>]*>[\s\S]*?<\/a>/gi.test(content)) {
            content = content.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, '');
        }

        // Remove all HTML tags to leave visible text
        const text = content.replace(/<[^>]+>/g, ' ');

        const matches = [...text.matchAll(domainRegex)];
        const unlinked = [];
        for (const m of matches) {
            const domain = m[0];
            if (isPlaceholder(domain, text, m.index)) continue;
            unlinked.push(domain);
        }

        assert.deepEqual(unlinked, [], `${page} has bare (unlinked) domain names in visible text: ${unlinked.join(', ')}`);
    }
});

test('global.html carries apple-itunes-app meta tag for Safari', () => {
    const html = fs.readFileSync(path.join(SITE, 'global.html'), 'utf8');
    const metaMatch = html.match(/<meta\s+name="apple-itunes-app"\s+content="([^"]*)"/i);
    assert.ok(metaMatch, 'global.html has apple-itunes-app meta tag');
    const content = metaMatch[1];
    assert.match(content, /\bapp-id=6761870086\b/);
    assert.match(content, /\bapp-argument=https:\/\/beanpool\.org\/global\b/);
});
