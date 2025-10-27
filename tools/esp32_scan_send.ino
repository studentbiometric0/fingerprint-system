/*
 * ESP32 Adafruit_Fingerprint integrated sketch - DEBUGGED & INTEGRATED
 *
 * This version includes:
 * - 20x4 I2C LCD Display support with formatted menus and status screens.
 * - DS3231 RTC (Real-Time Clock) support for accurate timestamps.
 * - Refactored, separate logic for Time-In and Time-Out button actions.
 * - Numpad ID entry with the asterisk (*) key as a user-friendly backspace.
 * - Hardware buttons for changing modes (HOME, TIME-IN, TIME-OUT, ENROLL).
 *
 * BUG FIXES:
 * - Resolved pin conflict between Green LED and Keypad Row.
 * - Corrected syntax error in refreshActiveEvent() JSON parsing.
 * - Restored original, consistent button and keypad pin definitions.
 * - The HOME button now correctly cancels the enrollment process at any stage.
 */

// --- LIBRARIES ---
#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Adafruit_Fingerprint.h>
#include <vector>
#include <algorithm>
#include <RTClib.h>               // For RTC
#include <LiquidCrystal_I2C.h>  // For LCD

// --- LED DEFINITIONS ---
const int GREEN_LED_PIN = 23;
const int RED_LED_PIN = 4;
const int LED_FLASH_TIME_MS = 500;

// --- BUTTON DEFINITIONS (Restored to original for consistency) ---
const int HOME_BUTTON_PIN = 13;
const int TIME_IN_BUTTON_PIN = 15;
const int TIME_OUT_BUTTON_PIN = 12;
const int ENROLL_BUTTON_PIN = 27;

// --- MODE DEFINITIONS ---
enum OperationMode {
  MODE_HOME,
  MODE_TIME_IN,
  MODE_TIME_OUT,
  MODE_ENROLL
};

// --- VOLATILE FLAGS FOR INTERRUPTS ---
volatile bool enrollButtonState = false;
volatile bool homeButtonState = false;
volatile bool timeInButtonState = false;
volatile bool timeOutButtonState = false;

// --- GLOBAL STATE ---
OperationMode currentMode = MODE_HOME;
std::vector<uint16_t> studentsTimeIn;

// --- KEYPAD DEFINITIONS (Restored to original for consistency) ---
const byte ROWS = 4;
const byte COLS = 3;
char keys[ROWS][COLS] = {
  {'1','2','3'},
  {'4','5','6'},
  {'7','8','9'},
  {'*','0','#'}
};
byte rowPins[ROWS] = {32, 33, 25, 26}; // BUG FIX: Changed pin 23 back to 26 to resolve conflict with GREEN_LED_PIN
byte colPins[COLS] = {19, 18, 5};

// --- CONFIG ---
const char* ssid = "GlobeAtHome_E2C37_2.4";
const char* password = "DBE46507";
// Use your deployed Render app (HTTPS). We use WiFiClientSecure with setInsecure()
// to accept the TLS certificate from Render. For production, pin the cert or
// validate properly.
const char* serverBase = "https://fingerprint-system.onrender.com";

// --- SENSOR & PERIPHERAL OBJECTS ---
HardwareSerial fingerSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerSerial);
int baudRates[] = {57600, 115200, 9600};
int foundBaud = 0;

RTC_DS3231 rtc;
LiquidCrystal_I2C lcd(0x27, 20, 4);

// --- EVENT CACHE ---
String currentEventId = "";
String currentEventName = "";
unsigned long lastSentFingerprint = 0;
unsigned long lastSentMillis = 0;
const unsigned long SEND_COOLDOWN_MS = 5000;


// ======================================================================================
// --- LED HELPER FUNCTIONS ---
// ======================================================================================
void ledFlashSuccess() {
    digitalWrite(GREEN_LED_PIN, HIGH);
    delay(LED_FLASH_TIME_MS);
    digitalWrite(GREEN_LED_PIN, LOW);
}

void ledFlashFailure() {
    digitalWrite(RED_LED_PIN, HIGH);
    delay(LED_FLASH_TIME_MS);
    digitalWrite(RED_LED_PIN, LOW);
}

