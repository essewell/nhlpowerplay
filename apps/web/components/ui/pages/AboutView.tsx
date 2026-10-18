import Image from "next/image";
import { t } from "../../../lib/copy.ts";
import { SITE_CONFIG } from "../../../lib/site.ts";
import { Card } from "../Card.tsx";
import { PageShell, Prose, SectionHeading } from "./PageShell.tsx";

/** About (COPY.md section 3). Includes the non-affiliation notice (docs/LAUNCH.md). */
export function AboutView() {
  return (
    <PageShell title={t("about.title")}>
      <div className="flex flex-col gap-3.5">
        <Prose>{t("about.p1")}</Prose>
        <Prose>{t("about.p2")}</Prose>
        <Prose>{t("about.p3")}</Prose>
      </div>

      <section aria-labelledby="credits-h" className="flex flex-col gap-2">
        <SectionHeading id="credits-h">{t("about.credits.title")}</SectionHeading>
        <p className="m-0 text-sm leading-normal text-text-soft [text-wrap:pretty]">
          {t("about.credits.body")}{" "}
          <a href={SITE_CONFIG.nhlApiDocsUrl} className="text-pp underline underline-offset-2 hover:text-white">
            {t("about.credits.link")}
          </a>
          .
        </p>
      </section>

      <Card as="section" aria-labelledby="notice-h" className="flex flex-col gap-2">
        <SectionHeading id="notice-h">{t("about.notice.title")}</SectionHeading>
        <p className="m-0 text-sm leading-normal text-text [text-wrap:pretty]">{t("about.notice.body")}</p>
      </Card>

      <div className="mt-auto flex justify-center pt-3">
        <Image
          src="/brand/wordmark-light.svg"
          alt={t("app.name")}
          width={140}
          height={22}
          unoptimized
          className="block opacity-90"
        />
      </div>
    </PageShell>
  );
}
