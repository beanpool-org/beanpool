// scripts/check-deploy-workflow.mjs on the real .github/workflows/registrar-deploy.yml, and on copies of it with one
// regression planted: each must fail, naming where. What the check guards is in its header.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORKFLOW, workflowProblems } from '../scripts/check-deploy-workflow.mjs';

const REAL = readFileSync(WORKFLOW, 'utf8');
const TOKEN = 'CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}';

// The real file with `from` (which must occur exactly once) replaced by `to`.
function planted(from, to) {
    assert.equal(REAL.split(from).length, 2, `the workflow no longer has exactly one ${JSON.stringify(from)}; update this test`);
    return REAL.replace(from, to);
}
function fails(text, ...expected) {
    const problems = workflowProblems(text);
    assert.ok(problems.length, 'the check passed a planted regression');
    for (const e of expected) assert.ok(problems.some((p) => p.includes(e)), `no problem mentions ${JSON.stringify(e)}:\n${problems.join('\n')}`);
}

test('the real workflow passes', () => {
    assert.deepEqual(workflowProblems(REAL), []);
});

test('the token at job level fails (every step, actions and pnpm install included, would see it)', () => {
    fails(planted("      CLOUDFLARE_ACCOUNT_ID: 151a28c4fd1e6ee09768f4226be76b4d\n",
        `      CLOUDFLARE_ACCOUNT_ID: 151a28c4fd1e6ee09768f4226be76b4d\n      ${TOKEN}\n`), 'jobs.deploy.env.CLOUDFLARE_API_TOKEN');
});

test('the token at workflow level fails', () => {
    fails(planted('permissions:\n  contents: read\n', `permissions:\n  contents: read\n\nenv:\n  ${TOKEN}\n`), 'env.CLOUDFLARE_API_TOKEN');
});

test('the token in the deploy job\'s pnpm install step fails', () => {
    const install = '      - name: Install wrangler (the workspace\'s)\n        working-directory: .\n        run: pnpm install --frozen-lockfile --filter @beanpool/registrar\n\n      # `wrangler d1';
    fails(planted(install, install.replace('        working-directory: .\n', `        working-directory: .\n        env:\n          ${TOKEN}\n`)),
        'jobs.deploy.steps[5].env.CLOUDFLARE_API_TOKEN');
});

test('the token in an action\'s step fails, in its env or its with', () => {
    const setupNode = '      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0\n        with:\n          node-version: 22\n\n';
    fails(planted(setupNode, setupNode.replace('        with:\n', `        env:\n          ${TOKEN}\n        with:\n`)), 'jobs.deploy.steps[4].env.CLOUDFLARE_API_TOKEN');
    fails(planted(setupNode, setupNode.replace('          node-version: 22\n', '          node-version: 22\n          token: ${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}\n')),
        'jobs.deploy.steps[4].with.token');
});

test('the token anywhere in the dry-run job fails', () => {
    fails(planted('      - name: wrangler deploy --dry-run\n', `      - name: wrangler deploy --dry-run\n        env:\n          ${TOKEN}\n`),
        'jobs.dry-run.steps[5].env.CLOUDFLARE_API_TOKEN');
    fails(planted("    env:\n      WRANGLER_SEND_METRICS: 'false'\n    steps:\n      - uses: actions/checkout",
        `    env:\n      WRANGLER_SEND_METRICS: 'false'\n      ${TOKEN}\n    steps:\n      - uses: actions/checkout`), 'jobs.dry-run.env.CLOUDFLARE_API_TOKEN');
});

test('a secret in a script, under another name, or passed wholesale fails', () => {
    fails(planted('        run: npx --no-install wrangler deploy --var "GIT_SHA:$GITHUB_SHA"\n',
        '        run: npx --no-install wrangler deploy --var "GIT_SHA:$GITHUB_SHA" --var "T:${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}"\n'),
        'jobs.deploy.steps[9].run');
    fails(planted('        run: npx --no-install wrangler d1 migrations apply beanpool-registrar --remote\n',
        '        run: npx --no-install wrangler d1 migrations apply beanpool-registrar --remote\n      - name: Everything\n        env:\n          ALL: ${{ toJSON(secrets) }}\n        run: npx --no-install wrangler whoami\n'),
        'jobs.deploy.steps[9].env.ALL');
    fails(planted('      - name: Apply migrations\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}\n',
        '      - name: Apply migrations\n        env:\n          CLOUDFLARE_API_TOKEN: ${{ secrets.SOME_OTHER_TOKEN }}\n'), 'jobs.deploy.steps[8].env.CLOUDFLARE_API_TOKEN');
});

test('the token on the health check (no wrangler) fails, and so does the presence check once an action has run', () => {
    fails(planted('      - name: The live Worker is this commit and accepts every protocol the node can send\n',
        `      - name: The live Worker is this commit and accepts every protocol the node can send\n        env:\n          ${TOKEN}\n`),
        'jobs.deploy.steps[10].env.CLOUDFLARE_API_TOKEN');
    const presence = REAL.match(/      - name: The deploy token is set\n[\s\S]*?          fi\n\n/)[0];
    // After the deploy job's checkout, before its pnpm setup (the one followed by the no-cache comment).
    const pnpmSetup = '      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0\n        with:\n          version: 9.0.0\n\n      # No dependency cache';
    const moved = planted(presence, '').replace(pnpmSetup, `${presence}${pnpmSetup}`);
    assert.equal(workflowProblems(moved.replace(presence, '')).length, 0, 'fixture: the move itself is otherwise clean');
    fails(moved, 'jobs.deploy.steps[2].env.CLOUDFLARE_API_TOKEN');
});

test('a deploy job without the environment fails, and so does another job naming one', () => {
    fails(planted('    environment: registrar-production\n', ''), 'jobs.deploy.environment');
    fails(planted('    environment: registrar-production\n', '    environment: staging\n'), 'jobs.deploy.environment');
    fails(planted("    name: Registrar dry run (no deploy)\n", "    name: Registrar dry run (no deploy)\n    environment: registrar-production\n"),
        'jobs.dry-run.environment');
});

test('an automatic trigger or a looser deploy condition fails', () => {
    fails(planted('on:\n  workflow_dispatch:\n', "on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n"), 'on.push');
    fails(planted('on:\n  workflow_dispatch:\n', 'on:\n  workflow_dispatch:\n  pull_request_target:\n'), 'on.pull_request_target');
    fails(planted("    if: github.event_name == 'workflow_dispatch'\n", "    if: github.event_name != 'pull_request'\n"), 'jobs.deploy.if');
});

test('an action on a tag, a branch or a short SHA fails, and so does one with no version comment', () => {
    const at = '@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0\n        with:\n          persist-credentials: false\n\n      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0\n        with:\n          version: 9.0.0\n\n      # No';
    for (const ref of ['@v4', '@main', '@11d5960'])
        fails(planted(at, at.replace('@11d5960a326750d5838078e36cf38b85af677262', ref)), `actions/checkout${ref} is not pinned`);
    fails(planted(at, at.replace(' # v4.4.0', '')), 'has no "# v<version>" comment');
});

test('what is not a workflow fails', () => {
    fails('jobs: [', 'not valid YAML');
    fails(`${REAL}\npermissions:\n  contents: write\n`, 'not valid YAML');
});
