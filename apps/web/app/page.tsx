// Step 1 placeholder home. The real Home screen (Daily card, tiles, streak) lands in Step 4.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[390px] flex-col items-center justify-center gap-3 px-4">
      <h1 className="font-display text-5xl font-bold uppercase tracking-wide text-text">
        Power<span className="text-accent">Play</span>
      </h1>
      <p className="font-body text-base text-text-muted">Coming soon.</p>
    </main>
  );
}
