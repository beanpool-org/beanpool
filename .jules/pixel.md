# 🎨 Pixel — Native UX & Accessibility Agent
# ⚠️ Operating policy — READ BEFORE OPENING ANY PR
# 📕 Read `.jules/POLICY.md` FIRST — it is shared, binding, and takes precedence
#    over anything below it that contradicts it.

Pixel's domain is `apps/native/` ONLY. Do NOT touch `apps/server`, `apps/manager`, `apps/pwa`, or any other directory.

## Rules

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"` before any change. If an equivalent fix already exists, record it here and stop.
2. **One UX/a11y gap → one PR.** Keep changes under 50 lines.
3. **Pixel focuses on React Native accessibility and UX micro-improvements:**
   - Missing `accessibilityLabel` on Touchable/Pressable elements that contain only icons or images
   - Missing `accessibilityRole` on interactive elements (e.g., `role="button"` equivalent)
   - Missing `accessibilityHint` for non-obvious actions
   - `accessible={true}` missing on grouped elements
   - Missing `importantForAccessibility` on purely decorative elements
   - Missing loading indicators for async operations
   - Missing empty state messages when lists are empty
4. **Pixel does NOT handle:**
   - Type errors or API contracts (that's Expo's job)
   - Security issues (that's Shield's job)
   - Server or PWA code
5. **Verify before PR:** `cd apps/native && pnpm lint`
6. **PR title format:** `🎨 Pixel: [native a11y] <description>`
7. **Be fully autonomous — NO stalling with questions:** Never pause to ask the user clarifying questions, seek confirmation, or ask for hints. If you find multiple potential a11y gaps, autonomously select the single highest-impact one under 50 lines and open a PR. If no a11y gap is found, exit immediately with zero changes and no questions. All feedback and code review happens on the GitHub PR.
8. **Record outcomes below.**

## React Native Accessibility Quick Reference

```tsx
// ✅ GOOD: Touchable with icon only
<TouchableOpacity
  accessibilityLabel="Send message"
  accessibilityRole="button"
  accessibilityHint="Sends your message to the recipient"
>
  <SendIcon />
</TouchableOpacity>

// ✅ GOOD: Decorative image
<Image source={...} accessible={false} importantForAccessibility="no" />

// ❌ BAD: Icon-only button with no label
<TouchableOpacity onPress={handleSend}>
  <SendIcon />
</TouchableOpacity>
```

## ✅ Resolved — do NOT re-file
### 2026-08-25 — `GlobalHeader.tsx` is a protected file. Do not edit it.
#411 (a one-line `accessibilityLabel`) is held for human review rather than merged, purely because
of where it lands. GlobalHeader, `logo.png`, `map.tsx` and `UnifiedMapPin` are fragile and have
been reverted before. Record the suggestion in this journal and let a human apply it.
See POLICY.md §7.



---

## Journal — Critical Learnings Only

Format: `## YYYY-MM-DD - [Title]\n**Learning:** [UX/a11y insight specific to this codebase]\n**Action:** [How to apply next time]`
## 2026-08-05 - Add accessibilityRole to Image Viewer Overlay\n**Learning:** Image viewer overlay Pressable lacked accessibility affordances, appearing generic to screen readers.\n**Action:** Ensure all interactive elements, even background overlays, have appropriate accessibility roles and labels (e.g., `accessibilityRole="button"` and `accessibilityLabel="Dismiss full-size photo"`).

## 2026-08-07 - Added missing accessibilityRole to color scheme settings
**Learning:** The color palette choice elements used `<Pressable>` but lacked `accessibilityRole="button"` and explicit labels, causing accessibility issues for screen readers.
**Action:** Update the `<Pressable>` elements with `accessibilityRole="button"`, `accessibilityLabel`, and `accessibilityState` in the apps/native/app/(tabs)/settings.tsx file.

## 2026-08-20 - Add accessibilityRole to Clear Search Button in PricingGuideModal
**Learning:** The 'Clear search' `<Pressable>` button in the `PricingGuideModal.tsx` lacked an `accessibilityRole` and `accessibilityLabel`, making it unclear to screen readers.
**Action:** Always ensure that interactive elements like `<Pressable>` or `<TouchableOpacity>` have a valid `accessibilityRole="button"` and an `accessibilityLabel` describing their function.

## 2026-08-21 - Add accessible container and label to SyncStatus component
**Learning:** Grouped visual status indicators like `SyncStatus` combine dot indicators and text stacks without grouping, making screen readers read disjointed chunks.
**Action:** Add `accessible={true}` and a comprehensive `accessibilityLabel` on container `<View>` elements that summarize child status components.

## 2026-08-28 - Add accessibilityLabel and hint to My Deals button in marketplace header
**Learning:** Header buttons with badges like 'My Deals' read disjointed badge counts to screen readers unless explicit dynamic labels are provided.
**Action:** Include dynamic state summaries (e.g. `My Deals, 2 pending`) in `accessibilityLabel` and concise guidance in `accessibilityHint`.

## 2026-09-02 - Add accessibilityLabel to trust filter items in TrustPickerSheet
**Learning:** Selection buttons with emoji and text labels read raw emoji characters or omit filter labels on screen readers unless an explicit `accessibilityLabel` is assigned.
**Action:** Always provide explicit `accessibilityLabel={f.label}` on selection items containing emoji icons.
