
import http from "node:http";

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";
const RECEIVER_VERSION = "worker-routing-v2";
const serverStartedAt = new Date().toISOString();

const initialWorkerData = {
  worker: "WORKER2",
  h2s: null,
  temperature: null,
  humidity: null,
  movement: null,
  lastUpdated: null,
  connected: false
};

const workerDataById = {
  WORKER1: {
    worker: "WORKER1",
    packetID: null,
    gas_adc: null,
    temperature: null,
    humidity: null,
    acceleration: null,
    movement: null,
    turn: null,
    roll: null,
    pitch: null,
    sos: null,
    sosEventId: null,
    sosAcknowledged: false,
    status: null,
    rssi: null,
    snr: null,
    lastUpdated: null,
    connected: false
  },
  WORKER2: { ...initialWorkerData }
};

let latestWorkerData = workerDataById.WORKER2;
let workerOneSosEventId = 0;
let workerOneSosAcknowledged = false;

function normalizeWorkerId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[\s_-]+/g, "");
  return normalized === "WORKER1" || normalized === "WORKER2"
    ? normalized
    : null;
}

const workerOneFields = [
  "packetID",
  "gas_adc",
  "temperature",
  "humidity",
  "acceleration",
  "movement",
  "turn",
  "roll",
  "pitch",
  "sos",
  "status",
  "rssi",
  "snr"
];

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidMetric(value) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return false;
  }
  return Number.isFinite(Number(value));
}

function normalizeSos(value) {
  if (value === 1 || value === "1" || value === true) return 1;
  if (value === 0 || value === "0" || value === false) return 0;
  return null;
}

function validateWorkerOne(data) {
  if (workerOneFields.some((field) => !(field in data))) {
    return "Worker 1 payload is missing one or more required fields";
  }
  if (
    (typeof data.packetID !== "string" && typeof data.packetID !== "number") ||
    !isFiniteNumber(data.gas_adc) ||
    data.gas_adc < 0 ||
    !isFiniteNumber(data.temperature) ||
    !isFiniteNumber(data.humidity) ||
    data.humidity < 0 ||
    data.humidity > 100 ||
    !isFiniteNumber(data.acceleration) ||
    typeof data.movement !== "string" ||
    typeof data.turn !== "string" ||
    !isFiniteNumber(data.roll) ||
    !isFiniteNumber(data.pitch) ||
    normalizeSos(data.sos) === null ||
    typeof data.status !== "string" ||
    !isFiniteNumber(data.rssi) ||
    !isFiniteNumber(data.snr)
  ) {
    return "Worker 1 payload contains invalid field values";
  }
  return null;
}

