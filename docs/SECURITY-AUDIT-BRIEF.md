# BeanPool security handover — pre-open-source release

This handover covers **two phases, in order**:
- **Phase 1 — Convert the live mirror to a one-directional live backup** (removes the biggest
  remaining threat vector). Implementation task. **Do this first.** See "## Phase 1" below.
- **Phase 2 — Full adversarial pre-release audit** of the whole codebase. Find-and-report only.
  See "## Phase 2 (audit)" below.

The threat model and "what's already remediated" sections apply to both.

---

## Phase 1 — Convert mirror → one-directional live backup

**Why:** the only reason the SRV-20/21 ledger-forgery vector exists is that the primary node
*trusts and imports* ledger state pushed *from* a `mirror` connector. A compromised mirror is a
trusted writer to the ledger. Decision: replace the bidirectional mirror with a **one-directional
live backup** so the **primary trusts NOTHING inbound** — which closes the forgery vector on the
authority everyone transacts against. (Load-balancing isn't needed at this scale; the mirror was
really being used as failover anyway.)

**Goal:** data flows **primary → backup only**. The backup stays near-real-time and promotable on
failover; the primary never imports peer state.

**Hard requirement:** do NOT reintroduce inbound trust on the primary under a new name. The win is
entirely that the primary imports from nobody.

**Key investigation before designing:** the current P2P sync may be *mutual* — for the backup to
pull, the primary might have to accept (trust) the backup's sync stream, which would quietly rebuild
the mirror. Inspect `sync-protocol.ts` / `connector-manager.ts` and determine which path is safe:
- **(a) Preferred — read-only snapshot pull:** the backup periodically fetches the primary's
  state over HTTPS (e.g. the ledger export / a snapshot endpoint, authenticated read) and applies
  it locally. The primary configures **zero trusted connectors** → forgery surface gone.
- **(b) Serve-only P2P:** only viable if the primary can *serve* state to a connecting peer without
  ever calling `importRemoteState` on that peer's data. If sync is inherently mutual, prefer (a).

**Tasks:**
1. Determine (a) vs (b) by reading the sync code; document the choice.
2. Implement it as a PR off `main` (NOT to main directly — protected; shared worktree; a Sentinel
   agent also files PRs — coordinate via `.jules/sentinel.md`). Config: primary trusts no mirror;
   backup trusts only the primary.
3. Keep ALL existing SRV-20/21 hardening (mirror-only gate, conservation guard, strict member
   verification) intact as a dormant safety net.
4. Validate on the test pair (`test` = primary, `test-mirror` = live backup): backup stays in
   sync; the primary rejects/ignores any inbound state push; failover promotion works. Add a
   conservation/sanity check at promotion if cheap.
5. Update `SECURITY-AUDIT.md` + `docs/SECURITY-CUTOVER-CHECKLIST.md` to reflect the new topology.

**Then proceed to Phase 2.**

---

## Phase 2 (audit)

**You are a security auditor.** Run an exhaustive, adversarial, white-box audit of the CURRENT
codebase (after Phase 1) before it is released publicly as open source. Assume the attacker has
everything you have — full source, git history, and AI tooling — so obscurity is worth nothing;
only correctness counts. **Find anything exploitable; economic / credit-minting bugs lead.** This
pass is **find-and-report only — do NOT change code.** Fixing is a separate, reviewed step.
**Intended topology to assume:** no trusted mirror; one-directional live backup (Phase 1) — flag
anything that imports state without a configured trusted peer, or that re-introduces inbound trust.

## Threat model
- **The server is the trust boundary.** The native app (APK, decompilable) and PWA (JS in the
  browser) ship to attackers, so the request format, signing scheme, and endpoints are effectively
  public regardless. A real attacker hits the API directly — assume forged / replayed / malformed
  requests, a malicious libp2p peer, and a **compromised `mirror` connector**.
- **Money + identity = high incentive.** Treat business-logic / economic exploits (minting,
  double-spend, free value) as first-class, alongside classic vulns.
- Identity = an Ed25519 keypair; the private key is the crown jewel (PWA stores it in JS-readable
  IndexedDB — higher risk; native uses SecureStore).

## What's already remediated — DO NOT re-report as new (verify the fix actually holds)
`SECURITY-AUDIT.md` (the **status log** + the 2026-06-19 re-audit section) is the source of truth.
Remediated and on `main`: SRV-1 (sync trust gate), SRV-2/4 (read-auth + WS-auth), SRV-3 (verified
requester), SRV-9a/10 (restore traversal + admin pw), SRV-20/21 (mirror-only import + balance LWW +
**conservation guard** + strict member-transfer signatures), X-1/X-1b (replay-proofing), NAT-1
(DM E2E), NAT-4 (cleartext scoping), NAT-5/20/21, PWA-1/2/5, SRV-5/8, CORS.

