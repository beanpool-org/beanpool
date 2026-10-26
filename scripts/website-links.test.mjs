// scripts/website-links.test.mjs: verify that every internal href in apps/website/**/*.html resolves to a file in the tree.
// S0 amendment (c): no link to a page that doesn't exist (fails first if beanpool.org/android is linked before S5 ships it).
//
//   node --test scripts/website-links.test.mjs
//

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.resolve(process.env.WEBSITE_ROOT ?? path.join(ROOT, 'apps/website'));

/** Recursively collects all .html files in dir. */
function collectHtmlFiles(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectHtmlFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
            files.push(full);
        }
    }
    return files;
}

/** Determines if an href is an internal link on the beanpool.org website. */
function isInternalHref(href) {
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
        return false;
    }
    if (/^https?:\/\/beanpool\.org(?:\/|$)/i.test(href)) {
        return true;
    }
    // External absolute URL (including subdomains like global.beanpool.org)
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) {
        return false;
    }
    return true;
}

/** Resolves an internal href from filePath to possible target file paths. */
function resolveInternalHref(filePath, href) {
    let clean = href.split(/[?#]/)[0];
    if (/^https?:\/\/beanpool\.org/i.test(clean)) {
        clean = clean.replace(/^https?:\/\/beanpool\.org/i, '');
        if (!clean) clean = '/';
    }

    let targetPath;
    if (clean.startsWith('/')) {
        targetPath = path.join(SITE, clean.slice(1));
    } else {
        targetPath = path.resolve(path.dirname(filePath), clean);
    }
    return targetPath;
}

/** Checks whether a resolved target path exists in the tree as a file, .html, or dir/index.html. */
function targetExists(targetPath) {
    if (fs.existsSync(targetPath)) {
        const stat = fs.statSync(targetPath);
        if (stat.isFile()) return true;
        if (stat.isDirectory()) {
            return fs.existsSync(path.join(targetPath, 'index.html'));
        }
    }
    if (fs.existsSync(`${targetPath}.html`)) {
        return true;
    }
    return false;
}

test('every internal href in apps/website/**/*.html resolves to a file in the tree', () => {
    assert.ok(fs.existsSync(SITE), `website directory ${SITE} exists`);
    const htmlFiles = collectHtmlFiles(SITE);
    assert.ok(htmlFiles.length >= 8, `found ${htmlFiles.length} HTML files`);

    const broken = [];

    for (const file of htmlFiles) {
        const content = fs.readFileSync(file, 'utf8');
        // Strip HTML comments to avoid checking disabled code
        const clean = content.replace(/<!--[\s\S]*?-->/g, '');

        const hrefMatches = clean.matchAll(/\b(?:href|action)="([^"]*)"/g);
        for (const m of hrefMatches) {
            const rawHref = m[1].trim();
            if (!isInternalHref(rawHref)) continue;

            const target = resolveInternalHref(file, rawHref);
            if (!targetExists(target)) {
                const relFile = path.relative(SITE, file);
                broken.push({ file: relFile, href: rawHref, target: path.relative(SITE, target) });
            }
        }
    }

    assert.deepEqual(broken, [], `Broken internal links found: ${JSON.stringify(broken, null, 2)}`);
});
