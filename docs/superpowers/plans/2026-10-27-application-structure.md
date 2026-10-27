# Application structure implementation plan

**Goal:** Implement the structure approved in the chat without changing application behaviour.

**Architecture:** Construct Express independently of startup. Group HTTP routes by feature, extract preference rules and WebSocket transport, and use explicit session names. Group frontend files by feature and keep shared contracts in `shared/`.

**Tech stack:** Existing TypeScript, React, Express and MongoDB; no new dependencies.

**Spec:** The approved structure in the 27 October 2026 chat.

## Constraints

Preserve endpoints, middleware order, ownership checks, response shapes, model behaviour, assets and deployment entrypoints. Keep research and training implementations unchanged. Use a descriptive branch and conventional commits.

## Review focus

- Authentication routes must precede JSON parsing and protected routes.
- Weight deletion must preserve the active-session guard and preference reset.
- WebSocket origin checks, owner isolation and sign-out invalidation must remain intact.
- API documentation checks must still detect undocumented feature routes.
- Frontend imports, dynamic imports and public asset URLs must survive moves.

## Tasks

- [x] 1. Add construction/HTTP regression tests and contract-discovery coverage; observe failures for missing construction API and route discovery.
- [x] 2. Extract app, feature routers, preferences and live connections; rename Laboratory to SessionManager. Run focused tests and full checks, then commit the server unit.
- [x] 3. Move frontend files into account, session, settings, scene, audio and components. Extract HTTP helpers into api.ts and rename useLab to useFlySession. Update references and documentation.
- [x] 4. Run full checks and applicable integration/browser checks, review the complete diff, fix regressions, and commit the frontend unit.

## Execution notes

Implementation runs in the clean existing checkout on a dedicated branch, preserving installed dependencies. The chat supplies the approved design and authorisation; no additional design approval is needed. Review and runtime evidence will be recorded below.

Server verification: `npm run check` passed with 121 tests; focused HTTP, live-connection, preference and route-discovery tests passed. Existing bundle-size warnings remain. Route discovery retains static full paths and now scans nested server files and multiline router declarations; no parser dependency was introduced.

Final verification: `npm run check` passed (121 tests, formatting, lint, OpenAPI, TypeScript and build). `npm run test:e2e` passed sound, account UI and playback in Chromium and WebKit against the built frontend at `http://127.0.0.1:3100`. The Browser plugin was not available; the existing Playwright scripts were used. `npm run test:integration` passed account/model execution, weight search/account isolation and authentication security against the local Docker stack with external email disabled.

Independent review found a shutdown-order regression introduced during extraction. Corrected it so sessions finish and broadcast before sockets close; focused session/live tests and the full check passed afterwards. No other blocking findings. The existing bundle-size warnings remain outside this organisational refactor. No dependencies, model logic or public API shapes changed.
