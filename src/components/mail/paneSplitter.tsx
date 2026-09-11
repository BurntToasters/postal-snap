import { strings } from "../../i18n";

export function PaneSplitter({
  className,
  label,
  controls,
  orientation,
  value,
  min,
  max,
  onChange,
}: {
  className: string;
  label: string;
  controls?: string;
  orientation: "vertical" | "horizontal-reverse";
  value: number;
  min: number;
  max: number;
  onChange: (value: number, persist: boolean) => void;
}) {
  return (
    <div
      className={`pane-splitter ${className}`}
      role="separator"
      aria-label={label}
      aria-controls={controls}
      aria-orientation={orientation === "vertical" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuetext={strings.mail.paneSize(Math.round(value))}
      tabIndex={0}
      onKeyDown={(event) => {
        const decrement =
          orientation === "vertical" ? "ArrowLeft" : "ArrowDown";
        const increment = orientation === "vertical" ? "ArrowRight" : "ArrowUp";
        if (
          event.key === "Home" ||
          event.key === "End" ||
          event.key === "PageUp" ||
          event.key === "PageDown" ||
          event.key === decrement ||
          event.key === increment
        ) {
          event.preventDefault();
        } else {
          return;
        }
        if (event.key === "Home") {
          onChange(min, true);
          return;
        }
        if (event.key === "End") {
          onChange(max, true);
          return;
        }
        if (event.key === "PageUp" || event.key === "PageDown") {
          onChange(value + (event.key === "PageUp" ? 64 : -64), true);
          return;
        }
        onChange(value + (event.key === increment ? 16 : -16), true);
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        const start =
          orientation === "vertical" ? event.clientX : event.clientY;
        const initial = value;
        const target = event.currentTarget;
        const move = (moveEvent: PointerEvent) => {
          const current =
            orientation === "vertical" ? moveEvent.clientX : moveEvent.clientY;
          const delta = current - start;
          onChange(
            initial + (orientation === "vertical" ? delta : -delta),
            false,
          );
        };
        const finish = (upEvent: PointerEvent) => {
          const current =
            orientation === "vertical" ? upEvent.clientX : upEvent.clientY;
          const delta = current - start;
          target.releasePointerCapture(upEvent.pointerId);
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", finish);
          onChange(
            initial + (orientation === "vertical" ? delta : -delta),
            true,
          );
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", finish);
      }}
    />
  );
}
