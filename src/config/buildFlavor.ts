/**
 * Build flavour: which model lines ship in this binary.
 *
 * WHY THIS EXISTS
 *
 * The app supports two model lines:
 *   - `official`     — Qwen-family aligned models. Publishable everywhere.
 *   - `abliterated`  — refusal-ablated ("uncensored") models. These are a hard
 *                      rejection on every mainland-China app store, and are
 *                      increasingly rejected on Google Play too.
 *
 * Shipping one binary that contains both therefore means the binary cannot go
 * on any store. Shipping only the aligned line means users who want the
 * abliterated models have no path at all.
 *
 * The resolution is TWO BINARIES FROM ONE CODEBASE, differing only in a
 * compile-time constant:
 *
 *   store   → official line only. Submission-safe. Default.
 *   full    → both lines. Self-distributed (website APK) only.
 *
 * WHY A COMPILE-TIME CONSTANT AND NOT A RUNTIME SETTING
 *
 * This is the load-bearing decision, and it is a compliance one, not a
 * performance one. If the abliterated catalogue is present in the JS bundle
 * and merely hidden behind a runtime flag, then:
 *
 *   1. The model ids, repository paths and download URLs are still *in the
 *      shipped artifact*. A store reviewer (or an automated scanner diffing
 *      bundles) can read them straight out of the bundle. "We hid it behind a
 *      flag" is not a defence.
 *   2. A runtime flag can be flipped by anyone who can influence persisted
 *      state, turning the store build into the full build after review — which
 *      is exactly the pattern reviewers reject apps for.
 *
 * Metro performs dead-code elimination on `if (__DEV__)`-style constant
 * branches at bundle time. By making the line registry itself a constant that
 * folds, the abliterated entries are *absent* from a `store` bundle rather
 * than merely unreferenced.
 *
 * HOW TO SET IT
 *
 *   Default (no env):            store
 *   APP_FLAVOR=full              full
 *
 *   The Android build reads the same variable (see android/app/build.gradle)
 *   and stamps a matching `BuildConfig` field + versionName suffix, so the
 *   installed app is identifiable without launching it.
 *
 * ⚠️ `APP_FLAVOR` is read via a literal `process.env.APP_FLAVOR` expression so
 * Metro's inliner can substitute it at build time. Do NOT refactor this into a
 * dynamic lookup like `process.env[name]` — that defeats the substitution and
 * silently produces a `store`-shaped bundle that still contains the data.
 */

/** Which catalogue lines a build contains. */
export type BuildFlavor = 'store' | 'full'

/**
 * The active flavour, resolved at bundle time.
 *
 * Anything other than the exact string `full` yields `store`. Failing closed
 * matters: a typo in a CI variable must produce the *submittable* binary, not
 * accidentally ship an unreviewable one.
 */
export const BUILD_FLAVOR: BuildFlavor =
  process.env.APP_FLAVOR === 'full' ? 'full' : 'store'

/** True when this build may present the abliterated line to the user. */
export const INCLUDES_ABLITERATED: boolean = BUILD_FLAVOR === 'full'

/** Human-facing label, used in About/Settings so a build is self-identifying. */
export const FLAVOR_LABEL: string =
  BUILD_FLAVOR === 'full' ? 'Full build (self-distributed)' : 'Store build'

/**
 * Explains, in the UI, why the uncensored tab is absent.
 *
 * Returns `null` on the full build (nothing to explain). On the store build
 * this is shown as a one-line note, because a user who read about the feature
 * elsewhere will otherwise assume the app is broken rather than restricted.
 */
export const ABLITERATED_UNAVAILABLE_REASON: string | null = INCLUDES_ABLITERATED
  ? null
  : 'This build ships without the uncensored model line, which app stores do not permit. ' +
    'The full build is available from the project website.'
