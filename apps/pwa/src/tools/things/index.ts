/**
 * The Tool shed's web half (scratch/tools/DESIGN-tool-template-fable.md §3.1, slice T1.3): the same four screens as the
 * phone's. apps/pwa/src/tools/index.ts loads this file on first open, so Vite makes the tool its own chunk.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';
import { SCREENS } from './screens';

const app: ToolApp<ComponentType<AnyToolScreenProps>> = {
    id: 'things',
    screens: () => SCREENS,
};
export default app;
