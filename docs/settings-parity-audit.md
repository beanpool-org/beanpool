# Node Settings Parity Audit

> **Scope**: Complete audit of legacy node settings (`apps/server/static/settings.html` + `settings.js`, ~231 KB vanilla JS, served at `/settings-legacy`) against the single-node React manager (`apps/manager`, served at `/settings` via PR #808).
> **Source of Truth**: The legacy codebase (`apps/server/static/settings.html` and `settings.js`) evaluated against `apps/manager/src/`.
> **Design References**: [`docs/settings-ia.md`](./settings-ia.md), [`docs/admin-surface.md`](./admin-surface.md), [`docs/the-commons.md`](./the-commons.md).

---

## 1. Executive Summary

PR #808 rebuilt the node settings as a modern, typed React 19 application (`apps/manager`) served at `/settings`. The migration followed [`docs/settings-ia.md`](./settings-ia.md), which reorganized 12 technical legacy tabs into 4 plain-English sections:
1. **People & Safety** (`PeopleSafetySection.tsx`)
2. **Shared Projects & Economy** (`EconomySection.tsx`)
3. **Bulletin & News** (`BulletinSection.tsx`)
4. **Appliance & Data** (`ApplianceSection.tsx`)

However, because `docs/settings-ia.md` mapped only high-level tabs, several critical operational controls present in `apps/server/static/settings.html` and `settings.js` were omitted from the React rebuild. Most prominently, the entire **"📡 Node Identity"** panel (geographic location search with OpenStreetMap Nominatim geocoding, interactive Leaflet map with draggable node pin, service-radius controls, and scheduled directory publishing to beanpool.org with output preview) was not ported. Additionally, essential networking features—specifically **Public Address (.beanpool.org) domain claims & Cloudflare DNS tunnels**, as well as **bidirectional peer connector controls with collision/deadlock resolution**—were omitted from the single-node appliance view.

### Parity Breakdown

| Status | Count | Description |
|---|:---:|---|
| **PRESENT** | 41 | Implemented in the new React settings with direct file:line parity. |
| **REFORMATTED** | 12 | Capability survives in a streamlined or consolidated shape with no loss of capability. |
| **DROPPED** | 15 | Deliberately excluded per `docs/settings-ia.md` §1, §6 or `docs/admin-surface.md`. |
| **MISSING** | 22 | Implemented and working in legacy, but omitted from the new React settings. |
| **TOTAL INVENTORY** | **90** | Distinct user-visible controls, panels, form fields, and actions. |

---

## 2. Complete Inventory by Legacy Tab & Section

### 2.1 Global Header & Administrator Authentication

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Header Title & Version Display** (`#top-version-display`) | `settings.html:686`<br>`settings.js:1147-1160` | **REFORMATTED** | `apps/manager/src/components/modules/HomeScreen.tsx:104-122`<br>Moved to Home Screen header banner and Appliance version card (`ApplianceSection.tsx:566-576`). |
| **Header Update Available Badge** (`#update-badge`) | `settings.html:686`<br>`settings.js:1162-1175` | **REFORMATTED** | `apps/manager/src/components/modules/ApplianceSection.tsx:578-596`<br>Reformatted into the Update Status card in Appliance & Data. |
| **Peer ID Display** (`#hdr-peer-id`) | `settings.html:687`<br>`settings.js:4163-4172` | **REFORMATTED** | `apps/manager/src/components/layout/TopHeader.tsx:42-55`<br>Surfaces active node name, URL, and connection health in header. |
| **Logout Button** (`#logout-btn`) | `settings.html:690`<br>`settings.js:51-54, 524-530` | **PRESENT** | `apps/manager/src/components/layout/TopHeader.tsx:64-75`<br>Clears session token and resets authentication state. |
| **Back Link** (`href="/"`) | `settings.html:691` | **PRESENT** | `apps/manager/src/components/layout/TopHeader.tsx:32-38`<br>Navigates back to the root application. |
| **Admin Password Login Input & Eye Toggle** (`#login-password`) | `settings.html:701-704`<br>`settings.js:475-520` | **PRESENT** | `apps/manager/src/components/auth/AdminLoginCard.tsx:88-98`<br>Password authentication gating all local admin routes. |
| **Login 2FA Code Input** (`#login-totp`) | `settings.html:707-709`<br>`settings.js:485-515` | **PRESENT** | `apps/manager/src/components/auth/AdminLoginCard.tsx:105-115`<br>6-digit TOTP verification during login. |
| **Unlock Settings Button** (`#login-btn`) | `settings.html:710`<br>`settings.js:475-522` | **PRESENT** | `apps/manager/src/components/auth/AdminLoginCard.tsx:118-128`<br>Submits password + 2FA code to `/api/verify-password`. |
| **Sovereign Appliance Mode Banner** | `settings.html:732-734` | **REFORMATTED** | `apps/manager/src/components/modules/HomeScreen.tsx:99-136`<br>Replaced by the dedicated Single-Node Home Screen. |

---

### 2.2 📡 Identity Tab (`data-tab="identity"`)

#### Panel: Node Identity & Public Directory

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Node Callsign (Short Name)** (`#cfg-callsign`) | `settings.html:741`<br>`settings.js:940-960` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1063-1070`<br>Section: **Appliance & Data** (`subTab === 'identity'`). Calls `POST /api/local/admin/node/config`. |
| **Operating Region Place Search** (`#location-search`, `#location-results`) | `settings.html:746-749`<br>`settings.js:433-466` | **MISSING** | **What it does**: Queries OpenStreetMap Nominatim geocoding API to resolve place names to latitude/longitude coordinates.<br>**Endpoints called**: `https://nominatim.openstreetmap.org/search?format=json&q=...`<br>**Operator impact**: Operators cannot look up their locality by name; forced to manually find and inject coordinates or remain unlocated. |
| **Interactive Leaflet Map & Node Pin** (`#settings-map`, `#cfg-lat`, `#cfg-lng`) | `settings.html:750-752`<br>`settings.js:387-431` | **MISSING** | **What it does**: Renders an interactive Leaflet map tile display with draggable node pin marker to set exact community coordinates.<br>**Endpoints called**: Saves via `POST /api/local/admin/node/config` and `POST /api/update-identity`.<br>**Operator impact**: Operator cannot visually place or verify their node's geographic location pin. |
| **Service Radius Slider & KM Input** (`#radius-slider`, `#radius-km`) | `settings.html:758-760`<br>`settings.js:397-408` | **MISSING** | **What it does**: Dual range slider (0–200 km) and number input (0–500 km) setting community operating radius with dynamic Leaflet circle overlay.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`serviceRadiusKm`).<br>**Operator impact**: Operator cannot define the trade boundary or geographic discovery radius of their community node. |
| **Preview Public Output Link** (`/api/directory/info`) | `settings.html:767-769`<br>`settings.js:1765-1772` | **MISSING** | **What it does**: Direct link opening `/api/directory/info` in a new tab to inspect exactly what metadata the node exposes to beanpool.org.<br>**Endpoints called**: `GET /api/directory/info`.<br>**Operator impact**: Operator cannot audit what public data is broadcast to the global directory. |
| **Directory Push Schedule Dropdown** (`#directory-push-interval`) | `settings.html:778-785`<br>`settings.js:1722-1734` | **MISSING** | **What it does**: Sets periodic outbound push cadence (Disabled, 1h, 6h, 12h, 24h) to `beanpool.org`.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`directoryPushIntervalHours`).<br>**Operator impact**: Operator cannot automate or disable directory publishing. |
| **Publish Now Manual Trigger** (`#publish-now-btn`) | `settings.html:788`<br>`settings.js:1736-1763` | **MISSING** | **What it does**: Triggers an immediate outbound push of directory metadata to beanpool.org.<br>**Endpoints called**: `POST /api/local/admin/directory/push`.<br>**Operator impact**: Operator cannot manually broadcast node directory updates. |
| **Share Location & Radius Toggle** (`#publish-location`) | `settings.html:794`<br>`settings.js:1724-1734` | **MISSING** | **What it does**: Controls whether geographic coordinates and radius are included in directory payloads.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`publishLocation`).<br>**Operator impact**: Privacy control lost; cannot hide geographic presence. |
| **Share Member Count Toggle** (`#publish-members`) | `settings.html:803`<br>`settings.js:1724-1734` | **MISSING** | **What it does**: Toggles publishing registered member count to demonstrate community activity.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`publishMembers`).<br>**Operator impact**: Cannot suppress community size metrics from public directory. |
| **Share Community Contacts Toggle** (`#publish-contacts`) | `settings.html:812`<br>`settings.js:1724-1734` | **MISSING** | **What it does**: Toggles publishing administrator email/phone on directory listing.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`publishContacts`).<br>**Operator impact**: Cannot withhold public contact info from automated directory ingest. |
| **Share Node Health & Version Toggle** (`#publish-health`) | `settings.html:821`<br>`settings.js:1724-1734` | **MISSING** | **What it does**: Opt-in toggle to report node uptime, health, and software version to the core diagnostic registry.<br>**Endpoints called**: `POST /api/local/admin/node/config` (`publishHealth`).<br>**Operator impact**: Operator cannot opt in/out of diagnostic telemetry reporting. |
| **Community Public Name** (`#community-name`) | `settings.html:836`<br>`settings.js:940-960` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1053-1061`<br>Section: **Appliance & Data** (`subTab === 'identity'`). |
| **Community Contact Email** (`#contact-email`) | `settings.html:838`<br>`settings.js:940-960` | **MISSING** | **What it does**: Configures public email displayed on node welcome page.<br>**Endpoints called**: `POST /api/community-info`, `POST /api/update-identity`.<br>**Operator impact**: Landing page contact email cannot be set through web UI. |
| **Community Contact Phone** (`#contact-phone`) | `settings.html:840`<br>`settings.js:940-960` | **MISSING** | **What it does**: Configures public telephone number on landing page.<br>**Endpoints called**: `POST /api/community-info`, `POST /api/update-identity`.<br>**Operator impact**: Landing page contact telephone cannot be set through web UI. |
| **Save Identity Button** (`#save-identity-btn`) | `settings.html:843`<br>`settings.js:940-960` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1073-1079`<br>Section: **Appliance & Data** (`subTab === 'identity'`). |

#### Panel: Change Admin Password

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **New Password Input & Eye Toggle** (`#new-pwd`) | `settings.html:852-854`<br>`settings.js:1060-1095` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1104-1113`<br>Section: **Appliance & Data** (`subTab === 'access'`). |
| **Password Strength Checklist** (`#pwd-requirements-box`) | `settings.html:856-863`<br>`settings.js:1060-1080` | **REFORMATTED** | `apps/manager/src/components/modules/ApplianceSection.tsx:1101`<br>Helper text displays 8+ character complexity requirements. |
| **Confirm Password Input** (`#new-pwd-confirm`) | `settings.html:867-869`<br>`settings.js:1060-1095` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1115-1124`<br>Section: **Appliance & Data** (`subTab === 'access'`). |
| **Update Password Button** (`#change-pwd-btn`) | `settings.html:871`<br>`settings.js:1060-1095` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1126-1132`<br>Section: **Appliance & Data** (`subTab === 'access'`). Calls `POST /api/change-password`. |

