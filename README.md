# Lasting Atlas

> *Leave your mark. Beyond Earth.*
> An interactive premium Earth atlas — 200,000 permanent land cells, seven hidden Wonders, one final map bound for the Earth Trace Mission.

This repository contains the **front-end design & interactive prototype** of Lasting Atlas: a single, self-contained streaming Design Component that renders both a **2.5D illustrated flat atlas** and a **3D WebGL globe**, with cell selection & purchase, flags & cooperation, fog of exploration, banners, Voice of the Atlas, and the cinematic Wonder-discovery moment.

---

## Run it (Docker)

Two services now run together (via `docker compose`): the **web** container (nginx serving
the static app) and the **backend** API container (Node) that owns orders, payment
verification, the cell ledger, certificates and admin. nginx proxies `/api/*` to the backend.

```bash
# build + run both services
docker compose up --build
# open
http://localhost:8080
```

Before a real launch, copy `backend/.env.example` → `backend/.env` and set `ATLAS_SECRET`,
`ADMIN_PASSWORD`, `RECEIVING_WALLETS`, `CORS_ORIGIN`, and `PROVIDER=evm` with your explorer/RPC
keys. The shipped `backend/.env` uses safe **mock** defaults (payments auto-confirm after a few
seconds) so the stack runs end-to-end out of the box for local testing.

---

## Backend API & payment security

The browser is never trusted with money or ownership. Flow:

1. **Checkout** → `POST /api/order` reserves the selected cells server-side, assigns a
   receiving wallet from the pool, and returns an **exact, uniquely-tagged USDC amount**
   (e.g. `8.017`) so concurrent same-price payments are distinguishable on-chain.
2. **Watch** → the backend polls the chain (or uses the mock) for that exact transfer to the
   assigned wallet. The buyer's **sending address is read from the transaction** — nothing to
   connect or type in the UI.
3. **Confirm** → only a confirmed transfer (after N block confirmations) flips the order to
   `paid`, writes the cells as owned, and issues a verifiable certificate. The frontend just
   polls `GET /api/order/:id` and reacts to `paid`.
4. **Abuse guards** → cells lock the instant checkout starts, unpaid reservations expire
   (`ORDER_TTL_MS`), one active order per cell, rate-limited endpoints, admin actions require a
   signed session (HMAC-JWT), and certificate hashes are HMACs over the canonical record.

Endpoints: `POST /api/order`, `GET /api/order/:id`, `POST /api/order/:id/cancel`,
`GET /api/state`, `GET /api/verify/:hashOrSerial`, `POST /api/admin/login`,
`GET /api/admin/orders`, `POST /api/admin/mark/:id`, `POST /api/admin/mark/:id/remove`,
`GET /api/health`.

> If the API is unreachable (e.g. the design preview with no backend), the frontend falls back
> to a local simulation so the experience still demonstrates end-to-end.

---

## What's in this build

| Area | Status |
|---|---|
| Premium atlas chrome (banners, Voice, World Status, 7 Wonders, Legend, Selected Plot, Create Mark, Mission Reserve, Recent Activity, Top Marks, Transparency, footer) | ✅ |
| **Flat 2.5D map** — pan, zoom, drifting fog, animated ships, aurora, ocean labels, graticule | ✅ |
| **3D globe** — Three.js sphere, atmosphere shader, drag-to-spin, zoom, live mark/Wonder markers | ✅ |
| **Real Natural Earth terrain** — coastlines & country borders from Natural Earth (public domain), procedural shaded relief (hillshade), biomes (tundra/taiga/grass/forest/tropics/desert/savanna/rock/snow), continental shelves & coastal foam | ✅ |
| **Hexagonal plot grid** that only resolves on zoom-in (far view = beautiful Earth, close view = selectable hexes) | ✅ |
| Single & multi-hex selection (click / Shift-drag box-select), live price total (2 / 5 / 8 USDC) | ✅ |
| Create a flag (territory colour, name, quote, link) **or** join a nearby flag | ✅ |
| Flag growth by soft formula `baseSize + scale·√connectedCells` | ✅ |
| Fog clears around purchases; territories & flags grow on the map and globe | ✅ |
| Banner takeover modal with geometric price ladder (100→200→400…→×1.5) | ✅ |
| Voice of the Atlas — 4-hour countdown + weighted reselection | ✅ |
| Hidden Wonder discovery — cinematic reveal, geographically **decoupled** trigger | ✅ |
| Cosmic backdrop — sun, starfield, periodic comet | ✅ |
| Starts from a clean **launch-day** world (0 claimed, 0 banners, no Voice) | ✅ |

Everything lives on **one page** — no redirects, no separate routes.

---

## How the hidden Wonders behave

Per spec, a Wonder's discovery trigger is **never** near its real location. In this
prototype the reveal is driven client-side for demonstration (a buy has a chance to
surface the next undiscovered Wonder, and the reveal card shows the unrelated origin
plot). In production this MUST move server-side:

- Trigger cells are fixed, random, and **disconnected** from the Wonder's geography.
- Wonder names, glyphs, coordinates and trigger cells are **not** shipped to the client
  until the moment of discovery (not in JS bundles, not in API responses).
- The discoverer is recorded permanently on-chain / in the archive.

---

## Production hand-off (not in this front-end prototype)

This deliverable is the experience layer. A production launch additionally needs:

1. **Backend / API** — cell ledger (200k cells, terrain class, price tier, owner, flag),
   purchases, flags/marks, banners, Voice draws, Wonder records, activity feed.
2. **Wallet & payments** — USDC receiving wallet(s), network config, confirmations,
   treasury / mission-reserve / banner wallets, on-chain verification.
3. **PDF certificates** — premium ownership document per purchase (wallet, cell IDs,
   price, tx hash, flag, quote, territory, verification hash, branding).
4. **Hidden Admin panel** — non-obvious route (env-configured); moderate purchases,
   flags, quotes, links, banners, Wonders, certificates; manage payment wallets;
   full audit log (admin · time · field · old → new · note). Never exposes Wonder triggers.
5. **Earth Trace Mission archive** — frozen final map, Voice of Earth, final banner
   holders, Wonders + discoverers, high-res paper edition, capsule status, sponsors.
6. **Offline assets** — vendor fonts + (optionally) a higher-resolution / tiled satellite
   terrain set. The map here generates illustrated shaded-relief terrain at runtime from
   real Natural Earth coastlines (`countries-50m.json`, vendored into the image at build
   time); swap in real satellite tiles if photographic "more zoom = more detail" is wanted.

---

## Tweakable props

The root component exposes (editable in the design host's Tweaks panel):

- `startView` — `flat` or `globe`
- `goldAccent` — the gilt accent colour

---

## Files

```
index.html            redirect → app
Lasting Atlas.dc.html  the app (template + logic, streaming Design Component)
support.js             Design Component runtime
assets/earth.png       baked illustrated Earth texture (flat map + globe)
Dockerfile             self-contained nginx image (vendors Three.js)
nginx.conf             static serving + caching
docker-compose.yml     one-command run
```