// ======================================================================================
// --- LCD & RTC HELPER FUNCTIONS ---
// ======================================================================================

String getTimestamp() {
  if (!rtc.now().isValid()) {
    return "1970-01-01T00:00:00";
  }
  DateTime now = rtc.now();
  char buf[20];
  snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02d",
           now.year(), now.month(), now.day(),
           now.hour(), now.minute(), now.second());
  return String(buf);
}

void displayMessage(String l1, String l2 = "", String l3 = "", String l4 = "", int delayMs = 0) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(l1.substring(0, 20));
  lcd.setCursor(0, 1); lcd.print(l2.substring(0, 20));
  lcd.setCursor(0, 2); lcd.print(l3.substring(0, 20));
  lcd.setCursor(0, 3); lcd.print(l4.substring(0, 20));
  if (delayMs > 0) {
    delay(delayMs);
  }
}

void displayHomeScreen() {
  String dt = getTimestamp();
  String date = dt.substring(0, 10);
  String time = dt.substring(11, 19);
  displayMessage("  Student Biometric", "      " + date, "      " + time, "Status: HOME (Idle)");
}

void displayModeScreen() {
  String modeStr = (currentMode == MODE_TIME_IN) ? "TIME-IN" : "TIME-OUT";
  if (currentEventId.length() == 0) {
    displayMessage("MODE: " + modeStr, "!! NO ACTIVE EVENT !!", "", " (Check server)");
  } else {
    displayMessage("MODE: " + modeStr, "Event: " + currentEventName.substring(0, 13), "Place finger on", "sensor to log...");
  }
}

// ======================================================================================
// --- INTERRUPT SERVICE ROUTINES (ISRs) ---
// ======================================================================================
void IRAM_ATTR handleEnrollButton() {
  static unsigned long last_interrupt_time = 0;
  unsigned long interrupt_time = millis();
  if (interrupt_time - last_interrupt_time > 200) {
    enrollButtonState = true;
    last_interrupt_time = interrupt_time;
  }
}
void IRAM_ATTR handleHomeButton() {
  static unsigned long last_interrupt_time = 0;
  unsigned long interrupt_time = millis();
  if (interrupt_time - last_interrupt_time > 200) {
    homeButtonState = true;
    last_interrupt_time = interrupt_time;
  }
}
void IRAM_ATTR handleTimeInButton() {
  static unsigned long last_interrupt_time = 0;
  unsigned long interrupt_time = millis();
  if (interrupt_time - last_interrupt_time > 200) {
    timeInButtonState = true;
    last_interrupt_time = interrupt_time;
  }
}
void IRAM_ATTR handleTimeOutButton() {
  static unsigned long last_interrupt_time = 0;
  unsigned long interrupt_time = millis();
  if (interrupt_time - last_interrupt_time > 200) {
    timeOutButtonState = true;
    last_interrupt_time = interrupt_time;
  }
}

