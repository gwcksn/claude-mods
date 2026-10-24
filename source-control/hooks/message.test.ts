import { expect, test } from 'claude-code/testing'

import { buildPrompt, cleanMessage, isNameOnly, splitDiff, trimDiff } from './message'

const file = (path: string, body: string) => `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n${body}\n`

test('splitDiff gives one chunk per file', () => {
  const files = splitDiff(file('a.ts', '-a\n+b') + file('dir/b.ts', '-c\n+d'))
  expect(files.map(f => f.path)).toEqual(['a.ts', 'dir/b.ts'])
})

test('a path is found whatever prefixes git was configured to print, and unknown means held back', () => {
  const body = '@@ -1 +1 @@\n-A=1\n+TOKEN=hunter2\n'
  const styles = [
    `diff --git c/.env i/.env\n--- c/.env\n+++ i/.env\n${body}`,
    `diff --git .env .env\n--- .env\n+++ .env\n${body}`,
    `diff --git a/.env b/.env\nnew file mode 100644\n--- /dev/null\n+++ b/.env\n${body}`,
    `diff --git a/.env b/.env\ndeleted file mode 100644\n--- a/.env\n+++ /dev/null\n${body}`,
  ]
  for (const raw of styles) {
    const [f] = splitDiff(raw)
    expect(f?.path).toBe('.env')
    expect(trimDiff([f!])).not.toMatch(/hunter2/)
  }
  // Nothing names the file: its contents are not sent.
  const [unnamed] = splitDiff(`diff --git something odd\n${body}`)
  expect(unnamed?.path).toBe('')
  expect(trimDiff([unnamed!])).not.toMatch(/hunter2/)
  expect(splitDiff('diff --git a/dir/with space.ts b/dir/with space.ts\nindex 1..2\nBinary files a/x and b/x differ\n')[0]?.path).toBe('dir/with space.ts')
})

test('lockfiles, binaries and secrets are names only', () => {
  for (const p of ['package-lock.json', 'sub/yarn.lock', 'img/logo.png', '.env', 'app/.env.production', 'keys/server.pem', 'Cargo.lock']) expect(isNameOnly(p)).toBe(true)
  for (const p of ['src/app.ts', 'README.md', 'environment.ts', 'docs/env.md']) expect(isNameOnly(p)).toBe(false)
  const out = trimDiff(splitDiff(file('.env', '-A=1\n+TOKEN=hunter2') + file('src/a.ts', '-old\n+new')))
  expect(out).not.toMatch(/hunter2/)
  expect(out).toMatch(/### \.env\n\(contents not sent/)
  expect(out).toMatch(/\+new/)
})

test('a big change is cut per file and says how much was left out', () => {
  const lines = Array.from({ length: 4000 }, (_, i) => `+line ${i}`).join('\n')
  const out = trimDiff(splitDiff(file('big.ts', lines) + file('small.ts', '-a\n+b')), 12_000)
  expect(out.length).toBeLessThan(13_000)
  expect(out).toMatch(/more lines of this file not shown/)
  expect(out).toMatch(/### small\.ts/)
  expect(out).toMatch(/\+b/)
})

test('the prompt says what is staged and lists new files by name', () => {
  const p = buildPrompt({ branch: 'main', recent: ['feat: a', 'fix: b'], stat: ' a.ts | 2 +-', diff: '### a.ts\n@@ ...', scope: 'staged' })
  expect(p).toMatch(/STAGED/)
  expect(p).toMatch(/- feat: a/)
  const u = buildPrompt({ branch: '', recent: [], stat: '', diff: '', scope: 'unstaged', untracked: ['new.ts'] })
  expect(u).toMatch(/Nothing is staged/)
  expect(u).toMatch(/- new\.ts/)
  expect(u).toMatch(/first commit/)
})

test('cleanMessage strips fences, quotes and trailers', () => {
  expect(cleanMessage('```\nfeat: x\n\n- y\n```')).toBe('feat: x\n\n- y')
  expect(cleanMessage('"feat: quoted"')).toBe('feat: quoted')
  expect(cleanMessage('feat: x\n\nbody  \n\nCo-Authored-By: Someone <a@b.c>\n🤖 Generated with a tool')).toBe('feat: x\n\nbody')
  expect(cleanMessage('a\n\n\n\nb')).toBe('a\n\nb')
})

test('cleanMessage wraps a long body at 72 and keeps bullets readable, but never cuts the subject', () => {
  const subject = 'feat(very-long-scope): ' + 'word '.repeat(20).trim()
  const para = 'This change makes the cart honour a per-item discount so that the total shown at checkout matches what the customer will really be charged.'
  const out = cleanMessage(`${subject}\n\n${para}\n\n- src/cart.ts: add lineTotal(), price * qty * (1 - discount), treating a missing discount as zero\n- short`)
  const lines = out.split('\n')
  expect(lines[0]).toBe(subject)
  for (const l of lines.slice(1)) expect(l.length).toBeLessThanOrEqual(72)
  expect(out).toMatch(/\n- src\/cart\.ts: add lineTotal\(\)/)
  expect(lines.some(l => /^ {2}\S/.test(l))).toBe(true)
  expect(out.endsWith('- short')).toBe(true)
})
