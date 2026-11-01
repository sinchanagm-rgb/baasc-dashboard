# BAASC Underground Worker Safety Dashboard

The dashboard displays the current prototype configuration: two workers, one
stationary LoRa gateway (CP-01), and schematic—not GPS—worker positions.

## Run locally

1. Start the existing Node receiver: `node receiver.js` (port 3000).
2. In another terminal, install dependencies with `npm install` if needed.
3. Start the React dashboard with `npm run dev`.

The dashboard polls `http://localhost:3000/api/worker-data?worker=WORKER1`
and `?worker=WORKER2` every three seconds. Each worker has its own stored
latest packet; the existing no-query endpoint continues to return the most
recent packet received. The receiver accepts WORKER1's packet fields:
`packetID`, `gas_adc`,
`temperature`, `humidity`, `acceleration`, `movement`, `turn`, `roll`,
`pitch`, `sos`, `status`, `rssi`, and `snr`. Every accepted packet includes
server-generated `lastUpdated` and `connected` fields. To use a different
receiver URL, set `VITE_RECEIVER_URL` to the full `/api/worker-data` URL before
starting Vite.

Worker 1 SOS acknowledgements are supervisor state, separate from the incoming
`sos` telemetry. A new `0` to `1` transition increments `sosEventId` and clears
the previous acknowledgement. The dashboard can acknowledge that specific
event with `POST /api/worker-data/acknowledge`, sending
`{"worker":"WORKER1","sosEventId":1}`. Worker reads include `sosEventId` and
`sosAcknowledged`; acknowledging never changes `sos`. This state is shared by
dashboard tabs while the Node receiver is running, but resets when the receiver
process restarts.

WORKER1 maps to W-001 and displays the raw MQ-135 value as ADC counts, not H₂S
ppm. Its SOS flag or `status: "SOS"` raises an emergency alert. W-002 remains
offline until an actual WORKER2 packet is received. Unavailable or invalid
readings display as `--`; data older than 30 seconds is treated as stale.
Worker positions remain schematic rather than GPS-based.

The map advances a connected worker's icon along the existing main-tunnel
schematic only when a new backend packet reports `movement: "Walking"` (also
accepts `walk` or `moving`). A repeated poll of the same packet does not move
the icon again. `Stationary`, unknown movement, disconnected data, or stale
data does not advance it. The MPU6050 does not provide tunnel coordinates, so
this visual progression is a movement indication only, not a measured location.

`CP01_Checkpoint.ino` contains the CP-01 gateway sketch based on the source
provided for this project. Set its Wi-Fi credentials and verify the server IP
before flashing. It parses the worker ID and packet ID from the LoRa header,
updates last-seen time and packet count together for each accepted packet,
prints the packet age used by the 30-second freshness check, and forwards
Worker 1 telemetry—including `MOVEMENT` unchanged—to `receiver.js`. Worker-side
MPU6050 classification remains in the Worker ESP32 firmware: it must include
`MOVING` or `WALKING` in the LoRa packet for the dashboard to detect movement.
`receiver.js` already stores and returns the `movement` field.

After changing `receiver.js`, restart the Node receiver process so it loads the
updated code. Confirm the new process is running by requesting
`http://localhost:3000/`; the JSON includes `version: "worker-routing-v2"`.
POST logs include the request URL, raw and parsed body, extracted worker ID,
validation result, and stored temperature/humidity. If `?worker=WORKER1`
returns a WORKER2 record or the health response has no version, an older Node
receiver process is still serving port 3000.

Safety thresholds are configured in `src/App.jsx` in `safetyThresholds`:

- H₂S: warning at 10 ppm, emergency at 20 ppm.
- Temperature: warning at 35 °C, emergency at 40 °C.
- Relative humidity: warning at 85%.

## Validation

- `npm run lint`
- `npm run build`
