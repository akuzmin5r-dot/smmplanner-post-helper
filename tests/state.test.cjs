const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','smmplanner-mobile.user.js'),'utf8');
const pure=source.slice(source.indexOf('  function footerKey('),source.indexOf('  function rowOf('));
let preferences={autoPages:true,autoVideoTitle:true,pageIds:['1','2']},messages=[],updates=0;
const sandbox={prefs:()=>preferences,status:(_,s)=>messages.push(s),importPages:()=>[]};
vm.runInNewContext(pure+source.slice(source.indexOf('  function autoSelect('),source.indexOf('  function adapt('))+';this.select=autoSelect;this.video=autoVideo;',sandbox);
function ctx(pages,form={pageConfigs:[],media:[],text:''}){return {queries:{pageConfigSet:{data:{array:pages}}},state:{form},actions:{updateForm:fn=>{updates++;fn(form)},setSidebarView:()=>{}}}}
const available=[{id:1,medium:'vk'},{id:2,medium:'ok'}];
let c=ctx(available.slice(0,1)),state={titles:new Map()};sandbox.select(state,c);assert.equal(updates,0);assert.match(messages.at(-1),/изменился/);
c=ctx(available);sandbox.select(state,c);assert.equal(c.state.form.pageConfigs.length,2);assert.equal(updates,1);
c.state.form.pageConfigs=[];sandbox.select(state,c);assert.equal(updates,1,'Manual removal must not trigger reselection');
c=ctx(available);c.state.existingPostProject={id:7};sandbox.select({titles:new Map()},c);assert.equal(updates,1,'Existing posts must not be auto-selected');
c=ctx(available,{pageConfigs:[],media:[{uid:'one',type:'video'}],text:'🚤 Заголовок\n\nТело'});state={titles:new Map()};sandbox.video(state,c);assert.equal(c.state.form.media[0].title,'Заголовок');
c.state.form.text='';sandbox.video(state,c);assert.equal(c.state.form.media[0].title,'','Clearing text must clear the owned automatic title');
c.state.form.media[0].title='Ручное название';c.state.form.text='Другой заголовок';sandbox.video(state,c);assert.equal(c.state.form.media[0].title,'Ручное название');
const reports={URL,AbortController,setTimeout,clearTimeout,fetch:async(url,options)=>{assert.equal(options.credentials,'same-origin');assert(!options.method||options.method==='GET');return {ok:true,json:async()=>url.includes('postproject')?{text:'Заголовок\n\nТекст',post_set:[1,2,3]}:url.endsWith('/1')?{external_url:'https://example.invalid/one'}:url.endsWith('/2')?{external_url:'https://example.invalid/two'}:{external_url:'javascript:alert(1)'}}}};
vm.runInNewContext(source.slice(source.indexOf('  const firstLine ='),source.indexOf('  function feed('))+';this.report=report;',reports);
(async()=>{assert.equal(await reports.report({organization:9,project:{id:7}}),'Заголовок\n\nhttps://example.invalid/one\nhttps://example.invalid/two');console.log('PASS: partial page selection rejected, manual choices retained, automatic/manual video titles protected, read-only report assembled');})().catch(e=>{console.error(e);process.exitCode=1});
