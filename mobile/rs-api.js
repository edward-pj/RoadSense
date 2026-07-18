// ============================================================================
// RoadSense — shared data layer (window.RSApi). ALL data access lives here;
// no fetch() in the screens. Contribution is wired LIVE to the composed
// /api/v1/contrib endpoint (cloud or PC mirror) with a mock fallback; routes
// use the design fixtures by default with a live adapter available.
//
// Config via query string on the host page:
//   ?api=http://<host>:8000   backend base (cloud :8000 or PC mirror :8100)
//   ?user=sim-user-0000       which driver's impact to show
//   ?routes=live              use the real /api/v1/route instead of fixtures
// ============================================================================
(function () {
  const qs = new URLSearchParams(location.search);
  const CONFIG = {
    baseUrl: qs.get('api') || 'http://localhost:8000',
    user: qs.get('user') || 'sim-user-0000',
    routesLive: qs.get('routes') === 'live',
  };

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- geometry helper (route fixtures) ------------------------------------
  function densify(wp, n) {
    const out = [];
    const segs = wp.length - 1;
    const per = Math.floor(n / segs);
    for (let s = 0; s < segs; s++) {
      const [x1, y1] = wp[s];
      const [x2, y2] = wp[s + 1];
      const cnt = s === segs - 1 ? Math.max(1, n - out.length) : per;
      for (let i = 0; i < cnt; i++) {
        const t = i / cnt;
        out.push([+(x1 + (x2 - x1) * t).toFixed(5), +(y1 + (y2 - y1) * t).toFixed(5)]);
      }
    }
    out.push(wp[wp.length - 1]);
    return out;
  }

  // Sector 62 (28.6280,77.3648) -> Sector 135 / Candor (28.4949,77.4000)
  const FAST_WP = [
    [77.3648, 28.6280], [77.3760, 28.6050], [77.3850, 28.5800],
    [77.3915, 28.5560], [77.3960, 28.5320], [77.3990, 28.5100], [77.4000, 28.4949],
  ];
  const SMOOTH_WP = [
    [77.3648, 28.6280], [77.3510, 28.6070], [77.3420, 28.5810],
    [77.3470, 28.5530], [77.3620, 28.5280], [77.3830, 28.5070], [77.4000, 28.4949],
  ];
  const FAST_HAZARDS = [
    { lat: 28.6050, lng: 77.3760, cls: 'speed_breaker', severity: 3.4 },
    { lat: 28.5800, lng: 77.3850, cls: 'pothole', severity: 8.4 },
    { lat: 28.5680, lng: 77.3885, cls: 'rough_patch', severity: 2.6 },
    { lat: 28.5560, lng: 77.3915, cls: 'rough_patch', severity: 5.2 },
    { lat: 28.5320, lng: 77.3960, cls: 'pothole', severity: 7.9 },
    { lat: 28.5100, lng: 77.3990, cls: 'pothole', severity: 5.8 },
  ];
  const SMOOTH_HAZARDS = [
    { lat: 28.5530, lng: 77.3470, cls: 'speed_breaker', severity: 2.3 },
  ];
  const ROUTE_FIXTURES = {
    fast: {
      mode: 'fast', geometry: { type: 'LineString', coordinates: densify(FAST_WP, 24) },
      duration_s: 1440, distance_m: 8200, comfort_score: 34, hazards_hit: FAST_HAZARDS,
    },
    smooth: {
      mode: 'smooth', geometry: { type: 'LineString', coordinates: densify(SMOOTH_WP, 24) },
      duration_s: 1620, distance_m: 8900, comfort_score: 81, hazards_hit: SMOOTH_HAZARDS,
    },
  };

  // ---- contribution fixture (matches the design's src/api.js) --------------
  const CONTRIB_FIXTURE = {
    region: 'Noida', coins: 127,
    km_mapped: 342, hero_unit: 'km', monthly_goal: 300,
    events_contributed: 1204, hazards_confirmed_by_you: 18, hazards_repaired: 3,
    week_activity: [false, true, true, true, true, true, false], today_index: 6, streak_days: 4,
    rank: 412, percentile: 8,
    badges: [
      { id: 'first_confirm', label: 'First Confirm', earned_at: '2026-05-02T00:00:00Z' },
      { id: '100_km', label: '100 km', earned_at: '2026-06-11T00:00:00Z' },
      { id: 'night_mapper', label: 'Night Mapper', earned_at: '2026-07-01T00:00:00Z' },
    ],
    repairs: [
      { location: 'Sector 137', cls: 'pothole', repaired_at: '2026-07-14T00:00:00Z', your_reports: 4 },
      { location: 'Sector 128 · DND spur', cls: 'pothole', repaired_at: '2026-06-29T00:00:00Z', your_reports: 2 },
      { location: 'Mahamaya Flyover', cls: 'rough_patch', repaired_at: '2026-06-18T00:00:00Z', your_reports: 7 },
    ],
  };

  // ---- route adapter (cloud -> design per-mode shape) ----------------------
  function adaptCloudRoute(json, mode) {
    const leg = mode === 'fast' ? json.fastest : json.smoothest;
    return {
      mode,
      geometry: { type: 'LineString',
        coordinates: (leg.polyline || []).map(([lat, lng]) => [lng, lat]) },
      duration_s: Math.round((leg.eta_min || 0) * 60),
      distance_m: Math.round((leg.distance_km || 0) * 1000),
      // The cloud route exposes a hazard COUNT only, so map dots reuse the
      // fixture severities/positions for the corridor.
      comfort_score: mode === 'fast' ? 34 : 81,
      hazards_hit: mode === 'fast' ? FAST_HAZARDS : SMOOTH_HAZARDS,
    };
  }

  async function getRoute(from, to, mode) {
    if (CONFIG.routesLive) {
      try {
        const res = await fetch(`${CONFIG.baseUrl}/api/v1/route?from_lat=${from.lat}`
          + `&from_lng=${from.lng}&to_lat=${to.lat}&to_lng=${to.lng}`);
        if (res.ok) return adaptCloudRoute(await res.json(), mode);
      } catch (e) { console.warn('RoadSense: live route failed, using fixture', e && e.message); }
    }
    await delay(400);
    return JSON.parse(JSON.stringify(ROUTE_FIXTURES[mode]));
  }

  // Live-first: the composed rollup already matches the screen's shape.
  async function getContrib(user) {
    const uid = user || CONFIG.user;
    try {
      const res = await fetch(`${CONFIG.baseUrl}/api/v1/contrib/${encodeURIComponent(uid)}`);
      if (res.ok) return { ...(await res.json()), _live: true };
      throw new Error('status ' + res.status);
    } catch (e) {
      console.warn('RoadSense: live contrib failed, using fixture', e && e.message);
      await delay(500);
      return JSON.parse(JSON.stringify({ ...CONTRIB_FIXTURE, user_id: uid, _live: false }));
    }
  }

  // ---- voice alerts (Sarvam TTS via backend proxy) -------------------------
  // Short-code -> BCP-47 for the browser speechSynthesis fallback.
  const SPEECH_LANG = {
    en: 'en-IN', hi: 'hi-IN', bn: 'bn-IN', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN',
  };

  function speakLocal(text, lang) {
    try {
      const synth = window.speechSynthesis;
      if (!synth) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = SPEECH_LANG[lang] || 'en-IN';
      synth.speak(u);
    } catch (_) { /* no speech available — silent */ }
  }

  /**
   * Speak a driver-alert line in `lang` (short code) using Sarvam TTS through
   * the backend proxy. Falls back to on-device speechSynthesis if the cloud
   * is unreachable or Sarvam fails — the alert must survive offline.
   * @param {string} text  line to speak (already in the target language)
   * @param {string} lang  short language code ('hi', 'ta', ...)
   */
  async function speak(text, lang) {
    if (!text) return;
    try {
      const res = await fetch(`${CONFIG.baseUrl}/api/v1/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang: lang || 'en' }),
      });
      if (!res.ok) throw new Error('tts status ' + res.status);
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      audio.play().catch(() => speakLocal(text, lang));
    } catch (e) {
      console.warn('RoadSense: Sarvam TTS failed, using on-device voice', e && e.message);
      speakLocal(text, lang);
    }
  }

  window.RSApi = { getRoute, getContrib, speak, CONFIG };
})();
