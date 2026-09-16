const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config')
const path = require('path')

/**
 * Metro configuration.
 *
 * IMPORTANT — GGUF models must NEVER pass through Metro.
 * Models are downloaded at runtime into the app's private storage
 * (`filesDir/models/...`) and handed to llama.rn as absolute `file://` paths.
 * If a .gguf ever ended up under the project tree, Metro's asset resolver
 * would try to hash/bundle it (multi-GB) and the build would die. The
 * `resolver.blockList` entry below is a guard, not a convenience.
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  projectRoot: __dirname,
  watchFolders: [path.resolve(__dirname, 'src')],
  resolver: {
    // Explicit source extensions; .gguf deliberately absent.
    sourceExts: ['ts', 'tsx', 'js', 'jsx', 'json', 'cjs', 'mjs'],
    // Guard: hard-fail any accidental attempt to bundle model weights.
    blockList: [
      /.*\.gguf$/,
      /.*\/models\/.*/,
      /.*\.tmp$/,
      /node_modules\/.*\/android\/\.cxx\/.*/,
    ],
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  transformer: {
    getTransformOptions: async () => ({
      transform: {
        experimentalImportSupport: false,
        inlineRequires: true,
      },
    }),
  },
}

module.exports = mergeConfig(getDefaultConfig(__dirname), config)
