// JSON payload shapes for the dashboard. Single source of truth — update here when src/dashboard.ts changes.

/** /proxy-stats payload. */
export interface StatsPayload {
  /** All top-level weighted totals are provider-credit equivalents; use the
   * provider buckets for rates and never treat a mixed total as USD. */
  accounting_basis?: string;
  port: number;
  uptime_sec: number;
  requests: number;
  compressed_requests: number;
  passthrough: number;
  baseline_input_weighted: number;
  actual_input_weighted: number;
  saved_input_tokens: number;
  /** Back-compat duplicate of `saved_pct_input_only`. */
  saved_pct: number;
  saved_pct_input_only: number;
  /** DEPRECATED — denominator was measured-rows-only (cherry-picks wins). Kept for back-compat. */
  saved_pct_of_total_bill: number;
  /** Measured-rows savings ÷ ALL paid requests (compressed + passthrough + probe-failed). */
  saved_pct_of_all_spend: number;
  all_baseline_equivalent_weighted: number;
  all_actual_input_weighted: number;
  all_output_weighted: number;
  all_usage_requests: number;
  /** Observed cost split: compressed vs passthrough paths on real traffic. `split_sufficient_sample` gates the per-request delta (UI shows caveat below threshold). */
  compressed_paid_requests: number;
  passthrough_paid_requests: number;
  compressed_actual_usd: number;
  passthrough_actual_usd: number;
  compressed_avg_usd_per_request: number;
  passthrough_avg_usd_per_request: number;
  compressed_minus_passthrough_avg_usd: number;
  split_sufficient_sample: boolean;
  split_min_sample_per_bucket: number;
  /** Claude-only conversion; null when the observed traffic has no priced Claude bucket. */
  saved_usd: number | null;
  output_weighted: number;
  baseline_token_equivalent: number;
  actual_token_equivalent: number;
  pricing_assumptions: PricingAssumptions;
  /** Provider-specific accounting buckets. OpenAI has no monetary conversion. */
  providers?: Record<string, DashboardProviderStats>;
  pricing_by_provider?: Record<string, ProviderPricingAssumptions>;
  measured_text_chars: number;
  measured_thinking_chars: number;
  measured_tool_use_chars: number;
  measured_redacted_block_count: number;
  events_with_measurement: number;
  uptime_sec_unused?: never; // future-proof
  compression_enabled: boolean;
}

export interface ProviderPricingAssumptions {
  monetary_supported: boolean;
  unit: string;
  input_per_mtok?: number;
  output_multiplier?: number;
  cache_read_multiplier?: number;
  cache_write_multiplier?: number;
  source?: string;
}

export interface DashboardProviderStats {
  provider: 'anthropic' | 'openai' | 'other';
  requests: number;
  compressed_requests: number;
  usage_requests: number;
  baseline_measured_count: number;
  baseline_input_weighted: number;
  actual_input_weighted: number;
  output_weighted: number;
  all_baseline_equivalent_weighted: number;
  all_actual_input_weighted: number;
  all_output_weighted: number;
  saved_input_weighted: number;
  saved_pct_input_only: number;
  compressed_paid_requests: number;
  passthrough_paid_requests: number;
  compressed_avg_input_weighted: number;
  passthrough_avg_input_weighted: number;
  input_tokens: number;
  ordinary_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  anthropic_cache_create_tokens: number;
  anthropic_cache_read_tokens: number;
  openai_cached_tokens: number;
  openai_cache_write_tokens: number;
  image_tokens: number;
  baseline_imaged_tokens: number;
  raw_actual_tokens: number;
  raw_baseline_tokens: number;
  raw_output_tokens: number;
  safety_flagged: number;
  models: Array<[string, number]>;
  service_tiers: Array<[string, number]>;
  stop_reasons: Array<[string, number]>;
  reasoning_items?: number;
  encrypted_reasoning_items?: number;
  render_cache_hits?: number;
  render_cache_misses?: number;
  render_cache_saved_ms?: number;
  prompt_cache_key_events?: number;
  monetary_supported: boolean;
  saved_usd?: number;
}

export interface PricingAssumptions {
  input_per_mtok: number;
  output_multiplier: number;
  cache_write_5m_multiplier: number;
  cache_write_1h_multiplier: number;
  cache_read_multiplier: number;
  source: string;
}

