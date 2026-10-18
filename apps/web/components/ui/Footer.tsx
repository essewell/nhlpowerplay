import Link from "next/link";
import { t } from "../../lib/copy.ts";
import { FOCUS_RING } from "./cx.ts";

const LINKS = [
  { href: "/how-it-works", key: "nav.howItWorks" },
  { href: "/about", key: "nav.about" },
  { href: "/privacy", key: "footer.link.privacy" },
  { href: "/terms", key: "footer.link.terms" },
] as const;

/** Site footer: non-affiliation notice (docs/LAUNCH.md) and the four static-page links, 44 px targets. */
export function Footer() {
  return (
    <footer className="mx-auto flex w-full max-w-[390px] flex-col items-center gap-1 px-4 pb-6 pt-3">
      <p className="m-0 text-center text-xs leading-[1.4] text-text-muted">{t("footer.notice")}</p>
      <nav aria-label={t("footer.nav.label")}>
        <ul className="m-0 flex list-none flex-wrap justify-center p-0">
          {LINKS.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                className={`flex min-h-touch items-center px-2.5 text-[13px] text-pp underline-offset-2 hover:text-white ${FOCUS_RING}`}
              >
                {t(link.key)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </footer>
  );
}
