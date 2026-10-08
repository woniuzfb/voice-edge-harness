/**
 * Create a Git release tag and push it to origin to trigger release workflows.
 * Supports positional argument as well as flags:
 *   pnpm run release v1.2.3
 *   pnpm run release v1.2.3 --clean
 *   pnpm run release v1.2.3 --delete
 *   pnpm run release --tag=v1.2.3
 *   pnpm run release -t v1.2.3
 */

import { execFileSync } from 'node:child_process'
import { readSync } from 'node:fs'
import { resolve } from 'node:path'

/** Parsed options from command-line arguments. */
export interface ReleaseTagOptions {
  tag: string | null
  allowDirty: boolean
  dryRun: boolean
  clean: boolean
  deleteOnly: boolean
}

/**
 * Parse release tag and options from command-line arguments.
 * @param argv - command-line arguments without node and script path.
 * @returns parsed release tag and flag options.
 */
export function parseTagArgs(argv: string[]): ReleaseTagOptions {
  let tag: string | null = null
  let allowDirty = false
  let dryRun = false
  let clean = false
  let deleteOnly = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--allow-dirty') {
      allowDirty = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (arg === '--clean' || arg === '--recreate' || arg === '--force' || arg === '-f') {
      clean = true
    } else if (arg === '--delete' || arg === '-d') {
      deleteOnly = true
    } else if (arg === '--tag' || arg === '-t') {
      tag = argv[i + 1] ?? null
      i += 1
    } else if (arg.startsWith('--tag=')) {
      tag = arg.slice('--tag='.length)
    } else if (!arg.startsWith('-')) {
      tag = arg
    }
  }

  if (!tag && process.env.TAG) {
    tag = process.env.TAG
  }

  return { tag, allowDirty, dryRun, clean, deleteOnly }
}

function git(args: string[], options: { stdio?: 'inherit' | 'pipe' } = {}): string {
  const result: unknown = execFileSync('git', args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
  })
  if (typeof result === 'string') {
    return result.trim()
  }
  return ''
}

/**
 * Detect the GitHub repository (owner/repo) from the origin remote URL.
 * @returns owner/repo string if matched, otherwise null.
 */
export function getOriginGitHubRepo(): string | null {
  try {
    const url = git(['remote', 'get-url', 'origin'])
    const match = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/.exec(url)
    if (match) {
      return `${match[1]}/${match[2]}`
    }
  } catch {
    // remote origin might not exist
  }
  return null
}

/**
 * Check if the GitHub CLI (gh) is installed and available in PATH.
 * @returns true if gh is executable, false otherwise.
 */
