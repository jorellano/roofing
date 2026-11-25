/* Roof Measure MVP: address -> parcel -> footprint -> squares. Runs fully in the browser, free public data only. */
"use strict";
const UA_NOTE = "RoofMeasure MVP";
const OVERTURE_PM = "https://tiles.overturemaps.org/2026-11-18.0/buildings.pmtiles";
const EPT_BASE = "https://usgs-lidar-public.s3.amazonaws.com/";
const SQFT = 10.7639104;
const DEFAULT_PITCH = 5; // assumption: typical Southern California tract-home pitch
const PARCELS = {
  "San Diego County": {
    label: "San Diego County parcels (County of San Diego GIS)",
    url: "https://gis-public.sandiegocounty.gov/arcgis/rest/services/cosd_warehouse/parcels_all_for_public_use/MapServer/0/query",
    where: (num, core) => `SITUS_ADDRESS=${num} AND SITUS_STREET LIKE '${core}%'`,
    fields: "APN,SITUS_ADDRESS,SITUS_PRE_DIR,SITUS_STREET,SITUS_SUFFIX,SITUS_ZIP",
    zip: (p) => String(p.SITUS_ZIP || "").slice(0, 5),
    situs: (p) => [p.SITUS_ADDRESS, p.SITUS_PRE_DIR, p.SITUS_STREET, p.SITUS_SUFFIX].filter(Boolean).join(" "),
  },
  "Riverside County": {
    label: "Riverside County parcels (RCIT)",
    url: "https://gis.countyofriverside.us/arcgis/rest/services/parcels/Parcels/MapServer/0/query",
    where: (num, core) => `STREET_NUMBER=${num} AND STREET_NAME LIKE '${core}%'`,
    fields: "APN,SITUS_STREET,SITUS_CITY,ZIP_CODE",
    zip: (p) => String(p.ZIP_CODE || "").slice(0, 5),
    situs: (p) => `${p.SITUS_STREET || ""}`.trim(),
  },
};
const DIRS = new Set(["N", "S", "E", "W", "NORTH", "SOUTH", "EAST", "WEST", "NE", "NW", "SE", "SW"]);

const $ = (id) => document.getElementById(id);
const statusUl = document.querySelector("#status ul");
function step(text) {
  const li = document.createElement("li"); li.className = "wait"; li.textContent = text; statusUl.appendChild(li);
  return { ok: (t) => { li.className = "ok"; if (t) li.textContent = t; }, bad: (t) => { li.className = "bad"; if (t) li.textContent = t; } };
}
async function fetchJSON(url, opts = {}, ms = 20000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { ...opts, signal: c.signal }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

/* ---------- geometry helpers (local metres around a reference point) ---------- */
function projector(lon0, lat0) {
  const a = 6378137, e2 = 0.00669437999014, s = Math.sin(lat0 * Math.PI / 180);
  const N = a / Math.sqrt(1 - e2 * s * s), M = a * (1 - e2) / Math.pow(1 - e2 * s * s, 1.5);
  const kx = N * Math.cos(lat0 * Math.PI / 180) * Math.PI / 180, ky = M * Math.PI / 180;
  return { fwd: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky], inv: ([x, y]) => [lon0 + x / kx, lat0 + y / ky] };
}
const ringArea = (r) => { let s = 0; for (let i = 0; i < r.length - 1; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
const closeRing = (r) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1]) ? [...r, r[0]] : r);
function pip(pt, ring) {
  let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c;
  } return c;
}
function segDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
  let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
const edgeDist = (p, ring) => { let d = Infinity; for (let i = 0; i < ring.length - 1; i++) d = Math.min(d, segDist(p, ring[i], ring[i + 1])); return d; };
const bbox = (r) => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
function overlapShare(bld, parcel) { // share of building area inside parcel, by 0.5 m sampling
  const [x0, y0, x1, y1] = bbox(bld); let tot = 0, ins = 0;
  for (let x = x0 + 0.25; x < x1; x += 0.5) for (let y = y0 + 0.25; y < y1; y += 0.5) {
    if (pip([x, y], bld)) { tot++; if (pip([x, y], parcel)) ins++; }
  } return tot ? ins / tot : 0;
}
function ringDistToPoint(ring, p) { return pip(p, ring) ? 0 : edgeDist(p, ring); }
function mainAxis(ring) { // orientation (deg, 0..90) of min-area bounding rectangle among edge directions
  let best = [Infinity, 0];
  for (let i = 0; i < ring.length - 1; i++) {
    const ang = Math.atan2(ring[i + 1][1] - ring[i][1], ring[i + 1][0] - ring[i][0]);
    const c = Math.cos(-ang), s = Math.sin(-ang);
    const pts = ring.map(([x, y]) => [x * c - y * s, x * s + y * c]); const b = bbox(pts);
    const A = (b[2] - b[0]) * (b[3] - b[1]); if (A < best[0]) best = [A, ang, b[2] - b[0], b[3] - b[1]];
  }
  return best;
}

