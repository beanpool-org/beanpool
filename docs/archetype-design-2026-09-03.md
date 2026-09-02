# Archetypes: from inert label to coordination lubricant

**Status: DESIGN ONLY — none of this is built.** The "What exists" section is measured
from the code on 2026-09-03; everything after it is a proposal. Do not read this as a
description of shipped behaviour.

From a design conversation on 2026-09-03. It contains two deliberate **refusals** as well
as a recommendation — the refusals are the part most likely to be lost otherwise, and one
of them cancels an item already on the backlog.

---

## What exists (measured)

`packages/beanpool-core/src/archetypes.ts`, 722 lines, and it is good work:

- **9 archetypes** grounded in Enneagram collaboration energies, reframed as positive
  community roles: Weaver, Connector, Catalyst, Artisan, Sage, Guardian, Spark, Champion,
  Harmonizer. Each carries name, emoji, tagline, description, `superpowers[]`,
  `collaborationStyle`, `idealPartners[]`, `communicationTip`.
- **Two quiz modes** — Quick Spark (9 questions), Deep Resonance (27). `scoreQuiz()`
  returns **primary + secondary** plus full scores.
- **`calculateSynergy(viewer, member)`** → `kindred_spirits` / `dynamic_complements` /
  `balanced_allies`, each with title, headline, summary, `strengths[]`, `collaborationTip`.
- Stored as JSON on `members.archetype`.

**And it is almost entirely inert.** Every consumer, from a full grep:

1. `apps/native/app/public-profile.tsx` — the 1:1 synergy card, but only if you already
   navigated to that member's profile.
2. `apps/native/app/(tabs)/settings.tsx` — displaying your own result.
3. `apps/native/utils/db.ts` — parsing the JSON.

Zero integration with Commons, the marketplace, discovery or search. The server stores the
string and returns it.

---

## Two things I had wrong

Recording these because they were both cases of pushing the feature toward exactly the
failure modes the constraints forbid.

**"It's one-shot, so make it a daily habit" — wrong, and a trap.** Personality is
infrastructure, not feed content. Giving a static personality model an artificial "external
rhythm of change" is precisely the trapdoor to daily-horoscope mechanics. The ledger and
mutual aid are the daily loop; archetypes are the lubricant *when coordination happens*.

**"It has no economic consequence" — wrong, and it breaks the anti-gating rule.** Wiring
archetypes to balances, pricing or credit limits manufactures caste ("Champions get better
terms"). Archetypes describe interpersonal collaboration style, not market value, and must
stay entirely detached from the ledger.

## The reframe that matters most

**Stop describing archetypes as identity. Describe them as preference.**

Not *"Bob is a Catalyst"* but *"Bob prefers fast feedback and clear milestones."*

This resolves the strongest objection to the whole system — that the input is a stale,
aspirational self-report — by making aspiration the *correct* data rather than a flaw:

- It converts an unverified psychometric claim into an **explicit social contract**. Bob is
  telling you how he wants to be worked with, which is actionable whether or not the
  underlying model is true.
- If Alice answers as the Spark she *wishes* she were, she is signalling "give me kickoffs,
  not solo maintenance" — exactly what a coordinator needs. Aspirational answering stops
  being a validity problem and becomes a preference declaration.
- It removes the psychometric authority that makes a label feel like a verdict, which is
  what allows a typology to harden into caste.

This costs no new feature. It is a copy rewrite of the existing quiz result and settings
panel, on code already live, and it is where the work should start.

---

## Recommendation: the dyadic synergy card

**One thing to build.** At the moment two members actually coordinate — a Commons task
handoff, a project thread — run `calculateSynergy(viewer, counterparty)` client-side and
render **only** the practical `collaborationTip` and shared `strengths[]`. No scores, no
Enneagram jargon, no type names on display.

Why this shape:

- **Timed right.** It appears at the point of friction, not after a team has formed (where
  the advice reads as "you picked wrong") and not on a profile you had to seek out (where
  you have already decided to deal with the person).
- **Private and dyadic**, so it creates no public badge and therefore nothing weaponisable.
- **No small-N leak** — only you see it, about you and one counterparty.
- Client-side, so it works offline on low-end hardware with no server change.

**Refinement: not on marketplace trades.** Buying someone's lemons does not need
collaboration-style advice; that is clutter. The card earns its place only where work is
*sustained* — Commons tasks, project coordination, work parties.

## Explicit refusals

**1. No public archetype chips on profiles or member lists.** A visible `[Champion]` tag
next to a name is a permanent reputation label in a community members cannot leave. A
typology hardens into caste when labels are pinned to people's chests, and social
convention will do that even if the software never gates anything. **This cancels the
"profile chips never wired" backlog item — it should be dropped, not built.**

**2. No public 9-archetype project composition bars.** Two reasons:

- **Small-N disclosure.** Commons projects will often have 3–5 members in a 40-person node.
  A bar reading "2 Sparks, 1 Guardian" plus knowledge of two members deduces the third by
  simple arithmetic. A member who deliberately never displayed their archetype has it
  disclosed by an aggregate.
- It invites gatekeeping and finger-pointing at named neighbours.

If a composition view is ever wanted, the only safe form is: aggregate to **three
meta-energies** — Drive (Catalyst/Spark/Champion), Craft (Weaver/Artisan/Guardian), Glue
(Connector/Sage/Harmonizer) — blend primary at 1.0 with secondary at 0.5, and render
nothing below **N ≥ 4**. You lose the specific "we lack a Guardian" and gain enough
ambiguity that a third member's type cannot be reverse-engineered.

## If a project-level nudge is ever built

Surface it at the **join gate**, addressed privately to the prospective member, framed as
an invitation rather than a deficiency report:

> "Your Craft energy would provide needed balance to this initiative."

The team is never told it failed; a prospective member is given an affirmative reason to
step up. Descriptive, never prescriptive, and never a blocker.

## Standing constraints this respects

- Archetypes **gate nothing** — consistent with merit badges deliberately gating nothing.
- **No astrology.** No daily rotation, no "your Spark energy is high today", no
  pseudo-scientific state that changes without cause.
- **No re-take treadmill** and no behavioural surveillance to "verify" a member's type.
- Works offline on old Android; nothing requiring large populations to be meaningful.

## Open questions

- Is the dyadic card worth building at all before the copy reframe is done and observed?
- Does the secondary archetype's "flex/bridge role" reading deserve surfacing anywhere, or
  is it only useful inside aggregation maths?
- Bindarrabi is the driver community and off-grid. Would a typology be welcome there at
  all, or is it culturally the wrong instrument? Worth asking Doone before building.
