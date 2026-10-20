/**
 * Which tools have a card on Home on the web (scratch/tools/DESIGN-tool-template-fable.md §1.3, slice T0.3): a tool with
 * a Home card in its manifest and a web half registered here. Pure, so lib/home-layout.ts builds `HOME_DRAWN` from it
 * and tools/home-card.tsx (Home's default branch) draws the same set.
 */
import { TOOLS, toolHomeCardType, type ToolManifest } from '@beanpool/core';
import { TOOL_APPS } from './index';

type Registered = Readonly<Record<string, unknown>>;

/** The tool a Home card type is the card of, when this build has it with a Home card and a web half. */
export function toolOfCard(type: string, tools: readonly ToolManifest[] = TOOLS, apps: Registered = TOOL_APPS): ToolManifest | undefined {
    return tools.find((m) => !!m.homeCard && !!apps[m.id] && toolHomeCardType(m.id) === type);
}

/** Every tool card type this build draws. */
export function drawnToolCardTypes(tools: readonly ToolManifest[] = TOOLS, apps: Registered = TOOL_APPS): string[] {
    return tools.filter((m) => !!m.homeCard && !!apps[m.id]).map((m) => toolHomeCardType(m.id));
}
