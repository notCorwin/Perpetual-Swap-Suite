export default function SettingsLoadError() {
  return <main role="alert" className="flex h-full flex-col items-start gap-3 p-6">
    <p>Settings could not load. Restart the app to try again.</p>
    <button type="button" className="rounded-md border px-3 py-2" onClick={() => { void window.radarDesktop.closeSettingsWindow() }}>Close settings</button>
  </main>
}
