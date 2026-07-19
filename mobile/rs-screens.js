// ============================================================================
// RoadSense driver screens — vanilla ports of the design components.
//   window.RouteComparisonScreen  (RouteComparison.dc.html)
//   window.ContributionScreen     (Contribution v2.dc.html)
// Each mounts into a host container and keeps its own DOM alive across tab
// switches (call .onShow()/.onHide() from the shell). Data via window.RSApi.
// ============================================================================
(function () {
  const nf = (n) => Number(n).toLocaleString('en-IN');
  // Translation shortcut. All user-visible copy goes through this so the whole
  // app re-renders in the driver's chosen language (see rs-i18n.js).
  const T = (key, params) => window.RSI18n.t(key, params);

  // --------------------------------------------------------------------------
  // Route comparison
  // --------------------------------------------------------------------------
  class RouteComparisonScreen {
    constructor(container, opts = {}) {
      this.opts = opts;
      this.mapEl = document.createElement('div');
      // Map lives in the top band only (above the bottom sheet); goes
      // full-screen in nav mode. Exact height synced to the sheet at runtime.
      // z-index:0 makes this a stacking context so Leaflet's internal panes
      // (tiles/markers, z-index 200-700) can't paint over the sheet above it.
      this.mapEl.style.cssText = 'position:absolute;left:0;right:0;top:0;height:58%;'
        + 'z-index:0;background:#e6e8ec';
      this.root = document.createElement('div');           // overlays
      container.appendChild(this.mapEl);
      container.appendChild(this.root);

      this.state = {
        status: 'loading', selected: opts.initialSelected || 'smooth',
        offline: !!opts.startOffline, nav: false, navDist: 200, navAlert: false,
        tw: (opts.initialSelected === 'fast') ? { cFrom: 81, cTo: 34 } : { cFrom: 34, cTo: 81 },
      };
      this.routes = null; this.map = null;
      this._timer = null; this._navTimer = null;
      this._navBannerShown = false;
      this._drawn = false; this._mapReady = false; this._drawTries = 0;
    }

    mount() {
      this.render(); this.load(); this.initMap();
      window.RSI18n.onChange(() => this.render());
    }
    onShow() { setTimeout(() => this._syncMapLayout(), 60); }
    onHide() {}

    /** Size the map element to the visible map band (full-screen in nav). */
    _syncMapLayout() {
      if (!this.mapEl) return;
      const container = this.mapEl.parentElement;
      const ch = container ? container.clientHeight : 0;
      if (this.state.nav) {
        this.mapEl.style.height = '100%';
      } else if (ch) {
        const sheet = this.root.querySelector('[data-sheet]');
        const sh = sheet ? sheet.offsetHeight : 0;
        // +26px so the sheet's rounded top corners still reveal the map.
        this.mapEl.style.height = Math.max(220, sh ? ch - sh + 26 : Math.round(ch * 0.58)) + 'px';
      }
      if (this.map) { this.map.invalidateSize(); this.fitSelected(); }
    }

    setState(patch, cb) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render();
      if (cb) cb();
    }

    async load() {
      this.setState({ status: 'loading' });
      const demo = this.opts.demoState;
      if (demo === 'loading') return;
      if (demo === 'error') { this.setState({ status: 'error' }); return; }
      try {
        const from = { lat: 28.6280, lng: 77.3648 };
        const to = { lat: 28.4949, lng: 77.4000 };
        const [fast, smooth] = await Promise.all([
          RSApi.getRoute(from, to, 'fast'), RSApi.getRoute(from, to, 'smooth'),
        ]);
        this.routes = { fast, smooth };
        this.setState({ status: 'ready' });
        requestAnimationFrame(() => this._syncMapLayout());
      } catch (e) {
        console.warn('RoadSense: route load failed', e && (e.message || e));
        this.setState({ status: 'error' }); return;
      }
      this.tryDraw();
    }

    async initMap() {
      for (let i = 0; i < 120 && !window.L; i++) await new Promise(r => setTimeout(r, 60));
      if (!window.L || this.map) return;
      this.map = L.map(this.mapEl, { center: [28.4949, 77.4000], zoom: 12, zoomControl: false, attributionControl: true });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd', maxZoom: 19, attribution: '© OpenStreetMap © CARTO',
      }).addTo(this.map);
      this.map.whenReady(() => { this.map.invalidateSize(); this._mapReady = true; this.tryDraw(); });
    }

    tryDraw() {
      try { this.drawRoutes(); }
      catch (e) { if (++this._drawTries < 20) setTimeout(() => this.tryDraw(), 120); }
    }

    drawRoutes() {
      if (!this.map || !this._mapReady || !this.routes || this._drawn) return;
      const m = this.map;
      m.invalidateSize();
      m.setView(m.getCenter(), m.getZoom(), { animate: false });
      this._renderer = L.svg({ padding: 0.5 });
      this._renderer.addTo(m);
      if (this._renderer._update) this._renderer._update();
      const toLL = (coords) => coords.map(([lng, lat]) => [lat, lng]);
      this._lines = this._lines || {};
      this._dots = this._dots || [];
      ['fast', 'smooth'].forEach((mode) => {
        if (!this._lines[mode]) {
          this._lines[mode] = L.polyline(toLL(this.routes[mode].geometry.coordinates), {
            color: '#9AA4B2', weight: 3, opacity: 0.55, lineJoin: 'round',
            lineCap: 'round', className: 'rs-route', renderer: this._renderer, noClip: true,
          }).addTo(m);
        }
        this.routes[mode].hazards_hit.forEach((h) => {
          const color = h.severity >= 6 ? '#DC2626' : h.severity >= 3 ? '#D97706' : '#16A34A';
          const r = 4 + (h.severity / 10) * 6;
          this._dots.push(L.circleMarker([h.lat, h.lng], {
            radius: r, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, renderer: this._renderer,
          }).addTo(m));
        });
      });
      this._drawn = true;
      this.applySelection();
      this.fitSelected();
    }

    applySelection() {
      if (!this._lines || !this._lines.fast) return;
      const sel = this.state.selected;
      ['fast', 'smooth'].forEach((mode) => {
        const on = mode === sel;
        this._lines[mode].setStyle({ color: on ? '#2563EB' : '#9AA4B2', weight: on ? 5 : 3, opacity: on ? 1 : 0.5 });
      });
      this._lines[sel].bringToFront();
      (this._dots || []).forEach(d => d.bringToFront());
    }

    fitSelected() {
      if (!this.map || !this.routes) return;
      const coords = this.routes[this.state.selected].geometry.coordinates;
      let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
      coords.forEach(([lng, lat]) => {
        if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng; if (lng > maxLng) maxLng = lng;
      });
      try { this.map.setView([(minLat + maxLat) / 2, (minLng + maxLng) / 2], this.state.nav ? 12 : 11, { animate: true }); } catch (e) {}
    }

    selectRoute(mode) {
      if (mode === this.state.selected) return;
      this.setState({ selected: mode }, () => { this.applySelection(); this.fitSelected(); });
      this.tweenComfort(mode === 'smooth' ? { cFrom: 34, cTo: 81 } : { cFrom: 81, cTo: 34 });
    }

    tweenComfort(target) {
      if (this._timer) clearInterval(this._timer);
      const start = { ...this.state.tw };
      const t0 = Date.now();
      this._timer = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / 460);
        const e = 1 - Math.pow(1 - p, 3);
        this.setState({ tw: {
          cFrom: Math.round(start.cFrom + (target.cFrom - start.cFrom) * e),
          cTo: Math.round(start.cTo + (target.cTo - start.cTo) * e),
        } });
        if (p >= 1) { clearInterval(this._timer); this._timer = null; }
      }, 32);
    }

    startNav() {
      // One pothole alert: slides in once, counts down to the hazard, then
      // dismisses. `_navBannerShown` stops the slide-down animation replaying
      // on the per-tick re-render (which read as a repeated notification).
      this._navBannerShown = false;
      this.setState({ nav: true, navDist: 200, navAlert: true });
      // Speak the hazard alert once, in the driver's language, via Sarvam TTS
      // (falls back to on-device voice offline). Guarded so the countdown
      // re-renders don't repeat it.
      this._spoke = false;
      RSApi.speak(T('voice_line'), window.RSI18n.get());
      setTimeout(() => this._syncMapLayout(), 80);
      if (this._navTimer) clearInterval(this._navTimer);
      this._navTimer = setInterval(() => {
        this.setState(s => {
          const d = s.navDist - 10;
          if (d <= 0) {                         // reached the hazard — alert done
            clearInterval(this._navTimer); this._navTimer = null;
            return { navDist: 0, navAlert: false };
          }
          return { navDist: d };
        });
      }, 550);
    }
    endNav() {
      if (this._navTimer) { clearInterval(this._navTimer); this._navTimer = null; }
      this._navBannerShown = false;
      this.setState({ nav: false, navAlert: false });
      setTimeout(() => this._syncMapLayout(), 80);
    }
    toggleOffline() { this.setState(s => ({ offline: !s.offline })); }

    barStyle(comfort, i) {
      const on = i < Math.round(comfort / 100 * 5);
      const color = comfort >= 70 ? '#16A34A' : comfort >= 45 ? '#D97706' : '#DC2626';
      return `width:12px;height:7px;border-radius:2px;background:${on ? color : '#E5E7EB'}`;
    }

    cardVM(mode) {
      const r = this.routes[mode];
      const sel = this.state.selected === mode;
      const n = r.hazards_hit.length;
      const worst = Math.max(0, ...r.hazards_hit.map(h => h.severity));
      return {
        mode, label: mode === 'fast' ? T('fastest_caps') : T('smoothest_caps'),
        labelColor: sel ? '#2563EB' : '#9AA1AC',
        mins: Math.round(r.duration_s / 60),
        hazardText: T(n === 1 ? 'pothole_1' : 'potholes_n', { n }),
        dot: worst >= 6 ? '#DC2626' : worst >= 3 ? '#D97706' : '#16A34A',
        bars: [0, 1, 2, 3, 4].map(i => this.barStyle(r.comfort_score, i)),
        tickStyle: `width:20px;height:20px;border-radius:50%;display:flex;align-items:center;`
          + `justify-content:center;background:${sel ? '#2563EB' : 'transparent'};`
          + `border:${sel ? 'none' : '1.5px solid #D7DBE2'}`,
        cardStyle: `flex:1;padding:13px 13px 14px;border-radius:14px;cursor:pointer;`
          + `background:${sel ? '#F4F8FF' : '#fff'};border:${sel ? '1.5px solid #2563EB' : '1px solid #E5E7EB'};`
          + `box-shadow:${sel ? '0 6px 16px rgba(37,99,235,.14)' : '0 1px 2px rgba(17,24,39,.04)'};`
          + `transition:background .2s,border-color .2s,box-shadow .2s`,
      };
    }

    render() {
      const st = this.state;
      const ready = st.status === 'ready' && this.routes;
      const smoothSel = st.selected === 'smooth';
      const layersColor = st.offline ? '#D97706' : '#4b5563';
      let html = '';

      if (st.status === 'loading') {
        html += `<div style="position:absolute;left:0;right:0;top:0;height:452px;`
          + `background:linear-gradient(100deg,#e9ebef 30%,#f3f4f6 50%,#e9ebef 70%);`
          + `background-size:520px 100%;animation:rs-shim 1.3s linear infinite;z-index:3"></div>`;
      }

      if (!st.nav) {
        html += `
        <div style="position:absolute;top:16px;left:16px;z-index:6">
          <div style="width:42px;height:42px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(17,24,39,.12);display:flex;align-items:center;justify-content:center">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/></svg>
          </div>
        </div>
        <div style="position:absolute;top:16px;right:16px;z-index:6;display:flex;flex-direction:column;gap:10px">
          <div data-act="offline" style="width:42px;height:42px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(17,24,39,.12);display:flex;align-items:center;justify-content:center;cursor:pointer">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="${layersColor}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/></svg>
          </div>
        </div>
        <div style="position:absolute;top:150px;right:16px;z-index:6;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(17,24,39,.12);overflow:hidden">
          <div data-act="zoomin" style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer;border-bottom:1px solid #eef0f3"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>
          <div data-act="zoomout" style="width:42px;height:42px;display:flex;align-items:center;justify-content:center;cursor:pointer"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg></div>
        </div>
        <div data-act="locate" style="position:absolute;top:392px;right:16px;z-index:6;width:42px;height:42px;border-radius:12px;background:#fff;box-shadow:0 2px 8px rgba(17,24,39,.12);display:flex;align-items:center;justify-content:center;cursor:pointer">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="5"/></svg>
        </div>`;
        if (st.offline) {
          html += `<div style="position:absolute;top:70px;left:16px;z-index:6;display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #F1D9A8;border-radius:999px;padding:7px 12px;box-shadow:0 2px 8px rgba(17,24,39,.10)">
            <span style="width:7px;height:7px;border-radius:50%;background:#D97706"></span>
            <span style="font-size:12px;font-weight:600;color:#92600A">${T('offline_cached')}</span>
          </div>`;
        }

        html += `<div data-sheet style="position:absolute;left:0;right:0;bottom:0;background:#fff;border-radius:22px 22px 0 0;box-shadow:0 -6px 24px rgba(17,24,39,.10);padding:8px 18px 18px;display:flex;flex-direction:column">
          <div style="width:38px;height:4px;border-radius:999px;background:#E0E3E8;margin:2px auto 12px"></div>`;

        if (st.status === 'error') {
          html += `<div style="padding:26px 10px 30px;display:flex;flex-direction:column;align-items:center;gap:14px;text-align:center">
            <div style="font-size:14px;color:#6B7280">${T('routes_error')}</div>
            <div data-act="retry" style="padding:10px 22px;border-radius:10px;background:#2563EB;color:#fff;font-size:14px;font-weight:600;cursor:pointer">${T('retry')}</div></div>`;
        } else if (st.status === 'loading') {
          html += `<div style="height:20px;width:60%;border-radius:6px;background:#eef0f3;margin-bottom:14px"></div>
            <div style="display:flex;gap:12px">
              <div style="flex:1;height:132px;border-radius:14px;background:linear-gradient(100deg,#eef0f3 30%,#f6f7f9 50%,#eef0f3 70%);background-size:420px 100%;animation:rs-shim 1.3s linear infinite"></div>
              <div style="flex:1;height:132px;border-radius:14px;background:linear-gradient(100deg,#eef0f3 30%,#f6f7f9 50%,#eef0f3 70%);background-size:420px 100%;animation:rs-shim 1.3s linear infinite"></div>
            </div>
            <div style="height:52px;border-radius:12px;background:#eef0f3;margin-top:16px"></div>`;
        } else if (ready) {
          const r = this.routes[st.selected];
          const headerSub = Math.round(r.duration_s / 60) + ' ' + T('min') + ' · '
            + (r.distance_m / 1000).toFixed(1) + ' ' + T('km') + ' · '
            + T(smoothSel ? 'smoothest_lower' : 'fastest_lower');
          const cards = [this.cardVM('fast'), this.cardVM('smooth')];
          const tf = {
            badge: (smoothSel ? '+3 ' : '−3 ') + T('min'),
            badgeStyle: `font-size:12px;font-weight:700;padding:3px 8px;border-radius:7px;`
              + `color:${smoothSel ? '#166534' : '#92600A'};background:${smoothSel ? '#E7F6EC' : '#FEF3E2'}`,
            headline: T(smoothSel ? 'avoids_potholes' : 'exposes_potholes', { n: 5 }),
            cFrom: st.tw.cFrom, cTo: st.tw.cTo,
          };
          html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:3px">
            <div style="display:flex;align-items:center;gap:10px;min-width:0">
              <div style="width:34px;height:34px;border-radius:10px;background:#EAF1FE;display:flex;align-items:center;justify-content:center;flex:none">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M3 13h13V6H3zM16 9h3l2 3v3h-5z"/><circle cx="7" cy="17" r="1.8"/><circle cx="17.5" cy="17" r="1.8"/></svg>
              </div>
              <div style="min-width:0">
                <div style="font-size:16px;font-weight:700;line-height:1.15">Sector 62 → Candor</div>
                <div style="font-size:12.5px;color:#6B7280;margin-top:1px">${headerSub}</div>
              </div>
            </div>
            <div style="font-size:14px;font-weight:600;color:#2563EB;cursor:pointer;flex:none">${T('edit')}</div>
          </div>
          <div style="height:1px;background:#EEF0F3;margin:12px 0 14px"></div>
          <div style="display:flex;gap:12px">`;
          for (const c of cards) {
            html += `<div data-act="select" data-mode="${c.mode}" style="${c.cardStyle}">
              <div style="display:flex;align-items:center;justify-content:space-between">
                <span style="font-size:11px;font-weight:700;letter-spacing:.05em;color:${c.labelColor}">${c.label}</span>
                <span style="${c.tickStyle}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>
              </div>
              <div style="display:flex;align-items:baseline;gap:4px;margin-top:9px">
                <span style="font-size:27px;font-weight:700;line-height:1;letter-spacing:-.02em">${c.mins}</span>
                <span style="font-size:13px;color:#6B7280">${T('min')}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:9px">
                <span style="width:8px;height:8px;border-radius:50%;background:${c.dot};flex:none"></span>
                <span style="font-size:12.5px;color:#374151">${c.hazardText}</span>
              </div>
              <div style="display:flex;align-items:center;gap:6px;margin-top:11px">
                <span style="font-size:10.5px;color:#9AA1AC;font-weight:600">${T('comfort_caps')}</span>
                <div style="display:flex;gap:2.5px;margin-left:auto">${c.bars.map(b => `<div style="${b}"></div>`).join('')}</div>
              </div>
            </div>`;
          }
          html += `</div>
          <div style="margin-top:14px;background:#F7F8FA;border:1px solid #EEF0F3;border-radius:12px;padding:12px 14px;animation:rs-fade .3s ease">
            <div style="display:flex;align-items:center;gap:8px">
              <span style="${tf.badgeStyle}">${tf.badge}</span>
              <span style="font-size:14px;font-weight:600;color:#111827">${tf.headline}</span>
            </div>
            <div style="font-size:13px;color:#6B7280;margin-top:6px">${T('comfort_word')} <span style="color:#374151;font-weight:600">${tf.cFrom}</span> <span style="color:#B6BCC6">→</span> <span style="color:#16A34A;font-weight:700">${tf.cTo}</span></div>
          </div>
          <div data-act="start" style="margin-top:16px;height:52px;border-radius:13px;background:#2563EB;color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;font-size:16px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(37,99,235,.28)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l16-7-7 16-2-7-7-2z"/></svg>
            ${T('start_nav')}
          </div>`;
        }
        html += `</div>`;
      }

      if (st.nav) {
        const navEta = ready ? Math.round(this.routes[st.selected].duration_s / 60) : 27;
        const navModeLabel = smoothSel ? T('smoothest_title') : T('fastest_title');
        if (st.navAlert) {
          // Animate the slide-in only on the first render of this alert; the
          // per-tick distance updates must not replay it (would look repeated).
          const bannerAnim = this._navBannerShown ? '' : 'animation:rs-slidedown .4s cubic-bezier(.2,.9,.3,1) both;';
          this._navBannerShown = true;
          html += `<div style="position:absolute;top:16px;left:16px;right:16px;z-index:8;background:#fff;border-radius:16px;padding:14px 15px;box-shadow:0 8px 26px rgba(17,24,39,.18);${bannerAnim}display:flex;align-items:flex-start;gap:12px">
          <div style="width:40px;height:40px;border-radius:11px;background:#FDF0DA;display:flex;align-items:center;justify-content:center;flex:none">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#D97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l9.5 16.5H2.5L12 3z"/><path d="M12 10v4M12 17.5v.01"/></svg>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:15px;font-weight:700;line-height:1.2;color:#111827">${T('pothole_ahead')} · <span style="color:#B45309">${st.navDist} ${T('meters')}</span></div>
            <div style="font-size:12.5px;color:#6B7280;margin-top:2px">${T('reported_by', { n: 12 })}</div>
            <div style="display:flex;align-items:center;gap:7px;margin-top:9px;padding-top:9px;border-top:1px solid #F0F1F4;font-size:12.5px;color:#374151">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/></svg>
              <span style="font-style:italic">“${T('voice_line')}”</span>
            </div>
          </div>
        </div>`;
        }
        html += `<div style="position:absolute;bottom:0;left:0;right:0;z-index:8;background:#fff;border-radius:22px 22px 0 0;box-shadow:0 -6px 24px rgba(17,24,39,.12);padding:16px 18px 18px">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
            <div><div style="font-size:12.5px;color:#6B7280;line-height:1">${T('arriving_in')}</div>
              <div style="font-size:23px;font-weight:700;margin-top:3px">${navEta} ${T('min')}</div></div>
            <div style="text-align:right"><div style="font-size:12.5px;color:#6B7280;line-height:1">${T('route_label')}</div>
              <div style="font-size:14px;font-weight:600;color:#111827;margin-top:4px">${navModeLabel}</div></div>
          </div>
          <div data-act="end" style="height:52px;border-radius:13px;background:#F3F4F6;border:1px solid #E5E7EB;color:#B4232B;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:600;cursor:pointer">${T('end_nav')}</div>
        </div>`;
      }

      this.root.innerHTML = html;
      const on = (act, fn) => this.root.querySelectorAll(`[data-act="${act}"]`).forEach(el => el.addEventListener('click', fn));
      on('offline', () => this.toggleOffline());
      on('zoomin', () => { try { this.map && this.map.zoomIn(); } catch (e) {} });
      on('zoomout', () => { try { this.map && this.map.zoomOut(); } catch (e) {} });
      on('locate', () => this.fitSelected());
      on('retry', () => this.load());
      on('start', () => this.startNav());
      on('end', () => this.endNav());
      on('select', (e) => this.selectRoute(e.currentTarget.getAttribute('data-mode')));
    }
  }

  // --------------------------------------------------------------------------
  // Contribution ("Your impact")
  // --------------------------------------------------------------------------
  class ContributionScreen {
    constructor(container, opts = {}) {
      this.opts = opts;
      this.root = document.createElement('div');
      this.root.className = 'rs-scroll';
      this.root.style.cssText = 'position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;'
        + 'background:#F4F5F7;font-feature-settings:\'tnum\' 1';
      container.appendChild(this.root);
      this.state = { status: 'loading', dispKm: 0 };
      this.data = null; this._timer = null;
    }

    mount() {
      this.render(); this.load();
      window.RSI18n.onChange(() => this.render());
    }
    onShow() {}
    onHide() {}
    setState(patch, cb) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render(); if (cb) cb();
    }

    async load() {
      const demo = this.opts.demoState;
      if (demo === 'loading') { this.setState({ status: 'loading' }); return; }
      if (demo === 'error') { this.setState({ status: 'error' }); return; }
      if (demo === 'empty') { this.setState({ status: 'empty' }); return; }
      this.setState({ status: 'loading' });
      try {
        const d = await RSApi.getContrib(this.opts.user);
        if (demo === 'no_repairs') d.repairs = [];
        this.data = d;
        this.setState({ status: 'ready' }, () => this.countUp());
      } catch (e) {
        console.warn('RoadSense: contrib load failed', e && (e.message || e));
        this.setState({ status: 'error' });
      }
    }

    countUp() {
      const target = Number(this.data.km_mapped) || 0;
      const t0 = Date.now(), dur = 1100;
      if (this._timer) clearInterval(this._timer);
      this._timer = setInterval(() => {
        const p = Math.min(1, (Date.now() - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        this.setState({ dispKm: Math.round(target * e) });
        if (p >= 1) { clearInterval(this._timer); this._timer = null; }
      }, 32);
    }

    ago(x) {
      const ms = typeof x === 'number' ? (x < 1e12 ? x * 1000 : x) : Date.parse(x);
      const days = Math.round((Date.now() - ms) / 86400000);
      if (days <= 0) return T('ago_today');
      if (days === 1) return T('ago_yesterday');
      if (days < 14) return T('ago_days', { n: days });
      if (days < 60) return T('ago_weeks', { n: Math.round(days / 7) });
      return T('ago_months', { n: Math.round(days / 30) });
    }
    clsLabel(cls) {
      return T(({ pothole: 'cls_pothole', speed_breaker: 'cls_speed_breaker',
        rough_patch: 'cls_rough_patch' })[cls] || 'cls_hazard');
    }

    render() {
      const st = this.state, d = this.data;
      const ready = st.status === 'ready' && d;
      const coins = ready ? nf(d.coins) : '0';
      const avatar = (ready && d.region ? d.region[0] : 'N').toUpperCase();
      const streak = ready ? (d.streak_days || 0) : 0;
      const region = ready ? (d.region || 'Noida') : 'Noida';
      let html = '';

      // top bar
      html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:20px 18px 8px">
        <div style="display:flex;align-items:center;gap:11px">
          <div style="width:38px;height:38px;border-radius:50%;background:#2563EB;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;color:#fff">${avatar}</div>
          <div><div style="font-size:16px;font-weight:700;line-height:1.1">${T('your_impact')}</div>
            <div style="font-size:12.5px;color:#6B7280;margin-top:1px">${region} · ${T('streak_days', { n: streak })}</div></div>
        </div>
        <div style="display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:10px;background:#fff;border:1px solid #E5E7EB">
          <span style="font-size:14px;font-weight:700">₹${coins}</span>
        </div>
      </div>`;

      if (st.status === 'error') {
        html += `<div style="padding:110px 34px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:15px">
          <div style="font-size:15px;color:#6B7280;line-height:1.5">${T('contrib_error')}</div>
          <div data-act="retry" style="padding:10px 22px;border-radius:10px;background:#2563EB;color:#fff;font-size:14px;font-weight:600;cursor:pointer">${T('retry')}</div></div>`;
      } else if (st.status === 'empty') {
        html += `<div style="padding:100px 40px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:18px">
          <div style="width:70px;height:70px;border-radius:16px;background:#EAF1FE;display:flex;align-items:center;justify-content:center">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19h16M6 19V9l6-4 6 4v10M10 19v-5h4v5"/></svg>
          </div>
          <div style="font-size:21px;font-weight:700;line-height:1.35">${T('empty_title')}</div>
          <div style="font-size:14px;color:#6B7280;line-height:1.55;max-width:250px">${T('empty_sub')}</div></div>`;
      } else {
        // MAIN (loading uses zeroed placeholders)
        const C = 2 * Math.PI * 106;
        const heroUnit = ready ? (d.hero_unit || 'km') : 'km';
        const goal = ready ? (d.monthly_goal || 300) : 300;
        const frac = ready ? Math.min(1, st.dispKm / goal) : 0;
        const goalMet = ready && Number(d.km_mapped) >= goal;
        const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const activity = ready ? (d.week_activity || []) : [];
        const today = ready ? (d.today_index != null ? d.today_index : 6) : 6;
        const repairs = ready ? d.repairs : [];
        const badges = ready ? d.badges : [];
        const dKm = ready ? nf(st.dispKm) : '0';

        html += `<div style="padding:4px 0 24px">
          <div style="position:relative;height:280px;display:flex;align-items:center;justify-content:center">
            <svg width="240" height="240" viewBox="0 0 240 240" style="position:absolute">
              <circle cx="120" cy="120" r="106" fill="none" stroke="#E5E7EB" stroke-width="12"></circle>
              <circle cx="120" cy="120" r="106" fill="none" stroke="#2563EB" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(C * frac).toFixed(1)} ${C}" transform="rotate(-90 120 120)" style="transition:stroke-dasharray .25s"></circle>
            </svg>
            <div style="position:relative;text-align:center">
              <div style="font-size:13px;font-weight:600;color:#6B7280">${T('mapped_this_month')}</div>
              <div style="font-size:56px;font-weight:700;letter-spacing:-.03em;line-height:1;margin-top:8px;color:#111827">${dKm}</div>
              <div style="font-size:14px;font-weight:500;color:#6B7280;margin-top:6px">${heroUnit}</div>
              ${goalMet ? `<div style="display:inline-flex;align-items:center;gap:5px;margin-top:12px;padding:5px 11px;border-radius:999px;background:#E7F6EC">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#16A34A" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>
                <span style="font-size:12.5px;font-weight:600;color:#166534">${T('goal_reached')}</span></div>` : ''}
            </div>
          </div>

          <div style="margin:6px 16px 0;padding:16px 16px 12px;border-radius:14px;background:#fff;border:1px solid #E5E7EB">
            <div style="font-size:12px;font-weight:600;color:#6B7280;margin-bottom:12px">${T('this_week')}</div>
            <div style="display:flex;justify-content:space-between">
              ${days.map((label, i) => {
                const isToday = i === today, done = !!activity[i];
                const bg = isToday ? '#2563EB' : (done ? '#EAF1FE' : '#F3F4F6');
                const border = (isToday || done) ? 'none' : '1px solid #E5E7EB';
                const checkShow = (isToday || done) ? 'inline-flex' : 'none';
                const checkColor = isToday ? '#fff' : '#2563EB';
                return `<div style="display:flex;flex-direction:column;align-items:center;gap:9px;width:34px">
                  <span style="font-size:11px;color:#9AA1AC">${label}</span>
                  <div style="width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${bg};border:${border}">
                    <span style="display:${checkShow};color:${checkColor}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg></span>
                  </div></div>`;
              }).join('')}
            </div>
          </div>

          <div style="display:flex;gap:11px;margin:12px 16px 0">
            ${this._statCard('#E7F6EC', '#16A34A', '<path d="M5 12.5l4.2 4.2L19 7"/>', ready ? nf(d.hazards_repaired) : 0, T('stat_repaired'))}
            ${this._statCard('#EAF1FE', '#2563EB', '<path d="M9 11l3 3L22 4"/><path d="M21 12a9 9 0 1 1-6.2-8.5"/>', ready ? nf(d.hazards_confirmed_by_you) : 0, T('stat_confirmed'))}
            ${this._statCard('#F3F4F6', '#6B7280', '<path d="M3 12h3l3-8 4 16 3-8h5"/>', ready ? nf(d.events_contributed) : 0, T('stat_sensed'))}
          </div>`;

        // repair highlight
        if (ready && repairs.length > 0) {
          const top = repairs[0];
          const reportsText = T(top.your_reports === 1 ? 'reports_from_you_1' : 'reports_from_you_n',
            { n: top.your_reports });
          html += `<div style="margin:14px 16px 0;border-radius:14px;background:#fff;border:1px solid #E5E7EB;padding:15px 16px">
            <div style="display:flex;align-items:center;gap:11px">
              <div style="width:36px;height:36px;border-radius:50%;background:#16A34A;display:flex;align-items:center;justify-content:center;flex:none">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>
              </div>
              <div style="flex:1;min-width:0">
                <div style="font-size:11px;font-weight:700;letter-spacing:.05em;color:#16A34A">${T('repaired_caps')}</div>
                <div style="font-size:14.5px;font-weight:600;line-height:1.35;margin-top:3px">${T('repaired_line', { cls: this.clsLabel(top.cls), loc: top.location })}</div>
              </div>
            </div>
            <div style="font-size:12.5px;color:#6B7280;margin-top:10px;padding-top:10px;border-top:1px solid #F0F1F4">${this.ago(top.repaired_at)} · ${reportsText}</div>
          </div>`;
        } else if (ready) {
          html += `<div style="margin:14px 16px 0;border-radius:14px;background:#fff;border:1px solid #E5E7EB;padding:15px 16px;display:flex;align-items:center;gap:11px">
            <div style="width:36px;height:36px;border-radius:50%;background:#EAF1FE;display:flex;align-items:center;justify-content:center;flex:none">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2-5 4 10 2-5h6"/></svg>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:14.5px;font-weight:600;line-height:1.35">${T('hazards_confirmed_line', { n: nf(d.hazards_confirmed_by_you) })}</div>
              <div style="font-size:12.5px;color:#6B7280;margin-top:2px">${T('fixed_soon')}</div>
            </div></div>`;
        }

        // badges
        if (ready && badges.length) {
          html += `<div style="display:flex;flex-wrap:wrap;gap:9px;margin:16px 16px 0">
            ${badges.map(b => `<div style="display:flex;align-items:center;gap:7px;padding:8px 13px;border-radius:999px;background:#fff;border:1px solid #E5E7EB;font-size:13px;font-weight:500;color:#374151">
              <span style="width:6px;height:6px;border-radius:50%;background:#2563EB"></span>${b.label}</div>`).join('')}
          </div>`;
        }

        // earnings row
        html += `<div data-act="details" style="display:flex;align-items:center;justify-content:space-between;margin:20px 16px 0;padding:14px 4px 4px;border-top:1px solid #E5E7EB;cursor:pointer">
          <span style="font-size:14px;color:#6B7280">${T('earned_from_mapping', { coins: `<span style="color:#111827;font-weight:600">₹${coins}</span>` })}</span>
          <span style="font-size:13px;color:#2563EB;font-weight:600">${T('details')} ›</span>
        </div>
        <div style="height:20px"></div></div>`;
      }

      this.root.innerHTML = html;
      this.root.querySelectorAll('[data-act="retry"]').forEach(el => el.addEventListener('click', () => this.load()));
    }

    _statCard(bg, stroke, path, value, label) {
      return `<div style="flex:1;border-radius:14px;background:#fff;border:1px solid #E5E7EB;padding:14px 13px 15px">
        <div style="width:30px;height:30px;border-radius:8px;background:${bg};display:flex;align-items:center;justify-content:center;margin-bottom:11px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>
        </div>
        <div style="font-size:21px;font-weight:700;line-height:1;letter-spacing:-.02em">${value}</div>
        <div style="font-size:12px;color:#6B7280;margin-top:5px;line-height:1.3">${label}</div>
      </div>`;
    }
  }

  window.RouteComparisonScreen = RouteComparisonScreen;
  window.ContributionScreen = ContributionScreen;
})();
