// QuickJS is the script capability boundary; no host object or function enters its heap.
import releaseVariant from '@jitl/quickjs-wasmfile-release-sync';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import { transform } from 'sucrase';
import { makeFemProxy } from './script-api';

export const SCRIPT_MEMORY_BYTES = 64 * 1024 * 1024;
export const SCRIPT_MESSAGE_BYTES = 1024 * 1024;

const quickJs = newQuickJSWASMModuleFromVariant(releaseVariant);
const encoder = new TextEncoder();

const messageTooLarge = (text: string): boolean =>
  text.length > SCRIPT_MESSAGE_BYTES || encoder.encode(text).byteLength > SCRIPT_MESSAGE_BYTES;

// Guest JavaScript is data to the host runtime. Exercise this bootstrap through real QuickJS
// contexts in tests rather than evaluating it in the host JavaScript realm.
const bootstrap = String.raw`function bootstrap(proxy) {
  const emit = globalThis.__send;
  delete globalThis.__send;
  const send = (value) => emit(JSON.stringify(value));
  let next = 0;
  const pending = new Map();
  const timers = new Map();
  const rpc = (kind, value) => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    send({ kind, id, value });
  });
  const show = (v) => typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
  const plain = (v) => {
    try {
      return JSON.parse(JSON.stringify(v ?? null));
    } catch {
      return String(v);
    }
  };
  const log = (...args) => send({ kind: "log", value: args.map(show).join(" ") });
  Object.assign(globalThis, {
    fem: proxy((v) => rpc("dispatch", v), (v) => rpc("query", v)),
    console: { log, info: log, warn: log, error: log, debug: log },
    setTimeout: (callback, ms = 0, ...args) => {
      const id = ++next;
      timers.set(id, () => callback(...args));
      send({ kind: "timer", id, value: ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
    __receive: (reply) => {
      if (reply.timer) {
        const fn = timers.get(reply.id);
        timers.delete(reply.id);
        fn?.();
      } else {
        const p = pending.get(reply.id);
        pending.delete(reply.id);
        if (reply.error === void 0) p?.resolve(reply.value);
        else p?.reject(new Error(reply.error));
      }
    },
    __complete: (value) => send({ kind: "done", value: plain(value) }),
    __fail: (error) => {
      const e = error;
      send({ kind: "failed", value: { message: e?.message ?? String(error), stack: e?.stack } });
    }
  });
}`;

/** JSON is the only bridge. The owner must dispose this context, even on a timeout. */
export async function createScriptContext(code: string, send: (text: string) => void) {
  const vm = (await quickJs).newContext();
  vm.runtime.setMemoryLimit(SCRIPT_MEMORY_BYTES);
  vm.runtime.setMaxStackSize(512 * 1024);
  const emit = vm.newFunction('__send', (value) => {
    const text = vm.getString(value);
    if (messageTooLarge(text)) throw new Error('script message exceeds 1 MiB');
    send(text);
  });
  vm.setProp(vm.global, '__send', emit);
  emit.dispose();
  const evaluate = (source: string, file: string) => {
    vm.unwrapResult(vm.evalCode(source, file)).dispose();
    vm.unwrapResult(vm.runtime.executePendingJobs());
  };
  try {
    evaluate(`(${bootstrap})(${makeFemProxy.toString()})`, 'api.js');
    const js = transform(code, { transforms: ['typescript'] }).code;
    evaluate(`(async () => {\n${js}\n})().then(__complete).catch(__fail);`, 'script.js');
  } catch (error) {
    vm.dispose();
    throw error;
  }
  return {
    receive: (text: string) => evaluate(`__receive(${text})`, 'reply.js'),
    dispose: () => vm.dispose(),
  };
}
