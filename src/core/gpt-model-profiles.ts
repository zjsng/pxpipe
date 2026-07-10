/**
 * Per-model GPT rendering + vision-cost profiles.
 *
 * One place to retune when a new model ships with different image tokenization,
 * a different downscale threshold (max safe portrait-strip width), or a different
 * max image height. GPT-5.6 is deliberately different: `detail:original` has no
 * patch or pixel-dimension cap, so its page is aligned to exact 32px patch bands.
 *
 * Retune without a code change via the PXPIPE_GPT_PROFILES env var (JSON map of
 * model-id PREFIX -> partial profile; longest matching prefix wins, checked
 * BEFORE the built-in table). Partial fields fall back to the built-in match, so
 * you can override just one knob:
 *
 *   PXPIPE_GPT_PROFILES='{"gpt-5.6":{"vision":{"regime":"patch","multiplier":1},"stripCols":152,"maxHeightPx":2624,"historySectionTokens":9000}}'
 *   PXPIPE_GPT_PROFILES='{"gpt-5.6":{"stripCols":176}}'   # widen only
 */

/** Legacy GPT strip height, decoupled from the Anthropic renderer. Tile-billed
 * models and capped patch models retain this geometry. GPT-5.6 overrides it
 * below because original detail no longer has the old resize/cap behavior. */
export const GPT_MAX_HEIGHT_PX = 1932;

/** GPT-5.6 page height chosen from the patch math, not an API resize ceiling:
 * 768x2624 is exactly 24x82 patches and fits 327 5x8 rows (49,704 chars), just
 * below the renderer's 50k readability cap. This is the densest full page the
 * existing readability contract permits without paying for a partial patch. */
export const GPT_56_MAX_HEIGHT_PX = 2624;

/** Image-token cost model (mirrors OpenAI's mandatory pre-tokenize resize). */
export type GptVisionCost =
  | { regime: 'tile'; base: number; perTile: number }
  | { regime: 'patch'; multiplier: number; patchCap?: number };

export interface GptModelProfile {
  /** How OpenAI bills the rendered images as input tokens. */
  vision: GptVisionCost;
  /** Portrait-strip width in columns. 152 cols x 5px + 8px pad = 768px, an
   * exact 24 patches on GPT-5.6 and the legacy shortest-side floor elsewhere. */
  stripCols: number;
  /** Max rendered image height in px. Threaded into the renderer so the gate's
   *  cost estimate and the actual page split agree. */
  maxHeightPx: number;
  /** Target o200k tokens per frozen history section. Larger sections reduce
   * physical image count while preserving append-only prompt-cache stability. */
  historySectionTokens: number;
}

/** Default downscale-safe strip width (768px). Exported as the global cols default. */
export const DEFAULT_GPT_STRIP_COLS = 152;

const C = DEFAULT_GPT_STRIP_COLS;
const H = GPT_MAX_HEIGHT_PX;
const S = 2000;

/**
 * Conservative fallback for unrecognized models: tile 85/170 over-states cost,
 * which biases the gate toward pass-through (safe). Matches gpt-4o/4.1/4.5.
 */
export const DEFAULT_GPT_PROFILE: GptModelProfile = {
  vision: { regime: 'tile', base: 85, perTile: 170 },
  stripCols: C,
  maxHeightPx: H,
  historySectionTokens: S,
};

interface ProfileRule {
  test: (m: string) => boolean;
  profile: GptModelProfile;
}

/** True for the patch-billed mini/nano family (incl. o4-mini). */
const isMiniNanoPatch = (m: string): boolean =>
  /^(?:gpt-5(?:\.\d+)?|gpt-4\.1)-(?:mini|nano)/.test(m) || /^o4-mini/.test(m);

/**
 * Built-in profiles, evaluated in order (first match wins). Precedence and
 * numbers reproduce the previous hardcoded `resolveVisionCost` EXACTLY:
 *   mini/nano -> patch (nano 2.46 / mini 1.62, cap 1536), BEFORE 5.x flagship.
 */
