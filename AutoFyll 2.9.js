// ==UserScript==
// @name         Havbruksloggen Autofyll v2.9
// @namespace    local.havbruksloggen.autofyll
// @version      2.9.0
// @description  Autofyll, AJAX-sikker sjekkliste, sluttkommentar og kompakt meny
// @match        https://havbruksloggen.no/*
// @match        https://www.havbruksloggen.no/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__HBL_AUTOFILL_V29__) return;
  window.__HBL_AUTOFILL_V29__ = true;

  const VERSION = '2.9';
  const KEY = 'hbl-v2-defaults';
  const SETTINGS_KEY = 'hbl-v29-settings';
  const POS_KEY = 'hbl-v22-position';

  const FIELD = {
    activity: 'MainContent_activityDDL',
    ship: 'MainContent_shipTxt',
    person: 'MainContent_responsiblePersonTxt',
    pressure: 'MainContent_pressureBarTxt',
    depth: 'MainContent_flushMeterTxt',
    washer: 'MainContent_washerTypeDDL',
    area: 'MainContent_kvmFlushTotalTxt',
    washComment: 'MainContent_commentWashTxt',
    finalComment: 'MainContent_commentTxt'
  };

  const CHOICES = [
    'Top', 'Side', 'Bunn',
    'Etterkontroll', 'Inspeksjon', 'Luseskjørt'
  ];

  const COMMENT_CHOICES = new Set(
    CHOICES.filter(x => x !== 'Luseskjørt')
  );

  const SKIRT = new Set([355, 356, 357, 358]);
  const YES = new Set([346, 347, 348, 363, 364, 365]);

  const CHECKLIST =
    'select[id^="MainContent_pkt"][id$="_VerdiKontroll"]';

  const $ = id => document.getElementById(id);
  const sleep = ms =>
    new Promise(resolve => setTimeout(resolve, ms));

  function load(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function store(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function html(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    })[c]);
  }

  const previous = load(KEY, {});

  const defaults = {
    activity: previous.activity || '',
    ship: previous.ship || '',
    person: previous.person || '',
    people: Array.isArray(previous.people)
      ? previous.people : [],
    pressure: previous.pressure || '',
    depth: previous.depth || '',
    washer: previous.washer || '',
    area: previous.area || '',
    finalComment: previous.finalComment || '',
    checks: Array.isArray(previous.checks)
      ? previous.checks
      : ['Top', 'Side', 'Etterkontroll']
  };

  defaults.checks = [
    ...new Set(defaults.checks.map(x =>
      x === 'Lureskjørt' ? 'Luseskjørt' : x
    ))
  ].filter(x => CHOICES.includes(x));

  const oldSettings = load(
    'hbl-v28-settings',
    load('hbl-v27-settings', {})
  );

  const settings = {
    enabled: oldSettings.enabled ?? true,
    ...load(SETTINGS_KEY, {})
  };

  const saveDefaults = () => store(KEY, defaults);
  const saveSettings = () => store(SETTINGS_KEY, settings);

  const state = {
    section: 'other',
    visit: 0,
    busy: false,
    queued: false,
    open: false,
    view: 'home',
    retryTimer: null,
    scanTimer: null,
    retryCount: 0,
    status: 'Klar',
    progress: null,
    touched: new Set(),
    generated: new Map(),
    lastNodes: new Map(),
    attachedPRM: null
  };

  function visible(el) {
    if (!el?.isConnected || !el.getClientRects().length) {
      return false;
    }
    const s = getComputedStyle(el);
    return s.display !== 'none' &&
      s.visibility !== 'hidden';
  }

  function sectionNow() {
    if (visible($(FIELD.finalComment))) return 'final';

    if (
      [...document.querySelectorAll(CHECKLIST)].some(visible)
    ) return 'checklist';

    if (
      visible($(FIELD.pressure)) ||
      visible($(FIELD.washComment))
    ) return 'wash';

    if (
      visible($(FIELD.activity)) ||
      visible($(FIELD.person))
    ) return 'general';

    return 'other';
  }

  function reportExists() {
    return !!(
      $(FIELD.activity) ||
      $(FIELD.pressure) ||
      $(FIELD.finalComment) ||
      document.querySelector(CHECKLIST)
    );
  }

  function sectionLabel(s) {
    return {
      general: 'Generelt',
      wash: 'Vask',
      checklist: 'Sjekkliste',
      final: 'Sluttkommentar',
      other: 'Annen seksjon'
    }[s] || s;
  }

  function prm() {
    try {
      return window.Sys?.WebForms
        ?.PageRequestManager?.getInstance() || null;
    } catch {
      return null;
    }
  }

  function ajaxBusy() {
    try {
      return !!prm()?.get_isInAsyncPostBack?.();
    } catch {
      return false;
    }
  }

  function comment() {
    return defaults.checks
      .filter(x => COMMENT_CHOICES.has(x))
      .join(' + ');
  }

  function targets() {
    const after = defaults.checks.includes('Etterkontroll');
    const inspect = defaults.checks.includes('Inspeksjon');
    const skirt = defaults.checks.includes('Luseskjørt');

    const result = [];

    for (let n = 346; n <= 365; n++) {
      const included =
        (after && n === 346) ||
        (inspect && !SKIRT.has(n)) ||
        (skirt && SKIRT.has(n));

      if (!included) continue;

      result.push({
        id: `MainContent_pkt${n}_VerdiKontroll`,
        label: n === 358
          ? 'Nei'
          : YES.has(n) ? 'Ja' : 'Ok'
      });
    }

    return result;
  }

  function textTargets(s) {
    if (s === 'general') {
      return [
        [FIELD.ship, defaults.ship],
        [FIELD.person, defaults.person]
      ];
    }

    if (s === 'wash') {
      return [
        [FIELD.pressure, defaults.pressure],
        [FIELD.depth, defaults.depth],
        [FIELD.area, defaults.area],
        [FIELD.washComment, comment()]
      ];
    }

    if (s === 'final') {
      return [[FIELD.finalComment, defaults.finalComment]];
    }

    return [];
  }

  function selectTargets(s) {
    if (s === 'general' && defaults.activity) {
      return [{
        id: FIELD.activity,
        value: defaults.activity
      }];
    }

    if (s === 'wash' && defaults.washer) {
      return [{
        id: FIELD.washer,
        value: defaults.washer
      }];
    }

    return s === 'checklist' ? targets() : [];
  }

  // Protect manually entered values.
  document.addEventListener('input', e => {
    if (
      !e.isTrusted ||
      !e.target?.id?.startsWith('MainContent_')
    ) return;

    state.touched.add(e.target.id);
    state.generated.delete(e.target.id);
  }, true);

  document.addEventListener('change', e => {
    if (
      !e.isTrusted ||
      !e.target?.id?.startsWith('MainContent_')
    ) return;

    state.touched.add(e.target.id);
    state.generated.delete(e.target.id);

    if (
      e.target.id === FIELD.person &&
      e.target.value.trim()
    ) {
      rememberPerson(e.target.value);
    }

    if (
      e.target.id === FIELD.area &&
      e.target.value.trim()
    ) {
      defaults.area = e.target.value.trim();
      saveDefaults();
    }
  }, true);

  function rememberPerson(value) {
    defaults.person = String(value ?? '').trim();

    if (defaults.person) {
      defaults.people = [
        defaults.person,
        ...defaults.people.filter(x => x !== defaults.person)
      ].slice(0, 30);
    }

    saveDefaults();
  }

  function setText(id, value, updateGenerated = false) {
    const el = $(id);

    if (!el || value == null) return 'missing';

    const next = String(value);

    if (!next && !updateGenerated) return 'skip';
    if (el.value === next) return 'already';
    if (state.touched.has(id)) return 'protected';

    const prior = state.generated.get(id);

    if (
      el.value.trim() &&
      !(updateGenerated && prior === el.value)
    ) return 'protected';

    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const setter =
      Object.getOwnPropertyDescriptor(proto, 'value')?.set;

    if (setter) setter.call(el, next);
    else el.value = next;

    state.generated.set(id, next);

    el.dispatchEvent(new Event('input', {
      bubbles: true
    }));

    el.dispatchEvent(new Event('change', {
      bubbles: true
    }));

    return 'changed';
  }

  function fillText(s) {
    let count = 0;

    for (const [id, value] of textTargets(s)) {
      if (setText(id, value) === 'changed') count++;
    }

    return count;
  }

  function blankSelect(el) {
    if (!el) return true;

    const selected = el.selectedOptions?.[0];

    return !el.value ||
      !selected ||
      /^--\s*velg/i.test(selected.textContent.trim());
  }

  function optionFor(el, target) {
    return [...el.options].find(o =>
      target.label !== undefined
        ? o.textContent.trim().toLowerCase() ===
          target.label.toLowerCase()
        : o.value === target.value
    );
  }

  async function selectOne(target, visit) {
    const el = $(target.id);

    if (!el) return 'missing';

    const option = optionFor(el, target);

    if (!option) return 'missing-option';
    if (el.value === option.value) return 'already';

    if (
      state.touched.has(target.id) ||
      !blankSelect(el)
    ) return 'protected';

    if (ajaxBusy()) return 'busy';

    const manager = prm();
    let began = false;
    let ended = false;

    const begin = () => { began = true; };
    const end = () => { ended = true; };

    try {
      manager?.add_beginRequest(begin);
      manager?.add_endRequest(end);

      el.value = option.value;

      el.dispatchEvent(new Event('change', {
        bubbles: true
      }));

      const start = performance.now();

      while (performance.now() - start < 8500) {
        if (visit !== state.visit) return 'cancelled';

        if (ended && !ajaxBusy()) break;

        if (
          !began &&
          !ajaxBusy() &&
          performance.now() - start >= 350
        ) break;

        await sleep(50);
      }

      if (began && (!ended || ajaxBusy())) {
        return 'timeout';
      }

      const current = $(target.id);

      if (!current) return 'missing';

      if (current.value !== option.value) {
        return 'retry';
      }

      state.generated.set(target.id, option.value);

      return 'changed';

    } catch (error) {
      console.error(
        '[HBL v2.9] Dropdown:',
        target.id,
        error
      );

      return 'error';

    } finally {
      try {
        manager?.remove_beginRequest(begin);
        manager?.remove_endRequest(end);
      } catch {}
    }
  }

  function progressFor(s) {
    const list = selectTargets(s);

    const result = {
      total: list.length,
      complete: 0,
      pending: 0,
      manual: 0
    };

    for (const target of list) {
      const el = $(target.id);

      if (!el) {
        result.pending++;
        continue;
      }

      const option = optionFor(el, target);

      if (!option) {
        result.pending++;
        continue;
      }

      if (el.value === option.value) {
        result.complete++;
      } else if (
        state.touched.has(target.id) ||
        !blankSelect(el)
      ) {
        result.manual++;
      } else {
        result.pending++;
      }
    }

    return result;
  }

  function status(message, progress = null) {
    state.status = message;
    state.progress = progress;

    if ($('hbl29-status')) {
      $('hbl29-status').textContent = message;
    }

    if ($('hbl29-progress')) {
      $('hbl29-progress').textContent = progress?.total
        ? `${progress.complete}/${progress.total} ferdig · ` +
          `${progress.pending} venter · ` +
          `${progress.manual} manuelle`
        : '';
    }

    console.log(
      '[HBL v2.9]',
      message,
      progress || ''
    );
  }

  function retrySoon() {
    if (
      !settings.enabled ||
      state.section === 'other' ||
      state.retryCount >= 10
    ) return;

    clearTimeout(state.retryTimer);

    const visit = state.visit;
    const delay = 450 + state.retryCount * 200;

    state.retryCount++;

    state.retryTimer = setTimeout(() => {
      if (visit === state.visit) runFill();
    }, delay);
  }

  async function runFill(force = false) {
    if (
      (!settings.enabled && !force) ||
      state.section === 'other'
    ) return;

    if (state.busy) {
      state.queued = true;
      return;
    }

    if (ajaxBusy()) {
      retrySoon();
      return;
    }

    state.busy = true;

    const visit = state.visit;
    const section = state.section;

    let changed = 0;
    let needsRetry = false;

    try {
      changed += fillText(section);

      for (const target of selectTargets(section)) {
        if (
          visit !== state.visit ||
          sectionNow() !== section
        ) break;

        const outcome = await selectOne(target, visit);

        if (outcome === 'changed') changed++;

        if ([
          'busy',
          'timeout',
          'retry',
          'missing',
          'missing-option',
          'error'
        ].includes(outcome)) {
          needsRetry = true;
          break;
        }
      }

      if (visit === state.visit) {
        changed += fillText(section);
      }

      const progress = progressFor(section);

      if (progress.pending) needsRetry = true;

      status(
        `${sectionLabel(section)}: ${changed} nye felt utfylt`,
        progress
      );

      if (!needsRetry) state.retryCount = 0;

    } catch (error) {
      console.error('[HBL v2.9]', error);
      status(`Feil: ${error.message}`);
      needsRetry = true;

    } finally {
      state.busy = false;

      if (state.queued) {
        state.queued = false;

        if (visit === state.visit) retrySoon();

      } else if (
        needsRetry &&
        visit === state.visit
      ) {
        retrySoon();
      }
    }
  }

  // ------------------------------
  // Interface
  // ------------------------------

  const CSS = `
    #hbl29-panel,
    #hbl29-panel * {
      box-sizing: border-box;
    }

    #hbl29-panel {
      position: fixed;
      z-index: 2147483647;
      top: 130px;
      right: 18px;
      width: min(350px, calc(100vw - 24px));
      max-height: 78vh;
      overflow: auto;
      background: #fff;
      color: #244257;
      border: 1px solid #dce5ec;
      border-radius: 16px;
      padding: 17px;
      font: 13px Arial, sans-serif;
      box-shadow: 0 14px 42px #0004;
    }

    #hbl29-panel .head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    #hbl29-panel .title {
      font-size: 16px;
      font-weight: 700;
    }

    #hbl29-panel .muted {
      font-size: 11px;
      color: #8193a0;
      margin: 9px 0;
      line-height: 1.5;
    }

    #hbl29-panel .field {
      display: block;
      margin: 12px 0;
      font-size: 12px;
      font-weight: 600;
    }

    #hbl29-panel input:not([type=checkbox]),
    #hbl29-panel select,
    #hbl29-panel textarea {
      display: block;
      width: 100%;
      padding: 10px;
      margin-top: 6px;
      background: #f8fafc;
      color: #244257;
      border: 1px solid #d6e1e8;
      border-radius: 9px;
      font: 13px Arial, sans-serif;
    }

    #hbl29-panel textarea {
      min-height: 110px;
      resize: vertical;
    }

    #hbl29-panel .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 10px 0 14px;
    }

    #hbl29-panel .check {
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 9px 8px;
      background: #f7fafc;
      border: 1px solid #e0e8ee;
      border-radius: 9px;
      cursor: pointer;
    }

    #hbl29-panel .menu {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      padding: 12px;
      margin: 8px 0;
      border: 1px solid #dce6ed;
      border-radius: 10px;
      background: #f7fafc;
      color: #24485f;
      font-weight: 600;
      cursor: pointer;
    }

    #hbl29-panel .primary {
      display: block;
      width: 100%;
      padding: 11px;
      margin: 12px 0;
      border: 0;
      border-radius: 9px;
      background: #17638b;
      color: #fff;
      font-weight: 700;
      cursor: pointer;
    }

    #hbl29-panel .back,
    #hbl29-panel .close {
      border: 0;
      background: transparent;
      color: #286d92;
      cursor: pointer;
      padding: 7px;
    }

    #hbl29-panel .footer {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px solid #e7edf1;
    }

    #hbl29-panel .progress {
      font-size: 11px;
      color: #39748f;
      margin-top: 7px;
    }
  `;

  function head(title) {
    return `
      <div class="head">
        <div>
          <div class="title">${html(title)}</div>
          <div class="muted">Autofyll v${VERSION}</div>
        </div>
        <button id="hbl29-close" class="close">✕</button>
      </div>
    `;
  }

  const back = page =>
    `<button class="back" data-view="${page}">
      ← Tilbake
    </button>`;

  function field(label, id, value) {
    return `
      <label class="field">
        ${html(label)}
        <input id="${id}" value="${html(value)}">
      </label>
    `;
  }

  function options(source, chosen) {
    const el = $(source);

    if (!el) {
      return '<option value="">Åpne riktig seksjon</option>';
    }

    return [...el.options].map(o => `
      <option value="${html(o.value)}"
        ${o.value === chosen ? 'selected' : ''}>
        ${html(o.textContent.trim())}
      </option>
    `).join('');
  }

  function home() {
    const people = [
      ...new Set([
        defaults.person,
        ...defaults.people
      ].filter(Boolean))
    ];

    return `
      ${head('Havbruksloggen')}

      <div class="muted">
        ${settings.enabled
          ? '● Autofyll aktiv'
          : '○ Autofyll pauset'}
        · ${sectionLabel(state.section)}
      </div>

      <label class="field">
        Ansvarlig person
        <input id="hbl29-person"
          list="hbl29-people"
          value="${html(defaults.person)}"
          placeholder="Skriv eller velg navn">
      </label>

      <datalist id="hbl29-people">
        ${people.map(x =>
          `<option value="${html(x)}"></option>`
        ).join('')}
      </datalist>

      <div class="field">
        Kommentar til vask / sjekkliste
      </div>

      <div class="grid">
        ${CHOICES.map(x => `
          <label class="check">
            <input type="checkbox"
              class="hbl29-choice"
              value="${html(x)}"
              ${defaults.checks.includes(x)
                ? 'checked'
                : ''}>
            ${html(x)}
          </label>
        `).join('')}
      </div>

      <button class="menu" data-view="settings">
        ⚙ Innstillinger <span>›</span>
      </button>

      <div class="footer">
        <div class="muted" id="hbl29-status">
          ${html(state.status)}
        </div>
        <div class="progress" id="hbl29-progress"></div>
      </div>
    `;
  }

  function settingsPage() {
    return `
      ${head('Innstillinger')}
      ${back('home')}

      <button class="menu" data-view="general">
        Generelt <span>›</span>
      </button>

      <button class="menu" data-view="wash">
        Vask <span>›</span>
      </button>

      <button class="menu" data-view="final">
        Sluttkommentar <span>›</span>
      </button>

      <label class="check">
        <input type="checkbox" id="hbl29-enabled"
          ${settings.enabled ? 'checked' : ''}>
        Automatisk utfylling
      </label>

      <button class="primary" id="hbl29-fill">
        Fyll denne seksjonen
      </button>

      <div class="muted">
        Eksisterende manuelle svar beholdes.
        Rapporten sendes aldri automatisk.
      </div>
    `;
  }

  function generalPage() {
    return `
      ${head('Generelt')}
      ${back('settings')}

      <label class="field">
        Aktivitet
        <select id="hbl29-activity">
          ${options(FIELD.activity, defaults.activity)}
        </select>
      </label>

      ${field(
        'Utførende fartøy',
        'hbl29-ship',
        defaults.ship
      )}

      <button class="primary" id="hbl29-save-general">
        Lagre
      </button>
    `;
  }

  function washPage() {
    return `
      ${head('Vask')}
      ${back('settings')}

      ${field(
        'Trykk (bar)',
        'hbl29-pressure',
        defaults.pressure
      )}

      ${field(
        'Spylt meter dybde',
        'hbl29-depth',
        defaults.depth
      )}

      <label class="field">
        Type spyler
        <select id="hbl29-washer">
          ${options(FIELD.washer, defaults.washer)}
        </select>
      </label>

      ${field(
        'Kvm totalt',
        'hbl29-area',
        defaults.area
      )}

      <button class="primary" id="hbl29-save-wash">
        Lagre
      </button>
    `;
  }

  function finalPage() {
    return `
      ${head('Sluttkommentar')}
      ${back('settings')}

      <label class="field">
        Standardkommentar
        <textarea id="hbl29-final-text"
          rows="6"
          placeholder="Skriv standardkommentaren for siste side...">${html(defaults.finalComment)}</textarea>
      </label>

      <div class="muted">
        Fylles kun i kommentarfeltet på siste side.
        Manuelle kommentarer overskrives ikke.
      </div>

      <button class="primary" id="hbl29-save-final">
        Lagre sluttkommentar
      </button>
    `;
  }

  function closePanel() {
    state.open = false;

    if ($('hbl29-panel')) {
      $('hbl29-panel').style.display = 'none';
    }
  }

  function render(page = 'home') {
    state.view = page;

    const panel = $('hbl29-panel');
    if (!panel) return;

    panel.innerHTML = ({
      home,
      settings: settingsPage,
      general: generalPage,
      wash: washPage,
      final: finalPage
    }[page] || home)();

    $('hbl29-close').onclick = closePanel;

    panel.querySelectorAll('[data-view]').forEach(b => {
      b.onclick = () => render(b.dataset.view);
    });

    if (page === 'home') {
      $('hbl29-person').onchange = e => {
        rememberPerson(e.target.value);

        const result = setText(
          FIELD.person,
          defaults.person,
          true
        );

        status(
          result === 'protected'
            ? 'Navn lagret; manuelt navn beholdt'
            : 'Ansvarlig person lagret'
        );
      };

      panel.querySelectorAll('.hbl29-choice')
        .forEach(box => {
          box.onchange = () => {
            defaults.checks = [
              ...panel.querySelectorAll(
                '.hbl29-choice:checked'
              )
            ].map(el => el.value);

            saveDefaults();

            const result = setText(
              FIELD.washComment,
              comment(),
              true
            );

            status(
              result === 'protected'
                ? 'Valg lagret; manuell vaskekommentar beholdt'
                : 'Valg lagret'
            );

            if (state.section === 'checklist') {
              state.retryCount = 0;
              runFill(true);
            }
          };
        });

      if (state.progress?.total) {
        status(state.status, state.progress);
      }
    }

    if (page === 'settings') {
      $('hbl29-enabled').onchange = e => {
        settings.enabled = e.target.checked;
        saveSettings();

        if (!settings.enabled) {
          clearTimeout(state.retryTimer);
        } else {
          state.retryCount = 0;
          runFill();
        }

        status(
          settings.enabled
            ? 'Autofyll aktivert'
            : 'Autofyll pauset'
        );
      };

      $('hbl29-fill').onclick = () => {
        state.retryCount = 0;
        runFill(true);
      };
    }

    if (page === 'general') {
      $('hbl29-save-general').onclick = () => {
        defaults.activity = $('hbl29-activity').value;
        defaults.ship = $('hbl29-ship').value.trim();

        saveDefaults();
        render('settings');
        status('Generelt lagret');
      };
    }

    if (page === 'wash') {
      $('hbl29-save-wash').onclick = () => {
        defaults.pressure =
          $('hbl29-pressure').value.trim();

        defaults.depth =
          $('hbl29-depth').value.trim();

        defaults.washer =
          $('hbl29-washer').value;

        defaults.area =
          $('hbl29-area').value.trim();

        saveDefaults();
        render('settings');
        status('Vask lagret');
      };
    }

    if (page === 'final') {
      $('hbl29-save-final').onclick = () => {
        defaults.finalComment =
          $('hbl29-final-text').value;

        saveDefaults();

        if (state.section === 'final') {
          setText(
            FIELD.finalComment,
            defaults.finalComment,
            true
          );
        }

        render('settings');
        status('Sluttkommentar lagret');
      };
    }
  }

  function createUI() {
    if (!reportExists() || $('hbl29-button')) return;

    if (!$('hbl29-style')) {
      const style = document.createElement('style');
      style.id = 'hbl29-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    const button = document.createElement('button');

    button.id = 'hbl29-button';
    button.textContent = 'Autofyll v2.9';

    button.style.cssText = `
      position:fixed;
      top:80px;
      right:18px;
      z-index:2147483646;
      padding:12px 16px;
      background:#124b69;
      color:#fff;
      border:0;
      border-radius:10px;
      font:600 14px Arial,sans-serif;
      cursor:grab;
      box-shadow:0 4px 14px #0004;
      touch-action:none;
    `;

    document.body.appendChild(button);

    const panel = document.createElement('section');
    panel.id = 'hbl29-panel';
    panel.style.display = 'none';
    document.body.appendChild(panel);

    const position = load(POS_KEY, null);

    if (
      Number.isFinite(position?.left) &&
      Number.isFinite(position?.top)
    ) {
      button.style.left = Math.max(
        0,
        Math.min(innerWidth - 120, position.left)
      ) + 'px';

      button.style.top = Math.max(
        0,
        Math.min(innerHeight - 40, position.top)
      ) + 'px';

      button.style.right = 'auto';
    }

    let drag = null;
    let suppress = false;

    button.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;

      const r = button.getBoundingClientRect();

      drag = {
        x: e.clientX,
        y: e.clientY,
        left: r.left,
        top: r.top,
        moved: false
      };

      button.setPointerCapture(e.pointerId);
    });

    button.addEventListener('pointermove', e => {
      if (!drag) return;

      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;

      if (Math.abs(dx) + Math.abs(dy) > 5) {
        drag.moved = true;
      }

      if (!drag.moved) return;

      button.style.left = Math.max(
        0,
        Math.min(
          innerWidth - button.offsetWidth,
          drag.left + dx
        )
      ) + 'px';

      button.style.top = Math.max(
        0,
        Math.min(
          innerHeight - button.offsetHeight,
          drag.top + dy
        )
      ) + 'px';

      button.style.right = 'auto';
    });

    button.addEventListener('pointerup', () => {
      if (drag?.moved) {
        store(POS_KEY, {
          left: parseFloat(button.style.left),
          top: parseFloat(button.style.top)
        });

        suppress = true;
      }

      drag = null;
    });

    button.addEventListener('click', () => {
      if (suppress) {
        suppress = false;
        return;
      }

      state.open = !state.open;

      if (state.open) render('home');

      panel.style.display = state.open
        ? 'block'
        : 'none';
    });
  }

  // Minimize when clicking outside the menu.
  document.addEventListener('pointerdown', e => {
    if (!state.open) return;

    const panel = $('hbl29-panel');
    const button = $('hbl29-button');

    if (
      panel?.contains(e.target) ||
      button?.contains(e.target)
    ) return;

    closePanel();
  }, true);

  function attachAjax() {
    const manager = prm();

    if (
      !manager ||
      manager === state.attachedPRM
    ) return;

    state.attachedPRM = manager;

    manager.add_endRequest(() => {
      setTimeout(scan, 70);
    });
  }

  function scan() {
    clearTimeout(state.scanTimer);

    state.scanTimer = setTimeout(() => {
      if (reportExists()) createUI();

      attachAjax();

      const next = sectionNow();

      if (next !== state.section) {
        state.section = next;
        state.visit++;
        state.retryCount = 0;

        state.touched.clear();
        state.generated.clear();
        state.lastNodes.clear();

        clearTimeout(state.retryTimer);

        if (settings.enabled) runFill();

        if (
          state.open &&
          state.view === 'home'
        ) render('home');

      } else if (
        settings.enabled &&
        next !== 'other' &&
        !state.busy &&
        !ajaxBusy()
      ) {
        // Handle fields restored by ASP.NET updates.
        if (progressFor(next).pending) {
          retrySoon();
        }

        if (
          next === 'final' &&
          defaults.finalComment &&
          !$(FIELD.finalComment)?.value.trim()
        ) {
          retrySoon();
        }
      }
    }, 180);
  }

  function start() {
    createUI();
    attachAjax();

    state.section = sectionNow();
    state.visit = 1;

    if (settings.enabled) runFill();

    new MutationObserver(scan).observe(
      document.documentElement,
      {
        childList: true,
        subtree: true
      }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      start,
      { once: true }
    );
  } else {
    start();
  }
})();
