# Two-Factor Authentication (2FA / TOTP)

Admin 2FA for BeanPool node operators. Protects the admin settings UI with
standard RFC 6238 time-based one-time passwords (Google Authenticator, Authy,
Apple Keychain, 1Password, etc.).

**Issue:** #135 · **Initial PR:** #198 · **Bug-fix PR:** #205
**Direct-to-main fixes:** `b04b746`, `4799855`, `f7030c6`

---

## Architecture overview

```
┌──────────────────┐     ┌───────────────────────────────────────────┐
│  Browser (Admin)  │────▶│  POST /api/local/verify-password          │
│  settings.js      │     │  ┌─ password OK? ──┐                     │
│                   │     │  │  totpEnabled?    │                     │
│  ┌─ login-password│     │  │  ├── no  → 200 { success }           │
│  ├─ login-totp    │     │  │  └── yes → need X-Admin-TOTP         │
│  └─ 2FA session ──│────▶│  │       ├── missing → 401 totpRequired │
│     (sessionStore)│     │  │       ├── valid   → 200 + tfaSession  │
│                   │     │  │       └── invalid → 401              │
│  adminHeaders()  ─│──┐  │  └──────────────────┘                    │
│  X-Admin-Password │  │  └───────────────────────────────────────────┘
│  X-Admin-2FA-Sess │  │
└──────────────────┘  │  ┌───────────────────────────────────────────┐
                      └─▶│  checkAdminAuth()                         │
                         │  1. verify password (async scrypt)         │
                         │  2. validate CSRF token (if present)       │
                         │  3. if totpEnabled:                        │
                         │     a. X-Admin-2FA-Session valid? → skip   │
                         │     b. else check X-Admin-TOTP / body      │
                         │  4. return true/false                      │
                         └───────────────────────────────────────────┘
```

---

## Files

| File | Purpose |
|------|---------|
| `apps/server/src/totp.ts` | Zero-dependency RFC 6236 TOTP engine |
| `apps/server/src/admin-auth.ts` | `checkAdminAuth()`, CSRF tokens, WS tickets, 2FA session tokens |
| `apps/server/src/routes/settings.ts` | 2FA admin endpoints (`/2fa/status`, `/2fa/setup`, `/2fa/verify`, `/2fa/disable`) |
| `apps/server/src/routes/community.ts` | `POST /api/local/verify-password` login endpoint |
| `apps/server/src/routes/admin.ts` | `POST /api/local/admin/ws-ticket` WebSocket ticket endpoint |
| `apps/server/static/settings.js` | Frontend login flow, 2FA management UI, `adminHeaders()` |
| `apps/server/static/settings.html` | Login form (including hidden TOTP field), 2FA setup/disable UI |

---

## TOTP engine (`totp.ts`)

Zero external dependencies — uses only Node.js `crypto` module.

### Functions

| Function | Signature | Description |
|----------|-----------|-------------|
| `generateTotpSecret()` | `() → string` | Returns a random 20-byte Base32-encoded secret |
| `generateTotpCode(secret, time?)` | `(string, number?) → string` | Generates a 6-digit TOTP code for the current (or given) time step |
| `verifyTotpCode(code, secret)` | `(string, string) → boolean` | Verifies a code against ±1 time step (30s window each side = 90s total tolerance) |
| `generateBackupCodes(count)` | `(number) → string[]` | Generates `count` random 8-character alphanumeric backup codes |
| `hashBackupCode(code)` | `(string) → string` | SHA-256 hex digest of a backup code (stored at rest) |
| `verifyAndFindBackupCodeHash(code, hashes)` | `(string, string[]) → number` | Finds matching hash index using `crypto.timingSafeEqual`; returns `-1` if none match |
| `generateOtpauthUri(secret, label, issuer)` | `(string, string, string) → string` | Builds `otpauth://totp/...` URI for QR code generation |

### Constants

| Constant | Value | Notes |
|----------|-------|-------|
| Time step | 30 seconds | RFC 6238 standard |
| Drift tolerance | ±1 step | Accepts codes from `t-1`, `t`, and `t+1` |
| Code length | 6 digits | HMAC-SHA1 based, uses `crypto.timingSafeEqual` for constant-time comparison |
| Secret length | 20 bytes | Base32-encoded (32 characters) |
| Backup code length | 8 characters | Alphanumeric, stored as SHA-256 hashes |
| Default backup code count | 8 | Set in `/2fa/setup` endpoint |

---

## Config properties (`local-config.json`)

These properties are persisted in the node's `data/local-config.json`:

