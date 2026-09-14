# wb-ops — project templates and AI export for OpenReplay

Static, same-origin page served by `nginx-openreplay` at **https://replay.wbrix.dev/wb/**. No build step, no
dependencies, nothing stored server-side. It talks to the same APIs the OpenReplay SPA uses:

- chalice `/api/…` — `projects`, `{projectId}/metadata`, `account`
- Go API `/v2/api/{projectId}/…` — `cards`, `dashboards`, `sessions/search`, `sessions/{id}/events`

## What it does

1. **Projekt** — pick an existing project or create one (`POST /api/projects`).
2. **Szablon** — shows a diff against the project (metadata keys, dashboard, cards, cards missing from the
   dashboard), then applies only what is missing. Templates live in `templates/*.json`; the PrestaShop one
   matches the event names emitted by the `wb_openreplay` module (`docs/EVENTS.md` there).
3. **Klucz projektu** — the `projectKey` to paste into the module's configuration, plus a link to the dashboard.
4. **Eksport dla AI** — sessions in a date range (optionally only those with a given event) with their custom
   events, issues, JS errors, metadata and replay links → `export.json` + `DIGEST.md` (funnel, blockers with
   links, carriers/payments, vouchers, search phrases, JS errors). Feed both files to Claude.

## Auth

The page reads the SPA's JWT from `localStorage.UserStore.jwt` (mobx-persist) and uses it as a bearer. It never
calls `/api/login` or `/api/refresh`: OpenReplay keeps **one token generation per user**, so any login/refresh
elsewhere (another browser, an API script) invalidates the token the SPA holds and logs it out. If the page
reports 401/403, open OpenReplay in a new tab (it refreshes and re-persists the token) and reload `/wb/`.

## Deploying changes

Dokploy re-clones the repository on every deploy, so bind mounts (`./wb-ops`, `./nginx.conf`) point at a stale
directory until the nginx container is recreated. **Bump `WB_OPS_VERSION` on `nginx-openreplay` in
`docker-compose.yaml`** (and `app.js?v=` in `index.html` for browser caches) in the same commit as any change
here. Push to `develop` → Dokploy deploys (~30 s).

## Editing the template

`templates/prestashop.json`: `metadata` (max 10 per project), `dashboard {name, description}`, `cards[]` with
`metricType` (`funnel` | `timeseries` | `table`), `viewType`, `metricOf` (`sessionCount` | `userCount` |
`eventCount` for timeseries/funnel; `userId` | `jsException` | `userBrowser` | … for tables), and `series[]`
with `events[]` (custom event names, in order for funnels). A card is matched by **name** — rename = new card.

Validated against the running instance (card `try` endpoint) on 2026-09-14; `metricOf: sessions` and `ISSUE`
tables are rejected by this OpenReplay build.
