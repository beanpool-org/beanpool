# Onboarding lockout, recovery UX, and map centering — findings 2026-09-02

**Status: FINDINGS ONLY — nothing here is fixed yet.** Every claim below was measured
from the code or from live node responses on 2026-09-02, and the file/line references
are to `main` at that date. This is a bug report, not a description of fixed behaviour.

Found while preparing the TikTok/Meta App Review submission. Marty attempted to add the
`review` node from inside the app, was ejected into a dead-end screen, and the only exit
destroyed his device identity. He recovered, but only because two other nodes happened to
hold recovery fragments.

Findings are grouped by severity. Section 1 is the lockout chain and can cost a member
their account.

---

## 1. The lockout chain (P0 — can destroy a member's identity)

### 1.1 Guest mode and "stranger" are the same condition

`_layout.tsx` runs a watcher that probes whether the anchored node recognises the
identity. On `recognition === 'stranger'` it redirects:

```ts
if (root !== 'node-mismatch' && root !== 'welcome' && root !== 'recover-identity') {
    router.replace('/node-mismatch');
}
```

The exclusion list does not cover `(tabs)`, and nothing in it knows about **guest mode**.
But being a non-member of your anchored node is exactly what read-only guest mode *is*.

So adding a node as read-only and anchoring to it puts the app in a state the watcher
treats as a fatal addressing error. The member is ejected from the very Register tab that
exists to fix it. The invite code never gets evaluated.

**This is the root cause of the incident.** The invite code was never the problem.

### 1.2 `node-mismatch` is inescapable

Once there, there is no way back:

| lock | where |
|---|---|
| no header back button | `<Stack screenOptions={{ headerShown: false }}>` |
| no swipe-back gesture | `<Stack.Screen name="node-mismatch" options={{ gestureEnabled: false }} />` |
| no back-stack entry | reached via `router.replace()`, not `push` |
| no cancel control | the screen renders only **Reconnect** and **Log out & start over** |

The only `Cancel` in `node-mismatch.tsx` belongs to the logout confirmation dialog, not to
the screen.

For a member deliberately in guest mode, **Reconnect cannot succeed** — re-probing the
same node returns 'stranger' again. That leaves exactly one working control, and it is
the destructive one.

This violates the standing "no hard gates" rule for onboarding: never leave a member
blocked with no good way forward.

### 1.3 The only exit deletes the identity, with no seed backup

`handleLogout()` in `node-mismatch.tsx` calls `wipeIdentity()`, which is a bare
`SecureStore.deleteItemAsync(KEY_ID)` — **no seed is backed up first**. There is no
`seed_backup` key anywhere in the codebase.

Its dialog says:

> "Your 12-word recovery phrase still restores this account later."

That is only true if the member was ever shown those words *and* saved them. The dialog
asserts a safety net rather than verifying one exists.

Compounding it: the label is **"Log out"**. There is one identity per device across all
nodes, so there is no such thing as logging out of a single node — any logout is
necessarily global. The most destructive action in the app is presented in the vocabulary
of a reversible session logout, and offered as the remedy for one node having the wrong
address.

### 1.4 No "switch community" action, despite having the list

Saved nodes live in `beanpool_saved_nodes` (`utils/nodes.ts`). At the moment of the
lockout that list contained `test`, `mullum` and `melb` — all nodes where the member *was*
recognised.

`node-mismatch` offers a free-text address field instead. One tap on a saved node would
have resolved it. **This is the single highest-value fix in this document.**

### 1.5 Wiping leaves the saved-node list behind

`wipeIdentity()` clears `beanpool_anchor_url` and the `pillar_sync_*` keys but not
`beanpool_saved_nodes`. Keeping the addresses is arguably right, but nothing in the UI
then reflects that the identity backing them is gone: the member sees a full list of their
communities while being a stranger to every one.

### 1.6 The guest redeem path discards its result (latent)

In `people.tsx`, the guest-mode branch:

```ts
await redeemInvite(parsedCode, identity?.callsign || 'Unknown', identity);
// return value never inspected
Alert.alert('Success', 'Invite redeemed! ...');
setIsGuest(false);
router.replace('/');
```

`redeemInvite` in `utils/db.ts` throws only on a non-2xx status; on any 2xx it ignores
`data.success` entirely and returns `{ success: true }`.

Currently masked because `/api/invite/redeem` returns **400** on failure, so the client
throws and the error surfaces. But the client is relying on a status code it never checks
against a payload field it never reads. Any change to that route returning
200-with-`success:false` would report "Invite redeemed!" on a failure.

### Working path today, for the record

Joining a second community from inside the app *does* work — but only if you **do not add
the node first**. People → "Join Another Community" with both the invite code and the node
URL closes the DB, switches the anchor, redeems, then saves the node, so registration
completes before the watcher can see a stranger. The QR/invite-link route works for the
same reason.

Pre-adding the node read-only is the trap.

---

## 2. Recovery UX (P1 — causes false confidence about account safety)

