#include <WiFi.h>
#include <HTTPClient.h>
#include <SPI.h>
#include <LoRa.h>
#include <freertos/FreeRTOS.h>
#include <freertos/queue.h>
#include <string.h>

const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL =
  "http://192.168.137.1:3000/api/worker-data";

#define LORA_SS       5
#define LORA_RST      14
#define LORA_DIO0     26
#define LORA_SCK      18
#define LORA_MISO     19
#define LORA_MOSI     23
#define LORA_FREQUENCY 433E6

#define QUEUE_SIZE 30
#define JSON_SIZE 900

const unsigned long STATUS_INTERVAL_MS = 10000UL;
const unsigned long SCAN_DIAGNOSTIC_INTERVAL_MS = 1000UL;
const unsigned long WIFI_RETRY_INTERVAL_MS = 5000UL;
const unsigned long RECEIVER_CHECK_INTERVAL_MS = 3000UL;

struct WorkerPacket {
  char worker[12];
  char json[JSON_SIZE];
};

QueueHandle_t httpQueue = nullptr;
unsigned long worker1Packets = 0;
unsigned long worker2Packets = 0;
unsigned long lastStatusMs = 0;
unsigned long lastScanDiagnosticMs = 0;
unsigned long lastWiFiCheckMs = 0;
unsigned long lastReceiverCheckMs = 0;

String getField(const String& packet, const String& key) {
  const String searchKey = key + "=";
  int searchFrom = 0;

  while (true) {
    const int start = packet.indexOf(searchKey, searchFrom);
    if (start < 0) return "";
    if (start != 0 && packet.charAt(start - 1) != ',') {
      searchFrom = start + searchKey.length();
      continue;
    }

    const int valueStart = start + searchKey.length();
    int valueEnd = packet.indexOf(',', valueStart);
    if (valueEnd < 0) valueEnd = packet.length();
    return packet.substring(valueStart, valueEnd);
  }
}

String getWorkerID(const String& packet) {
  const int firstComma = packet.indexOf(',');
  if (firstComma < 0) return "";
  const int secondComma = packet.indexOf(',', firstComma + 1);
  if (secondComma < 0) return "";
  return packet.substring(firstComma + 1, secondComma);
}

String getPacketID(const String& packet) {
  const int firstComma = packet.indexOf(',');
  if (firstComma < 0) return "";
  const int secondComma = packet.indexOf(',', firstComma + 1);
  if (secondComma < 0) return "";
  const int thirdComma = packet.indexOf(',', secondComma + 1);
  if (thirdComma < 0) return packet.substring(secondComma + 1);
  return packet.substring(secondComma + 1, thirdComma);
}

int getInteger(const String& packet, const String& key, int defaultValue = 0) {
  const String value = getField(packet, key);
  return value.length() == 0 ? defaultValue : value.toInt();
}

bool parseWorker1(
  const String& packet,
  int rssi,
  float snr,
  char* json
) {
  const String packetID = getPacketID(packet);
  const String gas = getField(packet, "GAS_ADC");
  const String temp = getField(packet, "TEMP");
  const String hum = getField(packet, "HUM");
  const String acc = getField(packet, "ACC");
  const String movement = getField(packet, "MOVEMENT");
  const String turn = getField(packet, "TURN");
  const String roll = getField(packet, "ROLL");
  const String pitch = getField(packet, "PITCH");
  const String sos = getField(packet, "SOS");
  const String status = getField(packet, "STATUS");

  if (
    packetID.length() == 0 ||
    gas.length() == 0 ||
    temp.length() == 0 ||
    hum.length() == 0 ||
    acc.length() == 0 ||
    movement.length() == 0 ||
    turn.length() == 0 ||
    roll.length() == 0 ||
    pitch.length() == 0 ||
    sos.length() == 0 ||
    status.length() == 0
  ) {
    Serial.println("Packet rejected: WORKER1 fields are incomplete");
    return false;
  }

  const int sosValue = sos.toInt();
  if (sosValue != 0 && sosValue != 1) {
    Serial.println("Packet rejected: SOS must be 0 or 1");
    return false;
  }

  const int written = snprintf(
    json,
    JSON_SIZE,
    "{"
      "\"worker\":\"WORKER1\","
      "\"packetID\":\"%s\","
      "\"gas_adc\":%d,"
      "\"temperature\":%.2f,"
      "\"humidity\":%.2f,"
      "\"acceleration\":%.2f,"
      "\"movement\":\"%s\","
      "\"turn\":\"%s\","
      "\"roll\":%.2f,"
      "\"pitch\":%.2f,"
      "\"sos\":%d,"
      "\"status\":\"%s\","
      "\"rssi\":%d,"
      "\"snr\":%.2f"
    "}",
    packetID.c_str(),
    gas.toInt(),
    temp.toFloat(),
    hum.toFloat(),
    acc.toFloat(),
    movement.c_str(),
    turn.c_str(),
    roll.toFloat(),
    pitch.toFloat(),
    sosValue,
    status.c_str(),
    rssi,
    snr
  );
  return written >= 0 && written < JSON_SIZE;
}

