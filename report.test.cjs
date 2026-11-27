const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const source=fs.readFileSync('smmplanner-tampermonkey.user.js','utf8');
const start=source.indexOf('  const firstLine'),end=source.indexOf('  function titleOf');
const context={URL,Set,String,Error};
vm.runInNewContext(source.slice(start,end)+';this.reportOf=reportOf;',context);
function modal(text,urls){return {querySelector:()=>({value:text}),querySelectorAll:()=>urls.map(href=>({href}))}}
assert.equal(context.reportOf(modal('\r\n Headline \r\nBody',['https://one.invalid/post/1','https://two.invalid/post/2','https://three.invalid/post/3'])),'Headline\n\nhttps://one.invalid/post/1\nhttps://two.invalid/post/2\nhttps://three.invalid/post/3');
assert.equal(context.reportOf(modal('', ['https://one.invalid/p','https://one.invalid/p','javascript:alert(1)','https://user:password@one.invalid/p'])),'https://one.invalid/p');
assert.throws(()=>context.reportOf(modal('Title',[])),/Опубликованных ссылок пока нет/);
assert.throws(()=>context.reportOf({querySelector:()=>null}),/Не найден полный текст/);
console.log('PASS: arbitrary published links, headline, line spacing, deduplication, unsafe URL rejection, empty/missing data');
