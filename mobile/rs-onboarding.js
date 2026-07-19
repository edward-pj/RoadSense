// ============================================================================
// RoadSense onboarding — vanilla port of Onboarding.dc.html.
//   window.OnboardingScreen  (language → intro slides → login → done)
//
// The first screen is language selection, and it is load-bearing: picking a
// language calls RSI18n.set(), which re-renders every following screen — and
// the rest of the app — in that language. The whole flow is driven by
// RSI18n.t(), so it is fully multilingual with zero hard-coded copy.
// Depends on rs-i18n.js (window.RSI18n).
// ============================================================================
(function () {
  const T = () => window.RSI18n;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const BLUE = '#2563EB';
  const CHECK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#2563EB" '
    + 'stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>';

  // Intro slides: [icon paths, title key, body key].
  const SLIDES = [
    { paths: ['M4 11.5L12 4l8 7.5', 'M6 10v9h12v-9'], title: 'slide1_title', body: 'slide1_body' },
    { paths: ['M9 11l3 3L22 4', 'M21 12a9 9 0 1 1-6.2-8.5'], title: 'slide2_title', body: 'slide2_body' },
    { paths: ['M3 8h18v13H3z', 'M3 12h18', 'M12 8v13', 'M8 8a2.5 2.5 0 1 1 4-2.5'], title: 'slide3_title', body: 'slide3_body' },
  ];

  const slideIcon = (paths) =>
    `<svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="${BLUE}" stroke-width="1.6" `
    + `stroke-linecap="round" stroke-linejoin="round">${paths.map((d) => `<path d="${d}"/>`).join('')}</svg>`;

  class OnboardingScreen {
    /**
     * @param {HTMLElement} container host element (fills it)
     * @param {{onComplete?: (info:{user:string, lang:string})=>void,
     *          onEnter?: (info:{user:string, lang:string})=>void}} opts
     *        onComplete fires after a successful sign-in (reaching the "done"
     *        screen). onEnter fires when the driver taps "Open RoadSense" on
     *        that screen — the shell routes into the main app here.
     */
    constructor(container, opts = {}) {
      this.opts = opts;
      this.root = document.createElement('div');
      this.root.className = 'rs-scroll';
      this.root.style.cssText = 'position:absolute;inset:0;overflow-y:auto;overflow-x:hidden;'
        + 'background:#F4F5F7;font-family:Inter,system-ui,sans-serif;color:#111827;'
        + '-webkit-font-smoothing:antialiased';
      container.appendChild(this.root);
      this.state = {
        step: 'lang',
        langIdx: Math.max(0, T().langs().findIndex((l) => l.code === T().get())),
        slide: 0, email: '', pass: '', loginErr: false, user: '',
      };
      // Re-render if the language changes from anywhere else in the app.
      T().onChange(() => { if (this._mounted) this.render(); });
    }

    mount() { this._mounted = true; this.render(); }
    onShow() {}
    onHide() {}

    setState(patch, cb) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      this.render();
      if (cb) cb();
    }

    render() {
      const s = this.state;
      let html = '';
      if (s.step === 'lang') html = this.renderLang();
      else if (s.step === 'onb') html = this.renderOnb();
      else if (s.step === 'login') html = this.renderLogin();
      else html = this.renderDone();
      this.root.innerHTML = html;
      this.bind();
      // Preserve focus/caret for the login inputs across re-render.
      if (s.step === 'login' && this._focus) {
        const el = this.root.querySelector(`[data-field="${this._focus}"]`);
        if (el) { el.focus(); const v = el.value.length; el.setSelectionRange(v, v); }
      }
    }

    // ---- LANGUAGE ----------------------------------------------------------
    renderLang() {
      const t = T().t.bind(T());
      const rows = T().langs().map((l, i) => {
        const on = this.state.langIdx === i;
        const rowStyle = 'display:flex;align-items:center;justify-content:space-between;'
          + 'padding:15px 16px;border-radius:14px;background:#fff;cursor:pointer;'
          + `border:1px solid ${on ? BLUE : '#E5E7EB'};`
          + (on ? `box-shadow:0 0 0 1px ${BLUE} inset;` : '');
        return `<div data-act="pick" data-i="${i}" style="${rowStyle}">
            <div style="display:flex;flex-direction:column;gap:2px">
              <span style="font-size:15px;font-weight:600">${esc(l.native)}</span>
              <span style="font-size:12.5px;color:#6B7280">${esc(l.en)}</span>
            </div>
            <span style="display:${on ? 'inline-flex' : 'none'}">${CHECK}</span>
          </div>`;
      }).join('');
      return `<div style="min-height:100%;padding:64px 22px 24px;display:flex;flex-direction:column">
        ${this.logo()}
        <div style="font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.2">${esc(t('lang_title'))}</div>
        <div style="font-size:14.5px;color:#6B7280;margin-top:8px;line-height:1.5">${esc(t('lang_sub'))}</div>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:26px">${rows}</div>
        <div style="flex:1;min-height:20px"></div>
        <div data-act="langNext" style="${this.primaryBtn()}">${esc(t('continue'))}</div>
      </div>`;
    }

    // ---- ONBOARDING SLIDES -------------------------------------------------
    renderOnb() {
      const t = T().t.bind(T());
      const s = this.state;
      const sl = SLIDES[s.slide];
      const dots = SLIDES.map((_, i) => {
        const on = i === s.slide;
        return `<div style="height:4px;border-radius:999px;transition:all .2s;`
          + `width:${on ? '24px' : '8px'};background:${on ? BLUE : '#D1D5DB'}"></div>`;
      }).join('');
      const last = s.slide >= SLIDES.length - 1;
      return `<div style="min-height:100%;display:flex;flex-direction:column;padding:64px 22px 24px">
        <div style="display:flex;gap:7px;margin-bottom:auto">${dots}</div>
        <div style="display:flex;flex-direction:column;align-items:center;text-align:center;margin:auto 0">
          <div style="width:132px;height:132px;border-radius:28px;background:#EAF1FE;display:flex;align-items:center;justify-content:center;margin-bottom:34px">
            ${slideIcon(sl.paths)}
          </div>
          <div style="font-size:25px;font-weight:700;letter-spacing:-.02em;line-height:1.25;text-wrap:pretty">${esc(t(sl.title))}</div>
          <div style="font-size:15px;color:#6B7280;margin-top:12px;line-height:1.55;max-width:300px;text-wrap:pretty">${esc(t(sl.body))}</div>
        </div>
        <div style="margin-top:auto;display:flex;flex-direction:column;gap:14px">
          <div data-act="onbNext" style="${this.primaryBtn()}">${esc(t(last ? 'get_started' : 'next'))}</div>
          <div data-act="skip" style="text-align:center;font-size:14px;font-weight:500;color:#6B7280;cursor:pointer;padding:4px">${esc(t('skip'))}</div>
        </div>
      </div>`;
    }

    // ---- LOGIN -------------------------------------------------------------
    renderLogin() {
      const t = T().t.bind(T());
      const s = this.state;
      const inputStyle = 'width:100%;height:50px;border-radius:12px;border:1px solid #E5E7EB;'
        + 'background:#fff;padding:0 15px;font-size:15px;font-family:inherit;color:#111827;outline:none';
      const socialBtn = 'height:50px;border-radius:14px;background:#fff;border:1px solid #E5E7EB;'
        + 'font-size:14.5px;font-weight:600;color:#374151;display:flex;align-items:center;'
        + 'justify-content:center;gap:10px;cursor:pointer';
      const err = s.loginErr
        ? `<div style="margin-top:12px;font-size:13px;color:#DC2626;font-weight:500">${esc(t('login_err'))}</div>` : '';
      return `<div style="min-height:100%;padding:64px 22px 24px;display:flex;flex-direction:column">
        ${this.logo()}
        <div style="font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.2">${esc(t('login_title'))}</div>
        <div style="font-size:14.5px;color:#6B7280;margin-top:8px;line-height:1.5">${esc(t('login_sub'))}</div>
        <div style="display:flex;flex-direction:column;gap:14px;margin-top:28px">
          <div>
            <div style="font-size:12.5px;font-weight:600;color:#374151;margin-bottom:7px">${esc(t('phone_email'))}</div>
            <input data-field="email" value="${esc(s.email)}" placeholder="you@example.com" style="${inputStyle}"/>
          </div>
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
              <span style="font-size:12.5px;font-weight:600;color:#374151">${esc(t('password'))}</span>
              <span style="font-size:12.5px;font-weight:600;color:${BLUE};cursor:pointer">${esc(t('forgot'))}</span>
            </div>
            <input data-field="pass" value="${esc(s.pass)}" type="password" placeholder="••••••••" style="${inputStyle}"/>
          </div>
        </div>
        ${err}
        <div data-act="login" style="${this.primaryBtn()}margin-top:22px">${esc(t('sign_in'))}</div>
        <div style="display:flex;align-items:center;gap:12px;margin:22px 0">
          <div style="flex:1;height:1px;background:#E5E7EB"></div>
          <span style="font-size:12px;color:#9AA1AC">${esc(t('or'))}</span>
          <div style="flex:1;height:1px;background:#E5E7EB"></div>
        </div>
        <div style="display:flex;flex-direction:column;gap:11px">
          <div style="${socialBtn}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>
            ${esc(t('email_link'))}
          </div>
          <div style="${socialBtn}">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.2-.3-4.6-1.1-4.6-4.9 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.7 0 0 .8-.3 2.7 1a9.3 9.3 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.4.2 2.4.1 2.7.6.7 1 1.6 1 2.7 0 3.8-2.3 4.6-4.6 4.9.4.3.7.9.7 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2z"/></svg>
            ${esc(t('github'))}
          </div>
        </div>
        <div style="flex:1;min-height:16px"></div>
        <div style="text-align:center;font-size:13.5px;color:#6B7280;margin-top:20px">${esc(t('new_here'))} <span style="color:${BLUE};font-weight:600;cursor:pointer">${esc(t('create_account'))}</span></div>
      </div>`;
    }

    // ---- DONE --------------------------------------------------------------
    renderDone() {
      const t = T().t.bind(T());
      const langEn = T().langs()[this.state.langIdx].en;
      return `<div style="min-height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:0 34px">
        <div style="width:76px;height:76px;border-radius:50%;background:#16A34A;display:flex;align-items:center;justify-content:center;margin-bottom:22px">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>
        </div>
        <div style="font-size:23px;font-weight:700;letter-spacing:-.02em">${esc(t('done_title'))}</div>
        <div style="font-size:14.5px;color:#6B7280;margin-top:10px;line-height:1.55">${esc(t('signed_as'))} <b style="color:#111827">${esc(this.state.user || 'demo')}</b> · ${esc(t('language_label'))}: <b style="color:#111827">${esc(langEn)}</b></div>
        <div data-act="enter" style="${this.primaryBtn()}width:100%;max-width:280px;margin-top:28px;gap:9px">
          ${esc(t('open_app'))}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>
        </div>
        <div data-act="restart" style="margin-top:14px;font-size:13.5px;font-weight:600;color:#6B7280;cursor:pointer;padding:4px">${esc(t('restart'))}</div>
      </div>`;
    }

    // ---- shared bits -------------------------------------------------------
    logo() {
      return `<div style="width:44px;height:44px;border-radius:12px;background:${BLUE};display:flex;`
        + `align-items:center;justify-content:center;font-size:18px;font-weight:700;color:#fff;margin-bottom:26px">R</div>`;
    }
    primaryBtn() {
      return `height:52px;border-radius:14px;background:${BLUE};color:#fff;font-size:15.5px;`
        + 'font-weight:600;display:flex;align-items:center;justify-content:center;cursor:pointer;';
    }

    // ---- events ------------------------------------------------------------
    bind() {
      const on = (act, fn) => this.root.querySelectorAll(`[data-act="${act}"]`).forEach((el) => el.addEventListener('click', fn));
      const s = this.state;

      on('pick', (e) => {
        const i = Number(e.currentTarget.getAttribute('data-i'));
        T().set(T().langs()[i].code);   // language switches app-wide, live
        this.setState({ langIdx: i });
      });
      on('langNext', () => this.setState({ step: 'onb', slide: 0 }));

      on('onbNext', () => {
        if (s.slide < SLIDES.length - 1) this.setState({ slide: s.slide + 1 });
        else this.setState({ step: 'login' });
      });
      on('skip', () => this.setState({ step: 'login' }));

      // Login inputs: track value + caret without losing focus on re-render.
      this.root.querySelectorAll('[data-field]').forEach((el) => {
        el.addEventListener('focus', () => { this._focus = el.getAttribute('data-field'); });
        el.addEventListener('input', (e) => {
          const f = e.target.getAttribute('data-field');
          this.state[f === 'email' ? 'email' : 'pass'] = e.target.value;
          this.state.loginErr = false;
        });
      });
      on('login', () => {
        this._focus = null;
        if (s.email.trim().toLowerCase() === 'demo' && s.pass === 'demo') {
          this.setState({ step: 'done', loginErr: false, user: 'demo' },
            () => this.opts.onComplete && this.opts.onComplete({ user: 'demo', lang: T().get() }));
        } else {
          this.setState({ loginErr: true });
        }
      });

      on('enter', () => this.opts.onEnter && this.opts.onEnter({ user: s.user || 'demo', lang: T().get() }));
      on('restart', () => this.setState({ step: 'lang', slide: 0, email: '', pass: '', loginErr: false, user: '' }));
    }
  }

  window.OnboardingScreen = OnboardingScreen;
})();