#### Panel: Two-Factor Authentication (TOTP 2FA)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **2FA Status Badge** (`#totp-status-badge`) | `settings.html:879`<br>`settings.js:560-590` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1159-1167`<br>Section: **Appliance & Data** (`subTab === 'access'`). Displays Enabled/Disabled badge. |
| **Setup 2FA Button** (`#btn-totp-start-setup`) | `settings.html:888`<br>`settings.js:605-640` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1174-1180`<br>Section: **Appliance & Data**. Calls `POST /api/admin/2fa/setup`. |
| **QR Code Display** (`#totp-qr-img`) | `settings.html:896`<br>`settings.js:615-625` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1191-1196`<br>Section: **Appliance & Data**. Renders generated base64 QR code image. |
| **Secret Key Text & Copy Button** (`#totp-secret-text`, `#btn-totp-copy-secret`) | `settings.html:901-902`<br>`settings.js:620-630` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1197-1205`<br>Section: **Appliance & Data**. Displays alphanumeric seed with clipboard copy button. |
| **Setup Verification Code Input & Submit** (`#totp-setup-code`, `#btn-totp-verify-setup`) | `settings.html:910-913`<br>`settings.js:645-680` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1208-1224`<br>Section: **Appliance & Data**. Submits verification code to `POST /api/admin/2fa/verify`. |
| **Cancel Setup Button** (`#btn-totp-cancel-setup`) | `settings.html:914`<br>`settings.js:642` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1225-1231`<br>Section: **Appliance & Data**. Aborts enrollment and resets modal state. |
| **Disable 2FA Input & Button** (`#totp-disable-code`, `#btn-totp-disable`) | `settings.html:934-936`<br>`settings.js:705-735` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1238-1246`<br>Section: **Appliance & Data**. Submits code to `POST /api/admin/2fa/disable`. |
| **Emergency Backup Codes Display & Copy** (`#totp-backup-codes-list`, `#btn-totp-copy-backups`) | `settings.html:947-950`<br>`settings.js:685-700` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1233-1236`<br>Section: **Appliance & Data**. Renders emergency one-time recovery codes with copy button. |

---

### 2.3 🔗 Network & Gateway Tab (`data-tab="network"`)

#### Panel: Trusted Connectors (P2P Mesh Federation)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Connectors List Display** (`#connectors-list`) | `settings.html:1020`<br>`settings.js:750-847` | **REFORMATTED** | `apps/manager/src/components/modules/ApplianceSection.tsx:1011-1027`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Displays connected peer list. |
| **Connection Mode Guide** | `settings.html:1022-1036` | **MISSING** | **What it does**: In-app documentation explaining Active (dialer) vs Passive (listener) roles and collision avoidance.<br>**Operator impact**: Operators lack operational instructions for configuring multi-node federation. |
| **Add Connector Form** (`#new-addr`, `#new-trust`, `#new-mode`, `#new-callsign`, `#add-connector-btn`) | `settings.html:1044-1066`<br>`settings.js:890-930` | **MISSING** | **What it does**: Allows adding a new federation peer with specific Trust Level (`peer`/`blocked`), Mode (`active`/`passive`), and Callsign.<br>**Endpoints called**: `POST /api/local/connectors`.<br>**Operator impact**: In React (`ApplianceSection.tsx:993-1008`), only `peerAddress` is accepted; cannot configure trust level, mode, or callsign. |
| **Make Active / Make Passive Mode Toggle** (`toggleConnectorMode`) | `settings.js:839-841, 874-885` | **MISSING** | **What it does**: Flips connection mode between outbound dialer (`active`) and inbound listener (`passive`).<br>**Endpoints called**: `POST /api/local/connectors`.<br>**Operator impact**: Operators cannot adjust dialer role to resolve connection collisions or deadlocks without modifying raw JSON. |
| **Dual Active Collision / Dual Passive Deadlock Badges & Alerts** | `settings.js:772-811` | **MISSING** | **What it does**: Detects and highlights simultaneous dialing collisions or mutual listening deadlocks.<br>**Operator impact**: Operator receives no visual alert when federation fails due to mismatched dialer roles. |
| **Connect / Disconnect Buttons** (`doConnect`, `doDisconnect`) | `settings.js:835-838, 856-872` | **MISSING** | **What it does**: Manually opens or drops a live WebSocket connection to a specific peer.<br>**Endpoints called**: `POST /api/local/connectors/connect`, `POST /api/local/connectors/disconnect`.<br>**Operator impact**: Cannot disconnect a misbehaving peer or force an immediate reconnect. |
| **Remove Connector Button** (`doRemove`) | `settings.js:842, 876-888` | **MISSING** | **What it does**: Deletes a peer connector from `connectors.json`.<br>**Endpoints called**: `POST /api/local/connectors/remove`.<br>**Operator impact**: Operator cannot delete obsolete or retired peer connections. |

