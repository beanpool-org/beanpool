# Recorded GitHub answers for pr-state.test.mjs

Captured on 15 Nov 2026 with read-only `gh api` calls, in the shape `scripts/lanes/pr-state.mjs` asks for them
(`--paginate --slurp`, so each list file is an array of pages).

| File | What GitHub answered |
|---|---|
| `check-runs-33a37470.json` | #3169's check runs on head 33a37470: two reds, `Test-All shard checks` and the summary job. |
| `check-runs-5550edf6.json` | #3169 on head 5550edf6: three reds, `Test-All shard vitest-pwa-1`, `Test-All shard checks` and the summary job. |
| `check-runs-a8738323.json` | #3169 on head a8738323: all 19 green. |
| `comments-3169.json` | #3169's issue comments: NOT CLEAN of 5550edf6, then CLEAN of 33a37470. |
| `reviews-3169.json`, `commits-3169.json`, `files-3169.json` | #3169's reviews (inline only, empty bodies), its 10 commits, and its diff's files at its last head. |
| `status-none.json` | The commit status of a head with none: GitHub says `"state": "pending"` with `total_count: 0`. |
| `logs/132569745348.log`, `logs/132571592359.log` | Head 33a37470: the `checks` shard (no_google_fonts red) and the summary job (`Shards: failure`). |
| `logs/132551473408.log`, `logs/132551473386.log`, `logs/132555697041.log` | Head 5550edf6: the `vitest-pwa-1` shard (EnterpriseNotAProfile.test.tsx), the `checks` shard, the summary job. |
| `logs/132543380716.log` | Another PR's `server-1` shard: a server suite's ✗ line and stack. |
| `logs/132555659030.log` | Another PR's `web-pwa` shard: an esbuild error naming a source file. |

The only edits: the trimmed fields listed in each JSON file are all that was kept; comment and review authors are
`reviewer`; and each shard log's setup steps (checkout, install, build) are cut, where one marked line says which lines
went. Everything from test-all's start to the job's end is byte for byte what GitHub served.
