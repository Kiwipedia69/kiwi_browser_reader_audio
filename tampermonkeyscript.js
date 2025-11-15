// ==UserScript==
// @name         NovelBin TTS Auto-Reader + Auto-Next (+ Night Mode) [chr-content p-only]
// @namespace    qb.novelbin.tts
// @version      1.3.0
// @description  Lit uniquement les <p> de #chr-content.chr-c, passe au chapitre suivant, avec mode nuit.
// @match        https://novelbin.com/b/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  const LS_KEYS = {
    autoplay: "nb_tts_autoplay",
    rate: "nb_tts_rate",
    voice: "nb_tts_voiceName",
    night: "nb_tts_night",
  };

  const state = {
    queue: [], idx: 0, playing: false, paused: false,
    utterance: null, voices: [], ui: null, styleEl: null,
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const save = (k, v) => { try { localStorage.setItem(k, String(v)); } catch {} };
  const load = (k, d=null) => { try { const v = localStorage.getItem(k); return v===null?d:v; } catch { return d; } };
  const sanitizeText = s => s.replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();

  // --- Extraction ciblée: uniquement les <p> à l'intérieur de #chr-content.chr-c ---
  function extractChapterText() {
    const container = document.querySelector('#chr-content.chr-c') ||
                      document.querySelector('#chr-content') ||
                      document.querySelector('.chr-content') ||
                      document.body;

    // On prend UNIQUEMENT les <p> visibles et non triviaux
    const paras = $$('p', container).filter(p =>
      p.offsetParent !== null && (p.textContent || '').trim().length > 20
    );

    const raw = paras.map(p => p.textContent).join('\n');

    // Nettoyage éventuels de barres/options si injectées dans le flux
    const cleaned = raw
      .replace(/^\s*Show menu.*?Options.*?No line break.*?Yes No\s*/is, '');

    return sanitizeText(cleaned);
  }

  // Découpage TTS
  function toChunks(text, maxLen = 300) {
    const sentences = text.split(/(?<=[\.\!\?…])\s+(?=[A-Z0-9“"'\(])/g);
    const chunks = []; let buf = '';
    for (const s of sentences) {
      if ((buf + ' ' + s).trim().length > maxLen) { if (buf) chunks.push(buf.trim()); buf = s; }
      else { buf = (buf ? buf + ' ' : '') + s; }
    }
    if (buf) chunks.push(buf.trim());
    return chunks;
  }

  function findNextLink() {
    return $("a[rel='next']") ||
           $$("a").find(a => /^(Next Chapter|Next)$/i.test((a.textContent||"").trim())) ||
           $$("a,button").find(a => /next/i.test(a.className||"") && /next/i.test(a.textContent||"")) ||
           null;
  }

  // --- UI ---
  function buildUI() {
    const box = document.createElement('div');
    Object.assign(box.style, {
      position:'fixed', zIndex:'2147483647', right:'10px', bottom:'10px', maxWidth:'90vw',
      background:'rgba(20,20,20,0.9)', color:'#fff', padding:'10px', borderRadius:'12px',
      boxShadow:'0 6px 18px rgba(0,0,0,0.4)', font:'14px/1.3 system-ui,-apple-system,Roboto,Arial'
    });
    box.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center">
        <button id="nbtts-play">▶︎</button>
        <button id="nbtts-pause">⏸</button>
        <button id="nbtts-stop">⏹</button>
        <label style="display:flex; align-items:center; gap:6px;">
          Vitesse <input id="nbtts-rate" type="number" min="0.5" max="2" step="0.1" style="width:60px;">
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          Auto-suivant <input id="nbtts-autonext" type="checkbox">
        </label>
        <select id="nbtts-voice" style="max-width:40vw;"></select>
        <label style="display:flex; align-items:center; gap:6px; margin-left:8px;">
          Mode nuit <input id="nbtts-night" type="checkbox">
        </label>
      </div>
    `;
    document.documentElement.appendChild(box);

    state.ui = {
      box,
      play: $('#nbtts-play', box),
      pause: $('#nbtts-pause', box),
      stop: $('#nbtts-stop', box),
      rate: $('#nbtts-rate', box),
      auto: $('#nbtts-autonext', box),
      voice: $('#nbtts-voice', box),
      night: $('#nbtts-night', box),
    };

    state.ui.rate.value = load(LS_KEYS.rate, '1.0');
    state.ui.auto.checked = load(LS_KEYS.autoplay, '0') === '1';
    state.ui.night.checked = load(LS_KEYS.night, '0') === '1';

    state.ui.play.addEventListener('click', start);
    state.ui.pause.addEventListener('click', togglePause);
    state.ui.stop.addEventListener('click', stop);
    state.ui.rate.addEventListener('change', () => save(LS_KEYS.rate, state.ui.rate.value));
    state.ui.auto.addEventListener('change', () => save(LS_KEYS.autoplay, state.ui.auto.checked ? '1' : '0'));
    state.ui.voice.addEventListener('change', () => save(LS_KEYS.voice, state.ui.voice.value || ''));
    state.ui.night.addEventListener('change', () => applyNightMode(state.ui.night.checked));

    for (const b of [state.ui.play, state.ui.pause, state.ui.stop]) {
      Object.assign(b.style, {
        background:'#2b2b2b', color:'#fff', border:'1px solid #555',
        borderRadius:'8px', padding:'6px 10px', cursor:'pointer'
      });
    }
  }

  function populateVoices() {
    const wanted = load(LS_KEYS.voice, '');
    state.voices = window.speechSynthesis.getVoices() || [];
    state.ui.voice.innerHTML = '';
    const sorted = state.voices.slice().sort((a,b)=>{
      const ap = /en/i.test(a.lang) ? 0 : 1; const bp = /en/i.test(b.lang) ? 0 : 1;
      return ap - bp || a.name.localeCompare(b.name);
    });
    for (const v of sorted) {
      const opt = document.createElement('option');
      opt.value = v.name; opt.textContent = `${v.name} (${v.lang})`;
      if (v.name === wanted) opt.selected = true;
      state.ui.voice.appendChild(opt);
    }
  }

  // --- Mode nuit ---
  const NIGHT_CLASS = 'nbtts-night';
  const NIGHT_CSS = `
    html.${NIGHT_CLASS}, html.${NIGHT_CLASS} body { background-color:#0e0f12 !important; color:#e7e7e7 !important; }
    html.${NIGHT_CLASS} a { color:#8ab4f8 !important; }
    html.${NIGHT_CLASS} #chr-content, html.${NIGHT_CLASS} .chr-content,
    html.${NIGHT_CLASS} .chapter-content, html.${NIGHT_CLASS} .reading-content,
    html.${NIGHT_CLASS} main, html.${NIGHT_CLASS} article, html.${NIGHT_CLASS} .container, html.${NIGHT_CLASS} .content {
      background:transparent !important; color:#e7e7e7 !important;
    }
    html.${NIGHT_CLASS} img, html.${NIGHT_CLASS} picture, html.${NIGHT_CLASS} video, html.${NIGHT_CLASS} canvas { filter:none !important; }
  `;
  function ensureNightStyle() {
    if (state.styleEl) return;
    const el = document.createElement('style');
    el.id = 'nbtts-night-style'; el.textContent = NIGHT_CSS; document.head.appendChild(el);
    state.styleEl = el;
  }
  function applyNightMode(on) {
    ensureNightStyle();
    document.documentElement.classList.toggle(NIGHT_CLASS, !!on);
    save(LS_KEYS.night, on ? '1' : '0');
  }

  // --- TTS ---
  function currentVoice() {
    const name = state.ui.voice.value || load(LS_KEYS.voice, '');
    return name ? state.voices.find(v => v.name === name) || null : null;
  }
  function speakNext() {
    if (!state.playing || state.paused) return;
    if (state.idx >= state.queue.length) { onChapterEnd(); return; }
    const u = new SpeechSynthesisUtterance(state.queue[state.idx++]);
    u.rate = Math.max(0.5, Math.min(2, parseFloat(state.ui.rate.value) || 1.0));
    const v = currentVoice(); if (v) u.voice = v;
    u.onend = () => speakNext(); u.onerror = () => speakNext();
    state.utterance = u; window.speechSynthesis.speak(u);
  }
  function start() {
    stop(true);
    const text = extractChapterText();
    state.queue = toChunks(text);
    state.idx = 0; state.playing = true; state.paused = false;
    speakNext();
  }
  function togglePause() {
    if (!state.playing) return;
    if (!state.paused) { window.speechSynthesis.pause(); state.paused = true; }
    else { state.paused = false; window.speechSynthesis.resume(); }
  }
  function stop(keepUI=false) {
    try { window.speechSynthesis.cancel(); } catch {}
    state.playing = false; state.paused = false; state.queue = []; state.idx = 0; state.utterance = null;
    if (!keepUI && state.ui?.box) state.ui.box.remove();
  }
  function onChapterEnd() {
    if (state.ui.auto.checked) {
      save(LS_KEYS.autoplay, '1');
      const next = findNextLink();
      if (next) { next.click(); return; }
    }
    stop(true);
  }

  // --- Boot ---
  function boot() {
    if (!('speechSynthesis' in window)) { console.warn('[NB TTS] speechSynthesis non supporté.'); return; }
    buildUI(); ensureNightStyle(); applyNightMode(load(LS_KEYS.night, '0') === '1');
    populateVoices();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.onvoiceschanged = () => populateVoices();
    if (load(LS_KEYS.autoplay, '0') === '1') setTimeout(() => start(), 600);
  }

  if (!window.__NB_TTS_INIT__) {
    window.__NB_TTS_INIT__ = true;
    boot();
    window.addEventListener('beforeunload', () => { try { speechSynthesis.cancel(); } catch {} });
  }
})();
