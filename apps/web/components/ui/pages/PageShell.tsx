import type { ReactNode } from "react";
import { BackButton } from "../BackButton.tsx";

/** v2 static-page shell: 390 column, back button + h1 (Barlow 700 28 uppercase), 20 px gap between blocks. */
export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-col gap-5 px-4 pb-6 pt-[18px]">
      <div className="flex items-center gap-3">
        <BackButton href="/" />
        <h1 className="m-0 font-display text-[28px] font-bold uppercase tracking-[0.04em]">{title}</h1>
      </div>
      {children}
    </main>
  );
}

/** Small uppercase section heading (12/600, tracking 0.08em, muted). */
export function SectionHeading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
      {children}
    </h2>
  );
}

/** Body paragraph on the page ground (15/1.55, text-soft). */
export function Prose({ children }: { children: ReactNode }) {
  return <p className="m-0 text-[15px] leading-[1.55] text-text-soft [text-wrap:pretty]">{children}</p>;
}
