/**
 * RunHost: owns ONE XState run actor (engine machine.ts) and turns it into RunSnapshot messages.
 * Thread ownership: it lives wherever it is constructed. In the browser that is the run Web Worker
 * (worker.ts); on the main-thread fallback (tests, SSR, no Worker) it is the same class behind the
 * same message interface (transport.ts). The actor is never shared or touched from another thread.
 *
 * Message protocol (plain JSON, structured-clone safe):
 *   main -> host: init {RunInit} | start | call {call, callIndex} | continue | formation {formation}
 *   host -> main: snapshot {RunSnapshot} after init and after EVERY event (even an ignored duplicate,
 *                 so the caller's `busy` always clears) | fatal {kind, message}
 * `formation` (intro only, before any call) rebuilds the run with another starting formation: it is part of the replay key.
 * Cost: one legalCalls() per paused snapshot, O(C x (D + R + S)); one applyCall per call.
 */
import { runMachine } from "@powerplay/engine/machine.ts";
import { legalCalls, replay } from "@powerplay/engine/sim.ts";
import type { Call, CallOption, PpFormationName, RunInput } from "@powerplay/engine/sim-types.ts";
import { createActor, type Actor } from "xstate";
import type { Mode, RunSnapshot } from "../contracts.ts";
import { V1_LOAD_OPTS, type DataSource } from "../data.ts";
import { toScenarioView } from "../view.ts";

export interface RunInit {
  mode: Mode;
  date: string | null;
  scenarioId: string;
  /** Run seed override (Endless, resume). null: use the scenario's own seed. */
  seed: number | null;
  /** Starting formation (RunInput.settings.formation). */
  formation: PpFormationName;
  /** Calls to replay before the actor starts (resume). */
  calls: Call[];
  /** Origin-relative URL of the exported data; the worker builds its own DataSource from it. */
  dataBase: string;
}

export type ToHost =
  | { type: "init"; init: RunInit }
  | { type: "start" }
  | { type: "call"; call: Call; callIndex: number }
  | { type: "continue" }
  | { type: "formation"; formation: PpFormationName };

export type FatalKind = "load" | "resume";
export type FromHost =
  | { type: "snapshot"; snapshot: RunSnapshot }
  | { type: "fatal"; kind: FatalKind; message: string };

type MachineState = RunSnapshot["machineState"];
const MACHINE_STATES: readonly MachineState[] = [
  "intro", "faceoffCall", "zoneEntryCall", "breakoutCall", "decision", "celebrating", "ended", "error",
];
const CALL_STATES: ReadonlySet<MachineState> = new Set(["faceoffCall", "zoneEntryCall", "breakoutCall", "decision"]);

export type CreateResult = { ok: true; value: RunHost } | { ok: false; kind: FatalKind; error: string };

type RunActor = Actor<typeof runMachine>;

export class RunHost {
  private readonly actor: RunActor;
  private readonly init: RunInit;
  private readonly loaded: { flags: RunSnapshot["flags"]; scenario: RunSnapshot["scenario"] };
  private readonly emit: (m: FromHost) => void;
  private readonly calls: Call[];

  private constructor(
    init: RunInit,
    loaded: { flags: RunSnapshot["flags"]; scenario: RunSnapshot["scenario"] },
    actor: RunActor,
    emit: (m: FromHost) => void,
  ) {
    this.init = init;
    this.loaded = loaded;
    this.actor = actor;
    this.emit = emit;
    this.calls = [...init.calls];
  }

  /**
   * Load the scenario, replay stored calls, start the actor. Err kind "load": data missing/invalid.
   * Kind "resume": the stored calls no longer replay (corrupt save, or the data changed).
   */
  static async create(init: RunInit, source: DataSource, emit: (m: FromHost) => void): Promise<CreateResult> {
    const run = await source.runInput(init.scenarioId, { ...V1_LOAD_OPTS, formation: init.formation });
    if (!run.ok) return { ok: false, kind: "load", error: run.error };
    const input: RunInput = init.seed === null ? run.value.loaded.input : { ...run.value.loaded.input, seed: init.seed };
    const state = replay(input, init.calls);
    if (!state.ok) {
      return { ok: false, kind: init.calls.length > 0 ? "resume" : "load", error: state.error };
    }
    const actor = createActor(runMachine, { input: { input, state: state.value } });
    actor.start();
    const host = new RunHost(
      init,
      { flags: run.value.loaded.flags, scenario: toScenarioView(run.value.scenario) },
      actor,
      emit,
    );
    return { ok: true, value: host };
  }

