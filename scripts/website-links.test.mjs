// scripts/website-links.test.mjs: verify that every internal href in apps/website/**/*.html resolves to a file in the tree.
// S0 amendment (c): no link to a page that doesn't exist (fails first if beanpool.org/android is linked before S5 ships it).
//
//   node --test scripts/website-links.test.mjs
//

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
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
    // API routes are served by the registrar / backend worker, not static website files
    if (href.startsWith('/api/') || /^https?:\/\/beanpool\.org\/api\//i.test(href)) {
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

test('the "Start a community" install block enables Docker live-restore idempotently', () => {
    // 1. Check README.md install block
    const readmePath = path.join(ROOT, 'README.md');
    assert.ok(fs.existsSync(readmePath), 'README.md exists');
    const readmeContent = fs.readFileSync(readmePath, 'utf8');

    // Extract bash code block under "## Run a community"
    const runCommunityMatch = readmeContent.match(/## Run a community[\s\S]*?```bash\n([\s\S]*?)```/);
    assert.ok(runCommunityMatch, 'README has a bash code block under "## Run a community"');
    const readmeBlock = runCommunityMatch[1];

    // 2. Check apps/website/index.html install block
    const indexPath = path.join(SITE, 'index.html');
    assert.ok(fs.existsSync(indexPath), 'apps/website/index.html exists');
    const indexContent = fs.readFileSync(indexPath, 'utf8');
    const ctaMatch = indexContent.match(/<code class="cta-block">([\s\S]*?)<\/code>/);
    assert.ok(ctaMatch, 'apps/website/index.html has <code class="cta-block">');
    // Decode HTML entities
    const indexBlock = ctaMatch[1]
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');

    // 3. Verify step presence and properties in both blocks
    for (const [sourceName, block] of [
        ['README.md', readmeBlock],
        ['apps/website/index.html', indexBlock],
    ]) {
        assert.ok(block.includes('/etc/docker/daemon.json'), `${sourceName} block references /etc/docker/daemon.json`);
        assert.ok(block.includes('live-restore'), `${sourceName} block sets live-restore`);
        assert.ok(block.includes('systemctl reload docker'), `${sourceName} block reloads docker via systemctl`);
        assert.ok(!block.includes('systemctl restart docker'), `${sourceName} block never restarts docker`);
        assert.ok(block.includes("docker info --format '{{.LiveRestoreEnabled}}'"), `${sourceName} block checks LiveRestoreEnabled`);

        // Check idempotent shape:
        // Must check if file exists or handle missing file, and preserve other keys
        assert.ok(
            block.includes('d = json.load(open(p))') || block.includes('os.path.exists'),
            `${sourceName} block has idempotent json loading logic`
        );
    }

    // 4. Verify idempotent behavior by simulating the python3 snippet on temp files
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-restore-test-'));
    try {
        const fakeDaemon = path.join(tmpDir, 'daemon.json');

        // Extract the python snippet from readmeBlock, substituting the fake path
        const pySnippetMatch = readmeBlock.match(/python3 -c '([^']+)'/);
        assert.ok(pySnippetMatch, 'README block has a python3 -c snippet');
        const originalSnippet = pySnippetMatch[1];
        const runSnippet = (targetFile) => {
            const normalizedTarget = targetFile.replaceAll('\\', '/');
            const normalizedTmp = tmpDir.replaceAll('\\', '/');
            const adapted = originalSnippet
                .replaceAll('/etc/docker/daemon.json', normalizedTarget)
                .replaceAll('/etc/docker', normalizedTmp);
            execFileSync('python3', ['-c', adapted]);
        };

        // Test A: Missing daemon.json -> creates file with {"live-restore": true}
        runSnippet(fakeDaemon);
        let parsed = JSON.parse(fs.readFileSync(fakeDaemon, 'utf8'));
        assert.equal(parsed['live-restore'], true, 'missing daemon.json creates {"live-restore": true}');

        // Test B: Existing daemon.json with other keys -> preserves keys and sets live-restore
        fs.writeFileSync(fakeDaemon, JSON.stringify({ 'log-driver': 'json-file', 'max-size': '10m' }, null, 2));
        runSnippet(fakeDaemon);
        parsed = JSON.parse(fs.readFileSync(fakeDaemon, 'utf8'));
        assert.equal(parsed['live-restore'], true, 'existing daemon.json merges live-restore');
        assert.equal(parsed['log-driver'], 'json-file', 'existing log-driver is preserved');
        assert.equal(parsed['max-size'], '10m', 'existing max-size is preserved');

        // Test C: Second run is idempotent (no-op change)
        runSnippet(fakeDaemon);
        parsed = JSON.parse(fs.readFileSync(fakeDaemon, 'utf8'));
        assert.equal(parsed['live-restore'], true, 'idempotent rerun keeps live-restore true');
        assert.equal(parsed['log-driver'], 'json-file', 'idempotent rerun keeps existing keys');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
