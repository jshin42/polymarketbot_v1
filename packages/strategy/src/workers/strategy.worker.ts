import { Worker, Queue, Job } from 'bullmq';
import { RedisKeys, createLogger, Redis, type CompositeScore, type FeatureVector } from '@polymarketbot/shared';
import { DecisionService } from '../services/decision.service.js';
import { KellySizingService } from '../services/kelly-sizing.service.js';
import { RiskGuards } from '../guards/risk-guards.js';
import { StalenessGuards } from '../guards/staleness-guards.js';

// =============================================================================
// Strategy Worker
// =============================================================================

const logger = createLogger('strategy-worker');

export interface StrategyJobData {
  tokenId: string;
  conditionId: string;
  timestamp: number;
  scores: CompositeScore;
  features: FeatureVector;
  marketData: {
    closeTime: number;
    currentMid: number;
    bestBid: number;
    bestAsk: number;
    spread: number;
    topOfBookDepth: number;
  };
}

export interface StrategyJobResult {
  tokenId: string;
  timestamp: number;
  action: string;
  approved: boolean;
  targetSizeUsd: number | null;
  rejectionReason: string | null;
}

export interface StrategyWorkerDeps {
  redis: Redis;
  paperQueue: Queue;
}

/**
 * Create strategy worker that consumes scored signals and makes trading decisions.
 */
export async function createStrategyWorker(
  deps: StrategyWorkerDeps
): Promise<Worker<StrategyJobData, StrategyJobResult>> {
  const { redis, paperQueue } = deps;

  // Initialize services
  const kellySizing = new KellySizingService();
  const riskGuards = new RiskGuards(redis);
  const stalenessGuards = new StalenessGuards(redis);
  const decisionService = new DecisionService(
    redis,
    kellySizing,
    riskGuards,
    stalenessGuards
  );

  const worker = new Worker<StrategyJobData, StrategyJobResult>(
    RedisKeys.queues.strategy,
    async (job: Job<StrategyJobData>): Promise<StrategyJobResult> => {
      const { tokenId, conditionId, timestamp, scores, features, marketData } =
        job.data;

      logger.debug(
        { tokenId, anomalyScore: scores.anomalyScore.score },
        'Processing strategy job'
      );

      try {
        // Make decision
        const { decision, sizing, riskCheck, reasoning } =
          await decisionService.makeDecision({
            tokenId,
            conditionId,
            marketCloseTime: marketData.closeTime,
            currentMid: marketData.currentMid,
            bestBid: marketData.bestBid,
            bestAsk: marketData.bestAsk,
            spread: marketData.spread,
            topOfBookDepth: marketData.topOfBookDepth,
            scores,
            features,
          });

        // Log reasoning
        logger.info(
          {
            tokenId,
            action: decision.action,
            approved: decision.approved,
            reasoning,
          },
          'Strategy decision'
        );

        // If approved, send to paper engine for execution
        if (decision.approved && decision.targetSizeUsd && decision.targetSizeUsd > 0) {
          await paperQueue.add(
            `paper-${tokenId}-${timestamp}`,
            {
              decision,
              marketData: {
                ...marketData,
                timestamp,
              },
            },
            {
              removeOnComplete: 100,
              removeOnFail: 50,
            }
          );

          logger.info(
            {
              tokenId,
              action: decision.action,
              side: decision.side,
              size: decision.targetSizeUsd,
            },
            'Decision sent to paper engine'
          );
        }

        return {
          tokenId,
          timestamp,
          action: decision.action,
          approved: decision.approved ?? false,
          targetSizeUsd: decision.targetSizeUsd ?? null,
          rejectionReason: decision.rejectionReason ?? null,
        };
      } catch (error) {
        logger.error({ error, tokenId }, 'Strategy job failed');
        throw error;
      }
    },
    {
      connection: redis.duplicate(),
      concurrency: 10,
      limiter: {
        max: 100,
        duration: 1000,
      },
    }
  );

  // Event handlers
  worker.on('completed', (job, result) => {
    if (result.approved) {
      logger.info(
        {
          jobId: job.id,
          tokenId: result.tokenId,
          action: result.action,
          size: result.targetSizeUsd,
        },
        'Strategy job completed with approved decision'
      );
    }
  });

  worker.on('failed', (job, error) => {
    logger.error(
      { jobId: job?.id, error: error.message },
      'Strategy job failed'
    );
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'Strategy worker error');
  });

  logger.info('Strategy worker started');

  return worker;
}
