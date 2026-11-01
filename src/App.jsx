import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Activity,
  AlertTriangle,
  Bell,
  Clock3,
  Droplets,
  HardHat,
  MapPin,
  Minus,
  Navigation,
  Plus,
  RadioTower,
  ShieldCheck,
  Thermometer,
  Users,
  Wifi,
  Wind,
} from "lucide-react";
import "./App.css";

const initialWorkers = [
  {
    id: "W-001",
    name: "Worker 001",
    location: "CP-01 zone · position unavailable",
    x: 27,
    y: 65,
    gasAdc: null,
    h2s: null,
    temperature: null,
    humidity: null,
    battery: null,
    acceleration: null,
    movement: null,
    turn: null,
    roll: null,
    pitch: null,
    sos: null,
    sosEventId: null,
    sosAcknowledged: false,
    telemetryStatus: null,
    rssi: null,
    snr: null,
    packetId: null,
    connected: false,
    checkpointId: "CP-01",
    lastReceivedAt: null,
  },
  {
    id: "W-002",
    name: "Worker 002",
    location: "CP-01 zone · position unavailable",
    x: 72,
    y: 65,
    gasAdc: null,
    h2s: null,
    temperature: null,
    humidity: null,
    battery: null,
    acceleration: null,
    movement: null,
    turn: null,
    roll: null,
    pitch: null,
    sos: null,
    sosEventId: null,
    sosAcknowledged: false,
    telemetryStatus: null,
    rssi: null,
    snr: null,
    packetId: null,
    connected: false,
    checkpointId: "CP-01",
    lastReceivedAt: null,
  },
];

const checkpoints = [
  {
    id: "CP-01",
    name: "Fixed LoRa Gateway",
    location: "Tunnel entrance",
    x: 13,
  },
];

const safetyThresholds = {
  h2s: { warning: 10, emergency: 20 },
  temperature: { warning: 35, emergency: 40 },
  humidity: { warning: 85, emergency: null },
  battery: { warning: 20 },
};

const RECEIVER_POLL_INTERVAL_MS = 3000;
const RECEIVER_REQUEST_TIMEOUT_MS = 5000;
const TELEMETRY_STALE_AFTER_MS = 30000;
const TUNNEL_PATH_MIN_X = 20;
const TUNNEL_PATH_MAX_X = 89;
const MOVEMENT_STEP_PERCENT = 2;
const RECEIVER_API_URL =
  import.meta.env.VITE_RECEIVER_URL ?? "http://localhost:3000/api/worker-data";

