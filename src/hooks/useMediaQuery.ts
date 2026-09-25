import { useEffect, useState } from "react";

/** Subscribe to a CSS media query and return whether it matches. */
export function useMediaQuery(
  query: string,
  onChange?: (matches: boolean) => void,
): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const update = () => {
      setMatches(media.matches);
      onChange?.(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [onChange, query]);
  return matches;
}
