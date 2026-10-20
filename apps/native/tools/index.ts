/**
 * The phone's half of every tool (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.1): one line per tool, keyed
 * by its id, beside its lines in @beanpool/core's TOOLS and apps/pwa/src/tools/index.ts. scripts/tools/check-tool-budgets.mjs
 * refuses a folder here that isn't registered in all three, and `node scripts/tools/new-tool.mjs <id>` writes them.
 *
 * A tool's folder holds only its screens and talks to the app through the host (eslint.config.mjs fences its imports).
 * Its index is its ToolApp, whose screens are a thunk: nothing of a tool runs at app start. The host route, the Tools
 * screen and the primitives (app/tool/[id].tsx, app/tools.tsx, tools/host.ts, tools/ui.tsx) are slice T0.2.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';

export type PhoneToolApp = ToolApp<ComponentType<AnyToolScreenProps>>;

/** Every tool's phone half, by id. */
export const TOOL_APPS: Readonly<Record<string, PhoneToolApp>> = {
};
