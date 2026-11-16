const { build } = require('../package.json')

// Local builds use ad-hoc signing without notarization.
module.exports = {
  ...build,
  // Renderer dependencies are bundled by Vite; the main process and workers
  // use only Electron/Node built-ins. Do not ship their unused source trees.
  files: [...build.files, '!node_modules/**'],
  mac: { ...build.mac, identity: null, notarize: false },
  extraResources: [
    ...(build.extraResources ?? []),
    { from: '.build/build-revision.json', to: 'build-revision.json' },
  ],
}
