# Tools: the template every tool is written to

A **tool** is a small, single-player helper a member (or an enterprise) uses on their own: the Tool shed, Your garden, a
stock list, a job tracker. Every tool is a built-in plugin written to one template, so the third tool costs three folders
and three lines, never a hunt through Home, the router and the shop.

Design: `scratch/tools/DESIGN-tool-template-fable.md` (Fable 5.1, 20 Oct 2026; Marty: "Yes, build as designed"). This page
is its §4 for contributors. Slice T0.1 built the contract and the checks; the phone's host (the Tools screen, the host
route, the primitives) is T0.2 and the web's is T0.3. The **Tool shed** (`things`, slices T1.1 to T1.3) is the first tool
written to it: read its three folders for a worked example.

## What a tool is

- **A manifest in core**, `packages/beanpool-core/src/tools/<id>/`: pure data and pure functions (id, words, icon, shelf,
  shop kinds, owner, permissions, its document's version and `read()`, the Tools row, examples, an optional Home card and
  reminders). The types are `packages/beanpool-core/src/tools/manifest.ts`.
- **A phone half**, `apps/native/tools/<id>/`, and **a web half**, `apps/pwa/src/tools/<id>/`: one component per screen
  the manifest names, `main` first.
- **One line in each registry**: `TOOLS` in `packages/beanpool-core/src/tools/index.ts`, `TOOL_APPS` in
  `apps/native/tools/index.ts` and in `apps/pwa/src/tools/index.ts`.

A tool imports React, `@beanpool/core`, its own folder and the template's host and primitives, and nothing else (the
eslint fence). It talks to the app only through `host`, which has exactly the functions its permissions grant
(`narrowHost` in `packages/beanpool-core/src/tools/host.ts`). Its data is one JSON document with `v` at the top, at most
64 KB, kept on the phone (or in the browser); photos stay on the device (files on the phone, this browser's tool store on
the web), and reach the node only inside a listing the member posts. A tool whose permissions include
`node-copy` also has a private copy on the community's server, on by default and switched off by the member in the
tool's Settings (`apps/*/tools/node-copy.ts`, the rule in `packages/beanpool-core/src/tools/reconcile.ts`); without that
permission nothing of it leaves the device.

