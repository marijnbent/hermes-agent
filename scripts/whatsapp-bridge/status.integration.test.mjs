import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStatusRouter } from './status.js';
import { spawnSync } from 'node:child_process';

test('CLI refuses another account bridge or remote destination before network', () => {
  for (const bridge of ['http://127.0.0.1:3000', 'http://example.com:3001']) {
    const result = spawnSync(process.execPath, [new URL('./whatsapp-status.mjs', import.meta.url).pathname, '--bridge', bridge, '--audience', '31612345678@s.whatsapp.net', '--text', 'x', '--key', 'test'], {encoding:'utf8',timeout:3000});
    assert.equal(result.status,2);
  }
});
const request = {text:'literal * text', audience:['31612345678@s.whatsapp.net'], idempotencyKey:'one'};

test('concurrent identical requests both acknowledge the single send', async () => {
  let release, calls = 0;
  const wait = new Promise(resolve => {release=resolve;});
  const router = createStatusRouter({isEnabled:()=>true, isConnected:()=>true, sendStatus:async()=>{calls++; await wait; return {key:{id:'provider-id'}};}});
  const first = router.publish(request);
  const second = router.publish(request);
  release();
  const results = await Promise.all([first,second]);
  assert.deepEqual(results.map(r=>r.status), [200,200]);
  assert.equal(calls,1);
});

test('disconnected preflight does not burn the idempotency key', async () => {
  let connected=false, calls=0;
  const router = createStatusRouter({isEnabled:()=>true,isConnected:()=>connected,sendStatus:async()=>({key:{id:String(++calls)}})});
  assert.equal((await router.publish(request)).status,503);
  connected=true;
  assert.equal((await router.publish(request)).status,200);
  assert.equal(calls,1);
});

test('HTTP POST and exact GET use the router and disabled GET fails closed', async t => {
  let enabled=true;
  const app=express(); app.use(express.json());
  app.use('/status',createStatusRouter({isEnabled:()=>enabled,isConnected:()=>true,sendStatus:async()=>({key:{id:'http-provider-id'}})}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/status`;
  const sent=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request)});
  assert.equal(sent.status,200);
  const read=await fetch(`${url}/one`);
  assert.equal((await read.json()).messageId,'http-provider-id');
  enabled=false;
  assert.equal((await fetch(`${url}/one`)).status,404);
});
