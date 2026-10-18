import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx.ts";

type Props = Omit<HTMLAttributes<HTMLElement>, "className" | "children"> & {
  as?: "div" | "section" | "article" | "li";
  /** "lg" = r16 (default), "home" = r18 Home Daily card, "banner" = r20 Results banner. */
  radius?: "lg" | "home" | "banner";
  padded?: boolean;
  className?: string;
  children: ReactNode;
};

const RADIUS = { lg: "rounded-xl", home: "rounded-card", banner: "rounded-banner" } as const;

/** Surface card: surface fill, 1 px border, r16, 16 px padding. */
export function Card({ as: Tag = "div", radius = "lg", padded = true, className, children, ...rest }: Props) {
  return (
    <Tag className={cx("border border-border bg-surface", RADIUS[radius], padded && "p-4", className)} {...rest}>
      {children}
    </Tag>
  );
}
