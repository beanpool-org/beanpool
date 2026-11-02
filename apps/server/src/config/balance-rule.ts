/**
 * When the rule on what the admins can see starts here (scratch/fable-design/DESIGN-balance-rule-fable.md §3): node_config
 * `balance_rule_from`, written once, at the first boot of a main server on a version with the rule (db.ts
 * stampBalanceRuleFrom), as that moment plus the notice. A take-over brings its main server's (config/community-settings.ts).
 *
 * No imports, so db.ts and the community's settings can both read it.
 */
export const BALANCE_RULE_FROM_KEY = 'balance_rule_from';

/** The notice, in days, before the rule reaches members already confirmed, and before a tightened line applies (Q-A, Q-E). */
export const RULE_NOTICE_DAYS = 14;
export const RULE_NOTICE_MS = RULE_NOTICE_DAYS * 86_400_000;

/**
 * The stamp's time in ms, or null for anything but the exact form the boot writes. Date.parse alone would read "0" as the
 * year 2000, and so start the rule for everyone: a stamp this can't read must fail closed.
 */
export function readRuleInstant(value: unknown): number | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}
