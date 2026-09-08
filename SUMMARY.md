# Parity Implementation Summary: PWA WebSocket Resilience & Message Parity

**Worktree:** `/Users/marty/projects/bp-parity-e`  
**Date:** 2026-09-08  
**Scope:** Tasks 1, 2, and 3 (PWA WebSocket Resilience, Message Feature Parity: Reactions & Editing, Message State Parity).

---

## 1. Overview of Changes

### Task 1: PWA WebSocket Resilience
- Replaced the flat 5-second polling reconnect in `apps/pwa/src/lib/sync.ts` with exponential backoff with jitter (initial delay 1000ms, doubling up to 30,000ms max with random jitter up to 1000ms), exactly matching the native client reference (`apps/native/services/ws-client.ts`).
- Added a 30-second heartbeat ping (`JSON.stringify({ type: 'ping' })`) when the WebSocket is open, preventing proxies, load balancers, and Cloudflare from silently killing idle sockets.
- Added browser page visibility detection (`document.visibilitychange`) to immediately trigger reconnect when the user returns to the foreground, mirroring native's `AppState` listener.
- Preserved relative transport URLs (`getNodeWsUrl('/ws')`), ensuring the PWA remains securely bound to whichever node serves it without hardcoded or multi-node configurations.

### Task 2: Message Feature Parity (Reactions & Editing)
- Added `editMessageApi` (`POST /api/messages/edit`) and `toggleMessageReactionApi` (`POST /api/messages/react`) to `apps/pwa/src/lib/api.ts`.
- Updated `ApiMessage` interface with `editedAt?: string | null` and `updatedAt?: string | null`.
- Updated `Conversation` interface with `myLastReadAt?: string | null` and `readCursors?: { publicKey: string; lastReadAt: string | null }[]`.
- In `apps/pwa/src/pages/MessagesPage.tsx`:
  - Added the exact allowed reaction emoji set matching native: `['👍', '❤️', '😂', '😮', '😢', '🙏', '😁']`.
  - Added message editing with the exact 15-minute edit window (`MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000`), author-only gate, and exclusion of images and system messages.
  - Implemented E2E re-encryption on edit (`encryptDM` / `dmCtxFor` for DMs, `encodePlaintext` for fallback).
  - Added floating emoji reaction picker popover with click-outside dismissal and optimistic reaction toggling.
  - Added reaction badges below message bubbles displaying unique emoji glyphs, reaction counts, and active-user highlights.
  - Added "Editing message" preview banner above the composer with cancel ("✕") button and draft pre-fill, matching native behavior.
  - Displayed "edited · " badge before message timestamp for edited messages.

### Task 3: Message State & Read Receipt Dynamic Synchronization
- Fixed a genuine gap where `loadMessages` was ignoring `readCursors` returned in `getConversationMessages`, causing peer read receipts (`✓✓`) to never dynamically update while chatting. `loadMessages` now extracts the peer cursor and dynamically updates `activeConv.peerLastReadAt`.
- Fixed conversation list unread badges: opening a conversation now immediately clears its unread count locally upon calling `markConversationReadApi`.
- In `apps/pwa/src/App.tsx`: subscribed `onSyncActivity` to `pollUnread` so the main navigation tab bar unread badge updates immediately upon receiving WebSocket state notifications, instead of lagging up to 10 seconds.
- Ensured all UI elements fit within 320dp width and survive 1.3x font scaling with CSS variables (`var(--accent)`, `var(--bg-card)`, `var(--border-primary)`, etc.) respecting light and dark themes.

---

## 2. File-by-File Changes and Line Locations

### 1. `apps/pwa/src/lib/sync.ts`
- **Lines 23–28:** Added state variables: `reconnectTimeoutId`, `pingIntervalId`, `reconnectDelay = 1000`, `isConnecting = false`, `currentUrl = null`. Removed static `RECONNECT_INTERVAL = 5000`.
- **Lines 51–54, 61:** Added connection-in-progress and active-connection guards to eliminate connection race conditions.
- **Lines 69–89:** In `socket.onopen`, reset `reconnectDelay` to 1000ms, clear pending reconnect timers, and start 30s heartbeat interval (`socket.send(JSON.stringify({ type: 'ping' }))`) matching `apps/native/services/ws-client.ts:127-135`.
- **Line 92:** Added stale socket guard on `socket.onmessage`.
- **Lines 119–130:** In `socket.onclose`, clear heartbeat ping interval, nullify closed socket reference, and schedule exponential backoff reconnect.
- **Lines 132–135:** In `socket.onerror`, cleanly close the socket.
- **Lines 142–170:** In `connectToAnchor`, guard against duplicate connection attempts and record `currentUrl`. Kept transport relative.
- **Lines 173–184:** In `scheduleReconnect`, implement exponential backoff with jitter (`reconnectDelay + Math.random() * 1000`), doubling backoff capped at 30,000ms.
- **Lines 186–199:** Added document `visibilitychange` listener to immediately reconnect when the browser tab returns to the foreground.

