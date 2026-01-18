// =============================================================================
// FOCuS (Functional Online Change-point detection using CUSUM)
// Simplified implementation for online change-point detection
// =============================================================================

/**
 * FOCuS/CUSUM state for persistence
 */
export interface FocusState {
  n: number;                    // Number of observations
  sumX: number;                 // Sum of observations
  sumX2: number;                // Sum of squared observations
  maxStatistic: number;         // Maximum CUSUM statistic
  changePointIndex: number | null; // Index of detected change point
  lastValue: number | null;     // Last observed value
}

/**
 * FOCuS CUSUM for online change-point detection
 *
 * This implements a simplified version of the CUSUM (Cumulative Sum)
 * algorithm for detecting shifts in the mean of a data stream.
 */
export class FocusCusum {
  private state: FocusState;
  private readonly threshold: number;
  private readonly preChangeMean: number | null;

  constructor(
    threshold: number = 5.0,
    preChangeMean: number | null = null
  ) {
    this.threshold = threshold;
    this.preChangeMean = preChangeMean;
    this.state = this.initializeState();
  }

  /**
   * Initialize fresh state
   */
  private initializeState(): FocusState {
    return {
      n: 0,
      sumX: 0,
      sumX2: 0,
      maxStatistic: 0,
      changePointIndex: null,
      lastValue: null,
    };
  }

  /**
   * Update with new observation
   *
   * @param value New observation
   * @returns Detection result
   */
  update(value: number): {
    detected: boolean;
    statistic: number;
    changePointIndex: number | null;
  } {
    this.state.n++;
    this.state.sumX += value;
    this.state.sumX2 += value * value;
    this.state.lastValue = value;

    // Compute current statistics
    const mean = this.preChangeMean ?? this.state.sumX / this.state.n;
    const variance = this.computeVariance();

    // Standardize the observation
    const standardized = variance > 0
      ? (value - mean) / Math.sqrt(variance)
      : 0;

    // Update CUSUM statistic (Page's CUSUM for mean shift)
    // S_n = max(0, S_{n-1} + (x_n - mu_0) / sigma)
    const newStatistic = Math.max(0, this.state.maxStatistic + standardized);

    // Check for change point
    const detected = newStatistic > this.threshold;

    if (detected && this.state.changePointIndex === null) {
      this.state.changePointIndex = this.state.n;
    }

    this.state.maxStatistic = newStatistic;

    return {
      detected,
      statistic: newStatistic,
      changePointIndex: this.state.changePointIndex,
    };
  }

  /**
   * Compute sample variance
   */
  private computeVariance(): number {
    if (this.state.n < 2) {
      return 1; // Default variance for small samples
    }

    const mean = this.state.sumX / this.state.n;
    const variance = (this.state.sumX2 - this.state.n * mean * mean) / (this.state.n - 1);

    return Math.max(variance, 0.0001); // Avoid division by zero
  }

  /**
   * Reset the detector
   */
  reset(): void {
    this.state = this.initializeState();
  }

  /**
   * Get current state
   */
  getState(): FocusState {
    return { ...this.state };
  }

  /**
   * Get current statistic value
   */
  getStatistic(): number {
    return this.state.maxStatistic;
  }

  /**
   * Check if change point detected
   */
  isDetected(): boolean {
    return this.state.changePointIndex !== null;
  }

  /**
   * Restore from saved state
   */
  static fromState(
    state: FocusState,
    threshold: number = 5.0,
    preChangeMean: number | null = null
  ): FocusCusum {
    const instance = new FocusCusum(threshold, preChangeMean);
    instance.state = { ...state };
    return instance;
  }

  /**
   * Serialize state to JSON
   */
  serialize(): string {
    return JSON.stringify(this.state);
  }

  /**
   * Deserialize state from JSON
   */
  static deserialize(
    json: string,
    threshold: number = 5.0,
    preChangeMean: number | null = null
  ): FocusCusum {
    const state = JSON.parse(json) as FocusState;
    return FocusCusum.fromState(state, threshold, preChangeMean);
  }
}

/**
 * Compute change-point score (0-1) from statistic
 *
 * Maps CUSUM statistic to a 0-1 score:
 * - 0 when statistic is low (no change)
 * - 1 when statistic exceeds threshold (change detected)
 */
export function computeChangePointScore(
  statistic: number,
  threshold: number = 5.0
): number {
  // Sigmoid-like mapping
  const normalized = statistic / threshold;
  return Math.min(1, Math.max(0, normalized));
}

/**
 * Detect regime shift direction
 */
export function detectRegimeShift(
  statistic: number,
  lastValue: number | null,
  historicalMean: number | null
): 'none' | 'increase' | 'decrease' {
  if (lastValue === null || historicalMean === null) {
    return 'none';
  }

  if (statistic < 2) {
    return 'none'; // Insufficient evidence
  }

  return lastValue > historicalMean ? 'increase' : 'decrease';
}
