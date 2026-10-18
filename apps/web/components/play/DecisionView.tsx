"use client";

/**
 * The decision pause: scoreboard, status chips, rink, and the "Your call" sheet with
 * PASS / SKATE / SHOOT / SET PLAY tabs built from the engine's options grouped by call type.
 * SHOOT opens the shot picker as its own screen. Every control is disabled while `snapshot.busy` (edge 9).
 * Mount this with key={calls.length} so tab, expander and picker state reset after each call.
 * UI thread only.
 */
import { useMemo, useState } from "react";
import type { Call } from "@powerplay/engine/sim-types.ts";
import { Button } from "../ui/Button.tsx";
import { Chip } from "../ui/Chip.tsx";
import { OptionRow } from "../ui/OptionRow.tsx";
import { SkeletonRows } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { Tabs, type TabItem } from "../ui/Tabs.tsx";
import { EstimateTag, InfoTip } from "../ui/Tooltip.tsx";
import type { RunSnapshot } from "../../lib/contracts.ts";
import { spotName, t } from "../../lib/copy.ts";
import {
  carrierOf, groupOptions, limitRows, optionDisabled, playerLabel, SET_PLAY_VIEW, sortByChance,
} from "../../lib/play/options.ts";
import { scoreboardModel } from "../../lib/play/scoreboard.ts";
import { fillCopy, pctLabel } from "../../lib/play/strings.ts";
import { RinkView, type RinkPassTarget } from "./RinkView.tsx";
import { Scoreboard } from "./Scoreboard.tsx";
import { ShotPicker } from "./ShotPicker.tsx";

type TabId = "pass" | "skate" | "shoot" | "setplay";

const TABS: readonly TabItem[] = [
  { id: "pass", label: t("pause.tab.pass") },
  { id: "skate", label: t("pause.tab.skate") },
  { id: "shoot", label: t("pause.tab.shoot") },
  { id: "setplay", label: t("pause.tab.setplay") },
];

const ID_PREFIX = "call";

interface Props {
  snapshot: RunSnapshot;
  resumed: boolean;
  onCall: (call: Call) => void;
  /** Outcome of the last call (OutcomeTicker), shown between the chips and the rink. */
  ticker?: React.ReactNode;
}

