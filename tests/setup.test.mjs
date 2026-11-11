import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('Codex registration preserves unrelated TOML, backs it up and removes only its own entry', { skip: process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-config-'))
  const home = path.join(dir, 'codex'); fs.mkdirSync(home)
  const file = path.join(home, 'config.toml')
  const original = 'model = "unchanged"\n\n[mcp_servers.unrelated]\ncommand = "keep-this"\nargs = []\ntype = "stdio"\n\n[projects."/tmp/example with spaces"]\ntrust_level = "trusted"\n'
  fs.writeFileSync(file, original)
  const cwd = fileURLToPath(new URL('../', import.meta.url)), cli = path.join(cwd, 'src/cli.mjs')
  const env = { ...process.env, CODEX_HOME: home, DROID_BIN: path.join(cwd, 'tests/fixtures/fake-droid.mjs') }
  try {
    const setup = JSON.parse(execFileSync(process.execPath, [cli, 'setup'], { cwd, env, encoding: 'utf8' }))
    assert.equal(setup.registered, true)
    assert.equal(fs.readFileSync(setup.backup, 'utf8'), original)
    const parse = () => JSON.parse(execFileSync('python3', ['-c', 'import sys,tomllib,json;print(json.dumps(tomllib.load(open(sys.argv[1],"rb"))))', file], { encoding: 'utf8' }))
    const data = parse()
    assert.equal(data.model, 'unchanged'); assert.equal(data.mcp_servers.unrelated.command, 'keep-this')
    assert.deepEqual(data.mcp_servers.unrelated.args, []); assert.equal(data.mcp_servers.unrelated.type, 'stdio')
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(original.trimEnd()))
    assert.equal(data.mcp_servers['droid-baton'].tool_timeout_sec, 3600)
    assert.equal(data.mcp_servers['droid-baton'].args[0], path.join(cwd, 'src/server.mjs'))
    assert.equal(data.projects['/tmp/example with spaces'].trust_level, 'trusted')
    execFileSync(process.execPath, [cli, 'setup', '--remove'], { cwd, env })
    const after = parse(); assert.equal(after.mcp_servers['droid-baton'], undefined); assert.equal(after.mcp_servers.unrelated.command, 'keep-this')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
