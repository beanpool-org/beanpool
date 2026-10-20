/**
 * Tests only: the scaffold tool (scripts/tools/_scaffold, what `node scripts/tools/new-tool.mjs <id>` writes) registered
 * for a test, without touching the source tree. The registry has no tools yet (slice T0.3 ships none), so the web host's
 * generic tests draw this one, exactly as new-tool.mjs would write it: its core half (manifest, document, fixtures) and
 * its web half (screens), each file written to a scratch folder with its imports pointed back at what they name in the
 * tree. Core is the built @beanpool/core (the same module the app imports, so t() and the language are one), and the web
 * half's `../ui` is the template's own primitives.
 *
 * core's __tests__/tools-template.test.ts does the same for the core half.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp, ToolFixtures, ToolManifest } from '@beanpool/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PWA_TOOLS = path.resolve(HERE, '..');
const REPO = path.resolve(PWA_TOOLS, '../../../..');
const CORE_SRC_TOOLS = path.join(REPO, 'packages/beanpool-core/src/tools');
const CORE_DIST = path.join(REPO, 'packages/beanpool-core/dist');
/**
 * Where the scratch copies go: inside the workspace (Vite serves a jsdom test no file outside it) and in a folder git
 * ignores (`out/`), never under src/ (the size check would read it as a tool). Each run's own folder, removed after.
 */
const SCRATCH = path.join(PWA_TOOLS, '../../out');

export interface ScaffoldTool {
    manifest: ToolManifest;
    fixtures: ToolFixtures<unknown>;
    app: ToolApp<ComponentType<AnyToolScreenProps>>;
    /** The registry entry, as apps/pwa/src/tools/index.ts holds one: a loader of the tool's web half. */
    loader: () => Promise<{ default: ToolApp<ComponentType<AnyToolScreenProps>> }>;
}

interface ScaffoldFile { part: 'core' | 'native' | 'pwa'; rel: string; text: string }

/** `from '…'` with what it names rewritten by `to` (null: kept as written). */
function rewrite(text: string, to: (spec: string) => string | null): string {
    return text.replace(/(from\s+)(['"])([^'"]+)\2/g, (whole, from: string, q: string, spec: string) => {
        const next = to(spec);
        return next === null ? whole : `${from}${q}${next}${q}`;
    });
}

/** The scaffold under `id`, in a scratch folder, its imports pointed at the tree. */
export async function scaffoldTool(id = 'scaffold'): Promise<ScaffoldTool> {
    const { scaffoldFiles } = await import(/* @vite-ignore */ pathToFileURL(path.join(REPO, 'scripts/tools/registry.mjs')).href);
    fs.mkdirSync(SCRATCH, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(SCRATCH, 'tool-scaffold-'));
    const files = (scaffoldFiles(id) as ScaffoldFile[]).filter((f) => f.part !== 'native' && !f.rel.includes('__tests__'));
    for (const f of files) {
        const dest = path.join(tmp, f.part, f.rel);
        let text: string;
        if (f.part === 'core') {
            // Where new-tool.mjs puts it; a file outside the tool's folder is core's, built.
            const fromDir = path.dirname(path.join(CORE_SRC_TOOLS, f.rel));
            text = rewrite(f.text, (spec) => {
                if (!spec.startsWith('.')) return null;
                const target = path.resolve(fromDir, spec);
                const inside = !path.relative(path.join(CORE_SRC_TOOLS, id), target).startsWith('..');
                return inside ? null : path.join(CORE_DIST, path.relative(path.join(REPO, 'packages/beanpool-core/src'), target));
            });
        } else {
            const fromDir = path.dirname(path.join(PWA_TOOLS, f.rel));
            text = rewrite(f.text, (spec) => {
                if (spec === '@beanpool/core') return path.join(CORE_DIST, 'index.js');
                if (!spec.startsWith('.')) return null;
                const target = path.resolve(fromDir, spec);
                const inside = !path.relative(path.join(PWA_TOOLS, id), target).startsWith('..');
                return inside ? null : target;
            });
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, text);
    }
    const core: Record<string, unknown> = await import(/* @vite-ignore */ path.join(tmp, 'core', id, 'index.ts'));
    const manifest = Object.values(core).find((v): v is ToolManifest =>
        !!v && typeof v === 'object' && (v as ToolManifest).id === id && Array.isArray((v as ToolManifest).screens));
    if (!manifest) throw new Error(`the scaffold under ${id} exports no manifest`);
    const { FIXTURES } = await import(/* @vite-ignore */ path.join(tmp, 'core', id, 'fixtures.ts'));
    const web = await import(/* @vite-ignore */ path.join(tmp, 'pwa', id, 'index.ts'));
    const app = web.default as ToolApp<ComponentType<AnyToolScreenProps>>;
    fs.rmSync(tmp, { recursive: true, force: true });
    return { manifest, fixtures: FIXTURES as ToolFixtures<unknown>, app, loader: async () => ({ default: app }) };
}
