// Tests for scripts/check-workflows.mjs: the repository's workflows pass, and each edit it exists to catch fails.
// Run by test-all.sh (the `workflows` check): node --test scripts/check-workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflowProblems, workflowFiles, DROP_MICROSOFT_APT_SCRIPT } from './check-workflows.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHA = '11d5960a326750d5838078e36cf38b85af677262';

// A minimal workflow in the shape the check wants; each test changes one thing.
const wf = ({ permissions = 'permissions:\n  contents: read\n', uses = `actions/checkout@${SHA} # v4.4.0`, job = '' } = {}) => `name: t
on: push
${permissions}
jobs:
  build:
    runs-on: ubuntu-latest
${job}    steps:
      - uses: ${uses}
      - run: echo hi
`;

test('every workflow in the repository passes', () => {
    const files = workflowFiles();
    assert.ok(files.length >= 4, `found ${files.length} workflows`);
    for (const file of files) assert.deepEqual(workflowProblems(readFileSync(file, 'utf8')), [], basename(file));
});

test('the docker image workflow gates its release job on the release environment, and only that job publishes', () => {
    const file = workflowFiles().find((f) => basename(f) === 'docker-publish.yml');
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^ {2}release:\n(?: {4}.*\n)*? {4}environment: release$/m);
    // Taking the environment away from that job is caught.
    assert.match(workflowProblems(text.replace(/^ {4}environment: release\n/m, '')).join('\n'), /jobs\.release .*environment: release/);
});

// A GitHub branch/tag filter as a RegExp: `*` any run of characters but `/`, `**` any run, `?` zero or one of the
// character before, `+` one or more of it, `[...]` a class; everything else literal.
const filterRegExp = (pattern) => new RegExp(`^${pattern.replace(/\*\*|\*|\[[^\]]*\]|[?+]|[.^$(){}|\\]/g,
    (t) => t === '**' ? '.*' : t === '*' ? '[^/]*' : t.startsWith('[') || t === '?' || t === '+' ? t : `\\${t}`)}$`);

test('only a node release tag (v1.2.27) starts the docker image release, never vault-v* or native-v*', () => {
    const file = workflowFiles().find((f) => basename(f) === 'docker-publish.yml');
    const text = readFileSync(file, 'utf8');
    const tags = /^ {4}tags:\s*\[(.*)\]\s*$/m.exec(text);
    assert.ok(tags, 'on.push.tags is a one-line list');
    const patterns = tags[1].split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, ''));
    const starts = (tag) => patterns.some((p) => filterRegExp(p).test(tag));
    for (const tag of ['v1.2.27', 'v1.10.0', 'v2.0.0']) assert.ok(starts(tag), `${tag} starts it (${patterns.join(', ')})`);
    for (const tag of ['vault-v1.0.0', 'vault-v1.2.27', 'native-v1.2.28', 'version-1', 'v.1']) assert.ok(!starts(tag), `${tag} does not (${patterns.join(', ')})`);
    // The converter itself: the filter the file had before matched the vault's tag.
    assert.ok(filterRegExp('v*').test('vault-v1.0.0') && !filterRegExp('v[0-9]*').test('vault-v1.0.0') && !filterRegExp('v*').test('v1/x'));
    // And the release job refuses any other tag before it builds anything: its first step.
    assert.ok(releaseGuardFirst(text), 'the first step of jobs.release is the node-release-tag guard');
});