/** /proxy-recent payload. */
export interface RecentPayload {
  recent: RecentRow[];
  has_preview: boolean;
  preview_meta: string;
  image_ids?: number[];
  preview_provider?: 'anthropic' | 'openai' | 'other';
  preview_model?: string;
  preview_service_tier?: string;
}

export interface RecentRow {
  ts: number;
  method: string;
  path: string;
  model?: string;
  status: number;
  size_in?: number;
  compressed: boolean;
  reason?: string;
  error?: string;
  error_body?: string;
  /** Provider classification; accounting must never infer this from a UI label. */
  provider?: 'anthropic' | 'openai' | 'other';
  service_tier?: string;
  stop_reason?: string;
  safety_flagged?: boolean;
  sent_as?: 'image' | 'text' | 'error';
  cc_added?: number;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_create?: number;
  cache_read?: number;
  cache_write?: number;
  cached_tokens?: number;
  ordinary_input_tokens?: number;
  image_tokens?: number;
  baseline_imaged_tokens?: number;
  reasoning_items?: number;
  encrypted_reasoning_items?: number;
  reasoning_effort?: string;
  reasoning_context?: string;
  prompt_cache_key_present?: boolean;
  prompt_cache_key_fingerprint?: string;
  render_cache_hits?: number;
  render_cache_misses?: number;
  render_cache_saved_ms?: number;
  request_body_input_bytes?: number;
  request_body_output_bytes?: number;
  actual_input?: number;
  baseline_input?: number;
  session_saved_so_far_delta?: number;
  img_id?: number;
  img_ids?: number[];
}

/** /api/sessions.json payload. */
export interface SessionsPayload {
  sessions: SessionRow[];
  count: number;
}

export interface SessionRow {
  // Field names MUST match the JSON from serveSessionsJson (core/sessions.ts).
  id: string;
  project: string | null;
  firstSeen: string;
  lastSeen: string;
  requestCount: number;
  charsSaved: number;
  tokensSavedEst: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  cachedTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  imageTokens?: number;
  models?: string[];
  providers?: string[];
  serviceTiers?: string[];
  providerStats?: Record<string, SessionProviderSummary>;
  jsonlBytes: number;
  sidecarBytes: number;
  claudeCode: ClaudeCodeRef | null;
}

export interface SessionProviderSummary {
  provider: 'anthropic' | 'openai' | 'other';
  requests: number;
  compressedRequests: number;
  usageRequests: number;
  inputTokens: number;
  ordinaryInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  imageTokens: number;
  baselineImagedTokens: number;
  baselineMeasuredCount: number;
  /** Measured compressed rows only; same basis as savedInputWeighted. */
  baselineInputWeighted: number;
  /** Measured compressed rows only; same basis as baselineInputWeighted. */
  actualInputWeighted: number;
  /** All successful usage-bearing rows, including passthrough/unmeasured rows. */
  allBaselineEquivalentWeighted?: number;
  allActualInputWeighted?: number;
  allOutputWeighted?: number;
  savedInputWeighted: number;
  models: string[];
  serviceTiers: string[];
}

export interface ClaudeCodeRef {
  sessionId: string;
  projectPath: string;
  cwd?: string;
  firstUserPreview?: string;
}

/** /api/stats.json payload. */
export interface FullStatsPayload {
  parsed: number;
  dropped: number;
  summary: FullStatsSummary;
  error?: string;
  path?: string;
}

export interface FullStatsSummary {
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  inputTokensTotal: number;
  ordinaryInputTokensTotal?: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  openAICachedTokensTotal: number;
  openAICacheWriteTokensTotal: number;
  outputTokensTotal: number;
  reasoningTokensTotal?: number;
  cacheHitEvents: number;
  /** Legacy alias may be absent; use eventsWithUsage for cache telemetry. */
  eventsWithBaseline?: number;
  eventsWithUsage?: number;
  baselineMeasuredCount?: number;
  baselineInputWeighted?: number;
  actualInputWeighted?: number;
  savedInputWeighted?: number;
  allBaselineEquivalentWeighted?: number;
  allActualInputWeighted?: number;
  allOutputWeighted?: number;
  origCharsTotal: number;
  imageBytesTotal: number;
  durationP50: number;
  durationP95: number;
  firstByteP50: number;
  firstByteP95: number;
  models?: Array<[string, number]>;
  serviceTiers?: Array<[string, number]>;
  stopReasons?: Array<[string, number]>;
  safetyFlagged?: number;
  byProvider?: Record<string, ProviderStatsPayload>;
}

