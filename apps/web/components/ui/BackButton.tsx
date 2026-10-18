import Link from "next/link";
import { t } from "../../lib/copy.ts";
import { cx, FOCUS_RING } from "./cx.ts";

const CLASSES =
  "flex size-touch shrink-0 items-center justify-center rounded-md border border-border bg-surface text-text " +
  FOCUS_RING;

const Chevron = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M11 3L5 9l6 6" />
  </svg>
);

type Props = { label?: string; className?: string } & (
  | { href: string; onClick?: undefined }
  | { onClick: () => void; href?: undefined }
);

/** 44 x 44 back control, r12. A link when `href` is given, else a button. */
export function BackButton({ label, className, href, onClick }: Props) {
  const name = label ?? t("action.back");
  if (href !== undefined) {
    return (
      <Link href={href} aria-label={name} className={cx(CLASSES, className)}>
        <Chevron />
      </Link>
    );
  }
  return (
    <button type="button" onClick={onClick} aria-label={name} className={cx(CLASSES, className)}>
      <Chevron />
    </button>
  );
}
