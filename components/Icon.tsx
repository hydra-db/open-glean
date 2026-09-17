"use client";
import React from "react";
import {
  House,
  Stack,
  Terminal,
  Plug,
  ListBullets,
  WebhooksLogo,
  CreditCard,
  ArrowSquareOut,
  Key,
  Users,
  File as FileIcon,
  UsersThree,
  User,
  Plus,
  Minus,
  ArrowsOut,
  MagnifyingGlass,
  X,
  Copy,
  PencilSimple,
  Trash,
  CaretRight,
  CaretDown,
  Sun,
  Moon,
  BookOpen,
  ChatCircle,
  SignOut,
  Check,
  ThumbsUp,
  ThumbsDown,
  ArrowsClockwise,
  Lightning,
  Graph,
  Warning,
  GithubLogo,
  Lock,
  Envelope,
  Eye,
  EyeSlash,
  ArrowRight,
  SlidersHorizontal,
  LinkSimple,
  DotsThree,
  Info,
  Funnel,
  Clock,
  UploadSimple,
  DownloadSimple,
  PaperPlaneRight,
  Sparkle,
  Brain,
  Folder,
  Gear,
  Globe,
  MapPin,
  Microphone,
  ShareNetwork,
  ClockCounterClockwise,
  Square,
  Database,
  Smiley,
  Star,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";

/**
 * Icon set backed by Phosphor. The <Icon name="..."> API is unchanged, so every
 * call site stays the same. Names map to the closest Phosphor glyph.
 */
const ICONS: Record<string, PhosphorIcon> = {
  home: House,
  layers: Stack,
  query: Terminal,
  plug: Plug,
  logs: ListBullets,
  webhook: WebhooksLogo,
  card: CreditCard,
  external: ArrowSquareOut,
  key: Key,
  users: Users,
  file: FileIcon,
  team: UsersThree,
  user: User,
  plus: Plus,
  minus: Minus,
  fit: ArrowsOut,
  search: MagnifyingGlass,
  x: X,
  copy: Copy,
  edit: PencilSimple,
  trash: Trash,
  chev: CaretRight,
  chevDown: CaretDown,
  sun: Sun,
  moon: Moon,
  book: BookOpen,
  msg: ChatCircle,
  logout: SignOut,
  check: Check,
  "thumb-up": ThumbsUp,
  "thumb-down": ThumbsDown,
  refresh: ArrowsClockwise,
  bolt: Lightning,
  graph: Graph,
  alert: Warning,
  github: GithubLogo,
  lock: Lock,
  mail: Envelope,
  eye: Eye,
  eyeOff: EyeSlash,
  arrowRight: ArrowRight,
  sliders: SlidersHorizontal,
  link: LinkSimple,
  dots: DotsThree,
  info: Info,
  filter: Funnel,
  clock: Clock,
  upload: UploadSimple,
  download: DownloadSimple,
  send: PaperPlaneRight,
  sparkles: Sparkle,
  brain: Brain,
  folder: Folder,
  settings: Gear,
  globe: Globe,
  pin: MapPin,
  mic: Microphone,
  share: ShareNetwork,
  history: ClockCounterClockwise,
  stop: Square,
  spark: Sparkle,
  database: Database,
  smile: Smiley,
  star: Star,
};

export function Icon({
  name,
  size = 16,
  className = "",
  style,
}: {
  name: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const Glyph = ICONS[name];
  if (!Glyph) return null;
  return (
    <Glyph
      className={className}
      style={style}
      size={size}
      weight="regular"
      aria-hidden="true"
    />
  );
}

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      className={`animate-spin ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}