### 2.1 "You're covered" is per-node but reads as account-wide

`fetchProtectionStatus()` in `settings.tsx` calls `getAnchorUrl()` and posts to
`/api/recovery/shares/status` **on that node only**. `KeeperProtectionPanel` then renders
"🛡️ You're covered" with no community named anywhere on the panel.

Measured live on 2026-09-02 for the same pubkey:

| node | keepers | recoverable |
|---|---|---|
| `melb` | hub + sso (2, threshold 2) | **true** |
| `test` | hub + sso (2, threshold 2) | **true** |
| `mullum` | none (0) | **false** |

The member had read "You're covered" and reasonably concluded it described his *account*.
When locked out he attempted recovery on `mullum`, which holds nothing, and was told there
were no fragments.

Someone could lose their phone genuinely believing they are covered and discover their
community was never enrolled. Keeper enrolment being per-node is defensible — the hub
fragment has to live on a node — but then the UI must aggregate it or state the scope.

### 2.2 The panel contradicts itself

`KeeperProtectionPanel.tsx` line 39 renders unconditionally:

> "Connect multiple accounts for redundant backup. Any single connected account can
> restore your 12 words."

That omits the hub requirement. Directly below, the footnote is correctly conditional and
says, for a single enrolled provider:

> "Neither of them can open your account alone — it takes both."

With one provider both appear at once. The footnote logic is right; the subtitle is wrong,
and it is the more reassuring of the two.

The disconnect dialog has the same slip — "will no longer be able to restore your 12
recovery words" is node-scoped but stated globally.

### 2.3 Recovery cannot tell you which node to use

`/api/recovery/keepers/:callsign` deliberately returns an identical shape for "no such
callsign" and "member with no split", to avoid being a sharper oracle. Sound reasoning —
but the resulting message, *"That account has no recovery fragments to collect"*, reads as
"you have no backup at all" when it often means "wrong node".

The client already knows the member's saved nodes. It could probe them and point at the
one that can actually recover, instead of leaving the member to guess. The member guessed
`mullum` and got a dead end while `melb` would have worked.

---

## 3. Map centering (P2 — cosmetic, but one live node is affected)

### 3.1 Two nodes have no `serviceRadius`, so the map silently shows Mullumbimby

`fetchNodeLocation()` reads `/api/node/config` and centres on `config.serviceRadius`
(confirmed **not** gated by the `publishLocation` toggle). With no value set, the map keeps
its hardcoded initial state — `-28.5398, 153.4996`, which is **Mullumbimby**.

Measured: `test` and `bindarrabi` have no `serviceRadius`. `review`, `melb`, `castlemaine`,
`mullum` and `gippsland` all do, and all resolve to the correct towns.

`bindarrabi` is a **live node with real members**, currently showing them a map centred on
another community's town.

Defaulting to a real, specific community's coordinates is the defect: an unconfigured node
silently impersonates Mullumbimby with no signal that anything is wrong. Better to not
animate at all when `serviceRadius` is absent, and prompt to set a community location.

### 3.2 Centering is racy and can fail on a correctly configured node

`initialRegion={currentRegion}` is applied **once** on first render and is not reactive.
`fetchNodeLocation()` then runs from `useFocusEffect`, after mount, and does two things:

- `setCurrentRegion(nextRegion)` — no effect on the displayed map, because `initialRegion`
  ignores later changes;
- `mapRef.current?.animateToRegion(...)` — optional-chained, so if the ref is not yet
  attached when the async fetch resolves, it is silently a no-op.

So the only thing that actually moves the map can be skipped, leaving a properly
configured node on the Mullumbimby default. Not yet observed on-device — this is a
code-reading conclusion — but it is possible by construction.

### 3.3 The map re-centres on every tab focus

`onRegionChangeComplete` writes every pan into `currentRegion`, and `fetchNodeLocation()`
re-runs on every focus with `[]` deps. Leaving the Map tab and returning discards wherever
the member had scrolled to.

---

## Suggested order of work

1. **1.4** — add a saved-node picker to `node-mismatch`. Smallest change, removes the trap.
2. **1.1** — teach the watcher about guest mode so it stops ejecting deliberate guests.
3. **1.3** — back up the seed before wiping, or verify the member holds their 12 words;
   and stop calling it "log out".
4. **2.1 / 2.2** — name the community on the protection panel and fix the contradictory copy.
5. **3.1** — set `serviceRadius` on `test`; agree a value for `bindarrabi` (live — needs a
   decision, not a guess) and remove the hardcoded Mullumbimby fallback.
6. **2.3**, **1.5**, **1.6**, **3.2**, **3.3** — as capacity allows.

## Note

`map.tsx`, `Map.web.tsx`, `UnifiedMapPin.tsx` and `GlobalHeader.tsx` are on the
do-not-touch list after an earlier revert. Section 3 fixes touch `map.tsx` and should be
done by hand with care, not delegated to an autonomous agent.
