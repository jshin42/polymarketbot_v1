// =============================================================================
// Hawkes Process Proxy - Simplified self-exciting point process
// =============================================================================

/**
 * Hawkes process state for persistence
 */
export interface HawkesState {
  intensity: number;           // Current intensity
  lastEventTime: number;       // Timestamp of last event (ms)
  eventCount: number;          // Total event count
  baselineIntensity: number;   // Baseline (background) intensity
}

/**
 * Simplified Hawkes process for burst detection
 *
 * The Hawkes process models self-exciting behavior where each event
 * increases the probability of future events. The intensity decays
 * exponentially over time.
 *
 * Intensity: λ(t) = μ + Σ α * exp(-β * (t - t_i))
 * where:
 * - μ = baseline intensity
 * - α = jump size (excitation)
 * - β = decay rate
 */
export class HawkesProxy {
  private state: HawkesState;
  private readonly alpha: number; // Jump size
  private readonly beta: number;  // Decay rate

  constructor(
    baselineIntensity: number = 0.1,  // Events per second baseline
    alpha: number = 0.5,               // Jump magnitude
    beta: number = 0.1                 // Decay rate (higher = faster decay)
  ) {
    this.alpha = alpha;
    this.beta = beta;
    this.state = {
      intensity: baselineIntensity,
      lastEventTime: 0,
      eventCount: 0,
      baselineIntensity,
    };
  }

  /**
   * Record a new event and update intensity
   *
   * @param timestamp Event timestamp in milliseconds
   * @returns Current intensity after the event
   */
  recordEvent(timestamp: number): number {
    // Decay intensity since last event
    if (this.state.lastEventTime > 0) {
      const timeDelta = (timestamp - this.state.lastEventTime) / 1000; // Convert to seconds
      this.state.intensity = this.state.baselineIntensity +
        (this.state.intensity - this.state.baselineIntensity) * Math.exp(-this.beta * timeDelta);
    }

    // Jump intensity due to new event
    this.state.intensity += this.alpha;
    this.state.lastEventTime = timestamp;
    this.state.eventCount++;

    return this.state.intensity;
  }

  /**
   * Get current intensity at a given time (without recording an event)
   *
   * @param currentTime Current timestamp in milliseconds
   * @returns Current intensity
   */
  getCurrentIntensity(currentTime: number): number {
    if (this.state.lastEventTime === 0) {
      return this.state.baselineIntensity;
    }

    const timeDelta = (currentTime - this.state.lastEventTime) / 1000;
    return this.state.baselineIntensity +
      (this.state.intensity - this.state.baselineIntensity) * Math.exp(-this.beta * timeDelta);
  }

  /**
   * Check if current intensity indicates a burst
   *
   * @param currentTime Current timestamp
   * @param threshold Threshold multiplier (default 2.0 = 2x baseline)
   * @returns True if bursting
   */
  isBurst(currentTime: number, threshold: number = 2.0): boolean {
    const intensity = this.getCurrentIntensity(currentTime);
    return intensity > threshold * this.state.baselineIntensity;
  }

  /**
   * Get intensity ratio (current / baseline)
   */
  getIntensityRatio(currentTime: number): number {
    const intensity = this.getCurrentIntensity(currentTime);
    return this.state.baselineIntensity > 0
      ? intensity / this.state.baselineIntensity
      : 1;
  }

  /**
   * Compute burst score (0-1)
   *
   * Maps intensity ratio to a score:
   * - 0 when intensity = baseline
   * - 0.5 when intensity = 2x baseline
   * - 1 when intensity >= 5x baseline
   */
  getBurstScore(currentTime: number): number {
    const ratio = this.getIntensityRatio(currentTime);

    if (ratio <= 1) {
      return 0;
    }

    // Map [1, 5] to [0, 1]
    return Math.min(1, (ratio - 1) / 4);
  }

  /**
   * Get current state
   */
  getState(): HawkesState {
    return { ...this.state };
  }

  /**
   * Reset the process
   */
  reset(): void {
    const baseline = this.state.baselineIntensity;
    this.state = {
      intensity: baseline,
      lastEventTime: 0,
      eventCount: 0,
      baselineIntensity: baseline,
    };
  }

  /**
   * Update baseline intensity (e.g., based on recent averages)
   */
  setBaselineIntensity(baseline: number): void {
    this.state.baselineIntensity = baseline;
  }

  /**
   * Restore from saved state
   */
  static fromState(
    state: HawkesState,
    alpha: number = 0.5,
    beta: number = 0.1
  ): HawkesProxy {
    const instance = new HawkesProxy(state.baselineIntensity, alpha, beta);
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
    alpha: number = 0.5,
    beta: number = 0.1
  ): HawkesProxy {
    const state = JSON.parse(json) as HawkesState;
    return HawkesProxy.fromState(state, alpha, beta);
  }
}

/**
 * Estimate baseline intensity from inter-arrival times
 *
 * @param interArrivalTimes Array of inter-arrival times in milliseconds
 * @returns Estimated baseline intensity (events per second)
 */
export function estimateBaselineIntensity(interArrivalTimes: number[]): number {
  if (interArrivalTimes.length === 0) {
    return 0.1; // Default
  }

  const meanInterArrival = interArrivalTimes.reduce((a, b) => a + b, 0) / interArrivalTimes.length;

  // Convert from ms to seconds and invert to get rate
  return meanInterArrival > 0 ? 1000 / meanInterArrival : 0.1;
}

/**
 * Compute inter-arrival times from event timestamps
 */
export function computeInterArrivalTimes(timestamps: number[]): number[] {
  if (timestamps.length < 2) {
    return [];
  }

  const sorted = [...timestamps].sort((a, b) => a - b);
  const interArrivals: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    interArrivals.push(sorted[i]! - sorted[i - 1]!);
  }

  return interArrivals;
}
