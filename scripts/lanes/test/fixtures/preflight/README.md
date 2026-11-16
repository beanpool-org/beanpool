# preflight fixtures

`big-merges.json`: three real merges on main whose changed server suites made the draft check's tests part plan past
ci.yml's `PREFLIGHT_HARD_SECS` (1200 s) before it had a budget (#3280's review, 17 Nov 2026; main's last 600 merges
replayed: #3054 4850 s, #3055 5451 s, #3033 7535 s). `scripts/lanes/preflight.test.mjs` holds every draft part to its
budget on them.

For each merge (`<sha> #<PR>`): `files`, every path `git diff -U0 <sha>^1 <sha>` touches; `route` and `table`, the paths
whose touched lines match preflight-plan.mjs's `ROUTE_LINE` / `ROUTER_LINE` and `TABLE_LINE`. The lines themselves are
not kept: the planner reads only the paths and whether those rules match, so the test rebuilds each file as one matching
line. To make it again, for each sha: parse the diff with `parseDiff`, then keep the sorted paths and the two filtered lists.
