#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <math.h>
#include <stdlib.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL =
  "http://192.168.137.1:3000/api/worker-data";

#define LORA_SS 5
#define LORA_RST 14
#define LORA_DIO0 26
#define LORA_FREQ 433E6

const unsigned long RECENT_DATA_TIMEOUT_MS = 30000UL;
const unsigned long STATUS_PRINT_INTERVAL_MS = 5000UL;
const unsigned long WIFI_RETRY_INTERVAL_MS = 10000UL;

unsigned long worker1LastSeenMs = 0;
unsigned long worker2LastSeenMs = 0;
unsigned long worker1PacketCount = 0;
unsigned long worker2PacketCount = 0;
unsigned long lastStatusPrintMs = 0;
unsigned long lastWiFiCheckMs = 0;
bool worker1HasReceived = false;
bool worker2HasReceived = false;

String lastWorker1Data;
String lastWorker2Data;

String getHeaderToken(const String& message, unsigned int tokenIndex) {
  int tokenStart = 0;

  for (unsigned int current = 0; current < tokenIndex; current++) {
    const int separator = message.indexOf(',', tokenStart);
    if (separator < 0) {
      return "";
    }
    tokenStart = separator + 1;
  }

  int tokenEnd = message.indexOf(',', tokenStart);
  if (tokenEnd < 0) {
    tokenEnd = message.length();
  }
  return message.substring(tokenStart, tokenEnd);
}

String getField(const String& message, const String& field) {
  const String key = field + "=";
  int searchFrom = 0;

  while (true) {
    const int keyStart = message.indexOf(key, searchFrom);
    if (keyStart < 0) {
      return "";
    }

    const bool atFieldBoundary =
      keyStart == 0 || message.charAt(keyStart - 1) == ',';
    if (!atFieldBoundary) {
      searchFrom = keyStart + key.length();
      continue;
    }

    const int valueStart = keyStart + key.length();
    int valueEnd = message.indexOf(',', valueStart);
    if (valueEnd < 0) {
      valueEnd = message.length();
    }
    return message.substring(valueStart, valueEnd);
  }
}

bool isNumericField(const String& value) {
  if (value.length() == 0) {
    return false;
  }

  char* end = nullptr;
  const char* start = value.c_str();
  const double number = strtod(start, &end);
  return end != start && *end == '\0' && isfinite(number);
}

String jsonEscape(const String& value) {
  String escaped;
  escaped.reserve(value.length() + 4);
  for (unsigned int i = 0; i < value.length(); i++) {
    const char character = value.charAt(i);
    if (character == '"' || character == '\\') {
      escaped += '\\';
    }
    if (character == '\n') {
      escaped += "\\n";
    } else if (character == '\r') {
      escaped += "\\r";
    } else {
      escaped += character;
    }
  }
  return escaped;
}

void connectWiFi() {
  Serial.println();
  Serial.println("Connecting to Wi-Fi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Wi-Fi CONNECTED");
    Serial.print("CP-01 IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi CONNECTION FAILED; LoRa reception will continue");
  }
}

void displayWorkerData(
  const String& workerId,
  const String& message,
  int rssi,
  float snr
) {
  Serial.println();
  Serial.println("========== RECEIVED WORKER DATA ==========");
  Serial.print("Worker: ");
  Serial.println(workerId);
  Serial.print("Packet ID: ");
  Serial.println(getHeaderToken(message, 2));
  Serial.print("Gas ADC: ");
  Serial.println(getField(message, "GAS_ADC"));
  Serial.print("Temperature: ");
  Serial.println(getField(message, "TEMP"));
  Serial.print("Humidity: ");
  Serial.println(getField(message, "HUM"));
  Serial.print("Acceleration: ");
  Serial.println(getField(message, "ACC"));
  Serial.print("Movement: ");
  Serial.println(getField(message, "MOVEMENT"));
  Serial.print("Turning: ");
  Serial.println(getField(message, "TURN"));
  Serial.print("Roll: ");
  Serial.println(getField(message, "ROLL"));
  Serial.print("Pitch: ");
  Serial.println(getField(message, "PITCH"));
  Serial.print("SOS: ");
  Serial.println(getField(message, "SOS"));
  Serial.print("Status: ");
  Serial.println(getField(message, "STATUS"));
  Serial.print("RSSI: ");
  Serial.println(rssi);
  Serial.print("SNR: ");
  Serial.println(snr, 1);
  Serial.println("==========================================");
}

