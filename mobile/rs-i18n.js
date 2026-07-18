// ============================================================================
// RoadSense i18n — the multilingual engine for the driver app.
//   window.RSI18n.t(key, params)  -> translated string for the active language
//                                    ({name} tokens filled from params)
//   window.RSI18n.set(code)       -> switch language app-wide (persisted)
//   window.RSI18n.get()           -> active language code
//   window.RSI18n.langs()         -> [{code, native, en}] for the picker
//   window.RSI18n.onChange(fn)    -> notified whenever the language changes
//   window.RSI18n.ready(code)     -> Promise resolved once that language's
//                                    app-screen strings are loaded
//
// The language a driver picks in onboarding is the language the whole app
// speaks. It is stored in localStorage ('rs_lang') so every screen and every
// later session honours it. Onboarding/login copy lives inline below; the
// main app-screen strings (routes, contribution) are PRE-BAKED by Sarvam into
// mobile/i18n/app.<lang>.json and fetched at runtime — so the running app
// needs no network for text. Any string missing in the active language falls
// back to English, so partial dictionaries never break a screen.
// ============================================================================
window.RSI18n = (function () {
  const LANGS = [
    { code: 'en', native: 'English',  en: 'English' },
    { code: 'hi', native: 'हिन्दी',   en: 'Hindi'   },
    { code: 'bn', native: 'বাংলা',    en: 'Bengali' },
    { code: 'ta', native: 'தமிழ்',    en: 'Tamil'   },
    { code: 'te', native: 'తెలుగు',   en: 'Telugu'  },
    { code: 'mr', native: 'मराठी',    en: 'Marathi' },
  ];

  const STR = {
    en: {
      lang_title: 'Choose your language',
      lang_sub: 'This sets the language for the whole app. You can change it later in Settings.',
      continue: 'Continue',
      slide1_title: 'Roads that map themselves',
      slide1_body: 'RoadSense senses potholes, bumps and rough patches in the background as you drive. No taps needed.',
      slide2_title: 'Your reports get roads fixed',
      slide2_body: 'Confirmed hazards go straight to local authorities — and you hear back the moment one is repaired.',
      slide3_title: 'Earn as you drive',
      slide3_body: 'Every kilometre you map earns rewards. Track your impact and streak right from the home screen.',
      next: 'Next',
      get_started: 'Get started',
      skip: 'Skip',
      login_title: 'Welcome back',
      login_sub: 'Sign in to keep mapping and earning.',
      phone_email: 'Phone or email',
      password: 'Password',
      forgot: 'Forgot?',
      login_err: 'Incorrect credentials. Try demo / demo.',
      sign_in: 'Sign in',
      or: 'or',
      email_link: 'Continue with email link',
      github: 'Continue with GitHub',
      new_here: 'New here?',
      create_account: 'Create an account',
      done_title: "You're all set",
      signed_as: 'Signed in as',
      language_label: 'Language',
      open_app: 'Open RoadSense',
      restart: 'Restart flow',
    },
    hi: {
      lang_title: 'अपनी भाषा चुनें',
      lang_sub: 'यह पूरे ऐप की भाषा तय करता है। आप इसे बाद में सेटिंग्स में बदल सकते हैं।',
      continue: 'आगे बढ़ें',
      slide1_title: 'सड़कें जो खुद का नक्शा बनाती हैं',
      slide1_body: 'RoadSense गाड़ी चलाते समय पृष्ठभूमि में गड्ढों, उबड़-खाबड़ और खराब हिस्सों को पहचानता है। किसी टैप की ज़रूरत नहीं।',
      slide2_title: 'आपकी रिपोर्ट से सड़कें ठीक होती हैं',
      slide2_body: 'पुष्ट खतरे सीधे स्थानीय अधिकारियों तक पहुँचते हैं — और मरम्मत होते ही आपको सूचना मिलती है।',
      slide3_title: 'चलाते-चलाते कमाएँ',
      slide3_body: 'आप जितने किलोमीटर मैप करते हैं, हर एक इनाम दिलाता है। अपना प्रभाव और स्ट्रीक होम स्क्रीन पर देखें।',
      next: 'आगे',
      get_started: 'शुरू करें',
      skip: 'छोड़ें',
      login_title: 'वापसी पर स्वागत है',
      login_sub: 'मैपिंग और कमाई जारी रखने के लिए साइन इन करें।',
      phone_email: 'फ़ोन या ईमेल',
      password: 'पासवर्ड',
      forgot: 'भूल गए?',
      login_err: 'गलत क्रेडेंशियल। demo / demo आज़माएँ।',
      sign_in: 'साइन इन करें',
      or: 'या',
      email_link: 'ईमेल लिंक से जारी रखें',
      github: 'GitHub से जारी रखें',
      new_here: 'नए हैं?',
      create_account: 'खाता बनाएँ',
      done_title: 'सब तैयार है',
      signed_as: 'साइन इन',
      language_label: 'भाषा',
      open_app: 'RoadSense खोलें',
      restart: 'फिर से शुरू करें',
    },
    bn: {
      lang_title: 'আপনার ভাষা নির্বাচন করুন',
      lang_sub: 'এটি পুরো অ্যাপের ভাষা নির্ধারণ করে। আপনি পরে সেটিংসে এটি পরিবর্তন করতে পারেন।',
      continue: 'চালিয়ে যান',
      slide1_title: 'যে রাস্তা নিজেই মানচিত্র তৈরি করে',
      slide1_body: 'আপনি গাড়ি চালানোর সময় RoadSense পটভূমিতে গর্ত, ঝাঁকুনি ও খারাপ অংশ শনাক্ত করে। কোনো ট্যাপ প্রয়োজন নেই।',
      slide2_title: 'আপনার রিপোর্ট রাস্তা মেরামত করায়',
      slide2_body: 'নিশ্চিত বিপদ সরাসরি স্থানীয় কর্তৃপক্ষের কাছে যায় — এবং মেরামত হলেই আপনি জানতে পারেন।',
      slide3_title: 'চালানোর সাথে সাথে আয় করুন',
      slide3_body: 'আপনি প্রতিটি কিলোমিটার ম্যাপ করলে পুরস্কার পান। হোম স্ক্রিন থেকেই আপনার প্রভাব ও স্ট্রিক দেখুন।',
      next: 'পরবর্তী',
      get_started: 'শুরু করুন',
      skip: 'এড়িয়ে যান',
      login_title: 'আবার স্বাগতম',
      login_sub: 'ম্যাপিং ও উপার্জন চালিয়ে যেতে সাইন ইন করুন।',
      phone_email: 'ফোন বা ইমেল',
      password: 'পাসওয়ার্ড',
      forgot: 'ভুলে গেছেন?',
      login_err: 'ভুল তথ্য। demo / demo চেষ্টা করুন।',
      sign_in: 'সাইন ইন',
      or: 'অথবা',
      email_link: 'ইমেল লিঙ্ক দিয়ে চালিয়ে যান',
      github: 'GitHub দিয়ে চালিয়ে যান',
      new_here: 'নতুন?',
      create_account: 'অ্যাকাউন্ট তৈরি করুন',
      done_title: 'সব প্রস্তুত',
      signed_as: 'সাইন ইন',
      language_label: 'ভাষা',
      open_app: 'RoadSense খুলুন',
      restart: 'আবার শুরু করুন',
    },
    ta: {
      lang_title: 'உங்கள் மொழியைத் தேர்ந்தெடுக்கவும்',
      lang_sub: 'இது முழு பயன்பாட்டின் மொழியை அமைக்கிறது. பின்னர் அமைப்புகளில் மாற்றலாம்.',
      continue: 'தொடரவும்',
      slide1_title: 'தானாகவே வரைபடமாகும் சாலைகள்',
      slide1_body: 'நீங்கள் ஓட்டும்போது RoadSense பின்னணியில் குழிகள், குலுக்கல் மற்றும் மோசமான பகுதிகளை உணரும். தட்ட வேண்டாம்.',
      slide2_title: 'உங்கள் அறிக்கைகள் சாலைகளைச் சரிசெய்கின்றன',
      slide2_body: 'உறுதிசெய்யப்பட்ட ஆபத்துகள் நேரடியாக உள்ளூர் அதிகாரிகளுக்குச் செல்கின்றன — சரிசெய்யப்பட்டவுடன் உங்களுக்குத் தெரிவிக்கப்படும்.',
      slide3_title: 'ஓட்டும்போதே சம்பாதியுங்கள்',
      slide3_body: 'நீங்கள் வரைபடமாக்கும் ஒவ்வொரு கிலோமீட்டரும் வெகுமதி பெறும். உங்கள் தாக்கத்தை முகப்புத் திரையில் காணுங்கள்.',
      next: 'அடுத்து',
      get_started: 'தொடங்கு',
      skip: 'தவிர்',
      login_title: 'மீண்டும் வரவேற்கிறோம்',
      login_sub: 'வரைபடமாக்கலையும் சம்பாதிப்பையும் தொடர உள்நுழையவும்.',
      phone_email: 'தொலைபேசி அல்லது மின்னஞ்சல்',
      password: 'கடவுச்சொல்',
      forgot: 'மறந்துவிட்டீர்களா?',
      login_err: 'தவறான விவரங்கள். demo / demo முயற்சிக்கவும்.',
      sign_in: 'உள்நுழை',
      or: 'அல்லது',
      email_link: 'மின்னஞ்சல் இணைப்புடன் தொடரவும்',
      github: 'GitHub உடன் தொடரவும்',
      new_here: 'புதியவரா?',
      create_account: 'கணக்கை உருவாக்கு',
      done_title: 'அனைத்தும் தயார்',
      signed_as: 'உள்நுழைந்தது',
      language_label: 'மொழி',
      open_app: 'RoadSense ஐத் திற',
      restart: 'மீண்டும் தொடங்கு',
    },
    te: {
      lang_title: 'మీ భాషను ఎంచుకోండి',
      lang_sub: 'ఇది మొత్తం యాప్ భాషను సెట్ చేస్తుంది. తర్వాత సెట్టింగ్‌లలో మార్చవచ్చు.',
      continue: 'కొనసాగించు',
      slide1_title: 'తమను తామే మ్యాప్ చేసుకునే రహదారులు',
      slide1_body: 'మీరు నడుపుతున్నప్పుడు RoadSense నేపథ్యంలో గుంతలు, కుదుపులు, చెడు ప్రాంతాలను గుర్తిస్తుంది. ట్యాప్ అవసరం లేదు.',
      slide2_title: 'మీ నివేదికలు రహదారులను బాగుచేస్తాయి',
      slide2_body: 'నిర్ధారించిన ప్రమాదాలు నేరుగా స్థానిక అధికారులకు వెళ్తాయి — మరమ్మతు జరిగిన వెంటనే మీకు తెలుస్తుంది.',
      slide3_title: 'నడుపుతూ సంపాదించండి',
      slide3_body: 'మీరు మ్యాప్ చేసే ప్రతి కిలోమీటరుకు రివార్డులు లభిస్తాయి. మీ ప్రభావాన్ని హోమ్ స్క్రీన్‌లో చూడండి.',
      next: 'తదుపరి',
      get_started: 'ప్రారంభించు',
      skip: 'దాటవేయి',
      login_title: 'తిరిగి స్వాగతం',
      login_sub: 'మ్యాపింగ్ మరియు సంపాదన కొనసాగించడానికి సైన్ ఇన్ చేయండి.',
      phone_email: 'ఫోన్ లేదా ఇమెయిల్',
      password: 'పాస్‌వర్డ్',
      forgot: 'మర్చిపోయారా?',
      login_err: 'తప్పు వివరాలు. demo / demo ప్రయత్నించండి.',
      sign_in: 'సైన్ ఇన్',
      or: 'లేదా',
      email_link: 'ఇమెయిల్ లింక్‌తో కొనసాగించు',
      github: 'GitHub తో కొనసాగించు',
      new_here: 'కొత్తవారా?',
      create_account: 'ఖాతా సృష్టించు',
      done_title: 'అంతా సిద్ధం',
      signed_as: 'సైన్ ఇన్',
      language_label: 'భాష',
      open_app: 'RoadSense తెరవండి',
      restart: 'మళ్లీ ప్రారంభించు',
    },
    mr: {
      lang_title: 'तुमची भाषा निवडा',
      lang_sub: 'हे संपूर्ण अ‍ॅपची भाषा ठरवते. तुम्ही नंतर सेटिंग्जमध्ये बदलू शकता.',
      continue: 'पुढे चला',
      slide1_title: 'स्वतःचा नकाशा बनवणारे रस्ते',
      slide1_body: 'तुम्ही गाडी चालवताना RoadSense पार्श्वभूमीत खड्डे, धक्के आणि खराब भाग ओळखते. टॅप करण्याची गरज नाही.',
      slide2_title: 'तुमच्या तक्रारींमुळे रस्ते दुरुस्त होतात',
      slide2_body: 'निश्चित धोके थेट स्थानिक अधिकाऱ्यांकडे जातात — आणि दुरुस्ती होताच तुम्हाला कळते.',
      slide3_title: 'चालवताना कमवा',
      slide3_body: 'तुम्ही मॅप करता तो प्रत्येक किलोमीटर बक्षीस मिळवतो. तुमचा प्रभाव होम स्क्रीनवर पाहा.',
      next: 'पुढे',
      get_started: 'सुरू करा',
      skip: 'वगळा',
      login_title: 'पुन्हा स्वागत आहे',
      login_sub: 'मॅपिंग आणि कमाई सुरू ठेवण्यासाठी साइन इन करा.',
      phone_email: 'फोन किंवा ईमेल',
      password: 'पासवर्ड',
      forgot: 'विसरलात?',
      login_err: 'चुकीची माहिती. demo / demo वापरून पाहा.',
      sign_in: 'साइन इन',
      or: 'किंवा',
      email_link: 'ईमेल लिंकसह सुरू ठेवा',
      github: 'GitHub सह सुरू ठेवा',
      new_here: 'नवीन आहात?',
      create_account: 'खाते तयार करा',
      done_title: 'सर्व तयार',
      signed_as: 'साइन इन',
      language_label: 'भाषा',
      open_app: 'RoadSense उघडा',
      restart: 'पुन्हा सुरू करा',
    },
  };

  // Pre-baked app-screen dictionaries (mobile/i18n/app.<lang>.json), lazily
  // fetched and cached per language. English is the always-present base.
  const APP = { en: null };
  const appLoads = {};   // code -> Promise (dedupes concurrent fetches)

  function loadApp(code) {
    if (appLoads[code]) return appLoads[code];
    appLoads[code] = fetch(`i18n/app.${code}.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (json) APP[code] = json; })
      .catch(() => { /* offline / missing — fall back to inline + English */ });
    return appLoads[code];
  }

  const listeners = [];
  let current = 'en';
  try {
    const saved = localStorage.getItem('rs_lang');
    if (saved && STR[saved]) current = saved;
  } catch (_) { /* storage unavailable — stay on default */ }
  // A ?lang= override (onboarding passes it when opening app.html) wins and is
  // persisted, so the app opens in the language chosen during onboarding.
  try {
    const q = new URLSearchParams(location.search).get('lang');
    if (q && STR[q]) { current = q; try { localStorage.setItem('rs_lang', q); } catch (_) {} }
  } catch (_) {}

  // Kick off loading English (base) + the active language immediately.
  loadApp('en');
  if (current !== 'en') loadApp(current);

  function interpolate(str, params) {
    if (!params) return str;
    return str.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? params[k] : m));
  }

  function t(key, params) {
    // Resolution order: app dict (active -> English) -> inline onboarding dict
    // (active -> English) -> the key itself.
    const app = APP[current], appEn = APP.en, tbl = STR[current] || STR.en;
    let val;
    if (app && key in app) val = app[key];
    else if (appEn && key in appEn) val = appEn[key];
    else if (key in tbl) val = tbl[key];
    else if (STR.en[key] != null) val = STR.en[key];
    else val = key;
    return interpolate(val, params);
  }

  function set(code) {
    if (!STR[code] || code === current) { if (STR[code]) current = code; }
    current = STR[code] ? code : current;
    try { localStorage.setItem('rs_lang', current); } catch (_) {}
    if (typeof document !== 'undefined') document.documentElement.lang = current;
    // Ensure the app dictionary is present before/while notifying; listeners
    // re-render again when the fetch resolves so late strings appear.
    loadApp(current).then(() => listeners.forEach((fn) => { try { fn(current); } catch (_) {} }));
    listeners.forEach((fn) => { try { fn(current); } catch (_) {} });
  }

  function get() { return current; }
  function langs() { return LANGS.slice(); }
  function onChange(fn) { if (typeof fn === 'function') listeners.push(fn); }
  // Resolves once the given (or active) language's app strings are loaded.
  function ready(code) {
    const c = code || current;
    return Promise.all([loadApp('en'), c === 'en' ? null : loadApp(c)]);
  }

  if (typeof document !== 'undefined') document.documentElement.lang = current;
  return { t, set, get, langs, onChange, ready };
})();
