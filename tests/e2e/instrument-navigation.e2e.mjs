import { offscreenChartWindow } from '../../scripts/chart-acceptance.mjs'
import { registerInstrumentNavigationTests } from '../support/instrument-navigation-suite.mjs'

registerInstrumentNavigationTests({ presentation: 'offscreen', prepareWindow: offscreenChartWindow })
