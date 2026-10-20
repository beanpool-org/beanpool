/**
 * The web's host types: what a tool may import from the template (DESIGN-tool-template-fable.md §1.4).
 *
 * The host builder (`webHostFor`, `useWebHost`, `useToolDoc`) lives in `tools/builder.ts`, which the eslint fence refuses
 * a tool (`eslint.config.mjs`), so a tool cannot build an un-narrowed host.
 */
export type {
    ToolHost,
    ToolHostBase,
    ToolHostGrants,
    ToolManifest,
    ToolOfferDraft,
    ToolNeedDraft,
    ToolPermission,
    ToolScreenProps,
    AnyToolScreenProps,
    ToolApp,
} from '@beanpool/core';

export type { WebToolApp } from './index';
export type { ComposerDraft, WebHostContext, ToolDocState } from './builder';
export { ToolDocTooBig, ToolDocNotKept } from './builder';
