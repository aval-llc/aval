/** Shared, allowlisted avatar catalog. Stored preferences never contain URLs. */
export const PORTRAIT_IDS = [
  "01-short-loose-curls", "02-rounded-center-bob", "03-curly-cropped-pixie", "04-tight-coily-halo",
  "05-sleek-side-bob", "06-flipped-ends-bob", "07-rounded-afro-puff", "08-shoulder-curls",
  "09-shoulder-waves", "10-chin-length-bob", "11-long-straight-center", "12-short-asym-bob",
  "13-blunt-bob-bangs", "14-high-bun", "15-low-side-bun", "16-twin-low-ponytails",
  "17-side-ponytail", "18-long-wavy-side-pony", "19-long-pigtails", "20-double-braids",
  "21-long-straight-side-part", "22-long-loose-waves", "23-long-half-up", "24-voluminous-long-curls",
  "personality-01-nerdy",
  "personality-02-sporty",
  "personality-03-artsy",
  "personality-04-bookish",
  "personality-05-cool",
  "personality-06-preppy",
  "personality-07-geeky",
  "personality-08-dreamy",
  "personality-09-grumpy",
  "personality-10-cheerful",
  "personality-11-shy",
  "personality-12-confident",
  "personality-13-sleepy",
  "personality-14-energetic",
  "personality-15-serious",
  "personality-16-playful",
  "personality-17-curious",
  "personality-18-dramatic",
  "personality-19-rebellious",
  "personality-20-fancy",
  "personality-21-outdoorsy",
  "personality-22-zen",
  "personality-23-quirky",
  "personality-24-studious",
] as const;
/** Only the Aval brand mark remains selectable from the old character family. */
export const CHARACTER_IDS = ["general"] as const;
const LEGACY_CHARACTER_IDS = ["general", "financial", "brokerage", "real-estate", "market-research", "maintenance", "risk-analyst", "portfolio-outlook", "lease-review"] as const;
const AGENT_PORTRAITS: Record<string, number> = { financial: 0, brokerage: 4, realEstate: 7, "real-estate": 7, marketResearch: 10, "market-research": 10, maintenance: 2, riskAnalyst: 13, "risk-analyst": 13, portfolioOutlook: 20, "portfolio-outlook": 20, leaseReview: 23, "lease-review": 23 };

export function defaultAgentAvatar(id: string): AvatarSelection {
  if (id === "general") return { kind: "character", id: "general", background: "paper" };
  const index = AGENT_PORTRAITS[id] ?? Array.from(id).reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0) % PORTRAIT_IDS.length;
  return { kind: "portrait", id: PORTRAIT_IDS[index], background: "paper" };
}

/** Read old saved choices without bringing retired blob artwork back. */
export function currentAvatar(avatar: AvatarSelection): AvatarSelection {
  return avatar.kind === "character" && avatar.id !== "general"
    ? { ...defaultAgentAvatar(avatar.id), background: avatar.background }
    : avatar;
}
export const BACKGROUNDS = { paper: "#ffffff", fog: "#e8e8ec", sky: "#dceaff", mint: "#dceee5", peach: "#ffe4d5", lilac: "#eae1f6" } as const;
export type AvatarSelection = { kind: "portrait" | "character"; id: string; background: keyof typeof BACKGROUNDS };
export type AvatarMotion = "system" | "animated" | "still";
export type ChatWindowBackground = "white" | "glass";
export const DEFAULT_CHAT_TRANSPARENCY = 20;
export const MAX_CHAT_TRANSPARENCY = 100;
export type AppearancePreferences = { chatWindowTransparency?: number; chatWindowBackground?: ChatWindowBackground; profile: AvatarSelection | null; agents: Record<string, AvatarSelection>; motion: AvatarMotion };
export const DEFAULT_APPEARANCE: AppearancePreferences = { profile: null, agents: {}, motion: "system" };

export function isAvatarSelection(value: unknown): value is AvatarSelection {
  if (!value || typeof value !== "object") return false;
  const item = value as AvatarSelection;
  return Object.hasOwn(BACKGROUNDS, item.background) &&
    (item.kind === "portrait" ? (PORTRAIT_IDS as readonly string[]).includes(item.id)
      : item.kind === "character" && (LEGACY_CHARACTER_IDS as readonly string[]).includes(item.id));
}

export function parseAppearance(value: unknown): AppearancePreferences | null {
  if (!value || typeof value !== "object") return null;
  const item = value as AppearancePreferences;
  if (!["system", "animated", "still"].includes(item.motion) || (item.profile !== null && !isAvatarSelection(item.profile))) return null;
  if (!item.agents || typeof item.agents !== "object" || Array.isArray(item.agents)) return null;
  if (item.chatWindowBackground !== undefined && !["white", "glass"].includes(item.chatWindowBackground)) return null;
  if (item.chatWindowTransparency !== undefined && (!Number.isInteger(item.chatWindowTransparency) || item.chatWindowTransparency < 0 || item.chatWindowTransparency > MAX_CHAT_TRANSPARENCY)) return null;
  const entries = Object.entries(item.agents);
  if (entries.length > 100 || entries.some(([id, avatar]) => !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id) || !isAvatarSelection(avatar))) return null;
  const clean = (avatar: AvatarSelection): AvatarSelection => currentAvatar({ kind: avatar.kind, id: avatar.id, background: avatar.background });
  return { ...(item.chatWindowTransparency !== undefined ? { chatWindowTransparency: item.chatWindowTransparency } : {}), ...(item.chatWindowBackground ? { chatWindowBackground: item.chatWindowBackground } : {}), profile: item.profile && clean(item.profile), agents: Object.fromEntries(entries.map(([id, avatar]) => [id, clean(avatar)])), motion: item.motion };
}

export function avatarSources(avatar: AvatarSelection): { animated: string; still: string } {
  avatar = currentAvatar(avatar);
  const base = avatar.kind === "portrait" ? `/avatars/${avatar.id}-animated` : `/personas/${avatar.id}`;
  return { animated: `${base}.webp`, still: `${base}.png` };
}
