/**
 * Run Web Worker entry. OWNERSHIP: this worker owns exactly one XState run actor (inside a
 * HostRunner/RunHost); the main thread only sends messages and mirrors the snapshots it gets back.
 * Nothing here is shared. A new run = a new worker (the controller terminates the old one).
 * The worker loads its own data (fetch from the base URL it receives in `init`) and caches it for
 * the life of the worker.
 */
import { createDataSource } from "../data.ts";
import { HostRunner, type FromHost, type ToHost } from "./host.ts";

interface WorkerScope {
  onmessage: ((e: { data: ToHost }) => void) | null;
  postMessage(msg: FromHost): void;
}

const scope = self as unknown as WorkerScope;

const runner = new HostRunner(
  (dataBase) => createDataSource({ base: dataBase, fetchFn: (url) => fetch(url) }),
  (m) => scope.postMessage(m),
);

scope.onmessage = (e) => runner.receive(e.data);
