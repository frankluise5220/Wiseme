import {
  BookOpen,
  Building2,
  Cpu,
  Database,
  Globe,
  Handshake,
  Hash,
  Heart,
  HeartHandshake,
  Key,
  KeyRound,
  Mail,
  Palette,
  RefreshCw,
  Server,
  Settings,
  Shield,
  ShieldCheck,
  Tag,
  Users,
} from "lucide-react";

const ICONS = {
  "book-open": BookOpen,
  "building-2": Building2,
  cpu: Cpu,
  database: Database,
  globe: Globe,
  handshake: Handshake,
  hash: Hash,
  heart: Heart,
  "heart-handshake": HeartHandshake,
  key: Key,
  "key-round": KeyRound,
  mail: Mail,
  palette: Palette,
  "refresh-cw": RefreshCw,
  server: Server,
  shield: Shield,
  "shield-check": ShieldCheck,
  tag: Tag,
  users: Users,
} as const;

export function SettingsCatalogIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = ICONS[icon as keyof typeof ICONS] ?? Settings;
  return <Icon className={className} />;
}
