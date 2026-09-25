// Keeps the registrar deploy workflow (.github/workflows/registrar-deploy.yml) in the shape its safety depends on
// (director's call, 2026-09-26; README, "Deploy"). The gate itself is GitHub's: the deploy token is a secret of the
// `registrar-production` environment only, which accepts `main` only and waits for Marty's approval. This catches
// the edits that would quietly undo the rest, and fails on any of them:
//   - the deploy job stops naming that environment, or another job names one;
//   - the workflow gains a trigger besides a manual run and pull requests, or the deploy job runs on anything but a
//     manual run;
//   - any mention of `secrets` other than CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_WORKERS_TOKEN }} in the
//     step-level `env:` of a deploy-job step that runs wrangler (or of the check that the token is set, before any
//     action runs): never in the workflow's or a job's `env:`, the dry-run job, an action's step, `with:` or a
//     script;
//   - an action not pinned to a full commit SHA with its version in a comment.
// Run by the workflow's dry-run job and by the registrar tests (test/deploy-workflow.test.js):
//   node scripts/check-deploy-workflow.mjs [path/to/registrar-deploy.yml]

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';

export const WORKFLOW = fileURLToPath(new URL('../../../.github/workflows/registrar-deploy.yml', import.meta.url));
export const ENVIRONMENT = 'registrar-production';
const TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';
const TOKEN_REF = '${{ secrets.CLOUDFLARE_WORKERS_TOKEN }}';
const PRESENCE_CHECK = 'The deploy token is set';
const TRIGGERS = ['workflow_dispatch', 'pull_request'];
const DEPLOY_IF = "github.event_name == 'workflow_dispatch'";
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^\s*#\s*v\d+(\.\d+)*\s*$/;
const RUNS_WRANGLER = /\bnpx --no-install wrangler\b/;

const at = (path) => path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('').slice(1);

// Every string in a parsed YAML value as [path, string, isKey], keys included, so `secrets: inherit` is seen too.
function* strings(value, path = []) {
    if (typeof value === 'string') yield [path, value, false];
    else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, [...path, i]);
    else if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) { yield [[...path, k], k, true]; yield* strings(v, [...path, k]); }
}

// What is wrong with the workflow's text: [] when nothing.
export function workflowProblems(text) {
    const doc = parseDocument(text);
    if (doc.errors.length) return doc.errors.map((e) => `not valid YAML: ${e.message}`);
    const wf = doc.toJS();
    if (!wf || typeof wf !== 'object') return ['not a workflow'];
    const problems = [];
    const jobs = wf.jobs && typeof wf.jobs === 'object' ? wf.jobs : {};
    const deploy = jobs.deploy;
    const steps = Array.isArray(deploy?.steps) ? deploy.steps : [];

    const on = typeof wf.on === 'string' ? [wf.on] : Array.isArray(wf.on) ? wf.on : Object.keys(wf.on ?? {});
    for (const t of on) if (!TRIGGERS.includes(t)) problems.push(`on.${t}: the workflow runs only by hand and on pull requests`);

    if (!deploy) problems.push('jobs.deploy: no deploy job');
    else {
        if (deploy.if !== DEPLOY_IF) problems.push(`jobs.deploy.if: must be ${JSON.stringify(DEPLOY_IF)} (a manual run only)`);
        const env = typeof deploy.environment === 'string' ? deploy.environment : deploy.environment?.name;
        if (env !== ENVIRONMENT) problems.push(`jobs.deploy.environment: must be ${ENVIRONMENT}, the only place the deploy token is kept`);
    }
    for (const [id, job] of Object.entries(jobs))
        if (id !== 'deploy' && job?.environment !== undefined) problems.push(`jobs.${id}.environment: only the deploy job names an environment`);

    // The token may be set only as a deploy-job step's own env, on a step that runs a shell script (no action) calling
    // wrangler, or on the check that it is set, which comes before any action.
    const firstAction = steps.findIndex((s) => s?.uses !== undefined);
    const tokenStep = (i) => {
        const s = steps[i];
        if (!s || s.uses !== undefined || typeof s.run !== 'string') return false;
        if (RUNS_WRANGLER.test(s.run)) return true;
        return s.name === PRESENCE_CHECK && (firstAction === -1 || i < firstAction);
    };
    for (const [path, s, isKey] of strings(wf)) {
        if (!/secrets/i.test(s)) continue;
        const [jobs_, job, steps_, i, env, name] = path;
        const allowed = !isKey && path.length === 6 && jobs_ === 'jobs' && job === 'deploy' && steps_ === 'steps' && env === 'env'
            && name === TOKEN_ENV && s === TOKEN_REF && tokenStep(i);
        if (!allowed) problems.push(`${at(path)}: ${JSON.stringify(s)} — the deploy token goes only in the env of a deploy step that runs wrangler`);
    }
    if (deploy && !steps.some((st, i) => st?.env?.[TOKEN_ENV] === TOKEN_REF && tokenStep(i)))
        problems.push('jobs.deploy.steps: no wrangler step sets the deploy token in its own env');

    for (const [path, s, isKey] of strings(wf)) {
        if (isKey || path.at(-1) !== 'uses') continue;
        if (!s.startsWith('./') && !PINNED.test(s)) problems.push(`${at(path)}: ${s} is not pinned to a full commit SHA`);
    }
    for (const [n, line] of text.split('\n').entries()) {
        const m = /^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/.exec(line);
        if (m && !m[1].startsWith('./') && !VERSION_COMMENT.test(m[2])) problems.push(`line ${n + 1}: ${m[1]} has no "# v<version>" comment`);
    }
    return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
    const file = process.argv[2] ?? WORKFLOW;
    const problems = workflowProblems(readFileSync(file, 'utf8'));
    for (const p of problems) console.error(`::error file=${file}::${p}`);
    if (problems.length) process.exit(1);
    console.log(`${file}: the deploy token is only in ${ENVIRONMENT}'s wrangler steps, and every action is pinned`);
}
