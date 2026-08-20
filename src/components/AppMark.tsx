import { strings } from "../i18n";

interface Props {
  size?: number;
  className?: string;
}

export function AppMark({ size = 40, className = "" }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={strings.appName}
    >
      <rect width="64" height="64" rx="15" fill="currentColor" />
      <path
        d="M14 21.5c0-2.5 2-4.5 4.5-4.5h27c2.5 0 4.5 2 4.5 4.5v21c0 2.5-2 4.5-4.5 4.5h-27A4.5 4.5 0 0 1 14 42.5v-21Z"
        fill="white"
      />
      <path
        d="m16.5 21 13.2 11.6a3.5 3.5 0 0 0 4.6 0L47.5 21"
        fill="none"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m16.8 43 10.1-9M47.2 43l-10.1-9"
        fill="none"
        stroke="#9bd5f7"
        strokeWidth="3.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
