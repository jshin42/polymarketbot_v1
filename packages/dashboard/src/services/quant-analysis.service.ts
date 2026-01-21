import { Pool } from 'pg';
import { createLogger } from '@polymarketbot/shared';
import {
  type AnalysisConfig,
  type ContrarianEvent,
  AnalysisService,
} from './analysis.service.js';

// =============================================================================
// Quant Analysis Service - Advanced Quantitative Strategies
// =============================================================================
// Implements: VPIN, Hawkes Process, Benford's Law, Time Decay, Kyle's Lambda

const logger = createLogger('quant-analysis-service');

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface VPINResult {
  vpin: number;           // Volume-synchronized probability of informed trading
  bucketCount: number;
  avgBucketVolume: number;
  toxicityLevel: 'low' | 'medium' | 'high';
  timeSeries: Array<{
    timestamp: Date;
    vpin: number;
    volume: number;
  }>;
}

export interface HawkesResult {
  baselineIntensity: number;    // μ - base event rate
  excitationAlpha: number;      // α - jump in intensity per event
  decayBeta: number;            // β - decay rate
  branchingRatio: number;       // α/β - ratio (< 1 for stability)
  clusteringScore: number;      // 0-1 measure of event clustering
  burstPeriods: Array<{
    startTime: Date;
    endTime: Date;
    eventCount: number;
    intensity: number;
  }>;
}

export interface BenfordResult {
  chiSquare: number;
  pValue: number;
  isAnomalous: boolean;
  firstDigitDistribution: Record<string, number>;
  expectedDistribution: Record<string, number>;
  deviationByDigit: Record<string, number>;
  anomalyScore: number;  // 0-1, higher = more anomalous
}

export interface TimeDecayResult {
  timeBuckets: Array<{
    minMinutes: number;
    maxMinutes: number;
    n: number;
    winRate: number;
    avgPrice: number;
    pnl: number;
    roi: number;
    edgePoints: number;
  }>;
  optimalWindow: { min: number; max: number };
  decayCoefficient: number;  // Exponential decay rate
}

export interface KyleLambdaResult {
  lambda: number;           // Price impact coefficient
  permanentImpact: number;  // Long-term impact
  temporaryImpact: number;  // Short-term impact
  r2: number;              // Regression fit
  priceImpactBySize: Array<{
    sizeQuantile: number;
    avgImpact: number;
    n: number;
  }>;
}

export interface QuantReport {
  id?: number;
  reportType: 'full' | 'incremental' | 'strategy';
  dataStart: Date;
  dataEnd: Date;
  totalEvents: number;
  resolvedEvents: number;

  // Analysis results
  vpin: VPINResult | null;
  hawkes: HawkesResult | null;
  benford: BenfordResult | null;
  timeDecay: TimeDecayResult | null;
  kyleLambda: KyleLambdaResult | null;

  // Strategy rankings
  topStrategies: Array<{
    config: Partial<AnalysisConfig>;
    metrics: { n: number; winRate: number; pnl: number; roi: number };
    quantSignals: string[];  // Which quant signals apply
  }>;

  // Recommendations
  recommendations: string[];

  // Metadata
  executionTimeMs: number;
  createdAt: Date;
}

// Benford's Law expected distribution
const BENFORD_EXPECTED: Record<string, number> = {
  '1': 0.301,
  '2': 0.176,
  '3': 0.125,
  '4': 0.097,
  '5': 0.079,
  '6': 0.067,
  '7': 0.058,
  '8': 0.051,
  '9': 0.046,
};

// -----------------------------------------------------------------------------
// Quant Analysis Service Class
// -----------------------------------------------------------------------------

export class QuantAnalysisService {
  private pool: Pool;
  private analysisService: AnalysisService;

  constructor(pool: Pool, analysisService: AnalysisService) {
    this.pool = pool;
    this.analysisService = analysisService;
  }

  // ---------------------------------------------------------------------------
  // Full Analysis Pipeline
  // ---------------------------------------------------------------------------

