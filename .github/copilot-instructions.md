# GitHub Copilot Instructions

This repository contains **BeanPool**, a decentralized mutual credit platform for community-based asset and trade sharing. It is a monorepo consisting of:
* `apps/native`: Expo/React Native mobile app (the primary client).
* `apps/pwa`: Single Page Application (SPA) web client.
* `apps/server`: Node.js backend server with a Koa REST API, SQLite database, and P2P synchronization layer (`libp2p`).
* `apps/website`: Static HTML website (`beanpool.org`) auto-deployed to Cloudflare Pages.
* `packages/beanpool-core`: Protocol core definitions and calculations.

Please follow these guidelines during pull request reviews and coding assistance:

## 1. Mobile Styling & Theming (`apps/native`)
* **Theme Context**: Never use static, hardcoded colors for UI components. Instead, always use `useTheme` and `useStyles` from `ThemeContext` to define component styles.
* **Colors & Palette**: Utilize the theme token colors (e.g., `colors.surface.card`, `colors.text.body`) rather than raw palette colors (e.g., `palette.yellow300`) to guarantee dynamic Dark Mode compatibility.
* **Component Structures**: Prefer layout components over inline style objects. Keep components modular, accessible, and performant.

## 2. Server & Database Conventions (`apps/server`)
* **SQLite Database**: We use `better-sqlite3` for local persistence. Always write clean, sanitized, and performant SQL queries.
* **Trust Model**: Ensure any logic involving credit floors, limits, or balances conforms strictly to the latest Trust Model guidelines (e.g. Trust Model v3). Usable floor limits are offer-gated (`min(earnedLimit, offerCap)`).
* **Network & P2P**: Bidirectional P2P replication runs over libp2p, routed via secure WebSockets (`wss`) over port `443` to circumvent reverse proxy and Cloudflare tunnel restrictions.

## 3. Web & PWA (`apps/pwa` & `apps/website`)
* **Vite & PWA**: The web client uses Vite and React. Ensure state hooks and components mirror mobile conventions.
* **Static Pages**: The main landing website (`apps/website`) consists of pure static HTML, CSS, and JS. Do not add compilation steps or NPM dependencies to `apps/website`.

## 4. General Best Practices
* **Linting & Formatting**: Follow standard ES6 syntax. Ensure all TypeScript types are fully declared.
* **Test Parity**: Ensure new protocol changes are backed up by integration tests in `apps/server/src/test-vouch-covenant.ts`.