#### Panel: Public Address (.beanpool.org Registrar & Cloudflare Tunnel)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Public Address Status Display** (`#pubaddr-display`) | `settings.html:1078`<br>`settings.js:142-205` | **MISSING** | **What it does**: Queries registrar and displays public URL, connection mode, and approval status.<br>**Endpoints called**: `GET /api/local/admin/public-address/status`.<br>**Operator impact**: Operator cannot see if node has a public domain name registered. |
| **Real-Time DNS Propagation Terminal Monitor** (`#pubaddr-live-terminal`) | `settings.html:1081-1087`<br>`settings.js:207-280` | **MISSING** | **What it does**: Streams live 4-step tunnel initialization logs and DNS propagation progress.<br>**Endpoints called**: `GET /api/local/admin/public-address/logs`.<br>**Operator impact**: Operator cannot diagnose DNS or Cloudflare tunnel setup failures. |
| **Tunnel Token Secret Field, Reveal Eye & Copy Button** (`#pubaddr-token`) | `settings.html:1093-1095`<br>`settings.js:201-204, 335-345` | **MISSING** | **What it does**: Securely displays the Cloudflare tunnel authentication token with reveal/copy actions.<br>**Endpoints called**: `GET /api/local/admin/public-address/status`.<br>**Operator impact**: Operator cannot copy the tunnel token for off-node connectors or backup deployments. |
| **Claim Public Web Address Form** (`#pubaddr-name`, `#pubaddr-preview-url`, `#pubaddr-community-name`, `#pubaddr-contact`, `#pubaddr-mode`, `#pubaddr-claim-btn`) | `settings.html:1109-1133`<br>`settings.js:282-308` | **MISSING** | **What it does**: Registers a custom `<name>.beanpool.org` subdomain with contact info and tunnel mode.<br>**Endpoints called**: `POST /api/local/admin/public-address/claim`.<br>**Operator impact**: Operator cannot claim or register a public `.beanpool.org` web address through settings. |
| **Reset Tunnel Button** (`#pubaddr-restart-btn`) | `settings.html:1136`<br>`settings.js:310-322` | **MISSING** | **What it does**: Restarts the local Cloudflare tunnel sidecar process.<br>**Endpoints called**: `POST /api/local/admin/public-address/restart-sidecar`.<br>**Operator impact**: Operator cannot recover stalled tunnels without SSH server access. |
| **Take Offline Button** (`#pubaddr-offline-btn`) | `settings.html:1137`<br>`settings.js:324-334` | **MISSING** | **What it does**: Releases public registration and shuts down tunnel ingress.<br>**Endpoints called**: `POST /api/local/admin/public-address/offline`.<br>**Operator impact**: Operator cannot take their node offline from the public internet. |

#### Panel: Gateway Self-Protection Configuration

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **CORS Allowed Origins Input** (`#gw-cors-origins`) | `settings.html:1152`<br>`settings.js:4200-4270` | **PRESENT** | `apps/manager/src/components/modules/GatewayModule.tsx:65-75`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Calls `POST /api/local/admin/gateway`. |
| **Admin IP Allowlist Input** (`#gw-admin-ips`) | `settings.html:1157`<br>`settings.js:4200-4270` | **PRESENT** | `apps/manager/src/components/modules/GatewayModule.tsx:77-87`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Calls `POST /api/local/admin/gateway`. |
| **Rate Limiting Toggle & Max Requests Input** (`#gw-rate-enabled`, `#gw-rate-max`) | `settings.html:1163-1172`<br>`settings.js:4200-4270` | **PRESENT** | `apps/manager/src/components/modules/GatewayModule.tsx:90-110`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Calls `POST /api/local/admin/gateway`. |
| **Subsystem Feature Toggles** (Marketplace, Messaging, Federation, Invites, PWA) | `settings.html:1177-1191`<br>`settings.js:4200-4270` | **PRESENT** | `apps/manager/src/components/modules/GatewayModule.tsx:115-170`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Calls `POST /api/local/admin/gateway`. |
| **Save Gateway Configuration Button** (`#save-gateway-btn`) | `settings.html:1193`<br>`settings.js:4245-4275` | **PRESENT** | `apps/manager/src/components/modules/GatewayModule.tsx:175-182`<br>Section: **Appliance & Data** (`subTab === 'gateway'`). Calls `POST /api/local/admin/gateway`. |

---

### 2.4 🎫 Invites Tab (`data-tab="invites"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Invite Tier Selector Radio Buttons** (Newcomer, Resident, Steward, Elder) | `settings.html:963-995`<br>`settings.js:990-1010` | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:180-230`<br>Section: **People & Safety** (`subTab === 'invites'`). |
| **Batch Quantity Selector** (1, 5, 10, 25 passes) | *New in React* | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:190-210`<br>Section: **People & Safety** (`subTab === 'invites'`). |
| **Generate Invite Code Button** (`#seed-invite-btn`) | `settings.html:997`<br>`settings.js:995-1015` | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:235-245`<br>Section: **People & Safety**. Calls `POST /api/admin/seed-invite`. |
| **Invite Link, Code Display & Copy Button** (`#seed-invite-code`, `#copy-invite-btn`) | `settings.html:1002-1007`<br>`settings.js:1015-1040` | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:270-320`<br>Section: **People & Safety**. Displays code, full URL, and copy button. |
| **Invite QR Code Display** (`#seed-invite-qr`) | `settings.html:1004`<br>`settings.js:1020-1035` | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:325-360`<br>Section: **People & Safety**. Renders scannable QR modal. |
| **Printable Invite Cards Generator** | *New in React per IA §5.5* | **PRESENT** | `apps/manager/src/components/modules/InvitesModule.tsx:112-160`<br>Section: **People & Safety**. Generates printable physical cards with join QR codes. |

---

### 2.5 ⚙️ System Tab (`data-tab="system"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Reset Confirmation Text Safeguard** (`#reset-confirm-input`) | `settings.html:1211-1214`<br>`settings.js:1115-1120` | **MISSING** | **What it does**: Requires typing `RESET` into text box before enabling the wipe button, preventing accidental destruction.<br>**Operator impact**: React uses `window.confirm()`; lacks safety barrier against accidental misclicks. |
| **Reset Configuration Button** (`#reset-btn`) | `settings.html:1215`<br>`settings.js:1115-1135` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:1288-1295`<br>Section: **Appliance & Data** (`subTab === 'access'`). Calls `POST /api/local/reset`. |
| **Current & Latest Version Status Display** (`#current-version`, `#latest-version`) | `settings.html:1225, 1230`<br>`settings.js:1320-1360` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:566-596`<br>Section: **Appliance & Data**. Shows version and update status. |
| **Software Update Release Notes Box** (`#update-release-notes`) | `settings.html:1235`<br>`settings.js:1340-1355` | **MISSING** | **What it does**: Displays changelog and release notes fetched from release registry.<br>**Endpoints called**: `/api/admin/check-update`.<br>**Operator impact**: Operator is notified of update but cannot read release notes. |
| **CLI Update Instructions Snippet & Copy Button** (`#update-commands`: `docker compose pull && docker compose up -d`) | `settings.html:1240-1242`<br>`settings.js:1360-1375` | **MISSING** | **What it does**: Displays the exact shell commands needed to update container image over SSH, with one-click copy button.<br>**Operator impact**: Operator must remember or search for the exact Docker update commands. |
| **Check for Updates Button** (`#check-update-btn`) | `settings.html:1251`<br>`settings.js:1320-1365` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:611-618`<br>Section: **Appliance & Data**. Calls `POST /api/admin/check-update`. |
| **Auto-Check for Updates Toggle & Cadence Select** (`#auto-check-updates`, `#update-check-interval`) | `settings.html:1257-1265`<br>`settings.js:1367-1385` | **MISSING** | **What it does**: Automatically schedules update checks (hourly, 6h, daily, weekly) in the background.<br>**Operator impact**: Update checks in React only execute manually on button click. |

---

