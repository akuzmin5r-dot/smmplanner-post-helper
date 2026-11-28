// ==UserScript==
// @name         SMMplanner Helper — Safari
// @namespace    https://smmplanner.com/
// @version      3.1.0
// @updateURL    https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-safari.user.js
// @downloadURL  https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-safari.user.js
// @description  Автовыбор страниц и копирование заголовка со всеми опубликованными ссылками.
// @match        https://smmplanner.com/home/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window !== top || window.__postHelperV2) return;
  window.__postHelperV2 = true;
  const version = '3.1.0';
  let busy = false, configureRequested = false, editorSequence = 0;
  const installed = new WeakSet(), handled = new WeakSet();
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const firstLine = text => String(text || '').split(/\r\n|[\n\r\u2028\u2029]/).map(s => s.trim()).find(Boolean) || '';
  function urlsOf(modal) {
    return [...new Set([...modal.querySelectorAll('post-status a[href]')].map(a => {
      try { const u = new URL(a.href); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; }
    }).filter(Boolean))];
  }
  function reportOf(modal) {
    const field = modal.querySelector('emoji-input[ng-model="project.text"] textarea,textarea[ng-model="project.text"]');
    if (!field) throw Error('Не найден полный текст поста. Окно оставлено открытым.');
    const title = firstLine(field.value), links = urlsOf(modal);
    if (!links.length) throw Error('Опубликованных ссылок пока нет.');
    return (title ? title + '\n\n' : '') + links.join('\n');
  }
  function titleOf(modal) { return modal.querySelector('h3,h4,.modal-title')?.textContent.trim() || ''; }
  function modalOf(doc) { return [...doc.querySelectorAll('.modal-dialog')].find(m => /Редактирование поста|Планирование нового поста/.test(titleOf(m))); }
  function newModal(doc) { const m = modalOf(doc); return m && titleOf(m).includes('Планирование нового поста') ? m : null; }
  function pagesOf(modal) {
    const counts = new Map(), result = [];
    for (const li of modal.querySelectorAll('li[ng-repeat="page in group.pageconfig_set"]')) {
      const name = li.querySelector('.page-name')?.textContent.trim();
      const logo = li.querySelector('.page-logo');
      const medium = [...(logo?.classList || [])].find(x => !['page-logo', 'ng-scope'].includes(x)) || '';
      const group = li.closest('.panel')?.querySelector('.panel-heading')?.textContent.trim() || '';
      if (!name || !medium) continue;
      const base = JSON.stringify([group, medium, name]);
      const ordinal = counts.get(base) || 0; counts.set(base, ordinal + 1);
      result.push({ li, name, medium, group, ordinal, base, key: JSON.stringify([group, medium, name, ordinal]) });
    }
    return result.map(p => ({ ...p, total: counts.get(p.base) }));
  }
  function storageKey(doc) {
    const url = new URL(doc.URL);
    return 'post-helper:settings:v2:' + (url.searchParams.get('organizationContext') || 'personal');
  }
  function readSettings(doc) {
    try {
      const s = JSON.parse(localStorage.getItem(storageKey(doc)) || 'null');
      return s && Array.isArray(s.pages) ? s : { enabled: true, pages: [] };
    } catch { return { enabled: true, pages: [] }; }
  }
  function saveSettings(doc, settings) { localStorage.setItem(storageKey(doc), JSON.stringify(settings)); }
  function button(text, action) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
    b.className = 'ph-button'; b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); action(e); }); return b;
  }
  function panel(label) {
    const overlay = document.createElement('div'); overlay.className = 'ph-overlay';
    const box = document.createElement('div'); box.className = 'ph-panel';
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', label);
    const heading = document.createElement('h3'); heading.textContent = label; box.append(heading);
    overlay.append(box); document.body.append(overlay); return { overlay, box };
  }
  function textLine(host, text) { const p = document.createElement('p'); p.textContent = text; host.append(p); return p; }
  function showManual(text) {
    const { overlay, box } = panel('Готовый отчёт');
    const hint = textLine(box, 'Нажмите «Скопировать».');
    const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
    field.setAttribute('aria-label', 'Заголовок и ссылки'); field.className = 'ph-text'; box.append(field);
    box.append(button('Скопировать', async () => {
      try { await navigator.clipboard.writeText(text); hint.textContent = 'Скопировано'; } catch {
        field.focus(); field.select(); field.setSelectionRange(0, text.length);
        let ok = false; try { ok = document.execCommand('copy'); } catch {}
        hint.textContent = ok ? 'Скопировано' : 'Выберите «Скопировать» в меню выделенного текста.';
      }
    }), button('Закрыть', () => overlay.remove()));
  }
  async function copyDuringTap(promise) {
    const ready = Promise.resolve(promise);
    try {
      if (!navigator.clipboard?.write || !window.ClipboardItem) throw Error('Manual copy');
      const payload = ready.then(t => new Blob([t], { type: 'text/plain' }));
      // Avoid an unhandled rejection if a browser rejects write before reading the item.
      payload.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': payload })]);
      await ready;
      return true;
    } catch {
      showManual(await ready);
      return false;
    }
  }
  async function collect(doc, row) {
    if (modalOf(doc)) throw Error('Сначала закройте открытое окно поста.');
    const edit = row.querySelector('.post-edit-button');
    if (!edit) throw Error('Не найдена кнопка открытия поста.');
    edit.click();
    let owned;
    try {
      for (let i = 0; i < 100; i++) {
        const m = modalOf(doc);
        if (m && titleOf(m).includes('Редактирование поста')) {
          owned = m;
          if (m.querySelector('emoji-input[ng-model="project.text"] textarea,textarea[ng-model="project.text"]') && m.querySelector('post-status')) {
            return reportOf(m);
          }
        }
        await sleep(150);
      }
      throw Error('Окно поста не загрузилось. Попробуйте ещё раз.');
    } finally {
      // Only close the editor opened by this operation. Never click save/OK/publish.
      if (owned?.isConnected) owned.querySelector('button[ng-click="closeWithConfirm()"]')?.click();
    }
  }
  function configure(doc, modal) {
    if (document.querySelector('.ph-settings')) return;
    const pages = pagesOf(modal), settings = readSettings(doc), { overlay, box } = panel('Настройки помощника');
    box.classList.add('ph-settings');
    const heading = box.querySelector('h3'), header = document.createElement('div'); header.className = 'ph-settings-header';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'ph-settings-close'; close.setAttribute('aria-label', 'Закрыть настройки');
    const dismiss = () => overlay.remove();
    close.onclick = dismiss; header.append(heading, close);
    const body = document.createElement('div'); body.className = 'ph-settings-body';
    const section = title => {
      const element = document.createElement('section'), h = document.createElement('h4'); h.textContent = title;
      element.append(h); body.append(element); return element;
    };
    const choice = (host, title, hint, checked, toggle = true) => {
      const label = document.createElement('label'); label.className = 'ph-setting-row';
      const copy = document.createElement('span'); copy.className = 'ph-setting-copy';
      const name = document.createElement('span'); name.className = 'ph-setting-name'; name.textContent = title; copy.append(name);
      if (hint) { const help = document.createElement('span'); help.className = 'ph-setting-help'; help.textContent = hint; copy.append(help); }
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked;
      input.className = toggle ? 'ph-setting-toggle' : 'ph-setting-check';
      if (toggle) input.setAttribute('role', 'switch');
      label.append(copy, input); host.append(label); return input;
    };
    const auto = section('Страницы для нового поста');
    const enabledInput = choice(auto, 'Автовыбор страниц', 'Выбранные ВК и ОК добавляются при создании поста.', settings.enabled);
    const pageList = document.createElement('div'); pageList.className = 'ph-setting-pages'; auto.append(pageList);
    const choices = [];
    for (const page of pages.filter(p => p.medium === 'vk' || p.medium === 'ok')) {
      const detail = (page.medium === 'vk' ? 'ВКонтакте' : 'Одноклассники') + (page.group ? ' · ' + page.group : '') + (page.total > 1 ? ' · вариант ' + (page.ordinal + 1) : '');
      const input = choice(pageList, page.name, detail, settings.pages.some(p => p.key === page.key), false);
      choices.push({ input, page });
    }
    if (!choices.length) textLine(pageList, 'Доступные страницы ВК и ОК пока не найдены.');
    const updatePages = () => {
      pageList.classList.toggle('ph-setting-pages-disabled', !enabledInput.checked);
      for (const { input } of choices) input.disabled = !enabledInput.checked;
    };
    enabledInput.addEventListener('change', updatePages); updatePages();
    const content = section('Текст и видео');
    const trimInput = choice(content, 'Удалять подпись о подписке', 'При вставке убирается подпись в конце. Её можно сразу вернуть.', settings.footerTrim !== false);
    const videoInput = choice(content, 'Автозаголовок видео', 'Первый абзац без эмодзи. Редактор видео открывать не нужно; ручное название сохраняется.', settings.autoVideoTitle !== false);
    const appearance = section('Оформление');
    const skinInput = choice(appearance, 'Обновлённое оформление', 'Стили страницы SMMplanner.', settings.skin !== false);
    const privacy = textLine(body, 'Настройки сохраняются только в этом браузере, отдельно для каждой команды.'); privacy.className = 'ph-settings-privacy';
    const message = textLine(body, ''); message.className = 'ph-settings-error'; message.setAttribute('role', 'alert');
    const footer = document.createElement('div'); footer.className = 'ph-settings-footer';
    const save = button('Сохранить', () => {
      const selected = choices.filter(x => x.input.checked).map(x => ({ key: x.page.key, total: x.page.total }));
      if (enabledInput.checked && !selected.length) { message.textContent = 'Выберите страницы для автовыбора или отключите его.'; message.scrollIntoView({ block: 'nearest' }); return; }
      try { saveSettings(doc, { ...settings, enabled: enabledInput.checked, skin: skinInput.checked, footerTrim: trimInput.checked, autoVideoTitle: videoInput.checked, pages: selected }); }
      catch { message.textContent = 'Не удалось сохранить настройки. Проверьте доступ к хранилищу браузера.'; return; }
      handled.delete(modal); dismiss(); applyDefaults(doc, modal); syncVideoTitle(doc, modal);
    });
    save.classList.add('ph-settings-save');
    footer.append(button('Отмена', dismiss), save); box.replaceChildren(header, body, footer);
    overlay.addEventListener('click', event => { if (event.target === overlay) dismiss(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === 'Tab') {
        const controls = [...box.querySelectorAll('button,input')].filter(el => !el.disabled);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    heading.tabIndex = -1; heading.style.outline = 'none'; heading.focus({ preventScroll: true });
  }
  function applyDefaults(doc, modal) {
    if (handled.has(modal)) return;
    const settings = readSettings(doc);
    if (!settings.enabled || !settings.pages.length) return;
    const pages = pagesOf(modal); if (!pages.length) return;
    const matches = settings.pages.map(p => pages.find(x => x.key === p.key && x.total === p.total));
    if (matches.some(p => !p)) {
      handled.add(modal);
      textLine(modal.querySelector('.modal-body') || modal, 'Автовыбор: список страниц изменился. Откройте «Настроить автовыбор» и выберите страницы заново.'); return;
    }
    // Preserve any selection already present in a new/duplicated draft.
    if (modal.querySelector('tr[ng-repeat="post in posts"]')) { handled.add(modal); return; }
    handled.add(modal);
    for (const page of matches) {
      if (!page.li.classList.contains('ng-hide')) page.li.querySelector('a[ng-click="addPage(page)"]')?.click();
    }

  }
  function actionLabel(target, text, kind = 'copy') {
    const doc = target.ownerDocument, ns = 'http://www.w3.org/2000/svg';
    const icon = doc.createElementNS(ns, 'svg'); icon.setAttribute('viewBox','0 0 24 24'); icon.setAttribute('fill','none');
    icon.setAttribute('stroke','currentColor'); icon.setAttribute('stroke-width','1.7'); icon.setAttribute('aria-hidden','true'); icon.classList.add('ph-icon');
    const rect = (x,y,w,h,r=2) => { const el = doc.createElementNS(ns,'rect'); for(const [k,v] of Object.entries({x,y,width:w,height:h,rx:r}))el.setAttribute(k,v);icon.append(el); };
    if(kind === 'clear'){const path=doc.createElementNS(ns,'path');path.setAttribute('d','M6 6l12 12M18 6L6 18');path.setAttribute('stroke-linecap','round');icon.append(path);}else if(kind === 'paste'){rect(6,5,12,16);rect(9,3,6,4,1);}else{rect(8,8,12,13);const path=doc.createElementNS(ns,'path');path.setAttribute('d','M16 5V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1');icon.append(path);}
    const label = doc.createElement('span'); label.textContent = text;target.replaceChildren(icon,label);
  }

  function syncDensity(doc = document) {
    const touch = matchMedia('(pointer:coarse)').matches;
    const layoutWidth = document.documentElement.clientWidth;
    const factor = touch ? Math.min(3, Math.max(1, layoutWidth / Math.max(1, screen.width || layoutWidth))) : 1;
    const value = String(Math.round(factor * 100) / 100);
    if (doc.documentElement.style.getPropertyValue('--ph-size') !== value) doc.documentElement.style.setProperty('--ph-size', value);
  }
  function autoSummary(doc) {
    const s = readSettings(doc);
    if (!s.pages.length) return 'Автовыбор: выберите страницы';
    return s.enabled ? 'Автовыбор · страниц: ' + s.pages.length : 'Автовыбор выключен';
  }
  function footerKey(value) {
    const text = String(value || '')
      .replace(/\[([^\]\r\n]+)\]\(\s*(?:https?:\/\/|t\.me\/|max\.ru\/)[^)\s]+\s*\)/gi, '$1')
      .replace(/\(\s*(?:https?:\/\/|t\.me\/|max\.ru\/)[^)\s]+\s*\)/gi, '')
      .replace(/<?(?:https?:\/\/|t\.me\/|max\.ru\/)[^\s<>()\]]+>?/gi, '')
      .replace(/\*\*|__/g, '').replace(/[\u200b\ufeff]/g, '');
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length === 1 ? lines[0].replace(/[ \t\u00a0]+/g, ' ').trim() : '';
  }
  function footerBoundary(text, index) {
    if (index === 0) return true;
    const prefix = text.slice(0, index);
    return /\n[ \t\u00a0]*$/.test(prefix) || /[.!?…][ \t\u00a0]+$/.test(prefix) || /[ \t\u00a0]{2,}$/.test(prefix);
  }
  function trimSubscriptionFooter(input, settings = {}) {
    const original = String(input);
    if (settings.footerTrim === false) return { text: original, removed: false };
    const signatures = (Array.isArray(settings.footerSignatures) ? settings.footerSignatures : [])
      .filter(value => typeof value === 'string' && value.length <= 1000).slice(0, 30)
      .map(footerKey).filter(Boolean).map(value => value.toLocaleLowerCase());
    let result = original, removed = false;
    for (let pass = 0; pass < 5; pass++) {
      const starts = new Set([0]);
      for (const match of result.matchAll(/\n[ \t\u00a0]*/g)) starts.add(match.index + match[0].length);
      for (const match of result.matchAll(/\[[^\]\r\n]+\]\(\s*(?:https?:\/\/|t\.me\/|max\.ru\/)[^)\s]+\s*\)/gi)) starts.add(match.index);
      for (const match of result.matchAll(/(?:\*\*|__)?\[?Подписывайтесь[ \t\u00a0]+на[ \t\u00a0]+/giu)) starts.add(match.index);
      for (const match of result.matchAll(/(?:\*\*|__)?\[?Подписаться[ \t\u00a0]+(?:в|на)[ \t\u00a0]+(?:MAX|МАКС|Telegram|Телеграм)/giu)) starts.add(match.index);
      for (const signature of signatures) {
        const first = signature.match(/[\p{L}\p{N}@]+/u)?.[0];
        if (!first) continue;
        const lower = result.toLocaleLowerCase();
        for (let index = lower.indexOf(first); index >= 0; index = lower.indexOf(first, index + first.length)) {
          let start = index;
          while (start > 0 && /[\[*_]/.test(result[start - 1])) start--;
          starts.add(start);
        }
      }
      let cut = null;
      for (const start of [...starts].sort((a, b) => a - b)) {
        const fragment = result.slice(start);
        if (fragment.length > 2500 || !footerBoundary(result, start)) continue;
        const key = footerKey(fragment);
        if (!key || key.length > 240) continue;
        if (signatures.includes(key.toLocaleLowerCase())) { cut = start; break; }
        const linked = /(?:https?:\/\/|t\.me\/|max\.ru\/)/i.test(fragment);
        const invite = key.match(/^Подписывайтесь на (.{1,120})$/iu);
        if (invite && !/[!?…:;«»"'“”]/u.test(invite[1]) && !/\.\s|[.,]$/.test(invite[1]) &&
            (linked || /^[\p{Lu}\p{N}@]/u.test(invite[1]))) { cut = start; break; }
        if (/^Подписаться (?:в|на) (?:MAX|МАКС|Telegram|Телеграм)$/iu.test(key)) { cut = start; break; }
        const pair = key.match(/^([^/\n]{1,100})\s*\/\s*Подписаться (?:в|на) (?:MAX|МАКС)$/iu);
        if (pair && !/[!?…:;«»"'“”]|\.\s/u.test(pair[1]) &&
            (linked || (start > 0 && /\n[ \t\u00a0]*$/.test(result.slice(0, start)) && /^[\p{Lu}\p{N}@]/u.test(pair[1])))) {
          cut = start; break;
        }
      }
      if (cut === null) break;
      const next = result.slice(0, cut).trimEnd();
      if (next.length >= result.length) break;
      result = next; removed = true;
    }
    return { text: result, removed };
  }

  function videoTitleOf(text) {
    const paragraph = String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/)[0];
    const clean = paragraph
      .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/[0-9#*]\ufe0f?\u20e3/g, '')
      .replace(/[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0e\ufe0f\u20e3\u{E0020}-\u{E007F}]/gu, '')
      .replace(/\s+/g, ' ').trim();
    return Array.from(clean).slice(0, 255).join('').trimEnd();
  }
  const videoTitles = new WeakMap();
  function syncVideoTitle(doc, modal) {
    let state = videoTitles.get(modal);
    if (!state) {
      state = { last: null, manual: false }; videoTitles.set(modal, state);
      for (const type of ['input', 'keyup', 'change']) modal.addEventListener(type, event => {
        if (event.target.closest?.('emoji-input[ng-model="project.text"],textarea[ng-model="project.text"]'))
          queueMicrotask(() => { if (modal.isConnected) syncVideoTitle(doc, modal); });
      });
    }
    if (readSettings(doc).autoVideoTitle === false) return;
    const field = modal.querySelector('input[ng-model="project.caption"]');
    const text = modal.querySelector('emoji-input[ng-model="project.text"] textarea,textarea[ng-model="project.text"]');
    // This native cover control is shown only for videos, not photos or GIFs.
    const video = modal.querySelector('button[ngf-change="onCoverSelect($files, picture)"]:not(.ng-hide)');
    if (!field || !text || !video) return;
    if (state.manual) return;
    if (state.last === null ? !!field.value : field.value !== state.last) { state.manual = true; return; }
    // Leave the video editor alone while the user edits a title or a cover.
    if (doc.querySelector('input[ng-model="videoTitle"]')) return;
    const title = videoTitleOf(text.value);
    if (title === field.value) return;
    state.last = title;
    field.value = title;
    field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    field.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  }

  function addPaste(doc, modal) {
    const field = modal.querySelector('emoji-input[ng-model="project.text"],textarea[ng-model="project.text"]');
    if (!field || modal.querySelector('.ph-paste')) return;
    const editor = field.querySelector('.emoji-wysiwyg-editor');
    if (!editor && field.tagName !== 'TEXTAREA') return;
    const line = doc.createElement('div'); line.className = 'ph-paste-row';
    const paste = doc.createElement('button'); paste.type = 'button'; paste.className = 'ph-paste';
    const status = doc.createElement('span'); status.className = 'ph-paste-status'; status.setAttribute('role', 'status');
    let snapshot = null, timer = null, updating = false, pending = false;
    const hasText = () => editor
      ? !!(editor.textContent.replace(/\u200b/g, '') || editor.querySelector('img[alt]'))
      : !!field.value;
    const refresh = () => {
      if (updating) return;
      if (!modal.isConnected) { clearTimeout(timer); observer?.disconnect(); return; }
      const mode = hasText() ? 'clear' : 'paste';
      if (snapshot && snapshot.key !== contentKey()) discardUndo();
      if (paste.dataset.mode !== mode) {
        paste.dataset.mode = mode;
        actionLabel(paste, mode === 'clear' ? 'Очистить' : 'Вставить текст', mode === 'clear' ? 'clear' : 'paste');
      }
      paste.title = mode === 'clear' ? 'Очистить текст поста' : 'Вставить текст из буфера без перехода в редактор';
      paste.setAttribute('aria-label', mode === 'clear' ? 'Очистить текст' : 'Вставить текст');
    };
    const observer = editor ? new doc.defaultView.MutationObserver(() => queueMicrotask(refresh)) : null;
    function discardUndo() {
      snapshot = null; clearTimeout(timer); timer = null;
      status.querySelector('.ph-undo-notice')?.remove();
    }
    function saveScroll() {
      const nodes = new Set();
      for (const start of [editor || field, doc.defaultView.frameElement]) {
        for (let node = start; node; node = node.parentElement) nodes.add(node);
      }
      const points = [...nodes].map(node => [node, node.scrollLeft, node.scrollTop]);
      return () => {
        for (const [node, x, y] of points) {
          if (!node.isConnected) continue;
          if (node.scrollLeft !== x) node.scrollLeft = x;
          if (node.scrollTop !== y) node.scrollTop = y;
        }
      };
    }
    function announceChange() {
      const target = editor || field;
      target.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
      if (editor) target.dispatchEvent(new doc.defaultView.KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
      target.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
    }
    function changeContent(write) {
      const restoreScroll = saveScroll();
      updating = true;
      try { write(); announceChange(); }
      finally { updating = false; }
      refresh(); restoreScroll();
      doc.defaultView.requestAnimationFrame(() => { if (modal.isConnected) restoreScroll(); });
    }
    function contentKey() {
      if (!editor) return field.value;
      const read = node => node.nodeType === 3 ? node.nodeValue
        : node.nodeName === 'BR' ? '\n' : node.nodeName === 'IMG' ? node.getAttribute('alt') || ''
        : [...node.childNodes].map(read).join('');
      return read(editor).replace(/\u200b/g, '');
    }
    function plainFragment(text) {
      const fragment = doc.createDocumentFragment();
      String(text).replace(/\r\n?/g, '\n').split('\n').forEach((part, index) => {
        if (index) fragment.append(doc.createElement('br'));
        fragment.append(doc.createTextNode(part));
      });
      return fragment;
    }
    function writePlain(text) {
      if (editor) editor.replaceChildren(plainFragment(text));
      else field.value = text;
    }
    (editor || field).addEventListener('paste', event => {
      const clipboard = event.clipboardData;
      if (!clipboard || clipboard.files?.length) return;
      const text = clipboard.getData('text/plain');
      if (!text) return;
      const cleaned = trimSubscriptionFooter(text, readSettings(doc));
      if (!cleaned.removed) return;
      let saved, insert;
      if (editor) {
        const selection = doc.defaultView.getSelection();
        const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : doc.createRange();
        if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
          range.selectNodeContents(editor); range.collapse(false);
        }
        const path = node => {
          const parts = [];
          while (node !== editor) { parts.unshift([...node.parentNode.childNodes].indexOf(node)); node = node.parentNode; }
          return parts;
        };
        const startPath = path(range.startContainer), endPath = path(range.endContainer);
        const clone = editor.cloneNode(true), rawRange = doc.createRange();
        const at = parts => parts.reduce((node, index) => node.childNodes[index], clone);
        rawRange.setStart(at(startPath), range.startOffset);
        rawRange.setEnd(at(endPath), range.endOffset);
        rawRange.deleteContents(); rawRange.insertNode(plainFragment(text));
        saved = { nodes: [...clone.childNodes].map(node => node.cloneNode(true)), cleanup: true };
        insert = () => {
          range.deleteContents();
          const fragment = plainFragment(cleaned.text), last = fragment.lastChild;
          range.insertNode(fragment);
          if (last && selection) { range.setStartAfter(last); range.collapse(true); selection.removeAllRanges(); selection.addRange(range); }
        };
      } else {
        const start = field.selectionStart, end = field.selectionEnd, before = field.value.slice(0, start), after = field.value.slice(end);
        saved = { value: before + text + after, cleanup: true };
        insert = () => { field.value = before + cleaned.text + after; field.setSelectionRange(start + cleaned.text.length, start + cleaned.text.length); };
      }
      event.preventDefault(); event.stopImmediatePropagation();
      discardUndo(); changeContent(insert); showUndo(saved);
    }, true);
    function showUndo(saved) {
      snapshot = { ...saved, key: contentKey() };
      const undo = doc.createElement('button'); undo.type = 'button'; undo.className = 'ph-undo-text'; undo.textContent = saved.cleanup ? 'Вернуть подпись' : 'Вернуть текст';
      undo.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        if (!snapshot || snapshot.key !== contentKey()) { discardUndo(); refresh(); return; }
        const saved = snapshot;
        discardUndo(); status.textContent = '';
        changeContent(() => {
          if (editor) editor.replaceChildren(...saved.nodes.map(node => node.cloneNode(true)));
          else field.value = saved.value;
        });
      };
      const notice = doc.createElement('span'); notice.className = 'ph-undo-notice';
      if (saved.cleanup) notice.append(doc.createTextNode('Подпись удалена · '));
      notice.append(undo); status.replaceChildren(notice);
      timer = setTimeout(() => { discardUndo(); refresh(); }, 10000);
    }
    paste.onclick = async event => {
      event.preventDefault(); event.stopPropagation();
      if (pending) return;
      status.textContent = '';
      if (hasText()) {
        const saved = editor ? { nodes: [...editor.childNodes].map(node => node.cloneNode(true)) } : { value: field.value };
        discardUndo();
        changeContent(() => { if (editor) editor.replaceChildren(); else field.value = ''; });
        showUndo(saved); refresh(); return;
      }
      pending = true; paste.disabled = true;
      try {
        if (!navigator.clipboard?.readText) throw Error('Этот браузер не разрешает чтение буфера. Используйте вставку через поле текста.');
        const text = await navigator.clipboard.readText();
        if (!modal.isConnected) return;
        if (!text) { status.textContent = 'В буфере нет текста.'; return; }
        // Do not replace content typed while a clipboard permission prompt was open.
        if (hasText()) { status.textContent = 'В поле уже появился текст. Он сохранён.'; return; }
        discardUndo();
        const cleaned = trimSubscriptionFooter(text, readSettings(doc));
        changeContent(() => writePlain(cleaned.text));
        if (cleaned.removed) showUndo(editor
          ? { nodes: [...plainFragment(text).childNodes], cleanup: true }
          : { value: text, cleanup: true });
      } catch (error) {
        status.textContent = error.name === 'NotAllowedError' ? 'Разрешите вставку из буфера и нажмите ещё раз. Либо используйте вставку через поле поста.' : error.message;
      } finally { pending = false; paste.disabled = false; refresh(); }
    };
    for (const type of ['input', 'keyup', 'change']) (editor || field).addEventListener(type, () => queueMicrotask(refresh));
    observer?.observe(editor, { childList: true, subtree: true, characterData: true });
    line.append(paste, status); (field.closest('.form-group.emoji-group') || field).before(line);
    refresh();
  }

  function invokeNativeOk(modal) {
    const native = modal.querySelector('.modal-footer button[ng-click="ok()"]');
    if (!native?.isConnected || native.disabled || native.getAttribute('aria-disabled') === 'true') return false;
    native.click();
    return true;
  }
  function enhanceSchedule(doc, modal) {
    const rows = [...modal.querySelectorAll('tr[ng-repeat="post in posts"]')];
    for (const row of rows) {
      const page = row.querySelector('social-page');
      const date = row.querySelector('input[ng-model="post.scheduled_for"]');
      const hour = row.querySelector('select[ng-model="hour"]');
      const minute = row.querySelector('select[ng-model="minute"]');
      if (!page || !date || !hour || !minute) continue;
      row.classList.add('ph-schedule-row');
      page.closest('td').classList.add('ph-schedule-page');
      date.closest('td').classList.add('ph-schedule-time');
      const remove = row.querySelector('a[ng-click="removePost(post)"]');
      remove?.closest('td').classList.add('ph-schedule-remove');
      if (remove && !remove.hasAttribute('aria-label')) remove.setAttribute('aria-label', 'Убрать страницу из поста');
      if (!date.hasAttribute('aria-label')) date.setAttribute('aria-label', 'Дата публикации');
      if (!hour.hasAttribute('aria-label')) hour.setAttribute('aria-label', 'Часы публикации');
      if (!minute.hasAttribute('aria-label')) minute.setAttribute('aria-label', 'Минуты публикации');
      const table = row.closest('table'); table.classList.add('ph-schedule-table');
      table.parentElement.classList.add('ph-schedule-block');
    }
    const unified = modal.querySelector('[ng-click="setUnifiedTime()"]');
    const now = modal.querySelector('[ng-click="setUnifiedTimeNow()"]');
    if (unified && now && unified.parentElement === now.parentElement) {
      unified.parentElement.classList.add('ph-time-tools');
      for (const control of [unified, now]) {
        if (!control.hasAttribute('role')) control.setAttribute('role', 'button');
        if (!control.hasAttribute('tabindex')) control.tabIndex = 0;
        if (!control.dataset.phKeyboard) {
          control.dataset.phKeyboard = 'true';
          control.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); control.click(); }
          });
        }
      }
    }
    const firstPage = modal.querySelector('li[ng-repeat="page in group.pageconfig_set"]');
    firstPage?.closest('.form-group')?.classList.add('ph-page-picker');
  }
  function enhanceComposeBar(doc) {
    for (const primary of doc.querySelectorAll('button[ng-click="newPostProject()"]')) {
      const bar = primary.parentElement;
      if (!bar.classList.contains('main-layout')) continue;
      const storyHost = [...bar.children].find(e => e.tagName === 'SCHEDULE-STORY-BUTTON');
      const story = storyHost?.querySelector('button[ng-click="c.openStoryCreator()"]');
      if (!story) continue;
      bar.classList.add(bar.classList.contains('main-layout') ? 'ph-compose-bar' : 'ph-compose-inline'); primary.classList.add('ph-compose-primary');
      storyHost.classList.add('ph-story-host'); story.classList.add('ph-story-button');
      if (!story.querySelector('.ph-story-label')) {
        const label = doc.createElement('span'); label.className = 'ph-story-label'; label.textContent = 'Сторис'; story.append(label);
      }
      story.setAttribute('aria-label', 'Запланировать историю');
    }
  }

  function enhanceEditor(doc, modal) {
    const native = modal.querySelector('.modal-footer button[ng-click="ok()"]');
    const cancel = modal.querySelector('.modal-footer button[ng-click="closeWithConfirm()"]');
    const field = modal.querySelector('emoji-input[ng-model="project.text"]');
    const photo = modal.querySelector('button[ngf-select][ngf-change="onPictureSelect($files)"]');
    const settings = modal.querySelector('.postproject-form__settings');
    const media = photo?.parentElement;
    const line = modal.querySelector('.ph-paste-row');
    // If the native form changes, keep its existing controls visible and intact.
    if (!native || !cancel || !field || !photo || !settings || !line || !media?.classList.contains('form-group')) return;
    modal.classList.add('ph-new-post');
    native.parentElement.classList.add('ph-editor-footer');
    photo.classList.add('ph-main-media');
    media.classList.add('ph-media-tools');
    const poll = media.querySelector('button[ng-click="poll.toggle()"]');
    poll?.classList.add('ph-main-media');
    media.dataset.hasPoll = String(!!poll);
    settings.classList.add('ph-extra-options');
    if (!line.querySelector('.ph-submit-proxy')) {
      const proxy = doc.createElement('button'); proxy.type = 'button'; proxy.className = 'ph-submit-proxy';
      proxy.textContent = 'Опубликовать пост';
      proxy.title = 'Повторяет ОК: публикация или планирование по указанному времени';
      proxy.setAttribute('aria-description', 'Использует выбранные страницы, дату и время, как штатная кнопка ОК');
      proxy.onclick = event => { event.preventDefault(); event.stopPropagation(); invokeNativeOk(modal); };
      line.insertBefore(proxy, line.querySelector('.ph-paste-status'));
      const sync = () => {
        proxy.disabled = native.disabled || native.getAttribute('aria-disabled') === 'true';
        proxy.setAttribute('aria-disabled', String(proxy.disabled));
      };
      new doc.defaultView.MutationObserver(sync).observe(native, { attributes: true, attributeFilter: ['disabled', 'aria-disabled'] });
      sync();
    }
    let more = modal.querySelector('.ph-more');
    if (!more) {
      more = doc.createElement('button'); more.type = 'button'; more.className = 'ph-more';
      more.onclick = event => {
        event.preventDefault(); event.stopPropagation();
        modal.classList.toggle('ph-options-open');
        more.setAttribute('aria-expanded', String(modal.classList.contains('ph-options-open')));
        enhanceEditor(doc, modal);
      };
      media.append(more);
    }
    if (!settings.id) settings.id = 'ph-extra-' + (++editorSequence);
    more.setAttribute('aria-controls', settings.id);
    const active = [...settings.querySelectorAll('input[type="checkbox"]:checked')].filter(input => !input.closest('.ng-hide')).length;
    const next = (modal.classList.contains('ph-options-open') ? 'Скрыть настройки' : 'Дополнительные настройки') + (active ? ' · включено: ' + active : '');
    if (more.textContent !== next) more.textContent = next;
    more.setAttribute('aria-expanded', String(modal.classList.contains('ph-options-open')));
  }


  const identityRequests = new WeakMap();
  function installPostIdentity(doc) {
    const entry = doc.defaultView.performance.getEntriesByType('resource').filter(e => {
      try { return e.initiatorType === 'xmlhttprequest' && new URL(e.name).origin === location.origin && new URL(e.name).pathname === '/api/v1/data'; } catch { return false; }
    }).at(-1);
    if (!entry) return;
    const stamp = entry.name + ':' + entry.startTime;
    let state = identityRequests.get(doc);
    if (!state || state.stamp !== stamp) {
      state = { stamp, map: new Map() }; identityRequests.set(doc,state);
      const headers = { 'X-Organization-Context': new URL(doc.URL).searchParams.get('organizationContext') || '' };
      // One read-only request for each native list load; no per-post requests.
      fetch(entry.name, { credentials:'same-origin', headers }).then(response => {
        if (!response.ok) throw Error('List unavailable');
        return response.json();
      }).then(data => {
        if (identityRequests.get(doc) !== state || !Array.isArray(data.results?.posts)) return;
        for (const post of data.results.posts) {
          if (/^\d+$/.test(String(post.id)) && /^\d+$/.test(String(post.project))) state.map.set(String(post.id),String(post.project));
        }
        styleNews(doc); polishNativeList(doc);
      }).catch(() => {});
    }
    for (const row of doc.querySelectorAll('post[post="::post"]')) {
      const id = row.querySelector('.time[clipcopier]')?.getAttribute('clipcopier');
      const project = state.map.get(id);
      if (project && row.dataset.phProject !== project) row.dataset.phProject = project;
    }
  }
  const groupFooters = new WeakMap();
  function styleNews(doc) {
    if (!readSettings(doc).skin && readSettings(doc).skin === false) return;
    installPostIdentity(doc);

    for (const list of doc.querySelectorAll('.post-list')) {
      const rows = [...list.children].filter(e => e.tagName === 'POST');
      let previous = null, groups = [];
      for (const row of rows) {
        row.classList.remove('ph-news-head','ph-news-body','ph-news-tail','ph-news-shared');
        const key = row.dataset.phProject;
        if (key && previous?.key === key) previous.rows.push(row);
        else { previous = { key, rows: [row] }; groups.push(previous); }
      }
      for (const { key, rows: members } of groups) {
        if (!key) continue;
        const head = members[0], tail = members[members.length - 1];
        head.classList.add('ph-news-head'); tail.classList.add('ph-news-tail');
        const text = head.querySelector('[ng-bind-html="::post.project.formattedText"]')?.textContent;
        for (const row of members) {
          if (row !== head) {
            row.classList.add('ph-news-body');
            if (text && row.querySelector('[ng-bind-html="::post.project.formattedText"]')?.textContent === text) row.classList.add('ph-news-shared');
          }
          const info = row.querySelector('.info');
          if (info && !info.querySelector('.ph-publication-state')) {
            const badge = doc.createElement('span'); badge.className = 'ph-publication-state'; info.append(badge);
          }
          const section = row.querySelector('.post-list-item');
          const label = section?.classList.contains('post-list-item-published') ? 'Опубликован' : section?.classList.contains('post-list-item-scheduled') ? 'Запланирован' : 'Проверьте статус';
          const badge = info?.querySelector('.ph-publication-state');
          if (badge && badge.textContent !== label) badge.textContent = label;
        }
        const source = members.map(row => row.querySelector('.ph-copy')).find(Boolean);
        for (const row of members) {
          const old = groupFooters.get(row);
          if (old && (row !== tail || !source)) { old.remove(); groupFooters.delete(row); }
        }
        if (!source) continue;
        let footer = groupFooters.get(tail);
        if (!footer) {
          footer = doc.createElement('div'); footer.className = 'ph-news-footer';
          const copy = doc.createElement('button'); copy.type = 'button'; copy.className = 'ph-news-copy';
          const status = doc.createElement('span'); status.className = 'ph-status'; status.setAttribute('role','status');
          footer.append(copy,status); tail.append(footer); groupFooters.set(tail,footer);
        }
        const copy = footer.querySelector('button'), status = footer.querySelector('.ph-status');
        copy.onclick = event => { event.preventDefault(); event.stopPropagation(); source.click(); sync(); };
        const sync = () => {
          const label = source.textContent.trim();
          if (copy.textContent.trim() !== label) actionLabel(copy,label);
          copy.disabled = source.disabled;
          const message = source.parentElement.querySelector('.ph-status')?.textContent || '';
          if (status.textContent !== message) status.textContent = message;
        };
        sync();
      }
    }
  }
  const composerAnchors = new WeakMap();
  function styleComposer(doc, modal) {
    const enabled = readSettings(doc).skin !== false;
    const field = modal.querySelector('emoji-input[ng-model="project.text"]');
    const group = field?.closest('.form-group'), line = modal.querySelector('.ph-paste-row');
    const native = modal.querySelector('.modal-footer button[ng-click="ok()"]');
    if (!group || !line || !native || !modal.classList.contains('ph-new-post')) return;
    group.classList.toggle('ph-text-area',enabled);
    const media = modal.querySelector('.ph-media-tools'), paste = modal.querySelector('.ph-paste');
    if (enabled && media && paste) {
      if (paste.parentElement !== media) media.prepend(paste);
      line.classList.add('ph-paste-feedback');
      if (media.nextElementSibling !== line) media.after(line);
      const editor = field.querySelector('.emoji-wysiwyg-editor');
      if (editor && editor.getAttribute('placeholder') !== 'Текст поста') editor.setAttribute('placeholder', 'Текст поста');
    } else if (!enabled) {
      if (paste && paste.parentElement !== line) line.prepend(paste);
      line.classList.remove('ph-paste-feedback');
      if (line.parentElement === group || line.nextElementSibling !== group) group.before(line);
    }
    if (!native.dataset.phOriginalLabel) native.dataset.phOriginalLabel = native.textContent;
    const label = enabled ? 'Опубликовать пост' : native.dataset.phOriginalLabel;
    if (native.textContent !== label) native.textContent = label;
    const more = modal.querySelector('.ph-more'), settings = modal.querySelector('.ph-extra-options'), picker = modal.querySelector('.ph-page-picker');
    if (more && settings && picker && picker.parentElement === settings.parentElement && enabled) {
      if (!composerAnchors.has(settings)) { const marker=doc.createComment('post-helper-options');settings.before(marker);composerAnchors.set(settings,marker); }
      if (picker.nextElementSibling !== more) picker.after(more);
      let secondary = modal.querySelector('.ph-secondary-media');
      if (!secondary) { secondary = doc.createElement('div'); secondary.className = 'ph-secondary-media'; }
      for (const control of [...media.children]) {
        if (control.tagName === 'BUTTON' && !control.matches('.ph-main-media,.ph-paste,.ph-more')) secondary.append(control);
      }
      if (more.nextElementSibling !== secondary) more.after(secondary);
      if (secondary.nextElementSibling !== settings) secondary.after(settings);
    } else if (!enabled && settings && composerAnchors.has(settings)) {
      composerAnchors.get(settings).after(settings);
      const secondary = modal.querySelector('.ph-secondary-media');
      if (secondary && media) { for (const control of [...secondary.children]) media.append(control); secondary.remove(); }
      if (more) modal.querySelector('.ph-media-tools')?.append(more);
    }

  }
  function polishNativeList(doc) {
    if (readSettings(doc).skin === false) {
      for (const row of doc.querySelectorAll('post')) {
        row.querySelector('.ph-news-text')?.remove();
        const time=row.querySelector('.info>.time'),section=row.querySelector('.post-list-item');if(time&&section)section.prepend(time);
        const tools=row.querySelector('.ph-row-tools'),info=row.querySelector('.info');
        if(tools&&info){
          const favorite=tools.querySelector('favorite-list');if(favorite)row.querySelector('.post-content-place')?.append(favorite);
          for(const button of tools.querySelectorAll('button'))info.append(button);
          tools.remove();
        }
      }
      return;
    }
    for (const blank of doc.querySelectorAll('.viewport__content-section>.main-layout')) blank.classList.toggle('ph-empty-header',!blank.firstElementChild);
    for (const li of doc.querySelectorAll('.postlist-tabs>li:not(.refresh-holder)')) {
      const text=li.classList.contains('all')?'Все':li.classList.contains('scheduled')?'План':li.classList.contains('published')?'Опубликовано':li.classList.contains('error')?'Ошибки':'Удалено';
      let label=li.querySelector('.ph-tab-label');
      if(!label){label=doc.createElement('span');label.className='ph-tab-label';li.append(label);}
      if(label.textContent!==text)label.textContent=text;
    }
    for(const row of doc.querySelectorAll('post.ph-news-head,post.ph-news-body')){
      const info=row.querySelector('.info');if(!info)continue;
      const time=row.querySelector('.time');if(time&&time.parentElement!==info)info.append(time);
      const badge=info.querySelector('.ph-publication-state'),right=info.querySelector('.c-soc-page__right');if(badge&&right&&badge.parentElement!==right)right.append(badge);
      row.classList.toggle('ph-no-media',!row.querySelector('.publication-img'));
      const edit=info.querySelector('.post-edit-button-mobile');
      if(edit&&!edit.classList.contains('ph-native-edit')){
        const svg=doc.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
        const path=doc.createElementNS(svg.namespaceURI,'path');path.setAttribute('d','m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-4-4L5 15Z');svg.append(path);edit.append(svg);edit.classList.add('ph-native-edit');edit.setAttribute('aria-label','Редактировать публикацию');
      }
      let tools=info.querySelector('.ph-row-tools');
      if(!tools){
        tools=doc.createElement('details');tools.className='ph-row-tools';
        const summary=doc.createElement('summary');summary.setAttribute('aria-label','Другие действия с публикацией');summary.textContent='•••';
        tools.append(summary);info.append(tools);
      }
      for(const button of [...info.children].filter(e=>e.tagName==='BUTTON'&&!e.classList.contains('post-edit-button-mobile')))tools.append(button);
      const favorite=row.querySelector('favorite-list');if(favorite&&!tools.contains(favorite))tools.append(favorite);
      if(!row.classList.contains('ph-news-head'))continue;
      const native=row.querySelector('[ng-bind-html="::post.project.formattedText"]'),host=row.querySelector('.text');if(!native||!host)continue;
      let preview=host.querySelector('.ph-news-text');
      if(!preview){
        preview=doc.createElement('div');preview.className='ph-news-text';
        const title=doc.createElement('button');title.type='button';title.className='ph-news-title';title.onclick=()=>native.click();
        const body=doc.createElement('p');body.className='ph-news-summary';preview.append(title,body);host.prepend(preview);
      }
      const full=native.textContent.trim();
      if(preview.firstElementChild.textContent!==full)preview.firstElementChild.textContent=full;
      preview.querySelector('.ph-news-summary')?.remove();
    }
  }

  function styleHeader(doc) {
    for (const bar of doc.querySelectorAll('.ph-compose-bar')) {
      if (!bar.querySelector('.ph-inline-settings')) {
        const settings = doc.createElement('button'); settings.type = 'button'; settings.className = 'ph-inline-settings'; settings.textContent = 'Плагин';
        settings.onclick = event => { event.preventDefault(); event.stopPropagation(); utility.click(); };
        bar.append(settings);
      }
      if (!bar.querySelector('.ph-list-filter')) {
        const filter=doc.createElement('button');filter.type='button';filter.className='ph-list-filter';filter.textContent='Фильтры';
        filter.onclick=()=>doc.documentElement.classList.toggle('ph-filter-open');bar.append(filter);
      }
      const holder=doc.querySelector('.post-filter-horizontal-holder');
      if(holder&&!holder.querySelector('.ph-filter-close')){
        const close=doc.createElement('button');close.type='button';close.className='ph-filter-close';close.textContent='Закрыть';close.onclick=()=>doc.documentElement.classList.remove('ph-filter-open');holder.prepend(close);
      }
      let title = bar.querySelector('.ph-list-title');
      if (!title) { title = doc.createElement('h2'); title.className = 'ph-list-title'; title.textContent = 'Публикации'; bar.prepend(title); }
      const story = bar.querySelector('.ph-story-label');
      if (story && story.textContent !== '+ Stories') story.textContent = '+ Stories';
    }
  }
  let originalViewport = null;
  function styleShell(frame, enabled) {
    const touch = matchMedia('(pointer:coarse)').matches;
    document.querySelector('#smmplanner-front [class^="_header_"]')?.classList.add('ph-clean-header');
    const nativeMenu=document.querySelector('.tabler-icon-menu-2')?.closest('button');const shellNav=nativeMenu?.parentElement?.parentElement?.parentElement?.parentElement;if(shellNav?.querySelector('a[href]'))shellNav.classList.add('ph-clean-nav');
    document.documentElement.classList.toggle('ph-shell-skin',enabled);
    document.documentElement.classList.toggle('ph-shell-touch',touch);
    const viewport = document.querySelector('meta[name="viewport"]');
    if (!enabled || !touch) {
      document.documentElement.classList.remove('ph-menu-open');
      if (viewport && originalViewport !== null && viewport.content !== originalViewport) viewport.content = originalViewport;
      return;
    }
    if (viewport) {
      if (originalViewport === null) originalViewport = viewport.content;
      const mobile = 'width=device-width, initial-scale=1, viewport-fit=cover';
      if (viewport.content !== mobile) viewport.content = mobile;
    }
    const menuButton = document.querySelector('.tabler-icon-menu-2')?.closest('button');
    const nav = menuButton?.parentElement?.parentElement?.parentElement?.parentElement;
    const header = [...document.querySelectorAll('#smmplanner-front > div > div')].find(e => String(e.className).startsWith('_header_'));
    // Only adjust the known outer application shell when all its anchors match.
    if (!nav || !header || !nav.querySelector('a[href]') || nav.contains(frame)) return;
    nav.classList.add('ph-shell-menu'); header.classList.add('ph-shell-header');
    [...header.querySelectorAll('div')].find(e => String(e.className).startsWith('_header__buttons_'))?.classList.add('ph-shell-tools');
    for (let node = frame.parentElement; node && node !== document.getElementById('smmplanner-front'); node = node.parentElement) node.classList.add('ph-frame-host');
    if (!header.querySelector('.ph-shell-burger')) {
      const burger = document.createElement('button'); burger.type = 'button'; burger.className = 'ph-shell-burger'; burger.setAttribute('aria-label','Открыть меню'); const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('width','24');icon.setAttribute('height','24');icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.6');icon.setAttribute('aria-hidden','true');const path=document.createElementNS(icon.namespaceURI,'path');path.setAttribute('d','M4 6h16M4 12h16M4 18h16');icon.append(path);burger.append(icon);
      burger.onclick = () => { const open = document.documentElement.classList.toggle('ph-menu-open'); burger.setAttribute('aria-expanded',String(open)); };
      header.prepend(burger);
      const shade = document.createElement('button'); shade.type = 'button'; shade.className = 'ph-menu-shade'; shade.setAttribute('aria-label','Закрыть меню');
      shade.onclick = () => { document.documentElement.classList.remove('ph-menu-open'); burger.setAttribute('aria-expanded','false'); };
      document.body.append(shade);
      nav.addEventListener('click', event => { if (event.target.closest('a[href]')) shade.click(); });
      document.addEventListener('keydown',event => { if(event.key === 'Escape') shade.click(); });
    }
  }

  const copyPlacement = new WeakMap();
  function copyTarget(doc, row) {
    if (readSettings(doc).skin !== false) return row;
    return matchMedia('(pointer:coarse)').matches ? row.querySelector('.center') : (row.querySelector('.info') || row.querySelector('.center'));
  }
  function updateCopyPlacement(doc) {
    const touch = matchMedia('(pointer:coarse)').matches;
    const key=String(touch)+String(readSettings(doc).skin!==false);
    if (copyPlacement.get(doc) === key) return;
    copyPlacement.set(doc, key);
    for (const row of doc.querySelectorAll('post')) {
      const actions = row.querySelector('.ph-actions'), target = copyTarget(doc,row);
      if (actions && target && actions.parentElement !== target) target.append(actions);
    }
  }
  function enhanceClose(modal) {
    const close = modal.querySelector('.modal-header__close-button[ng-click="closeWithConfirm()"]');
    if (!close) return;
    close.classList.add('ph-editor-close');
    close.setAttribute('role','button');close.setAttribute('aria-label','Закрыть форму поста');close.tabIndex=0;
    if (!close.dataset.phKeyboard) {
      close.dataset.phKeyboard='true';
      close.addEventListener('keydown',event=>{
        if(event.key==='Enter'||event.key===' '){event.preventDefault();close.click();}
      });
    }
  }

  function install(doc) {
    if (installed.has(doc)) return;
    installed.add(doc);
    const style = doc.createElement('style'); style.dataset.postHelper='desktop'; style.textContent = "/* Old editor: one frame stylesheet, native actions remain intact. */\n.ph-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;padding:12px 0}\n.ph-copy,.ph-paste{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:9px 14px;border:1px solid #d9dee4;border-radius:9px;background:#fff;color:#34414b;font:400 13px/1.4 system-ui,sans-serif;cursor:pointer;box-sizing:border-box}\n.ph-icon{width:18px;height:18px;flex:none}.ph-status,.ph-paste-status,.ph-note{font:400 12px/1.5 system-ui,sans-serif;color:#65727d}.ph-status:empty,.ph-paste-status:empty{display:none}.ph-copy:disabled,.ph-paste:disabled{opacity:.5;cursor:wait}.ph-copy:hover,.ph-paste:hover{background:#f3f5f7}.ph-copy:focus-visible,.ph-paste:focus-visible{outline:2px solid #7c8c9b;outline-offset:3px}.ph-undo-notice{display:flex;gap:8px;align-items:center}.ph-undo-notice button{font:inherit}\n.ph-paste-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}.ph-submit-proxy{display:none!important}\n.ph-skin{--ph-paper:#fff;--ph-canvas:#f2f4f6;--ph-ink:#27323c;--ph-muted:#65727d;--ph-line:#e0e4e8;--ph-yellow:#ffe39a;background:var(--ph-canvas);color:var(--ph-ink);font-family:system-ui,-apple-system,\"Segoe UI\",sans-serif}\n.ph-skin body{font:400 14px/1.5 system-ui,-apple-system,\"Segoe UI\",sans-serif;color:var(--ph-ink);background:var(--ph-canvas)}\n.ph-skin button,.ph-skin input,.ph-skin select,.ph-skin textarea{font-family:inherit}\n.ph-skin .viewport,.ph-skin .viewport__content-section{background:var(--ph-canvas);min-width:0!important}\n.ph-skin .l-post-list{width:100%!important;max-width:1120px!important;min-width:0!important;margin:0 auto!important;padding:0 24px 32px!important;box-sizing:border-box}\n.ph-skin .l-post-list>.main-layout,.ph-skin .post-list,.ph-skin .post-list-header{width:100%!important;max-width:none!important;min-width:0!important;margin-left:0!important;margin-right:0!important;padding-left:0!important;padding-right:0!important;box-sizing:border-box}\n.ph-skin .ph-empty-header{display:none!important}\n.ph-skin .ph-compose-bar{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;align-items:stretch;padding:24px 0 12px!important}\n.ph-skin .ph-list-title{grid-column:1/-1;margin:0 0 8px;font-size:24px;line-height:1.3;font-weight:500;letter-spacing:-.02em}\n.ph-skin .ph-compose-primary{grid-column:1/-1;min-height:48px!important;width:100%;margin:0!important;padding:12px!important;border:0!important;border-radius:12px!important;background:var(--ph-yellow)!important;color:var(--ph-ink)!important;font-size:15px!important;font-weight:500!important;box-shadow:none!important}\n.ph-skin .ph-compose-primary .button-label,.ph-skin .ph-compose-primary span{font:inherit!important}\n.ph-skin .ph-story-host{display:block;min-width:0}.ph-skin .ph-story-button,.ph-skin .ph-inline-settings,.ph-skin .ph-compose-bar>view-selector button{display:flex!important;align-items:center;justify-content:center;width:100%;min-height:36px;margin:0!important;padding:8px 12px!important;border:1px solid #cdd4db!important;border-radius:8px!important;background:transparent!important;color:#53616d!important;font:400 12px/1.4 system-ui,sans-serif!important;box-shadow:none!important}\n.ph-skin .ph-story-button,.ph-skin .ph-inline-settings,.ph-skin .ph-compose-bar>view-selector,.ph-skin .ph-compose-bar>view-selector .btn-group,.ph-skin .ph-compose-bar>view-selector button{height:36px!important;min-height:0!important}\n.ph-skin .ph-story-button>*:not(.ph-story-label){display:none!important}.ph-skin .ph-story-label{display:inline!important;font:inherit!important}\n.ph-skin .ph-compose-bar>view-selector{display:block!important;float:none!important;margin:0!important}\n.ph-skin .ph-list-title{grid-row:1}.ph-skin .ph-compose-primary{grid-row:2}.ph-skin .ph-story-host{grid-row:3;grid-column:1}.ph-skin .ph-compose-bar>view-selector{grid-row:3;grid-column:2}.ph-skin .ph-inline-settings{grid-row:3;grid-column:3}.ph-skin .ph-list-filter{grid-row:4;grid-column:3!important}.ph-skin .weekly-view-link{display:none!important}\n.ph-skin .ph-list-title{grid-column:1/3}.ph-skin .ph-list-filter{grid-row:1;align-self:center}\n.ph-skin .ph-compose-bar>view-selector .btn-group{display:block;width:100%}.ph-skin .c-view-selector__text-full,.ph-skin .c-view-selector__primary-icon{display:none!important}.ph-skin .c-view-selector__text-brief{display:inline!important}.ph-skin .ph-compose-primary::before,.ph-skin .ph-compose-primary::after,.ph-skin .ph-story-button::before,.ph-skin .ph-story-button::after{display:none!important;content:none!important}\n.ph-skin .ph-compose-bar>view-selector .dropdown-menu{min-width:160px}\n.ph-skin .ph-list-filter{grid-column:1/-1;justify-self:end;min-height:30px;margin:0;padding:4px 0;border:0;background:none;color:var(--ph-muted);font:400 12px/1.4 system-ui,sans-serif}\n.ph-skin .post-filter-horizontal-holder{display:none!important}\n.ph-skin.ph-filter-open .post-filter-horizontal-holder{display:block!important;position:fixed!important;inset:0 0 0 auto!important;width:360px!important;max-width:90vw;height:100vh;z-index:1060;overflow:auto;background:#fff;padding:52px 16px 16px!important;box-shadow:-12px 0 40px #202b3b25}\n.ph-skin.ph-filter-open .post-filter-holder{display:block!important}.ph-skin .ph-filter-close{position:absolute;top:8px;right:12px;padding:8px 12px;border:0;border-radius:7px;background:#f2f4f6;color:#53616d}\n.ph-skin .postlist-tabs{display:flex;align-items:center;gap:8px;margin:0 0 12px!important;padding:0!important;min-height:40px;border:0!important;background:none!important}\n.ph-skin .postlist-tabs>li{display:flex!important;align-items:center;justify-content:center;min-width:0!important;height:36px!important;margin:0!important;padding:8px 12px!important;border:0!important;border-radius:20px;background:none;color:var(--ph-muted);font-size:12px;line-height:20px;cursor:pointer}\n.ph-skin .postlist-tabs>li.active{background:#293640!important;color:#fff!important}.ph-skin .postlist-tabs>li:not(.refresh-holder)>*:not(.ph-tab-label){display:none!important}.ph-skin .ph-tab-label{display:inline!important}.ph-skin .postlist-tabs>.refresh-holder{margin-left:auto!important;padding:0!important}.ph-skin .refresh-holder .btn{min-height:36px;background:transparent;border:0;color:#65727d;box-shadow:none}\n.ph-skin .postlist-tabs>li::before,.ph-skin .postlist-tabs>li::after{display:none!important;content:none!important}.ph-skin .postlist-tabs>li.ng-hide{display:none!important}\n.ph-skin .post-list-header{border:0!important;background:none!important;color:var(--ph-muted);font-size:12px;padding-bottom:12px!important}\n.ph-skin .post-list>post:is(.ph-news-head,.ph-news-body){display:block!important;position:relative!important;float:none!important;width:100%!important;margin:0!important;padding:0 20px!important;border:0!important;background:#fff!important;box-sizing:border-box;outline:none!important}\n.ph-skin .post-list>post.ph-news-head{padding-top:18px!important;border-radius:14px 14px 0 0}\n.ph-skin .post-list>post.ph-news-tail{padding-bottom:14px!important;margin-bottom:16px!important;border-radius:0 0 14px 14px}\n.ph-skin .post-list>post.ph-news-head.ph-news-tail{border-radius:14px}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .post-list-item{display:block!important;position:static!important;min-height:0!important;padding:0!important;margin:0!important;border:0!important;outline:none!important;background:transparent!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .center{display:flex!important;flex-direction:column;width:100%!important;min-width:0!important;margin:0!important;padding:0!important;border:0!important;background:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .content{display:grid!important;grid-template-columns:90px minmax(0,1fr);align-items:start;gap:16px;order:0;float:none!important;position:static!important;width:100%!important;min-height:0!important;padding:0 0 12px!important;margin:0!important;border:0!important}\n.ph-skin post.ph-no-media .content{grid-template-columns:minmax(0,1fr)}\n.ph-skin post.ph-news-shared .content{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .text{width:auto!important;min-width:0;position:static!important;float:none!important;margin:0!important;padding:0!important;border:0!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .text>.btn,.ph-skin post:is(.ph-news-head,.ph-news-body) .post-content-place,.ph-skin post:is(.ph-news-head,.ph-news-body) .post-content>[ng-bind-html]{display:none!important}\n.ph-skin .ph-news-text{min-width:0}.ph-skin .ph-news-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden;max-width:100%;margin:0;padding:0;border:0;background:none;color:#34414b;font:400 14px/1.6 system-ui,sans-serif;text-align:left;white-space:pre-line;cursor:pointer}.ph-skin .ph-news-summary{display:none}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img{float:none!important;position:relative!important;left:auto!important;top:auto!important;width:90px!important;margin:0!important;padding:0!important;border:0!important;border-radius:8px;overflow:hidden;background-image:none!important;box-shadow:none!important}\n.ph-skin .publication-img.video-preview .afkl-lazy-wrapper::before,.ph-skin .publication-img.video-preview .afkl-lazy-wrapper::after{display:none!important;content:none!important}.ph-skin .c-soc-page__link{border:0!important}\n.ph-skin .publication-img>div[afkl-lazy-image]{width:90px!important;min-height:0!important}.ph-skin .publication-img img{display:block;width:90px!important;max-height:126px;height:auto;object-fit:contain;background:#f4f5f6}.ph-skin .publication-img.video-preview::before,.ph-skin .publication-img.video-preview::after{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info{display:grid!important;grid-template-columns:minmax(180px,260px) 90px 36px 28px;gap:12px;align-items:center;justify-content:start;order:1;width:100%!important;min-height:52px!important;float:none!important;position:static!important;margin:0!important;padding:6px 0!important;border:0!important;outline:none!important;box-sizing:border-box}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>soc-page{display:block!important;grid-column:1;grid-row:1;width:auto!important;min-width:0}.ph-skin .c-soc-page{display:flex;align-items:center;gap:10px}.ph-skin .c-soc-page__left{flex:none;position:relative;width:32px;height:32px;margin:0!important}.ph-skin .c-soc-page__lazy-holder,.ph-skin .c-soc-page__lazy-holder img{width:32px;height:32px;border-radius:5px}.ph-skin .c-soc-page__right{float:none!important;margin:0!important;min-width:0;padding:0!important}.ph-skin .c-soc-page__link{display:block!important;color:#34414b;font-size:13px;line-height:1.4;text-decoration:none}.ph-skin .c-soc-page__link::after{display:none!important}.ph-skin .ph-publication-state{display:block;margin-top:2px;color:#69776c;font-size:11px;line-height:1.4;font-weight:400}.ph-skin .info>.project{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.time{display:flex!important;flex-direction:column;align-items:flex-start;grid-column:2;grid-row:1;float:none!important;position:static!important;inset:auto!important;width:auto!important;margin:0!important;padding:0!important;border:0!important;color:#65727d;font:400 12px/1.5 system-ui,sans-serif;text-align:left!important}.ph-skin .info>.time span{font:inherit!important;white-space:nowrap}\n.ph-skin .info>.ph-native-edit{display:flex!important;align-items:center;justify-content:center;grid-column:3;grid-row:1;position:static!important;width:36px;height:36px;min-height:0;margin:0!important;padding:9px!important;border:0!important;background:none!important;color:#65727d;box-shadow:none!important}.ph-skin .ph-native-edit svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:1.6}.ph-skin .ph-native-edit::before,.ph-skin .ph-native-edit::after{display:none!important}\n.ph-skin .ph-row-tools{grid-column:4;grid-row:1;position:relative;min-width:0;margin:0;padding:0;color:#65727d}.ph-skin .ph-row-tools>summary{display:flex;align-items:center;justify-content:center;width:28px;height:36px;list-style:none;cursor:pointer;font-size:12px}.ph-skin .ph-row-tools>summary::-webkit-details-marker{display:none}.ph-skin .ph-row-tools:not([open])>:not(summary){display:none!important}.ph-skin .ph-row-tools[open]{z-index:5;background:#fff;border:1px solid #dfe3e8;border-radius:9px;padding:4px;box-shadow:0 6px 18px #24314018}.ph-skin .ph-row-tools .btn{display:block;position:static!important;margin:4px 0;background:#f1f3f5;color:#53616d;border:0}.ph-skin .ph-row-tools .ng-hide{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body)>.ph-actions{display:none!important}.ph-skin .ph-news-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px;flex-wrap:wrap;padding-top:10px;border:0!important}.ph-skin .ph-news-copy{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:9px 16px;border:1px solid #d9dee4;border-radius:9px;background:#f7f8fa;color:#34414b;font:400 13px/1.4 system-ui,sans-serif;cursor:pointer}.ph-skin .ph-news-copy:disabled{opacity:.5;cursor:wait}.ph-skin .ph-news-copy:hover{background:#eef1f4}.ph-skin .ph-news-footer .ph-status{width:100%;text-align:right}\n/* Composer: one field border, one tool row, native schedule controls. */\n.ph-skin .modal:has(.ph-new-post){display:flex!important;align-items:center;justify-content:center;padding:20px!important;overflow:auto!important}\n.ph-skin .ph-new-post{position:relative!important;inset:auto!important;transform:none!important;width:100%!important;max-width:680px!important;margin:0!important;box-sizing:border-box}\n.ph-skin .ph-new-post .modal-content{display:flex;flex-direction:column;max-height:calc(100dvh - 40px);padding:0;border:0!important;border-radius:16px!important;background:#fff!important;box-shadow:0 18px 64px #1f29372b;overflow:hidden}\n.ph-skin .ph-new-post .modal-header{position:relative;display:flex;align-items:center;justify-content:flex-end;flex:none;height:42px;min-height:42px;margin:0;padding:0 12px!important;border:0!important;background:#fff!important}.ph-skin .ph-new-post .modal-title{display:none!important}\n.ph-skin .ph-new-post .ph-editor-close{position:relative!important;display:flex!important;align-items:center;justify-content:center;width:36px;height:36px;margin:0!important;padding:8px!important;border:0!important;border-radius:8px!important;background:transparent!important;color:#697781!important;font-size:0;line-height:1!important;opacity:1;cursor:pointer}.ph-skin .ph-new-post .ph-editor-close:hover{background:#f2f4f6!important}.ph-skin .ph-new-post .ph-editor-close::before,.ph-skin .ph-new-post .ph-editor-close::after{content:\"\"!important;position:absolute;left:9px;top:17px;width:18px;height:1.5px;background:currentColor;transform:rotate(45deg)}.ph-skin .ph-new-post .ph-editor-close::after{transform:rotate(-45deg)}.ph-skin .ph-new-post .ph-editor-close>*{display:none}\n.ph-skin .ph-new-post .ph-editor-close::before,.ph-skin .ph-new-post .ph-editor-close::after{opacity:1!important;visibility:visible!important;display:block!important;background:#697781!important;border:0!important}\n.ph-skin .ph-new-post .ph-editor-close::before,.ph-skin .ph-new-post .ph-editor-close::after{position:absolute!important;left:9px!important;top:17px!important;width:18px!important;height:1.5px!important;clip:auto!important;clip-path:none!important}\n.ph-skin .ph-new-post .ph-editor-close{position:absolute!important;inset:3px 12px auto auto!important;transform:none!important;float:none!important;z-index:1}\n.ph-skin .ph-new-post .modal-body{flex:1 1 auto;overflow:auto!important;min-height:0;padding:2px 24px 20px!important;background:#fff!important;border:0!important}.ph-skin .ph-new-post .postproject-form__drag-notice{display:none!important}\n.ph-skin .ph-new-post .form-group{margin-bottom:12px}.ph-skin .ph-new-post .ph-text-area{margin:0 0 12px!important;padding:0!important;border:0!important;background:none!important;box-shadow:none!important}.ph-skin .ph-new-post emoji-input[ng-model=\"project.text\"]{display:block;position:relative;margin:0;padding:0;border:0;background:none}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor{box-sizing:border-box;min-height:176px;max-height:300px;overflow:auto!important;resize:vertical;margin:0!important;padding:14px 16px!important;border:1px solid #d5dce3!important;border-radius:12px!important;background:#fff!important;box-shadow:none!important;font:400 15px/1.6 system-ui,-apple-system,\"Segoe UI\",sans-serif!important;color:#303a44;white-space:pre-wrap;outline:none!important}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor:focus{border-color:#8c9aa7!important;box-shadow:0 0 0 2px #e8edf1!important}.ph-skin .ph-new-post .emoji-btn,.ph-skin .ph-new-post .text-length-control{display:none!important}\n.ph-skin .ph-new-post .ph-text-area typograph-input,.ph-skin .ph-new-post .ph-text-area hashtags-input,.ph-skin .ph-new-post .ph-text-area signs-input{display:none!important}\n.ph-skin .ph-new-post .ph-media-tools{display:grid!important;grid-template-columns:44px minmax(0,1fr) minmax(0,1fr);gap:8px;margin:0 0 12px!important;padding:0!important;border:0!important;align-items:stretch}.ph-skin .ph-new-post .ph-media-tools>.ph-main-media{display:flex;align-items:center;justify-content:center;gap:6px;min-height:44px;margin:0!important;padding:10px 12px!important;border:1px solid #d9dee4!important;border-radius:9px!important;background:#f7f8fa!important;color:#34414b!important;box-shadow:none!important;font:400 13px/1.4 system-ui,sans-serif!important;width:100%}\n.ph-skin .ph-new-post .ph-media-tools>.ph-paste{width:44px;height:44px;min-height:44px;padding:11px!important;border:1px solid #d9dee4!important;border-radius:9px;background:#f7f8fa!important;color:#34414b!important;position:relative}.ph-skin .ph-new-post .ph-media-tools>.ph-paste>span{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}.ph-skin .ph-new-post .ph-media-tools>.ph-paste .ph-icon{width:20px;height:20px}\n.ph-skin .ph-new-post .ph-media-tools[data-has-poll=false]{grid-template-columns:44px minmax(0,1fr)}\n.ph-skin .ph-new-post .ph-paste-feedback{display:flex;min-height:0;margin:0 0 12px;padding:0;border:0;background:none}.ph-skin .ph-new-post .ph-paste-feedback:has(.ph-paste-status:empty){display:none!important}\n.ph-skin .ph-new-post .ph-schedule-block{padding:0!important;margin:18px 0 12px!important;border:0!important;background:none!important;box-shadow:none!important}.ph-skin .ph-new-post .ph-schedule-block>.control-label,.ph-skin .ph-new-post .ph-schedule-block>.el-divider-light{display:none!important}\n.ph-skin .ph-new-post .ph-time-tools{display:flex;float:none!important;position:static!important;justify-content:flex-start;align-items:center;gap:8px;margin:0 0 10px!important;padding:0!important}.ph-skin .ph-new-post .ph-time-tools>.glyphicon,.ph-skin .ph-new-post .ph-time-tools>span:not([ng-click]){display:none!important}.ph-skin .ph-new-post .ph-time-tools>.dashed-link{display:inline-flex;align-items:center;min-height:36px;padding:7px 10px;border:1px solid #d9dee4;border-radius:8px;color:#586570;background:#fff;font:400 12px/1.4 system-ui,sans-serif;text-decoration:none}\n.ph-skin .ph-new-post .ph-schedule-table{display:block;width:100%!important;border:0!important;outline:none!important;background:none!important;border-collapse:separate}.ph-skin .ph-new-post .ph-schedule-table>tbody{display:grid;gap:8px}.ph-skin .ph-new-post .ph-schedule-row{display:grid;grid-template-columns:minmax(150px,1fr) auto 24px;gap:12px;align-items:center;padding:10px 12px!important;margin:0!important;border:0!important;border-radius:10px;background:#f6f7f9!important}\n.ph-skin .ph-new-post .ph-schedule-row>td{display:block;min-width:0;width:auto!important;padding:0!important;border:0!important;background:none!important;vertical-align:middle}.ph-skin .ph-new-post .ph-schedule-page{font-size:13px;color:#34414b}.ph-skin .ph-new-post .ph-schedule-time{white-space:nowrap;display:flex;gap:5px;align-items:center;font-size:12px;color:#71808d}\n.ph-skin .ph-new-post .ph-schedule-time input,.ph-skin .ph-new-post .ph-schedule-time select{height:36px;min-height:36px;padding:6px 8px;border:1px solid #d5dce3;border-radius:7px;box-shadow:none;background:white;color:#3f4c57;font-size:13px}.ph-skin .ph-new-post .ph-schedule-time input{width:108px!important}.ph-skin .ph-new-post .ph-schedule-time select{width:48px!important}.ph-skin .ph-new-post .ph-schedule-time .input-group{display:inline-flex;width:auto;border:1px solid #d5dce3;border-radius:7px;background:#fff}.ph-skin .ph-new-post .ph-schedule-time .input-group input{height:34px;min-height:34px;border:0!important}.ph-skin .ph-new-post .ph-schedule-time .input-group-btn{display:block;width:auto}.ph-skin .ph-new-post .ph-schedule-time .btn{height:34px;padding:7px 10px;border:0!important;border-radius:0 6px 6px 0;background:#eef1f4!important;color:#66737e!important;box-shadow:none}\n.ph-skin .ph-new-post .ph-schedule-time select{width:56px!important;min-width:56px!important;padding:6px!important;background-image:none!important;appearance:auto!important}\n.ph-skin .ph-new-post .ph-schedule-remove a{display:flex;align-items:center;justify-content:center;width:24px;height:32px;color:#7a8792;border:0}.ph-skin .ph-new-post .ph-page-picker{margin:12px 0!important;padding:0;border:0;background:none}.ph-skin .ph-new-post .ph-page-picker>.control-label{display:none!important}.ph-skin .ph-new-post .ph-page-picker .panel{margin:0;border:0;box-shadow:none;background:none}.ph-skin .ph-new-post .ph-page-picker .panel-heading{padding:10px 12px;border:1px dashed #cfd7df;border-radius:9px;background:transparent;color:#65727d;font-size:13px}.ph-skin .ph-new-post .ph-page-picker .panel-heading a{color:inherit;text-decoration:none}.ph-skin .ph-new-post .ph-page-picker .panel-body{border:0;background:#fff;padding:12px}\n.ph-skin .ph-new-post .ph-more{display:block;width:100%;min-height:36px;padding:7px 0;margin:4px 0 0;border:0!important;background:none!important;color:#65727d;font:400 12px/1.5 system-ui,sans-serif;text-align:left;cursor:pointer}.ph-skin .ph-new-post .ph-more::after{content:\"\";display:inline-block;width:6px;height:6px;margin-left:8px;border-bottom:1px solid currentColor;border-right:1px solid currentColor;transform:translateY(-2px) rotate(45deg)}.ph-skin .ph-new-post.ph-options-open .ph-more::after{transform:translateY(1px) rotate(225deg)}\n.ph-skin .ph-new-post:not(.ph-options-open) .ph-extra-options,.ph-skin .ph-new-post:not(.ph-options-open) .ph-secondary-media{display:none!important}.ph-skin .ph-new-post .ph-secondary-media{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 12px}.ph-skin .ph-new-post .ph-secondary-media .btn{min-height:36px;margin:0;padding:8px 12px;border:1px solid #d9dee4;border-radius:8px;background:#f6f7f9;color:#586570;font-size:12px;box-shadow:none}\n.ph-skin .ph-new-post .ph-extra-options{margin:0;padding:8px 0 0;color:#65727d;font-size:13px;line-height:1.6}.ph-skin .ph-new-post .ph-extra-options .checkbox{margin:8px 0}.ph-skin .ph-new-post .ph-extra-options label{display:block;line-height:1.6}\n.ph-skin .ph-new-post .ph-editor-footer{display:grid;grid-template-columns:minmax(120px,1fr) minmax(0,2fr);gap:10px;flex:none;margin:0;padding:14px 24px 18px!important;border-top:1px solid #edf0f3!important;background:#fff!important}.ph-skin .ph-new-post .ph-editor-footer::before,.ph-skin .ph-new-post .ph-editor-footer::after{display:none;content:none}.ph-skin .ph-new-post .ph-editor-footer>button{float:none!important;width:100%;min-height:44px;margin:0!important;padding:10px 14px;border:1px solid #d9dee4;border-radius:9px;background:#fff;color:#65727d;box-shadow:none;font:400 13px/1.5 system-ui,sans-serif}.ph-skin .ph-new-post .ph-editor-footer>button[ng-click=\"ok()\"]{order:1;background:var(--ph-yellow)!important;border-color:var(--ph-yellow)!important;color:#303a44}.ph-skin .ph-new-post .ph-editor-footer>button[ng-click=\"closeWithConfirm()\"]{order:0}.ph-skin .ph-new-post .ph-editor-footer>button:not([ng-click=\"ok()\"]):not([ng-click=\"closeWithConfirm()\"]){order:2;grid-column:1/-1}\n@media(max-width:760px){.ph-skin .l-post-list{padding-left:16px!important;padding-right:16px!important}.ph-skin .modal:has(.ph-new-post){padding:12px!important}.ph-skin .ph-new-post .modal-content{max-height:calc(100dvh - 24px)}.ph-skin .ph-new-post .modal-body{padding-left:16px!important;padding-right:16px!important}.ph-skin .ph-new-post .ph-schedule-row{grid-template-columns:minmax(0,1fr) 24px}.ph-skin .ph-new-post .ph-schedule-page{grid-column:1;grid-row:1}.ph-skin .ph-new-post .ph-schedule-time{grid-column:1/-1;grid-row:2}.ph-skin .ph-new-post .ph-schedule-remove{grid-column:2;grid-row:1}.ph-skin post:is(.ph-news-head,.ph-news-body) .info{grid-template-columns:minmax(0,1fr) 74px 32px 28px;gap:8px}.ph-skin .ph-new-post .ph-editor-footer{padding-left:16px!important;padding-right:16px!important}}\n@media(prefers-reduced-motion:reduce){.ph-skin *{scroll-behavior:auto!important}}\n"; doc.head.append(style);
    syncDensity(doc);
    function scan() {
      if(activeDoc===doc)document.documentElement.classList.toggle("ph-form-open",!!modalOf(doc));
      if (activeDoc === doc) utility.hidden = !!modalOf(doc)||(readSettings(doc).skin!==false&&!!doc.querySelector(".ph-inline-settings"));
      enhanceComposeBar(doc); styleHeader(doc);
      for (const row of doc.querySelectorAll('post')) {
        if (!row.querySelector('.post-list-item-published') || row.querySelector('.ph-copy')) continue;
        const host = copyTarget(doc,row); if (!host) continue;
        const b = doc.createElement('button'); b.type = 'button'; b.className = 'ph-copy'; actionLabel(b,'Копировать ссылки');
        const status = doc.createElement('span'); status.setAttribute('role','status'); status.className='ph-status';
        b.onclick = async e => {
          e.preventDefault(); e.stopPropagation();
          if (busy) { status.textContent = 'Дождитесь завершения предыдущего копирования.'; return; }
          busy = true; b.disabled = true; actionLabel(b,'Получаю ссылки…'); status.textContent = '';
          try { const copied = await copyDuringTap(collect(doc, row)); actionLabel(b,copied ? 'Скопировано' : 'Отчёт открыт'); }
          catch (error) { status.textContent = error.message; }
          finally { busy = false; b.disabled = false; setTimeout(() => { actionLabel(b,'Копировать ссылки'); }, 2500); }
        };
        const actions = doc.createElement('div'); actions.className = 'ph-actions'; actions.append(b,status); host.append(actions);
      }
      styleNews(doc);
      const m=newModal(doc);
      if(m){
        addPaste(doc,m); syncVideoTitle(doc,m); enhanceEditor(doc,m); enhanceSchedule(doc,m); enhanceClose(m); styleComposer(doc,m);
        if(configureRequested&&pagesOf(m).length){configureRequested=false;configure(doc,m);}
        else applyDefaults(doc,m);
      }
    }
    let queued=false;
    new MutationObserver(()=>{if(queued)return;queued=true;setTimeout(()=>{queued=false;scan()},120)}).observe(doc.body,{childList:true,subtree:true});
    scan();
  }
  const style=document.createElement('style');
  style.textContent='.ph-overlay{position:fixed;inset:0;z-index:2147483647;background:#0008;display:flex;align-items:center;justify-content:center;padding:12px}.ph-panel{background:#fff;color:#222;border-radius:8px;padding:16px;max-width:520px;width:100%;max-height:80vh;overflow:auto;font:16px/1.5 Arial,sans-serif;box-sizing:border-box}.ph-panel h3{font-size:20px}.ph-button{font:16px Arial,sans-serif;padding:12px;margin:4px;border:1px solid #9bb0c3;background:white;color:#254968;border-radius:4px;cursor:pointer}.ph-choice{display:block;padding:10px 0}.ph-choice input{margin-right:8px}.ph-text{width:100%;height:180px;font-size:16px;box-sizing:border-box}';

  style.textContent += '@media(pointer:coarse){.ph-panel{max-width:calc(520px * var(--ph-size,1));font-size:calc(16px * var(--ph-size,1));padding:calc(16px * var(--ph-size,1));max-height:85vh}.ph-panel h3{font-size:calc(20px * var(--ph-size,1))}.ph-button{min-height:calc(48px * var(--ph-size,1));font-size:calc(16px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1));margin:calc(4px * var(--ph-size,1))}.ph-choice{display:flex;align-items:center;gap:calc(10px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) 0}.ph-choice input{width:calc(22px * var(--ph-size,1));height:calc(22px * var(--ph-size,1));flex:none}.ph-text{font-size:calc(16px * var(--ph-size,1));height:calc(180px * var(--ph-size,1));max-height:40vh}.ph-overlay{padding:calc(12px * var(--ph-size,1))}}';

  style.textContent += ".ph-utility{position:fixed;right:16px;bottom:78px;z-index:2147483644;display:inline-flex;align-items:center;gap:8px;min-height:36px;padding:8px 12px;box-sizing:border-box;color:#31577d;background:#fff;border:1px solid #c6d3e0;border-radius:8px;font:500 12px/1.2 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer;touch-action:manipulation}.ph-utility[hidden]{display:none}.ph-utility:hover{background:#f5f8fb}.ph-utility:focus-visible{outline:2px solid #457dae;outline-offset:3px}.ph-utility-dot{width:6px;height:6px;flex:none;border-radius:50%;background:#9aa7b5}.ph-utility[data-enabled=true] .ph-utility-dot{background:#45846a}@media(pointer:coarse){.ph-utility{right:calc(12px * var(--ph-size,1));bottom:calc(76px * var(--ph-size,1));gap:calc(7px * var(--ph-size,1));min-height:calc(40px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1)) calc(12px * var(--ph-size,1));font-size:calc(12px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(8px * var(--ph-size,1))}.ph-utility-dot{width:calc(6px * var(--ph-size,1));height:calc(6px * var(--ph-size,1))}}";
  style.textContent += "\n.ph-settings{display:flex;flex-direction:column;max-width:560px;max-height:calc(100dvh - 32px);padding:0;overflow:hidden;background:#fff;border-radius:12px;box-shadow:0 18px 60px #12263c30;font:14px/1.45 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#24374a}\n.ph-settings-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border-bottom:1px solid #e2e8ef}\n.ph-settings-header h3{margin:0;font-size:20px;line-height:1.3;font-weight:600}\n.ph-settings-close{position:relative;flex:none;width:40px;height:40px;padding:0;border:0;background:transparent;color:#54687c;cursor:pointer;touch-action:manipulation}\n.ph-settings-close::before,.ph-settings-close::after{content:\"\";position:absolute;top:50%;left:50%;width:18px;height:1.5px;background:currentColor;transform:translate(-50%,-50%) rotate(45deg)}\n.ph-settings-close::after{transform:translate(-50%,-50%) rotate(-45deg)}\n.ph-settings-body{overflow:auto;overscroll-behavior:contain;padding:4px 24px 20px;min-height:0}\n.ph-settings section{padding:20px 0;border-bottom:1px solid #e2e8ef}\n.ph-settings h4{margin:0 0 8px;font-size:13px;line-height:1.4;font-weight:600;color:#50647a}\n.ph-setting-row{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:0;padding:12px 0;cursor:pointer}\n.ph-setting-copy{display:block;min-width:0}\n.ph-setting-name{display:block;font-size:14px;line-height:1.4;font-weight:500;overflow-wrap:anywhere}\n.ph-setting-help{display:block;margin-top:4px;font-size:12px;line-height:1.5;font-weight:400;color:#52667b;overflow-wrap:anywhere}\n.ph-setting-toggle{appearance:none;-webkit-appearance:none;position:relative;flex:0 0 40px;width:40px;height:24px;margin:0;border:1px solid #8799aa;border-radius:12px;background:#e5ebf1;cursor:pointer;touch-action:manipulation}\n.ph-setting-toggle::before{content:\"\";position:absolute;width:18px;height:18px;left:2px;top:2px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #24374a35}\n.ph-setting-toggle:checked{background:#31577d;border-color:#31577d}\n.ph-setting-toggle:checked::before{left:18px}\n.ph-setting-check{flex:none;appearance:auto;width:20px;height:20px;margin:0;accent-color:#31577d;cursor:pointer}\n.ph-setting-pages{padding:0 0 0 12px;margin:4px 0 0 0;border-left:1px solid #d7e0e9}\n.ph-setting-pages .ph-setting-row{padding:9px 0}\n.ph-setting-pages-disabled .ph-setting-row{cursor:default}\n.ph-setting-pages-disabled .ph-setting-copy{opacity:.65}\n.ph-settings-privacy{margin:16px 0 0;color:#52667b;font-size:12px;line-height:1.5}\n.ph-settings-error{margin:12px 0 0;color:#a42b35;font-size:13px}\n.ph-settings-error:empty{display:none}\n.ph-settings-footer{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:16px 24px;border-top:1px solid #e2e8ef;background:#fff}\n.ph-settings-footer .ph-button{width:100%;margin:0;min-height:44px;padding:10px 16px;border:1px solid #b9c9d9;border-radius:6px;background:#fff;color:#31577d;font:500 14px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer;touch-action:manipulation}\n.ph-settings-footer .ph-settings-save{background:#31577d;border-color:#31577d;color:#fff}\n.ph-settings-footer .ph-button:hover{background:#f0f4f8}\n.ph-settings-footer .ph-settings-save:hover{background:#274967}\n.ph-settings-close:hover{color:#24374a;background:#f0f4f8;border-radius:6px}\n.ph-settings :is(button,input):focus-visible{outline:2px solid #457dae;outline-offset:3px}\n@media(pointer:coarse){\n.ph-settings{max-width:calc(520px * var(--ph-size,1));max-height:calc(100dvh - 24px);font-size:calc(14px * var(--ph-size,1))}\n.ph-settings-header{padding:calc(16px * var(--ph-size,1)) calc(20px * var(--ph-size,1));gap:calc(12px * var(--ph-size,1))}\n.ph-settings-header h3{font-size:calc(20px * var(--ph-size,1))}\n.ph-settings-close{width:calc(40px * var(--ph-size,1));height:calc(40px * var(--ph-size,1))}\n.ph-settings-close::before,.ph-settings-close::after{width:calc(18px * var(--ph-size,1));height:calc(1.5px * var(--ph-size,1))}\n.ph-settings-body{padding:calc(4px * var(--ph-size,1)) calc(20px * var(--ph-size,1)) calc(16px * var(--ph-size,1))}\n.ph-settings section{padding:calc(16px * var(--ph-size,1)) 0}\n.ph-settings h4{font-size:calc(13px * var(--ph-size,1));margin-bottom:calc(8px * var(--ph-size,1))}\n.ph-setting-row{gap:calc(16px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) 0}\n.ph-setting-name{font-size:calc(15px * var(--ph-size,1))}\n.ph-setting-help,.ph-settings-privacy{font-size:calc(12px * var(--ph-size,1))}\n.ph-setting-toggle{flex-basis:calc(40px * var(--ph-size,1));width:calc(40px * var(--ph-size,1));height:calc(24px * var(--ph-size,1));border-radius:calc(12px * var(--ph-size,1))}\n.ph-setting-toggle::before{width:calc(18px * var(--ph-size,1));height:calc(18px * var(--ph-size,1));left:calc(2px * var(--ph-size,1));top:calc(2px * var(--ph-size,1))}\n.ph-setting-toggle:checked::before{left:calc(18px * var(--ph-size,1))}\n.ph-setting-check{width:calc(22px * var(--ph-size,1));height:calc(22px * var(--ph-size,1))}\n.ph-setting-pages{padding-left:calc(12px * var(--ph-size,1))}\n.ph-setting-pages .ph-setting-row{padding:calc(9px * var(--ph-size,1)) 0}\n.ph-settings-footer{gap:calc(10px * var(--ph-size,1));padding:calc(14px * var(--ph-size,1)) calc(20px * var(--ph-size,1))}\n.ph-settings-footer .ph-button{font-size:calc(14px * var(--ph-size,1));min-height:calc(44px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1)) calc(14px * var(--ph-size,1))}\n.ph-settings-error{font-size:calc(13px * var(--ph-size,1))}\n}\n";
  style.textContent += "\n.ph-skin{--ph-u:calc(1px * var(--ph-size,1));--ph-paper:#fff;--ph-canvas:#eef1f6;--ph-ink:#222a32;--ph-muted:#526575;--ph-line:#dbe3ec;--ph-yellow:#ffe49a;background:var(--ph-canvas);color:var(--ph-ink)}\n.ph-skin body,.ph-skin .viewport,.ph-skin .l-post-list{background:var(--ph-canvas)!important;color:var(--ph-ink)}\n.ph-skin .ph-list-title{display:block;font:600 calc(27 * var(--ph-u))/1.2 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;margin:0 0 calc(10 * var(--ph-u));letter-spacing:-.02em;grid-column:1/-1}\n.ph-list-title,.ph-inline-settings,.ph-news-footer{display:none}\n.ph-skin .ph-compose-bar,.ph-skin .ph-compose-inline{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr));grid-template-rows:auto auto auto;gap:calc(10 * var(--ph-u));padding-top:calc(20 * var(--ph-u));padding-bottom:calc(22 * var(--ph-u));align-items:stretch}\n.ph-skin .ph-compose-bar>.ph-compose-primary,.ph-skin .ph-compose-inline>.ph-compose-primary{grid-column:1/-1;grid-row:2;width:100%;min-height:calc(56 * var(--ph-u));height:auto;padding:calc(14 * var(--ph-u));font:500 calc(16 * var(--ph-u))/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;background:var(--ph-yellow)!important;border:0!important;color:var(--ph-ink)!important;border-radius:calc(15 * var(--ph-u))!important;box-shadow:none}\n.ph-skin .ph-compose-primary::before{content:\"+\";font:300 calc(24 * var(--ph-u))/1 sans-serif;margin-right:calc(8 * var(--ph-u))}\n.ph-skin .ph-compose-bar>.ph-story-host,.ph-skin .ph-compose-inline>.ph-story-host{grid-column:1;grid-row:3;height:auto;min-width:0}\n.ph-skin .ph-compose-bar>view-selector,.ph-skin .ph-compose-inline>view-selector{grid-column:2;grid-row:3;height:auto;min-width:0;width:100%}\n.ph-skin .ph-compose-bar>view-selector>.btn-group,.ph-skin .ph-compose-inline>view-selector>.btn-group{display:block;width:100%;height:100%}\n.ph-skin .ph-compose-bar .ph-story-button,.ph-skin .ph-compose-inline .ph-story-button,.ph-skin .ph-compose-bar .c-view-selector__button,.ph-skin .ph-compose-inline .c-view-selector__button,.ph-skin .ph-inline-settings{display:flex!important;align-items:center;justify-content:center;width:100%;min-height:calc(44 * var(--ph-u));height:100%;min-width:0;padding:calc(8 * var(--ph-u)) calc(5 * var(--ph-u));margin:0!important;border:1px solid currentColor!important;border-radius:calc(10 * var(--ph-u))!important;background:transparent!important;color:var(--ph-muted)!important;font:400 calc(13 * var(--ph-u))/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;box-shadow:none;cursor:pointer}\n.ph-skin .ph-inline-settings{grid-column:3;grid-row:3}\n.ph-skin .ph-compose-bar .c-view-selector__text-full,.ph-skin .ph-compose-inline .c-view-selector__text-full{display:none!important}\n.ph-skin .ph-compose-bar .c-view-selector__text-brief,.ph-skin .ph-compose-inline .c-view-selector__text-brief{display:inline!important}\n.ph-skin .ph-compose-bar .c-view-selector__primary-icon,.ph-skin .ph-compose-inline .c-view-selector__primary-icon,.ph-skin .weekly-view-link{display:none!important}\n.ph-skin .ph-compose-bar .dropdown-menu{right:0;left:auto;min-width:260px}\n.ph-skin .post-list>post.ph-news-head,.ph-skin .post-list>post.ph-news-body{display:block;background:#fff;padding:0 calc(18 * var(--ph-u));margin:0;border:0}\n.ph-skin .post-list>post.ph-news-head{margin-top:calc(18 * var(--ph-u));padding-top:calc(18 * var(--ph-u));border-radius:calc(17 * var(--ph-u)) calc(17 * var(--ph-u)) 0 0}\n.ph-skin .post-list>post.ph-news-tail{border-radius:0 0 calc(17 * var(--ph-u)) calc(17 * var(--ph-u));padding-bottom:calc(6 * var(--ph-u));margin-bottom:calc(18 * var(--ph-u))}\n.ph-skin .post-list>post.ph-news-head.ph-news-tail{border-radius:calc(17 * var(--ph-u))}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .post-list-item{display:grid!important;grid-template-columns:minmax(0,1fr) auto;gap:0 calc(8 * var(--ph-u));padding:0!important;margin:0;min-height:0;background:transparent!important;border:0;color:var(--ph-ink)}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .center{display:contents!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .content{grid-column:1/-1;grid-row:1;display:flex!important;gap:calc(14 * var(--ph-u));padding:0 0 calc(16 * var(--ph-u));margin:0;min-height:0;float:none;width:auto}\n.ph-skin post.ph-news-shared .content{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img{flex:none;float:none;width:calc(90 * var(--ph-u))!important;max-width:35%;margin:0!important;align-self:flex-start;overflow:hidden;border-radius:calc(9 * var(--ph-u));cursor:pointer}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img>div[afkl-lazy-image]{width:100%!important;min-height:0!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img img{width:100%;max-height:calc(160 * var(--ph-u));object-fit:contain}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .text{flex:1;min-width:0;width:auto;float:none;margin:0;padding:0;color:var(--ph-ink);font:400 calc(14 * var(--ph-u))/1.6 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .text>.btn{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .post-content{padding:0;margin:0}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info{grid-column:1;grid-row:2;float:none;width:auto;min-width:0;margin:0;padding:calc(12 * var(--ph-u)) calc(42 * var(--ph-u)) calc(12 * var(--ph-u)) 0;border-top:1px solid var(--ph-line);position:relative}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .time{grid-column:2;grid-row:2;float:none;width:auto;position:static;display:flex;flex-direction:column;justify-content:center;align-items:flex-end;padding:calc(10 * var(--ph-u)) 0;border-top:1px solid var(--ph-line);font:400 calc(12 * var(--ph-u))/1.5 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:var(--ph-muted)}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .date-time{font-weight:400}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .date-day-month{font-size:calc(11 * var(--ph-u))}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page__right{font:500 calc(13 * var(--ph-u))/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page__left{width:calc(30 * var(--ph-u));height:calc(30 * var(--ph-u))}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page__left img{width:100%;height:auto;border-radius:calc(7 * var(--ph-u))}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .project{font-size:calc(11 * var(--ph-u));margin-top:calc(4 * var(--ph-u));color:var(--ph-muted)}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.post-edit-button-mobile{display:block!important;position:absolute;right:0;top:calc(10 * var(--ph-u));width:calc(36 * var(--ph-u));height:calc(36 * var(--ph-u));min-height:0;margin:0;border:0;background:transparent!important;color:#526575;border-radius:6px}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.post-edit-button-mobile::before{font-size:calc(17 * var(--ph-u))}\n.ph-skin .ph-publication-state{display:block;color:#41715b;font:400 calc(11 * var(--ph-u))/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;margin-top:calc(3 * var(--ph-u))}\n.ph-skin post:is(.ph-news-head,.ph-news-body)>.ph-actions,.ph-skin post:is(.ph-news-head,.ph-news-body) .ph-actions{display:none!important}\n.ph-skin .ph-news-footer{display:block;padding:calc(5 * var(--ph-u)) 0 calc(12 * var(--ph-u))}\n.ph-skin .ph-news-copy{display:flex;align-items:center;justify-content:center;gap:calc(8 * var(--ph-u));width:100%;min-height:calc(47 * var(--ph-u));padding:calc(10 * var(--ph-u));border:1px solid #cbd7e3;border-radius:calc(10 * var(--ph-u));background:#f7f9fc;color:#334f69;font:500 calc(14 * var(--ph-u))/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer;touch-action:manipulation}\n.ph-skin .ph-news-copy:disabled{opacity:.6;cursor:wait}\n.ph-skin .ph-new-post{max-width:660px;width:calc(100% - 24px);margin:12px auto}\n.ph-skin .ph-new-post .modal-content{background:#f4f6f9;border:0;border-radius:18px;box-shadow:0 18px 60px #14263b30;overflow:hidden}\n.ph-skin .ph-new-post .postproject-form{display:flex;flex-direction:column;max-height:calc(100vh - 28px)}\n.ph-skin .ph-new-post .modal-header{padding:16px 24px;background:#fff;border-bottom:1px solid var(--ph-line)}\n.ph-skin .ph-new-post .modal-title{font-size:0}\n.ph-skin .ph-new-post .modal-title::after{content:\"Новый пост\";font:600 calc(22 * var(--ph-u))/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.ph-skin .ph-new-post .modal-body{overflow:auto;overscroll-behavior:contain;min-height:0;flex:1;padding:20px 24px}\n.ph-skin .ph-new-post .postproject-form__drag-notice{display:none}\n.ph-skin .ph-new-post .ph-text-area{background:#fff;border:1px solid #c8d2de;border-radius:14px;overflow:hidden;padding:0;margin-bottom:18px}\n.ph-skin .ph-new-post .ph-text-area emoji-input{display:block;position:relative}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor{background:transparent;border:0;border-radius:0;box-shadow:none;padding:8px 15px 18px;font:400 14px/1.65 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;min-height:160px}\n.ph-skin .ph-new-post .ph-paste-row{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:0;margin:0;padding:2px 12px 0;min-height:44px}\n.ph-skin .ph-new-post .ph-paste-row>.ph-paste{width:auto;min-height:44px;padding:8px 0;margin:0;border:0;background:transparent;border-radius:0;font:400 12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#526575}\n.ph-skin .ph-new-post .ph-submit-proxy{display:none!important}\n.ph-skin .ph-new-post .ph-paste-status{flex-basis:100%;padding:0 0 8px}\n.ph-skin .ph-new-post .ph-paste-status:empty{display:none}\n.ph-skin .ph-new-post .ph-main-media{background:#fff!important;color:#334f69;border-color:#cdd8e4!important;border-radius:10px;font-weight:500}\n.ph-skin .ph-new-post .ph-more{color:#526575}\n.ph-skin .ph-new-post .ph-schedule-block{background:#fff;border-radius:12px;padding:0 10px}\n.ph-skin .ph-new-post .ph-schedule-row{background:#fff!important;border-bottom:1px solid #e2e7ee}\n.ph-skin .ph-new-post .ph-schedule-row input,.ph-skin .ph-new-post .ph-schedule-row select{box-shadow:none;border:1px solid #d5dfea;border-radius:7px}\n.ph-skin .ph-new-post .ph-editor-footer{flex:none;grid-template-columns:1fr 2fr;background:#fff;border-top:1px solid var(--ph-line);padding:14px 24px;gap:12px}\n.ph-skin .ph-new-post .ph-editor-footer>button{border-radius:10px;font-weight:500;min-height:48px}\n.ph-skin .ph-new-post .ph-editor-footer>button[ng-click=\"ok()\"]{grid-column:2;grid-row:1;background:var(--ph-yellow)!important;border-color:transparent!important;color:#222a32!important}\n.ph-skin .ph-new-post .ph-editor-footer>button[ng-click=\"closeWithConfirm()\"]{grid-column:1;grid-row:1;background:#fff;border:1px solid #d3dde8;color:#526575}\n.ph-shell-burger,.ph-menu-shade{display:none}\n@media(pointer:coarse){\n.ph-skin .viewport,.ph-skin .viewport.navbar-tablet,.ph-skin .viewport.navbar-minimize{margin-left:0!important;padding-left:0!important;width:100%!important}\n\n.ph-skin .l-post-list .main-layout,.ph-skin .post-list{max-width:none!important;margin-left:0!important;margin-right:0!important;padding-left:calc(16 * var(--ph-u));padding-right:calc(16 * var(--ph-u))}\n.ph-skin .ph-new-post{width:100%;max-width:none;margin:0}\n.ph-skin .ph-new-post .modal-content{border-radius:0}\n.ph-skin .ph-new-post .postproject-form{max-height:100vh}\n.ph-skin .ph-new-post .modal-header{padding:calc(12 * var(--ph-u)) calc(16 * var(--ph-u))}\n.ph-skin .ph-new-post .modal-body{padding:calc(18 * var(--ph-u)) calc(16 * var(--ph-u))}\n.ph-skin .ph-new-post .ph-paste-row{padding:0 calc(13 * var(--ph-u));min-height:calc(44 * var(--ph-u))}\n.ph-skin .ph-new-post .ph-paste-row>.ph-paste{font-size:calc(13 * var(--ph-u));min-height:calc(44 * var(--ph-u));padding:calc(8 * var(--ph-u)) 0}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor{font-size:calc(16 * var(--ph-u));line-height:1.55;min-height:calc(160 * var(--ph-u));padding:calc(8 * var(--ph-u)) calc(13 * var(--ph-u)) calc(16 * var(--ph-u))}\n.ph-skin .ph-new-post .ph-text-area{border-radius:calc(14 * var(--ph-u));margin-bottom:calc(18 * var(--ph-u))}\n.ph-skin .ph-new-post .ph-editor-footer{padding:calc(12 * var(--ph-u)) calc(16 * var(--ph-u));gap:calc(10 * var(--ph-u))}\n.ph-skin .ph-new-post .ph-editor-footer>button{min-height:calc(48 * var(--ph-u));font-size:calc(14 * var(--ph-u));padding:calc(10 * var(--ph-u));border-radius:calc(10 * var(--ph-u))}\n.ph-shell-skin.ph-shell-touch .ph-frame-host{padding-left:0!important;padding-right:0!important;margin-left:0!important;margin-right:0!important;max-width:none!important;width:100%!important}\n.ph-shell-skin.ph-shell-touch .ph-shell-menu{display:none!important}\n.ph-shell-skin.ph-shell-touch.ph-menu-open .ph-shell-menu{display:block!important;position:fixed!important;top:0;left:0;bottom:0;z-index:2147483646;background:#fff;min-width:60px;max-width:80vw;box-shadow:8px 0 40px #15293c25}\n.ph-shell-skin.ph-shell-touch .ph-shell-header{left:0!important;width:100%!important;padding-left:calc(44px * var(--ph-size,1))!important}\n.ph-shell-skin.ph-shell-touch .ph-shell-burger{display:flex;align-items:center;justify-content:center;position:absolute;left:0;top:0;height:100%;width:calc(44px * var(--ph-size,1));border:0;background:#eef1f6;color:#40566d;font-size:calc(22px * var(--ph-size,1));cursor:pointer}\n.ph-shell-skin.ph-shell-touch.ph-menu-open .ph-menu-shade{display:block;position:fixed;inset:0;z-index:2147483645;background:#15293c66;border:0}\n}\n";
  style.textContent += "\n@media(pointer:coarse){\n.ph-skin,.ph-skin body{min-width:0!important;width:100%!important}\n.ph-skin .main-layout,.ph-skin .allow-width-870,.ph-skin .post-list-header,.ph-skin .l-post-list,.ph-skin .viewport__content-section{min-width:0!important;max-width:none!important;width:auto!important}\n.ph-shell-skin.ph-shell-touch #smmplanner-front,.ph-shell-skin.ph-shell-touch .ph-frame-host{min-width:0!important}\n.ph-shell-skin.ph-shell-touch iframe[title=\"Posts\"]{min-width:0!important;width:100%!important}\n.ph-shell-skin.ph-shell-touch .ph-shell-burger svg{width:calc(22px * var(--ph-size,1));height:calc(22px * var(--ph-size,1))}\n}\n";
  style.textContent += "@media(pointer:coarse){.ph-shell-skin.ph-shell-touch .ph-shell-header{box-sizing:border-box}.ph-shell-skin.ph-shell-touch .ph-shell-header>div{width:100%;min-width:0;box-sizing:border-box;padding-left:8px!important;padding-right:8px!important}.ph-shell-skin.ph-shell-touch .ph-shell-tools{display:none!important}.ph-shell-skin.ph-shell-touch .ph-shell-header p{max-width:70vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ph-skin .ph-compose-primary::before{display:inline-block!important}}";
  style.textContent += "\n.ph-tab-label{display:none}\n.ph-skin .ph-compose-bar>view-selector{display:block!important}\n.ph-skin .ph-empty-header{display:none}\n.ph-skin .viewport__content-section{padding-top:0!important}\n.ph-skin .ph-compose-bar{margin-top:0!important}\n.ph-skin .ph-compose-primary::before{background:none!important;position:static!important;width:auto!important;height:auto!important;display:inline-block!important;content:\"+\"!important;color:#334f69}\n.ph-skin .postlist-tabs{display:flex!important;align-items:center;gap:4px;list-style:none;overflow-x:auto;scrollbar-width:none;min-height:40px;height:auto;margin:0 0 14px;padding:0;border:0}\n.ph-skin .postlist-tabs>li:not(.ng-hide){display:flex!important;align-items:center;justify-content:center;float:none;flex:none;width:auto;min-width:0;min-height:37px;height:auto;margin:0;padding:8px 10px;border:0;border-radius:18px;background:transparent;color:#566575;position:static}\n.ph-skin .postlist-tabs>li>label,.ph-skin .postlist-tabs>li::before,.ph-skin .postlist-tabs>li::after{display:none!important}\n.ph-skin .postlist-tabs>li.active{background:#26323e!important;color:#fff!important}\n.ph-skin .ph-tab-label{display:inline;font:400 12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.ph-skin .postlist-tabs>.refresh-holder{margin-left:auto!important;padding:0!important}\n.ph-skin .postlist-tabs .btn-refresh-list{border:0;background:none;box-shadow:none;width:36px;height:36px;min-width:0;padding:8px;color:#526575}\n.ph-skin .postlist-tabs .btn-refresh-list .button-label{display:none!important}\n.ph-skin .post-list-header .space-divider{display:none}\n.ph-skin .post-list-header .c-sorting{font-size:12px;color:#526575;margin-bottom:16px}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .content{padding-top:0!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info{min-height:66px;padding-top:12px!important;padding-bottom:10px!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info .project{display:none}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page{display:flex;align-items:center;gap:9px}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page__left{float:none;flex:none}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .c-soc-page__right{margin:0!important;min-width:0}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .ph-publication-state{margin-left:39px}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.post-edit-button-mobile{left:auto!important;padding:8px!important;background:none!important;color:#526575}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.post-edit-button-mobile::before{color:#526575;background:none}\n.ph-skin .ph-row-tools{position:absolute;right:0;top:42px;z-index:3;font-size:12px}\n.ph-skin .ph-row-tools>summary{list-style:none;cursor:pointer;color:#526575;min-width:36px;min-height:24px;text-align:center}\n.ph-skin .ph-row-tools>summary::-webkit-details-marker{display:none}\n.ph-skin .ph-row-tools:not([open])>button,.ph-skin .ph-row-tools:not([open])>favorite-list{display:none!important}\n.ph-skin .ph-row-tools[open]{background:#fff;border:1px solid #dbe3ec;border-radius:8px;padding:4px;min-width:44px}\n.ph-skin .ph-row-tools>button{position:static!important;float:none!important;margin:4px 0!important;min-width:32px;min-height:32px}\n.ph-skin .ph-news-text+.post-content{display:none}\n.ph-skin .ph-news-title{display:block;width:100%;padding:0;margin:0 0 7px;text-align:left;white-space:normal;border:0;background:none;color:#222a32;font:600 18px/1.35 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer}\n.ph-skin .ph-news-summary{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:0;color:#526575;font:400 13px/1.6 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}\n.ph-skin .ph-new-post .ph-more{margin-top:18px}\n.ph-utility[hidden]{display:none!important}\n@media(pointer:coarse){\n.ph-skin .post-list-header{padding-top:0!important}\n.ph-skin .ph-compose-bar{padding-bottom:14px!important}\n.ph-skin .postlist-tabs{gap:2px}\n.ph-skin .postlist-tabs>li:not(.ng-hide){padding:8px 10px}\n.ph-skin .postlist-tabs>.refresh-holder{display:none!important}\n.ph-skin .ph-news-title{font-size:18px}\n.ph-skin .ph-news-summary{font-size:13px}\n.ph-skin .viewport{padding-top:0!important}\n}\n\n@media(pointer:coarse){.ph-shell-skin.ph-shell-touch .ph-shell-header [class*=\"_button__content_\"]{display:block!important;min-width:0}.ph-shell-skin.ph-shell-touch .ph-shell-header [class*=\"_button__title_\"]{display:block!important;font-size:13px!important;max-width:220px}.ph-shell-skin.ph-shell-touch .ph-shell-header [class*=\"_button__subtitle_\"]{display:none!important}}\n.ph-shell-skin.ph-form-open [id^=\"carrotquest\"]{display:none!important}\n";
  style.textContent += "\n/* Compact publication layout and neutral form controls. */\n.ph-skin{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important}\n.ph-skin body,.ph-skin button,.ph-skin input,.ph-skin select,.ph-skin textarea{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important}\n.ph-skin a,.ph-skin .btn,.ph-skin .dashed-link{color:#4d6275}\n.ph-skin .viewport,.ph-skin .viewport__content-section{margin-right:0!important;padding-right:0!important;max-width:none!important}\n.ph-skin .l-post-list>.main-layout{width:100%!important;max-width:960px!important;margin-left:auto!important;margin-right:auto!important;padding-left:24px!important;padding-right:24px!important;box-sizing:border-box}\n.ph-skin:not(.ph-filter-open) :is(.post-filter-horizontal-holder,.post-filter-holder,.post-filter-expand,.c-hide-filter-tablet-button,.post-filter-switcher){display:none!important}\n.ph-skin .post-filter-expand,.ph-skin .c-hide-filter-tablet-button{display:none!important}\n.ph-skin .ph-list-filter{display:flex;grid-row:4;grid-column:1/-1;justify-self:end;align-items:center;min-height:36px;padding:4px 0;border:0;background:none;color:#526575;font-size:12px}\n.ph-skin.ph-filter-open .post-filter-horizontal-holder{display:block!important;position:fixed!important;inset:0 0 0 auto!important;width:360px!important;max-width:calc(100% - 32px);height:100vh;max-height:100vh;overflow:auto;z-index:1060;margin:0!important;padding-top:44px;background:#fff;box-shadow:-12px 0 40px #14283c30}\n.ph-skin.ph-filter-open .post-filter-horizontal-holder .post-filter-holder{display:block!important}\n.ph-skin .ph-filter-close{display:block;position:absolute;top:6px;right:8px;min-height:36px;padding:6px 10px;border:0;background:#eef1f6;color:#526575;border-radius:7px}\n.ph-skin .ph-compose-bar>.ph-compose-primary{font-size:16px!important;line-height:1.4!important;font-weight:500!important;min-height:56px!important}\n.ph-skin .ph-compose-bar .button-label,.ph-skin .ph-compose-bar .button-label span{font:inherit!important}\n.ph-skin .ph-compose-bar{padding-top:22px!important;padding-bottom:12px!important}\n.ph-skin .post-list{padding:0!important}\n.ph-skin .post-list>post:is(.ph-news-head,.ph-news-body){padding-left:18px!important;padding-right:18px!important;border:0!important;outline:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .post-list-item{grid-template-columns:minmax(0,1fr)!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .content{display:grid!important;grid-template-columns:90px minmax(0,1fr);gap:16px;padding:0 0 16px!important;width:100%!important}\n.ph-skin post.ph-no-media .content{grid-template-columns:minmax(0,1fr)}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .text{min-width:0!important;width:auto!important;margin:0!important;padding:0!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img{width:90px!important;max-width:100%!important;left:auto!important;float:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .publication-img img{max-height:144px}\n.ph-skin .ph-news-title{display:-webkit-box!important;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-line;font:400 14px/1.65 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important;text-align:left;margin:0!important;letter-spacing:normal!important;color:#344350!important}\n.ph-skin .ph-news-summary{display:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info{display:grid!important;grid-template-columns:minmax(160px,260px) 70px 36px 28px;align-items:center;justify-content:start;gap:10px;grid-column:1!important;grid-row:2!important;width:100%!important;min-height:62px!important;padding:12px 0!important;border:0!important;border-top:1px solid #e2e7ed!important;outline:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .center{border:0!important;outline:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>soc-page{display:block!important;grid-column:1;grid-row:1;min-width:0}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.time{grid-column:2!important;grid-row:1!important;position:static!important;float:none!important;border:0!important;margin:0!important;padding:0!important;align-items:flex-start!important;font:400 12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.ph-native-edit{position:static!important;grid-column:3;grid-row:1;width:36px!important;height:40px!important;margin:0!important;padding:9px!important;border:0!important;color:#526575;background:none!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info>.ph-row-tools{position:relative!important;grid-column:4;grid-row:1;inset:auto!important;min-width:0;align-self:center}\n.ph-skin .ph-row-tools>summary{min-width:28px;min-height:40px;display:flex;align-items:center;justify-content:center;line-height:1}\n.ph-skin .ph-row-tools[open]{position:absolute!important;top:12px!important;right:0!important;min-width:44px;z-index:8}\n.ph-skin .c-soc-page__right .ph-publication-state{margin:3px 0 0!important;font-size:11px!important}\n.ph-skin .ph-publication-state{font-weight:400!important}\n.ph-skin .ph-new-post .modal-header{min-height:44px;justify-content:flex-end!important;padding:4px 14px!important;border:0!important;background:#f4f6f9!important}\n.ph-skin .ph-new-post .modal-title,.ph-skin .ph-new-post .modal-title::after{display:none!important}\n.ph-skin .ph-new-post .modal-body{padding:0 24px 20px!important}\n.ph-skin .ph-new-post .ph-text-area{border:1px solid #ccd6e1;border-radius:14px;margin-bottom:18px!important}\n.ph-skin .ph-new-post .ph-paste-row{justify-content:flex-start!important;padding:10px 12px 0!important;min-height:54px!important}\n.ph-skin .ph-new-post .ph-paste-row>.ph-paste{padding:9px 12px!important;min-height:42px!important;border:1px solid #ced8e3!important;border-radius:8px!important;background:#f5f7fa!important;color:#455e73!important;font-size:13px!important;font-weight:400!important}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor{min-height:150px;padding-top:12px!important;font-weight:400!important}\n.ph-skin .ph-new-post .ph-schedule-block{background:transparent!important;border:0!important;border-radius:0!important;padding:0!important;margin:18px 0 0!important;box-shadow:none!important}\n.ph-skin .ph-new-post .ph-schedule-block>.control-label,.ph-skin .ph-new-post .ph-schedule-block>.el-divider-light{display:none!important}\n.ph-skin .ph-new-post .ph-time-tools{float:none!important;position:static!important;display:flex!important;justify-content:flex-start!important;align-items:center!important;gap:8px;width:auto!important;margin:0 0 10px!important;padding:0!important}\n.ph-skin .ph-new-post .ph-time-tools>.glyphicon,.ph-skin .ph-new-post .ph-time-tools>span:not([ng-click]){display:none!important}\n.ph-skin .ph-new-post .ph-time-tools>.dashed-link{display:inline-flex!important;align-items:center;justify-content:center;min-height:40px!important;margin:0!important;padding:8px 10px!important;border:1px solid #ced8e3!important;border-radius:8px!important;background:#fff!important;color:#526575!important;font:400 12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important;text-decoration:none}\n.ph-skin .ph-new-post .ph-schedule-table{display:block!important;border:0!important;border-collapse:separate!important;background:transparent!important;outline:none!important}\n.ph-skin .ph-new-post .ph-schedule-table>tbody{display:grid!important;gap:8px}\n.ph-skin .ph-new-post .ph-schedule-row{display:grid!important;grid-template-columns:minmax(0,1fr) auto 24px;gap:12px;align-items:center;margin:0!important;padding:12px!important;border:0!important;border-radius:10px!important;background:white!important;box-shadow:none!important}\n.ph-skin .ph-new-post .ph-schedule-row>td{display:block!important;width:auto!important;min-width:0;padding:0!important;border:0!important;background:transparent!important}\n.ph-skin .ph-new-post .ph-schedule-time{white-space:nowrap!important}\n.ph-skin .ph-new-post .ph-schedule-row input,.ph-skin .ph-new-post .ph-schedule-row select{height:36px!important;min-height:36px!important;padding:6px 8px!important;border:1px solid #d4dee9!important;box-shadow:none!important;background:#fff!important;color:#455666!important;font-size:13px!important;border-radius:7px!important;vertical-align:middle}\n.ph-skin .ph-new-post .ph-schedule-row input{width:110px!important}\n.ph-skin .ph-new-post .ph-schedule-row select{width:48px!important}\n.ph-skin .ph-new-post .ph-schedule-time .btn,.ph-skin .ph-new-post .ph-schedule-time .input-group-addon{background:#edf1f6!important;color:#526575!important;border:1px solid #d4dee9!important;border-radius:7px!important;box-shadow:none!important;height:36px!important}\n.ph-skin .ph-new-post .ph-page-picker{margin-top:14px!important}\n.ph-skin .ph-new-post .ph-page-picker>.control-label{display:none!important}\n.ph-skin .ph-new-post .ph-page-picker .panel{background:transparent!important;border:0!important;box-shadow:none!important;margin-bottom:0}\n.ph-skin .ph-new-post .ph-page-picker .panel-heading{padding:12px!important;background:white!important;border:1px solid #d3dde7!important;border-radius:10px!important;color:#526575!important;font-size:13px}\n.ph-skin .ph-new-post .ph-page-picker .panel-heading a{color:#526575!important;text-decoration:none!important}\n.ph-skin .ph-new-post .ph-page-picker .panel-body{border:0!important;background:white!important;border-radius:10px}\n.ph-skin .ph-new-post .ph-main-media{font-weight:400!important}\n.ph-skin .ph-new-post .ph-editor-footer{padding:14px 24px!important}\n.ph-shell-skin,.ph-shell-skin body{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important}\n.ph-shell-skin .ph-clean-header{background:#eef1f6!important;border-bottom:1px solid #d9e1eb!important;box-shadow:none!important}\n.ph-shell-skin .ph-clean-header *{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif!important}\n.ph-shell-skin .ph-clean-header button{color:#526575!important;box-shadow:none!important}\n.ph-shell-skin .ph-clean-header button.MuiButton-outlined{border-color:#c2cfdc!important;background:transparent!important;border-radius:9px!important}\n.ph-shell-skin .ph-clean-header .MuiAvatar-root{background:#d8e0eb!important;color:#40566b!important}\n.ph-shell-skin .ph-clean-nav{background:#eef1f6!important;color:#526575!important;border-right:1px solid #d9e1eb}\n.ph-shell-skin .ph-clean-nav div,.ph-shell-skin .ph-clean-nav button,.ph-shell-skin .ph-clean-nav span{background-color:transparent!important;color:inherit!important}\n@media(pointer:coarse){\n.ph-skin .l-post-list>.main-layout{padding-left:16px!important;padding-right:16px!important}\n.ph-skin post:is(.ph-news-head,.ph-news-body) .info{grid-template-columns:minmax(0,1fr) 56px 30px 24px;gap:6px!important}\n.ph-skin .ph-new-post .modal-body{padding:0 16px 18px!important}\n.ph-skin .ph-new-post .ph-schedule-row{grid-template-columns:minmax(0,1fr) 24px;gap:10px!important}\n.ph-skin .ph-new-post .ph-schedule-page{grid-column:1;grid-row:1}\n.ph-skin .ph-new-post .ph-schedule-time{grid-column:1/-1;grid-row:2}\n.ph-skin .ph-new-post .ph-schedule-remove{grid-column:2;grid-row:1}\n.ph-skin .ph-new-post .ph-text-area .emoji-wysiwyg-editor{font-size:16px!important}\n.ph-skin .ph-new-post .ph-editor-footer{padding:12px 16px!important}\n}\n";
  style.textContent += ".ph-shell-skin .ph-clean-nav .tabler-icon-menu-2{stroke:#526575!important}";
  document.head.append(style);
  const utility = document.createElement('button'); utility.type = 'button'; utility.className = 'ph-utility';
  const dot = document.createElement('span'); dot.className = 'ph-utility-dot';dot.setAttribute('aria-hidden','true');
  const utilityLabel = document.createElement('span');utility.append(dot,utilityLabel);
  let activeDoc;
  utility.onclick = event => {
    event.preventDefault(); event.stopPropagation(); const doc = activeDoc; if(!doc)return;
    const m = newModal(doc);if(m){configure(doc,m);return;}
    if(modalOf(doc)){alert('Закройте окно редактирования перед настройкой автовыбора.');return;}
    const anchor = doc.querySelector('button[ng-click="newPostProject()"]');
    if(anchor){configureRequested=true;anchor.click();}
  };
  function refresh(){
    if(location.pathname.replace(/\/$/,'')!=='/home/posts'){document.documentElement.classList.remove('ph-shell-skin','ph-shell-touch','ph-form-open','ph-menu-open');utility.remove();return;}
    syncDensity();
    const frame=[...document.querySelectorAll('iframe')].find(f=>{try{return new URL(f.src,location.href).pathname==='/iframe/app/'}catch{return false}});
    try{
      const doc=frame?.contentDocument;
      if(!doc?.body){utility.remove();return;}
      activeDoc=doc;install(doc);syncDensity(doc);updateCopyPlacement(doc);
      const draft=newModal(doc);if(draft){syncVideoTitle(doc,draft);styleComposer(doc,draft);}
      styleNews(doc);polishNativeList(doc);styleHeader(doc);styleShell(frame,readSettings(doc).skin!==false);syncDensity();syncDensity(doc);
      document.documentElement.classList.toggle("ph-form-open",!!modalOf(doc));
      doc.documentElement.classList.toggle('ph-skin',readSettings(doc).skin!==false);
      if(!utility.isConnected)document.body.append(utility);
      const settings=readSettings(doc);
      const next=settings.pages.length?'Автовыбор · '+settings.pages.length:'Выбрать страницы';
      if(utilityLabel.textContent!==next)utilityLabel.textContent=next;
      utility.dataset.enabled=String(settings.enabled&&settings.pages.length>0);
      utility.title=autoSummary(doc);utility.setAttribute('aria-label',autoSummary(doc)+'. Открыть настройки');
      utility.hidden=!!modalOf(doc)||(readSettings(doc).skin!==false&&!!doc.querySelector(".ph-inline-settings"));
    }catch{utility.remove();}
  }
  refresh();setInterval(refresh,1200);
})();
