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
  tblDeliveries: process.env.TABLE_DELIVERIES || "tblwYjnDfU2p69MZ",
  // Custom bot webhook for the "Creative Department [Content]" group chat.
  webhook: process.env.LARK_WEBHOOK_URL || "https://open.larksuite.com/open-apis/bot/v2/hook/3321f7f7-f822-425a-ba8b-0c809e1d2f46",
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
const larkPut = (url, body) =>
  larkFetch(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const larkPatch = (url, body) =>
  larkFetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const larkDelete = (url) => larkFetch(url, { method: "DELETE" });

// Pull every "rec..." id out of a link field's value (shape varies by API version).
function extractRecordIds(v) {
  const ids = [];
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === "string") { if (/^rec[A-Za-z0-9]+$/.test(x)) ids.push(x); return; }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === "object") {
      if (x.record_ids) walk(x.record_ids);
      if (x.record_id) walk(x.record_id);
      if (x.link_record_ids) walk(x.link_record_ids);
      if (x.id && /^rec/.test(x.id)) walk(x.id);
    }
  };
  walk(v);
  return [...new Set(ids)];
}

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
        reorder: readNumber(f["Reorder Qty"]),
        image: imgToken ? `/api/image/${imgToken}` : null,
      });
    }
    pageToken = j.data.has_more ? j.data.page_token : "";
  } while (pageToken);
  return items;
}

// ---- Group-chat notifications (custom bot webhook) --------------------------