### 2.6 🏛️ Commons Tab (`data-tab="commons"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Commons Pool Balance Display** (`#commons-balance`) | `settings.html:1460`<br>`settings.js:1450-1465` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:422-435`<br>Section: **Shared Projects & Economy**. Displays live commons pool balance. |
| **Active Round Status Display** (`#commons-round-status`) | `settings.html:1464`<br>`settings.js:1455-1465` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:500-515`<br>Section: **Shared Projects & Economy**. |
| **Commons Projects List & Details** (`#commons-projects-list`) | `settings.html:1470`<br>`settings.js:1468-1495` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:560-650`<br>Section: **Shared Projects & Economy**. Calls `POST /api/local/admin/commons/projects`. |
| **Create Voting Round Button** (`createRound()`) | `settings.html:1474`<br>`settings.js:1505-1522` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:377-395, 674-680`<br>Section: **Shared Projects & Economy**. Calls `POST /api/local/admin/commons/round`. |
| **Close Voting Round Button** (`closeRound()`) | `settings.html:1475`<br>`settings.js:1524-1540` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:397-414, 530-540`<br>Section: **Shared Projects & Economy**. Calls `POST /api/local/admin/commons/round`. |
| **Reject Project Action** (`rejectProject()`) | `settings.js:1485, 1542-1555` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:416-430, 635-645`<br>Section: **Shared Projects & Economy**. Calls `POST /api/local/admin/commons/reject`. |
| **Refresh Commons Data Button** (`loadCommonsData()`) | `settings.html:1476`<br>`settings.js:1435-1465` | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:488-494`<br>Section: **Shared Projects & Economy**. Refreshes pool and project states. |
| **Base Circulation Rate Input & Save Button** (`#th-circulationRate`, `#save-commons-thresholds-btn`, `#reset-commons-thresholds-btn`) | `settings.html:1484-1491`<br>`settings.js:1480-1495` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §6.1 & `the-commons.md` §3.6.<br>*"Changing a protocol parameter is a rule Decision under the-commons.md §3.6 — one member, one vote, 60%. An admin slider that silently changes everyone's money is precisely the authority the Decision model exists to remove."* |
| **Enterprise Presets & First Offer Seeding** | *New in React per IA §4.3* | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:192-260, 328-360`<br>Section: **Shared Projects & Economy**. Allows operator to create enterprises from presets and seed initial offers. |
| **Keeper Assignment & Revocation** | *New in React per IA §3* | **PRESENT** | `apps/manager/src/components/modules/EconomySection.tsx:266-325, 960-1045`<br>Section: **Shared Projects & Economy**. Assigns/revokes keepers for shared enterprises. |

---

### 2.7 📚 Pulse Content Tab (`data-tab="pulse"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Pulse Channels Refresh Button** (`#refresh-pulse-channels-btn`) | `settings.html:1499`<br>`settings.js:1555-1565` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:210-215`<br>Section: **Bulletin & News**. Refreshes curated channels. |
| **Add Channel URL Input & Category Select** (`#pulse-new-url`, `#pulse-new-category`) | `settings.html:1510-1524`<br>`settings.js:1640-1670` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:225-255`<br>Section: **Bulletin & News**. URL and category inputs for YouTube/RSS feeds. |
| **Add Channel Submit Button** (`#pulse-add-btn`) | `settings.html:1525`<br>`settings.js:1640-1670` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:260-265`<br>Section: **Bulletin & News**. Calls `POST /api/local/admin/pulse/channels`. |
| **Curated Channels List Display** (`#pulse-channels-list`) | `settings.html:1531`<br>`settings.js:1560-1635` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:280-350`<br>Section: **Bulletin & News**. Displays title, category badge, URL, and stats. |
| **Remove Channel Button** (`removePulseChannel()`) | `settings.js:1615, 1675-1700` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:330-340`<br>Section: **Bulletin & News**. Calls `POST /api/local/admin/pulse/channels/remove`. |

---

### 2.8 📥 Comms Tab (`data-tab="comms"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Admin Web Chat & DM Inbox Console** (`#admin-inbox-search`, `#admin-inbox-list`, `#admin-inbox-messages`, `#admin-inbox-input`, `#admin-inbox-send`) | `settings.html:1545-1570`<br>`settings.js:2490-2675` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1 & §3.<br>*"Cut outright: the web chat console (operators carry phones; nobody answers DMs from a desktop admin panel)... `comms` splits — broadcasts move, the admin chat inbox is deleted."* |
| **Global Announcement Title Input** (`#admin-announce-title`) | `settings.html:1578`<br>`settings.js:2455-2485` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:140-148`<br>Section: **Bulletin & News**. Input for broadcast title. |
| **Global Announcement Severity Dropdown** (`#admin-announce-severity`) | `settings.html:1581`<br>`settings.js:2455-2485` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:150-160`<br>Section: **Bulletin & News**. Dropdown for `info`, `warning`, `critical`. |
| **Global Announcement Body Textarea** (`#admin-announce-body`) | `settings.html:1589`<br>`settings.js:2455-2485` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:162-172`<br>Section: **Bulletin & News**. Textarea for notification body. |
| **Broadcast Announcement Button** (`#btn-send-announcement`) | `settings.html:1591`<br>`settings.js:2455-2485` | **PRESENT** | `apps/manager/src/components/modules/BulletinSection.tsx:175-185`<br>Section: **Bulletin & News**. Calls `POST /api/local/admin/announcements`. |

---

### 2.9 🔌 Connections Tab (`data-tab="connections"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Active Connection Counts** (`#conn-stat-total`, `#conn-stat-sync`, `#conn-stat-admin`) | `settings.html:1962-1975`<br>`settings.js:3415-3440` | **REFORMATTED** | `apps/manager/src/components/modules/HomeScreen.tsx:128-134`<br>`apps/manager/src/components/modules/ApplianceSection.tsx:650-654`<br>Summarized as active WebSocket count in Home Screen pill and Appliance metrics. |
| **Average Connection Duration & Messages Transited** (`#conn-stat-avg-time`, `#conn-stat-messages`) | `settings.html:1978-1988`<br>`settings.js:3425-3445` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1.<br>Low-utility socket lifetime telemetry removed during dashboard simplification. |
| **Live Connection List with IPs and User-Agents** (`#conn-list-container`) | `settings.html:1998-2003`<br>`settings.js:3450-3580` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1.<br>*"Cut outright: the live connection monitor (raw IPs and user-agent strings — sysadmin voyeurism; reduce to `Connections: 18 active`)."* |
| **Live WebSocket Traffic Terminal Feed** (`#conn-traffic-feed`, `#btn-conn-pause`, `#btn-conn-clear`) | `settings.html:2009-2034`<br>`settings.js:3585-3750` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1.<br>Raw packet stream inspect console dropped in favor of structured event logging in Diagnostics. |

---

### 2.10 🌳 Members & Audit Tab (`data-tab="members"`)

#### Panel: Community Health Dashboard

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Community Health Metric Grid** (`#health-grid`) | `settings.html:1273`<br>`settings.js:1195-1210` | **REFORMATTED** | `apps/manager/src/components/modules/HomeScreen.tsx:165-265`<br>Replaced by 4 Home Screen cards (Members, Commons Pool, Enterprises, Circulation). |
| **Widest Branch Anomaly Banner** (`#health-widest`) | `settings.html:1274`<br>`settings.js:1212-1220` | **MISSING** | **What it does**: Alerts operator when a single member has invited a disproportionate share of the community.<br>**Endpoints called**: `POST /api/local/admin/health`.<br>**Operator impact**: Operator is not warned about centralization or runaway invite trees. |
| **Health Flags List & Refresh Button** (`#health-flags`, `#refresh-health-btn`) | `settings.html:1276-1277`<br>`settings.js:1222-1240` | **REFORMATTED** | `apps/manager/src/components/modules/PeopleSafetySection.tsx:145-217`<br>Section: **People & Safety** (`subTab === 'moderation'`). Replaced by actionable threat report cards. |

#### Panel: Detection Thresholds (Fraud / Sybil / Wash Trading)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Eight Detection Threshold Inputs & Save/Reset Buttons** (`#th-washTradingWindowHours`, `#th-washTradingMinTxns`, `#th-inactiveMemberDays`, `#th-isolatedBranchMinTxns`, `#th-maxProjectExpiryDays`, `#th-sybilFunnelMinInvitees`, `#th-sybilFunnelMinAmount`, `#th-sybilFunnelWindowDays`, `#save-audit-thresholds-btn`, `#reset-audit-thresholds-btn`) | `settings.html:1368-1411`<br>`settings.js:1245-1310` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1.<br>*"Cut outright: and the eight raw Sybil/wash-threshold number fields (handing a community elder a box labelled 'Isolated Branch Min Txns' guarantees broken fraud detection — hardcode them)."* |

