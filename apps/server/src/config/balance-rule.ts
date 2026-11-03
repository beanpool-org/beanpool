/**
 * That the rule on what the admins can see has started here: node_config `balance_rule_from`, written once, at the first
 * boot of a main server on a version with the rule (db.ts stampBalanceRuleFrom), as that moment. The rule starts at once
 * (Marty, 3 Nov: nobody trades on a node yet, so a start notice would be redundant); what the stamp still does is fail
 * closed: a node with no readable stamp lists nobody. A stamp from the days of a 14-day start notice holds a time in the
 * future; it is read as started now, and nothing rewrites it. A take-over brings its main server's
 * (config/community-settings.ts).
 *
 * No imports, so db.ts and the community's settings can both read it.
 */
export const BALANCE_RULE_FROM_KEY = 'balance_rule_from';

/** The notice, in days, before a tightened line applies (Q-E); a loosened one applies at once. The rule itself has no notice. */
export const LINE_NOTICE_DAYS = 14;
export const LINE_NOTICE_MS = LINE_NOTICE_DAYS * 86_400_000;

/**
 * The stamp's time in ms, or null for anything but the exact form the boot writes. Date.parse alone would read "0" as the
 * year 2000, and so start the rule for everyone: a stamp this can't read must fail closed.
 */
export function readRuleInstant(value: unknown): number | null {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}
