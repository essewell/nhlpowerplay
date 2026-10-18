import type { ReactNode } from "react";
import { rawCopy, t } from "../../../lib/copy.ts";
import type { CopyKey } from "../../../lib/copy.ts";
import { formatLegalDate, SITE_CONFIG } from "../../../lib/site.ts";
import { PageShell, SectionHeading } from "./PageShell.tsx";
import { TemplateText, TodoValue } from "./TemplateText.tsx";

/** {date} and {contactEmail} slots. Unset values render a visible TODO from lib/copy.ts, never an invented value. */
function legalSlots(): Record<string, ReactNode> {
  const date = formatLegalDate(SITE_CONFIG.legalUpdated);
  const email = SITE_CONFIG.contactEmail;
  return {
    date: date ?? <TodoValue>{t("site.pending.date")}</TodoValue>,
    contactEmail: email ? (
      <a href={`mailto:${email}`} className="text-pp underline underline-offset-2 hover:text-white">
        {email}
      </a>
    ) : (
      <TodoValue>{t("site.pending.email")}</TodoValue>
    ),
  };
}

const BODY = "m-0 text-sm leading-normal text-text-soft [text-wrap:pretty]";

function PolicySection({ title, body, slots }: { title: CopyKey; body: CopyKey; slots: Record<string, ReactNode> }) {
  return (
    <section className="flex flex-col gap-2">
      <SectionHeading>{t(title)}</SectionHeading>
      <p className={BODY}>
        <TemplateText copyKey={body} slots={slots} />
      </p>
    </section>
  );
}

/** Privacy (COPY.md section 8). Accurate only while v1 has no accounts, backend, analytics or ads. */
export function PrivacyView() {
  const slots = legalSlots();
  return (
    <PageShell title={t("privacy.title")}>
      <p className="m-0 text-[13px] text-text-muted">
        <TemplateText copyKey="privacy.updated" slots={slots} />
      </p>
      <p className="m-0 text-[15px] leading-[1.55] text-text-soft [text-wrap:pretty]">{t("privacy.intro")}</p>
      <PolicySection title="privacy.device.title" body="privacy.device.body" slots={slots} />
      <PolicySection title="privacy.host.title" body="privacy.host.body" slots={slots} />
      <PolicySection title="privacy.never.title" body="privacy.never.body" slots={slots} />
      <PolicySection title="privacy.kids.title" body="privacy.kids.body" slots={slots} />
      <PolicySection title="privacy.contact.title" body="privacy.contact.body" slots={slots} />
    </PageShell>
  );
}

const TERM_ITEMS = [1, 2, 3, 4, 5, 6, 7] as const;

/** Terms of use (COPY.md section 9). Includes the non-affiliation notice as item 1 (docs/LAUNCH.md). */
export function TermsView() {
  const slots = legalSlots();
  return (
    <PageShell title={t("terms.title")}>
      <p className="m-0 text-[13px] text-text-muted">
        <TemplateText copyKey="terms.updated" slots={slots} />
      </p>
      <ol className="m-0 flex list-none flex-col gap-3.5 p-0">
        {TERM_ITEMS.map((n) => {
          const title = `terms.item${n}.title` as const;
          const body = `terms.item${n}.body` as const;
          return (
            <li key={n} className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2">
              <span aria-hidden="true" className="font-display text-lg font-bold leading-5 text-accent">
                {n}
              </span>
              <p className={BODY}>
                <strong className="font-semibold text-text">{t(title)}</strong>{" "}
                {rawCopy(body).includes("{") ? <TemplateText copyKey={body} slots={slots} /> : t(body)}
              </p>
            </li>
          );
        })}
      </ol>
    </PageShell>
  );
}