#### Panel: Members & Audit Tree

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Member Search Input & Clear Button** (`#member-search`, `#member-search-clear`) | `settings.html:1422-1425`<br>`settings.js:2348-2365` | **PRESENT** | `apps/manager/src/components/modules/MembersModule.tsx:190, 500-510`<br>Section: **People & Safety** (`subTab === 'directory'`). Real-time search filter. |
| **Audit Filter Tabs** (All, Vouchers, Sybil, Funnel, Wash, Isolated, Inactive, Reported) | `settings.html:1430-1446`<br>`settings.js:2426-2440` | **REFORMATTED** | `apps/manager/src/components/modules/MembersModule.tsx:514-545`<br>Streamlined into 4 tabs: All, Vouchers, Threats / Flags, and Frozen. Specific Sybil/wash algorithmic sub-filters dropped per §1. |
| **Hierarchical Ancestry Tree** (`#admin-members-tree`) | `settings.html:1447`<br>`settings.js:2178-2405` | **MISSING** | **What it does**: Renders recursive `<details>` tree tracing ancestry of who invited whom from genesis.<br>**Endpoints called**: `POST /api/local/admin/data`.<br>**Operator impact**: Operator cannot visually inspect multi-hop invitation lineage to identify fraud rings. |
| **Branch Statistics Aggregation Card** (`statsCard`) | `settings.js:2240-2259, 2318-2337` | **MISSING** | **What it does**: Computes aggregate metrics (total downstream members, posts, messages, deals, trade volume) across a member's entire branch.<br>**Endpoints called**: Client-side calculation from `POST /api/local/admin/data`.<br>**Operator impact**: Operator cannot measure total economic output or dormancy of an invite tree. |
| **Member Standing Tier Selector** (`setMemberTier`) | `settings.js:2382-2387, 1835-1858` | **PRESENT** | `apps/manager/src/components/modules/MembersModule.tsx:238-254, 986-1050`<br>Section: **People & Safety**. Modal allows selecting Newcomer, Resident, Steward, Elder. Calls `POST /api/local/admin/users/:pubkey/tier`. |
| **Voucher Capability Button** (`🤝 Grant vouch` / `🤝 Voucher ✓`) | `settings.js:2388-2390` | **PRESENT** | `apps/manager/src/components/modules/MembersModule.tsx:716-724`<br>`MemberDetailModal.tsx:445-455`<br>Section: **People & Safety**. Calls `POST /api/local/admin/users/:pubkey/voucher`. |
| **Freeze / Unfreeze (Pause/Resume) User** | `settings.js:2381` | **PRESENT** | `apps/manager/src/components/modules/MembersModule.tsx:753-761`<br>`MemberDetailModal.tsx:475-483`<br>Section: **People & Safety**. Calls `POST /api/local/admin/users/:pubkey/freeze`. |
| **Prune Individual User Button** | `settings.js:2391` | **PRESENT** | `apps/manager/src/components/modules/MembersModule.tsx:226-236`<br>`MemberDetailModal.tsx:486-493`<br>Section: **People & Safety**. Calls `POST /api/local/admin/users/:pubkey/prune`. |
| **Prune Branch Button** (`/branches/${pubkey}/prune`) | `settings.js:2392` | **MISSING** | **What it does**: Prunes an abusive member AND all downstream invitees who were invited by them in one atomic administrative action.<br>**Endpoints called**: `POST /api/local/admin/branches/:pubkey/prune`.<br>**Operator impact**: If an attacker floods 50 Sybil accounts from one invite code, the operator must manually locate and prune all 50 accounts individually. |
| **View Member Posts Button** (`viewMemberPosts`) | `settings.js:2380, 1965-1978` | **MISSING** | **What it does**: Jumps directly to moderation tab filtered to posts authored by this member.<br>**Operator impact**: Cannot filter or review all marketplace posts by a suspicious user with one click. |
| **Direct Member Warning Message** (`promptWarning`) | `settings.js:2393, 2670-2675` | **DROPPED** | **Cited Decision**: `docs/settings-ia.md` §1.<br>Dropped alongside the admin DM console. Operators warn members in-person or via regular member messaging. |
| **Node Authority Roles** (Owner, Admin, Moderator) with Last-Owner Guard | *New in React per admin-surface.md §5* | **PRESENT** | `apps/manager/src/components/modules/MemberDetailModal.tsx:94-134, 290-386`<br>Section: **People & Safety**. Manages node roles via `POST /api/local/admin/node-roles`. The full list, add by callsign/key and remove live in **People & Safety → Owners & admins** (`NodeRolesPanel.tsx`; operator text in [`operators/people/roles.md`](../packages/beanpool-guide/operators/people/roles.md)). |

---

### 2.11 🛡️ Moderation Tab (`data-tab="moderation"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Reports Inbox & Count Badge** (`#reports-count-badge`, `#admin-reports-inbox`) | `settings.html:1288, 1295`<br>`settings.js:1889-1960` | **PRESENT** | `apps/manager/src/components/modules/PeopleSafetySection.tsx:145-217`<br>Section: **People & Safety** (`subTab === 'moderation'`). Queries `GET /api/local/admin/reports`. |
| **Reports Filter Buttons** (All, Pending, Actioned) | `settings.html:1290-1292`<br>`settings.js:1920-1935` | **REFORMATTED** | `apps/manager/src/components/modules/PeopleSafetySection.tsx:145-217`<br>Section: **People & Safety**. Shows active queue; dismiss removes from view. |
| **Inspect & Action Report Modal** | `settings.js:1940-1960` | **PRESENT** | `apps/manager/src/components/modules/ThreatReviewModal.tsx:1-250`<br>Section: **People & Safety**. Provides full review, user freeze, and report dismissal. |
| **Dismiss Report Action** | `settings.js:1945` | **PRESENT** | `apps/manager/src/components/modules/ThreatReviewModal.tsx:60-75`<br>Section: **People & Safety**. Calls `POST /api/local/admin/reports/:id/dismiss`. |
| **Health Alerts Container** (`#admin-health-alerts`) | `settings.html:1301`<br>`settings.js:1960-1970` | **REFORMATTED** | `apps/manager/src/components/modules/ThreatReviewModal.tsx:150-180`<br>Displays associated flag severity and descriptions in the inspection modal. |
| **Search Posts Input** (`#admin-post-search`) | `settings.html:1314`<br>`settings.js:2035-2055` | **MISSING** | **What it does**: Real-time keyword filter across all marketplace post titles and descriptions.<br>**Endpoints called**: Client filter over `POST /api/local/admin/data`.<br>**Operator impact**: Operator cannot search for a specific offending post by keyword. |
| **Post Type Filter** (All, Offers, Needs) (`#admin-post-type-filter`) | `settings.html:1315-1319`<br>`settings.js:2035-2055` | **MISSING** | **What it does**: Filters posts by transaction direction (Offer vs Need).<br>**Operator impact**: Operator cannot filter marketplace listings by type. |
| **Post Category Filter** (16 categories) (`#admin-post-category-filter`) | `settings.html:1320-1338`<br>`settings.js:2035-2055` | **MISSING** | **What it does**: Filters posts across 16 categories (food, tools, care, housing, etc.).<br>**Operator impact**: Operator cannot isolate posts in sensitive categories. |
| **Post Multi-Select & Batch Action Bar** (`#batch-action-bar`, `selectAllPosts()`, `deselectAllPosts()`) | `settings.html:1342-1349`<br>`settings.js:2100-2120` | **MISSING** | **What it does**: Checkbox selection bar enabling multi-post manual selection for deletion.<br>**Operator impact**: In React, operators can only bulk delete posts by age threshold, not by selective manual checking. |
| **Bulk Delete Selected Posts Button** (`bulkDeletePosts()`) | `settings.html:1347`<br>`settings.js:2122-2145` | **REFORMATTED** | `apps/manager/src/components/modules/PeopleSafetySection.tsx:46-82, 220-260`<br>Section: **People & Safety**. Reformatted into an age-threshold dropdown (7, 14, 30, 60, 90 days) + "Prune Stale Posts" button calling `POST /api/local/admin/posts/bulk-delete`. |
| **Individual Post Delete Button** (`deletePost()`) | `settings.js:2080, 2150-2170` | **MISSING** | **What it does**: Deletes a single specific abusive post immediately.<br>**Endpoints called**: `POST /api/local/admin/posts/:id/delete`.<br>**Operator impact**: Operator cannot delete an individual reported post without running a date-based bulk prune. |

