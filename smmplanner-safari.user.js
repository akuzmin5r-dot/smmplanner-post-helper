// ==UserScript==
// @name         SMMplanner Helper — Safari
// @namespace    https://smmplanner.com/
// @version      2.1.0
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
  const version = '2.1.0';
  let busy = false, configureRequested = false;
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
      try { saveSettings(doc, { enabled: enabledInput.checked, pages: selected }); } catch { message.textContent = 'Не удалось сохранить настройки браузера.'; return; }
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
    const note = document.createElement('p'); note.className = 'ph-note';
    note.textContent = 'Автовыбор: добавлено страниц — ' + matches.length + '. Их можно снять вручную.';
    modal.querySelector('h3,h4,.modal-title')?.after(note);
  }
  function syncDensity(doc = document) {
    const touch = matchMedia('(pointer:coarse)').matches;
    const factor = touch ? Math.min(3, Math.max(1, 1 / (visualViewport?.scale || 1))) : 1;
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
    const paste = doc.createElement('button'); paste.type = 'button'; paste.className = 'ph-paste'; paste.textContent = 'Вставить текст';
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
        paste.textContent = 'Текст вставлен';
        setTimeout(() => { paste.textContent = 'Вставить текст'; }, 2500);
      } catch (error) {
        status.textContent = error.name === 'NotAllowedError' ? 'Разрешите Safari вставку из буфера и нажмите ещё раз. Либо вставьте текст через поле поста.' : error.message;
      } finally { paste.disabled = false; }
    };
    line.append(paste, status); field.before(line);
  }

  function install(doc) {
    if (installed.has(doc)) return;
    installed.add(doc);
    const style = doc.createElement('style'); style.textContent = ".ph-actions{clear:both;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px;padding:12px 0 4px}.ph-copy,.ph-setup,.ph-paste{box-sizing:border-box;min-height:44px;padding:10px 16px;font:14px/1.3 Arial,sans-serif;color:#254968;background:#fff;border:1px solid #9bb0c3;border-radius:5px;cursor:pointer;touch-action:manipulation}.ph-copy{display:block;width:auto;min-width:210px;font-weight:600;background:#31577d;color:#fff;border-color:#31577d}.ph-copy:disabled,.ph-paste:disabled{opacity:.65;cursor:wait}.ph-copy:focus-visible,.ph-setup:focus-visible,.ph-paste:focus-visible{outline:3px solid #457dae;outline-offset:3px}.ph-toolbar.main-layout{clear:both;display:flex;align-items:center;justify-content:space-between;gap:12px;box-sizing:border-box;padding-top:12px;padding-bottom:12px;border-top:1px solid #dbe2e9}.ph-toolbar-status{font:14px/1.4 Arial,sans-serif;color:#254968}.ph-note,.ph-status{display:block;font:13px/1.4 Arial,sans-serif;color:#254968}.ph-status:empty{display:none}.ph-status:not(:empty){margin-top:8px}.ph-paste-row{display:block;margin:10px 0}.ph-paste{display:block;width:100%;font-weight:600}.ph-paste-status{display:block;color:#254968;font:13px/1.4 Arial,sans-serif}.ph-paste-status:empty{display:none}@media(pointer:fine){.ph-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:12px}.ph-copy{width:auto;min-width:210px}.ph-paste{width:auto;min-width:210px}}@media(pointer:coarse){.ph-actions{display:block}.ph-copy{width:100%;min-width:0}.ph-copy,.ph-setup,.ph-paste{min-height:calc(48px * var(--ph-size,1));font-size:calc(16px * var(--ph-size,1));padding:calc(12px * var(--ph-size,1)) calc(16px * var(--ph-size,1))}.ph-actions{padding:calc(12px * var(--ph-size,1)) 0 calc(4px * var(--ph-size,1))}.ph-toolbar.main-layout{gap:calc(10px * var(--ph-size,1));flex-wrap:wrap;padding-top:calc(10px * var(--ph-size,1));padding-bottom:calc(10px * var(--ph-size,1))}.ph-toolbar-status{font-size:calc(14px * var(--ph-size,1));flex:1 1 45%}.ph-note,.ph-status,.ph-paste-status{font-size:calc(13px * var(--ph-size,1))}.ph-paste-row{margin:calc(10px * var(--ph-size,1)) 0}}"; doc.head.append(style);
    syncDensity(doc);
    function scan() {
      for (const row of doc.querySelectorAll('post')) {
        if (!row.querySelector('.post-list-item-published') || row.querySelector('.ph-copy')) continue;
        const host = row.querySelector('.center'); if (!host) continue;
        const b = doc.createElement('button'); b.type = 'button'; b.className = 'ph-copy'; b.textContent = 'Копировать ссылки';
        const status = doc.createElement('span'); status.setAttribute('role','status'); status.className='ph-status';
        b.onclick = async e => {
          e.preventDefault(); e.stopPropagation();
          if (busy) { status.textContent = 'Дождитесь завершения предыдущего копирования.'; return; }
          busy = true; b.disabled = true; b.textContent = 'Получаю ссылки…'; status.textContent = '';
          try { const copied = await copyDuringTap(collect(doc, row)); b.textContent = copied ? 'Скопировано' : 'Отчёт открыт'; }
          catch (error) { status.textContent = error.message; }
          finally { busy = false; b.disabled = false; setTimeout(() => { b.textContent = 'Копировать ссылки'; }, 2500); }
        };
        const actions = doc.createElement('div'); actions.className = 'ph-actions'; actions.append(b,status); host.append(actions);
      }
      const anchor = doc.querySelector('button[ng-click="newPostProject()"]');
      if (anchor && !doc.querySelector('.ph-toolbar')) {
        const toolbar = doc.createElement('div'); toolbar.className = 'main-layout ph-toolbar';
        const summary = doc.createElement('span'); summary.className = 'ph-toolbar-status'; summary.setAttribute('role', 'status');
        const setup = doc.createElement('button'); setup.type = 'button'; setup.className = 'ph-setup'; setup.textContent = 'Настроить';
        setup.setAttribute('aria-label', 'Настроить автовыбор страниц');
        setup.onclick = e => {
          e.preventDefault(); e.stopPropagation();
          const m = newModal(doc);
          if (m) { configure(doc,m); return; }
          if (modalOf(doc)) { alert('Закройте окно редактирования перед настройкой автовыбора.'); return; }
          configureRequested = true; anchor.click();
        };
        toolbar.append(summary,setup);
        (anchor.closest('.main-layout') || anchor.parentElement).after(toolbar);
      }
      const summary = doc.querySelector('.ph-toolbar-status'), next = autoSummary(doc);
      if (summary && summary.textContent !== next) summary.textContent = next;
      const m=newModal(doc);
      if(m){
        addPaste(doc,m);
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

  document.head.append(style);
  const badge=document.createElement('div');badge.setAttribute('role','status');badge.style.cssText='position:fixed;bottom:8px;right:8px;z-index:2147483645;padding:7px;background:white;color:#254968;border:1px solid #9bb0c3;font:12px Arial,sans-serif';
  function refresh(){
    if(location.pathname.replace(/\/$/,'')!=='/home/posts'){badge.remove();return;}
    syncDensity();
    const frame=[...document.querySelectorAll('iframe')].find(f=>{try{return new URL(f.src,location.href).pathname==='/iframe/app/'}catch{return false}});
    try{
      const doc=frame?.contentDocument;
      if(!doc?.body){if(document.body&&!badge.isConnected)document.body.append(badge);badge.textContent='Помощник: ожидаю список постов';return;}
      install(doc); syncDensity(doc);
      const summary = doc.querySelector('.ph-toolbar-status'), next = autoSummary(doc);
      if(summary && summary.textContent !== next)summary.textContent = next;
      badge.remove();

    }catch{badge.textContent='Помощник: нет доступа к списку постов';}
  }
  refresh();setInterval(refresh,1200);
})();