/* ---------- 1. geocode (Nominatim, then Photon) ---------- */
function parseAddr(addr) {
  const parts = addr.split(",").map((s) => s.trim());
  const m = parts[0].match(/^(\d+)\s+(.+)$/);
  const zip = (addr.match(/\b(\d{5})(?:-\d{4})?\s*$/) || [])[1] || "";
  if (!m) return { num: null, street: parts[0], zip };
  const words = m[2].toUpperCase().replace(/\./g, "").split(/\s+/);
  const core = words.find((w, i) => !(DIRS.has(w) && i < words.length - 1)) || words[0];
  return { num: m[1], street: m[2], core: core.replace(/'/g, ""), zip, city: (parts[1] || "").toUpperCase() };
}
async function geocode(addr) {
  try {
    const q = new URLSearchParams({ q: addr, format: "jsonv2", addressdetails: "1", limit: "1", countrycodes: "us" });
    const r = await fetchJSON("https://nominatim.openstreetmap.org/search?" + q, {}, 12000);
    if (r.length) return { lon: +r[0].lon, lat: +r[0].lat, county: r[0].address?.county || "", zip: r[0].address?.postcode || "", src: "Nominatim (OpenStreetMap)" };
  } catch (e) { console.warn("nominatim", e); }
  const q = new URLSearchParams({ q: addr, limit: "1", lang: "en" });
  const r = await fetchJSON("https://photon.komoot.io/api/?" + q, {}, 12000);
  const f = r.features && r.features[0];
  if (!f) throw new Error("Address not found");
  return { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], county: f.properties.county || "", zip: f.properties.postcode || "", src: "Photon (OpenStreetMap)" };
}

/* ---------- 2. parcel ---------- */
async function parcelLookup(pa, geo) {
  if (!pa.num) return null;
  const order = PARCELS[geo?.county] ? [geo.county] : Object.keys(PARCELS);
  for (const county of order) {
    const P = PARCELS[county];
    const q = new URLSearchParams({ where: P.where(pa.num, pa.core), outFields: P.fields, outSR: "4326", f: "geojson" });
    let d; try { d = await fetchJSON(P.url + "?" + q, {}, 15000); } catch (e) { console.warn("parcel", county, e); continue; }
    let feats = (d.features || []).filter((f) => f.geometry);
    const zip = pa.zip || (geo?.zip || "").slice(0, 5);
    if (zip) { const z = feats.filter((f) => P.zip(f.properties) === zip); if (z.length) feats = z; }
    if (!feats.length) continue;
    if (feats.length > 1 && geo) { // nearest to the geocode point
      feats.sort((a, b) => dist2(centroidLL(a.geometry), geo) - dist2(centroidLL(b.geometry), geo));
    }
    const f = feats[0];
    const ring = (f.geometry.type === "MultiPolygon" ? f.geometry.coordinates[0][0] : f.geometry.coordinates[0]).map((c) => [c[0], c[1]]);
    return { ring: closeRing(ring), apn: f.properties.APN, situs: P.situs(f.properties), label: P.label, county, url: P.url.replace(/\/query$/, "") };
  }
  return null;
}
const centroidLL = (g) => { const r = g.type === "MultiPolygon" ? g.coordinates[0][0] : g.coordinates[0]; const n = r.length; return { lon: r.reduce((s, c) => s + c[0], 0) / n, lat: r.reduce((s, c) => s + c[1], 0) / n }; };
const dist2 = (a, b) => (a.lon - b.lon) ** 2 + (a.lat - b.lat) ** 2;

/* ---------- 3a. OSM via Overpass ---------- */
async function osmBuildings(lon, lat, radius) {
  const q = `[out:json][timeout:15];way["building"](around:${Math.round(radius)},${lat},${lon});out tags geom;`;
  for (const url of ["https://overpass-api.de/api/interpreter"]) { // public server, often busy; Overture already carries OSM outlines
    try {
      const d = await fetchJSON(url, { method: "POST", body: new URLSearchParams({ data: q }) }, 8000);
      return (d.elements || []).filter((e) => e.geometry && e.geometry.length >= 4).map((e) => ({
        ring: closeRing(e.geometry.map((g) => [g.lon, g.lat])), source: "OpenStreetMap", id: "way/" + e.id, tags: e.tags || {},
      }));
    } catch (e) { console.warn("overpass", url, e); }
  }
  throw new Error("Overpass unavailable");
}

/* ---------- 3b. Overture buildings via PMTiles (z14 vector tiles, HTTP range requests) ---------- */
let pm = null;
function tileXY(lon, lat, z) {
  const n = 2 ** z, la = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n)];
}
function decodeMVT(buf) { // minimal Mapbox Vector Tile decoder (polygons + string props)
  const b = new Uint8Array(buf); let pos = 0;
  const varint = () => { let r = 0, s = 0, x; do { x = b[pos++]; r += (x & 0x7f) * 2 ** s; s += 7; } while (x & 0x80); return r; };
  const skip = (wt) => { if (wt === 0) varint(); else if (wt === 1) pos += 8; else if (wt === 2) { const l = varint(); pos += l; } else if (wt === 5) pos += 4; };
  const str = (end) => new TextDecoder().decode(b.subarray(pos, end));
  const layers = [];
  while (pos < b.length) {
    const tag = varint(), f = tag >> 3, wt = tag & 7;
    if (f === 3 && wt === 2) {
      const len = varint(), end = pos + len; const L = { name: "", extent: 4096, keys: [], values: [], features: [] };
      while (pos < end) {
        const t2 = varint(), f2 = t2 >> 3, w2 = t2 & 7;
        if (f2 === 1) { const l = varint(); L.name = str(pos + l); pos += l; }
        else if (f2 === 3) { const l = varint(); L.keys.push(str(pos + l)); pos += l; }
        else if (f2 === 4) {
          const l = varint(), ve = pos + l; let v = null;
          while (pos < ve) { const t3 = varint(), f3 = t3 >> 3, w3 = t3 & 7;
            if (f3 === 1) { const sl = varint(); v = str(pos + sl); pos += sl; }
            else if (f3 === 2) { v = new DataView(b.buffer, b.byteOffset + pos, 4).getFloat32(0, true); pos += 4; }
            else if (f3 === 3) { v = new DataView(b.buffer, b.byteOffset + pos, 8).getFloat64(0, true); pos += 8; }
            else if (f3 === 4 || f3 === 5) { v = varint(); }
            else if (f3 === 6) { const z = varint(); v = (z >> 1) ^ -(z & 1); }
            else if (f3 === 7) { v = !!varint(); } else skip(w3); }
          L.values.push(v);
        }
        else if (f2 === 5) { L.extent = varint(); }
        else if (f2 === 2) {
          const l = varint(), fe = pos + l; const F = { tags: [], type: 0, geom: [] };
          while (pos < fe) { const t3 = varint(), f3 = t3 >> 3, w3 = t3 & 7;
            if (f3 === 2) { const pl = varint(), pe = pos + pl; while (pos < pe) F.tags.push(varint()); }
            else if (f3 === 3) F.type = varint();
            else if (f3 === 4) { const gl = varint(), ge = pos + gl; while (pos < ge) F.geom.push(varint()); }
            else skip(w3); }
          L.features.push(F);
        } else skip(w2);
      }
      layers.push(L);
    } else skip(wt);
  }
  return layers;
}
function mvtRings(F) {
  const rings = []; let x = 0, y = 0, i = 0, cur = null;
  while (i < F.geom.length) {
    const ci = F.geom[i++], cmd = ci & 7, cnt = ci >> 3;
    if (cmd === 1 || cmd === 2) for (let k = 0; k < cnt; k++) {
      const dx = F.geom[i++], dy = F.geom[i++]; x += (dx >> 1) ^ -(dx & 1); y += (dy >> 1) ^ -(dy & 1);
      if (cmd === 1) { cur = [[x, y]]; rings.push(cur); } else cur.push([x, y]);
    } else if (cmd === 7 && cur) cur.push([cur[0][0], cur[0][1]]);
  }
  return rings;
}
async function overtureBuildings(bboxLL) {
  if (!pm) pm = new pmtiles.PMTiles(OVERTURE_PM);
  const z = 14, [tx0, ty1] = tileXY(bboxLL[0], bboxLL[1], z), [tx1, ty0] = tileXY(bboxLL[2], bboxLL[3], z);
  const out = [];
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    const t = await pm.getZxy(z, tx, ty); if (!t) continue;
    const L = decodeMVT(t.data).find((l) => l.name === "building"); if (!L) continue;
    const n = 2 ** z;
    const toLL = ([px, py]) => { const X = (tx + px / L.extent) / n, Y = (ty + py / L.extent) / n;
      return [X * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * Y))) * 180 / Math.PI]; };
    for (const F of L.features) {
      if (F.type !== 3) continue;
      const props = {}; for (let k = 0; k < F.tags.length; k += 2) props[L.keys[F.tags[k]]] = L.values[F.tags[k + 1]];
      const rings = mvtRings(F); if (!rings.length) continue;
      // keep outer rings (MVT outer rings are clockwise in tile coords => positive area after y-flip)
      for (const r of rings) {
        if (ringArea(r) <= 0) continue;
        const ll = r.map(toLL);
        const b = bbox(ll); if (b[2] < bboxLL[0] || b[0] > bboxLL[2] || b[3] < bboxLL[1] || b[1] > bboxLL[3]) continue;
        out.push({ ring: closeRing(ll), source: "Overture Maps (" + (props["@geometry_source"] || "unknown") + ")", id: props.id || "", tags: props,
          edge: r.some(([px, py]) => px <= 0 || py <= 0 || px >= L.extent || py >= L.extent) });
      }
    }
  }
  return out;
}