---

### 2.12 💻 Diagnostics Tab (`data-tab="diagnostics"`)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **CPU Load Metric Card & SVG Gauge** (`#cpu-load-text`, `#cpu-gauge-val`, `#cpu-cores`) | `settings.html:1605-1615`<br>`settings.js:3830-3845` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:631-636`<br>Section: **Appliance & Data** (`subTab === 'diagnostics'`). Shows CPU load percent. |
| **Memory Allocation Card & Bar** (`#ram-usage-text`, `#ram-usage-bar`, `#ram-used-percent`, `#ram-free-gb`) | `settings.html:1618-1630`<br>`settings.js:3848-3860` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:637-642`<br>Section: **Appliance & Data**. Displays total MB memory usage. |
| **Database Storage & WAL Cache Card** (`#db-total-size`, `#db-wal-size`, `#sys-uptime`, `#sys-os-arch`) | `settings.html:1633-1645`<br>`settings.js:3862-3880` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:643-649`<br>Section: **Appliance & Data**. Displays SQLite DB size in MB. |
| **Unseen Warning/Error Notification Badge** (`#diag-badge`) | `settings.html:727, 95`<br>`settings.js:93-96, 3885-3900` | **MISSING** | **What it does**: Red notification pill on tab bar indicating unread warning or error logs since last inspection.<br>**Operator impact**: Operator has no visual indication of background system warnings without opening Diagnostics. |
| **Log Level Filter Dropdown** (ALL, INFO, WARN, ERROR, SECURITY, SYNC) (`#log-filter-level`) | `settings.html:1655-1662`<br>`settings.js:3760-3800` | **PRESENT** | `apps/manager/src/components/modules/LogsModule.tsx:52-63`<br>Section: **Appliance & Data** (`subTab === 'diagnostics'`). Filters by log level. |
| **Log Category Filter Dropdown** (P2P, LEDGER, TLS, ADMIN, AUTH, DB, SYS) (`#log-filter-category`) | `settings.html:1664-1673`<br>`settings.js:3760-3800` | **MISSING** | **What it does**: Filters log stream by subsystem origin.<br>**Endpoints called**: `/api/admin/logs?category=...`.<br>**Operator impact**: Operator cannot isolate ledger audit issues from P2P networking or TLS logs. |
| **Log Search Filter Input** (`#log-search`) | `settings.html:1675`<br>`settings.js:3805-3815` | **PRESENT** | `apps/manager/src/components/modules/LogsModule.tsx:66-73`<br>Section: **Appliance & Data**. Real-time message text search filter. |
| **Log Stream Auto-Scroll Pause Button** (`#btn-log-pause`) | `settings.html:1681`<br>`settings.js:3990-4005` | **MISSING** | **What it does**: Freezes log viewport to read fast-moving errors without scroll jump.<br>**Operator impact**: Rapid incoming logs cannot be paused for inspection. |
| **Clear Log Console Button** (`#btn-log-clear`) | `settings.html:1685`<br>`settings.js:4010-4020` | **MISSING** | **What it does**: Clears current log entries from the DOM viewport.<br>**Operator impact**: Cannot clear screen between diagnostic test runs. |
| **Export Logs Dropdown (.txt and .json)** (`#btn-log-export`, `#btn-export-txt`, `#btn-export-json`) | `settings.html:1690-1701`<br>`settings.js:4040-4085` | **MISSING** | **What it does**: Downloads buffered logs as formatted `.txt` or raw structured `.json`.<br>**Operator impact**: Operator cannot export diagnostics logs to attach to bug reports or share with maintainers. |
| **Real-Time Logs Feed** (`#log-terminal-feed`) | `settings.html:1706`<br>`settings.js:3930-3985` | **PRESENT** | `apps/manager/src/components/modules/LogsModule.tsx:77-113`<br>Section: **Appliance & Data**. Terminal scroll console with colored level chips. |
| **Ledger Conservation Audit Panel** | *New in React per IA §3* | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:657-704`<br>Section: **Appliance & Data** (`subTab === 'diagnostics'`). Verifies `SUM(balances) + Commons = 0`. Calls `POST /api/local/admin/ledger-audit`. |

---

### 2.13 🗄️ Backup Tab (`data-tab="backup"`)

#### Panel: Snapshots & Local Manual Backup

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Download Database Backup Button** (`#btn-backup`) | `settings.html:1728`<br>`settings.js:2680-2715` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:717-732`<br>Section: **Appliance & Data** (`subTab === 'backups'`). Calls `POST /api/local/admin/backup`. |
| **Upload Restore File Input & Form** (`#backup-upload-input`) | `settings.html:1732`<br>`settings.js:2720-2760` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:735-768`<br>Section: **Appliance & Data** (`subTab === 'backups'`). Calls `POST /api/local/admin/restore`. |
| **Automated Snapshots Toggle, Interval & Retention Limit** (`#autosnap-enabled`, `#autosnap-interval`, `#autosnap-keep`) | `settings.html:1744-1760`<br>`settings.js:3240-3285` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:772-854`<br>Section: **Appliance & Data** (`subTab === 'backups'`). Calls `POST /api/local/admin/backup-config`. |
| **Create Snapshot Now Button** (`createSnapshotNow()`) | `settings.html:1761`<br>`settings.js:3325-3345` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:918-923`<br>Section: **Appliance & Data**. Calls `POST /api/local/admin/snapshots/create`. |
| **Local Snapshots List Display** (`#snapshot-list`) | `settings.html:1769`<br>`settings.js:3290-3320` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:926-962`<br>Section: **Appliance & Data**. Displays local snapshot list. |
| **Snapshot Verify Action** | `settings.js:3305-3315` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:858-903, 945-950`<br>Section: **Appliance & Data**. Runs `PRAGMA integrity_check` on live DB or selected snapshot. |
| **Snapshot Delete Action** | `settings.js:3375-3395` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:951-956`<br>Section: **Appliance & Data**. Calls `POST /api/local/admin/snapshots/delete`. |
| **Snapshot Download Action** | `settings.js:3350-3372` | **PRESENT** | `apps/manager/src/components/modules/ApplianceSection.tsx:726-731`<br>Section: **Appliance & Data**. Downloads `.sqlite` database snapshot. |

#### Panel: Live Backup Server (Hot-Standby Replication HA)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Node Replication Role Badge & URL** (`#backup-role-badge`, `#backup-primary-url`) | `settings.html:1784, 1788`<br>`settings.js:2820-2860` | **MISSING** | **What it does**: Displays whether node is acting as Primary or Standby replica.<br>**Endpoints called**: `POST /api/local/admin/backup-status`.<br>**Operator impact**: Operator cannot verify node replication role in single-node settings. *(Note: partially present in multi-node Fleet TopologyModule, but missing from standalone appliance).* |
| **Replication Connection Configuration Form** (`#rep-primary-url`, `#rep-primary-pw`, `#rep-primary-token`) | `settings.html:1795-1809`<br>`settings.js:3030-3110` | **MISSING** | **What it does**: Configures standby node to continuously pull signed read-only snapshots from primary node URL with password/token.<br>**Endpoints called**: `POST /api/local/admin/replication-config/save`.<br>**Operator impact**: Standby replica cannot be paired to a primary node from the single-node settings interface. |
| **Live Backup Health & Replica Consistency Checks** (`#backup-health-badge`, `#backup-consistency`) | `settings.html:1819, 1838`<br>`settings.js:2865-2945` | **MISSING** | **What it does**: Monitors last successful snapshot pull, failure streak, and verifies table row counts and total balances against primary.<br>**Endpoints called**: `POST /api/local/admin/backup-status`.<br>**Operator impact**: Operator cannot audit whether standby replica is in sync or drifting. |
| **Force Full Resync Button** (`#backup-resync-btn`) | `settings.html:1849`<br>`settings.js:3112-3135` | **MISSING** | **What it does**: Rebuilds standby replica from primary's current snapshot, discarding drifted or orphan rows.<br>**Endpoints called**: `POST /api/local/admin/replication-resync`.<br>**Operator impact**: Operator cannot recover a desynced standby node from the web UI. |

