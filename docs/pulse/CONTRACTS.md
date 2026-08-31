# The Pulse — build contracts and coordination

**Read this file in full before writing code.** It is the single source of truth for the parallel
Pulse build. If a prompt you were given disagrees with this file, this file wins — say so in your
report rather than guessing.

Your package brief is in [`PACKAGES.md`](./PACKAGES.md) alongside this file.

Spec (the product intent, not the interfaces):
<https://gist.github.com/martyinspace/f982a03a3d38875828d940d5b6657d47>

---

## 1. Coordination protocol

Several agents build different Pulse packages **at the same time**, each in its own git worktree,
each opening its own PR to `main`.

### Read from here, report into your own file

| | |
|---|---|
| **This file** | Read-only for agents. Only the director edits it. |
| `docs/pulse/reports/<worktree>.md` | **Yours alone.** Create it, write your report into it, include it in your PR. |

Write **only** your own report file. Do not edit another package's report, and do not add yourself
to a shared status table — five agents editing the same table means four merge conflicts. Per-agent
files cannot collide, which is the whole point.

### Report template

```markdown
# <package name> — <worktree>

PR: #<number>
Status: complete | partial | blocked

## Built
<what exists now that did not before>

## Verified
<REAL pasted command output. Not a description of a result.>

## Not done
<explicit gaps, and why. A named gap is useful; a silent one is a trap.>

## Assumptions a reviewer must confirm

## Found but out of scope
<name it, do not fix it>
```

### File ownership — do not edit outside your package

| Package | Worktree | Owns |
|---|---|---|
| 01 Profile chips | `pulse-profile-chips` | `apps/native/app/public-profile.tsx`, new chip components, PWA profile view |
| 02 Resolver & cache | `pulse-resolver` | `engine/pulse-resolver.ts`, `routes/pulse.ts`, **and the shared plumbing**: `db/schema.sql`, `db/db.ts`, `engine/sync.ts`, `state-engine.ts`, `packages/beanpool-engine/{sync,audit}.ts` |
| 03 The feed UI | `pulse-feed-ui` | new feed screen + components under `apps/native/`. **No server files.** |
| 04 Manager vitest env | `manager-vitest-env` | `apps/manager/` test config only |
| 05 Manual ingestion | `pulse-manual-ingest` | new intake screen, `routes/pulse-submit.ts`. **Not** schema, sync, or `pulse-resolver.ts`. |

Package 02 is the only package permitted to touch schema or sync. If you need something it does not
expose, record that in your report — do not reach into its files.

---

## 2. Contract A — the `pulse_items` table

Owned by package 02. Packages 03 and 05 read it and must not alter it.

It follows the `creator_channels` precedent deliberately. Those replication rules were settled over
thirteen review rounds; they are not worth relitigating.

```sql
CREATE TABLE IF NOT EXISTS pulse_items (
    id             TEXT PRIMARY KEY,          -- 'item_' + 12 random bytes, hex
    channel_id     TEXT NOT NULL REFERENCES creator_channels(id),
    owner_pubkey   TEXT NOT NULL REFERENCES members(public_key),
    platform       TEXT NOT NULL,   -- copied at insert: survives the channel's tombstone
    external_id    TEXT,            -- platform's own id (YouTube video id, RSS guid); NULL if none
    url            TEXT,            -- canonical permalink. NULLed on delete
    title          TEXT,            -- NULLed on delete
    thumbnail_url  TEXT,            -- NULLed on delete
    published_at   DATETIME,        -- from the source. The feed orders by this, NOT created_at
    category       TEXT NOT NULL,   -- copied at insert, so recategorising a channel does not
                                    -- retro-relabel items already on the feed
    source         TEXT NOT NULL,   -- 'autolist' | 'manual'
    muted          INTEGER NOT NULL DEFAULT 0,
    created_at     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at     DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    deleted_at     DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pulse_items_dedupe
    ON pulse_items(channel_id, external_id) WHERE external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_items_feed
    ON pulse_items(published_at DESC) WHERE deleted_at IS NULL AND muted = 0;
CREATE INDEX IF NOT EXISTS idx_pulse_items_owner
    ON pulse_items(owner_pubkey) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pulse_items_updated ON pulse_items(updated_at);
```

