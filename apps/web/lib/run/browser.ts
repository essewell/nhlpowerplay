/**
 * Browser wiring for RunController: real localStorage, crypto seeds, the Vancouver clock, and the
 * run Web Worker. Kept apart from controller.ts so tests never construct a Worker.
 */
import { DATA_BASE, defaultSource } from "../data.ts";
import { vancouverDate } from "../daily.ts";
import type { ControllerDeps } from "./controller.ts";
import { createBrowserStore, createMemoryStore } from "./store.ts";
import { InlineTransport, WorkerTransport, type Transport } from "./transport.ts";

const UINT32_COUNT = 1;

/** Random uint32 from the platform CSPRNG (the web layer may use it; the engine may not). */
export function randomSeed(): number {
  const buf = new Uint32Array(UINT32_COUNT);
  crypto.getRandomValues(buf);
  return buf[0] ?? 0;
}

function makeTransport(): Transport {
  const source = defaultSource();
  if (typeof Worker === "undefined") return new InlineTransport(source);
  try {
    // The literal `new Worker(new URL(...))` form is what lets the bundler emit the worker chunk.
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    return new WorkerTransport(worker);
  } catch (e) {
    console.warn(`PowerPlay: Web Worker unavailable, running on the main thread: ${e instanceof Error ? e.message : String(e)}`);
    return new InlineTransport(source);
  }
}

let store: ReturnType<typeof createBrowserStore> | null = null;

/** Browser store, created on first use (never at import time, so SSR stays quiet). */
export function browserStore(): ReturnType<typeof createBrowserStore> {
  store ??= typeof window === "undefined" ? createMemoryStore() : createBrowserStore();
  return store;
}

export function browserDeps(): ControllerDeps {
  return {
    store: browserStore(),
    source: defaultSource(),
    today: () => vancouverDate(new Date()),
    newSeed: randomSeed,
    dataBase: DATA_BASE,
    makeTransport,
  };
}
