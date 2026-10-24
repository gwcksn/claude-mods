import { expect, test } from 'claude-code/testing'

import { cleanBranchName, diffCmd, needsUpstream, parseBranches, parseLog, parseStatus, prepareDiff } from './git'

const Z = (...r: string[]) => r.join('\0') + '\0'

test('status: branch line, ahead and behind, groups', () => {
  const s = parseStatus(
    Z(
      '# branch.oid 1234567890',
      '# branch.head feat/x',
      '# branch.upstream origin/feat/x',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b staged.ts',
      '1 .M N... 100644 100644 100644 a b changed.ts',
      '1 MM N... 100644 100644 100644 a b both.ts',
      '? new file.txt',
    ),
  )
  expect(s.branch).toMatchObject({ name: 'feat/x', upstream: 'origin/feat/x', ahead: 2, behind: 1, isDetached: false })
  expect(s.hasHead).toBe(true)
  expect(s.staged.map(c => c.path)).toEqual(['staged.ts', 'both.ts'])
  expect(s.unstaged.map(c => c.path)).toEqual(['changed.ts', 'both.ts', 'new file.txt'])
  expect(s.unstaged[2]).toMatchObject({ code: 'U', isUntracked: true })
})

test('status: a rename takes its old path from the next record, a conflict is its own group', () => {
  const s = parseStatus(Z('# branch.oid abc', '# branch.head main', '2 R. N... 100644 100644 100644 a b R100 new name.ts', 'old name.ts', 'u UU N... 100644 100644 100644 100644 a b c clash.ts'))
  expect(s.staged[0]).toMatchObject({ path: 'new name.ts', orig: 'old name.ts', code: 'R' })
  expect(s.conflicts).toEqual([{ path: 'clash.ts', code: '!' }])
})

test('status: no commit yet and a detached head', () => {
  expect(parseStatus(Z('# branch.oid (initial)', '# branch.head main')).hasHead).toBe(false)
  const d = parseStatus(Z('# branch.oid abcdef0', '# branch.head (detached)'))
  expect(d.branch.isDetached).toBe(true)
  expect(d.branch.name).toBe('')
})

test('diff commands: untracked uses --no-index and accepts exit 1; staged uses --cached', () => {
  expect(diffCmd({ path: 'a b.txt', code: 'U', isUntracked: true }, false)).toMatchObject({ okCodes: [1] })
  expect(diffCmd({ path: 'a', code: 'M' }, true).args).toContain('--cached')
  expect(diffCmd({ path: 'n', orig: 'o', code: 'R' }, true).args.slice(-2)).toEqual(['o', 'n'])
})

test('prepareDiff: starts at the first hunk, notes binaries, cuts a huge diff at a hunk', () => {
  expect(prepareDiff('diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n').text).toBe('@@ -1 +1 @@\n-a\n+b\n')
  expect(prepareDiff('Binary files /dev/null and b/x differ').note).toBe('Binary file.')
  expect(prepareDiff('').note).toMatch(/No changes/)
  const hunk = (n: number) => `@@ -${n},1 +${n},1 @@\n-${'x'.repeat(9000)}\n+${'y'.repeat(9000)}`
  const big = prepareDiff(`--- a\n+++ b\n${hunk(1)}\n${hunk(100)}\n${hunk(200)}`)
  expect(big.text.startsWith('@@ -1,1')).toBe(true)
  expect(big.text.length).toBeLessThan(20_001)
  expect(big.note).toMatch(/Large diff/)
})

test('branches, log and upstream wording', () => {
  expect(parseBranches('main\t*\torigin/main\nfeature/x\t\t\n(HEAD detached at abc)\t\t')).toEqual([
    { name: 'main', isCurrent: true, upstream: 'origin/main' },
    { name: 'feature/x', isCurrent: false, upstream: '' },
  ])
  const log = parseLog('h1\x1fh1s\x1fsubject one\x1fme\x1f2 hours ago\nh2\x1fh2s\x1fsubject two\x1fme\x1f1 day ago', new Set(['h1']))
  expect(log.map(c => [c.short, c.isUnpushed])).toEqual([['h1s', true], ['h2s', false]])
  expect(needsUpstream('fatal: The current branch topic has no upstream branch.')).toBe(true)
  expect(needsUpstream('fatal: unable to access')).toBe(false)
})

test('branch names git would refuse are caught early', () => {
  expect(cleanBranchName('feat/ok-1')).toBe('feat/ok-1')
  for (const bad of ['', 'two words', 'a..b', '-x', 'x/', 'x.', 'x.lock', 'a@{b', 'a~b']) expect(cleanBranchName(bad)).toBe('')
})
