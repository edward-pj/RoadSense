/*
 * RoadSense MCU sketch (hop 1) — STM32U585, Zephyr.
 *
 * Samples the IMU at a deterministic 100 Hz (the reason this hop exists:
 * Linux cannot guarantee this timing), keeps a 2 s ring buffer, and on a
 * vertical-acceleration peak sends the 128-sample window centred on the
 * trigger to the MPU via Bridge RPC.
 *
 * IMPORTANT: the Bridge owns the inter-chip serial link. Never touch
 * Serial1. Verify Bridge API names against the App Lab Blink example
 * before flashing — adjust here if they differ.
 *
 * IMU: Modulino Movement (Qwiic) primary, MPU6050 (I2C) backup.
 * GPS: NEO-6M on UART, NMEA at 1 Hz (optional; 0,0 sent when absent).
 */

#include <Arduino.h>
#include <Wire.h>
#include "Modulino.h"          // Modulino Movement (Qwiic IMU)
#include <ArduinoBridge.h>     // App Lab Bridge — verify exact header on-site

constexpr int   SAMPLE_HZ      = 100;
constexpr int   RING_SIZE      = 200;   // 2 s
constexpr int   WINDOW_SIZE    = 128;   // 64 before + 64 after trigger
constexpr int   HALF_WINDOW    = WINDOW_SIZE / 2;
constexpr float TRIGGER_G      = 0.35f; // |az - 1g| threshold
constexpr int   COOLDOWN_MS    = 1500;  // one event per bump, not five

ModulinoMovement imu;

static float ring[RING_SIZE][6];
static int   head = 0;
static unsigned long lastTriggerMs = 0;
static int   postTriggerLeft = -1;      // counts samples after a trigger

static float gpsLat = 0.0f, gpsLng = 0.0f, gpsSpeedKmh = 30.0f;

void setup() {
  Modulino.begin();
  imu.begin();
  Bridge.begin();
}

static void sampleImu() {
  imu.update();
  float* slot = ring[head];
  slot[0] = imu.getX();      // accel g
  slot[1] = imu.getY();
  slot[2] = imu.getZ();
  slot[3] = imu.getRoll();   // gyro dps — verify getter names for the lib version
  slot[4] = imu.getPitch();
  slot[5] = imu.getYaw();
  head = (head + 1) % RING_SIZE;
}

static bool triggered() {
  int last = (head + RING_SIZE - 1) % RING_SIZE;
  float az = ring[last][2];
  return fabsf(az - 1.0f) > TRIGGER_G &&
         (millis() - lastTriggerMs) > COOLDOWN_MS;
}

static void sendWindow() {
  // Serialize the 128x6 window centred on the trigger as JSON for the MPU.
  // Start = 128 samples back from head (64 pre-trigger + 64 post already sampled).
  String msg = "{\"ts\":" + String(millis() / 1000.0, 3) +
               ",\"lat\":" + String(gpsLat, 6) +
               ",\"lng\":" + String(gpsLng, 6) +
               ",\"speed_kmh\":" + String(gpsSpeedKmh, 1) +
               ",\"window\":[";
  int start = (head + RING_SIZE - WINDOW_SIZE) % RING_SIZE;
  for (int i = 0; i < WINDOW_SIZE; i++) {
    float* s = ring[(start + i) % RING_SIZE];
    msg += "[";
    for (int c = 0; c < 6; c++) {
      msg += String(s[c], 4);
      if (c < 5) msg += ",";
    }
    msg += (i < WINDOW_SIZE - 1) ? "]," : "]";
  }
  msg += "]}";
  Bridge.call("submit_window", msg);
}

void loop() {
  static unsigned long nextSampleUs = micros();
  if ((long)(micros() - nextSampleUs) >= 0) {
    nextSampleUs += 1000000UL / SAMPLE_HZ;
    sampleImu();

    if (postTriggerLeft > 0 && --postTriggerLeft == 0) {
      sendWindow();                     // window is now centred on the peak
    }
    if (postTriggerLeft <= 0 && triggered()) {
      lastTriggerMs = millis();
      postTriggerLeft = HALF_WINDOW;    // wait for 64 post-trigger samples
    }
  }
  // GPS NMEA parsing (UART) goes here when the module is attached:
  // update gpsLat/gpsLng/gpsSpeedKmh from RMC sentences at 1 Hz.
}
