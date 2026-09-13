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

### 2.4 Migration — do not flip this in one release

A flip-day locks the operator out of their own machine.

1. **Add** key-based auth alongside the password. Both work. Nothing is removed.
2. **Enrol** — each admin signs in once with their key and it is recorded.
3. **Verify** on the test node that key auth, the QR flow and revocation all work.
4. **Demote** the password to break-glass-only, per §2.2.
5. **Rotate** whatever password remains as part of the pre-launch secret sweep.

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

The in-app drawer is **not** a port of those tabs. It is the *queue* — the handful of things waiting
for a decision — with a link out to the full tab for anything more.

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

### 4.3 Machine operations are not community administration

The fleet manager conflates two jobs, and only one of them belongs to a community:

- **Operating the machine** — deploy, containers, image tags, cross-node topology, host-level
  backups. Sysadmin work. It stays where it is and remains only Marty's problem.
- **Administering the community** — members, invites, moderation, enterprises, decisions, pool
  health. This belongs at `/settings` and in the app, reachable by any admin from their phone.

A self-hosted community node's host does the first with ssh and docker, as they already do. Do not
build a web UI for deployment into a community's settings page.

---

## 5. Build order

1. **`node_roles` table + delete `getAdminPubkey()`.** Confirm the `'SYSTEM'` bug first, then replace
   inference with a real lookup. **Everything else depends on this** — there is no point designing
   multi-owner rules or key handoffs on top of an admin identity that may not resolve to a human.
2. **Owner and admin tags** in profile, People, node info and moderation records (not marketplace
   listings — [`the-commons.md` §9.3](./the-commons.md)).
3. **Key-based auth alongside the password**, then enrol, verify, demote (§2.4).
4. **In-app admin drawer** — the reactive queue only.
5. **Manager retargeted to a single node** and served as `/settings`; retire `settings.js`.
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
