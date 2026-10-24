const $ = (id) => document.getElementById(id);
const MAX_ROWS = 3000;
const reported = {};
let path = [];
let ws;

function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== "object") target[k] = {};
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

const isPositionTraffic = (e) => e.topic === "req" || e.topic === "data";

function addRow(e) {
  const row = document.createElement("div");
  row.className = "row " + e.dir;
  row.dataset.pos = isPositionTraffic(e) ? "1" : "";
  const time = new Date(e.t).toLocaleTimeString([], { hour12: false }) +
    "." + String(e.t % 1000).padStart(3, "0");
  const arrow = { in: "◀", out: "▶", info: "•" }[e.dir];
  const compact = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
  row.innerHTML = `<span class="time"></span> <span class="dir">${arrow}</span> <span class="topic"></span> <span class="body"></span>`;
  row.querySelector(".time").textContent = time;
  row.querySelector(".topic").textContent = e.topic;
  row.querySelector(".body").textContent = compact;
  row.onclick = () => {
    row.classList.toggle("open");
    row.querySelector(".body").textContent = row.classList.contains("open") && typeof e.payload !== "string"
      ? "\n" + JSON.stringify(e.payload, null, 2) : compact;
  };
  applyFilter(row);
  const log = $("log");
  log.appendChild(row);
  while (log.childElementCount > MAX_ROWS) log.firstChild.remove();
  if ($("follow").checked) log.scrollTop = log.scrollHeight;
}

function applyFilter(row) {
  const text = $("filter").value.toLowerCase();
  const hide = ($("hidepos").checked && row.dataset.pos) ||
    (text && !row.textContent.toLowerCase().includes(text));
  row.style.display = hide ? "none" : "";
}
function refilter() {
  for (const row of $("log").children) applyFilter(row);
}

// Position replies come in two shapes:
//   coords: [{xyt: [x, y, theta]}]   or   coords: [x, y, theta]
function positionFrom(payload) {
  const entry = payload?.data?.[0];
  const coords = entry?.coords;
  if (!Array.isArray(coords) || !coords.length) return null;
  const xyt = typeof coords[0] === "number" ? coords : coords[0]?.xyt;
  if (!Array.isArray(xyt) || xyt.length < 3) return null;
  return { x: xyt[0], y: xyt[1], theta: xyt[2] };
}

function handle(e) {
  addRow(e);
  if (e.dir === "info") {
    if (e.payload.startsWith("connected")) $("robot").textContent = "connected";
    else if (e.payload.startsWith("disconnected")) $("robot").textContent = "disconnected";
    return;
  }
  if (e.dir !== "in") return;
  const rep = e.payload?.state?.reported;
  if (rep) {
    merge(reported, rep);
    updateStatus();
  }
  if (e.topic === "data") {
    const p = positionFrom(e.payload);
    if (p) {
      const last = path[path.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y || last.theta !== p.theta) path.push(p);
      $("pos").textContent = `x=${p.x.toFixed(2)} m, y=${p.y.toFixed(2)} m, θ=${(p.theta * 180 / Math.PI).toFixed(0)}°`;
      drawMap();
    } else {
      $("pos").textContent = "no fix";
    }
  }
}

function updateStatus() {
  const m = reported.cleanMissionStatus || {};
  $("phase").textContent = [m.cycle, m.phase].filter(Boolean).join(" / ") || "?";
  if (reported.batPct != null) $("bat").textContent = reported.batPct + "%";
  if (reported.bin) $("bin").textContent = reported.bin.full ? "full" : "ok";
  if (m.mssnM != null) $("mission").textContent = `${m.mssnM} min, ${m.sqft ?? 0} ft²` + (m.error ? `, error ${m.error}` : "");
}

function drawMap() {
  const c = $("map");
  const ctx = c.getContext("2d");
  const W = c.width, pad = 40;
  ctx.clearRect(0, 0, W, W);
  const pts = path.concat([{ x: 0, y: 0 }]);
  let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const span = Math.max(maxX - minX, maxY - minY, 2);
  const scale = (W - 2 * pad) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  // Robot frame: x forward from the dock, y to the left. Draw y up.
  const tx = (p) => W / 2 + (p.x - cx) * scale;
  const ty = (p) => W / 2 - (p.y - cy) * scale;

  // 1 m grid
  ctx.strokeStyle = "#8883";
  ctx.lineWidth = 1;
  for (let g = Math.floor(cx - span); g <= cx + span; g++) {
    ctx.beginPath(); ctx.moveTo(tx({ x: g }), 0); ctx.lineTo(tx({ x: g }), W); ctx.stroke();
  }
  for (let g = Math.floor(cy - span); g <= cy + span; g++) {
    ctx.beginPath(); ctx.moveTo(0, ty({ y: g })); ctx.lineTo(W, ty({ y: g })); ctx.stroke();
  }

  // Swept area (i3 is ~34 cm wide) then the center line.
  ctx.lineCap = ctx.lineJoin = "round";
  for (const [style, width] of [["#3a86ff33", 0.34 * scale], ["#3a86ff", 2]]) {
    ctx.strokeStyle = style; ctx.lineWidth = width;
    ctx.beginPath();
    path.forEach((p, i) => (i ? ctx.lineTo(tx(p), ty(p)) : ctx.moveTo(tx(p), ty(p))));
    ctx.stroke();
  }

  // Dock
  ctx.fillStyle = "#2a8";
  ctx.fillRect(tx({ x: 0 }) - 6, ty({ y: 0 }) - 6, 12, 12);

  // Robot
  const r = path[path.length - 1];
  if (r) {
    ctx.fillStyle = "#d70";
    ctx.beginPath(); ctx.arc(tx(r), ty(r), 0.17 * scale, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(tx(r), ty(r));
    ctx.lineTo(tx(r) + Math.cos(r.theta) * 0.17 * scale, ty(r) - Math.sin(r.theta) * 0.17 * scale);
    ctx.stroke();
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}`);
  ws.onopen = () => ($("ws").textContent = "connected");
  ws.onclose = () => {
    $("ws").textContent = "disconnected";
    setTimeout(connect, 2000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "history") {
      $("log").textContent = "";
      path = [];
      msg.entries.forEach(handle);
      $("poll").value = String(msg.positionPollMs);
    } else if (msg.type === "msg") {
      handle(msg.entry);
    } else if (msg.type === "poll") {
      $("poll").value = String(msg.positionPollMs);
    }
  };
}

const send = (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj));
document.querySelectorAll("[data-cmd]").forEach((b) =>
  (b.onclick = () => send({ type: "cmd", command: b.dataset.cmd })));
$("poll").onchange = () => send({ type: "poll", ms: Number($("poll").value) });
$("filter").oninput = refilter;
$("hidepos").onchange = refilter;
$("clearlog").onclick = () => ($("log").textContent = "");
$("clearmap").onclick = () => { path = []; drawMap(); };
$("psend").onclick = () => {
  let payload = $("ppayload").value;
  try { payload = JSON.parse(payload); } catch {}
  if (payload && typeof payload === "object" && "time" in payload) payload.time = Math.floor(Date.now() / 1000);
  send({ type: "publish", topic: $("ptopic").value, payload });
};

connect();
drawMap();
$("profiler").onclick = () => {
  const url = new URL("/profile.json", location.href).href;
  window.open(`https://profiler.firefox.com/from-url/${encodeURIComponent(url)}/`);
};
