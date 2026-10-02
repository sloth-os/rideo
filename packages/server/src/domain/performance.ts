import { AppError } from '../errors';
import { Service } from './base';
import type { Deps } from './deps';

/**
 * The gateway model that acts performances (`supports_performance`, docs/design/performance.md), or
 * `performance_unavailable`.
 */
export async function performanceModel(deps: Pick<Deps, 'gateway'>, wanted: string): Promise<string> {
  if (wanted === 'off')
    throw new AppError('performance_unavailable', 'Performance-driven takes are off for this project');
  const entries = await deps.gateway.modelLimits('video').catch(() => []);
  const able = entries.filter((e) => e.limits?.supports_performance === true);
  const chosen = wanted === 'auto' ? able[0] : able.find((e) => e.id === wanted);
  if (!chosen)
    throw new AppError(
      'performance_unavailable',
      wanted === 'auto'
        ? 'No performance model on the gateway (models with supports_performance)'
        : `${wanted} does not act performances (supports_performance)`,
    );
  return chosen.id;
}

export class PerformanceService extends Service {
  /** The model a project's performance takes use, if the gateway has one (docs/design/performance.md#surfaces). */
  async model(projectId: string): Promise<{ model: string | null; available: boolean }> {
    const docs = await this.deps.projects.docs(projectId);
    try {
      return {
        model: await performanceModel(this.deps, docs.project.settings.models.performance),
        available: true,
      };
    } catch (err) {
      if (err instanceof AppError && err.code === 'performance_unavailable')
        return { model: null, available: false };
      throw err;
    }
  }
}