function parseSensorValue(value, { min = -Infinity, max = Infinity } = {}) {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

function parseTimestamp(value) {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isFinite(new Date(value).getTime())
  ) {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMovement(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const movement = value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (["walking", "walk", "moving"].includes(movement)) return "Walking";
  if (["stationary", "still", "stopped"].includes(movement)) return "Stationary";
  if (["unknown", "unavailable"].includes(movement)) return null;
  return value.trim();
}

function isWalkingMovement(movement) {
  return movement === "Walking";
}

function parseSosValue(value) {
  if (value === 1 || value === "1" || value === true) return 1;
  if (value === 0 || value === "0" || value === false) return 0;
  return null;
}

function isSosActive(worker) {
  return worker.sos === 1;
}

function isWorkerConnectionDisplayedAsConnected(worker) {
  return worker.id === "W-001";
}

function getWorkerStatus(worker, includeSos = true) {
  if (includeSos && isSosActive(worker)) return "emergency";
  if (!worker.connected && worker.id !== "W-001") return "offline";

  const availableReadings = [
    worker.h2s,
    worker.temperature,
    worker.humidity,
  ].filter(Number.isFinite);
  if (availableReadings.length === 0) return "unavailable";

  if (
    (Number.isFinite(worker.h2s) && worker.h2s >= safetyThresholds.h2s.emergency) ||
    (Number.isFinite(worker.temperature) &&
      worker.temperature >= safetyThresholds.temperature.emergency) ||
    (Number.isFinite(worker.humidity) &&
      safetyThresholds.humidity.emergency !== null &&
      worker.humidity >= safetyThresholds.humidity.emergency)
  ) {
    return "emergency";
  }
  if (
    (Number.isFinite(worker.h2s) && worker.h2s >= safetyThresholds.h2s.warning) ||
    (Number.isFinite(worker.temperature) &&
      worker.temperature >= safetyThresholds.temperature.warning) ||
    (Number.isFinite(worker.humidity) &&
      worker.humidity >= safetyThresholds.humidity.warning) ||
    (Number.isFinite(worker.battery) &&
      worker.battery <= safetyThresholds.battery.warning)
  ) {
    return "warning";
  }
  return availableReadings.length > 0 ? "normal" : "unavailable";
}

function getWorkerAlerts(worker, includeSos = true) {
  const sosAlerts =
    includeSos && isSosActive(worker)
      ? [
          {
            key: "sos",
            label: "SOS emergency signal",
            value: null,
            unit: "",
            severity: "emergency",
          },
        ]
      : [];
  if (!worker.connected) return sosAlerts;

  const monitoredReadings = [
    {
      key: "h2s",
      label: "H₂S concentration",
      value: worker.h2s,
      unit: "ppm",
      thresholds: safetyThresholds.h2s,
    },
    {
      key: "temperature",
      label: "Temperature",
      value: worker.temperature,
      unit: "°C",
      thresholds: safetyThresholds.temperature,
    },
    {
      key: "humidity",
      label: "Relative humidity",
      value: worker.humidity,
      unit: "%",
      thresholds: safetyThresholds.humidity,
    },
  ].filter((reading) => worker.id !== "W-001" || reading.key !== "h2s");

  const thresholdAlerts = monitoredReadings.flatMap((reading) => {
    if (!Number.isFinite(reading.value)) return [];
    if (
      reading.thresholds.emergency !== null &&
      reading.value >= reading.thresholds.emergency
    ) {
      return [{ ...reading, severity: "emergency" }];
    }
    if (reading.value >= reading.thresholds.warning) {
      return [{ ...reading, severity: "warning" }];
    }
    return [];
  });
  return [...sosAlerts, ...thresholdAlerts];
}

function formatMetric(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : "--";
}

function formatTime(timestamp) {
  if (!Number.isFinite(timestamp)) return "--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatReceivedTimestamp(timestamp) {
  if (!Number.isFinite(timestamp)) return "No data";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(timestamp);
}

function App() {
  const [workers, setWorkers] = useState(initialWorkers);
  const [selected, setSelected] = useState("W-001");
  const [activeSection, setActiveSection] = useState("dashboard");
  const [workerOneSosAcknowledged, setWorkerOneSosAcknowledged] =
    useState(false);
  const [popupOpen, setPopupOpen] = useState(false);
  const tunnelMapRef = useRef(null);
  const workerPopupRef = useRef(null);
  const [popupCoordinates, setPopupCoordinates] = useState(null);
  const [clockTime, setClockTime] = useState(null);
  const [mapZoom, setMapZoom] = useState(1);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [receiverStatus, setReceiverStatus] = useState("connecting");
  const [receiverError, setReceiverError] = useState("");
  const movementDiagnostics = useRef({});
  const previousWorkerOneSos = useRef(null);
  const workerOneSosAlertPendingRef = useRef(false);
  const [workerOneSosAlertPending, setWorkerOneSosAlertPending] =
    useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTime(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!popupOpen) return undefined;

    const closePopupOnOutsidePointer = (event) => {
      if (workerPopupRef.current?.contains(event.target)) return;
      if (
        event.target instanceof Element &&
        event.target.closest(".worker-marker")
      ) {
        return;
      }
      setPopupOpen(false);
    };

    document.addEventListener("pointerdown", closePopupOnOutsidePointer);
    return () =>
      document.removeEventListener("pointerdown", closePopupOnOutsidePointer);
  }, [popupOpen]);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    let currentController = null;

    const fetchWorkerData = async () => {
      if (inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      currentController = controller;
      const timeoutId = window.setTimeout(
        () => controller.abort(),
        RECEIVER_REQUEST_TIMEOUT_MS,
      );

      try {
        const fetchWorker = async (workerType) => {
          try {
            const separator = RECEIVER_API_URL.includes("?") ? "&" : "?";
            const response = await fetch(
              `${RECEIVER_API_URL}${separator}worker=${workerType}`,
              {
                cache: "no-store",
                signal: controller.signal,
              },
            );
            if (!response.ok) {
              throw new Error(`Receiver returned ${response.status}`);
            }

            const data = await response.json();
            if (
              !data ||
              typeof data !== "object" ||
              Array.isArray(data) ||
              data.worker !== workerType
            ) {
              throw new Error(`Receiver returned invalid ${workerType} data`);
            }

            const receivedAt = parseTimestamp(data.lastUpdated);
            const isWorkerOne = workerType === "WORKER1";
            const stringOrNull = (value) =>
              typeof value === "string" && value.trim() ? value.trim() : null;
            const parsed = {
              lastReceivedAt: receivedAt,
              connected: data.connected === true,
              gasAdc: isWorkerOne
                ? parseSensorValue(data.gas_adc, { min: 0 })
                : null,
              h2s: isWorkerOne
                ? null
                : parseSensorValue(data.h2s, { min: 0 }),
              temperature: parseSensorValue(data.temperature),
              humidity: parseSensorValue(data.humidity, { min: 0, max: 100 }),
              acceleration: isWorkerOne
                ? parseSensorValue(data.acceleration, { min: 0 })
                : null,
              movement: normalizeMovement(data.movement),
              turn: isWorkerOne ? stringOrNull(data.turn) : null,
              roll: isWorkerOne ? parseSensorValue(data.roll) : null,
              pitch: isWorkerOne ? parseSensorValue(data.pitch) : null,
              sos: isWorkerOne
                ? parseSosValue(data.sos)
                : null,
              sosAcknowledged:
                isWorkerOne && data.sosAcknowledged === true,
              sosEventId:
                isWorkerOne && Number.isSafeInteger(data.sosEventId)
                  ? data.sosEventId
                  : null,
              telemetryStatus: isWorkerOne
                ? stringOrNull(data.status)
                : null,
              rssi: isWorkerOne ? parseSensorValue(data.rssi) : null,
              snr: isWorkerOne ? parseSensorValue(data.snr) : null,
              packetId:
                isWorkerOne && data.packetID !== undefined && data.packetID !== null
                  ? String(data.packetID)
                  : null,
            };
            const requiredSensor = isWorkerOne ? parsed.gasAdc : parsed.h2s;
            const unavailableReadings = [
              requiredSensor,
              parsed.temperature,
              parsed.humidity,
            ].filter((value) => value === null).length;
            return {
              workerType,
              parsed,
              unavailableReadings,
              rawMovement: data.movement,
              rawSos: isWorkerOne ? data.sos : undefined,
              rawResponse: isWorkerOne ? data : undefined,
            };
          } catch (error) {
            return {
              workerType,
              error:
                error.name === "AbortError"
                  ? "Receiver request timed out."
                  : error instanceof TypeError
                    ? "Receiver unavailable. Check that receiver.js is running."
                    : error.message,
            };
          }
        };

        const results = await Promise.all([
          fetchWorker("WORKER1"),
          fetchWorker("WORKER2"),
        ]);
        if (cancelled) return;

        const successfulResults = results.filter((result) => result.parsed);
        const failedResults = results.filter((result) => result.error);
        const workerOneResult = successfulResults.find(
          (result) => result.workerType === "WORKER1",
        );
        const rawSos = workerOneResult?.rawSos;
        const currentSos = workerOneResult?.parsed.sos ?? null;
        const currentEventId = workerOneResult?.parsed.sosEventId ?? null;
        const currentEventKey =
          currentEventId ??
          workerOneResult?.parsed.lastReceivedAt ??
          "WORKER1-SOS";
        const previousSosState = previousWorkerOneSos.current;
        const previousSos = previousSosState?.sos ?? null;
        let newSosEventDetected = false;
        if (currentSos === 0 || currentSos === 1) {
          if (previousSosState === null) {
            previousWorkerOneSos.current = {
              sos: currentSos,
              eventKey: currentEventKey,
            };
          } else {
            const eventIdChanged =
              currentSos === 1 &&
              currentEventId !== null &&
              previousSosState.eventKey !== null &&
              currentEventKey !== previousSosState.eventKey;
            if (
              currentSos === 0 ||
              (currentSos === 1 && (previousSos === 0 || eventIdChanged))
            ) {
              previousWorkerOneSos.current = {
                sos: currentSos,
                eventKey: currentEventKey,
              };
            }
            if (currentSos === 1) {
              newSosEventDetected =
                previousSos === 0 || eventIdChanged;
              if (newSosEventDetected) {
                workerOneSosAlertPendingRef.current = true;
                setWorkerOneSosAlertPending(true);
                setWorkerOneSosAcknowledged(false);
              }
            } else {
              workerOneSosAlertPendingRef.current = false;
              setWorkerOneSosAlertPending(false);
              setWorkerOneSosAcknowledged(false);
            }
          }
          if (currentSos === 1 && workerOneResult?.parsed.sosAcknowledged) {
            setWorkerOneSosAcknowledged(true);
          }
        }
        if (workerOneResult) {
          console.info("[BAASC SOS] WORKER1 poll", {
            apiResponse: workerOneResult.rawResponse,
            rawSos: rawSos ?? null,
            normalizedSos: currentSos,
            previousSos,
            sosEventId: currentEventId,
            newSosEventDetected,
            acknowledged:
              currentSos === 1 && !workerOneSosAlertPendingRef.current,
          });
        }
        successfulResults.forEach(
          ({ workerType, parsed, rawMovement }) => {
            const diagnosticKey = `${parsed.lastReceivedAt}:${JSON.stringify(rawMovement)}`;
            if (movementDiagnostics.current[workerType] !== diagnosticKey) {
              console.info(`[BAASC movement] ${workerType} API telemetry`, {
                rawMovement: rawMovement ?? null,
                recognizedMovement: parsed.movement,
                connected: parsed.connected,
                lastReceivedAt: parsed.lastReceivedAt,
              });
              movementDiagnostics.current[workerType] = diagnosticKey;
            }
          },
        );
        failedResults.forEach(({ workerType, error }) => {
          if (movementDiagnostics.current[workerType] !== error) {
            console.warn(`[BAASC movement] ${workerType} API read failed`, error);
            movementDiagnostics.current[workerType] = error;
          }
        });

        setWorkers((currentWorkers) =>
          currentWorkers.map((worker) => {
            const workerType = worker.id === "W-001" ? "WORKER1" : "WORKER2";
            const result = results.find((entry) => entry.workerType === workerType);
            if (result?.parsed) {
              const isNewPacket =
                result.parsed.lastReceivedAt !== null &&
                result.parsed.lastReceivedAt !== worker.lastReceivedAt;
              const shouldAdvance =
                result.parsed.connected &&
                isNewPacket &&
                isWalkingMovement(result.parsed.movement);
              return {
                ...worker,
                ...result.parsed,
                connected: worker.connected || result.parsed.connected,
                sos:
                  workerType === "WORKER1" && result.parsed.sos === null
                    ? worker.sos
                    : result.parsed.sos,
                x: shouldAdvance
                  ? Math.min(
                      TUNNEL_PATH_MAX_X,
                      Math.max(
                        TUNNEL_PATH_MIN_X,
                        worker.x + MOVEMENT_STEP_PERCENT,
                      ),
                    )
                  : worker.x,
              };
            }
            return worker;
          }),
        );

        const latestReceivedAt = successfulResults.reduce(
          (latest, { parsed }) =>
            parsed.lastReceivedAt === null
              ? latest
              : Math.max(latest, parsed.lastReceivedAt),
          0,
        );
        if (latestReceivedAt > 0) setLastUpdate(latestReceivedAt);
        setReceiverStatus(
          successfulResults.length > 0
            ? "online"
            : failedResults.every((result) =>
                  result.error.includes("unavailable") ||
                  result.error.includes("timed out"),
                )
              ? "offline"
              : "error",
        );
        const messages = [
          ...failedResults.map(({ workerType, error }) => `${workerType}: ${error}`),
          ...successfulResults
            .filter(({ unavailableReadings }) => unavailableReadings > 0)
            .map(
              ({ workerType }) =>
                `One or more ${workerType} sensor readings are unavailable.`,
            ),
        ];
        setReceiverError(messages.join(" "));
      } finally {
        window.clearTimeout(timeoutId);
        inFlight = false;
        if (currentController === controller) currentController = null;
      }
    };

    fetchWorkerData();
    const timer = window.setInterval(
      fetchWorkerData,
      RECEIVER_POLL_INTERVAL_MS,
    );

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      currentController?.abort();
    };
  }, []);

  const activeWorker =
    workers.find((worker) => worker.id === selected) ?? workers[0];
  const activeCheckpoint = checkpoints.find(
    (gateway) => gateway.id === activeWorker.checkpointId,
  );
  const checkpointConnected = receiverStatus === "online";
  const workerOne = workers.find((worker) => worker.id === "W-001");
  const sosConditionActive = isSosActive(workerOne);
  const sosAlertVisible = sosConditionActive && workerOneSosAlertPending;
  const workerStatus = (worker) =>
    getWorkerStatus(worker, worker.id !== "W-001" || sosAlertVisible);
  const workerAlerts = (worker) =>
    getWorkerAlerts(worker, worker.id !== "W-001" || sosAlertVisible);
  const acknowledgeWorkerOneSos = () => {
    if (sosAlertVisible) {
      workerOneSosAlertPendingRef.current = false;
      setWorkerOneSosAlertPending(false);
      setWorkerOneSosAcknowledged(true);
    }
  };
  const emergencyWorker = workers.find(
    (worker) => workerStatus(worker) === "emergency",
  );
  const routeWorker = emergencyWorker ?? activeWorker;

  const selectWorker = (workerId, openMapPopup = false) => {
    setSelected(workerId);
    setPopupOpen(openMapPopup);
  };
  const popupAnchorX = 50 + (activeWorker.x - 50) * mapZoom;
  const popupToLeft = popupAnchorX >= 50;
  const popupTelemetryStatus =
    activeWorker.id === "W-001"
      ? activeWorker.sos === 1
        ? "SOS"
        : activeWorker.telemetryStatus?.toUpperCase() ??
          (activeWorker.sos === 0 ? "NORMAL" : "--")
      : "--";
  const popupDataIsStale =
    activeWorker.lastReceivedAt !== null &&
    clockTime !== null &&
    clockTime - activeWorker.lastReceivedAt > TELEMETRY_STALE_AFTER_MS;
  const popupPosition = {
    "--popup-available-width": popupToLeft
      ? `calc(${popupAnchorX}% - 22px)`
      : `calc(100% - ${popupAnchorX}% - 22px)`,
    ...(popupCoordinates ?? {}),
  };
  useLayoutEffect(() => {
    if (!popupOpen) return undefined;

    const map = tunnelMapRef.current;
    const popup = workerPopupRef.current;
    if (!map || !popup) return undefined;

    const positionPopup = () => {
      const mapRect = map.getBoundingClientRect();
      const anchorX =
        (mapRect.width * (50 + (activeWorker.x - 50) * mapZoom)) / 100;
      const anchorY =
        (mapRect.height * (50 + (activeWorker.y - 50) * mapZoom)) / 100;
      const popupWidth = popup.offsetWidth;
      const popupHeight = popup.offsetHeight;
      const margin = 8;
      const gap = 10;
      const verticalGap = 20;

      const preferredLeft = popupToLeft
        ? anchorX - popupWidth - gap
        : anchorX + gap;
      const left = Math.max(
        margin,
        Math.min(preferredLeft, mapRect.width - popupWidth - margin),
      );

      const availableAbove = anchorY - verticalGap - margin;
      const maxHeight =
        availableAbove >= 120
          ? Math.min(mapRect.height - margin * 2, availableAbove)
          : mapRect.height - margin * 2;
      const visiblePopupHeight = Math.min(popupHeight, maxHeight);
      let preferredTop =
        availableAbove >= 120
          ? anchorY - verticalGap - visiblePopupHeight
          : anchorY + verticalGap;
      const top = Math.max(
        margin,
        Math.min(preferredTop, mapRect.height - visiblePopupHeight - margin),
      );

      setPopupCoordinates((current) =>
        current?.left === left &&
        current?.top === top &&
        current?.maxHeight === maxHeight
          ? current
          : { left, top, maxHeight },
      );
    };

    positionPopup();
    const observer = new ResizeObserver(positionPopup);
    observer.observe(map);
    observer.observe(popup);
    return () => observer.disconnect();
  }, [popupOpen, activeWorker.x, activeWorker.y, mapZoom, popupToLeft]);
  const connectedWorkers = workers.filter(
    isWorkerConnectionDisplayedAsConnected,
  );
  const activeAlerts = workers.flatMap((worker) =>
    workerAlerts(worker).map((alert) => ({
      ...alert,
      worker,
      timestamp: worker.lastReceivedAt,
    })),
  );
  const alertList = workers.flatMap((worker) =>
    getWorkerAlerts(worker, true).map((alert) => ({
      ...alert,
      worker,
      timestamp: worker.lastReceivedAt,
      acknowledgementStatus:
        alert.key !== "sos"
          ? "Not required"
          : workerOneSosAcknowledged || worker.sosAcknowledged
            ? "Acknowledged"
            : "Not acknowledged",
    })),
  );
  const emergencies = activeAlerts.filter(
    (alert) => alert.severity === "emergency",
  ).length;
  const warnings = activeAlerts.filter(
    (alert) => alert.severity === "warning",
  ).length;
  const normalWorkers = workers.filter(
    (worker) => workerStatus(worker) === "normal",
  ).length;
  const statusLabel = (status) =>
    ({
      normal: "NORMAL",
      warning: "WARNING",
      emergency: "EMERGENCY",
      offline: "OFFLINE",
      unavailable: "DATA UNAVAILABLE",
      connecting: "CONNECTING",
    })[status];
  const navigateToSection = (sectionId) => {
    setActiveSection(sectionId);
    if (sectionId !== "tunnel-map") setPopupOpen(false);
    document
      .getElementById(`${sectionId}-section`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="dashboard">
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon">
            <ShieldCheck size={25} />
          </div>
          <div>
            <h2>BAASC</h2>
            <span>WORKER SAFETY SYSTEM</span>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="Dashboard sections">
          <div className="nav-label">MONITORING</div>
          <button
            type="button"
            className={`nav-item ${activeSection === "dashboard" ? "active" : ""}`}
            aria-current={activeSection === "dashboard" ? "page" : undefined}
            onClick={() => navigateToSection("dashboard")}
          >
            <Activity size={18} /> Dashboard
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === "workers" ? "active" : ""}`}
            aria-current={activeSection === "workers" ? "page" : undefined}
            onClick={() => navigateToSection("workers")}
          >
            <Users size={18} /> Workers
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === "tunnel-map" ? "active" : ""}`}
            aria-current={activeSection === "tunnel-map" ? "page" : undefined}
            onClick={() => navigateToSection("tunnel-map")}
          >
            <MapPin size={18} /> Tunnel Map
          </button>
          <button
            type="button"
            className={`nav-item ${activeSection === "alerts" ? "active" : ""}`}
            aria-current={activeSection === "alerts" ? "page" : undefined}
            onClick={() => navigateToSection("alerts")}
          >
            <Bell size={18} /> Alerts
          </button>
        </nav>

        <div className="sidebar-bottom">
          <div className="connection" title={receiverError || "Receiver API status"}>
            <span className={`online-dot ${receiverStatus}`} />
            Receiver {receiverStatus === "online"
              ? "Connected"
              : receiverStatus === "connecting"
                ? "Connecting"
                : receiverStatus === "error"
                  ? "Data error"
                  : "Offline"}
          </div>
          <p>BAASC – Breathe Awareness And Safety Care</p>
          <small>Two-worker prototype · CP-01</small>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="breadcrumb">MONITORING / OVERVIEW</p>
            <h1>Underground Safety Dashboard</h1>
          </div>
          <div className="top-right">
            <span
              className={`receiver-badge ${receiverStatus}`}
              title={receiverError || "Connection to the local Node receiver"}
            >
              <i />
              {receiverStatus === "online"
                ? "RECEIVER ONLINE"
                : receiverStatus === "connecting"
                  ? "CONNECTING"
                  : receiverStatus === "error"
                    ? "API DATA ERROR"
                    : "RECEIVER OFFLINE"}
            </span>
            <div className="supervisor">
              <div className="avatar">S</div>
              <div>
                <b>Supervisor</b>
                <small>Control Room</small>
              </div>
            </div>
          </div>
        </header>

        <section className="welcome">
          <div>
            <h2>Worker Safety Overview</h2>
            <p>
              Live CP-01 telemetry · Worker 1 reports MQ-135 gas ADC separately
              from H₂S concentration.
            </p>
          </div>
          <div className="updated">
            <Clock3 size={15} /> Updated {formatTime(lastUpdate)}
          </div>
        </section>
        {sosAlertVisible && (
          <div className="sos-emergency-banner" role="alert" aria-live="assertive">
            <AlertTriangle size={22} aria-hidden="true" />
            <strong>SOS EMERGENCY — WORKER 1 NEEDS HELP!</strong>
            <span>W-001 · SOS ACTIVE</span>
            <button
              type="button"
              onClick={acknowledgeWorkerOneSos}
              style={{
                padding: "9px 13px",
                border: "1px solid #a52323",
                borderRadius: 7,
                background: "#a52323",
                color: "#fff",
                fontSize: 10,
                fontWeight: 850,
                letterSpacing: ".6px",
                whiteSpace: "nowrap",
              }}
            >
              ACKNOWLEDGE
            </button>
          </div>
        )}
        {receiverError && (
          <div className={`receiver-notice ${receiverStatus}`} role="status">
            <AlertTriangle size={15} />
            <span>{receiverError}</span>
          </div>
        )}

        <section
          className="stats-grid"
          id="dashboard-section"
          aria-label="Prototype statistics"
        >
          <div className="stat-card">
            <div className="stat-icon blue">
              <Users />
            </div>
            <div>
              <span>TOTAL WORKERS</span>
              <strong>{workers.length}</strong>
              <small>W-001 and W-002</small>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon green">
              <RadioTower />
            </div>
            <div>
              <span>FIXED CHECKPOINTS</span>
              <strong>{checkpoints.length}</strong>
              <small>CP-01 LoRa gateway</small>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon blue">
              <Wifi />
            </div>
            <div>
              <span>CONNECTED WORKERS</span>
              <strong>{connectedWorkers.length}<small> / {workers.length}</small></strong>
              <small>Current worker links</small>
            </div>
          </div>
          <div className="stat-card">
            <div className="stat-icon red">
              <AlertTriangle />
            </div>
            <div>
              <span>ACTIVE ALERTS</span>
              <strong>{activeAlerts.length}</strong>
              <small>{emergencies} emergency · {warnings} warning</small>
            </div>
          </div>
        </section>

        <section className="content-grid">
          <div
            className="panel map-panel"
            id="tunnel-map-section"
            aria-label="Underground tunnel map and checkpoint status"
          >
            <div className="panel-heading">
              <div>
                <h3>Underground Tunnel Map</h3>
                <p>Illustrative, last-known positions · Not GPS</p>
              </div>
              <span className={`live-indicator ${receiverStatus}`}>
                <i /> {receiverStatus === "online" ? "LIVE RECEIVER" : "SCHEMATIC MAP"}
              </span>
            </div>

            <div
              className="tunnel-map"
              ref={tunnelMapRef}
              aria-label="Schematic map with fixed checkpoint CP-01 and workers W-001 and W-002"
            >
              <div className="map-world" style={{ transform: `scale(${mapZoom})` }}>
              <svg className="tunnel-svg" viewBox="0 0 1000 540" preserveAspectRatio="none" aria-hidden="true">
                <defs>
                  <linearGradient id="mineFloor" x1="0%" x2="0%" y1="0%" y2="100%">
                    <stop offset="0%" stopColor="#fafbf9" />
                    <stop offset="100%" stopColor="#e9edeb" />
                  </linearGradient>
                  <pattern id="mapGrid" width="40" height="40" patternUnits="userSpaceOnUse">
                    <path d="M40 0H0V40" fill="none" stroke="#cfd7d4" strokeOpacity=".4" strokeWidth="1" />
                  </pattern>
                  <pattern id="geoHatch" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(18)">
                    <path d="M0 4H28M0 18H28" stroke="#c3ccca" strokeOpacity=".3" strokeWidth="1" />
                    <circle cx="6" cy="11" r="1.4" fill="#aebbb7" fillOpacity=".45" />
                    <circle cx="20" cy="25" r="1" fill="#aebbb7" fillOpacity=".35" />
                  </pattern>
                </defs>

                <rect x="0" y="0" width="1000" height="540" fill="url(#mineFloor)" />
                <rect x="0" y="0" width="1000" height="540" fill="url(#mapGrid)" />
                <path d="M0 68Q155 28 285 69T560 60T1000 88V154Q810 120 650 157T345 145T0 163Z" fill="url(#geoHatch)" opacity=".48" />
                <path d="M0 427Q175 391 330 438T650 421T1000 443V540H0Z" fill="url(#geoHatch)" opacity=".55" />
                <g fill="none" stroke="#c3cdca" strokeOpacity=".54" strokeWidth="2">
                  <path d="M-20 100C80 50 176 116 280 79S468 59 570 102s215 31 310-9 131-21 150-3" />
                  <path d="M-30 118C70 68 166 134 270 97s188-20 290 23 215 31 310-9 131-21 150-3" />
                  <path d="M-18 466c96-43 193 28 292-4s189-22 284 15 207 35 301-9 131-24 154-7" />
                  <path d="M-20 487c96-43 193 28 292-4s189-22 284 15 207 35 301-9 131-24 154-7" />
                </g>

                <g fill="none" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M38 340H958" stroke="#aebbb9" strokeWidth="106" />
                  <path d="M38 340H958" stroke="#ffffff" strokeWidth="98" />
                  <path d="M38 340H958" stroke="#e1e7e4" strokeWidth="75" />
                  <path d="M280 340V270Q280 236 246 236H204V126M280 270H510V214Q510 184 540 184H566V82M510 214H734V268Q734 293 760 293H820V155M395 340V412Q395 448 360 448H342V505M610 340V412Q610 448 646 448H680V497M510 214V127M280 270V198" stroke="#aebbb9" strokeWidth="68" />
                  <path d="M280 340V270Q280 236 246 236H204V126M280 270H510V214Q510 184 540 184H566V82M510 214H734V268Q734 293 760 293H820V155M395 340V412Q395 448 360 448H342V505M610 340V412Q610 448 646 448H680V497M510 214V127M280 270V198" stroke="#ffffff" strokeWidth="61" />
                  <path d="M280 340V270Q280 236 246 236H204V126M280 270H510V214Q510 184 540 184H566V82M510 214H734V268Q734 293 760 293H820V155M395 340V412Q395 448 360 448H342V505M610 340V412Q610 448 646 448H680V497M510 214V127M280 270V198" stroke="#e4e9e6" strokeWidth="45" />
                  <path d="M246 236H510M510 214H734M360 448H646M204 236V178M820 293V217" stroke="#b6c1bf" strokeWidth="54" />
                  <path d="M246 236H510M510 214H734M360 448H646M204 236V178M820 293V217" stroke="#fcfdfb" strokeWidth="47" />
                  <path d="M246 236H510M510 214H734M360 448H646M204 236V178M820 293V217" stroke="#e5e9e6" strokeWidth="33" />
                </g>
                <path d="M50 340H950M280 330V127M510 330V83M734 330V158M395 350V503M610 350V495" fill="none" stroke="#acb8b5" strokeWidth="2" strokeDasharray="5 10" opacity=".9" />
                <g stroke="#a7b3b0" strokeOpacity=".6" strokeWidth="2" fill="#f3f5f2">
                  <circle cx="280" cy="270" r="11" />
                  <circle cx="510" cy="214" r="11" />
                  <circle cx="734" cy="268" r="11" />
                  <circle cx="395" cy="412" r="9" />
                  <circle cx="610" cy="412" r="9" />
                </g>
                <g fill="#cbd3d0" opacity=".8">
                  <rect x="92" y="326" width="2" height="28" rx="1" />
                  <rect x="151" y="326" width="2" height="28" rx="1" />
                  <rect x="874" y="326" width="2" height="28" rx="1" />
                  <rect x="912" y="326" width="2" height="28" rx="1" />
                  <rect x="270" y="294" width="20" height="2" rx="1" />
                  <rect x="500" y="254" width="20" height="2" rx="1" />
                  <rect x="724" y="294" width="20" height="2" rx="1" />
                </g>
                <path
                  d={`M 130 340 H ${routeWorker.x * 10}`}
                  fill="none"
                  stroke={emergencyWorker ? "#d83e3e" : "#738a91"}
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray="15 8"
                  opacity=".94"
                />
                {emergencyWorker && (
                  <g>
                    <circle cx={emergencyWorker.x * 10} cy="340" r="24" fill="#e54842" fillOpacity=".14" stroke="#d83e3e" strokeWidth="3" />
                    <text x={emergencyWorker.x * 10} y="302" textAnchor="middle" fill="#b82727" fontSize="15" fontWeight="700">SOS · {emergencyWorker.id}</text>
                  </g>
                )}
                <g stroke="#fff" strokeWidth="4">
                  <circle cx="130" cy="340" r="10" fill="#2f8074" />
                  <circle
                    cx={routeWorker.x * 10}
                    cy="340"
                    r="10"
                    fill={emergencyWorker ? "#d64b47" : "#738a91"}
                  />
                </g>
              </svg>

              <div className="map-direction">UNDERGROUND MAIN TUNNEL</div>
              <div className="map-view-badge">
                <span className="map-view-dot" />
                LEVEL 02 <i /> SCHEMATIC · NOT TO SCALE
              </div>
              <div className="map-branch-label branch-north">NORTH DRIFT · N-02</div>
              <div className="map-branch-label branch-rise">VENT RAISE · R-01</div>
              <div className="map-branch-label branch-east">EAST DRIFT · E-03</div>
              <div className="map-branch-label branch-service">SERVICE CROSSCUT · S-01</div>
              <div className="map-entrance-label">ENTRY · CP-01</div>
              <div className="map-exit-label">TUNNEL END / EXIT</div>
              <div className="map-junction-label j-01">J-01</div>
              <div className="map-junction-label j-02">J-02</div>
              <div className="map-junction-label j-03">J-03</div>

              {checkpoints.map((gateway) => (
                <div
                  className="checkpoint-marker"
                  key={gateway.id}
                  style={{ left: `${gateway.x}%`, top: "63%" }}
                  title={`${gateway.id} · stationary gateway`}
                >
                  <RadioTower size={18} />
                  <span>{gateway.id}</span>
                </div>
              ))}

              {workers.map((worker) => {
                const status = workerStatus(worker);
                return (
                  <Fragment key={worker.id}>
                    <button
                      className={`worker-marker ${status} ${selected === worker.id ? "selected" : ""}`}
                      style={{ left: `${worker.x}%`, top: `${worker.y}%` }}
                      onClick={() => selectWorker(worker.id, true)}
                      title={`${worker.id} · ${worker.location}`}
                      aria-label={`Select ${worker.id}, ${statusLabel(status).toLowerCase()}`}
                    >
                      <HardHat size={17} />
                      <span>{worker.id}</span>
                    </button>
                  </Fragment>
                );
              })}
              </div>

              <div className="map-control-stack" aria-label="Map zoom controls">
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setMapZoom((zoom) => Math.min(1.6, +(zoom + 0.15).toFixed(2)))}
                >
                  <Plus size={16} />
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => setMapZoom((zoom) => Math.max(1, +(zoom - 0.15).toFixed(2)))}
                >
                  <Minus size={16} />
                </button>
                <span>{Math.round(mapZoom * 100)}%</span>
              </div>

              <div
                className={`map-route-chip ${emergencyWorker ? "rescue-route" : ""} ${activeWorker.connected && isWalkingMovement(activeWorker.movement) && !emergencyWorker ? "detected-movement" : ""}`}
              >
                {emergencyWorker ? (
                  <AlertTriangle size={13} />
                ) : (
                  <Navigation size={13} />
                )}
                <span>
                  {emergencyWorker
                    ? `RESCUE ALERT · ${emergencyWorker.id}`
                    : !activeWorker.connected && activeWorker.id !== "W-001"
                      ? `WORKER OFFLINE · ${activeWorker.id}`
                      : isWalkingMovement(activeWorker.movement)
                        ? `DETECTED WALKING · ${activeWorker.id} · SCHEMATIC`
                        : activeWorker.movement === "Stationary"
                          ? `STATIONARY · ${activeWorker.id}`
                          : activeWorker.movement
                            ? `${activeWorker.movement.toUpperCase()} · ${activeWorker.id}`
                            : `MOVEMENT DATA UNAVAILABLE · ${activeWorker.id}`}
                </span>
              </div>

              {popupOpen && activeWorker && (
                  <div
                    className="map-worker-popup"
                    ref={workerPopupRef}
                    style={popupPosition}
                    role="dialog"
                    aria-label={`${activeWorker.name} details`}
                  >
                    <div className="worker-popup-header">
                      <div className="worker-popup-heading">
                        <span className="popup-eyebrow">WORKER DETAILS</span>
                        <h4>{activeWorker.name}</h4>
                        <span className="popup-worker-subtitle">
                          {activeWorker.id} · Helmet-mounted unit
                        </span>
                      </div>
                      <button
                        type="button"
                        className="popup-close"
                        aria-label="Close worker details"
                        onClick={() => setPopupOpen(false)}
                      >
                        ×
                      </button>
                    </div>
                    <div className="popup-status-row">
                      <span
                        className={`popup-telemetry-badge ${
                          popupTelemetryStatus === "SOS" ? "emergency" : ""
                        }`}
                      >
                        {popupTelemetryStatus}
                      </span>
                      <span
                        className={`popup-connection-badge ${
                          isWorkerConnectionDisplayedAsConnected(activeWorker)
                            ? "connected"
                            : "disconnected"
                        }`}
                      >
                        <i />
                        {isWorkerConnectionDisplayedAsConnected(activeWorker)
                          ? "CONNECTED"
                          : "DISCONNECTED"}
                      </span>
                    </div>
                    {popupDataIsStale && (
                      <div className="popup-stale-notice" role="status">
                        Telemetry is stale · values are last received, not live
                      </div>
                    )}
                    <div
                      className={`popup-metric-grid ${
                        activeWorker.id === "W-002" ? "three-metrics" : ""
                      }`}
                    >
                      <div className="popup-metric-card">
                        <Wind size={17} />
                        <span>
                          {activeWorker.id === "W-001" ? "MQ-135 GAS ADC" : "H₂S"}
                        </span>
                        <strong>
                          {formatMetric(
                            activeWorker.id === "W-001"
                              ? activeWorker.gasAdc
                              : activeWorker.h2s,
                            activeWorker.id === "W-001" ? 0 : 1,
                          )}
                          {Number.isFinite(
                            activeWorker.id === "W-001"
                              ? activeWorker.gasAdc
                              : activeWorker.h2s,
                          ) && (
                            <small>
                              {activeWorker.id === "W-001" ? "ADC" : "ppm"}
                            </small>
                          )}
                        </strong>
                      </div>
                      <div className="popup-metric-card">
                        <Thermometer size={17} />
                        <span>TEMPERATURE</span>
                        <strong>
                          {formatMetric(activeWorker.temperature)}
                          {Number.isFinite(activeWorker.temperature) && (
                            <small>°C</small>
                          )}
                        </strong>
                      </div>
                      <div className="popup-metric-card">
                        <Droplets size={17} />
                        <span>RELATIVE HUMIDITY</span>
                        <strong>
                          {formatMetric(
                            activeWorker.humidity,
                            activeWorker.id === "W-001" ? 1 : 0,
                          )}
                          {Number.isFinite(activeWorker.humidity) && (
                            <small>%</small>
                          )}
                        </strong>
                      </div>
                      {activeWorker.id === "W-001" && (
                        <div className="popup-metric-card">
                          <Activity size={17} />
                          <span>ACCELERATION</span>
                          <strong>
                            {formatMetric(activeWorker.acceleration, 2)}
                            {Number.isFinite(activeWorker.acceleration) && (
                              <small>g</small>
                            )}
                          </strong>
                        </div>
                      )}
                    </div>
                    <section className="popup-info-section">
                      <h5>Worker Safety</h5>
                      <dl className="popup-info-list">
                        <div>
                          <dt>Movement</dt>
                          <dd>
                            {activeWorker.movement === "Walking"
                              ? "MOVING"
                              : activeWorker.movement?.toUpperCase() ?? "No data"}
                          </dd>
                        </div>
                        <div>
                          <dt>Turn</dt>
                          <dd>{activeWorker.turn?.toUpperCase() ?? "No data"}</dd>
                        </div>
                        <div>
                          <dt>SOS</dt>
                          <dd>
                            {activeWorker.id === "W-001" &&
                            activeWorker.sos !== null
                              ? activeWorker.sos
                              : "--"}
                          </dd>
                        </div>
                        <div>
                          <dt>Telemetry status</dt>
                          <dd>{popupTelemetryStatus}</dd>
                        </div>
                      </dl>
                    </section>
                    <section className="popup-info-section popup-communication">
                      <h5>Communication</h5>
                      <dl className="popup-info-list">
                        <div>
                          <dt>LoRa connection</dt>
                          <dd>
                            {isWorkerConnectionDisplayedAsConnected(activeWorker)
                              ? "Connected"
                              : "Disconnected"}
                          </dd>
                        </div>
                        <div>
                          <dt>Last received</dt>
                          <dd>
                            {formatReceivedTimestamp(activeWorker.lastReceivedAt)}
                          </dd>
                        </div>
                        <div>
                          <dt>Checkpoint</dt>
                          <dd>{activeCheckpoint?.id ?? "CP-01"}</dd>
                        </div>
                      </dl>
                    </section>
                    <details className="popup-technical-details">
                      <summary>Technical Details</summary>
                      <dl className="popup-info-list">
                        <div>
                          <dt>RSSI / SNR</dt>
                          <dd>
                            {activeWorker.id === "W-001" &&
                            Number.isFinite(activeWorker.rssi) &&
                            Number.isFinite(activeWorker.snr)
                              ? `${formatMetric(activeWorker.rssi, 0)} dBm / ${formatMetric(activeWorker.snr)} dB`
                              : "--"}
                          </dd>
                        </div>
                        <div>
                          <dt>Packet ID</dt>
                          <dd>
                            {activeWorker.id === "W-001"
                              ? activeWorker.packetId ?? "--"
                              : "--"}
                          </dd>
                        </div>
                        <div>
                          <dt>Roll / Pitch</dt>
                          <dd>
                            {activeWorker.id === "W-001" &&
                            Number.isFinite(activeWorker.roll) &&
                            Number.isFinite(activeWorker.pitch)
                              ? `${formatMetric(activeWorker.roll)}° / ${formatMetric(activeWorker.pitch)}°`
                              : "--"}
                          </dd>
                        </div>
                      </dl>
                    </details>
                  </div>
              )}

              <div className="map-legend">
                <span>
                  <RadioTower size={14} /> Fixed gateway
                </span>
                <span>
                  <HardHat size={14} /> Worker unit
                </span>
                <span>
                  <i className="legend-route" /> Illustrative route
                </span>
                <span>
                  <i className="legend-dot normal" /> Normal
                </span>
                <span>
                  <i className="legend-dot warning" /> Warning
                </span>
                <span>
                  <i className="legend-dot emergency" /> Emergency
                </span>
                <span>
                  <i className="legend-dot offline" /> Offline / unavailable
                </span>
              </div>
            </div>
            <div className="map-note">
              <MapPin size={14} /> Worker positions and routes are schematic,
              last-known references—not precise tracking. CP-01 is the only gateway.
            </div>

            {checkpoints.map((gateway) => {
              const gatewayWorkers = workers.filter(
                (worker) =>
                  worker.checkpointId === gateway.id &&
                  isWorkerConnectionDisplayedAsConnected(worker),
              ).length;
              return (
                <section
                  className="checkpoint-card"
                  aria-label={`${gateway.id} gateway status`}
                  key={gateway.id}
                >
                  <div className="checkpoint-icon">
                    <RadioTower size={22} />
                  </div>
                  <div className="checkpoint-info">
                    <div className="checkpoint-title">
                      <div>
                        <span className="eyebrow">FIXED CHECKPOINT</span>
                        <h4>{gateway.id}</h4>
                      </div>
                      <span
                        className={`status-badge ${checkpointConnected ? "normal" : "offline"}`}
                      >
                        {checkpointConnected ? "ONLINE" : "OFFLINE"}
                      </span>
                    </div>
                    <p>{gateway.name} · {gateway.location}</p>
                    <div className="checkpoint-meta">
                      <span>
                        <Wifi size={14} />
                        {checkpointConnected ? "Connected" : "Disconnected"}
                      </span>
                      <span>
                        <Clock3 size={14} /> Last communication{" "}
                        {formatTime(lastUpdate)}
                      </span>
                      <span>
                        <Users size={14} /> {gatewayWorkers} of {workers.length} workers
                      </span>
                    </div>
                  </div>
                </section>
              );
            })}
          </div>

          <div className="panel worker-panel" id="workers-section">
            <div className="panel-heading">
              <div>
                <h3>Workers</h3>
                <p>Individual status · Latest available receiver readings</p>
              </div>
              <Users size={19} />
            </div>
            <div className="worker-cards">
              {workers.map((worker) => {
                const connected = isWorkerConnectionDisplayedAsConnected(worker);
                const metrics =
                  worker.id === "W-001"
                    ? [
                        {
                          label: "MQ-135 gas",
                          value: formatMetric(worker.gasAdc, 0),
                          unit: Number.isFinite(worker.gasAdc) ? "ADC" : "",
                        },
                        {
                          label: "Temperature",
                          value: formatMetric(worker.temperature),
                          unit: Number.isFinite(worker.temperature) ? "°C" : "",
                        },
                        {
                          label: "Humidity",
                          value: formatMetric(worker.humidity, 1),
                          unit: Number.isFinite(worker.humidity) ? "%" : "",
                        },
                        {
                          label: "Acceleration",
                          value: formatMetric(worker.acceleration, 2),
                          unit: Number.isFinite(worker.acceleration) ? "g" : "",
                        },
                      ]
                    : [
                        {
                          label: "H₂S",
                          value: formatMetric(worker.h2s),
                          unit: Number.isFinite(worker.h2s) ? "ppm" : "",
                        },
                        {
                          label: "Temperature",
                          value: formatMetric(worker.temperature),
                          unit: Number.isFinite(worker.temperature) ? "°C" : "",
                        },
                        {
                          label: "Humidity",
                          value: formatMetric(worker.humidity),
                          unit: Number.isFinite(worker.humidity) ? "%" : "",
                        },
                      ];
                return (
                  <article className="worker-summary-card" key={worker.id}>
                    <div className="worker-summary-heading">
                      <div className="worker-summary-avatar">
                        <HardHat size={19} />
                      </div>
                      <div>
                        <h4>{worker.name}</h4>
                        <span>{worker.id} · Helmet-mounted unit</span>
                      </div>
                      <span
                        className={`worker-summary-connection ${
                          connected ? "connected" : "disconnected"
                        }`}
                      >
                        <i />
                        {connected ? "CONNECTED" : "DISCONNECTED"}
                      </span>
                    </div>
                    <div className="worker-summary-metrics">
                      {metrics.map((metric) => (
                        <div key={metric.label}>
                          <span>{metric.label}</span>
                          <strong>
                            {metric.value}
                            {metric.unit && <small> {metric.unit}</small>}
                          </strong>
                        </div>
                      ))}
                    </div>
                    <div className="worker-summary-footer">
                      <span>
                        SOS{" "}
                        <strong>
                          {worker.id === "W-001" && worker.sos !== null
                            ? worker.sos
                            : "--"}
                        </strong>
                      </span>
                      <span>
                        Last received{" "}
                        <strong>
                          {worker.lastReceivedAt === null
                            ? "No recent data"
                            : formatTime(worker.lastReceivedAt)}
                        </strong>
                      </span>
                      <button
                        type="button"
                        className="view-button"
                        onClick={() => {
                          selectWorker(worker.id, true);
                          navigateToSection("tunnel-map");
                        }}
                      >
                        View on map
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="panel alerts-panel" id="alerts-section">
          <div className="panel-heading">
            <div>
              <h3>Worker Safety Status</h3>
              <p>Automatically assessed from current sensor readings</p>
            </div>
            <span className="alert-count">{alertList.length} CURRENT ALERTS</span>
          </div>

          <div className="safety-summary">
            <span><i className="legend-dot normal" /> {normalWorkers} normal</span>
            <span><i className="legend-dot warning" /> {warnings} warning</span>
            <span><i className="legend-dot emergency" /> {emergencies} emergency</span>
          </div>
          {alertList.map((alert) => {
            const status = alert.severity;
            return (
              <div
                className={`alert-row ${status}`}
                key={`${alert.worker.id}-${alert.key}`}
              >
                <div className="alert-symbol">
                  <AlertTriangle size={18} />
                </div>
                <div className="alert-description">
                  <b>
                    {status === "emergency"
                      ? `${alert.label} emergency`
                      : `${alert.label} warning`}
                  </b>
                  <span>
                    {alert.worker.id} ·{" "}
                    {alert.key === "sos"
                      ? "SOS signal active"
                      : `${alert.label}: ${formatMetric(alert.value)} ${alert.unit}`}
                    {" · "}Received {formatTime(alert.timestamp)}
                  </span>
                </div>
                <span className={`status-badge ${status}`}>
                  {statusLabel(status)}
                </span>
                <span
                  className={`acknowledgement-status ${
                    alert.acknowledgementStatus === "Acknowledged"
                      ? "acknowledged"
                      : alert.key === "sos"
                        ? "pending"
                        : "not-required"
                  }`}
                >
                  {alert.acknowledgementStatus}
                </span>
                <button
                  className="view-button"
                  onClick={() => {
                    selectWorker(alert.worker.id, true);
                    navigateToSection("tunnel-map");
                  }}
                >
                  View worker
                </button>
              </div>
            );
          })}
          {alertList.length === 0 && (
            <p className="no-alerts">No active worker safety alerts.</p>
          )}
        </section>

        <footer className="footer">
          <span>BAASC – Breathe Awareness And Safety Care</span>
          <span>
            <Wifi size={14} /> Live CP-01 receiver data · schematic positions only
          </span>
        </footer>
      </main>
    </div>
  );
}

export default App;
