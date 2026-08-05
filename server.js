// hiessence PR Shoot — connector (backend), zero dependencies (Node 18+).
// Holds the Lark app credentials server-side, talks to the Lark Base API.
// The website (public/index.html) calls THIS server, never Lark directly.
//
// Required environment variables (set these in your host, NOT in code):
//   LARK_APP_ID       = cli_aafb1732ff38de18
//   LARK_APP_SECRET   = <your app secret>   <-- keep this private
// Optional (already defaulted to the hiessence base):
//   LARK_DOMAIN, WIKI_TOKEN, TABLE_PRODUCTS, TABLE_PRSHOOTS, TABLE_SHOOTITEMS

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CFG = {
  domain: process.env.LARK_DOMAIN || "https://open.larksuite.com",
  appId: process.env.LARK_APP_ID || "cli_aafb1732ff38de18",
  appSecret: process.env.LARK_APP_SECRET || "",
  wikiToken: process.env.WIKI_TOKEN || "QouawhoyBi1LlJkNunRjkBtEpMe",
  tblProducts: process.env.TABLE_PRODUCTS || "tblUtz2SKZNW85HD",
  tblShoots: process.env.TABLE_PRSHOOTS || "tblkBmCmFu77v0iE",
  tblItems: process.env.TABLE_SHOOTITEMS || "tblQDe19HojFjVCR",
};

// ---- Lark API helpers -------------------------------------------------------

let _token = { value: null, exp: 0 };
async function tenantToken() {
  const now = Date.now();
  if (_token.value && now < _token.exp - 60_000) return _token.value;
  const r = await fetch(`${CFG.domain}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: CFG.appId, app_secret: CFG.appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`tenant_access_token failed: ${j.code} ${j.msg}`);
  _token = { value: j.tenant_access_token, exp: now + j.expire * 1000 };
  return _token.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Lark codes worth retrying (rate limit / transient server "Fail" conditions)
const TRANSIENT = new Set([1254002, 1254607, 1254291, 99991400, 99991661, 99991663, 99991665]);

async function larkFetch(url, init) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const t = await tenantToken();
      const r = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${t}`, ...(init && init.headers) },
      });
      const j = await r.json();
      if (j.code && TRANSIENT.has(j.code)) {
        last = new Error(`lark ${j.code} ${j.msg}`);
        await sleep(600 * (i + 1));
        continue;
      }
      return j;
    } catch (e) {
      last = e;
      await sleep(600 * (i + 1));
    }
  }
  throw last;
}
const larkGet = (url) => larkFetch(url);
const larkPost = (url, body) =>
  larkFetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Base lives inside a Lark Wiki, so resolve the wiki node -> base app_token.
let _appToken = null;
async function baseAppToken() {
  if (_appToken) return _appToken;
  const j = await larkGet(
    `${CFG.domain}/open-apis/wiki/v2/spaces/get_node?token=${CFG.wikiToken}&obj_type=wiki`
  );
  if (j.code !== 0) throw new Error(`wiki get_node failed: ${j.code} ${j.msg}`);
  _appToken = j.data.node.obj_token;
  return _appToken;
}
const recUrl = (appToken, tableId, suffix = "") =>
  `${CFG.domain}/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records${suffix}`;

// ---- Field readers (tolerant of Lark's value shapes) ------------------------

function readText(v) {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map((x) => x?.text ?? x?.name ?? "").join("");
  if (typeof v === "object") return v.text ?? v.name ?? "";
  return "";
}
function readNumber(v) {
  const n = typeof v === "object" && v && v.value != null ? v.value : v;
  const num = Number(Array.isArray(n) ? n[0] : n);
  return Number.isFinite(num) ? num : 0;
}
function readAttachmentToken(v) {
  if (Array.isArray(v) && v.length && v[0] && v[0].file_token) return v[0].file_token;
  return null;
}
const CAT_MAP = { Diffuser: "diffuser", "Aroma Oil": "oil", "Kit / Set": "kit", Kit: "kit" };
// Decide the website tab: kits/sets/candles win by name, else Lark category, else guess by name.
function catFor(catText, name) {
  const n = (name || "").toLowerCase();
  if (/\b(kit|set|candle)\b/.test(n)) return "kit";
  if (CAT_MAP[catText]) return CAT_MAP[catText];
  if (n.includes("oil")) return "oil";
  return "diffuser";
}

// ---- API handlers -----------------------------------------------------------

