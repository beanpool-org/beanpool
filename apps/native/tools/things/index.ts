/**
 * The Tool shed's phone half (scratch/tools/DESIGN-tool-template-fable.md §3.1, slice T1.2): its four screens, one per
 * name in the manifest's `screens`. The thunk keeps them out of app start: Metro bundles a require() inside a function
 * but runs it on first open.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';

const app: ToolApp<ComponentType<AnyToolScreenProps>> = {
    id: 'things',
    screens: () => require('./screens').SCREENS,
};
export default app;
