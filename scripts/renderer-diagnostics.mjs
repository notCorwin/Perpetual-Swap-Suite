import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** Opt-in, separate diagnostic runs; their timings never replace acceptance. */
export async function startRendererDiagnostics(electron, page, directory) {
  const output = resolve(directory)
  await mkdir(output, { recursive: true })
  const session = await page.context().newCDPSession(page)
  const clocks = await page.evaluate(() => ({ timeOrigin: performance.timeOrigin, now: performance.now(), wallTime: Date.now() }))
  await session.send('Profiler.enable')
  await electron.evaluate(({ contentTracing }) => contentTracing.startRecording({
    included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink.user_timing'],
    recording_mode: 'record-until-full', trace_buffer_size_in_kb: 32768,
  }))
  await session.send('Profiler.start')
  let stopping
  return () => stopping ??= (async () => {
    const results = await Promise.allSettled([
      session.send('Profiler.stop').then(({ profile }) => writeFile(join(output, 'renderer.cpuprofile'), JSON.stringify(profile))),
      electron.evaluate(async ({ contentTracing }, path) => {
        const bufferUsage = await contentTracing.getTraceBufferUsage()
        const file = await contentTracing.stopRecording(path)
        return { file, bufferUsage }
      }, join(output, 'timeline.json')),
    ])
    await session.detach().catch(() => {})
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason?.message ?? String(result.reason)] : [])
    await writeFile(join(output, 'manifest.json'), JSON.stringify({ diagnosticOnly: true, clocks,
      finishedAt: new Date().toISOString(), cpuProfileComplete: results[0].status === 'fulfilled',
      timeline: results[1].status === 'fulfilled' ? results[1].value : null, errors }, null, 2))
    if (errors.length) throw new Error(`Renderer diagnostics failed: ${errors.join('; ')}`)
  })()
}
