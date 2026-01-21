import { Redis, RedisKeys, createLogger } from '@polymarketbot/shared';

// =============================================================================
// Wallet Profile Service
// =============================================================================

const logger = createLogger('wallet-profile-service');

export interface WalletProfile {
  address: string;
  username: string | null;
  joinedDate: string | null; // "May 2025" format
  joinedTimestamp: number | null;
  profileUrl: string;
  polygonscanUrl: string;
}

const PROFILE_CACHE_TTL = 86400; // 24 hours - join date doesn't change

export class WalletProfileService {
  constructor(private readonly redis: Redis) {}

  /**
   * Get wallet profile with join date
   * Checks cache first, then fetches from Polymarket profile page
   */
  async getProfile(addressOrUsername: string): Promise<WalletProfile> {
    // Normalize the key - could be username or address
    const cacheKey = RedisKeys.walletProfile(addressOrUsername.toLowerCase());

    // Check cache first
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch {
        // Cache corrupted, refetch
      }
    }

    // Fetch from Polymarket profile
    const profile = await this.fetchProfile(addressOrUsername);

    // Cache the result
    await this.redis.set(cacheKey, JSON.stringify(profile), 'EX', PROFILE_CACHE_TTL);

    return profile;
  }

  /**
   * Fetch profile from Polymarket
   * Profile URL: https://polymarket.com/@{addressOrUsername}
   */
  private async fetchProfile(addressOrUsername: string): Promise<WalletProfile> {
    const profileUrl = `https://polymarket.com/@${addressOrUsername}`;
    // Determine polygonscan URL based on whether input looks like an address
    const isAddress = addressOrUsername.startsWith('0x') && addressOrUsername.length === 42;
    const polygonscanUrl = isAddress
      ? `https://polygonscan.com/address/${addressOrUsername}`
      : `https://polygonscan.com/address/${addressOrUsername}`; // Will be updated if we find the address

    // Fallback: scrape profile page HTML
    try {
      const pageResponse = await fetch(profileUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (pageResponse.ok) {
        const html = await pageResponse.text();

        // Extract joined date - look for patterns like:
        // "Joined" followed by "May 2025" in nearby spans
        // From the DOM inspection: <span class="text-sm whitespace-nowrap">"Joined"</span> + "May 2025"
        let joinedDate: string | null = null;
        let joinedTimestamp: number | null = null;

        // Try multiple patterns - ordered by specificity (most accurate first)
        const patterns = [
          // Pattern 1: joinDate JSON field (most reliable - from user profile stats)
          // Matches: {"joinDate":"Jan 2026"}
          /"joinDate"\s*:\s*"([A-Z][a-z]+ \d{4})"/i,

          // Pattern 2: "Joined" text node followed by month year in HTML
          /Joined["\s<>span\/]*["']?([A-Z][a-z]+ \d{4})["']?/i,

          // Pattern 3: Direct month year after Joined span
          /Joined\s*<\/span>\s*<span[^>]*>\s*"?([A-Z][a-z]+ \d{4})"?/i,

          // Pattern 4: joinedAt timestamp (ISO format) - if available
          /"joinedAt"\s*:\s*"(\d{4}-\d{2}-\d{2})/i,

          // NOTE: createdAt pattern REMOVED - it incorrectly matches category metadata
        ];

        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match) {
            // Check if it's a date string (YYYY-MM-DD) or month year
            if (match[1].includes('-')) {
              // It's a date string like 2025-05-15
              joinedTimestamp = new Date(match[1]).getTime();
              joinedDate = this.formatJoinDate(joinedTimestamp);
            } else {
              // It's already month year format like "May 2025"
              joinedDate = match[1];
              joinedTimestamp = this.parseJoinDate(match[1]);
            }
            break;
          }
        }

        // Extract wallet address if we can find it
        const addressMatch = html.match(/0x[a-fA-F0-9]{40}/);
        const foundAddress = addressMatch ? addressMatch[0] : (isAddress ? addressOrUsername : null);

        logger.debug(
          { addressOrUsername, joinedDate, foundAddress },
          'Fetched wallet profile'
        );

        return {
          address: foundAddress ?? addressOrUsername,
          username: isAddress ? null : addressOrUsername,
          joinedDate,
          joinedTimestamp,
          profileUrl,
          polygonscanUrl: foundAddress
            ? `https://polygonscan.com/address/${foundAddress}`
            : polygonscanUrl,
        };
      }
    } catch (error) {
      logger.debug({ error, addressOrUsername }, 'Profile page fetch failed');
    }

    // Return minimal profile if all fetches fail
    return {
      address: isAddress ? addressOrUsername : addressOrUsername,
      username: isAddress ? null : addressOrUsername,
      joinedDate: null,
      joinedTimestamp: null,
      profileUrl,
      polygonscanUrl,
    };
  }

  /**
   * Format timestamp to "May 2025" format
   */
  private formatJoinDate(timestamp: number | null): string | null {
    if (!timestamp) return null;
    const date = new Date(timestamp);
    if (isNaN(date.getTime())) return null;

    const months = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${months[date.getMonth()]} ${date.getFullYear()}`;
  }

  /**
   * Parse "May 2025" back to timestamp
   */
  private parseJoinDate(dateStr: string): number | null {
    const months: Record<string, number> = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };

    const match = dateStr.match(/([A-Za-z]+)\s+(\d{4})/);
    if (!match) return null;

    const month = months[match[1].toLowerCase().slice(0, 3)];
    const year = parseInt(match[2], 10);

    if (month === undefined || isNaN(year)) return null;

    return new Date(year, month, 1).getTime();
  }
}
