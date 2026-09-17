/**
 * Starter tradable-universe config (FR-2.3 asset universe management).
 *
 * The SRS is explicit that "all coins" is a filter problem, not something to
 * hardcode (section 2.3). M0 deliberately starts with a small, manually
 * curated + liquidity-verified list rather than building the full
 * auto-discovery/filter pipeline — see README "Deviations" section. Adding
 * an asset is a config change here, not a code change to the engine.
 */

export interface AssetConfig {
  canonicalAssetId: string;
  quoteAssetId: string; // what it's priced against on both venues (kept identical to avoid stablecoin cross-comparison)
  raydium: {
    poolId: string;
    mintA: string;
    mintB: string;
  };
  mexc: {
    symbol: string;
  };
  // Optional: not every asset lists on every CEX. RAY, for example, isn't on
  // Bybit — a small, real instance of the SRS's own point that "all coins"
  // is a filter/availability problem, not a given. Adapters and the
  // detector already skip a (venue, asset) pair with no mapping.
  bybit?: {
    symbol: string;
  };
}

export const ASSET_UNIVERSE: AssetConfig[] = [
  {
    canonicalAssetId: "SOL",
    quoteAssetId: "USDT",
    raydium: {
      poolId: "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF",
      mintA: "So11111111111111111111111111111111111111112", // WSOL
      mintB: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    },
    mexc: {
      symbol: "SOLUSDT",
    },
    bybit: {
      symbol: "SOLUSDT",
    },
  },
  {
    canonicalAssetId: "RAY",
    quoteAssetId: "USDT",
    raydium: {
      poolId: "DVa7Qmb5ct9RCpaU7UTpSaf3GVMYz17vNVU67XpdCRut",
      mintA: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R", // RAY
      mintB: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
    },
    mexc: {
      symbol: "RAYUSDT",
    },
  },
];
