/**
 * The worldwide community's one address, in a file that imports only core's constant, so pure modules (utils/community-origin.ts,
 * and through it utils/home-cards.ts) can name it without loading the phone's storage. utils/node-profile.ts
 * re-exports it, where every other screen reads it.
 */

import { DEFAULT_GLOBAL_COMMUNITY_URL } from '@beanpool/core';

/** The worldwide community's one address: core's named default (packages/beanpool-core/src/beanpool-defaults.ts). */
export const GLOBAL_NODE_URL = DEFAULT_GLOBAL_COMMUNITY_URL;
