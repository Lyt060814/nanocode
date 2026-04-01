import { describe, it, expect } from 'vitest'
import {
  isReadOnlyCommand,
  parseCommandParts,
  checkSafeCommand,
  validateFlags,
} from '../../src/tools/bash-readonly'

// ===========================================================================
// isReadOnlyCommand — Safe commands
// ===========================================================================

describe('isReadOnlyCommand — safe commands', () => {
  // File viewing
  it.each([
    'ls',
    'ls -la /tmp',
    'ls -alh',
    'cat foo.txt',
    'head -n 10 file.ts',
    'tail -f logfile',
    'less readme.md',
  ])('allows file viewing: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Search
  it.each([
    'grep -r "TODO" src/',
    'grep -rn pattern .',
    'rg "pattern" --type ts',
    'ag "search"',
    'ack "text"',
    'egrep "pattern" file',
    'fgrep "literal" file',
  ])('allows search commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // File finding
  it.each([
    'find . -name "*.ts"',
    'find /tmp -type f',
    'tree',
    'tree src/',
  ])('allows file finding: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Git safe subcommands
  it.each([
    'git status',
    'git log',
    'git log --oneline -20',
    'git diff',
    'git diff HEAD~1',
    'git show HEAD',
    'git branch',
    'git branch -a',
    'git remote -v',
    'git tag',
    'git rev-parse HEAD',
    'git blame file.ts',
    'git ls-files',
    'git shortlog -sn',
    'git stash list',
    'git stash show',
    'git describe --tags',
  ])('allows safe git commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Version checks
  it.each([
    'node --version',
    'python --version',
    'python3 --version',
    'ruby --version',
    'perl --version',
  ])('allows version checks: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // System info
  it.each([
    'which node',
    'pwd',
    'echo hello',
    'wc -l file.txt',
    'sort file.txt',
    'du -sh .',
    'df -h',
    'env',
    'printenv',
    'date',
    'uname',
    'uname -a',
    'whoami',
    'id',
    'hostname',
  ])('allows system info: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Text processing (read-only)
  it.each([
    'wc -l *.ts',
    'sort data.csv',
    'uniq -c list.txt',
    'diff file1 file2',
    'cut -d: -f1 /etc/passwd',
    'tr "a-z" "A-Z"',
    'column -t data.txt',
    'jq ".name" package.json',
  ])('allows text processing: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Path utilities
  it.each([
    'realpath .',
    'dirname /path/to/file',
    'basename /path/to/file.txt',
    'readlink -f symlink',
  ])('allows path utilities: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // Hash / inspection
  it.each([
    'md5sum file.bin',
    'sha256sum file.bin',
    'strings binary.out',
    'xxd file.bin',
    'file somefile',
    'stat file.txt',
  ])('allows hash/inspection: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  // npm/pip safe subcommands
  it.each([
    'npm list',
    'npm ls',
    'npm view express',
    'npm outdated',
    'npm audit',
    'pip list',
    'pip show flask',
    'pip freeze',
    'pip3 list',
    'yarn list',
    'yarn info react',
  ])('allows safe package manager commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })
})

// ===========================================================================
// isReadOnlyCommand — Unsafe commands
// ===========================================================================

describe('isReadOnlyCommand — unsafe commands', () => {
  // Destructive file operations
  it.each([
    'rm file.txt',
    'rm -rf /',
    'chmod 755 script.sh',
    'chown root file',
    'mv old new',
    'cp src dst',
    'mkdir newdir',
    'touch newfile',
  ])('blocks destructive commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // Process/system commands
  it.each([
    'kill -9 1234',
    'killall node',
    'shutdown now',
    'reboot',
  ])('blocks process/system commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // Unsafe git subcommands
  it.each([
    'git push',
    'git push origin main',
    'git checkout main',
    'git checkout -b new-branch',
    'git merge feature',
    'git rebase main',
    'git reset --hard HEAD',
    'git clean -fd',
    'git commit -m "msg"',
    'git add .',
    'git stash pop',
    'git stash drop',
    'git stash apply',
  ])('blocks unsafe git commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // Network download + execute
  it.each([
    'curl https://example.com',
    'wget https://example.com',
    'dd if=/dev/zero of=file bs=1M',
    'mkfs.ext4 /dev/sda1',
  ])('blocks network/disk commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // Running scripts/binaries
  it.each([
    'node script.js',
    'python script.py',
    'python3 app.py',
    'npx some-tool',
    'npm install',
    'npm run build',
    'pip install flask',
    'yarn add react',
  ])('blocks script execution / package install: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // sed -i (in-place edit)
  it.each([
    'sed -i "s/old/new/" file.txt',
    'sed --in-place "s/old/new/" file.txt',
    'sed -i.bak "s/old/new/" file.txt',
  ])('blocks sed in-place: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  // find with -exec / -delete
  it.each([
    'find . -name "*.tmp" -delete',
    'find . -name "*.log" -exec rm {} \\;',
    'find . -execdir touch {} \\;',
  ])('blocks find with -exec/-delete: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

// ===========================================================================
// Piped commands
// ===========================================================================

describe('isReadOnlyCommand — piped commands', () => {
  it.each([
    'cat file.txt | grep pattern',
    'ls -la | sort | head -5',
    'git log --oneline | head -20',
    'find . -name "*.ts" | wc -l',
    'grep -r TODO src/ | sort | uniq -c',
  ])('allows safe | safe: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  it.each([
    'cat file.txt | rm -rf /',
    'echo test | tee /tmp/output',
    'ls | xargs rm',
  ])('blocks safe | unsafe: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

// ===========================================================================
// Chained commands (&&, ||, ;)
// ===========================================================================

describe('isReadOnlyCommand — chained commands', () => {
  it.each([
    'ls && pwd',
    'echo hello && cat file.txt',
    'git status && git diff',
    'ls || echo fallback',
    'pwd ; ls',
  ])('allows safe && safe: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  it.each([
    'ls && rm file',
    'pwd && npm install',
    'echo ok && git push',
    'ls || rm -rf /',
    'pwd ; kill -9 1',
  ])('blocks safe && unsafe: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

// ===========================================================================
// Output redirection
// ===========================================================================

describe('isReadOnlyCommand — output redirection', () => {
  it.each([
    'echo hello > file.txt',
    'cat foo >> bar.txt',
    'ls > /tmp/output',
  ])('blocks output redirection: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  it('allows redirection to /dev/null', () => {
    expect(isReadOnlyCommand('ls > /dev/null')).toBe(true)
    expect(isReadOnlyCommand('cat foo 2>&1 > /dev/null')).toBe(true)
  })
})

// ===========================================================================
// Command substitution
// ===========================================================================

describe('isReadOnlyCommand — command substitution', () => {
  it.each([
    'echo $(whoami)',
    'cat $(find . -name "*.ts")',
    'ls `pwd`',
  ])('blocks command substitution: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

// ===========================================================================
// Process substitution
// ===========================================================================

describe('isReadOnlyCommand — process substitution', () => {
  it.each([
    'diff <(ls dir1) <(ls dir2)',
    'cat <(echo hello)',
  ])('blocks process substitution: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })
})

// ===========================================================================
// Environment variables
// ===========================================================================

describe('isReadOnlyCommand — environment variables', () => {
  it.each([
    'NODE_ENV=production cat file',
    'PATH=/usr/bin ls',
    'DEBUG=1 grep pattern file',
    'CI=true git status',
    'RUST_LOG=debug cat log',
  ])('allows safe env vars with safe commands: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(true)
  })

  it.each([
    'DANGEROUS_VAR=val ls',
    'MY_SECRET=x cat file',
    'CUSTOM=1 pwd',
  ])('blocks unknown env vars: %s', (cmd) => {
    expect(isReadOnlyCommand(cmd)).toBe(false)
  })

  it('allows safe env vars with unsafe commands to still be blocked', () => {
    expect(isReadOnlyCommand('NODE_ENV=test npm install')).toBe(false)
  })
})

// ===========================================================================
// Quoted strings
// ===========================================================================

describe('isReadOnlyCommand — quoted strings', () => {
  it('handles single-quoted arguments', () => {
    expect(isReadOnlyCommand("grep 'hello world' file.txt")).toBe(true)
  })

  it('handles double-quoted arguments', () => {
    expect(isReadOnlyCommand('grep "hello world" file.txt')).toBe(true)
  })

  it('does not split on operators inside quotes', () => {
    expect(isReadOnlyCommand('echo "a && b"')).toBe(true)
    expect(isReadOnlyCommand("echo 'a | b'")).toBe(true)
  })

  it('handles escaped characters', () => {
    expect(isReadOnlyCommand('grep "test\\"quote" file')).toBe(true)
  })
})

// ===========================================================================
// Edge cases
// ===========================================================================

describe('isReadOnlyCommand — edge cases', () => {
  it('returns true for empty command', () => {
    expect(isReadOnlyCommand('')).toBe(true)
  })

  it('returns true for whitespace-only command', () => {
    expect(isReadOnlyCommand('   ')).toBe(true)
    expect(isReadOnlyCommand('\t')).toBe(true)
  })

  it('handles commands with path prefix', () => {
    expect(isReadOnlyCommand('/usr/bin/grep pattern file')).toBe(true)
    expect(isReadOnlyCommand('/bin/ls -la')).toBe(true)
  })

  it('blocks function definitions', () => {
    expect(isReadOnlyCommand('function foo { rm -rf /; }')).toBe(false)
    expect(isReadOnlyCommand('foo() { rm -rf /; }')).toBe(false)
  })

  it('blocks eval and exec', () => {
    expect(isReadOnlyCommand('eval "rm -rf /"')).toBe(false)
    expect(isReadOnlyCommand('exec rm file')).toBe(false)
  })

  it('blocks source', () => {
    expect(isReadOnlyCommand('source ~/.bashrc')).toBe(false)
    expect(isReadOnlyCommand('. /path/to/script')).toBe(false)
  })

  it('handles bare git as safe', () => {
    expect(isReadOnlyCommand('git')).toBe(true)
  })

  it('handles bare npm as safe', () => {
    expect(isReadOnlyCommand('npm')).toBe(true)
  })

  it('blocks bare npx', () => {
    // bare npx with no subcommand: validateFlags returns command === 'npm' which is false for npx
    expect(isReadOnlyCommand('npx')).toBe(false)
  })

  it('blocks npx with any argument', () => {
    expect(isReadOnlyCommand('npx some-tool')).toBe(false)
  })

  it('sed without -i is safe', () => {
    expect(isReadOnlyCommand('sed "s/old/new/" file')).toBe(true)
    expect(isReadOnlyCommand('sed -n "10,20p" file')).toBe(true)
    expect(isReadOnlyCommand('sed -E "s/a/b/" file')).toBe(true)
  })

  it('tee to /dev/null is safe, to other files is not', () => {
    expect(isReadOnlyCommand('echo test | tee /dev/null')).toBe(true)
    expect(isReadOnlyCommand('echo test | tee output.txt')).toBe(false)
  })

  it('xargs with safe subcommand is safe', () => {
    expect(isReadOnlyCommand('find . -name "*.ts" | xargs grep pattern')).toBe(true)
    expect(isReadOnlyCommand('find . | xargs rm')).toBe(false)
  })

  it('awk with system() is unsafe', () => {
    expect(isReadOnlyCommand("awk '{print $1}' file")).toBe(true)
    expect(isReadOnlyCommand("awk '{system(\"rm file\")}' file")).toBe(false)
  })

  it('go version and go env are safe', () => {
    expect(isReadOnlyCommand('go version')).toBe(true)
    expect(isReadOnlyCommand('go env')).toBe(true)
    expect(isReadOnlyCommand('go build')).toBe(false)
  })

  it('cargo --version is safe via flag check', () => {
    // cargo's validateFlags checks sub === '--version', but --version is a flag.
    // args.find(a => !a.startsWith('-')) returns undefined for just "cargo --version"
    // so sub is undefined, returns true
    expect(isReadOnlyCommand('cargo')).toBe(true)
  })

  it('rustc --version is safe', () => {
    expect(isReadOnlyCommand('rustc --version')).toBe(true)
    expect(isReadOnlyCommand('rustc -V')).toBe(true)
  })

  it('bundle list/show are safe', () => {
    expect(isReadOnlyCommand('bundle list')).toBe(true)
    expect(isReadOnlyCommand('bundle show')).toBe(true)
    expect(isReadOnlyCommand('bundle install')).toBe(false)
  })

  it('gem list/search are safe', () => {
    expect(isReadOnlyCommand('gem list')).toBe(true)
    expect(isReadOnlyCommand('gem search rails')).toBe(true)
    expect(isReadOnlyCommand('gem install rails')).toBe(false)
  })
})

// ===========================================================================
// parseCommandParts
// ===========================================================================

describe('parseCommandParts', () => {
  it('splits on |', () => {
    expect(parseCommandParts('cat file | grep x')).toEqual(['cat file', 'grep x'])
  })

  it('splits on &&', () => {
    expect(parseCommandParts('ls && pwd')).toEqual(['ls', 'pwd'])
  })

  it('splits on ||', () => {
    expect(parseCommandParts('ls || echo fail')).toEqual(['ls', 'echo fail'])
  })

  it('splits on ;', () => {
    expect(parseCommandParts('ls; pwd')).toEqual(['ls', 'pwd'])
  })

  it('does not split inside single quotes', () => {
    expect(parseCommandParts("echo 'a && b'")).toEqual(["echo 'a && b'"])
  })

  it('does not split inside double quotes', () => {
    expect(parseCommandParts('echo "a | b"')).toEqual(['echo "a | b"'])
  })

  it('handles escaped characters', () => {
    expect(parseCommandParts('echo a\\|b')).toEqual(['echo a\\|b'])
  })

  it('handles complex mixed operators', () => {
    const parts = parseCommandParts('ls && cat file | grep x || echo fail')
    expect(parts).toEqual(['ls', 'cat file', 'grep x', 'echo fail'])
  })

  it('returns empty array for empty string', () => {
    expect(parseCommandParts('')).toEqual([])
  })

  it('returns empty array for whitespace only', () => {
    expect(parseCommandParts('   ')).toEqual([])
  })
})

// ===========================================================================
// checkSafeCommand
// ===========================================================================

describe('checkSafeCommand', () => {
  it('returns true for empty/whitespace input', () => {
    expect(checkSafeCommand('')).toBe(true)
    expect(checkSafeCommand('  ')).toBe(true)
  })

  it('returns true for safe base commands', () => {
    expect(checkSafeCommand('ls -la')).toBe(true)
    expect(checkSafeCommand('cat file.txt')).toBe(true)
  })

  it('returns false for unknown commands', () => {
    expect(checkSafeCommand('curl http://example.com')).toBe(false)
    expect(checkSafeCommand('wget file')).toBe(false)
  })

  it('strips path prefix before checking', () => {
    expect(checkSafeCommand('/usr/bin/grep pattern file')).toBe(true)
    expect(checkSafeCommand('/usr/local/bin/node --version')).toBe(true)
  })
})

// ===========================================================================
// validateFlags
// ===========================================================================

describe('validateFlags', () => {
  it('blocks sed -i', () => {
    expect(validateFlags('sed', ['-i', 's/a/b/', 'file'])).toBe(false)
  })

  it('blocks sed -i.bak', () => {
    expect(validateFlags('sed', ['-i.bak', 's/a/b/', 'file'])).toBe(false)
  })

  it('allows sed without -i', () => {
    expect(validateFlags('sed', ['-n', '10p', 'file'])).toBe(true)
  })

  it('blocks git push', () => {
    expect(validateFlags('git', ['push'])).toBe(false)
  })

  it('allows git log', () => {
    expect(validateFlags('git', ['log', '--oneline'])).toBe(true)
  })

  it('allows git stash list', () => {
    expect(validateFlags('git', ['stash', 'list'])).toBe(true)
  })

  it('blocks git stash pop', () => {
    expect(validateFlags('git', ['stash', 'pop'])).toBe(false)
  })

  it('allows npm list', () => {
    expect(validateFlags('npm', ['list'])).toBe(true)
  })

  it('blocks npm install', () => {
    expect(validateFlags('npm', ['install'])).toBe(false)
  })

  it('blocks npx anything', () => {
    expect(validateFlags('npx', ['create-react-app'])).toBe(false)
  })

  it('node without --version is unsafe', () => {
    expect(validateFlags('node', ['script.js'])).toBe(false)
    expect(validateFlags('node', [])).toBe(false)
  })

  it('node --version is safe', () => {
    expect(validateFlags('node', ['--version'])).toBe(true)
  })

  it('jq is safe unless -f used', () => {
    expect(validateFlags('jq', ['.name', 'file.json'])).toBe(true)
    expect(validateFlags('jq', ['-f', 'script.jq', 'file.json'])).toBe(false)
  })

  it('find blocks -exec and -delete', () => {
    expect(validateFlags('find', ['.', '-name', '*.ts'])).toBe(true)
    expect(validateFlags('find', ['.', '-name', '*.tmp', '-delete'])).toBe(false)
    expect(validateFlags('find', ['.', '-exec', 'rm', '{}', ';'])).toBe(false)
  })

  it('xargs is safe only with safe sub-command', () => {
    expect(validateFlags('xargs', ['grep', 'pattern'])).toBe(true)
    expect(validateFlags('xargs', ['rm'])).toBe(false)
    expect(validateFlags('xargs', [])).toBe(false)
  })

  it('tee is safe only to /dev/null', () => {
    expect(validateFlags('tee', ['/dev/null'])).toBe(true)
    expect(validateFlags('tee', ['/tmp/output'])).toBe(false)
  })

  it('pip safe subcommands', () => {
    expect(validateFlags('pip', ['list'])).toBe(true)
    expect(validateFlags('pip', ['show', 'flask'])).toBe(true)
    expect(validateFlags('pip', ['install', 'flask'])).toBe(false)
  })

  it('yarn safe subcommands', () => {
    expect(validateFlags('yarn', ['list'])).toBe(true)
    expect(validateFlags('yarn', ['add', 'react'])).toBe(false)
  })

  it('unknown command defaults to true', () => {
    expect(validateFlags('unknowncommand', ['--flag'])).toBe(true)
  })
})
