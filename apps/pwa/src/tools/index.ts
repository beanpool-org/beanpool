/**
 * The web's half of every tool (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.1): one line per tool, keyed by
 * its id, beside its lines in @beanpool/core's TOOLS and apps/native/tools/index.ts. scripts/tools/check-tool-budgets.mjs
 * refuses a folder here that isn't registered in all three, and `node scripts/tools/new-tool.mjs <id>` writes them.
 *
 * Each tool is loaded on first open, so Vite makes it its own chunk and a visitor who never opens it never fetches it.
 * A tool's folder holds only its screens and talks to the app through the host (eslint.config.mjs fences its imports).
 * The covered page, the host and the primitives (ToolsPage, tools/host.ts, tools/ui.tsx) are slice T0.3.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';

export type WebToolApp = ToolApp<ComponentType<AnyToolScreenProps>>;

/** Every tool's web half, by id, as a loader. */
export const TOOL_APPS: Readonly<Record<string, () => Promise<{ default: WebToolApp }>>> = {
};
