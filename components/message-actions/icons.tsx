import type { ReactNode } from "react";
import styles from "./MessageActions.module.css";

export type MessageActionIconProps = {
  className?: string;
  size?: number;
};

/** Render function so a set can be Lucide, Heroicons, or plain SVG. */
export type MessageActionIcon = (props: MessageActionIconProps) => ReactNode;

export type MessageActionIcons = {
  good: MessageActionIcon;
  bad: MessageActionIcon;
  copy: MessageActionIcon;
  copied: MessageActionIcon;
  reply: MessageActionIcon;
  more: MessageActionIcon;
  again: MessageActionIcon;
  aloud: MessageActionIcon;
  fork: MessageActionIcon;
  report: MessageActionIcon;
};

export function MessageActionGlyph({
  className,
  size = 12,
  strokeWidth = 1.125,
  children,
}: MessageActionIconProps & { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg
      className={[styles.icon, className].filter(Boolean).join(" ")}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function good({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
      <path d="M7 10v12" />
    </MessageActionGlyph>
  );
}

function bad({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
      <path d="M17 14V2" />
    </MessageActionGlyph>
  );
}

function copy({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </MessageActionGlyph>
  );
}

function copied({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M4 12 9 17 20 6" />
    </MessageActionGlyph>
  );
}


function reply({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M20 18v-2a4 4 0 0 0-4-4" />
      <line className={styles.replyShaft} x1="16" y1="12" x2="4" y2="12" />
      <path className={styles.replyHead} d="m9 17-5-5 5-5" />
    </MessageActionGlyph>
  );
}

function more({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </MessageActionGlyph>
  );
}

function again({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </MessageActionGlyph>
  );
}

function aloud({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
      <path d="M16 9a5 5 0 0 1 0 6" />
      <path d="M19.364 18.364a9 9 0 0 0 0-12.728" />
    </MessageActionGlyph>
  );
}

function fork({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9" />
      <path d="M12 12v3" />
    </MessageActionGlyph>
  );
}

function report({ className, size }: MessageActionIconProps) {
  return (
    <MessageActionGlyph className={className} size={size}>
      <path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528" />
    </MessageActionGlyph>
  );
}



/** Lucide stroke set. Replace any key via the `icons` prop. */
export const messageActionIcons: MessageActionIcons = {
  good,
  bad,
  copy,
  copied,
  reply,
  more,
  again,
  aloud,
  fork,
  report,
};
