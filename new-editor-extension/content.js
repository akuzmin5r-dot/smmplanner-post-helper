// ==UserScript==
// @name         SMMplanner — мобильный редактор
// @namespace    post-helper-mobile
// @version      1.1.0
// @description  Для iPhone и компьютера: вставка текста, автовыбор страниц, заголовки видео и опубликованные ссылки.
// @match        https://smmplanner.com/home/new_posts*
// @match        https://smmplanner.com/home/post_v3*
// @run-at       document-idle
// @inject-into  page
// @grant        none
// @noframes
// @updateURL    https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-mobile.user.js
// @downloadURL  https://raw.githubusercontent.com/akuzmin5r-dot/smmplanner-post-helper/main/smmplanner-mobile.user.js
// ==/UserScript==

(() => {
  'use strict';
  if (window !== top || window.__postHelperMobile) return;
  window.__postHelperMobile = '1.1.0';
  const mobile = () => /iPhone|iPad|iPod|Android/.test(navigator.userAgent) || (navigator.maxTouchPoints > 0 && innerWidth < 1024);
  const forms = new WeakMap();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function mark(node, name) { if (node && !node.classList.contains(name)) node.classList.add(name); }
  function props(node, test) {
    let f = node?.[Object.keys(node).find(k => k.startsWith('__reactFiber$'))];
    for (let i = 0; f && i < 100; i++, f = f.return) if (f.memoizedProps && test(f.memoizedProps)) return f.memoizedProps;
    return null;
  }
  function context(editor) {
    return props(editor, p => typeof p.value?.actions?.updateForm === 'function' && p.value?.refs?.textEditor)?.value;
  }
  function prefsKey() {
    return 'post-helper:mobile:v1:' + (document.querySelector('[class*="_button__title_"]')?.textContent.trim() || 'personal');
  }
  function prefs() {
    try { return { autoPages: true, footerTrim: true, autoVideoTitle: true, ...JSON.parse(localStorage.getItem(prefsKey()) || '{}') }; }
    catch { return { autoPages: true, footerTrim: true, autoVideoTitle: true }; }
  }
  function savePrefs(p) { localStorage.setItem(prefsKey(), JSON.stringify(p)); }
  function button(label, action, className = '') {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.className = 'phm-button ' + className;
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); action(e); }); return b;
  }
  const nameOf = p => p.name || p.page?.name || '';
  function importPages(available) {
    const candidates = [];
    for (const k of Object.keys(localStorage).filter(k => k.startsWith('post-helper:settings:v2:'))) {
      try {
        const old = JSON.parse(localStorage.getItem(k));
        if (!old?.enabled) continue;
        const found = old.pages.map(item => {
          const [group, medium, name, ordinal] = JSON.parse(item.key);
          const matches = available.filter(p => p.group?.name === group && p.medium === medium && nameOf(p) === name);
          return matches.length === item.total ? matches[ordinal] : null;
        });
        if (found.length && found.every(Boolean)) candidates.push(found);
      } catch { /* Invalid older preferences are ignored. */ }
    }
    const unique = [...new Map(candidates.map(pages => [pages.map(p => p.id).sort().join(','), pages])).values()];
    return unique.length === 1 ? unique[0] : [];
  }
  // Shared pure text helpers are inserted at build time.
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

  function rowOf(node, inner) {
    if (!node || !inner?.contains(node)) return null;
    while (node.parentElement !== inner) node = node.parentElement;
    return node;
  }
  function textLeaf(root, text) {
    return [...root.querySelectorAll('button,p,span,h1,h2,h3,h4,h5,h6,div')].find(n => n.textContent.trim() === text && ![...n.children].some(c => c.textContent.trim() === text));
  }
  function updateText(state, value) {
    const c = context(state.editor);
    if (!c?.refs.textEditor.current?.updateValue) throw Error('Редактор ещё загружается. Повторите попытку.');
    c.refs.textEditor.current.updateValue(value);
    setTimeout(scan, 450);
  }
  function status(state, message) { if (state.status.textContent !== message) state.status.textContent = message; }
  function settings(state, c) {
    const available = c.queries?.pageConfigSet?.data?.array;
    if (state.settings || !available?.length) return;
    const details = document.createElement('details'); details.className = 'phm-settings';
    const summary = document.createElement('summary'); summary.textContent = 'Плагин'; details.append(summary);
    const body = document.createElement('div'); body.className = 'phm-settings-body'; details.append(body);
    const heading = document.createElement('strong'); heading.textContent = 'Автоматизация'; body.append(heading);
    for (const [key, label] of [['autoPages', 'Выбирать страницы автоматически'], ['footerTrim', 'Убирать подпись при вставке'], ['autoVideoTitle', 'Название видео из первого абзаца']]) {
      const l = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = !!prefs()[key];
      input.addEventListener('change', () => { const p = prefs(); p[key] = input.checked; savePrefs(p); }); l.append(input, document.createTextNode(label)); body.append(l);
    }
    const title = document.createElement('strong'); title.textContent = 'Страницы для автовыбора'; body.append(title);
    const choices = [];
    for (const pc of available.filter(p => ['vk', 'ok'].includes(p.medium))) {
      const l = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox';
      const ids = prefs().pageIds || context(state.editor).state.form.pageConfigs.map(p => String(p.id)); input.checked = ids.includes(String(pc.id));
      input.addEventListener('change', () => { const p = prefs(); p.pageIds = choices.filter(x => x.input.checked).map(x => String(x.pc.id)); savePrefs(p); });
      l.append(input, document.createTextNode(`${pc.medium === 'vk' ? 'ВК' : 'ОК'} · ${nameOf(pc)}${pc.group?.name ? ' · ' + pc.group.name : ''}`)); choices.push({ input, pc }); body.append(l);
    }
    details.addEventListener('toggle', () => {
      if (!details.open) return;
      const ids = prefs().pageIds || context(state.editor).state.form.pageConfigs.map(p => String(p.id));
      for (const item of choices) item.input.checked = ids.includes(String(item.pc.id));
    });
    body.append(button('Применить к этому посту', () => {
      const ctx = context(state.editor), chosen = choices.filter(x => x.input.checked).map(x => x.pc);
      if (ctx.state.existingPostProject?.id) { status(state, 'Для существующего поста страницы меняются в редакторе.'); return; }
      ctx.actions.updateForm(form => { form.pageConfigs = chosen; }); status(state, ''); details.open = false;
    }));
    state.inner.append(details); state.settings = details;
  }
  function autoSelect(state, c) {
    if (state.autoDone || c.state.existingPostProject?.id) return;
    const p = prefs(), available = c.queries?.pageConfigSet?.data?.array;
    if (!available?.length) return;
    if (!p.autoPages || c.state.form.pageConfigs.length) { state.autoDone = true; return; }
    let chosen = Array.isArray(p.pageIds) ? available.filter(pc => p.pageIds.includes(String(pc.id))) : importPages(available);
    if (!chosen.length && !Array.isArray(p.pageIds)) {
      const vk = available.filter(pc => pc.medium === 'vk'), ok = available.filter(pc => pc.medium === 'ok');
      if (vk.length === 1 && ok.length === 1) chosen = [vk[0], ok[0]];
    }
    if (!chosen.length) { status(state, 'Выберите страницы в настройках плагина.'); return; }
    state.autoDone = true;
    c.actions.updateForm(form => { form.pageConfigs = chosen; });
    c.actions.setSidebarView(null);
  }
  function autoVideo(state, c) {
    if (!prefs().autoVideoTitle || c.state.existingPostProject?.id) return;
    const title = videoTitleOf(c.state.form.text);
    if (!title) return;
    const ids = c.state.form.media.filter(m => m.type === 'video' && (!m.title || state.titles.get(m.uid) === m.title) && m.title !== title).map(m => m.uid);
    if (!ids.length) return;
    for (const id of ids) state.titles.set(id, title);
    c.actions.updateForm(form => { for (const m of form.media) if (ids.includes(m.uid)) m.title = title; });
  }
  function adapt(editor) {
    const modal = editor.closest('[role="dialog"]'), inner = modal?.querySelector('[class*="_main__content__inner_"]'), c = context(editor);
    if (!modal || !inner || !c) return;
    mark(modal, 'phm-editor'); mark(inner, 'phm-content');
    for (const row of inner.children) {
      if (!row.className.includes('_row_')) continue;
      if (row.textContent.trim() || row.querySelector('input,button,img,[role="alert"]')) {
        if (row.classList.contains('phm-empty-row')) row.classList.remove('phm-empty-row');
      } else if (row.getBoundingClientRect().height === 0) mark(row, 'phm-empty-row');
    }
    let state = forms.get(modal);
    if (!state) {
      state = { editor, inner, titles: new Map() }; forms.set(modal, state);
      mark(rowOf(editor, inner), 'phm-text-row');
      const field = editor.parentElement; mark(field, 'phm-field');
      const toolbar = field.querySelector('.MuiGrid-container'); mark(toolbar, 'phm-hidden');
      const commands = document.createElement('div'); commands.className = 'phm-commands';
      state.paste = button('Вставить текст', async () => {
        try {
          if (context(editor).state.form.text.trim()) { state.undoText = context(editor).state.form.text; updateText(state, ''); status(state, ''); state.undo.hidden = false; return; }
          const original = (await navigator.clipboard.readText()).replace(/\r\n?/g, '\n').replace(/\u2029/g, '\n\n').replace(/\u2028/g, '\n');
          const cleaned = prefs().footerTrim ? trimSubscriptionFooter(original) : { text: original, changed: false };
          state.undoText = original; updateText(state, cleaned.text); status(state, cleaned.removed ? 'Подпись удалена' : ''); state.undo.hidden = !cleaned.removed;
        } catch (e) { status(state, e.name === 'NotAllowedError' ? 'Разрешите вставку из буфера или вставьте текст в поле.' : e.message); }
      }, 'phm-paste'); commands.append(state.paste);
      const gpt = toolbar && [...toolbar.querySelectorAll('button')].find(b => /Чат GPT/.test(b.textContent));
      if (gpt) commands.append(button('Чат GPT+', () => gpt.click(), 'phm-gpt'));
      state.status = document.createElement('span'); state.status.setAttribute('role', 'status');
      state.undo = button('Вернуть текст', () => { updateText(state, state.undoText || ''); state.undo.hidden = true; status(state, ''); }, 'phm-undo'); state.undo.hidden = true;
      const feedback = document.createElement('div'); feedback.className = 'phm-feedback'; feedback.append(state.status, state.undo);
      inner.append(commands, feedback);
      editor.addEventListener('paste', e => {
        if (!prefs().footerTrim || !e.clipboardData) return;
        if (!trimSubscriptionFooter(e.clipboardData.getData('text/plain')).removed) return;
        setTimeout(() => {
          if (!editor.isConnected || !prefs().footerTrim) return;
          const original = context(editor)?.state.form.text;
          if (typeof original !== 'string') return;
          const cleaned = trimSubscriptionFooter(original);
          if (!cleaned.removed) return;
          state.undoText = original; updateText(state, cleaned.text); state.undo.hidden = false; status(state, 'Подпись удалена');
        }, 500);
      }, true);
    }
    const label = c.state.form.text.trim() ? 'Очистить текст' : 'Вставить текст';
    mark(rowOf(editor, inner), 'phm-text-row');
    mark(editor.parentElement, 'phm-field');
    mark(editor.parentElement.querySelector('.MuiGrid-container'), 'phm-hidden');
    if (state.paste.textContent !== label) state.paste.textContent = label;
    autoSelect(state, c); autoVideo(state, c); settings(state, c);
    const media = rowOf(inner.querySelector('input[type="file"][accept*="video"]'), inner);
    if (media) {
      mark(media, 'phm-media');
      for (const child of media.children) if (child.tagName === 'P' || child.tagName === 'H3' || [...child.querySelectorAll('button')].some(b => b.textContent.trim() === 'Загрузить')) mark(child, 'phm-hidden');
    }
    const schedule = rowOf(textLeaf(inner, 'Время публикации'), inner), add = rowOf(textLeaf(inner, 'Добавить паблик'), inner);
    if (schedule && add) {
      for (let row = schedule; row; row = row.nextElementSibling) { mark(row, 'phm-schedule'); if (row === add) break; }
    }
    mark(rowOf(textLeaf(inner, 'Настройки поста'), inner), 'phm-post-settings');
    mark(rowOf(textLeaf(inner, 'Элементы'), inner), 'phm-elements');
    const buttons = [...modal.querySelectorAll('button')], now = buttons.find(b => b.textContent.trim() === 'Опубликовать сейчас'), plan = buttons.find(b => b.textContent.trim() === 'Запланировать'), draft = buttons.find(b => b.textContent.trim() === 'Сохранить как черновик');
    if (now && plan && draft && now.parentElement.parentElement === draft.parentElement.parentElement) {
      mark(now.parentElement.parentElement, 'phm-actions'); mark(now, 'phm-now'); mark(plan, 'phm-plan'); mark(draft.parentElement, 'phm-draft');
    }
  }
  function copyFallback(text, error) {
    const d = document.createElement('dialog'); d.className = 'phm-copy-dialog';
    const title = document.createElement('p'); title.textContent = error || 'Выделите и скопируйте отчёт'; d.append(title);
    if (text) { const t = document.createElement('textarea'); t.value = text; t.readOnly = true; d.append(t); t.addEventListener('click', () => t.select()); }
    d.append(button('Закрыть', () => d.remove())); document.body.append(d); d.showModal();
  }
  const firstLine = value => String(value || '').split(/[\r\n\u2028\u2029]/).map(s => s.trim()).find(Boolean) || '';
  const idOf = value => { const id = typeof value === 'object' ? value?.id : value; if (!/^\d+$/.test(String(id))) throw Error('Не удалось определить публикацию.'); return String(id); };
  async function report(post) {
    const headers = { 'X-Organization-Context': idOf(post.organization) };
    const get = async url => { const r = await fetch(url, { credentials: 'same-origin', headers }); if (!r.ok) throw Error('Не удалось загрузить опубликованные ссылки.'); return r.json(); };
    const project = await get('/api/v1/postproject/' + idOf(post.project));
    if (!Array.isArray(project.post_set) || project.post_set.length > 100) throw Error('Не удалось прочитать публикации.');
    const posts = await Promise.all(project.post_set.map(p => get('/api/v1/post/' + idOf(p))));
    const links = [...new Set(posts.map(p => { try { const u = new URL(p.external_url); return /^(https?:)$/.test(u.protocol) && !u.username && !u.password ? u.href : ''; } catch { return ''; } }).filter(Boolean))];
    if (!links.length) throw Error('Опубликованных ссылок пока нет.');
    return (firstLine(project.text) ? firstLine(project.text) + '\n\n' : '') + links.join('\n');
  }
  function feed() {
    for (const icon of document.querySelectorAll('[data-testid="StarBorderRoundedIcon"],[data-testid="StarRoundedIcon"],[data-testid="StarIcon"]')) {
      const original = icon.closest('button'), model = props(original, p => p.post?.project?.id && p.post.publishing_status);
      if (!original || !model) continue;
      let copy = original.nextElementSibling;
      if (!copy?.classList.contains('phm-copy')) {
        copy = button('', async () => {
          if (copy.dataset.busy) return;
          copy.dataset.busy = 'true'; copy.disabled = true;
          let text = '';
          try {
            const source = props(original, p => p.post?.project?.id && p.post.publishing_status)?.post;
            const pending = report(source).then(value => (text = value));
            if (navigator.clipboard?.write && window.ClipboardItem) {
              try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': pending.then(t => new Blob([t], { type: 'text/plain' })) })]); }
              catch { text = await pending; copyFallback(text); return; }
            } else { text = await pending; copyFallback(text); return; }
            copy.setAttribute('aria-label', 'Скопировано'); copy.title = 'Скопировано'; await sleep(1400);
          } catch (e) { copyFallback(text, e.message); }
          finally { delete copy.dataset.busy; copy.disabled = false; copy.title = 'Копировать ссылки'; copy.setAttribute('aria-label', 'Копировать ссылки'); }
        }, 'phm-copy');
        copy.className += ' ' + original.className;
        copy.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';
        copy.title = 'Копировать ссылки'; copy.setAttribute('aria-label', 'Копировать ссылки'); original.after(copy);
      }
      mark(original, 'phm-hidden');
      const published = /published|success|done/i.test(String(model.post.publishing_status));
      if (!copy.dataset.busy) copy.disabled = !published;
      if (!published) copy.title = 'Ссылки появятся после публикации';
    }
  }
  const css = `
    .phm-hidden{display:none!important}
    .phm-editor{font-family:Arial,sans-serif!important;border-radius:20px!important;max-width:620px!important;width:calc(100% - 24px)!important;margin:12px!important}
    .phm-content{display:flex!important;flex-direction:column!important;gap:12px!important;padding:8px 16px 16px!important}
    .phm-content>div[class*="_row_"]{margin:0!important;padding-top:0!important;padding-bottom:0!important}
    .phm-content>.MuiCollapse-hidden,.phm-content>.phm-empty-row{display:none!important}
    .phm-text-row{order:10}.phm-commands{order:11;display:flex;gap:10px}.phm-feedback{order:12;display:flex;gap:8px;align-items:center;flex-wrap:wrap;color:#667080;font-size:13px}.phm-feedback:has(span:empty):has(button[hidden]){display:none}
    .phm-field{border:1px solid #cdd1da!important;border-radius:14px!important;padding:12px!important}
    .phm-field [data-lexical-editor]{min-height:130px!important;font-size:16px!important;line-height:1.5!important;padding:0!important;outline-offset:6px}
    .phm-field [data-lexical-editor] p{margin:0!important}
    .phm-field [data-lexical-editor]>p+p{margin-top:1em!important}
    .phm-button{font:inherit;line-height:1.3;border:1px solid #cdd1da;background:#f7f8fa;color:#303845;border-radius:10px;min-height:46px;padding:10px 16px;cursor:pointer;touch-action:manipulation}
    .phm-button:focus-visible{outline:2px solid #4857bb;outline-offset:3px}.phm-button:disabled{opacity:.45;cursor:default}.phm-button[hidden]{display:none}
    .phm-paste{flex:1;text-align:center}.phm-gpt{background:transparent}.phm-undo{border:0;background:none;min-height:32px;padding:0;text-decoration:underline;font-size:inherit;color:inherit}
    .phm-media{order:20;margin-top:4px!important}.phm-media [class*="_dropZone_"]{border-radius:14px!important;min-height:90px!important;height:auto!important;padding:14px 12px!important}
    .phm-media>div:not(.phm-hidden){margin-top:0!important}
    .phm-schedule>[class*="_head_"]{margin:4px 0 12px!important}
    .phm-elements>p,.phm-post-settings>p{margin:4px 0 12px!important}
    .phm-schedule{order:30}.phm-elements{order:40}.phm-post-settings{order:41}.phm-settings{order:50;border-top:1px solid #e5e7eb;padding-top:14px;color:#535c6c;font-size:14px}.phm-settings>summary{cursor:pointer;min-height:38px;align-content:center}.phm-settings-body{display:flex;flex-direction:column;gap:14px;padding:12px 0}.phm-settings-body strong{color:#303845;font-size:14px;font-weight:600}.phm-settings-body label{display:flex;gap:10px;align-items:flex-start;line-height:1.4}.phm-settings-body input{width:18px;height:18px;margin:0;flex-shrink:0;accent-color:#4857bb}
    .phm-actions{display:grid!important;grid-template-columns:minmax(0,1fr) minmax(0,1fr)!important;gap:12px!important;align-items:stretch!important}
    .phm-actions>div:not(.phm-draft){display:contents!important}.phm-actions .phm-now,.phm-actions .phm-plan{margin:0!important;min-width:0!important;width:100%!important;min-height:50px!important;font-size:15px!important;line-height:1.3!important;padding:10px!important;border-radius:12px!important;white-space:normal!important}
    .phm-now{grid-row:1;grid-column:1}.phm-plan{grid-row:1;grid-column:2}.phm-draft{grid-row:2;grid-column:1/-1;text-align:center!important}.phm-draft button{min-height:36px!important;border:0!important;background:transparent!important;box-shadow:none!important;font-size:13px!important;padding:4px 12px!important}
    .phm-copy{padding:10px!important;min-width:44px!important;min-height:44px!important;background:transparent!important;border:0!important;border-radius:8px!important;color:inherit!important}
    .phm-copy-dialog{width:calc(100% - 48px);max-width:460px;padding:20px;border:0;border-radius:16px;font:16px/1.5 Arial,sans-serif}.phm-copy-dialog::backdrop{background:#0006}.phm-copy-dialog textarea{box-sizing:border-box;width:100%;min-height:220px;font:16px/1.5 Arial,sans-serif;border:1px solid #cdd1da;border-radius:10px;padding:12px}.phm-copy-dialog .phm-button{margin-top:12px;width:100%}
    @media(min-width:900px){.phm-editor{max-width:760px!important;margin:24px!important}.phm-content{padding-left:24px!important;padding-right:24px!important}}
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);
  let pending = false;
  function scan() {
    pending = false;
    if (!/^\/home\/(new_posts|post_v3)(\/|$)/.test(location.pathname)) return;
    document.querySelectorAll('[data-lexical-editor="true"][contenteditable="true"]').forEach(adapt); feed();
  }
  new MutationObserver(() => { if (!pending) { pending = true; setTimeout(scan, 120); } }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  let inputTimer;
  document.addEventListener('input', e => {
    if (!e.target.closest?.('[data-lexical-editor]')) return;
    clearTimeout(inputTimer); inputTimer = setTimeout(scan, 450);
  }, true);
  window.addEventListener('resize', () => { if (!pending) { pending = true; setTimeout(scan, 120); } });
  document.addEventListener('click', e => {
    if (mobile() || location.pathname.replace(/\/$/, '') !== '/home/new_posts/feed' || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const b = e.target.closest?.('button,a');
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true' || !/^(?:Создать\s+)?пост$/iu.test(b.textContent.trim())) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const url = new URL('/home/post_v3', location.origin); url.search = location.search;
    location.assign(url.href);
  }, true);
  scan();
})();
