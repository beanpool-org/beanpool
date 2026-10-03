# PROGRESS — connectors admin-only (from #1564 deciding review NB3)

Branch fix/connectors-admin-only, from main 19d43592. Lane started 10:40 AEDT 2026-10-04.

## Caller map (step 1)

| Caller | Route | How it authenticates today | After the change |
|---|---|---|---|
| `apps/server/static/settings.js:551` (legacy Settings, after sign-in) | GET /api/local/dashboard | `adminHeaders()`: X-Admin-Password + X-Admin-2FA-Session; an admin route (`/admin/2fa/status`) is asked first | works: an admin caller gets identity + connectors |
| `apps/server/static/settings.js:913` `refreshConnectors()` (after each connector action) | GET /api/local/connectors | **nothing** | would get 401 → fixed: sends `adminHeaders()` |
| `apps/manager/src/components/modules/PeerConnectorsPanel.tsx:66` | GET /api/local/connectors | `buildAdminHeaders(nodeCredential, tfaSession)` | works unchanged |
| `scripts/federation/redeem.mjs:142` (dev script, Marty's test containers) | GET /api/local/connectors | `plain()`: nothing | fixed: passes `adminHeaders('eastgippy')` |
| `apps/server/src/test-gateway-real-client.ts:193` | GET /dashboard as an admin-surface path for the IP allowlist | none; asserts 403 / not 403 | unchanged: anonymous still 200 |
| `apps/server/src/test-node-config-public.ts:194` | GET /dashboard as an unsigned public read | none; asserts 200 and no hidden contacts | unchanged: still 200 |
| `apps/server/src/test-guest-view.ts:1319` | both, in EVERY_ROUTE | unsigned / non-member signer / pruned | listed already; leak sweep only |
| `apps/manager/e2e/fixtures.mjs:1039` | GET /connectors | mock | n/a |
| PWA, native, server federation/peer code | — | no caller (peers use libp2p, `/api/local/status` with CORS *, `/api/federation/*`) | n/a |

## Plan
1. Fail-first test in test-connector-credit-cap.ts (real HTTPS node): anonymous / member key / moderator refused, admin session + token list; dashboard public fields for anyone, connectors only for admin.
2. Server: GET /connectors → checkAdminAuth + requireAdminRole(OWNER_OR_ADMIN); GET /dashboard → no credential: identity only; a credential: checked, connectors for an admin, refused otherwise.
3. settings.js refreshConnectors + redeem.mjs send credentials.

## Done
- a3db9a97 fail-first test (test-connector-credit-cap §7): on main 35/43, 8 red (anonymous, member, moderator, wrong password, backups token all got the list; dashboard gave links to anyone)
- 052e0736 server fix + settings.js refreshConnectors + redeem.mjs credentials: credit-cap 43/43
- test-2fa-covers-admin-routes: GET /api/local/connectors added to its admin-route table
- Ran: test-connector-credit-cap, test-password-needs-2fa, test-federation-link, test-connector-public-url, test-node-config-public,
  test-gateway-real-client, test-2fa-covers-admin-routes, test-guest-view: all pass. tsc server 0. eslint: 0 errors in changed TS;
  the static/.mjs no-undef errors are older lines (globals not configured), none on changed lines.
- test-guest-view needed no edit: both routes are already in EVERY_ROUTE and its sweep checks leaks, not auth.
- PR: (being opened)