export function DecisionView({ snapshot, resumed, onCall, ticker }: Props) {
  const [tab, setTab] = useState<TabId>("pass");
  const [showAllSpots, setShowAllSpots] = useState(false);
  const [pickingShot, setPickingShot] = useState(false);
  const { busy, options, scenario, state } = snapshot;

  const grouped = useMemo(() => groupOptions(options), [options]);
  const carrier = carrierOf(snapshot);
  const board = scoreboardModel(snapshot);

  if (carrier === null) {
    return (
      <StateCard
        kind="error"
        size="screen"
        title={t("pause.error.title")}
        body={t("pause.error.body")}
        action={{ label: t("pause.error.cta"), onClick: () => window.location.reload() }}
      />
    );
  }

  const carrierLabel = playerLabel(snapshot, carrier.id);
  const spotLabel = spotName(carrier.spot);

  if (pickingShot) {
    return (
      <ShotPicker
        shoot={grouped.shoot}
        lastName={carrierLabel.lastName}
        spotLabel={spotLabel}
        busy={busy}
        onBack={() => setPickingShot(false)}
        onShoot={onCall}
      />
    );
  }

  const passRows = sortByChance(grouped.pass);
  const targets: RinkPassTarget[] = passRows.map((o) => ({
    id: o.call.to,
    label: playerLabel(snapshot, o.call.to),
    disabled: optionDisabled(o, busy),
  }));
  const skateRows = limitRows(sortByChance(grouped.skate), showAllSpots);
  const hiddenSpots = skateRows.hidden;
  const chipText = t("pause.chip.paused", { number: carrierLabel.number ?? carrierLabel.lastName });

  const noOptions = options.length === 0;
  const cutNote = fillCopy("play.cut");

  const estimateTip = (
    <div className="flex items-center justify-end">
      <InfoTip label={t("a11y.estimateInfo")} text={t("how.numbers.noRange")} />
    </div>
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">
      <div className="flex flex-col gap-2.5 px-4 pb-2.5 pt-3.5">
        {board.ok ? <Scoreboard teams={scenario.teams} model={board.value} /> : null}
        <div className="flex flex-wrap gap-2 text-[13px]">
          <Chip>{chipText}</Chip>
          {resumed ? <Chip>{t("pause.resume.banner")}</Chip> : null}
        </div>
        {ticker}
      </div>

      <div className="px-5">
        <RinkView
          state={state}
          carrier={{ id: carrier.id, label: carrierLabel }}
          targets={targets}
          onPass={(id) => onCall({ type: "pass", to: id })}
        />
      </div>

      <section
        aria-label={fillCopy("play.sheet.aria")}
        aria-busy={busy}
        className="mt-3.5 flex flex-1 flex-col gap-3 rounded-t-sheet border-t border-border bg-surface px-4 pb-5 pt-4"
      >
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 font-display text-[22px] font-bold uppercase tracking-[0.04em]">
            {t("pause.sheet.title", { lastName: carrierLabel.lastName })}
          </h2>
          <span className="text-xs text-text-muted">{t("pause.sheet.spot", { spotName: spotLabel })}</span>
        </div>

        <Tabs tabs={TABS} value={tab} onChange={(id) => setTab(id as TabId)} idPrefix={ID_PREFIX} label={t("pause.tabs")} />

        {noOptions ? (
          <SkeletonRows count={4} label={t("pause.loading.odds")} hideLabel={false} />
        ) : (
          <div
            role="tabpanel"
            id={`${ID_PREFIX}-panel-${tab}`}
            aria-labelledby={`${ID_PREFIX}-tab-${tab}`}
            tabIndex={0}
            className="flex min-h-0 flex-col gap-1.5 outline-none"
          >
            {tab === "pass" && (
              <>
                {passRows.length === 0 ? (
                  <StateCard kind="empty" body={t("pause.empty.pass")} />
                ) : (
                  <>
                    {estimateTip}
                    {passRows.map((o) => {
                      const who = playerLabel(snapshot, o.call.to);
                      const spot = state.ppSpots.find((x) => x.id === o.call.to)?.spot;
                      return (
                        <OptionRow
                          key={o.call.to}
                          badge={who.number ?? who.lastName.slice(0, 1)}
                          name={t("pause.pass.row.title", { lastName: who.lastName })}
                          sub={o.cutByClock ? cutNote : spot === undefined ? undefined : spotName(spot)}
                          value={o.p}
                          valueLabel={pctLabel("pause.pass.row.pct")}
                          tag={<EstimateTag />}
                          disabled={optionDisabled(o, busy)}
                          onSelect={() => onCall(o.call)}
                        />
                      );
                    })}
                  </>
                )}
              </>
            )}

            {tab === "skate" && (
              <>
                {skateRows.shown.length === 0 ? (
                  <StateCard kind="empty" body={t("pause.empty.skate")} />
                ) : (
                  <>
                    {estimateTip}
                    {skateRows.shown.map((o) => (
                      <OptionRow
                        key={o.call.to}
                        badge="→"
                        name={t("pause.skate.row.title", { spotName: spotName(o.call.to) })}
                        sub={o.cutByClock ? cutNote : undefined}
                        value={o.p}
                        valueLabel={pctLabel("pause.skate.row.pct")}
                        tag={<EstimateTag />}
                        disabled={optionDisabled(o, busy)}
                        onSelect={() => onCall(o.call)}
                      />
                    ))}
                    {hiddenSpots > 0 || showAllSpots ? (
                      <Button variant="secondary" onClick={() => setShowAllSpots((v) => !v)}>
                        {showAllSpots ? fillCopy("play.skate.fewer") : fillCopy("play.skate.more", { n: hiddenSpots })}
                      </Button>
                    ) : null}
                  </>
                )}
              </>
            )}

            {tab === "shoot" && (
              <Button variant="compact" disabled={busy} onClick={() => setPickingShot(true)}>
                {fillCopy("play.shoot.open")}
              </Button>
            )}

            {tab === "setplay" && (
              <>
                {grouped.setPlay.length === 0 ? (
                  <StateCard kind="empty" body={t("pause.empty.setPlay")} />
                ) : (
                  <>
                    {estimateTip}
                    {sortByChance(grouped.setPlay).map((o) => {
                      const v = SET_PLAY_VIEW[o.call.id];
                      return (
                        <OptionRow
                          key={o.call.id}
                          thumbnail={v.thumbnail}
                          name={t(v.nameKey)}
                          sub={o.cutByClock ? cutNote : t(v.subKey)}
                          value={o.p}
                          valueLabel={pctLabel("pause.setplay.row.pct")}
                          tag={<EstimateTag />}
                          disabled={optionDisabled(o, busy)}
                          onSelect={() => onCall(o.call)}
                        />
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>
        )}
        <div className="sr-only" aria-live="polite">
          {busy ? t("pause.loading.odds") : ""}
        </div>
      </section>
    </div>
  );
}
