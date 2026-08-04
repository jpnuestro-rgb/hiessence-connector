# hiessence PR Shoot — website + connector

A small website (the +/- units cart) plus a backend "connector" that talks to
your Lark Base. The website calls the connector; the connector holds your Lark
app secret and talks to Lark. Your secret never reaches the browser.

```
Browser (public/index.html)  →  Connector (server.js)  →  Lark Base API
        pick units, Create              holds APP_SECRET        products, create shoot
```

## What it does

- `GET /api/products` — reads your **Products** table (name, category, **live
  Current Stock**, photo) and returns it to the website.
- `GET /api/image/:token` — streams a product photo from the Base.
- `POST /api/shoots` — creates a **PR Shoot** record + one **Shoot Item** per
  selected product. That automatically **deducts stock** (via the "To Bring"
  rollup) and fires your **calendar + notification** automation.

## Before it will work

1. The Lark app **"hiessence Website Connector"** must be **approved** by a Lark
   workspace admin (Zen G / Michael Cordoviz).
2. The app must be **added to the base** as a collaborator (so it can read/write
   the PR Shoot Inventory base). See "Add the app to the base" below.
3. You set the **App Secret** as an environment variable on your host (step below).

## Run locally (to try it on your own machine)

```bash
npm install
cp .env.example .env      # then edit .env and paste your App Secret
npm start                 # opens on http://localhost:3000
```

## Deploy (recommended: Render.com — free, no card)

1. Put this folder in a GitHub repo (or upload it).
2. On Render → **New → Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
4. **Environment → Add Environment Variable:**
   - `LARK_APP_ID` = `cli_aafb1732ff38de18`
   - `LARK_APP_SECRET` = *your app secret* (paste it here, in the host — not in code)
5. Deploy. Your website is the Render URL.

(Any Node host works — Railway, Fly.io, a VPS. The only must-have is setting the
two env vars.)

## Add the app to the base

Open the base → top-right **•••** (or **Share / Add collaborators**) → add the
app **"hiessence Website Connector"** with **edit** access. (On a wiki-hosted
base you can also add it to the wiki space.) Without this, the connector can
authenticate but can't see the base.

## Field mapping (for reference)

- Products: `Product Name`, `Category`, `Current Stock`, `Image`
- PR Shoots: `Talent Name`, `Shoot Date`, `Shoot Time`, `Address`, `Status`
- Shoot Items: `Product` (link), `Quantity`, `Shoot` (link)

If any field is renamed in Lark, update the matching key in `server.js`.
