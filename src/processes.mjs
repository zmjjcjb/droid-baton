// Linux process identity/ownership checks. A PID alone is never permission to
// signal a process: it may have been reused or belong to an unrelated program.
import fs from 'node:fs'
export function processIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 1) return null
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { pid, state: fields[0], ppid: Number(fields[1]), pgrp: Number(fields[2]), start_ticks: fields[19], uid: fs.statSync(`/proc/${pid}`).uid }
  } catch { return null }
}
export function ownedProcess(pid, ownerPid) {
  const identity = processIdentity(pid)
  if (!identity || identity.uid !== process.getuid?.()) return null
  let p = identity
  for (let i = 0; i < 128 && p; i++) {
    if (p.pid === ownerPid) return identity
    if (p.ppid <= 1 || p.ppid === p.pid) break
    p = processIdentity(p.ppid)
  }
  return null
}
export function processAlive(identity) {
  const p = processIdentity(identity?.pid)
  return !!p && p.state !== 'Z' && p.start_ticks === identity.start_ticks && p.uid === identity.uid
}
export function stopProcess(identity) {
  if (!processAlive(identity)) return false
  const p = processIdentity(identity.pid)
  try { process.kill(p.pgrp === p.pid ? -p.pid : p.pid, 'SIGKILL'); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
