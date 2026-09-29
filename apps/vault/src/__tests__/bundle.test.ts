import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs build script, no types
import { bundleVault, PROGRAMS } from '../../scripts/bundle.mjs';

/**
 * The release bundles (V3): the same commit and custodian keys give the same bytes, so anyone can rebuild a release's
 * `apiBundleHash` and compare. What CI checks of the image is this and the manifest and chain tests; the whole boot
 * file is built and compared twice by `image/build.sh` (see the README: it needs Docker and about half an hour).
 */

const dir = mkdtempSync(path.join(os.tmpdir(), 'bvb-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const keys = () => [0, 1, 2].map(() => crypto.randomBytes(32).toString('hex'));

describe('the release bundles', () => {
    it('two builds with the same keys give the same bytes; other keys give another API bundle', async () => {
        const rootKeys = keys();
        const a = await bundleVault({ outDir: path.join(dir, 'a'), rootKeys }) as Record<string, string>;
        const b = await bundleVault({ outDir: path.join(dir, 'b'), rootKeys }) as Record<string, string>;
        expect(Object.keys(a).sort()).toEqual(Object.keys(PROGRAMS).sort());
        expect(b).toEqual(a);
        for (const file of Object.keys(PROGRAMS)) {
            expect(readFileSync(path.join(dir, 'a', file)).equals(readFileSync(path.join(dir, 'b', file)))).toBe(true);
        }
        const other = await bundleVault({ outDir: path.join(dir, 'c'), rootKeys: keys() }) as Record<string, string>;
        expect(other['vault-api.mjs']).not.toBe(a['vault-api.mjs']);
        // Nothing of the machine that built it: no absolute path.
        for (const file of Object.keys(PROGRAMS)) expect(readFileSync(path.join(dir, 'a', file), 'utf8')).not.toContain(dir);
    });

    it('the API bundle\'s self-test passes and reports its pinned keys and its own hash', async () => {
        const rootKeys = keys();
        const hashes = await bundleVault({ outDir: path.join(dir, 'd'), rootKeys }) as Record<string, string>;
        const run = spawnSync(process.execPath, [path.join(dir, 'd', 'vault-api.mjs'), '--self-test'], { encoding: 'utf8' });
        expect(run.status).toBe(0);
        const report = JSON.parse(run.stdout.trim()) as { ok: boolean; rootKeys: string[]; bundleSha256: string; failed: string[] };
        expect(report).toMatchObject({ ok: true, failed: [], rootKeys, bundleSha256: hashes['vault-api.mjs'] });
    });
});