/* ---------- 4. choose the building ---------- */
function choose(cands, parcel, geo, pa, proj) {
  const noGoogle = cands.filter((c) => !/google/i.test(c.source + " " + (c.tags.sources || "")));
  const P = (r) => r.map(proj.fwd);
  const area = (c) => Math.abs(ringArea(P(c.ring)));
  if (parcel) {
    const pr = P(parcel.ring); let best = null;
    for (const c of noGoogle) {
      const a = area(c) * SQFT; if (a < 600) continue; // skip sheds and garages
      const [x0, y0, x1, y1] = bbox(P(c.ring)), [p0, q0, p1, q1] = bbox(pr);
      if (x1 < p0 || x0 > p1 || y1 < q0 || y0 > q1) continue;
      const ov = overlapShare(P(c.ring), pr);
      const score = ov * a + (c.source === "OpenStreetMap" ? 1 : 0) + (/OpenStreetMap/.test(c.source) ? 0.5 : 0);
      if (ov >= 0.5 && (!best || score > best.score)) best = { ...c, ov, score };
    }
    if (best) return { ...best, conf: "high", why: `the building inside parcel APN ${parcel.apn} (${Math.round(best.ov * 100)}% inside the lot)` };
  }
  const tagHit = noGoogle.find((c) => c.source === "OpenStreetMap" && c.tags["addr:housenumber"] === pa.num &&
    (c.tags["addr:street"] || "").toUpperCase().includes(pa.core));
  if (tagHit) return { ...tagHit, conf: "high", why: "OpenStreetMap building tagged with this address" };
  const g = proj.fwd([geo.lon, geo.lat]); let best = null;
  for (const c of noGoogle) { if (area(c) * SQFT < 600) continue; const d = ringDistToPoint(P(c.ring), g); if (!best || d < best.d) best = { ...c, d }; }
  if (best && best.d < 30) return { ...best, conf: "low", why: `nearest building to the geocoded point (${Math.round(best.d)} m away); it may be a neighbour` };
  return null;
}