  /**
   * Run complete quant analysis
   */
  async runFullAnalysis(config?: Partial<AnalysisConfig>): Promise<QuantReport> {
    const startTime = Date.now();
    logger.info('Starting full quant analysis');

    // Get all events
    const events = await this.analysisService.getContrarianEventsFromDB({
      lookbackDays: 30,
      resolvedOnly: false,
      ...config,
    } as AnalysisConfig);

    const resolved = events.filter(e => e.outcomeWon !== null);

    // Run all analyses in parallel
    const [vpin, hawkes, benford, timeDecay, kyleLambda] = await Promise.all([
      this.calculateVPIN(events),
      this.estimateHawkesIntensity(events),
      this.calculateBenfordAnomaly(events),
      this.analyzeTimeDecay(events),
      this.estimateKyleLambda(events),
    ]);

    // Generate recommendations
    const recommendations = this.generateRecommendations(vpin, hawkes, benford, timeDecay, kyleLambda);

    // Find top strategies with quant signals
    const topStrategies = await this.findStrategiesWithQuantSignals(events);

    const report: QuantReport = {
      reportType: 'full',
      dataStart: events.length > 0 ? new Date(events[events.length - 1].tradeTimestamp) : new Date(),
      dataEnd: events.length > 0 ? new Date(events[0].tradeTimestamp) : new Date(),
      totalEvents: events.length,
      resolvedEvents: resolved.length,
      vpin,
      hawkes,
      benford,
      timeDecay,
      kyleLambda,
      topStrategies,
      recommendations,
      executionTimeMs: Date.now() - startTime,
      createdAt: new Date(),
    };

    // Store report
    await this.storeReport(report);

    logger.info({ executionTimeMs: report.executionTimeMs }, 'Full quant analysis completed');

    return report;
  }

  /**
   * Run incremental analysis on new events
   */
  async runIncrementalAnalysis(
    newEvents: ContrarianEvent[],
    prevReport?: QuantReport
  ): Promise<QuantReport> {
    const startTime = Date.now();
    logger.info({ newEventsCount: newEvents.length }, 'Starting incremental analysis');

    // For incremental, we only update time-sensitive metrics
    const hawkes = await this.estimateHawkesIntensity(newEvents);
    const vpin = await this.calculateVPIN(newEvents);

    const report: QuantReport = {
      reportType: 'incremental',
      dataStart: new Date(),
      dataEnd: new Date(),
      totalEvents: newEvents.length,
      resolvedEvents: newEvents.filter(e => e.outcomeWon !== null).length,
      vpin,
      hawkes,
      benford: prevReport?.benford || null,
      timeDecay: prevReport?.timeDecay || null,
      kyleLambda: prevReport?.kyleLambda || null,
      topStrategies: [],
      recommendations: [],
      executionTimeMs: Date.now() - startTime,
      createdAt: new Date(),
    };

    return report;
  }

  // ---------------------------------------------------------------------------
  // VPIN (Volume-Synchronized Probability of Informed Trading)
  // ---------------------------------------------------------------------------

