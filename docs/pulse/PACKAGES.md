# The Pulse — work packages

Five packages, built concurrently, each in its own git worktree. **You were sent here to execute
one of them.** Find your package number below and do only that one.

**Before you write anything, read [`CONTRACTS.md`](./CONTRACTS.md) in full.** It holds the interface
contracts, the file-ownership map, the house conventions, the verification bar, and measured
platform facts you must not re-derive. If a package brief here disagrees with `CONTRACTS.md`, that
file wins.

Report into `docs/pulse/reports/<your-worktree>.md` — yours alone — and include it in your PR.

| # | Package | Worktree | Start |
|---|---|---|---|
| 01 | Profile chips | `pulse-profile-chips` | now |
| 02 | Resolver & cache | `pulse-resolver` | now |
| 03 | The feed UI | `pulse-feed-ui` | now |
| 04 | Manager vitest env | `manager-vitest-env` | now |
| 05 | Manual ingestion | `pulse-manual-ingest` | **after 02 merges** |

Package 02 is the only package permitted to touch schema or sync. Three packages need `pulse_items`;
one creates it. That single restriction is what makes the rest safe to run at the same time.

---

## Package 01 — Profile chips (closes Phase 1)

```
git worktree add -b feat/pulse-profile-chips .claude/worktrees/pulse-profile-chips origin/main
cd .claude/worktrees/pulse-profile-chips
pnpm install --frozen-lockfile
pnpm --filter @beanpool/core build && pnpm --filter @beanpool/engine build
```

Phase 1 shipped storage plus a management screen, and its PR claimed "channels render as link chips
on a profile". **That is not true**: `GET /api/members/:publicKey/channels` exists, returns the right
projection, and has no caller in `apps/native` or `apps/pwa`. Fix that.

The server is done. Do not modify `creator-channels.ts`, `routes/channels.ts`, or any schema. Read
`listPublicChannels` and `rowToPublicChannel` in `apps/server/src/engine/creator-channels.ts` to see
what the endpoint returns and what it deliberately withholds.

- Render a member's syndicated channels on their public profile as tappable link chips: platform
  icon, platform name, handle. Open the URL externally.
- A channel with `oauth_verified_at` set is verified — show that distinctly. A typed handle is only a
  **claim**; the UI must not imply the node has proven the member owns that account.
- No channels: render nothing. No empty state, no "add channels" prompt on someone else's profile.
- The platform vocabulary already exists in `apps/native/app/channels.tsx` (`PLATFORMS`,
  `LISTING_LABEL`, `categoryMeta`). **Reuse it** — extract to a shared module rather than
  duplicating, and say in your PR that you did. A second hardcoded copy of the platform list is the
  exact drift a reviewer already flagged once on this feature.
- Never fall back to `PLATFORMS[0]` for an unknown platform id. That rendered an unknown platform as
  "YouTube · updates itself" — a false autolist promise attached to the wrong name.

Chips must wrap rather than clip at 320dp and 1.3× font scale.

---

## Package 02 — Resolver & cache (Phase 2)

```
git worktree add -b feat/pulse-resolver .claude/worktrees/pulse-resolver origin/main
cd .claude/worktrees/pulse-resolver
pnpm install --frozen-lockfile
pnpm --filter @beanpool/core build && pnpm --filter @beanpool/engine build
```

You own the foundation, and you are the **only** package allowed to edit `schema.sql`, `db.ts`,
`engine/sync.ts`, `state-engine.ts` or `packages/beanpool-engine/*`. Implement **Contract A and
Contract B from `CONTRACTS.md` verbatim** — two other agents are coding against them right now. If
you believe a contract is wrong, build it as specified and say so in your report.

1. **The `pulse_items` table and its replication**, per Contract A. All four sync sites, both
   convergence checks. Read `apps/server/src/engine/creator-channels.ts` first — it is the pattern
   you are following, including the tombstone scrub.

2. **A resolver turning a channel into items.** Only two sources can be enumerated (see the measured
   platform reality in `CONTRACTS.md` — do not attempt the others):
   - YouTube channel RSS: `https://www.youtube.com/feeds/videos.xml?channel_id=UC...`
     `canAutolist()` in `creator-channels.ts` **already** decides which YouTube URL forms have a feed
     behind them. Reuse that judgement; do not re-implement it.
   - generic RSS/Atom for `website`/`rss` channels.

   Handle RSS 2.0 and Atom — they differ in date field, id field and link shape. Malformed feeds are
   normal: one bad feed must never throw out of the scheduler.