bool worker1FieldsAreValid(const String& message) {
  const char* numericFields[] = {
    "GAS_ADC", "TEMP", "HUM", "ACC", "ROLL", "PITCH", "SOS"
  };
  for (const char* field : numericFields) {
    if (!isNumericField(getField(message, field))) {
      Serial.print("Cannot forward: missing/invalid numeric field ");
      Serial.println(field);
      return false;
    }
  }

  const char* textFields[] = {"MOVEMENT", "TURN", "STATUS"};
  for (const char* field : textFields) {
    if (getField(message, field).length() == 0) {
      Serial.print("Cannot forward: missing text field ");
      Serial.println(field);
      return false;
    }
  }
  return true;
}

void sendWorker1ToServer(
  const String& message,
  const String& packetId,
  int rssi,
  float snr
) {
  if (!worker1FieldsAreValid(message)) {
    return;
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("HTTP forward skipped: Wi-Fi is disconnected");
    return;
  }

  const String movement = getField(message, "MOVEMENT");
  String json;
  json.reserve(320);
  json = "{";
  json += "\"worker\":\"WORKER1\",";
  json += "\"packetID\":\"" + jsonEscape(packetId) + "\",";
  json += "\"gas_adc\":" + getField(message, "GAS_ADC") + ",";
  json += "\"temperature\":" + getField(message, "TEMP") + ",";
  json += "\"humidity\":" + getField(message, "HUM") + ",";
  json += "\"acceleration\":" + getField(message, "ACC") + ",";
  json += "\"movement\":\"" + jsonEscape(movement) + "\",";
  json += "\"turn\":\"" + jsonEscape(getField(message, "TURN")) + "\",";
  json += "\"roll\":" + getField(message, "ROLL") + ",";
  json += "\"pitch\":" + getField(message, "PITCH") + ",";
  json += "\"sos\":" + getField(message, "SOS") + ",";
  json += "\"status\":\"" + jsonEscape(getField(message, "STATUS")) + "\",";
  json += "\"rssi\":" + String(rssi) + ",";
  json += "\"snr\":" + String(snr, 1);
  json += "}";

  Serial.println();
  Serial.println("Forwarding received WORKER1 packet to Node.js:");
  Serial.print("URL: ");
  Serial.println(SERVER_URL);
  Serial.print("Movement forwarded unchanged: ");
  Serial.println(movement);
  Serial.println(json);

  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  if (!http.begin(SERVER_URL)) {
    Serial.println("HTTP begin failed; packet was received but not forwarded");
    return;
  }

  http.addHeader("Content-Type", "application/json");
  const int httpCode = http.POST(json);
  Serial.print("HTTP response code: ");
  Serial.println(httpCode);
  if (httpCode > 0) {
    Serial.print("HTTP response body: ");
    Serial.println(http.getString());
  } else {
    Serial.print("HTTP request failed: ");
    Serial.println(http.errorToString(httpCode));
  }
  http.end();
}

