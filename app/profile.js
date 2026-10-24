// Converts the recorded MQTT traffic into a Firefox Profiler processed
// profile (format version 76), with markers for packets, state changes and
// robot phases, and marker graph tracks for numeric values.

const { errors: ERROR_MESSAGES } = require("./robot-strings.json");

const PHASES = {
  charge: "Charging",
  new: "New mission",
  run: "Cleaning",
  resume: "Cleaning",
  hmMidMsn: "Returning to dock (mid-mission)",
  recharge: "Recharging",
  stuck: "Stuck",
  hmUsrDock: "Returning to dock (user)",
  dock: "Docking",
  dockend: "Docking (mission end)",
  cancelled: "Cancelled",
  stop: "Stopped",
  pause: "Paused",
  hmPostMsn: "Returning to dock (mission done)",
  evac: "Emptying bin",
  chargingerror: "Base unplugged",
  spot: "Spot cleaning",
  completed: "Mission complete",
};

// Human-readable labels for numeric values worth charting. These are best
// guesses from field names; the robot does not document them.
const LABELS = {
  batPct: "Battery (%)",
  "signal.rssi": "Wi-Fi RSSI (dBm)",
  "signal.snr": "Wi-Fi SNR (dB)",
  "signal.noise": "Wi-Fi noise (dBm)",
  "cleanMissionStatus.mssnM": "Mission time (min)",
  "cleanMissionStatus.sqft": "Area cleaned (ft²)",
  "cleanMissionStatus.rechrgM": "Recharge time left (min)",
  "cleanMissionStatus.expireM": "Mission expires in (min)",
  "cleanMissionStatus.nMssn": "Mission count",
  "dock.state": "Dock state",
  "bbrun.hr": "Lifetime run time (h)",
  "bbrun.min": "Lifetime run time (+min)",
  "bbrun.sqft": "Lifetime area (×100 ft²?)",
  "bbrun.nStuck": "Lifetime stuck events",
  "bbrun.nEvacs": "Lifetime bin evacuations",
  "bbrun.nCliffsF": "Lifetime front cliff detections",
  "bbrun.nPanics": "Lifetime panics",
  "bbrun.nPicks": "Lifetime pick-ups",
  "bbrun.nMBStll": "Lifetime main brush stalls",
  "bbrun.nWStll": "Lifetime wheel stalls",
  "bbchg3.hOnDock": "Lifetime hours on dock",
  "bbchg3.avgMin": "Average charge? (min)",
  "bbchg3.estCap": "Estimated battery capacity (mAh?)",
  "bbchg.nChgOk": "Successful charges",
  "bbsys.hr": "Lifetime powered time (h)",
  "bbswitch.nBumper": "Lifetime bumper hits",
  "bbmssn.nMssn": "Lifetime missions",
  "bbmssn.nMssnOk": "Lifetime missions OK",
  "bbmssn.nMssnF": "Lifetime missions failed",
  "bbmssn.nMssnC": "Lifetime missions cancelled",
  "batInfo.cCount": "Battery charge cycles",
};
// Names for the top-level keys of the reported state.
const GROUP_NAMES = {
  batPct: "Battery",
  bbchg: "Charging stats",
  bbchg3: "Charging stats (3)",
  bbmssn: "Mission stats",
  bbnav: "Navigation stats",
  bbpause: "Pause stats",
  bbrstinfo: "Reset stats",
  bbrun: "Run stats",
  bbswitch: "Button & bumper counts",
  bbsys: "System stats",
  bin: "Bin",
  cleanMissionStatus: "Mission status",
  connected: "Cloud connected",
  dock: "Dock info",
  lastDisconnect: "Last disconnect",
  netinfo: "Network info",
  signal: "Wi-Fi signal",
  wifistat: "Wi-Fi status",
  wlcfg: "Wi-Fi config",
};

