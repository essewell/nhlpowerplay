"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { t } from "../../lib/copy.ts";
import { FOCUS_RING } from "../ui/cx.ts";

const LINKS = [
  { href: "/how-it-works", key: "nav.howItWorks" },
  { href: "/about", key: "nav.about" },
  { href: "/privacy", key: "footer.link.privacy" },
  { href: "/terms", key: "footer.link.terms" },
] as const;

const ICON_BUTTON =
  "flex size-touch shrink-0 items-center justify-center rounded-md border border-border bg-surface text-text " + FOCUS_RING;

/**
 * Menu button + modal sheet. A native dialog opened with showModal() gives the focus trap, Escape to
 * close, an inert page behind it and focus restore to the button for free. A press on the backdrop closes it.
 */
export function MenuSheet() {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        aria-label={t("home.menu")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className={ICON_BUTTON}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>
      <dialog
        ref={dialog}
        aria-labelledby={titleId}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialog.current) setOpen(false);
        }}
        className="m-0 mx-auto mt-auto w-full max-w-[390px] rounded-t-sheet border border-b-0 border-border bg-surface p-0 text-text backdrop:bg-black/60"
      >
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 id={titleId} className="m-0 font-display text-[28px] font-bold uppercase tracking-[0.04em]">
            {t("home.menu")}
          </h2>
          <button type="button" aria-label={t("action.close")} onClick={() => setOpen(false)} className={ICON_BUTTON}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 4l10 10M14 4L4 14" />
            </svg>
          </button>
        </div>
        <nav aria-label={t("home.menu")}>
          <ul className="m-0 flex list-none flex-col p-0 pb-4">
            {LINKS.map((link) => (
              <li key={link.href} className="border-t border-border">
                <Link
                  href={link.href}
                  className={`flex min-h-[52px] items-center px-5 text-base text-text no-underline ${FOCUS_RING}`}
                >
                  {t(link.key)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </dialog>
    </>
  );
}
