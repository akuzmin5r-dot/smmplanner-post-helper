const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname,'..','smmplanner-mobile.user.js'), 'utf8');
const start = source.indexOf('  function footerKey(');
const end = source.indexOf('  function rowOf(', start);
assert(start >= 0 && end > start);
const helpers = vm.runInNewContext(source.slice(start, end) + ';({trimSubscriptionFooter,videoTitleOf})');
const text = 'Заголовок\n\nПервый абзац.\n\nВторой абзац.';
for (const tail of [
  'Подписывайтесь на Канал',
  '[Подписывайтесь на Канал](https://max.ru/example)',
  '[Канал](https://t.me/example) / [Подписаться в MAX](https://max.ru/example)',
  'Канал / Подписаться в MAX',
]) {
  const cleaned = helpers.trimSubscriptionFooter(text + '\n\n' + tail);
  assert.equal(cleaned.text, text);
  assert.equal(cleaned.removed, true);
}
assert.equal(helpers.trimSubscriptionFooter(text).text, text);
assert.equal(helpers.trimSubscriptionFooter('Подписывайтесь на новости, чтобы знать больше.\n\nОсновной текст.').removed, false);
assert.equal(helpers.trimSubscriptionFooter(text + '\n\nПодписывайтесь на Канал', {footerTrim:false}).removed, false);
assert.equal(helpers.videoTitleOf('👨‍👩‍👧‍👦 🇷🇺 👍🏽 Заголовок\nна двух строках\n\nТело'), 'Заголовок на двух строках');
assert.equal(helpers.videoTitleOf('🫣 «Город» — первая строка\n\nВторая.'), '«Город» — первая строка');
assert.equal(helpers.videoTitleOf('Только один абзац'), 'Только один абзац');
assert.equal(helpers.videoTitleOf('🫣'), '');
assert.equal(Array.from(helpers.videoTitleOf('я'.repeat(300))).length, 255);
console.log('PASS: mobile footer cleanup preserves body and paragraphs; video titles remove emoji and respect the length limit');