  /**
   * Calculate VPIN metric
   * VPIN = |V_buy - V_sell| / V_total over volume buckets
   */
  async calculateVPIN(
    events: ContrarianEvent[],
    bucketSize: number = 50000  // $50k volume buckets
  ): Promise<VPINResult> {
    if (events.length === 0) {
      return {
        vpin: 0,
        bucketCount: 0,
        avgBucketVolume: 0,
        toxicityLevel: 'low',
        timeSeries: [],
      };
    }

    // Sort by timestamp
    const sorted = [...events].sort(
      (a, b) => new Date(a.tradeTimestamp).getTime() - new Date(b.tradeTimestamp).getTime()
    );

    const buckets: Array<{ buyVolume: number; sellVolume: number; timestamp: Date }> = [];
    let currentBuyVolume = 0;
    let currentSellVolume = 0;
    let currentBucketVolume = 0;
    let bucketStartTime = new Date(sorted[0].tradeTimestamp);

    for (const event of sorted) {
      const volume = event.tradeNotional;

      // Classify as buy or sell based on trade side and price movement
      // Using Lee-Ready algorithm approximation: compare to midpoint
      const isBuy = event.tradedOutcome === 'Yes' && event.tradePrice > 0.5;

      if (isBuy) {
        currentBuyVolume += volume;
      } else {
        currentSellVolume += volume;
      }
      currentBucketVolume += volume;

      // Check if bucket is complete
      if (currentBucketVolume >= bucketSize) {
        buckets.push({
          buyVolume: currentBuyVolume,
          sellVolume: currentSellVolume,
          timestamp: bucketStartTime,
        });
        currentBuyVolume = 0;
        currentSellVolume = 0;
        currentBucketVolume = 0;
        bucketStartTime = new Date(event.tradeTimestamp);
      }
    }

    // Don't forget the last partial bucket
    if (currentBucketVolume > 0) {
      buckets.push({
        buyVolume: currentBuyVolume,
        sellVolume: currentSellVolume,
        timestamp: bucketStartTime,
      });
    }

    if (buckets.length === 0) {
      return {
        vpin: 0,
        bucketCount: 0,
        avgBucketVolume: 0,
        toxicityLevel: 'low',
        timeSeries: [],
      };
    }

    // Calculate VPIN for each bucket and overall
    const timeSeries = buckets.map(bucket => {
      const totalVolume = bucket.buyVolume + bucket.sellVolume;
      const imbalance = Math.abs(bucket.buyVolume - bucket.sellVolume);
      return {
        timestamp: bucket.timestamp,
        vpin: totalVolume > 0 ? imbalance / totalVolume : 0,
        volume: totalVolume,
      };
    });

    // Calculate average VPIN
    const avgVpin = timeSeries.reduce((sum, t) => sum + t.vpin, 0) / timeSeries.length;
    const avgBucketVolume = timeSeries.reduce((sum, t) => sum + t.volume, 0) / timeSeries.length;

    // Determine toxicity level
    let toxicityLevel: 'low' | 'medium' | 'high' = 'low';
    if (avgVpin > 0.5) toxicityLevel = 'high';
    else if (avgVpin > 0.3) toxicityLevel = 'medium';

    return {
      vpin: avgVpin,
      bucketCount: buckets.length,
      avgBucketVolume,
      toxicityLevel,
      timeSeries,
    };
  }

  // ---------------------------------------------------------------------------
  // Hawkes Process (Trade Clustering)
  // ---------------------------------------------------------------------------

  /**
   * Estimate Hawkes process parameters for trade clustering
   * λ(t) = μ + Σ α * exp(-β * (t - t_i))
   */
  async estimateHawkesIntensity(
    events: ContrarianEvent[],
    decayHalfLife: number = 5 * 60 * 1000  // 5 minutes in ms
  ): Promise<HawkesResult> {
    if (events.length < 10) {
      return {
        baselineIntensity: 0,
        excitationAlpha: 0,
        decayBeta: 0,
        branchingRatio: 0,
        clusteringScore: 0,
        burstPeriods: [],
      };
    }

    // Sort by timestamp
    const timestamps = events
      .map(e => new Date(e.tradeTimestamp).getTime())
      .sort((a, b) => a - b);

    // Calculate inter-arrival times
    const interArrivals: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      interArrivals.push(timestamps[i] - timestamps[i - 1]);
    }

    // Estimate baseline intensity μ (events per ms)
    const totalDuration = timestamps[timestamps.length - 1] - timestamps[0];
    const baselineIntensity = totalDuration > 0 ? events.length / totalDuration : 0;

    // Estimate decay β from half-life
    const decayBeta = Math.LN2 / decayHalfLife;

    // Estimate excitation α using method of moments
    // For a stationary Hawkes process: E[N]/T = μ / (1 - α/β)
    // Simplified: α ≈ β * (1 - (events/T) * β / μ)
    const avgInterArrival = interArrivals.reduce((a, b) => a + b, 0) / interArrivals.length;
    const interArrivalVariance = interArrivals.reduce(
      (sum, t) => sum + Math.pow(t - avgInterArrival, 2), 0
    ) / interArrivals.length;

