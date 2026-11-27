// ==UserScript==
// @name         SMMplanner Helper
// @namespace    https://smmplanner.com/
// @version      2.4.1
// @updateURL    https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-tampermonkey.user.js
// @downloadURL  https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-tampermonkey.user.js
// @description  Автовыбор страниц и копирование заголовка со всеми опубликованными ссылками.
// @match        https://smmplanner.com/home/*
// @noframes
// @run-at       document-idle
// @sandbox      DOM
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window !== top || window.__postHelperV2) return;
  window.__postHelperV2 = true;
  const version = '2.4.1';
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
    const pages = pagesOf(modal);
    if (!pages.length) return;
    const settings = readSettings(doc), { overlay, box } = panel('Автовыбор страниц');
    textLine(box, 'Один раз выберите нужные страницы ВК и ОК. Выбор сохранится только в этом браузере для текущей команды.');
    const enabledLabel = document.createElement('label'); enabledLabel.className = 'ph-choice';
    const enabledInput = document.createElement('input'); enabledInput.type = 'checkbox'; enabledInput.checked = settings.enabled;
    enabledLabel.append(enabledInput,document.createTextNode('Автоматически выбирать страницы в новом посте')); box.append(enabledLabel);
    const skinLabel = document.createElement('label'); skinLabel.className = 'ph-choice';
    const skinInput = document.createElement('input'); skinInput.type = 'checkbox'; skinInput.checked = settings.skin !== false;
    skinLabel.append(skinInput,document.createTextNode('Обновлённое оформление страницы')); box.append(skinLabel);
    const choices = [];
    for (const page of pages.filter(p => p.medium === 'vk' || p.medium === 'ok')) {
      const label = document.createElement('label'); label.className = 'ph-choice';
      const input = document.createElement('input'); input.type = 'checkbox';
      input.checked = settings.pages.some(p => p.key === page.key);
      const network = page.medium === 'vk' ? 'ВК' : 'ОК';
      label.append(input, document.createTextNode(network + ' · ' + page.name + (page.group ? ' · ' + page.group : '') + (page.total > 1 ? ' · вариант ' + (page.ordinal + 1) : '')));
      box.append(label); choices.push({ input, page });
    }
    const message = textLine(box, '');
    box.append(button('Сохранить и выбрать', () => {
      const selected = choices.filter(x => x.input.checked).map(x => ({ key: x.page.key, total: x.page.total }));
      if (!selected.length) { message.textContent = 'Выберите хотя бы одну страницу.'; return; }
      try { saveSettings(doc, { enabled: enabledInput.checked, skin: skinInput.checked, pages: selected }); } catch { message.textContent = 'Не удалось сохранить настройки браузера.'; return; }
      handled.delete(modal); overlay.remove(); applyDefaults(doc, modal);
    }), button('Отмена', () => overlay.remove()));
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
    if(kind === 'paste'){rect(6,5,12,16);rect(9,3,6,4,1);}else{rect(8,8,12,13);const path=doc.createElementNS(ns,'path');path.setAttribute('d','M16 5V4a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1');icon.append(path);}
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
  function addPaste(doc, modal) {
    const field = modal.querySelector('emoji-input[ng-model="project.text"],textarea[ng-model="project.text"]');
    if (!field || modal.querySelector('.ph-paste')) return;
    const line = doc.createElement('div'); line.className = 'ph-paste-row';
    const paste = doc.createElement('button'); paste.type = 'button'; paste.className = 'ph-paste'; actionLabel(paste,'Вставить текст','paste');
    paste.title = 'Добавить текст из буфера в конец поста';
    const status = doc.createElement('span'); status.className = 'ph-paste-status'; status.setAttribute('role', 'status');
    paste.onclick = async event => {
      event.preventDefault(); event.stopPropagation();
      paste.disabled = true; status.textContent = '';
      try {
        if (!navigator.clipboard?.readText) throw Error('Этот браузер не разрешает чтение буфера. Используйте вставку через поле текста.');
        const text = await navigator.clipboard.readText();
        if (!text) { status.textContent = 'В буфере нет текста.'; return; }
        if (!modal.isConnected) return;
        const editor = field.querySelector('.emoji-wysiwyg-editor');
        if (editor) {
          editor.focus();
          const range = doc.createRange(); range.selectNodeContents(editor); range.collapse(false);
          const selection = doc.defaultView.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          if (!doc.execCommand('insertText', false, text)) {
            range.insertNode(doc.createTextNode(text)); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
          }
          editor.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
          editor.dispatchEvent(new doc.defaultView.KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
          editor.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
        } else if (field.tagName === 'TEXTAREA') {
          field.value += text;
          field.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
          field.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
        } else throw Error('Не найден редактор текста.');
        actionLabel(paste,'Текст вставлен','paste');
        setTimeout(() => { actionLabel(paste,'Вставить текст','paste'); }, 2500);
      } catch (error) {
        status.textContent = error.name === 'NotAllowedError' ? 'Разрешите Safari вставку из буфера и нажмите ещё раз. Либо вставьте текст через поле поста.' : error.message;
      } finally { paste.disabled = false; }
    };
    line.append(paste, status); (field.closest('.form-group.emoji-group') || field).before(line);
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
      if (!bar.classList.contains('main-layout') && !bar.classList.contains('post-list-header')) continue;
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
    let more = media.querySelector('.ph-more');
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

  const copyPlacement = new WeakMap();
  function copyTarget(doc, row) {
    return matchMedia('(pointer:coarse)').matches ? row.querySelector('.center') : (row.querySelector('.info') || row.querySelector('.center'));
  }
  function updateCopyPlacement(doc) {
    const touch = matchMedia('(pointer:coarse)').matches;
    if (copyPlacement.get(doc) === touch) return;
    copyPlacement.set(doc, touch);
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
    const style = doc.createElement('style'); style.textContent = ".ph-actions{clear:both;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 2px}.ph-copy,.ph-paste{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 12px;font:500 13px/1.25 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d;background:#fff;border:1px solid #bdcddd;border-radius:6px;cursor:pointer;touch-action:manipulation;max-width:100%}.ph-copy:hover,.ph-paste:hover{background:#f4f7fb;border-color:#8faac4}.ph-copy:active,.ph-paste:active{background:#eaf0f7}.ph-copy:disabled,.ph-paste:disabled{opacity:.6;cursor:wait}.ph-copy:focus-visible,.ph-paste:focus-visible{outline:2px solid #457dae;outline-offset:3px}.ph-icon{width:16px;height:16px;flex:none}.ph-note,.ph-status,.ph-paste-status{display:block;font:12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d}.ph-status:empty,.ph-paste-status:empty{display:none}.ph-status:not(:empty){margin:4px 0;flex-basis:100%;text-align:right}.ph-paste-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0}.ph-paste{background:#f6f9fc}.ph-paste-status{flex-basis:100%}@media(pointer:coarse){.ph-copy,.ph-paste{min-height:calc(44px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1)) calc(12px * var(--ph-size,1));gap:calc(8px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1))}.ph-actions{padding-top:calc(10px * var(--ph-size,1));padding-bottom:calc(2px * var(--ph-size,1))}.ph-icon{width:calc(16px * var(--ph-size,1));height:calc(16px * var(--ph-size,1))}.ph-note,.ph-status,.ph-paste-status{font-size:calc(12px * var(--ph-size,1))}.ph-paste-row{margin:calc(8px * var(--ph-size,1)) 0}}"; style.textContent += "\n.ph-skin .post-list-item{border-bottom-color:#e1e7ef}.ph-skin .post-list-item-published{background-color:#f6f8fb}.ph-skin .c-soc-page__link{color:#315c85}.ph-skin .form-control{border-color:#cad5e1;border-radius:6px;box-shadow:none}.ph-skin .btn{border-radius:6px}.ph-skin .btn-primary{background-color:#31577d;border-color:#31577d}.ph-skin .btn:focus-visible,.ph-skin .form-control:focus-visible{outline:2px solid #537fa8;outline-offset:2px}.ph-skin .modal-content{border:1px solid #d7e0e9;border-radius:12px}.ph-skin .modal-header,.ph-skin .modal-footer{border-color:#e2e8ef}\n.ph-new-post{width:calc(100% - 32px);max-width:720px}.ph-new-post .modal-content{border-radius:12px}.ph-new-post .ph-paste-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:stretch;margin:10px 0 14px}.ph-new-post .ph-paste-row>.ph-paste,.ph-new-post .ph-submit-proxy{width:100%;min-width:0;max-width:100%;min-height:46px;margin:0;padding:12px;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;white-space:normal;text-align:center;border-radius:7px;box-sizing:border-box}.ph-new-post .ph-paste-status{grid-column:1/-1}.ph-new-post .ph-submit-proxy{background:#31577d;color:#fff;border:1px solid #31577d;cursor:pointer;touch-action:manipulation}.ph-new-post .ph-submit-proxy:hover{background:#274868}.ph-new-post .ph-submit-proxy:disabled{opacity:.5;cursor:not-allowed}.ph-new-post .ph-submit-proxy:focus-visible,.ph-new-post .ph-more:focus-visible{outline:2px solid #537fa8;outline-offset:3px}\n.ph-new-post .ph-media-tools{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.ph-new-post .ph-media-tools>.ph-main-media{order:0;width:100%;min-width:0;min-height:46px;padding:12px 8px;margin:0;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d;border:1px solid #bdcddd;background:#f6f9fc;white-space:normal;box-sizing:border-box}.ph-new-post .ph-media-tools[data-has-poll=false]>.ph-main-media{grid-column:1/-1}.ph-new-post .ph-media-tools>button:not(.ph-main-media):not(.ph-more){order:2;min-height:36px;white-space:normal;margin:0}.ph-new-post .ph-more{order:1;grid-column:1/-1;display:block;width:100%;min-height:36px;padding:8px 2px;text-align:left;color:#4d647b;background:none;border:0;border-top:1px solid #e0e7ef;font:13px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;cursor:pointer}.ph-new-post .ph-more::after{content:\"\";display:inline-block;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);margin-left:10px}.ph-new-post.ph-options-open .ph-more::after{transform:translateY(2px) rotate(225deg)}.ph-new-post:not(.ph-options-open) .ph-media-tools>button:not(.ph-main-media):not(.ph-more),.ph-new-post:not(.ph-options-open) .ph-extra-options{display:none!important}.ph-new-post.ph-options-open .ph-extra-options{animation:ph-reveal .16s ease-out}.ph-new-post .ph-extra-options{padding-top:8px}.ph-new-post .ph-extra-options label{line-height:1.65}\n.ph-new-post .ph-editor-footer::before,.ph-new-post .ph-editor-footer::after{content:none;display:none}.ph-new-post .ph-editor-footer{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:16px}.ph-new-post .ph-editor-footer>button{float:none!important;margin:0!important;min-width:0;min-height:46px;padding:12px;box-sizing:border-box;white-space:normal;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif}.ph-new-post .ph-editor-footer>button[ng-click=\"ok()\"]{order:0;grid-column:1;color:#fff;background:#31577d;border-color:#31577d}.ph-new-post .ph-editor-footer>button[ng-click=\"closeWithConfirm()\"]{order:1;grid-column:2;background:#fff;color:#4d647b;border-color:#cad5e1}.ph-new-post .ph-editor-footer>button:not([ng-click=\"ok()\"]):not([ng-click=\"closeWithConfirm()\"]){order:2;grid-column:1/-1}\n@media(pointer:coarse){.ph-new-post{width:calc(100% - 24px * var(--ph-size,1));max-width:calc(760px * var(--ph-size,1))}.ph-new-post .modal-body{padding:calc(16px * var(--ph-size,1))}.ph-new-post .modal-header{padding:calc(16px * var(--ph-size,1))}.ph-new-post .modal-header h3,.ph-new-post .modal-header h4{font-size:calc(20px * var(--ph-size,1))}.ph-new-post .ph-paste-row{gap:calc(8px * var(--ph-size,1));margin:calc(8px * var(--ph-size,1)) 0 calc(12px * var(--ph-size,1))}.ph-new-post .ph-paste-row>.ph-paste,.ph-new-post .ph-submit-proxy{min-height:calc(48px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) calc(8px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1))}.ph-new-post emoji-input[ng-model=\"project.text\"] .emoji-wysiwyg-editor{font-size:calc(16px * var(--ph-size,1));line-height:1.5;min-height:calc(140px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1))}.ph-new-post .ph-media-tools{gap:calc(8px * var(--ph-size,1))}.ph-new-post .ph-media-tools>.ph-main-media{min-height:calc(48px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) calc(8px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1))}.ph-new-post .ph-more{font-size:calc(12px * var(--ph-size,1));min-height:calc(40px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1)) 0}.ph-new-post .ph-extra-options{font-size:calc(13px * var(--ph-size,1))}.ph-new-post .ph-extra-options input[type=checkbox]{width:calc(16px * var(--ph-size,1));height:calc(16px * var(--ph-size,1))}.ph-new-post .ph-editor-footer{gap:calc(8px * var(--ph-size,1));padding:calc(16px * var(--ph-size,1))}.ph-new-post .ph-editor-footer>button{min-height:calc(48px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1))}.ph-new-post .ph-media-tools>button:not(.ph-main-media):not(.ph-more){font-size:calc(13px * var(--ph-size,1));min-height:calc(40px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1))}}\n@keyframes ph-reveal{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){.ph-new-post.ph-options-open .ph-extra-options{animation:none}}\n"; style.textContent += "\n.ph-new-post .ph-extra-options{opacity:1!important;animation:none!important}.ph-new-post .ph-extra-options label.hand{display:block;max-width:100%;margin:0;padding:5px 0;font-weight:400;line-height:1.5;white-space:normal;color:#42566b}.ph-new-post .ph-extra-options .postproject-modal-checkbox-border{display:inline-flex;align-items:center;justify-content:center;position:relative;width:18px;height:18px;margin:0 8px 0 0;vertical-align:-3px;border:0!important;background:none}.ph-new-post .ph-extra-options .postproject-modal-checkbox-border input[type=checkbox]{position:static!important;display:block;width:16px;height:16px;margin:0!important;padding:0;accent-color:#31577d}.ph-new-post .ph-extra-options .form-control{min-height:34px;font-size:13px;max-width:100%}\n.ph-new-post .ph-schedule-block{display:grid;gap:10px}.ph-new-post .ph-schedule-block::before,.ph-new-post .ph-schedule-block::after{display:none;content:none}.ph-new-post .ph-schedule-block>.control-label{order:0;margin:0;font-size:14px;font-weight:600;color:#344b62}.ph-new-post .ph-schedule-block>.el-divider-light{display:none}.ph-new-post .ph-time-tools{order:1;float:none!important;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:0;line-height:1;margin:0}.ph-new-post .ph-time-tools>.dashed-link{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:7px 10px;font:500 13px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d;border:1px solid #c6d3e0;border-radius:6px;background:#fff;cursor:pointer;touch-action:manipulation}.ph-new-post .ph-time-tools>.dashed-link:hover{background:#f3f7fb}.ph-new-post .ph-time-tools>.dashed-link:focus-visible{outline:2px solid #537fa8;outline-offset:2px}\n.ph-new-post .ph-schedule-table{order:2;display:block;width:100%;margin:0}.ph-new-post .ph-schedule-table>tbody{display:grid;gap:10px}.ph-new-post .ph-schedule-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.65fr) 28px;align-items:center;gap:10px;padding:10px;background:#f8fafc;border:1px solid #dde5ee;border-radius:8px}.ph-new-post .ph-schedule-row>td{padding:0!important;min-width:0}.ph-new-post .ph-schedule-page{grid-column:1}.ph-new-post .ph-schedule-page .public{display:flex;align-items:center;gap:8px;white-space:normal}.ph-new-post .ph-schedule-page .page-logo{width:28px;height:28px;flex:none;background-size:cover;margin:0}.ph-new-post .ph-schedule-page .page-name{font-size:13px;line-height:1.35;overflow-wrap:anywhere;color:#344b62}.ph-new-post .ph-schedule-time{grid-column:2;display:grid;grid-template-columns:minmax(0,1.35fr) auto minmax(0,1fr);gap:6px;align-items:center;text-align:left!important;white-space:normal!important}.ph-new-post .ph-schedule-time>.input-group:not(.timepicker){display:flex;min-width:0;width:auto}.ph-new-post .ph-schedule-time input.form-control{width:100%!important;min-width:0;flex:1;height:36px;min-height:36px;padding:7px;font-size:13px;box-sizing:border-box}.ph-new-post .ph-schedule-time .input-group-btn{display:flex;flex:none;width:auto}.ph-new-post .ph-schedule-time .input-group-btn>.btn{width:34px;height:36px;padding:6px;line-height:1}.ph-new-post .ph-schedule-time>.timepicker{display:block;width:auto;min-width:0}.ph-new-post .ph-schedule-time my-timepicker{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px}.ph-new-post .ph-schedule-time my-timepicker>select{float:none;width:100%!important;min-width:0;height:36px;min-height:36px;padding:6px 3px;font-size:13px;box-sizing:border-box}.ph-new-post .ph-schedule-time>strong{padding:0!important;font-size:12px;color:#687b8e}.ph-new-post .ph-schedule-remove{grid-column:3;justify-self:end}.ph-new-post .ph-schedule-remove>a{display:flex;align-items:center;justify-content:center;width:28px;height:36px;border-radius:5px}.ph-new-post .ph-page-picker>.control-label{font-size:14px;font-weight:600;color:#344b62}\n.ph-compose-bar{display:grid;grid-template-columns:minmax(0,1fr) 112px auto;align-items:stretch;gap:10px;padding-bottom:14px}.ph-compose-bar::before,.ph-compose-bar::after{display:none;content:none}.ph-compose-bar>.ph-compose-primary{grid-column:1;order:0;min-width:0;width:100%;min-height:48px;padding:12px 14px;background-image:none!important;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;white-space:normal;border-radius:7px}.ph-compose-primary .button-label{display:block;white-space:normal}.ph-compose-primary .btn_ghost-word{display:inline}.ph-compose-bar>.ph-story-host{display:block;grid-column:2;order:1;min-width:0}.ph-story-button{display:flex;align-items:center;justify-content:center;min-width:0;width:100%;height:100%;min-height:48px;padding:12px;background:#fff!important;background-image:none!important;color:#4d647b;border:1px solid #c6d3e0;font:500 14px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;border-radius:7px;white-space:normal}.ph-story-button::before,.ph-story-button::after{display:none;content:none}.ph-story-button>.c-schedule-button__text-full,.ph-story-button>.c-schedule-button__text-brief{display:none!important}.ph-compose-bar>view-selector{grid-column:3;order:2;float:none;align-self:center;justify-self:end}.ph-compose-bar>.weekly-view-link{grid-column:1/-1;order:3;margin:0}\n@media(pointer:coarse){.ph-new-post .ph-extra-options label.hand{padding:calc(6px * var(--ph-size,1)) 0;font-size:calc(13px * var(--ph-size,1));line-height:1.5}.ph-new-post .ph-extra-options .postproject-modal-checkbox-border{width:calc(18px * var(--ph-size,1));height:calc(18px * var(--ph-size,1));margin:0 calc(7px * var(--ph-size,1)) 0 0;vertical-align:calc(-3px * var(--ph-size,1))}.ph-new-post .ph-extra-options .postproject-modal-checkbox-border input[type=checkbox]{width:calc(16px * var(--ph-size,1));height:calc(16px * var(--ph-size,1))}.ph-new-post .ph-extra-options .form-control{min-height:calc(36px * var(--ph-size,1));font-size:calc(13px * var(--ph-size,1));padding:calc(6px * var(--ph-size,1))}.ph-new-post .ph-schedule-block{gap:calc(10px * var(--ph-size,1))}.ph-new-post .ph-schedule-block>.control-label{font-size:calc(14px * var(--ph-size,1))}.ph-new-post .ph-time-tools{gap:calc(8px * var(--ph-size,1))}.ph-new-post .ph-time-tools>.dashed-link{min-height:calc(38px * var(--ph-size,1));font-size:calc(13px * var(--ph-size,1));padding:calc(8px * var(--ph-size,1)) calc(10px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(6px * var(--ph-size,1))}.ph-new-post .ph-schedule-table>tbody{gap:calc(10px * var(--ph-size,1))}.ph-new-post .ph-schedule-row{grid-template-columns:minmax(0,1fr) auto;gap:calc(10px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(8px * var(--ph-size,1))}.ph-new-post .ph-schedule-page{grid-row:1;grid-column:1}.ph-new-post .ph-schedule-page .public{gap:calc(8px * var(--ph-size,1))}.ph-new-post .ph-schedule-page .page-logo{width:calc(26px * var(--ph-size,1));height:calc(26px * var(--ph-size,1))}.ph-new-post .ph-schedule-page .page-name{font-size:calc(14px * var(--ph-size,1))}.ph-new-post .ph-schedule-time{grid-row:2;grid-column:1/-1;gap:calc(7px * var(--ph-size,1))}.ph-new-post .ph-schedule-time input.form-control{height:calc(38px * var(--ph-size,1));min-height:calc(38px * var(--ph-size,1));padding:calc(7px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));border-radius:calc(6px * var(--ph-size,1))}.ph-new-post .ph-schedule-time .input-group-btn>.btn{width:calc(34px * var(--ph-size,1));height:calc(38px * var(--ph-size,1));padding:calc(6px * var(--ph-size,1));font-size:calc(13px * var(--ph-size,1))}.ph-new-post .ph-schedule-time my-timepicker{gap:calc(5px * var(--ph-size,1))}.ph-new-post .ph-schedule-time my-timepicker>select{height:calc(38px * var(--ph-size,1));min-height:calc(38px * var(--ph-size,1));padding:calc(6px * var(--ph-size,1)) calc(3px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));border-radius:calc(6px * var(--ph-size,1))}.ph-new-post .ph-schedule-time>strong{font-size:calc(12px * var(--ph-size,1))}.ph-new-post .ph-schedule-remove{grid-row:1;grid-column:2}.ph-new-post .ph-schedule-remove>a{width:calc(30px * var(--ph-size,1));height:calc(32px * var(--ph-size,1));font-size:calc(12px * var(--ph-size,1))}.ph-new-post .ph-page-picker>.control-label,.ph-new-post .ph-page-picker .panel-title{font-size:calc(14px * var(--ph-size,1))}.ph-new-post .ph-page-picker .panel-heading{padding:calc(10px * var(--ph-size,1));min-height:calc(38px * var(--ph-size,1));box-sizing:border-box}.ph-new-post .ph-page-picker .page-name{font-size:calc(13px * var(--ph-size,1))}.ph-compose-bar{grid-template-columns:minmax(0,2.3fr) minmax(0,1fr);gap:calc(8px * var(--ph-size,1));padding-bottom:calc(10px * var(--ph-size,1))}.ph-compose-bar>.ph-compose-primary,.ph-story-button{min-height:calc(48px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) calc(10px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1))}.ph-compose-bar>view-selector{grid-column:1/-1}.ph-compose-bar .c-view-selector__button{font-size:calc(11px * var(--ph-size,1));min-height:calc(28px * var(--ph-size,1));padding:calc(6px * var(--ph-size,1)) calc(8px * var(--ph-size,1))}}\n"; style.textContent += "\n.ph-compose-inline>.ph-compose-primary{float:left;width:68%;min-width:0;min-height:48px;margin:0 2% 12px 0!important;padding:12px 14px;background-image:none!important;font:600 15px/1.3 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;white-space:normal;border-radius:7px;box-sizing:border-box}.ph-compose-inline>.ph-story-host{display:block;float:left;width:30%;margin:0 0 12px;box-sizing:border-box}.ph-compose-inline>[postlist-bar],.ph-compose-inline>postlist-loading,.ph-compose-inline>.post-list{clear:both}@media(pointer:coarse){.ph-compose-inline>.ph-compose-primary{min-height:calc(48px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) calc(10px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1));margin-bottom:calc(10px * var(--ph-size,1))!important}.ph-compose-inline>.ph-story-host{margin-bottom:calc(10px * var(--ph-size,1))}}"; style.textContent += ".ph-compose-primary::before,.ph-compose-primary::after{display:none;content:none}"; style.textContent += ".ph-new-post .ph-extra-options label.hand{position:relative;padding-left:26px}.ph-new-post .ph-extra-options label.hand>.postproject-modal-checkbox-border{position:absolute;left:0;top:6px;margin:0;vertical-align:baseline}@media(pointer:coarse){.ph-new-post .ph-extra-options label.hand{padding-left:calc(26px * var(--ph-size,1))}.ph-new-post .ph-extra-options label.hand>.postproject-modal-checkbox-border{top:calc(7px * var(--ph-size,1));margin:0}}"; style.textContent += "\n.ph-compose-bar{grid-template-columns:minmax(0,2fr) minmax(0,1fr);grid-template-rows:32px 32px;gap:6px 10px;align-items:stretch}.ph-compose-bar>.ph-compose-primary{grid-column:1;grid-row:1/3;width:100%;height:100%;min-height:0;margin:0!important;display:flex;align-items:center;justify-content:center}.ph-compose-bar>.ph-story-host{grid-column:2;grid-row:1;width:100%;height:100%;min-height:0;margin:0;float:none}.ph-compose-bar .ph-story-button{min-height:0;height:100%;padding:4px 8px;font-size:13px}.ph-compose-bar>view-selector{grid-column:2;grid-row:2;align-self:stretch;justify-self:stretch;display:block;width:100%;height:100%;min-width:0;float:none}.ph-compose-bar>view-selector>.btn-group{display:block;width:100%;height:100%}.ph-compose-bar>view-selector .c-view-selector__button{width:100%;height:100%;min-height:0;min-width:0;margin:0;padding:4px 6px;font-size:12px;line-height:1.2;box-sizing:border-box;white-space:normal}.ph-compose-bar>view-selector .c-view-selector__primary-icon{display:none}.ph-compose-bar>view-selector .c-view-selector__text-full{display:inline!important}.ph-compose-bar>view-selector .c-view-selector__text-brief{display:none!important}.ph-compose-bar>.weekly-view-link{grid-column:1/-1;grid-row:auto}.ph-story-button{background:linear-gradient(110deg,#ff8a24 0%,#f12b63 55%,#9639a3 100%)!important;border-color:transparent!important;color:#fff!important}\n@media(pointer:coarse){.ph-compose-bar{grid-template-columns:minmax(0,2fr) minmax(0,1fr);grid-template-rows:calc(32px * var(--ph-size,1)) calc(32px * var(--ph-size,1));gap:calc(6px * var(--ph-size,1)) calc(8px * var(--ph-size,1))}.ph-compose-bar>.ph-compose-primary{height:100%;min-height:0}.ph-compose-bar .ph-story-button{height:100%;min-height:0;padding:calc(4px * var(--ph-size,1)) calc(6px * var(--ph-size,1));font-size:calc(13px * var(--ph-size,1))}.ph-compose-bar>view-selector{grid-column:2;grid-row:2}.ph-compose-bar>view-selector .c-view-selector__button{min-height:0;height:100%;font-size:calc(12px * var(--ph-size,1));padding:calc(4px * var(--ph-size,1)) calc(5px * var(--ph-size,1))}}\n"; style.textContent += "\n.ph-new-post .modal-header{position:relative;padding-right:68px}.ph-new-post .ph-editor-close{position:absolute!important;top:8px!important;right:8px!important;left:auto!important;display:flex;align-items:center;justify-content:center;width:40px;height:40px;min-width:40px;padding:0;background:#31577d;color:#fff;border-radius:8px;cursor:pointer;box-sizing:border-box;touch-action:manipulation}.ph-new-post .ph-editor-close::before{position:static;display:block;width:auto;height:auto;min-width:0;padding:0;line-height:1;font-size:22px;background:none;color:inherit;border-radius:0}.ph-new-post .ph-editor-close:focus-visible{outline:2px solid #537fa8;outline-offset:3px}.ph-new-post emoji-input[ng-model=\"project.text\"] .emoji-wysiwyg-editor{font-size:14px}.info>.ph-actions{justify-content:flex-start;align-items:flex-start;padding-top:12px}.info>.ph-actions>.ph-status{text-align:left}\n@media(pointer:coarse){.ph-new-post .modal-header{padding-right:calc(68px * var(--ph-size,1))}.ph-new-post .ph-editor-close{top:calc(8px * var(--ph-size,1))!important;right:calc(8px * var(--ph-size,1))!important;width:calc(40px * var(--ph-size,1));height:calc(40px * var(--ph-size,1));min-width:calc(40px * var(--ph-size,1));border-radius:calc(8px * var(--ph-size,1))}.ph-new-post .ph-editor-close::before{font-size:calc(22px * var(--ph-size,1));line-height:1}.ph-new-post emoji-input[ng-model=\"project.text\"] .emoji-wysiwyg-editor{font-size:calc(15px * var(--ph-size,1))}.ph-compose-bar>view-selector .c-view-selector__button{font-size:calc(11px * var(--ph-size,1))}}\n"; style.textContent += "\n.ph-compose-primary,.ph-compose-primary .button-label,.ph-compose-primary .button-label span{font-weight:400!important}\n.ph-new-post .modal-header{display:flex;align-items:center;gap:12px;padding-right:16px}.ph-new-post .modal-header::before,.ph-new-post .modal-header::after{display:none;content:none}.ph-new-post .modal-header>.modal-title{order:1;flex:1;min-width:0;margin:0}.ph-new-post .ph-editor-close{order:2;position:relative!important;top:auto!important;right:auto!important;left:auto!important;float:none!important;flex:0 0 40px;width:40px;height:40px;min-width:40px;margin:0!important;padding:0;background:transparent!important;color:#60748b;border:0;border-radius:0}.ph-new-post .ph-editor-close:hover{color:#31577d}.ph-new-post .ph-editor-close::before,.ph-new-post .ph-editor-close::after{content:\"\";position:absolute;display:block;left:50%;top:50%;width:18px;height:1.5px;min-width:0;margin:0;padding:0;border:0;border-radius:1px;background:currentColor;color:inherit;transform:translate(-50%,-50%) rotate(45deg)}.ph-new-post .ph-editor-close::after{transform:translate(-50%,-50%) rotate(-45deg)}.info>.ph-actions .ph-copy{font-size:12px;gap:6px;padding:8px;white-space:nowrap}\n@media(pointer:coarse){.ph-new-post .modal-header{gap:calc(12px * var(--ph-size,1));padding-right:calc(16px * var(--ph-size,1))}.ph-new-post .ph-editor-close{flex-basis:calc(40px * var(--ph-size,1));width:calc(40px * var(--ph-size,1));height:calc(40px * var(--ph-size,1));min-width:calc(40px * var(--ph-size,1))}.ph-new-post .ph-editor-close::before,.ph-new-post .ph-editor-close::after{width:calc(18px * var(--ph-size,1));height:calc(1.5px * var(--ph-size,1))}}\n"; doc.head.append(style);
    syncDensity(doc);
    function scan() {
      if (activeDoc === doc) utility.hidden = !!modalOf(doc);
      enhanceComposeBar(doc);
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
      const m=newModal(doc);
      if(m){
        addPaste(doc,m); enhanceEditor(doc,m); enhanceSchedule(doc,m); enhanceClose(m);
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
    if(location.pathname.replace(/\/$/,'')!=='/home/posts'){utility.remove();return;}
    syncDensity();
    const frame=[...document.querySelectorAll('iframe')].find(f=>{try{return new URL(f.src,location.href).pathname==='/iframe/app/'}catch{return false}});
    try{
      const doc=frame?.contentDocument;
      if(!doc?.body){utility.remove();return;}
      activeDoc=doc;install(doc);syncDensity(doc);updateCopyPlacement(doc);
      doc.documentElement.classList.toggle('ph-skin',readSettings(doc).skin!==false);
      if(!utility.isConnected)document.body.append(utility);
      const settings=readSettings(doc);
      const next=settings.pages.length?'Автовыбор · '+settings.pages.length:'Выбрать страницы';
      if(utilityLabel.textContent!==next)utilityLabel.textContent=next;
      utility.dataset.enabled=String(settings.enabled&&settings.pages.length>0);
      utility.title=autoSummary(doc);utility.setAttribute('aria-label',autoSummary(doc)+'. Открыть настройки');
      utility.hidden=!!modalOf(doc);
    }catch{utility.remove();}
  }
  refresh();setInterval(refresh,1200);
})();
