---
name: pr-architect-review
description: Performs a rigorous code review of a GitHub PR URL from the perspective of a Senior Developer and Technical Architect, generating and posting structured comments directly to GitHub.
---

# PR Architect Review (`pr-architect-review`)

## Overview
This skill implements an automated code review loop. It evaluates a pull request from an architectural, risk, correctness, and security standpoint, and publishes the resulting inline review comments back to the GitHub PR.

## Steps to Execute the Review

### 1. Fetch the Pull Request Diff
Use the GitHub CLI to retrieve the diff of the pull request:
```bash
GITHUB_TOKEN="" gh pr diff <PR_URL>
```
If the PR belongs to a different repository, specify the full URL, and `gh` will automatically resolve the repository context.

### 2. Perform the Code Review
Analyze the diff line-by-line as a Senior Developer and Technical Architect, focusing on:
1. **Blast Radius & Architectural Risk:** Will modifying this code break downstream dependencies, shared utility files, database schemas, or public API contracts? Flag high-risk coupling.
2. **Critical Bugs & Edge Cases:** Look for async/await race conditions, unhandled exceptions, incorrect boolean logic, and null/undefined pointer errors.
3. **Security & Performance:** Check for insecure data handling, SQL Injection risks, redundant loops, or unoptimized database queries.

#### Rules of Engagement:
- **Be Concise:** Write comments as if you are a peer reviewing code in a fast-paced team. Get straight to the point.
- **Provide Solutions:** Every identified issue *must* include a suggested code fix or mitigation strategy.
- **Ignore Trivialities:** Do not comment on formatting, styling, or naming preferences that a linter should catch.

### 3. Calculate Line Numbers and Sides
To ensure review comments align with the exact lines in the diff, calculate the 1-based target line number and determine the correct side:

- **Hunk Header Format:** `@@ -old_start,old_len +new_start,new_len @@`
- **For added or modified lines (`RIGHT` side):**
  1. Start a counter at `new_start`.
  2. Iterate through each line of the hunk following the header.
  3. For each line:
     - If it starts with `+` or has no prefix (unchanged context), this line belongs to the modified version of the file. The counter represents its 1-based line number.
     - If it starts with `-`, skip incrementing the counter (as it is deleted in the target file).
     - Increment the counter by 1 for any line that is NOT starting with `-`.
  4. Specify `"side": "RIGHT"` (or omit, since it defaults to `"RIGHT"`).
  
- **For deleted lines (`LEFT` side):**
  1. Start a counter at `old_start`.
  2. Iterate through each line of the hunk following the header.
  3. For each line:
     - If it starts with `-` or has no prefix (unchanged context), this line belongs to the original version of the file. The counter represents its 1-based line number.
     - If it starts with `+`, skip incrementing the counter (as it is added in the target file).
     - Increment the counter by 1 for any line that is NOT starting with `+`.
  4. Specify `"side": "LEFT"`.

### 4. Format the Output
Return the review strictly as a raw JSON array of objects. Do not wrap the JSON in markdown code blocks, and do not include any introductory or concluding text.

```json
[
  {
    "path": "relative/path/to/file.ext",
    "position": 42,
    "side": "RIGHT",
    "body": "### Blast Radius Alert (or Issue Type)\n**Risk:** [Clear description of the bug or downstream impact]\n\n**Suggested Fix:**\n```[language]\n[Provide the exact refactored code snippet or mitigation steps]\n```"
  }
]
```

*Note: `"position"` represents the 1-based line number in the target/original file (mapped to `"line"` in the GitHub API).*

### 5. Submit the Review to GitHub
Write the raw JSON array to a temporary file (e.g. `scratch/review_comments.json`) and push the review to GitHub using the helper script:

```bash
# Push review comments (defaults to REQUEST_CHANGES event)
python3 .agents/skills/pr-architect-review/scripts/push_review.py <PR_URL> --comments-file scratch/review_comments.json

# Post comments as a non-blocking review (COMMENT event)
python3 .agents/skills/pr-architect-review/scripts/push_review.py <PR_URL> --comments-file scratch/review_comments.json --event COMMENT

# Verify the payload first with a dry run
python3 .agents/skills/pr-architect-review/scripts/push_review.py <PR_URL> --comments-file scratch/review_comments.json --dry-run
```