bool parseWorker2(const String& packet, char* json) {
  const String h2s = getField(packet, "H2S");
  const String temp = getField(packet, "TEMP");
  const String hum = getField(packet, "HUM");
  const String movement = getField(packet, "MOVEMENT");

  if (h2s.length() == 0 && temp.length() == 0 && hum.length() == 0) {
    Serial.println("Packet rejected: WORKER2 has no sensor readings");
    return false;
  }

  String payload = "{\"worker\":\"WORKER2\"";
  if (h2s.length() > 0) payload += ",\"h2s\":" + String(h2s.toFloat(), 2);
  if (temp.length() > 0) payload += ",\"temperature\":" + String(temp.toFloat(), 2);
  if (hum.length() > 0) payload += ",\"humidity\":" + String(hum.toFloat(), 2);
  if (movement.length() > 0) payload += ",\"movement\":\"" + movement + "\"";
  payload += "}";

  if (payload.length() >= JSON_SIZE) return false;
  strcpy(json, payload.c_str());
  return true;
}

void queuePacket(const String& worker, const char* json) {
  WorkerPacket item = {};
  strncpy(item.worker, worker.c_str(), sizeof(item.worker) - 1);
  strncpy(item.json, json, sizeof(item.json) - 1);

  if (xQueueSend(httpQueue, &item, 0) == pdTRUE) {
    Serial.print("HTTP queued: ");
    Serial.println(worker);
  } else {
    Serial.println("HTTP QUEUE FULL - packet dropped");
  }
}

void logReceiverState(const char* reason) {
  const byte opMode = LoRa.readRegister(0x01);
  const byte mode = opMode & 0x07;
  const bool longRangeMode = (opMode & 0x80) != 0;

  Serial.print(reason);
  Serial.print(" SX127x OP_MODE=0x");
  Serial.print(opMode, HEX);
  Serial.print(" LoRa-mode=");
  Serial.print(longRangeMode ? "yes" : "NO");
  Serial.print(" RX_CONTINUOUS=");
  Serial.print(mode == 0x05 ? "yes" : "NO");
  Serial.print(" DIO0=");
  Serial.println(digitalRead(LORA_DIO0) == HIGH ? "HIGH" : "LOW");

  if (!longRangeMode || mode != 0x05) {
    Serial.println("Receiver was not in continuous RX; restoring receive mode");
    LoRa.receive();
  }
}

void receiveLoRaPacket() {
  const int packetSize = LoRa.parsePacket();
  if (packetSize <= 0) return;

  Serial.println();
  Serial.println("PACKET DETECTED");
  Serial.print("Packet size: ");
  Serial.println(packetSize);

  String packet;
  packet.reserve(packetSize);
  while (LoRa.available()) {
    packet += static_cast<char>(LoRa.read());
  }
  packet.trim();

  const int rssi = LoRa.packetRssi();
  const float snr = LoRa.packetSnr();
  const String worker = getWorkerID(packet);
  const bool dataHeader = packet.startsWith("DATA,");

  Serial.print("Received data: ");
  Serial.println(packet);
  Serial.print("RSSI: ");
  Serial.println(rssi);
  Serial.print("SNR: ");
  Serial.println(snr, 1);
  Serial.print("Worker ID: ");
  Serial.println(worker.length() ? worker : "(not parsed)");

  char json[JSON_SIZE] = {0};
  bool accepted = false;
  if (dataHeader && worker == "WORKER1") {
    worker1Packets++;
    Serial.print("Worker 1 counter: ");
    Serial.println(worker1Packets);
    accepted = parseWorker1(packet, rssi, snr, json);
    if (accepted) {
      Serial.println("Packet accepted: WORKER1");
      Serial.print("WORKER1 JSON: ");
      Serial.println(json);
      if (getInteger(packet, "SOS", 0) == 1) {
        Serial.println("!!! WORKER 1 SOS EMERGENCY !!!");
      }
      queuePacket("WORKER1", json);
    } else {
      Serial.println("Packet rejected: WORKER1 validation failed");
    }
  } else if (dataHeader && worker == "WORKER2") {
    worker2Packets++;
    Serial.print("Worker 2 counter: ");
    Serial.println(worker2Packets);
    accepted = parseWorker2(packet, json);
    if (accepted) {
      Serial.println("Packet accepted: WORKER2");
      Serial.print("WORKER2 JSON: ");
      Serial.println(json);
      queuePacket("WORKER2", json);
    } else {
      Serial.println("Packet rejected: WORKER2 validation failed");
    }
  } else {
    Serial.println("Packet rejected: unexpected packet type or worker ID");
    Serial.print("Worker 1 counter (recognized DATA packets): ");
    Serial.println(worker1Packets);
  }

  Serial.print("Packet accepted/rejected: ");
  Serial.println(accepted ? "ACCEPTED" : "REJECTED");
  Serial.println("--------------------------------");

  // parsePacket() may leave the radio idle after a received packet.
  LoRa.receive();
}

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("Connecting to WiFi...");
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  const unsigned long startTime = millis();

  while (
    WiFi.status() != WL_CONNECTED &&
    millis() - startTime < 15000UL
  ) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi connected");
    Serial.print("Gateway IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi connection failed; LoRa receive loop continues");
  }
}