async function getProducts() {
  const appToken = await baseAppToken();
  const items = [];
  let pageToken = "";
  do {
    const suffix = `?page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`;
    const j = await larkGet(recUrl(appToken, CFG.tblProducts, suffix));
    if (j.code !== 0) throw new Error(`list products failed: ${j.code} ${j.msg}`);
    for (const rec of j.data.items || []) {
      const f = rec.fields || {};
      const catText = readText(f["Category"]);
      const name = readText(f["Product Name"]);
      const imgToken = readAttachmentToken(f["Image"]);
      // Compute stock from source fields (Initial Stock updates instantly, unlike
      // the "Current Stock" formula which lags in the API after bulk edits).
      const stock =
        readNumber(f["Initial Stock"]) + readNumber(f["Total Received"]) - readNumber(f["To Bring"]);
      items.push({
        id: rec.record_id,
        name,
        cat: catFor(catText, name),
        catText,
        stock,
        image: imgToken ? `/api/image/${imgToken}` : null,
      });
    }
    pageToken = j.data.has_more ? j.data.page_token : "";
  } while (pageToken);
  return items;
}

// Convert a 24-hour "HH:MM" time (from the website input) to "H:MM AM/PM".
function to12Hour(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  if (!m) return String(t || "");
  let h = Number(m[1]);
  const min = m[2];
  const ap = h < 12 ? "AM" : "PM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${h}:${min} ${ap}`;
}

async function createShoot(body) {
  const { talent, address, date, time, videoEditor, contentStrat, items } = body || {};
  if (!Array.isArray(items) || items.length === 0) {
    const err = new Error("No units selected.");
    err.status = 400;
    throw err;
  }
  const appToken = await baseAppToken();
  const shootFields = {
    "Talent Name": talent || "(no name)",
    "Address": address || "",
    "Status": "Scheduled",
  };
  if (date) shootFields["Shoot Date"] = new Date(`${date}T00:00:00`).getTime();
  if (time) shootFields["Shoot Time"] = to12Hour(time);
  if (videoEditor) shootFields["Videographer/Editor"] = videoEditor;
  if (contentStrat) shootFields["Content Strategy Associate"] = contentStrat;

  // Pre-format the units as plain text (one "Name ×qty" per line) and store it on
  // the shoot record itself. The "new record" automation snapshots the shoot the
  // instant it is created — before the linked Shoot Items exist — so the linked
  // "Units to Bring" / "Units List" fields are still empty at that moment. Writing
  // the text here makes the unit list available in that first snapshot.
  try {
    const products = await getProducts();
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    const unitsText = items
      .map((it) => `${nameById.get(it.id) || "Item"} ×${Number(it.qty) || 0}`)
      .join("\n");
    if (unitsText) shootFields["Units Text"] = unitsText;
  } catch (_) {
    /* non-fatal: fall back to the linked-field automations if lookup fails */
  }

  const shootRes = await larkPost(recUrl(appToken, CFG.tblShoots), { fields: shootFields });
  if (shootRes.code !== 0) throw new Error(`create shoot failed: ${shootRes.code} ${shootRes.msg}`);
  const shootId = shootRes.data.record.record_id;

  const created = [];
  for (const it of items) {
    const itemRes = await larkPost(recUrl(appToken, CFG.tblItems), {
      fields: { "Product": [it.id], "Quantity": Number(it.qty) || 0, "Shoot": [shootId] },
    });
    if (itemRes.code !== 0) throw new Error(`create item failed: ${itemRes.code} ${itemRes.msg}`);
    created.push(itemRes.data.record.record_id);
  }
  return { shootId, items: created };
}

// ---- HTTP plumbing ----------------------------------------------------------

function serveIndex(res) {
  fs.readFile(path.join(__dirname, "index.html"), (err, data) => {
    if (err) { res.writeHead(500); return res.end("index.html missing"); }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(data);
  });
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  try {
    if (url === "/api/health") {
      return sendJson(res, 200, { ok: true, appIdSet: !!CFG.appId, secretSet: !!CFG.appSecret, domain: CFG.domain });
    }
    if (url === "/api/products" && req.method === "GET") {
      const products = await getProducts();
      return sendJson(res, 200, { ok: true, products });
    }
    if (url.startsWith("/api/image/") && req.method === "GET") {
      const token = url.slice("/api/image/".length);
      const t = await tenantToken();
      const r = await fetch(`${CFG.domain}/open-apis/drive/v1/medias/${token}/download`, {
        headers: { Authorization: `Bearer ${t}` },
      });
      if (!r.ok) { res.writeHead(502); return res.end(); }
      res.writeHead(200, { "Content-Type": r.headers.get("content-type") || "image/jpeg", "Cache-Control": "public, max-age=86400" });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    if (url === "/api/shoots" && req.method === "POST") {
      const body = await readBody(req);
      const out = await createShoot(body);
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (url.startsWith("/api/")) return sendJson(res, 404, { ok: false, error: "Not found" });
    return serveIndex(res);
  } catch (e) {
    console.error("API error:", (e && e.stack) || e);
    sendJson(res, e.status || 500, { ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`hiessence connector running on :${PORT}`));
