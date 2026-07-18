// ============================================================================
// RoadSense authority dashboard — controller (vanilla port of the design's
// DCLogic component). MapLibre + H3 hazard hexes, ranked repair-priority list
// with real 7-day sparklines, timeline scrub, live event ripples, stats bar.
// Data via window.RSCloudApi (live-first with fixture fallback).
// ============================================================================
(function () {
  const qs = new URLSearchParams(location.search);
  const PROPS = {
    connectionState: qs.get('state') === 'offline' ? 'offline' : 'live',
    showResolved: qs.get('resolved') !== '0',
    basemap: qs.get('basemap') === 'darker' ? 'darker' : 'dark',
  };

  class Dashboard {
    constructor(root) {
      this.root = root;
      this.state = { loading: true, error: false, hazards: [], hotspots: [], stats: null, timelineOpen: false, scrubDay: 90 };
      this.map = null; this.mapReady = false; this.unsub = null; this.timeline = null;
    }

    mount() {
      this.renderShell();
      this.mapEl = this.root.querySelector('#rs-map');
      this.renderBadges();
      this.renderList();
      this.renderStats();
      this.renderTimeline();
      this.root.querySelector('#rs-tl-btn').addEventListener('click', () => this.toggleTimeline());
      this.waitLibs().then(() => { this.initMap(); this.loadData(); });
    }

    setState(patch, cb) { Object.assign(this.state, patch); if (cb) cb(); }

    waitLibs() {
      return new Promise((res) => {
        const t = setInterval(() => {
          if (window.maplibregl && window.h3 && this.mapEl) { clearInterval(t); res(); }
        }, 40);
        setTimeout(() => { clearInterval(t); res(); }, 8000);
      });
    }

    async loadData() {
      try {
        const api = window.RSCloudApi;
        const [hz, ht, st] = await Promise.all([api.getHazards(), api.getHotspots(), api.getStats()]);
        this.buildTimeline(hz);
        this.setState({ hazards: hz, hotspots: ht, stats: st, loading: false, error: false });
        this.renderList(); this.renderStats(); this.renderMapLoading();
        this.refreshMap();
        if (PROPS.connectionState !== 'offline') this.unsub = api.subscribeEvents((e) => this.onEvent(e));
      } catch (err) {
        console.error('load failed', err);
        this.setState({ loading: false, error: true });
        this.renderList(); this.renderMapLoading();
      }
    }

    buildTimeline(hz) {
      this.timeline = hz.map((h, i) => {
        const appearedP = 12 + ((i * 37) % 74);
        let resolvedP = Infinity;
        if (h.status === 'RESOLVED') resolvedP = Math.min(appearedP + 20 + ((i * 13) % 14), 88);
        return { appearedP, resolvedP };
      });
    }

    // ---- map (ported verbatim from the design) -----------------------------
    initMap() {
      if (!window.maplibregl || !this.mapEl || this.map) return;
      const tiles = PROPS.basemap === 'darker' ? 'dark_nolabels' : 'dark_all';
      this.map = new window.maplibregl.Map({
        container: this.mapEl,
        style: {
          version: 8,
          sources: { base: { type: 'raster', tileSize: 256,
            tiles: ['a', 'b', 'c'].map((s) => `https://${s}.basemaps.cartocdn.com/${tiles}/{z}/{x}/{y}.png`),
            attribution: '© OpenStreetMap contributors © CARTO' } },
          layers: [{ id: 'base', type: 'raster', source: 'base' }],
        },
        center: [77.4000, 28.4949], zoom: 14, attributionControl: { compact: true },
      });
      this.map.addControl(new window.maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      this.popup = new window.maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '260px' });

      this.map.on('load', () => {
        this.map.addSource('hex', { type: 'geojson', data: this.emptyFC() });
        const sevColor = ['step', ['get', 'severity'], '#22C55E', 3, '#F59E0B', 6, '#EF4444'];
        const fillColor = ['case', ['==', ['get', 'status'], 'RESOLVED'], '#6B7280', sevColor];
        this.map.addLayer({ id: 'hex-fill', type: 'fill', source: 'hex', paint: {
          'fill-color': fillColor,
          'fill-opacity': ['case', ['==', ['get', 'status'], 'PENDING'], 0.4, ['==', ['get', 'status'], 'RESOLVED'], 0.5, 0.8],
        } });
        this.map.addLayer({ id: 'hex-line', type: 'line', source: 'hex',
          filter: ['!=', ['get', 'status'], 'PENDING'],
          paint: { 'line-color': ['case', ['==', ['get', 'status'], 'RESOLVED'], '#6B7280', sevColor], 'line-width': 1 } });
        this.map.addLayer({ id: 'hex-line-dash', type: 'line', source: 'hex',
          filter: ['==', ['get', 'status'], 'PENDING'],
          paint: { 'line-color': sevColor, 'line-width': 1, 'line-dasharray': [2, 2] } });

        this.map.on('click', 'hex-fill', (e) => {
          const f = e.features[0]; if (!f) return;
          const p = f.properties;
          this.popup.setLngLat([p.lng, p.lat]).setHTML(this.hazardPopup(p)).addTo(this.map);
        });
        this.map.on('mouseenter', 'hex-fill', () => { this.map.getCanvas().style.cursor = 'pointer'; });
        this.map.on('mouseleave', 'hex-fill', () => { this.map.getCanvas().style.cursor = ''; });

        this.mapReady = true;
        this.refreshMap();
      });
    }

    emptyFC() { return { type: 'FeatureCollection', features: [] }; }

    buildGeoJSON(scrubP) {
      const h3 = window.h3;
      const showResolved = PROPS.showResolved !== false;
      const feats = [];
      this.state.hazards.forEach((h, i) => {
        const tl = this.timeline ? this.timeline[i] : { appearedP: 0, resolvedP: Infinity };
        if (scrubP < tl.appearedP) return;
        let status = h.status;
        if (h.status === 'RESOLVED') status = scrubP >= tl.resolvedP ? 'RESOLVED' : 'CONFIRMED';
        if (!showResolved && status === 'RESOLVED') return;
        let ring;
        try { ring = h3.cellToBoundary(h3.latLngToCell(h.lat, h.lng, 11), true); }
        catch (e) { return; }
        if (ring.length && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) ring.push(ring[0]);
        feats.push({ type: 'Feature', properties: {
          severity: h.severity, status, cls: h.cls, n_reports: h.n_reports, last_seen: h.last_seen, lat: h.lat, lng: h.lng,
        }, geometry: { type: 'Polygon', coordinates: [ring] } });
      });
      return { type: 'FeatureCollection', features: feats };
    }

    refreshMap() {
      if (!this.mapReady || !this.map.getSource('hex')) return;
      const p = this.state.timelineOpen ? this.state.scrubDay : 90;
      this.map.getSource('hex').setData(this.buildGeoJSON(p));
    }

    hazardPopup(p) {
      const label = { pothole: 'Pothole', speed_breaker: 'Speed breaker', rough_patch: 'Rough patch' }[p.cls] || p.cls;
      const sc = Number(p.severity) >= 6 ? '#EF4444' : Number(p.severity) >= 3 ? '#F59E0B' : '#22C55E';
      const stC = { CONFIRMED: '#22C55E', PENDING: '#F59E0B', RESOLVED: '#6B7280' }[p.status] || '#8B949E';
      return `<div style="font-family:Inter,sans-serif;min-width:170px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px">
          <span style="font-size:14px;font-weight:700;color:#E6EDF3">${label}</span>
          <span style="font-size:10px;font-weight:700;color:${stC};letter-spacing:.05em">${p.status}</span>
        </div>
        <div style="display:flex;gap:16px;font-size:12px;color:#8B949E;font-variant-numeric:tabular-nums">
          <div><div style="color:#5b6672;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Severity</div><div style="color:${sc};font-weight:700;font-size:16px">${Number(p.severity).toFixed(1)}</div></div>
          <div><div style="color:#5b6672;font-size:10px;text-transform:uppercase;letter-spacing:.05em">Reports</div><div style="color:#E6EDF3;font-weight:700;font-size:16px">${p.n_reports}</div></div>
        </div>
        <div style="margin-top:8px;font-size:11px;color:#8B949E">Last seen ${this.timeAgo(p.last_seen)}</div>
      </div>`;
    }

    timeAgo(iso) {
      if (!iso) return 'recently';
      const d = (Date.now() - new Date(iso).getTime()) / 1000;
      if (d < 3600) return Math.max(1, Math.round(d / 60)) + ' min ago';
      if (d < 86400) return Math.round(d / 3600) + ' hr ago';
      const days = Math.round(d / 86400);
      return days <= 1 ? 'yesterday' : days + ' days ago';
    }

    flyTo(h) {
      if (!this.map) return;
      this.map.flyTo({ center: [h.lng, h.lat], zoom: 16, speed: 1.3, curve: 1.4 });
      this.popup.setLngLat([h.lng, h.lat]).setHTML(`<div style="font-family:Inter,sans-serif;min-width:170px">
        <div style="font-size:14px;font-weight:700;color:#E6EDF3;margin-bottom:6px">${h.name}</div>
        <div style="font-size:12px;color:#8B949E;font-variant-numeric:tabular-nums">priority <span style="color:#3B82F6;font-weight:700">${h.priority_score}</span> · ${h.n_reports} reports</div>
      </div>`).addTo(this.map);
    }

    onEvent(e) {
      if (!this.map || PROPS.connectionState === 'offline') return;
      const el = document.createElement('div');
      el.style.cssText = 'width:22px;height:22px;pointer-events:none;';
      const sev = e.severity >= 6 ? '#EF4444' : e.severity >= 3 ? '#F59E0B' : '#22C55E';
      el.innerHTML = `<span style="position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid ${sev};animation:rs-ring 2s ease-out forwards"></span>
        <span style="position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:${sev};box-shadow:0 0 10px ${sev}"></span>`;
      const m = new window.maplibregl.Marker({ element: el }).setLngLat([e.lng, e.lat]).addTo(this.map);
      setTimeout(() => m.remove(), 2100);
    }

    toggleTimeline() {
      this.setState({ timelineOpen: !this.state.timelineOpen });
      this.renderTimeline();
      this.root.querySelector('#rs-tl-btn').style.background = this.state.timelineOpen ? '#141b24' : 'transparent';
      this.refreshMap();
    }
    onScrub(v) { this.setState({ scrubDay: Number(v) }); this.renderTimeline(); this.refreshMap(); }
    retry() { this.setState({ loading: true, error: false }); this.renderList(); this.renderMapLoading(); this.loadData(); }

    spark(trend) {
      const w = 60, h = 20, pad = 2, min = Math.min(...trend), max = Math.max(...trend), span = (max - min) || 1;
      return trend.map((v, i) => {
        const x = pad + (i / (trend.length - 1)) * (w - 2 * pad);
        const y = h - pad - ((v - min) / span) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
    }

    // ---- dynamic renders ---------------------------------------------------
    renderBadges() {
      const offline = PROPS.connectionState === 'offline';
      this.root.querySelector('#rs-badges').innerHTML = offline
        ? `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid #3a2f12;background:#1c1608;border-radius:999px;font-size:12px;font-weight:600;color:#F59E0B;">
             <span style="width:8px;height:8px;border-radius:50%;background:#F59E0B;"></span>Local mode — cloud sync paused</div>`
        : `<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid #16311f;background:#0c1a11;border-radius:999px;font-size:12px;font-weight:600;color:#22C55E;letter-spacing:.05em;">
             <span style="width:8px;height:8px;border-radius:50%;background:#22C55E;box-shadow:0 0 8px #22C55E;animation:rs-live 1.6s infinite ease-in-out;"></span>LIVE</div>`;
    }

    renderMapLoading() {
      this.root.querySelector('#rs-map-loading').style.display = this.state.loading ? 'flex' : 'none';
    }

    renderTimeline() {
      const el = this.root.querySelector('#rs-tl-overlay');
      if (!this.state.timelineOpen) { el.style.display = 'none'; return; }
      el.style.display = 'block';
      const selDate = new Date(Date.now() - (90 - this.state.scrubDay) * 86400000);
      const scrubDate = selDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      el.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
          <span style="font-size:12px;font-weight:600;color:#8B949E;letter-spacing:.04em;text-transform:uppercase;">Timeline scrub · last 90 days</span>
          <span style="font-size:14px;font-weight:700;color:#E6EDF3;font-variant-numeric:tabular-nums;">${scrubDate}</span>
        </div>
        <input id="rs-scrub" type="range" min="0" max="90" step="1" value="${this.state.scrubDay}" style="width:100%;accent-color:#3B82F6;cursor:pointer;">
        <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:#5b6672;font-variant-numeric:tabular-nums;">
          <span>90 days ago</span><span>today</span></div>`;
      el.querySelector('#rs-scrub').addEventListener('input', (ev) => this.onScrub(ev.target.value));
    }

    renderStats() {
      const st = this.state.stats;
      const fmt = (n) => n == null ? '—' : n.toLocaleString('en-IN');
      const cells = [
        { label: 'cells mapped', value: fmt(st && st.km_mapped) },
        { label: 'hazards confirmed', value: fmt(st && st.confirmed) },
        { label: 'resolved', value: fmt(st && st.resolved) },
        { label: 'active vehicles', value: fmt(st && st.active_vehicles) },
      ];
      this.root.querySelector('#rs-stats').innerHTML = cells.map((s) =>
        `<div style="flex:1 1 0;display:flex;flex-direction:column;justify-content:center;gap:2px;padding:0 22px;border-right:1px solid #232B36;">
          <span style="font-size:22px;font-weight:700;color:#E6EDF3;font-variant-numeric:tabular-nums;letter-spacing:-.01em;">${s.value}</span>
          <span style="font-size:11px;color:#8B949E;text-transform:uppercase;letter-spacing:.06em;">${s.label}</span>
        </div>`).join('');
    }

    renderList() {
      const list = this.root.querySelector('#rs-list');
      const s = this.state;
      if (s.loading) {
        list.innerHTML = [0, 1, 2, 3, 4, 5].map(() =>
          `<div style="border:1px solid #232B36;border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;">
            <div style="display:flex;gap:12px;align-items:center;">
              <div class="rs-skel" style="width:34px;height:34px;border-radius:8px;"></div>
              <div class="rs-skel" style="height:14px;width:55%;border-radius:4px;"></div>
            </div>
            <div class="rs-skel" style="height:11px;width:40%;border-radius:4px;"></div>
            <div class="rs-skel" style="height:26px;width:100%;border-radius:4px;"></div>
          </div>`).join('');
        return;
      }
      if (s.error) {
        list.innerHTML = `<div style="border:1px solid #3a2226;background:#1a1012;border-radius:10px;padding:16px;display:flex;align-items:center;justify-content:space-between;gap:12px;">
          <span style="font-size:13px;color:#f0a5ad;">Couldn't load hazard data.</span>
          <button id="rs-retry" style="padding:6px 14px;border:1px solid #EF4444;background:transparent;color:#EF4444;border-radius:7px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;">Retry</button>
        </div>`;
        list.querySelector('#rs-retry').addEventListener('click', () => this.retry());
        return;
      }
      if (!s.hotspots.length) {
        list.innerHTML = `<div style="border:1px dashed #232B36;border-radius:10px;padding:28px;text-align:center;font-size:13px;color:#8B949E;">No hazards mapped in this area yet.</div>`;
        return;
      }
      list.innerHTML = s.hotspots.map((h) => {
        const n = h.trend.length, last = h.trend[n - 1], prev = h.trend[n - 2] || last;
        const pct = Math.round(((last - prev) / (last || 1)) * 100);
        const worse = pct >= 0;
        const isTop = h.rank === 1;
        const rankColor = isTop ? '#3B82F6' : '#8B949E';
        const rankBg = isTop ? '#0e1826' : '#141b24';
        const rankBorder = isTop ? '#1e3a5f' : '#232B36';
        const deltaColor = worse ? '#EF4444' : '#22C55E';
        const deltaLabel = worse ? `worsening +${pct}%` : `improving −${Math.abs(pct)}%`;
        return `<div class="rs-card" data-rank="${h.rank}" style="border:1px solid #232B36;background:#10151c;border-radius:10px;padding:14px;cursor:pointer;transition:border-color .15s,background .15s;">
          <div style="display:flex;gap:12px;align-items:flex-start;">
            <div style="flex:0 0 auto;width:36px;height:36px;border-radius:8px;background:${rankBg};border:1px solid ${rankBorder};display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:800;color:${rankColor};font-variant-numeric:tabular-nums;">#${h.rank}</div>
            <div style="flex:1 1 auto;min-width:0;">
              <div style="font-size:14px;font-weight:600;color:#E6EDF3;line-height:1.25;">${h.name}</div>
              <div style="font-size:12px;color:#8B949E;margin-top:3px;font-variant-numeric:tabular-nums;">score <span style="color:#E6EDF3;font-weight:600;">${h.priority_score}</span> · ${h.n_reports} reports</div>
            </div>
            <div style="flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:3px;">
              <svg width="60" height="20" viewBox="0 0 60 20" style="display:block;">
                <polyline points="${this.spark(h.trend)}" fill="none" stroke="${deltaColor}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"></polyline>
              </svg>
              <span style="font-size:10px;font-weight:600;color:${deltaColor};font-variant-numeric:tabular-nums;">${deltaLabel}</span>
            </div>
          </div>
          <div style="font-size:12px;font-style:italic;color:#8B949E;margin-top:10px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${h.brief}</div>
        </div>`;
      }).join('');
      list.querySelectorAll('.rs-card').forEach((el) => {
        el.addEventListener('click', () => {
          const h = s.hotspots.find((x) => String(x.rank) === el.getAttribute('data-rank'));
          if (h) this.flyTo(h);
        });
      });
    }

    // ---- static shell ------------------------------------------------------
    renderShell() {
      this.root.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100vh;width:100vw;overflow:hidden;background:#0B0F14;color:#E6EDF3;font-family:Inter,-apple-system,system-ui,sans-serif;font-feature-settings:'tnum' 1,'cv01' 1;">
        <header style="display:flex;align-items:center;justify-content:space-between;height:56px;flex:0 0 56px;padding:0 20px;border-bottom:1px solid #232B36;background:#0B0F14;">
          <div style="display:flex;align-items:baseline;gap:10px;">
            <span style="font-size:16px;font-weight:700;letter-spacing:-.01em;">RoadSense</span>
            <span style="color:#3B4655;">·</span>
            <span style="font-size:13px;color:#8B949E;font-weight:500;">Sector 135 Ward</span>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <div id="rs-badges"></div>
            <button id="rs-tl-btn" style="display:flex;align-items:center;gap:7px;padding:7px 13px;border:1px solid #232B36;background:transparent;color:#E6EDF3;border-radius:8px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;">
              <span style="width:13px;height:13px;border:1.5px solid currentColor;border-radius:3px;position:relative;display:inline-block;"><span style="position:absolute;left:2px;top:4px;width:7px;height:1.5px;background:currentColor;"></span></span>
              Timeline
            </button>
          </div>
        </header>
        <main style="display:flex;flex:1 1 auto;min-height:0;">
          <section style="flex:0 0 60%;position:relative;min-width:0;border-right:1px solid #232B36;">
            <div id="rs-map" style="position:absolute;inset:0;"></div>
            <div id="rs-tl-overlay" style="display:none;position:absolute;top:16px;left:16px;right:16px;z-index:5;background:rgba(21,27,35,.94);backdrop-filter:blur(8px);border:1px solid #232B36;border-radius:10px;padding:14px 18px;box-shadow:0 10px 30px rgba(0,0,0,.5);"></div>
            <div style="position:absolute;bottom:14px;left:14px;z-index:4;background:rgba(21,27,35,.9);backdrop-filter:blur(6px);border:1px solid #232B36;border-radius:8px;padding:10px 12px;font-size:11px;color:#8B949E;">
              <div style="display:flex;gap:14px;margin-bottom:7px;">
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#22C55E;border-radius:2px;"></span>0–3</span>
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#F59E0B;border-radius:2px;"></span>3–6</span>
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#EF4444;border-radius:2px;"></span>6–10</span>
              </div>
              <div style="display:flex;gap:14px;">
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#EF4444;border-radius:2px;"></span>confirmed</span>
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#EF4444;opacity:.4;border:1px dashed #EF4444;border-radius:2px;"></span>pending</span>
                <span style="display:flex;align-items:center;gap:6px;"><span style="width:11px;height:11px;background:#6B7280;border-radius:2px;"></span>resolved</span>
              </div>
            </div>
            <div id="rs-map-loading" style="position:absolute;inset:0;z-index:6;background:#0B0F14;display:flex;align-items:center;justify-content:center;">
              <div style="position:relative;width:260px;height:220px;opacity:.5;">
                <div class="rs-skel" style="position:absolute;left:40px;top:30px;width:70px;height:60px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);"></div>
                <div class="rs-skel" style="position:absolute;left:120px;top:70px;width:70px;height:60px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);"></div>
                <div class="rs-skel" style="position:absolute;left:80px;top:120px;width:70px;height:60px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);"></div>
                <div class="rs-skel" style="position:absolute;left:160px;top:20px;width:70px;height:60px;clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%);"></div>
              </div>
            </div>
          </section>
          <aside style="flex:0 0 40%;display:flex;flex-direction:column;min-width:0;background:#0B0F14;">
            <div style="flex:0 0 auto;padding:16px 20px 12px;border-bottom:1px solid #232B36;">
              <div style="font-size:13px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:#E6EDF3;">Repair Priority</div>
              <div style="font-size:12px;color:#8B949E;margin-top:3px;">Ranked by crowdsourced severity &amp; report volume</div>
            </div>
            <div id="rs-list" class="rs-scroll" style="flex:1 1 auto;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px;"></div>
          </aside>
        </main>
        <footer id="rs-stats" style="flex:0 0 64px;display:flex;align-items:stretch;border-top:1px solid #232B36;background:#0B0F14;"></footer>
      </div>`;
    }
  }

  window.addEventListener('DOMContentLoaded', () => new Dashboard(document.getElementById('rs-root')).mount());
})();