// Lifetime counters: shown as "+N" duration markers between two reports.
const COUNTERS = {
  "bbswitch.nBumper": "Bumper hits",
  "bbswitch.nDrops": "Wheel drops",
  "bbswitch.nDock": "Home button presses",
  "bbswitch.nSpot": "Spot button presses",
  "bbswitch.nClean": "Clean button presses",
  "bbrun.nStuck": "Stuck events",
  "bbrun.nEvacs": "Bin evacuations",
  "bbrun.nPicks": "Pick-ups",
  "bbrun.nPanics": "Panics",
  "bbrun.nCliffsF": "Front cliff detections",
  "bbrun.nCliffsR": "Rear cliff detections",
  "bbrun.nMBStll": "Main brush stalls",
  "bbrun.nWStll": "Wheel stalls",
  "bbrun.nCBump": "nCBump (?)",
  "bbrun.nScrubs": "Scrubs (?)",
  "bbrun.nOvertemps": "Overheats",
  "bbrun.nOpticalDD": "Optical dirt detections",
  "bbrun.nPiezoDD": "Piezo dirt detections",
  "bbchg.nChgOk": "Successful charges",
  "bbchg.nChgErr": "Charge errors",
  "bbchg.nLithF": "Lithium charge failures (?)",
  "bbchg.nChatters": "Charge contact chatters (?)",
  "bbchg.nKnockoffs": "Knocked off dock (?)",
  "bbchg3.nAvail": "nAvail (?)",
  "bbmssn.nMssn": "Missions",
  "bbmssn.nMssnOk": "Missions completed",
  "bbmssn.nMssnC": "Missions cancelled",
  "bbmssn.nMssnF": "Missions failed",
  "batInfo.cCount": "Battery charge cycles",
};
// Lifetime durations, in minutes, built from hour and minute fields.
const TIME_COUNTERS = {
  "bbrun.time": { name: "Run time", hr: "bbrun.hr", min: "bbrun.min" },
  "bbsys.time": { name: "Powered time", hr: "bbsys.hr", min: "bbsys.min" },
  "bbchg3.time": { name: "Time on dock", hr: "bbchg3.hOnDock" },
};
const TIME_FIELDS = new Set(
  Object.values(TIME_COUNTERS).flatMap((c) => [c.hr, c.min].filter(Boolean))
);
const isCounter = (path) => path in COUNTERS || /^bb\w+\.n[A-Z]\w*$/.test(path);
const formatMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);

// Values shown as graph tracks.
const CHARTED = new Set(["batPct", "signal.rssi", "signal.noise", "signal.snr", "dock.state"]);

const CATEGORIES = [
  { name: "Other", color: "grey", subcategories: ["Other"] },
  { name: "Packets", color: "lightblue", subcategories: ["Other"] },
  { name: "State", color: "purple", subcategories: ["Other"] },
  { name: "Activity", color: "blue", subcategories: ["Other"] },
  // Only used by samples, to color the activity graph.
  { name: "Charging", color: "green", subcategories: ["Other"] },
  { name: "Cleaning", color: "blue", subcategories: ["Other"] },
  { name: "Returning", color: "orange", subcategories: ["Other"] },
  { name: "Stuck", color: "red", subcategories: ["Other"] },
  // Transparent, so the activity graph looks empty.
  { name: "Idle", color: "transparent", subcategories: ["Other"] },
];
const CAT = Object.fromEntries(CATEGORIES.map((c, i) => [c.name, i]));

// Inferred from the sequence seen around bin emptying: 302 → 303 → 301 → 300.
const DOCK_STATES = {
  300: "off dock",
  // Also reported with the battery at 100%: on the charger, not necessarily charging.
  301: "on dock",
  302: "emptying bin",
  303: "emptying bin (finishing)",
};

const MID_MISSION_RETURN = "Returning to dock (mid-mission)";

// hmMidMsn means "going home mid-mission", to recharge or to empty the bin.
// The robot also reports it for a few seconds on the dock after emptying.
function phaseLabel(phase, state) {
  if (phase === "hmMidMsn") {
    if (state["dock.state"] !== undefined && state["dock.state"] !== 300) return "On dock (mid-mission)";
    return MID_MISSION_RETURN;
  }
  // "charge" is reported whenever the robot sits on the dock, even when full.
  if (phase === "charge" && state.batPct === 100) return "Docked (battery full)";
  return PHASES[phase] || phase;
}

function phaseCategory(phase) {
  if (phase === "charge" || phase === "evac") return CAT.Charging;
  if (phase === "run" || phase === "resume" || phase === "new" || phase === "spot") return CAT.Cleaning;
  if (phase.startsWith("hm") || phase.startsWith("dock")) return CAT.Returning;
  if (phase === "stuck" || phase === "chargingerror") return CAT.Stuck;
  return CAT.Other;
}

