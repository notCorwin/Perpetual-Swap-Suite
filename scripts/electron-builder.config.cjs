const { build } = require('../package.json')

// Local and CI artifacts share an ad-hoc signing policy. Notarization is not
// a prerequisite for packaging, installation, or the executable smoke check.
module.exports = {
  ...build,
  mac: { ...build.mac, identity: null, notarize: false },
  extraResources: [
    ...(build.extraResources ?? []),
    { from: '.build/build-revision.json', to: 'build-revision.json' },
  ],
}
