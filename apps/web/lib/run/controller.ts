/**
 * RunController: the framework-free brain behind `useRun`. It plans the run (plan.ts), starts a
 * transport (Worker or inline), mirrors snapshots as a Loadable, persists after every applied call,
 * and enforces the UI-side rules: one call in flight (`busy`, edge 9), calls only while paused.
 * The hook is a thin wrapper, so every rule here is tested without React.
 *
 * Thread ownership: main thread only; the actor itself lives in the transport's host.
 * Reentrancy: every async step checks `generation`, so a stale plan/message from a disposed or
 * restarted run is dropped.
 */
import type { Call } from "@powerplay/engine/sim-types.ts";
import type { Loadable, Mode, RunControls, RunSnapshot } from "../contracts.ts";
import type { DataSource } from "../data.ts";
import type { FromHost, RunInit } from "./host.ts";
import { clearRun, writeRun } from "./persistence.ts";
import { planRun, type PlanDeps, type PlanOpts, type RunPlan } from "./plan.ts";
import type { KeyValueStore } from "./store.ts";
import type { Transport } from "./transport.ts";

export interface ControllerDeps {
  store: KeyValueStore;
  source: DataSource;
  today: () => string;
  newSeed: () => number;
  /** Origin-relative data URL handed to the host (the worker builds its own source from it). */
  dataBase: string;
  makeTransport: () => Transport;
}

export interface RunControlsEx extends RunControls {
  /** Endless only: abandon/finish this run and start the next scenario from the queue. No-op for Daily. */
  playAgain(): void;
}

const LOADING: Loadable<RunSnapshot> = { status: "loading" };

export class RunController {
  private state: Loadable<RunSnapshot> = LOADING;
  private readonly listeners = new Set<(s: Loadable<RunSnapshot>) => void>();
  private transport: Transport | null = null;
  private generation = 0;
  private disposed = false;

  private readonly deps: ControllerDeps;
  private readonly mode: Mode;
  private readonly requestedId: string | null;
  private readonly planOpts: PlanOpts;

  constructor(deps: ControllerDeps, mode: Mode, requestedId: string | null, planOpts: PlanOpts = {}) {
    this.deps = deps;
    this.mode = mode;
    this.requestedId = requestedId;
    this.planOpts = planOpts;
  }

  // Arrow properties so they can be handed straight to useSyncExternalStore.
  getSnapshot = (): Loadable<RunSnapshot> => this.state;

  subscribe = (cb: (s: Loadable<RunSnapshot>) => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  readonly controls: RunControlsEx = {
    start: () => this.start(),
    call: (c) => this.call(c),
    continue: () => this.continueRun(),
    playAgain: () => this.playAgain(),
  };

  /** Plan and launch the run. Safe to call again (restarts). */
  async init(ignoreStored = false): Promise<void> {
    if (this.disposed) return;
    const gen = ++this.generation;
    this.teardownTransport();
    this.set(LOADING);
    const planDeps: PlanDeps = {
      store: this.deps.store, source: this.deps.source, today: this.deps.today, newSeed: this.deps.newSeed,
    };
    const plan = await planRun(this.mode, this.requestedId, planDeps, { ...this.planOpts, ignoreStored });
    if (gen !== this.generation) return;
    if (!plan.ok) {
      this.set({ status: "error", message: plan.error });
      return;
    }
    const transport = this.deps.makeTransport();
    this.transport = transport;
    transport.onMessage((m) => this.onMessage(gen, plan.value, m));
    transport.post({ type: "init", init: this.initFor(plan.value) });
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.teardownTransport();
    this.listeners.clear();
  }

  private initFor(plan: RunPlan): RunInit {
    return {
      mode: plan.mode, date: plan.date, scenarioId: plan.scenarioId, seed: plan.seed, calls: plan.calls,
      dataBase: this.deps.dataBase,
    };
  }

  private onMessage(gen: number, plan: RunPlan, m: FromHost): void {
    if (gen !== this.generation) return;
    if (m.type === "fatal") {
      if (m.kind === "resume" && plan.resumed) {
        // The save no longer replays (corrupt, or the export changed): drop it and start this scenario fresh.
        console.warn(`PowerPlay: saved run could not be restored (${m.message}); starting fresh.`);
        clearRun(this.deps.store, this.mode);
        void this.init(true);
        return;
      }
      this.set({ status: "error", message: m.message });
      return;
    }
    this.persist(m.snapshot);
    this.set({ status: "ready", value: m.snapshot });
  }

  /** The run state worth keeping: skip only the untouched intro (planning already saved that). */
  private persist(s: RunSnapshot): void {
    if (s.machineState === "intro" && s.calls.length === 0) return;
    writeRun(this.deps.store, {
      v: 1, mode: s.mode, date: s.date, scenarioId: s.scenario.id, seed: s.input.seed,
      calls: s.calls, ended: s.machineState === "ended",
    });
  }

  private ready(): RunSnapshot | null {
    return this.state.status === "ready" ? this.state.value : null;
  }

  private start(): void {
    const s = this.ready();
    if (s === null || s.machineState !== "intro") return;
    this.transport?.post({ type: "start" });
  }

  private call(call: Call): void {
    const s = this.ready();
    if (s === null || s.busy) return;
    if (s.machineState !== "decision" && s.machineState !== "faceoffCall"
      && s.machineState !== "zoneEntryCall" && s.machineState !== "breakoutCall") return;
    // Mark busy synchronously, before the reply: a second tap in the same frame is dropped here.
    this.set({ status: "ready", value: { ...s, busy: true } });
    this.transport?.post({ type: "call", call, callIndex: s.calls.length });
  }

  private continueRun(): void {
    const s = this.ready();
    if (s === null || s.machineState !== "celebrating") return;
    this.transport?.post({ type: "continue" });
  }

  private playAgain(): void {
    if (this.mode !== "endless" || this.disposed) return;
    clearRun(this.deps.store, "endless");
    void this.init();
  }

  private set(next: Loadable<RunSnapshot>): void {
    this.state = next;
    for (const l of [...this.listeners]) l(next);
  }

  private teardownTransport(): void {
    this.transport?.terminate();
    this.transport = null;
  }
}
