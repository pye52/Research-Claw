/**
 * Dual Model Supervisor — RPC Method Registration
 */

import type {
  RegisterMethod,
  SupervisorConfig,
  PluginLogger,
  ConfiguredProvider,
  TurnState,
  TurnPhase,
} from './core/types.js';
import { AuditLogType, DEFAULT_CONFIG } from './core/types.js';
import type { TurnRegistry } from './core/turn-context.js';
import type { SessionAnchorsRegistry, SessionAnchors } from './core/session-anchors.js';
import { AuditLogService } from './core/audit-log.js';
import { parseConfig } from './core/config.js';

export interface SessionAnchorsRpc {
  researchGoal?: string;
  goalConfirmed: boolean;
  methodology?: string;
  targetConclusions: string[];
  keyConclusions: string[];
  userPreferences: string[];
  methodologyDecisions: string[];
}

export interface TurnSummary {
  turnId: string;
  turnSeq: number;
  phase: TurnPhase;
  createdAt: number;
  researchGoal?: string;
  targetConclusions: string[];
  goalConfirmed: boolean;
  regenerateAttempts: number;
  trivialTurn: boolean;
  lastReviewReport?: string;
}

export interface SessionSummary {
  sessionId: string;
  researchGoal?: string;
  targetConclusions: string[];
  goalConfirmed: boolean;
  anchors: SessionAnchorsRpc;
  activeTurns: TurnSummary[];
}

function toAnchorsRpc(a: Readonly<SessionAnchors>): SessionAnchorsRpc {
  return {
    researchGoal: a.researchGoal,
    goalConfirmed: a.goalConfirmed,
    methodology: a.methodology,
    targetConclusions: [...a.targetConclusions],
    keyConclusions: [...a.keyConclusions],
    userPreferences: [...a.userPreferences],
    methodologyDecisions: [...a.methodologyDecisions],
  };
}

function summarizeTurn(turn: TurnState): TurnSummary {
  const staged = turn.stagedAnchorUpdates;
  return {
    turnId: turn.turnId,
    turnSeq: turn.turnSeq,
    phase: turn.phase,
    createdAt: turn.createdAt,
    researchGoal: staged.researchGoal,
    targetConclusions: staged.targetConclusions ? [...staged.targetConclusions] : [],
    goalConfirmed: staged.goalConfirmed ?? false,
    regenerateAttempts: turn.regenerateHistory.length,
    trivialTurn: turn.trivialTurn === true,
    lastReviewReport: turn.lastReviewReport,
  };
}

function summarizeSessions(
  registry: TurnRegistry,
  anchorsReg: SessionAnchorsRegistry,
): { activeSessions: number; sessions: SessionSummary[] } {
  const sessionIds = new Set<string>([...registry.listSessions(), ...anchorsReg.listSessions()]);
  const sessions: SessionSummary[] = [];

  for (const sessionId of sessionIds) {
    const turns = registry.listActive(sessionId);
    const anchorView = anchorsReg.view(sessionId);
    if (turns.length === 0 && !anchorView.researchGoal && anchorView.targetConclusions.length === 0) {
      continue;
    }

    sessions.push({
      sessionId,
      researchGoal: anchorView.researchGoal,
      targetConclusions: [...anchorView.targetConclusions],
      goalConfirmed: anchorView.goalConfirmed,
      anchors: toAnchorsRpc(anchorView),
      activeTurns: turns.map(summarizeTurn),
    });
  }

  return { activeSessions: sessions.length, sessions };
}