**What the host gives.** Every tool: `owner`, `node`, `doc` (`get`, and `set`, which writes the document whole), `navigate`
(to another of its screens) and `back` (as the header's Back goes: what a form does once it is saved), and `now`. Each
permission grants one more: `photos` and `camera` (pick or take a photo, 800 px, kept on the device, by `ref`), `offerDoor`
and `needDoor` (the composer, prefilled; nothing is posted until the member taps Post), `posts` (pause, resume and the
status of the owner's own Offers, and `mine()` to list them, so a record can be linked to the Offer posted from its
draft; the status is the server's, asked each time; a pause is the owner's own, taken for an Offer live or already paused,
so one a shop "closed for now" paused stays down when it reopens; a resume while its shop is closed rejects with core's
`TOOL_SHOP_CLOSED`, which `isShopClosedRefusal` tells from no answer), `deals` (the owner's deals as seller or lender, a loan's `backAround` when known), `pricingGuide` (a hint from the
community's guide, never a price set), `nodeCopy`, and `reminders` (which grants no function: the host schedules what
`due()` says). `place` and `eventDoor` are not built yet: a phone route refuses a tool that asks for them.

**The primitives** (`apps/native/tools/ui.tsx`, `apps/pwa/src/tools/ui.tsx`, the same names): `ToolScreen` (phone;
it scrolls a box being typed in, and the buttons under it, above the keyboard),
`ToolSection`, `ToolRow` (an emoji or a photo, a title, a one-line state; `wrap` for a record's own screen), `ToolField`,
`ToolChips` (`heading` to show its label), `ToolButton` (primary, danger), `ToolEmpty`, `ToolNote` (warning, danger),
`ToolInput` (one line, several, or numbers) and `ToolPhoto`. One column, 48 px targets, colours from the central tokens.

## Adding a tool

1. **`node scripts/tools/new-tool.mjs <id>`** copies `scripts/tools/_scaffold/` into the three roots as `<id>/` (a
   compiling empty tool with its fixtures and a test) and writes the three registry lines. Pick the id: 2 to 16 lowercase
   letters and hyphens, never two together; new-tool refuses one whose names in core are already taken (`tools`, `tool`).
   Then the shelf (`stock`, `trade` or `books`), the shop kinds, the owner.
2. **Fill the manifest** (`<id>/manifest.ts` in core): words through `word()` (a line with a count is a
   `wordn('{n} thing', '{n} things')` pair with its count as `n`, so "1 thing" reads right in every language), one emoji,
   the permissions you need and no more, `doc` with `version: 1`, `empty()`, `read()`, `row()`, `examples`. Add `homeCard` and `reminders` only if the
   tool has something to say on Home or at a time. A tool's Home card is offered once from inside the tool, never added
   to Home by itself.
3. **Write the document's rules and tests in core** (`<id>/doc.ts`, `<id>/__tests__/`), and `<id>/fixtures.ts`: a stored
   value of every version the tool ever wrote, and the empty, small and full documents. `read()` never throws, reads every
   older version, and keeps the keys of a newer one it doesn't know.
4. **Write the phone screens** with the host's primitives (`apps/native/tools/ui`) and `host`; **then the web screens**,
   the same screens. Every sentence in `t()`. Rules both apps share (a record's state, each change to the document)
   belong in core beside the manifest, so the two halves never disagree (the Tool shed's `things/shed.ts`). The phone
   half's screens are a thunk, `require('./screens')`, which vitest can't load (a `.tsx` through Node's own `require`): a
   tool's phone tests import its screens module instead (`vi.mock('../index', …)`, as `apps/native/tools/things/__tests__`
   does, and the generic test does for every registered tool).
5. **Run** `pnpm words:check`, `pnpm words:lint` (your folders start at 0),
   `node scripts/tools/check-tool-budgets.mjs`, the package tests, and the emulator at 320 dp with 1.3× text. On the web,
   a real-browser check at 320 px like `apps/pwa/e2e/tool-shed-320.mjs`. Put the screenshots in the PR, light and dark.
6. **Open the PR** with: what leaves the phone (the permissions, in words), the budget check's output, the tier, the
   screenshots. The words lane drafts the other languages after merge (machine drafts are labelled).

## The PR must pass

Most of this is automated: `test-all.sh` runs `tool_budgets`, core's tests run the generic checks for every registered
tool, and eslint runs the fence.

- [ ] Registered in all three roots (`check-tool-budgets.mjs` refuses a folder missing from any).
- [ ] Manifest within its bounds, and the fixtures of every version read cleanly (core's `tools-template.test.ts`).
- [ ] The generic 320 dp render test in a pseudo-language (`xx`), from T0.2 (phone) and T0.3 (web).
- [ ] Words check and words lint at 0 for the new folders.
- [ ] The three budgets: **120 KB** of minified JS on the phone and on the web (each with its core half), **100 KB** of
      bundled data (`*.json`, `*.table.ts`), **150 sentences** of its own. A tool that needs more says why, and its
      entry in `scripts/tools/budgets.json` carries the reason.
- [ ] The eslint fence: no import outside React, `@beanpool/core`, its own folder and the template's host and primitives;
      no `fetch`, no browser storage.
- [ ] `tsc` for core and both apps, and the package suites.
- [ ] No file outside the three folders changed, except the three registry lines. Anything else is a change to the
      template, and the PR says so.
- [ ] No protected file touched (the map screen, the map pin, the web map, the header, the logo, `deploy.sh`).
- [ ] Nothing tier-locked; a feature a node has switched off is marked with 🏘️, never locked.
- [ ] No dollar amount parsed, no Beans moved, nothing posted without the member's tap.

**Tier.** A tool inside the fence never touches identity, recovery, the ledger, federation, the treasury, auth or the
schema, so its tier is the size rule alone: its core half is usually tier B, its phone and web screens usually tier A by
size. A tool that needs a node route or a column is a server slice first, tier A.

**What a reviewer reads by hand:** the permissions against what the screens do (the fence catches imports and the
network and storage names, plain or as a member, not intent or a name built at runtime); the document for anything a
member would not expect kept on the server (an address, a third person's name, a dollar amount stored as a number);
`read()` keeping a newer version's unknown keys; the sentence count against what the screens need (a tool at the cap is
usually two tools); the words an Offer draft would carry, since a listing is public; the screenshots at 320 dp in light
and dark; and that the PR's "what leaves the phone" matches the permissions.

## Later: a closed door

A tool could one day be a **sandboxed runtime plugin**: the same manifest as JSON plus one script in a web view, served by
the community's own node, with the host's functions as its only bridge. Both app stores allow sandboxed downloaded
JavaScript under conditions (DESIGN-tool-template-fable.md §5). Nothing of it is built, and nothing should be until it is
wanted: the template keeps the door open (the fence, a plain JSON document, pure manifest functions, ids with prefixes
left free, an opaque node copy) and it stays shut.