export interface ProviderStatsPayload {
  provider: 'anthropic' | 'openai' | 'other';
  total: number;
  ok2xx: number;
  err4xx: number;
  err5xx: number;
  compressed: number;
  passthrough: number;
  eventsWithUsage: number;
  inputTokensTotal: number;
  ordinaryInputTokensTotal: number;
  outputTokensTotal: number;
  reasoningTokensTotal: number;
  cacheCreateTokensTotal: number;
  cacheReadTokensTotal: number;
  cachedTokensTotal: number;
  cacheWriteTokensTotal: number;
  imageTokensTotal: number;
  baselineImagedTokensTotal: number;
  cacheHitEvents: number;
  safetyFlagged: number;
  models: Array<[string, number]>;
  serviceTiers: Array<[string, number]>;
  stopReasons: Array<[string, number]>;
  reasoningItemsTotal?: number;
  encryptedReasoningItemsTotal?: number;
  renderCacheHits?: number;
  renderCacheMisses?: number;
  renderCacheSavedMs?: number;
  promptCacheKeyEvents?: number;
  baselineMeasuredCount?: number;
  baselineInputWeighted?: number;
  actualInputWeighted?: number;
  savedInputWeighted?: number;
  allBaselineEquivalentWeighted?: number;
  allActualInputWeighted?: number;
  allOutputWeighted?: number;
}

/** POST /api/compression response. */
export interface CompressionToggleResponse {
  compression_enabled: boolean;
}

/** /api/current-session.json — aggregates for the most-recently-active session.
 *  Includes session-wide totals needed for the honest saved-% against the full bill (not just measured slice). */
export interface CurrentSessionPayload {
  sessionId: string | null;
  message?: string;
  baselineInputWeighted?: number;
  actualInputWeighted?: number;
  baselineMeasuredCount?: number;
  /** Σ actualInputWeighted over all session requests — honest denominator for saved-% against the full bill. */
  allActualInputWeighted?: number;
  /** Σ outputWeighted over all session requests. */
  allOutputWeighted?: number;
  /** Raw input tokens (no rate weighting): Σ(input+cache_create+cache_read). Cache-blind — kept for the math drawer, NOT the headline (which uses the weighted pair). */
  rawActualTokens?: number;
  /** Σ count_tokens of each body as plain text — the cache-blind baseline side. */
  rawBaselineTokens?: number;
  /** Raw output tokens — shown as an "untouched" note; output is never compressed. */
  rawOutputTokens?: number;
  providers?: Record<string, CurrentSessionProviderPayload>;
}

export interface CurrentSessionProviderPayload {
  provider: 'anthropic' | 'openai' | 'other';
  requests: number;
  compressedRequests: number;
  usageRequests: number;
  baselineMeasuredCount: number;
  /** Measured compressed rows only; same basis as savedInputWeighted. */
  baselineInputWeighted: number;
  /** Measured compressed rows only; same basis as baselineInputWeighted. */
  actualInputWeighted: number;
  /** All successful usage-bearing rows, including passthrough/unmeasured rows. */
  allBaselineEquivalentWeighted?: number;
  allActualInputWeighted?: number;
  allOutputWeighted?: number;
  outputWeighted: number;
  savedInputWeighted: number;
  rawActualTokens: number;
  rawBaselineTokens: number;
  rawOutputTokens: number;
  inputTokens: number;
  ordinaryInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  imageTokens: number;
  baselineImagedTokens: number;
  models: Array<[string, number]>;
  serviceTiers: Array<[string, number]>;
  reasoningItems?: number;
  encryptedReasoningItems?: number;
  renderCacheHits?: number;
  renderCacheMisses?: number;
  renderCacheSavedMs?: number;
  promptCacheKeyEvents?: number;
}
