/**
 * The tool template's generic tests (scratch/tools/DESIGN-tool-template-fable.md §1.5 (a), (b), (d), slice T0.1), run for
 * every registered tool and for the scaffold scripts/tools/new-tool.mjs copies: each folder under tools/ is one tool in
 * TOOLS; its manifest's shape and bounds hold; every stored value it ever wrote reads as its fixtures say; its pure
 * functions are pure and bounded on its fixtures. And the checks themselves bite: a manifest or fixtures broken in each
 * way is refused in a sentence that names the tool.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { word, wordn, type WordKey } from '../words.js';
import { HOME_FRAME_LIMITS } from '../home-frame.js';
import {
    TOOLS, TOOL_LIMITS, toolDocMaxBytes, toolFixtureProblems, toolHomeCardType, toolLineText, toolManifestProblems,
    type ToolFixtures, type ToolManifest,
} from '../tools/index.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(SRC, 'tools');
const REPO = path.resolve(SRC, '../../..');
const folders = fs.readdirSync(TOOLS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('__')).map((d) => d.name).sort();

const isManifest = (v: unknown): v is ToolManifest =>
    !!v && typeof v === 'object' && typeof (v as ToolManifest).id === 'string' && !!(v as ToolManifest).doc && Array.isArray((v as ToolManifest).screens);

describe('every registered tool', () => {
    it("each folder under tools/ is one tool in TOOLS, its manifest's id the folder's name", async () => {
        expect(TOOLS.map((t) => t.id).sort()).toEqual(folders);
        for (const folder of folders) {
            const mod: Record<string, unknown> = await import(pathToFileURL(path.join(TOOLS_DIR, folder, 'index.ts')).href);
            const manifests = Object.values(mod).filter(isManifest);
            expect(manifests.map((m) => m.id), folder).toEqual([folder]);
            expect(TOOLS).toContain(manifests[0]);
        }
    });

    it('no two tools share an id or a name', () => {
        expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
        expect(new Set(TOOLS.map((t) => t.name)).size).toBe(TOOLS.length);
    });

    it("a tool's Home card type fits Home's bound on a type", () => {
        expect(toolHomeCardType('x'.repeat(TOOL_LIMITS.idChars)).length).toBeLessThanOrEqual(HOME_FRAME_LIMITS.typeChars);
    });

    it("a document's bound: the tool's own (64 KB when it names none), never past 128 KB, never past what the node said it keeps", () => {
        expect(TOOL_LIMITS.docBytes).toBe(65_536);
        expect(TOOL_LIMITS.docBytesMax).toBe(131_072);
        const named = (maxBytes?: number) => ({ doc: { maxBytes } });
        expect(toolDocMaxBytes(named())).toBe(65_536);
        expect(toolDocMaxBytes(named(131_072))).toBe(131_072);
        expect(toolDocMaxBytes(named(1_000_000))).toBe(131_072);
        // A node from before tools could name more answers 65536 for every tool: the bound is that.
        expect(toolDocMaxBytes(named(131_072), 65_536)).toBe(65_536);
        expect(toolDocMaxBytes(named(), 131_072)).toBe(65_536);
        // Nothing heard, or nothing a node would say, is no bound of the node's.
        for (const junk of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(toolDocMaxBytes(named(131_072), junk)).toBe(131_072);
    });

    for (const tool of TOOLS) {
        it(`${tool.id}: its manifest, and its fixtures read cleanly`, async () => {
            expect(toolManifestProblems(tool)).toEqual([]);
            const file = path.join(TOOLS_DIR, tool.id, 'fixtures.ts');
            expect(fs.existsSync(file), `${tool.id} has a fixtures.ts`).toBe(true);
            const { FIXTURES } = await import(pathToFileURL(file).href);
            expect(toolFixtureProblems(tool, FIXTURES)).toEqual([]);
        });
    }
});

describe("the scaffold (scripts/tools/_scaffold, what new-tool.mjs writes)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beanpool-tool-scaffold-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

    /** The scaffold's core half for `id`, written outside the source tree with its imports of core pointed back at it. */
    async function scaffoldCore(id: string): Promise<{ manifest: ToolManifest; fixtures: ToolFixtures<unknown> }> {
        const registry = path.join(REPO, 'scripts/tools/registry.mjs');
        const { scaffoldFiles } = await import(/* @vite-ignore */ pathToFileURL(registry).href);
        const virtual = path.join(TOOLS_DIR, id); // where new-tool.mjs would put it
        for (const f of (scaffoldFiles(id) as { part: string; rel: string; text: string }[]).filter((f) => f.part === 'core')) {
            const dest = path.join(tmp, f.rel);
            const fromDir = path.dirname(path.join(TOOLS_DIR, f.rel));
            const text = f.text.replace(/(from\s+)(['"])(\.[^'"]+)\2/g, (whole, from, q, spec) => {
                const target = path.resolve(fromDir, spec);
                if (!path.relative(virtual, target).startsWith('..')) return whole; // the tool's own file, written beside it
                return `${from}${q}${target.replace(/\.js$/, '.ts')}${q}`;
            });
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, text);
        }
        const mod: Record<string, unknown> = await import(pathToFileURL(path.join(tmp, id, 'index.ts')).href);
        const { FIXTURES } = await import(pathToFileURL(path.join(tmp, id, 'fixtures.ts')).href);
        return { manifest: Object.values(mod).find(isManifest)!, fixtures: FIXTURES };
    }

    it('passes the generic tests as written, under a new id', async () => {
        const { manifest, fixtures } = await scaffoldCore('new-tool-check');
        expect(manifest.id).toBe('new-tool-check');
        expect(toolManifestProblems(manifest)).toEqual([]);
        expect(toolFixtureProblems(manifest, fixtures)).toEqual([]);
    });
});