// ======================================================================================
// --- KEYPAD LOGIC (with HOME cancel and Backspace) ---
// ======================================================================================
uint16_t getKeypadID() {
  String idString = "";
  Serial.println("\n--- ID ENTRY MODE ---");
  Serial.println("Enter ID, press '#' to finish, or '*' for backspace.");
  displayMessage("--- ID ENTRY ---", "ID: ", "", "(*=Back, #=Enter)");
  lcd.setCursor(4, 1);

  for (byte r = 0; r < ROWS; r++) { pinMode(rowPins[r], OUTPUT); digitalWrite(rowPins[r], HIGH); }
  for (byte c = 0; c < COLS; c++) { pinMode(colPins[c], INPUT_PULLUP); }

  unsigned long lastKeyTime = 0;
  const unsigned long KEY_DEBOUNCE_MS = 150;
  while (true) {
    if (homeButtonState) {
      homeButtonState = false;
      currentMode = MODE_HOME;
      Serial.println("\nEnrollment cancelled by Home Button.");
      displayMessage("--- CANCELLED ---", "Returning to", "Home Screen...", "", 1500);
      return 0;
    }
    char key = '\0';
    for (byte r = 0; r < ROWS; r++) {
      digitalWrite(rowPins[r], LOW);
      for (byte c = 0; c < COLS; c++) {
        if (digitalRead(colPins[c]) == LOW) {
          if (millis() - lastKeyTime > KEY_DEBOUNCE_MS) {
            key = keys[r][c];
            lastKeyTime = millis();
            goto keyFound;
          }
        }
      }
      digitalWrite(rowPins[r], HIGH);
    }
    keyFound:
    if (key != '\0') {
      if (key >= '0' && key <= '9') {
        if (idString.length() < 4) {
          idString += key;
          Serial.print(key);
          lcd.print(key);
        }
      } else if (key == '#') {
        Serial.println("\nID Confirmed.");
        lcd.setCursor(0, 2); lcd.print("ID Confirmed: " + idString);
        delay(500);
        break;
      } else if (key == '*') {
        if (idString.length() > 0) {
          idString.remove(idString.length() - 1);
          int cursorPos = 4 + idString.length();
          lcd.setCursor(cursorPos, 1);
          lcd.print(" ");
          lcd.setCursor(cursorPos, 1);
          Serial.print("\b \b");
        }
      }
    }
    delay(10);
  }
  for (byte r = 0; r < ROWS; r++) { digitalWrite(rowPins[r], HIGH); }
  if (idString.length() > 0) {
    int id = idString.toInt();
    if (id >= 1 && id <= 1000) { return (uint16_t)id; }
  }
  return 0;
}

// ======================================================================================
// --- WIFI & SERVER ---
// ======================================================================================
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.begin(ssid, password);
  Serial.print("Connecting WiFi");
  lcd.setCursor(0, 3); lcd.print("Connecting WiFi...");
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print('.');
    lcd.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("WiFi connected, IP: "); Serial.println(WiFi.localIP());
    lcd.setCursor(0, 3); lcd.print("WiFi Connected!     ");
    delay(500);
  } else {
    Serial.println("WiFi connect failed");
    lcd.setCursor(0, 3); lcd.print("WiFi Failed!        ");
    delay(1000);
  }
}

bool postAttendance(uint16_t fpID, const char* type) {
  if (currentEventId.length() == 0) {
    Serial.println("No Active Event - skipping send");
    displayMessage("--- FAILED ---", "No Active Event", "Log skipped.", "", 1500);
    ledFlashFailure();
    return false;
  }
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi offline - cannot send");
    displayMessage("--- FAILED ---", "WiFi Offline", "Cannot send log.", "", 1500);
    ledFlashFailure();
    return false;
  }
  HTTPClient http;
  WiFiClientSecure client;
  client.setInsecure(); // Accept any cert (insecure). Replace with cert pinning for production.
  String url = String(serverBase) + "/esp-log";
  http.begin(client, url);
  http.addHeader("Content-Type", "application/json");
  String timestamp = getTimestamp();
  String body = "{\"fingerprintID\": " + String(fpID) + ", \"eventId\": \"" + currentEventId + "\", \"type\": \"" + String(type) + "\", \"timestamp\": \"" + timestamp + "\" }";
  int code = http.POST(body);
  if (code == 200 || code == 201) {
    Serial.printf("Logged %s: fp=%d event=%s\n", type, fpID, currentEventName.c_str());
  http.end();
    ledFlashSuccess();
    if (strcmp(type, "Time-In") == 0) { studentsTimeIn.push_back(fpID); }
    return true;
  } else if (code == 404) {
    Serial.println("No Active Event (server returned 404)");
    displayMessage("--- FAILED ---", "No Active Event", "(Server 404)", "Refreshing...", 1500);
  http.end();
    refreshActiveEvent();
    ledFlashFailure();
    return false;
  } else {
    Serial.print("POST /esp-log error: "); Serial.println(code);
    displayMessage("--- FAILED ---", "Server Error", "Code: " + String(code), "", 1500);
  http.end();
    ledFlashFailure();
    return false;
  }
}