const MARKER_SCHEMA = [
  {
    name: "Packet",
    tooltipLabel: "{marker.name}",
    tableLabel: "{marker.data.payload}",
    chartLabel: "{marker.data.payload}",
    display: ["marker-chart", "marker-table"],
    description: "An MQTT message received from or sent to the robot.",
    fields: [
      { key: "topic", label: "Topic", format: "string" },
      { key: "size", label: "Size", format: "bytes" },
      { key: "payload", label: "Payload", format: "string" },
    ],
  },
  {
    name: "StateChange",
    tooltipLabel: "{marker.data.label}: {marker.data.from} → {marker.data.to}",
    tableLabel: "{marker.data.label}: {marker.data.from} → {marker.data.to}",
    chartLabel: "{marker.data.label}",
    display: ["marker-chart", "marker-table"],
    description: "A value of the robot's reported state changed.",
    fields: [
      { key: "label", label: "Field", format: "string" },
      { key: "path", label: "Raw field", format: "string" },
      { key: "from", label: "From", format: "string" },
      { key: "to", label: "To", format: "string" },
    ],
  },
  {
    name: "Phase",
    tooltipLabel: "{marker.data.label}",
    tableLabel: "{marker.data.label} ({marker.data.phase})",
    chartLabel: "{marker.data.label}",
    display: ["marker-chart", "marker-table"],
    description: "What the robot was doing (cleanMissionStatus.phase).",
    fields: [
      { key: "label", label: "Activity", format: "string" },
      { key: "phase", label: "Phase", format: "string" },
      { key: "cycle", label: "Cycle", format: "string" },
    ],
  },
  {
    name: "Mission",
    tooltipLabel: "Mission {marker.data.nMssn}: {marker.data.cycle}",
    tableLabel: "Mission {marker.data.nMssn}: {marker.data.cycle}, {marker.data.mssnM} min, {marker.data.sqft} ft²",
    chartLabel: "Mission {marker.data.nMssn} ({marker.data.cycle})",
    display: ["marker-chart", "marker-table"],
    fields: [
      { key: "cycle", label: "Cycle", format: "string" },
      { key: "initiator", label: "Started by", format: "string" },
      { key: "nMssn", label: "Mission number", format: "integer" },
      { key: "mssnM", label: "Robot-reported duration (min)", format: "integer" },
      { key: "sqft", label: "Area (ft²)", format: "integer" },
      { key: "missionId", label: "Mission ID", format: "string" },
    ],
  },
  {
    name: "Counter",
    tooltipLabel: "{marker.data.change}",
    tableLabel: "{marker.name}: {marker.data.change} (total {marker.data.total})",
    chartLabel: "{marker.data.change}",
    display: ["marker-chart", "marker-table"],
    description: "A lifetime counter increased between two reports from the robot.",
    fields: [
      { key: "change", label: "Change", format: "string" },
      { key: "total", label: "Lifetime total", format: "string" },
      { key: "path", label: "Field", format: "string" },
    ],
  },
  {
    name: "Trip",
    tooltipLabel: "Cleaning run (off dock)",
    tableLabel: "Cleaning run (off dock)",
    chartLabel: "Cleaning run",
    display: ["marker-chart", "marker-table", "timeline-overview"],
    description: "The robot was away from its dock.",
    fields: [],
  },
  {
    name: "Span",
    tooltipLabel: "{marker.name}",
    tableLabel: "{marker.name} {marker.data.detail}",
    chartLabel: "{marker.data.detail}",
    display: ["marker-chart", "marker-table"],
    fields: [{ key: "detail", label: "Details", format: "string" }],
  },
  {
    name: "Battery",
    tooltipLabel: "Battery {marker.data.value}%",
    tableLabel: "Battery {marker.data.value}%",
    display: ["marker-table"],
    fields: [{ key: "value", label: "Battery (%)", format: "integer" }],
    graphs: [{ key: "value", type: "line-filled", color: "green" }],
  },
  {
    name: "Signal",
    tooltipLabel: "RSSI {marker.data.rssi} dBm, noise {marker.data.noise} dBm",
    tableLabel: "RSSI {marker.data.rssi} dBm, noise {marker.data.noise} dBm",
    display: ["marker-table"],
    fields: [
      { key: "rssi", label: "RSSI (dBm)", format: "integer" },
      { key: "noise", label: "Noise (dBm)", format: "integer" },
    ],
    graphs: [
      { key: "rssi", type: "line", color: "blue" },
      { key: "noise", type: "line", color: "red" },
    ],
  },
  {
    name: "Metric",
    tooltipLabel: "{marker.name}: {marker.data.value}",
    tableLabel: "{marker.name}: {marker.data.value}",
    display: ["marker-table"],
    fields: [
      { key: "path", label: "Field", format: "string" },
      { key: "value", label: "Value", format: "decimal" },
    ],
    graphs: [{ key: "value", type: "line", color: "purple" }],
  },
];

function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, path, out);
    else out[path] = v;
  }
  return out;
}

const show = (v) => (v === undefined ? "∅" : typeof v === "string" ? v : JSON.stringify(v));

