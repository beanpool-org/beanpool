/**
 * The tool registry (scratch/tools/DESIGN-tool-template-fable.md §1.2, slice T0.1): every built-in tool, in shelf order,
 * and the rules the Tools screen, the shelves and Home read from it. Nothing outside a tool's three folders names a tool:
 * adding one is its folders and one line here, in apps/native/tools/index.ts and in apps/pwa/src/tools/index.ts
 * (`node scripts/tools/new-tool.mjs <id>` writes all three; scripts/tools/check-tool-budgets.mjs refuses a folder that is
 * missing from any; docs/tools-template.md is the rest).
 *
 * A tool's line here is an import of its manifest, an `export *` of its folder (so the apps can name its types) and its
 * entry in TOOLS. Pure: no I/O (the barrel is bundled for the phone, barrel-is-universal.test.ts).
 */
import type { HomeCardType, HomeNodeFacts } from '../home-frame.js';
import type { ShopKind, ToolManifest, ToolShelf } from './manifest.js';

export * from './manifest.js';
export * from './host.js';
export * from './check.js';
export * from './reconcile.js';

/** Every tool this build has, in shelf order. */
export const TOOLS: readonly ToolManifest[] = [
];

/** A tool by its id, or undefined for one this build doesn't have ("This tool isn't in this version of the app"). */
export const toolById = (id: string, tools: readonly ToolManifest[] = TOOLS): ToolManifest | undefined => tools.find((t) => t.id === id);

/** Who a shelf is drawn for: a member's Tools screen, or an enterprise's console (S7). */
export type ToolReader = 'member' | 'enterprise';

const forReader = (t: ToolManifest, reader: ToolReader) => t.owner === 'both' || t.owner === reader;
const onThisNode = (t: ToolManifest, facts: HomeNodeFacts) => t.onNode?.(facts) ?? true;
const forKind = (t: ToolManifest, kind: ShopKind) => t.shopKinds === 'all' || t.shopKinds.includes(kind);

/**
 * The tools on one shelf of the Tools screen (§1.5), in the registry's order: every tool on that shelf for this reader
 * that this node can have and, for a shop of a kind, only those for that kind (the rest are under "More tools",
 * {@link toolsMore}). Nothing here names a tool, and nothing is shown locked: a tool a node can't have isn't listed.
 */
export function toolsOnShelf(
    shelf: ToolShelf, kind: ShopKind | null, reader: ToolReader, facts: HomeNodeFacts, tools: readonly ToolManifest[] = TOOLS,
): ToolManifest[] {
    return tools.filter((t) => t.shelf === shelf && forReader(t, reader) && onThisNode(t, facts) && (kind === null || forKind(t, kind)));
}

/** The "More tools" heading for a shop of a kind: the reader's tools on this node that aren't for that kind. None without a kind. */
export function toolsMore(kind: ShopKind | null, reader: ToolReader, facts: HomeNodeFacts, tools: readonly ToolManifest[] = TOOLS): ToolManifest[] {
    if (kind === null) return [];
    return tools.filter((t) => forReader(t, reader) && onThisNode(t, facts) && !forKind(t, kind));
}

/** The Home card type of a tool: `tool-<id>`. */
export const toolHomeCardType = (id: string): string => `tool-${id}`;

/**
 * The Home card types of the tools that have one, for home-frame.ts's registry (just before Your community): in the
 * picker under For you, worked out on the device from the tool's document (`asks: 'none'`, so the node is never asked
 * and builds nothing), shown where the tool is: Home is a member's, so a card for a tool that is on no member's shelf (an
 * enterprise's own) is never offered. An app or node without the tool keeps such a card and draws nothing.
 */
export function toolHomeCardTypes(tools: readonly ToolManifest[] = TOOLS): HomeCardType[] {
    return tools.filter((t) => t.homeCard).map((t) => ({
        id: toolHomeCardType(t.id),
        name: t.name,
        line: t.homeCard!.line,
        group: 'you',
        asks: 'none',
        onNode: (answer: HomeNodeFacts) => forReader(t, 'member') && onThisNode(t, answer),
    }));
}