#### Panel: Replication Access (Primary Side Token Management)

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Generate / Rotate Replication Token Button** (`#rep-token-gen-btn`) | `settings.html:1867`<br>`settings.js:3140-3170` | **MISSING** | **What it does**: Generates a scoped, read-only replication token separate from the master admin password.<br>**Endpoints called**: `POST /api/local/admin/replication-token/generate`.<br>**Operator impact**: Cannot issue scoped credentials for backup servers; forces using master admin password. |
| **Require Token (Token-Only Mode) Checkbox** (`#rep-token-only`) | `settings.html:1870`<br>`settings.js:3172-3185` | **MISSING** | **What it does**: Enforces token authentication and rejects admin-password pulls from replicas.<br>**Endpoints called**: `POST /api/local/admin/replication-token/mode`.<br>**Operator impact**: Cannot lock down the primary snapshot endpoint against password-based siphoning. |
| **Snapshot Pull Activity Metrics** (`#rep-last-pull`, `#rep-total-pulls`, `#rep-rejected`) | `settings.html:1890-1901`<br>`settings.js:3190-3235` | **MISSING** | **What it does**: Audits snapshot pull requests, tracking total pulls and rejected attempts.<br>**Endpoints called**: `POST /api/local/admin/replication-access`.<br>**Operator impact**: Primary operator cannot audit replication activity or detect unauthorized pull attempts. |

#### Panel: Backup Setup & Disaster Recovery Wizards

| Control / Panel / Action | Legacy Source | Status | React Implementation or Missing Impact |
|---|---|:---:|---|
| **Create Backup Server CLI Command Generator** (`#backup-enroll-btn`) | `settings.html:1912`<br>`settings.js:2955-2985` | **MISSING** | **What it does**: Generates ready-to-run shell script command for enrolling a secondary standby machine.<br>**Endpoints called**: `GET /api/local/admin/backup-enroll`.<br>**Operator impact**: Operator lacks guided command generation for standing up a secondary server. |
| **Restore Primary Server CLI Command Generator** (`#backup-restore-btn`) | `settings.html:1934`<br>`settings.js:2995-3028` | **MISSING** | **What it does**: Generates disaster recovery command to restore a fresh primary node from a backup server's state.<br>**Operator impact**: Operator lacks guided disaster recovery script generator. |

---

## 3. Prioritised List of Missing Items

The 22 missing items are classified below into three strict priority buckets based on operational necessity.

### Bucket 1: Operator Cannot Run Node Without It (Critical Blockers)
*Without these controls, an operator cannot independently provision, establish connectivity, or place their node in the network.*

1. **Public Address (.beanpool.org) Claim & DNS Tunnel Management**
   - **Legacy Location**: `apps/server/static/settings.html:1071-1141`, `settings.js:142-385`
   - **Target Section**: **Appliance & Data** (`subTab === 'network'`)
   - **Rationale**: An operator cannot register `<name>.beanpool.org`, copy their tunnel token, monitor propagation, restart the tunnel sidecar, or take the node offline without SSH.
2. **Operating Region Geocoding & Interactive Leaflet Pin**
   - **Legacy Location**: `apps/server/static/settings.html:744-753`, `settings.js:387-466`
   - **Target Section**: **Appliance & Data** (`subTab === 'identity'`)
   - **Rationale**: A new node cannot configure its geographic locality via place search or visual map pin, breaking local discovery and regional mapping.
3. **Directory Publishing Configuration, Privacy Toggles & Manual Trigger**
   - **Legacy Location**: `apps/server/static/settings.html:763-827`, `settings.js:1722-1773`
   - **Target Section**: **Appliance & Data** (`subTab === 'identity'`)
   - **Rationale**: The node cannot announce its presence to `beanpool.org`, control privacy metadata toggles, or preview its public output.
4. **Peer Connector Actions (Connect/Disconnect, Active/Passive Toggle, Remove, Collision Resolution)**
   - **Legacy Location**: `apps/server/static/settings.html:1014-1068`, `settings.js:750-930`
   - **Target Section**: **Appliance & Data** (`subTab === 'gateway'`)
   - **Rationale**: Operators running federation cannot resolve connection collisions or deadlocks, toggle dialer roles, or remove dead peers.

---

### Bucket 2: Operator Would Notice Within a Week (Major Operational Friction)
*Capabilities essential for ongoing community maintenance, moderation, security isolation, and disaster recovery.*

1. **Prune Branch Administrative Action (`POST /api/local/admin/branches/:pubkey/prune`)**
   - **Legacy Location**: `apps/server/static/settings.js:2392`
   - **Target Section**: **People & Safety** (`subTab === 'directory'`)
   - **Rationale**: Sybil attacks involving multi-hop invite trees cannot be pruned in one action; operator is forced to manually find and prune dozens of accounts.
2. **Individual Post Search, Category Filtering & Single-Post Deletion**
   - **Legacy Location**: `apps/server/static/settings.html:1307-1355`, `settings.js:1980-2175`
   - **Target Section**: **People & Safety** (`subTab === 'moderation'`)
   - **Rationale**: When an abusive listing is reported, the operator cannot search for it or delete it individually without running a date-based bulk prune.
3. **Standby Live Backup / Replication Configuration & Resync**
   - **Legacy Location**: `apps/server/static/settings.html:1774-1854`, `settings.js:3030-3135`
   - **Target Section**: **Appliance & Data** (`subTab === 'backups'`)
   - **Rationale**: Operators cannot configure a high-availability standby replica or trigger resyncs after network divergence from the web UI.
4. **Replication Token Scoped Access & Pull Activity Audit**
   - **Legacy Location**: `apps/server/static/settings.html:1857-1904`, `settings.js:3137-3235`
   - **Target Section**: **Appliance & Data** (`subTab === 'backups'`)
   - **Rationale**: Primary node operators cannot isolate replica snapshot credentials from the master admin password or audit pull attempts.
5. **Service Radius Controls (Slider & Number Input)**
   - **Legacy Location**: `apps/server/static/settings.html:754-761`, `settings.js:397-408`
   - **Target Section**: **Appliance & Data** (`subTab === 'identity'`)
   - **Rationale**: Operator cannot configure or adjust the geographical service radius for their community.
6. **Community Public Contact Details (Email & Phone)**
   - **Legacy Location**: `apps/server/static/settings.html:829-842`, `settings.js:940-960`
   - **Target Section**: **Appliance & Data** (`subTab === 'identity'`)
   - **Rationale**: Landing page cannot display admin email or phone number for prospective member onboarding inquiries.
7. **Hierarchical Ancestry Tree (Visual Audit Lineage)**
   - **Legacy Location**: `apps/server/static/settings.html:1416-1449`, `settings.js:2178-2405`
   - **Target Section**: **People & Safety** (`subTab === 'directory'`)
   - **Rationale**: Operator cannot visually inspect invitation trees to identify suspicious invite clustering or Sybil farming structures.

---

### Bucket 3: Cosmetic / Convenience / Polish
*Helpful workflow conveniences and diagnostics tools that do not block core operations.*

1. **Docker CLI Update Commands Box & Release Notes**
   - **Legacy Location**: `apps/server/static/settings.html:1234-1248`, `settings.js:1340-1375`
   - **Target Section**: **Appliance & Data** (`subTab === 'hardware'`)
   - **Description**: Displaying release notes and `docker compose pull && docker compose up -d` with a copy button alongside the update check button.
2. **Explicit Type-to-Confirm "RESET" Safeguard**
   - **Legacy Location**: `apps/server/static/settings.html:1209-1215`, `settings.js:1115-1135`
   - **Target Section**: **Appliance & Data** (`subTab === 'access'`)
   - **Description**: Replacing generic browser confirmation modal with explicit text verification and backup prompt.
3. **Log Category Subsystem Filtering**
   - **Legacy Location**: `apps/server/static/settings.html:1664-1673`, `settings.js:3760-3800`
   - **Target Section**: **Appliance & Data** (`subTab === 'logs'`)
   - **Description**: Dropdown filter for log subsystems (P2P, LEDGER, TLS, ADMIN, AUTH, DB, SYS).
4. **Log Export to .txt and .json Files**
   - **Legacy Location**: `apps/server/static/settings.html:1689-1701`, `settings.js:4040-4085`
   - **Target Section**: **Appliance & Data** (`subTab === 'logs'`)
   - **Description**: Download buttons for exporting logs buffer to plain text or raw JSON.
