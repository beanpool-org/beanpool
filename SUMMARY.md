# PWA Parity: Community Working Style & Archetype Quiz

## Overview
This implementation achieves complete PWA parity with the native client for the Community Working Style & Archetype (Enneagram) Quiz feature. The feature ports the 9-archetype collaborative energy model into the PWA using the shared `@beanpool/core` package, matches all native copy verbatim, supports both Quick Spark (9 questions) and Deep Resonance (27 questions) modes, displays working style on personal profiles, computes privacy-preserving Collaboration Chemistry on member profiles, and integrates with the chat composer for one-click synergy outreach.

---

## Files Changed

### 1. `apps/pwa/src/lib/api.ts`
- **Lines changed:** 265, 273
- **What changed:**
  - Added `archetype?: string | null;` to the `MemberProfile` interface.
  - Added `archetype?: string | null;` to the `updateMemberProfile` payload argument type.
- **Why:** Enables reading and persisting archetype results (JSON string) across PWA profile API calls (`/api/profile/update`).

### 2. `apps/pwa/src/components/ArchetypeQuizModal.tsx` *(New File)*
- **Lines:** 1–434
- **What changed:**
  - Created modal component with 100% parity to `apps/native/components/ArchetypeQuizModal.tsx`.
  - Implemented 3 states: `intro`, `quiz`, and `result`.
  - Added Quick Spark (9 Qs) and Deep Resonance (27 Qs) mode selection with verbatim native copy.
  - Interactive quiz flow with step counter, progress bar, option selector with hover states, back navigation, and smooth completion.
  - Result view showcasing archetype emoji, name, tagline, description, secondary rhythm, community superpowers list, ideal collaborator pairings, and "How you collaborate best" tip.
  - Instant auto-save upon quiz scoring with `hasSavedRef` guard to prevent double writes on dismissal or save button click.
  - Full keyboard accessibility with Escape key listener to close/save.
  - Styled with Tailwind CSS, supporting dark mode (`dark:` variants), 320dp minimum viewport width, and 1.3x font scaling tolerance.
- **Why:** Core UI component required to take or retake the working style quiz anywhere in the PWA.

### 3. `apps/pwa/src/pages/SettingsPage.tsx`
- **Lines changed:** 14, 85–86, 98–111, 401–523, 1346–1351
- **What changed:**
  - Imported `parseArchetype`, `ARCHETYPES`, `type QuizResult` from `@beanpool/core`, `ArchetypeQuizModal`, and `updateMemberProfile`.
  - Added modal state (`showQuizModal`, `quizInitialMode`) and `handleQuizComplete` callback.
  - Added `COMMUNITY WORKING STYLE` card section in settings `mode === 'menu'`:
    - Empty state: "Discover Your Archetype" with description and "⚡ Take 60s Quiz" button.
    - Populated state: Primary archetype hero (emoji, name, tagline, badge for 9 Qs vs 27 Qs), description, secondary rhythm badge, superpowers list, "🧭 Deepen (27 Qs)" button (if quick mode taken), and "🔄 Retake Quiz" button.
  - Mounted `<ArchetypeQuizModal />` in the page root.
- **Why:** Satisfies requirement to offer the ability to take or retake the quiz from Settings matching native's information architecture.

### 4. `apps/pwa/src/pages/ProfilePage.tsx`
- **Lines changed:** 8, 27–29, 54, 75, 91–104, 283–385, 399–405
- **What changed:**
  - Added `archetype` state initialized from `getMemberProfile`, included in profile save handler `handleSave`.
  - Added `handleQuizComplete` callback to save results immediately to the profile.
  - Added `Working style (self)` card on profile edit screen:
    - Empty state: "Your Working Style" prompt with "⚡ Take 60s Quiz" button.
    - Populated state: Primary archetype details, secondary rhythm, superpowers list with checkmarks, "💡 How you work best" guidance box, "🧭 More accurate" button (for quick mode), and "🔄 Retake" button.
  - Mounted `<ArchetypeQuizModal />` in the page root.
- **Why:** Allows members to view and retake their working style quiz directly from their edit profile screen.

