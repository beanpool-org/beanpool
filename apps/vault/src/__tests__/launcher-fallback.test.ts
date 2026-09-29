import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Launcher } from '../launcher/launcher.js';
import { sha256Hex, type ReleaseFiles } from '../shared/release.js';
import { nextMonthlyRestart } from '../shared/schedule.js';
import { keys3, makeRelease, randomImage, type MadeRelease } from './release-kit.js';

/**
 * The launcher's own step back (#1314 round 2, 4135477703), with real processes: this launcher, and API bundles that
 * pass their self-test, say they listen, and ask for a switch when the test tells them to (a file named for their
 * release). A release that keeps exiting after a switch gives way to the API in service before it, not the image's;
 * it may be taken again after a back-off (an hour, doubling, never past the monthly restart); nothing older than what
 * it fell back to is ever taken, and nothing else at or below the newest release switched to.
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvl-'));
const launchers: Launcher[] = [];
afterAll(async () => {
    for (const l of launchers) await l.stop();
    rmSync(dir, { recursive: true, force: true });
});
let n = 0;

/** An API bundle for release `version`: `crash-<version>` in `work` makes it exit (after it said it listens). */
function fakeApi(work: string, version: string, rootKeys: string[]): string {
    const file = path.join(work, `api-${version}.mjs`);
    writeFileSync(file, `import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const VERSION = ${JSON.stringify(version)};
const WORK = ${JSON.stringify(work)};
if (process.argv.includes('--self-test')) {
    const own = crypto.createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
    console.log(JSON.stringify({ ok: true, rootKeys: ${JSON.stringify(rootKeys)}, bundleSha256: own }));
    process.exit(0);
}
process.on('message', m => {
    if (m && m.type === 'drain') process.exit(0);
    if (m && m.type === 'switch-result') {
        writeFileSync(WORK + '/answer-' + m.id + '.part', JSON.stringify(m));
        renameSync(WORK + '/answer-' + m.id + '.part', WORK + '/answer-' + m.id + '.json');
    }
});
process.send({ type: 'ready' });
setInterval(() => {
    if (existsSync(WORK + '/crash-' + VERSION)) process.exit(3);
    const ask = WORK + '/ask-from-' + VERSION + '.json';
    if (!existsSync(ask)) return;
    const { id, request } = JSON.parse(readFileSync(ask, 'utf8'));
    unlinkSync(ask);
    process.send({ type: 'switch', id, request });
}, 20);
`);
    return file;
}

async function until<T>(what: string, fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise(r => setTimeout(r, 20));
    }
}

const files = (r: MadeRelease): ReleaseFiles => ({ manifestText: r.manifestText, signaturesText: r.signaturesText, label: r.label });

function setUp(start: number) {
    const work = path.join(dir, `w-${++n}`);
    mkdirSync(work);
    const root = keys3();
    const rootKeys = root.map(k => k.publicKey);
    const image = randomImage();
    const bundles: Record<string, string> = {};
    const releases: Record<string, MadeRelease> = {};
    let previous: MadeRelease | null = null;
    for (const v of ['1.0.0', '1.0.1', '1.0.2']) {
        bundles[v] = fakeApi(work, v, rootKeys);
        previous = makeRelease({ version: v, previous, custodianKeys: root, signers: root.slice(0, 2), image, apiBundleHash: sha256Hex(readFileSync(bundles[v])) });
        releases[v] = previous;
    }
    const chain = Object.values(releases);
    const clock = { now: start };
    const logs: string[] = [];
    const launcher = new Launcher({
        node: process.execPath, nodeArgs: [], imageBundle: bundles['1.0.0'], apiArgs: [], rootKeys, runningImage: () => releases['1.0.0'].manifest.imageHash, restartDelayMs: 20,
        log: line => logs.push(line), clock: () => clock.now,
    });
    launchers.push(launcher);
    let seq = 0;
    /** The API of release `from` asks the launcher for release `to`; the launcher's answer. */
    const ask = async (from: string, to: string) => {
        const id = ++seq;
        const file = path.join(work, `ask-from-${from}.json`);
        writeFileSync(`${file}.part`, JSON.stringify({ id, request: { bundlePath: bundles[to], release: files(releases[to]), chain: chain.map(files) } }));
        renameSync(`${file}.part`, file);
        const answer = path.join(work, `answer-${id}.json`);
        await until(`the answer to ${from} asking for ${to}`, () => existsSync(answer));
        const { ok, reason } = JSON.parse(readFileSync(answer, 'utf8')) as { ok: boolean; reason?: string };
        return ok ? { ok } : { ok, reason };
    };
    /** The API in service is release `version`'s, and listens (started, or switched to). */
    const inService = (version: string) => until(`${version}'s API in service`, () => launcher.currentBundle === bundles[version]
        && logs.some(l => l === `the API (pid ${launcher.currentPid}) is listening` || l.startsWith(`pid ${launcher.currentPid} is serving`)));
    const crash = (version: string, on: boolean) => (on ? writeFileSync(path.join(work, `crash-${version}`), '') : rmSync(path.join(work, `crash-${version}`), { force: true }));
    const fallbacks = (version: string) => logs.filter(l => l.startsWith(`release ${version} keeps failing`));
    /** Code no release signs, written over `version`'s bundle file: it says it listens, and leaves a mark that it ran. */
    const overwrite = (version: string) => writeFileSync(bundles[version], `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(work, 'unsigned-ran'))}, String(process.pid));
process.send({ type: 'ready' });
setInterval(() => undefined, 1 << 30);
`);
    const unsignedRan = () => existsSync(path.join(work, 'unsigned-ran'));
    return { launcher, bundles, clock, logs, ask, inService, crash, fallbacks, overwrite, unsignedRan };
}

