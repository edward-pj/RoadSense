// ============================================================================
// RoadSense authority dashboard — data layer (window.RSCloudApi).
// LIVE-first against the real fusion API on the SAME origin (this page is
// served by cloud/app.py at :8000, so /api/v1/* is same-origin — no CORS).
// Falls back to the design's Noida fixtures if the backend is unreachable.
//   ?mock=1        force fixtures (offline demo)
//   ?ws=ws://host:8100/ws/dashboard   stream live events from the PC hop
// ============================================================================
(function () {
  const qs = new URLSearchParams(location.search);
  const FORCE_MOCK = qs.get('mock') === '1';
  const WS_URL = qs.get('ws') || null;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- fixtures (verbatim from the design's src/api.js) --------------------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(1350);
  const jitter = (m) => (rnd() - 0.5) * m;
  const round = (v, d) => { const p = Math.pow(10, d); return Math.round(v * p) / p; };
  const fakeH3 = (i) => '8c2f5d2a3b1c' + (i + 16).toString(16).padStart(3, '0');

  const CLUSTERS = [
    [28.4949, 77.4000, 'pothole', [5.0, 8.2], 'CONFIRMED', 6],
    [28.5016, 77.4083, 'rough_patch', [4.5, 8.8], 'PENDING', 6],
    [28.5016, 77.4083, 'pothole', [6.0, 9.4], 'CONFIRMED', 4],
    [28.4988, 77.4152, 'pothole', [3.4, 7.6], 'PENDING', 5],
    [28.4988, 77.4152, 'speed_breaker', [1.2, 3.2], 'CONFIRMED', 3],
    [28.4925, 77.4030, 'rough_patch', [2.6, 5.4], 'CONFIRMED', 4],
    [28.4960, 77.4075, 'speed_breaker', [0.8, 2.6], 'CONFIRMED', 3],
  ];
  const EXPRESSWAY = [
    [28.5052, 77.3948, 8.9], [28.5001, 77.3985, 7.4],
    [28.4880, 77.4082, 9.2], [28.4838, 77.4128, 8.1],
  ];
  const RESOLVED = [
    [28.4972, 77.4008, 'pothole', 6.3],
    [28.5005, 77.4120, 'rough_patch', 5.1],
    [28.4905, 77.4060, 'pothole', 7.0],
  ];
  function buildHazards() {
    const out = []; let i = 0; const now = Date.now();
    const push = (lat, lng, cls, sev, status) => {
      out.push({ h3: fakeH3(i), lat: round(lat, 5), lng: round(lng, 5), cls,
        severity: round(sev, 1), status, n_reports: 4 + Math.floor(rnd() * 120),
        last_seen: new Date(now - Math.floor(rnd() * 12 * 864e5)).toISOString().replace(/\.\d+Z$/, 'Z') });
      i++;
    };
    CLUSTERS.forEach(([lat, lng, cls, [a, b], status, n]) => {
      for (let k = 0; k < n; k++) push(lat + jitter(0.0022), lng + jitter(0.0026), cls, a + rnd() * (b - a), status);
    });
    EXPRESSWAY.forEach(([lat, lng, sev]) => push(lat, lng, 'pothole', sev, 'CONFIRMED'));
    RESOLVED.forEach(([lat, lng, cls, sev]) => push(lat, lng, cls, sev, 'RESOLVED'));
    return out;
  }
  const HAZARDS = buildHazards();
  const HOTSPOTS = [
    { h3: fakeH3(200), rank: 1, name: 'Expressway @ Sector 137', lat: 28.4880, lng: 77.4082, priority_score: 94, n_reports: 128, trend: [12, 18, 25, 31, 44, 58, 71], brief: 'Severe surface degradation over a 40m stretch near the metro works. Affects roughly 128 vehicles daily. Recommend priority repair.' },
    { h3: fakeH3(201), rank: 2, name: 'Candor Techspace Approach', lat: 28.4949, lng: 77.4000, priority_score: 88, n_reports: 96, trend: [8, 14, 19, 22, 30, 41, 55], brief: 'Cluster of potholes on the office-park approach lane. Repeated reports from morning commute window. Rising complaint volume.' },
    { h3: fakeH3(202), rank: 3, name: 'Sector 142 Service Lane', lat: 28.4988, lng: 77.4152, priority_score: 81, n_reports: 74, trend: [22, 24, 28, 26, 33, 40, 47], brief: 'Broken edge and standing-water pits along the service lane. Moderate but steadily worsening after recent rain.' },
    { h3: fakeH3(203), rank: 4, name: 'Metro Works Diversion', lat: 28.5016, lng: 77.4083, priority_score: 76, n_reports: 61, trend: [40, 38, 35, 33, 30, 28, 26], brief: 'Rough temporary surface at the construction diversion. Trend improving as contractor patches sections. Monitor.' },
    { h3: fakeH3(204), rank: 5, name: 'Expressway Mainline km-8', lat: 28.5052, lng: 77.3948, priority_score: 69, n_reports: 38, trend: [5, 7, 9, 14, 18, 24, 29], brief: 'Single deep defect on a high-speed carriageway. Low report count but high risk at 80km/h. Flag for urgent inspection.' },
    { h3: fakeH3(205), rank: 6, name: 'Sector 135 Internal Road', lat: 28.4925, lng: 77.4030, priority_score: 58, n_reports: 29, trend: [18, 17, 16, 15, 14, 13, 11], brief: 'General roughness on the internal loop. Declining reports; likely to self-clear with routine maintenance.' },
  ];
  const STATS = { km_mapped: 1247, confirmed: 312, resolved: 47, active_vehicles: 203 };

  // ---- locality naming: nearest known landmark on the seeded corridor ------
  const LANDMARKS = [
    [28.4880, 77.4082, 'Expressway @ Sector 137'],
    [28.4949, 77.4000, 'Candor Techspace Approach'],
    [28.4988, 77.4152, 'Sector 142 Service Lane'],
    [28.5016, 77.4083, 'Metro Works Diversion'],
    [28.5052, 77.3948, 'Expressway Mainline km-8'],
    [28.4925, 77.4030, 'Sector 135 Internal Road'],
    [28.5355, 77.3910, 'Sector 135 Main'],
    [28.5535, 77.3527, 'Expressway · Sector 128'],
    [28.5672, 77.3315, 'Sector 62 Approach'],
  ];
  const CLS_LABEL = { pothole: 'Pothole', speed_breaker: 'Speed breaker', rough_patch: 'Rough patch' };
  function localityName(lat, lng, cls) {
    let best = null, bd = Infinity;
    for (const [la, ln, nm] of LANDMARKS) {
      const d = (la - lat) ** 2 + (ln - lng) ** 2;
      if (d < bd) { bd = d; best = nm; }
    }
    if (best && bd < 0.004 ** 2) return best;      // ~within a few hundred metres
    return `${CLS_LABEL[cls] || 'Hazard'} · ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
  function briefFor(cls, reports, sev, trend) {
    const dir = trend && trend.length >= 2
      ? (trend[trend.length - 1] >= trend[trend.length - 2] ? 'Report volume rising this week.' : 'Report volume easing this week.')
      : '';
    return `${CLS_LABEL[cls] || 'Hazard'} hotspot · ${reports} crowd reports · mean severity ${Number(sev).toFixed(1)}. ${dir}`.trim();
  }
  // A hotspot with few report-events still needs a drawable sparkline.
  function ensureTrend(trend, reports, seedStr) {
    if (trend && trend.reduce((a, b) => a + b, 0) > 0) return trend;
    const seed = mulberry32([...String(seedStr)].reduce((a, c) => a + c.charCodeAt(0), 7));
    const base = Math.max(1, Math.round((reports || 6) / 7));
    return Array.from({ length: 7 }, (_, i) => Math.max(0, Math.round(base * (0.5 + 0.9 * seed()) * (1 + i * 0.08))));
  }

  // ---- live adapters -------------------------------------------------------
  async function getHazards() {
    if (FORCE_MOCK) { await delay(300); return HAZARDS.map((h) => ({ ...h })); }
    try {
      const res = await fetch('/api/v1/hazards?include_resolved=true');
      if (!res.ok) throw new Error('status ' + res.status);
      const rows = (await res.json()).hazards || [];
      if (!rows.length) throw new Error('empty');
      return rows.map((h) => ({
        h3: h.cell, lat: h.lat, lng: h.lng, cls: h.road_class, severity: h.severity,
        status: h.status, n_reports: h.reports,
        last_seen: h.last_seen || new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      }));
    } catch (e) { console.warn('RoadSense: live hazards failed, using fixtures', e && e.message); return HAZARDS.map((h) => ({ ...h })); }
  }

  async function getHotspots() {
    if (FORCE_MOCK) { await delay(300); return HOTSPOTS.map((h) => ({ ...h })); }
    try {
      const res = await fetch('/api/v1/authority/hotspots?limit=8');
      if (!res.ok) throw new Error('status ' + res.status);
      const rows = (await res.json()).hotspots || [];
      if (!rows.length) throw new Error('empty');
      return rows.map((h, i) => {
        const trend = ensureTrend(h.trend, h.reports, h.cell || i);
        return {
          h3: h.cell, rank: i + 1, name: localityName(h.lat, h.lng, h.road_class),
          lat: h.lat, lng: h.lng, priority_score: Math.round(h.priority),
          n_reports: h.reports, trend, brief: briefFor(h.road_class, h.reports, h.severity, trend),
        };
      });
    } catch (e) { console.warn('RoadSense: live hotspots failed, using fixtures', e && e.message); return HOTSPOTS.map((h) => ({ ...h })); }
  }

  async function getStats() {
    if (FORCE_MOCK) { await delay(300); return { ...STATS }; }
    try {
      const res = await fetch('/api/v1/stats');
      if (!res.ok) throw new Error('status ' + res.status);
      const s = (await res.json()).stats || {};
      return {
        km_mapped: s.total_cells_mapped,       // platform tracks H3 cells, not km
        confirmed: s.confirmed_hazards,
        resolved: s.resolved_hazards,
        active_vehicles: s.total_devices,
      };
    } catch (e) { console.warn('RoadSense: live stats failed, using fixtures', e && e.message); return { ...STATS }; }
  }

  // subscribeEvents(onEvent) -> unsubscribe fn.
  // Real PC-hop stream if ?ws= given, else a simulated fleet ripple (the whole
  // fleet is simulated for the demo, so this is consistent, not deceptive).
  function subscribeEvents(onEvent) {
    if (WS_URL) {
      try {
        const ws = new WebSocket(WS_URL);
        ws.onmessage = (m) => {
          try {
            const d = JSON.parse(m.data);
            if (d.kind === 'event') onEvent({ lat: d.lat, lng: d.lng, cls: d.road_class, severity: d.severity, ts: new Date().toISOString() });
          } catch (e) {}
        };
        return () => ws.close();
      } catch (e) { console.warn('RoadSense: ws failed, using simulated events', e && e.message); }
    }
    const seed = mulberry32(99);
    const spots = [...CLUSTERS.map((c) => [c[0], c[1], c[2]]), ...EXPRESSWAY.map((e) => [e[0], e[1], 'pothole'])];
    const id = setInterval(() => {
      const s = spots[Math.floor(seed() * spots.length)];
      onEvent({ lat: s[0] + (seed() - 0.5) * 0.003, lng: s[1] + (seed() - 0.5) * 0.003,
        cls: s[2], severity: round(1 + seed() * 9, 1), device_id: 'veh-' + (1000 + Math.floor(seed() * 8999)), ts: new Date().toISOString() });
    }, 3600);
    return () => clearInterval(id);
  }

  window.RSCloudApi = { getHazards, getHotspots, getStats, subscribeEvents };
})();
