/**
 * The tool's web half (docs/tools-template.md step 4): the same screens as the phone's. apps/pwa/src/tools/index.ts
 * loads this file on first open, so Vite makes the tool its own chunk.
 */
import type { ComponentType } from 'react';
import type { AnyToolScreenProps, ToolApp } from '@beanpool/core';
import { SCREENS } from './screens';

const app: ToolApp<ComponentType<AnyToolScreenProps>> = {
    id: 'scaffold',
    screens: () => SCREENS,
};
export default app;
