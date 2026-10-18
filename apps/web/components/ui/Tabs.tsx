"use client";

import { useRef } from "react";
import type { KeyboardEvent } from "react";
import { cx, FOCUS_RING } from "./cx.ts";
import { nextTabIndex } from "./logic.ts";

export type TabItem = { id: string; label: string };

/**
 * Tablist: 44 high, r10, Barlow 17 uppercase. Active tab = 2 px accent border on surface-raised.
 * Controlled (`value` + `onChange`). Arrow keys, Home and End move focus and selection (roving tabindex).
 * Panels should use id `${idPrefix}-panel-${tab.id}` and aria-labelledby `${idPrefix}-tab-${tab.id}`.
 * UI-thread only; no timers.
 */
export function Tabs({
  tabs,
  value,
  onChange,
  idPrefix,
  label,
  className,
}: {
  tabs: readonly TabItem[];
  value: string;
  onChange: (id: string) => void;
  idPrefix: string;
  label: string;
  className?: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const current = Math.max(
    0,
    tabs.findIndex((tab) => tab.id === value),
  );

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const next = nextTabIndex(index, e.key, tabs.length);
    if (next === null) return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cx("grid gap-1.5", className)}
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
    >
      {tabs.map((tab, i) => {
        const active = i === current;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${tab.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cx(
              "box-border h-touch rounded-sm px-0 font-display text-[17px] font-bold uppercase",
              active
                ? "border-2 border-accent bg-surface-raised text-white"
                : "border border-border bg-surface-sunk text-text-soft",
              FOCUS_RING,
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
