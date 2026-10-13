/**
 * A stand-in for utils/db that records every call into it: the net spy's arm for the node client (the showcase's
 * render tests, scratch/global-node/DESIGN-global-showcase-fable.md §4: a screen in preview asks nothing of a node).
 *
 * Every export of utils/db by name, read from its source, so an export added later is covered without touching a test:
 * each function is a real one that pushes `db.<name>` onto `calls` and answers a promise that never settles (the
 * screen waits, as on a phone with no answer yet, instead of failing on an empty answer and hiding the call). A mock
 * that listed no names would answer none of them: vitest refuses an import the factory didn't return, a screen's catch
 * swallows that, and nothing is recorded. The object has no `then`, so the module never reads as a promise.
 *
 *   vi.mock('../db', async () => (await import('./net-spy-db')).dbStandIn(net.calls));
 */
import fs from 'node:fs';
import path from 'node:path';

/** The value exports of utils/db.ts: its functions, its one class and its one string, by name. */
export function dbExportNames(): { functions: string[]; classes: string[]; strings: Record<string, string> } {
    const source = fs.readFileSync(path.resolve(__dirname, '../db.ts'), 'utf8');
    const functions = [...source.matchAll(/^export (?:async )?function\*? ?(\w+)/gm)].map(m => m[1]);
    // `export { a, b };` re-exports a function imported into db.ts (communityCachesRenamed).
    for (const m of source.matchAll(/^export \{([^}]+)\};?/gm)) functions.push(...m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop()!).filter(Boolean));
    const classes = [...source.matchAll(/^export class (\w+)/gm)].map(m => m[1]);
    const strings: Record<string, string> = {};
    for (const m of source.matchAll(/^export const (\w+)\s*=\s*'([^']*)'/gm)) strings[m[1]] = m[2];
    const otherConsts = [...source.matchAll(/^export (?:const|let|var) (\w+)/gm)].map(m => m[1]).filter(n => !(n in strings));
    if (otherConsts.length) throw new Error(`net-spy-db: utils/db exports ${otherConsts.join(', ')}, which this stand-in doesn't know how to stand in for`);
    return { functions, classes, strings };
}

export function dbStandIn(calls: string[]): Record<string, unknown> {
    const { functions, classes, strings } = dbExportNames();
    const out: Record<string, unknown> = { ...strings };
    for (const name of functions) {
        const record = { [name](..._args: unknown[]) { calls.push(`db.${name}`); return new Promise(() => {}); } }[name];
        out[name] = record;
    }
    for (const name of classes) {
        out[name] = class extends Error { constructor(message?: string) { super(message); this.name = name; } };
    }
    return out;
}