// Format an epoch-ms date as "Aug 14, 2026" in Manila time (matches the calendar).
function fmtDateMs(ms) {
  if (!ms) return "";
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

// Post a plain-text message to the group chat via the custom bot webhook (no auth).
// Returns the Lark response (or an error string) so callers can surface delivery status.
async function postWebhookText(text) {
  if (!CFG.webhook || !text) return { skipped: true };
  try {
    const r = await fetch(CFG.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
    try { return await r.json(); } catch { return { status: r.status }; }
  } catch (e) {
    /* non-fatal: a failed notification must never break the reschedule itself */
    return { error: String(e && e.message || e) };
  }
}

// Build the "Rescheduled" group-chat message with the same details as a new booking.
function rescheduleText(f) {
  const lines = ["PR Shoot Rescheduled", ""];
  if (f.talent) lines.push(`Talent: ${f.talent}`);
  if (f.dateText) lines.push(`Date: ${f.dateText}`);
  if (f.timeText) lines.push(`Time: ${f.timeText}`);
  if (f.address) lines.push(`Address: ${f.address}`);
  if (f.videoEditor) lines.push(`Videographer/Editor: ${f.videoEditor}`);
  if (f.contentStrat) lines.push(`Content Strategy Associate: ${f.contentStrat}`);
  if (f.unitsText) lines.push(`Units to bring:\n${f.unitsText}`);
  return lines.join("\n");
}

// ---- Lark Calendar sync -----------------------------------------------------
// Shoots are mirrored onto an app-owned shared calendar so the Lark Calendar
// stays in sync: an event is created on booking, moved on reschedule/edit, and
// removed on delete. The event id is stored on the shoot record.

const SHOOT_CAL_NAME = "hiessence PR Shoots";
let _calId = null;

// Find (or create) the shared PR-shoots calendar; cache its id in memory.
async function ensureShootCalendar() {
  if (_calId) return _calId;
  try {
    const j = await larkGet(`${CFG.domain}/open-apis/calendar/v4/calendars?page_size=500`);
    if (j.code === 0 && j.data) {
      const list = j.data.calendar_list || j.data.items || [];
      const found = list.find((c) => (c.summary || "") === SHOOT_CAL_NAME);
      if (found) { _calId = found.calendar_id; return _calId; }
    }
  } catch (_) { /* fall through to create */ }
  const c = await larkPost(`${CFG.domain}/open-apis/calendar/v4/calendars`, {
    summary: SHOOT_CAL_NAME,
    description: "PR shoot schedule, synced automatically from the hiessence website.",
    permissions: "public",
    color: -14513409,
  });
  if (c.code !== 0) throw new Error(`create calendar failed: ${c.code} ${c.msg}`);
  _calId = c.data.calendar.calendar_id;
  return _calId;
}

// Build Lark event start/end from a Shoot Date (epoch ms) + a "H:MM AM/PM" text.
// With a time -> a 1-hour timed event; without -> an all-day event. Manila time.
function eventTimes(dateMs, timeText) {
  const d = new Date(Number(dateMs) + 8 * 3600 * 1000);
  const Y = d.getUTCFullYear(), M = d.getUTCMonth(), D = d.getUTCDate();
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(String(timeText || ""));
  if (!m) {
    const ds = `${Y}-${String(M + 1).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
    return { start_time: { date: ds, timezone: "Asia/Manila" }, end_time: { date: ds, timezone: "Asia/Manila" } };
  }
  let hh = Number(m[1]); const mm = Number(m[2]); const ap = (m[3] || "").toUpperCase();
  if (ap === "PM" && hh < 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  const startSec = Math.floor(Date.UTC(Y, M, D, hh, mm) / 1000) - 8 * 3600;
  return {
    start_time: { timestamp: String(startSec), timezone: "Asia/Manila" },
    end_time: { timestamp: String(startSec + 3600), timezone: "Asia/Manila" },
  };
}

function eventBody({ dateMs, timeText, talent, address, unitsText }) {
  const t = eventTimes(dateMs, timeText);
  const body = { summary: talent || "PR Shoot", start_time: t.start_time, end_time: t.end_time };
  body.description = unitsText ? `Units to bring:\n${unitsText}` : "";
  if (address) body.location = { name: address };
  return body;
}

// Create a calendar event for a shoot; returns the event id (or null on failure).
async function createShootEvent(info) {
  try {
    const calId = await ensureShootCalendar();
    const r = await larkPost(`${CFG.domain}/open-apis/calendar/v4/calendars/${calId}/events`, eventBody(info));
    if (r.code === 0 && r.data && r.data.event) return r.data.event.event_id;
  } catch (_) { /* non-fatal */ }
  return null;
}

// Move/update an existing shoot event (non-fatal on any error).
async function updateShootEvent(eventId, info) {
  if (!eventId) return;
  try {
    const calId = await ensureShootCalendar();
    await larkPatch(`${CFG.domain}/open-apis/calendar/v4/calendars/${calId}/events/${eventId}`, eventBody(info));
  } catch (_) { /* non-fatal */ }
}

// Remove a shoot event (non-fatal on any error).
async function deleteShootEvent(eventId) {
  if (!eventId) return;
  try {
    const calId = await ensureShootCalendar();
    await larkDelete(`${CFG.domain}/open-apis/calendar/v4/calendars/${calId}/events/${eventId}`);
  } catch (_) { /* non-fatal */ }
}

// Make sure the shoots table has a "Calendar Event ID" text field to store event ids.
let _eventFieldReady = false;
async function ensureEventIdField() {
  if (_eventFieldReady) return;
  try {
    const appToken = await baseAppToken();
    const j = await larkGet(`${CFG.domain}/open-apis/bitable/v1/apps/${appToken}/tables/${CFG.tblShoots}/fields?page_size=200`);
    if (j.code === 0 && j.data) {
      const exists = (j.data.items || []).some((f) => f.field_name === "Calendar Event ID");
      if (!exists) {
        await larkPost(`${CFG.domain}/open-apis/bitable/v1/apps/${appToken}/tables/${CFG.tblShoots}/fields`, {
          field_name: "Calendar Event ID", type: 1,
        });
      }
      _eventFieldReady = true;
    }
  } catch (_) { /* non-fatal: event-id storage is best-effort */ }
}

// Read a Lark date field (stored as epoch ms) into a number, or null.
function readDateMs(v) {
  if (v == null) return null;
  const n = typeof v === "object" && v && v.value != null ? v.value : v;
  const num = Number(Array.isArray(n) ? n[0] : n);
  return Number.isFinite(num) ? num : null;
}

// List every PR Shoot (for the website calendar view).
async function getShoots() {
  const appToken = await baseAppToken();
  const items = [];
  let pageToken = "";
  do {
    const suffix = `?page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`;
    const j = await larkGet(recUrl(appToken, CFG.tblShoots, suffix));
    if (j.code !== 0) throw new Error(`list shoots failed: ${j.code} ${j.msg}`);
    for (const rec of j.data.items || []) {
      const f = rec.fields || {};
      items.push({
        id: rec.record_id,
        talent: readText(f["Talent Name"]),
        date: readDateMs(f["Shoot Date"]),
        time: readText(f["Shoot Time"]),
        address: readText(f["Address"]),
        status: readText(f["Status"]),
        videoEditor: readText(f["Videographer/Editor"]),
        contentStrat: readText(f["Content Strategy Associate"]),
        units: readText(f["Units Text"]),
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

  // Mirror the shoot onto the shared Lark Calendar and remember the event id.
  await ensureEventIdField();
  const eventId = await createShootEvent({
    dateMs: shootFields["Shoot Date"],
    timeText: shootFields["Shoot Time"],
    talent: shootFields["Talent Name"],
    address: shootFields["Address"],
    unitsText: shootFields["Units Text"] || "",
  });
  if (eventId) {
    await larkPut(recUrl(appToken, CFG.tblShoots, `/${shootId}`), { fields: { "Calendar Event ID": eventId } });
  }

  return { shootId, items: created };
}

// ---- Deliveries (stock-in) --------------------------------------------------

async function getDeliveries() {
  const appToken = await baseAppToken();
  const items = [];
  let pageToken = "";
  do {
    const suffix = `?page_size=100${pageToken ? `&page_token=${pageToken}` : ""}`;
    const j = await larkGet(recUrl(appToken, CFG.tblDeliveries, suffix));
    if (j.code !== 0) throw new Error(`list deliveries failed: ${j.code} ${j.msg}`);
    for (const rec of j.data.items || []) {
      const f = rec.fields || {};
      items.push({
        id: rec.record_id,
        no: readText(f["Delivery No."]),
        product: readText(f["Product"]),
        qty: readNumber(f["Quantity Received"]),
        date: readDateMs(f["Date Received"]),
      });
    }
    pageToken = j.data.has_more ? j.data.page_token : "";
  } while (pageToken);
  // drop blank rows, newest first
  return items.filter((x) => x.qty > 0).sort((a, b) => (b.date || 0) - (a.date || 0));
}

// Reschedule a shoot (change its Shoot Date) — e.g. drag to another day.
async function updateShoot(body) {
  const { id, date } = body || {};
  if (!id) { const e = new Error("Missing shoot id."); e.status = 400; throw e; }
  const appToken = await baseAppToken();
  // Read the current record first: for change-detection and for the notif details.
  let old = null;
  const g = await larkGet(recUrl(appToken, CFG.tblShoots, `/${id}`));
  if (g.code === 0 && g.data && g.data.record) old = g.data.record.fields || {};
  const newMs = date ? new Date(`${date}T00:00:00`).getTime() : null;
  const oldMs = old ? readDateMs(old["Shoot Date"]) : null;
  const fields = {};
  if (date) fields["Shoot Date"] = newMs;
  const res = await larkPut(recUrl(appToken, CFG.tblShoots, `/${id}`), { fields });
  if (res.code !== 0) throw new Error(`update shoot failed: ${res.code} ${res.msg}`);
  // Only notify + move the calendar event when the date actually moved.
  if (old && newMs && newMs !== oldMs) {
    await postWebhookText(rescheduleText({
      talent: readText(old["Talent Name"]),
      dateText: fmtDateMs(newMs),
      timeText: readText(old["Shoot Time"]),
      address: readText(old["Address"]),
      videoEditor: readText(old["Videographer/Editor"]),
      contentStrat: readText(old["Content Strategy Associate"]),
      unitsText: readText(old["Units Text"]),
    }));
    await updateShootEvent(readText(old["Calendar Event ID"]), {
      dateMs: newMs,
      timeText: readText(old["Shoot Time"]),
      talent: readText(old["Talent Name"]),
      address: readText(old["Address"]),
      unitsText: readText(old["Units Text"]),
    });
  }
  return { id };
}

// Delete a shoot AND its linked Shoot Items (so the reserved stock is returned).
async function deleteShoot(body) {
  const { id } = body || {};
  if (!id) { const e = new Error("Missing shoot id."); e.status = 400; throw e; }
  const appToken = await baseAppToken();
  const g = await larkGet(recUrl(appToken, CFG.tblShoots, `/${id}`));
  if (g.code === 0 && g.data && g.data.record) {
    const f = g.data.record.fields || {};
    const itemIds = extractRecordIds(f["Units to Bring"]);
    for (const iid of itemIds) {
      await larkDelete(recUrl(appToken, CFG.tblItems, `/${iid}`));
    }
    // Remove the mirrored calendar event, if any.
    await deleteShootEvent(readText(f["Calendar Event ID"]));
  }
  const res = await larkDelete(recUrl(appToken, CFG.tblShoots, `/${id}`));
  if (res.code !== 0) throw new Error(`delete shoot failed: ${res.code} ${res.msg}`);
  return { id };
}

// Read a shoot's current units (product id + qty) so the Edit form can pre-fill them.
async function getShootItems(shootId) {
  if (!shootId) return [];
  const appToken = await baseAppToken();
  const g = await larkGet(recUrl(appToken, CFG.tblShoots, `/${shootId}`));
  if (g.code !== 0 || !g.data || !g.data.record) return [];
  const itemIds = extractRecordIds(g.data.record.fields["Units to Bring"]);
  const out = [];
  for (const iid of itemIds) {
    const ig = await larkGet(recUrl(appToken, CFG.tblItems, `/${iid}`));
    if (ig.code === 0 && ig.data && ig.data.record) {
      const f = ig.data.record.fields || {};
      const pid = extractRecordIds(f["Product"])[0];
      if (pid) out.push({ id: pid, qty: readNumber(f["Quantity"]) });
    }
  }
  return out;
}

// Full edit: update shoot fields AND replace its units (stock re-computes to match).
async function editShoot(body) {
  const { id, talent, address, date, time, videoEditor, contentStrat, items } = body || {};
  if (!id) { const e = new Error("Missing shoot id."); e.status = 400; throw e; }
  if (!Array.isArray(items) || items.length === 0) { const e = new Error("No units selected."); e.status = 400; throw e; }
  const appToken = await baseAppToken();
  const fields = { "Talent Name": talent || "(no name)", "Address": address || "" };
  if (date) fields["Shoot Date"] = new Date(`${date}T00:00:00`).getTime();
  if (time) fields["Shoot Time"] = to12Hour(time);
  if (videoEditor) fields["Videographer/Editor"] = videoEditor;
  if (contentStrat) fields["Content Strategy Associate"] = contentStrat;
  try {
    const products = await getProducts();
    const nameById = new Map(products.map((p) => [p.id, p.name]));
    fields["Units Text"] = items.map((it) => `${nameById.get(it.id) || "Item"} ×${Number(it.qty) || 0}`).join("\n");
  } catch (_) {}
  // remove the old shoot items, then update the shoot, then create the new items
  const g = await larkGet(recUrl(appToken, CFG.tblShoots, `/${id}`));
  let dateOrTimeChanged = false;
  let eventId = "";
  let oldDateMs = null;
  let oldTimeText = "";
  if (g.code === 0 && g.data && g.data.record) {
    const oldF = g.data.record.fields || {};
    oldDateMs = readDateMs(oldF["Shoot Date"]);
    oldTimeText = readText(oldF["Shoot Time"]);
    eventId = readText(oldF["Calendar Event ID"]);
    if (date && fields["Shoot Date"] !== oldDateMs) dateOrTimeChanged = true;
    if (time && fields["Shoot Time"] !== oldTimeText) dateOrTimeChanged = true;
    for (const iid of extractRecordIds(oldF["Units to Bring"])) {
      await larkDelete(recUrl(appToken, CFG.tblItems, `/${iid}`));
    }
  }
  const up = await larkPut(recUrl(appToken, CFG.tblShoots, `/${id}`), { fields });
  if (up.code !== 0) throw new Error(`edit shoot failed: ${up.code} ${up.msg}`);
  for (const it of items) {
    const ir = await larkPost(recUrl(appToken, CFG.tblItems), {
      fields: { "Product": [it.id], "Quantity": Number(it.qty) || 0, "Shoot": [id] },
    });
    if (ir.code !== 0) throw new Error(`create item failed: ${ir.code} ${ir.msg}`);
  }
  // Notify the group chat only when the schedule (date or time) actually moved.
  if (dateOrTimeChanged) {
    await postWebhookText(rescheduleText({
      talent: talent || "(no name)",
      dateText: fields["Shoot Date"] ? fmtDateMs(fields["Shoot Date"]) : "",
      timeText: fields["Shoot Time"] || "",
      address: address || "",
      videoEditor: videoEditor || "",
      contentStrat: contentStrat || "",
      unitsText: fields["Units Text"] || "",
    }));
  }
  // Keep the Lark Calendar event in sync with the edited details.
  if (eventId) {
    await updateShootEvent(eventId, {
      dateMs: fields["Shoot Date"] || oldDateMs,
      timeText: fields["Shoot Time"] || oldTimeText,
      talent: talent || "(no name)",
      address: address || "",
      unitsText: fields["Units Text"] || "",
    });
  }
  return { id };
}

// Log a delivery -> the Product's "Total Received" rollup rises -> stock rises.
async function createDelivery(body) {
  const { productId, productName, qty, date } = body || {};
  const q = Number(qty) || 0;
  if (!productId || q <= 0) {
    const err = new Error("Pick a product and a quantity greater than 0.");
    err.status = 400;
    throw err;
  }
  const appToken = await baseAppToken();
  const fields = {
    "Delivery No.": `${productName || "Stock-in"} ×${q}`,
    "Product": [productId],
    "Quantity Received": q,
  };
  if (date) fields["Date Received"] = new Date(`${date}T00:00:00`).getTime();
  const res = await larkPost(recUrl(appToken, CFG.tblDeliveries), { fields });
  if (res.code !== 0) throw new Error(`create delivery failed: ${res.code} ${res.msg}`);
  return { id: res.data.record.record_id };
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
    if (url === "/api/shoots" && req.method === "GET") {
      const shoots = await getShoots();
      return sendJson(res, 200, { ok: true, shoots });
    }
    if (url === "/api/deliveries" && req.method === "GET") {
      const deliveries = await getDeliveries();
      return sendJson(res, 200, { ok: true, deliveries });
    }
    if (url === "/api/deliveries" && req.method === "POST") {
      const body = await readBody(req);
      const out = await createDelivery(body);
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (url === "/api/shoots" && req.method === "POST") {
      const body = await readBody(req);
      const out = await createShoot(body);
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (url === "/api/shoots/items" && req.method === "GET") {
      const id = new URL(req.url, "http://x").searchParams.get("id");
      const items = await getShootItems(id);
      return sendJson(res, 200, { ok: true, items });
    }
    if (url === "/api/shoots/edit" && req.method === "POST") {
      const out = await editShoot(await readBody(req));
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (url === "/api/shoots/update" && req.method === "POST") {
      const out = await updateShoot(await readBody(req));
      return sendJson(res, 200, { ok: true, ...out });
    }
    if (url === "/api/shoots/delete" && req.method === "POST") {
      const out = await deleteShoot(await readBody(req));
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
