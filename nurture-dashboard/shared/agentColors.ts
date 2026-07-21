/**
 * Dynamic agent color palette — replaces all hardcoded AGENT_COLORS/AGENT_GRADIENTS maps.
 * Colors are assigned deterministically by agent slug (stable across sessions).
 * New agents automatically get a color without code changes (Golden Rule).
 */

// Ordered palette — first 8 entries match the legacy assignments for visual continuity.
// Additional entries cover future agents.
const PALETTE = [
  { slug: "peter",    bar: "bg-amber-500",    text: "text-amber-400",    bg: "bg-amber-500/8 border-amber-500/20",    gradient: "from-amber-500 to-amber-700",    avatar: "from-yellow-500 to-amber-700" },
  { slug: "steven",   bar: "bg-blue-500",     text: "text-blue-400",     bg: "bg-blue-500/8 border-blue-500/20",     gradient: "from-blue-500 to-blue-700",     avatar: "from-blue-600 to-blue-800" },
  { slug: "tiffany",  bar: "bg-violet-500",   text: "text-violet-400",   bg: "bg-violet-500/8 border-violet-500/20",   gradient: "from-violet-500 to-violet-700",   avatar: "from-violet-600 to-violet-800" },
  { slug: "stefanie", bar: "bg-rose-500",     text: "text-rose-400",     bg: "bg-rose-500/8 border-rose-500/20",     gradient: "from-rose-500 to-rose-700",     avatar: "from-rose-600 to-rose-800" },
  { slug: "abby",     bar: "bg-emerald-500",  text: "text-emerald-400",  bg: "bg-emerald-500/8 border-emerald-500/20",  gradient: "from-emerald-500 to-emerald-700",  avatar: "from-emerald-600 to-emerald-800" },
  { slug: "irma",     bar: "bg-orange-500",   text: "text-orange-400",   bg: "bg-orange-500/8 border-orange-500/20",   gradient: "from-orange-500 to-orange-700",   avatar: "from-amber-600 to-amber-800" },
  { slug: "laila",    bar: "bg-cyan-500",     text: "text-cyan-400",     bg: "bg-cyan-500/8 border-cyan-500/20",     gradient: "from-cyan-500 to-cyan-700",     avatar: "from-cyan-600 to-cyan-800" },
  { slug: "jason",    bar: "bg-orange-600",   text: "text-orange-400",   bg: "bg-orange-600/8 border-orange-600/20",   gradient: "from-orange-600 to-orange-800",   avatar: "from-orange-600 to-orange-800" },
  // Overflow slots for future agents
  { slug: "_8",       bar: "bg-pink-500",     text: "text-pink-400",     bg: "bg-pink-500/8 border-pink-500/20",     gradient: "from-pink-500 to-pink-700",     avatar: "from-pink-600 to-pink-800" },
  { slug: "_9",       bar: "bg-indigo-500",   text: "text-indigo-400",   bg: "bg-indigo-500/8 border-indigo-500/20",   gradient: "from-indigo-500 to-indigo-700",   avatar: "from-indigo-600 to-indigo-800" },
  { slug: "_10",      bar: "bg-lime-500",     text: "text-lime-400",     bg: "bg-lime-500/8 border-lime-500/20",     gradient: "from-lime-500 to-lime-700",     avatar: "from-lime-600 to-lime-800" },
  { slug: "_11",      bar: "bg-sky-500",      text: "text-sky-400",      bg: "bg-sky-500/8 border-sky-500/20",      gradient: "from-sky-500 to-sky-700",      avatar: "from-sky-600 to-sky-800" },
];

const DEFAULT_COLORS = { bar: "bg-stone-400", text: "text-muted-foreground", bg: "bg-card/4 border-white/8", gradient: "from-slate-500 to-slate-700", avatar: "from-slate-600 to-slate-800" };

// Slug-based lookup (O(1) for known agents)
const slugIndex = new Map(PALETTE.map((p, i) => [p.slug, i]));

/**
 * Get color set for an agent by slug or name.
 * Known agents get their legacy color. Unknown agents get a deterministic overflow color.
 */
export function getAgentColors(slugOrName: string): typeof DEFAULT_COLORS {
  const key = slugOrName.toLowerCase().trim();
  const idx = slugIndex.get(key);
  if (idx !== undefined) return PALETTE[idx];
  // Deterministic hash for unknown agents → overflow palette slot
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  const overflowIdx = 8 + (Math.abs(hash) % (PALETTE.length - 8));
  return PALETTE[overflowIdx] ?? DEFAULT_COLORS;
}

/**
 * Get gradient string for an agent (used in avatar circles).
 */
export function getAgentGradient(slugOrName: string): string {
  return getAgentColors(slugOrName).gradient;
}

/**
 * Get avatar gradient string for an agent (used in initials circles).
 */
export function getAgentAvatarGradient(slugOrName: string): string {
  return getAgentColors(slugOrName).avatar;
}
