import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";

const CREDITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function KiroUsageSection({ usage }: { readonly usage: NonNullable<MergedUsage["kiro"]> }) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <h2 className="text-sm font-medium text-foreground">Kiro credits</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Credits used</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {usage.unavailable ? "Unavailable" : CREDITS.format(usage.credits)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Sessions</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {usage.unavailable ? "Unavailable" : formatCount(usage.sessions)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Reported tokens</span>
          <span className="text-2xl font-semibold tabular-nums text-foreground">
            {usage.unavailable
              ? "Unavailable"
              : usage.totalTokens === null
                ? "Not reported"
                : formatTokens(usage.totalTokens)}
          </span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Credits come from Kiro's saved session history for the selected period. Kiro usage is
        separate from the other providers' token and API cost totals; credits are not converted to
        dollars.
      </p>
      {!usage.unavailable && usage.totalTokens === null ? (
        <p className="text-xs text-muted-foreground">
          Kiro did not report token counts for this period.
        </p>
      ) : usage.tokenRecords < usage.records ? (
        <p className="text-xs text-muted-foreground">
          Token counts cover {formatCount(usage.tokenRecords)} of {formatCount(usage.records)}{" "}
          records; the remaining records did not report tokens.
        </p>
      ) : null}
      {usage.partial || usage.unavailable ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          {usage.unavailable
            ? "Kiro usage could not be read."
            : "Kiro totals are partial because some history could not be read."}
        </p>
      ) : null}
      {usage.messages.map((message) => (
        <p key={message} className="text-xs text-muted-foreground">
          {message}
        </p>
      ))}
      {usage.models.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-96 table-fixed text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-1/2 py-2 font-normal">Model</th>
                <th className="py-2 text-right font-normal">Credits</th>
                <th className="py-2 text-right font-normal">Reported tokens</th>
              </tr>
            </thead>
            <tbody>
              {usage.models.map((model) => (
                <tr key={model.model} className="border-b border-border/50 last:border-0">
                  <td className="break-words py-2 pr-3 text-foreground">{model.model}</td>
                  <td className="py-2 text-right tabular-nums text-foreground">
                    {CREDITS.format(model.credits)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {model.totalTokens === null
                      ? "Not reported"
                      : `${formatTokens(model.totalTokens)}${model.tokenRecords < model.records ? " (partial)" : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
