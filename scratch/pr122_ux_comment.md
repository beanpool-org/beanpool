### 🎨 Specialized UX & Accessibility Review

**PR:** [#122](https://github.com/beanpool-org/beanpool/pull/122) (Cross-Node Settlement State Machine & Ledger Labels)  
**Role:** UX & Accessibility Specialist

---

### Focus Area 1: User-Facing Copy & Ledger Labels
- **Finding (`apps/server/src/federation-bridge.ts:200`):** Connector callsigns are checked via `if (byPeer?.callsign)`. If an operator inputs leading/trailing spaces or whitespace-only strings (e.g., `"   "`), it evaluates as truthy and displays `🌐    ` instead of falling back to `'🌐 Another community'`.
  - **Recommendation:** Use `.trim()`: `if (byPeer?.callsign?.trim()) return \`🌐 ${byPeer.callsign.trim()}\`;`
- **Finding (`apps/server/src/federation-bridge.ts:204`):** Returning raw `🌐` emoji in ledger labels aids visual distinction for sighted users, but screen readers (VoiceOver, NVDA) read raw emojis verbatim (e.g. *"Globe showing Americas Another community"*), which can obscure the actual community name.
  - **Recommendation:** Ensure client-side UI consumers encapsulate the `🌐` prefix in an `aria-hidden` span (e.g., `<span aria-hidden="true">🌐 </span>`) or provide an explicit `aria-label="Cross-community transaction"` attribute.

---

### Focus Area 2: UI State Indicators & Accessibility Feedback
- **Finding (`apps/server/src/federation-settlement-state.ts:26`):** PR #122 defines 7 internal backend states (`escrowed`, `reserved`, `committed`, `held`, `settled`, `reversed`, `abandoned`). Displaying raw technical state strings directly in member-facing ledger views causes cognitive friction and lacks accessible status indicators during pending cross-node transactions.
  - **Recommendation:** Export a user-facing status mapper (e.g. `getSettlementUserStatus`) that maps internal states into clear status labels, visual badge variants (`pending`, `success`, `cancelled`), and descriptive `ariaLabel` strings for screen reader navigation.

---

### Focus Area 3: Transparency & Identifier Safety
- **Finding (`apps/server/src/federation-bridge.ts:214`):** `resolveCounterpartyLabel` successfully protects member UIs by resolving `bridge_<peerId>` to readable community labels. However, if `peerFromBridgeAccountId` fails to parse a peer ID or receives a malformed ID, `bridgeDisplayName` returns `null`, causing `resolveCounterpartyLabel` to return `null` and falling back to raw internal account strings (e.g., `bridge_12D3KooW...`).
  - **Recommendation:** Ensure `resolveCounterpartyLabel` guarantees a safe default for any `bridge_` prefixed account string: `return bridgeDisplayName(accountId) ?? '🌐 Another community';`.
