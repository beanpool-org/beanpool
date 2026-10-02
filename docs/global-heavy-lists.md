# Global's heavy lists under concurrency: measurements and design

2026-10-02. Code: `origin/main` 20b415f (#1475 and #1484 in); main at 3c581fb changes only comments and tests on these
paths. A design pass with measurements. Nothing here changes the
server or the apps. Issue #1486 item 3; the load rehearsal's §8 item 2 ("page the directory on global, or don't send it
whole").

Everything ran on a Linux VM against loopback, inside a network namespace with only loopback up. No BeanPool node, the
registrar, Expo or any DNS was reachable. The scripts are in `scripts/load/` (§9).

## Summary

**The limit is answers in flight, not members.** Every heavy list is built whole in memory and kept until its last byte
leaves. For the 30,000-member directory (11.9 MB) that means about 57 MB per answer in flight:
- two copies of the body in the heap: one held by Koa's `ctx.body`, one by the socket's pending write;
- a native write buffer three times the body's size (Node sizes a string write at 3 bytes a character).

So the ceiling grows only in step with the heap, and a phone that reads slowly holds its share for as long as it takes.

**Measured with the server pinned to one core, about as fast as the droplet's is estimated to be:**

| Setup (30,000 members with photos) | Directory `GET /api/members` | Convenor's roster of a 30,000 group | Web app's directory `GET /api/community/members` |
|---|---|---|---|
| 256 MB heap | dies at 12 at once | dies at 8 | dies at 8 |
| 512 MB heap (deployed today) | dies at 24; p95 > 5 s from 12–16 | dies at 20–24; > 5 s from 16 | dies at 16; > 5 s from 8–12 |
| **1 GB droplet, 512 MB heap (RAM emulated)** | **killed by the kernel at 20–24** | **killed at 24–40** | not run |
| 900 MB heap / 2 GB droplet emulated | dies at 40; > 5 s from 20–24 | dies at 32–40; > 5 s from 16 | dies at 32–40 (heap only); > 5 s from 8–12 |

- **A bigger droplet buys survival, not service.** From 2 GB with a 900 MB heap, the death point moves from about 20 to
  about 40. But p95 passes 5 seconds at 16 to 24 at every heap: one directory build costs 0.3 to 0.45 s of the one core.
- **The web app's directory is the heaviest read.** It is 15.4 MB, takes 0.7 to 0.9 s, and needs 190 MB of heap for a
  single read, because it is built per reader. The People, Messages, Marketplace and Ledger pages each load it whenever
  they open.
- **Not heavy on global:**
  - the list of groups at the apps' 50 a page: 1.4 MB, survives 512 at once at every heap;
  - the crowdfund list: 404, because crowdfunds are off on global.

  The group list at the server's maximum of 200 a page is 5.5 MB while group pictures are inline. It dies at 32 to 256
  at once depending on the heap, and #1486 removes that.

**The fix that measured best: build each shared answer once and send the same bytes to everyone.** A per-version
snapshot of the directory, or of a roster view, held as one Buffer measured as follows (prototype, §5):
- 512 readers at once on the emulated 1 GB droplet: heap 76–93 MB, RSS under 300 MB, no death;
- p95 under 5 s up to 192 at once;
- 128 stalled readers: 244 MB RSS, all of them sharing the one buffer;
- byte-identical to main's answer.

**Recommendation** (§6):
- a cap on heavy builds first, so a burst can't kill the node;
- then shared snapshots (as Buffers, gzipped once) for the directory and rosters;
- then the web app off the per-reader directory;
- then paged directory and roster reads in new native builds, with the hourly whole-directory re-download stopped.

Old apps keep getting the whole list, served from the snapshot under the cap. After the snapshots, the 1 GB droplet with
the 512 MB heap is no longer the limit for these lists. The 2 GB resize stays Marty's call, for headroom and for
cloudflared (§8).

## 1. Setup and method

**Machine and server**
- VM: Linux 6.18, 4 vCPUs, 16 GB RAM, Node 22.22.0 (production's major), `better-sqlite3` built for it.
- Server: the real `apps/server/dist/index.js`, full boot, `NODE_PROFILE=global`. Each trial gets a fresh copy of the
  seeded data directory and a fresh boot. Reads go to the plain HTTP listener (what the tunnel reaches), with a distinct
  `CF-Connecting-IP` per reader.
- One core: the server is pinned with `taskset`, as on the droplet's one vCPU, so GC and libuv threads share the core
  with the event loop. One roster read takes 410–460 ms here against 135 ms on the M4 (#1484's review). So this core is
  about 3× slower than the M4, close to the load report's estimate for the droplet (2.5–3×).

**Network fence.** `scripts/load/fenced.sh` runs everything in a new network namespace with only loopback up. The driver
refuses to start unless a connect to a public address fails with `ENETUNREACH` and a name lookup fails.

**Data**
- 30,000 members plus the 2 system rows: 30,002 rows. Each member has a 20 KB JPEG, set through `updateProfile` (the
  profile route's writer).
- One open group of all 30,000. Member 0 is lead convenor and members 1–255 are co-convenors, so each concurrent roster
  read is a convenor's, which includes requests and invitations; all are active here.
- 200 more open groups, each with a 20 KB group picture.
- `state.db` is 869 MB. Every member's key is a real Ed25519 key derived from its index, so any member can sign.

**Bursts**
- A level is C signed GETs from C distinct members, sent together. Levels run 1, 2, 4, 8, 12, 16, 20, 24, 32, 40, 48,
  64, … until the server dies or the burst's p95 passes 20 s.
- Two fresh-boot trials per list and heap.
- Recorded: status, bytes and latency, plus the server's peaks:
  - V8 heap (an in-process 5 ms sampler, checked against `--trace-gc`);
  - native ArrayBuffer memory;
  - RSS high-water mark (`VmHWM`);
  - with a RAM cap, the cgroup's peak.

**Heaps and RAM**
- Heaps: `--max-old-space-size` 256, 512 and 900. V8 reports limits of 304, 560 and 948 MB, which include the young
  generation.
- Droplet RAM is emulated with a memory cgroup of 750 MB (1 GB droplet) or 1,750 MB (2 GB droplet). These are estimates
  of what is left for the node after the kernel, dockerd, containerd and cloudflared. Check them on the droplet with
  `free -m` and `docker stats`. The cgroup counts page cache too, as the droplet's RAM does.

Memory figures are MiB, written MB. Response sizes are bytes as sent.

## 2. Measurements

### 2.1 One read of each list (fresh boot, one core)

| List | Route (as the apps call it) | Answer | Time | Heap peak | RSS |
|---|---|---|---|---|---|
| Directory | `GET /api/members` | 11.9 MB (every member) | 365–443 ms | 92 MB | 270 MB |
| Web app's directory | `GET /api/community/members` | 15.4 MB | 714–930 ms | 185–191 MB | 371–380 MB |
| Convenor's roster | `GET /api/groups/:id/members` | 12.1 MB (30,000 rows) | 407–464 ms | 96–102 MB | 261–280 MB |
| List of groups | `GET /api/groups` (50 a page, the default) | 1.4 MB | 26–44 ms | 46–49 MB | 189–199 MB |
| List of groups, most | `GET /api/groups?limit=200` | 5.5 MB | 68–115 ms | 58–61 MB | 203–222 MB |
| Crowdfund list | `GET /api/crowdfund/projects?limit=1000` | 404 (crowdfunds are off on global) | 6–8 ms | 42–44 MB | 188–199 MB |

The idle node after boot: 42–48 MB heap and 160–200 MB RSS. The group list's size is almost all group pictures, which
still go out inline (`avatar_url` as stored). #1486 turns them into URLs. Without them, 200 groups are about 0.1 MB.

### 2.2 Concurrency ceilings by heap (one core, no RAM cap; trial 1 / trial 2)

"Survived" is the largest burst that all got 200. Every death in this table is V8's `FATAL ERROR: Reached heap limit`.

| List | Heap | Survived | Died at | p95 first > 5 s | At the largest survived burst: heap / native / RSS |
|---|---|---|---|---|---|
| Directory | 256 | 8 / 8 | 12 / 12 | not before death | 222–255 / 273 / 485–488 MB |
| Directory | 512 | 20 / 20 | 24 / 24 | 12 / 16 | 458–496 / 478–683 / 800–873 MB |
| Directory | 900 | 32 / 32 | 40 / 40 | 20 / 24 | 533–805 / 546–1,058 / 909–1,371 MB |
| Web app's directory | 256 | 4 / 4 | 8 / 8 | not before death | 191–208 / 177 / 528–530 MB |
| Web app's directory | 512 | 12 / 12 | 16 / 16 | 12 / 8 | 397–425 / 265–529 / 693–829 MB |
| Web app's directory | 900 | 32 / 24 | 40 / 32 | 12 / 8 | 746–856 / 397–1,058 / 998–1,381 MB |
| Convenor's roster | 256 | 4 / 4 | 8 / 8 | not before death | 182–185 / 139 / 405–413 MB |
| Convenor's roster | 512 | 20 / 16 | 24 / 20 | 16 / 16 | 425–482 / 243–521 / 649–819 MB |
| Convenor's roster | 900 | 32 / 32 | 40 / 40 | 16 / 16 | 586–707 / 243 / 927–989 MB |
| Groups, 50 a page | 256, 512, 900 | 512 (every trial) | never | 512 (5 of 6 trials) | ≤ 78 / 0.5 / ≤ 219 MB |
| Groups, 200 a page | 256 | 24 / 32 | 32 / 48 | not before death | 234–244 / 220–282 / 475–479 MB |
| Groups, 200 a page | 512 | 48 / 96 | 64 / 128 | not before death | 440–455 / 565–580 / 774–796 MB |
| Groups, 200 a page | 900 | 192 / 128 | 256 / 192 | 128 / 128 | 791–859 / 988–1,161 / 1,258–1,695 MB |
| Crowdfund (404) | 256, 512, 900 | 512 (every trial) | never | never (p95 ≤ 0.75 s at 512) | ≤ 56 / 0.2 / ≤ 199 MB |

An unpinned run (all 4 cores) of the directory at 256 MB also died at 12. So pinning is not why these ceilings sit below
#1484's Mac figures, where the directory died at 24 and rosters at 16. Its summary doesn't say which listener, which
Node or how simultaneous its bursts were, so I can't tell which of those differs. The cause and the slope are the same.

### 2.3 On the droplets' RAM (emulated with a memory cgroup)

| Droplet | Heap | Directory | Convenor's roster |
|---|---|---|---|
| 1 GB (750 MB for the node) | 256 | dies at 12 (heap limit); survived 8 | dies at 8 (heap limit); survived 4 |
| **1 GB (750 MB)** | **512 (today)** | **killed by the kernel (SIGKILL) at 20 / 24**; survived 16 / 20, p95 4.3 / 5.6 s | **killed by the kernel at 24 / 40**; survived 20 / 32, p95 8.3 / 13.9 s; p95 > 5 s from 12 / 16 |
| 2 GB (1,750 MB) | 900 | dies at 40 / 40 (heap limit); p95 > 5 s from 24 / 20 | dies at 32 / 32 (heap limit); p95 > 5 s from 16 / 16 |

On today's deploy, RAM runs out before V8's limit. The native write buffers (§3) aren't in the heap, so
`--max-old-space-size` doesn't bound them. With 900 MB on 2 GB, the heap limit comes first, at about the same burst
sizes as without a RAM cap.

### 2.4 Slow readers: what an undrained answer holds (directory, 512 MB heap)

Each reader stopped reading after the first bytes for 20 s. Memory half-way through:

| Readers holding | Heap | Native buffers | RSS |
|---|---|---|---|
| 1 | 63 MB | 34 MB | 212 MB |
| 4 | 132 MB | 137 MB | 401 MB |
| 8 | 250 MB | 273 MB | 555 MB |
| 16 | 432 MB | 546 MB | 842 MB |
| 24 | died (heap limit) | | |

That is about 24 MB of heap and 34 MB of native memory per undrained answer. A phone on a slow connection holds its
answer for the whole download: 11.9 MB at 2 Mbit/s is about 50 s. So the number in flight is the arrival rate times the
transfer time, and it can be far above the number being built at that moment.

Behind the tunnel, cloudflared (a child of the server, in the same container) reads from the node over loopback. How
much of a slow phone's wait it and Cloudflare's edge absorb, and at what memory cost to cloudflared, isn't measured
(§8). A node that phones reach directly, such as a local community on its LAN, holds it all itself.

## 3. Where the memory goes

### 3.1 Building one answer (`scripts/load/heavy-lists-anatomy.mjs`)

Each stage is built as the route builds it, with the server's own functions. The heap it keeps is measured after a full
GC, on one core.

| Stage | Directory (30,002 rows) | Convenor's roster (30,000 rows) |
|---|---|---|
| SQLite rows (`.all()`, one object a row) | 19.8 MB, 67 ms | 24.0 MB, 106 ms |
| The answer's objects (the route's map, with each photo's keyed URL) | 10.3 MB, 103 ms | 10.3 MB, 102 ms |
| `JSON.stringify` of the array: one string | 9.1 MB, 62 ms | 9.3 MB, 48 ms |
| That string as UTF-8 bytes (`Buffer.from`) | 11.4 MB native, 17 ms | 11.6 MB native, 13 ms |
| What the socket's string write reserves (3 bytes a character) | 34.1 MB native | 34.7 MB native |
| gzip level 6, once / Brotli quality 5, once | 2.2 MB in 135 ms / 2.1 MB in 303 ms | 2.1 MB in 136 ms / 2.0 MB in 287 ms |

Photo keys alone (an HMAC per row, `engine/avatar-keys.ts`) take 55–90 ms of a 30,000-row build. Unkeyed URLs take
about 4 ms.

The compressed sizes are from this seed, which repeats 16 photo versions and numbered names. Real keys, versions and
names are less repetitive. I'd expect 3–4× rather than 5×.

### 3.2 Allocation profile of one directory read in the running server

This is V8's sampling heap profiler, counting objects the GC has already freed. One `GET /api/members` allocates 69 MB
on the heap:

| Share | Where |
|---|---|
| 31% | SQLite row objects (`getMemberDirectoryRows`) |
| 23% | the answer's objects (the route's `map`) |
| 16% | photo keys (`keyFor`: an HMAC digest per row, as a string) |
| 16% | a second copy of the body in the socket write (`writevGeneric`) |
| 11% | `JSON.stringify` |

On top of that, outside the heap, the write's native buffer is 34 MB.

### 3.3 What keeps it

This is a heap snapshot taken while two readers hold their answers undrained. Each held answer keeps two 11.4 MB strings:
- the body, held by Koa's response (`ctx.body`, `response._body`) until the response ends;
- a second copy, held by the socket's pending write (`WriteWrap._chunks`, a concatenated string).

The 3× native buffer comes on top of both.

### 3.4 What that means

- **The answers in flight dominate. SQLite row materialisation is the largest piece while an answer is being built, but
  it is short-lived.** Each answer in flight costs about 2 × its body on the heap plus 3 × its body natively. The build
  needs about 70 MB of churn for the 30,000-row lists. That is why the ceilings rise in step with the heap: 8–12 at 256,
  20–24 at 512, 32–40 at 900.
- **A string body is the expensive form.** The same bytes sent as a Buffer are written without the 3× copy, and nothing
  makes the second heap copy. Measured in §5(d): sending a Buffer alone kept the heap at 90–120 MB however many were
  reading.
- **CPU is the second wall.** One build is 0.3 to 0.45 s of the core, and the web app's directory is 0.7 to 0.9 s.
  Twelve to twenty-four builds at once put p95 past 5 s, at 512 and 900 MB alike.
- **Socket buffers are why slow phones matter**, not why fast ones do. On loopback, the node holds bursts because the
  event loop is busy building the next answer while the last ones drain.

## 4. Who reads these lists, and how often (the apps today)

**Native, `GET /api/members` in full**
- Read when the local directory is empty (a new install's first sync, a restore) or older than an hour.
- Two paths: `services/pillar-sync.ts:527` and `utils/db.ts:3398` (`syncMessages`). They share one stamp
  (`kLastMembersSync`), so normally there is one full read an hour, and both can fire together when it expires.
- Otherwise the delta (`?updatedAfter=`), on every sync. Syncs run on socket open, on every socket message, every 5
  minutes in the foreground, and on background fetch.
- No `If-None-Match`; 30 s and 10 s timeouts.
- A non-200 is silent and sets no stamp, so the next sync reads in full again.
- A complete list deletes local members missing from it (`membersComplete`).

**Web app, `GET /api/community/members`** (the per-reader directory: bio, contact, last active)
- Read each time People, Messages, Marketplace or Ledger opens.
- No ETag.
- The web app is served by the node, so it updates with the node.

**Native, `GET /api/community/members`**: the invite sheet (`getInvitablePeople`).

**Rosters**
- Native `fetchGroupDetails` reads one when a group opens, after each action, when the group chat screen opens or its
  15 s poll shows a new system line, and on posts aimed at a group on every `sync_data_updated`.
- The web app's group modal reads one when it opens and after each action.
- Neither sends parameters.

**List of groups**
- Neither app sends `limit` or `offset`, so both get the server's default 50.
- So neither app's list shows more than the 50 most recently updated groups; a search (`q`) can still find others.
  This is a product gap of its own, outside this design.

**Crowdfund list**: native, every sync, with `?limit=1000`, which the server ignores. It is 404 on global.

**What the apps do with a refusal**
- No app reads `Retry-After` or treats 429 or 503 specially on these reads; Retry-After is read only in the join flows.
- Native sends `X-BeanPool-App: <version> <platform>`. The web app sends no version.

**Launch-day load**
- Every new member's first sync is a full directory read. So is every phone's hourly one.
- After a restart, every phone reconnects and syncs. A failed full read leaves no stamp, so a node that dies under a
  burst is met by the same burst again. That is the crash loop of the load report, now from concurrency instead of
  photos.
- Bandwidth: 11.9 MB per full read is about 12 MB per active phone per hour through the tunnel, uncompressed.

## 5. The options, measured

Each option was measured with a prototype patched into the local build (`scripts/load/heavy-lists-prototypes.mjs`,
measurement only, never committed to `apps/`). Every prototype that sends the directory whole hashed the same as main's
answer, and the roster snapshot the same as main's roster. Unless
noted, the setup is the emulated 1 GB droplet (750 MB), one core, and the directory.

### (a) Paged reads (cursor + limit)

**Measured.** One 500-row page by rowid keyset:
- 197 KB in 20 ms;
- 512 page reads at once: p95 1.9 s, heap 49 MB, RSS 177 MB (256 MB heap);
- a whole directory by pages costs about the same CPU as one full read (60 pages × about 3.5 ms), but spread out and
  interleaved with everything else.

**Ceiling.** About 1 MB per page in flight. CPU allows about 250 page reads a second per core.

**Work**
- Server:
  - `?after=&limit=` on `/api/members`, beside the existing delta;
  - a keyset on (role rank, joined_at, rowid) for rosters;
  - search and pages for the web app's directory.
- Core: the page shape, `{ items, next }`.
- Native:
  - the full-directory path loops pages into SQLite and sets `membersComplete` only after the last page;
  - the roster's `ScrollView` becomes a `FlatList` that loads more;
  - the invite sheet searches on the server.
- Web app: People and the group modal page or search on the server.

**Old apps don't page.** Never give them a first page as if it were the whole list. Native treats a complete list as
complete and deletes every member missing from it, so a silently truncated list would empty phones' directories. An old
app gets the whole list, or a refusal it ignores and retries.

**Risk: medium.** Native sync's completeness rules are delicate, and it needs a store release. A long paged read sees
writes between pages; the deltas already cover that.

### (b) Streaming the JSON instead of building it

**Measured.** 1,000-row keyset chunks with backpressure, the same bytes:
- 128 readers at once: heap flat at 49 MB, RSS 179 MB;
- 64 stalled readers: RSS 216 MB, native 49 MB;
- CPU unchanged: p95 passed 5 s at 32 at once, and 21 s at 128.

**Ceiling.** Memory stops being the limit; CPU remains (16–30 builds at once within 5 s).

**Work.** Server only: a chunked generator for each list. It must yield to the event loop between chunks. The prototype
didn't, and its event-loop delay reached 10–17 s with 64–128 readers on loopback. Answers lose `Content-Length` and go chunked,
which both apps' `fetch` handle.

**Old apps.** The same bytes. Nothing to change.

**Risk: low to medium.** Each chunk is its own query, so a stream can see rows change under it. The CPU and the
bandwidth stay the same.

### (c) A server-side cap on concurrent heavy reads

**Measured.** At most 4 heavy answers in flight, counted from build to last byte. Others wait in a queue of 64 for up to
8 s, then get 503 with `Retry-After: 10`.
- Never died up to 256 at once.
- Heap at most 177 MB (256 MB heap) or 255 MB (512 MB heap); RSS at most 481 MB.
- From 64 at once, half or more were refused, and the served answers' p95 was 10–33 s.

**Ceiling.** Memory is bounded at about 4 × 57 MB plus one build, whatever arrives. Service is bounded by the CPU,
about 2–3 directory builds a second.

**What the apps show today**
- Native: nothing. The read fails silently, sets no stamp and retries at the next sync (5 minutes in the foreground).
  A new member's directory stays empty until then.
- Web app: the page's list stays empty or old (People catches the error as "offline").
- New builds should honour `Retry-After` and the web app should say "busy, try again in a moment". Neither is needed
  for the cap to protect the node.

**Work.** Server: one small module (a semaphore, a short queue, 503 with `Retry-After` and a `code`), around the heavy
routes. The queue's wait must stay under the apps' shortest timeout (10 s in `syncMessages`).

**Risk: low.** It is a safety net, not service: under a real burst most readers get "busy".

### (d) A shared answer (a cached snapshot)

**Measured.** One Buffer per list, version and query, rebuilt at most every 5 s and shared by every reader of that
version, on the emulated 1 GB droplet with a 512 MB heap:

| Readers at once | Directory: p95 / heap / RSS | Convenor's roster: p95 / heap / RSS |
|---|---|---|
| 32 | 0.9 s / 76 MB / 244 MB | 1.1 s / 92 MB / 273 MB |
| 128 | 2.4 s / 86 MB / 267 MB | 2.7 s / 83 MB / 273 MB |
| 192 | 4.1 s / 87 MB / 267 MB | 4.0 s / 92 MB / 277 MB |
| 512 | 11.1 s / 87 MB / 268 MB (no death) | 11.1 s / 86 MB / 300 MB (no death) |

- With 128 stalled readers (256 MB heap), memory was 44 MB heap and 232 MB RSS: every reader holds the same 11.5 MB
  buffer.
- At 512, time goes on moving 6 GB through loopback and on checking 512 signatures, not on building.
- A Buffer without the sharing (each reader its own; 512 MB heap, no RAM cap): the heap stayed at 90–120 MB up to 80
  at once. But native memory was 11.4 MB per answer in flight (RSS 957 MB at 64), and CPU was unchanged (p95 > 5 s from
  20). So the Buffer is necessary, and the sharing is what scales.

**Where it applies**
- `/api/members`: the answer is the same for every member. The `lat`/`lng` form is per reader and bypasses the snapshot.
- A roster: one snapshot per group and view (the convenor's, with requests and invitations; a member's, active only)
  and filters. The visibility checks (#828: invite-only is 404 to outsiders and 403 to invitees; a suspended convenor
  sees the member's view) run first, and only then is the view chosen. A roster snapshot is keyed on both the groups and
  the members versions, since a member's new name or photo changes a roster row too.
- The web app's directory is per reader: contacts follow each member's choice and the reader's friends and trade
  partners, and a reader's own last-active is exact. It can't be one shared answer as it is (slice 4).
- The list of groups is per reader (the reader's role and status in each group, invite-only groups they belong to) and
  small after #1486. It needs no snapshot.

**Freshness**
- A snapshot belongs to one members (or groups) version and is rebuilt at most every 5 s.
- Its ETag is its own version, so a 304 is never wrong.
- It works only if every write that changes a directory field moves the version. Today a full read rebuilds every
  time, so a write that doesn't would still show at once; with a snapshot it would wait for the next join.
- The three gaps #1467 found are fixed on main: node-role grants and revokes bump the version, and a vouch and
  `adminSetTier` broadcast `profile_updated`. I found no other gap. But nothing pins the rule, and a directory field
  written later without a broadcast would go stale.
- So pin the rule with a test, and rebuild any snapshot older than 60 s regardless.

**Members-only and moderation**
- The snapshot sits behind the read gate and each route's own checks. Only the part that is the same for every allowed
  reader is shared.
- A member the directory leaves out today (pruned) leaves the snapshot at its next rebuild, within 5 s. A member removed
  from a group leaves that group's roster snapshot the same way.
- It is never cacheable outside the node: faces' keys are members-only, so the answer stays `Cache-Control: private`.

**Compression.** Gzip the snapshot once and serve it to readers that send `Accept-Encoding: gzip`, as both apps' fetch
and browsers do. That is 2.2 MB instead of 11.9 (this seed; 3–4× on real data), for 135 ms once per version. It cuts the
tunnel's bytes and each socket's time by the same factor.

**CPU.** At most one build per list version per 5 s: under 10% of the core even with joins every second. A served read
costs its signature check and its write.

**Work.** Server only for the directory and rosters: one snapshot helper, and the test that pins the version rule. The web app's directory needs
app work (slice 4).

**Old apps.** The same bytes, and the ETag still works.

**Risk: low to medium.**
- Staleness if a version bump is missing. The 60 s ceiling bounds it.
- Memory for the snapshots: about 12 MB plus 2.5 MB gzipped per directory or big roster view. Hold rosters in an LRU
  with a byte budget (say 64 MB), so many big groups can't add up.

### Not an option on its own: a bigger droplet

From 2 GB with a 900 MB heap, the death point moves from about 20 to about 40 at once (§2.3). The p95 still passes 5 s
at 16 to 24, and slow phones still multiply what is held. It buys margin, not a fix.

## 6. Recommendation

**(c) + (d) now, (a) next, and not (b).**

1. **The cap (c) first.** It is what stops a burst from killing the node and the crash loop that follows, for every
   heavy read, including the ones that can't be shared (the web app's directory today, rosters' filtered views, the
   directory near a place). It is small and server-only.
2. **Shared snapshots (d) for the directory and rosters**, sent as Buffers and gzipped once. That is where the
   measurements say the ceiling goes away: 512 at once, RSS under 300 MB, on today's 1 GB droplet with its 512 MB heap.
   It needs no app change, so old apps benefit the day it ships.
3. **The web app off the per-reader directory.** The web app updates with the node, so this needs no compatibility
   window beyond a reload.
4. **Paging (a) in the next native build**, for the directory sync and big rosters, and the hourly whole-directory
   re-download replaced by pages and deltas. This is the long-term fix for bandwidth and for very large groups. Old apps
   keep the whole list from the snapshot under the cap.

**Not streaming (b).** Its memory gain is real, but (d) gives the same gain plus the CPU, and (a) bounds what's left.
Streaming would add per-chunk consistency and yielding for little more.

**Estimated ceilings after slices 1–3** (droplet ≈ this core):
- Directory and rosters: memory stops being the limit (measured: 512 at once). Builds are at most one per version per
  5 s. A served read then costs its signature check and its write: 512 uncompressed answers took about 11 s of the
  core, about 45 a second. That is a floor; gzipped answers move about a quarter of the bytes.
- Anything uncached sits under the cap. With 4 directory-sized answers, the measured worst was 255 MB of heap and 481 MB
  RSS. The web app's directory is heavier (15.4 MB, and a 190 MB build), so the cap should count weight, not answers
  (§7, slice 1).

**Settings.** With the cap and the snapshots, 512 MB of heap on the 1 GB droplet is enough for these lists. Keep heap
plus native in flight under the RAM: with a cap of K, native is at most K × 3 × the largest body until every heavy
answer is a Buffer. The 2 GB resize with `--max-old-space-size=900` stays the safer launch choice, for cloudflared and
the rest of the load report's findings, and is Marty's call.

## 7. Slices (one PR each, in order)

1. **Server: a heavy-read cap.**
   - A module that admits heavy answers while their weight in flight (build to last byte) stays under a budget, queues
     briefly (under 8 s), then answers 503 with `Retry-After` and `code: heavy_read_busy`. One log line a minute while
     it refuses.
   - The weight is each route's last answer size, so the web app's directory counts more than a roster. A budget of
     about four directories fits the 1 GB droplet.
   - Wired into the full `/api/members`, `/api/community/members`, `/api/groups/:id/members` and `/api/groups` above 50
     a page.
   - Fail-first suite: 30,000 members with photos, a 256 MB heap, 64 directory reads at once. On main the server dies;
     with the cap it answers 200 or 503 and lives.
2. **Server: the directory snapshot.**
   - A test that every write to a directory field moves the members version.
   - One Buffer per version (5 s floor, 60 s ceiling), with a gzip variant served on `Accept-Encoding`; the ETag
     from the snapshot; `lat`/`lng` and the delta bypass it.
   - Suite: byte-identical to an unshared build for full, delta and `lat`/`lng`; the read gate unchanged; a pruned
     member gone after the rebuild; 512 at once under a 256 MB heap survive.
3. **Server: roster snapshots.**
   - Per group, view and filters, the same mechanics, in an LRU with a byte budget.
   - Suite: the #828 rules (invite-only is 404 to outsiders and 403 to invitees, the convenor's view against a member's,
     a suspended convenor gets the member's view); a removal shows within the rebuild window.
4. **Web app and server: the web app's directory.**
   - People, Messages, Marketplace and Ledger read the shared directory (slice 2). Contact details come from the
     profile route, which already applies `contactVisibleTo`.
   - Server: `/api/community/members` gets search and pages for the native invite sheet. It stays under the cap for old
     clients.
5. **Native and server: paged directory sync and rosters.**
   - Directory: `?after=&limit=` by rowid, `membersComplete` only after the last page, and `If-None-Match` on the full
     read.
   - Native: one full-read path instead of two; the group detail's roster as a paged list; `Retry-After` honoured on
     these reads.
   - Old builds keep the whole list.
6. **Later: removals as tombstones in the delta**, so the hourly full read can stop entirely (load report §8 item 2).

#1486's own items (the crowdfund list and group pictures as URLs) are separate and in flight. None of these slices
touches those files.

## 8. What this can't tell us

- **The droplet's own speed.** This core is about 3× slower than the M4, close to the estimate. Not measured: shared-vCPU
  steal, and network block storage under SQLite.
- **What RAM is left for the node.** 750 MB and 1,750 MB are estimates; check with `free -m` and `docker stats`.
- **cloudflared.** It is the server's child in the same container. Its memory while relaying 12 MB answers to slow
  phones, and how much of a slow phone's wait the edge absorbs, aren't measured.
- **Real data.** The seeded members have no bios or contact details, so the web app's directory will be larger on real
  data. Gzip ratios will be lower than on this seed.
- **Arrival rates.** Burst sizes here are how many read at once. How many phones that is on launch day depends on build
  and transfer times, modelled in §2.4 and §4, not observed.
- **Group count.** There was one 30,000-member group. Many big groups multiply roster snapshots (the LRU's budget) and
  roster reads.
- **Duration.** Each trial ran minutes, not hours.

## 9. Re-running

Build core, signin, engine and server, then copy the schema next to the build as the Dockerfile does:

```sh
pnpm install --frozen-lockfile
(cd packages/beanpool-core && pnpm run build) && (cd packages/beanpool-signin && pnpm run build)
(cd packages/beanpool-engine && pnpm run build) && (cd apps/server && pnpm run build)
cp apps/server/src/db/schema.sql apps/server/dist/db/schema.sql
```

Seed once (about 50 s and 870 MB):

```sh
mkdir -p /tmp/hl/tpl
(cd apps/server && BEANPOOL_DATA_DIR=/tmp/hl/tpl TMPDIR=/tmp/hl/tpl NODE_PROFILE=global \
  ../../scripts/load/fenced.sh node ../../scripts/load/heavy-lists-seed.mjs '{"n":30000,"groups":200}')
```

Ramp one list on one heap, two fresh-boot trials, the server pinned to core 1, optionally under a RAM cap. Linux, as
root for the cgroup:

```sh
scripts/load/fenced.sh node scripts/load/heavy-lists.mjs --template /tmp/hl/tpl --work /tmp/hl/work \
  --heap 512 --list members --trials 2 --cpu 1 --stop-p95 20000 [--mem-limit 750] [--hold 20000] --out results.jsonl
```

- Lists: `members`, `community`, `roster`, `groups`, `groups200`, and `crowdfund` (with `--expect 404` on global).
- `--profile DIR` writes the allocation profile and the held-answers heap snapshot (§3.2, §3.3).
- `scripts/load/heavy-lists-anatomy.mjs` gives §3.1.
- For §5, run `node scripts/load/heavy-lists-prototypes.mjs` (it patches only the git-ignored `dist`), then set
  `LOAD_PROTO=buffer|cache|cap|stream|page` on the driver's command, with `--expect 200,503` for `cap` and
  `--list page500` for `page`. `pnpm run build` in `apps/server` restores `dist`.