void refreshActiveEvent() {
  connectWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("No WiFi; cannot refresh active event.");
    return;
  }
  HTTPClient http;
  WiFiClientSecure client;
  client.setInsecure();
  String url = String(serverBase) + "/events/active";
  http.begin(client, url);
  int code = http.GET();
  String oldEventId = currentEventId;
  if (code == 200) {
    String payload = http.getString();
    // --- BUG FIX: Corrected JSON parsing syntax ---
    int idStart = payload.indexOf("\"_id\":\"");
    String newEventId = "";
    String newEventName = "";
    if (idStart >= 0) {
      idStart += 7;
      int idEnd = payload.indexOf('"', idStart);
      if (idEnd > idStart) newEventId = payload.substring(idStart, idEnd);
    }
    int nameStart = payload.indexOf("\"name\":\"");
    if (nameStart >= 0) {
      nameStart += 8;
      int nameEnd = payload.indexOf('"', nameStart);
      if (nameEnd > nameStart) newEventName = payload.substring(nameStart, nameEnd);
    }
    currentEventId = newEventId;
    currentEventName = newEventName;
    Serial.printf("Cached active event: %s (%s)\n", currentEventName.c_str(), currentEventId.c_str());
    if (currentEventId != oldEventId) {
      studentsTimeIn.clear();
      Serial.println("Time-In tracking reset for new active event.");
    }
  } else if (code == 404) {
    currentEventId = "";
    currentEventName = "No Active Event";
    if (oldEventId.length() > 0) { studentsTimeIn.clear(); }
    Serial.println("No Active Event (404)");
  } else {
    Serial.print("GET /events/active failed: "); Serial.println(code);
  }
  http.end();
}

// ======================================================================================
// --- FINGERPRINT LOGIC (with HOME cancel) ---
// ======================================================================================
void enrollFingerprint(uint16_t id) {
  Serial.print("Enrolling ID #"); Serial.println(id);
  displayMessage("Enrolling ID: " + String(id), "Checking...", "", "");
  if (finger.loadModel(id) == FINGERPRINT_OK) {
    displayMessage("Enrolling ID: " + String(id), "ID already exists.", "Deleting old one...", "");
    if (finger.deleteModel(id) != FINGERPRINT_OK) {
      displayMessage("--- FAILED ---", "Could not delete", "old ID template.", "Aborting...", 2000);
      ledFlashFailure(); return;
    }
  }
  displayMessage("Enrolling ID: " + String(id), "", "Place finger...", "(Scan 1 of 2)");
  while (finger.getImage() != FINGERPRINT_OK) {
    if (homeButtonState) { homeButtonState = false; currentMode = MODE_HOME; displayMessage("--- CANCELLED ---", "Returning to", "Home Screen...", "", 1500); return; }
  }
  if (finger.image2Tz(1) != FINGERPRINT_OK) { displayMessage("--- FAILED ---", "Image 1 failed.", "Please try again.", "", 2000); ledFlashFailure(); return; }
  displayMessage("Enrolling ID: " + String(id), "Scan 1 OK.", "Remove finger...", "");
  ledFlashSuccess();
  delay(1000);
  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    if (homeButtonState) { homeButtonState = false; currentMode = MODE_HOME; displayMessage("--- CANCELLED ---", "Returning to", "Home Screen...", "", 1500); return; }
    delay(50);
  }
  displayMessage("Enrolling ID: " + String(id), "", "Place same finger...", "(Scan 2 of 2)");
  while (finger.getImage() != FINGERPRINT_OK) {
    if (homeButtonState) { homeButtonState = false; currentMode = MODE_HOME; displayMessage("--- CANCELLED ---", "Returning to", "Home Screen...", "", 1500); return; }
  }
  if (finger.image2Tz(2) != FINGERPRINT_OK) { displayMessage("--- FAILED ---", "Image 2 failed.", "Please try again.", "", 2000); ledFlashFailure(); return; }
  displayMessage("Enrolling ID: " + String(id), "Scan 2 OK.", "Creating model...", "");
  ledFlashSuccess();
  if (finger.createModel() != FINGERPRINT_OK) { displayMessage("--- FAILED ---", "Scans did not match.", "Please try again.", "", 2000); ledFlashFailure(); return; }
  if (finger.storeModel(id) == FINGERPRINT_OK) {
    displayMessage("--- SUCCESS ---", "ID: " + String(id) + " Enrolled!", "", "", 2000);
    ledFlashSuccess();
  } else {
    displayMessage("--- FAILED ---", "Could not store", "model in sensor.", "Aborting...", 2000);
    ledFlashFailure();
  }
}