### 5. `apps/pwa/src/pages/PublicProfilePage.tsx`
- **Lines changed:** 10–11, 25–27, 48–65, 96–98, 255–408, 429–531, 832–837
- **What changed:**
  - Imported archetype types/helpers and `ArchetypeQuizModal`.
  - Added `viewerProfile` state fetched alongside profile data when `!isSelf`.
  - Added `Collaboration Chemistry` card for other members (`!isSelf`):
    - When both viewer and member have archetypes: calculates `calculateSynergy(viewerArchetype, memberArchetype)`, displays synergy headline, summary, shared strengths, collaboration tip, and "💬 Collaborate with [Callsign]" chat nudge button with prefilled message.
    - When viewer hasn't taken quiz but member has: displays prompt with member's archetype and "⚡ Take 60s Quiz to Reveal Synergy" invite button.
    - When member hasn't taken quiz: displays "Encourage [Callsign] to discover their archetype".
  - Added `Working style (self)` card for own profile (`isSelf`) matching native display.
  - Mounted `<ArchetypeQuizModal />` in the page root.
- **Why:** Delivers relational collaboration chemistry and synergy insights when viewing neighbours' profiles, driving viral community discovery and collaboration.

### 6. `apps/pwa/src/pages/MessagesPage.tsx`
- **Lines changed:** 185–191, 250–264
- **What changed:**
  - Read `sessionStorage.getItem('bp_chat_prefill')` when a conversation becomes active, populating the draft composer and clearing storage.
  - In `openConversationId` effect, supported both conversation IDs and peer public keys; if navigating with a member's pubkey from the profile synergy nudge, locates existing DM or creates a new DM conversation with that member.
- **Why:** Enables seamless one-click chat outreach from the Collaboration Chemistry card ("💬 Collaborate with [Name]") prefilling the synergy introduction.

### 7. `apps/pwa/src/lib/archetypes.test.ts` *(New File)*
- **Lines:** 1–116
- **What changed:**
  - Added 8 unit tests covering:
    - Metadata completeness of all 9 canonical archetypes (name, emoji, tagline, description, superpowers, idealPartners).
    - `parseArchetype` handling for full JSON, public/compact JSON, and invalid/null inputs.
    - `calculateSynergy` chemistry insights, strengths, and collaboration tips.
    - `scoreQuiz` scoring logic for Quick Spark (9 Qs) and Deep Resonance (27 Qs) modes.
    - SessionStorage chat prefill mechanism for synergy outreach.
- **Why:** Verifies stability and prevents regressions across all archetype functionality.

---

## Archetype Set Agreement: Native vs Engine

- **Investigation:** We audited the archetype definitions across `apps/native`, `apps/pwa`, `packages/beanpool-engine`, and `packages/beanpool-core`.
- **Finding:**
  - Both native (`apps/native/components/ArchetypeQuizModal.tsx`) and engine (`packages/beanpool-engine/src/archetypes.ts`) import and re-export directly from `@beanpool/core/src/archetypes.ts`.
  - All 9 archetypes (`weaver`, `connector`, `catalyst`, `artisan`, `sage`, `guardian`, `spark`, `champion`, `harmonizer`), their Enneagram dynamics, questions, scoring weights, and synergy pairings are **100% identical** between native and engine.
  - **There are zero disagreements** between native and the engine regarding the archetype set.

---

## Verification & Test Results

1. **PWA Typecheck & Build:**
   ```bash
   cd apps/pwa && npx tsc --noEmit && pnpm run build
   ```
   - **Result:** Exit code 0. TypeScript cleanly compiled with 0 errors. Vite built production bundle in 1.42s.

2. **PWA Unit Tests:**
   ```bash
   cd apps/pwa && pnpm test
   ```
   - **Result:** Exit code 0. 3 test files, 13 tests passed (including 8 new archetype parity tests).

3. **Native Unit Tests:**
   ```bash
   cd apps/native && npx vitest run
   ```
   - **Result:** Exit code 0. 15 test files, 171 tests passed.

4. **Monorepo Test Suite:**
   ```bash
   pnpm test
   ```
   - **Result:** Exit code 0. All 8 workspace packages passed tests cleanly.