### 2. `apps/pwa/src/lib/api.ts`
- **Lines 332–333:** Added `myLastReadAt?: string | null` and `readCursors?: { publicKey: string; lastReadAt: string | null }[]` to `Conversation` interface.
- **Lines 364–365:** Added `editedAt?: string | null` and `updatedAt?: string | null` to `ApiMessage` interface.
- **Lines 396–411:** Added API client functions:
  - `editMessageApi(messageId: string, authorPubkey: string, ciphertext: string, nonce: string): Promise<{ success: boolean; message: ApiMessage }>`
  - `toggleMessageReactionApi(messageId: string, authorPubkey: string, emoji: string): Promise<{ success: boolean; metadata: string }>`

### 3. `apps/pwa/src/App.tsx`
- **Line 12:** Imported `onSyncActivity` from `./lib/sync`.
- **Lines 216–221:** Connected `onSyncActivity(() => pollUnread())` inside the unread-polling effect to provide instant unread badge updates on incoming WebSocket events without 10-second polling delay.

### 4. `apps/pwa/src/pages/MessagesPage.tsx`
- **Line 12:** Imported `editMessageApi` and `toggleMessageReactionApi` from `../lib/api`.
- **Lines 20–21:** Declared `ALLOWED_REACTIONS` (`['👍', '❤️', '😂', '😮', '😢', '🙏', '😁']`) and `MESSAGE_EDIT_WINDOW_MS = 15 * 60 * 1000`.
- **Lines 157–158:** Added component states `editingMessage: ApiMessage | null` and `activeEmojiPickerId: string | null`.
- **Lines 170–174:** Added global click listener to close active emoji picker when clicking outside.
- **Lines 186–191:** On conversation change, clear editing/reaction picker state and immediately update local `conversations` unread count to 0 upon `markConversationReadApi`.
- **Lines 240–245:** In `loadConversations`, keep `activeConv` synchronized with fresh conversation state.
- **Lines 261–274:** In `loadMessages`, extract peer cursor from `result.conversation.readCursors` to keep `activeConv.peerLastReadAt` current for real-time `✓✓` read receipts.
- **Lines 277–324:** Added `handleStartEdit`, `handleCancelEdit`, and `handleToggleReaction` (with optimistic UI update).
- **Lines 400–438:** Updated `handleSend` to branch on `editingMessage`: re-encrypting ciphertext via DM context (or plaintext) and calling `editMessageApi` with optimistic update.
- **Lines 862–875:** Computed message bubble flags: `isEdited`, `canEdit` (15m author check), parsed reactions from metadata, and calculated unique emojis and reaction counts.
- **Lines 875–917:** Rendered floating emoji picker popover with the allowed 7-emoji set.
- **Lines 964–1011:** Added "edited · " text before timestamp, added "React" action, and added "Edit" action when eligible. Rendered reaction count badge pill below message bubble with active state indicator.
- **Lines 1059–1084:** Rendered "Editing message" preview banner above the composer with cancel button.
- **Lines 1121–1153:** Dynamic composer placeholder ("Edit message...") and save button ("✓") when editing.

---

## 3. Verification Commands & Results

1. **PWA TypeScript & Build Verification:**
   ```bash
   cd /Users/marty/projects/bp-parity-e/apps/pwa && npx tsc --noEmit && pnpm run build
   ```
   **Result:** `PASS` (Clean build, exit code 0, 0 TypeScript errors).

2. **PWA Unit Tests Verification:**
   ```bash
   cd /Users/marty/projects/bp-parity-e/apps/pwa && pnpm run test
   ```
   **Result:** `PASS` (2 test suites, 5 tests passed, exit code 0).

3. **Native App Check:**
   No files in `apps/native` were modified (protected files and guardrails observed).
