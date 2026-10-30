/**
 * The tool's phone half (docs/tools-template.md step 4): its screens, one per name in the manifest's `screens`. The
 * thunk keeps them out of app start: Metro bundles a require() inside a function but runs it on first open.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';

const app: ToolApp<ComponentType<AnyToolScreenProps>> = {
    id: 'garden',
    screens: () => require('./screens').SCREENS,
};
export default app;
