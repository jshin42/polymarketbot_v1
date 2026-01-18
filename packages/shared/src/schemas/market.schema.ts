import { z } from 'zod';
import { MARKET_FILTERING } from '../constants/index.js';

// =============================================================================
// Market Schemas
// =============================================================================

/**
 * Outcome represents a single outcome option in a binary market
 */
export const OutcomeSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  tokenId: z.string().min(1),
});

export type Outcome = z.infer<typeof OutcomeSchema>;

/**
 * Market status enum
 */
export const MarketStatusSchema = z.enum([
  'active',
  'closed',
  'resolved',
  'archived',
]);

export type MarketStatus = z.infer<typeof MarketStatusSchema>;

/**
 * Full market metadata from Gamma API
 */
export const MarketMetadataSchema = z.object({
  conditionId: z.string().length(66, 'Condition ID must be 66 characters'),
  question: z.string().min(1),
  description: z.string().optional(),
  outcomes: z.array(OutcomeSchema).length(2, 'Binary markets must have exactly 2 outcomes'),
  endDateIso: z.string().datetime(),
  active: z.boolean(),
  closed: z.boolean().default(false),
  resolved: z.boolean().default(false),
  volume: z.number().nonnegative(),
  liquidity: z.number().nonnegative(),
  negRisk: z.boolean().default(false),
  slug: z.string().optional(),
  eventSlug: z.string().optional(),
  tags: z.array(z.string()).default([]),
  category: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});

export type MarketMetadata = z.infer<typeof MarketMetadataSchema>;

/**
 * Simplified market reference used in other schemas
 */
export const MarketRefSchema = z.object({
  conditionId: z.string(),
  question: z.string(),
  endDateIso: z.string().datetime(),
});

export type MarketRef = z.infer<typeof MarketRefSchema>;

/**
 * Event object from Gamma API (markets are grouped into events)
 */
export const GammaEventSchema = z.object({
  id: z.string().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional().nullable(),
}).passthrough();

/**
 * Raw market response from Gamma API (camelCase format)
 * Note: API returns camelCase, not snake_case
 */
export const GammaMarketResponseSchema = z.object({
  conditionId: z.string(),
  question: z.string(),
  description: z.string().optional().nullable(),
  slug: z.string().optional().nullable(),
  market_slug: z.string().optional().nullable(), // Some markets use snake_case
  endDate: z.string().optional().nullable(),
  endDateIso: z.string().optional().nullable(),
  active: z.boolean(),
  closed: z.boolean(),
  archived: z.boolean().optional().default(false),
  volume: z.string(),
  liquidity: z.string(),
  outcomes: z.string(), // JSON string
  outcomePrices: z.string().optional().nullable(),
  clobTokenIds: z.string().optional().nullable(), // JSON array of token IDs as string
  negRisk: z.boolean().optional().default(false),
  tags: z.array(z.object({
    id: z.string().optional(),
    slug: z.string().optional(),
    label: z.string().optional(),
  })).optional().nullable(),
  events: z.array(GammaEventSchema).optional().nullable(), // Event/category info
}).passthrough(); // Allow additional fields

export type GammaMarketResponse = z.infer<typeof GammaMarketResponseSchema>;

/**
 * Transform Gamma API response to canonical MarketMetadata
 */
export function transformGammaMarket(raw: GammaMarketResponse): MarketMetadata {
  // Parse clobTokenIds if available, otherwise use outcomes
  let tokenIds: string[] = [];
  if (raw.clobTokenIds) {
    try {
      tokenIds = JSON.parse(raw.clobTokenIds);
    } catch {
      tokenIds = [];
    }
  }

  // Parse outcomes to get names
  let outcomeNames: string[] = [];
  if (raw.outcomes) {
    try {
      outcomeNames = JSON.parse(raw.outcomes);
    } catch {
      outcomeNames = [];
    }
  }

  // Create outcomes array by combining token IDs with outcome names
  const outcomes: Outcome[] = outcomeNames.map((name, index) => ({
    id: String(index),
    name,
    tokenId: tokenIds[index] ?? '',
  })).filter(o => o.tokenId); // Only include outcomes with token IDs

  // Use endDateIso if available, otherwise parse endDate
  const endDateIso = raw.endDateIso ?? (raw.endDate ? raw.endDate.split('T')[0] : '');

  // Extract category from events[0].title or tags
  // Gamma API often has null tags but events[0].title contains useful categorization
  const event = raw.events?.[0];
  const eventTitle = event?.title ?? '';
  const eventSlug = event?.slug ?? '';

  // Collect tags from multiple sources
  const tags: string[] = [];

  // Add labels from tags array (if present)
  if (raw.tags) {
    for (const t of raw.tags) {
      if (t.label) tags.push(t.label);
    }
  }

  // Add event title and slug as searchable tags
  if (eventTitle) tags.push(eventTitle);
  if (eventSlug) {
    // Convert slug to readable format: "trump-deportation" -> "trump deportation"
    tags.push(eventSlug.replace(/-/g, ' '));
  }

  // Use event title as category, falling back to first tag label
  const category = eventTitle || raw.tags?.[0]?.label;

  return {
    conditionId: raw.conditionId,
    question: raw.question,
    description: raw.description ?? undefined,
    outcomes,
    endDateIso,
    active: raw.active,
    closed: raw.closed,
    resolved: raw.closed && !raw.active, // Approximate resolved state
    volume: parseFloat(raw.volume) || 0,
    liquidity: parseFloat(raw.liquidity) || 0,
    negRisk: raw.negRisk ?? false,
    slug: raw.slug ?? raw.market_slug ?? undefined,
    eventSlug: eventSlug || undefined,
    tags,
    category,
  };
}

