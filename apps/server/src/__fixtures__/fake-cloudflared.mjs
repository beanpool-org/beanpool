// A stand-in for cloudflared, for the tunnel suites (services/tunnel-connector.ts). No suite ever starts the real binary.
//
//   node fake-cloudflared.mjs <control folder> <cloudflared's own arguments…>
//
// The connector runs it through setTunnelConnectorForTests({ command: process.execPath, prefixArgs: [this file, folder] }),
// so it sees exactly the arguments and the environment the real one would. It:
//   - waits <folder>/start-delay-ms first, when it exists (a loaded machine's slow start: FAKE_CLOUDFLARED_START_DELAY_MS);
//   - appends { pid, argv, env, at, started } to <folder>/runs.jsonl as it starts (`started`: when its process began, before
//     any start-up delay);
//   - exits at once with code 1 while <folder>/crash exists (a crash);
//   - serves GET /ready on the --metrics address: <folder>/ready.json's { status, readyConnections }, else 503;
//   - prints each line of the files <folder>/say.<seq>.jsonl to stderr, in order, as cloudflared prints its log, then deletes
//     each. A suite writes one whole under another name and renames it into place (tunnel-test-fake.ts say), so the fake never
//     takes an empty file that is written to a moment later: that line was lost, and a suite waiting for it ran out its time.
//     It looks every 25 ms, or every <folder>/say-poll-ms when it exists (a loaded machine's late reader:
//     FAKE_CLOUDFLARED_SAY_POLL_MS), to show a suite waits for the line it said, not for a fixed time;
//   - the three again per name: crash.<id>, ready.<id>.json and say.<id>.<seq>.jsonl speak only to the child whose TUNNEL_TOKEN
//     gives that <id> (tokenFileId), so a suite can crash or refuse one name's tunnel and leave another's alone;
//   - on SIGTERM appends { pid, signal } to <folder>/exits.jsonl and exits 0;
//   - exits when the server that started it is gone, so a killed test node never leaves one behind.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const [dir, ...argv] = process.argv.slice(2);
const at = (f) => path.join(dir, f);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(at(f), 'utf-8')); } catch { return null; } };
const parent = process.ppid;
/** Keep the same in tunnel-test-fake.ts. */
const tokenFileId = (token) => String(token ?? '').replace(/[^A-Za-z0-9_-]/g, '_');
const id = tokenFileId(process.env.TUNNEL_TOKEN);

// First, so a SIGTERM that arrives while it starts is recorded too.
process.on('SIGTERM', () => {
    fs.appendFileSync(at('exits.jsonl'), JSON.stringify({ pid: process.pid, signal: 'SIGTERM', at: Date.now() }) + '\n');
    process.exit(0);
});

fs.mkdirSync(dir, { recursive: true });
// The connector's spawn resolves on the 'spawn' event; on a loaded CI runner this process records itself well after that.
const startDelayMs = Number(readJson('start-delay-ms')) || 0;
const sayPollMs = Number(readJson('say-poll-ms')) || 25;
if (startDelayMs > 0) await new Promise((r) => setTimeout(r, startDelayMs));
fs.appendFileSync(at('runs.jsonl'), JSON.stringify({ pid: process.pid, argv, env: { ...process.env }, at: Date.now(), started: Math.round(performance.timeOrigin) }) + '\n');

if (fs.existsSync(at('crash')) || fs.existsSync(at(`crash.${id}`))) {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'fake cloudflared crashed on purpose' }) + '\n');
    process.exit(1);
}

const metrics = argv[argv.indexOf('--metrics') + 1] || '127.0.0.1:0';
const [host, port] = metrics.split(':');
const server = http.createServer((req, res) => {
    if (req.url !== '/ready') { res.writeHead(404); res.end(); return; }
    const r = readJson(`ready.${id}.json`) ?? readJson('ready.json') ?? { status: 503, readyConnections: 0 };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: r.status, readyConnections: r.readyConnections ?? 0 }));
});
server.on('error', (e) => {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'metrics server', error: String(e?.message || e) }) + '\n');
    process.exit(1);
});
server.listen(Number(port), host);

/** A line said to every fake (`say.<seq>.jsonl`) or to the one on this token (`say.<id>.<seq>.jsonl`): tunnel-test-fake.ts. */
const SAID = /^say\.(?:([A-Za-z0-9_-]+)\.)?(\d{14}-\d{6})\.jsonl$/;
setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
    let said = [];
    try {
        said = fs.readdirSync(dir)
            .map((f) => ({ f, m: SAID.exec(f) }))
            .filter((x) => x.m && (x.m[1] === undefined || x.m[1] === id))
            .sort((a, b) => (a.m[2] < b.m[2] ? -1 : a.m[2] > b.m[2] ? 1 : 0));
    } catch { return; }
    for (const { f } of said) {
        // A said file appears whole (it is renamed into place), so nothing is read half written or lost to a rename.
        const taken = at(`said.${process.pid}.taken`);
        try { fs.renameSync(at(f), taken); } catch { continue; }
        for (const line of fs.readFileSync(taken, 'utf-8').split('\n')) if (line.trim()) process.stderr.write(line + '\n');
        fs.rmSync(taken, { force: true });
    }
}, sayPollMs);
