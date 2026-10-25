import { foregroundPaintWindow } from '../../scripts/chart-acceptance.mjs'
import { requireForegroundTests } from '../../electron/test-presentation.js'
import { registerInstrumentNavigationTests } from '../support/instrument-navigation-suite.mjs'

requireForegroundTests()
registerInstrumentNavigationTests({ presentation: 'foreground', prepareWindow: foregroundPaintWindow })
