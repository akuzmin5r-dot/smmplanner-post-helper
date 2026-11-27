// ==UserScript==
// @name         SMMplanner Helper
// @namespace    https://smmplanner.com/
// @version      2.2.0
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
  const version = '2.2.0';
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
    line.append(paste, status); field.before(line);
  }

  function install(doc) {
    if (installed.has(doc)) return;
    installed.add(doc);
    const style = doc.createElement('style'); style.textContent = ".ph-actions{clear:both;display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;padding:12px 0 2px}.ph-copy,.ph-paste{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;padding:8px 12px;font:500 13px/1.25 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d;background:#fff;border:1px solid #bdcddd;border-radius:6px;cursor:pointer;touch-action:manipulation;max-width:100%}.ph-copy:hover,.ph-paste:hover{background:#f4f7fb;border-color:#8faac4}.ph-copy:active,.ph-paste:active{background:#eaf0f7}.ph-copy:disabled,.ph-paste:disabled{opacity:.6;cursor:wait}.ph-copy:focus-visible,.ph-paste:focus-visible{outline:2px solid #457dae;outline-offset:3px}.ph-icon{width:16px;height:16px;flex:none}.ph-note,.ph-status,.ph-paste-status{display:block;font:12px/1.4 -apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif;color:#31577d}.ph-status:empty,.ph-paste-status:empty{display:none}.ph-status:not(:empty){margin:4px 0;flex-basis:100%;text-align:right}.ph-paste-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:8px 0}.ph-paste{background:#f6f9fc}.ph-paste-status{flex-basis:100%}@media(pointer:coarse){.ph-copy,.ph-paste{min-height:calc(44px * var(--ph-size,1));font-size:calc(14px * var(--ph-size,1));padding:calc(10px * var(--ph-size,1)) calc(12px * var(--ph-size,1));gap:calc(8px * var(--ph-size,1));border-width:calc(1px * var(--ph-size,1));border-radius:calc(7px * var(--ph-size,1))}.ph-actions{padding-top:calc(10px * var(--ph-size,1));padding-bottom:calc(2px * var(--ph-size,1))}.ph-icon{width:calc(16px * var(--ph-size,1));height:calc(16px * var(--ph-size,1))}.ph-note,.ph-status,.ph-paste-status{font-size:calc(12px * var(--ph-size,1))}.ph-paste-row{margin:calc(8px * var(--ph-size,1)) 0}}"; doc.head.append(style);
    syncDensity(doc);
    function scan() {
      for (const row of doc.querySelectorAll('post')) {
        if (!row.querySelector('.post-list-item-published') || row.querySelector('.ph-copy')) continue;
        const host = row.querySelector('.center'); if (!host) continue;
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
      activeDoc=doc;install(doc);syncDensity(doc);
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