3. **SSRF hardening. This is the main security surface** — the node fetches member-supplied URLs.
   `assertPublicHostname()` in `creator-channels.ts` is a starting point and is **not** sufficient
   for a fetcher. You must also handle:
   - redirects: re-validate the host at **every** hop, not just the first URL
   - DNS rebinding: a host that validates, then resolves to `127.0.0.1` on the actual connection
   - a response size cap and a hard timeout — a feed must not exhaust memory or hang
   - content-type checking; refuse non-`http(s)` schemes

   `apps/manager` has a dev proxy SSRF filter already hardened against IPv6 and cloud-metadata
   bypasses — read it for the bypass classes known here.

   **Use a sub-agent as an adversarial reviewer of this logic specifically**: ask it to break your
   fetcher, fix what it finds, and report both what it found and what you changed.

4. **A fetch scheduler.** `fail_count`, `last_error` and `is_stale` already exist on
   `creator_channels` and are unused: back off a failing channel, mark it stale, surface the reason.
   The test node is 1 CPU / 1 GB and also serves live traffic — stagger the work, never fetch every
   channel at once, and never block the event loop in a long synchronous parse.

5. **The `og:description` post-count probe.** Instagram's `og:description` does serve a post count in
   plain HTML. Fetch it and store it against the existing `post_count_seen` column. It is a
   **watermark, not a backlog**. Build the read side only — package 05 turns it into a nudge.

6. **The 30-day pruner:** tombstone items older than 30 days. Never hard delete — a hard delete does
   not replicate, so a lagging backup would restore them.

7. **Contract B's** `GET /api/pulse/feed` and the mute endpoint.

**Verify.** New suite `test-pulse-resolver`, registered in `scripts/test-all.sh`, covering at
minimum: RSS 2.0 and Atom both parse; a malformed feed does not throw; dedupe by
`(channel_id, external_id)` holds; a deleted item leaves a tombstone with `url`/`title`/`thumbnail`
NULLed; a signed sync round-trip proves a restore cannot resurrect a deleted item; the feed endpoint
hides items from a suspended member and from a de-syndicated channel; every SSRF class above is
refused.

You are editing shared sync code and **can** break these — all must stay green:
`test-creator-channels`, `test-schema-upgrade`, `test-backup-topology`, `test-sync-signature`.

**In your PR, call out that `getStateHash` changed**: a backup and primary on different binaries will
see one canary mismatch and reconcile, so the backup is upgraded before or with its primary.

Do not build a feed UI, manual/clipboard ingestion, or OAuth. Other packages own those.

---

## Package 03 — The feed UI (Phase 3)

```
git worktree add -b feat/pulse-feed-ui .claude/worktrees/pulse-feed-ui origin/main
cd .claude/worktrees/pulse-feed-ui
pnpm install --frozen-lockfile
pnpm --filter @beanpool/core build && pnpm --filter @beanpool/engine build
```

**The endpoint you are consuming does not exist yet** — another agent is implementing it right now
against Contract B. Build against a local fixture so your work does not block on theirs.

**Create or edit no file under `apps/server` or `packages/`** — not even a stopgap endpoint.

- A feed of items ordered by `publishedAt` descending, paginated with Contract B's cursor.
- **Facade cards, not embeds.** Thumbnail, title, the member's callsign and avatar, platform and
  category. Tapping opens the post on its own platform, externally. Do **not** embed or proxy video
  playback: it breaches platform terms and the node has no rights to re-host the content.
- Make it obvious whose post it is and which platform it came from. This feed's value is "my
  neighbour made this", so the person matters as much as the content.
- A per-item mute via Contract B's mute endpoint. Only the item's **owner** can mute, so the control
  appears only on your own items.
- **Empty state:** this will be empty or near-empty at first — only YouTube/RSS channels produce items
  until package 05 ships. Write an empty state that is honest and useful rather than one implying
  something is broken.
- Pull to refresh. A failed load shows a message the member can act on, placed where they are
  looking — not at the top of a page they have scrolled past.

Read `apps/native/app/channels.tsx` first: it has the platform vocabulary, category labels, the
`readJson` helper, `signedPost` usage and the error conventions. **Reuse them.** If package 01 has
already extracted them to a shared module, use that; otherwise extract rather than duplicate, and say
so.

Renders at 320dp and 1.3× font scale; cards reflow and a long title must not push the layout
sideways — the page body must never scroll horizontally.

**State clearly in the PR that this is untested against the real endpoint** until package 02 merges.
Do not claim end-to-end verification you did not do.

---

## Package 04 — Manager vitest environment

```
git worktree add -b fix/manager-vitest-env .claude/worktrees/manager-vitest-env origin/main
cd .claude/worktrees/manager-vitest-env
pnpm install --frozen-lockfile
```

