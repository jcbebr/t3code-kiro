import type { EnvironmentId, KiroAgentCatalog, ProviderInstanceId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

type CatalogState = {
  key: string;
  catalog: KiroAgentCatalog | null;
  error: string | null;
  loading: boolean;
};

/** Fetch from the selected environment; a result for the previous workspace never becomes visible. */
export function useKiroAgentCatalog(input: {
  enabled: boolean;
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  cwd: string | null;
}) {
  const { enabled, environmentId, instanceId, cwd } = input;
  const key = JSON.stringify([environmentId, instanceId, cwd]);
  const [state, setState] = useState<CatalogState | null>(null);
  const requestId = useRef(0);
  const load = useAtomQueryRunner(serverEnvironment.getKiroAgents, {
    refresh: true,
    reportFailure: false,
  });
  const fetchCatalog = useCallback(async () => {
    if (!enabled || !cwd) return;
    const id = ++requestId.current;
    try {
      const result = await load({ environmentId, input: { instanceId, cwd } });
      if (id !== requestId.current) return;
      setState({
        key,
        catalog: result._tag === "Success" ? result.value : null,
        error: result._tag === "Success" ? null : "Could not load agents from this environment.",
        loading: false,
      });
    } catch {
      if (id !== requestId.current) return;
      setState({
        key,
        catalog: null,
        error: "Could not load agents from this environment.",
        loading: false,
      });
    }
  }, [cwd, enabled, environmentId, instanceId, key, load]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Synchronize the remote catalog; state is published only after the request resolves or fails.
    void fetchCatalog();
    return () => {
      requestId.current += 1;
    };
  }, [fetchCatalog]);

  const refresh = useCallback(() => {
    if (!enabled || !cwd) return;
    setState((previous) => ({
      key,
      catalog: previous?.key === key ? previous.catalog : null,
      error: null,
      loading: true,
    }));
    void fetchCatalog();
  }, [cwd, enabled, fetchCatalog, key]);

  const current = state?.key === key ? state : null;
  return {
    catalog: current?.catalog ?? null,
    error: current?.error ?? null,
    loading: enabled && !!cwd && (current?.loading ?? true),
    refresh,
  };
}
