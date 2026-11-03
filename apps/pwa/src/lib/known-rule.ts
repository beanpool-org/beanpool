/**
 * A known community's rule in the web app, read for the join step and the rules page (the words: @beanpool/core
 * known-rule.ts and community-shape-card.ts, the same as the phone's utils/known-rule.ts).
 */
import { readKnownRule, type KnownRule } from '@beanpool/core';
import { request } from './api';

/** The rule here, or null: an older node, a community that doesn't confirm its members, no answer. Never throws. */
export async function fetchKnownRule(): Promise<KnownRule | null> {
    return request<unknown>('GET', '/api/community/known-rule').then(readKnownRule).catch(() => null);
}
