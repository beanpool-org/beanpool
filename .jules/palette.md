# ⚠️ Operating policy — READ BEFORE OPENING ANY PR
# 📕 Read `.jules/POLICY.md` FIRST — it is shared, binding, and takes precedence
#    over anything below it that contradicts it.

This repo has accumulated many duplicate Palette PRs (6 on marketplace cards, 4 on
PostAuthorTrust, 2 on the FAQ — all the same fix). Before opening a PR:

1. **Check for duplicates first.** Run `gh pr list --state all --search "<keywords>"`
   and read the diffs of any open / recently-merged / recently-closed PRs on the same
   component. If an equivalent change is already open, merged, or closed-as-rejected,
   **do not open another** — append a note here and stop.
2. **One issue → one PR.** Never re-file a fix that already landed. Treat merged and
   closed PRs as final.
3. **Don't "fix" already-accessible elements.** A semantic `<button>` with visible text
   is already keyboard- and screen-reader-operable; converting its inline styles to
   Tailwind or adding redundant `aria-label`s is not an accessibility fix and risks
   visual regressions (this is why #72 was closed without merging).
4. **Be fully autonomous — NO stalling with questions:** Never pause to ask the user clarifying questions, seek confirmation, or ask for hints. If you find multiple potential improvements, autonomously select the single highest-impact one under 50 lines and open a PR. If no gap is found, exit immediately with zero changes and no questions. All feedback and code review happens on the GitHub PR.
5. **Record outcomes below** so the next run sees what's already done.

## ✅ Resolved — do NOT re-file (2026-06-14, landed in #112 / #113)
### 2026-08-25 — CategoryPickerModal a11y LANDED in #371. Raised four times.
#366, #390, #399 closed as duplicates. #371 won because it was the only one with an Escape
handler *and* an explicit close button *and* `type="button"`. One open nit worth a future PR:
`role="dialog"` / `aria-modal` sit on the backdrop div rather than the inner dialog container.

### 2026-08-25 — MyDealsModal a11y LANDED in #412. Do not re-file.

- Marketplace post cards (grid + list): clickable `<div>`s made keyboard-operable
  (`role="button"`, `tabIndex`, Enter/Space, `aria-label`, focus ring).
- PostAuthorTrust author chip (compact + full): same, gated on `isInteractive`.
- WelcomePage FAQ accordion headers: `role="button"`, `tabIndex`, `aria-expanded`,
  Enter/Space, focus ring.
- Marketplace filter-clear `✕` buttons (category + distance): keyboard-operable.
- REJECTED: WelcomePage "← Back" controls (#72) — already semantic `<button>`s; not
  an a11y gap. Do not re-file.

---

## 2024-05-11 - PWA Input Accessibility
**Learning:** Found that many inputs across the PWA, specifically in forms built with custom styling like in the `WelcomePage.tsx` entry sequence, were missing explicit `<label>` associations or relied solely on placeholders. This creates a poor experience for screen readers and breaks keyboard tap-targets for checkboxes.
**Action:** Always ensure that custom-styled PWA inputs have an explicit `id` and are either nested inside a `<label>` or are associated via `<label htmlFor="...">`. For array-generated inputs (like recovery words), `aria-label`s should be applied.

## 2026-05-21 - Close Buttons, Keyboard Navigation, and Icon Button Accessibility
**Learning:** During review of open accessibility and user interface pull requests, identified gaps in non-semantic interactive components and icon-only buttons across LedgerPage, InvitePage, CommonsInfoModal, ProjectsPage, and MarketplacePage:
1. **Close & Back Buttons:** Non-text buttons containing symbols like "✕" or "▼" are unreadable by screen readers unless given explicit descriptive `aria-label` tags.
2. **Icon & Text Action Buttons:** Actionable components (e.g., share, copy, edit, delete icons) must provide explicit action descriptions using both hover tooltips (`title`) and `aria-label` text to ensure they can be understood by screen readers and visually impaired users.
3. **Interactive Pseudo-elements:** Non-semantic HTML tags (like `<span>` or `<div>`) that handle clicks must act as fully keyboard-accessible buttons to ensure users navigating with keyboard alone are not locked out.

**Action:** Adopt the following rules for all client-side UI interactive features:
* **Rule 1 (Close Buttons):** Always augment symbolic close buttons or back icons with descriptive `aria-label` attributes (e.g., `aria-label="Close details"`, `aria-label="Close information modal"`).
* **Rule 2 (Action Icons):** For any icon-only interactive controls (e.g., ✏️, 🗑️, 📋, 📤), provide explicit `aria-label` (for screen readers) and `title` (for tooltips) specifying the exact action (e.g., `aria-label="Copy invite link"`).
* **Rule 3 (Interactive Spans/Divs):** When utilizing nested pseudo-elements (like custom `<span>` clear/delete triggers) that listen to click events:
  * Apply `role="button"` to inform screen readers of their interactive behavior.
  * Apply `tabIndex={0}` to place the element in the document's sequential keyboard focus tab order.
  * Handle the `onKeyDown` event to capture key events, and fire the action when `Enter` or Space (` `) are pressed (with `e.preventDefault()` to prevent scrolling/page actions).

## 2026-06-19 - Icon-only buttons: cancel-reply ✕ and star ratings
**Learning:** Two icon-only controls lacked accessibility affordances: the reply-cancel "✕" button in `MessagesPage.tsx` (no `aria-label`) and the star-rating buttons in `PublicProfilePage.tsx` (no `aria-label`, and `focus:outline-none` with no replacement focus ring — invisible to keyboard users).
**Action:** Added `aria-label="Cancel reply"` to the ✕ button; added dynamic `aria-label={`Rate ${star} star${star === 1 ? '' : 's'}`}` to the stars and replaced `focus:outline-none` with `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-lg`. Landed by martin consolidating PRs #122 and #124. Note: do NOT create a `.Jules/palette.md` — this filesystem is case-insensitive, so `.Jules` resolves to this same `.jules` dir; append here instead.


## 2024-05-18 - Input Label Associations
**Learning:** Many form inputs throughout the application (such as in settings or profile pages) use `<label>` elements visually, but do not associate them to their respective inputs using `htmlFor` and `id`. This breaks the expected behavior for screen reader users and affects focus state toggling.
**Action:** When adding or modifying inputs with visible label text, always ensure `htmlFor` on the label exactly matches the `id` on the `<input>` or `<textarea>`.

## 2026-06-20 - CategoryPickerModal Dialog & Keyboard Accessibility
**Learning:** `CategoryPickerModal.tsx` lacked modal dialog semantics (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`), an explicit close button ("✕"), Escape key dismiss handler, and `aria-pressed` / focus ring indicators on category selection buttons.
**Action:** Added dialog semantics, Escape key listener, explicit close button with `aria-label="Close category picker"`, and `aria-pressed` with `focus-visible:ring-2` to category buttons.

## 2026-06-25 - MyDealsModal Card Accessibility & Modal Semantics
**Learning:** The `MyDealsModal` component contained interactive card `<div>` elements with `onClick` handlers for viewing deal details and active posts, but lacked keyboard accessibility (`role="button"`, `tabIndex={0}`, `onKeyDown` handlers for Enter/Space), `aria-label` text, dynamic focus rings, and proper modal dialog semantics (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`).
**Action:** Added `role="dialog"`, `aria-modal="true"`, `aria-labelledby="my-deals-title"` to the backdrop overlay and `id="my-deals-title"` to the modal title. Made all interactive deal transaction and active post cards fully keyboard accessible with `role="button"`, `tabIndex={0}` (or gated on pending status), `onKeyDown` listener, descriptive `aria-label`s, and focus ring classes (`focus-visible:ring-2`).

## 2026-08-26 - CommonsInfoModal Modal Accessibility & Keyboard Navigation
**Learning:** `CommonsInfoModal.tsx` lacked modal dialog accessibility attributes (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`), an Escape key dismiss listener, explicit `type="button"` on the close button and tab buttons, and proper tablist accessibility attributes (`role="tablist"`, `role="tab"`, `aria-selected`).
**Action:** Added `useEffect` Escape key dismiss listener, `role="dialog"`, `aria-modal="true"`, `aria-labelledby="commons-modal-title"`, `id="commons-modal-title"`, `role="tablist"`, `aria-label`, `type="button"`, `role="tab"`, and `aria-selected` attributes.

## 2026-08-27 - LedgerPage Medallion Shelf Level Button Accessibility
**Learning:** `LedgerPage.tsx` medallion shelf level selection buttons lacked explicit `type="button"`, state communication via `aria-pressed`, descriptive `aria-label` text, and visible focus ring indicators for keyboard users.
**Action:** Added `type="button"`, `aria-pressed={isSel}`, `aria-label={`View ${t.name} level details`}`, and replaced `focus:ring-2` with `focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1`.

## 2026-08-28 - ProfileGateModal Accessibility & Keyboard Navigation
**Learning:** `ProfileGateModal.tsx` lacked Escape key dismissal, dynamic focus ring indicators for keyboard focus, explicit `type="button"` attributes on buttons, and title linking (`aria-labelledby` / `id`).
**Action:** Added `useEffect` Escape key listener, `aria-labelledby="profile-gate-title"`, `id="profile-gate-title"`, explicit `type="button"`, and `focus-visible:ring-2 focus-visible:ring-nature-500` to modal buttons.

## 2026-08-29 - InstallPrompt Banner Accessibility & Focus Ring Styling
**Learning:** `InstallPrompt.tsx` floating banner lacked region ARIA semantics (`role="region"`, `aria-label="App installation prompt"`), decorative emoji hiding (`aria-hidden="true"`), explicit `type="button"` attributes on close and action buttons, disclosure state (`aria-expanded`), and focus-visible ring styling for keyboard users.
**Action:** Added `role="region"`, `aria-label="App installation prompt"`, `aria-hidden="true"` on emoji, explicit `type="button"`, `aria-label="Dismiss install prompt"`, `aria-expanded={showSteps}`, and `focus-visible:ring-2` focus rings to all buttons.

## 2026-08-30 - SyncStatus ARIA Status & Live Region Accessibility
**Learning:** `SyncStatus.tsx` displayed network status and last sync time visually, but lacked ARIA status semantics (`role="status"`, `aria-live="polite"`), descriptive screen-reader `aria-label`, and decorative element hiding (`aria-hidden="true"` on the dot indicator).
**Action:** Added `role="status"`, `aria-live="polite"`, dynamic `aria-label` announcing status and sync time, and `aria-hidden="true"` to the indicator dot.

## 2026-08-31 - PricingGuideModal Accessibility & Keyboard Focus Indicators
**Learning:** `PricingGuideModal.tsx` close button, category selection pills, and interactive catalog item rows (`role="button"`) lacked visual focus ring indicators (`focus-visible:ring-2`) and explicit screen-reader `aria-label`s on item rows when interactive.
**Action:** Added `focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500` to modal close button, category buttons, and item cards. Added dynamic `aria-label` context to item cards.

## 2026-09-01 - PrivacyBadge Accessibility & Focus Ring Styling
**Learning:** `PrivacyBadge.tsx` lacked an explicit `type="button"` attribute, descriptive screen-reader `aria-label` text communicating privacy mode and action, decorative status dot hiding (`aria-hidden="true"`), and visible keyboard focus ring styling (`focus-visible:ring-2`).
**Action:** Added `type="button"`, dynamic `aria-label`, `aria-hidden="true"` on status indicator dot, and `focus-visible:ring-2 focus-visible:ring-emerald-500` focus ring styling.

## 2026-09-02 - RadiusPickerPage Modal Accessibility & Keyboard Navigation
**Learning:** `RadiusPickerPage.tsx` full-screen location modal overlay lacked ARIA modal semantics (`role="dialog"`, `aria-modal="true"`, `aria-labelledby`), Escape key press dismiss listener, explicit `type="button"` attributes on action buttons, descriptive `aria-label` text on buttons and range slider, and visible focus-visible ring indicators.
**Action:** Added `role="dialog"`, `aria-modal="true"`, `aria-labelledby="radius-picker-title"`, `id="radius-picker-title"`, `useEffect` Escape key handler, explicit `type="button"`, `aria-label` text, and `focus-visible:ring-2 focus-visible:ring-amber-500` focus rings.
