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
import { spawnSync } from 'node:child_process';
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

// ---------------------------------------------------------------------------------------------------------------------
// The Docker live-restore step of "Start a community", and the one-paste block it follows.
//
// Self-hosters copy this step onto their own servers, so it has to work for root and for a user with sudo, check that
// systemd and Docker are there, never damage an existing /etc/docker/daemon.json, and be the same text everywhere it
// appears: the README and the server README.
//
// It is an OPTIONAL step in a block of its own, below the one-paste quickstart (Marty, 29 Oct 2026): the quickstart stays
// short for newcomers, and says nothing about live-restore. An AI assistant doing the install always does the step, and
// the step points it to the install-with-AI page.
//
// The website does not carry the step (Marty, 29 Oct 2026, evening: "lets get start a community on its own page - straight
// up", after seeing 35 lines of install code on the home page): beanpool.org/start, in every language, has the one-paste
// block, the same as the README's, and one sentence that sends to the operator manual's Updates and health page; the home
// page has no install code at all, only a teaser with a button to /start. The README is for operators, so it keeps the step.
// ---------------------------------------------------------------------------------------------------------------------

const STEP_FIRST_LINE = '# Docker live-restore:';
const SOURCE_LANGS = fs.readdirSync(path.join(ROOT, 'apps/website-src/content')).sort();
const ON_WINDOWS = process.platform === 'win32';
const WINDOWS_NOTE = 'the step runs on Linux; Python on Windows has no fchmod or fchown';

/** Decodes the HTML escapes used inside the site's <code> blocks. */
const decodeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The live-restore step in `text`: from its first comment line to the line that closes its heredoc (EOF). */
function extractStep(text, where) {
    const lines = text.split('\n');
    const first = lines.findIndex((l) => l.startsWith(STEP_FIRST_LINE));
    assert.ok(first >= 0, `${where} has the live-restore step`);
    assert.equal(lines.findIndex((l, i) => i > first && l.startsWith(STEP_FIRST_LINE)), -1, `${where} has the step only once`);
    const last = lines.indexOf('EOF', first);
    assert.ok(last > first, `${where}: the step ends with a line holding only EOF`);
    return lines.slice(first, last + 1).join('\n');
}

/** What the quickstart must never carry: the live-restore step, or anything it runs. */
const LIVE_RESTORE_WORDS = /live-restore|LiveRestore|daemon\.json|systemctl|\bsudo\b|python3|<<'?EOF/i;

/** One page of the English site, and of each of the 24 languages as a source and as a built page: [name, file]. */
function websitePages(page) {
    const pages = [[`apps/website/${page}`, path.join(SITE, page)]];
    for (const lang of SOURCE_LANGS) {
        pages.push([`apps/website-src/content/${lang}/${page}`, path.join(ROOT, 'apps/website-src/content', lang, page)]);
        pages.push([`apps/website/${lang}/${page}`, path.join(SITE, lang, page)]);
    }
    return pages;
}

