import Link from "next/link";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";
import { cx, FOCUS_RING } from "./cx.ts";

/** primary 56h r14 accent; compact 48h r12 accent; secondary 48h r12 surface + border (DESIGN.md v2). */
export type ButtonVariant = "primary" | "compact" | "secondary";

const BASE =
  "inline-flex shrink-0 items-center justify-center text-center no-underline transition-colors " +
  "disabled:cursor-not-allowed disabled:bg-surface-raised disabled:text-text-muted " +
  FOCUS_RING;

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "h-14 rounded-lg bg-accent px-5 font-display text-[22px] font-bold uppercase tracking-[0.06em] text-on-accent",
  compact:
    "h-12 rounded-md bg-accent px-5 font-display text-[19px] font-bold uppercase tracking-[0.06em] text-on-accent",
  secondary: "h-12 rounded-md border border-border bg-surface px-5 font-body text-sm font-semibold text-text",
};

type CommonProps = { variant?: ButtonVariant; fullWidth?: boolean; className?: string; children: ReactNode };
type ButtonAsButton = CommonProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "children"> & { href?: undefined };
type ButtonAsLink = CommonProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children" | "href"> & {
    href: string;
    disabled?: undefined;
  };
export type ButtonProps = ButtonAsButton | ButtonAsLink;

/** Button, or a Next link styled as one when `href` is set. Disabled buttons keep their 56/48 height. */
export function Button(props: ButtonProps) {
  const { variant = "primary", fullWidth = true, className, children, ...rest } = props;
  const classes = cx(BASE, VARIANT[variant], fullWidth && "w-full", className);
  if (props.href !== undefined) {
    const { href, ...anchorRest } = rest as Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className" | "children">;
    return (
      <Link href={href ?? ""} className={classes} {...anchorRest}>
        {children}
      </Link>
    );
  }
  const { href: _unused, ...buttonRest } = rest as ButtonHTMLAttributes<HTMLButtonElement> & { href?: undefined };
  void _unused;
  return (
    <button type="button" className={classes} {...buttonRest}>
      {children}
    </button>
  );
}
