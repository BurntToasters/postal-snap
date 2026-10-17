import { useEffect, useState } from "react";

import { api } from "../../api";
import { supportsWorkspaceWindowFx } from "../../window-fx";
import type { DistributionChannel } from "../../types";

/** Settings-level capabilities shared by General, Appearance, Updates, and Advanced. */
export function useSettingsCapabilities() {
  const [distribution, setDistribution] = useState<DistributionChannel>();
  const [windowFxSupported, setWindowFxSupported] = useState(false);

  useEffect(() => {
    let active = true;
    void api
      .distribution()
      .then((result) => {
        if (active) setDistribution(result);
      })
      .catch(() => undefined);
    void supportsWorkspaceWindowFx().then((supported) => {
      if (active) setWindowFxSupported(supported);
    });
    return () => {
      active = false;
    };
  }, []);

  return { distribution, windowFxSupported };
}
