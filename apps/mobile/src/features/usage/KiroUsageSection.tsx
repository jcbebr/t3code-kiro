import type { MergedUsage } from "@t3tools/shared/usageMerge";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";

const CREDITS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 });

export function KiroUsageSection({ usage }: { readonly usage: NonNullable<MergedUsage["kiro"]> }) {
  return (
    <SettingsSection title="Kiro credits" card>
      <View className="gap-3 p-4">
        <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
          {usage.unavailable ? "Unavailable" : `${CREDITS.format(usage.credits)} credits`}
        </Text>
        {!usage.unavailable ? (
          <Text className="text-sm text-foreground-muted">
            {formatCount(usage.sessions)} sessions
          </Text>
        ) : null}
        <Text className="text-sm text-foreground-muted">
          Reported tokens:{" "}
          {usage.unavailable
            ? "Unavailable"
            : usage.totalTokens === null
              ? "Not reported"
              : formatTokens(usage.totalTokens)}
        </Text>
        <Text className="text-xs text-foreground-tertiary">
          Credits come from Kiro's saved session history for the selected period. Kiro usage is
          separate from the other providers' token and API cost totals; credits are not converted to
          dollars.
        </Text>
        {usage.totalTokens !== null && usage.tokenRecords < usage.records ? (
          <Text className="text-xs text-foreground-muted">
            Token counts cover {formatCount(usage.tokenRecords)} of {formatCount(usage.records)}{" "}
            records; the remaining records did not report tokens.
          </Text>
        ) : null}
        {usage.partial || usage.unavailable ? (
          <Text className="text-sm text-foreground-muted">
            {usage.unavailable
              ? "Kiro usage could not be read."
              : "Kiro totals are partial because some history could not be read."}
          </Text>
        ) : null}
        {usage.messages.map((message) => (
          <Text key={message} className="text-xs text-foreground-muted">
            {message}
          </Text>
        ))}
      </View>
      {usage.models.map((model) => (
        <View key={model.model} className="gap-1 border-t border-border-subtle p-4">
          <View className="flex-row flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <Text className="min-w-0 grow basis-40 text-base text-foreground">{model.model}</Text>
            <Text className="text-base tabular-nums text-foreground">
              {CREDITS.format(model.credits)} credits
            </Text>
          </View>
          <Text className="text-sm text-foreground-muted">
            {model.totalTokens === null
              ? "Tokens not reported"
              : `${formatTokens(model.totalTokens)} tokens${model.tokenRecords < model.records ? " (partial)" : ""}`}
          </Text>
        </View>
      ))}
    </SettingsSection>
  );
}
