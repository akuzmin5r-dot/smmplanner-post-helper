// ==UserScript==
// @name         SMMplanner Helper
// @namespace    https://smmplanner.com/
// @version      2.0.0
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
  const version = '2.0.0';
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
    } catch {
      showManual(await ready);
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
      try { saveSettings(doc, { enabled: true, pages: selected }); } catch { message.textContent = 'Не удалось сохранить настройки браузера.'; return; }
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
  function install(doc) {
    if (installed.has(doc)) return;
    installed.add(doc);
    const style = doc.createElement('style'); style.textContent = '.ph-copy,.ph-setup{display:inline-block!important;margin:7px 4px!important;padding:10px 12px!important;min-height:42px;font:14px Arial,sans-serif!important;color:#254968!important;background:#fff!important;border:1px solid #9bb0c3!important;border-radius:4px!important;cursor:pointer!important}.ph-copy:disabled{opacity:.6}.ph-note{font:13px Arial,sans-serif;color:#254968}'; doc.head.append(style);
    function scan() {
      for (const row of doc.querySelectorAll('post')) {
        if (!row.querySelector('.post-list-item-published') || row.querySelector('.ph-copy')) continue;
        const host = row.querySelector('.post-content'); if (!host) continue;
        const b = doc.createElement('button'); b.type = 'button'; b.className = 'ph-copy'; b.textContent = 'Копировать ссылки';
        const status = doc.createElement('span'); status.setAttribute('role','status'); status.style.cssText='display:block;font-size:12px';
        b.onclick = async e => {
          e.preventDefault(); e.stopPropagation();
          if (busy) { status.textContent = 'Дождитесь завершения предыдущего копирования.'; return; }
          busy = true; b.disabled = true; status.textContent = '';
          try { await copyDuringTap(collect(doc, row)); status.textContent = 'Отчёт подготовлен'; }
          catch (error) { status.textContent = error.message; }
          finally { busy = false; b.disabled = false; }
        };
        host.append(b,status);
      }
      const anchor = doc.querySelector('button[ng-click="newPostProject()"]');
      if (anchor && !doc.querySelector('.ph-setup')) {
        const setup = doc.createElement('button'); setup.type='button'; setup.className='ph-setup'; setup.textContent='Настроить автовыбор';
        setup.onclick = e => {
          e.preventDefault(); e.stopPropagation();
          const m = newModal(doc);
          if (m) { configure(doc,m); return; }
          if (modalOf(doc)) { alert('Закройте окно редактирования перед настройкой автовыбора.'); return; }
          configureRequested=true; anchor.click();
        };
        anchor.after(setup);
        const label=doc.createElement('label'), toggle=doc.createElement('input'); toggle.type='checkbox';toggle.checked=readSettings(doc).enabled;
        label.className='ph-note';label.append(toggle,doc.createTextNode(' Автовыбор'));
        toggle.onchange=()=>{const s=readSettings(doc);s.enabled=toggle.checked;saveSettings(doc,s)};setup.after(label);
      }
      const m=newModal(doc);
      if(m){
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
  document.head.append(style);
  const badge=document.createElement('div');badge.setAttribute('role','status');badge.style.cssText='position:fixed;bottom:8px;right:8px;z-index:2147483645;padding:7px;background:white;color:#254968;border:1px solid #9bb0c3;font:12px Arial,sans-serif';
  function refresh(){
    if(location.pathname.replace(/\/$/,'')!=='/home/posts'){badge.remove();return;}
    if(document.body&&!badge.isConnected)document.body.append(badge);
    const frame=[...document.querySelectorAll('iframe')].find(f=>{try{return new URL(f.src,location.href).pathname==='/iframe/app/'}catch{return false}});
    try{
      const doc=frame?.contentDocument;
      if(!doc?.body){badge.textContent='Помощник: ожидаю список постов';return;}
      install(doc);
      badge.textContent='Помощник '+version+(readSettings(doc).pages.length?' · автовыбор настроен':' · настройте автовыбор');
    }catch{badge.textContent='Помощник: нет доступа к списку постов';}
  }
  refresh();setInterval(refresh,1200);
})();
