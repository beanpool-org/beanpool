# BeanPool Invite Architecture Walkthrough

This document outlines the final, modernized architecture of the invitation system used by the Native App (iOS & Android) and PWA. We have successfully deprecated the vulnerable proxy shortlink endpoints in favor of a robust, multi-node capable, dual-mode URL parameter architecture.

## 1. Invite Code Formats

There are two distinct types of invite structures in BeanPool:

1. **Standard Online Invite (`INV-XXXX-XXXX`)**: Generated directly by a specific community node via the `/api/invite/generate` or `/api/admin/seed-invite` endpoints. These are short, 13-character string codes.
2. **Offline Binary Fallback (`BP-...`)**: When the app is offline, it mathematically generates a ~136-character cryptographic ticket containing compressed binary data (Inviter Public Key, Timestamp, and Ed25519 Signature).

---

## 2. Scenario A: The Online Flow

When the user is connected to the internet or the local mesh network, the app communicates directly with the chosen community node to generate a secure invite code.

### The Generation Flow
1. **Request:** The user clicks "Generate Invite" in the Native App.
2. **Node Fetch:** The app directly POSTs the user's `publicKey` to their active node's `/api/invite/generate` endpoint.
3. **Result:** The node returns a standard `INV-XXXX-XXXX` code.
4. **Sharing:** The app generates a QR code and a Universal Link using the node's domain (e.g., `https://my-node.org/?invite=INV-XXXX-XXXX`).

### The Redemption Flow
1. **Link Interception:** The invitee clicks the link or scans the QR code.
2. **Routing (Native App):** If the app is installed, Apple/Android immediately intercepts the link. The app parses the `INV-` code AND extracts the community node URL (`my-node.org`), setting it as the active anchor.
3. **Routing (Web Trampoline):** If the app is *not* installed, the browser opens the PWA. The PWA detects the `invite` parameter and renders the App Store buttons. The invite survives the store detour by two mechanisms:
   - **Android — Play Install Referrer:** the Play button's URL carries `referrer=invite=…&server=…`; on first launch the app reads it via the Install Referrer API and drops the user straight into the join wizard with the invite and node pre-filled. No user action needed.
   - **Clipboard (iOS + fallback):** tapping either store button copies the invite link to the clipboard. On first launch the app's welcome screen offers a one-tap *"Been sent an invite? Tap to check your clipboard"* (the clipboard is only read on that tap), plus a manual **Paste** button on the join screen.
4. **Registration:** The new user enters their callsign. The app submits the `INV-` code to the active node for validation, instantly registering them to the network.

---

## 3. Scenario B: The Offline Flow

When the user is entirely disconnected from the mesh, the app falls back to a self-contained cryptographic deep link. No proxy server is needed.

### The Generation Flow
1. **Request:** The user clicks "Generate Invite" while offline in the bush.
2. **Fetch Failure:** The app's network request to `/api/invite/generate` fails.
3. **Cryptographic Signing:** The app seamlessly falls back to packing raw bytes:
   - 32 bytes (Public Key)
   - 4 bytes (Timestamp)
   - 64 bytes (Signature)
4. **Result:** The 100-byte array is Base64Url encoded. The app creates a Universal Link using its last known node URL: `https://my-node.org/?invite=BP-ey...`
5. **Sharing:** The inviter shares this via a dynamically generated QR code or Bluetooth message.

### The Redemption Flow
1. **Link Interception:** The invitee clicks the link or scans the QR code.
2. **Routing:** Just like the online flow, the link either opens the Native App directly via Universal Links or opens the PWA Trampoline, where the `BP-` token rides the same install-gap mechanisms (Play Install Referrer on Android; clipboard copy + first-launch clipboard check elsewhere).
3. **Cryptographic Verification:** When the invitee eventually connects to the network and hits "Create Self-Managed Identity", the app sends the raw `BP-` token to the node. The node mathematically verifies the 64-byte signature against the inviter's Public Key, ensuring it hasn't expired (max 7 days), and registers the new member—all without the original inviter ever having to go online!

---

## 4. Multi-Node Support & Manual Entry

To fully support BeanPool's decentralized, multi-node capabilities, the architecture handles two critical edge cases:

1. **Switching Nodes via Link:** If a user is *already logged in* to Node A, but clicks an invite link for Node B, the Native App intercepts the intent globally. It presents an alert: *"You've been invited to a different community node. Would you like to switch your active connection?"* If accepted, the app switches the active node and performs a background sync.
2. **Manual Bare-Code Entry:** If a user receives a bare code (e.g., `INV-A1B2-C3D4`) over the phone without a link, they can type it into the "Join BeanPool" screen. Because the bare code lacks a domain name, the UI now features an optional **"Community Node URL"** input field, allowing the user to manually specify which node database the app should query, ensuring no reliance on hardcoded fallback nodes.
