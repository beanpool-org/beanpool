# Market grid — pictures for review

Card View at every column count, light and dark, from the branch that stopped the grid stretching listing tiles
to the height of the tallest thing in their row (`fix/market-grid-heights`).

- `after/` — this branch, at 1440px (5 columns), 1200px (4), 800px (3), 640px (2) and 320px (1, at normal and at
  1.3x text), light and dark.
- `before/` — the same feed on `origin/main` at 1440px and 800px, for contrast: the dead space between a tile's
  description and its VIEW button, and the truncated poll answers.

## Regenerating them

```
pnpm --filter @beanpool/pwa exec playwright install --only-shell chromium   # once
pnpm --filter @beanpool/pwa screenshots:market-grid <out-dir>
```

`e2e/market-grid-shots.mjs` builds `e2e/harness.html` — the real MarketplacePage on its own — answers every /api
request from `e2e/fixtures.mjs`, and prints what each picture is meant to show, measured from the live layout:
tile heights, the gap between a description and its VIEW button, whether the VIEW buttons in a row line up, the
poll's column span, and whether any poll answer is truncated. It exits non-zero if any of that is wrong. Nothing
in it talks to a node.

## Why these files are committed, and when to delete them

The repo does not otherwise keep screenshots in git — `apps/manager/e2e/screenshots.mjs` writes to a directory you
name and nothing is committed. These are here only so the pictures show up in the pull request for Marty to
approve before merge, and they are 256-colour copies of what the script emits, to keep them small. Once the
branch is approved they can go in one commit; the script is the thing worth keeping.
