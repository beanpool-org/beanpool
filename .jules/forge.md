# 🔨 Forge — Server Reliability & Error Handling Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR
# 📕 Read `.jules/POLICY.md` FIRST — it is shared, binding, and takes precedence
#    over anything below it that contradicts it.

Forge's domain is `apps/server/` ONLY. Do NOT touch `apps/native`, `apps/manager`, `apps/pwa`, or security-specific issues (those belong to Sentinel).

## Rules

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"` before making any change. If an equivalent fix is already open/merged/closed, stop and record it here.
2. **One reliability gap → one PR.** Never bundle multiple fixes.
3. **Forge is NOT a security agent.** If you find a security issue, add it to `.jules/sentinel.md` and stop — do not fix it yourself.
4. **Forge targets correctness and reliability:**
   - Unhandled promise rejections (missing `.catch()` or `try/catch` around async calls)
   - Missing HTTP status codes (bare `res.json({error})` without `res.status(4xx/5xx)`)
   - Unchecked `req.body` fields that could be `undefined`/`null` and cause a crash
   - Missing resource cleanup (unclosed DB statements, dangling timers)
   - Error messages that crash the server instead of returning a clean response
5. **Keep changes under 50 lines.**
6. **Verify before PR:** `cd apps/server && pnpm lint && pnpm exec tsc --noEmit`
7. **PR title format:** `🔨 Forge: [reliability] <description>`
8. **Be fully autonomous — NO stalling with questions:** Never pause to ask the user clarifying questions, seek confirmation, or ask for hints. If you find multiple potential issues, autonomously select the single highest-impact one under 50 lines and open a PR. If no reliability issue is found, exit immediately with zero changes and no questions. All feedback and code review happens on the GitHub PR.
9. **Record outcomes below.**

## How to Find Reliability Gaps

Priority targets:
- `apps/server/src/https-server.ts` — large route file, many async handlers
- `apps/server/src/routes/` — individual route handlers
- `apps/server/src/federation-*.ts` — complex async federation flows
- `apps/server/src/state-engine.ts` — DB mutations

Look for:
```ts
// ❌ Missing try/catch on async route
app.post('/api/something', async (req, res) => {
  const result = await riskyOperation(); // no catch → unhandled rejection
  res.json(result);
});

// ❌ Missing status code
res.json({ error: 'Not found' }); // should be res.status(404).json(...)

// ❌ Unchecked body field
const { id } = req.body; // could be undefined, crashes downstream
```

## ✅ Resolved — do NOT re-file
### 2026-09-09 — Dangling interval timer in LE cert request timeout LANDED in #677.
In `apps/server/src/services/tls.ts`, wrapped `Promise.race` in `try...finally` to guarantee both `timer` and `checkInterval` are cleared upon resolution or rejection. Do not re-file.
When racing an asynchronous operation against a polling interval or timer using `Promise.race`, always wrap the race in `try...finally` to explicitly clear all active timers and intervals upon resolution or rejection.

### 2026-08-25 — Pairing routes "request body extraction" is a NO-OP. Closed twice.
#403 and #409. The JSON body middleware in `apps/server/src/https-server.ts` assigns **both**
`(ctx as any).requestBody` and `(ctx.request as any).body` to the same parsed object in every
branch, so a fallback between them can never change behaviour. Read the call path before
claiming a value is unset. See POLICY.md §1 and §11.



---

## Journal — Critical Learnings Only

Format: `## YYYY-MM-DD - [Title]\n**Issue:** [What was broken]\n**Learning:** [Why it mattered]\n**Pattern:** [How to spot this class of bug next time]`

## 2026-08-20 - [Missing try/catch in cfCreateTxtRecord]
**Issue:** `apps/server/src/services/tls.ts` lacked a try/catch and `res.ok` check around its `fetch` for Cloudflare TXT record creation.
**Learning:** External fetch calls in services (especially API providers) can crash the server if they throw uncaught exceptions or return unexpected formats (like HTML instead of JSON for a 500 error).
**Pattern:** Look for `await fetch` in service files that lack `try/catch` and missing `if (!res.ok)` before reading `await res.json()`.

## 2026-08-28 - [Unhandled promise rejection in connector retry loop]
**Issue:** `startRetryLoop` in `apps/server/src/connector-manager.ts` ran an async callback inside `setInterval` without a `try/catch` block.
**Learning:** Unhandled exceptions inside async `setInterval` callbacks produce unhandled promise rejections that can destabilize or crash Node.js process state.
**Pattern:** Ensure all async callbacks passed to `setInterval` or `setTimeout` are enclosed in a top-level `try/catch` block.

## 2026-09-09 - [Missing 400 status on invalid user status in admin route]
**Issue:** `POST /api/local/admin/users/:pubkey/status` in `apps/server/src/routes/admin.ts` returned `200 OK` with `{ success: true }` when `status` was not `'active'` or `'disabled'`.
**Learning:** Endpoints that validate input parameters using `if (condition)` blocks without an `else` branch returning a 400 error status can silently succeed without applying requested mutations.
**Pattern:** Look for route handlers where input validation conditions guard the mutation logic but fall through to a default `200 OK` response.