  /** Handle one non-init message; always answers with a snapshot. O(applyCall). */
  handle(msg: Exclude<ToHost, { type: "init" | "formation" }>): void {
    switch (msg.type) {
      case "start":
        this.actor.send({ type: "START" });
        break;
      case "call":
        this.actor.send({ type: "CALL", call: msg.call, callIndex: msg.callIndex });
        this.recordCall(msg.call);
        break;
      case "continue":
        this.actor.send({ type: "CONTINUE" });
        break;
    }
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  /** Auto-START a resumed run (it already passed the intro) and publish the first snapshot. */
  ready(): void {
    if (this.calls.length > 0) this.actor.send({ type: "START" });
    this.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  stop(): void {
    this.actor.stop();
  }

  /** True before the first START: the only moment the starting formation may change. */
  inIntro(): boolean {
    return this.calls.length === 0 && this.actor.getSnapshot().value === "intro";
  }

  get startedWith(): RunInit {
    return this.init;
  }

  /** Append the call only if the machine really applied it (duplicates and errors leave callCount alone). */
  private recordCall(call: Call): void {
    const applied = this.actor.getSnapshot().context.state.callCount;
    if (applied === this.calls.length + 1) this.calls.push(call);
  }

  snapshot(): RunSnapshot {
    const snap = this.actor.getSnapshot();
    const { input, state, error } = snap.context;
    const value = typeof snap.value === "string" ? snap.value : "";
    const machineState: MachineState = MACHINE_STATES.find((s) => s === value) ?? "error";
    let options: CallOption[] = [];
    let optionsError: string | null = null;
    if (CALL_STATES.has(machineState)) {
      const legal = legalCalls(state, input);
      if (legal.ok) options = legal.value;
      else optionsError = legal.error;
    }
    return {
      mode: this.init.mode,
      date: this.init.date,
      scenario: this.loaded.scenario,
      input,
      state,
      phase: state.phase,
      machineState: optionsError === null ? machineState : "error",
      options,
      calls: [...this.calls],
      flags: this.loaded.flags,
      error: error ?? optionsError,
      busy: false,
    };
  }
}

/**
 * Message router around one RunHost: serialises messages (an async init cannot be overtaken),
 * turns init failures into `fatal`, and ignores run messages that arrive before a host exists.
 * This is the object a worker or the main-thread fallback feeds.
 */
export class HostRunner {
  private host: RunHost | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly sources = new Map<string, DataSource>();
  private readonly makeSource: (dataBase: string) => DataSource;
  private readonly emit: (m: FromHost) => void;

  constructor(makeSource: (dataBase: string) => DataSource, emit: (m: FromHost) => void) {
    this.makeSource = makeSource;
    this.emit = emit;
  }

  receive(msg: ToHost): void {
    this.chain = this.chain.then(() => this.process(msg)).catch((e: unknown) => {
      this.emit({ type: "fatal", kind: "load", message: e instanceof Error ? e.message : String(e) });
    });
  }

  private async process(msg: ToHost): Promise<void> {
    if (msg.type === "init") {
      await this.start(msg.init);
      return;
    }
    if (msg.type === "formation") {
      const host = this.host;
      // Ignored once the run has left the intro; the answering snapshot below keeps the caller's view in step.
      if (host !== null && host.inIntro() && host.startedWith.formation !== msg.formation) {
        await this.start({ ...host.startedWith, formation: msg.formation });
      } else if (host !== null) {
        this.emit({ type: "snapshot", snapshot: host.snapshot() });
      }
      return;
    }
    this.host?.handle(msg);
  }

  private async start(init: RunInit): Promise<void> {
    this.host?.stop();
    this.host = null;
    const created = await RunHost.create(init, this.sourceFor(init.dataBase), this.emit);
    if (!created.ok) {
      this.emit({ type: "fatal", kind: created.kind, message: created.error });
      return;
    }
    this.host = created.value;
    created.value.ready();
  }

  /** One DataSource per base URL, so replays and "play again" reuse the cached export. */
  private sourceFor(dataBase: string): DataSource {
    let s = this.sources.get(dataBase);
    if (s === undefined) {
      s = this.makeSource(dataBase);
      this.sources.set(dataBase, s);
    }
    return s;
  }

  stop(): void {
    this.host?.stop();
    this.host = null;
  }
}
