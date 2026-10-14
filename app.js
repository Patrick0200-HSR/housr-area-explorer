// Housr Area Explorer
// Search a UK postcode (or pick a property) and see what's within walking distance.
// Data: postcodes.io (postcode -> location) and OpenStreetMap via the Overpass API (nearby places).

const SEARCH_RADIUS_M = 1500;   // how far to look for most places
const UNI_RADIUS_M = 3000;      // universities can be a bit further away
const WALK_M_PER_MIN = 80;      // ~4.8 km/h walking pace
const ROUTE_FACTOR = 1.3;       // streets aren't straight lines, so pad the distance
const MAX_PER_CATEGORY = 5;

const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Each category: how it looks, which OpenStreetMap tags it matches,
// and the walk (in minutes) we'd call "good" for the area score.
const CATEGORIES = [
  { id: "uni",       label: "Universities", one: "university", many: "unis",
    emoji: "🎓", color: "#6b46c1", goodMins: 20,
    query: (r) => `nwr(around:${r.uni},LAT,LON)["amenity"~"^(university|college)$"]["name"];`,
    match: (t) => /^(university|college)$/.test(t.amenity) },
  { id: "food",      label: "Supermarkets", one: "supermarket", many: "supermarkets",
    emoji: "🛒", color: "#2f855a", goodMins: 10,
    query: (r) => `nwr(around:${r.base},LAT,LON)["shop"="supermarket"];`,
    match: (t) => t.shop === "supermarket" },
  { id: "transport", label: "Transport",    one: "bus or train stop", many: "bus & train stops",
    emoji: "🚌", color: "#2b6cb0", goodMins: 5,
    query: (r) => `node(around:${r.base},LAT,LON)["highway"="bus_stop"];nwr(around:${r.base},LAT,LON)["railway"~"^(station|tram_stop|halt)$"];`,
    match: (t) => t.highway === "bus_stop" || /^(station|tram_stop|halt)$/.test(t.railway) },
  { id: "gym",       label: "Gyms",         one: "gym", many: "gyms",
    emoji: "🏋️", color: "#c05621", goodMins: 15,
    query: (r) => `nwr(around:${r.base},LAT,LON)["leisure"="fitness_centre"];`,
    match: (t) => t.leisure === "fitness_centre" },
  { id: "cafe",      label: "Cafés",        one: "café", many: "cafés",
    emoji: "☕", color: "#8b5e3c", goodMins: 10,
    query: (r) => `nwr(around:${r.base},LAT,LON)["amenity"="cafe"];`,
    match: (t) => t.amenity === "cafe" },
  { id: "pub",       label: "Pubs & bars",  one: "pub or bar", many: "pubs & bars",
    emoji: "🍺", color: "#b7791f", goodMins: 10,
    query: (r) => `nwr(around:${r.base},LAT,LON)["amenity"~"^(pub|bar)$"];`,
    match: (t) => /^(pub|bar)$/.test(t.amenity) },
];

// ---------- State ----------
const state = {
  home: null,                        // { lat, lon, postcode, area }
  places: {},                        // categoryId -> [{ name, lat, lon, distance, mins }]
  visible: new Set(CATEGORIES.map((c) => c.id)),
  layers: {},                        // categoryId -> Leaflet layer group
  markers: new Map(),                // place key -> Leaflet marker
};

// ---------- Map setup ----------
const map = L.map("map", { zoomControl: true }).setView([53.0, -1.8], 6);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);

const homeIcon = L.divIcon({
  className: "home-marker",
  html: '<img src="assets/housr-icon-green.svg" alt="Your house">',
  iconSize: [44, 44],
  iconAnchor: [22, 22],
});
let homeMarker = null;
let radiusCircle = null;

CATEGORIES.forEach((c) => { state.layers[c.id] = L.layerGroup().addTo(map); });

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);

