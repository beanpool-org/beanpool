import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Owner-delete S4b, item 6: an action that removes or replaces data, keys or roles is confirmed in the page
 * (components/common/InPageConfirm.tsx), never with the browser's window.confirm(). The one window.confirm() kept is a
 * question about this tab's memory before a very large download (lib/node-client.ts): it removes nothing.
 *
 * Counted per file, so a second call in a kept file fails; and any `confirm(` that is not the end of a longer name counts,
 * whatever is before it (`window.`, `globalThis.`, `self.`, a plain call): PR #2029's review, N1.
 */
const SRC = path.resolve(__dirname);
const KEPT: Record<string, { calls: number; why: string }> = {
    'lib/node-client.ts': { calls: 1, why: 'asks before holding a download of several GB in this tab\'s memory; a read, nothing is removed' },
};
const CONFIRM_CALL = /(^|[^\w])confirm\s*\(/g;

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return sources(p);
        return /\.(ts|tsx)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name) && !/\.testing\.ts$/.test(e.name) ? [p] : [];
    });
}

/** The code of a file without its comments, so a comment that names confirm() is not a call. */
function code(file: string): string {
    return fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

describe('no window confirm() for a destructive action', () => {
    const files = sources(SRC).map((f) => ({ rel: path.relative(SRC, f).split(path.sep).join('/'), text: code(f) }));

    it('calls confirm() only where the kept list says why, and only as often as it says', () => {
        const calls = Object.fromEntries(files
            .map((f) => [f.rel, (f.text.match(CONFIRM_CALL) ?? []).length] as const)
            .filter(([, n]) => n > 0));
        expect(calls).toEqual(Object.fromEntries(Object.entries(KEPT).map(([rel, k]) => [rel, k.calls])));
    });

    it('every in-page question is awaited (an un-awaited promise is truthy and would never ask)', () => {
        const unawaited = files.flatMap((f) => {
            const hits = [...f.text.matchAll(/(^|[^\w.])ask\(\{/g)].map((m) => m.index ?? 0);
            return hits.filter((i) => !/await\s*$/.test(f.text.slice(Math.max(0, i - 12), i + 1))).map(() => f.rel);
        });
        expect(unawaited).toEqual([]);
        // And the hook is in use: the eleven actions, in nine files, this lane moved off window.confirm().
        const asking = files.filter((f) => /await ask\(\{/.test(f.text)).map((f) => f.rel).sort();
        expect(asking).toEqual([
            'App.tsx',
            'components/modules/ApplianceSection.tsx',
            'components/modules/AutomationTokensPanel.tsx',
            'components/modules/BulletinSection.tsx',
            'components/modules/ConnectedAssistantsPanel.tsx',
            'components/modules/EconomySection.tsx',
            'components/modules/OffboxBackupsPanel.tsx',
            'components/modules/PeopleSafetySection.tsx',
            'components/modules/TopologyModule.tsx',
        ]);
    });
});
