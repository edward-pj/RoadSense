#include "Arduino_RouterBridge.h"
#include <TinyGPSPlus.h>
#include <Wire.h>
#include <MPU6050.h>
#include <Arduino_LED_Matrix.h>

TinyGPSPlus gps;
MPU6050 mpu;

#define gpsSerial Serial

Arduino_LED_Matrix matrix;

const uint8_t ROWS = 8;
const uint8_t COLS = 13;
const uint8_t BRIGHT = 75;
const uint16_t SCROLL_MS = 90;
const char* MESSAGE = "ASPHALT WHISPER";

struct Glyph {
  char c;
  uint8_t col[5];
};

const Glyph FONT[] = {
  {' ', {0x00,0x00,0x00,0x00,0x00}},
  {'A', {0x7C,0x12,0x11,0x12,0x7C}},
  {'E', {0x7F,0x49,0x49,0x49,0x41}},
  {'H', {0x7F,0x08,0x08,0x08,0x7F}},
  {'I', {0x00,0x41,0x7F,0x41,0x00}},
  {'L', {0x7F,0x40,0x40,0x40,0x40}},
  {'P', {0x7F,0x09,0x09,0x09,0x06}},
  {'R', {0x7F,0x09,0x19,0x29,0x46}},
  {'S', {0x46,0x49,0x49,0x49,0x31}},
  {'T', {0x01,0x01,0x7F,0x01,0x01}},
  {'W', {0x7F,0x20,0x18,0x20,0x7F}},
};

uint8_t gColumns[220];
int gNumCols = 0;
int scrollOffset = 0;
unsigned long lastScroll = 0;

const uint8_t* glyphFor(char ch)
{
  for (auto &g : FONT)
    if (g.c == ch)
      return g.col;

  return FONT[0].col;
}

void buildColumns()
{
  gNumCols = 0;

  for (int i = 0; i < COLS; i++)
    gColumns[gNumCols++] = 0x00;

  for (const char* p = MESSAGE; *p; ++p)
  {
    const uint8_t* g = glyphFor(*p);

    for (int c = 0; c < 5; c++)
      gColumns[gNumCols++] = g[c];

    gColumns[gNumCols++] = 0x00;
  }

  for (int i = 0; i < COLS; i++)
    gColumns[gNumCols++] = 0x00;
}

void renderWindow(int offset)
{
  uint8_t frame[ROWS * COLS];
  memset(frame, 0, sizeof(frame));

  for (int x = 0; x < COLS; x++)
  {
    int s = offset + x;
    uint8_t bits = (s >= 0 && s < gNumCols) ? gColumns[s] : 0x00;

    for (int r = 0; r < 7; r++)
    {
      if (bits & (1 << r))
        frame[r * COLS + x] = BRIGHT;
    }
  }

  matrix.draw(frame);
}

struct SensorSnapshot
{
  int16_t ax, ay, az;
  int16_t gx, gy, gz;

  double latitude;
  double longitude;
  double altitude;
  double speedKmph;
  double courseDeg;

  int satellites;
  bool gpsFixValid;

  int utcHour;
  int utcMinute;
  int utcSecond;

  int year;
  int month;
  int day;
};

SensorSnapshot snapshot;

unsigned long lastSensorRead = 0;
const unsigned long sensorReadInterval = 100;

void updateSensorSnapshot()
{
  mpu.getMotion6(
    &snapshot.ax,
    &snapshot.ay,
    &snapshot.az,
    &snapshot.gx,
    &snapshot.gy,
    &snapshot.gz
  );

  while (gpsSerial.available())
    gps.encode(gpsSerial.read());

  snapshot.gpsFixValid = gps.location.isValid();

  if (snapshot.gpsFixValid)
  {
    snapshot.latitude = gps.location.lat();
    snapshot.longitude = gps.location.lng();
    snapshot.altitude = gps.altitude.meters();
    snapshot.speedKmph = gps.speed.kmph();
    snapshot.courseDeg = gps.course.deg();
    snapshot.satellites = gps.satellites.value();
  }

  if (gps.time.isValid())
  {
    snapshot.utcHour = gps.time.hour();
    snapshot.utcMinute = gps.time.minute();
    snapshot.utcSecond = gps.time.second();
  }

  if (gps.date.isValid())
  {
    snapshot.year = gps.date.year();
    snapshot.month = gps.date.month();
    snapshot.day = gps.date.day();
  }
}

String get_imu(String arg)
{
  char buf[64];

  snprintf(
    buf,
    sizeof(buf),
    "%d,%d,%d,%d,%d,%d",
    snapshot.ax,
    snapshot.ay,
    snapshot.az,
    snapshot.gx,
    snapshot.gy,
    snapshot.gz
  );

  return String(buf);
}

String get_gps(String arg)
{
  char buf[160];

  snprintf(
    buf,
    sizeof(buf),
    "%d,%.6f,%.6f,%.2f,%.2f,%.2f,%d,%02d,%02d,%02d,%04d,%02d,%02d",
    snapshot.gpsFixValid ? 1 : 0,
    snapshot.latitude,
    snapshot.longitude,
    snapshot.altitude,
    snapshot.speedKmph,
    snapshot.courseDeg,
    snapshot.satellites,
    snapshot.utcHour,
    snapshot.utcMinute,
    snapshot.utcSecond,
    snapshot.year,
    snapshot.month,
    snapshot.day
  );

  return String(buf);
}

void setup()
{
  Monitor.begin();

  gpsSerial.begin(9600);
  Wire.begin();

  matrix.begin();
  matrix.setGrayscaleBits(8);
  matrix.clear();
  buildColumns();

  if (Monitor)
    Monitor.println("Initializing MPU6050...");

  mpu.initialize();

  if (Monitor)
  {
    if (mpu.testConnection())
      Monitor.println("MPU6050 Connected!");
    else
      Monitor.println("MPU6050 NOT Found!");
  }

  Bridge.begin();

  Bridge.provide_safe("get_imu", get_imu);
  Bridge.provide_safe("get_gps", get_gps);

  if (Monitor)
    Monitor.println("Bridge ready. Headless safety enabled.");
}

void loop()
{
  unsigned long now = millis();

  if (now - lastSensorRead >= sensorReadInterval)
  {
    lastSensorRead = now;
    updateSensorSnapshot();
  }

  if (now - lastScroll >= SCROLL_MS)
  {
    lastScroll = now;
    renderWindow(scrollOffset);

    scrollOffset++;

    if (scrollOffset > gNumCols - COLS)
      scrollOffset = 0;
  }
}
