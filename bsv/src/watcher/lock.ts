// Only one process may own the watcher journal. Two watchers on one journal could each read
// "new" for the same intent and both sign. The lock is a file created exclusively next to the
// journal, holding the owner's pid; a lock left by a process that no longer runs is taken over.
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs'

export interface JournalLock {
  file: string
  release: () => void
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function lockJournal(journalFile: string): JournalLock {
  const file = `${journalFile}.lock`
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600)
      writeSync(fd, String(process.pid))
      closeSync(fd)
      let released = false
      const release = (): void => {
        if (released) return
        released = true
        try {
          if (readFileSync(file, 'utf8') === String(process.pid)) unlinkSync(file)
        } catch {
          // Already gone.
        }
      }
      process.once('exit', release)
      return { file, release }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const owner = Number(readFileSync(file, 'utf8'))
      if (Number.isSafeInteger(owner) && owner > 0 && alive(owner)) {
        throw new Error(`The watcher journal is in use by process ${owner} (${file}); only one watcher may run`)
      }
      unlinkSync(file) // stale: its process is gone
    }
  }
  throw new Error(`Could not lock ${file}`)
}