const HOUR = 60 * 60 * 1000;
const iso = (t: number) => new Date(t).toISOString();

describe('the launcher steps back from a release that keeps failing, and takes it again after a back-off', () => {
    it('back to the release in service before it; again after an hour, then two; older releases never, at any point', async () => {
        // 2026-10-05: the next monthly restart is 2026-11-01, far off.
        const t = setUp(Date.UTC(2026, 9, 5, 12));
        await t.launcher.start();
        expect(await t.ask('1.0.0', '1.0.1')).toEqual({ ok: true });
        await t.inService('1.0.1');

        // 1.0.2 passes its self-test and says it listens, then keeps exiting: back to 1.0.1, the API in service before
        // the switch (not the image's 1.0.0).
        t.crash('1.0.2', true);
        expect(await t.ask('1.0.1', '1.0.2')).toEqual({ ok: true });
        await until('the fallback', () => t.fallbacks('1.0.2').length === 1);
        expect(t.fallbacks('1.0.2')[0]).toBe(`release 1.0.2 keeps failing: back to the API in service before it (${t.bundles['1.0.1']}); it may be taken again from ${iso(t.clock.now + HOUR)}`);
        await t.inService('1.0.1');

        // Older than the API it fell back to, or the same: refused. 1.0.2 within the hour: refused.
        expect(await t.ask('1.0.1', '1.0.0')).toEqual({ ok: false, reason: 'never backwards: 1.0.0 is not newer than 1.0.1' });
        expect(await t.ask('1.0.1', '1.0.1')).toEqual({ ok: false, reason: 'never backwards: 1.0.1 is not newer than 1.0.1' });
        const first = t.clock.now + HOUR;
        t.clock.now += HOUR - 1;
        expect(await t.ask('1.0.1', '1.0.2')).toEqual({ ok: false, reason: `release 1.0.2 kept failing after the switch: it may be taken again from ${iso(first)}` });

        // After the hour: taken again. It fails again: back to 1.0.1, for two hours this time.
        t.clock.now += 1;
        expect(await t.ask('1.0.1', '1.0.2')).toEqual({ ok: true });
        await until('the second fallback', () => t.fallbacks('1.0.2').length === 2);
        expect(t.fallbacks('1.0.2')[1]).toContain(`it may be taken again from ${iso(t.clock.now + 2 * HOUR)}`);
        await t.inService('1.0.1');
        const second = t.clock.now + 2 * HOUR;
        t.clock.now += HOUR;
        expect(await t.ask('1.0.1', '1.0.2')).toEqual({ ok: false, reason: `release 1.0.2 kept failing after the switch: it may be taken again from ${iso(second)}` });

        // 1.0.1 keeps failing too: the image's own API. 1.0.1 (below 1.0.2, the newest switched to) is never taken
        // again; 1.0.2 is, once its back-off has passed.
        t.crash('1.0.1', true);
        await until('the image\'s API', () => t.logs.includes('it keeps failing: back to the image\'s own API'));
        await t.inService('1.0.0');
        expect(await t.ask('1.0.0', '1.0.1')).toEqual({ ok: false, reason: 'never backwards: 1.0.1 is not newer than 1.0.2' });
        expect(await t.ask('1.0.0', '1.0.2')).toMatchObject({ ok: false, reason: expect.stringContaining('kept failing after the switch') });
        t.crash('1.0.2', false);
        t.clock.now = second;
        expect(await t.ask('1.0.0', '1.0.2')).toEqual({ ok: true });
        await t.inService('1.0.2');
        expect(await t.ask('1.0.2', '1.0.1')).toEqual({ ok: false, reason: 'never backwards: 1.0.1 is not newer than 1.0.2' });
        expect(await t.ask('1.0.2', '1.0.0')).toEqual({ ok: false, reason: 'never backwards: 1.0.0 is not newer than 1.0.2' });
        expect(t.launcher.currentBundle).toContain('api-1.0.2.mjs');
    }, 60_000);

    it('the back-off never runs past the next monthly restart (which starts the launcher afresh)', async () => {
        const restart = nextMonthlyRestart(Date.UTC(2026, 9, 5, 12));
        const t = setUp(restart - 20 * 60 * 1000);
        await t.launcher.start();
        t.crash('1.0.1', true);
        expect(await t.ask('1.0.0', '1.0.1')).toEqual({ ok: true });
        await until('the fallback', () => t.fallbacks('1.0.1').length === 1);
        expect(t.fallbacks('1.0.1')[0]).toBe(`release 1.0.1 keeps failing: back to the image's own API; it may be taken again from ${iso(restart)}`);
        await t.inService('1.0.0');
        expect(await t.ask('1.0.0', '1.0.1')).toMatchObject({ ok: false, reason: `release 1.0.1 kept failing after the switch: it may be taken again from ${iso(restart)}` });
    }, 60_000);
});

