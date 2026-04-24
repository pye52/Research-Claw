/**
 * Dual Model Supervisor — Reviewer Model API Client
 *
 * Uses the same `models.providers.<id>` entry as the main stack: `baseUrl`, `apiKey`, optional `headers`,
 * and `models[]` (e.g. `maxTokens` for the `supervisorModel` row).
 * `baseUrl` is used as the HTTP POST URL as stored in config (only trailing `/` trimmed); do not append paths here — match whatever the gateway / dashboard persists for that provider.
 */

import type { ModelsProviderEntry, PluginLogger, SupervisorConfig } from '../core/types.js';
import { SUPPORTED_REVIEWER_APIS } from '../core/types.js';
import { parseModelRef } from '../core/config.js';
import type { ReviewerApiAdapter } from './api-adapters.js';
import { resolveAdapterForReviewer } from './api-adapters.js';

function hasProviderAuth(providerCfg: ModelsProviderEntry): boolean {
  if (providerCfg.apiKey) return true;
  const h = providerCfg.headers;
  if (!h) return false;
  const a = h.Authorization ?? h.authorization;
  return typeof a === 'string' && a.length > 0;
}

// ── Result cache (5-min TTL) ───────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map<string, { result: unknown; ts: number }>();

function cacheKey(prompt: string, content: string): string {
  const raw = `${prompt}::${content}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    const chr = raw.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return String(hash);
}

function getCached<T>(key: string): T | null {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
    return entry.result as T;
  }
  if (entry) _cache.delete(key);
  return null;
}

function setCache(key: string, result: unknown): void {
  _cache.set(key, { result, ts: Date.now() });
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now - v.ts > CACHE_TTL_MS) _cache.delete(k);
  }
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Anthropic Messages API: POST `{base}/v1/messages` (Kimi Coding mirrors this). */
function resolveAnthropicMessagesRequestUrl(base: string): string {
  const b = trimUrl(base);
  if (/\/v1\/messages$/i.test(b)) return b;
  return `${b}/v1/messages`;
}

// ── API Client ─────────────────────────────────────────────────────────

export interface ReviewerClientOptions {
  supervisorConfig: SupervisorConfig;
  providers: Record<string, ModelsProviderEntry>;
  logger: PluginLogger;
  fallbackModel?: string;
}

export class ReviewerClient {
  private supervisorConfig: SupervisorConfig;
  private providers: Record<string, ModelsProviderEntry>;
  private logger: PluginLogger;
  private fallbackModel: string;
  /** Cached adapter for current `supervisorModel` provider; refreshed on config/provider updates. */
  private _adapter: ReviewerApiAdapter | null = null;

  /**
   * Serialize reviewer HTTP calls with limited concurrency.
   * Allows up to N (default 3) concurrent API calls so Steps 1→2→3 within a turn do not starve each other.
   * Uses a semaphore pattern: callers enqueue and are dispatched when a slot opens.
   */
  private _reviewQueue: Promise<void> = Promise.resolve();
  private _running: number = 0;
  private _queueDepth: number = 0;
  private readonly _maxConcurrency: number = 3;
  /** Queue of resolve callbacks for callers waiting for a concurrency slot. */
  private _waiters: Array<() => void> = [];

  constructor(opts: ReviewerClientOptions) {
    this.supervisorConfig = opts.supervisorConfig;
    this.providers = opts.providers;
    this.logger = opts.logger;
    this.fallbackModel = opts.fallbackModel ?? '';
    this._resolveAdapter();
  }

  /** Update the provider map (e.g. after config change) and re-resolve the adapter. */
  updateProviders(providers: Record<string, ModelsProviderEntry>): void {
    this.providers = providers;
    this._resolveAdapter();
  }

  updateSupervisorConfig(cfg: SupervisorConfig): void {
    this.supervisorConfig = cfg;
    this._resolveAdapter();
  }

  updateFallbackModel(fallbackModel: string): void {
    this.fallbackModel = fallbackModel;
    this._resolveAdapter();
  }

  /**
   * Recompute protocol adapter for `supervisorModel` → provider `api` (must be supported reviewer protocol).
   * Falls back to `fallbackModel` when supervisorModel is empty.
   */
  private _resolveAdapter(): void {
    const cfg = this.supervisorConfig;
    const modelRef = cfg.supervisorModel || this.fallbackModel;
    if (!modelRef) {
      this.logger.warn('[ReviewerClient] No supervisorModel or fallbackModel configured');
      this._adapter = null;
      return;
    }
    const parsed = parseModelRef(modelRef);
    if (!parsed) {
      this.logger.error(`[ReviewerClient] Failed to parse model reference: ${modelRef}`);
      this._adapter = null;
      return;
    }

    const providerCfg = this.providers[parsed.provider];
    if (!providerCfg) {
      this.logger.error(`[ReviewerClient] Provider not found: ${parsed.provider}. Available providers: ${Object.keys(this.providers).join(', ')}`);
      this._adapter = null;
      return;
    }

    const adapter = resolveAdapterForReviewer(parsed.provider, providerCfg.api);
    if (!adapter) {
      this.logger.error(
        `[ReviewerClient] Unsupported api "${String(providerCfg.api ?? 'openai-completions')}" for provider "${parsed.provider}". Supported: ${SUPPORTED_REVIEWER_APIS.join(', ')}`,
      );
      this._adapter = null;
      return;
    }

    this._adapter = adapter;
  }

  /**
   * Call the reviewer model. Returns parsed JSON or null on failure.
   * Uses a semaphore to limit concurrent calls to _maxConcurrency.
   */
  async review<T>(systemPrompt: string, userContent: string): Promise<T | null> {
    const key = cacheKey(systemPrompt, userContent);
    const cached = getCached<T>(key);
    if (cached !== null) {
      return cached;
    }

    this._queueDepth++;

    // Acquire a concurrency slot (semaphore acquire).
    await this._reviewQueue
      .catch(() => undefined);

    if (this._running >= this._maxConcurrency) {
      // No slot available; enqueue a waiter and wait for release.
      this._queueDepth--;
      await new Promise<void>((resolve) => {
        this._waiters.push(resolve);
      });
    }

    this._running++;

    // Wrap with _reviewQueue chain for ordering: when this call finishes,
    // it must signal the next waiter if any.
    const prev = this._reviewQueue
      .catch(() => undefined)
      .then(() => this._reviewAfterQueue<T>(systemPrompt, userContent, key))
      .finally(() => {
        this._running--;
        const next = this._waiters.shift();
        if (next) {
          next();
        }
      });

    this._reviewQueue = prev.then(() => {});
    return prev as Promise<T | null>;
  }

  private async _reviewAfterQueue<T>(
    systemPrompt: string,
    userContent: string,
    key: string,
  ): Promise<T | null> {
    const start = Date.now();
    try {
      const result = await this._callApi(systemPrompt, userContent);
      if (result !== null) {
        setCache(key, result);
      }
      return result as T | null;
    } catch (err) {
      const latency = Date.now() - start;
      this.logger.error(`[ReviewCall] _callApi FAILED key=${key.slice(0, 16)}... latency=${latency}ms error=${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fire-and-forget async review.
   */
  reviewAsync<T>(systemPrompt: string, userContent: string, callback?: (result: T | null) => void): void {
    this.review<T>(systemPrompt, userContent)
      .then((result) => callback?.(result))
      .catch((err) => {
        this.logger.error(`Async reviewer call failed: ${err instanceof Error ? err.message : String(err)}`);
        callback?.(null);
      });
  }

  private async _callApi(systemPrompt: string, userContent: string): Promise<unknown | null> {
    const cfg = this.supervisorConfig;
    const modelRef = cfg.supervisorModel || this.fallbackModel;
    if (!modelRef) {
      this.logger.error('[ReviewerClient] No supervisorModel or fallbackModel configured');
      return null;
    }
    const parsed = parseModelRef(modelRef);
    if (!parsed) {
      this.logger.error(`Invalid model reference: ${modelRef}`);
      return null;
    }

    const providerCfg = this.providers[parsed.provider];
    if (!providerCfg) {
      this.logger.error(`No provider config found for: ${parsed.provider}`);
      return null;
    }

    if (!hasProviderAuth(providerCfg)) {
      this.logger.error(`No API key or Authorization header for provider: ${parsed.provider}`);
      return null;
    }

    const base = providerCfg.baseUrl?.trim();
    if (!base) {
      this.logger.error(`Set baseUrl on models.providers.${parsed.provider} for the reviewer model`);
      return null;
    }

    const adapter = this._adapter;
    if (!adapter) {
      this.logger.error('[ReviewerClient] No adapter resolved for reviewer model');
      return null;
    }

    const url =
      adapter.protocol === 'anthropic-messages'
        ? resolveAnthropicMessagesRequestUrl(base)
        : trimUrl(base);
    const headers = adapter.buildHeaders(providerCfg);
    const body = adapter.buildBody(providerCfg, parsed.modelId, systemPrompt, userContent);

    const httpStart = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      this.logger.error(`Reviewer API error ${response.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data = await response.json() as Record<string, unknown>;
    const content = adapter.extractText(data);

    if (!content || (typeof content === 'string' && content.trim().length === 0)) {
      this.logger.error('Reviewer API returned empty content');
      return null;
    }

    const parsedJson = parseJsonFromResponse(content);
    if (parsedJson === null) {
      this.logger.error('[ReviewerClient] Failed to parse JSON from response');
      return null;
    }

    return parsedJson;
  }
}

function parseJsonFromResponse(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch { /* continue */ }

  const fenceMatch = content.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { /* give up */ }
  }

  return null;
}
