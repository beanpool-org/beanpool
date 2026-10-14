/**
 * Loaded into the server under test with `node --import` by scripts/load/heavy-lists.mjs; not part of the server.
 *
 * Samples the process's memory every 5 ms (V8 heap used, external and ArrayBuffer memory, RSS) and the event loop's
 * delay, and answers on its own loopback port (LOAD_PROBE_PORT):
 *   GET /peak             the peaks since the last /peak, then starts new ones
 *   GET /mem              the memory now
 *   GET /prof/start       starts V8's sampling heap profiler, counting objects the GC has already freed as well, so a
 *                         short-lived response's allocations show
 *   GET /prof/stop?out=   stops it and writes the profile (.heapprofile, DevTools' format) to `out`
 *   GET /snapshot?out=    writes a heap snapshot to `out`
 * The sampler runs on the server's own event loop, so a read that holds the loop for 300 ms is sampled before and after
 * it, not during; the GC trace (--trace-gc) in the server's log gives the heap at each collection as a check.
 */
import http from 'node:http';
import inspector from 'node:inspector';
import fs from 'node:fs';
import v8 from 'node:v8';
import { monitorEventLoopDelay } from 'node:perf_hooks';

const port = Number(process.env.LOAD_PROBE_PORT);
if (port) {
    const fresh = () => ({ heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0, rss: 0 });
    let peak = fresh();
    const sample = () => {
        const m = process.memoryUsage();
        for (const k of Object.keys(peak)) if (m[k] > peak[k]) peak[k] = m[k];
    };
    setInterval(sample, 5).unref();
    let loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();

    let session = null;
    const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://probe');
        const send = (o) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
        try {
            if (url.pathname === '/peak') {
                sample();
                const out = { ...peak, loopMaxMs: loop.max / 1e6, loopP99Ms: loop.percentile(99) / 1e6, heapLimit: v8.getHeapStatistics().heap_size_limit };
                peak = fresh();
                loop.reset();
                return send(out);
            }
            if (url.pathname === '/mem') return send({ ...process.memoryUsage(), heapLimit: v8.getHeapStatistics().heap_size_limit });
            if (url.pathname === '/prof/start') {
                session = new inspector.Session();
                session.connect();
                await post('HeapProfiler.enable');
                await post('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
                return send({ started: true });
            }
            if (url.pathname === '/prof/stop') {
                const { profile } = await post('HeapProfiler.stopSampling');
                fs.writeFileSync(url.searchParams.get('out'), JSON.stringify(profile));
                session.disconnect();
                session = null;
                return send({ written: url.searchParams.get('out') });
            }
            if (url.pathname === '/snapshot') return send({ written: v8.writeHeapSnapshot(url.searchParams.get('out')) });
            res.statusCode = 404;
            res.end();
        } catch (e) {
            res.statusCode = 500;
            send({ error: String(e?.message || e) });
        }
    });
    server.listen(port, '127.0.0.1');
    server.unref();
}
