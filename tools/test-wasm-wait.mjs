#!/usr/bin/env node
// Execute the compiled Rust backend with real shared memory and independent Node worker agents.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) {
  const instance = await WebAssembly.instantiate(workerData.module, { env: { memory: workerData.memory } });
  parentPort.on('message', ({ id, expected }) => {
    parentPort.postMessage({ id, phase: 'enter' });
    instance.exports.wait(expected);
    parentPort.postMessage({ id, phase: 'return' });
  });
  parentPort.postMessage({ phase: 'ready' });
} else {
  const module = await WebAssembly.compile(readFileSync(process.argv[2]));
  const memory = new WebAssembly.Memory({ initial: 2, maximum: 65536, shared: true });
  const instance = await WebAssembly.instantiate(module, { env: { memory } });
  const workers = [];
  const requests = new Map();
  let sequence = 0;
  try {
    for (let index = 0; index < 3; index++) {
      const worker = new Worker(new URL(import.meta.url), { workerData: { module, memory } });
      workers.push(worker);
      await new Promise((resolve, reject) => {
        worker.once('error', reject);
        worker.on('message', data => {
          if (data.phase === 'ready') resolve();
          else {
            const request = requests.get(data.id);
            if (data.phase === 'enter') request.enter();
            else { request.returned = true; request.done(); }
          }
        });
      });
    }
    const wait = (worker, expected) => {
      const id = ++sequence;
      let enter, done;
      const entered = new Promise(resolve => { enter = resolve; });
      const completed = new Promise(resolve => { done = resolve; });
      const request = { enter, done, returned: false, entered, completed };
      requests.set(id, request);
      worker.postMessage({ id, expected });
      return request;
    };
    const deadline = async (promise) => {
      let timeout;
      try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('WASM wait/wake did not complete')), 5000); })]); }
      finally { clearTimeout(timeout); }
    };
    // The expected-value check is part of the wait instruction: a mismatch must return.
    instance.exports.store(0);
    await deadline(wait(workers[0], 1).completed);
    for (const address of [0, instance.exports.address() + 1, 0xfffffffc, instance.exports.address() + 4]) {
      instance.exports.notify_invalid(address); // Safe API must not trap, even for dangling/null addresses.
    }
    for (const all of [false, true]) {
      const expected = all ? 0 : 0x80000000;
      instance.exports.store(expected);
      const pending = workers.map(worker => wait(worker, expected));
      await deadline(Promise.all(pending.map(request => request.entered)));
      // A condition check, not a throughput/timing benchmark: matching waits must remain blocked.
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(pending.every(request => !request.returned), 'wait returned before notification');
      if (all) instance.exports.wake_all();
      else {
        instance.exports.wake_one();
        await deadline(Promise.race(pending.map(request => request.completed)));
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(pending.filter(request => request.returned).length, 1, 'wake-one must wake exactly one waiting agent');
        instance.exports.store(1);
        instance.exports.wake_all();
      }
      await deadline(Promise.all(pending.map(request => request.completed)));
    }
    console.log('Actual Rust WASM wait: unequal value, safe invalid notifications, wake-one and three-agent wake-all PASS.');
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
}
