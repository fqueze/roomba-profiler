// Bridges the Roomba's local MQTT broker to web pages over a websocket.
// Every message in either direction is relayed to the page and appended to
// a JSONL log.
//
// Usage: node server.js <robot-ip> <blid> <password-file>

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const mqtt = require("mqtt");
const { WebSocketServer } = require("ws");

const [IP, BLID, PASSWORD_FILE] = process.argv.slice(2);
if (!IP || !BLID || !PASSWORD_FILE) {
  console.error("Usage: node server.js <robot-ip> <blid> <password-file>");
  process.exit(1);
}
const PASSWORD = fs.readFileSync(PASSWORD_FILE, "utf8").trim();
const PORT = 8980;
const HISTORY_SIZE = 5000;
const LOG_PATH = path.join(__dirname, "..", "traffic.jsonl");
const LOG = fs.createWriteStream(LOG_PATH, {
  flags: "a",
});

const history = [];
let positionPollMs = 1000;
let positionTimer = null;
// Robots that never answer (e.g. the i3) shouldn't be asked forever.
const MAX_UNANSWERED = 20;
let unanswered = 0;

function record(entry) {
  entry.t = Date.now();
  history.push(entry);
  if (history.length > HISTORY_SIZE) history.shift();
  LOG.write(JSON.stringify(entry) + "\n");
  const text = JSON.stringify({ type: "msg", entry });
  for (const client of wss.clients) client.send(text);
}

function parse(payload) {
  const text = payload.toString();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// The robot presents a self-signed cert and older TLS settings.
// Logged before connecting, so a profile can tell when the server wasn't running.
LOG.write(JSON.stringify({ dir: "info", topic: "", payload: "server started", t: Date.now() }) + "\n");

const robot = mqtt.connect(`mqtts://${IP}:8883`, {
  clientId: BLID,
  username: BLID,
  password: PASSWORD,
  protocolVersion: 4,
  rejectUnauthorized: false,
  ciphers: "DEFAULT:!DH@SECLEVEL=0",
  secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  reconnectPeriod: 5000,
  keepalive: 60,
});

robot.on("connect", () => {
  record({ dir: "info", topic: "", payload: "connected to robot" });
  robot.subscribe("#");
  startPositionPolling();
});
robot.on("close", () =>
  record({ dir: "info", topic: "", payload: "disconnected from robot" })
);
robot.on("error", (err) =>
  record({ dir: "info", topic: "", payload: "error: " + err.message })
);
robot.on("message", (topic, payload) => {
  if (topic === "data") unanswered = 0;
  record({ dir: "in", topic, payload: parse(payload) });
});

function publish(topic, payload) {
  record({ dir: "out", topic, payload });
  robot.publish(topic, typeof payload === "string" ? payload : JSON.stringify(payload));
}

// Newer robots only report their position when asked on the `req` topic;
// the reply comes back on `data`.
function startPositionPolling() {
  clearInterval(positionTimer);
  positionTimer = null;
  if (!positionPollMs || !robot.connected) return;
  unanswered = 0;
  positionTimer = setInterval(() => {
    if (++unanswered > MAX_UNANSWERED) {
      record({
        dir: "info",
        topic: "",
        payload: `no reply to ${MAX_UNANSWERED} position requests, stopped polling`,
      });
      setPositionPolling(0);
      return;
    }
    publish("req", {
      reqId: crypto.randomUUID(),
      reqType: "current",
      conType: "local",
    });
  }, positionPollMs);
}

function setPositionPolling(ms) {
  positionPollMs = ms > 0 ? Math.max(250, ms) : 0;
  startPositionPolling();
  const text = JSON.stringify({ type: "poll", positionPollMs });
  for (const client of wss.clients) client.send(text);
}

function sendCommand(command) {
  publish("cmd", {
    command,
    time: Math.floor(Date.now() / 1000),
    initiator: "localApp",
  });
}

const COMMANDS = new Set(["start", "clean", "pause", "resume", "stop", "dock", "evac", "find"]);

function serveProfile(res) {
  fs.readFile(LOG_PATH, "utf8", (err, text) => {
    if (err) {
      res.writeHead(500).end(err.message);
      return;
    }
    const entries = text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    // Reload on each request so profile.js edits apply without a restart.
    delete require.cache[require.resolve("./profile")];
    const { buildProfile } = require("./profile");
    res.writeHead(200, {
      "Content-Type": "application/json",
      // profiler.firefox.com fetches this from the browser.
      "Access-Control-Allow-Origin": "https://profiler.firefox.com",
    });
    res.end(JSON.stringify(buildProfile(entries, `Roomba (${IP})`)));
  });
}

const server = http.createServer((req, res) => {
  if (req.url === "/profile.json") {
    serveProfile(res);
    return;
  }
  const file = req.url === "/" ? "index.html" : req.url.slice(1);
  if (!/^[\w.-]+$/.test(file)) {
    res.writeHead(404).end();
    return;
  }
  fs.readFile(path.join(__dirname, "public", file), (err, data) => {
    if (err) {
      res.writeHead(404).end();
      return;
    }
    const types = { html: "text/html", js: "text/javascript", css: "text/css" };
    res.writeHead(200, { "Content-Type": types[file.split(".").pop()] || "text/plain" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "history", entries: history, positionPollMs }));
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.type === "cmd" && COMMANDS.has(msg.command)) {
      sendCommand(msg.command);
    } else if (msg.type === "publish" && typeof msg.topic === "string") {
      publish(msg.topic, msg.payload);
    } else if (msg.type === "poll") {
      setPositionPolling(Number(msg.ms) || 0);
    }
  });
});

// Localhost only: the page can drive the robot.
server.listen(PORT, "127.0.0.1", () =>
  console.log(`Open http://localhost:${PORT}`)
);