function distanceMetres(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkMinutes(metres) {
  return Math.max(1, Math.round((metres * ROUTE_FACTOR) / WALK_M_PER_MIN));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function showStatus(text, isError = false) {
  const el = $("map-status");
  el.textContent = text;
  el.classList.toggle("error", isError);
  el.hidden = !text;
}

function toast(text) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

// ---------- Data fetching ----------
async function lookupPostcode(postcode) {
  const clean = postcode.replace(/\s+/g, "").toUpperCase();
  const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(clean)}`);
  if (!res.ok) throw new Error("We couldn't find that postcode. Check it and try again.");
  const { result } = await res.json();
  return {
    lat: result.latitude,
    lon: result.longitude,
    postcode: result.postcode,
    area: [result.admin_ward, result.admin_district].filter(Boolean).join(", "),
  };
}

// Load nearby places, trying the fastest sources first:
// 1. a pre-saved file (for the example properties – always instant)
// 2. this browser's cache (for postcodes searched before)
// 3. the live OpenStreetMap service
async function getNearby(home) {
  const slug = home.postcode.replace(/\s+/g, "").toUpperCase();

  try {
    const res = await fetch(`data/${slug}.json`);
    if (res.ok) return await res.json();
  } catch { /* no saved file – carry on */ }

  const cacheKey = `nearby:${slug}`;
  try {
    const cached = JSON.parse(localStorage.getItem(cacheKey));
    if (cached && Date.now() - cached.savedAt < 7 * 24 * 60 * 60 * 1000) return cached.elements;
  } catch { /* storage unavailable – carry on */ }

  const elements = await fetchNearby(home.lat, home.lon);
  try {
    localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), elements }));
  } catch { /* storage full or blocked – fine */ }
  return elements;
}

async function fetchNearby(lat, lon) {
  const radii = { base: SEARCH_RADIUS_M, uni: UNI_RADIUS_M };
  const body = `[out:json][timeout:25];(${CATEGORIES.map((c) => c.query(radii)).join("")});out center tags;`
    .replaceAll("LAT", lat).replaceAll("LON", lon);

  // The free Overpass servers are sometimes busy, so retry a few times,
  // alternating between servers and waiting a little longer each time.
  const ATTEMPTS = 4;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const url = OVERPASS_URLS[attempt % OVERPASS_URLS.length];
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(body),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`Map data service returned ${res.status}`);
      return (await res.json()).elements;
    } catch (err) {
      console.warn(`Overpass attempt ${attempt + 1} failed`, err);
      if (attempt === ATTEMPTS - 1) break;
      showStatus("Map data is busy – retrying…");
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw new Error("The map data service is busy right now. Please try again in a moment.");
}

// Turn raw OpenStreetMap results into tidy, sorted lists per category.
function groupPlaces(elements, home) {
  const grouped = Object.fromEntries(CATEGORIES.map((c) => [c.id, []]));
  const seen = new Set();

  for (const el of elements) {
    const tags = el.tags || {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null) continue;

    const cat = CATEGORIES.find((c) => c.match(tags));
    if (!cat) continue;

    const name = tags.name || (cat.id === "transport" ? "Bus stop" : `Unnamed ${cat.label.toLowerCase()}`);
    // Bus stops come in pairs (one each side of the road) – keep just one per name.
    const dedupeKey = `${cat.id}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const distance = distanceMetres(home.lat, home.lon, lat, lon);
    grouped[cat.id].push({ key: `${el.type}/${el.id}`, name, lat, lon, distance, mins: walkMinutes(distance), cat });
  }

  for (const id in grouped) grouped[id].sort((a, b) => a.distance - b.distance);
  return grouped;
}

// ---------- Area score ----------
// Each category scores 1 if the nearest one is within a "good" walk,
// 0.5 if within double that, otherwise 0. Scaled to a score out of 10.
function computeScore(places) {
  let points = 0;
  const highlights = [];

  for (const c of CATEGORIES) {
    const list = places[c.id];
    const nearest = list[0];
    if (!nearest) { highlights.push(`${c.emoji} No ${c.many} nearby`); continue; }
    if (nearest.mins <= c.goodMins) points += 1;
    else if (nearest.mins <= c.goodMins * 2) points += 0.5;

    const within = list.filter((p) => p.mins <= c.goodMins).length;
    if (within > 1 && c.id !== "uni") {
      highlights.push(`${c.emoji} ${within} ${c.many} within ${c.goodMins} min`);
    } else {
      highlights.push(`${c.emoji} Nearest ${c.one}: ${nearest.mins} min`);
    }
  }

  return { score: Math.round((points / CATEGORIES.length) * 100) / 10, highlights };
}

// ---------- Rendering ----------
function renderChips() {
  $("chips").innerHTML = CATEGORIES.map((c) => `
    <button type="button" class="chip" data-id="${c.id}" aria-pressed="${state.visible.has(c.id)}">
      <span class="dot" style="background:${c.color}"></span>${c.emoji} ${c.label}
    </button>`).join("");
}

function renderMarkers() {
  state.markers.clear();
  for (const c of CATEGORIES) {
    const layer = state.layers[c.id];
    layer.clearLayers();
    for (const p of (state.places[c.id] || []).slice(0, MAX_PER_CATEGORY)) {
      const icon = L.divIcon({
        className: "",
        html: `<div class="poi-marker" style="background:${c.color}">${c.emoji}</div>`,
        iconSize: [30, 30], iconAnchor: [15, 15],
      });
      const marker = L.marker([p.lat, p.lon], { icon })
        .bindPopup(`<strong>${escapeHtml(p.name)}</strong><br>${c.label} · ${formatDistance(p.distance)} · ~${p.mins} min walk`);
      layer.addLayer(marker);
      state.markers.set(p.key, marker);
    }
    if (state.visible.has(c.id)) layer.addTo(map); else map.removeLayer(layer);
  }
}

