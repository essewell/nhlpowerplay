import Link from "next/link";
import { cx, FOCUS_RING } from "./cx.ts";

/** Daily / Endless tile: a link card, title in Barlow 22 uppercase, 13/1.4 muted body, at least 104 high. */
export function ModeTile({
  href,
  title,
  body,
  className,
}: {
  href: string;
  title: string;
  body: string;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cx(
        "box-border flex min-h-[104px] flex-col gap-1.5 rounded-xl border border-border bg-surface p-4 text-text no-underline",
        FOCUS_RING,
        className,
      )}
    >
      <span className="font-display text-[22px] font-bold uppercase">{title}</span>
      <span className="text-[13px] leading-[1.4] text-text-muted">{body}</span>
    </Link>
  );
}
