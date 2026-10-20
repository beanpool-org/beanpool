/**
 * The phone's host types: what a tool may import from the template (DESIGN-tool-template-fable.md §1.4).
 *
 * The host builder (`phoneHost`, `hostFor`) lives in `tools/builder.ts`, which the eslint fence refuses a tool
 * (`eslint.config.mjs`), so a tool cannot construct an un-narrowed host.
 */
export type {
    ToolHost,
    ToolHostBase,
    ToolHostGrants,
    ToolManifest,
    ToolOfferDraft,
    ToolNeedDraft,
    ToolPermission,
    ToolPostStatus,
    ToolScreenProps,
    AnyToolScreenProps,
    ToolApp,
} from '@beanpool/core';

export type { PhoneToolApp } from './index';
export type { PhoneHostContext } from './builder';