describe('the checks bite', () => {
    type Doc = { v: number; items: string[] };
    const read = (raw: unknown): Doc => {
        const r = raw as Partial<Doc> | null;
        if (!r || typeof r !== 'object' || typeof r.v !== 'number') return { v: 1, items: [] };
        return { ...r, v: r.v, items: Array.isArray(r.items) ? r.items.filter((i) => typeof i === 'string') : [] } as Doc;
    };
    const good: ToolManifest<Doc> = {
        id: 'sample', name: word('Sample tool'), line: word('A tool for the tests.'), icon: '🧪', shelf: 'stock', categories: ['tools'],
        owner: 'member', permissions: [], doc: { version: 1, empty: () => ({ v: 1, items: [] }), read }, screens: ['main'],
        row: (d) => ({ key: word('Kept here: {count}'), values: { count: d.items.length } }), examples: [word('An example')],
        homeCard: { line: word('A line for the picker.'), lines: (d) => d.items.slice(0, 2).map(() => ({ key: word('One more') })) },
    };
    const fixtures: ToolFixtures<Doc> = {
        stored: [{ name: 'version 1', raw: { v: 1, items: ['a'] }, reads: { v: 1, items: ['a'] } }],
        docs: { empty: { v: 1, items: [] }, small: { v: 1, items: ['a'] }, full: { v: 1, items: ['a', 'b'] } },
        now: 0,
    };
    const one = (problems: string[], words: RegExp) => {
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/^Tool \S+: .+\.$/);
        expect(problems[0]).toMatch(words);
    };

    it('a good sample passes, so a refusal below is the change and nothing else', () => {
        expect(toolManifestProblems(good)).toEqual([]);
        expect(toolFixtureProblems(good, fixtures)).toEqual([]);
    });

    it('refuses a manifest out of shape, one sentence each', () => {
        one(toolManifestProblems({ ...good, id: 'Sample_1' }), /id/);
        one(toolManifestProblems({ ...good, id: 'ab--cd' }), /never two hyphens together/);
        one(toolManifestProblems({ ...good, id: undefined as never }), /id/);
        one(toolManifestProblems({ ...good, id: null as never }), /id/);
        const noId: Partial<ToolManifest<Doc>> = { ...good };
        delete noId.id;
        one(toolManifestProblems(noId as never), /id/);
        one(toolManifestProblems({ ...good, icon: 'S' }), /emoji/);
        one(toolManifestProblems({ ...good, categories: ['tools', 'spaceships' as never] }), /spaceships is not one of the Market's categories/);
        one(toolManifestProblems({ ...good, categories: ['tools', 'baking' as never] }), /baking is not one of the Market's categories/);
        one(toolManifestProblems({ ...good, permissions: ['contacts' as never] }), /contacts is not a permission/);
        one(toolManifestProblems({ ...good, permissions: ['reminders'] }), /asks for 'reminders' but has none/);
        one(toolManifestProblems({ ...good, reminders: { list: [{ id: 'r', name: word('A reminder'), defaultOn: true }], due: () => [] } }), /does not ask for the 'reminders'/);
        one(toolManifestProblems({ ...good, permissions: ['reminders'], reminders: { list: [{ id: 'due:back', name: word('A reminder'), defaultOn: true }], due: () => [] } }), /reminder due:back is not 1 to 24 lowercase letters, digits and hyphens/);
        one(toolManifestProblems({ ...good, screens: ['list', 'main'] }), /start with 'main'/);
        one(toolManifestProblems({ ...good, examples: [] }), /examples/);
        one(toolManifestProblems({ ...good, needs: { fee: 'money' as never } }), /needs.fee is not a node feature/);
        one(toolManifestProblems({ ...good, doc: { ...good.doc, maxBytes: TOOL_LIMITS.docBytesMax + 1 } }), /at most 131072 bytes/);
        expect(toolManifestProblems({ ...good, doc: { ...good.doc, maxBytes: TOOL_LIMITS.docBytesMax } })).toEqual([]);
        one(toolManifestProblems({ ...good, doc: { ...good.doc, read: () => { throw new Error('no'); } } }).slice(0, 1), /throws/);
    });

    it('refuses fixtures that a migration breaks, one sentence each', () => {
        one(toolFixtureProblems(good, { ...fixtures, stored: [...fixtures.stored, { name: 'odd', raw: { v: 1, items: [3] }, reads: { v: 1, items: [3] as never } }] }), /"odd" is not what its fixture says/);
        one(toolFixtureProblems({ ...good, doc: { ...good.doc, version: 2 } }, fixtures), /no stored value of version 2/);
        one(toolFixtureProblems({ ...good, doc: { ...good.doc, read: (raw) => { const d = read(raw); return { v: d.v, items: d.items }; } } }, fixtures), /drops keys it doesn't know/);
        one(toolFixtureProblems({ ...good, doc: { ...good.doc, maxBytes: 22 } }, fixtures), /full document is 25 bytes, over its 22/);
    });

    it('refuses a read() that throws or gives nothing on a document, in a sentence and never by throwing', () => {
        const hasB = (raw: unknown) => !!raw && typeof raw === 'object' && Array.isArray((raw as Doc).items) && (raw as Doc).items.includes('b');
        const throwsOnB = { ...good, doc: { ...good.doc, read: (raw: unknown) => { if (hasB(raw)) throw new Error('boom'); return read(raw); } } };
        let problems: string[] = [];
        expect(() => { problems = toolFixtureProblems(throwsOnB, fixtures); }).not.toThrow();
        expect(problems).toHaveLength(2);
        for (const p of problems) expect(p).toMatch(/^Tool sample: .+\.$/);
        expect(problems[0]).toMatch(/read\(\) throws on its full document/);
        expect(problems[1]).toMatch(/read\(\) throws on a newer version/);

        const throwsOnItself = { ...good, doc: { ...good.doc, read: (raw: unknown) => { if ((raw as { seen?: boolean })?.seen) throw new Error('boom'); return { ...read(raw), seen: true }; } } };
        expect(() => { problems = toolFixtureProblems(throwsOnItself, fixtures); }).not.toThrow();
        expect(problems).toContain('Tool sample: read() throws on its own reading of "version 1": it must never throw.');

        const nothingOnB = { ...good, doc: { ...good.doc, read: (raw: unknown) => (hasB(raw) ? undefined as unknown as Doc : read(raw)) } };
        const stored = [{ name: 'version 1', raw: { v: 1, items: ['b'] }, reads: { v: 1, items: ['b'] } }];
        expect(() => { problems = toolFixtureProblems(nothingOnB, { ...fixtures, stored }); }).not.toThrow();
        expect(problems).toContain('Tool sample: read() of the stored value "version 1" is not JSON, so it can\'t be stored.');
    });

    it("refuses a read() that rebuilds a newer version's records without the keys it doesn't know", () => {
        type Rec = { id: string };
        type RecDoc = { v: number; items: Rec[] };
        const records = (raw: unknown, keep: boolean): RecDoc => {
            const r = raw as Partial<RecDoc> | null;
            if (!r || typeof r !== 'object' || typeof r.v !== 'number') return { v: 1, items: [] };
            const items = (Array.isArray(r.items) ? r.items : []).filter((i) => typeof i?.id === 'string');
            return { ...r, v: r.v, items: items.map((i) => (keep ? { ...i, id: i.id } : { id: i.id })) };
        };
        const { id, name, line, icon, shelf, categories, owner, permissions, screens, examples } = good;
        const tool = (keep: boolean): ToolManifest<RecDoc> => ({
            id, name, line, icon, shelf, categories, owner, permissions, screens, examples, row: () => null,
            doc: { version: 1, empty: () => ({ v: 1, items: [] }), read: (raw) => records(raw, keep) },
        });
        const recFixtures: ToolFixtures<RecDoc> = {
            stored: [{ name: 'version 1', raw: { v: 1, items: [{ id: 'a' }] }, reads: { v: 1, items: [{ id: 'a' }] } }],
            docs: { empty: { v: 1, items: [] }, small: { v: 1, items: [{ id: 'a' }] }, full: { v: 1, items: [{ id: 'a' }, { id: 'b' }] } },
            now: 0,
        };
        expect(toolFixtureProblems(tool(true), recFixtures)).toEqual([]);
        one(toolFixtureProblems(tool(false), recFixtures), /drops the keys it doesn't know on a record in items/);
    });

    it('refuses pure functions that are not pure or not bounded', () => {
        let calls = 0;
        one(toolFixtureProblems({ ...good, row: () => ({ key: word('Kept here: {count}'), values: { count: calls++ } }) }, { ...fixtures, docs: { ...fixtures.docs, small: fixtures.docs.empty, full: fixtures.docs.empty } }).slice(0, 1), /not the same twice/);
        one(toolFixtureProblems({ ...good, homeCard: { line: good.homeCard!.line, lines: (d) => (d.items.length > 1 ? [1, 2, 3].map(() => ({ key: word('One more') })) : []) } }, fixtures), /3 lines on the full document, over 2/);
        one(toolFixtureProblems({ ...good, row: () => ({ key: word('Kept here: {count}'), screen: 'elsewhere' }) }, { ...fixtures, docs: { ...fixtures.docs, small: fixtures.docs.empty, full: fixtures.docs.empty } }).slice(0, 1), /opens elsewhere/);
        const reminders = { list: [{ id: 'back', name: word('A reminder'), defaultOn: true }], due: () => Array.from({ length: 11 }, () => ({ reminder: 'back', at: 1, key: word('One more') })) };
        one(toolFixtureProblems({ ...good, permissions: ['reminders'], reminders }, { ...fixtures, docs: { ...fixtures.docs, small: fixtures.docs.empty, full: fixtures.docs.empty } }).slice(0, 1), /due\(\) returns 11 on the empty document, over 10/);
    });

    it('a line with a count is a wordn() pair with its n, drawn by toolLineText; a reminder is never one', () => {
        const ITEMS = wordn('{n} item kept here', '{n} items kept here');
        const counted: ToolManifest<Doc> = { ...good, row: (d) => ({ key: ITEMS, n: d.items.length }) };
        expect(toolFixtureProblems(counted, fixtures)).toEqual([]);
        expect([0, 1, 2].map((n) => toolLineText({ key: ITEMS, n }))).toEqual(['0 items kept here', '1 item kept here', '2 items kept here']);
        expect(toolLineText({ key: word('Kept here: {count}'), values: { count: 1 } })).toBe('Kept here: 1');

        const onEmpty = { ...fixtures, docs: { ...fixtures.docs, small: fixtures.docs.empty, full: fixtures.docs.empty } };
        one(toolFixtureProblems({ ...good, row: () => ({ key: ITEMS }) }, onEmpty).slice(0, 1), /row\(\) on the empty document has a wordn\(\) key and no count n/);
        one(toolFixtureProblems({ ...good, row: () => ({ key: ITEMS, n: Number.NaN }) }, onEmpty).slice(0, 1), /no count n/);
        one(toolFixtureProblems({ ...good, row: () => ({ key: { one: ITEMS.one, other: '' as WordKey }, n: 1 }) }, onEmpty).slice(0, 1), /is not \{ key: wordn/);
        one(toolFixtureProblems({ ...good, row: () => ({ key: word('Kept here: {count}'), n: 1 }) }, onEmpty).slice(0, 1), /has a count n, but its key is not a wordn\(\) pair/);
        const reminders = { list: [{ id: 'back', name: word('A reminder'), defaultOn: true }], due: () => [{ reminder: 'back', at: 1, key: ITEMS as unknown as WordKey }] };
        one(toolFixtureProblems({ ...good, permissions: ['reminders'], reminders }, onEmpty).slice(0, 1), /a reminder due on the empty document is not \{ key, values\? \}/);
    });
});
