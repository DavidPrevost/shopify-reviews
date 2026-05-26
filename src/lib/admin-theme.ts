// Admin dashboard theming. Each theme is a set of CSS custom properties that
// the admin shell's stylesheet consumes via var(). Only the "chrome" is
// themed — page background, surfaces, text, borders, header, and the accent
// used for primary buttons / active tabs / links. Semantic colors (status
// pills, error/success boxes, star gold, danger red, the pause banner) are
// deliberately NOT themed: they carry meaning and must stay recognizable and
// legible in every palette.
//
// Ten presets: five accents (blue, green, terracotta, purple, pink) in light
// and dark, all matte/pastel and contrast-checked for readability. An eleventh
// "brand" option (auto-matched from Shopify brand colors) is reserved for when
// brand-sync is wired through.

import { getSetting } from '../db/queries.js';

export type ThemeVars = Record<string, string>;

export interface AdminTheme {
  label: string;
  vars: ThemeVars;
}

// Shared neutrals. Per-accent builders override the accent + a few tints.
const LIGHT_BASE: ThemeVars = {
  '--surface': '#ffffff',
  '--text': '#232830',
  '--muted': '#6b7280',
  '--border': '#e7e9ee',
  '--border-strong': '#d2d6de',
  '--header-text': '#ffffff',
  '--header-nav': 'rgba(255,255,255,0.72)',
  '--header-nav-active': '#ffffff',
  '--accent-text': '#ffffff',
};

const DARK_BASE: ThemeVars = {
  '--bg': '#1a1d23',
  '--surface': '#232830',
  '--surface-alt': '#2b313b',
  '--text': '#e7eaf0',
  '--muted': '#9aa2b1',
  '--border': '#333a45',
  '--border-strong': '#404856',
  '--header-bg': '#161a20',
  '--header-text': '#f3f5f8',
  '--header-nav': 'rgba(255,255,255,0.6)',
  // On dark, accent buttons use a light pastel accent, so their text is dark.
  '--accent-text': '#1a1d23',
};

const lightTheme = (
  label: string,
  accent: string,
  accentHover: string,
  bg: string,
  surfaceAlt: string,
): AdminTheme => ({
  label,
  vars: {
    ...LIGHT_BASE,
    '--bg': bg,
    '--surface-alt': surfaceAlt,
    '--accent': accent,
    '--accent-hover': accentHover,
    '--header-bg': accent,
  },
});

const darkTheme = (label: string, accent: string, accentHover: string): AdminTheme => ({
  label,
  vars: {
    ...DARK_BASE,
    '--accent': accent,
    '--accent-hover': accentHover,
    '--header-nav-active': accent,
  },
});

export const ADMIN_THEMES: Record<string, AdminTheme> = {
  'blue-light':       lightTheme('Blue · light',       '#3f6098', '#34507f', '#f3f6fa', '#eef2f8'),
  'green-light':      lightTheme('Green · light',      '#4a7c59', '#3d6749', '#f2f7f3', '#ecf3ee'),
  'terracotta-light': lightTheme('Terracotta · light', '#b06a4f', '#97583f', '#faf4f1', '#f5ebe6'),
  'purple-light':     lightTheme('Purple · light',     '#6b5b95', '#5a4b80', '#f6f4fa', '#efebf6'),
  'pink-light':       lightTheme('Pink · light',       '#a85676', '#8f4663', '#faf2f5', '#f5e9ee'),
  'blue-dark':        darkTheme('Blue · dark',         '#7fa8d6', '#6f99c9'),
  'green-dark':       darkTheme('Green · dark',        '#7cb98c', '#6daa7d'),
  'terracotta-dark':  darkTheme('Terracotta · dark',   '#d59478', '#c8866a'),
  'purple-dark':      darkTheme('Purple · dark',       '#a594c9', '#9684bd'),
  'pink-dark':        darkTheme('Pink · dark',         '#d291ac', '#c682a0'),
};

export const DEFAULT_ADMIN_THEME = 'blue-light';

export const getActiveAdminTheme = (): string => {
  const stored = getSetting('admin_theme');
  if (stored && stored in ADMIN_THEMES) return stored;
  return DEFAULT_ADMIN_THEME;
};

// Builds the `:root { --x: y; ... }` block for the active theme, to be injected
// at the top of the admin shell's <style>.
export const renderAdminThemeVars = (themeKey: string): string => {
  const theme = ADMIN_THEMES[themeKey] ?? ADMIN_THEMES[DEFAULT_ADMIN_THEME]!;
  const lines = Object.entries(theme.vars)
    .map(([k, v]) => `      ${k}: ${v};`)
    .join('\n');
  return `:root {\n${lines}\n    }`;
};
