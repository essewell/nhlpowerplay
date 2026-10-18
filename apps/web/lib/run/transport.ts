/**
 * Transports carry ToHost / FromHost messages between the controller (main thread) and a RunHost.
 *  - WorkerTransport: the host lives in a Web Worker (worker.ts).
 *  - InlineTransport: the SAME host logic on the main thread (tests, SSR, no Worker, Worker blocked).
 * Both deliver replies asynchronously (never re-entrantly inside post()), so controller code behaves
 * identically on either path.
 */
import type { DataSource } from "../data.ts";
import { HostRunner, type FromHost, type ToHost } from "./host.ts";

export interface Transport {
  post(msg: ToHost): void;
  /** One listener; replaces any earlier one. */
  onMessage(cb: (m: FromHost) => void): void;
  terminate(): void;
}

/** Minimal Worker surface we use (lets tests pass a stub). */
export interface WorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

export class WorkerTransport implements Transport {
  private readonly worker: WorkerLike;

  constructor(worker: WorkerLike) {
    this.worker = worker;
  }

  post(msg: ToHost): void {
    this.worker.postMessage(msg);
  }

  onMessage(cb: (m: FromHost) => void): void {
    this.worker.onmessage = (e) => cb(e.data as FromHost);
    this.worker.onerror = (e) => cb({ type: "fatal", kind: "load", message: e.message || "run worker crashed" });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export class InlineTransport implements Transport {
  private listener: ((m: FromHost) => void) | null = null;
  private readonly runner: HostRunner;
  private dead = false;

  constructor(source: DataSource) {
    this.runner = new HostRunner(
      () => source,
      (m) => {
        // Deliver on a microtask: replies are never synchronous inside post().
        queueMicrotask(() => {
          if (!this.dead) this.listener?.(m);
        });
      },
    );
  }

  post(msg: ToHost): void {
    if (!this.dead) this.runner.receive(msg);
  }

  onMessage(cb: (m: FromHost) => void): void {
    this.listener = cb;
  }

  terminate(): void {
    this.dead = true;
    this.runner.stop();
  }
}
