import React from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { AppNavigator } from '@/ui/AppNavigator'

/**
 * Application root.
 *
 * Deliberately thin: providers and the navigator only. All state lives in the
 * Zustand stores, all side effects in `src/engine` (roadmap Phase 2), so this
 * file should almost never change.
 */
export default function App(): React.JSX.Element {
  return (
    <SafeAreaProvider>
      <AppNavigator />
    </SafeAreaProvider>
  )
}
