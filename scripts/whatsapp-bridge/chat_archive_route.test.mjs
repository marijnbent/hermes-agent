import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function harness(chatModify, timeoutMs=15) {
  const source = readFileSync(new URL('./bridge.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("app.post('/chats/:id/archive'"), source.indexOf('// Chat info'));
  let handler;
  const pending = new Map();
  const timers = new Set();
  const chat = { id: 'group@g.us', latestMessage: { id: 'm1', timestamp: 20, fromMe: true, participant: 'self@lid' } };
  vm.runInNewContext(route, {
    app: { post(_path, fn) { handler=fn; } },
    sock: { chatModify: (...args) => chatModify(pending,...args) }, connectionState:'connected',
    chatInventory: { canArchive: (_id, expected) => expected?.id==='m1' && expected.timestamp===20, get: () => chat },
    pendingChatUpdates:pending,
    setTimeout: (fn) => { const timer=setTimeout(fn,timeoutMs); timers.add(timer); return timer; },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); },
  });
  const res={ statusCode:200, status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;} };
  return { pending,timers,res, call: (payload={archived:true,expectedLatestMessage:{id:'m1',timestamp:20}}) => handler({params:{id:chat.id},body:payload},res) };
}

test('archive sends message range and requires matching confirmation', async()=>{
  const h=harness(async(pending,mod,id)=>{
    assert.equal(id,'group@g.us');
    assert.equal(mod.archive,true);
    assert.equal(mod.lastMessages[0].key.fromMe,true);
    assert.equal(mod.lastMessages[0].key.participant,'self@lid');
    assert.equal(mod.lastMessages[0].messageTimestamp,20);
    const waiter=pending.get(id)[0];
    clearTimeout(waiter.timer);
    waiter.resolve({id,archived:true});
  });
  await h.call();
  assert.equal(h.res.statusCode,200);
  assert.equal(h.res.body.confirmed,true);
  assert.equal(h.res.body.chat.archived,true);
});

test('invalid explicit state and stale anchors never call chatModify',async()=>{
  let calls=0;
  const h=harness(async()=>{calls++;});
  await h.call({archived:'true',expectedLatestMessage:{id:'m1',timestamp:20}});
  assert.equal(h.res.statusCode,400);
  await h.call({archived:true,expectedLatestMessage:{id:'older',timestamp:19}});
  assert.equal(h.res.statusCode,409);
  assert.equal(calls,0);
});

test('slow chatModify handles confirmation timeout without unhandled rejection', async()=>{
  const h=harness(async()=>{await new Promise(resolve=>setTimeout(resolve,40));},5);
  await h.call();
  assert.equal(h.res.statusCode,504);
  assert.equal(h.res.body.confirmed,false);
  assert.equal(h.pending.get('group@g.us').length,0);
});

test('archive API failure cancels its confirmation timer', async()=>{
  const h=harness(async()=>{throw new Error('transport failed');});
  await h.call();
  assert.equal(h.res.statusCode,502);
  assert.equal(h.pending.get('group@g.us').length,0);
  // Clear test timers even on failure, avoiding unrelated test-process rejection.
  const left=h.timers.size;
  for(const timer of h.timers) clearTimeout(timer);
  assert.equal(left,0);
});
