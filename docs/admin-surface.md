# The Admin Surface — identity, auth, and retiring the fleet manager

> **Status: DESIGN, agreed in discussion. Not built.**
> Companion to [`the-commons.md`](./the-commons.md). That document designs authority *within* a
> community — enterprises, decisions, keepers. This one covers authority *over the machine*: who the
> owner and admins are, how they prove it, and where they do the work.
>
> The role model itself lives in [`the-commons.md` §9](./the-commons.md#9-roles--the-four-kinds-of-belonging)
> and is not repeated here. This is the implementation and migration plan.
>
> Written 2026-09-14 by Claude, from a verified read of `main` plus a fifth round of design argument
> with Antigravity ([transcript](./the-commons-discussion.md)).

---

## 1. The problem in one paragraph

There is no owner, and "admin" is two disconnected mechanisms that do not agree with each other: a
**shared, anonymous password** that gates every `/api/local/admin/*` route, and an **inferred
pubkey** (`getAdminPubkey()` = the first `invited_by='genesis'` row, no `ORDER BY`) that gates the
in-protocol override in about eight places. The password cannot tell you *which* admin acted — which
is the root of the audit-trail hole. The pubkey is probably returning the literal string `'SYSTEM'`
on every node, in which case that override has never fired at all. See
[`the-commons.md` §9.2](./the-commons.md#92-node-owner-and-admins) for the detail and the one-line
check.

Meanwhile the admin UI exists **twice**: a twelve-tab page served by the node at `/settings`
(`apps/server/static/settings.html` + `settings.js`), and a separate React fleet manager
(`apps/manager`) that duplicates most of it because Marty runs several nodes. He now calls the
multi-node case an edge case and wants one surface.

---

## 2. Authentication — attributable by default, break-glass by exception

### 2.1 The normal path

An admin proves who they are with **their own member key**, not a shared secret. Every admin action
then carries a real identity, which is what [`the-commons.md` §3.7](./the-commons.md)'s provenance
stamp and §3.8's *signed public halt* both require — **you cannot sign as a password.**

Key + TOTP 2FA, exactly as Marty proposed. The IP allowlist and CSRF protections already in front of
`/settings` stay as they are.

### 2.2 Break-glass, and why it does not reopen the hole

"Kill the shared password" was too strong, and the reason is boring and fatal: key-only auth locks
you out of your own node the day you lose your phone.

So the password survives — **restricted to a single capability.**

> **The break-glass credential can do exactly one thing: enrol a new admin key.**
> It cannot dismiss a report, change a setting, touch a balance, or moderate anything. It authorises
> a new device key and the session ends. The admin then signs in with that key, and everything from
> that point is attributable.

That is what stops break-glass from quietly reinstating the anonymity it was meant to replace: there
is no anonymous *session* to fall into, only an anonymous *re-pairing*. It is rate-limited, and using
it raises a loud, public, permanent entry in the system feed —
*"Break-glass recovery used to authorise a new admin key for @callsign."* An operator recovering their
own node sees a notice they expect; a community seeing that notice unexpectedly knows immediately.

### 2.3 The web handoff

The key is on the phone; `/settings` is a browser. One primitive serves both directions:

- **Phone → phone browser** (Marty's button): the app signs a challenge and opens the browser at
  `/settings` carrying a short-lived token.
- **Desktop** (unavoidable — logs, wide tables, JSON): the browser shows a QR containing the
  challenge, the app scans and signs it, the desktop session opens. The Signal/WhatsApp model.

Desktop cannot be dropped in favour of the button alone: a phone button cannot deep-link to a
monitor, and the heavy configuration work genuinely needs a keyboard.

**Session rules:**

| | |
|---|---|
| Handshake token | 60 seconds, single use, burned on exchange |
| Browser session | 2 hours idle, 12 hours hard maximum |
| Revocation | *"Revoke all web sessions"* in the app bumps the admin's `session_epoch`, invalidating every outstanding cookie instantly |

**Phone button — built 2026-09-19 (Marty approved the flow 2026-09-19).**

- *Who sees it:* Settings → "🛡️ Manage ‹community›" appears only when `GET /api/node-admin/me` (signed with
  the member key, answers only for the signer) says `owner` or `admin`. Nothing is cached on the phone. The
  node checks the live role again when it issues the token and again when the browser exchanges it, and a
  key session's role follows `node_roles` on every request.
- *Second factor:* the phone's own unlock (fingerprint, face or PIN) comes before the token is requested.
  A phone with no screen lock gets an explanation and no link: this fails closed, unlike app lock. The
  node's own TOTP, when turned on, is still asked for on top.
- *The link:* `/settings#handoff=<60 s single-use token>[&section=…]`, opened in Custom Tabs /
  SFSafariViewController. The token goes in the **fragment**, so it never reaches a server, proxy log or
  Referer. `/settings` wipes it from the address bar, then POSTs it once to `/api/local/admin/auth/exchange`.
- *Android app links* claim only `/` on node hosts (where `/?invite=` lives) and `/auth/*` on beanpool.org.
  That means `/settings`, `/app` and the website stay in the browser.
- *Web app (PWA):* shows the same owner/admin-only entry, as a plain link to `/settings`, which then asks
  for the password. The browser does not mint key links, because it has no equivalent of the phone unlock.
- *Admin queue:* `GET /api/node-admin/queue` (owner/admin, signed) returns counts only, each with its
  `/settings#section=` target, for the header's "needs you" badge.
- *Header 🛡️ icon (app):* owners/admins only, while the queue total is above 0. First in the needs-you
  priority (rightmost, last to fold into "•••"), amber accent, label in words ("2 reports to review").
  Tapping it is the Manage press (phone unlock → key sign-in link) landing at the first item's section.
  The app remembers the role in memory for 10 minutes per node and key, and only then asks for the queue,
  on the header's existing refresh gate; a refused queue makes it ask the role again.

### 2.4 Migration — do not flip this in one release

A flip-day locks the operator out of their own machine.

1. **Add** key-based auth alongside the password. Both work. Nothing is removed.
2. **Enrol** — each admin signs in once with their key and it is recorded.
3. **Verify** on the test node that key auth, the QR flow and revocation all work.
4. **Demote** the password to break-glass-only, per §2.2.
5. **Rotate** whatever password remains as part of the pre-launch secret sweep.

### 2.5 Interim rule: password authentication as owner-level action

Until key-based admin auth ships, password-authenticated admin routes follow an interim rule (controller decision, 2026-09-14):
- A password-authenticated call to an admin route is by definition an OWNER-level action, because in the agreed model only owners hold the password.
- Never read an actor identity from the request body or headers.
- When `ctx.state.actor` is absent on a password-authenticated admin route, treat the caller as owner and record `granted_by = 'owner:password'`.
- When a signed actor IS present (via cryptographic session or signature), use it and enforce owner-only for owner grants.
- The same rule applies to voting-round creation (`POST /api/local/admin/commons/round`): bind round creation to the cryptographically verified actor (`ctx.state.actor`), or fall back to the active node admin/owner if unpopulated under password auth; never accept an unauthenticated `adminPubkey` in the request body.

### 2.6 The password brake, and why a stranger cannot use it to lock you out

The admin password is the one secret an outsider can try online, so guesses are slowed down
(`apps/server/src/password-brake.ts`). On a node with no key owner yet (every node straight after its launch
update) the password is also the only way in. So nobody else's guessing may keep the owner out.

#937's first brake counted wrong passwords for the whole node. After eleven wrong passwords from anyone, it refused
every password, including the right one, for up to ten minutes. Anyone could keep that going for as long as they
liked. We found this on the test node on 2026-09-19. It was replaced by this brake:

- **Per source.** A source is an IPv4 address or an IPv6 /64 (`client-ip.ts`, `limiterKeyForIp`). Each source gets
  5 wrong passwords free. After that it waits 2 s, then 4 s, 8 s, and so on, doubling up to **1 hour**. Only that
  source waits. A right password from the source clears its record, and so does a day with no failure from it.
- **A clean source is always checked.** A source is clean when it has no wrong password on record. Its attempt is
  never capped or queued. So from a network you haven't been guessing from today, the right password always works,
  whatever else is happening to the node.
- **A node-wide cap for everyone else.** Sources with a failure on record share **12 checks a minute** across the
  node. An attempt over the cap gets 429 with `Retry-After` (a minute at most) and is not counted as a failure.
  The cap is shared in three ranks, so an owner who mistyped isn't queued behind an attacker:
  - **Typo**: 1 or 2 failures, in a /48 or /24 with at most 3 failures today (so nearly clean). When one of
    these is refused, a free check is **held for it** for 5 minutes, and the ranks below can't take it. So the
    owner is checked on the first retry after a check frees. That is **not** always within a minute. Typo-rank
    sources don't wait for each other, so an attacker can fill 11 checks a minute from a dirty block and spend
    one typo-rank check on the 12th, which keeps the owner out for that minute. Each clean /48 or /24 gives it at
    most 2 of those a day. Measured (`test-password-brake-fairness.ts` part 1b; the owner mistyped once and
    honours `Retry-After`):

    | Attacker: one dirty /48, plus | Owner let in after | Before #948's review round 1 (typo rank up to 20 failures) |
    |---|---|---|
    | nothing more (a single /48) | 59 s | 59 s |
    | 1 clean /48 | 3 min | 14 min |
    | 2 clean /48s | 5 min | 27 min |
    | 5 clean /48s | 11 min | 66 min |
    | 28 clean /48s | 57 min | 365 min |

    So against N clean /48s or /24s the owner waits about 1 + 2N minutes, once per day of the attacker's
    supply. On main before #948 the same owner never got in. A network with no failures today is never held up
    at all, so the quick way in is still another network or key sign-in.
  - **After 3 or more mistypes** a source ranks as "few", and nothing is held for it. An attacker with a dirty
    block can keep it out for as long as it keeps guessing (as on main). Holding a claim costs the attacker
    nothing: twelve once-failed addresses keep their claims by retrying when they lapse, which shuts out the few
    and backoff ranks for about 144 filler checks an hour (Fable's measure at 9d0b061f: 0 of 2,159 tries over
    6 h for a 3-mistype owner). That owner was already shut out on main; it is cheaper for the attacker now. Either way,
    after 3 mistypes sign in from another network or with your key from the app.
  - **Few**: up to 5 failures and not typo (so also a fresh source in a dirty block). Gets the cap, minus the
    held checks.
  - **Backoff**: sources already backing off get only the first **6** checks, minus the held checks.
- **Clean sources can't be minted.** One IPv6 customer can hold a /48, which is 65,536 /64s. So failures are also
  counted per IPv6 /48 and per IPv4 /24. After 20 failures in a day, the block is dirty: its fresh sources are
  no longer clean and rank as "few". Fable's review of #944 simulated one /48 rotating fresh /64s, six guesses
  each. Before the typo rank, those /64s took every freed check, and an owner who had mistyped once was refused
  on all 1,078 retries over 6 hours. With the typo rank, the same attack lets the owner in after 59 s and one
  refusal (`test-password-brake-fairness.ts`).
- **One address for everyone (a proxy the node doesn't trust).** Behind a reverse proxy on another host that isn't
  in `TRUSTED_PROXIES`, every member arrives from the proxy's address. The brake then treats the whole community
  as one source, so a few wrong passwords from anyone make everyone wait. `client-ip.ts` notices this case: the
  proxy sends forwarding headers (`X-Forwarded-For` and similar) that the node doesn't believe. When it does,
  it logs a warning naming `TRUSTED_PROXIES`, and that source's wait is **capped at 10 minutes** instead of an
  hour. The fix is to add the proxy's address to `TRUSTED_PROXIES` in `.env` and restart. The restart also
  clears the brake. A lone guesser can send such a header to get the lower cap too, but that only gains it six
  checks an hour instead of one. Our own nodes aren't affected, because they resolve `CF-Connecting-IP` (#935).
- Memory is bounded: at most 100,000 sources and 100,000 blocks. When full, the one that failed longest ago is
  dropped, and that costs about a microsecond, not a rescan.
- Parallel guesses from one source are checked one at a time, so a burst can't all pass the gate before the first
  one fails. A dashboard sending several right passwords at once is served in turn, not refused.
- Every password check goes through it: `checkAdminAuth`, every route that calls `checkAdminPassword`, and
  `/ws/logs?auth=`. Key sign-in never does.
- The existing per-address limiters still apply on top: 15 auth attempts a minute on `verify-password`, and 300
  admin requests a minute.

**The maths.** These numbers come from simulating an attacker who guesses as soon as the brake allows
(`test-password-brake-no-lockout.ts` part 2):

| Attacker | #937 (node-wide) | This brake |
|---|---|---|
| 1 address | 24 in hour 1, then 6/h; 32/h if it pauses 30 min to reset the count | 16 in hour 1, then 1/h |
| N addresses in N different /24s or /48s | the same ~24–32/h, whatever N is | at most N + 720 in hour 1, then at most 720/h, falling to 360/h once every source is in backoff, plus one clean guess per new source per day |
| any number of /64s in one /48 | the same | at most 20 + 720 in hour 1, then at most 720/h |

For example, 300 addresses simulated gave 1020, 720 and 720 checks in hours 1–3.

This is looser against a large botnet than #937: hundreds of guesses an hour instead of about 30. That is the price
of promising that the owner is never locked out. A generated admin password is far outside what that rate can reach
in any useful time. A weak human-chosen one isn't, so the pre-launch password rotation still matters.

**Locked out with no key enrolled.** In order of what to try:

1. **Use another network**, such as mobile data instead of home Wi-Fi. A source with no failures is always checked.
2. **Wait.** A source's wait is never more than an hour (10 minutes behind an untrusted proxy). The node-wide cap
   frees within a minute, and after one or two mistypes a check is held for you. Under a determined attack that
   can still take several minutes (§2.6 above), and after three or more mistypes it may not come at all; then use
   another network or your key. The 429 says how long each wait is.
3. **Restart the node.** The brake is kept in memory, so a restart clears it completely. This needs shell access
   to the server, not the password.
4. **Reset the password from the server.** Set `ADMIN_PASSWORD` in the node's `.env` and recreate the container.
   `scripts/rotate-node-env.sh` clears the `isLocked` flag for you. Also needs shell access, not the old password.
   See `docs/secrets-rotation-runbook.md`.

**Operator manual: to carry over.** The node manual (#945, `feat/node-manual`) hadn't merged when this was
written. Its "The admin password brake" section in `packages/beanpool-guide/operators/server/rate-limits.md`
still describes #937's brake: node-wide, 10 free, up to 10 minutes, for everyone. Its lockout lines in
`help/troubleshooting.md` and `setup/signing-in.md` say "for everyone" too. Once it merges, replace that section
with the text below. Then change those lockout lines to "from your network; try another network, or sign in
from the app", and regenerate.

> **The admin password brake.** Wrong admin passwords are counted per internet address. Each address gets 5
> free. After that it waits 2 seconds, then 4, 8 and so on, up to an hour. Only that address waits. A right
> password, or a day with no wrong ones, clears it. From a network you haven't mistyped from today, the right
> password is always checked straight away, whatever anyone else is doing. If you mistyped once or twice and the
> server is busy with someone else's guesses, a check is kept for you: you usually get in on your next try, within
> a minute, but someone attacking from many networks can stretch that to several minutes or more. After three or
> more mistypes, or if you are still waiting, sign in from another network (mobile data instead of Wi-Fi) or from
> the app's Manage button, which is never affected.
>
> If it keeps closing, someone is guessing your password. Sign in from the app meanwhile, and make sure the
> password is long and not used anywhere else.
>
> **Behind a proxy on another machine.** If you haven't listed that proxy in `TRUSTED_PROXIES` in `.env`, your
> server sees every member as the proxy's address. Then a few wrong passwords from anyone make everyone wait,
> for up to 10 minutes. The log says so and names `TRUSTED_PROXIES`. Add the proxy's address there and restart
> the server. The restart also clears the brake.

Once a key owner exists, key sign-in skips the brake entirely. A break-glass code (§2.2) is still checked even from a
braked source, because it is 64 random bits and can't be guessed online.

---

## 3. Where admin work happens

### 3.1 Reactive versus configurational, not basic versus advanced

Marty proposed a basic/advanced toggle. The better axis is **what kind of work it is**:

- **Reactive work** is small, frequent, and arrives as a notification — dismiss this report, approve
  this keeper, answer this message. **If an admin has to open a browser and log in to dismiss a
  report, reports do not get dismissed.** This has to be in the app.
- **Configuration** is rare, fiddly, needs a keyboard and a wide screen — gateways, TLS, backups,
  diagnostics, network topology. This belongs on the web.

Basic/advanced splits by *difficulty*, which does not predict where someone will be standing when
the work arrives.

### 3.2 The split across the twelve existing tabs

| Surface | Tabs | Why |
|---|---|---|
| **In-app admin drawer** | `moderation` · `members` · `invites` · `commons` | reactive and daily: reports, a single invite, a pending keeper, pool health |
| **Web `/settings`** | `backup` · `system` · `network` · `connections` · `diagnostics` · `identity` · `comms` · `pulse` | configurational and heavy: certificates, gateways, logs, feeds, maintenance |

**Some things live in both, at different depth.** `members` is the clearest case: the in-app drawer
shows the *queue* — a pending keeper, someone to suspend right now — while the web tab holds the full
member table with every lever on it (voucher, tier, elder, freeze, prune). That is not duplication;
it is the same data at two depths, and the in-app view always links out to the full tab.

The in-app drawer is **not** a port of those tabs. It is the *queue* — the handful of things waiting
for a decision — with a link out for anything more.

---

## 4. Retiring the fleet manager

### 4.1 It is a duplicate, not a superset

| Fleet manager module | Already at `/settings` |
|---|---|
| Members, MemberDetail | `members` |
| Invites | `invites` |
| Logs | `diagnostics` |
| Gateway | `network` |
| ThreatReview | `moderation` |
| Onboarding | onboarding-funnel admin route exists |
| Telemetry, Analytics | partially — `diagnostics` |
| Topology | **genuinely fleet-only** (cross-node) |

Almost everything is per-node and already exists. The fleet manager's real distinguishing feature is
that it can point at *several* nodes — which is the edge case being retired.

### 4.2 The direction of the merge is the opposite of the obvious one

The obvious plan is "fold the manager's modules into `settings.js`". **Do not.**
`apps/server/static/settings.js` is a **231 KB untyped vanilla-JavaScript file** with no build step
and no component model. Pouring a React fleet manager into it produces something nobody can maintain,
and it is already close to that line. *(This also makes the `static/settings.js` blind spot worse —
it has already been the file a review missed.)*

Merge the other way. `apps/manager` is **React 19 + Vite + Tailwind**, and `node-client.ts` already
takes a `nodeUrl` argument on every single call — it was built per-node from the start and merely
loops over several. So:

> **Serve the fleet manager, scoped to one node, from the node itself as its admin UI.**

- Build `apps/manager` with its node URL fixed to its own origin.
- Ship that build as the node's admin surface; the old `settings.html` / `settings.js` retires.
- The multi-node profile switcher becomes a build flag, so Marty keeps a fleet view for himself
  without every community node carrying it.
- Authentication becomes the key-based flow in §2, replacing `buildAdminHeaders`' password.

This keeps the typed, tested, component-based code and deletes the untyped monolith — rather than the
reverse.

### 4.3 The line is single-node versus multi-node — not "machine" versus "community"

*(An earlier draft split this as machine-operations versus community-administration and said the
machine half stayed Marty's problem. **That was wrong**, and Marty corrected it: every person running
their own node **is** the machine half. They need their own backups, their own DNS, their own logs,
their own ability to promote a voucher. There is no half that belongs to someone else.)*

**`/settings` must be complete for a standalone operator.** It is not a subset of the fleet manager
and it is not "the easy bits". A community running its own node must be able to do everything for
that node without opening another tool, without ssh, and without asking us.

Explicitly including: **take, restore, schedule and verify their own backups**; promote a member to
**voucher** (`can_vouch`), grant a tier badge, grant elder; suspend, freeze, prune; generate and
revoke invites; action reports; create enterprises and assign keepers; configure public address, DNS
and TLS; manage peering and connectors; read their own logs and ledger audits; curate Pulse channels;
set node identity; manage their own password, 2FA and IP allowlist.

**Only genuinely multi-node features stay in a separate app:**

- the node switcher and saved node profiles
- comparing nodes side by side; aggregate cross-fleet analytics
- the cross-node topology view
- deploying or updating several nodes in one action

That app stays Marty's — and it should be the *same* React codebase with fleet features behind a
build flag, not a fork. One code path, two audiences.

**One deliberate carve-out, on security grounds rather than convenience.** Deploying, replacing or
restarting the node's own container stays **out of any web UI**. A settings page that can swap the
running image is a remote-code-execution surface on a box in someone's house, reachable by anyone
holding an admin session. A self-hosting operator does that over ssh, as they already do. What
`/settings` *should* carry is the read-only half — current version, whether a newer release exists,
when the last backup succeeded — so the operator knows they need to act without the page being able
to act for them.

---

## 5. Build order

1. **`node_roles` table + delete `getAdminPubkey()`.** Confirm the `'SYSTEM'` bug first, then replace
   inference with a real lookup. **Everything else depends on this** — there is no point designing
   multi-owner rules or key handoffs on top of an admin identity that may not resolve to a human.
2. **Owner and admin tags** in profile, People, node info and moderation records (not marketplace
   listings — [`the-commons.md` §9.3](./the-commons.md)).
3. **Key-based auth alongside the password**, then enrol, verify, demote (§2.4).
4. **In-app admin drawer** — the reactive queue only.
5. **Manager retargeted to a single node** and served as `/settings`; retire `settings.js`. Fleet
   features (node switcher, cross-node compare, topology, multi-node deploy) sit behind a build flag
   in the same codebase rather than a fork.
6. **Multi-owner rules** and the owner-removal grace window.

---

## 6. Open questions

1. **Does an admin need to be a member of the node they administer?** Presumably yes — they need a
   key and a profile to be attributable. But it means the owner appears in People and holds a
   balance, which is probably right and should be a deliberate choice.
2. **Does the in-protocol override survive at all?** Once admins are real, `canOperateTreasury`
   returning true for any admin is a large, silent power over every enterprise's money. It may be
   better to require an explicit keeper binding even for admins, and let the override cover only
   moderation. **Recommendation: narrow it**, now that we can tell who is using it.
3. **What happens to a node with zero owners** — an owner pruned or lost? Recovery is break-glass by
   definition, and it should be tested rather than discovered.
4. **Is `identity` (node name, avatar, description) really web-only?** It is the one configuration
   tab a community might want to change casually.
