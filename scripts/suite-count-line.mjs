// suite-count-line.mjs — whether a server suite's log holds its closing count (scripts/run-server-suites.mjs, NO-COUNT).
// A module of its own so scripts/test-merge-gate.sh can test it without running the pool.

/** The closing count a suite prints when every check ran: `N/N passed`, `PASSED`, `All N … passed`. */
export const COUNT_LINE = /PASSED|[0-9]+ ?\/ ?[0-9]+[^0-9].*passed|passed.*[0-9]+ ?\/ ?[0-9]+|All [0-9]+ .*passed/;

/**
 * Whether one LINE of the log is a closing count, as test-all.sh's `grep -E` read it before the pool: tested over the whole
 * log, `[^0-9]` and `.*` cross a newline, so a line ending "1/2" followed by any line with "passed" counted (#1334
 * confirmation 3, finding 4).
 */
export function hasCountLine(log) {
    return String(log).split('\n').some((line) => COUNT_LINE.test(line));
}
