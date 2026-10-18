import type { ReactNode } from "react";
import { t } from "../../../lib/copy.ts";
import type { SeasonRange } from "../../../lib/site.ts";
import { HOW_CTA_HREF } from "../../../lib/site.ts";
import { Button } from "../Button.tsx";
import { Card } from "../Card.tsx";
import { GradeChip } from "../GradeChip.tsx";
import type { Grade } from "../GradeChip.tsx";
import { PageShell, Prose, SectionHeading } from "./PageShell.tsx";

const GRADES: readonly Grade[] = ["best", "close", "costly", "miss"];

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li>
      <Card className="grid grid-cols-[32px_minmax(0,1fr)] gap-x-3 gap-y-1 px-4 py-3.5">
        <div className="row-span-2 flex size-8 items-center justify-center rounded-sm border border-border bg-surface-sunk font-display text-lg font-bold text-accent">
          {n}
        </div>
        <h3 className="m-0 font-display text-xl font-bold uppercase leading-8 tracking-[0.04em]">{title}</h3>
        <div className="text-sm leading-normal text-text-muted [text-wrap:pretty]">{children}</div>
      </Card>
    </li>
  );
}

function Mode({ title, body }: { title: string; body: string }) {
  return (
    <Card className="flex flex-col gap-1.5">
      <h3 className="m-0 font-display text-[22px] font-bold uppercase">{title}</h3>
      <p className="m-0 text-[13px] leading-[1.4] text-text-muted">{body}</p>
    </Card>
  );
}

const CALLS = ["pass", "skate", "shoot", "setplay"] as const;

/**
 * How it works (COPY.md section 2). `seasonRange` comes from the export; without it the year phrases
 * are left out (PENDING_COPY "...noRange" variants) rather than typed here.
 */
export function HowItWorksView({ seasonRange }: { seasonRange?: SeasonRange }) {
  return (
    <PageShell title={t("how.title")}>
      <Prose>{t("how.intro")}</Prose>
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        <Step n={1} title={t("how.step1.title")}>
          {t("how.step1.body")}
        </Step>
        <Step n={2} title={t("how.step2.title")}>
          <div className="flex flex-col gap-2">
            <div>{t("how.step2.intro")}</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {CALLS.map((call) => (
                <li key={call} className="flex gap-2">
                  <span aria-hidden="true" className="text-pk">
                    ·
                  </span>
                  <span>
                    <strong className="font-semibold text-text">{t(`how.step2.${call}.label`)}</strong>
                    {t(`how.step2.${call}.rest`).startsWith(",") ? "" : " "}
                    {t(`how.step2.${call}.rest`)}
                  </span>
                </li>
              ))}
            </ul>
            <div>{t("how.step2.outro")}</div>
          </div>
        </Step>
        <Step n={3} title={t("how.step3.title")}>
          {t("how.step3.body")}
        </Step>
        <Step n={4} title={t("how.step4.title")}>
          <div>{t("how.step4.body")}</div>
          <ul className="m-0 mt-1 flex list-none flex-wrap gap-x-3 gap-y-1.5 p-0 text-xs text-text-soft">
            {GRADES.map((g) => (
              <li key={g}>
                <GradeChip grade={g} size={16} />
              </li>
            ))}
          </ul>
        </Step>
      </ol>

      <section id="numbers" aria-labelledby="numbers-h" className="flex flex-col gap-2">
        <SectionHeading id="numbers-h">{t("how.numbers.title")}</SectionHeading>
        <p className="m-0 text-sm leading-normal text-text-soft [text-wrap:pretty]">
          {seasonRange ? t("how.numbers", { ...seasonRange }) : t("how.numbers.noRange")}
        </p>
      </section>

      <section aria-labelledby="modes-h" className="flex flex-col gap-2">
        <SectionHeading id="modes-h">{t("how.modes.title")}</SectionHeading>
        <div className="grid grid-cols-2 gap-3">
          <Mode title={t("how.modes.daily.title")} body={t("how.modes.daily.body")} />
          <Mode
            title={t("how.modes.endless.title")}
            body={seasonRange ? t("how.modes.endless.body", { ...seasonRange }) : t("how.modes.endless.body.noRange")}
          />
        </div>
      </section>

      <Button href={HOW_CTA_HREF} className="mt-auto">
        {t("how.cta")}
      </Button>
    </PageShell>
  );
}