/* ---------- 5. optional lidar pitch (USGS 3DEP EPT, LAZ decoded in the browser) ---------- */
let eptIndex = null, lazMod = null;
const merc = { fwd: ([lon, lat]) => [lon * 20037508.342789244 / 180, Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * 6378137],
  inv: ([x, y]) => [x / 20037508.342789244 * 180, (2 * Math.atan(Math.exp(y / 6378137)) - Math.PI / 2) * 180 / Math.PI] };
async function lidarPitch(ringLL, proj, onProgress) {
  if (!eptIndex) eptIndex = await fetchJSON("data/ept_index.json");
  if (!lazMod) lazMod = await createLazPerf({ locateFile: (f) => "vendor/" + f });
  const ring = ringLL.map(proj.fwd); const [bx0, by0, bx1, by1] = bbox(ring);
  const padLL = [proj.inv([bx0 - 12, by0 - 12]), proj.inv([bx1 + 12, by1 + 12])];
  const [qx0, qy0] = merc.fwd(padLL[0]), [qx1, qy1] = merc.fwd(padLL[1]);
  const cx = (qx0 + qx1) / 2, cy = (qy0 + qy1) / 2;
  const hits = eptIndex.filter((e) => e[1] <= cx && cx <= e[3] && e[2] <= cy && cy <= e[4]).sort((a, b) => b[5] - a[5]);
  let totalBytes = 0;
  for (const [name, , , , , year] of hits) {
    const base = EPT_BASE + name + "/";
    const meta = await fetchJSON(base + "ept.json"); const B = meta.bounds;
    const hier = {}; Object.assign(hier, await fetchJSON(base + "ept-hierarchy/0-0-0-0.json"));
    const pts = []; const stack = [[0, 0, 0, 0]];
    while (stack.length) {
      const [D, X, Y, Z] = stack.pop(); const key = `${D}-${X}-${Y}-${Z}`;
      if (!(key in hier)) continue;
      if (hier[key] === -1) Object.assign(hier, await fetchJSON(base + `ept-hierarchy/${key}.json`));
      const w = (B[3] - B[0]) / 2 ** D, nx0 = B[0] + X * w, ny0 = B[1] + Y * w;
      if (nx0 > qx1 || nx0 + w < qx0 || ny0 > qy1 || ny0 + w < qy0) continue;
      if (hier[key] > 0) {
        const r = await fetch(base + `ept-data/${key}.laz`); const buf = new Uint8Array(await r.arrayBuffer());
        totalBytes += buf.length; onProgress && onProgress(totalBytes);
        decodeLaz(buf, (x, y, z, cls) => { if (x >= qx0 && x <= qx1 && y >= qy0 && y <= qy1) pts.push([x, y, z, cls]); });
      }
      for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) stack.push([D + 1, 2 * X + dx, 2 * Y + dy, 2 * Z + dz]);
    }
    if (!pts.length) continue;
    const P = pts.map(([x, y, z, c]) => { const [lx, ly] = proj.fwd(merc.inv([x, y])); return [lx, ly, z, c]; });
    const res = fitPitch(P, ring);
    return { ...res, dataset: name, year, kb: Math.round(totalBytes / 1024) };
  }
  return { ok: false, reason: "No USGS lidar covers this spot." };
}
function decodeLaz(buf, cb) {
  const M = lazMod, dv = new DataView(buf.buffer, buf.byteOffset);
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const ptr = M._malloc(buf.length); M.HEAPU8.set(buf, ptr);
  const las = new M.LASZip(); las.open(ptr, buf.length);
  const n = las.getCount(), len = las.getPointLength(), fmt = las.getPointFormat() & 0x3f;
  const p = M._malloc(len);
  for (let i = 0; i < n; i++) {
    las.getPoint(p); const v = new DataView(M.HEAPU8.buffer, p, len);
    const cls = fmt >= 6 ? v.getUint8(16) : v.getUint8(15) & 31;
    cb(v.getInt32(0, true) * sx + ox, v.getInt32(4, true) * sy + oy, v.getInt32(8, true) * sz + oz, cls);
  }
  M._free(p); las.delete(); M._free(ptr);
}
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; }
function fitPlane(nb, cx, cy) { // z = a x + b y + c, least squares
  let Sxx = 0, Sxy = 0, Syy = 0, Sx = 0, Sy = 0, Sz = 0, Sxz = 0, Syz = 0; const n = nb.length;
  for (const [x0, y0, z] of nb) { const x = x0 - cx, y = y0 - cy; Sxx += x * x; Sxy += x * y; Syy += y * y; Sx += x; Sy += y; Sz += z; Sxz += x * z; Syz += y * z; }
  const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]], r = [Sxz, Syz, Sz];
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A); if (Math.abs(D) < 1e-9) return null;
  const col = (k) => A.map((row, i) => row.map((v, j) => (j === k ? r[i] : v)));
  const a = det(col(0)) / D, b = det(col(1)) / D, c = det(col(2)) / D;
  let ss = 0; for (const [x0, y0, z] of nb) { const e = a * (x0 - cx) + b * (y0 - cy) + c - z; ss += e * e; }
  return { a, b, rms: Math.sqrt(ss / n) };
}
function fitPitch(P, ring) {
  const G = P.filter((p) => p[3] === 2);
  const hag = (p) => { if (G.length < 10) return NaN; let r = 8, nb;
    do { nb = G.filter((g) => (g[0] - p[0]) ** 2 + (g[1] - p[1]) ** 2 < r * r); r *= 1.6; } while (nb.length < 5 && r < 40);
    return p[2] - median(nb.map((g) => g[2])); };
  const inner = (p) => pip(p, ring) && edgeDist(p, ring) >= 0.7;
  const area = Math.abs(ringArea(ring));
  const R = P.filter((p) => p[3] !== 2 && inner(p)).filter((p) => hag(p) > 2.0);
  const dens = R.length / area;
  if (R.length < 25) return { ok: false, reason: `Only ${R.length} lidar points on the roof.` };
  const rad = dens > 4 ? 1.6 : 2.2, slopes = [], asp = [];
  for (const p of R) {
    const nb = R.filter((q) => (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 < rad * rad); if (nb.length < 6) continue;
    const f = fitPlane(nb, p[0], p[1]); if (!f || f.rms > 0.15) continue;
    slopes.push(Math.atan(Math.hypot(f.a, f.b)) * 180 / Math.PI);
    asp.push((Math.atan2(-f.a, -f.b) * 180 / Math.PI + 360) % 360);
  }
  if (slopes.length < 20) return { ok: false, reason: "Roof points did not form clean planes." };
  const flat = slopes.map((s) => s < 5), flatShare = flat.filter(Boolean).length / slopes.length;
  const faces = [];
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  if (flatShare > 0.6) faces.push({ n: "flat", share: flatShare, deg: median(slopes.filter((s, i) => flat[i])) });
  else {
    const [, ang] = mainAxis(ring); const axis = ((90 - ang * 180 / Math.PI) % 90 + 90) % 90;
    for (let k = 0; k < 4; k++) {
      const c = (axis + 90 * k) % 360;
      const sel = slopes.filter((s, i) => !flat[i] && Math.abs(((asp[i] - c + 540) % 360) - 180) < 45);
      if (sel.length >= 8) faces.push({ n: names[Math.floor(((c + 22.5) % 360) / 45)], share: sel.length / slopes.length, deg: median(sel) });
    }
    if (flatShare > 0.1) faces.push({ n: "flat", share: flatShare, deg: median(slopes.filter((s, i) => flat[i])) });
  }
  const tot = faces.reduce((s, f) => s + f.share, 0);
  faces.forEach((f) => { f.share /= tot; f.rise = 12 * Math.tan(f.deg * Math.PI / 180); });
  return { ok: true, faces, points: R.length };
}

/* ---------- UI ---------- */
const state = { plan: 0, waste: 10, pitch: String(DEFAULT_PITCH), lidar: null, ring: null, geo: null };
const mult = (r) => Math.sqrt(1 + (r / 12) ** 2);
const fmt = (n) => Math.round(n).toLocaleString("en-US");
function slopedArea() {
  if (state.pitch === "lidar" && state.lidar?.ok) return state.lidar.faces.reduce((s, f) => s + state.plan * f.share * mult(f.rise), 0);
  return state.plan * mult(Number(state.pitch));
}
function render() {
  const sl = slopedArea(), sq = sl * (1 + state.waste / 100) / 100;
  $("r-sq").textContent = sq.toFixed(1);
  $("r-sqsub").textContent = state.waste ? `includes ${state.waste}% waste · ${(sl / 100).toFixed(1)} squares without waste` : "no waste added";
  $("r-sloped").textContent = fmt(sl); $("r-plan").textContent = fmt(state.plan);
  if (state.pitch === "lidar" && state.lidar?.ok) {
    const avg = state.lidar.faces.reduce((s, f) => s + f.share * f.rise, 0);
    $("r-pitch").textContent = avg.toFixed(1) + "/12"; $("r-pitchsrc").textContent = `pitch · lidar ${state.lidar.year || ""}`;
    $("r-faces").textContent = "By face: " + state.lidar.faces.map((f) => `${f.n} ${f.n === "flat" ? "" : f.rise.toFixed(1) + "/12 "}(${Math.round(f.share * 100)}%)`).join(" · ");
  } else {
    $("r-pitch").textContent = state.pitch + "/12";
    $("r-pitchsrc").textContent = state.pitch === String(DEFAULT_PITCH) && !state.userPitch ? "pitch · assumed" : "pitch · you picked";
    $("r-faces").textContent = state.lidar && !state.lidar.ok ? "Lidar: " + state.lidar.reason : "";
  }
  let pn;
  if (state.pitch === "lidar" && state.lidar?.ok) pn = `Pitch measured per roof face from USGS lidar flown in ${state.lidar.year} (about ±1/12; newer roofs or additions will not show).`;
  else if (state.userPitch) pn = `Pitch ${state.pitch}/12 picked by you.`;
  else pn = `Pitch is assumed at ${DEFAULT_PITCH}/12 (typical, not measured). Pick the real pitch or tap “Measure with lidar”.`;
  $("r-note").className = "note" + (state.noteGood && (state.userPitch || state.pitch === "lidar") ? " good" : "");
  $("r-note").textContent = (state.notes || []).concat(pn).join(" ");
  document.querySelectorAll("#waste button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === state.waste));
  document.querySelectorAll("#pitch button").forEach((b) => b.classList.toggle("on", b.dataset.v === state.pitch));
}
function chips() {
  $("waste").innerHTML = ""; [0, 10, 15].forEach((v) => { const b = document.createElement("button"); b.textContent = v ? v + "%" : "None"; b.dataset.v = v;
    b.onclick = () => { state.waste = v; render(); }; $("waste").appendChild(b); });
  $("pitch").innerHTML = "";
  const lb = document.createElement("button"); lb.dataset.v = "lidar"; lb.textContent = state.lidar?.ok ? "Lidar" : "Measure with lidar";
  lb.onclick = async () => {
    if (state.lidar?.ok) { state.pitch = "lidar"; render(); return; }
    lb.disabled = true; lb.textContent = "Reading lidar…";
    try {
      const proj = projector(state.geo.lon, state.geo.lat);
      state.lidar = await lidarPitch(state.ring, proj, (b) => { lb.textContent = `Reading lidar… ${(b / 1048576).toFixed(1)} MB`; });
    } catch (e) { state.lidar = { ok: false, reason: "lidar failed: " + e.message }; }
    if (state.lidar.ok) { state.pitch = "lidar"; addSource(`USGS 3DEP lidar point cloud ${state.lidar.dataset} (${state.lidar.kb} KB read)`, "https://registry.opendata.aws/usgs-lidar/"); }
    chips(); render();
  };
  $("pitch").appendChild(lb);
  for (let p = 3; p <= 12; p++) { const b = document.createElement("button"); b.textContent = p + "/12"; b.dataset.v = String(p);
    b.onclick = () => { state.pitch = String(p); state.userPitch = true; render(); }; $("pitch").appendChild(b); }
}
function addSource(text, href) { const li = document.createElement("li"); if (href) { const a = document.createElement("a"); a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text; li.appendChild(a); } else li.textContent = text; $("r-src").appendChild(li); }
function drawOutline(ringM, parcelM) {
  const all = parcelM ? ringM.concat(parcelM) : ringM; const [x0, y0, x1, y1] = bbox(ringM);
  const W = 360, H = 260, pad = 34, s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad - 20) / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2, X = (x) => ox + (x - x0) * s, Y = (y) => pad + (y1 - y) * s;
  const pts = (r) => r.map(([x, y]) => `${X(x).toFixed(1)},${Y(y).toFixed(1)}`).join(" ");
  const ccw = ringArea(ringM) > 0; let labels = "";
  for (let i = 0; i < ringM.length - 1; i++) {
    const a = ringM[i], b = ringM[i + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]) * 3.28084; if (L < 10) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy), nx = (ccw ? dy : -dy) / l, ny = (ccw ? -dx : dx) / l, off = 13 / s;
    labels += `<text x="${X((a[0] + b[0]) / 2 + nx * off).toFixed(1)}" y="${Y((a[1] + b[1]) / 2 + ny * off).toFixed(1)}">${Math.round(L)} ft</text>`;
  }
  const ft20 = 20 / 3.28084 * s;
  $("r-svg").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Roof outline">
    <style>text{font:11px -apple-system,system-ui,sans-serif;fill:currentColor;opacity:.7;text-anchor:middle;dominant-baseline:middle}</style>
    ${parcelM ? `<polygon points="${pts(parcelM)}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-dasharray="4 4"/>` : ""}
    <polygon points="${pts(ringM)}" fill="var(--accent)" fill-opacity=".14" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>
    ${labels}
    <line x1="14" y1="${H - 14}" x2="${14 + ft20}" y2="${H - 14}" stroke="currentColor" stroke-width="2"/>
    <text x="${14 + ft20 / 2}" y="${H - 26}">20 ft</text>
    <text x="${W - 14}" y="16" style="font-weight:600;opacity:.9;text-anchor:end">N ↑</text>
  </svg>`;
}

async function run() {
  const addr = $("addr").value.trim(); if (!addr) return;
  $("go").disabled = true; statusUl.innerHTML = ""; $("result").style.display = "none"; $("r-src").innerHTML = "";
  Object.assign(state, { lidar: null, pitch: String(DEFAULT_PITCH), userPitch: false });
  history.replaceState(null, "", "?a=" + encodeURIComponent(addr));
  try {
    const pa = parseAddr(addr);
    let s = step("Finding the address");
    let geo = null; try { geo = await geocode(addr); s.ok(`Address found (${geo.src})`); } catch (e) { s.bad("Geocoder could not find it; trying county parcels"); }
    s = step("Looking up the county parcel");
    const parcel = await parcelLookup(pa, geo);
    if (parcel) s.ok(`Parcel ${parcel.apn} found (${parcel.county})`); else s.bad("No parcel match (only San Diego and Riverside counties are wired in)");
    let ref = geo;
    if (parcel) { const c = parcel.ring.slice(0, -1); ref = { lon: c.reduce((a, p) => a + p[0], 0) / c.length, lat: c.reduce((a, p) => a + p[1], 0) / c.length, src: geo?.src }; }
    if (!ref) throw new Error("Could not locate this address.");
    const proj = projector(ref.lon, ref.lat);
    let radius = 60; if (parcel) { const b = bbox(parcel.ring.map(proj.fwd)); radius = Math.max(40, Math.hypot(b[2] - b[0], b[3] - b[1]) / 2 + 15); }
    const bb = [proj.inv([-radius, -radius]), proj.inv([radius, radius])]; const bboxLL = [bb[0][0], bb[0][1], bb[1][0], bb[1][1]];
    s = step("Finding the roof outline");
    const [osm, ov] = await Promise.allSettled([osmBuildings(ref.lon, ref.lat, radius), overtureBuildings(bboxLL)]);
    const cands = [...(osm.status === "fulfilled" ? osm.value : []), ...(ov.status === "fulfilled" ? ov.value : [])];
    const pick = choose(cands, parcel, ref, pa, proj);
    if (!pick) { s.bad("No building outline found here"); throw new Error("No building outline found near this address in OpenStreetMap or Overture."); }
    s.ok(`Outline found (${pick.source})`);
    const ringM = pick.ring.map(proj.fwd);
    state.plan = Math.abs(ringArea(ringM)) * SQFT; state.ring = pick.ring; state.geo = ref;
    $("r-addr").textContent = parcel ? `${parcel.situs} · APN ${parcel.apn}` : addr;
    drawOutline(ringM, parcel ? parcel.ring.map(proj.fwd) : null);
    const notes = [];
    if (pick.conf === "high") notes.push(`Outline: ${pick.why}.`); else notes.push(`Check this outline: ${pick.why}.`);
    if (pick.edge) notes.push("The outline touches a map tile edge and may be cut short.");
    if (osm.status !== "fulfilled") notes.push("The live OpenStreetMap server was busy, so outlines came from Overture (which includes OpenStreetMap outlines).");
    state.notes = notes; state.noteGood = pick.conf === "high" && !pick.edge;
    if (geo) addSource(`Geocoding: ${geo.src}`, geo.src.startsWith("Nominatim") ? "https://nominatim.openstreetmap.org/" : "https://photon.komoot.io/");
    if (parcel) addSource(`Parcel: ${parcel.label}, APN ${parcel.apn}`, parcel.url);
    addSource(`Outline: ${pick.source}${pick.id ? " " + String(pick.id).slice(0, 12) : ""}`, pick.source === "OpenStreetMap" ? "https://www.openstreetmap.org/" + pick.id : "https://docs.overturemaps.org/guides/buildings/");
    chips(); render(); $("result").style.display = "block";
    window.__result = { plan: state.plan, source: pick.source, conf: pick.conf, why: pick.why, apn: parcel?.apn, osm: osm.status, overture: ov.status, geo: geo?.src };
  } catch (e) {
    step(e.message).bad(); window.__result = { error: e.message };
  } finally { $("go").disabled = false; }
}
$("go").onclick = run;
$("addr").addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
const qa = new URLSearchParams(location.search).get("a");
if (qa) { $("addr").value = qa; run(); }
