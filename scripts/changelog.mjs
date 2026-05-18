import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function generateChangelog(root) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version

  let lastTag
  try {
    lastTag = execSync('git describe --tags --abbrev=0', { encoding: 'utf8', cwd: root }).trim()
  } catch {
    lastTag = null
  }

  const range = lastTag ? `${lastTag}..HEAD` : 'HEAD'
  const raw = execSync(`git log ${range} --pretty=format:%s`, { encoding: 'utf8', cwd: root }).trim()

  const NOISE = /^(bump\s|merge\s|create readme|initial commit)/i
  const commits = raw.split('\n').filter(s => s && !NOISE.test(s))

  const FIX_RE = /^(fix|bug|resolve|revert|patch)\b/i
  const IMPROVE_RE = /^(polish|update|improve|refactor|rework|tweak|enhance|clean|remove|change)\b/i

  const features = []
  const improvements = []
  const fixes = []

  for (const c of commits) {
    if (FIX_RE.test(c)) fixes.push(c)
    else if (IMPROVE_RE.test(c)) improvements.push(c)
    else features.push(c)
  }

  const section = (title, items) =>
    items.length ? `### ${title}\n${items.map(i => `- ${i}`).join('\n')}` : ''

  const parts = [
    section("What's new", features),
    section('Improvements', improvements),
    section('Bug fixes', fixes),
  ].filter(Boolean)

  const body = parts.length ? parts.join('\n\n') : 'No notable changes.'

  return { version, lastTag, body }
}