Unrelated to the Pulse, but `CONTRACTS.md`'s house conventions and verification bar still apply.

**The symptom.** `apps/manager/src/lib/ai-client.test.ts` fails locally with 9 errors — "Cannot read
properties of undefined (reading 'clear')" on `localStorage.clear()` — while the same commit is
**green in CI**. Every local `test-all.sh` therefore ends red, which trains everyone to ignore a red
result. That habit is the real cost.

**Already ruled out, do not re-check:**
- `apps/manager/vite.config.ts` **does** set `test.environment = 'jsdom'`.
- jsdom **is** in the lockfile and **is** installed. `.npmrc` sets `node-linker=hoisted`, so it lands
  in the **root** `node_modules`, not `apps/manager`'s — looking only in `apps/manager/node_modules`
  gives a false negative.
- The local run logs "localStorage is not available because --localstorage-file was not provided",
  which is **Node's own** experimental localStorage. So the run is in the node environment and the
  jsdom setting is not being applied locally.

**Diagnose it before changing anything.** Do not paper over it by stubbing `localStorage` in the test
or adding a setup shim that fakes the browser — that hides the real fault and lets a genuinely broken
environment pass.

Find why the config is not applied. Lines of enquiry, not conclusions: whether vitest resolves
`vite.config.ts` at all from this working directory; the vitest/vite version pairing; whether a
workspace or root config overrides it; whether the CI invocation differs (CI runs
`bash scripts/test-all.sh --all`).

Own `apps/manager` only. Nothing outside it.

**Verify:** `cd apps/manager && pnpm test` — all 86 tests pass. `bash scripts/test-all.sh` completes
with no failures. Explain the root cause in one paragraph in your PR. If you could not find it and
applied a workaround, **say so explicitly** and list what you ruled out.

---

## Package 05 — Manual ingestion (Phase 4)

**Prerequisite: `feat/pulse-resolver` must already be merged to `main`.** Branch from current main and
confirm `apps/server/src/engine/pulse-resolver.ts` and the `pulse_items` table exist. If they do not,
**stop and report that you were unblocked too early.**

```
git worktree add -b feat/pulse-manual-ingest .claude/worktrees/pulse-manual-ingest origin/main
cd .claude/worktrees/pulse-manual-ingest
pnpm install --frozen-lockfile
pnpm --filter @beanpool/core build && pnpm --filter @beanpool/engine build
```

**Not yours — do not edit:** `db/schema.sql`, `engine/sync.ts`, `state-engine.ts`,
`engine/pulse-resolver.ts`, `packages/beanpool-engine/*`. Call the resolver's exported functions. If
you need something it does not expose, record that in your report rather than reaching into it.

This is what makes the feed non-empty. Instagram and TikTok **cannot** be enumerated — settled, do
not try. Their posts arrive one at a time by the member's own action. Make that as close to
frictionless as a per-post action can be, and never nag.

1. **Submit one post.** The member pastes or shares a post URL, the node resolves what it can (TikTok
   oEmbed works server-side unauthenticated; a single Instagram **post** URL is resolvable even though
   a profile **list** is not) and stores an item.
   - **Ownership:** the item attaches to a channel **the signer owns**. Take the owner from
     `ctx.state.actor` and nothing else. A URL whose account matches none of the member's own channels
     is refused — otherwise anyone can attribute a post to a neighbour, the exact failure
     `creator-channels` was built to prevent.
   - Reuse `normaliseChannelInput`'s canonicalisation where it applies, and dedupe against existing
     items.

2. **The clipboard nudge.** If the clipboard holds a URL matching one of the member's own channels,
   offer to add it — **once per URL**. Never repeatedly, and never interrupting app boot.

3. **The post-count nudge**, from the `og:description` count the resolver already stores. Compare
   against `post_count_seen` and say "you've posted 2 new things", with a route to sharing them.
   - The watermark **advances on dismissal** as well as on action. A member with 700 posts and 10
     imported must **never** be told 690 remain. Only new posts since the last look are interesting.
   - It is a nudge, not a chore list. Ignored, it goes quiet.

4. **A review list with per-item opt-out** before anything publishes. Some members are happy to post
   to the world but more careful with their own community, so the default must be deliberate rather
   than automatic.

**Verify.** New suite registered in `scripts/test-all.sh` covering: a member cannot submit an item
onto another member's channel; a URL matching no owned channel is refused; the same post submitted
twice dedupes; the post-count watermark advances on dismissal. `test-pulse-resolver` and
`test-creator-channels` stay green.

Do not implement OAuth (Phase 5), scrape Instagram or TikTok profile pages, or use a third-party
scraper API.