const server = http.createServer((req, res) => {

  // CORS headers: allow React dashboard to access this server
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  res.setHeader("Content-Type", "application/json");

  // Handle browser preflight requests
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // Parse URL without query parameters
  const requestUrl = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );
  const pathname = requestUrl.pathname;

  // Health check
  if (req.method === "GET" && pathname === "/") {
    res.writeHead(200);
    return res.end(JSON.stringify({
      message: "BAASC receiver is running",
      port: PORT,
      version: RECEIVER_VERSION,
      startedAt: serverStartedAt
    }));
  }

  // GET latest worker data
  if (req.method === "GET" && pathname === "/api/worker-data") {
    const requestedWorker = requestUrl.searchParams.get("worker");
    if (requestedWorker !== null) {
      const workerId = normalizeWorkerId(requestedWorker);
      if (!workerId) {
        res.writeHead(400);
        return res.end(JSON.stringify({
          success: false,
          error: "Unexpected worker ID"
        }));
      }
      res.writeHead(200);
      return res.end(JSON.stringify(workerDataById[workerId]));
    }

    res.writeHead(200);
    return res.end(JSON.stringify(latestWorkerData));
  }

  if (req.method === "POST" && pathname === "/api/worker-data/acknowledge") {
    let body = "";
    let bodyTooLarge = false;

    req.on("data", (chunk) => {
      if (bodyTooLarge) return;
      body += chunk;
      if (body.length > 4000) {
        bodyTooLarge = true;
        res.writeHead(413);
        res.end(JSON.stringify({
          success: false,
          error: "Request body too large"
        }));
      }
    });

    req.on("end", () => {
      if (bodyTooLarge) return;

      try {
        const data = JSON.parse(body);
        const workerId = normalizeWorkerId(data?.worker);
        if (workerId !== "WORKER1") {
          res.writeHead(400);
          return res.end(JSON.stringify({
            success: false,
            error: "Acknowledgement is only supported for WORKER1"
          }));
        }

        if (
          !Number.isSafeInteger(data.sosEventId) ||
          data.sosEventId !== workerOneSosEventId ||
          workerDataById.WORKER1.sos !== 1
        ) {
          res.writeHead(409);
          return res.end(JSON.stringify({
            success: false,
            error: "SOS event is no longer active or has changed",
            worker: "WORKER1",
            sos: workerDataById.WORKER1.sos,
            sosEventId: workerOneSosEventId,
            sosAcknowledged: workerOneSosAcknowledged
          }));
        }

        workerOneSosAcknowledged = true;
        workerDataById.WORKER1.sosAcknowledged = true;
        console.log(
          `WORKER1 SOS event ${workerOneSosEventId} acknowledged by supervisor`
        );
        res.writeHead(200);
        return res.end(JSON.stringify({
          success: true,
          worker: "WORKER1",
          sos: workerDataById.WORKER1.sos,
          sosEventId: workerOneSosEventId,
          sosAcknowledged: true
        }));
      } catch (error) {
        console.error("Invalid SOS acknowledgement request:", error.message);
        res.writeHead(400);
        return res.end(JSON.stringify({
          success: false,
          error: "Invalid acknowledgement JSON"
        }));
      }
    });
    return;
  }

  // POST worker data from checkpoint ESP32
  if (req.method === "POST" && pathname === "/api/worker-data") {
    console.log(`Incoming request: ${req.method} ${req.url}`);

    let body = "";
    let bodyTooLarge = false;

    req.on("data", chunk => {
      if (bodyTooLarge) return;
      body += chunk;

      // Prevent excessively large requests
      if (body.length > 10000) {
        bodyTooLarge = true;
        res.writeHead(413);
        res.end(JSON.stringify({
          success: false,
          error: "Request body too large"
        }));
      }
    });

    req.on("end", () => {
      if (bodyTooLarge) return;
      console.log("Complete incoming JSON body:", body);

      try {
        const data = JSON.parse(body);
        console.log("Parsed incoming JSON:", JSON.stringify(data));

        if (!data || typeof data !== "object" || Array.isArray(data)) {
          console.log("Extracted worker ID: unavailable (request body is not an object)");
          console.log("Validation result: rejected (expected a JSON object)");
          res.writeHead(400);
          return res.end(JSON.stringify({
            success: false,
            error: "Expected a JSON object"
          }));
        }

        const workerId = normalizeWorkerId(data.worker);
        console.log(
          `Extracted worker ID: ${JSON.stringify(data.worker)} -> ${workerId ?? "invalid"}`
        );
        if (!workerId) {
          console.log("Validation result: rejected (unsupported worker ID)");
          res.writeHead(400);
          return res.end(JSON.stringify({
            success: false,
            error: "Unexpected worker ID"
          }));
        }

        const receivedAt = new Date().toISOString();
        if (workerId === "WORKER1") {
          const validationError = validateWorkerOne(data);
          if (validationError) {
            console.log(`Validation result: rejected WORKER1 (${validationError})`);
            res.writeHead(400);
            return res.end(JSON.stringify({
              success: false,
              error: validationError
            }));
          }

          const incomingSos = normalizeSos(data.sos);
          if (incomingSos === 1 && workerDataById.WORKER1.sos !== 1) {
            workerOneSosEventId++;
            workerOneSosAcknowledged = false;
          } else if (incomingSos === 0) {
            workerOneSosAcknowledged = false;
          }

          workerDataById.WORKER1 = {
            worker: workerId,
            packetID: String(data.packetID),
            gas_adc: data.gas_adc,
            temperature: data.temperature,
            humidity: data.humidity,
            acceleration: data.acceleration,
            movement: data.movement,
            turn: data.turn,
            roll: data.roll,
            pitch: data.pitch,
            sos: incomingSos,
            sosEventId: workerOneSosEventId,
            sosAcknowledged:
              incomingSos === 1 && workerOneSosAcknowledged,
            status: data.status,
            rssi: data.rssi,
            snr: data.snr,
            lastUpdated: receivedAt,
            connected: true
          };
        } else {
          const workerTwoMetrics = [
            data.h2s,
            data.temperature,
            data.humidity
          ].filter((value) => value !== undefined && value !== null);
          if (
            workerTwoMetrics.some((value) => !isValidMetric(value)) ||
            !workerTwoMetrics.some(isValidMetric)
          ) {
            console.log("Validation result: rejected WORKER2 (no valid sensor reading)");
            res.writeHead(400);
            return res.end(JSON.stringify({
              success: false,
              error: "Worker 2 payload must include a valid sensor reading"
            }));
          }

          workerDataById.WORKER2 = {
            worker: workerId,
            h2s: data.h2s ?? workerDataById.WORKER2.h2s,
            temperature: data.temperature ?? workerDataById.WORKER2.temperature,
            humidity: data.humidity ?? workerDataById.WORKER2.humidity,
            movement: data.movement ?? workerDataById.WORKER2.movement ?? "UNKNOWN",
            lastUpdated: receivedAt,
            connected: true
          };
        }
        latestWorkerData = workerDataById[workerId];

        console.log(
          `Validation result: accepted ${workerId}`
        );
        console.log(
          `[${receivedAt}] Stored ${workerId}: temperature=${workerDataById[workerId].temperature}, humidity=${workerDataById[workerId].humidity}, packet=${workerDataById[workerId].packetID ?? "n/a"}`
        );
        console.log(
          `LoRa movement forwarded for ${workerId}: ${JSON.stringify(workerDataById[workerId].movement)}`
        );
        if (workerId === "WORKER1") {
          console.log(`Stored WORKER1 SOS value: ${workerDataById.WORKER1.sos}`);
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: "Worker data received"
        }));

      } catch (error) {
        console.error("Invalid JSON:", error.message);
        console.log("Validation result: rejected (invalid JSON)");

        res.writeHead(400);
        res.end(JSON.stringify({
          success: false,
          error: "Invalid JSON data"
        }));
      }
    });

    return;
  }

  // Unknown endpoint
  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Endpoint not found"
  }));
});

// Start server
server.listen(PORT, HOST, () => {
  console.log("-----------------------------------");
  console.log("       BAASC DATA RECEIVER");
  console.log("-----------------------------------");
  console.log(`Server running on port ${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`ESP32: http://192.168.137.1:${PORT}`);
  console.log(`Receiver version: ${RECEIVER_VERSION}`);
  console.log("-----------------------------------");
});