Important context for the audit:
- **Enforcement flags are CODE-COMPLETE but default OFF** (`ENFORCE_READ_AUTH`, `ENFORCE_WS_AUTH`,
  `ENFORCE_LEDGER_AUTH`), flipped at the cutover. **Audit the enforcement paths as if the flags are
  ON** (that's the shipping config) — AND separately note any window that exists while they're off.
- **Known documented residual** (don't just re-flag — try to find a *worse* version): a compromised
  mirror could forge a *balance-neutral* escrow chain (deposit+release) that the conservation guard
  can't see.
- **Known manual/operator items** (out of code scope): NAT-2 FCM key (in git history), NAT-3
  keystore, NAT-10 Play key.
- **Known unresolved operational bug**: the admin "generate user" path hung the event loop (a 502).
  Root cause never found — investigate (candidate: SRV-14 synchronous `scryptSync` on the admin path).
- The audit predates a lot of current code (new features + merges from agents Bolt/Sentinel/Palette
  + the signed-ledger work). **New code = new surface — that's the main hunting ground.**

## Focus areas (priority order)
1. **Economic / ledger integrity (LEAD).** Credit minting, double-spend, escrow atomicity & races,
   floor/demurrage gaming, conservation gaps, marketplace/crowdfund value extraction, transaction-fee
   math. **Adversarially review the new signed-ledger code itself** (conservation guard, strict
   member-transfer verification, `verifyTransactionAuthorship`, the import path) — it was written by
   the agent that's now asking you to check it.
2. **AuthZ / AuthN.** This repo has a documented **fail-open "protect-this-list" pattern** (5+ prior
   auth-bypass incidents). Re-examine `requireSignature`, the read-auth public allowlist correctness,
   WS connect auth, admin endpoints, and **IDOR** (can A read/mutate B's data — DMs, balances,
   friends, recovery, preferences?).
3. **P2P / sync trust.** `connectionGater` is still absent (any peer can open a libp2p stream —
   SRV-1 residual), SRV-22 sync payloads aren't freshness/sequence-bound (replayable), mirror trust,
   sync-payload parsing/deserialization, resource exhaustion.
4. **Crypto / key handling.** The signing schemes (request + WS + transaction), PWA IndexedDB key
   exposure, native SecureStore, the homemade non-BIP39 mnemonic (PWA-7), identity import/transfer.
5. **Injection / input.** SQL, command (`execFileSync`), path traversal (beyond the restore fix),
   SSRF (federation/anchor fetches), unbounded inputs (SRV-11 body cap, SRV-24 import loops).
6. **Client.** PWA `innerHTML`/XSS sinks + key exposure, native clipboard/log leakage (NAT-8),
   deep-link/scheme handling.
7. **Info disclosure / DoS.** Verbose errors reflected to clients (SRV-12), enumeration,
   event-loop-blocking sync ops (SRV-14), `INSERT OR IGNORE` dropping CHECK-violating txns (SRV-26).

## Subsystem map
- `apps/server/src/state-engine.ts` — ledger, transfer, escrow, demurrage, `importRemoteState`, profiles.
- `apps/server/src/sync-protocol.ts`, `p2p.ts`, `connector-manager.ts`, `federation-*.ts` — P2P trust/sync.
- `apps/server/src/https-server.ts` — every route + `requireSignature` middleware + WS upgrade.
- `apps/server/src/db/db.ts` + `schema.sql` — schema, escrow/crowdfund balance mutations, FKs off (SRV-7).
- `apps/server/src/local-config.ts` — admin auth.
- `apps/pwa/src/lib/` — `api.ts` (signing), `identity.ts`, `sync.ts`, `e2e-crypto.ts`.
- `apps/native/utils/` — `db.ts`, `crypto.ts`, `node-url.ts`, `identity.ts`; `services/ws-client.ts`; `app/_layout.tsx`.

## Rules / constraints
- **Read-only.** Find + report; do NOT modify code, do NOT open code PRs in this pass.
- **Do NOT commit to `main`** (protected, PR-only) and beware the **shared git worktree** + the
  autonomous Sentinel agent (check `SECURITY-AUDIT.md` and `.jules/sentinel.md` to avoid duplicating
  Sentinel's open work, e.g. #142).
- Fix *directions* you suggest must not break **LAN cleartext sync** (NAT-4, reverted twice) or the
  fragile onboarding nav / `GlobalHeader`/`map` (prior revert).

## Method — be adversarial, minimize false positives
- For each candidate, construct the **concrete attacker path / PoC** (the exact request, peer
  behaviour, or sequence). If you can't articulate one, it's not a finding — say so.
- For high-severity candidates, verify from multiple angles before asserting (default to "refuted"
  when uncertain). The goal is real findings, not noise.
- For maximum coverage, fan out across the focus areas × subsystems above.

## Deliverable
Write to a NEW file `docs/SECURITY-AUDIT-2026-06-26.md`. One section per finding:
**ID** (use `A2-1`, `A2-2`, … to distinguish this pass; cross-reference any existing SRV-/NAT- id),
**severity** (🔴/🟠/🟡/🟢), **location** (`file:line`), **attacker path** (concrete), **PoC / repro**,
**fix direction**, **confidence**. End with: a **prioritized summary table**, and an explicit
**"reviewed and found clean"** list per subsystem so coverage is auditable. **Change no code.**
