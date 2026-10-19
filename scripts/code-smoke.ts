// Standalone mock/store smoke: bun scripts/code-smoke.ts
import { strict as assert } from 'node:assert';
import { minimalChange, fuzzyScore } from '../src/lib/code/helpers';
import { languageForPath, loadLanguage } from '../src/lib/code/languages';
Object.assign(globalThis, { window: globalThis, confirm: () => true, localStorage: { getItem: () => null, setItem: () => {} } });
const { isTauri } = await import('../src/lib/env');
assert.equal(isTauri(), false);
const { mockIPC } = await import('@tauri-apps/api/mocks');
const { mockCodeCommand } = await import('../src/lib/code/mock');
mockIPC(async (cmd, args) => {
  if (cmd === 'plugin:dialog|message') return (args as { buttons: { OkCancelCustom: string[] } }).buttons.OkCancelCustom[0];
  if (cmd === 'code_write_file') await new Promise(r => setTimeout(r, 8));
  return mockCodeCommand(cmd, args);
}, { shouldMockEvents: true });
assert.equal(isTauri(), false, 'mock IPC must not turn browser folder/confirm handling native');
const { useCode, bufferKey } = await import('../src/stores/code');
const { codeApi } = await import('../src/lib/ipc');
const pause = () => new Promise(r => setTimeout(r, 30));
for (const [a,b] of [['abc','axc'],['','abc'],['abc',''],['same','same'],['🙂 one','🙂 two']]) {
  const c=minimalChange(a,b); assert.equal(a.slice(0,c.from)+c.insert+a.slice(c.to),b);
}
assert(fuzzyScore('src/auth/session.ts','sast') >= 0);
assert.equal(fuzzyScore('src/main.ts','xyz'),-1);
for (const [ext,lang] of [['tsx','javascript'],['rs','rust'],['py','python'],['json','json'],['md','markdown'],['css','css'],['html','html'],['yaml','yaml'],['toml','toml'],['log','plain']]) {
  assert.equal(languageForPath('test.'+ext),lang); await loadLanguage('test.'+ext);
}
const s=()=>useCode.getState();
await s().openRoot('C:/code/test');
await s().openFile('src/main.ts'); await s().openFile('README.md');
assert.deepEqual(s().roots[0].tabs.map(t=>t.rel),['README.md']);
await s().openFile('src/main.ts',{preview:false}); await s().openFile('src/auth/session.ts');
assert.equal(s().roots[0].tabs.length,2);
const root=s().activeRoot!, rel='src/auth/session.ts', key=bufferKey(root,rel), initial=s().buffers[key].text;
s().updateText(root,rel,initial+'\n// edit\n');
assert.equal(s().roots[0].tabs.find(t=>t.rel===rel)?.preview,false);
await Promise.all([s().save(rel),s().save(rel)]); await pause();
assert.equal(s().buffers[key].dirty,false); assert.equal(s().buffers[key].diskChanged,false);
await codeApi.writeFile(root,rel,'// external clean\n',null); await pause();
assert.equal(s().buffers[key].text,'// external clean\n');
s().updateText(root,rel,'// mine\n');
await codeApi.writeFile(root,rel,'// external dirty\n',null); await pause();
assert.equal(s().buffers[key].diskChanged,true); assert.equal(s().buffers[key].text,'// mine\n');
await s().save(rel); assert.equal(s().buffers[key].diskChanged,true);
await s().keepMine(rel); await s().save(rel); await pause();
assert.equal((await codeApi.readFile(root,rel)).text,'// mine\n');
assert.equal(s().buffers[key].dirty,false);
await s().createEntry('notes.md',false); s().updateText(root,'notes.md','# Notes\n'); await s().save('notes.md'); await pause();
await s().renameEntry('notes.md','journal.md'); await pause();
assert(s().roots[0].tabs.some(t=>t.rel==='journal.md'));
assert.equal(s().buffers[bufferKey(root,'journal.md')].text,'# Notes\n');
await s().deleteEntry('journal.md'); await pause(); assert(!s().roots[0].tabs.some(t=>t.rel==='journal.md'));
await s().openFile('logo.png'); assert(s().buffers[bufferKey(root,'logo.png')].binary);
const files=await codeApi.listFiles(root); assert(!files.includes('dist/bundle.js'));
const results=await codeApi.search(root,'session',{regex:false,caseSensitive:false,wholeWord:false,include:'src/**',exclude:'',},7);
assert.equal(results.generation,7); assert(results.matches.length>0);
await s().openRoot('C:\\'); assert.equal(s().activeRoot,'C:/');
await s().closeRoot('C:/'); await s().closeRoot(root);
assert.equal(s().roots.length,0);
console.log('Code smoke passed: helpers, all language loaders, preview/pinning, concurrent saves, fs reload/conflict/overwrite, CRUD, binary, search, roots.');




