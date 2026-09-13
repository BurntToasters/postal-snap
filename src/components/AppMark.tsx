import appIconUrl from "../../src-tauri/icons/icon.png";

interface Props {
  size?: number;
  className?: string;
}

export function AppMark({ size = 40, className = "" }: Props) {
  return (
    <img
      className={["app-mark", className].filter(Boolean).join(" ")}
      src={appIconUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
