import { initializeOperationRecording } from '../electron/services/operation-runtime.js'

// Node --import propagates to node:test children and workers. Electron initializes
// its own runtime, so NODE_OPTIONS is intentionally left untouched.
if (process.env.PERPETUAL_SWAP_OPERATION_DIR) {
  const recording = initializeOperationRecording({ directory: process.env.PERPETUAL_SWAP_OPERATION_DIR, label: 'test-sandbox' })
  process.on('beforeExit', async () => { await recording.flush() })
}
