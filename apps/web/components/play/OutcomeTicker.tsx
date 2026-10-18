"use client";

/**
 * "What just happened" card shown on the pause screen after a call (decision, zone entry, faceoff) and on the
 * celebration / ended screens. Non-blocking: pointer-events-none, no tap needed, never takes focus.
 *  - Tone is shown by icon shape + a word + a border colour, never by colour alone.
 *  - Time chip "-0:12" is the game clock the call consumed (aria-label spells it out).
 *  - aria-live="polite": the region is always mounted, its content is swapped when a new outcome arrives.
 *  - `persist` (goal, run ended) keeps the card up; otherwise it fades after FADE_AFTER_MS and is removed.
 *    With prefers-reduced-motion it simply disappears (no transition).
 * Fixed under the scoreboard for the celebration / ended screens; `inline` puts it in a call sheet's flow.
 * UI thread only. State is two timer-set keys, so a new outcome (new `outcomeKey`) re-shows the card.
 */
import { useEffect, useState } from "react";
import { cx } from "../ui/cx.ts";
import { formatOffClock, type Narration, type NarrationTone } from "../../lib/play/narrate.ts";
import { fillCopy, type PlayCopyKey } from "../../lib/play/strings.ts";

/** How long a non-persistent card stays before it starts to fade. */
const FADE_AFTER_MS = 6000;
/** Matches the duration-300 class below. */
const FADE_MS = 300;

const TONE_STYLE: Record<NarrationTone, { border: string; text: string; word: PlayCopyKey }> = {
  good: { border: "border-l-grade-best", text: "text-grade-best", word: "narrate.tone.good" },
  bad: { border: "border-l-grade-costly", text: "text-grade-costly", word: "narrate.tone.bad" },
  neutral: { border: "border-l-border-strong", text: "text-text-muted", word: "narrate.tone.neutral" },
  goal: { border: "border-l-accent", text: "text-accent", word: "narrate.tone.goal" },
  against: { border: "border-l-grade-miss", text: "text-text", word: "narrate.tone.against" },
};

/** Distinct shape per tone: check, cross, dot, star, warning triangle. */
function ToneIcon({ tone }: { tone: NarrationTone }) {
  const common = { width: 16, height: 16, viewBox: "0 0 16 16", "aria-hidden": true, className: "shrink-0", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (tone) {
    case "good":
      return <svg {...common}><path d="M3 8.5l3.2 3L13 4.5" /></svg>;
    case "bad":
      return <svg {...common}><path d="M4 4l8 8M12 4l-8 8" /></svg>;
    case "goal":
      return <svg {...common}><path d="M8 1.8l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.4l-3.9 2.2.9-4.3-3.2-3 4.3-.5z" fill="currentColor" /></svg>;
    case "against":
      return <svg {...common}><path d="M8 2l6.5 11.5h-13z" /><path d="M8 6.5v3M8 11.6v.1" /></svg>;
    case "neutral":
      return <svg {...common}><circle cx="8" cy="8" r="3" fill="currentColor" /></svg>;
  }
}

export interface OutcomeTickerProps {
  /** null hides the card. */
  narration: Narration | null;
  /** Changes whenever a new outcome should be (re)shown, e.g. the call count. */
  outcomeKey: string;
  /** Keep the card up until the screen changes (goal, end of run). */
  persist?: boolean;
  /**
   * In normal flow (inside a call sheet) instead of fixed over the screen. It stays until the next call, so
   * the layout never shifts after the screen has settled, and it is aria-hidden: OutcomeLayer's always-mounted
   * live region announces it (this card remounts with every sheet, which screen readers would not announce).
   */
  inline?: boolean;
}

export function OutcomeTicker({ narration, outcomeKey, persist = false, inline = false }: OutcomeTickerProps) {
  const sticky = persist || inline;
  const [fadingKey, setFadingKey] = useState<string | null>(null);
  const [goneKey, setGoneKey] = useState<string | null>(null);
  const active = narration !== null && narration.lines.length > 0;

  useEffect(() => {
    if (!active || sticky) return;
    const fade = window.setTimeout(() => setFadingKey(outcomeKey), FADE_AFTER_MS);
    const gone = window.setTimeout(() => setGoneKey(outcomeKey), FADE_AFTER_MS + FADE_MS);
    return () => {
      window.clearTimeout(fade);
      window.clearTimeout(gone);
    };
  }, [active, sticky, outcomeKey]);

  const visible = active && (sticky || goneKey !== outcomeKey);
  const fading = !sticky && fadingKey === outcomeKey;
  const style = narration !== null ? TONE_STYLE[narration.tone] : TONE_STYLE.neutral;

  const card =
    visible && narration !== null ? (
      <div
        className={cx(
          "flex items-start gap-3 rounded-lg border border-l-4 border-border bg-surface-raised px-3 py-2",
          inline ? "" : "shadow-pop",
          "motion-safe:transition-opacity motion-safe:duration-300",
          style.border,
          fading ? "opacity-0" : "opacity-100",
        )}
      >
        <span className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.08em] text-text-soft">
          <span className={style.text}>
            <ToneIcon tone={narration.tone} />
          </span>
          {fillCopy(style.word)}
        </span>
        <ul className="m-0 flex min-w-0 flex-1 list-none flex-col gap-0.5 p-0 text-[14px] leading-snug text-text">
          {narration.lines.map((line, i) => (
            <li key={`${i}-${line.text}`}>{line.text}</li>
          ))}
        </ul>
        {narration.elapsedS > 0 ? (
          <span
            aria-label={fillCopy("narrate.elapsed.aria", { clock: formatOffClock(narration.elapsedS) })}
            className="shrink-0 rounded-chip bg-surface-sunk px-1.5 py-0.5 font-display text-sm font-bold tabular-nums text-text-soft"
          >
            {fillCopy("narrate.elapsed", { clock: formatOffClock(narration.elapsedS) })}
          </span>
        ) : null}
      </div>
    ) : null;

  if (inline) {
    return card === null ? null : (
      <div aria-hidden="true" data-testid="outcome-ticker">
        {card}
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[76px] z-30 mx-auto w-full max-w-[430px] px-4" data-testid="outcome-ticker">
      <div role="status" aria-live="polite" aria-atomic="true">
        {card}
      </div>
    </div>
  );
}