const BUILTIN_RULES: ProfileRule[] = [
  // nano patch models: ceil(patches * 2.46), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && /nano/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 2.46, patchCap: 1536 }, stripCols: C, maxHeightPx: H, historySectionTokens: S },
  },
  // mini / o4-mini patch models: ceil(patches * 1.62), cap 1536
  {
    test: (m) => isMiniNanoPatch(m) && !/nano/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 1.62, patchCap: 1536 }, stripCols: C, maxHeightPx: H, historySectionTokens: S },
  },
  // GPT-5.6 Sol/Terra/Luna: original/auto uses the original patch count with no
  // resize or patch cap. Keep the proven 2k-token frozen-section cadence: making
  // it larger delays profitable collapse and sacrifices prompt-cache continuity.
  {
    test: (m) => /^gpt-5\.6/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 1 }, stripCols: C, maxHeightPx: GPT_56_MAX_HEIGHT_PX, historySectionTokens: S },
  },
  // 5.x flagship (gpt-5.4/5.5/…, no -mini/-nano): patch, multiplier 1, detail:original cap
  {
    test: (m) => /^gpt-5\.\d/.test(m),
    profile: { vision: { regime: 'patch', multiplier: 1, patchCap: 10000 }, stripCols: C, maxHeightPx: H, historySectionTokens: S },
  },
  // gpt-5 / gpt-5-chat-latest: tile 70/140
  {
    test: (m) => /^gpt-5/.test(m),
    profile: { vision: { regime: 'tile', base: 70, perTile: 140 }, stripCols: C, maxHeightPx: H, historySectionTokens: S },
  },
  // o1 / o3 reasoning: tile 75/150
  {
    test: (m) => /^o[13]/.test(m),
    profile: { vision: { regime: 'tile', base: 75, perTile: 150 }, stripCols: C, maxHeightPx: H, historySectionTokens: S },
  },
];

function resolveBuiltin(m: string): GptModelProfile {
  for (const rule of BUILTIN_RULES) if (rule.test(m)) return rule.profile;
  return DEFAULT_GPT_PROFILE;
}

// --- env override (PXPIPE_GPT_PROFILES) -----------------------------------
// Parsed lazily and memoized on the raw env string so tests can mutate
// process.env and have it re-read, without re-parsing on every hot-path call.

let envRaw: string | null = null;
let envMap: Map<string, GptModelProfile> = new Map();

function isValidVision(v: unknown): v is GptVisionCost {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.regime === 'tile') return Number.isFinite(o.base) && Number.isFinite(o.perTile);
  if (o.regime === 'patch') {
    return Number.isFinite(o.multiplier)
      && (o.patchCap === undefined || (Number.isFinite(o.patchCap) && (o.patchCap as number) > 0));
  }
  return false;
}

function posInt(v: unknown, fallback: number): number {
  return Number.isFinite(v) && (v as number) > 0 ? Math.floor(v as number) : fallback;
}

function parseEnvProfiles(raw: string): Map<string, GptModelProfile> {
  const out = new Map<string, GptModelProfile>();
  if (!raw) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return out; // malformed env never throws — fall back to built-ins
  }
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const key = k.toLowerCase();
    const base = resolveBuiltin(key); // partial fields fall back to the built-in match
    const p = v as Partial<GptModelProfile>;
    out.set(key, {
      vision: isValidVision(p.vision) ? p.vision : base.vision,
      stripCols: posInt(p.stripCols, base.stripCols),
      maxHeightPx: posInt(p.maxHeightPx, base.maxHeightPx),
      historySectionTokens: posInt(p.historySectionTokens, base.historySectionTokens),
    });
  }
  return out;
}

function envProfiles(): Map<string, GptModelProfile> {
  const raw = (typeof process !== 'undefined' && process.env && process.env.PXPIPE_GPT_PROFILES) || '';
  if (raw !== envRaw) {
    envRaw = raw;
    envMap = parseEnvProfiles(raw);
  }
  return envMap;
}

/**
 * Resolve the full rendering + vision-cost profile for a model id. Env overrides
 * (longest matching prefix) win over the built-in table; unknown models get the
 * conservative `DEFAULT_GPT_PROFILE`.
 */
export function resolveGptProfile(model: string | null | undefined): GptModelProfile {
  const m = (model ?? '').toLowerCase();
  const env = envProfiles();
  if (env.size > 0) {
    let best: GptModelProfile | undefined;
    let bestLen = -1;
    for (const [k, p] of env) {
      if (m.startsWith(k) && k.length > bestLen) {
        best = p;
        bestLen = k.length;
      }
    }
    if (best) return best;
  }
  return resolveBuiltin(m);
}
