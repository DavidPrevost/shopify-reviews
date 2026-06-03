export interface BrandColorPair {
  background: string | null;
  foreground: string | null;
}

export interface BrandColors {
  primary: BrandColorPair | null;
  secondary: BrandColorPair | null;
}

export interface BrandInfo {
  shortDescription: string | null;
  slogan: string | null;
  colors: BrandColors | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  syncedAt: number;
}

// Defaults used when shop_brand_json is empty, unparseable, or missing fields.
// Neutral dark grey + white = legible across all email clients.
export const DEFAULT_CTA_BACKGROUND = '#222222';
export const DEFAULT_CTA_FOREGROUND = '#ffffff';

export interface ResolvedBrandColors {
  ctaBackground: string;
  ctaForeground: string;
}

// Parse the shop_brand_json setting and extract usable button colors with
// fallbacks. Anything malformed returns the defaults rather than throwing.
export const resolveBrandColors = (rawJson: string | null): ResolvedBrandColors => {
  if (!rawJson) {
    return { ctaBackground: DEFAULT_CTA_BACKGROUND, ctaForeground: DEFAULT_CTA_FOREGROUND };
  }
  try {
    const parsed = JSON.parse(rawJson) as Partial<BrandInfo>;
    const primary = parsed?.colors?.primary ?? null;
    return {
      ctaBackground: primary?.background ?? DEFAULT_CTA_BACKGROUND,
      ctaForeground: primary?.foreground ?? DEFAULT_CTA_FOREGROUND,
    };
  } catch {
    return { ctaBackground: DEFAULT_CTA_BACKGROUND, ctaForeground: DEFAULT_CTA_FOREGROUND };
  }
};
