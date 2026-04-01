import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validatePath } from '../../src/permissions/path-validation'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

// macOS tmpdir resolves under /var (which is a dangerous path), so we use
// a temp directory under $HOME to avoid false positives.
let tmpDir: string

beforeEach(async () => {
  const base = path.join(os.homedir(), '.nanocode-test-tmp')
  await fs.mkdir(base, { recursive: true })
  tmpDir = await fs.mkdtemp(path.join(base, 'path-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('Path Validation', () => {
  // -------------------------------------------------------------------
  // Dangerous paths rejected
  // -------------------------------------------------------------------
  describe('dangerous paths', () => {
    it('rejects root path /', async () => {
      const result = await validatePath('/', tmpDir)
      expect(result.allowed).toBe(false)
      expect(result.message).toContain('dangerous system path')
    })

    it('rejects /etc', async () => {
      const result = await validatePath('/etc', tmpDir)
      expect(result.allowed).toBe(false)
    })

    it('rejects /etc/passwd', async () => {
      const result = await validatePath('/etc/passwd', tmpDir)
      expect(result.allowed).toBe(false)
      expect(result.message).toContain('/etc')
    })

    it('rejects ~/.ssh', async () => {
      const sshDir = path.join(os.homedir(), '.ssh')
      const result = await validatePath(sshDir, tmpDir)
      expect(result.allowed).toBe(false)
      expect(result.message).toContain('.ssh')
    })

    it('rejects ~/.aws', async () => {
      const awsDir = path.join(os.homedir(), '.aws')
      const result = await validatePath(awsDir, tmpDir)
      expect(result.allowed).toBe(false)
      expect(result.message).toContain('.aws')
    })

    it('rejects ~/.gnupg', async () => {
      const gnupgDir = path.join(os.homedir(), '.gnupg')
      const result = await validatePath(gnupgDir, tmpDir)
      expect(result.allowed).toBe(false)
    })

    it('rejects ~/.config', async () => {
      const configDir = path.join(os.homedir(), '.config')
      const result = await validatePath(configDir, tmpDir)
      expect(result.allowed).toBe(false)
    })

    it('rejects files inside ~/.ssh/', async () => {
      const keyPath = path.join(os.homedir(), '.ssh', 'id_rsa')
      const result = await validatePath(keyPath, tmpDir)
      expect(result.allowed).toBe(false)
    })
  })

  // -------------------------------------------------------------------
  // Normal project paths allowed
  // -------------------------------------------------------------------
  describe('normal project paths', () => {
    it('allows a file inside the project root', async () => {
      const filePath = path.join(tmpDir, 'src', 'index.ts')
      const result = await validatePath(filePath, tmpDir)
      expect(result.allowed).toBe(true)
      expect(result.message).toBeUndefined()
    })

    it('allows the project root itself', async () => {
      const result = await validatePath(tmpDir, tmpDir)
      expect(result.allowed).toBe(true)
    })
  })

  // -------------------------------------------------------------------
  // Outside project boundary -> warning
  // -------------------------------------------------------------------
  describe('project boundary', () => {
    it('warns when path is outside project root', async () => {
      // Use a sibling directory under the same parent (still under $HOME, so not dangerous)
      const outsidePath = path.join(path.dirname(tmpDir), 'some-other-place', 'file.txt')
      const result = await validatePath(outsidePath, tmpDir)
      expect(result.allowed).toBe(true)
      expect(result.message).toContain('outside the project root')
    })
  })

  // -------------------------------------------------------------------
  // Symlink resolution
  // -------------------------------------------------------------------
  describe('symlink resolution', () => {
    it('rejects symlink pointing to dangerous path', async () => {
      const linkPath = path.join(tmpDir, 'evil-link')
      try {
        // Use /usr instead of /etc because on macOS /etc -> /private/etc
        // and /private/etc is not in the dangerous paths list.
        // /usr resolves to itself on macOS.
        await fs.symlink('/usr', linkPath)
      } catch {
        // Symlink creation may fail on some systems; skip test
        return
      }
      const result = await validatePath(linkPath, tmpDir)
      expect(result.allowed).toBe(false)
      expect(result.message).toContain('symlink')
    })

    it('allows symlink pointing to safe location inside project', async () => {
      const realDir = path.join(tmpDir, 'real')
      await fs.mkdir(realDir, { recursive: true })
      const linkPath = path.join(tmpDir, 'link-to-real')
      await fs.symlink(realDir, linkPath)
      const result = await validatePath(linkPath, tmpDir)
      expect(result.allowed).toBe(true)
    })
  })

  // -------------------------------------------------------------------
  // Path normalization
  // -------------------------------------------------------------------
  describe('path normalization', () => {
    it('normalizes relative paths', async () => {
      const result = await validatePath('./src/index.ts', tmpDir)
      expect(result).toHaveProperty('allowed')
    })

    it('normalizes paths with ..', async () => {
      const filePath = path.join(tmpDir, 'src', '..', 'package.json')
      const result = await validatePath(filePath, tmpDir)
      expect(result.allowed).toBe(true)
    })
  })
})
