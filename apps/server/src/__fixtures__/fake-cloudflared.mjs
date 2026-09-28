// A stand-in for cloudflared, for the tunnel suites (services/tunnel-connector.ts). No suite ever starts the real binary.
//
//   node fake-cloudflared.mjs <control folder> <cloudflared's own arguments…>
//
// The connector runs it through setTunnelConnectorForTests({ command: process.execPath, prefixArgs: [this file, folder] }),
// so it sees exactly the arguments and the environment the real one would. It:
//   - appends { pid, argv, env, at } to <folder>/runs.jsonl as it starts;
//   - exits at once with code 1 while <folder>/crash exists (a crash);
//   - serves GET /ready on the --metrics address: <folder>/ready.json's { status, readyConnections }, else 503;
//   - prints each line of <folder>/say.jsonl to stderr, as cloudflared prints its log, then deletes the file;
//   - on SIGTERM appends { pid, signal } to <folder>/exits.jsonl and exits 0;
//   - exits when the server that started it is gone, so a killed test node never leaves one behind.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const [dir, ...argv] = process.argv.slice(2);
const at = (f) => path.join(dir, f);
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(at(f), 'utf-8')); } catch { return null; } };
const parent = process.ppid;

fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(at('runs.jsonl'), JSON.stringify({ pid: process.pid, argv, env: { ...process.env }, at: Date.now() }) + '\n');

if (fs.existsSync(at('crash'))) {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'fake cloudflared crashed on purpose' }) + '\n');
    process.exit(1);
}

const metrics = argv[argv.indexOf('--metrics') + 1] || '127.0.0.1:0';
const [host, port] = metrics.split(':');
const server = http.createServer((req, res) => {
    if (req.url !== '/ready') { res.writeHead(404); res.end(); return; }
    const r = readJson('ready.json') ?? { status: 503, readyConnections: 0 };
    res.writeHead(r.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: r.status, readyConnections: r.readyConnections ?? 0 }));
});
server.on('error', (e) => {
    process.stderr.write(JSON.stringify({ level: 'error', message: 'metrics server', error: String(e?.message || e) }) + '\n');
    process.exit(1);
});
server.listen(Number(port), host);

setInterval(() => {
    try { process.kill(parent, 0); } catch { process.exit(0); }
    const taken = at(`say.${process.pid}.taken`);
    try { fs.renameSync(at('say.jsonl'), taken); } catch { return; }
    for (const line of fs.readFileSync(taken, 'utf-8').split('\n')) if (line.trim()) process.stderr.write(line + '\n');
    fs.rmSync(taken, { force: true });
}, 25);

process.on('SIGTERM', () => {
    fs.appendFileSync(at('exits.jsonl'), JSON.stringify({ pid: process.pid, signal: 'SIGTERM', at: Date.now() }) + '\n');
    process.exit(0);
});
