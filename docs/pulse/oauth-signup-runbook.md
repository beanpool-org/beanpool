# The Pulse: OAuth Platform Signup Runbook

> **Target Audience:** Marty / BeanPool Node Operators  
> **Scope:** Registering developer applications on TikTok and Meta (Instagram) to enable verified creator channel integration in The Pulse.  
> **Status:** Research & Step-by-Step Operator Runbook (No code changes, no deployment).

---

## Non-Negotiables & Hard Rules

Before touching any developer portal, observe these four rules:

1. **A SEPARATE Meta App is Mandatory**  
   BeanPool's member login and custodial recovery run on Meta App `818892721251369`. **That app must NEVER be submitted for a content feature.** Submitting it to App Review risks account suspension or credential disruption for every member authenticating across nodes. Business verification lives at the **Meta Business Portfolio** level, so a newly created app under the same portfolio automatically inherits business verification status. *(Verification check: In [Meta Business Suite](https://business.facebook.com/) $\to$ Settings $\to$ Security Centre, verify the green checkmark on Business Verification, then create the new app under Accounts $\to$ Apps).*
2. **Do Not Request Facebook Permissions**  
   Personal Facebook profiles provide no public content enumeration API. Extra Facebook permissions (`pages_read_engagement`, `user_posts`, etc.) add audit friction, lengthen review queues, and increase rejection risk.
3. **Say "Creator", Never "Business", in Member-Facing Copy**  
   Community members resonate with "Instagram Creator" and "TikTok Creator". Never present "Business Account" in UI chips or modals.
4. **NEVER Commit Real Credentials to Git**  
   The BeanPool repository is public. All Client Keys, App IDs, and Client Secrets belong exclusively in `.env` files (which are gitignored) or secure device storage. This document contains placeholders only.

---

## Code Grounding: What BeanPool Expects

Grounding extracted from `apps/native/utils/pulse-oauth.ts`, `apps/server/src/routes/channels.ts`, `apps/native/app/auth/`, `apps/native/app/+native-intent.ts`, and `docs/pulse/reports/pulse-oauth.md`:

