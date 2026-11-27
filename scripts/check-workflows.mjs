#!/usr/bin/env node
/**
 * Keeps every GitHub workflow (.github/workflows/*.yml) in the shape its supply-chain safety rests on
 * (scratch/reviews/FABLE-sec-infra.md M3, M4, L4), and fails on any edit that undoes it:
 *   - every action is pinned to a full commit SHA with its version in a comment (`uses: owner/repo@<40 hex> # v1.2.3`).
 *     A tag can be moved to other code (tj-actions/changed-files, 2025-03); a commit can't. A docker:// action needs
 *     a sha256 digest. Local actions (./...) are this repository's own code.
 *   - every workflow has a top-level `permissions:`, so no job gets the repository's default token scope, and none
 *     says write-all.
 *   - a job that moves the image's :latest (type=raw, flavor latest=true, a tags: or -t value ending :latest) or a semver tag, or makes a GitHub Release, names the `release`
 *     environment, which waits for Marty's approval ("approve each release", board, 2026-10-01).
 *   - every step that runs apt-get/apt update or install (or `playwright install --with-deps` / `install-deps`) drops
 *     the runner's flaky Microsoft apt source via `scripts/ci/drop-microsoft-apt-source.sh` first (unless the step
 *     explicitly opts out with `# needs-microsoft-apt`).
 * apps/registrar/scripts/check-deploy-workflow.mjs adds the registrar deploy's own rules on top of these.
 *
 * It reads the files as lines, like check-compose-log-caps.mjs, so it needs no YAML parser from node_modules.
 *
 * Usage: node scripts/check-workflows.mjs [workflow.yml ...]   (no arguments: every workflow in .github/workflows)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_ENVIRONMENT = 'release';
export const DROP_MICROSOFT_APT_SCRIPT = 'scripts/ci/drop-microsoft-apt-source.sh';

const APT_COMMAND = /\bapt-get\b[^\n]*\b(?:update|install)\b|\bapt\s+(?:-\S+\s+)*(?:update|install)\b|\bplaywright\s+(?:install\b[^\n]*--with-deps|install-deps)\b/;
const NEEDS_MICROSOFT_APT = /#\s*needs-microsoft-apt\b/;
const STANDALONE_DROP = /^\s*(?:bash[ \t]+)?scripts\/ci\/drop-microsoft-apt-source\.sh\s*$/;

const USES = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1(.*)$/;
const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/\S+@sha256:[0-9a-f]{64}$/;
const VERSION_COMMENT = /^\s*#\s*v\d+(\.\d+)*\s*$/;
// What publishes a release: the :latest tag, a semver tag (docker/metadata-action) or a GitHub Release.
const PUBLISHES_RELEASE = [
    /type=raw,value=latest\b/, /\blatest=true\b/, // metadata-action flavor, block or inline
    /(?:^|\s)(?:-t|--tag)[\s=]['"]?\S*:latest\b/, // docker buildx build --push -t / imagetools create -t, even over several lines
 /type=semver\b/, /\bdocker\s+(?:image\s+)?(?:push|tag)\b.*:latest\b/,
    /\bsoftprops\/action-gh-release@/, /\bgh\s+release\s+create\b/,
];

/** True when a `tags:` input of the job (inline, or the block under it) names an image reference ending :latest. */
function tagsInputNamesLatest(body) {
    for (const [i, line] of body.entries()) {
        const m = /^(\s*)(?:-\s+)?tags:\s*(.*)$/.exec(line);
        if (!m) continue;
        if (/:latest\b/.test(m[2])) return true;
        for (const next of body.slice(i + 1)) {
            if (!next.trim()) continue;
            if (indentOf(next) <= m[1].length) break;
            if (/:latest\b/.test(next)) return true;
        }
    }
    return false;
}

const withoutComment = (line) => line.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, '');
const indentOf = (line) => /^ */.exec(line)[0].length;
const isContent = (line) => withoutComment(line).trim() !== '';

/** The jobs as { id, line, lines }: each job's own lines, from its `<id>:` key to the next job or top-level key. */
function jobsOf(lines) {
    const jobs = [];
    const start = lines.findIndex((l) => /^jobs:\s*$/.test(withoutComment(l)));
    if (start === -1) return jobs;
    const first = lines.slice(start + 1).find(isContent);
    if (!first || indentOf(first) === 0) return jobs;
    const jobIndent = indentOf(first);
    let current = null;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i];
        if (isContent(line) && indentOf(line) === 0) break;
        const key = isContent(line) && indentOf(line) === jobIndent ? /^\s*([\w-]+):\s*$/.exec(withoutComment(line)) : null;
        if (key) jobs.push((current = { id: key[1], line: i + 1, lines: [] }));
        else if (current) current.lines.push(line);
    }
    return jobs;
}

