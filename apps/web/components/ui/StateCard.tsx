import type { ReactNode } from "react";
import { cx } from "./cx.ts";
import { Button } from "./Button.tsx";

type Action = { label: string; onClick?: () => void; href?: string };

type Props = {
  kind: "empty" | "error";
  /** "inline" = a row inside a sheet (v2 Rink states). "screen" = a full card (v2 Home states). */
  size?: "inline" | "screen";
  title?: string;
  body?: string;
  action?: Action;
  className?: string;
  children?: ReactNode;
};

/**
 * Empty and error states. Empty: dashed border-strong box. Error: role="alert" card with an optional
 * retry action. Copy comes from the caller (lib/copy.ts), never from here.
 */
export function StateCard({ kind, size = "inline", title, body, action, className, children }: Props) {
  const screen = size === "screen";
  const shell =
    kind === "empty" && !screen
      ? "rounded-md border border-dashed border-border-strong bg-surface-sunk px-4 py-[18px]"
      : screen
        ? "rounded-card border border-border bg-surface px-[18px] pb-[18px] pt-[22px]"
        : "rounded-md border border-border bg-surface-sunk p-4";

  return (
    <div role={kind === "error" ? "alert" : undefined} className={cx("flex flex-col gap-1.5", shell, screen && "gap-2.5", className)}>
      {title ? (
        screen ? (
          <div className="font-display text-[28px] font-bold uppercase tracking-[0.04em]">{title}</div>
        ) : (
          <div className="text-[15px] font-semibold">{title}</div>
        )
      ) : null}
      {body ? (
        <div className={screen || kind === "empty" ? "text-sm leading-[1.45] text-text-soft" : "text-[13px] leading-[1.45] text-text-muted"}>
          {body}
        </div>
      ) : null}
      {children}
      {action ? (
        action.href !== undefined ? (
          <Button href={action.href} variant={screen ? "primary" : "compact"} className="mt-1.5">
            {action.label}
          </Button>
        ) : (
          <Button onClick={action.onClick} variant={screen ? "primary" : "compact"} className="mt-1.5">
            {action.label}
          </Button>
        )
      ) : null}
    </div>
  );
}