### Non-negotiable rules

1. **Deleting an item does not preserve the item.** Set `deleted_at` and NULL `url`, `title` and
   `thumbnail_url` in the *same* statement, exactly as `deleteChannel` does. The row survives so the
   deletion replicates; the content must not travel with the tombstone. Write **one**
   `scrubPulseItems` helper — do not copy-paste the statement. Copy-paste drift across three call
   sites was a real review finding on `creator_channels`, and all three copies had already diverged.

2. **Register replication at all four sites.** Miss one and the table silently does not replicate:
   - `SyncPulseItem` type + payload field → `packages/beanpool-engine/src/sync.ts`
   - export mapper, watermarked on `updated_at` → same file
   - import handler + oversized-payload guard → `apps/server/src/engine/sync.ts`
   - `clearReplicatedTables()` → `apps/server/src/state-engine.ts`

3. **Add it to both convergence checks**, or a replication failure reports success:
   - live item ids into `getStateHash` (`packages/beanpool-engine/src/sync.ts`)
   - a row in `getReplicaConsistency`'s `tableDefs` (`packages/beanpool-engine/src/audit.ts`)

   Guard both reads in `try/catch` so a replica whose schema predates the table reports divergence
   rather than throwing. Hash **live** ids only (`deleted_at IS NULL`): that is what catches a
   tombstone which never applied, i.e. content a member deleted still published on the replica.

4. **`better-sqlite3` compiles on every `db.prepare()`.** Prepare above loops, never inside. The
   import path admits up to 250k rows inside one transaction.

5. **The feed is a 30-day window.** Items older than 30 days are *tombstoned* by the pruner, never
   hard deleted — a hard delete does not replicate, so a lagging backup would restore them.
   Back-catalogue importers are pointless by design. Do not build one.

---

## 3. Contract B — the feed read API

Package 02 implements it; package 03 consumes it. Frozen so 03 can build against a fixture before
02 lands.

```
GET /api/pulse/feed          (public read, unsigned)
  query: cursor?   = ISO published_at of the last item seen
         category? = community|food|craft|business|repair|art|other
         limit?    = 1..50, default 20
  200 -> {
    items: [{
      id, ownerPubkey, callsign, avatarUrl,     // presenter fields, joined from members
      platform, category, url, title, thumbnailUrl,
      publishedAt, source, isVerified           // isVerified = channel.oauth_verified_at is set
    }],
    nextCursor: string | null
  }
```

**Visibility — copy `listPublicChannels`' gating exactly.** An item is visible only when its channel
is not deleted and has `syndicate_to_node = 1`, the item is not deleted and `muted = 0`, **and**
`members.status = 'active'`. `actionReport` suspends a member and pauses their posts; their feed
items must go the same way, and this endpoint is unauthenticated.

```
POST /api/member/pulse/items/:id/mute     (signed; owner-scoped)
  body: { muted: boolean }
  200 -> { success: true, item: {...} }     403 NOT_YOURS     404 NOT_FOUND
```

`muted` must be a real boolean — reuse the `asBool` guard in `creator-channels.ts`. A JSON `1` is
rejected, not coerced. The owner comes from `ctx.state.actor` and **nothing else**: never read a
`publicKey` from the body, or anyone can mute a neighbour's items.

---

## 4. Measured platform reality — do not re-derive this

Three agents have already got this wrong from first principles. These are measured results.

- **"Resolve one item" and "list a person's items" are different capabilities.** Only YouTube
  channel RSS and generic RSS/Atom do both, unauthenticated.
