# Archetypes: a working preference, not an identity

**Decision note.** Rewritten 2026-09-17 against main at 882fd048 (node v1.2.19, app v1.2.33).
Replaces the 2026-09-03 draft. Nothing under "Decision" is built unless it says so.

## What exists today

- **The engine.** `packages/beanpool-core/src/archetypes.ts`: nine archetypes (Weaver, Catalyst,
  Guardian and six more), a 9- or 27-question quiz, `scoreQuiz` giving a primary and a secondary,
  and `calculateSynergy` giving one of three relationship types plus a tip. The server stores the
  result as JSON on `members.archetype` and does nothing else with it.
- **Both apps have the quiz and the profile card.** Native has had a quiz modal
  (`apps/native/components/ArchetypeQuizModal.tsx`) and a "Collaboration Chemistry" card on public
  profiles since before the first draft. The web app got both in #688 (2026-09-09), plus a one-tap
  chat outreach message. The first draft said the web app had nothing; that is no longer true.
- **What leaves the device is already minimal.** Both clients save only primary, secondary, quiz
  mode and date. Raw scores and answers never reach the node.
- **The member directory serves every member's archetype to every member**
  (`apps/server/src/routes/community.ts`). The profile card needs it. So "no public labels" is a
  display rule kept by the clients, not enforced by the server. Fine for now; revisit only if a
  label UI is ever proposed.
- **One dormant hook on main.** The Groups PR #823 (2026-09-17) added a `posts.target_archetypes`
  column and a `targetArchetype` filter on the marketplace list
  (`packages/beanpool-engine/src/posts.ts`, `apps/server/src/routes/marketplace.ts`). No client
  sets or reads it.

The copy is still identity-framed on both apps: "Discover Your Archetype", type names like
"The Weaver", descriptions that open "You bring…".

## Decision

### 1. Reframe the copy: preference, not identity

Not "Bob is a Catalyst" but "Bob prefers fast feedback and clear milestones."

This turns an unverified personality claim into a plain statement of how someone wants to be
worked with. If Alice answers as the Spark she wishes she were, she is saying "give me kickoffs,
not solo maintenance", which is exactly what a coordinator needs. Aspirational answers stop being
a validity problem. And it removes the "verdict" feeling that lets a typology harden into a caste.

Work: quiz intro and result headers, type descriptions ("You prefer…", "Works best when…"),
settings and profile panels, both clients. The core strings live in one file so both apps change
together; native reaches members with the next store build. The `collaborationStyle` field is
already preference-shaped and is the seed.

### 2. Two standing refusals

**No public archetype labels anywhere.** No chips on profiles, member lists or the map. A visible
"Champion" tag next to a name is a permanent reputation label in a community members cannot leave,
and social convention will treat it as a rank even if the software gates nothing. No chips exist
today; keep it that way.

**No per-type breakdown of a group or enterprise.** A bar reading "2 Sparks, 1 Guardian" on a
four-person enterprise in a 40-person node lets anyone who knows two members deduce the third. A
member who chose never to show their type has it disclosed by arithmetic. If a composition view is
ever wanted, the only safe form is three meta-energies (Drive, Craft, Glue), primary at 1.0 and
secondary at 0.5, and nothing rendered below four members. That is a guardrail for the future, not
a spec: the secondary archetype is unused by anything today.

### 3. Drop type names from what a member sees about another member

The shipped profile card and the web outreach message both name the types: the synergy headline
for complementary pairs is "Weaver + Catalyst" and the chat message ends "(Weaver + Catalyst)"
(`apps/pwa/src/lib/archetypes.ts`, `packages/beanpool-core/src/archetypes.ts`). That contradicts
refusal 1. Soften both: keep the tip and strengths, remove the names. One-line change per client.
A member sees their own type; nobody sees anyone else's.

### 4. Remove the marketplace archetype filter from #823

`posts.target_archetypes` and the `targetArchetype` filter are the one thing on main that could
become "posts for Guardians only", which is an archetype gate. Nothing uses them. Remove the filter
and the client fields before anyone builds a UI on them. Archetypes gate nothing, the same as
tiers.

### 5. The dyadic tip, at the keeper join review first

The one new thing worth building: a private, one-line tip at the moment two members start working
together. "Working with Sam: appreciates clarity up front." Computed on the client from data it
already holds, no server change, works offline on old phones.

- **Where.** The lead keeper's review of a join request first (both sides see their own tip).
  Then a keeper's name in the enterprise discussion thread. Not chat, which is mostly trades. Both
  surfaces exist on main now (`apps/server/src/routes/treasury.ts`, the treasury detail pages);
  neither did on 2026-09-03. There is no "task handoff" in Commons, so the first draft's trigger
  does not exist.
- **How.** One collapsed line at 320dp, expandable. Tip and strengths only, never a type name.
- **When.** After 1 to 4 ship, and after enterprises have real keepers so there is something to
  observe.

## Standing constraints

- Archetypes gate nothing, touch no beans, no pricing, no credit.
- No astrology: no daily rotation, no "your Spark energy is high today".
- No re-take treadmill and no behavioural surveillance to "verify" a type.
- Works offline on old Android; nothing that needs a large population to mean anything.

## Corrections to the first draft

- "Only three consumers, all native; the web has nothing": web parity shipped in #688, and the
  native quiz modal was missed.
- "Zero integration with the marketplace": #823 added a dormant hook. See decision 4.
- "This cancels the 'profile chips never wired' backlog item": there is no such item. The only
  "profile chips" work is the Pulse channel chips (verified social links), a different feature
  that is already built. Nothing to cancel.

## Open question

Bindarrabi is the Commons driver and its live status is unconfirmed. Ask Doone whether a typology
is welcome there at all before the dyadic tip ships. Decisions 1 to 4 go ahead regardless, since
they only soften or remove what members can already see.