// Separate functions for Time-In and Time-Out logic
void processTimeIn() {
  if (finger.getImage() != FINGERPRINT_OK) return;
  lcd.setCursor(0, 2); lcd.print("Processing finger...");
  lcd.setCursor(0, 3); lcd.print("                    ");
  if (finger.image2Tz() != FINGERPRINT_OK) { displayModeScreen(); return; }
  int p = finger.fingerSearch();
  if (p == FINGERPRINT_OK) {
    uint16_t id = finger.fingerID;
    unsigned long now = millis();
    if (id == lastSentFingerprint && now - lastSentMillis < SEND_COOLDOWN_MS) { displayModeScreen(); return; }
    if (std::find(studentsTimeIn.begin(), studentsTimeIn.end(), id) != studentsTimeIn.end()) {
      displayMessage("--- FAILED ---", "ID: " + String(id) + " already", "logged TIME-IN.", "", 2000);
      ledFlashFailure();
    } else {
      lastSentFingerprint = id;
      lastSentMillis = now;
      displayMessage("--- MATCH ---", "ID: " + String(id), "Sending to server...", "");
      if (postAttendance(id, "Time-In")) {
        displayMessage("--- SUCCESS ---", "ID: " + String(id) + " Logged", "Time-In", "Event: " + currentEventName.substring(0, 13), 2000);
      }
    }
  } else {
    displayMessage("--- NO MATCH ---", "Finger not found.", "Please try again.", "", 2000);
    ledFlashFailure();
  }
  displayModeScreen();
}

void processTimeOut() {
  if (finger.getImage() != FINGERPRINT_OK) return;
  lcd.setCursor(0, 2); lcd.print("Processing finger...");
  lcd.setCursor(0, 3); lcd.print("                    ");
  if (finger.image2Tz() != FINGERPRINT_OK) { displayModeScreen(); return; }
  int p = finger.fingerSearch();
  if (p == FINGERPRINT_OK) {
    uint16_t id = finger.fingerID;
    unsigned long now = millis();
    if (id == lastSentFingerprint && now - lastSentMillis < SEND_COOLDOWN_MS) { displayModeScreen(); return; }
    lastSentFingerprint = id;
    lastSentMillis = now;
    displayMessage("--- MATCH ---", "ID: " + String(id), "Sending to server...", "");
    if (postAttendance(id, "Time-Out")) {
      displayMessage("--- SUCCESS ---", "ID: " + String(id) + " Logged", "Time-Out", "Event: " + currentEventName.substring(0, 13), 2000);
    }
  } else {
    displayMessage("--- NO MATCH ---", "Finger not found.", "Please try again.", "", 2000);
    ledFlashFailure();
  }
  displayModeScreen();
}

// ======================================================================================
// --- MISC & SERIAL COMMANDS ---
// ======================================================================================
void scanBaudRates() {
  for (int i = 0; i < 3; i++) {
    int br = baudRates[i];
    Serial.print("Trying baud rate: "); Serial.println(br);
    fingerSerial.begin(br, SERIAL_8N1, 16, 17);
    finger.begin(br);
    delay(300);
    if (finger.verifyPassword()) {
      Serial.print("✅ Sensor detected at "); Serial.print(br); Serial.println(" baud.");
      foundBaud = br;
      return;
    }
    Serial.println("❌ No response");
  }
}
void handleCommand(String cmd) {
  cmd.trim();
  if (cmd.startsWith("help")) {
    Serial.println("Commands: enroll <id>, delete <id>, list, baudscan, refresh, show");
  } // Add other serial commands if needed
}

