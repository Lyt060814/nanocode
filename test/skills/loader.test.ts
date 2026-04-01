import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseFrontmatter, parseSkillFile, loadAllSkills } from '../../src/skills/loader'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanocode-skill-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

// Helper: create a skill directory with a SKILL.md file
async function createSkill(baseDir: string, skillName: string, content: string): Promise<string> {
  const skillDir = path.join(baseDir, '.claude', 'skills', skillName)
  await fs.mkdir(skillDir, { recursive: true })
  const filePath = path.join(skillDir, 'SKILL.md')
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

describe('parseFrontmatter', () => {
  it('extracts key:value pairs', () => {
    const content = `---
name: my-skill
description: A test skill
---
Body text here.`
    const { frontmatter, body } = parseFrontmatter(content)
    expect(frontmatter.name).toBe('my-skill')
    expect(frontmatter.description).toBe('A test skill')
    expect(body).toContain('Body text here.')
  })

  it('handles arrays with - item syntax', () => {
    const content = `---
arguments:
  - file
  - language
---
Body`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.arguments).toEqual(['file', 'language'])
  })

  it('handles inline array [a, b] syntax', () => {
    const content = `---
paths: [src, lib]
---
Body`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.paths).toEqual(['src', 'lib'])
  })

  it('handles booleans', () => {
    const content = `---
user-invocable: true
agent: false
---
Body`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter['user-invocable']).toBe(true)
    expect(frontmatter.agent).toBe(false)
  })

  it('handles numbers', () => {
    const content = `---
priority: 42
---
Body`
    const { frontmatter } = parseFrontmatter(content)
    expect((frontmatter as any).priority).toBe(42)
  })

  it('handles quoted strings', () => {
    const content = `---
name: "my skill"
description: 'a "quoted" value'
---
Body`
    const { frontmatter } = parseFrontmatter(content)
    expect(frontmatter.name).toBe('my skill')
    expect(frontmatter.description).toBe('a "quoted" value')
  })

  it('returns empty frontmatter when no --- delimiters', () => {
    const content = 'Just plain body text.'
    const { frontmatter, body } = parseFrontmatter(content)
    expect(Object.keys(frontmatter)).toHaveLength(0)
    expect(body).toBe(content)
  })

  it('returns empty frontmatter when closing --- is missing', () => {
    const content = `---
name: test
no closing marker`
    const { frontmatter } = parseFrontmatter(content)
    expect(Object.keys(frontmatter)).toHaveLength(0)
  })
})

describe('parseSkillFile', () => {
  it('reads SKILL.md with frontmatter', async () => {
    const filePath = await createSkill(tmpDir, 'test-skill', `---
name: test-skill
description: A test skill
---
Hello $ARGUMENTS!`)
    const skill = await parseSkillFile(filePath)
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('test-skill')
    expect(skill!.description).toBe('A test skill')
  })

  it('uses directory name when name is not in frontmatter', async () => {
    const filePath = await createSkill(tmpDir, 'dir-name-skill', `---
description: Uses dir name
---
Body`)
    const skill = await parseSkillFile(filePath)
    expect(skill).not.toBeNull()
    expect(skill!.name).toBe('dir-name-skill')
  })

  it('returns null for nonexistent file', async () => {
    const skill = await parseSkillFile('/nonexistent/path/SKILL.md')
    expect(skill).toBeNull()
  })

  it('returns null for empty file', async () => {
    const skillDir = path.join(tmpDir, '.claude', 'skills', 'empty')
    await fs.mkdir(skillDir, { recursive: true })
    const filePath = path.join(skillDir, 'SKILL.md')
    await fs.writeFile(filePath, '', 'utf-8')
    const skill = await parseSkillFile(filePath)
    expect(skill).toBeNull()
  })

  describe('getPrompt substitutions', () => {
    it('substitutes $ARGUMENTS', async () => {
      const filePath = await createSkill(tmpDir, 'arg-skill', `---
name: arg-skill
description: Test
---
Run with: $ARGUMENTS`)
      const skill = await parseSkillFile(filePath)
      const prompt = await skill!.getPrompt('hello world')
      expect(prompt).toContain('Run with: hello world')
    })

    it('substitutes $1, $2 positional args', async () => {
      const filePath = await createSkill(tmpDir, 'pos-skill', `---
name: pos-skill
description: Test
---
File: $1, Lang: $2`)
      const skill = await parseSkillFile(filePath)
      const prompt = await skill!.getPrompt('main.ts typescript')
      expect(prompt).toContain('File: main.ts')
      expect(prompt).toContain('Lang: typescript')
    })

    it('substitutes ${CLAUDE_SKILL_DIR}', async () => {
      const filePath = await createSkill(tmpDir, 'dir-skill', `---
name: dir-skill
description: Test
---
Dir: \${CLAUDE_SKILL_DIR}`)
      const skill = await parseSkillFile(filePath)
      const prompt = await skill!.getPrompt('')
      const expectedDir = path.resolve(path.dirname(filePath))
      expect(prompt).toContain(`Dir: ${expectedDir}`)
    })
  })
})

describe('loadAllSkills', () => {
  it('discovers skills from .claude/skills/', async () => {
    await createSkill(tmpDir, 'skill-a', `---
name: skill-a
description: First skill
---
Body A`)
    await createSkill(tmpDir, 'skill-b', `---
name: skill-b
description: Second skill
---
Body B`)
    const skills = await loadAllSkills(tmpDir)
    const names = skills.map((s) => s.name)
    expect(names).toContain('skill-a')
    expect(names).toContain('skill-b')
  })

  it('deduplicates by name (case-insensitive)', async () => {
    // Create two skills with same name (different case) in different dirs
    // The first one found (closer to cwd) should win
    await createSkill(tmpDir, 'Dupe', `---
name: dupe
description: First
---
Body 1`)

    // Create a parent-level skill with same name
    const parentDir = path.dirname(tmpDir)
    const parentSkillDir = path.join(parentDir, '.claude', 'skills', 'DupeParent')
    try {
      await fs.mkdir(parentSkillDir, { recursive: true })
      await fs.writeFile(
        path.join(parentSkillDir, 'SKILL.md'),
        `---\nname: dupe\ndescription: Second\n---\nBody 2`,
        'utf-8',
      )
    } catch {
      // Parent may not be writable; just test with the one skill
    }

    const skills = await loadAllSkills(tmpDir)
    const dupes = skills.filter((s) => s.name.toLowerCase() === 'dupe')
    expect(dupes).toHaveLength(1)
    expect(dupes[0]!.description).toBe('First')

    // Cleanup parent skill if created
    try {
      await fs.rm(parentSkillDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('returns empty array when no skills exist', async () => {
    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nanocode-empty-'))
    try {
      const skills = await loadAllSkills(emptyDir)
      expect(skills).toEqual([])
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true })
    }
  })
})
