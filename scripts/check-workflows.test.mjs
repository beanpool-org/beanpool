// Tests for scripts/check-workflows.mjs: the repository's workflows pass, and each edit it exists to catch fails.
// Run by test-all.sh (the `workflows` check): node --test scripts/check-workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { workflowProblems, workflowFiles } from './check-workflows.mjs';

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
