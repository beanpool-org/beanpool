/**
 * A known community's rule on this phone, read for the join screen and the rules page (the words: @beanpool/core
 * known-rule.ts and community-shape-card.ts, the same on the web app).
 */

import { readKnownRule, type KnownRule } from '@beanpool/core';

export const KNOWN_RULE_TIMEOUT_MS = 8_000;

/** The rule at `url`, or null: an older node, a community that doesn't confirm its members, no answer. Never throws. */
export async function fetchKnownRule(url: string, timeoutMs: number = KNOWN_RULE_TIMEOUT_MS): Promise<KnownRule | null> {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), timeoutMs);
    try {
        const res = await fetch(`${url.replace(/\/+$/, '')}/api/community/known-rule`, { signal: stop.signal });
        return res.ok ? readKnownRule(await res.json().catch(() => null)) : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}
