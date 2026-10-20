// ==UserScript==
// @name         Havbruksloggen Autofyll v3.1 Beta 2
// @namespace    local.havbruksloggen.autofyll
// @version      3.1.0-beta2
// @description  RC4-motor + sikker spørsmålsidentitet, grønt svar og læring
// @match        https://havbruksloggen.no/*
// @match        https://www.havbruksloggen.no/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.__HBL_AUTOFILL_V31__) return;
  window.__HBL_AUTOFILL_V31__ = true;

  const VERSION = '3.1 Beta';
  const RULES_KEY = 'hbl-v31-learned-rules';
  const BASELINE_KEY = 'hbl-v31-baseline';
  const KEY = 'hbl-v2-defaults';
  const SETTINGS_KEY = 'hbl-v30-rc2-settings';
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
  // These are identity anchors from the verified live checklist, NOT answer rules.
  // The complete wording is captured only after all 20 anchors match safely.
  const ANCHORS = {
    346:'ROV kontrollert før utsett i not?',
    347:'Dødfisk fjernet fra not før inspeksjon?',
    348:'Dødfiskhåv er hevet for å muliggjøre inspeksjon under?',
    349:'Kontroller at notposen står jevnt og fint utstrekt i alle sider og i bunn.',
    350:'Kontroller at alt notlin og tauverk er uten synlige hull og/eller skader.',
    351:'Sjekk om det er tegn til skader fra predator på notposen.',
    352:'Kontroller at område rundt dødfisksystemet er fri',
    353:'Sjekk om det er synlig utdragning og/eller at notl',
    354:'Kontroller at det er tilstrekkelig avstand fra not',
    355:'Kontroller at det ikke er gnag eller slitasje i om',
    356:'Luseskjørt er korrekt innfestet.',
    357:'Ved første inspeksjon etter utsett av luseskjørt s',
    358:'Skader på luseskjørt.',
    359:'Kontroller at bunnring har sirkulær form.',
    360:'Kontroller at lodd og bunnlodd er montert slik at',
    361:'Sjekk at tau til lodd ikke har gnag.',
    362:'Kontroller at alle komponenter i senter bunn er intakte.',
    363:'Er tauene fri for slitasjeskader?',
    364:'Er opphalertau korrekt innfestet og tredd?',
    365:'Er alt ekstrautstyr på og ved flytekragen forsvali'
  };

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
    warnings: true,
    dark: false,
    hue: 202,
    ...load('hbl-v30-settings', {}),
    ...load(SETTINGS_KEY, {})
  };
  settings.hue = Math.max(0, Math.min(359, Number(settings.hue) || 0));

  const learned = load(RULES_KEY, {});
  let baseline = load(BASELINE_KEY, null);
  const saveRules = () => store(RULES_KEY, learned);
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
    attachedPRM: null,
    errors: [],
    warned: '',
    testing: false,
    party: false,
    titleClicks: [],
    lastVerify: null,
    checklistIssues: [],
    checklistNotices: [],
    discoveries: [],
    checklistSignature: '',
    selectedLearning: {}
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

  // Identity is the question text, not its position or generated DOM ID.
  function normalize(text) {
    return canonicalQuestion(text).normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('nb-NO');
  }

  // Deviation (Avvik) controls can be inserted when an answer is changed.
  // They are NOT part of the question identity. Apply the same canonicalization
  // to both live text and previously stored baselines/learned rules.
  function canonicalQuestion(text) {
    return String(text ?? '')
      .replace(/\s+/g, ' ')
      .replace(/\s+Avvik\s+Prioritet\s+Beskrivelse\s*\*?\s+Årsak\b[\s\S]*$/i, '')
      .trim();
  }

  function questionText(select) {
    const id = select.id.match(/^MainContent_pkt(\d+)_VerdiKontroll$/)?.[1];
    const container = id && $(`MainContent_pkt${id}_punktRad`);
    if (!container || !container.contains(select)) return '';
    const clone = container.cloneNode(true);
    clone.querySelectorAll('select,input,textarea,button,script,style, [class*="dropzone"], [class*="Dropzone"]').forEach(n => n.remove());
    return canonicalQuestion(clone.textContent);
  }

  function greenOption(select) {
    const found = [...select.options].filter(o => {
      const c = (o.style.color || '').toLowerCase().replace(/\s+/g, '');
      return c === 'green' || c === '#008000' || c === 'rgb(0,128,0)' ||
        getComputedStyle(o).color.replace(/\s+/g, '') === 'rgb(0,128,0)';
    });
    return found.length === 1 ? found[0] : null;
  }

  function currentQuestions() {
    return [...document.querySelectorAll(CHECKLIST)].filter(visible).map(el => ({
      id: el.id, number: Number(el.id.match(/pkt(\d+)_/)?.[1]),
      text: questionText(el), el
    }));
  }

  function categoriesFor(n) {
    return n === 346 ? ['Inspeksjon', 'Etterkontroll'] :
      SKIRT.has(n) ? ['Luseskjørt'] : ['Inspeksjon'];
  }

  // A snapshot is created ONLY on a complete, independently anchor-matched
  // original checklist. Never silently accept changed wording as the baseline.
  function establishBaseline(rows) {
    if (baseline || rows.length !== 20) return;
    const snapshot = {};
    for (const [id, prefix] of Object.entries(ANCHORS)) {
      const matches = rows.filter(r => normalize(r.text).startsWith(normalize(prefix)));
      if (matches.length !== 1 || !matches[0].text) return;
      snapshot[id] = matches[0].text;
    }
    baseline = snapshot;
    store(BASELINE_KEY, baseline);
    console.info('[HBL v3.1] Originale 20 spørsmål identifisert; fulltekst lagret.');
  }

  function resolveChecklist(rows, reference = baseline) {
    const issues = [], notices = [], targets = [], discoveries = [];
    const used = new Set();
    const records = [
      ...Object.entries(ANCHORS).map(([n, prefix]) => ({
        key: `built:${n}`, text: reference?.[n] || prefix,
        prefix: !reference?.[n], categories: categoriesFor(Number(n))
      })),
      ...Object.entries(learned).map(([key, rule]) => ({
        key: `learn:${key}`, text: rule.text, prefix: false,
        categories: rule.categories
      }))
    ];
    for (const record of records) {
      const matches = rows.filter(r => record.prefix
        ? normalize(r.text).startsWith(normalize(record.text))
        : normalize(r.text) === normalize(record.text));
      if (matches.length !== 1 || used.has(matches[0]?.id)) {
        issues.push(`${record.key}: ${matches.length === 0 ? 'mangler/endret' : 'tvetydig'}`);
        continue;
      }
      const row = matches[0];
      used.add(row.id);
      if (record.categories.some(c => defaults.checks.includes(c))) {
        if (!greenOption(row.el)) issues.push(`${row.id}: ikke nøyaktig ett grønt svar`);
        else targets.push({ id: row.id, green: true, question: row.text });
      }
    }
    for (const row of rows) {
      if (used.has(row.id)) continue;
      discoveries.push({ id: row.id, text: row.text, green: !!greenOption(row.el) });
      notices.push(`Nytt/ukjent spørsmål ${row.number || row.id}: ${row.text || '(tekst mangler)'}`);
    }
    if (!baseline) notices.push('Fullstendig referansetekst ikke lagret ennå; kontroller sjekklisten.');
    return { targets, issues, notices, discoveries };
  }

  function checklistPlan() {
    const rows = currentQuestions();
    if (!rows.length) return { targets: [], issues: [], notices: [], discoveries: [] };
    establishBaseline(rows);
    const plan = resolveChecklist(rows);
    state.checklistIssues = plan.issues;
    state.checklistNotices = plan.notices;
    state.discoveries = plan.discoveries;
    return plan;
  }

  function targets() {
    // If any identity is ambiguous or missing, refuse checklist writes.
    // This prevents partial silent misclassification after a site change.
    const plan = checklistPlan();
    return plan.issues.length ? [] : plan.targets;
  }

  function textTargets(s) {
    if (s === 'general') {
      return [
        [FIELD.ship, defaults.ship],
        [FIELD.person, defaults.person]
      ];
    }

    if (s === 'wash') {
      const inspectionOnly = defaults.checks.length === 1 && defaults.checks.includes('Inspeksjon');
      return [
        [FIELD.pressure, inspectionOnly ? '0' : defaults.pressure],
        [FIELD.depth, inspectionOnly ? '0' : defaults.depth],
        [FIELD.area, inspectionOnly ? '0' : defaults.area],
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
    state.lastNodes.set(id, el);

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
    if (target.green) return greenOption(el);
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

    if (target.green) {
      const now = checklistPlan();
      if (now.issues.length || !now.targets.some(t=>t.id===target.id && t.question===target.question))
        return 'error';
    }
    const option = optionFor(el, target);

    if (!option) return 'missing-option';
    if (el.value === option.value) return 'already';

    if (
      state.touched.has(target.id) ||
      (!blankSelect(el) && state.generated.get(target.id) !== el.value)
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
      state.generated.set(target.id, option.value);
      state.lastNodes.set(target.id, el);

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
        '[HBL v3.1] Dropdown:',
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
        (!blankSelect(el) && state.generated.get(target.id) !== el.value)
      ) {
        result.manual++;
      } else {
        result.pending++;
      }
    }

    return result;
  }

  // Verify text and dropdown values, not merely whether fields are non-empty.
  function verifySection(section) {
    const missing = [];
    let confirmed = 0;
    let manual = 0;
    const textList = textTargets(section).filter(([, value]) => String(value ?? '') !== '');
    const selects = selectTargets(section);
    for (const [id, value] of textList) {
      const el = $(id);
      if (!el || !visible(el)) {
        missing.push(id);
      } else if (el.value === String(value)) {
        confirmed++;
      } else if (state.touched.has(id) ||
        (el.value.trim() && state.generated.get(id) !== el.value)) {
        manual++;
      } else {
        missing.push(id);
      }
    }
    for (const target of selects) {
      const el = $(target.id);
      const opt = el && optionFor(el, target);
      if (!el || !visible(el) || !opt) {
        missing.push(target.id);
      } else if (el.value === opt.value) {
        confirmed++;
      } else if (state.touched.has(target.id) ||
        (!blankSelect(el) && state.generated.get(target.id) !== el.value)) {
        manual++;
      } else {
        missing.push(target.id);
      }
    }
    if (section === 'checklist') {
      checklistPlan();
      missing.push(...state.checklistIssues.map(x => `Sjekkliste: ${x}`));
    }
    return { confirmed, manual, missing, total: textList.length + selects.length };
  }

  // Compact indicator: red = failure, amber = working/pending, green = verified.
  function indicatorState() {
    if (state.testing || (settings.warnings && state.errors.length)) return 'error';
    if (state.section === 'checklist' && state.checklistNotices.length) return 'working';
    if (!settings.enabled) return 'paused';
    if (state.section === 'other') return 'idle';
    const v = state.lastVerify;
    if (v && !v.missing.length && v.total > 0 && !state.checklistIssues.length && !state.checklistNotices.length) return 'ok';
    return 'working';
  }

  function updateStatusIndicator() {
    const dot = $('hbl29-indicator');
    if (!dot) return;
    const kind = indicatorState();
    dot.dataset.state = kind;
    dot.title = ({
      ok: 'Alle forventede felt bekreftet',
      working: 'Autofyll arbeider, venter eller har nye spørsmål til godkjenning',
      error: 'Feil oppdaget – åpne Status',
      paused: 'Autofyll pauset',
      idle: 'Ingen aktiv seksjon'
    })[kind];
    dot.setAttribute('aria-label', dot.title);
  }

  function updateWarnings() {
    updateStatusIndicator();
    const button = $('hbl29-button');
    if (button) button.classList.toggle('hbl-error',
      state.testing || (settings.warnings && state.errors.length > 0));
    const box = $('hbl29-errors');
    if (box) {
      const errors = state.testing ? ['TEST: Spørsmål 357 mangler'] : [...state.errors, ...state.checklistNotices];
      box.hidden = !errors.length || (!settings.warnings && !state.testing);
      box.textContent = errors.length ? `⚠ ${errors.join(' · ')}` : '';
    }
  }

  function flashWarning() {
    if (!settings.warnings) return;
    let overlay = $('hbl29-flash');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hbl29-flash';
      document.body.appendChild(overlay);
    }
    overlay.classList.remove('go');
    void overlay.offsetWidth;
    overlay.classList.add('go');
  }

  function clearWarnings() {
    state.errors = [];
    state.warned = '';
    updateWarnings();
  }

  function reportFailure(result) {
    if (!result.missing.length) {
      clearWarnings();
      return;
    }
    state.errors = result.missing.map(id =>
      `${sectionLabel(state.section)}: ${id.replace('MainContent_', '')}`);
    const signature = `${state.section}:${state.errors.join('|')}`;
    if (settings.warnings && signature !== state.warned) {
      state.warned = signature;
      flashWarning();
    }
    updateWarnings();
  }

  function applyAppearance() {
    const button = $('hbl29-button');
    const panel = $('hbl29-panel');
    if (button) {
      button.style.setProperty('--hbl-hue', String(settings.hue));
      button.classList.toggle('hbl-party', state.party);
    }
    if (panel) {
      panel.classList.toggle('hbl-dark', !!settings.dark);
      panel.classList.toggle('hbl-party', state.party);
    }
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

    updateStatusIndicator();

    console.log(
      '[HBL v3.1]',
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
      const verified = verifySection(section);
      state.lastVerify = verified;

      if (verified.missing.length) needsRetry = true;
      if (section === 'checklist' && state.checklistIssues.length) {
        reportFailure(verified);
        needsRetry = false; // Structural failures require review, not retries.
      }
      if (verified.missing.length && !state.checklistIssues.length && state.retryCount >= 9 && !ajaxBusy()) {
        reportFailure(verified);
      } else if (!verified.missing.length && !state.checklistIssues.length) {
        clearWarnings();
      }

      status(
        `${sectionLabel(section)}: ${verified.confirmed}/${verified.total} bekreftet · ${verified.manual} manuelle · ${verified.missing.length} venter`,
        progress
      );

      if (!needsRetry) state.retryCount = 0;

    } catch (error) {
      console.error('[HBL v3.1]', error);
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


    #hbl29-panel.hbl-home { padding: 12px 14px; }
    #hbl29-panel.hbl-home .head { margin-bottom: 5px; }
    #hbl29-panel.hbl-home .field { margin: 7px 0; }
    #hbl29-panel.hbl-home .field input { padding: 8px; margin-top: 4px; }
    #hbl29-panel.hbl-home .group-title { margin: 8px 0 4px; }
    #hbl29-panel.hbl-home .grid { gap: 5px; margin: 5px 0 7px; }
    #hbl29-panel.hbl-home .check { padding: 7px 6px; }
    #hbl29-panel.hbl-home .menu { margin: 7px 0 0; padding: 9px 10px; }
    #hbl29-panel .hbl-title-wrap { display:flex; align-items:center; gap:8px; }
    #hbl29-indicator {
      display:inline-block; width:10px; height:10px; min-width:10px;
      border-radius:50%; background:#9ca3af; cursor:pointer;
      border:1px solid #0002; box-shadow:0 0 0 2px #00000008;
    }
    #hbl29-indicator[data-state="ok"] { background:#21a366; }
    #hbl29-indicator[data-state="working"] { background:#e6a23c; }
    #hbl29-indicator[data-state="error"] { background:#e23c3c; }
    #hbl29-indicator[data-state="paused"],
    #hbl29-indicator[data-state="idle"] { background:#9ca3af; }
    #hbl29-panel .status-details { padding:9px 0; }
    #hbl29-panel .status-details .muted { overflow-wrap:anywhere; }

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

    #hbl29-panel [hidden] {display:none !important;}
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

    #hbl29-button { background:hsl(var(--hbl-hue,202) 65% 27%) !important; }
    #hbl29-button.hbl-error { background:#b42318 !important; box-shadow:0 0 0 3px #ffb0b0,0 4px 15px #0003 !important; }
    #hbl29-panel .toggle { display:flex;align-items:center;justify-content:space-between;gap:10px;margin:13px 0; }
    #hbl29-panel .toggle input { width:18px;height:18px; }
    #hbl29-panel input[type=range] { accent-color:hsl(var(--hbl-hue,202) 70% 45%); }
    #hbl29-panel .group-title { font-size:11px;font-weight:700;color:#70899a;margin:13px 0 6px; }
    #hbl29-panel .grid.cols3 { grid-template-columns:repeat(3,minmax(0,1fr)); }
    #hbl29-panel .check {font-size:12px;}
    #hbl29-panel .warning {margin:10px 0;padding:9px;border:1px solid #e9a3a3;background:#fff0f0;color:#a32222;border-radius:9px;overflow-wrap:anywhere;}
    #hbl29-panel .warning[hidden] {display:none;}
    #hbl29-panel .hbl-learn {padding:9px;border:1px solid #dce6ed;border-radius:9px;margin:9px 0;}
    #hbl29-panel .hbl-learn label {display:block;margin:6px 0;font-size:12px;}
    #hbl29-panel .hbl-learn button {margin-top:6px;}
    #hbl29-panel .hbl-learn .question {overflow-wrap:anywhere;font-weight:600;}
    #hbl29-panel.hbl-dark {background:#17212b;color:#e4edf6;border-color:#405363;}
    #hbl29-panel.hbl-dark .muted,#hbl29-panel.hbl-dark .group-title {color:#a7bbcb;}
    #hbl29-panel.hbl-dark .menu,#hbl29-panel.hbl-dark .check,
    #hbl29-panel.hbl-dark input:not([type=checkbox]),#hbl29-panel.hbl-dark select,
    #hbl29-panel.hbl-dark textarea {background:#243341;color:#f1f5f9;border-color:#4a6173;}
    #hbl29-panel.hbl-dark .back,#hbl29-panel.hbl-dark .close {color:#80c6ee;}
    #hbl29-panel.hbl-dark .footer {border-color:#405363;}
    #hbl29-flash {position:fixed;inset:0;pointer-events:none;z-index:2147483645;background:rgba(230,20,20,.25);opacity:0;}
    #hbl29-flash.go {animation:hbl29-blink .65s ease-in-out 1;}
    @keyframes hbl29-blink {0%,33%,66%,100%{opacity:0} 16%,50%{opacity:1}}
    @keyframes hbl29-rainbow {from{filter:hue-rotate(0deg)}to{filter:hue-rotate(360deg)}}
    @keyframes hbl29-fish {0%{transform:translateX(-40px)}100%{transform:translateX(390px)}}
    @keyframes hbl29-bubble {0%{transform:translateY(30px);opacity:0}30%{opacity:.7}100%{transform:translateY(-260px);opacity:0}}
    #hbl29-button.hbl-party:not(.hbl-error) {animation:hbl29-rainbow 2s linear infinite;}
    #hbl29-panel.hbl-party {background:linear-gradient(125deg,#f8b6de,#b7dfff,#d2ffc4,#ffe4a6,#f8b6de);background-size:350% 350%;animation:hbl29-rainbow 7s linear infinite;color:#243547;border:3px solid #ff4db8;}
    #hbl29-panel.hbl-party .check,#hbl29-panel.hbl-party .menu {background:#ffffffb9;color:#233447;border-color:#ff75bb;}
    #hbl29-panel.hbl-party .muted,#hbl29-panel.hbl-party .group-title {color:#36536b;}
    #hbl29-panel .hbl-fish,#hbl29-panel .hbl-bubble {display:none;pointer-events:none;position:absolute;z-index:0;}
    #hbl29-panel.hbl-party .hbl-fish {display:block;top:44%;left:0;font-size:23px;animation:hbl29-fish 5s linear infinite;}
    #hbl29-panel.hbl-party .hbl-bubble {display:block;bottom:0;left:18%;font-size:19px;animation:hbl29-bubble 3s ease-in infinite;}
    #hbl29-panel.hbl-party .hbl-bubble.b2 {left:75%;animation-delay:1.2s;}
    #hbl29-panel .hbl-party-message {display:none;font-weight:700;text-align:center;margin:10px 0;}
    #hbl29-panel.hbl-party .hbl-party-message {display:block;}
    @media (prefers-reduced-motion:reduce) {#hbl29-panel.hbl-party,#hbl29-button.hbl-party,#hbl29-panel .hbl-fish,#hbl29-panel .hbl-bubble{animation:none !important}}
  `;

  function head(title) {
    return `
      <div class="head">
        <div>
          <div class="hbl-title-wrap">
            <div class="title" id="hbl29-title" title="🐟">${html(title)}</div>
            <button type="button" id="hbl29-indicator" title="Vis status" aria-label="Vis status"></button>
          </div>
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

  function decoration() {
    return `<div class="hbl-fish">🐟</div><div class="hbl-bubble">🫧</div><div class="hbl-bubble b2">🫧</div>
      <div class="hbl-party-message">🌈 FULL KONTROLL PÅ MERDEN! 🐟</div>`;
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
      ${decoration()}

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

      ${[
        ['Område', ['Top', 'Side', 'Bunn']],
        ['Kontroll', ['Inspeksjon', 'Etterkontroll']],
        ['Tillegg', ['Luseskjørt']]
      ].map(([group, choices]) => `
        <div class="group-title">${group}</div>
        <div class="grid ${choices.length === 3 ? 'cols3' : ''}">
          ${choices.map(x => `<label class="check"><input type="checkbox"
            class="hbl29-choice" value="${html(x)}"
            ${defaults.checks.includes(x) ? 'checked' : ''}>
            ${x === 'Top' ? 'Topp' : html(x)}</label>`).join('')}
        </div>`).join('')}

      <button class="menu" data-view="settings">
        ⚙ Innstillinger <span>›</span>
      </button>


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
      <button class="menu" data-view="advanced">
        Avansert <span>›</span>
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

  function advancedPage() {
    return `${head('Avansert')}${back('settings')}${decoration()}
      <button class="menu" data-view="status">Status og fremdrift <span>›</span></button>
      <button class="menu" data-view="warnings">Feilvarsling <span>›</span></button>
      <button class="menu" data-view="learning">Adaptive sjekkpunkter <span>›</span></button>
      <label class="toggle"><span>Mørk modus</span>
        <input type="checkbox" id="hbl29-dark" ${settings.dark ? 'checked' : ''}></label>
      <label class="field">Farge på Autofyll-knappen
        <input id="hbl29-hue" type="range" min="0" max="359" value="${settings.hue}"></label>
      <button class="menu" id="hbl29-reset-hue">Standardfarge</button>
      <div class="muted">Fargen endres direkte på den flyttbare knappen.</div>`;
  }

  function statusPage() {
    return `${head('Status og fremdrift')}${back('advanced')}${decoration()}
      <div class="status-details">
        <div class="group-title">Seksjon</div>
        <div>${html(sectionLabel(state.section))}</div>
        <div class="group-title">Status</div>
        <div class="muted" id="hbl29-status">${html(state.status)}</div>
        <div class="group-title">Fremdrift</div>
        <div class="progress" id="hbl29-progress"></div>
        <div class="warning" id="hbl29-errors" hidden></div>
      </div>`;
  }

  function warningsPage() {
    return `${head('Feilvarsling')}${back('advanced')}${decoration()}
      <label class="toggle"><span>Aktiver feilvarsling</span>
        <input type="checkbox" id="hbl29-warnings" ${settings.warnings ? 'checked' : ''}></label>
      <button class="primary" id="hbl29-test">Test feilmelding</button>
      <button class="menu" id="hbl29-reset-test" ${state.testing ? '' : 'hidden'}>Nullstill test</button>
      <div class="warning" id="hbl29-errors" hidden></div>
      <div class="muted">Varsling etter gjentatte mislykkede kontroller. Ingen automatisk innsending.</div>`;
  }

  function learningPage() {
    const rows = currentQuestions();
    if (rows.length) checklistPlan();
    const discoveries = state.discoveries;
    return `${head('Adaptive sjekkpunkter')}${back('advanced')}
      <div class="muted">Nye spørsmål fylles ikke før du har godkjent kategori.
      Endrede eller manglende spørsmål stopper sjekklistens autofyll til de er gjennomgått.</div>
      <div class="group-title">Endrede eller manglende spørsmål (${state.checklistIssues.length})</div>
      ${state.checklistIssues.map(issue => {
        const key = issue.split(':')[0] + ':' + issue.split(':')[1];
        const recordKey = issue.match(/^(built:\d+|learn:[^:]+)/)?.[1];
        if (!recordKey) return `<div class="warning">${html(issue)}</div>`;
        const knownText = recordKey.startsWith('built:')
          ? (baseline?.[recordKey.slice(6)] || ANCHORS[recordKey.slice(6)])
          : learned[recordKey.slice(6)]?.text;
        return `<div class="hbl-learn">
          <div class="question">${html(knownText || recordKey)}</div>
          <div class="muted">${html(issue)} — koble bare til riktig spørsmål etter kontroll</div>
          <select class="hbl31-rebind-select" data-record="${html(recordKey)}">
            <option value="">Velg erstatningsspørsmål</option>
            ${discoveries.map((r,i) => `<option value="${i}">${html(r.text || r.id)}</option>`).join('')}
          </select>
          <button class="menu hbl31-rebind" data-record="${html(recordKey)}">Godkjenn endring</button>
        </div>`;
      }).join('') || '<div class="muted">Ingen kjente spørsmål er endret eller mangler.</div>'}
      <div class="group-title">Oppdaget (${discoveries.length})</div>
      ${discoveries.map((r, i) => `<div class="hbl-learn">
        <div class="question">${html(r.text || '(Spørsmålstekst mangler)')}</div>
        <div class="muted">${html(r.id)} · ${r.green ? 'Grønt svar funnet' : 'Grønt svar mangler'}</div>
        ${['Inspeksjon','Etterkontroll','Luseskjørt'].map(c =>
          `<label><input type="checkbox" class="hbl31-cat" data-index="${i}" value="${c}"> ${c}</label>`).join('')}
        <button class="menu hbl31-save" data-index="${i}" ${!r.text || !r.green ? 'disabled' : ''}>Godkjenn og lær</button>
      </div>`).join('') || '<div class="muted">Ingen nye spørsmål på denne siden.</div>'}
      <div class="group-title">Lagrede regler (${Object.keys(learned).length})</div>
      ${Object.entries(learned).map(([key, r]) => `<div class="hbl-learn">
        <div class="question">${html(r.text)}</div>
        <div class="muted">${html(r.categories.join(', '))}</div>
        <button class="menu hbl31-delete" data-key="${html(key)}">Slett regel</button>
      </div>`).join('') || '<div class="muted">Ingen lærte spørsmål ennå.</div>'}
      <div class="group-title">Kontroll og tester</div>
      <div class="warning" ${state.checklistIssues.length ? '' : 'hidden'}>${html(state.checklistIssues.join(' · '))}</div>
      <button class="menu" id="hbl31-test">Kjør simulering (uten skjemainngrep)</button>
      <div class="muted" id="hbl31-test-result"></div>
      <button class="menu" id="hbl31-export">Eksporter regler og referanse</button>
      <label class="field">Importer sikkerhetskopi
        <input type="file" accept="application/json,.json" id="hbl31-import"></label>
      <div class="muted">Importer kun din egen sikkerhetskopi. Ingen rapport sendes automatisk.</div>`;
  }

  function simulation() {
    const sample = Object.entries(ANCHORS).map(([n, text]) => ({
      id: `MainContent_pkt${n}_VerdiKontroll`, number: Number(n), text
    }));
    const base = Object.fromEntries(Object.entries(ANCHORS));
    const run = rows => {
      const matches = Object.entries(base).map(([n, text]) =>
        rows.filter(r => normalize(r.text) === normalize(text)));
      return { matched: matches.filter(x => x.length === 1).length,
        unknown: rows.length - matches.filter(x => x.length === 1).length,
        missing: matches.filter(x => x.length === 0).length };
    };
    const shifted = [{ id:'MainContent_pkt346_VerdiKontroll', text:'Nytt kontrollpunkt' },
      ...sample.map((r, i) => ({ ...r, id:`MainContent_pkt${347+i}_VerdiKontroll` }))];
    const edited = sample.map((r,i) => i === 12 ? {...r, text:'Endret: '+r.text} : r);
    const removed = sample.slice(1);
    const a=run(shifted), b=run(edited), c=run(removed);
    const pass = a.matched===20 && a.unknown===1 && b.missing===1 &&
      b.unknown===1 && c.missing===1;
    return `${pass?'BESTÅTT':'FEILET'}: Nytt øverst (${a.matched} kjente, ${a.unknown} nye), `+
      `endret (${b.missing} mangler, ${b.unknown} ukjent), fjernet (${c.missing} mangler).`;
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

    panel.classList.toggle('hbl-home', page === 'home');
    panel.innerHTML = ({
      home,
      settings: settingsPage,
      general: generalPage,
      wash: washPage,
      final: finalPage,
      advanced: advancedPage,
      status: statusPage,
      warnings: warningsPage,
      learning: learningPage
    }[page] || home)();

    $('hbl29-close').onclick = closePanel;
    const title = $('hbl29-title');
    if (title) title.onclick = () => {
      const now = Date.now();
      state.titleClicks = [...state.titleClicks.filter(t => now - t < 2200), now];
      if (state.titleClicks.length >= 5) {
        state.titleClicks = [];
        state.party = !state.party;
        render(state.view);
      }
    };
    applyAppearance();
    updateWarnings();
    status(state.status, state.progress);
    const indicator = $('hbl29-indicator');
    if (indicator) indicator.onclick = () => render('status');

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

    if (page === 'advanced') {
      $('hbl29-dark').onchange = e => {
        settings.dark = e.target.checked;
        saveSettings();
        applyAppearance();
      };
      $('hbl29-hue').oninput = e => {
        settings.hue = Number(e.target.value);
        saveSettings();
        applyAppearance();
      };
      $('hbl29-reset-hue').onclick = () => {
        settings.hue = 202;
        saveSettings();
        $('hbl29-hue').value = '202';
        applyAppearance();
      };
    }

    if (page === 'warnings') {
      $('hbl29-warnings').onchange = e => {
        settings.warnings = e.target.checked;
        saveSettings();
        updateWarnings();
      };
      $('hbl29-test').onclick = () => {
        if (!settings.warnings) {
          status('Aktiver feilvarsling for å teste');
          return;
        }
        state.testing = true;
        flashWarning();
        updateWarnings();
        $('hbl29-reset-test').hidden = false;
      };
      $('hbl29-reset-test').onclick = () => {
        state.testing = false;
        updateWarnings();
        $('hbl29-reset-test').hidden = true;
      };
    }

    if (page === 'learning') {
      panel.querySelectorAll('.hbl31-rebind').forEach(button => {
        button.onclick = () => {
          const key = button.dataset.record;
          const selector = [...panel.querySelectorAll('.hbl31-rebind-select')]
            .find(x => x.dataset.record === key);
          const row = state.discoveries[Number(selector?.value)];
          if (!selector?.value || !row?.text || !row.green) {
            alert('Velg et spørsmål med gyldig tekst og ett grønt svar.'); return;
          }
          if (!confirm('Bekreft at dette er SAMME kontrollpunkt som før, med endret tekst eller ID.')) return;
          if (key.startsWith('built:')) {
            if (!baseline) { alert('Referanse er ikke etablert ennå.'); return; }
            baseline[key.slice(6)] = row.text;
            store(BASELINE_KEY, baseline);
          } else if (key.startsWith('learn:')) {
            const old = key.slice(6);
            const rule = learned[old];
            if (!rule) return;
            delete learned[old];
            learned[normalize(row.text)] = {text:row.text,categories:rule.categories};
            saveRules();
          }
          checklistPlan(); render('learning');
          state.retryCount=0;
          if (settings.enabled && state.section==='checklist') runFill();
        };
      });
      panel.querySelectorAll('.hbl31-save').forEach(button => {
        button.onclick = () => {
          const row = state.discoveries[Number(button.dataset.index)];
          const cats = [...panel.querySelectorAll(`.hbl31-cat[data-index="${button.dataset.index}"]:checked`)]
            .map(x => x.value);
          if (!row?.text || !row.green || !cats.length) {
            alert('Velg minst én kategori og kontroller at grønt svar finnes.');
            return;
          }
          const key = normalize(row.text);
          if (Object.values(learned).some(r => normalize(r.text) === key)) return;
          learned[key] = { text: row.text, categories: cats };
          saveRules();
          checklistPlan();
          render('learning');
          state.retryCount = 0;
          if (settings.enabled && state.section === 'checklist') runFill();
        };
      });
      panel.querySelectorAll('.hbl31-delete').forEach(button => {
        button.onclick = () => {
          if (!confirm('Slette denne lærte regelen?')) return;
          delete learned[button.dataset.key];
          saveRules();
          checklistPlan();
          render('learning');
        };
      });
      $('hbl31-test').onclick = () => {
        $('hbl31-test-result').textContent = simulation();
      };
      $('hbl31-export').onclick = () => {
        const payload = JSON.stringify({version:1,baseline,learned},null,2);
        const blob = new Blob([payload],{type:'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href=url; a.download='havbruksloggen-v31-regler.json'; a.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
      $('hbl31-import').onchange = async e => {
        try {
          const file=e.target.files?.[0]; if (!file) return;
          const obj=JSON.parse(await file.text());
          if (obj.version!==1 || !obj.learned || typeof obj.learned!=='object' ||
            Array.isArray(obj.learned) || !obj.baseline || typeof obj.baseline!=='object')
            throw Error('Ugyldig format');
          for (const [key,r] of Object.entries(obj.learned)) {
            if (!r || typeof r.text!=='string' || normalize(r.text)!==key ||
              !Array.isArray(r.categories) || !r.categories.length ||
              !r.categories.every(c=>['Inspeksjon','Etterkontroll','Luseskjørt'].includes(c)))
              throw Error('Ugyldig regel');
          }
          if (!Object.keys(ANCHORS).every(n=>typeof obj.baseline[n]==='string' &&
              normalize(obj.baseline[n]).length > 10) ||
              new Set(Object.values(obj.baseline).map(normalize)).size !== 20)
            throw Error('Ugyldig referanse');
          if (!confirm('Erstatte lagrede læringsregler og referanse med sikkerhetskopien?')) return;
          Object.keys(learned).forEach(k=>delete learned[k]);
          Object.assign(learned,obj.learned);
          baseline=obj.baseline;
          saveRules(); store(BASELINE_KEY,baseline);
          checklistPlan(); render('learning');
        } catch(err) { alert('Import mislyktes: '+err.message); }
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
    button.textContent = 'Autofyll v3.1';

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
    applyAppearance();

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

      // ASP.NET can replace controls without changing the section.
      // Old generated values must never authorize writing to a new DOM node.
      for (const id of new Set([...state.generated.keys(), ...state.touched])) {
        const current = $(id);
        const prior = state.lastNodes.get(id);
        if (prior && current !== prior) {
          state.generated.delete(id);
          state.touched.delete(id);
        }
        if (current) state.lastNodes.set(id,current);
      }
      const next = sectionNow();
      if (next === 'checklist') {
        const before = state.checklistIssues.join('|')+'#'+state.checklistNotices.join('|');
        checklistPlan();
        const after = state.checklistIssues.join('|')+'#'+state.checklistNotices.join('|');
        if (before !== after) updateWarnings();
      }

      if (next !== state.section) {
        state.section = next;
        state.visit++;
        state.retryCount = 0;
        state.lastVerify = null;

        state.touched.clear();
        state.generated.clear();
        state.lastNodes.clear();
        state.testing = false;
        state.checklistIssues = [];
        state.checklistNotices = [];
        state.discoveries = [];
        clearWarnings();

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
        if (verifySection(next).missing.length && !state.checklistIssues.length && state.retryCount < 10) {
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