function buildProfile(entries, robotName) {
  const t0 = entries.length ? entries[0].t : Date.now();
  const tEnd = entries.length ? entries[entries.length - 1].t - t0 : 0;

  const strings = [];
  const stringIndex = new Map();
  const str = (s) => {
    if (!stringIndex.has(s)) {
      stringIndex.set(s, strings.length);
      strings.push(s);
    }
    return stringIndex.get(s);
  };

  const markers = { data: [], name: [], startTime: [], endTime: [], phase: [], category: [], length: 0 };
  const addMarker = (name, start, end, category, data) => {
    markers.name.push(str(name));
    markers.startTime.push(start);
    markers.endTime.push(end === null ? 0 : end);
    markers.phase.push(end === null ? 0 : 1);
    markers.category.push(category);
    markers.data.push(data);
    markers.length++;
  };

  // Intervals that stay open until their value changes.
  const open = {};
  const openSpan = (key, name, start, category, data) => {
    closeSpan(key, start);
    open[key] = { name, start, category, data };
  };
  const closeSpan = (key, end) => {
    const span = open[key];
    delete open[key];
    // The robot sometimes reports a phase and replaces it in the same second.
    if (!span || end <= span.start) return null;
    addMarker(span.name, span.start, end, span.category, span.data);
    return markers.length - 1;
  };

  // Numeric values, sampled as step intervals for the graph tracks.
  const series = {};
  // Every report of charted values, repeated ones included.
  const points = {};
  const sample = (path, value, time) => {
    const s = (series[path] ||= []);
    const last = s[s.length - 1];
    if (last && last.value === value) return;
    s.push({ time, value });
  };

  const SERVER_DOWN_MIN_MS = 5000;
  const receivedTimes = [];
  let sawServerStart = false;
  // Mid-mission returns not yet labeled with their reason.
  let pendingReturns = [];
  let returnStart = null;
  let dockArrival = null;
  let lastBinFull = null;
  const RECHARGE_STAY_MS = 5 * 60000;
  const BIN_FULL_WINDOW_MS = 60000;
  let prevTime = null;
  const state = {};
  // Last report of each counter, to know since when it increased.
  const counters = {};
  const counterReport = (path, name, value, time, format) => {
    const last = counters[path];
    counters[path] = { value, time };
    if (!last || value <= last.value) return;
    const delta = value - last.value;
    addMarker(name, last.time, time, CAT.State, {
      type: "Counter",
      change: `+${format(delta)} ${name.toLowerCase()}`,
      total: format(value),
      path,
    });
  };
  for (const e of entries) {
    const time = e.t - t0;

    // A server start, or a connection without a disconnection before it
    // (older logs have no "server started" entry), means the server wasn't
    // running since the previous entry.
    const serverRestart = e.dir === "info" &&
      (e.payload === "server started" || (e.payload === "connected to robot" && !open.disconnected && !sawServerStart));
    if (e.payload === "server started") sawServerStart = true;
    if (e.payload === "connected to robot") sawServerStart = false;
    if (serverRestart && prevTime !== null && time - prevTime > SERVER_DOWN_MIN_MS) {
      addMarker("Disconnected", prevTime, time, CAT.State,
        { type: "Span", detail: "no data (server not running)" });
    }
    prevTime = time;

    if (e.dir === "info") {
      // While the robot is unreachable the server retries every few seconds;
      // show that as one interval rather than hundreds of markers.
      if (e.payload === "connected to robot") {
        closeSpan("disconnected", time);
      } else if (e.payload.startsWith("disconnected") || e.payload.startsWith("error: ")) {
        if (!open.disconnected) {
          openSpan("disconnected", "Disconnected", time, CAT.State, { type: "Span", detail: e.payload });
        } else if (e.payload.startsWith("error: ")) {
          open.disconnected.data.detail = e.payload;
        }
      } else {
        addMarker("Server", time, null, CAT.State, { type: "Span", detail: e.payload });
      }
      continue;
    }

    const text = typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload);
    const shortTopic = e.topic.startsWith("$aws/things/") ? "shadow" : e.topic;
    addMarker(`${e.dir === "in" ? "◀" : "▶"} ${shortTopic}`, time, null, CAT.Packets,
      { type: "Packet", topic: e.topic, size: text.length, payload: text });

    if (e.dir === "in") receivedTimes.push(time);
    const reported = e.dir === "in" && e.payload?.state?.reported;
    if (!reported) continue;

    const flat = flatten(reported);
    for (const [path, value] of Object.entries(flat)) {
      if (typeof value === "number" && isCounter(path)) {
        counterReport(path, COUNTERS[path] || path, value, time, (n) => n.toLocaleString("en"));
        state[path] = value;
        continue;
      }
      if (CHARTED.has(path)) (points[path] ||= []).push({ time, value });
      const old = state[path];
      if (JSON.stringify(old) === JSON.stringify(value)) continue;
      state[path] = value;
      if (TIME_FIELDS.has(path)) continue;
      if (CHARTED.has(path)) {
        sample(path, value, time);
        continue;
      }
      if (old !== undefined) {
        const group = path.split(".")[0];
        addMarker(GROUP_NAMES[group] || group, time, null, CAT.State,
          { type: "StateChange", label: LABELS[path] || path, path, from: show(old), to: show(value) });
      }
    }
    for (const [path, c] of Object.entries(TIME_COUNTERS)) {
      if (!(c.hr in flat) && !(c.min && c.min in flat)) continue;
      const minutes = (state[c.hr] || 0) * 60 + (c.min ? state[c.min] || 0 : 0);
      counterReport(path, c.name, minutes, time, formatMinutes);
    }

    const m = {
      phase: state["cleanMissionStatus.phase"],
      cycle: state["cleanMissionStatus.cycle"],
      error: state["cleanMissionStatus.error"],
    };
    if ("cleanMissionStatus.phase" in flat || "cleanMissionStatus.cycle" in flat || "batPct" in flat) {
      if (open.phase?.data.phase !== m.phase || open.phase?.data.label !== phaseLabel(m.phase, state)) {
        const previous = open.phase;
        const index = closeSpan("phase", time);
        if (index !== null && previous.data.label === MID_MISSION_RETURN) {
          if (!pendingReturns.length) returnStart = previous.start;
          pendingReturns.push(index);
        }
        // Why it went home mid-mission is only known once it leaves the dock
        // again: the base empties the bin and the robot charges on every
        // visit, but a short stay means it only came back for the bin.
        if (pendingReturns.length) {
          if (dockArrival === null && ["evac", "charge", "recharge"].includes(m.phase)) dockArrival = time;
          const leaving = m.phase === "run" || m.phase === "resume";
          const missionOver = ["hmUsrDock", "hmPostMsn", "stop"].includes(m.phase) || m.cycle === "none";
          if (dockArrival !== null && (leaving || missionOver)) {
            const binFull = lastBinFull !== null && lastBinFull >= returnStart - BIN_FULL_WINDOW_MS;
            const reason = time - dockArrival > RECHARGE_STAY_MS ? "Returning to recharge"
              : binFull ? "Returning to empty bin" : null;
            if (reason) {
              for (const i of pendingReturns) {
                markers.name[i] = str(reason);
                markers.data[i].label = reason;
              }
            }
            pendingReturns = [];
            dockArrival = null;
          }
        }
        openSpan("phase", phaseLabel(m.phase, state), time, CAT.Activity,
          { type: "Phase", phase: m.phase, label: phaseLabel(m.phase, state), cycle: m.cycle });
      }
      const inMission = m.cycle && m.cycle !== "none";
      if (inMission && !open.mission) {
        open.mission = { name: "Mission", start: time, category: CAT.Activity, data: { type: "Mission" } };
      } else if (!inMission && open.mission) {
        closeSpan("mission", time);
      }
    }
    if (open.mission) {
      Object.assign(open.mission.data, {
        cycle: state["cleanMissionStatus.cycle"],
        initiator: state["cleanMissionStatus.initiator"] ?? "",
        nMssn: state["cleanMissionStatus.nMssn"] ?? 0,
        mssnM: state["cleanMissionStatus.mssnM"] ?? 0,
        sqft: state["cleanMissionStatus.sqft"] ?? 0,
        missionId: state["cleanMissionStatus.missionId"] ?? "",
      });
    }
    if ("dock.state" in flat) {
      const dockState = flat["dock.state"];
      const detail = DOCK_STATES[dockState] || `dock state ${dockState}`;
      if (open.dock?.data.detail !== detail) {
        openSpan("dock", "Dock", time, CAT.Activity,
          { type: dockState === 300 ? "Trip" : "Span", detail });
      }
    }
    if ("cleanMissionStatus.error" in flat) {
      if (m.error) {
        openSpan("error", "Error", time, CAT.State,
          { type: "Span", detail: `${m.error}: ${ERROR_MESSAGES[m.error] || "unknown error"}` });
      } else {
        closeSpan("error", time);
      }
    }
    if (flat["bin.full"]) lastBinFull = time;
    if ("bin.full" in flat) {
      if (flat["bin.full"]) openSpan("bin", "Bin full", time, CAT.State, { type: "Span", detail: "bin full" });
      else closeSpan("bin", time);
    }
  }
  for (const key of Object.keys(open)) closeSpan(key, tEnd);
  const sampleTables = buildSamples(markers, strings, str, tEnd, receivedTimes);

  // Graph tracks: battery and Wi-Fi always, other numbers only when they
  // changed during the recording.
  const stepMarkers = (path, name, toData) => {
    const s = series[path] || [];
    s.forEach((p, i) => {
      const end = i + 1 < s.length ? s[i + 1].time : tEnd;
      addMarker(name, p.time, Math.max(end, p.time), CAT.State, toData(p.value, p.time));
    });
  };
  // Measurements that vary continuously are instant markers: the graph joins
  // consecutive points with straight lines.
  // The last value still holds until the end of the recording.
  const pointMarkers = (path, name, toData) => {
    const list = points[path] || [];
    const last = list[list.length - 1];
    if (last && last.time < tEnd) list.push({ time: tEnd, value: last.value });
    for (const p of list) addMarker(name, p.time, null, CAT.State, toData(p.value, p.time));
  };
  pointMarkers("batPct", "Battery (%)", (value) => ({ type: "Battery", value }));
  // RSSI and noise arrive together; pair them by time.
  const noiseAt = (time) => {
    let v = null;
    for (const p of points["signal.noise"] || []) if (p.time <= time) v = p.value;
    return v;
  };
  pointMarkers("signal.rssi", "Wi-Fi signal (dBm)",
    (value, time) => ({ type: "Signal", rssi: value, noise: noiseAt(time) ?? value }));
  pointMarkers("signal.snr", LABELS["signal.snr"], (value) => ({ type: "Metric", path: "signal.snr", value }));
  // States are held until the next value.
  stepMarkers("dock.state", LABELS["dock.state"], (value) => ({ type: "Metric", path: "dock.state", value }));

  return {
    meta: {
      // The robot reports its Wi-Fi stats every ~10 s.
      interval: SAMPLE_INTERVAL_MS,
      startTime: t0,
      profilingStartTime: 0,
      profilingEndTime: tEnd,
      // Hides the symbolication row and the "Re-symbolicate" button.
      symbolicationNotSupported: true,
      abi: "",
      misc: "",
      processType: 0,
      extensions: { id: [], name: [], baseURL: [], length: 0 },
      categories: CATEGORIES,
      product: `iRobot Roomba ${state.name || ""}`.trim(),
      device: state.sku,
      appBuildID: state.softwareVer || "",
      oscpu: state["subModSwVer.linux"] || "",
      platform: "",
      extra: buildExtraInfo(state, robotName),
      stackwalk: 0,
      toolkit: "",
      version: 37,
      preprocessedProfileVersion: 76,
      sourceURL: "",
      physicalCPUs: 0,
      logicalCPUs: 0,
      CPUName: "",
      symbolicated: true,
      markerSchema: MARKER_SCHEMA,
    },
    libs: [],
    pages: [],
    shared: {
      stackTable: sampleTables.stackTable,
      frameTable: sampleTables.frameTable,
      funcTable: sampleTables.funcTable,
      resourceTable: { name: [], host: [], type: [], length: 0 },
      nativeSymbols: { libIndex: [], address: [], name: [], functionSize: [], length: 0 },
      sources: { id: [], filename: [], startLine: [], startColumn: [], sourceMapURL: [], content: [], length: 0 },
      stringArray: strings,
      sourceLocationTable: { source: [], line: [], column: [], length: 0 },
    },
    threads: [
      {
        processType: "default",
        processStartupTime: 0,
        processShutdownTime: null,
        registerTime: 0,
        unregisterTime: null,
        pausedRanges: [],
        name: "Robot",
        processName: robotName,
        isMainThread: true,
        showMarkersInTimeline: true,
        pid: "1",
        tid: 1,
        samples: sampleTables.samples,
        markers,
      },
    ],
  };
}