describe('the launcher checks a release\'s file again before every start (#1314 round 3, 4138896441)', () => {
    it('the file of the API in service overwritten, and its process killed: the image\'s own API starts, not the file', async () => {
        const t = setUp(Date.UTC(2026, 9, 5, 12));
        await t.launcher.start();
        expect(await t.ask('1.0.0', '1.0.1')).toEqual({ ok: true });
        await t.inService('1.0.1');
        const pid = t.launcher.currentPid as number;
        t.overwrite('1.0.1');
        process.kill(pid, 'SIGKILL');
        await until('the image\'s API', () => t.logs.some(l => l.startsWith(`not starting ${t.bundles['1.0.1']}`)));
        await t.inService('1.0.0');
        expect(t.logs.find(l => l.startsWith('not starting'))).toBe(
            `not starting ${t.bundles['1.0.1']}: its bytes changed after it was checked; the image's own API instead (release 1.0.1 may be taken again from ${iso(t.clock.now + HOUR)})`);
        await new Promise(r => setTimeout(r, 300));
        expect(t.unsignedRan()).toBe(false);
        expect(t.logs.filter(l => l.startsWith(`started the API (${t.bundles['1.0.1']})`))).toEqual([]);
    }, 60_000);

    it('the fallback\'s file overwritten before the release after it keeps failing: the image\'s own API, not the file', async () => {
        const t = setUp(Date.UTC(2026, 9, 5, 12));
        await t.launcher.start();
        expect(await t.ask('1.0.0', '1.0.1')).toEqual({ ok: true });
        await t.inService('1.0.1');
        expect(await t.ask('1.0.1', '1.0.2')).toEqual({ ok: true });
        await t.inService('1.0.2');
        // 1.0.1 is where the launcher would step back to; its file is rewritten, then 1.0.2 keeps exiting.
        t.overwrite('1.0.1');
        t.crash('1.0.2', true);
        await until('the fallback', () => t.fallbacks('1.0.2').length === 1);
        await until('the image\'s API', () => t.logs.some(l => l.startsWith(`not starting ${t.bundles['1.0.1']}`)));
        await t.inService('1.0.0');
        expect(t.logs.find(l => l.startsWith('not starting'))).toBe(`not starting ${t.bundles['1.0.1']}: its bytes changed after it was checked; the image's own API instead`);
        await new Promise(r => setTimeout(r, 300));
        expect(t.unsignedRan()).toBe(false);
    }, 60_000);
});
