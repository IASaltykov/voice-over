import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acquireWorkerLock } from '../src/worker-lock.mjs';
import { outputFilename, mainInternals } from '../src/main.mjs';
import { FragmentCache } from '../src/fragment-cache.mjs';
import { TtsQueue, validateQueueConfig } from '../src/tts-queue.mjs';
import { pdfInternals } from '../src/pdf.mjs';

test('cache lock prevents another worker and releases only its own lock', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const release = await acquireWorkerLock(root);
  await assert.rejects(() => acquireWorkerLock(root), /Another worker/);
  await release();
  await (await acquireWorkerLock(root))();
});

test('PDF retains consecutive and upper-margin headings', () => {
  const title = 'A long heading '.repeat(12).trim();
  const blocks = pdfInternals.markdownToBlocks(`# Chapter 1\n\n# ${title}\n\nBody`);
  assert.equal(blocks[0].title, `Chapter 1 ${title}`);
  const page = { width: 600, height: 800, lines: [{text:'Unique heading',y:760,x:40,size:20}, ...Array.from({length:6},(_,i)=>({text:`body ${i}`, y:700-i*20,x:40,size:10}))] };
  assert.match(pdfInternals.pageToMarkdown(page, new Set()).join('\n'), /Unique heading/);
});

test('generic filenames do not use book-specific index mappings', () => {
  assert.equal(outputFilename({index: 5, title:'Source title'}, {source:'Arrest-Proof-Yourself_RU_Original_Style.pdf',totalBlocks:35}), '05 Source title.mp3');
});

test('transient failures stop after configured attempts and preserve progress', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = validateQueueConfig({min_interval_ms:1,normal_jitter_max_ms:0,transient_max_attempts:2});
  const queue = new TtsQueue(config, {sleep:async()=>{}});
  const cache = new FragmentCache(root, {validateAudio: async()=>({valid:true})});
  let attempts=0;
  const settings={voice:'en-US-Test',rate:'+0%',cache:root,maxChars:100,minChars:1,retries:4,timeout:5,quality:'2',edgeQueue:config,edgeCircuit:{},environment:'test',sleep:async()=>{},synthesize:async()=>{attempts++;throw new Error('connection timeout');}};
  const manifest={source:'test.txt',totalBlocks:1,blocks:{}};
  const result=await mainInternals.speakBlock({index:1,title:'',text:'Hello.'},root,settings,manifest,path.join(root,'manifest.json'),path.join(root,'log'),queue,cache);
  assert.equal(result.status,'failed'); assert.equal(attempts,2);
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8')).progress['1'].status,'failed');
});

test('PDF joins adjacent text fragments without inventing spaces', () => {
  const items = [{str:'respons',transform:[10,0,0,10,10,100],width:35},{str:'ibility',transform:[10,0,0,10,45,100],width:25},{str:'matters',transform:[10,0,0,10,74,100],width:30}];
  assert.equal(pdfInternals.toPageLines({items},{width:600,height:800}).lines[0].text,'responsibility matters');
});

test('filename uses an explicit chapter number independent of block position', () => {
  const m={totalBlocks:35};
  assert.equal(outputFilename({index:21,title:'\u0413\u043b\u0430\u0432\u0430 17. Example'},m),'17 Example.mp3');
  assert.equal(outputFilename({index:21,title:'17 EXAMPLE'},m),'17 EXAMPLE.mp3');
});
