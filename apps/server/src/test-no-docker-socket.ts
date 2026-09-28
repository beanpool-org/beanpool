/**
 * No BeanPool server is handed Docker's control socket (design scratch/global-node/DESIGN-tunnel-without-docker-socket-opus.md
 * §3, §4). Anything that can use /var/run/docker.sock controls the whole machine; the server mounted it only to restart a
 * cloudflared sidecar, and the tunnel now runs inside the server (services/tunnel-connector.ts).
 *
 * Static, fast, reads files only:
 *  1. No compose file mounts docker.sock (main: docker-compose.yml:120).
 *  2. docker-compose.yml has no cloudflared service (main: :127), and no compose file runs cloudflared:latest.
 *  3. beanpool-node pins the name beanpool-node to 127.0.0.1 (extra_hosts): a tunnel whose settings still name it reaches
 *     this community's server, never another stack's on beanpool-shared.
 *  4. entrypoint.sh doesn't touch docker.sock (main: :13, it re-chowned the HOST's socket to group 1000).
 *  5. No server code talks to the socket: no `socketPath` at docker.sock, and docker.sock appears only in the connector,
 *     which checks whether it is mounted in order to warn (main: public-address-agent.ts:42,79).
 *  6. The image carries cloudflared pinned by version and digest, copied from Cloudflare's image, and runs it once at build.
 *
 *   pnpm exec tsx src/test-no-docker-socket.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SRC = path.join(ROOT, 'apps', 'server', 'src');

let run = 0, passed = 0;
function assert(cond: unknown, msg: string): void {
    run++;
    if (cond) { passed++; console.log(`✓ ${msg}`); } else { console.error(`✗ ${msg}`); process.exitCode = 1; }
}

const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
/** Lines with comments removed (a `#` inside a quoted value is not a comment in these files). */
const codeLines = (text: string) => text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trimEnd());

/** One compose service's lines, by name: from `  name:` to the next line at its indent or less. */
function serviceBlock(compose: string, name: string): string[] | null {
    const lines = codeLines(compose);
    const start = lines.findIndex((l) => l === `  ${name}:`);
    if (start === -1) return null;
    const out: string[] = [];
    for (let i = start + 1; i < lines.length; i++) {
        const l = lines[i];
        if (!l.trim()) continue;
        if (l.match(/^\s*/)![0].length <= 2) break;
        out.push(l);
    }
    return out;
}

const composeFiles = execSync('git ls-files', { cwd: ROOT, encoding: 'utf-8' }).split('\n')
    .filter((f) => /(?:^|\/)(?:(?:docker-)?compose[^/]*\.ya?ml|[^/]*\.compose\.ya?ml)$/.test(f));

console.log('— compose —');
assert(composeFiles.includes('docker-compose.yml'), `the compose files are found (${composeFiles.join(', ')})`);
for (const f of composeFiles) {
    const text = codeLines(read(f)).join('\n');
    assert(!text.includes('docker.sock'), `${f} mounts no Docker socket`);
    assert(!/cloudflare\/cloudflared(:latest)?(\s|$|")/.test(text), `${f} runs no unpinned cloudflare/cloudflared image`);
}
const compose = read('docker-compose.yml');
assert(serviceBlock(compose, 'cloudflared') === null, 'docker-compose.yml has no cloudflared service (the tunnel runs inside the server)');
assert(!codeLines(compose).some((l) => /^\s*profiles:/.test(l)), 'and no profile a stranger would have to know to switch on');
const node = serviceBlock(compose, 'beanpool-node');
assert(!!node, 'docker-compose.yml has the beanpool-node service');
const hostsAt = node?.findIndex((l) => /^\s*extra_hosts:\s*$/.test(l)) ?? -1;
const hosts: string[] = [];
for (let i = hostsAt + 1; hostsAt !== -1 && i < node!.length && /^\s*-\s/.test(node![i]); i++) hosts.push(node![i].replace(/^\s*-\s*/, '').replace(/["']/g, '').trim());
assert(hosts.includes('beanpool-node:127.0.0.1'), `beanpool-node pins beanpool-node to 127.0.0.1 (extra_hosts: ${JSON.stringify(hosts)})`);
assert(!node?.some((l) => l.includes('docker.sock')), 'beanpool-node has no docker.sock volume');

console.log('\n— entrypoint —');
const entrypoint = read('entrypoint.sh');
assert(!entrypoint.includes('docker.sock'), 'entrypoint.sh never touches docker.sock (it used to hand the host\'s socket to group 1000)');
assert(/chown -R \$PUID:\$PGID \/data/.test(entrypoint) && /exec su-exec \$PUID:\$PGID "\$@"/.test(entrypoint),
    'and still gives the data folder to the server\'s user and drops root');

console.log('\n— server code —');
function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : [];
    });
}
const isTest = (p: string) => /(^|\/)test-[^/]*\.ts$/.test(p) || p.includes('__fixtures__') || /-test-[^/]*\.ts$/.test(p) || /test-harness\.ts$/.test(p);
const source = walk(SRC).filter((p) => !isTest(path.relative(SRC, p)));
const socketUsers = source.filter((p) => /socketPath\s*:\s*['"`]\/var\/run\/docker\.sock/.test(fs.readFileSync(p, 'utf-8')));
assert(socketUsers.length === 0, `no server code sends a request to Docker's socket (${socketUsers.map((p) => path.relative(SRC, p)).join(', ') || 'none'})`);
const mentions = source.filter((p) => fs.readFileSync(p, 'utf-8').includes('docker.sock')).map((p) => path.relative(SRC, p));
assert(mentions.every((p) => p === 'services/tunnel-connector.ts'), `docker.sock appears only where the server warns that it is mounted (${mentions.join(', ') || 'none'})`);
const connector = fs.readFileSync(path.join(SRC, 'services', 'tunnel-connector.ts'), 'utf-8');
assert(!/\bsocketPath\b/.test(connector) && !/from 'node:https?'/.test(connector), 'and the connector opens no socket of Docker\'s: it only checks that the file exists');
const agent = fs.readFileSync(path.join(SRC, 'services', 'public-address-agent.ts'), 'utf-8');
assert(!/restartSidecar|writeToken|removeToken|CLOUDFLARED_CONTAINER_NAME|PUBLIC_ADDRESS_ORIGIN/.test(agent), 'the agent has no sidecar restart, token file or origin override left');

console.log('\n— image —');
const dockerfile = read('Dockerfile');
const stage = /^FROM cloudflare\/cloudflared:(\d+\.\d+\.\d+)@sha256:([0-9a-f]{64}) AS cloudflared$/m.exec(dockerfile);
assert(!!stage, `the Dockerfile takes cloudflared from Cloudflare's image pinned by version and digest (${stage ? `${stage[1]}@${stage[2].slice(0, 12)}…` : 'not found'})`);
assert(/^COPY --from=cloudflared --chown=root:root \/usr\/local\/bin\/cloudflared \/usr\/local\/bin\/cloudflared$/m.test(dockerfile), 'copies only its binary into the runtime image, owned by root');
assert(/^RUN cloudflared --version$/m.test(dockerfile), 'and runs it once, so a platform whose binary does not run fails the build');
const runtimeAt = dockerfile.indexOf('AS runtime');
assert(runtimeAt !== -1 && dockerfile.indexOf('COPY --from=cloudflared') > runtimeAt, 'in the runtime stage');

console.log(`\n${passed}/${run} checks passed.`);
process.exit(process.exitCode ?? 0);
