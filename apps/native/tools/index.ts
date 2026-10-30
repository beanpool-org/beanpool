/**
 * The phone's half of every tool (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.1): one line per tool, keyed
 * by its id, beside its lines in @beanpool/core's TOOLS and apps/pwa/src/tools/index.ts. scripts/tools/check-tool-budgets.mjs
 * refuses a folder here that isn't registered in all three, and `node scripts/tools/new-tool.mjs <id>` writes them.
 *
 * A tool's folder holds only its screens and talks to the app through the host (eslint.config.mjs fences its imports).
 * Its index is its ToolApp, whose screens are a thunk: nothing of a tool runs at app start. The host route, the Tools
 * screen and the primitives (app/tool/[id].tsx, app/tools.tsx, tools/host.ts, tools/ui.tsx) are slice T0.2, and read the
 * registry through the functions below it.
 */
import type { ComponentType } from 'react';
import {
    TOOLS, TOOL_SHELVES, toolHomeCardType, toolsOnShelf, word,
    type AnyToolScreenProps, type HomeNodeFacts, type ToolApp, type ToolManifest, type ToolShelf, type WordKey,
} from '@beanpool/core';
import thingsApp from './things';
import gardenApp from './garden';

export type PhoneToolApp = ToolApp<ComponentType<AnyToolScreenProps>>;

/** Every tool's phone half, by id. */
export const TOOL_APPS: Readonly<Record<string, PhoneToolApp>> = {
    things: thingsApp,
    garden: gardenApp,
};

// ── Read by the host (slice T0.2): nothing below names a tool ───────────────────────────────────────────────────

/** A tool this build has on the phone: its manifest in core and its phone half. */
export interface PhoneTool {
    manifest: ToolManifest;
    app: PhoneToolApp;
}

/** Every tool with both halves here, in core's shelf order. A manifest with no phone half is not this build's tool. */
export function phoneTools(apps: Readonly<Record<string, PhoneToolApp>> = TOOL_APPS, manifests: readonly ToolManifest[] = TOOLS): PhoneTool[] {
    return manifests.flatMap((manifest) => {
        const app = Object.prototype.hasOwnProperty.call(apps, manifest.id) ? apps[manifest.id] : undefined;
        return app && app.id === manifest.id ? [{ manifest, app }] : [];
    });
}

/** A tool by its id (a route's or a notification's), or null for one this build doesn't have. */
export function phoneTool(id: string, tools: readonly PhoneTool[] = phoneTools()): PhoneTool | null {
    return tools.find((t) => t.manifest.id === id) ?? null;
}

/**
 * The Home card types this build draws for its tools (`tool-<id>`, for utils/home-cards.ts HOME_DRAWN): every tool here
 * whose manifest has a Home card. The host draws the manifest's lines (tools/frame.tsx ToolHomeBody), or the tool's own
 * `homeBody` when it has one.
 */
export function toolHomeCardIds(tools: readonly PhoneTool[] = phoneTools()): string[] {
    return tools.filter((t) => t.manifest.homeCard).map((t) => toolHomeCardType(t.manifest.id));
}

/** The tool a Home card type is, or null for any other card (or a tool this build doesn't have). */
export function toolOfHomeCard(type: string, tools: readonly PhoneTool[] = phoneTools()): PhoneTool | null {
    if (!type.startsWith('tool-')) return null;
    const tool = phoneTool(type.slice('tool-'.length), tools);
    return tool?.manifest.homeCard ? tool : null;
}

// ── The Tools screen's shelves (and the Commons row's test: is there any) ──────────────────────────────────────

/** Each shelf's heading (round 2 §7). */
export const SHELF_HEADINGS: Record<ToolShelf, WordKey> = {
    stock: word('Stock: what you have'),
    trade: word('Trade: how you deal'),
    books: word("Books: how it's going"),
};

/** The tools of each shelf for a member of this community, in shelf order; an empty shelf is left out. */
export function memberShelves(facts: HomeNodeFacts, manifests: readonly ToolManifest[]): Array<{ shelf: ToolShelf; tools: ToolManifest[] }> {
    return TOOL_SHELVES
        .map((shelf) => ({ shelf, tools: toolsOnShelf(shelf, null, 'member', facts, manifests) }))
        .filter((s) => s.tools.length > 0);
}
