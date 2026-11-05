/** Recording is an explicit diagnostic/test capability, never a daily default. */
export function operationRecordingRequested(environment = process.env) {
  if (environment.PERPETUAL_SWAP_OPERATION_TRACE === '0') return false
  return Boolean(environment.PERPETUAL_SWAP_OPERATION_DIR)
    || environment.PERPETUAL_SWAP_OPERATION_TRACE === '1'
    || environment.PERPETUAL_SWAP_GPU_TRACE === '1'
    || environment.PERPETUAL_SWAP_SANDBOX === '1'
    || environment.PERPETUAL_SWAP_E2E === '1'
}
