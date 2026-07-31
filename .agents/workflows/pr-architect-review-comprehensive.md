---
description: Performs a deep multi-perspective architectural review of a GitHub PR using 5 parallel domain subagents (Code Quality, DB Architect, Security Auditor, Impact Specialist, UX & A11y).
---

# Comprehensive PR Architect Review (`/pr-architect-review-comprehensive`)

Perform a deep, multi-perspective code review of a GitHub Pull Request by spawning 5 specialized domain subagents in parallel:

1. **Code Quality & Logic Reviewer** (`prompts/code_reviewer.md`): Logic correctness, async/await race conditions, boundary edge cases.
2. **Database Architect** (`prompts/db_architect.md`): DDL schema changes, index optimization, float precision, CAS transition safety.
3. **Security Auditor** (`prompts/security_auditor.md`): Access control, input sanitization, injection vectors, replay protection.
4. **Consequences & Impact Specialist** (`prompts/consequences_specialist.md`): Downstream protocol risk, state machine deadlocks, boot-recovery safety.
5. **UX & Accessibility Specialist** (`prompts/ux_specialist.md`): Copy clarity, screen reader accessibility (`aria-hidden`/VoiceOver), raw hash masking.

## Usage
`/pr-architect-review-comprehensive <PR_NUMBER_OR_URL>`

## Skill Reference
This workflow uses the skill located at `.agents/skills/pr-architect-review/SKILL.md`.