// Sections for the profile's info panel, from the last known state.
// Identifiers (serial numbers, MAC addresses, BLIDs, IP) are left out so the
// profile can be shared more safely; the packet markers still contain them.
function buildExtraInfo(state, robotName) {
  const entry = (label, value, format = "string") =>
    value === undefined || value === null || value === "" ? null : { label, format, value };
  const yesNo = (v) => (v === undefined ? undefined : v ? "yes" : "no");
  const hours = (h, m = 0) => (h === undefined ? undefined : (h * 60 + m) * 60000);
  const section = (label, entries) => ({ label, entries: entries.filter(Boolean) });
  return [
    section("Robot", [
      entry("Name", state.name),
      entry("Model (SKU)", state.sku),
      entry("Connection", robotName),
      entry("Country", state.country),
      entry("Time zone", state.timezone),
      entry("Language", state["langs2.sLang"]),
      entry("Cloud environment", state.cloudEnv),
      entry("IMU", state["hwPartsRev.imuPartNo"]),
      entry("Mobility board revision", state["hwPartsRev.mobBrd"], "integer"),
      entry("Navigation board revision", state["hwPartsRev.NavBrd"], "integer"),
    ]),
    section("Firmware", [
      entry("Software version", state.softwareVer),
      entry("Navigation", state["subModSwVer.nav"]),
      entry("Mobility", state["subModSwVer.mob"]),
      entry("Mobility bootloader", state["subModSwVer.mobBtl"]),
      entry("Power", state["subModSwVer.pwr"]),
      entry("Safety", state["subModSwVer.sft"]),
      entry("Linux image", state["subModSwVer.linux"]),
      entry("Connectivity", state["subModSwVer.con"]),
      entry("Recovery image", state["secureBoot.recov"]),
      entry("Secure boot", state["secureBoot.TSK"]),
    ]),
    section("Battery", [
      entry("Level", state.batPct === undefined ? undefined : state.batPct / 100, "percentage"),
      entry("Type", state.batteryType),
      entry("Manufacturer", state["batInfo.mName"]),
      entry("Manufacturing date", state["batInfo.mDate"]),
      entry("Charge cycles", state["batInfo.cCount"], "integer"),
      entry("Estimated capacity (mAh?)", state["bbchg3.estCap"], "integer"),
      entry("Successful charges", state["bbchg.nChgOk"], "integer"),
      entry("Charge errors", state["bbchg.nChgErr"], "integer"),
    ]),
    section("Dock", [
      entry("Known", yesNo(state["dock.known"])),
      entry("Part number", state["dock.pn"]),
      entry("Firmware", state["dock.fwVer"]),
      entry("Hardware revision", state["dock.hwRev"], "integer"),
      entry("Bin present", yesNo(state["bin.present"])),
      entry("Bin type", state["bin.type"]),
    ]),
    section("Lifetime", [
      entry("Run time", hours(state["bbrun.hr"], state["bbrun.min"]), "duration"),
      entry("Powered time", hours(state["bbsys.hr"], state["bbsys.min"]), "duration"),
      entry("Time on dock", hours(state["bbchg3.hOnDock"]), "duration"),
      entry("Missions", state["bbmssn.nMssn"], "integer"),
      entry("Missions completed", state["bbmssn.nMssnOk"], "integer"),
      entry("Missions cancelled", state["bbmssn.nMssnC"], "integer"),
      entry("Missions failed", state["bbmssn.nMssnF"], "integer"),
      entry("Average mission (min)", state["bbmssn.aMssnM"], "integer"),
      entry("Bin evacuations", state["bbrun.nEvacs"], "integer"),
      entry("Stuck events", state["bbrun.nStuck"], "integer"),
      entry("Bumper hits", state["bbswitch.nBumper"], "integer"),
      entry("Front cliff detections", state["bbrun.nCliffsF"], "integer"),
      entry("Wheel drops", state["bbswitch.nDrops"], "integer"),
      entry("Pick-ups", state["bbrun.nPicks"], "integer"),
      entry("Main brush stalls", state["bbrun.nMBStll"], "integer"),
      entry("Navigation resets", state["bbrstinfo.nNavRst"], "integer"),
      entry("Mobility resets", state["bbrstinfo.nMobRst"], "integer"),
    ]),
    section("Settings", [
      entry("Carpet boost", yesNo(state.carpetBoost)),
      entry("High suction", yesNo(state.vacHigh)),
      entry("Two passes", yesNo(state.twoPass)),
      entry("Automatic passes", yesNo(state.noAutoPasses === undefined ? undefined : !state.noAutoPasses)),
      entry("Pause when bin full", yesNo(state.binPause)),
      entry("Eco charge", yesNo(state.ecoCharge)),
      entry("Bin evacuation allowed", yesNo(state.evacAllowed)),
      entry("Child lock", yesNo(state.childLock)),
      entry("Map upload allowed", yesNo(state.mapUploadAllowed)),
      entry("Map learning allowed", yesNo(state.pmapLearningAllowed)),
    ]),
    section("Wi-Fi", [
      entry("Signal (dBm)", state["signal.rssi"], "integer"),
      entry("Noise (dBm)", state["signal.noise"], "integer"),
      entry("SNR (dB)", state["signal.snr"], "integer"),
      entry("DHCP", yesNo(state["netinfo.dhcp"])),
    ]),
  ].filter((s) => s.entries.length);
}