| Property | Type | Description |
|----------|------|-------------|
| `totpEnabled` | `boolean` | Whether 2FA is active on this node |
| `totpSecret` | `string` | The active TOTP secret (Base32). Set after successful `/2fa/verify` |
| `totpPendingSecret` | `string` | Pending secret from `/2fa/setup` — not yet verified. Cleared on verify or disable |
| `totpBackupCodesHashes` | `string[]` | SHA-256 hex digests of remaining backup codes |
| `totpPendingBackupCodesHashes` | `string[]` | Backup code hashes generated during setup — promoted to active on successful `/2fa/verify` |

> **Important:** `totpPendingSecret` exists to prevent a security gap: calling `/2fa/setup`
> must NOT overwrite an already-active `totpSecret`, otherwise an attacker who knows the
> password could disarm 2FA by initiating a new setup.

---

## API endpoints

### `GET /api/local/admin/2fa/status`

**Auth:** Password-only (no TOTP required). This is deliberate — the UI needs to know
whether 2FA is enabled *before* the user can provide a TOTP code. See [Bugs fixed](#bugs-encountered-and-fixed).

**Response:**
```json
{
  "success": true,
  "totpEnabled": true,
  "hasSecret": true,
  "pendingSetup": false,
  "backupCodesRemaining": 8
}
```

---

### `POST /api/local/admin/2fa/setup`

**Auth:** Full `checkAdminAuth()` (password + TOTP if already enabled).

Generates a new pending secret, QR code, and 8 backup codes. Does NOT
overwrite an active `totpSecret`.

**Response:**
```json
{
  "success": true,
  "qrCodeDataUrl": "data:image/png;base64,...",
  "formattedSecret": "ABCD EFGH IJKL MNOP QRST UVWX YZ23 4567",
  "backupCodes": ["a1b2c3d4", "e5f6g7h8", "..."]
}
```

> ⚠️ **Backup codes are shown once.** They are returned as plaintext here but stored
> on disk as SHA-256 hashes only. There is no way to retrieve them after this response.

---

### `POST /api/local/admin/2fa/verify`

**Auth:** Full `checkAdminAuth()` (password only at this point — 2FA not yet active).

**Request body:** `{ "code": "123456" }`

Verifies the 6-digit code against `totpPendingSecret`. On success:
- Moves `totpPendingSecret` → `totpSecret`
- Sets `totpEnabled = true`
- Stores `totpBackupCodesHashes`
- Clears `totpPendingSecret`

**Response (success):**
```json
{ "success": true, "message": "2FA is now active." }
```

**Response (failure):**
```json
{ "success": false, "error": "Invalid code. Check your authenticator and try again." }
```

> **Key fix:** The frontend sends `{ code }` and the backend accepts either
> `body.code` or `body.totpCode` defensively. An earlier bug had the frontend
> sending `{ totpCode }` while the backend extracted `{ code }`, resulting in
> verification always failing.

---

### `POST /api/local/admin/2fa/disable`

**Auth:** Full `checkAdminAuth()` (password + TOTP required since 2FA is currently active).

**Request body:** `{ "code": "123456" }`

On success:
- Sets `totpEnabled = false`
- Clears `totpSecret`, `totpPendingSecret`, `totpBackupCodesHashes`

---

### `POST /api/local/verify-password` (login)

**Auth:** Self-contained password + TOTP verification (does not use `checkAdminAuth`).

**Flow:**
1. Verify password from body or `X-Admin-Password` header
2. If `totpEnabled` is `true`:
   - Check `X-Admin-TOTP` header or `body.totpCode`
   - If missing → `401 { error: "2FA code required", totpRequired: true }`
   - If invalid → `401 { error: "Invalid 2FA code", totpRequired: true }`
   - If valid → issue a 2FA session token
3. Return `{ success: true, tfaSessionToken: "..." }` (token omitted when 2FA is off)

---

## 2FA session tokens

**Problem:** TOTP codes expire every 30 seconds. The admin UI makes ~15 different API
calls after login (dashboard, gateway, thresholds, 2FA status, etc.). You can't
re-enter a TOTP code for every call.

**Solution:** After successful login with password + TOTP, the server issues a
**4-hour sliding-window session token**. The frontend stores it in `sessionStorage`
and sends it as `X-Admin-2FA-Session` on every subsequent request.

### Implementation (`admin-auth.ts`)

| Function | Description |
|----------|-------------|
| `issue2faSessionToken()` | Creates a 32-byte hex token, stores in `tfaSessionTokens` Map with expiry |
| `isValid2faSession(token)` | Returns `true` if token exists and not expired. Refreshes TTL on valid use (sliding window) |
| `revoke2faSession(token)` | Deletes the token (for logout) |

### How `checkAdminAuth()` uses it

```
1. Verify password (async scrypt)       → 401 if invalid
2. Validate CSRF token (if present)     → 403 if invalid
3. If totpEnabled && totpSecret:
   a. Read X-Admin-2FA-Session header
   b. If session token is valid → SKIP TOTP check ✅
   c. Else read X-Admin-TOTP header / body.totpCode
      - Missing → 401 { totpRequired: true }
      - Invalid → 401 { totpRequired: true }
      - Valid   → pass ✅
4. Return true
```

### Token lifecycle

| Constant | Value |
|----------|-------|
| `TFA_SESSION_TTL_MS` | 4 hours (14,400,000 ms) |
| Token size | 32 bytes (64 hex characters) |
| Cleanup | Opportunistic pruning on `issue2faSessionToken()` calls |
| Persistence | In-memory only — survives during process lifetime, cleared on restart |
| Sliding window | TTL refreshed on every valid `isValid2faSession()` call |

---

## Frontend flow (`settings.js`)

### `adminHeaders(extra?)`

Central helper that returns the correct headers for all admin API calls:

```javascript
function adminHeaders(extra) {
    const h = { 'X-Admin-Password': authToken };
    if (tfaSessionToken) h['X-Admin-2FA-Session'] = tfaSessionToken;
    if (extra) Object.assign(h, extra);
    return h;
}
```

All admin `fetch()` calls use `adminHeaders()` or `adminHeaders({ 'Content-Type': 'application/json' })`.

### Login flow

```
1. User enters password → clicks "Unlock Settings"
2. POST /api/local/verify-password  (password only)
3. If 401 { totpRequired: true }:
   a. Show hidden #login-2fa-field div (TOTP input)
   b. Focus the TOTP input
   c. Show "2FA code required" error message
4. User enters 6-digit code → clicks "Unlock Settings" again
5. POST /api/local/verify-password  (password + totpCode)
6. On success:
   a. Store authToken in sessionStorage('bp-admin-token')
   b. Store tfaSessionToken in sessionStorage('bp-2fa-session')
   c. All subsequent API calls use adminHeaders() which includes both
```

### 2FA status badge (`load2faStatus()`)

The UI shows one of three states:

| State | Badge | Box shown |
|-------|-------|-----------|
| Enabled | 🟢 "Active (2FA On)" | `#totp-box-enabled` — shows backup code count + disable form |
| Disabled | ⚪ "Disabled" | `#totp-box-disabled` — shows "Setup 2FA" button |
| Error | 🔴 "Error Checking" | Badge only — API call failed |

> **Key fix:** The frontend was checking `data.enabled` but the backend sends
> `data.totpEnabled`. This property name mismatch caused 2FA to always
> appear disabled. Similarly, `data.remainingBackupCodes` → `data.backupCodesRemaining`.

---

## WebSocket ticket authentication

The admin logs WebSocket (`wss://.../ws/logs`) previously sent the raw admin password
in the URL query string (`?auth=Sunshine_1`), exposing it in browser console errors,
server access logs, and proxy logs.

### Current flow

```
1. Frontend: POST /api/local/admin/ws-ticket  (adminHeaders())
   → Server issues single-use 30-second ticket
   → Returns { ticket: "a8f3..." }

2. Frontend: new WebSocket(`wss://.../ws/logs?ticket=${ticket}`)

3. Server upgrade handler:
   a. Check ?ticket param → isValidWsTicket() → consume (single-use)
   b. Fallback: check ?auth param (legacy, logs security deprecation warning)
   c. Neither → 401, socket destroyed
```

### WS ticket implementation (`admin-auth.ts`)

| Constant | Value |
|----------|-------|
| `WS_TICKET_TTL_MS` | 30 seconds |
| Cleanup interval | 60 seconds (unref'd, won't keep process alive) |
| Token size | 32 bytes (64 hex characters) |
| Single-use | Yes — consumed immediately on validation |

---

## Bugs encountered and fixed

This section documents integration bugs discovered during the initial deployment
and manual testing of the 2FA feature. Recording them here so future agents
understand the design constraints.

### 1. `totpCode` vs `code` key mismatch

**PR #205, commit `703ecfd`**

The frontend `settings.js` sent `{ totpCode: code }` in the verify request body,
but the backend `settings.ts` extracted `const { code } = ctx.request.body`.
Result: `code` was always `undefined` → verification always failed.

**Fix:** Backend now extracts `body.code || body.totpCode`. Frontend sends `{ code }`.

### 2. Double `/local/local/` path prefix

**PR #205, commit `703ecfd`**

`settings.js` used `${API}/local/admin/2fa/status` where `API = '/api/local'`,
producing `/api/local/local/admin/2fa/status` → 404.

**Fix:** Removed the extra `/local` segment from all 2FA and ws-ticket paths in `settings.js`.

### 3. `includeInactive` filter bypass in `posts.ts`

**PR #205, commit `703ecfd` + `4f1ff3c`**

The `includeInactive` flag was added to `PostFilter` but initially placed outside
the main guard in `getPosts()`, allowing it to bypass holiday-mode filters. A later
CR round also found the `else` branch (when `filter.id` is set) unconditionally
appended `AND p.active = 1`, making `includeInactive` ineffective for ID-based lookups.

**Fix:** Nested `includeInactive` inside the existing guard. Updated `else` branch
to check `!filter?.includeInactive`.

### 4. UI limbo state after failed setup

**Commit `b04b746`**

When 2FA setup verification failed (due to bug #1), the server retained
`pendingSetup: true`. On page refresh, `load2faStatus()` skipped showing
the "Setup 2FA" button when `pendingSetup` was `true`:

```javascript
if (!data.pendingSetup) {     // pendingSetup was TRUE → block skipped
    boxDisabled?.classList.remove('hidden');  // button never shown!
}
```

**Fix:** Always show the disabled box (with "Setup 2FA" button) when `totpEnabled` is `false`,
regardless of `pendingSetup` state.

### 5. Chicken-and-egg auth on 2FA status endpoint

**Commit `4799855`**

`GET /api/local/admin/2fa/status` used `checkAdminAuth()` which requires TOTP
when 2FA is enabled. But the UI needs this endpoint to determine IF 2FA is
enabled — before the user has entered any code. Result: status call returned 401,
UI fell back to showing "Disabled".

**Fix:** Status endpoint now uses password-only inline verification (no TOTP enforcement).
The response only contains non-sensitive metadata.

### 6. Frontend property name mismatch

**Commit `4799855`**

`load2faStatus()` checked `data.enabled` but the backend sends `data.totpEnabled`.
Also `data.remainingBackupCodes` vs `data.backupCodesRemaining`. Result: 2FA always
appeared disabled even when active.

**Fix:** Updated frontend to use the correct property names.

### 7. Login endpoint didn't check TOTP

**Commit `f7030c6`**

`POST /api/local/verify-password` only verified the password — it never checked
`totpCode` even when 2FA was enabled. Users could log in without 2FA.

**Fix:** Login endpoint now checks `config.totpEnabled` and requires TOTP code.
On success, issues a 2FA session token so subsequent API calls skip TOTP re-entry.

### 8. No 2FA session token — every API call needed TOTP

**Commit `f7030c6`**

`checkAdminAuth()` required a valid TOTP code on EVERY admin API call. Since TOTP
codes expire every 30 seconds, the UI couldn't make the ~15 API calls needed after
login. All returned 401.

**Fix:** Added the 2FA session token system. After successful password+TOTP login,
a 4-hour session token is issued. `checkAdminAuth()` accepts the session token as
proof of prior TOTP verification.

---

## Security considerations

1. **Backup codes are single-use.** Once a backup code is used for authentication,
   its hash is removed from the stored array. CSRF validation runs BEFORE backup
   code consumption to prevent burning codes on CSRF failures.

2. **Tarpit on failed 2FA.** Invalid TOTP codes increment the global
   `adminAuthFailures` counter, which applies a progressive delay (up to 5s)
   to all subsequent login attempts. This prevents TOTP brute-force attacks.

3. **Session tokens are in-memory only.** A server restart invalidates all
   active sessions, requiring re-authentication with password + TOTP.

4. **Password never in URLs.** The WebSocket ticket system eliminates raw
   passwords from URL query strings. Legacy `?auth=` fallback exists but logs
   a security deprecation warning.

5. **`totpPendingSecret` isolation.** Initiating a new 2FA setup does NOT
   overwrite the active `totpSecret`. This prevents an attacker who has the
   password from disarming 2FA by starting a new setup flow.

---

## Testing

Test suite: `scripts/test-totp-admin-2fa.ts` (included in `scripts/test-all.sh`).

### Manual testing checklist

1. **Enable 2FA:** Settings → Identity → "Setup 2FA" → scan QR → enter code → save backup codes
2. **Verify login:** Log out → enter password → see "2FA code required" → enter TOTP → success
3. **Verify badge:** After login, 2FA section shows "Active (2FA On)" with green badge
4. **Verify session:** Navigate between tabs — no re-authentication needed
5. **Backup code login:** Log out → enter password → enter a backup code instead of TOTP → success
6. **Disable 2FA:** Settings → "Disable Two-Factor Auth" → enter current TOTP code → confirm
7. **Verify disabled:** Badge shows "Disabled", "Setup 2FA" button reappears
8. **Log out and back in:** No TOTP prompt when 2FA is disabled

### Known limitations

- **WebSocket connections through Cloudflare Tunnel:** The `wss://` upgrade may be
  refused by some Cloudflare Tunnel configurations. This is an infrastructure issue,
  not a 2FA bug. The ticket auth works correctly — the connection itself fails at
  the transport level.

- **No 2FA on mobile app:** The native app uses member keypair auth, not admin password
  auth. 2FA only applies to the admin settings UI accessed via browser.
