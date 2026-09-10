# Economy and Marketplace: Native vs PWA Parity Audit

> **⚠️ Historical.** Keeper (social/guardian) recovery was scrapped in September 2026.
> This document describes it as live because that was true when it was written.
> The only recovery paths now are the member's 12 words and SSO (native only).
> See [keeper-recovery-parked.md](../keeper-recovery-parked.md).

## Parity table

| Feature | Native | PWA | Verdict |
| :--- | :--- | :--- | :--- |
| **Credit Position Indicator** | `<CreditBar />` anchored non-linear curve, zero-pinned at 50% ([CreditBar.tsx:1-200](file:///Users/marty/projects/beanpool/apps/native/components/CreditBar.tsx#L1-L200)) | `<CreditBar />` direct CSS port, identical non-linear anchor math ([CreditBar.tsx:1-246](file:///Users/marty/projects/beanpool/apps/pwa/src/components/CreditBar.tsx#L1-L246)) | **PARITY** |
| **Trust Tiers & Floor Progression** | Continuous sliding floor, tier thresholds 0, 180, 580, 1380 ([ledger.tsx:58-70](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L58-L70)) | Continuous sliding floor, tier thresholds 0, 180, 580, 1380 ([LedgerPage.tsx:25-37](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L25-L37)) | **DIVERGENT** (Newcomer floor copy mismatch) |
| **Direct Peer Transfer (Send)** | Signed transfer modal with instant balance check ([ledger.tsx:406-490](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L406-L490)) | Slide-over send modal with instant balance check ([LedgerPage.tsx:161-315](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L161-L315)) | **PARITY** (UI mechanics), **BROKEN** (Copy gates) |
| **Send Gating Enforcement** | Checks `balance > 0`; copy says any positive balance sends ([ledger.tsx:406, 565](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L406)) | Checks `balance > 0`; copy says any positive balance sends ([LedgerPage.tsx:161, 395](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L161)) | **DIVERGENT** (Server rejects without `earnedCredit > 0`) |
| **Next-Tier Partner Estimation** | Calculates `partnersToNext` using stale `PER_COUNTERPARTY_CAP = 5000` ([ledger.tsx:33, 426](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L33)) | Calculates `partnersToNext` using stale `PER_COUNTERPARTY_CAP = 5000` ([LedgerPage.tsx:44, 180](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L44)) | **DIVERGENT** (Server canonical is `500`) |
| **Demurrage / Circulation Display** | Ticks at 200, 500, 1000 with tier fee brackets ([ledger.tsx:34](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L34)) | Ticks at 200, 500, 1000 with tier fee brackets ([LedgerPage.tsx:49-55](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L49-L55)) | **PARITY** |
| **Ledger Transaction History** | Paginated list with type, amount, memo, timestamp ([ledger.tsx:600-750](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L600-L750)) | Paginated list with type, amount, memo, timestamp ([LedgerPage.tsx:480-620](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L480-L620)) | **PARITY** |
| **CSV Export** | Exports `transactionsCsv` only ([ledger.tsx:328-350](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/ledger.tsx#L328-L350)) | Exports both `beanpool_balances.csv` and `beanpool_transactions.csv` ([LedgerPage.tsx:633-680](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/LedgerPage.tsx#L633-L680)) | **DIVERGENT** |
| **Marketplace Browse & Search** | Grid/list view, keyword search, debounced input ([index.tsx:820-950](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/index.tsx#L820-L950)) | Grid/list view, keyword search, debounced input ([MarketplacePage.tsx:1750-1850](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L1750-L1850)) | **PARITY** |
| **Marketplace Categories** | 16 categories, labels e.g. "Food", "Tech" ([index.tsx:61-79](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/index.tsx#L61-L79)) | 17 categories, adds `mindset`, labels e.g. "Food & Produce", "Tech & Digital" ([marketplace.ts:6-24](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/marketplace.ts#L6-L24)) | **DIVERGENT** |
| **Marketplace Trust Filters** | 6 filters: All, Founding, Newcomers, Residents, Stewards, Elders ([TrustPickerSheet.tsx:7-14](file:///Users/marty/projects/beanpool/apps/native/components/TrustPickerSheet.tsx#L7-L14)) | Binary `foundingOnly` ("🌱 New members") toggle ([MarketplacePage.tsx:93, 1783](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L93)) | **DIVERGENT** |
| **Marketplace Post Creation** | FAB "+ Post" on tab navigates to `/map?newPost=true` ([index.tsx:1120-1135](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/index.tsx#L1120-L1135)) | No Post button on MarketplacePage; created exclusively on MapPage ([MapPage.tsx:850-920](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MapPage.tsx#L850-L920)) | **DIVERGENT** |
| **Node Service Radius on Post** | No radius validation on post submission | Validates coordinates against node service radius with warning modal ([MapPage.tsx:886-896](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MapPage.tsx#L886-L896)) | **PWA_ONLY** |
| **Marketplace Post Management** | Pause, resume, delete, update ([post/[id].tsx:690-710](file:///Users/marty/projects/beanpool/apps/native/app/post/[id].tsx#L690-L710), [db.ts:1865-1895](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1865-L1895)) | Pause, resume, delete, update ([MarketplacePage.tsx:1410-1640](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L1410-L1640)) | **PARITY** |
| **Marketplace Escrow Deal Flow** | Request, Accept, Approve, Reject, Cancel, Complete ([post/[id].tsx:720-810](file:///Users/marty/projects/beanpool/apps/native/app/post/[id].tsx#L720-L810)) | Request, Accept, Approve, Reject, Cancel, Complete ([MarketplacePage.tsx:1200-1350](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L1200-L1350)) | **PARITY** |
| **Transaction Ratings & Reviews** | Interactive 5-star & comment modal ([ReviewModal.tsx:17-150](file:///Users/marty/projects/beanpool/apps/native/components/ReviewModal.tsx#L17-L150)) | Interactive 5-star & comment sheet ([MarketplacePage.tsx:1320, 2210](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L1320)) | **PARITY** |
| **Community Pricing Guide** | Searchable modal opened from Map and Settings ([PricingGuideModal.tsx:41](file:///Users/marty/projects/beanpool/apps/native/components/PricingGuideModal.tsx#L41), [map.tsx:1484](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/map.tsx#L1484), [settings.tsx:2805](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/settings.tsx#L2805)) | Searchable modal opened from Marketplace header ([PricingGuideModal.tsx:23](file:///Users/marty/projects/beanpool/apps/pwa/src/components/PricingGuideModal.tsx#L23), [MarketplacePage.tsx:2277](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MarketplacePage.tsx#L2277)) | **PARITY** |
| **Pricing Guide Price Reporting** | Submits observed prices to node ([PricingGuideModal.tsx:115](file:///Users/marty/projects/beanpool/apps/native/components/PricingGuideModal.tsx#L115)) | Submits observed prices to node ([api.ts:1173](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/api.ts#L1173)) | **PARITY** |
| **Crowdfund Projects Listing** | Grid view with pledged vs goal, backer counts, progress bars ([projects.tsx:350-480](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/projects.tsx#L350-L480)) | Grid view with pledged vs goal, backer counts, progress bars ([ProjectsPage.tsx:320-450](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L320-L450)) | **PARITY** |
| **Crowdfund Project Propose** | Form requiring title, goal, description, deadline, photos ([propose-project.tsx:68-73](file:///Users/marty/projects/beanpool/apps/native/app/propose-project.tsx#L68-L73)) | Form requiring title and goal; description, deadline, photos optional ([ProjectsPage.tsx:125-133](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L125-L133)) | **DIVERGENT** |
| **Crowdfund Project Pledge** | Signed pledge transaction held in project escrow ([projects.tsx:410](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/projects.tsx#L410), [db.ts:1612](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1612)) | Signed pledge transaction held in project escrow ([ProjectsPage.tsx:640](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L640), [api.ts:887](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/api.ts#L887)) | **PARITY** |
| **Crowdfund Project Edit** | Dedicated screen for editing title, goal, description, deadline ([edit-project.tsx:15-120](file:///Users/marty/projects/beanpool/apps/native/app/edit-project.tsx#L15-L120), [db.ts:1648](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1648)) | No editing UI or API function implemented in PWA | **NATIVE_ONLY** |
| **Crowdfund Project Delete & Refund** | Deletes project and triggers trust refund ([edit-project.tsx:35](file:///Users/marty/projects/beanpool/apps/native/app/edit-project.tsx#L35), [db.ts:1709](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1709)) | Deletes project and triggers trust refund ([ProjectsPage.tsx:670](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L670)) | **PARITY** |
| **Project Quadratic / Multi-Voting** | Stepper voting UI calling `voteForProjectApi` ([projects.tsx:426](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/projects.tsx#L426)); fails with 404 ([db.ts:1849](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1849)) | API function exists ([api.ts:943](file:///Users/marty/projects/beanpool/apps/pwa/src/lib/api.ts#L943)); zero callers in PWA UI | **BROKEN_NATIVE** / **UNREACHABLE_PWA** |
| **Community Treasuries List** | Card list with balances, avatars, and live offer counts ([projects.tsx:490-540](file:///Users/marty/projects/beanpool/apps/native/app/(tabs)/projects.tsx#L490-L540)) | Card list with balances, avatars, and live offer counts ([ProjectsPage.tsx:274-304](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L274-L304)) | **PARITY** |
| **Community Treasury Detail & Keeper Actions** | Dedicated screen with listings, activity, keeper offer/need posting, and fund sweep ([treasury-detail.tsx:16-160](file:///Users/marty/projects/beanpool/apps/native/app/treasury-detail.tsx#L16-L160), [treasury-post.tsx:1-120](file:///Users/marty/projects/beanpool/apps/native/app/treasury-post.tsx#L1-L120)) | Cards are non-clickable `<div>` elements; no detail view, no keeper posting or sweep ([ProjectsPage.tsx:275](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/ProjectsPage.tsx#L275)) | **NATIVE_ONLY** |
| **Geographic Radius Filter** | Modal bottom sheet picker ([RadiusPickerModal.tsx:1-130](file:///Users/marty/projects/beanpool/apps/native/components/RadiusPickerModal.tsx#L1-L130)) | Full-page radius configuration route ([RadiusPickerPage.tsx:1-160](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/RadiusPickerPage.tsx#L1-L160)) | **DIVERGENT** (Presentation) |
| **Custom Currency Whitelabeling** | Dynamic formatting via `<CurrencyDisplay />` respecting node token ([CurrencyDisplay.tsx:1-80](file:///Users/marty/projects/beanpool/apps/native/components/CurrencyDisplay.tsx#L1-L80)) | Hardcoded `B` / `🫘` glyphs across all labels | **NATIVE_ONLY** |
| **Map Rendering on Web** | `Map.web.tsx` is an empty placeholder stub returning `[ Native MapView Stub ]` ([Map.web.tsx:9-15](file:///Users/marty/projects/beanpool/apps/native/components/Map.web.tsx#L9-L15)) | Full Leaflet implementation with interactive markers and popups ([MapPage.tsx:1-950](file:///Users/marty/projects/beanpool/apps/pwa/src/pages/MapPage.tsx#L1-L950)) | **DIVERGENT** |

---

### Divergences

- **Project Voting Execution**: Native calls a non-existent endpoint (`/api/crowdfund/projects/vote`), causing 404 rejections, while PWA targets the valid endpoint (`/api/commons/vote`) in `api.ts` but has zero UI callers.
- **Send Gating Contract**: Both clients check `balance > 0` and display copy stating any positive balance can send, directly contradicting server logic requiring `earnedCredit > 0` (at least 1 completed trade).
- **Diversity Cap Discrepancy**: Both clients use a stale `PER_COUNTERPARTY_CAP = 5000` to estimate `partnersToNext`, whereas the canonical engine constant is `500`, underestimating required counterparties by 10x.
- **Credit Floor & Welcome Voucher Specs**: PWA displays Newcomer entering floor as `-20` with a welcome voucher; Native displays Newcomer entering floor as `0` in `ledger.tsx`, yet claims a `-20B` welcome voucher in `TrustInfoModal.tsx`; server protocol has `CREDIT_BASE_FLOOR = 0` and no welcome voucher.
- **Social Recovery Quorum Specs**: Native `GuardianInfoModal.tsx` advertises that a majority approval (e.g. 2 of 3) restores access, whereas core cryptographic primitives strictly enforce `RECOVERY_THRESHOLD = 3`.
- **Account Suspension Claims**: Native `BalanceInfoModal.tsx` warns users of account suspension if at max floor for >3 months, which has no corresponding backend implementation.
- **Community Treasury Detail & Keeper Controls**: Native allows navigating into individual treasuries to review history, post enterprise offers/needs, and sweep funds; PWA renders unclickable static summary cards.
- **Crowdfund Project Creation Validation**: Native enforces description, deadline date, and at least one photo on project proposals; PWA leaves description, deadline, and photos entirely optional.
- **Crowdfund Project Updating**: Native provides an edit screen (`edit-project.tsx`) and API client (`updateCrowdfundProjectApi`); PWA contains no UI or API support for updating projects.
- **Marketplace Categories**: Native has 16 categories; PWA has 17 categories (adding `mindset`) and uses different category names ("Food & Produce" vs "Food", "Tech & Digital" vs "Tech").
- **Marketplace Trust Filtering**: Native supports 6 granular trust tiers via a bottom sheet; PWA supports only a single binary "New members" toggle.
- **Marketplace Creation Entrypoint**: Native features a floating action button on the marketplace tab linking to map posting; PWA has no post button on its marketplace page (only on the map page).
- **Post Node Service Radius Check**: PWA checks whether a new post falls within the node's configured radius and displays a confirmation prompt if outside; Native performs no radius validation on submission.
- **Currency Customization**: Native abstracts token branding through `<CurrencyDisplay />`; PWA hardcodes `B` and bean emojis throughout the UI.
- **Ledger CSV Export Scope**: Native exports only transaction history (`transactionsCsv`); PWA exports both transactions and account balances.
- **Web Map Implementation**: Native provides an empty non-functional stub on web (`Map.web.tsx`); PWA provides a full Leaflet map interface.

---

## HIGH severity

### 1. Broken Project Voting on Native Client
- **What breaks**: Any user attempting to vote on a crowdfund project from the Native app receives an HTTP 404 error and the vote fails to register.
- **Target audience**: All Native app users attempting to participate in community project governance.
- **Evidence**:
  - `apps/native/app/(tabs)/projects.tsx:426` triggers `voteForProjectApi(item.id, stepperVotes)`.
  - `apps/native/utils/db.ts:1849` sends `POST /api/crowdfund/projects/vote` with `{ projectId, pubkey, votes }`.
  - `apps/server/src/routes/commons.ts:79-87` implements the canonical voting route at `POST /api/commons/vote`, requiring `{ voterPubkey, projectId, voteCount }`.
  - The server has no handler for `/api/crowdfund/projects/vote` anywhere in `apps/server/src/routes/`.

### 2. Misleading Send Gating Copy vs Server Enforcement
- **What breaks**: New members who hold a positive balance (e.g., via administrative grants, genesis allocations, or gifts) are told by the UI that they can send credits, but every send attempt is rejected by the server with an error.
- **Target audience**: Newcomers who have not yet completed a trade on the marketplace.
- **Evidence**:
  - `apps/server/src/state-engine.ts:1213-1219` rejects transfers when `earnedCredit <= 0` for non-escrow/system accounts:
    ```ts
    const { earnedCredit } = getMemberTrustProfile(from);
    if (earnedCredit <= 0) return null;
    ```
  - `apps/server/src/routes/community.ts:1054` returns HTTP 400: `"Send failed — you can only send beans you currently hold, and only after your first completed trade."`.
  - `apps/native/app/(tabs)/ledger.tsx:406, 487, 565` gates the button with `canSend = balanceState.balance > 0` and copy `"Anyone with a positive balance can send"` / `"Send Credits"`.
  - `apps/pwa/src/pages/LedgerPage.tsx:161, 310, 395` gates the button with `canSend = balance > 0` and copy `"Anyone with a positive balance can send"` / `"Send Credits"`.

### 3. Tenfold Underestimation of Next-Tier Counterparty Requirements
- **What breaks**: Both Native and PWA display severely incorrect "partners to next tier" progress metrics, misleading users into believing they need 10x fewer trading partners than the protocol requires.
- **Target audience**: All members tracking their progression from Newcomer toward Resident, Steward, or Elder tiers.
- **Evidence**:
  - `packages/beanpool-engine/src/trust.ts:21` establishes the canonical tuning knob:
    ```ts
    // CANONICAL tuning knob — single source of truth for volume caps (do not duplicate in manager or server).
    export const PER_COUNTERPARTY_VOLUME_CAP = 500;
    ```
  - `apps/native/app/(tabs)/ledger.tsx:33, 426` hardcodes `const PER_COUNTERPARTY_CAP = 5000;` and computes `Math.ceil(valueToNext / PER_COUNTERPARTY_CAP)`.
  - `apps/pwa/src/pages/LedgerPage.tsx:44, 180` hardcodes `const PER_COUNTERPARTY_CAP = 5000;` and computes `Math.ceil(valueToNext / PER_COUNTERPARTY_CAP)`.

### 4. Conflicting Credit Floor & Phantom Welcome Voucher Claims
- **What breaks**: Users are given contradictory information across clients and modals regarding whether their starting floor is 0 or -20, and whether a "welcome voucher" exists.
- **Target audience**: All new members onboarding to BeanPool.
- **Evidence**:
  - `packages/beanpool-core/src/protocol.ts:23` defines `CREDIT_BASE_FLOOR: 0` with no base voucher.
  - `packages/beanpool-engine/src/trust.ts:408-414` calculates floor strictly as `c.CREDIT_BASE_FLOOR - allowance`, which is `0` until vouched or trade credit is earned.
  - `apps/pwa/src/pages/LedgerPage.tsx:26-27` states Newcomer has `floor: -20` with blurb `"a small welcome voucher gets you moving"`.
  - `apps/native/app/(tabs)/ledger.tsx:59` states Newcomer has `floor: 0`.
  - `apps/native/components/info-content/TrustInfoModal.tsx:158` and `SliderInfoModal.tsx:271` state `"A -20B welcome voucher opens your floor after your 1st trade"`.

### 5. Social Recovery Threshold Misinformation
- **What breaks**: Users are informed that a simple majority of guardians (e.g. 2 of 3) can restore their account, but combining 2 shares will crash and fail.
- **Target audience**: Any member setting up or executing social recovery.
- **Evidence**:
  - `packages/beanpool-core/src/recovery-split.ts:64, 192-196` strictly requires 3 fragments:
    ```ts
    export const RECOVERY_THRESHOLD = 3;
    if (!Array.isArray(shares) || shares.length < RECOVERY_THRESHOLD) {
        throw new RecoveryCombineError(`Rebuilding a recovery phrase needs ${RECOVERY_THRESHOLD} fragments, got ${shares?.length ?? 0}.`);
    }
    ```
  - `apps/native/components/info-content/GuardianInfoModal.tsx:157` states: `"If a majority (e.g., 2 out of 3, or 3 out of 5) of your Guardians approve your recovery request, your account is restored!"`.

### 6. Fictitious Account Suspension Policy Warning
- **What breaks**: Native users are threatened with account suspension for maintaining negative balances over 3 months, despite no such enforcement existing on the server.
- **Target audience**: Native users viewing the Available Balance educational modal.
- **Evidence**:
  - `apps/native/components/info-content/BalanceInfoModal.tsx:197` warns: `"Members who stay at their maximum floor balance for over 3 months without active trading may face account suspension."`.
  - Search across `apps/server/src/` reveals no inactivity cron, suspension timer, or floor penalty for 3-month negative balances.

---

## Built but unreachable

The following functions and wrappers are compiled in client codebases but have zero callers in their respective user interfaces:

### PWA Unreachable Code
- `apps/pwa/src/lib/api.ts:943` (`voteForProject`): Implements `POST /api/commons/vote`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:986` (`getTreasury`): Implements `GET /api/treasury/:publicKey`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:992` (`treasuryPostOffer`): Implements `POST /api/treasury/:publicKey/offers`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:995` (`treasuryPostNeed`): Implements `POST /api/treasury/:publicKey/needs`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:998` (`treasuryApprove`): Implements `POST /api/treasury/:publicKey/approve`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:1001` (`treasuryComplete`): Implements `POST /api/treasury/:publicKey/complete`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:1004` (`treasurySweep`): Implements `POST /api/treasury/:publicKey/sweep`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:923` (`getCommonsBalance`): Implements `GET /api/commons/balance`. Zero callers in `apps/pwa/src/` (retrieved via `getBalance`).
- `apps/pwa/src/lib/api.ts:947` (`getGovernanceCredits`): Implements `GET /api/commons/my-credits/:pubkey`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:927` (`getCommonsProjects`): Implements `GET /api/commons/projects`. Zero callers in `apps/pwa/src/` (`ProjectsPage.tsx` calls `getCrowdfundProjects`).
- `apps/pwa/src/lib/api.ts:931` (`proposeProject`): Implements `POST /api/commons/projects/propose`. Zero callers in `apps/pwa/src/` (`ProjectsPage.tsx` calls `createCrowdfundProject`).
- `apps/pwa/src/lib/api.ts:935` (`updateCommunityProject`): Implements `POST /api/commons/projects/update`. Zero callers in `apps/pwa/src/`.
- `apps/pwa/src/lib/api.ts:939` (`deleteCommunityProject`): Implements `POST /api/commons/projects/delete`. Zero callers in `apps/pwa/src/`.

### Native Unreachable Code
- `apps/native/utils/db.ts:1835` (`treasuryApprove`): Defined in `db.ts` to call `/api/treasury/:treasury/approve`. Zero callers across all screens in `apps/native/app/` or `components/`.
- `apps/native/utils/db.ts:1838` (`treasuryComplete`): Defined in `db.ts` to call `/api/treasury/:treasury/complete`. Zero callers across all screens in `apps/native/app/` or `components/`.

---

## Endpoints

Node API endpoints used by one client and not the other in the Economy & Marketplace domain:

### Used by Native, Not Used by PWA
- `GET /api/treasury/:id`
  - **Native**: Called in `apps/native/utils/db.ts:1827` via `getTreasuryDetail()` and executed in `apps/native/app/treasury-detail.tsx:42`.
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:986` (`getTreasury`), but 0 UI callers.
- `POST /api/treasury/:id/sweep`
  - **Native**: Called in `apps/native/utils/db.ts:1842` via `treasurySweep()` and executed in `apps/native/app/treasury-detail.tsx:123`.
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:1004` (`treasurySweep`), but 0 UI callers.
- `POST /api/treasury/:id/offers`
  - **Native**: Called in `apps/native/utils/db.ts:1830` via `treasuryPostOffer()` and executed in `apps/native/app/treasury-post.tsx:85`.
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:992` (`treasuryPostOffer`), but 0 UI callers.
- `POST /api/treasury/:id/needs`
  - **Native**: Called in `apps/native/utils/db.ts:1833` via `treasuryPostNeed()` and executed in `apps/native/app/treasury-post.tsx:88`.
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:995` (`treasuryPostNeed`), but 0 UI callers.
- `POST /api/crowdfund/projects/update`
  - **Native**: Called in `apps/native/utils/db.ts:1682` via `updateCrowdfundProjectApi()` and executed in `apps/native/app/edit-project.tsx:93`.
  - **PWA**: Not implemented in `apps/pwa/src/lib/api.ts` or `ProjectsPage.tsx`.

### Used by PWA, Not Used by Native
- `POST /api/commons/vote`
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:943` targeting the valid server route (`apps/server/src/routes/commons.ts:79`), though currently lacking a UI caller.
  - **Native**: Missing; Native erroneously calls the non-existent `/api/crowdfund/projects/vote` ([db.ts:1849](file:///Users/marty/projects/beanpool/apps/native/utils/db.ts#L1849)).
- `GET /api/commons/my-credits/:pubkey`
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:947` (`getGovernanceCredits`).
  - **Native**: Not implemented.
- `GET /api/commons/balance`
  - **PWA**: Wrapped in `apps/pwa/src/lib/api.ts:923` (`getCommonsBalance`).
  - **Native**: Not implemented.

---

## Coverage gaps

The following areas and files were not evaluated in this audit:
1. **Push Notification Delivery for Deals**: Push notification receipt handling and background wakeups for marketplace offer/need matches and deal status transitions (`apps/native/services/*` vs PWA Service Worker push subscription in `apps/pwa/src/service-worker.ts`).
2. **Offline Mutation Queues & SQLite Reconciliation**: Background SQLite transaction queue synchronization and conflict resolution when reconnecting after offline marketplace transactions (`apps/native/utils/db.ts` mutation queues vs PWA IndexedDB sync engine in `apps/pwa/src/lib/sync.ts`).
3. **Operator/Admin Management Consoles**: Administrative pricing guide configuration, item pinning, and abuse report processing in `apps/manager/*` (excluded to maintain strict focus on user-facing client parity).
4. **Automated End-to-End Deal Flow Integration Tests**: Runtime verification of real-time WebSocket events (`deal_requested`, `deal_accepted`, `deal_approved`) firing simultaneously across both clients.