export function hasGhCli(): boolean {
  try {
    execFileSync('gh', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Delete a GitHub release and its associated remote and local tags.
 * @param tag - Tag name to delete.
 * @param repo - Optional owner/repo repository identifier.
 * @param dryRun - Whether to perform a dry run.
 */
export function deleteReleaseAndTags(tag: string, repo: string | null, dryRun = false): void {
  if (hasGhCli()) {
    const args = ['release', 'delete', tag, '-y', '--cleanup-tag']
    if (repo) {
      args.push('-R', repo)
    }
    console.log(`Deleting remote release and tag via: gh ${args.join(' ')}`)
    if (dryRun) {
      console.log(`[dry-run] gh ${args.join(' ')}`)
    } else {
      try {
        execFileSync('gh', args, { stdio: 'inherit' })
        console.log(`Remote release and tag "${tag}" successfully cleaned up.`)
      } catch {
        console.log(`Note: Remote release "${tag}" was not found or already deleted on GitHub.`)
      }
    }
  } else {
    console.warn('Warning: GitHub CLI (gh) not found in PATH.')
    console.log(`Falling back to deleting remote git tag via: git push origin --delete ${tag}...`)
    if (!dryRun) {
      try {
        git(['push', 'origin', '--delete', tag], { stdio: 'inherit' })
      } catch {
        // remote tag may not exist
      }
    }
  }

  // Also remove local tag if present
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    console.log(`Deleting local tag "${tag}"...`)
    if (dryRun) {
      console.log(`[dry-run] git tag -d ${tag}`)
    } else {
      git(['tag', '-d', tag], { stdio: 'inherit' })
    }
  } catch {
    // local tag did not exist
  }
}

/**
 * Prompt the user for confirmation on standard input if in a TTY environment.
 * @param question - Question displayed to user.
 * @returns true if confirmed with 'y' or 'yes', false otherwise.
 */
export function confirmPrompt(question: string): boolean {
  if (!process.stdin.isTTY) return false
  process.stdout.write(question)
  try {
    const buf = Buffer.alloc(16)
    const bytesRead = readSync(0, buf, 0, 16, null)
    const input = buf.toString('utf8', 0, bytesRead).trim().toLowerCase()
    return input === 'y' || input === 'yes'
  } catch {
    return false
  }
}

/**
 * Execute the release tag flow: check status, create tag, and push to origin.
 * @param argv - command-line arguments passed to the script.
 */
export function runReleaseTag(argv: string[] = process.argv.slice(2)): void {
  const { tag, allowDirty, dryRun, clean, deleteOnly } = parseTagArgs(argv)

  if (!tag) {
    console.error('Error: Tag name is required.')
    console.error('')
    console.error('Usage:')
    console.error('  pnpm run release <tag> [--clean] [--delete]')
    console.error('  pnpm run release --tag=<tag>')
    console.error('')
    console.error('Examples:')
    console.error('  pnpm run release v0.2.0-rc.2')
    console.error('  pnpm run release v0.2.0-rc.2 --clean')
    console.error('  pnpm run release v0.2.0-rc.2 --delete')
    process.exit(1)
  }

  if (!tag.startsWith('v') && !tag.startsWith('desktop-v')) {
    console.warn(`Warning: Tag "${tag}" does not start with "v" or "desktop-v".`)
    console.warn('Note: GitHub Actions desktop-release.yml triggers only on tags matching "v*" or "desktop-v*".')
  }

  const repo = getOriginGitHubRepo()

  if (deleteOnly) {
    console.log(`Cleaning up release and tag "${tag}"...`)
    deleteReleaseAndTags(tag, repo, dryRun)
    console.log(`Cleanup complete for "${tag}".`)
    return
  }

  if (!allowDirty) {
    const status = git(['status', '--porcelain'])
    if (status.length > 0) {
      console.error('Error: Working directory has uncommitted changes.')
      console.error('Please commit or stash your changes before tagging, or pass --allow-dirty.')
      process.exit(1)
    }
  }

  let tagExistsLocally = false
  try {
    git(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])
    tagExistsLocally = true
  } catch {
    // Tag does not exist locally
  }

  let tagExistsRemotely = false
  try {
    const remoteTags = git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
    tagExistsRemotely = remoteTags.length > 0
  } catch {
    // Remote query failed or offline
  }

  if (clean) {
    console.log(`Flag --clean specified. Cleaning existing release and tags for "${tag}"...`)
    deleteReleaseAndTags(tag, repo, dryRun)
    tagExistsLocally = false
    tagExistsRemotely = false
  } else if (tagExistsRemotely || tagExistsLocally) {
    let sameHead = false
    if (tagExistsLocally) {
      const tagSha = git(['rev-parse', `refs/tags/${tag}`])
      const headSha = git(['rev-parse', 'HEAD'])
      sameHead = tagSha === headSha
    }

    if (sameHead && !tagExistsRemotely) {
      console.log(`Tag "${tag}" already exists locally on current HEAD. Proceeding to push...`)
    } else {
      console.warn(`Warning: Tag "${tag}" already exists on ${tagExistsRemotely ? 'remote' : 'local'}.`)
      const shouldClean = confirmPrompt('Clean existing release & tags and recreate on current HEAD? (y/N): ')
      if (shouldClean) {
        deleteReleaseAndTags(tag, repo, dryRun)
        tagExistsLocally = false
        tagExistsRemotely = false
      } else {
        console.error('Aborted. To cleanly re-release on current HEAD, run:')
        console.error(`  pnpm run release ${tag} --clean`)
        console.error('Or to only delete the remote release and tags:')
        console.error(`  pnpm run release ${tag} --delete`)
        process.exit(1)
      }
    }
  }

  if (!tagExistsLocally) {
    console.log(`Creating git tag "${tag}"...`)
    if (dryRun) {
      console.log(`[dry-run] git tag "${tag}"`)
    } else {
      git(['tag', tag], { stdio: 'inherit' })
    }
  }

  console.log(`Pushing tag "${tag}" to origin...`)
  if (dryRun) {
    console.log(`[dry-run] git push origin "${tag}"`)
    return
  }

  git(['push', 'origin', tag], { stdio: 'inherit' })

  console.log('')
  console.log(`Successfully created and pushed tag "${tag}"!`)
  console.log('GitHub Actions Desktop Release workflow has been triggered.')
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  runReleaseTag()
}