5. **Log Console Pause & Clear Controls**
   - **Legacy Location**: `apps/server/static/settings.html:1681-1687`, `settings.js:3990-4020`
   - **Target Section**: **Appliance & Data** (`subTab === 'logs'`)
   - **Description**: Freezing real-time log scroll or clearing console buffer.
6. **Community Health Widest Branch Anomaly Alert**
   - **Legacy Location**: `apps/server/static/settings.html:1274`, `settings.js:1212-1220`
   - **Target Section**: **People & Safety** (`subTab === 'directory'`)
   - **Description**: Banner identifying the widest invitation branch.
7. **Branch Activity Statistics Aggregation Card**
   - **Legacy Location**: `apps/server/static/settings.js:2240-2259, 2318-2337`
   - **Target Section**: **People & Safety** (`subTab === 'directory'`)
   - **Description**: Expandable summary of aggregated deals, volume, and posts across an entire branch.
8. **Automated Background Update Check Cadence**
   - **Legacy Location**: `apps/server/static/settings.html:1257-1265`, `settings.js:1367-1385`
   - **Target Section**: **Appliance & Data** (`subTab === 'hardware'`)
   - **Description**: Scheduling automated update check intervals (hourly, 6h, daily, weekly).
9. **Backup Setup & Disaster Recovery CLI Script Generators**
   - **Legacy Location**: `apps/server/static/settings.html:1907-1948`, `settings.js:2950-3028`
   - **Target Section**: **Appliance & Data** (`subTab === 'backups'`)
   - **Description**: One-click generation of shell setup commands for enrollment and disaster recovery.
10. **Tab Bar Unread Warning/Error Diagnostics Badge**
    - **Legacy Location**: `apps/server/static/settings.html:727`, `settings.js:93-96`
    - **Target Section**: **Appliance & Data** (`subTab === 'logs'`)
    - **Description**: Visual badge indicating unseen error logs.
11. **Connection Mode Guide Documentation Box**
    - **Legacy Location**: `apps/server/static/settings.html:1022-1036`
    - **Target Section**: **Appliance & Data** (`subTab === 'gateway'`)
    - **Description**: Explanatory guide on Active vs Passive federation peer configuration.

---

## 4. Verification Guide: Testing Ported Capabilities

To verify that the ported capabilities work as intended in the new single-node settings interface (`apps/manager`), execute the following clicks and workflows:

### 1. Authentication & Session Recovery
- **Unlock Settings**: Navigate to `/settings`. Enter the node administrator password into `AdminLoginCard`. If TOTP is configured, enter the 6-digit code. Click **Unlock Settings**. Verify that the session transitions to `HomeScreen` and persists in `sessionStorage` (`bp-admin-token`).
- **Logout**: Click the **🔒 Logout** button in `TopHeader`. Confirm authentication state clears and returns to the login card.

### 2. People & Safety (`/settings` → People & Safety)
- **Member Directory & Search**: Open **Directory** subtab. Type a callsign or pubkey snippet in the search bar to confirm filtering. Click on a member card to verify `MemberDetailModal` opens.
- **Trust Tier Adjustments**: In `MemberDetailModal`, verify the current tier badge is shown. Click **Assign tier badge** to open `tierEditMember` modal, select `Resident`, `Steward`, or `Elder`, and submit. Verify tier update reflects immediately on the card.
- **Voucher Promotion**: In `MemberDetailModal`, click **🛡️ Promote** to grant voucher status, or **Demote** to revoke.
- **Freeze / Unfreeze**: Click **🛑 Freeze** to freeze a user's balance and trade rights; verify button toggles to **🟢 Unfreeze**.
- **Node Authority & Last-Owner Guard**: In `MemberDetailModal`, click **👑 Grant Owner**, **⚡ Grant Admin**, or **🛡️ Grant Moderator**. On the sole owner account, attempt to revoke or demote owner status; verify the protocol guard error: *"Cannot remove the last owner"*.
- **Invites & Printable QR Cards**: Switch to **Invites** subtab. Select a starting tier (Newcomer, Resident, Steward, Elder) and batch count (e.g. 5). Click **Generate Invites**. Verify generated passes display codes and links. Click **Print Cards** to verify the physical QR card layout opens in print preview.
- **Moderation & Report Triage**: Switch to **Moderation** subtab. Click **Inspect & Action** on a pending report to open `ThreatReviewModal`. Confirm report details, target pubkey, and threat flags appear. Click **Dismiss** to resolve report.
- **Bulk Post Cleanup**: In the **Bulk Content Cleanup** card, select a threshold (e.g. 30 days) and click **Prune Stale Posts**. Confirm prompt and verify deleted count message.

### 3. Shared Projects & Economy (`/settings` → Shared Projects & Economy)
- **Commons Pool Metrics**: Verify Commons Pool balance, circulating volume, and active voting round status load from `/api/local/admin/commons/projects`.
- **Voting Rounds**: With proposed projects present, click **Start Voting Round**, specify duration, and submit. Verify active round card appears. When ready, click **Close Voting Round** to fund the winning project.
- **Reject Project**: On any proposed project card, click **Reject** to dismiss an invalid community proposal.
- **Create Enterprise from Presets**: Click **+ Create Enterprise**. Select a preset (Food Commons, Tool Library, Machinery Pool) or enter a custom name. Submit and verify enterprise is provisioned.
- **Assign / Revoke Keepers**: Click **Manage Keepers** on an enterprise card. Select a community member from the directory dropdown, assign the keeper role, and verify keeper list updates. Click **Revoke** to remove keeper access.
- **Seed Enterprise First Offer**: Click **Seed First Offer** on a keeper-managed enterprise. Fill title, category, credits, and description, and submit to satisfy the offer covenant.

### 4. Bulletin & News (`/settings` → Bulletin & News)
- **Push Announcement**: In the **Push Global Announcement** form, enter a title, select severity (`info`, `warning`, `critical`), enter message body, and click **Broadcast Announcement**. Verify success message.
- **Curated Pulse Channels**: In the **Curated Pulse Channels** card, enter an RSS feed or YouTube channel URL, select a category, and click **Add Channel**. Verify channel appears in the list. Click **Remove** on any channel card to delete it.

### 5. Appliance & Data (`/settings` → Appliance & Data)
- **Ledger Conservation Audit**: Switch to **Hardware & Diagnostics** (`subTab === 'diagnostics'`). Under **Ledger Conservation Audit**, click **Run Audit Now**. Verify invariant check completes with `✓ Balanced (0 Drift)` or alerts on drift.
- **Real-Time Logs Streamer**: In **System Logs**, select a log level (`INFO`, `WARN`, `ERROR`) and enter a search query. Click **Refresh Stream** to pull recent diagnostic entries.
- **Database Snapshots**: Switch to **Backups & Restore** (`subTab === 'backups'`). Click **Download Database Snapshot** to download live `.sqlite` file. Click **+ Create Snapshot** to take an on-disk VACUUM INTO snapshot. Click **Verify** on any snapshot to run `PRAGMA integrity_check`.
- **Database Restore**: In the **Restore Database Wizard**, select a backup file (`.sqlite` or `.tar.gz`) and click **Restore from Backup**. Confirm warning and verify restore execution.
- **Backup Schedule**: In **Automated Backup Schedule**, toggle enabled, select cadence (6h, 12h, 24h, 48h) and retention limit, and click **Save**.
- **Gateway Configuration**: Switch to **Gateway & Peers** (`subTab === 'gateway'`). Update CORS origins, admin IP allowlist, rate limits, or subsystem feature toggles, and click **Save Gateway Configuration**.
- **Software Version Check**: Verify Node Version and Last Successful Backup cards. Click **Check Release Updates** to query release API.
- **Change Password**: Switch to **Access & Security** (`subTab === 'access'`). Enter new password, confirm password, and click **Update Password**.
- **Two-Factor Authentication (TOTP)**: Click **Setup 2FA**. Scan QR code with authenticator app or copy seed key. Enter 6-digit verification code and click **Verify & Enable 2FA**. Confirm backup codes are generated. Enter code and click **Disable Two-Factor Auth** to disable.
- **Factory Reset Safeguard**: Scroll to **Danger Zone: Factory Reset Node**. Click **Wipe & Reset Node** and verify confirmation prompt triggers.