void receiveWorkerData() {
  const int packetSize = LoRa.parsePacket();
  if (packetSize <= 0) {
    return;
  }

  String receivedMessage;
  receivedMessage.reserve(packetSize);
  while (LoRa.available()) {
    receivedMessage += static_cast<char>(LoRa.read());
  }

  const int rssi = LoRa.packetRssi();
  const float snr = LoRa.packetSnr();
  const String packetType = getHeaderToken(receivedMessage, 0);
  const String workerId = getHeaderToken(receivedMessage, 1);

  Serial.println();
  Serial.println("========== LORA PACKET RECEIVED ==========");
  Serial.print("Complete packet: ");
  Serial.println(receivedMessage);
  Serial.print("Parsed packet type: ");
  Serial.println(packetType);
  Serial.print("Parsed worker ID: ");
  Serial.println(workerId);

  if (packetType != "DATA" ||
      (workerId != "WORKER1" && workerId != "WORKER2")) {
    Serial.println("Packet ignored: unexpected packet type or worker ID");
    Serial.println("==========================================");
    return;
  }

  const unsigned long receivedAtMs = millis();
  if (workerId == "WORKER1") {
    worker1LastSeenMs = receivedAtMs;
    worker1HasReceived = true;
    worker1PacketCount++;
    lastWorker1Data = receivedMessage;

    Serial.print("Worker 1 packet count: ");
    Serial.println(worker1PacketCount);
    Serial.print("Worker 1 last-received uptime (ms): ");
    Serial.println(worker1LastSeenMs);
    Serial.print("Worker 1 movement parsed: ");
    Serial.println(getField(receivedMessage, "MOVEMENT"));

    displayWorkerData(workerId, receivedMessage, rssi, snr);
    sendWorker1ToServer(
      receivedMessage,
      getHeaderToken(receivedMessage, 2),
      rssi,
      snr
    );

    if (getField(receivedMessage, "SOS") == "1") {
      Serial.println("!!!!!!!! SOS EMERGENCY: WORKER 1 NEEDS HELP !!!!!!!!");
    }
  } else {
    worker2LastSeenMs = receivedAtMs;
    worker2HasReceived = true;
    worker2PacketCount++;
    lastWorker2Data = receivedMessage;

    Serial.print("Worker 2 packet count: ");
    Serial.println(worker2PacketCount);
    Serial.print("Worker 2 last-received uptime (ms): ");
    Serial.println(worker2LastSeenMs);
    displayWorkerData(workerId, receivedMessage, rssi, snr);
  }
  Serial.println("==========================================");
}

void printWorkerFreshness(
  const char* label,
  bool hasReceived,
  unsigned long lastSeenMs,
  unsigned long packetCount,
  unsigned long nowMs
) {
  Serial.print(label);
  Serial.print(" packets (since boot): ");
  Serial.println(packetCount);

  if (!hasReceived) {
    Serial.print(label);
    Serial.println(": NO DATA RECEIVED SINCE BOOT");
    return;
  }

  const unsigned long ageMs = nowMs - lastSeenMs;
  Serial.print(label);
  Serial.print(" last received at uptime (ms): ");
  Serial.println(lastSeenMs);
  Serial.print(label);
  Serial.print(" packet age (ms): ");
  Serial.println(ageMs);

  Serial.print(label);
  Serial.println(
    ageMs < RECENT_DATA_TIMEOUT_MS
      ? ": CONNECTED / RECENT"
      : ": NO RECENT DATA (timeout exceeded)"
  );
}

void printCheckpointStatus() {
  const unsigned long nowMs = millis();
  if (nowMs - lastStatusPrintMs < STATUS_PRINT_INTERVAL_MS) {
    return;
  }
  lastStatusPrintMs = nowMs;

  Serial.println();
  Serial.println("============= CP-01 STATUS =============");
  printWorkerFreshness(
    "Worker 1",
    worker1HasReceived,
    worker1LastSeenMs,
    worker1PacketCount,
    nowMs
  );
  printWorkerFreshness(
    "Worker 2",
    worker2HasReceived,
    worker2LastSeenMs,
    worker2PacketCount,
    nowMs
  );
  Serial.print("Wi-Fi: ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
  Serial.println("========================================");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println();
  Serial.println("========================================");
  Serial.println("       CP-01 CHECKPOINT GATEWAY");
  Serial.println("========================================");

  connectWiFi();

  SPI.begin(18, 19, 23, LORA_SS);
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQ)) {
    Serial.println("LoRa initialization failed");
    while (true) {
      delay(1000);
    }
  }

  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x12);
  LoRa.enableCrc();

  Serial.println("LoRa initialized: 433 MHz, SF7, BW125 kHz, CR4/5, sync 0x12");
  Serial.println("CP-01 ready; listening for DATA packets");
}

void loop() {
  receiveWorkerData();
  printCheckpointStatus();

  const unsigned long nowMs = millis();
  if (nowMs - lastWiFiCheckMs >= WIFI_RETRY_INTERVAL_MS) {
    lastWiFiCheckMs = nowMs;
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("Wi-Fi disconnected; attempting reconnect");
      WiFi.reconnect();
    }
  }
}