export function registerSupervisorRpc(
  registerMethod: RegisterMethod,
  auditLog: AuditLogService,
  getActiveConfig: () => SupervisorConfig,
  setActiveConfig: (cfg: SupervisorConfig) => void,
  logger: PluginLogger,
  getTurnRegistry?: () => TurnRegistry,
  getConfiguredProviders?: () => ConfiguredProvider[],
  getAnchorsRegistry?: () => SessionAnchorsRegistry,
  persistConfig?: (cfg: SupervisorConfig) => void,
): void {
  registerMethod('rc.supervisor.status', async () => {
    const cfg = getActiveConfig();
    const stats = auditLog.getStats();

    let activeSessions = 0;
    let sessionsInfo: SessionSummary[] = [];
    if (getTurnRegistry && getAnchorsRegistry) {
      const summary = summarizeSessions(getTurnRegistry(), getAnchorsRegistry());
      activeSessions = summary.activeSessions;
      sessionsInfo = summary.sessions;
    }

    return {
      enabled: cfg.enabled,
      reviewMode: cfg.reviewMode,
      supervisorModel: cfg.supervisorModel,
      appendReviewToChannelOutput: cfg.appendReviewToChannelOutput,
      memoryGuardEnabled: cfg.memoryGuard.enabled,
      courseCorrectionEnabled: cfg.courseCorrection.enabled,
      deviationThreshold: cfg.courseCorrection.deviationThreshold,
      forceRegenerate: cfg.courseCorrection.forceRegenerate,
      maxRegenerateAttempts: cfg.courseCorrection.maxRegenerateAttempts,
      highRiskTools: cfg.highRiskTools,
      stats,
      activeSessions,
      sessionsInfo,
    };
  });

  registerMethod('rc.supervisor.config', async (params) => {
    if (params && typeof params === 'object' && Object.keys(params).length > 0) {
      const current = getActiveConfig();
      // Only accept known config keys — reject arbitrary params
      const ALLOWED_KEYS = [
        'enabled', 'supervisorModel', 'reviewMode',
        'appendReviewToChannelOutput', 'memoryGuard',
        'courseCorrection', 'preReviewFilter', 'highRiskTools',
      ] as const;
      const filtered: Record<string, unknown> = {};
      for (const key of ALLOWED_KEYS) {
        if (key in (params as Record<string, unknown>)) {
          filtered[key] = (params as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(filtered).length === 0) {
        return { ok: true, config: current };
      }
      // Deep-merge nested config objects to preserve sub-fields on partial updates
      const merged: Record<string, unknown> = { ...current, ...filtered };
      if (filtered.memoryGuard && typeof filtered.memoryGuard === 'object' && current.memoryGuard) {
        merged.memoryGuard = { ...current.memoryGuard, ...(filtered.memoryGuard as Record<string, unknown>) };
      }
      if (filtered.courseCorrection && typeof filtered.courseCorrection === 'object' && current.courseCorrection) {
        merged.courseCorrection = { ...current.courseCorrection, ...(filtered.courseCorrection as Record<string, unknown>) };
      }
      if (filtered.preReviewFilter && typeof filtered.preReviewFilter === 'object' && current.preReviewFilter) {
        merged.preReviewFilter = { ...current.preReviewFilter, ...(filtered.preReviewFilter as Record<string, unknown>) };
      }
      const updated = parseConfig(merged);
      setActiveConfig(updated);
      persistConfig?.(updated);
      logger.info(`Supervisor config updated: mode=${updated.reviewMode}, model=${updated.supervisorModel}`);
      return { ok: true, config: updated };
    }
    return { ok: true, config: getActiveConfig() };
  });

  registerMethod('rc.supervisor.log', async (params) => {
    const p = params as { limit?: number; offset?: number; sessionId?: string; type?: AuditLogType; action?: string };
    const entries = auditLog.list({
      limit: p.limit ?? 50,
      offset: p.offset ?? 0,
      sessionId: p.sessionId,
      type: p.type,
      action: p.action,
    });
    return { entries, total: entries.length };
  });

  registerMethod('rc.supervisor.stats', async () => {
    return auditLog.getStats();
  });

  registerMethod('rc.supervisor.toggle', async (params) => {
    const p = params as { enabled?: boolean };
    const current = getActiveConfig();
    const enabled = p.enabled ?? !current.enabled;
    const updated = {
      ...current,
      enabled,
      reviewMode: enabled && current.reviewMode === 'off' ? 'correct' as const : current.reviewMode,
    };
    setActiveConfig(updated);
    persistConfig?.(updated);
    logger.info(`Supervisor ${enabled ? 'enabled' : 'disabled'}`);
    return { ok: true, enabled: updated.enabled, reviewMode: updated.reviewMode };
  });

  registerMethod('rc.supervisor.defaults', async () => {
    return { defaults: DEFAULT_CONFIG };
  });

  registerMethod('rc.supervisor.providers', async () => {
    if (!getConfiguredProviders) return { providers: [] };
    const providers = getConfiguredProviders();
    return { providers };
  });
}