| Requirement | Value in Codebase | Source Reference |
| :--- | :--- | :--- |
| **TikTok Env Var** | `TIKTOK_CLIENT_KEY` (fallback: `TIKTOK_CLIENT_ID`) | [`apps/server/src/routes/channels.ts:L35`](file:///Users/marty/projects/beanpool/apps/server/src/routes/channels.ts#L35) |
| **Instagram Env Var** | `INSTAGRAM_APP_ID` | [`apps/server/src/routes/channels.ts:L36`](file:///Users/marty/projects/beanpool/apps/server/src/routes/channels.ts#L36) |
| **Server Secrets** | *None* (node holds no secrets; only advertises client IDs) | [`apps/server/src/routes/channels.ts:L29-L46`](file:///Users/marty/projects/beanpool/apps/server/src/routes/channels.ts#L29-L46) |
| **TikTok Redirect URI (Web)** | `https://beanpool.org/auth/tiktok` | [`apps/native/utils/pulse-oauth.ts:L274`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L274) |
| **TikTok Deep Link (App)** | `beanpool://auth/tiktok` | [`apps/native/utils/pulse-oauth.ts:L275`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L275) |
| **Instagram Redirect URI (Web)**| `https://beanpool.org/auth/instagram` | [`apps/native/utils/pulse-oauth.ts:L427`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L427) |
| **Instagram Deep Link (App)** | `beanpool://auth/instagram` | [`apps/native/utils/pulse-oauth.ts:L428`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L428) |
| **TikTok Scopes** | `user.info.basic,user.info.profile,video.list` | [`apps/native/utils/pulse-oauth.ts:L283`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L283) |
| **Instagram Scopes** | `instagram_business_basic` | [`apps/native/utils/pulse-oauth.ts:L468`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L468) |
| **PKCE Parameters** | SHA-256 (`code_challenge_method=S256`, 32-byte verifier) | [`apps/native/utils/pulse-oauth.ts:L145-L151`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L145-L151) |
| **Deep Link Interception** | `apps/native/app/+native-intent.ts` | [`apps/native/app/+native-intent.ts:L23-L38`](file:///Users/marty/projects/beanpool/apps/native/app/+native-intent.ts#L23-L38) |

### Architecture: What the App Sends vs. What the Server Receives
1. **Device-Side Token Grant:** The client app initiates OAuth in a browser session / Custom Tab (`WebBrowser.openAuthSessionAsync`).
2. **Device-Held Tokens:** The client app receives the authorization `code` and calls `https://open.tiktokapis.com/v2/oauth/token/`. Received `accessToken` and `refreshToken` are stored strictly in device hardware storage (`expo-secure-store` / `localStorage`).
3. **Verification Handshake:** The app queries `/v2/user/info/` to get the creator's username, then issues a cryptographic Ed25519 signed POST to the community node at `/api/member/channels/:id/verify-oauth` containing only `{ platform: 'tiktok', platformUsername }`.
4. **Node State:** The node verifies that `ctx.state.actor` owns the channel and that the platform username matches the registered handle. It sets `oauth_verified_at = now()` and `supports_autolist = 1`. **The node never receives or stores access tokens.**
5. **Content Ingestion:** The device client queries `https://open.tiktokapis.com/v2/video/list/` directly and submits items to `/api/member/pulse/oauth-ingest`.

> [!WARNING]
> ### CRITICAL FINDING: TikTok PKCE Token Exchange vs. Client Secret
> In [`apps/native/utils/pulse-oauth.ts:L304-L315`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L304-L315), the app exchanges the authorization code by calling `https://open.tiktokapis.com/v2/oauth/token/` with `client_key`, `code_verifier`, `code`, `grant_type=authorization_code`, and `redirect_uri`, but **omits** `client_secret` (assuming standard public client PKCE).  
> **Platform Discrepancy:** Official TikTok Open API v2 documentation states that `client_secret` is a mandatory parameter on `POST https://open.tiktokapis.com/v2/oauth/token/` even when PKCE (`code_verifier`) is supplied.  
> **Operational Impact:** When testing live with the TikTok Developer Portal, if TikTok rejects the code exchange with `invalid_request: client_secret is required`, you will need to note this discrepancy. (A server-side token exchange proxy or backend token relay may be needed if TikTok rejects secretless PKCE).
> 
> ### CRITICAL FINDING: Instagram Basic Display API Deprecation
> In [`apps/native/utils/pulse-oauth.ts:L434`](file:///Users/marty/projects/beanpool/apps/native/utils/pulse-oauth.ts#L434), the requested scopes are `user_profile,user_media`. Meta officially deprecated and retired the Instagram Basic Display API in December 2024. The modern path is the **Instagram API with Instagram Login** requiring an Instagram Creator/Business account and the permission `instagram_business_basic`.

---

## Blockers & Prerequisites Checked Up Front

### 1. Privacy Policy & Terms of Service URLs
*   **Requirement:** Both TikTok and Meta require public, unauthenticated, live Privacy Policy and Terms of Service URLs.
*   **Verification:** Verified live and active at:
    *   **Privacy Policy:** `https://beanpool.org/privacy.html` (also responds at `https://beanpool.org/privacy`)
    *   **Terms of Service:** `https://beanpool.org/terms.html` (also responds at `https://beanpool.org/terms`)
*   **Status:** **PASSED (No Blocker).**

### 2. Data Deletion Callback / Instructions
*   **Requirement:** Meta requires a Data Deletion Request URL (instructions page) or Callback endpoint.
*   **Solution for BeanPool:** Meta accepts a **Data Deletion Instructions URL**. Use:  
    `https://beanpool.org/privacy.html`  
    *(Section 4 explicitly documents "Account Eradication & Data Portability" via Settings $\to$ Reset / Wipe Identity and lists administrative contact `admin@beanpool.org`).*
*   **Status:** **PASSED (Use Instructions URL).**

### 3. Meta Business Verification (Australia)
*   **Requirement:** Meta requires verified legal identity for Advanced Access to Instagram APIs.
*   **Australian Documents Accepted by Meta:**
    1.  **Legal Business Name:** Australian Business Register (ABR) ABN Registration Certificate, ASIC Certificate of Registration, or ASIC Company Extract.
    2.  **Physical Address / Phone:** Utility bill (electricity, gas, water, internet) or Business Bank Statement (dated within 3 months) matching the legal name and physical address exactly.
    3.  **Verification Channel:** SMS code or official business domain email (`@beanpool.org`).
*   **Portfolio Inheritance:** A new Meta app created within the existing verified Meta Business Portfolio automatically inherits portfolio-level business verification.

### 4. Reviewer Access to an Invite-Gated App
*   **Risk:** BeanPool requires an invite code and community node pairing on first launch. If a reviewer launches the app and cannot proceed past the onboarding gate, the submission will be rejected with *"Could not test the integration"*.
*   **Resolution Protocol for App Review:**
    1.  **Generate Real Invite Codes on the Review Node:** Do NOT provide placeholder or invented codes. Generate fresh, genuine invite codes on the review node beforehand (e.g. via the node admin CLI or database).
    2.  **Provide Multiple Codes (Single-Use, No Expiry):** Invite codes **never expire, but are strictly single-use** (in [`apps/server/src/db/schema.sql`](file:///Users/marty/projects/beanpool/apps/server/src/db/schema.sql), `invite_codes` tracks `used_by` and `used_at` with no expiration column). Once consumed by an initial test, that code cannot be reused. Provide a list of several unconsumed invite codes in the reviewer instructions so multiple reviewers or repeated test runs do not get blocked.
    3.  **Clear Testing Instructions:** Provide clear test account credentials and specify exact navigation steps to reach the Channels screen (`Profile -> Creator Channels -> Connect TikTok / Connect Instagram`).
    4.  **Submit Screencast Video (MP4):** Submit an unedited MP4 video demonstrating the full user journey from clicking "Connect" to granting permissions and displaying the verified badge on The Pulse.

### 5. App Store Presence Requirements
*   **TikTok:** If registering as a "Mobile App", TikTok requires published Apple App Store or Google Play Store URLs for production review approval. However, registering with the **Web Platform** mode requires only the verified official website (`https://beanpool.org`). Furthermore, **TikTok Sandbox Mode** allows authorized test accounts to log in and sync immediately without any App Store listing or production review!
*   **Meta:** Meta accepts unreleased test builds, TestFlight links, and web staging environments for App Review as long as working test credentials and screencasts are provided.

---

## Platform 1: TikTok Developer App (Start Here)

TikTok has no account-type restriction and provides a functional Sandbox mode that works immediately without waiting for App Review.

```
[TikTok Developer Portal]
  ├── Log in with TikTok account (https://developers.tiktok.com)
  ├── Create App ("BeanPool Pulse")
  ├── Add Product: "Login Kit" & "Display API"
  ├── Configure Web Platform: https://beanpool.org/auth/tiktok
  ├── Add Test Accounts (Sandbox) -> Instant testing!
  └── Submit for App Review (when ready for public production)
```

### Step 1.1: Account Prerequisites
*   **Account Needed:** Any standard personal or business TikTok account.
*   **Action:** Go to [developers.tiktok.com](https://developers.tiktok.com/) and click **Log in** (top right) using your TikTok credentials.
*   **Developer Onboarding:** If prompted, enter your developer name, contact email (`admin@beanpool.org`), and agree to the Developer Terms of Service.

### Step 1.2: Portal Click-Path to Create App
1.  Navigate to **Manage apps** in the top navigation bar (or visit [developers.tiktok.com/apps](https://developers.tiktok.com/apps)).
2.  Click the **Create an app** button.
3.  Fill in the basic app details (see exact fields below).
4.  Click **Save and continue**.

### Step 1.3: Field-by-Field Values for BeanPool
| Portal Field | Exact Value to Enter | Notes / Rationale |
| :--- | :--- | :--- |
| **App Name** | `BeanPool` (or `BeanPool Pulse`) | Must not contain infringing trademarks other than BeanPool. |
| **App Description** | `Decentralized community mutual credit and local creator syndication platform.` | 10–200 characters explaining app purpose. |
| **App Icon** | Upload `apps/website/bean.png` | Square icon, min 100×100 px, transparent/clean background. |
| **Category** | `Social` or `Utilities` | Matches platform classification. |
| **Terms of Service URL** | `https://beanpool.org/terms.html` | Live, publicly accessible terms. |
| **Privacy Policy URL** | `https://beanpool.org/privacy.html` | Live, publicly accessible privacy policy. |
| **Target Platform** | Check **Web** (and/or iOS/Android) | Enable **Web** to configure the redirect URI without requiring published app store links immediately. |

### Step 1.4: Add Products & Permissions (Scopes)
1.  In your app dashboard, navigate to **Products** (left sidebar) $\to$ **Add products**.
2.  Add **Login Kit**:
    *   Click **Configure** under Login Kit.
    *   Under **Redirect Domain / URI**, enter:  
        `https://beanpool.org/auth/tiktok`
    *   Under **Scopes**, select:
        *   `user.info.basic` *(Read avatar and display name — Auto-granted in Sandbox)*
        *   `user.info.profile` *(Read account username — Auto-granted in Sandbox; required to verify channel ownership against registered handles)*
3.  Add **Display API** (or Content Kit / Video Kit depending on current UI):
    *   Select Scope: `video.list` *(Read public video list — Auto-granted in Sandbox for test users; gated by review in Production)*.

### Step 1.5: Locate Credentials & Update `.env`
1.  In the left sidebar, click **App Details** or **Basic info**.
2.  Locate **Client Key** (public identifier) and **Client Secret**.
3.  On your local server / node deployment, open your `.env` file (gitignored):
    ```bash
    # TikTok Integration for The Pulse
    TIKTOK_CLIENT_KEY=your_tiktok_client_key_here
    ```
4.  Restart the Node server. Verify availability:
    ```bash
    curl http://localhost:3000/api/pulse/oauth/config
    # Expected: {"tiktok":{"enabled":true,"clientKey":"your_tiktok_client_key_here"},"instagram":{"enabled":false,"appId":null}}
    ```

### Step 1.6: Sandbox & Test Mode (Immediate Testing)
1.  In the left sidebar under the app, click **Sandbox** $\to$ **Test accounts**.
2.  Click **Add account** and enter your personal TikTok handle (e.g. `@marty_food`).
3.  Accept the authorization invitation on your TikTok mobile app (in TikTok Inbox $\to$ System notifications).
4.  Once accepted, your account can log in via BeanPool's "Connect TikTok" flow on mobile or web immediately without completing App Review!

### Step 1.7: Production App Review Submission
When ready to open TikTok OAuth to all community members:
1.  In your TikTok App dashboard, click **Submit for review**.
2.  **Screencast Video:** Upload a short MP4 ($\le$ 50MB) showing:
    *   Opening BeanPool native app or web interface.
    *   Navigating to Profile $\to$ Creator Channels $\to$ Connect TikTok.
    *   The TikTok OAuth dialog requesting `user.info.basic`, `user.info.profile`, and `video.list`.
    *   Returning to BeanPool with the `✓ Verified` badge and seeing the synced videos in The Pulse feed.
3.  **Scope Justifications:**
    *   `user.info.basic`: *"Used to read the creator's avatar and display name to render their creator profile card."*
    *   `user.info.profile`: *"Used to read the authenticated member's account username to verify channel ownership against their registered channel handle, ensuring handles match even when the creator's display name differs from their username."*
    *   `video.list`: *"Allows verified community creators to automatically syndicate their latest public video links to their neighborhood community feed."*
4.  **Review Timeline:** Typically 2 to 5 business days.
5.  **Common Rejection Reasons:** Video doesn't show the permission consent screen; Privacy policy doesn't mention TikTok data; Redirect URI mismatch.
6.  **Token Lifecycles:**
    *   `access_token`: 86,400 seconds (24 hours).
    *   `refresh_token`: 31,536,000 seconds (365 days).
    *   *BeanPool automatically refreshes tokens on device via `refreshTokenIfNeeded` before sync.*
7.  **Cost:** Free ($0).

---

## Platform 2: Instagram API with Instagram Login (Meta)

Meta requires an Instagram Professional (Creator or Business) Account, a Meta Business Portfolio with business verification, and App Review for Advanced Access.

```
[Meta for Developers Portal]
  ├── Prerequisites: Instagram Creator Account + Meta Business Portfolio
  ├── Verify Business Portfolio in Security Centre (Inherited by new app)
  ├── Create App ("BeanPool Pulse") -> Type: Business / Other
  ├── Add Product: "Instagram API with Instagram Login" / "Instagram Graph API"
  ├── Configure Redirect URI: https://beanpool.org/auth/instagram
  ├── Test in Development Mode with Test Users
  └── Submit App Review for Advanced Access (`instagram_business_basic`)
```

### Step 2.1: Account Prerequisites
1.  **Instagram Creator Account:** Convert your Instagram account to a Professional Creator account (In Instagram Mobile App $\to$ Settings $\to$ Account type and tools $\to$ Switch to professional account $\to$ Choose **Creator**).
2.  **Meta Business Portfolio:** Ensure you have access to your Meta Business Portfolio at [business.facebook.com](https://business.facebook.com/).
3.  **Business Verification Status Check:**
    *   Go to [Meta Business Suite Settings](https://business.facebook.com/settings) $\to$ **Security Centre**.
    *   Confirm **Business Verification** shows "Verified" (green checkmark). If not, upload your Australian ABN Certificate / ASIC Extract and utility bill.

### Step 2.2: Portal Click-Path to Create App
1.  Go to [developers.facebook.com](https://developers.facebook.com/) and log in.
2.  Click **My Apps** (top right) $\to$ **Create App**.
3.  **Use Case / App Type:**
    *   Select **Other** $\to$ Next.
    *   Select **Business** (or **Consumer** if prompted for single use case; Business is recommended for Graph API access) $\to$ Next.
4.  **App Details:**
    *   **App Name:** `BeanPool Pulse` (Must not contain the word "Instagram" or "Facebook").
    *   **App Contact Email:** `admin@beanpool.org`
    *   **Business Portfolio:** Select your verified Meta Business Portfolio.
5.  Click **Create App** and enter your password.

### Step 2.3: Field-by-Field Values in App Settings
Navigate to **App settings** $\to$ **Basic** (left sidebar):
| Portal Field | Exact Value to Enter | Notes / Rationale |
| :--- | :--- | :--- |
| **Display Name** | `BeanPool Pulse` | Clean consumer-facing name. |
| **App Domains** | `beanpool.org` | Root domain. |
| **Privacy Policy URL** | `https://beanpool.org/privacy.html` | Must be live HTTPS. |
| **Terms of Service URL**| `https://beanpool.org/terms.html` | Must be live HTTPS. |
| **Data Deletion Instructions URL** | `https://beanpool.org/privacy.html` | Section 4 provides self-service wipe instructions. |
| **Category** | `Community Management` or `Utilities` | Accurate categorization. |
| **App Icon** | Upload `bean.png` (1024×1024 px) | High-resolution brand icon. |

Click **Save Changes**.

### Step 2.4: Add Instagram Product & Configure Redirect URIs
1.  In the left sidebar, click **Dashboard** or **Add Product**.
2.  Find **Instagram API with Instagram Login** (or **Instagram Graph API**) and click **Set up**.
3.  Under Instagram Settings $\to$ **OAuth Settings / Redirect URIs**:
    *   **Valid OAuth Redirect URIs:**  
        `https://beanpool.org/auth/instagram`
4.  Click **Save Changes**.

### Step 2.5: Locate Credentials & Update `.env`
1.  In the left sidebar, click **App settings** $\to$ **Basic**.
2.  Locate **App ID** (at top of page).
3.  On your local server / node deployment, open your `.env` file (gitignored):
    ```bash
    # Instagram Integration for The Pulse
    INSTAGRAM_APP_ID=your_meta_app_id_here
    ```
4.  Restart the Node server. Verify availability:
    ```bash
    curl http://localhost:3000/api/pulse/oauth/config
    # Expected: {"tiktok":{"enabled":true,...},"instagram":{"enabled":true,"appId":"your_meta_app_id_here"}}
    ```

### Step 2.6: Development Mode, Standard Access & Instagram Tester Setup
> [!IMPORTANT]
> ### CRITICAL REQUIREMENT: Instagram Tester Role under Standard Access
> Under **Standard Access**, `graph.instagram.com` refuses ALL data reads for any Instagram account that has not been explicitly assigned the Instagram Tester role on the app — even while `api.instagram.com` still issues a completely valid OAuth access token!  
> **Symptom:** Without the Tester role, every endpoint and field combination on `graph.instagram.com` fails with:  
> `{"error":{"message":"Unsupported request - method type: get","type":"IGApiException","code":100}}`  
> This generic error message names nothing useful and masks the underlying permissions gate. **A valid OAuth access token proves nothing about data access under Standard Access.**

**Required Setup Steps:**
1. In the Meta Developer Portal, go to **Instagram API with Instagram Login** (left menu) $\to$ **API setup with Instagram login**.
2. Scroll to section **2. Generate access tokens** and click **Add account** (or navigate to **App roles** $\to$ **Roles** $\to$ **Instagram Testers** $\to$ **Add Instagram Testers**).
3. Enter your Instagram Creator account username and send the tester invitation.
4. Open the Instagram mobile app on your phone, navigate to **Settings and privacy** $\to$ **For professionals** (or **Creator tools and controls**) $\to$ **Apps and websites** $\to$ **Tester invitations**, and tap **Accept**.
5. Once accepted, your account can successfully read profile information and media items via BeanPool in Development Mode and Standard Access.

### Step 2.7: App Review for Advanced Access (Production)
To allow any community creator to connect their Instagram Creator account without manual tester assignment:
1.  Navigate to **App Review** $\to$ **Permissions and Features**.
2.  Locate `instagram_business_basic` (and `instagram_basic` if applicable) and click **Request Advanced Access**.
3.  **Submission Form Details:**
    *   **Screencast Video:** Record an unedited MP4 demonstrating:
        *   App onboarding/login with a freshly generated real review invite code.
        *   Navigating to Profile $\to$ Creator Channels $\to$ Connect Instagram.
        *   Meta OAuth consent screen.
        *   Returning to BeanPool with channel verification tick and seeing synced items on The Pulse feed.
    *   **Step-by-Step Testing Instructions:**
        *   *Step 1:* Open BeanPool web app or mobile staging build.
        *   *Step 2:* Enter one of the pre-generated single-use invite codes provided in the review notes (e.g. `INVITE-XXXX-YYYY`).
        *   *Step 3:* Tap Profile $\to$ Creator Channels $\to$ Connect Instagram.
        *   *Step 4:* Log in and grant permission on the Instagram login screen.
4.  **Review Timeline:** Typically 5 to 20 days.
5.  **Common Rejection Reasons:** Reviewer could not log in (dead, already-used, or fabricated invite code); Screencast missing; Requesting unnecessary Facebook permissions.
6.  **Ongoing Obligations (Annual Data Use Checkup - DUC):**
    *   Meta requires an **annual Data Use Checkup (DUC)**. You will receive an alert in the App Dashboard 60 days prior. An admin must certify that data handling complies with Meta Platform Terms, or API access is automatically revoked.
7.  **Cost:** Free ($0).

---

## Operator Quick-Checklist (Step-by-Step Flow)

Print or check off this list during registration:

### Phase 1: TikTok Registration (30 minutes)
- [ ] 1. Log into [developers.tiktok.com](https://developers.tiktok.com/) with personal TikTok account.
- [ ] 2. Create app `BeanPool Pulse` with icon from `apps/website/bean.png`.
- [ ] 3. Enter Terms URL (`https://beanpool.org/terms.html`) and Privacy Policy URL (`https://beanpool.org/privacy.html`).
- [ ] 4. Add **Login Kit** product; enter Redirect URI `https://beanpool.org/auth/tiktok`.
- [ ] 5. Add **Login Kit** and **Display API** products; select scopes `user.info.basic`, `user.info.profile`, and `video.list`.
- [ ] 6. Copy **Client Key** to `.env` as `TIKTOK_CLIENT_KEY=...`.
- [ ] 7. In Sandbox $\to$ Test accounts, add your personal TikTok handle.
- [ ] 8. Accept the invitation in TikTok inbox and test the connection in BeanPool!

### Phase 2: Meta / Instagram Registration (45 minutes)
- [ ] 1. Switch personal Instagram account to **Creator Account**.
- [ ] 2. Confirm Meta Business Portfolio is verified in [Business Suite Security Centre](https://business.facebook.com/settings/security).
- [ ] 3. In [developers.facebook.com](https://developers.facebook.com/), create a NEW Business App `BeanPool Pulse` under the verified portfolio.
- [ ] 4. Enter App Domains (`beanpool.org`), Privacy Policy, Terms of Service, and Data Deletion URL (`https://beanpool.org/privacy.html`).
- [ ] 5. Add **Instagram API with Instagram Login**; enter Redirect URI `https://beanpool.org/auth/instagram`.
- [ ] 6. Copy **App ID** to `.env` as `INSTAGRAM_APP_ID=...`.
- [ ] 7. Under **API setup with Instagram login $\to$ 2. Generate access tokens**, click **Add account** to assign the Instagram Tester role (required for data access under Standard Access), and accept in Instagram app under **Settings $\to$ Creator tools and controls $\to$ Apps and websites $\to$ Tester invitations**.
- [ ] 8. Test the connection in Development Mode / Standard Access!

---

## Sources & Documentation Links

*   [TikTok for Developers Portal](https://developers.tiktok.com/)
*   [TikTok Login Kit v2 Documentation](https://developers.tiktok.com/doc/login-kit-web)
*   [TikTok Display API Reference](https://developers.tiktok.com/doc/display-api-get-started)
*   [Meta for Developers Portal](https://developers.facebook.com/)
*   [Meta Business Suite & Business Verification](https://business.facebook.com/settings/security)
*   [Meta App Review Guidelines & Screencast Best Practices](https://developers.facebook.com/docs/development/release/app-review/)
*   [Meta Data Use Checkup (DUC) Overview](https://developers.facebook.com/docs/development/compliance/data-use-checkup/)
*   [Instagram API with Instagram Login Reference](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/)
