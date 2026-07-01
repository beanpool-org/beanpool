# Contributing to BeanPool

Thank you for your interest in contributing to the BeanPool protocol. This document explains how to participate constructively, what kinds of contributions are most needed right now, and the values that should guide all contributions.

---

## Table of Contents

1. [Our Values](#our-values)
2. [What We Need Right Now](#what-we-need-right-now)
3. [How to Contribute](#how-to-contribute)
   - [Reporting Issues](#reporting-issues)
   - [Proposing Protocol Changes](#proposing-protocol-changes)
   - [Writing and Documentation](#writing-and-documentation)
   - [Code Contributions](#code-contributions)
4. [Design Process](#design-process)
5. [Code of Conduct](#code-of-conduct)
6. [Governance](#governance)
7. [Licensing](#licensing)

---

## Our Values

Contributions to BeanPool should be consistent with the project's founding values. If you are unsure whether a proposed change aligns with these values, open an issue and ask before investing time in implementation.

**Post-extraction:** We build infrastructure that enables communities to create and retain value rather than having it captured by intermediaries. Contributions that introduce extractive dynamics — network effects that benefit a single controlling party, proprietary lock-in, surveillance-based monetisation — are not welcome.

**Subsidiarity:** Local communities should be able to run their own nodes, make their own governance decisions, and operate independently. Contributions that push decision-making upwards to a global authority, or that make local operation impractical, work against the protocol's goals.

**Legibility:** The protocol should be understandable by the communities it serves — not only by software engineers. Contributions to specifications should be written in plain language where possible, with technical detail layered underneath.

**Consent and privacy:** No feature should allow data to move without the explicit, revocable, auditable consent of the party it belongs to. Privacy-invasive features will not be merged regardless of their technical elegance.

**Regeneration:** We measure success by whether communities, ecologies, and commons are healthier because of BeanPool, not by growth metrics or token price.

---

## What We Need Right Now

The project is in **beta** with a working implementation. The most valuable contributions at this stage are:

1. **Use case input** — Are you part of a cooperative, land trust, mutual aid network, open science project, or other commons-based organisation? Tell us about your infrastructure needs. Open an issue with the label `use-case`.

2. **Protocol design critique** — Read the [README](README.md) and challenge our assumptions. Where does the 3-layer model break down? What tensions exist between the principles? Open an issue with the label `design`.

3. **Relevant prior art** — Point us to existing protocols, standards, or implementations we should study or align with (e.g. DIDs, ActivityPub, Fediverse conventions, mutual credit protocols, community currency standards). Open an issue with the label `prior-art`.

4. **Documentation improvements** — Clarify, expand, or translate the documentation. Non-English translations are especially welcome since many of the communities BeanPool aims to serve are not primarily English-speaking.

5. **Formal specification drafts** — When we reach the specification phase, we will need people who can write precise, implementable protocol specs. Express your interest by opening an issue with the label `spec`.

---

## How to Contribute

### Reporting Issues

Use GitHub Issues to report problems, ask questions, or start discussions.

- Search existing issues before opening a new one to avoid duplicates.
- Use a clear, descriptive title.
- Provide as much context as possible.
- Use the appropriate label (see the label descriptions in the issue tracker).

### Proposing Protocol Changes

Protocol changes have consequences for everyone building on BeanPool. Please follow this process:

1. **Open an issue first.** Describe the problem you are trying to solve and why existing approaches are insufficient. Do not open a pull request without a linked issue unless the change is trivial (typo, formatting).

2. **Allow time for discussion.** Non-trivial protocol changes should remain open for discussion for at least **14 days** before any implementation work begins.

3. **Seek rough consensus.** You do not need unanimous agreement, but you do need to address substantive objections.

4. **Write the spec before the code.** For Layer changes, a human-readable specification must accompany any reference implementation.

### Writing and Documentation

- Write in plain English wherever possible. Avoid jargon; define terms when you introduce them.
- Use inclusive language. Avoid idioms that may not translate well across cultures.
- For significant additions, open an issue first so we can discuss scope.
- Pull requests that only fix typos or formatting are welcome and do not require a prior issue.

### Code Contributions

The project has a working reference implementation across three apps (BeanPool Node, PWA, and Native App) plus a shared core protocol library. When contributing code:

- Read the relevant app's README before starting work.
- Open an issue first to discuss scope and approach.
- All code must be written in TypeScript.
- All code must include tests.
- All code must pass the project's linting and formatting checks before review.
  - Run linting via `pnpm lint` (configured via Flat config `eslint.config.mjs`).
- Any changes to sensitive backend POST routes must be added to and verified by the auth boundary script at `scripts/verify-auth-boundary.mjs`. Run `node scripts/verify-auth-boundary.mjs` to prove that the `requireSignature` middleware coverage holds.

---

## Design Process

Major decisions about the BeanPool protocol go through an **open design process**:

1. **Proposal** — Anyone can propose a change by opening a GitHub issue.
2. **Discussion** — The community discusses the proposal asynchronously.
3. **Rough consensus** — Substantive objections have been addressed.
4. **Accepted / Rejected / Deferred** — The issue is closed with a clear record.

---

## Code of Conduct

BeanPool is committed to providing a welcoming, respectful, and harassment-free environment for all contributors.

**Expected behaviour:**
- Be kind, patient, and constructive.
- Assume good faith in others' contributions and questions.
- Criticise ideas, not people.
- Give credit generously.

**Unacceptable behaviour:**
- Harassment, intimidation, or discrimination of any kind.
- Derogatory comments about a person's identity or background.
- Publishing others' private information without consent.
- Bad-faith participation aimed at derailing the project.

---

## Governance

BeanPool is governed as a **commons**. No single organisation or individual owns or controls the protocol.

**Maintainers** are contributors who have demonstrated sustained, values-aligned participation. **Decisions** are made by rough consensus of active contributors.

**Forks** are always welcome. We ask that forks maintain interoperability so that the network effects benefit everyone.

---

## Licensing

By contributing to this repository you agree that your contributions will be licensed under the [MIT License](LICENSE).

---

*Thank you for helping build infrastructure for a post-extraction economy.*
