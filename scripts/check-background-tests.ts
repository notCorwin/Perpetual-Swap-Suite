import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const failures: string[] = [];
const root = 'Tests/PerpetualRadarTests';
for (const file of readdirSync(root).filter(file => file.endsWith('.swift'))) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  const rules: [RegExp, string][] = [
    [/\b(?:NSWindow|NSPanel)\s*\(/, 'Create native test windows with BackgroundTestWindow.'],
    [/\.activate\s*\(/, 'Tests must never activate an application.'],
    [/setActivationPolicy\s*\(\s*\.regular\s*\)/, 'Tests must never create a Dock application.'],
    [/\.(?:miniaturize|deminiaturize)\s*\(/, 'Test lifecycle callbacks without invoking Dock animations.'],
    [/\.level\s*=\s*\.(?:floating|statusBar|modalPanel|mainMenu|screenSaver)\b/, 'Test windows must not float above the desktop.'],
  ];
  // This regression suite deliberately challenges the offscreen window's
  // ordering guards. Every other suite must use background ordering only.
  if (file !== 'BackgroundWindowTests.swift') {
    rules.push([/\.(?:makeKeyAndOrderFront|orderFrontRegardless|orderFront|makeKey|makeMain)\s*\(/, 'Use background window ordering.']);
  }
  source.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('//')) return;
    for (const [pattern, message] of rules) {
      if (pattern.test(line)) failures.push(`${path}:${index + 1}: ${message}`);
    }
  });
  if (/\bBackgroundTestWindow\s*\(/.test(source) && !/:\s*BackgroundTestCase\b/.test(source)) {
    failures.push(`${path}: Native window suites must inherit the window/focus/Dock audit.`);
  }
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Background test contract passed.');
}
