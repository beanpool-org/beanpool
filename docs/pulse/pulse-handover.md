# Pulse build — handover

**Written 2026-08-31.** This exists so the build keeps moving when the director agent is out of
quota. Deploy steps are deliberately absent: this file is public, and no agent deploys. It is for Marty and for any agent picking up the work. Read [`CONTRACTS.md`](./CONTRACTS.md)
for the interfaces and [`PACKAGES.md`](./PACKAGES.md) for the package briefs.

---

## 1. Where the build is

| Phase | State |
|---|---|
| **Phase 1** — channels on the profile, chips visible to others | **Merged** (#530, #540, #541, #546) |
| **Phase 2** — resolver, cache, feed API | **Merged** (#547) |
| **Phase 3** — the feed UI | PR **#549**, green, **review not yet resolved** |
| **Phase 4** — manual ingestion | PR **#550**, green, **review not yet resolved** |
| **Phase 5** | Spec only, in the gist. **Not written up as a package yet.** |
| Platform OAuth verification | Referenced as "package 06" in #547's report. **No brief exists.** |

Also merged along the way: #545 (manager vitest env), #548 (agent finishing rules).

**Nothing is deployed.** `main` is ahead of every node. Deployment is a human step and is
deliberately not documented here — see the private runbook. No agent deploys, ever.

### What is real vs. what is only tested

- The resolver has **never run against a live feed.** Its 109 tests prove the parsers and the SSRF
  guard work on fixtures. A real YouTube or RSS fetch end-to-end is unverified.
- The chips have **no on-device verification.** They change what strangers see on a profile.
  A standalone build is needed — a dev client will not exercise it.
- Instagram and TikTok produce **no items** without OAuth. Only YouTube and RSS populate the feed
  until that lands, so the feed will look near-empty at first. That is expected, not a bug.

---

## 2. Resolving a code review — dispatch this to an agent

This is the loop that used to need the director. It does not. Hand this to an agent, replacing
`<PR>` with the number:

```
You are resolving code review on PR #<PR> in /Users/marty/projects/beanpool.

Read docs/pulse/CONTRACTS.md and docs/pulse/HANDOVER.md first.

1. Fetch every inline review comment:
     gh api repos/beanpool-org/beanpool/pulls/<PR>/comments --paginate \
       --jq '.[] | "=== [\(.id)] \(.path):\(.line // .original_line) ===\n\(.body)\n"'

2. For EACH comment, decide and act — do not batch-accept:
   - Verify the claim against the code before fixing. Reviews are sometimes wrong about
     where a bound applies, or describe intent rather than what the code does.
   - If it is real, fix it properly. If the suggested fix is worse than an alternative,
     implement the better one and say why in your reply.
   - If it is NOT real, say so with evidence. A wrong finding you "fix" makes the code worse.
   - Look for the adjacent bug the reviewer missed. Nearly every finding so far has had one.

3. Reply to each thread:
     gh api repos/beanpool-org/beanpool/pulls/<PR>/comments/<COMMENT_ID>/replies -f body='...'
   State what you changed, or why you did not.

4. Add regression tests for anything that was actually broken. A fix with no test will regress.

5. Run the full suite and paste the real output:
     bash scripts/test-all.sh --all
   Background it if it is slow; do not report a result you did not see.

6. Append a "Review round" section to your report in docs/pulse/reports/, correcting any
   claim in it the review proved wrong. That file lands on main as the record.

7. Commit, push to the PR branch, and confirm CI is green on the NEW head sha:
     gh pr view <PR> --json headRefOid --jq .headRefOid
     gh api repos/beanpool-org/beanpool/commits/<SHA>/check-runs \
       --jq '.check_runs[] | "\(.name): \(.conclusion // .status)"'

Do NOT merge, and do NOT deploy. Report the PR link and a one-line verdict per finding.
```

### Things reviews have got wrong before

Worth knowing so an agent does not "fix" a non-bug:

- A review claimed truncation happened at a line the code `return`ed before reaching. The real
  bug was that *no* bound existed on that path.
- A review described an index as covering `category` when the DDL never did — it was reading the
  report, not the schema.
- Reviews have missed the NULL case twice (`NULL < cursor` is NULL, not false).

---

## 3. Merging without the director

Preconditions, in order. Do not skip the sha check — CI can be green on a *stale* commit:

```bash
gh pr view <PR> --json headRefOid --jq .headRefOid          # note the sha
gh api repos/beanpool-org/beanpool/commits/<SHA>/check-runs \
  --jq '.check_runs[] | "\(.name): \(.conclusion // .status)"'  # must be success
```

Then:

```bash
gh pr merge <PR> --squash --admin
```

`--admin` is required: `main` has rulesets (review + code-owner + copilot + test-all) that a
self-authored PR cannot satisfy. Do **not** pass `--delete-branch` — branches may be checked out
in another agent's worktree.

**Merge one at a time, not as a batch.** Simultaneous merges race the ghcr `:latest` tag and the
last build to *finish* wins, so a deploy can silently ship an older commit. After merging, confirm
which build actually won:

```bash
gh run list --branch main --limit 4 \
  --json displayTitle,status,conclusion,headSha \
  --jq '.[] | "\(.status)/\(.conclusion // "-")  \(.headSha[0:7])  \(.displayTitle)"'
```

---

## 4. What to dispatch next, in order

1. **Resolve review on #549** (feed UI) — section 2 above. 14 comments.
2. **Resolve review on #550** (manual ingestion) — section 2 above. 17 comments.
3. **Merge both**, one at a time — section 3.
4. **Deploy to the test node** — Marty or the director only, never an agent. Then the feed
   is real for the first time.
5. **Marty:** standalone app build, and check the chips and the feed on device.

After that the Pulse is Phases 1–4 complete and running. Phase 5 and OAuth verification both need
a brief written before they can be dispatched — neither exists yet, and neither should be handed to
an agent as a vague instruction.

### Standing rules for every agent

- Read `CONTRACTS.md` in full first. It wins over any prompt that disagrees with it.
- Report into `docs/pulse/reports/<your-worktree>.md` — yours alone.
- You are not done until it is committed, pushed, and a PR is open. See CONTRACTS.md "Finishing".
- Never merge your own PR. Never deploy.
- Off-limits in any refactor: `GlobalHeader`, `logo.png`, `map.tsx`, `UnifiedMapPin`.
- Do not re-propose these; they are settled and rejected: WebView DOM scraping, node-side scraping
  of Instagram or TikTok profiles, third-party scraper APIs, and embedding or proxying video
  playback.
