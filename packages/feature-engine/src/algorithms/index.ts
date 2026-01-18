// =============================================================================
// Algorithm Exports
// =============================================================================

export {
  TDigestManager,
  computeQuantiles,
} from './t-digest.js';

export {
  computeRobustZScore,
  computeRobustStats,
  computeRobustZScoreFromValues,
  median,
  mad,
  identifyOutliers,
  type RobustStats,
} from './robust-zscore.js';

export {
  FocusCusum,
  computeChangePointScore,
  detectRegimeShift,
  type FocusState,
} from './focus-cusum.js';

export {
  HawkesProxy,
  estimateBaselineIntensity,
  computeInterArrivalTimes,
  type HawkesState,
} from './hawkes-proxy.js';
