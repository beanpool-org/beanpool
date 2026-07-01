# ⚠️ Operating policy — READ BEFORE OPENING ANY PR

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
4. **Record outcomes below** so the next run sees what's already done.

## ✅ Resolved — do NOT re-file (2026-06-14, landed in #112 / #113)
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
