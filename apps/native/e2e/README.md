# Native E2E smoke test (Maestro)

Basic end-to-end coverage for the native app, meant to run before each app release
(`eas build --local`) so a broken tab or a dead bottom sheet doesn't ship. Kept light —
one flow, one thing at a time — with a plan to scale it up once production builds make a
broken release costly.

## Install (one-time, this Mac)

We use **Maestro**, the open-source mobile UI-testing CLI
(https://github.com/mobile-dev-inc/maestro, Apache-2.0). This is **not** the
`brew install --cask maestro` package — that's an unrelated "AI agent command center"
app with the same name. Do not install that.

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

This installs to `~/.maestro/bin` and appends it to `PATH` in `~/.zshrc` /
`~/.bash_profile`. Open a new terminal (or `export PATH="$PATH:$HOME/.maestro/bin"`) and
confirm:

```bash
maestro --version
```

**Pinned version used to write and verify this suite: 2.10.0** (installed 2026-09-19).
Maestro has no npm package — it ships only as this native CLI, so there is nothing to add
to `package.json`.

Requires a JDK on `PATH` (the install script checks and tells you if it's missing) and
`unzip`/`curl`, both already on macOS.

Optional: Maestro phones home anonymous usage analytics by default. To opt out for every
run, export before use:

```bash
export MAESTRO_CLI_NO_ANALYTICS=1
export MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
```

We never use `maestro cloud` (the paid hosted runner) — everything here runs against a
local emulator or device.

## What's covered

`smoke.yaml` — launches the app with an already-joined identity, opens every bottom tab
in turn and asserts each one's large page title (`testID` + text, so a renamed or missing
title fails the run, not just a missing element), then opens and closes the Ledger tab's
"Available Balance" bean sheet.

- **Identity:** relies on an identity already seeded on the device/emulator the way
  `emulator-dev-client-loop.md` describes (SecureStore + the RKStorage `AsyncStorage` DB,
  anchored to a node) — `launchApp: { clearState: false }` so Maestro doesn't wipe it.
  This suite does not create an identity itself; if the target device has none, join one
  by hand first (see that memory, or `staging-web-qa-recipe.md` for a fresh invite/signup
  against `https://test.beanpool.org`).
- **Tabs asserted:** Market, Map, Talk, Pulse, Commons, Ledger (the six bottom tabs;
  People and Settings are hidden from the bar and out of scope for this pass). Market,
  Talk, Pulse, Commons and Ledger each render a shared `PageTitle` component — it now
  takes an optional `testID`, which each screen sets (`page-title-market`, etc.) purely
  for this suite; no visual change. Map has no `PageTitle` (its own header UI is
  protected — `map.tsx` is off-limits), so it's asserted via the existing "Recenter map"
  button's `accessibilityLabel` instead.
- **Bean sheet:** the balance info sheet reachable from Ledger → Wallet → the ⓘ next to
  "YOUR BALANCE" (`BalanceInfoModal`, titled "Available Balance"). Added `testID`s:
  `ledger-wallet-tab`, `bean-sheet-open` on the ⓘ button, and a generic `testID` /
  `${testID}-close` pair on the shared `InfoModal` component (used by every info sheet,
  not just this one) that `BalanceInfoModal` sets to `bean-sheet`.
- **Cold start:** the flow waits (`extendedWaitUntil`, 90s) for the Market tab before
  interacting. On a loaded dev machine, Maestro's own UI-automation overhead measurably
  slows the JS engine's cold start — over 30s from "Activity displayed" to
  `ReactNativeJS Running "main"` was observed on this Mac under load (other builds,
  editors, etc. running). A quieter machine or CI runner should be much faster; the
  generous timeout just means the suite waits rather than flaking.

## Screen size

Run at **320dp-equivalent width** by overriding emulator density before running (Maestro
itself has no display-size option — it drives whatever's already showing):

```bash
adb shell wm density 540   # 1080px physical / 540 = 320dp on a 1080-wide device
# ...run the suite...
adb shell wm density reset
```

Verified passing both at 320dp (override density 540) and at the emulator's normal
density (420, ~411dp) on `Medium_Phone_API_36.1` (1080×2400 physical). If your AVD has a
different physical width, recompute the override (`physical_width_px / 320`).

## Running it

One flow directly:

```bash
maestro test e2e/smoke.yaml
```

Or the full suite via the one-command wrapper (checks an emulator is up and the app is
installed first):

```bash
../../scripts/maestro-prerelease.sh
```

**Not run in CI.** This needs a live emulator/device and a joined identity already
seeded on it — `scripts/maestro-prerelease.sh` is for a human (or an agent following the
emulator loop) to run locally before cutting a release build, not for the pipeline that
runs `scripts/test-all.sh`.