void httpTask(void* parameter) {
  WorkerPacket item;
  for (;;) {
    if (xQueueReceive(httpQueue, &item, portMAX_DELAY) != pdTRUE) continue;

    Serial.println("\n========== HTTP TRANSMISSION ==========");
    Serial.print("Worker: ");
    Serial.println(item.worker);

    if (WiFi.status() != WL_CONNECTED) connectWiFi();
    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.setConnectTimeout(5000);
      http.setTimeout(5000);

      if (!http.begin(SERVER_URL)) {
        Serial.println("HTTP begin failed");
      } else {
        http.addHeader("Content-Type", "application/json");
        Serial.print("POST payload: ");
        Serial.println(item.json);
        const int httpCode = http.POST(item.json);
        Serial.print("HTTP Response Code: ");
        Serial.println(httpCode);
        if (httpCode > 0) {
          Serial.print("Server Response: ");
          Serial.println(http.getString());
        } else {
          Serial.print("HTTP Error: ");
          Serial.println(http.errorToString(httpCode));
        }
        http.end();
      }
    } else {
      Serial.println("WiFi unavailable - packet not forwarded");
    }
    Serial.println("=======================================");
  }
}

void printScanDiagnostic() {
  const unsigned long now = millis();
  if (now - lastScanDiagnosticMs < SCAN_DIAGNOSTIC_INTERVAL_MS) return;
  lastScanDiagnosticMs = now;
  Serial.println("Checking for packets...");
  logReceiverState("LoRa receiver active:");
}

void printGatewayStatus() {
  const unsigned long now = millis();
  if (now - lastStatusMs < STATUS_INTERVAL_MS) return;
  lastStatusMs = now;

  Serial.println("\n========== CP-01 STATUS ==========");
  Serial.print("Worker 1 packets: ");
  Serial.println(worker1Packets);
  Serial.print("Worker 2 packets: ");
  Serial.println(worker2Packets);
  Serial.print("WiFi: ");
  Serial.println(WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED");
  Serial.print("HTTP Queue: ");
  Serial.println(uxQueueMessagesWaiting(httpQueue));
  logReceiverState("Receiver status:");
  Serial.println("==================================");
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.println("\n-----------------------------------");
  Serial.println("       BAASC CP-01 GATEWAY");
  Serial.println("-----------------------------------");

  httpQueue = xQueueCreate(QUEUE_SIZE, sizeof(WorkerPacket));
  if (httpQueue == nullptr) {
    Serial.println("HTTP Queue creation failed!");
    while (true) delay(1000);
  }

  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_SS);
  LoRa.setPins(LORA_SS, LORA_RST, LORA_DIO0);
  if (!LoRa.begin(LORA_FREQUENCY)) {
    Serial.println("LoRa initialization failed!");
    while (true) delay(1000);
  }

  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setSyncWord(0x12);
  LoRa.enableCrc();
  pinMode(LORA_DIO0, INPUT);
  LoRa.receive();

  Serial.println("LoRa initialized successfully");
  Serial.println("Radio settings: 433 MHz, SF7, BW125 kHz, CR4/5, sync 0x12, CRC on");
  Serial.println("LoRa receiver active");
  logReceiverState("Initial receiver state:");

  WiFi.mode(WIFI_STA);
  connectWiFi();

  const BaseType_t taskCreated = xTaskCreatePinnedToCore(
    httpTask,
    "HTTP_Task",
    8192,
    nullptr,
    1,
    nullptr,
    0
  );
  if (taskCreated != pdPASS) {
    Serial.println("HTTP task creation failed!");
    while (true) delay(1000);
  }

  Serial.println("-----------------------------------");
  Serial.println("CP-01 READY");
  Serial.println("Waiting for worker packets...");
  Serial.println("-----------------------------------");
}

void loop() {
  receiveLoRaPacket();
  printScanDiagnostic();

  const unsigned long now = millis();
  if (now - lastWiFiCheckMs >= WIFI_RETRY_INTERVAL_MS) {
    lastWiFiCheckMs = now;
    if (WiFi.status() != WL_CONNECTED) connectWiFi();
  }

  if (now - lastReceiverCheckMs >= RECEIVER_CHECK_INTERVAL_MS) {
    lastReceiverCheckMs = now;
    const byte opMode = LoRa.readRegister(0x01);
    if ((opMode & 0x87) != 0x85) {
      Serial.println("LoRa left RX_CONTINUOUS; restoring receiver");
      LoRa.receive();
    }
  }

  printGatewayStatus();
  delay(2);
}