- An **Instagram profile page** returns HTTP 200 and ~772KB of JavaScript with **zero post data** —
  the list is built client-side. A plain `fetch()` can therefore never list someone's posts. (A
  JS-rendering fetcher can, which is what made an earlier draft wrongly believe device-side import
  would work.)
- `instagram.com/api/v1/users/web_profile_info/` → stable **HTTP 400**, both public app IDs.
- Instagram `/embed/` also returns a JS shell — no caption server-side. So verifying handle
  ownership via a bio code is **impossible**; OAuth is the only proof of ownership.
- Instagram's **`og:description` does serve name + follower count + post count** in plain HTML. This
  is the design's key trick: it powers the "you've posted 2 new things" nudge with no API.
- **TikTok oEmbed** works server-side unauthenticated. TikTok **profile** pages are bot-challenged.
- Instagram OAuth requires a **Creator/Business** account. TikTok's OAuth has **no** account-type
  gate.

**Rejected — do not propose these:** WebView DOM scraping (breakage needs an app-store release, and
members are on standalone builds), node-side scraping of Instagram/TikTok profiles, third-party
scraper APIs.

---

## 5. House conventions reviewers enforce

- **Comments explain *why*.** This codebase carries dense reasoning in comments: the constraint that
  forced a decision, the bug a guard prevents. Match that density. A comment restating the code
  gets flagged.
- **Never `git add -A` blind.** Run `git status` and stage deliberately. A scratch file (`probe2.ts`)
  reached `main` that way and needed a later PR to remove.
- **`main` is protected and PR-only.** Always pass `--head` to `gh pr create` — the Bash cwd resets
  between calls and `gh` otherwise infers the wrong branch.
- **Verification:** `pnpm exec tsc --noEmit` clean in `apps/server` *and* `apps/native`; new server
  suites registered in `scripts/test-all.sh`; run the suites your change could plausibly break, not
  only your own. Paste real output.
- **Known pre-existing failure, not yours:** `apps/manager/src/lib/ai-client.test.ts` fails locally
  with 9 errors (vitest not applying `environment: 'jsdom'`, so `localStorage` is undefined). It
  fails identically on clean `main` and CI is green. Ignore it unless you are package 04.

### Client rules (native)

- Must render at **320dp** width and **1.3× font scale**. Use `flexGrow`/`flexBasis`, not fixed
  percentages.
- Keyboard avoidance: `KeyboardAvoidingView` from `react-native-keyboard-controller`
  (`behavior="padding"`, `keyboardVerticalOffset={64}`). RN's own is broken under Android
  edge-to-edge. `KeyboardProvider` is already at the root layout.
- `SafeAreaView` from `react-native-safe-area-context` — RN's is iOS-only.
- URL/handle inputs: `autoCapitalize="none" autoCorrect={false} spellCheck={false}
  keyboardType="url"`, and strip whitespace as it is typed. Android gesture typing inserts spaces
  regardless of `autoCorrect`.
- Errors appear **next to the control that failed**, not at the top of a page the member has
  scrolled past.
- **Off limits:** `GlobalHeader`, `logo.png`, `map.tsx`, `UnifiedMapPin`. Fragile, previously
  reverted, out of scope for every package here.
- A native change **cannot** be tested without a standalone rebuild. Never claim otherwise — say
  "needs a build to verify on device" and list what to check.

### Operational rules

- **Do not deploy.** Do not run `deploy.sh`. Deployment is handled outside your task.
- **`mullum` is a live community with real members.** Never test or deploy against it.
  `test.beanpool.org` is the only node with data that we use.
- Do not touch `apps/registrar` unless your package says so.

---

## 6. Sub-agents

You may fan out with your Task/Agent tool where work is genuinely parallel and independent. A fresh
sub-agent has **none** of this context — hand it the specific facts from this file that it needs.

Good: one sub-agent per feed-format parser; a dedicated adversarial reviewer for your own SSRF or
auth logic; a sub-agent to hunt for an existing helper before you write a new one.

Bad: splitting one file between two sub-agents; delegating the final integration or the report.