/** The environment a job names (`environment: x`, or `environment:` with `name: x` under it), or undefined. */
function environmentOf(job) {
    const first = job.lines.find(isContent);
    if (!first) return undefined;
    const keyIndent = indentOf(first);
    for (const [i, line] of job.lines.entries()) {
        const m = /^\s*environment:\s*(.*)$/.exec(withoutComment(line));
        if (!m || indentOf(line) !== keyIndent) continue;
        if (m[1].trim()) return m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        for (const next of job.lines.slice(i + 1)) {
            if (!isContent(next)) continue;
            if (indentOf(next) <= keyIndent) break;
            const name = /^\s*name:\s*(['"]?)([^'"\s]+)\1\s*$/.exec(withoutComment(next));
            if (name) return name[2];
        }
        return '';
    }
    return undefined;
}

/** The steps of one job as { line, indent, lines, comments }. */
function stepsOf(job) {
    const first = job.lines.find(isContent);
    if (!first) return [];
    const keyIndent = indentOf(first);
    const start = job.lines.findIndex((l) => indentOf(l) === keyIndent && /^\s*steps:\s*$/.test(withoutComment(l)));
    if (start === -1) return [];
    const firstStep = job.lines.slice(start + 1).find(isContent);
    if (!firstStep || indentOf(firstStep) < keyIndent || !/^\s*-(?:\s|$)/.test(withoutComment(firstStep))) return [];
    const stepIndent = indentOf(firstStep);
    const steps = [];
    let current = null;
    let pendingComments = [];
    for (let i = start + 1; i < job.lines.length; i++) {
        const line = job.lines[i];
        const isStepStart = isContent(line) && indentOf(line) === stepIndent && /^\s*-(?:\s|$)/.test(withoutComment(line));
        if (isContent(line) && (indentOf(line) < stepIndent || (indentOf(line) === stepIndent && !isStepStart))) break;
        if (!isContent(line) && line.trim().startsWith('#') && indentOf(line) <= stepIndent) {
            pendingComments.push(line);
            continue;
        }
        if (isStepStart) {
            steps.push((current = { line: job.line + i + 1, indent: stepIndent, lines: [line], comments: pendingComments }));
            pendingComments = [];
        } else {
            if (line.trim() === '') {
                pendingComments = [];
            } else if (pendingComments.length) {
                if (current) current.lines.push(...pendingComments);
                pendingComments = [];
            }
            if (current) current.lines.push(line);
        }
    }
    return steps;
}

/** Column of a step's mapping keys (e.g. `step.indent + 2` for `- name:`). */
function stepKeyIndent(step) {
    const first = /^(\s*-\s+)\S/.exec(withoutComment(step.lines[0]));
    if (first) return first[1].length;
    const next = step.lines.slice(1).find(isContent);
    return next ? indentOf(next) : step.indent + 2;
}

/** The shell text of a step's `run:` key (inline, plain multi-line, or block scalar), or '' when the step has no `run:`. */
function stepRunText(step) {
    const mapIndent = stepKeyIndent(step);
    for (let i = 0; i < step.lines.length; i++) {
        const line = step.lines[i];
        const m = /^(\s*)(?:(-\s+))?run:\s*(.*)$/.exec(line);
        if (!m) continue;
        if (m[2] ? m[1].length !== step.indent : m[1].length !== mapIndent) continue;
        const keyIndent = m[2] ? m[1].length + m[2].length : m[1].length;
        const rest = m[3].trim();
        const block = /^([|>])(?:[+-]?[1-9]?|[1-9]?[+-]?)(?:\s+#.*)?$/.exec(rest);
        if (block || rest === '') {
            const out = [];
            for (const next of step.lines.slice(i + 1)) {
                if (!next.trim()) { out.push(''); continue; }
                if (indentOf(next) <= keyIndent) break;
                if (!block && next.trim().startsWith('#')) {
                    if (out.some(Boolean)) break;
                    continue;
                }
                out.push(next);
            }
            if (block?.[1] === '|') return out.join('\n');
            return out.map((l) => l.trim()).join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
        }
        const out = [rest];
        for (const next of step.lines.slice(i + 1)) {
            if (!next.trim()) { out.push(''); continue; }
            if (indentOf(next) <= keyIndent) break;
            if (next.trim().startsWith('#')) break;
            out.push(next.trim());
        }
        return out.join('\n').replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    }
    return '';
}

/** True when a step carries an `if:` condition. */
function stepHasIf(step) {
    const mapIndent = stepKeyIndent(step);
    return step.lines.some((line) => {
        const m = /^(\s*)(?:(-\s+))?if:\s*/.exec(withoutComment(line));
        return m && (m[2] ? m[1].length === step.indent : m[1].length === mapIndent);
    });
}

/** What is wrong with one workflow's text: [] when nothing. */
export function workflowProblems(text) {
    const problems = [];
    const lines = text.split('\n');

    for (const [n, line] of lines.entries()) {
        const m = USES.exec(line);
        if (!m || /^\s*#/.test(line)) continue;
        const [, , target, rest] = m;
        if (target.startsWith('./')) continue;
        if (target.startsWith('docker://')) {
            if (!DOCKER_DIGEST.test(target)) problems.push(`line ${n + 1}: ${target} is not pinned to a sha256 digest`);
            continue;
        }
        if (!PINNED.test(target)) problems.push(`line ${n + 1}: ${target} is not pinned to a full commit SHA`);
        else if (!VERSION_COMMENT.test(rest)) problems.push(`line ${n + 1}: ${target} has no "# v<version>" comment`);
    }

    const permissions = lines.map(withoutComment).filter((l) => /^permissions:/.test(l));
    if (permissions.length === 0) problems.push('no top-level permissions: (say what the token may do, e.g. contents: read)');
    for (const [n, line] of lines.entries())
        if (/^\s*permissions:\s*['"]?write-all['"]?\s*$/.test(withoutComment(line))) problems.push(`line ${n + 1}: permissions: write-all`);

    for (const job of jobsOf(lines)) {
        const body = job.lines.map(withoutComment);
        const publishes = PUBLISHES_RELEASE.some((re) => body.some((l) => re.test(l))) || tagsInputNamesLatest(body);
        if (publishes && environmentOf(job) !== RELEASE_ENVIRONMENT)
            problems.push(`jobs.${job.id} (line ${job.line}): publishes a release (:latest, a semver tag or a GitHub Release) but does not name environment: ${RELEASE_ENVIRONMENT}`);

        let droppedUnconditionally = false;
        for (const step of stepsOf(job)) {
            const runText = stepRunText(step);
            if (!runText) continue;
            const active = runText.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
            const aptMatch = APT_COMMAND.exec(active);
            const dropIdx = active.indexOf(DROP_MICROSOFT_APT_SCRIPT);
            if (aptMatch && ![...step.comments, ...step.lines].some((l) => NEEDS_MICROSOFT_APT.test(l))) {
                const droppedInStep = dropIdx !== -1 && dropIdx < aptMatch.index;
                if (!droppedUnconditionally && !droppedInStep) {
                    problems.push(`jobs.${job.id} (line ${step.line}): runs ${aptMatch[0]} without calling ${DROP_MICROSOFT_APT_SCRIPT} first`);
                }
            }
            if (!stepHasIf(step) && STANDALONE_DROP.test(active)) droppedUnconditionally = true;
        }
    }
    return problems;
}

/** Every workflow file in the repository. */
export function workflowFiles(root = REPO_ROOT) {
    const dir = join(root, '.github', 'workflows');
    return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => join(dir, f));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const files = process.argv.length > 2 ? process.argv.slice(2) : workflowFiles();
    let failed = 0;
    for (const file of files) {
        const problems = workflowProblems(readFileSync(file, 'utf8'));
        const shown = relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file);
        for (const p of problems) console.error(`❌ ${shown}: ${p}`);
        if (problems.length) failed++;
    }
    if (failed) {
        console.error(`\n${failed} of ${files.length} workflow(s) failed: pin each action as uses: owner/repo@<full commit sha> # v<version>,`);
        console.error('give each workflow a top-level permissions:, and gate a release job on environment: release.');
        process.exit(1);
    }
    console.log(`✅ ${files.length} workflow(s): every action pinned to a commit, explicit permissions, releases gated on environment: ${RELEASE_ENVIRONMENT}`);
}
