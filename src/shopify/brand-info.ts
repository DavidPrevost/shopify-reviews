import { shopifyStorefront } from './storefront-client.js';

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

const brandQuery = `
  query brandInfo {
    shop {
      brand {
        shortDescription
        slogan
        colors {
          primary { background foreground }
          secondary { background foreground }
        }
        logo { image { url } }
        coverImage { image { url } }
      }
    }
  }
`;

interface RawResponse {
  shop: {
    brand: {
      shortDescription: string | null;
      slogan: string | null;
      colors: BrandColors | null;
      logo: { image: { url: string } | null } | null;
      coverImage: { image: { url: string } | null } | null;
    } | null;
  };
}

export const fetchShopifyBrand = async (): Promise<BrandInfo> => {
  const data = await shopifyStorefront<RawResponse>(brandQuery);
  const brand = data.shop.brand;
  return {
    shortDescription: brand?.shortDescription ?? null,
    slogan: brand?.slogan ?? null,
    colors: brand?.colors ?? null,
    logoUrl: brand?.logo?.image?.url ?? null,
    coverImageUrl: brand?.coverImage?.image?.url ?? null,
    syncedAt: Math.floor(Date.now() / 1000),
  };
};

// `shop.brand` is a Storefront API field — it does not exist on the Admin
// API's Shop type. We query it via the Storefront client (which mints a public
// storefront token from the Admin token on first use). The query shape below
// is the Storefront `Brand` type.

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
