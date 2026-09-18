/**
 * Shared screen chrome.
 *
 * ── Why this lives apart from AppNavigator ─────────────────────────────────
 * `ScreenScaffold` used to be exported from `AppNavigator.tsx`, and every
 * screen imports it. `AppNavigator` imports every screen. That is a cycle:
 *
 *     AppNavigator → ChatScreen → AppNavigator
 *
 * Metro tolerates it as long as nothing dereferences the binding during module
 * initialisation, and for a long time nothing did — the navigator rendered
 * `RecommendScreen` first, which does not use `ScreenScaffold`. The moment the
 * app started rendering a scaffold-using screen on the very first frame, the
 * cycle resolved to `undefined` and React rendered nothing: a black screen with
 * no error in logcat, which is about as hard to diagnose as it gets.
 *
 * Moving the scaffold into its own leaf module removes the cycle rather than
 * papering over it with lazy imports.
 */

import React from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { colors, spacing, typography } from '@/ui/theme'

export function ScreenScaffold({
  title,
  subtitle,
  children,
  scroll = true,
  headerRight,
  headerLeft,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  scroll?: boolean
  /** Optional action rendered at the right edge of the header (e.g. a "+"). */
  headerRight?: React.ReactNode
  /** Optional leading control (e.g. a back chevron). */
  headerLeft?: React.ReactNode
}): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const Body = scroll ? ScrollView : View

  return (
    <View style={[styles.screen, { paddingTop: insets.top + spacing.md }]}>
      <View style={styles.header}>
        {headerLeft ? <View style={styles.headerLeading}>{headerLeft}</View> : null}
        <View style={styles.headerText}>
          <Text style={styles.headerTitle}>{title}</Text>
          {subtitle ? <Text style={styles.headerSubtitle}>{subtitle}</Text> : null}
        </View>
        {headerRight ? <View style={styles.headerAction}>{headerRight}</View> : null}
      </View>
      <Body
        style={styles.body}
        {...(scroll
          ? {
              contentContainerStyle: styles.bodyContent,
              keyboardShouldPersistTaps: 'handled' as const,
            }
          : {})}
      >
        {children}
      </Body>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  /**
   * Header.
   *
   * Was a plain row with a hairline divider, which made every screen read like a
   * settings list. Three changes give it a sense of being a surface rather than
   * a strip:
   *
   *   - `surface` fill instead of the page colour, so header and content are
   *     visibly different planes.
   *   - No divider. The colour change already separates them, and a line on top
   *     of a colour change is redundant.
   *   - More bottom padding: the title sat tight against the first row.
   */
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    backgroundColor: colors.surface,
  },
  headerText: { flex: 1, justifyContent: 'center' },
  headerLeading: { marginRight: spacing.sm },
  headerAction: { marginLeft: spacing.md },
  headerTitle: { ...typography.title, color: colors.text },
  headerSubtitle: { ...typography.subtitle, color: colors.textMuted, marginTop: 3 },
  body: { flex: 1 },
  bodyContent: { padding: spacing.lg, gap: spacing.md },
})
