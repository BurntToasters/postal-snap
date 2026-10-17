import { useCallback, useEffect, useState } from "react";

import { strings } from "../../i18n";
import { useAppStore } from "../../store";
import type { DistributionChannel } from "../../types";
import {
  addUpdateFoundListener,
  checkUpdateInteractive,
  removeUpdateFoundListener,
  type UpdateFoundListener,
} from "../../update";

interface Options {
  distribution?: DistributionChannel;
}

/** Update status and listener lifetime for the Updates settings section. */
export function useSettingsUpdates({ distribution }: Options) {
  const setError = useAppStore((state) => state.setError);
  const [updateStatus, setUpdateStatus] = useState<string>(
    strings.settings.checkUpdates,
  );
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  const handleUpdateFound = useCallback<UpdateFoundListener>((version) => {
    setUpdateStatus(strings.settings.installing(version ?? ""));
  }, []);

  useEffect(() => {
    addUpdateFoundListener(handleUpdateFound);
    return () => removeUpdateFoundListener(handleUpdateFound);
  }, [handleUpdateFound]);

  const checkForUpdates = useCallback(async () => {
    if (checkingUpdate || distribution?.updatesManagedBy !== "postalSnap")
      return;
    setCheckingUpdate(true);
    setUpdateStatus(strings.settings.checking);
    try {
      await checkUpdateInteractive();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCheckingUpdate(false);
      setUpdateStatus(strings.settings.checkUpdates);
    }
  }, [checkingUpdate, distribution, setError]);

  return { updateStatus, checkingUpdate, checkForUpdates };
}