// =============================================================================
// Market Filtering
// =============================================================================

/**
 * Filter result with reason for debugging
 */
export interface MarketFilterResult {
  /** Whether the market should be filtered (excluded) */
  filtered: boolean;
  /** Reason for filtering (if filtered) */
  reason?: string;
}

/**
 * Determines if a market should be filtered out based on configured rules.
 *
 * Filtering logic:
 * 1. If filtering is disabled, always include
 * 2. Check minimum volume threshold
 * 3. Check minimum liquidity threshold
 * 4. Check tag/question blacklist (any blacklisted term = filtered)
 * 5. Check category/tag/question whitelist (if whitelist exists, must match one)
 *
 * @param market - Canonical MarketMetadata object
 * @returns Filter result with reason
 */
export function shouldFilterMarket(market: MarketMetadata): MarketFilterResult {
  // Check if filtering is enabled
  if (!MARKET_FILTERING.ENABLED) {
    return { filtered: false };
  }

  // Check volume threshold
  if (market.volume < MARKET_FILTERING.MIN_VOLUME_USD) {
    return {
      filtered: true,
      reason: `Volume ${market.volume.toFixed(0)} below minimum ${MARKET_FILTERING.MIN_VOLUME_USD}`,
    };
  }

  // Check liquidity threshold
  if (market.liquidity < MARKET_FILTERING.MIN_LIQUIDITY_USD) {
    return {
      filtered: true,
      reason: `Liquidity ${market.liquidity.toFixed(0)} below minimum ${MARKET_FILTERING.MIN_LIQUIDITY_USD}`,
    };
  }

  // Normalize for case-insensitive comparison
  const marketTags = market.tags.map(t => t.toLowerCase());
  const marketCategory = market.category?.toLowerCase() ?? '';
  const questionLower = market.question.toLowerCase();

  // Build searchable text from all sources
  const searchableText = [
    questionLower,
    marketCategory,
    ...marketTags,
  ].join(' ');

  // Helper: check if a word appears as a whole word (word boundary matching)
  const containsWord = (text: string, word: string): boolean => {
    // Use word boundary regex to avoid matching "war" in "award"
    const regex = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return regex.test(text);
  };

  // Check blacklist against tags, category, AND question text
  const blacklistLower = MARKET_FILTERING.TAG_BLACKLIST.map(t => t.toLowerCase());
  for (const blacklistTerm of blacklistLower) {
    // Exact tag match
    if (marketTags.includes(blacklistTerm)) {
      return {
        filtered: true,
        reason: `Blacklisted tag: ${blacklistTerm}`,
      };
    }
    // Category match
    if (marketCategory === blacklistTerm) {
      return {
        filtered: true,
        reason: `Blacklisted category: ${blacklistTerm}`,
      };
    }
    // Question contains blacklisted term as whole word
    if (containsWord(questionLower, blacklistTerm)) {
      return {
        filtered: true,
        reason: `Blacklisted term in question: ${blacklistTerm}`,
      };
    }
  }

  // Check category whitelist (if configured)
  const whitelistLower = MARKET_FILTERING.CATEGORY_WHITELIST.map(c => c.toLowerCase());
  if (whitelistLower.length > 0) {
    // Check if category matches whitelist
    const categoryMatch = marketCategory && whitelistLower.includes(marketCategory);

    // Check if any tag contains a whitelist term
    const tagMatch = marketTags.some(tag =>
      whitelistLower.some(wl => tag.includes(wl) || wl.includes(tag))
    );

    // Check if question contains any whitelist keyword (whole word match)
    // This catches political markets like "Will Trump deport..." even if tags are empty
    const questionMatch = whitelistLower.some(wl =>
      containsWord(questionLower, wl)
    );

    if (!categoryMatch && !tagMatch && !questionMatch) {
      return {
        filtered: true,
        reason: `No whitelist match. Category: "${market.category ?? 'none'}", Tags: [${market.tags.slice(0, 3).join(', ')}]`,
      };
    }
  }

  // Market passes all filters
  return { filtered: false };
}