    // Use coefficient of variation to estimate clustering
    const cv = Math.sqrt(interArrivalVariance) / avgInterArrival;
    const clusteringScore = Math.min(1, Math.max(0, (cv - 1) / 2));

    // Estimate α from clustering
    const excitationAlpha = decayBeta * clusteringScore;
    const branchingRatio = excitationAlpha / decayBeta;

    // Detect burst periods
    const burstPeriods = this.detectBurstPeriods(timestamps, baselineIntensity * 1000 * 60);

    return {
      baselineIntensity: baselineIntensity * 1000 * 60 * 60, // Convert to per hour
      excitationAlpha,
      decayBeta,
      branchingRatio,
      clusteringScore,
      burstPeriods,
    };
  }

  /**
   * Detect periods of unusually high activity
   */
  private detectBurstPeriods(
    timestamps: number[],
    baselinePerMinute: number
  ): HawkesResult['burstPeriods'] {
    if (timestamps.length < 5 || baselinePerMinute === 0) return [];

    const windowSize = 5 * 60 * 1000; // 5-minute windows
    const burstThreshold = 3; // 3x baseline

    const bursts: HawkesResult['burstPeriods'] = [];
    let windowStart = timestamps[0];
    let windowCount = 0;
    let burstStart: number | null = null;
    let burstCount = 0;

    for (const ts of timestamps) {
      // Move window
      while (ts - windowStart > windowSize && timestamps.indexOf(ts) > 0) {
        const windowEnd = windowStart + windowSize;
        const eventsInWindow = timestamps.filter(t => t >= windowStart && t < windowEnd).length;
        const intensity = eventsInWindow / 5; // Events per minute

        if (intensity > baselinePerMinute * burstThreshold) {
          if (burstStart === null) {
            burstStart = windowStart;
            burstCount = eventsInWindow;
          } else {
            burstCount += eventsInWindow;
          }
        } else if (burstStart !== null) {
          bursts.push({
            startTime: new Date(burstStart),
            endTime: new Date(windowStart),
            eventCount: burstCount,
            intensity: burstCount / ((windowStart - burstStart) / 60000),
          });
          burstStart = null;
          burstCount = 0;
        }

        windowStart += 60000; // Move by 1 minute
      }
      windowCount++;
    }

    return bursts.slice(0, 10); // Return top 10 burst periods
  }

  // ---------------------------------------------------------------------------
  // Benford's Law Anomaly Detection
  // ---------------------------------------------------------------------------

  /**
   * Calculate Benford's Law anomaly score
   */
  async calculateBenfordAnomaly(events: ContrarianEvent[]): Promise<BenfordResult> {
    if (events.length < 30) {
      return {
        chiSquare: 0,
        pValue: 1,
        isAnomalous: false,
        firstDigitDistribution: {},
        expectedDistribution: BENFORD_EXPECTED,
        deviationByDigit: {},
        anomalyScore: 0,
      };
    }

    // Get first digits of trade sizes
    const firstDigits: string[] = [];
    for (const event of events) {
      const notional = Math.round(event.tradeNotional);
      if (notional > 0) {
        const firstDigit = String(notional)[0];
        if (firstDigit >= '1' && firstDigit <= '9') {
          firstDigits.push(firstDigit);
        }
      }
    }

    if (firstDigits.length < 30) {
      return {
        chiSquare: 0,
        pValue: 1,
        isAnomalous: false,
        firstDigitDistribution: {},
        expectedDistribution: BENFORD_EXPECTED,
        deviationByDigit: {},
        anomalyScore: 0,
      };
    }

    // Calculate observed distribution
    const counts: Record<string, number> = {};
    for (let i = 1; i <= 9; i++) {
      counts[String(i)] = 0;
    }
    for (const digit of firstDigits) {
      counts[digit]++;
    }

    const n = firstDigits.length;
    const observed: Record<string, number> = {};
    for (let i = 1; i <= 9; i++) {
      observed[String(i)] = counts[String(i)] / n;
    }

    // Calculate chi-square statistic
    let chiSquare = 0;
    const deviationByDigit: Record<string, number> = {};

    for (let i = 1; i <= 9; i++) {
      const digit = String(i);
      const expectedCount = BENFORD_EXPECTED[digit] * n;
      const observedCount = counts[digit];
      const deviation = observedCount - expectedCount;
      chiSquare += (deviation * deviation) / expectedCount;
      deviationByDigit[digit] = (observed[digit] - BENFORD_EXPECTED[digit]) * 100; // Percentage points
    }

    // Calculate p-value (chi-square with 8 degrees of freedom)
    const pValue = this.chiSquarePValue(chiSquare, 8);

    // Calculate anomaly score (0-1)
    // Higher chi-square = more anomalous
    const anomalyScore = Math.min(1, chiSquare / 50); // Normalize to 0-1

    return {
      chiSquare,
      pValue,
      isAnomalous: pValue < 0.05,
      firstDigitDistribution: observed,
      expectedDistribution: BENFORD_EXPECTED,
      deviationByDigit,
      anomalyScore,
    };
  }

  // ---------------------------------------------------------------------------
  // Time Decay Analysis
  // ---------------------------------------------------------------------------

  /**
   * Analyze win rate decay as a function of time to close
   */
  async analyzeTimeDecay(events: ContrarianEvent[]): Promise<TimeDecayResult> {
    const resolved = events.filter(e => e.outcomeWon !== null);

    if (resolved.length < 20) {
      return {
        timeBuckets: [],
        optimalWindow: { min: 0, max: 60 },
        decayCoefficient: 0,
      };
    }

    // Define time buckets
    const bucketDefs = [
      { min: 0, max: 10 },
      { min: 10, max: 20 },
      { min: 20, max: 30 },
      { min: 30, max: 45 },
      { min: 45, max: 60 },
      { min: 60, max: 90 },
      { min: 90, max: 120 },
    ];

    const timeBuckets: TimeDecayResult['timeBuckets'] = bucketDefs.map(bucket => {
      const bucketEvents = resolved.filter(
        e => e.minutesBeforeClose >= bucket.min && e.minutesBeforeClose < bucket.max
      );

      if (bucketEvents.length === 0) {
        return {
          minMinutes: bucket.min,
          maxMinutes: bucket.max,
          n: 0,
          winRate: 0,
          avgPrice: 0,
          pnl: 0,
          roi: 0,
          edgePoints: 0,
        };
      }

      const wins = bucketEvents.filter(e => e.outcomeWon);
      const losses = bucketEvents.filter(e => !e.outcomeWon);
      const n = bucketEvents.length;
      const winRate = wins.length / n;

      const totalNotional = bucketEvents.reduce((sum, e) => sum + e.tradeNotional, 0);
      const totalWinPnL = wins.reduce((sum, e) => sum + e.tradeNotional * (1 - e.tradePrice), 0);
      const totalLossPnL = losses.reduce((sum, e) => sum - e.tradeNotional * e.tradePrice, 0);
      const pnl = totalWinPnL + totalLossPnL;
      const roi = totalNotional > 0 ? pnl / totalNotional : 0;

      const avgPrice = bucketEvents.reduce((sum, e) => sum + e.tradePrice, 0) / n;
      const edgePoints = (winRate - avgPrice) * 100;

      return {
        minMinutes: bucket.min,
        maxMinutes: bucket.max,
        n,
        winRate,
        avgPrice,
        pnl,
        roi,
        edgePoints,
      };
    });

    // Find optimal window (highest edge points with sufficient sample)
    const validBuckets = timeBuckets.filter(b => b.n >= 10);
    const optimalBucket = validBuckets.reduce(
      (best, bucket) => (bucket.edgePoints > best.edgePoints ? bucket : best),
      validBuckets[0] || { minMinutes: 0, maxMinutes: 60, edgePoints: 0 }
    );

    // Estimate exponential decay coefficient
    // edge(t) = edge_0 * exp(-λt)
    const dataPoints = timeBuckets
      .filter(b => b.n >= 5 && b.edgePoints > 0)
      .map(b => ({
        time: (b.minMinutes + b.maxMinutes) / 2,
        edge: b.edgePoints,
      }));

    let decayCoefficient = 0;
    if (dataPoints.length >= 3) {
      // Simple linear regression on log(edge) vs time
      const logEdges = dataPoints.map(d => ({ x: d.time, y: Math.log(d.edge) }));
      const sumX = logEdges.reduce((s, p) => s + p.x, 0);
      const sumY = logEdges.reduce((s, p) => s + p.y, 0);
      const sumXY = logEdges.reduce((s, p) => s + p.x * p.y, 0);
      const sumX2 = logEdges.reduce((s, p) => s + p.x * p.x, 0);
      const n = logEdges.length;

      decayCoefficient = -((n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX));
    }

    return {
      timeBuckets,
      optimalWindow: {
        min: optimalBucket.minMinutes,
        max: optimalBucket.maxMinutes,
      },
      decayCoefficient: Math.max(0, decayCoefficient),
    };
  }

  // ---------------------------------------------------------------------------
  // Kyle's Lambda (Price Impact)
  // ---------------------------------------------------------------------------

  /**
   * Estimate Kyle's Lambda - price sensitivity to trade size
   * Δp = λ * sign(order) * sqrt(|order|) + ε
   */
  async estimateKyleLambda(events: ContrarianEvent[]): Promise<KyleLambdaResult> {
    // We need drift data for this analysis
    const eventsWithDrift = events.filter(
      e => e.drift30m !== null && e.drift30m !== undefined
    );

    if (eventsWithDrift.length < 20) {
      return {
        lambda: 0,
        permanentImpact: 0,
        temporaryImpact: 0,
        r2: 0,
        priceImpactBySize: [],
      };
    }

    // Calculate price impact for each trade
    // Impact = drift direction matching trade direction
    const impacts = eventsWithDrift.map(e => {
      const tradeDirection = e.tradedOutcome === 'Yes' ? 1 : -1;
      const drift = e.drift30m || 0;
      const signedImpact = tradeDirection * drift;
      return {
        size: e.tradeNotional,
        sqrtSize: Math.sqrt(e.tradeNotional),
        impact: signedImpact,
      };
    });

    // Linear regression: impact = λ * sqrt(size)
    const sumX = impacts.reduce((s, i) => s + i.sqrtSize, 0);
    const sumY = impacts.reduce((s, i) => s + i.impact, 0);
    const sumXY = impacts.reduce((s, i) => s + i.sqrtSize * i.impact, 0);
    const sumX2 = impacts.reduce((s, i) => s + i.sqrtSize * i.sqrtSize, 0);
    const n = impacts.length;

    const lambda = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    // Calculate R²
    const meanY = sumY / n;
    const ssTotal = impacts.reduce((s, i) => s + Math.pow(i.impact - meanY, 2), 0);
    const ssResidual = impacts.reduce((s, i) => {
      const predicted = lambda * i.sqrtSize;
      return s + Math.pow(i.impact - predicted, 2);
    }, 0);
    const r2 = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;

    // Calculate impact by size quantile
    const sorted = [...impacts].sort((a, b) => a.size - b.size);
    const quantiles = [0.25, 0.5, 0.75, 0.9, 0.99];
    const priceImpactBySize = quantiles.map(q => {
      const idx = Math.floor(q * sorted.length);
      const subset = sorted.slice(Math.max(0, idx - 10), Math.min(sorted.length, idx + 10));
      const avgImpact = subset.reduce((s, i) => s + i.impact, 0) / subset.length;
      return {
        sizeQuantile: q,
        avgImpact,
        n: subset.length,
      };
    });

    return {
      lambda: Math.abs(lambda),
      permanentImpact: lambda * 0.6, // Approximation: 60% of impact is permanent
      temporaryImpact: lambda * 0.4, // 40% is temporary
      r2: Math.max(0, r2),
      priceImpactBySize,
    };
  }

  // ---------------------------------------------------------------------------
  // Recommendations
  // ---------------------------------------------------------------------------

  /**
   * Generate actionable recommendations from quant analysis
   */
  private generateRecommendations(
    vpin: VPINResult | null,
    hawkes: HawkesResult | null,
    benford: BenfordResult | null,
    timeDecay: TimeDecayResult | null,
    kyleLambda: KyleLambdaResult | null
  ): string[] {
    const recommendations: string[] = [];

    // VPIN recommendations
    if (vpin && vpin.toxicityLevel === 'high') {
      recommendations.push(
        'HIGH VPIN detected - informed trading is likely. Consider reducing position sizes or waiting for volume to normalize.'
      );
    } else if (vpin && vpin.toxicityLevel === 'medium') {
      recommendations.push(
        'Moderate VPIN detected - some informed trading activity. Monitor closely.'
      );
    }

    // Hawkes recommendations
    if (hawkes && hawkes.clusteringScore > 0.7) {
      recommendations.push(
        'High trade clustering detected - events are not random. Look for patterns in burst periods.'
      );
    }
    if (hawkes && hawkes.burstPeriods.length > 0) {
      recommendations.push(
        `Detected ${hawkes.burstPeriods.length} burst periods. Consider timing trades to avoid these periods.`
      );
    }

    // Benford recommendations
    if (benford && benford.isAnomalous) {
      recommendations.push(
        'Trade sizes deviate significantly from Benford\'s Law. This may indicate non-natural trading patterns.'
      );
      if (benford.deviationByDigit['1'] && benford.deviationByDigit['1'] > 10) {
        recommendations.push(
          'Excess of trades starting with "1" suggests round-number bias. Consider filtering these out.'
        );
      }
    }

    // Time decay recommendations
    if (timeDecay && timeDecay.optimalWindow) {
      const { min, max } = timeDecay.optimalWindow;
      recommendations.push(
        `Optimal trading window: ${min}-${max} minutes before close. Edge decays with coefficient ${timeDecay.decayCoefficient.toFixed(4)}.`
      );
    }

    // Kyle's Lambda recommendations
    if (kyleLambda && kyleLambda.lambda > 0) {
      recommendations.push(
        `Price impact: ${(kyleLambda.lambda * 1000).toFixed(2)} bps per $1000^0.5. Consider smaller positions to reduce slippage.`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push('No significant anomalies detected. Continue with current strategy.');
    }

    return recommendations;
  }

  /**
   * Find strategies that align with quant signals
   */
  private async findStrategiesWithQuantSignals(
    events: ContrarianEvent[]
  ): Promise<QuantReport['topStrategies']> {
    // Group events by configuration characteristics
    const resolved = events.filter(e => e.outcomeWon !== null);

    if (resolved.length < 20) return [];

    // Analyze by different filters and find best performers
    const strategies: QuantReport['topStrategies'] = [];

    // Check VPIN-filtered strategy
    const highVPINEvents = resolved.filter(e => {
      // Approximate high VPIN: vs_ofi trades
      return e.isAgainstOfi;
    });

    if (highVPINEvents.length >= 10) {
      const metrics = this.calculateEventMetrics(highVPINEvents);
      strategies.push({
        config: { contrarianMode: 'vs_ofi' as const },
        metrics,
        quantSignals: ['VPIN_HIGH'],
      });
    }

    // Check time-decay optimized strategy
    const optimalTimeEvents = resolved.filter(
      e => e.minutesBeforeClose >= 10 && e.minutesBeforeClose <= 60
    );

    if (optimalTimeEvents.length >= 10) {
      const metrics = this.calculateEventMetrics(optimalTimeEvents);
      strategies.push({
        config: { minMinutes: 10, windowMinutes: 60 },
        metrics,
        quantSignals: ['TIME_DECAY_OPTIMAL'],
      });
    }

    // Check non-round-number trades (Benford filter)
    const nonRoundEvents = resolved.filter(e => {
      const firstDigit = String(Math.round(e.tradeNotional))[0];
      return firstDigit >= '2' && firstDigit <= '4';
    });

    if (nonRoundEvents.length >= 10) {
      const metrics = this.calculateEventMetrics(nonRoundEvents);
      strategies.push({
        config: {},
        metrics,
        quantSignals: ['BENFORD_OPTIMAL'],
      });
    }

    // Sort by edge points
    strategies.sort((a, b) => {
      const edgeA = (a.metrics.winRate - 0.5) * 100; // Approximate edge
      const edgeB = (b.metrics.winRate - 0.5) * 100;
      return edgeB - edgeA;
    });

    return strategies.slice(0, 5);
  }

  /**
   * Calculate metrics for a set of events
   */
  private calculateEventMetrics(events: ContrarianEvent[]): {
    n: number;
    winRate: number;
    pnl: number;
    roi: number;
  } {
    const wins = events.filter(e => e.outcomeWon);
    const losses = events.filter(e => !e.outcomeWon);
    const n = events.length;
    const winRate = wins.length / n;

    const totalNotional = events.reduce((sum, e) => sum + e.tradeNotional, 0);
    const totalWinPnL = wins.reduce((sum, e) => sum + e.tradeNotional * (1 - e.tradePrice), 0);
    const totalLossPnL = losses.reduce((sum, e) => sum - e.tradeNotional * e.tradePrice, 0);
    const pnl = totalWinPnL + totalLossPnL;
    const roi = totalNotional > 0 ? pnl / totalNotional : 0;

    return { n, winRate, pnl, roi };
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  /**
   * Store quant report in database
   */
  private async storeReport(report: QuantReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO quant_reports
       (report_type, data_start, data_end, total_events, resolved_events,
        top_strategies, recommendations, config_used, execution_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        report.reportType,
        report.dataStart,
        report.dataEnd,
        report.totalEvents,
        report.resolvedEvents,
        JSON.stringify(report.topStrategies),
        JSON.stringify(report.recommendations),
        JSON.stringify({
          vpin: report.vpin,
          hawkes: report.hawkes,
          benford: report.benford,
          timeDecay: report.timeDecay,
          kyleLambda: report.kyleLambda,
        }),
        report.executionTimeMs,
      ]
    );
  }

  /**
   * Get recent reports
   */
  async getRecentReports(limit: number = 10): Promise<QuantReport[]> {
    const result = await this.pool.query(
      `SELECT * FROM quant_reports ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    return result.rows.map(row => {
      const configUsed = typeof row.config_used === 'string'
        ? JSON.parse(row.config_used)
        : row.config_used;

      return {
        id: row.id,
        reportType: row.report_type,
        dataStart: row.data_start,
        dataEnd: row.data_end,
        totalEvents: row.total_events,
        resolvedEvents: row.resolved_events,
        vpin: configUsed?.vpin || null,
        hawkes: configUsed?.hawkes || null,
        benford: configUsed?.benford || null,
        timeDecay: configUsed?.timeDecay || null,
        kyleLambda: configUsed?.kyleLambda || null,
        topStrategies: typeof row.top_strategies === 'string'
          ? JSON.parse(row.top_strategies)
          : row.top_strategies,
        recommendations: typeof row.recommendations === 'string'
          ? JSON.parse(row.recommendations)
          : row.recommendations,
        executionTimeMs: row.execution_time_ms,
        createdAt: row.created_at,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Utility Functions
  // ---------------------------------------------------------------------------

  /**
   * Chi-square p-value approximation
   */
  private chiSquarePValue(chiSquare: number, df: number): number {
    // Wilson-Hilferty approximation
    if (chiSquare <= 0) return 1;

    const x = Math.pow(chiSquare / df, 1 / 3);
    const mean = 1 - 2 / (9 * df);
    const stdDev = Math.sqrt(2 / (9 * df));
    const z = (x - mean) / stdDev;

    // Standard normal CDF
    return 1 - this.normalCDF(z);
  }

  /**
   * Standard normal CDF approximation
   */
  private normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
  }
}
