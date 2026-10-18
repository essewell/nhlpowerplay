/**
 * Run state machine (XState v5) around the pure simulation in sim.ts.
 *
 *   intro --START--> route
 *   route (transient): error > ended > celebrating > faceoffCall | zoneEntryCall | breakoutCall | decision
 *   *Call / decision --CALL{call, callIndex}--> route   (applyCall; duplicates ignored, gaps -> error)
 *   celebrating --CONTINUE--> route                      (after a PP goal; sim already set a centre faceoff)
 *   ended, error: final
 *
 * All game logic lives in sim.ts; this file only routes events, so the server can score a run with
 * sim.replay() and get the same state as the actor. No timers or delays.
 *
 * Ownership: one actor per run, owned by a single Web Worker (browser) or a single request (server).
 * The machine definition itself is immutable and shareable. Every transition is O(applyCall).
 */
import { assign, setup } from "xstate";
import { applyCall } from "./sim.ts";
import type { Call, RunInput, RunState } from "./sim-types.ts";

export interface RunContext {
  input: RunInput;
  state: RunState;
  error: string | null;
  /** callCount at which the last PP goal was acknowledged with CONTINUE (-1 = none). */
  celebratedAt: number;
}

export type RunMachineEvent =
  | { type: "START" }
  | { type: "CALL"; call: Call; callIndex: number }
  | { type: "CONTINUE" };

/** Actor input: the run input plus its initial state (initRun, or replay for a resumed run). */
export interface RunMachineInput { input: RunInput; state: RunState }

const isCall = (e: RunMachineEvent): e is Extract<RunMachineEvent, { type: "CALL" }> => e.type === "CALL";

export const runMachine = setup({
  types: {
    context: {} as RunContext,
    events: {} as RunMachineEvent,
    input: {} as RunMachineInput,
  },
  guards: {
    hasError: ({ context }) => context.error !== null,
    isEnded: ({ context }) => context.state.phase.kind === "ended",
    needsCelebration: ({ context }) =>
      context.state.justScored && context.celebratedAt !== context.state.callCount,
    isFaceoff: ({ context }) => context.state.phase.kind === "faceoff",
    isZoneEntry: ({ context }) => context.state.phase.kind === "zone_entry",
    isBreakout: ({ context }) => context.state.phase.kind === "breakout",
    isDecision: ({ context }) => context.state.phase.kind === "decision",
    // Edge 9 (double tap): the second CALL carries an index that was already applied. Only integer
    // indices count as duplicates; a malformed index (e.g. -0.5) must reach isGap and error.
    isDuplicate: ({ context, event }) =>
      isCall(event) && Number.isInteger(event.callIndex) && event.callIndex < context.state.callCount,
    isGap: ({ context, event }) =>
      isCall(event) && (!Number.isInteger(event.callIndex) || event.callIndex > context.state.callCount),
  },
  actions: {
    apply: assign(({ context, event }) => {
      if (!isCall(event)) return {};
      const r = applyCall(context.state, context.input, event.call, event.callIndex);
      return r.ok ? { state: r.value } : { error: r.error };
    }),
    gapError: assign(({ context, event }) => ({
      error: isCall(event)
        ? `call index ${event.callIndex} does not follow ${context.state.callCount}`
        : "unexpected event",
    })),
    acknowledgeGoal: assign(({ context }) => ({ celebratedAt: context.state.callCount })),
    unroutable: assign(({ context }) => ({ error: `no route for phase ${context.state.phase.kind}` })),
  },
}).createMachine({
  id: "run",
  context: ({ input }) => ({ input: input.input, state: input.state, error: null, celebratedAt: -1 }),
  initial: "intro",
  states: {
    intro: { on: { START: "route" } },
    route: {
      always: [
        { guard: "hasError", target: "error" },
        { guard: "isEnded", target: "ended" },
        { guard: "needsCelebration", target: "celebrating" },
        { guard: "isFaceoff", target: "faceoffCall" },
        { guard: "isZoneEntry", target: "zoneEntryCall" },
        { guard: "isBreakout", target: "breakoutCall" },
        { guard: "isDecision", target: "decision" },
        { target: "error", actions: "unroutable" },
      ],
    },
    faceoffCall: { on: { CALL: callTransitions() } },
    zoneEntryCall: { on: { CALL: callTransitions() } },
    breakoutCall: { on: { CALL: callTransitions() } },
    decision: { on: { CALL: callTransitions() } },
    celebrating: { on: { CONTINUE: { target: "route", actions: "acknowledgeGoal" } } },
    ended: { type: "final" },
    error: { type: "final" },
  },
});

function callTransitions() {
  return [
    { guard: "isDuplicate" as const },                                  // ignored: one call recorded
    { guard: "isGap" as const, target: "error", actions: "gapError" as const },
    { target: "route", actions: "apply" as const },
  ];
}
