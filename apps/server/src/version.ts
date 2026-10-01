/**
 * The node's version, resolved once, from a single source.
 *
 * Two endpoints used to answer this question differently: `/api/version` read the
 * build arg, while `/api/community/health` — the one the app and PWA actually display —
 * returned a hardcoded '1.2.5' string that had not moved since August. Nodes reported a
 * version four releases behind whatever they were running. Both now call this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

let cached: string | null = null;
let cachedCommit: string | null = null;

export function getVersion(): string {
    if (cached === null) cached = resolveVersion();
    return cached;
}

/**
 * The commit this server runs (git's short hash of the working directory's checkout), or 'unknown' where there is no
 * git (the image has none). Asked of git once and kept: /api/version answers it to anyone, and running git for every
 * request blocked the event loop for about 6 ms each time, 149 requests a second where a 401 path answers 19,000 (the
 * confirm review of #1384).
 */
export function getCommit(): string {
    if (cachedCommit === null) {
        try {
            cachedCommit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        } catch { cachedCommit = 'unknown'; }
    }
    return cachedCommit;
}

function resolveVersion(): string {
    // Set by the Docker build arg and promoted to ENV in the runtime stage.
    if (process.env.APP_VERSION) return process.env.APP_VERSION;

    // Written into the image at build time when APP_VERSION was supplied.
    try {
        const versionFile = '/app/.version';
        if (fs.existsSync(versionFile)) {
            const v = fs.readFileSync(versionFile, 'utf-8').trim();
            if (v) return v;
        }
    } catch { /* fall through */ }

    // Walk up from this module to the workspace root and read its package.json.
    //
    // Deliberately NOT path.resolve('package.json'): the container's WORKDIR is
    // /app/apps/server, so a cwd-relative lookup lands on apps/server/package.json —
    // a separate, unmaintained version field that has read 1.2.5 since August. That is
    // the trap this whole function exists to avoid.
    try {
        let dir = path.dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 8; i++) {
            const candidate = path.join(dir, 'package.json');
            if (fs.existsSync(candidate)) {
                const pkg = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
                const isWorkspaceRoot =
                    pkg.name === 'beanpool-monorepo' ||
                    fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
                if (isWorkspaceRoot && pkg.version) return pkg.version;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    } catch { /* fall through */ }

    return '0.0.0';
}