// The text of one job: its `  <name>:` line and every line under it (indented four or more, or blank).
const jobText = (text, name) => new RegExp(`^ {2}${name}:\\n(?:(?: {4}.*)?\\n)*`, 'm').exec(text)?.[0] ?? '';
// The first entry under a job's `steps:`, comments before it skipped.
const firstStep = (job) => /^ {4}steps:\n(?:\s*\n| {6}#.*\n)*( {6}- .*\n(?: {8}.*\n|\s*\n)*)/m.exec(job)?.[1] ?? '';
// The node-release-tag guard is the first step of the `release` job, not just somewhere in the file.
const releaseGuardFirst = (text) => /^ {6}- name: Only a node release tag\n(?: {8}.*\n)*? {10}if \[\[ ! "\$TAG" =~ \^v\[0-9\]\+/m
    .test(firstStep(jobText(text, 'release')));

test('the node-release-tag guard is checked in the release job itself: moved to another job, or down a step, it fails', () => {
    const file = workflowFiles().find((f) => basename(f) === 'docker-publish.yml');
    const text = readFileSync(file, 'utf8');
    const release = jobText(text, 'release');
    assert.match(release, /^ {2}release:\n/);
    assert.match(release, /^ {4}environment: release$/m, 'the slice reaches into the release job');
    assert.doesNotMatch(release, /^ {2}build-main:/m, 'the slice stops at the job');
    assert.match(firstStep(release), /^ {6}- name: Only a node release tag\n/);

    // The guard step (with the comment above it), as it sits in the file.
    const guard = /^ {6}# A second lock.*\n {6}- name: Only a node release tag\n(?: {8}.*\n)*\n/m.exec(text)?.[0];
    assert.ok(guard, 'found the guard step');
    // Moved into build-main as its first step: the release job is unguarded and the check says so.
    const moved = text.replace(guard, '').replace(/^( {2}build-main:\n(?: {4}.*\n|\s*\n)*? {4}steps:\n)/m, `$1${guard}`);
    assert.notEqual(moved, text);
    assert.match(firstStep(jobText(moved, 'build-main')), /Only a node release tag/);
    assert.ok(!releaseGuardFirst(moved), 'guard moved to build-main');
    // Second step of release instead of first: also caught.
    const later = text.replace(guard, '').replace(/^( {6}- name: Checkout\n(?: {8}.*\n)*\n)(?= {6}- name: Extract version\n {8}id: version\n {8}run: echo "version=\$\{GITHUB_REF_NAME)/m, `$1${guard}`);
    assert.notEqual(later, text);
    assert.ok(!releaseGuardFirst(later), 'guard moved below Checkout');
    // Gone from the file: caught.
    assert.ok(!releaseGuardFirst(text.replace(guard, '')), 'guard removed');
});

test('a well-formed workflow passes', () => {
    assert.deepEqual(workflowProblems(wf()), []);
    assert.deepEqual(workflowProblems(wf({ uses: './.github/actions/local' })), []);
    assert.deepEqual(workflowProblems(wf({ uses: `"actions/checkout@${SHA}" # v4` })), []);
    assert.deepEqual(workflowProblems(wf({ permissions: 'permissions: {}\n' })), []);
});

test('an action pinned by tag or branch fails', () => {
    assert.match(workflowProblems(wf({ uses: 'actions/checkout@v4' })).join(), /actions\/checkout@v4 is not pinned to a full commit SHA/);
    assert.match(workflowProblems(wf({ uses: 'actions/checkout@main' })).join(), /not pinned/);
    assert.match(workflowProblems(wf({ uses: `actions/checkout@${SHA.slice(0, 12)} # v4.4.0` })).join(), /not pinned/);
});

test('a SHA pin without its version comment fails', () => {
    assert.match(workflowProblems(wf({ uses: `actions/checkout@${SHA}` })).join(), /has no "# v<version>" comment/);
    assert.match(workflowProblems(wf({ uses: `actions/checkout@${SHA} # latest` })).join(), /has no "# v<version>" comment/);
});

test('a docker:// action needs a digest', () => {
    assert.match(workflowProblems(wf({ uses: 'docker://alpine:3.21' })).join(), /not pinned to a sha256 digest/);
    assert.deepEqual(workflowProblems(wf({ uses: `docker://alpine@sha256:${'a'.repeat(64)}` })), []);
});

test('a commented-out unpinned action is not counted', () => {
    assert.deepEqual(workflowProblems(wf().replace('      - run: echo hi', '      # - uses: actions/checkout@v4\n      - run: echo hi')), []);
});

test('no top-level permissions, or write-all, fails', () => {
    assert.match(workflowProblems(wf({ permissions: '' })).join(), /no top-level permissions/);
    assert.match(workflowProblems(wf({ permissions: 'permissions: write-all\n' })).join(), /permissions: write-all/);
    // A job-level block alone is not enough: the next job added would get the repository default.
    assert.match(workflowProblems(wf({ permissions: '', job: '    permissions:\n      contents: read\n' })).join(), /no top-level permissions/);
});

test('a job that moves :latest, a semver tag or makes a Release must name environment: release', () => {
    const latest = (env) => `name: t
on: push
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
${env}    steps:
      - uses: docker/metadata-action@${SHA} # v5.10.0
        with:
          tags: |
            type=raw,value=latest
`;
    assert.match(workflowProblems(latest('')).join(), /jobs\.publish .*does not name environment: release/);
    assert.match(workflowProblems(latest('    environment: staging\n')).join(), /does not name environment: release/);
    assert.deepEqual(workflowProblems(latest('    environment: release\n')), []);
    assert.deepEqual(workflowProblems(latest("    environment: 'release'\n")), []);
    assert.deepEqual(workflowProblems(latest('    environment:\n      name: release\n      url: https://example.org\n')), []);
    // A step's own `environment:`-looking text deeper in the job is not the job's environment.
    assert.match(workflowProblems(latest('').replace('        with:\n', '        with:\n          environment: release\n')).join(), /does not name environment: release/);

    for (const step of [
        `      - uses: softprops/action-gh-release@${SHA} # v2.6.2\n`,
        '      - run: gh release create v1.0.0\n',
        '      - run: docker push ghcr.io/x/y:latest\n',
        '      - run: echo "type=semver,pattern={{version}}" >> tags.txt\n',
    ]) {
        assert.match(workflowProblems(wf().replace('      - run: echo hi\n', step)).join(), /does not name environment: release/, step);
        assert.deepEqual(workflowProblems(wf({ job: '    environment: release\n' }).replace('      - run: echo hi\n', step)), [], step);
    }
    // Mentioning :latest in a comment, or pulling it, is not publishing it.
    assert.deepEqual(workflowProblems(wf().replace('      - run: echo hi\n', '      # type=raw,value=latest\n      - run: docker pull x:latest\n')), []);
});

test('every other way of moving :latest from an ungated job fails too', () => {
    const meta = (withLines) => `name: t
on: push
permissions: {}
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: docker/metadata-action@${SHA} # v5.10.0
        with:
${withLines}`;
    const cases = {
        'control: type=raw,value=latest': meta('          tags: |\n            type=raw,value=latest\n'),
        'flavor block latest=true': meta('          flavor: |\n            latest=true\n            prefix=x\n'),
        'flavor inline latest=true': meta('          flavor: latest=true\n'),
        'tags inline with :latest': meta('          tags: ${{ steps.meta.outputs.tags }},ghcr.io/x/y:latest\n'),
        'tags block with :latest': meta('          tags: |\n            ghcr.io/x/y:v1\n            ghcr.io/x/y:latest\n'),
        'docker buildx build --push -t :latest': wf().replace('      - run: echo hi\n', '      - run: docker buildx build --push -t ghcr.io/x/y:latest .\n'),
        'docker buildx imagetools create -t :latest': wf().replace('      - run: echo hi\n', '      - run: docker buildx imagetools create -t ghcr.io/x/y:latest ghcr.io/x/y:sha-1\n'),
        'multi-line build with --tag :latest': wf().replace('      - run: echo hi\n', '      - run: |\n          docker buildx build --push \\\n            --tag ghcr.io/x/y:latest .\n'),
    };
    for (const [name, text] of Object.entries(cases)) {
        assert.match(workflowProblems(text).join(), /does not name environment: release/, name);
    }
    // Behind the release environment each one is fine.
    for (const [name, text] of Object.entries(cases))
        assert.deepEqual(workflowProblems(text.replace('    runs-on: ubuntu-latest\n', '    runs-on: ubuntu-latest\n    environment: release\n')), [], name);
    // Not publishing: flavor without latest=true, tags without :latest, a pull, a FROM-style reference in a comment.
    assert.deepEqual(workflowProblems(meta('          flavor: |\n            latest=false\n          tags: |\n            type=sha\n')), []);
    assert.deepEqual(workflowProblems(wf().replace('      - run: echo hi\n', '      - run: docker run --rm ghcr.io/x/y:latest --version\n')), []);
});

test('jobs indented by four spaces are read as jobs too', () => {
    const four = (env) => `name: t
on: push
permissions: {}
jobs:
    publish:
        runs-on: ubuntu-latest
${env}        steps:
            - uses: softprops/action-gh-release@${SHA} # v2.6.2
`;
    assert.match(workflowProblems(four('')).join(), /jobs\.publish .*does not name environment: release/);
    assert.deepEqual(workflowProblems(four('        environment: release\n')), []);
});

test('the key vault image workflow: its inputs reach no shell, the release build waits for the throwaway checks, no secret, nothing published', () => {
    const file = workflowFiles().find((f) => basename(f) === 'vault-image.yml');
    const text = readFileSync(file, 'utf8');
    // An input is read only in a job's `if:` (an expression, never text a shell runs): the values reach the builds as
    // release-inputs' checked outputs (apps/vault/image/release-inputs.mjs reads them from the event file).
    const refs = text.split('\n').map((line, i) => [line, i + 1])
        .filter(([line]) => /(?<![\w-])inputs\.|github\.event\.inputs/.test(line.replace(/^\s*#.*$/, '')));
    assert.ok(refs.length >= 1, 'the release jobs are gated on the inputs');
    for (const [line, n] of refs) assert.match(line, /^ {4}if: github\.event_name == 'workflow_dispatch' && \(/, `line ${n}: ${line.trim()}`);
    // The five inputs, none required, each empty by default: empty is the throwaway build, as it always was.
    for (const name of ['custodian_keys', 'version', 'host', 'network', 'network6'])
        assert.match(text, new RegExp(`^ {6}${name}:\\n(?: {8}.*\\n)*? {8}required: false\\n {8}default: ''\\n {8}type: string\\n`, 'm'), name);
    // The release image is built only after build-twice (two builds the same, the boots, the test image's genesis)
    // and the inputs' check passed.
    assert.match(jobText(text, 'release-image'), /^ {4}needs: \[build-twice, release-inputs\]$/m);
    assert.match(jobText(text, 'release-inputs'), /^ {8}run: node apps\/vault\/image\/release-inputs\.mjs$/m);
    // build-twice stays the throwaway build whatever the inputs: it reads none of them and waits for nothing.
    const buildTwice = jobText(text, 'build-twice');
    assert.match(buildTwice, /^ {4}runs-on: ubuntu-latest$/m, 'the slice reaches into build-twice');
    assert.match(buildTwice, /randomBytes\(32\)/);
    assert.doesNotMatch(buildTwice, /inputs|needs:/);
    // No secret, no write permission, no release (one is made by hand, later, with Marty's yes).
    assert.doesNotMatch(text, /secrets\./);
    assert.match(text, /^permissions:\n {2}contents: read\n/m);
    assert.doesNotMatch(text, /contents: write|gh release|action-gh-release/);
});

test('every apt-get/playwright --with-deps step in workflows must drop the Microsoft apt source first', () => {
    const withStep = (step) => wf().replace('      - run: echo hi\n', step);
    // Missing drop fails for apt-get update, apt-get install, and playwright --with-deps / install-deps.
    for (const bad of [
        '      - run: sudo apt-get update && sudo apt-get install -y expect\n',
        '      - run: sudo apt-get -qq update\n',
        '      - run: sudo apt-get install -y cryptsetup-bin\n',
        '      - run: pnpm --filter @beanpool/pwa exec playwright install --only-shell --with-deps chromium\n',
        '      - run: npx playwright install-deps chromium\n',
        // Calling the drop script AFTER apt still fails.
        `      - run: |\n          sudo apt-get update\n          bash ${DROP_MICROSOFT_APT_SCRIPT}\n`,
        // A conditional earlier step does not cover a later apt step.
        `      - if: matrix.other\n        run: bash ${DROP_MICROSOFT_APT_SCRIPT}\n      - run: sudo apt-get update\n`,
        // A drop script inside a shell conditional or after an early exit is not an unconditional drop.
        `      - run: |\n          if [ -n "$NEED_DROP" ]; then\n            bash ${DROP_MICROSOFT_APT_SCRIPT}\n          fi\n      - run: sudo apt-get update\n`,
        `      - run: |\n          command -v expect && exit 0\n          bash ${DROP_MICROSOFT_APT_SCRIPT}\n      - run: sudo apt-get update\n`,
        // Folded block scalars, explicit indentation indicators, and plain multi-line scalars.
        '      - run: >-\n          playwright install\n          --only-shell --with-deps chromium\n',
        '      - run: >\n          sudo apt-get\n          install -y expect\n',
        '      - run: |2\n          sudo apt-get update\n',
        '      - run: >-2\n          sudo apt-get\n          install -y expect\n',
        '      - run:\n          sudo apt-get update\n',
        '      - run: # install expect\n          sudo apt-get update\n',
        '      - run: # install expect\n          sudo apt-get\n          install -y expect\n',
        '      - run: sudo apt-get\n          install -y expect\n',
        // Literal block scalars with backslash line continuations.
        '      - run: |\n          pnpm --filter @beanpool/pwa exec playwright install \\\n            --only-shell --with-deps chromium\n',
        '      - run: |\n          sudo apt-get \\\n            install -y expect\n',
    ]) {
        assert.match(workflowProblems(withStep(bad)).join('\n'), /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/, bad);
    }
    // Calling the script before apt (same step or earlier unconditional step) passes, and # needs-microsoft-apt opts out.
    for (const good of [
        `      - run: bash ${DROP_MICROSOFT_APT_SCRIPT} && sudo apt-get update && sudo apt-get install -y expect\n`,
        `      - run: |\n          bash ${DROP_MICROSOFT_APT_SCRIPT}\n          pnpm --filter @beanpool/pwa exec playwright install --only-shell --with-deps chromium\n`,
        `      - run: |\n          bash ${DROP_MICROSOFT_APT_SCRIPT}\n          pnpm --filter @beanpool/pwa exec playwright install \\\n            --only-shell --with-deps chromium\n`,
        '      - run: # needs-microsoft-apt\n          sudo apt-get update\n',
        `      - run: bash ${DROP_MICROSOFT_APT_SCRIPT}\n      - run: sudo apt-get update\n`,
        `      - run: |\n          # Drop flaky Microsoft source\n          bash ${DROP_MICROSOFT_APT_SCRIPT}\n      - run: sudo apt-get update\n`,
        '      - name: Install dotnet\n        # needs-microsoft-apt: installs dotnet from packages.microsoft.com\n        run: sudo apt-get update && sudo apt-get install -y dotnet-sdk-8.0\n',
        '      # needs-microsoft-apt: installs dotnet from packages.microsoft.com\n      - name: Install dotnet\n        run: sudo apt-get update && sudo apt-get install -y dotnet-sdk-8.0\n',
    ]) {
        assert.deepEqual(workflowProblems(withStep(good)), [], good);
    }
    // A `# needs-microsoft-apt` comment above a step opts out ONLY that step, never the preceding step.
    const commentBetweenSteps = withStep([
        '      - name: Install expect',
        '        run: sudo apt-get update && sudo apt-get install -y expect',
        '',
        '      # needs-microsoft-apt: installs dotnet',
        '      - name: Install dotnet',
        '        run: sudo apt-get update && sudo apt-get install -y dotnet-sdk-8.0',
        '',
    ].join('\n'));
    const betweenProblems = workflowProblems(commentBetweenSteps);
    assert.equal(betweenProblems.length, 1, betweenProblems.join('\n'));
    assert.match(betweenProblems[0], /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/);
    // And a `# needs-microsoft-apt` above the very first step applies to that first step.
    const commentAboveFirst = `name: t
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      # needs-microsoft-apt: installs dotnet
      - name: Install dotnet
        run: sudo apt-get update && sudo apt-get install -y dotnet-sdk-8.0
`;
    assert.deepEqual(workflowProblems(commentAboveFirst), []);
    // Sequence items at the same indentation as `steps:` are checked, stopping at subsequent job-level keys.
    const unindentedSteps = `name: t
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
    - name: Install expect
      run: sudo apt-get update && sudo apt-get install -y expect
    outputs:
      done: 'true'
`;
    assert.match(workflowProblems(unindentedSteps).join('\n'), /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/);
    const unindentedStepsOk = unindentedSteps.replace(
        '      run: sudo apt-get',
        `      run: bash ${DROP_MICROSOFT_APT_SCRIPT} && sudo apt-get`,
    );
    assert.deepEqual(workflowProblems(unindentedStepsOk), []);
    // Mutation check on real ci.yml and vault-image.yml: removing any drop call fails.
    const ci = readFileSync(workflowFiles().find((f) => basename(f) === 'ci.yml'), 'utf8');
    assert.match(workflowProblems(ci.replace(`bash ${DROP_MICROSOFT_APT_SCRIPT} && `, '')).join('\n'), /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/);
    assert.match(workflowProblems(ci.replace(`          bash ${DROP_MICROSOFT_APT_SCRIPT}\n`, '')).join('\n'), /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/);
    const vault = readFileSync(workflowFiles().find((f) => basename(f) === 'vault-image.yml'), 'utf8');
    assert.match(workflowProblems(vault.replace(`          bash ${DROP_MICROSOFT_APT_SCRIPT}\n`, '')).join('\n'), /without calling scripts\/ci\/drop-microsoft-apt-source\.sh first/);
});

test('scripts/ci/drop-microsoft-apt-source.sh removes only pure packages.microsoft.com .list and .sources files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drop-ms-apt-'));
    const script = join(REPO_ROOT, DROP_MICROSOFT_APT_SCRIPT);
    const put = (name, body) => writeFileSync(join(dir, name), body);
    const has = (name) => existsSync(join(dir, name));
    try {
        // Pure Microsoft sources (must be removed).
        put('microsoft-prod.list', 'deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/microsoft.gpg] https://packages.microsoft.com/ubuntu/26.04/prod resolute main\n');
        put('azure-cli.sources', [
            'Types: deb',
            'URIs: https://packages.microsoft.com/repos/azure-cli/',
            'Suites: resolute',
            'Components: main',
            'Signed-By: /etc/apt/keyrings/microsoft.gpg',
            '',
        ].join('\n'));
        put('microsoft-multiline.sources', [
            '# Microsoft repos',
            'Types: deb',
            'URIs:',
            '  https://packages.microsoft.com/ubuntu/26.04/prod',
            '  http://packages.microsoft.com/repos/edge',
            'Suites: resolute',
            'Components: main',
            '',
        ].join('\n'));
        // Ubuntu & third-party sources (must NEVER be removed).
        put('ubuntu.sources', [
            'Types: deb',
            'URIs: http://archive.ubuntu.com/ubuntu/',
            'Suites: resolute resolute-updates resolute-backports',
            'Components: main universe restricted multiverse',
            'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
            '',
        ].join('\n'));
        put('ubuntu-mirrors.sources', 'Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: resolute\nComponents: main\n');
        // Comments mentioning packages.microsoft.com inside an Ubuntu file must NEVER be removed.
        put('ubuntu-comment.list', '# Note: packages.microsoft.com is disabled\ndeb http://archive.ubuntu.com/ubuntu/ resolute main\n');
        // Mixed file (both Microsoft and Ubuntu URIs) must NEVER be removed.
        put('mixed.list', 'deb https://packages.microsoft.com/ubuntu/26.04/prod resolute main\ndeb http://archive.ubuntu.com/ubuntu/ resolute main\n');
        put('mixed.sources', 'Types: deb\nURIs: https://packages.microsoft.com/ubuntu/26.04/prod\nSuites: resolute\n\nTypes: deb\nURIs: http://archive.ubuntu.com/ubuntu/\nSuites: resolute\n');
        // Spoofed hostname must NOT be removed.
        put('spoofed.list', 'deb https://packages.microsoft.com.example.org/ubuntu resolute main\n');
        // Non-.list/.sources file mentioning Microsoft must NOT be touched.
        put('microsoft-prod.list.bak', 'deb https://packages.microsoft.com/ubuntu/26.04/prod resolute main\n');

        const res = spawnSync('bash', [script], { env: { ...process.env, APT_SOURCES_DIR: dir }, encoding: 'utf8' });
        assert.equal(res.status, 0, res.stderr);
        assert.equal(has('microsoft-prod.list'), false, 'microsoft-prod.list removed');
        assert.equal(has('azure-cli.sources'), false, 'azure-cli.sources removed');
        assert.equal(has('microsoft-multiline.sources'), false, 'microsoft-multiline.sources removed');
        assert.equal(has('ubuntu.sources'), true, 'ubuntu.sources kept');
        assert.equal(has('ubuntu-mirrors.sources'), true, 'ubuntu-mirrors.sources kept');
        assert.equal(has('ubuntu-comment.list'), true, 'ubuntu-comment.list kept');
        assert.equal(has('mixed.list'), true, 'mixed.list kept');
        assert.equal(has('mixed.sources'), true, 'mixed.sources kept');
        assert.equal(has('spoofed.list'), true, 'spoofed.list kept');
        assert.equal(has('microsoft-prod.list.bak'), true, 'microsoft-prod.list.bak kept');

        // Second run is idempotent and exits 0.
        const second = spawnSync('bash', [script], { env: { ...process.env, APT_SOURCES_DIR: dir }, encoding: 'utf8' });
        assert.equal(second.status, 0, second.stderr);
        assert.match(second.stdout, /no packages\.microsoft\.com apt sources found/);

        // Missing directory exits 0 cleanly.
        const missing = spawnSync('bash', [script], { env: { ...process.env, APT_SOURCES_DIR: join(dir, 'does-not-exist') }, encoding: 'utf8' });
        assert.equal(missing.status, 0, missing.stderr);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
