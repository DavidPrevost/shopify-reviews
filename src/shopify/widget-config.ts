// Resolves the widget's visible styling from three layers, in order of
// precedence:
//   1. Per-field admin overrides stored as `widget_config_json` in settings
//   2. Synced Shopify brand colors (`shop_brand_json` — populated by the
//      "Sync brand info from Shopify" admin action)
//   3. Hardcoded fallbacks (so the widget renders sensibly out of the box
//      even before either layer has been populated)
//
// Each override field can be null/missing to delegate to the Shopify layer.
// Each Shopify field can be null/missing to delegate to the hardcoded
// default. This is the "inherit from Shopify by default, override per-field
// in our admin" pattern we agreed on.

import { getSetting } from '../db/queries.js';

export interface ResolvedWidgetConfig {
  starColor: string;
  ctaBackground: string;
  ctaForeground: string;
  borderRadius: number;
}

export interface WidgetConfigOverrides {
  starColor: string | null;
  ctaBackground: string | null;
  ctaForeground: string | null;
  borderRadius: number | null;
}

export interface ShopifyDefaults {
  starColor: string | null;
  ctaBackground: string | null;
  ctaForeground: string | null;
}

export const HARDCODED_DEFAULTS: ResolvedWidgetConfig = {
  starColor: '#f5a623',
  ctaBackground: '#222222',
  ctaForeground: '#ffffff',
  borderRadius: 6,
};

// Curated preset palette offered to admin users alongside the full color
// picker. Keys match the names the user listed; values are chosen to render
// reasonably against typical neutral storefront backgrounds.
export const PRESET_PALETTE: Array<{ name: string; hex: string }> = [
  { name: 'Gold',   hex: '#f5a623' },
  { name: 'Silver', hex: '#c0c0c0' },
  { name: 'Bronze', hex: '#cd7f32' },
  { name: 'Black',  hex: '#000000' },
  { name: 'White',  hex: '#ffffff' },
  { name: 'Blue',   hex: '#1e88e5' },
  { name: 'Red',    hex: '#d32f2f' },
  { name: 'Purple', hex: '#7b1fa2' },
  { name: 'Green',  hex: '#2e7d32' },
  { name: 'Yellow', hex: '#fbc02d' },
  { name: 'Orange', hex: '#f57c00' },
  { name: 'Pink',   hex: '#e91e63' },
  { name: 'Brown',  hex: '#795548' },
];

const parseJson = <T>(raw: string | null): Partial<T> | null => {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Partial<T>;
  } catch {
    return null;
  }
};

interface BrandColorPair { background: string | null; foreground: string | null }
interface BrandJson { colors?: { primary?: BrandColorPair | null; secondary?: BrandColorPair | null } | null }

export const getShopifyDefaults = (): ShopifyDefaults => {
  const brand = parseJson<BrandJson>(getSetting('shop_brand_json'));
  const primary = brand?.colors?.primary ?? null;
  const secondary = brand?.colors?.secondary ?? null;
  return {
    // Star color defaults to Shopify secondary (a typical brand accent);
    // CTA defaults to Shopify primary (the "main brand color" pair).
    starColor: secondary?.background ?? null,
    ctaBackground: primary?.background ?? null,
    ctaForeground: primary?.foreground ?? null,
  };
};

export const getWidgetOverrides = (): WidgetConfigOverrides => {
  const raw = parseJson<WidgetConfigOverrides>(getSetting('widget_config_json'));
  return {
    starColor: raw?.starColor ?? null,
    ctaBackground: raw?.ctaBackground ?? null,
    ctaForeground: raw?.ctaForeground ?? null,
    borderRadius: typeof raw?.borderRadius === 'number' ? raw.borderRadius : null,
  };
};

export const resolveWidgetConfig = (): ResolvedWidgetConfig => {
  const overrides = getWidgetOverrides();
  const shopify = getShopifyDefaults();
  return {
    starColor: overrides.starColor ?? shopify.starColor ?? HARDCODED_DEFAULTS.starColor,
    ctaBackground: overrides.ctaBackground ?? shopify.ctaBackground ?? HARDCODED_DEFAULTS.ctaBackground,
    ctaForeground: overrides.ctaForeground ?? shopify.ctaForeground ?? HARDCODED_DEFAULTS.ctaForeground,
    borderRadius: overrides.borderRadius ?? HARDCODED_DEFAULTS.borderRadius,
  };
};

// Light validation for incoming color strings. Accepts only "#RRGGBB" with
// hex characters — rejects everything else so we don't smuggle arbitrary CSS
// into the page via the config endpoint.
export const isValidHexColor = (s: unknown): s is string =>
  typeof s === 'string' && /^#[0-9a-fA-F]{6}$/.test(s);
