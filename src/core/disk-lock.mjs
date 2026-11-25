// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {number} pid
 * @returns {'alive' | 'dead' | 'unknown'}
 */
function checkPidState(pid) {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return 'dead';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Atomically creates `<qaDir>/.aitest/.write.lock` using write-to-temp + `fs.linkSync(tmp, lockFile)`
 * and fail-closed timeout handling (`WORKSPACE_LOCK_BUSY`).
 * Never deletes an existing lock merely because `JSON.parse` failed (protects concurrent writers).
 *
 * @param {string} lockDir
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: true, release: () => void } | { ok: false, reason: 'WORKSPACE_LOCK_BUSY', error: string }>}
 */
export async function acquireDiskLock(lockDir, timeoutMs = 15_000) {
  if (!lockDir || !fs.existsSync(lockDir)) {
    return { ok: true, release: () => {} };
  }
  const aitestDir = path.join(lockDir, '.aitest');
  const createdAitestDir = !fs.existsSync(aitestDir);
  if (createdAitestDir) {
    try {
      fs.mkdirSync(aitestDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        reason: 'WORKSPACE_LOCK_BUSY',
        error: `Unable to create lock directory "${aitestDir}": ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const lockFile = path.join(aitestDir, '.write.lock');
  const tmpFile = path.join(aitestDir, `.write.lock.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }) + '\n';
  const deadline = Date.now() + Math.max(50, timeoutMs);

  while (Date.now() < deadline) {
    try {
      fs.writeFileSync(tmpFile, payload, { encoding: 'utf8', flag: 'wx' });
      try {
        fs.linkSync(tmpFile, lockFile);
      } finally {
        try {
          if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
        } catch {
          // ignore tmp cleanup
        }
      }

      return {
        ok: true,
        release: () => {
          try {
            if (fs.existsSync(lockFile)) {
              const cur = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
              if (Number(cur?.pid) === process.pid) {
                fs.unlinkSync(lockFile);
              }
            }
            if (createdAitestDir && fs.existsSync(aitestDir)) {
              const remaining = fs.readdirSync(aitestDir);
              if (remaining.length === 0) {
                fs.rmdirSync(aitestDir);
              }
            }
          } catch {
            // do not forcibly unlink another process's lock
          }
        },
      };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (code !== 'EEXIST') {
        return {
          ok: false,
          reason: 'WORKSPACE_LOCK_BUSY',
          error: `Unable to acquire workspace lock "${lockFile}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }

      // Inspect existing lock conservatively: NEVER unlink on transient parse error!
      try {
        const rawText = fs.readFileSync(lockFile, 'utf8');
        const parsed = JSON.parse(rawText);
        const ownerPid = Number(parsed?.pid);
        const ageMs = Date.now() - Date.parse(String(parsed?.acquiredAt || ''));
        const pidState = checkPidState(ownerPid);
        if (pidState === 'dead' || (Number.isFinite(ageMs) && ageMs > 15 * 60_000)) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        // Wait if lock file is empty/partially written by a sibling; only reap if OS mtime > 15 min stale
        try {
          const stat = fs.statSync(lockFile);
          if (Date.now() - stat.mtimeMs > 15 * 60_000) {
            fs.unlinkSync(lockFile);
            continue;
          }
        } catch {
          // Lock vanished while inspecting; retry immediately
          continue;
        }
      }

      await new Promise((r) => setTimeout(r, 40));
    }
  }

  return {
    ok: false,
    reason: 'WORKSPACE_LOCK_BUSY',
    error: `Timed out after ${timeoutMs}ms waiting for workspace write lock "${lockFile}" (WORKSPACE_LOCK_BUSY). Retry after concurrent write finishes.`,
  };
}
