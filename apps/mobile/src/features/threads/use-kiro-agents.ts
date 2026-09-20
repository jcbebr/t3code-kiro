import type { EnvironmentId, KiroAgentCatalog, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

export function useKiroAgents(input: {
  readonly environmentId: EnvironmentId | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
}) {
  const query = useAtomQueryRunner(serverEnvironment.getKiroAgents, {
    refresh: true,
    reportFailure: false,
  });
  const { environmentId, instanceId, cwd, enabled } = input;
  const key =
    enabled && environmentId && instanceId && cwd
      ? JSON.stringify([environmentId, instanceId, cwd])
      : null;
  const generation = useRef(0);
  const [state, setState] = useState<{
    key: string;
    catalog: KiroAgentCatalog | null;
    error: string | null;
    loading: boolean;
  } | null>(null);
  const fetchCatalog = useCallback(async () => {
    if (!key || !environmentId || !instanceId || !cwd) return;
    const request = ++generation.current;
    try {
      const result = await query({ environmentId, input: { instanceId, cwd } });
      if (generation.current !== request) return;
      setState(
        AsyncResult.isSuccess(result)
          ? { key, catalog: result.value, error: null, loading: false }
          : {
              key,
              catalog: null,
              error: "Could not load Kiro agents. Refresh to try again.",
              loading: false,
            },
      );
    } catch {
      if (generation.current !== request) return;
      setState({
        key,
        catalog: null,
        error: "Could not load Kiro agents. Refresh to try again.",
        loading: false,
      });
    }
  }, [cwd, environmentId, instanceId, key, query]);
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Publish remote state only after the request resolves or fails.
    void fetchCatalog();
    return () => {
      generation.current++;
    };
  }, [fetchCatalog]);
  const refresh = useCallback(() => {
    if (!key) return;
    setState((previous) => ({
      key,
      catalog: previous?.key === key ? previous.catalog : null,
      error: null,
      loading: true,
    }));
    void fetchCatalog();
  }, [key, fetchCatalog]);
  const current = state?.key === key ? state : null;
  return {
    catalog: current?.catalog ?? null,
    error: current?.error ?? null,
    loading: key !== null && (current?.loading ?? true),
    refresh,
  };
}
