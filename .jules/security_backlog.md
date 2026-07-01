# Sentinel Security Backlog

This document tracks potential security vulnerabilities discovered during automated audits of the codebase.

## Critical
*(No critical vulnerabilities discovered in current scope.)*

## High
### Cross-Site Scripting (XSS)
- **Vulnerability:** Unsanitized variables concatenated directly into `innerHTML` calls, potentially allowing execution of arbitrary scripts if malicious data is present.
- **Location:** `apps/server/static/settings.js` (Lines 154, 245, 549, 561, 571, 798, 1048, 1099, 1193, 1437, 1580, 1629)
- **Status: 🟢 MITIGATED** 
  - *Note: Jules flagged these sinks, but they were already addressed during the manual security hardening phase. All of these `innerHTML` assignments are using the `esc()` helper function which securely sanitizes dynamic inputs before injection.*

## Medium
*(No medium vulnerabilities discovered in current scope.)*

## Low
*(No low vulnerabilities discovered in current scope.)*