function renderResults() {
  const html = CATEGORIES.filter((c) => state.visible.has(c.id)).map((c) => {
    const list = (state.places[c.id] || []).slice(0, MAX_PER_CATEGORY);
    const total = (state.places[c.id] || []).length;
    const items = list.length
      ? list.map((p) => `
          <button type="button" class="place" data-key="${p.key}">
            <span class="place-name">${escapeHtml(p.name)}</span>
            <span class="place-meta"><strong>~${p.mins} min</strong>${formatDistance(p.distance)}</span>
          </button>`).join("")
      : `<p class="none">None found within walking distance.</p>`;
    return `<div class="group"><h3>${c.emoji} ${c.label}<span class="count">${total} found</span></h3>${items}</div>`;
  }).join("");
  $("results").innerHTML = html || `<p class="none">Turn on a category above to see places.</p>`;
}

function renderScore() {
  const { score, highlights } = computeScore(state.places);
  $("score-value").textContent = score.toFixed(1).replace(/\.0$/, "");
  $("score-highlights").innerHTML = highlights.map((h) => `<li>${escapeHtml(h)}</li>`).join("");
  $("score-section").hidden = false;
}

function fitToResults() {
  const points = [[state.home.lat, state.home.lon]];
  for (const c of CATEGORIES) {
    if (!state.visible.has(c.id) || c.id === "uni") continue;
    for (const p of (state.places[c.id] || []).slice(0, MAX_PER_CATEGORY)) points.push([p.lat, p.lon]);
  }
  map.fitBounds(L.latLngBounds(points).pad(0.15), { maxZoom: 16 });
}

// ---------- Main flow ----------
let currentRun = 0;   // ignore results from an older search if a newer one has started

async function explore(postcode, displayName) {
  const run = ++currentRun;
  showStatus("Finding the area…");
  try {
    const home = await lookupPostcode(postcode);
    if (run !== currentRun) return;
    state.home = home;

    if (homeMarker) homeMarker.remove();
    if (radiusCircle) radiusCircle.remove();
    homeMarker = L.marker([home.lat, home.lon], { icon: homeIcon, zIndexOffset: 1000 })
      .bindPopup(`<strong>${escapeHtml(displayName || home.postcode)}</strong>`).addTo(map);
    radiusCircle = L.circle([home.lat, home.lon], {
      radius: WALK_M_PER_MIN * 15 / ROUTE_FACTOR,   // roughly a 15-minute walk
      color: "#004225", weight: 1.5, fillColor: "#004225", fillOpacity: 0.05, dashArray: "6 6",
    }).addTo(map);
    map.setView([home.lat, home.lon], 15);

    $("location-name").textContent = displayName || home.postcode;
    $("location-sub").textContent = displayName ? `${home.postcode} · ${home.area}` : home.area;
    $("location-section").hidden = false;
    $("postcode").value = home.postcode;

    const url = new URL(location.href);
    url.searchParams.set("postcode", home.postcode);
    history.replaceState(null, "", url);

    showStatus("Looking for places nearby…");
    const elements = await getNearby(home);
    if (run !== currentRun) return;
    state.places = groupPlaces(elements, home);

    renderMarkers();
    renderResults();
    renderScore();
    fitToResults();
    showStatus("");
  } catch (err) {
    if (run !== currentRun) return;
    console.error(err);
    showStatus(err.message || "Something went wrong. Please try again.", true);
    setTimeout(() => showStatus(""), 4000);
  }
}

// ---------- Events ----------
$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("property-select").value = "";
  explore($("postcode").value.trim());
});

$("property-select").addEventListener("change", (e) => {
  const opt = e.target.selectedOptions[0];
  if (opt.value) explore(opt.value, opt.textContent);
});

$("chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const id = chip.dataset.id;
  state.visible.has(id) ? state.visible.delete(id) : state.visible.add(id);
  renderChips();
  if (state.home) { renderMarkers(); renderResults(); }
});

$("results").addEventListener("click", (e) => {
  const btn = e.target.closest(".place");
  if (!btn) return;
  document.querySelectorAll(".place.active").forEach((el) => el.classList.remove("active"));
  btn.classList.add("active");
  const marker = state.markers.get(btn.dataset.key);
  if (marker) {
    map.setView(marker.getLatLng(), Math.max(map.getZoom(), 16));
    marker.openPopup();
    if (window.innerWidth <= 800) $("map").scrollIntoView({ behavior: "smooth" });
  }
});

$("copy-link").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(location.href);
    toast("Link copied – share it with your housemates!");
  } catch {
    toast("Copy this page's address to share it.");
  }
});

// ---------- Start up ----------
async function init() {
  renderChips();

  try {
    const properties = await (await fetch("properties.json")).json();
    $("property-select").insertAdjacentHTML("beforeend",
      properties.map((p) => `<option value="${escapeHtml(p.postcode)}">${escapeHtml(p.name)}</option>`).join(""));
  } catch (err) {
    console.warn("Couldn't load properties.json", err);
  }

  // Support shareable links like ?postcode=NG7%202RD
  const fromUrl = new URLSearchParams(location.search).get("postcode");
  if (fromUrl) explore(fromUrl);
}

init();
