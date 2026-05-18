import { execSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { generateChangelog } from './changelog.mjs'

if (!process.env.GH_TOKEN) {
  console.error('Error: GH_TOKEN is not set.')
  console.error('Create a GitHub PAT with Contents: Read+Write and run:')
  console.error('  [System.Environment]::SetEnvironmentVariable("GH_TOKEN", "your_token", "User")')
  process.exit(1)
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const draftFile = join(root, 'RELEASE_DRAFT.md')

let body
let version

if (existsSync(draftFile)) {
  body = readFileSync(draftFile, 'utf8').trim()
  version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
  console.log(`Using RELEASE_DRAFT.md for v${version}\n`)
} else {
  const changelog = generateChangelog(root)
  body = changelog.body
  version = changelog.version
  console.log(`Changelog: ${changelog.lastTag ?? '(beginning)'} → v${version}\n`)
}

console.log(body)
console.log()

// Publish native bridge
console.log('Publishing native bridge...')
execSync('dotnet publish native/Hynite.NativeBridge/Hynite.NativeBridge.csproj -c Release -r win-x64 --self-contained true -o dist/native/Hynite.NativeBridge', {
  stdio: 'inherit',
  cwd: root,
})

// Build installer and push to GitHub Releases
console.log('\nBuilding installer and publishing...')
execSync('electron-builder --win nsis --publish always', { stdio: 'inherit', cwd: root })

// Inject changelog into the GitHub release
const notesFile = join(tmpdir(), `hynite-notes-${Date.now()}.md`)
writeFileSync(notesFile, body, 'utf8')
try {
  console.log(`\nUpdating release notes for v${version}...`)
  execSync(`gh release edit v${version} --notes-file "${notesFile}"`, { stdio: 'inherit', cwd: root })
} finally {
  unlinkSync(notesFile)
}

// Create and push the git tag so future changelogs have the right base
console.log(`\nTagging v${version}...`)
execSync(`git tag v${version}`, { cwd: root })
execSync(`git push origin v${version}`, { stdio: 'inherit', cwd: root })

// Clean up draft if it was used
if (existsSync(draftFile)) {
  unlinkSync(draftFile)
  console.log('RELEASE_DRAFT.md cleaned up.')
}

console.log('Done.')
