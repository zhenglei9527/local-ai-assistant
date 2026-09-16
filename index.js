/**
 * React Native entry point.
 *
 * Registered name MUST match `MainActivity.getMainComponentName()` in
 * android/app/src/main/java/com/phonellm/app/MainActivity.kt — currently
 * "phone-llm-app". A mismatch produces a blank screen with no error, which is
 * an unusually annoying failure to debug, so keep the two in sync.
 */
import { AppRegistry } from 'react-native'

import App from './App'
import { name as appName } from './app.json'

AppRegistry.registerComponent(appName, () => App)