// ======================================================================================
// --- SETUP AND LOOP ---
// ======================================================================================
void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("ESP32 Fingerprint Integrated Sketch");
  pinMode(GREEN_LED_PIN, OUTPUT);
  digitalWrite(GREEN_LED_PIN, LOW);
  pinMode(RED_LED_PIN, OUTPUT);
  digitalWrite(RED_LED_PIN, LOW);
  pinMode(ENROLL_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(ENROLL_BUTTON_PIN), handleEnrollButton, FALLING);
  pinMode(HOME_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(HOME_BUTTON_PIN), handleHomeButton, FALLING);
  pinMode(TIME_IN_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TIME_IN_BUTTON_PIN), handleTimeInButton, FALLING);
  pinMode(TIME_OUT_BUTTON_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TIME_OUT_BUTTON_PIN), handleTimeOutButton, FALLING);
  Serial.println("All buttons setup complete.");
  Wire.begin(21, 22);
  
  Serial.print("Initializing 20x4 LCD...");
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0); lcd.print("System Booting...");
  Serial.println(" [OK]");
  Serial.print("Initializing DS3231 RTC...");
  if (!rtc.begin()) {
    Serial.println(" [ERROR] Couldn't find RTC!");
    lcd.setCursor(0, 1); lcd.print("RTC INIT FAILED!");
  } else {
    Serial.println(" [OK]");
    lcd.setCursor(0, 1); lcd.print("RTC INIT OK!");
    if (rtc.lostPower()) {
      Serial.println(" [WARNING] RTC lost power...");
    }
  }
  
  scanBaudRates();
  if (!foundBaud) {
    Serial.println("Sensor not found; check wiring");
    lcd.setCursor(0, 2); lcd.print("FP SENSOR FAILED!");
  } else {
    lcd.setCursor(0, 2); lcd.print("FP SENSOR OK!");
  }
  
  connectWiFi();
  refreshActiveEvent();
  Serial.println("--- Welcome to Student Biometric ---");
  displayHomeScreen();
}

void loop() {
  if (Serial.available()) {
    String cmd = Serial.readStringUntil('\n');
    handleCommand(cmd);
  }

  if (homeButtonState) {
    homeButtonState = false;
    currentMode = MODE_HOME;
    Serial.println("\n--- MODE SET: HOME ---");
    displayHomeScreen();
    return;
  }
  if (timeInButtonState) {
    timeInButtonState = false;
    currentMode = MODE_TIME_IN;
    Serial.println("\n*** MODE SET: TIME-IN ***");
    refreshActiveEvent();
    displayModeScreen();
    return;
  }
  if (timeOutButtonState) {
    timeOutButtonState = false;
    currentMode = MODE_TIME_OUT;
    Serial.println("\n*** MODE SET: TIME-OUT ***");
    refreshActiveEvent();
    displayModeScreen();
    return;
  }
  if (enrollButtonState) {
    enrollButtonState = false;
    currentMode = MODE_ENROLL;
    Serial.println("\n*** MODE SET: ENROLLMENT ***");
    uint16_t id = getKeypadID();
    
    // --- BUG FIX: Corrected the logic to handle invalid IDs ---
    // This outer 'if' correctly checks if the HOME button was pressed inside the keypad/enroll functions
    if (currentMode == MODE_ENROLL) {
        if (id > 0) {
          // A valid ID was entered, proceed.
          enrollFingerprint(id);
        } else {
          // An invalid ID (0) was returned and the process was not cancelled by HOME.
          // This block now correctly handles the error without the broken 'idString' check.
          displayMessage("--- FAILED ---", "Invalid or no ID", "was entered.", "Enrollment aborted.", 2000);
          ledFlashFailure();
        }
    }

    // After the process is done (or cancelled), if we are still in ENROLL mode,
    // we must manually return to HOME.
    if (currentMode == MODE_ENROLL) {
      currentMode = MODE_HOME;
      displayHomeScreen();
    }
    return;
  }

  if (currentMode == MODE_TIME_IN) {
    processTimeIn();
  } else if (currentMode == MODE_TIME_OUT) {
    processTimeOut();
  } else if (currentMode == MODE_HOME) {
    static unsigned long lastHomeUpdate = 0;
    if (millis() - lastHomeUpdate > 1000) {
      lastHomeUpdate = millis();
      String dt = getTimestamp();
      lcd.setCursor(6, 1); lcd.print(dt.substring(0, 10));
      lcd.setCursor(6, 2); lcd.print(dt.substring(11, 19));
    }
  }
}