/** The one-paste quickstart alone (the one copyable block of beanpool.org/start), by file, whatever else the page holds. */
function quickstartBlocks() {
    const found = new Map();
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const section = readme.match(/\n## Run a community\n([\s\S]*?)\n---\n/);
    assert.ok(section, 'README has "## Run a community"');
    const fence = section[1].match(/```bash\n([\s\S]*?)```/);
    assert.ok(fence, 'README has the quickstart block under "## Run a community"');
    found.set('README.md', fence[1].trim());
    for (const [name, file] of websitePages('start.html')) {
        assert.ok(fs.existsSync(file), `${name} exists`);
        const blocks = [...fs.readFileSync(file, 'utf8').matchAll(/<code class="cta-block">([\s\S]*?)<\/code>/g)];
        assert.equal(blocks.length, 1, `${name} has one <code class="cta-block">, the quickstart: the live-restore step is not on the website`);
        found.set(name, decodeHtml(blocks[0][1]).trim());
    }
    return found;
}

/**
 * The two copyable blocks of "Run a community" in the README: the one-paste `quickstart`, and below it the `stepBlock` with
 * the optional live-restore `step` in it. `lead` is the words just above the step's block: its heading and sentences.
 */
function pasteBlocks() {
    const found = new Map();
    const entry = (name, quickstart, stepBlock, lead) => ({ quickstart: quickstart.trim(), stepBlock, step: extractStep(stepBlock, name), lead });

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    const section = readme.match(/\n## Run a community\n([\s\S]*?)\n---\n/);
    assert.ok(section, 'README has "## Run a community"');
    const fences = [...section[1].matchAll(/```bash\n([\s\S]*?)```/g)];
    assert.equal(fences.length, 2, 'README: "## Run a community" has two bash blocks, the quickstart and the optional step');
    const above = section[1].slice(fences[0].index + fences[0][0].length, fences[1].index).trim().split(/\n\s*\n/).pop();
    found.set('README.md', entry('README.md', fences[0][1], fences[1][1], above));
    return found;
}

/** The step in the server README (a step-by-step setup, not a one-paste block): its block, and the paragraph above it. */
function serverReadmeStep() {
    const text = fs.readFileSync(path.join(ROOT, 'apps/server/README.md'), 'utf8');
    const fences = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].filter((f) => f[1].includes(STEP_FIRST_LINE));
    assert.equal(fences.length, 1, 'apps/server/README.md has the live-restore step in one bash block');
    const above = text.slice(0, fences[0].index).trim().split(/\n\s*\n/).pop();
    return { stepBlock: fences[0][1], step: extractStep(fences[0][1], 'apps/server/README.md'), lead: above };
}

/** Every copy of the step in the tree, by file: the README and the server README. */
function stepCopies() {
    const copies = new Map();
    for (const [name, found] of pasteBlocks()) copies.set(name, found.step);
    copies.set('apps/server/README.md', serverReadmeStep().step);
    return copies;
}

const CANONICAL = () => stepCopies().get('README.md');

/** The Python program of the step, with its path to daemon.json replaced. */
function pythonOf(step, daemonJson) {
    const py = step.match(/python3 - <<'PY'[^\n]*\n([\s\S]*?)\nPY\n/);
    assert.ok(py, 'the step runs a python3 program from a heredoc');
    const quoted = '"/etc/docker/daemon.json"';
    assert.ok(py[1].includes(quoted), 'the program names /etc/docker/daemon.json');
    return py[1].replace(quoted, JSON.stringify(daemonJson.replaceAll('\\', '/')));
}

/** The script the step hands to sh (root, or sudo -n): the outer heredoc, with the path to daemon.json replaced. */
function scriptOf(step, daemonJson) {
    const lines = step.split('\n');
    const open = lines.findIndex((l) => l.includes("<<'EOF'"));
    assert.ok(open >= 0 && lines[lines.length - 1] === 'EOF', 'the step hands a heredoc to sh');
    return lines.slice(open + 1, -1).join('\n').replace('"/etc/docker/daemon.json"', JSON.stringify(daemonJson.replaceAll('\\', '/'))) + '\n';
}

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-restore-test-'));

test('the live-restore step is the same text in the README and the server README', () => {
    const copies = stepCopies();
    assert.equal(copies.size, 2, 'README and server README');
    const canonical = copies.get('README.md');
    const different = [...copies].filter(([, step]) => step !== canonical).map(([name]) => name);
    assert.deepEqual(different, [], `these copies differ from the README step: ${different.join(', ')}`);
});

test('the live-restore step is on no website page: the home page has no install code, /start has the one-paste block and a pointer, in all 25 languages', () => {
    assert.equal(SOURCE_LANGS.length, 24, 'there are 24 translation sources');
    const everyPage = [...websitePages('index.html'), ...websitePages('start.html')];
    assert.equal(everyPage.length, 2 * (1 + 24 + 24), 'the English page, 24 sources and 24 built pages, for the home page and for /start');
    for (const [name, file] of everyPage) {
        assert.ok(fs.existsSync(file), `${name} exists`);
        const html = fs.readFileSync(file, 'utf8');
        assert.ok(!html.includes(STEP_FIRST_LINE), `${name}: the live-restore step is not on the website`);
        assert.deepEqual(html.split('\n').filter((l) => /live-restore|LiveRestore|daemon\.json|systemctl|python3|<<'?EOF/i.test(l)), [], `${name}: no line about live-restore or what the step runs`);
        const blocks = (html.match(/<code class="cta-block">/g) || []).length;
        if (name.endsWith('index.html')) assert.equal(blocks, 0, `${name}: the home page has no install code`);
        else assert.equal(blocks, 1, `${name}: /start has the one-paste block only`);
    }
});

test('/start in every language sends to the operator manual for the live-restore step, and to the install-with-AI page for what an assistant does', () => {
    const UPDATES = 'https://github.com/beanpool-org/beanpool/blob/main/packages/beanpool-guide/operators/server/updates-and-health.md';
    const WITH_AI = 'https://github.com/beanpool-org/beanpool/blob/main/packages/beanpool-guide/operators/setup/install-with-ai.md';
    for (const [name, file] of websitePages('start.html')) {
        const html = fs.readFileSync(file, 'utf8');
        const at = html.indexOf('<h2 id="keep-running">');
        assert.ok(at > 0, `${name}: has the Recommended heading (keep-running)`);
        assert.ok(at > html.indexOf('<code class="cta-block">'), `${name}: the pointer comes after the one-paste block`);
        const section = html.slice(at, html.indexOf('</main>'));
        const paragraph = section.match(/<\/h2>\s*<p>([\s\S]*?)<\/p>/)[1];
        assert.ok(paragraph.includes(`href="${UPDATES}"`), `${name}: it links the operator manual's Updates and health page`);
        assert.ok(paragraph.includes(`href="${WITH_AI}"`), `${name}: it links the install-with-AI page, where an assistant is told it always does the step`);
        assert.equal((section.match(/<p>/g) || []).length, 1, `${name}: it is one paragraph`);
    }
    // The pointer in English is one sentence about the step, then the AI-assistant sentence.
    const en = fs.readFileSync(path.join(SITE, 'start.html'), 'utf8');
    assert.match(en, /<h2 id="keep-running">Recommended: keep your community running when Docker updates<\/h2>/);
    assert.match(en, /An AI assistant doing the install always does this step \(<a href="[^"]+install-with-ai\.md"/);
});

test('the one-paste block has no live-restore line: the same short block in the README and on /start in all 25 languages', () => {
    const blocks = quickstartBlocks();
    assert.equal(blocks.size, 1 + 1 + 24 + 24, 'README, English /start, 24 sources and 24 built pages');
    const canonical = blocks.get('README.md');
    assert.ok(canonical.startsWith('git clone https://github.com/beanpool-org/beanpool.git && cd beanpool\ndocker network create beanpool-shared\n'), 'it starts with the clone and the network');
    assert.ok(canonical.endsWith('\ndocker compose exec beanpool-node beanpool claim'), 'and ends with the claim');
    assert.ok(canonical.split('\n').length <= 10, 'and is a short block');
    for (const [name, quickstart] of blocks) {
        assert.deepEqual(quickstart.split('\n').filter((l) => LIVE_RESTORE_WORDS.test(l)), [], `${name}: no line of the one-paste block is about live-restore`);
        assert.equal(quickstart, canonical, `${name}: the one-paste block is the README's`);
    }
});

test('the live-restore step is optional: below the one-paste block, in a block of its own, headed in plain words, and linked to the install-with-AI page', () => {
    const blocks = pasteBlocks();
    for (const [name, { stepBlock, step, lead }] of blocks) {
        assert.equal(stepBlock.trim(), step, `${name}: the step's block holds the step and nothing else, so one copy button copies all of it`);
        assert.ok(lead.includes('install-with-ai.md'), `${name}: the words above the step link it to the install-with-AI page`);
    }
    {
        const { lead } = blocks.get('README.md');
        for (const words of [
            'Recommended: keep your community running when Docker updates',
            'Docker can restart, or take a patch update, without stopping your community',
            'needs root or',
            'safe to skip',
            // Agents read the README: they must find out that the step is theirs to do.
            'An AI assistant doing the install always does this step',
        ]) {
            assert.ok(lead.includes(words), `README.md: the step is introduced with "${words}"`);
        }
    }
    const server = serverReadmeStep();
    assert.equal(server.stepBlock.trim(), server.step, 'apps/server/README.md: the step is in a block of its own');
    assert.ok(server.lead.includes('install-with-ai.md') && server.lead.includes('safe to skip') && server.lead.includes('An AI assistant doing the install always does this step'), 'apps/server/README.md: the paragraph above the step says the same');
});

test('the live-restore step reads systemd and Docker first, uses sudo only without a password prompt, and reloads, never restarts', () => {
    const step = CANONICAL();
    const commands = step.split('\n').filter((l) => !l.startsWith('#')).join('\n');

    assert.ok(step.includes('/etc/docker/daemon.json'), 'names /etc/docker/daemon.json');
    assert.ok(step.includes('live-restore'), 'sets live-restore');

    // Root runs it as it is; anyone else goes through sudo -n, which fails at once instead of asking for a password in the
    // middle of a paste (the lines after it would be typed into the prompt).
    assert.ok(commands.includes('if [ "$(id -u)" = 0 ]; then sh; else sudo -n sh; fi'), 'root runs sh, others run sudo -n sh');
    const bare = commands.replace(/"[^"\n]*"/g, '""'); // what the shell runs, without the words it prints
    assert.equal(bare.match(/\bsudo\b/g).length, 1, 'sudo is run in one place only');
    assert.ok(/\bsudo -n sh\b/.test(bare), 'and that place is sudo -n sh, which cannot prompt');
    assert.ok(step.split('\n')[1].includes('Not root?') && step.includes('sudo -v'), 'says in plain words what a non-root user does');

    // An interactive zsh (the macOS default) does not skip comment lines unless interactive_comments is set, so it reads
    // them as commands: a ' (or " or `) opens a quote that runs on through the lines below it and the step never runs, and
    // a ; & | < > ( ) $ \ would end, chain, redirect or continue the "command".
    const commentLines = step.split('\n').filter((l) => l.startsWith('#'));
    assert.ok(commentLines.length > 0, 'the step has comment lines to check');
    assert.deepEqual(commentLines.filter((l) => /['"`;&|<>()$\\]/.test(l)), [], 'no comment line of the step has a quote or shell operator in it');

    // The checks come before anything is written.
    const at = (needle) => commands.indexOf(needle);
    assert.ok(at('command -v systemctl') > 0, 'checks that systemd is there');
    assert.ok(at('docker info >/dev/null') > at('command -v systemctl'), 'checks that Docker is running');
    assert.ok(at('python3 - <<') > at('docker info >/dev/null'), 'writes only after the checks');
    assert.ok(commands.includes('systemctl start docker'), 'says how to start Docker when it is not running');

    // Docker takes a setting from a dockerd flag or from daemon.json, never both: a host with --live-restore in its unit and
    // the key in the file fails at the next start. So the step asks Docker first and, when it is already on, stops without
    // an error and before anything is written or reloaded.
    const askedFirst = commands.indexOf("docker info --format '{{.LiveRestoreEnabled}}'");
    assert.ok(askedFirst > at('docker info >/dev/null') && askedFirst < at('python3 - <<'), 'asks Docker whether live-restore is already on, after Docker is known to run and before anything is written');
    assert.ok(/ = true \] && \{ echo "[^"\n]*already on[^"\n]*"; exit 0; \}/.test(commands), 'and stops with exit 0, not an error, when it is');

    // Live-restore covers a restart and a patch update (YY.MM.x), not a new YY.MM, so the step must not promise more.
    assert.ok(step.split('\n')[0].includes('take a patch update'), 'says live-restore covers a patch update');
    assert.ok(!/restart or update/.test(step), 'does not say any update leaves the community running');

    // Atomic, key-keeping, mode-keeping write; refuses a file it cannot read as a JSON object.
    for (const piece of ['json.loads', 'os.replace(tmp, p)', 'os.fsync', 'os.fchmod', 'os.fchown', 'os.path.realpath', 'isinstance(d, dict)']) {
        assert.ok(step.includes(piece), `the write uses ${piece}`);
    }
    assert.ok(!step.includes('open(p, "w")'), 'daemon.json is never opened for writing in place');

    // Reload, never restart; confirm.
    assert.ok(commands.includes('systemctl reload docker'), 'reloads docker via systemctl');
    assert.ok(!/systemctl restart|service docker restart/.test(step), 'never restarts docker');
    assert.ok(step.includes("docker info --format '{{.LiveRestoreEnabled}}'"), 'checks LiveRestoreEnabled');
    assert.ok(/"\$\(docker info --format '\{\{\.LiveRestoreEnabled\}\}'[^)]*\)" = true/.test(step), 'and requires it to be true');
});

test('the live-restore step parses in bash and zsh, and its script in sh', () => {
    const step = CANONICAL();
    const dir = sandbox();
    try {
        const script = scriptOf(step, path.join(dir, 'daemon.json'));
        let checked = 0;
        for (const [shell, input] of [['bash', step], ['zsh', step], ['sh', script], ['dash', script]]) {
            const r = spawnSync(shell, ['-n'], { input, encoding: 'utf8' });
            if (r.error?.code === 'ENOENT') continue; // not installed here
            assert.equal(r.status, 0, `${shell} -n: ${r.stderr}`);
            checked += 1;
        }
        assert.ok(checked >= 2, 'at least bash and sh are there to check with');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the live-restore program writes daemon.json atomically, keeps every key and the file mode, and refuses what is not JSON', { skip: ON_WINDOWS && WINDOWS_NOTE }, () => {
    const step = CANONICAL();
    const dir = sandbox();
    try {
        const run = (file) => spawnSync('python3', ['-c', pythonOf(step, file)], { encoding: 'utf8' });
        const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
        const leftovers = () => fs.readdirSync(path.join(dir, 'docker')).filter((n) => n !== 'daemon.json');
        const file = path.join(dir, 'docker', 'daemon.json');

        // A: no file, and not even the folder
        let r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(read(file), { 'live-restore': true }, 'a missing daemon.json is created');
        assert.equal(fs.statSync(file).mode & 0o777, 0o644, 'a new file is world-readable like Docker\'s own');
        assert.deepEqual(leftovers(), [], 'no temporary file is left behind');

        // B: an empty file and a blank one count as {}
        for (const blank of ['', '  \n']) {
            fs.writeFileSync(file, blank);
            r = run(file);
            assert.equal(r.status, 0, r.stderr);
            assert.deepEqual(read(file), { 'live-restore': true }, `a ${JSON.stringify(blank)} file becomes {"live-restore": true}`);
        }

        // C: other keys, including nested ones, are all kept; a false is turned on
        const others = { 'log-driver': 'json-file', 'log-opts': { 'max-size': '10m' }, proxies: { 'http-proxy': 'http://u:p@proxy:3128' }, 'live-restore': false };
        fs.writeFileSync(file, JSON.stringify(others, null, 2));
        r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(read(file), { ...others, 'live-restore': true }, 'every existing key is kept');
        assert.deepEqual(leftovers(), [], 'no temporary file is left behind after a merge');

        // D: a second run changes nothing, not even the bytes
        const before = fs.readFileSync(file);
        r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(before.equals(fs.readFileSync(file)), 'a rerun leaves the file as it was');

        // E: a file that already has it on, written by hand, is not reformatted
        const byHand = '{"live-restore":true,\n "debug":   true}\n';
        fs.writeFileSync(file, byHand);
        r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.readFileSync(file, 'utf8'), byHand, 'a file that is already right is not rewritten');

        // F: the mode of a locked-down file survives the swap (it may hold proxy or registry passwords)
        fs.writeFileSync(file, JSON.stringify({ proxies: { 'http-proxy': 'http://u:p@proxy:3128' } }));
        fs.chmodSync(file, 0o600);
        r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'a 0600 daemon.json stays 0600');
        assert.equal(read(file).proxies['http-proxy'], 'http://u:p@proxy:3128');

        // G: what is not a JSON object is left alone, with a message and a failing exit
        for (const bad of ['{"log-driver": ', '[]', 'null', '"live-restore"', '{"a": 1} trailing', 'not json']) {
            fs.writeFileSync(file, bad);
            fs.chmodSync(file, 0o640);
            r = run(file);
            assert.notEqual(r.status, 0, `${JSON.stringify(bad)} is refused`);
            assert.match(r.stderr, /not a JSON object, so it is left alone/, 'and says why');
            assert.equal(fs.readFileSync(file, 'utf8'), bad, `${JSON.stringify(bad)} is not touched`);
            assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'nor its mode');
            assert.deepEqual(leftovers(), [], 'and no temporary file is left');
        }

        // H: a symlinked daemon.json stays a symlink; the file it points to is updated
        const real = path.join(dir, 'real-daemon.json');
        fs.writeFileSync(real, JSON.stringify({ 'log-driver': 'local' }));
        fs.rmSync(file);
        fs.symlinkSync(real, file);
        r = run(file);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(fs.lstatSync(file).isSymbolicLink(), 'the symlink is still a symlink');
        assert.deepEqual(read(real), { 'log-driver': 'local', 'live-restore': true }, 'the target was updated');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/** Stand-in docker, systemctl and sudo (and the real python3) in a folder of their own, for running the step without Docker. */
function makeStubs(dir, { systemctl = true } = {}) {
    const stubs = path.join(dir, 'bin');
    fs.mkdirSync(stubs);
    const script = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    script('docker', [
        '[ -n "$FAKE_DOCKER_DOWN" ] && exit 1',
        // `docker info --format` says false until the log holds the reload (as a real dockerd does when live-restore is only in
        // daemon.json), then true; FAKE_LIVE_RESTORE fixes the answer instead (true: a --live-restore flag or an earlier run).
        // Shell builtins only: one test runs the script with nothing but these stand-ins on PATH.
        '[ "$1" = info ] && [ "$2" = --format ] && {',
        '  reloaded=; while IFS= read -r line; do [ "$line" = "systemctl reload docker" ] && reloaded=1; done < "$FAKE_LOG"',
        '  if [ -n "$FAKE_LIVE_RESTORE" ]; then echo "$FAKE_LIVE_RESTORE"; elif [ -n "$reloaded" ]; then echo true; else echo false; fi',
        '  exit 0; }',
        '[ "$1" = info ] && exit 0',
        'exit 2',
    ].join('\n'));
    if (systemctl) script('systemctl', ['echo "systemctl $*" >> "$FAKE_LOG"', '[ -n "$FAKE_RELOAD_FAILS" ] && exit 1', 'exit 0'].join('\n'));
    script('sudo', [
        '[ "$1" = -n ] || { echo "stub sudo: only sudo -n is allowed" >&2; exit 2; }',
        'echo "sudo $*" >> "$FAKE_LOG"',
        '[ -n "$FAKE_SUDO_PASSWORD" ] && { echo "sudo: a password is required" >&2; exit 1; }',
        'shift',
        'exec "$@"',
    ].join('\n'));
    const python = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(fs.realpathSync(python), path.join(stubs, 'python3'));
    return stubs;
}

/** Runs `shell` with `input` as its script, the stubs first on PATH, and returns the result plus what the stubs logged. */
function runWithStubs(dir, shell, input, { path: pathValue, env = {} } = {}) {
    const log = path.join(dir, 'log.txt');
    fs.writeFileSync(log, '');
    const r = spawnSync(shell, [], {
        input,
        encoding: 'utf8',
        env: { PATH: pathValue, FAKE_LOG: log, ...env },
    });
    return { ...r, out: `${r.stdout}${r.stderr}`, calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) };
}

test('the live-restore script stops with a plain message when systemd or Docker is missing, or daemon.json is bad, and reloads when all is well', { skip: ON_WINDOWS && WINDOWS_NOTE }, () => {
    const step = CANONICAL();
    const dir = sandbox();
    try {
        const file = path.join(dir, 'daemon.json');
        const script = scriptOf(step, file);
        const stubs = makeStubs(dir);
        const noSystemd = makeStubs(fs.mkdtempSync(path.join(dir, 'nosystemd-')), { systemctl: false });
        const run = (opts, pathValue = stubs) => runWithStubs(dir, '/bin/sh', script, { path: pathValue, ...opts });

        // all well: written, reloaded (once, never restarted) and confirmed
        let r = run({});
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /Docker live-restore is on\./);
        assert.deepEqual(r.calls, ['systemctl reload docker']);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['live-restore'], true);

        // no systemd: says so, writes nothing
        fs.rmSync(file);
        r = run({}, noSystemd);
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /no systemd \(no systemctl\), so live-restore is skipped/);
        assert.ok(!fs.existsSync(file), 'nothing is written without systemd');

        // Docker not running: says how to start it, writes nothing, reloads nothing
        r = run({ env: { FAKE_DOCKER_DOWN: '1' } });
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /Docker is not installed or not running \(start it with: sudo systemctl start docker\)/);
        assert.ok(!fs.existsSync(file), 'nothing is written while Docker is down');
        assert.deepEqual(r.calls, []);

        // a daemon.json that is not JSON: left alone, nothing reloaded
        fs.writeFileSync(file, '{"log-driver": ');
        r = run({});
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /not a JSON object, so it is left alone/);
        assert.equal(fs.readFileSync(file, 'utf8'), '{"log-driver": ');
        assert.deepEqual(r.calls, []);
        fs.rmSync(file);

        // reload fails: not reported as done
        r = run({ env: { FAKE_RELOAD_FAILS: '1' } });
        assert.equal(r.status, 1, r.out);
        assert.ok(!/live-restore is on/.test(r.out));
        fs.rmSync(file);

        // Docker still says false after the reload: says so
        r = run({ env: { FAKE_LIVE_RESTORE: 'false' } });
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /Docker live-restore did not turn on\./);
        fs.rmSync(file, { force: true });

        // Docker already has it on (a --live-restore flag in its unit, or an earlier run): daemon.json must not get a second
        // copy of the setting, because Docker refuses a directive given both as a flag and in the file, and the next start
        // fails. Nothing is created, nothing is reloaded, and it is not reported as a failure.
        r = run({ env: { FAKE_LIVE_RESTORE: 'true' } });
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /Docker live-restore is already on\./);
        assert.ok(!/did not turn on|is skipped/.test(r.out), 'no failure message');
        assert.ok(!fs.existsSync(file), 'no daemon.json is created');
        assert.deepEqual(r.calls, [], 'nothing is reloaded');

        // ... and a daemon.json that is there is left byte for byte as it is, even one that is not valid JSON.
        for (const bytes of ['{"log-driver":"local"}', '{"log-driver": ']) {
            fs.writeFileSync(file, bytes);
            r = run({ env: { FAKE_LIVE_RESTORE: 'true' } });
            assert.equal(r.status, 0, r.out);
            assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'daemon.json is untouched');
            assert.deepEqual(r.calls, []);
        }
        fs.rmSync(file);

        // Not on yet: the stand-in says false until the reload, so the step writes, reloads once and then sees true.
        r = run({});
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /Docker live-restore is on\./);
        assert.ok(!/already on/.test(r.out));
        assert.deepEqual(r.calls, ['systemctl reload docker']);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the whole live-restore step works as root and as a user with sudo, and a sudo password prompt cannot swallow the install', { skip: ON_WINDOWS && WINDOWS_NOTE }, () => {
    const step = CANONICAL();
    const dir = sandbox();
    try {
        const file = path.join(dir, 'daemon.json');
        const pasted = step.replace('"/etc/docker/daemon.json"', JSON.stringify(file)) + '\necho AFTER-THE-STEP\n';
        const stubs = makeStubs(dir);
        const withSystemPath = `${stubs}:/usr/bin:/bin`;
        const root = typeof process.getuid === 'function' && process.getuid() === 0;
        const run = (env = {}) => runWithStubs(dir, 'bash', pasted, { path: withSystemPath, env });

        // sudo works (or we are root): written, reloaded, and the lines after the step still run
        let r = run();
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /Docker live-restore is on\./);
        assert.match(r.out, /AFTER-THE-STEP/);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))['live-restore'], true);
        assert.ok(r.calls.includes('systemctl reload docker') && r.calls.every((c) => !/restart/.test(c)));
        assert.deepEqual(r.calls.filter((c) => c.startsWith('sudo ')), root ? [] : ['sudo -n sh'], root ? 'root does not need sudo' : 'a user goes through sudo -n');

        // sudo wants a password: no prompt, nothing written, a message says what to type, and the install carries on
        if (!root) {
            fs.rmSync(file);
            r = run({ FAKE_SUDO_PASSWORD: '1' });
            assert.equal(r.status, 0, r.out);
            assert.match(r.out, /a password is required/);
            assert.match(r.out, /Docker live-restore is still off\. Your community runs without it\. If sudo wanted a password, type: sudo -v/);
            assert.match(r.out, /AFTER-THE-STEP/, 'the lines after the step still run');
            assert.ok(!fs.existsSync(file), 'nothing is written');
        }

        // Docker already has live-restore on: the step leaves daemon.json alone, says so, is not an error (so the "still off"
        // message does not fire), and the install carries on.
        fs.rmSync(file, { force: true });
        r = run({ FAKE_LIVE_RESTORE: 'true' });
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /Docker live-restore is already on\./);
        assert.ok(!/still off/.test(r.out), 'not reported as a failure');
        assert.match(r.out, /AFTER-THE-STEP/, 'the lines after the step still run');
        assert.ok(!fs.existsSync(file), 'nothing is written');
        assert.ok(r.calls.every((c) => !/reload|restart/.test(c)), 'nothing is reloaded');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('each operator page says the same thing about live-restore, in one paragraph under its heading', () => {
    const pages = ['setup/first-time-setup.md', 'setup/install-with-ai.md', 'server/updates-and-health.md'];
    const required = [
        'sudo',
        'command -v systemctl',
        'docker info',
        '/etc/docker/daemon.json',
        '{"live-restore": true}',
        'every other key',
        'cp -p',
        'valid JSON',
        'systemctl reload docker',
        'never a restart',
        "docker info --format '{{.LiveRestoreEnabled}}'",
        // Docker promises live-restore across patch updates only, not a new YY.MM, so the page says so ...
        'patch update',
        'quiet hour',
        // ... and when Docker already has it on (a flag), the file is left alone: a second copy stops Docker from starting.
        'already prints true',
        '--live-restore flag',
        'leave daemon.json alone',
        'a second copy',
        // It is an optional step below the install block, not part of it, and an AI assistant always does it.
        'optional step below the install block',
        'safe to skip',
        'an AI assistant doing the install always does it',
    ];
    for (const page of pages) {
        const text = fs.readFileSync(path.join(ROOT, 'packages/beanpool-guide/operators', page), 'utf8');
        const lines = text.split('\n');
        const heading = lines.findIndex((l) => /^### Docker (and )?live-restore$/.test(l));
        assert.ok(heading >= 0, `${page} has a live-restore section`);
        let end = lines.findIndex((l, i) => i > heading && l.startsWith('#'));
        if (end < 0) end = lines.length;
        const paragraphs = lines.slice(heading + 1, end).join('\n').trim().split(/\n\s*\n/);
        // A heading that sits in the middle of a page takes over the paragraphs after it: the section must be this one only.
        assert.equal(paragraphs.length, 1, `${page}: the live-restore section is one paragraph, so no other paragraph is filed under it`);
        for (const phrase of required) {
            assert.ok(paragraphs[0].includes(phrase), `${page}: the live-restore paragraph says "${phrase}"`);
        }
        assert.ok(!/restart or update/.test(text), `${page} does not say any update leaves the community running`);
        assert.ok(!/gets this from the install block/.test(text), `${page} does not say the install block does it: the block no longer carries the step`);
    }
    const assistant = fs.readFileSync(path.join(ROOT, 'packages/beanpool-guide/operators/setup/install-with-ai.md'), 'utf8')
        .split('\n').find((l) => l.startsWith('- Turn on Docker live-restore'));
    assert.ok(assistant, 'the assistant is told to turn on live-restore');
    for (const phrase of ['sudo', 'command -v systemctl', 'Docker is not running', '/etc/docker/daemon.json', 'every other key', 'cp -p', 'valid JSON', 'systemctl reload docker', 'never a restart', "docker info --format '{{.LiveRestoreEnabled}}'", 'patch update', 'already says true', '--live-restore flag', 'a second copy', 'optional step below the block', 'an assistant always does it']) {
        assert.ok(assistant.includes(phrase), `the assistant's instruction says "${phrase}"`);
    }
});