// Samples coloring the activity graph by what the robot was doing, with
// stacks like Robot > Mission 283 > Off dock > Cleaning for the call tree.
// There is a sample for each message received, weighted by the time until
// the next one. There are none while disconnected, so the graph's color
// there is visibly extrapolated.
const SAMPLE_INTERVAL_MS = 10000;
const FRAME_HAS_CATEGORY = 1 << 2;

function buildSamples(markers, strings, str, tEnd, receivedTimes) {
  const spans = { Activity: [], Dock: [], Mission: [], Disconnected: [] };
  for (let i = 0; i < markers.length; i++) {
    const data = markers.data[i];
    const list = spans[data.type === "Phase" ? "Activity" : strings[markers.name[i]]];
    if (list && markers.phase[i] === 1) {
      list.push({ start: markers.startTime[i], end: markers.endTime[i], category: markers.category[i], data: markers.data[i] });
    }
  }
  const at = (list, time) => list.find((span) => span.start <= time && time < span.end);

  const activityFrames = (time) => {
    const frames = [["Robot", CAT.Other]];
    const mission = at(spans.Mission, time);
    frames.push(mission ? [`Mission ${mission.data.nMssn}`, CAT.Cleaning] : ["Between missions", CAT.Other]);
    const dock = at(spans.Dock, time);
    if (dock) {
      const off = dock.data.detail === "off dock";
      frames.push(off ? ["Off dock", CAT.Cleaning] : ["On dock", CAT.Charging]);
    }
    const activity = at(spans.Activity, time);
    let label = activity ? activity.data.label : "Unknown";
    // The phase switches to cleaning a few seconds before the robot leaves.
    if (label === "Cleaning" && dock && dock.data.detail !== "off dock") label = "Leaving dock";
    const category = label === "Docked (battery full)" ? CAT.Idle
      : activity ? phaseCategory(activity.data.phase || "") : CAT.Other;
    frames.push([label, category]);
    return frames;
  };

  const funcTable = { flags: [], name: [], resource: [], source: [], lineNumber: [], columnNumber: [], originalLocation: [], length: 0 };
  const frameTable = {
    flags: [], address: [], category: [], subcategory: [], func: [], lib: [],
    nativeSymbol: [], innerWindowID: [], line: [], column: [], originalLocation: [], length: 0,
  };
  const stackTable = { frame: [], prefixOffset: [], length: 0 };
  // After a disconnection, the first sample's event delay is the time since
  // the previous message, so the profiler shows the gap as jank.
  const samples = { weightType: "tracing-ms", weight: [], stack: [], time: [], eventDelay: [], length: 0 };
  const addRow = (table, row) => {
    for (const [k, v] of Object.entries(row)) table[k].push(v);
    return table.length++;
  };
  const funcs = new Map(), frameIndexes = new Map(), stacks = new Map();
  const getStack = (frames) => {
    let stack = null;
    for (const [name, category] of frames) {
      if (!funcs.has(name)) {
        funcs.set(name, addRow(funcTable, {
          flags: 0, name: str(name), resource: 0, source: 0, lineNumber: 0, columnNumber: 0, originalLocation: 0,
        }));
      }
      const frameKey = `${name}|${category}`;
      if (!frameIndexes.has(frameKey)) {
        frameIndexes.set(frameKey, addRow(frameTable, {
          flags: FRAME_HAS_CATEGORY, address: 0, category, subcategory: 0, func: funcs.get(name), lib: 0,
          nativeSymbol: 0, innerWindowID: 0, line: 0, column: 0, originalLocation: 0,
        }));
      }
      const stackKey = `${stack}|${frameIndexes.get(frameKey)}`;
      if (!stacks.has(stackKey)) {
        const index = stackTable.length;
        stacks.set(stackKey, addRow(stackTable, {
          frame: frameIndexes.get(frameKey),
          prefixOffset: stack === null ? 0 : index - stack,
        }));
      }
      stack = stacks.get(stackKey);
    }
    return stack;
  };
  const times = [...new Set(receivedTimes)];
  times.forEach((time, i) => {
    const previous = i > 0 ? times[i - 1] : null;
    const next = i + 1 < times.length ? times[i + 1] : tEnd;
    const afterGap = previous !== null &&
      spans.Disconnected.some((d) => d.start < time && d.end > previous);
    addRow(samples, {
      time,
      stack: getStack(activityFrames(time)),
      weight: next - time,
      eventDelay: afterGap ? time - previous : 0,
    });
  });
  return { funcTable, frameTable, stackTable, samples };
}

module.exports = { buildProfile };
