const { build } = require('../package.json')

// Local builds use ad-hoc signing without notarization.
module.exports = {
  ...build,
  mac: { ...build.mac, identity: null, notarize: false },
  extraResources: [
    ...(build.extraResources ?? []),
    { from: '.build/build-revision.json', to: 'build-revision.json' },
  ],
}
