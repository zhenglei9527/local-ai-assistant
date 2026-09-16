/**
 * Design tokens.
 *
 * A single dark palette on purpose. A local-LLM chat app is used in long
 * sessions, often at night, and OLED phones spend meaningfully less power on
 * near-black backgrounds. A light theme is roadmap Phase 6; when it lands,
 * these objects become a `useTheme()` hook — the call sites already read from
 * `colors`, so the migration is mechanical rather than a find-and-replace
 * across every StyleSheet.
 */

export const colors = {
  /** Near-black rather than pure #000 — pure black causes visible smearing on OLED during scroll. */
  background: '#0E1116',
  surface: '#161B22',
  surfaceRaised: '#1C232C',
  border: '#2A313C',

  text: '#E6EDF3',
  textMuted: '#8B949E',
  textFaint: '#5C6672',

  accent: '#4C8DFF',
  accentMuted: '#1F3A66',

  success: '#3FB950',
  warning: '#D29922',
  danger: '#F85149',

  /** Bubble colours for the chat transcript. */
  bubbleUser: '#1F3A66',
  bubbleAssistant: '#161B22',
  bubbleSystem: '#231A11',
} as const

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

export const radii = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const

export const typography = {
  title: { fontSize: 22, fontWeight: '700' as const },
  body: { fontSize: 15, lineHeight: 22 },
  caption: { fontSize: 12, lineHeight: 16 },
  mono: { fontSize: 12, fontFamily: 'monospace' as const },
} as const

/**
 * Minimum touch target. Android's Material guidance and Apple's HIG agree on
 * 44–48dp; use the larger of the two so the same values work on both.
 */
export const TOUCH_TARGET = 48
