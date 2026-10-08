#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

// ---------- ANSI helpers ----------
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

// ---------- SSH config ----------
function sshConfigPath() {
  const env = process.env.SSHPICK_CONFIG || process.env.SSHMANAGE_CONFIG;
  if (env) return path.resolve(env);
  return path.join(os.homedir(), '.ssh', 'config');
}

const HELP = `sshpick - simple SSH host picker

Usage:
  sshpick                        interactive host picker from ~/.ssh/config
  sshpick <host>                 connect directly to a configured host
  sshpick <user>@<host> [-i key] [-p port]   ad-hoc connect, ssh-style
  sshpick add <name> <user>@<host> [-i key] [-p port]   save a host to config
  sshpick add <name> --from "ssh user@host -i key.pem"   add from an ssh command
  sshpick edit <name>            edit a host block in \$EDITOR
  sshpick edit <name> <user>@<host> [-i key] [-p port]   update fields in place
  sshpick rm <name>              remove a host from config
  sshpick rename <old> <new>     rename a host alias
  sshpick --list                 list hosts and exit
  sshpick --help                 this help

Options:
  SSHPICK_CONFIG=/path/to/config   use a different ssh config file`;

// tiny glob (no deps)
function globSync(pattern) {
  const dir = path.dirname(pattern);
  const base = path.basename(pattern);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  if (!base.includes('*') && !base.includes('?')) {
    return fs.existsSync(pattern) ? [pattern] : [];
  }
  const rx = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return entries.filter((e) => rx.test(e)).map((e) => path.join(dir, e));
}

/**
 * Parse ~/.ssh/config into host entries.
 * Supports: Host (multiple patterns), HostName, User, Port, IdentityFile,
 * Include directives, and skips wildcard-only patterns.
 */
function parseSshConfig(filePath, seen = new Set()) {
  const hosts = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return hosts;
  }
  if (seen.has(filePath)) return hosts;
  seen.add(filePath);

  const lines = raw.split('\n');
  let current = null;

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;

    const m = line.match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();

    if (key === 'include') {
      const pattern = value.replace(/^~/, os.homedir());
      const base = path.dirname(filePath);
      const full = path.isAbsolute(pattern) ? pattern : path.join(base, pattern);
      for (const f of globSync(full)) {
        hosts.push(...parseSshConfig(f, seen));
      }
      continue;
    }

    if (key === 'host') {
      const patterns = value.split(/\s+/);
      const concrete = patterns.filter((p) => !p.includes('*') && !p.includes('?'));
      if (concrete.length > 0) {
        current = { host: concrete[0], user: null, hostname: null, port: null, identity: null };
        hosts.push(current);
      } else {
        current = null; // wildcard block (Host *): skip as entry
      }
      continue;
    }

    if (!current) continue;
    if (key === 'hostname') current.hostname = value;
    else if (key === 'user') current.user = value;
    else if (key === 'port') current.port = value;
    else if (key === 'identityfile') current.identity = value.replace(/^~/, os.homedir());
  }

  return hosts;
}

// ---------- ssh-style arg parsing ----------
/** Parse args like: rifqi@1.2.3.4 -i ~/.ssh/key.pem -p 2222 */
function parseSshArgs(argv) {
  const out = { user: null, host: null, port: null, identity: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-i') out.identity = argv[++i];
    else if (a === '-p') out.port = argv[++i];
    else if (a.startsWith('-i') && a.length > 2) out.identity = a.slice(2);
    else if (a.startsWith('-p') && a.length > 2) out.port = a.slice(2);
    else if (!a.startsWith('-')) positional.push(a);
  }
  const target = positional[0];
  if (target) {
    if (target.includes('@')) {
      const idx = target.indexOf('@');
      out.user = target.slice(0, idx);
      out.host = target.slice(idx + 1);
    } else {
      out.host = target;
    }
  }
  return out;
}

function addHost({ name, user, host, port, identity }) {
  const cfgPath = sshConfigPath();
  const dir = path.dirname(cfgPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let block = `\nHost ${name}\n  HostName ${host}\n`;
  if (user) block += `  User ${user}\n`;
  if (port && port !== '22') block += `  Port ${port}\n`;
  if (identity) block += `  IdentityFile ${identity.replace(/^~/, os.homedir())}\n`;
  fs.appendFileSync(cfgPath, block);
  console.log(`${c.green}Added ${name}${c.reset} -> ${user ? user + '@' : ''}${host}${port && port !== '22' ? ' :' + port : ''}`);
  console.log(`${c.dim}saved to ${cfgPath}${c.reset}`);
}

/** Locate a host block's start/end line indexes (0-based, end exclusive) in the config text. */
function findHostBlock(lines, name) {
  const start = lines.findIndex((l) => {
    const m = l.trim().match(/^host\s+(.+)$/i);
    return m && m[1].trim().split(/\s+/).includes(name);
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*host\s+\S+/i.test(lines[i])) { end = i; break; }
  }
  return { start, end };
}

function requireHost(name, cfgPath) {
  const hosts = parseSshConfig(cfgPath);
  if (!hosts.find((h) => h.host === name)) {
    console.error(`${c.red}Host "${name}" not found in ${cfgPath}${c.reset}`);
    console.error(`Existing hosts: ${hosts.map((h) => h.host).join(', ') || '(none)'}`);
    process.exit(1);
  }
}

function removeHost(name) {
  const cfgPath = sshConfigPath();
  requireHost(name, cfgPath);
  const lines = fs.readFileSync(cfgPath, 'utf8').split('\n');
  const block = findHostBlock(lines, name);
  const removed = lines.splice(block.start, block.end - block.start);
  fs.writeFileSync(cfgPath, lines.join('\n'));
  console.log(`${c.green}Removed ${name}${c.reset} (${removed.filter((l) => l.trim()).length} lines)`);
}

function renameHost(oldName, newName) {
  const cfgPath = sshConfigPath();
  requireHost(oldName, cfgPath);
  if (parseSshConfig(cfgPath).find((h) => h.host === newName)) {
    console.error(`${c.red}Host "${newName}" already exists${c.reset}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(cfgPath, 'utf8').split('\n');
  const block = findHostBlock(lines, oldName);
  lines[block.start] = lines[block.start].replace(new RegExp(`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), newName);
  fs.writeFileSync(cfgPath, lines.join('\n'));
  console.log(`${c.green}Renamed ${oldName} -> ${newName}${c.reset}`);
}

/** Update fields of an existing host block in place. */
function editHostFields(name, { user, host, port, identity }) {
  const cfgPath = sshConfigPath();
  requireHost(name, cfgPath);
  const lines = fs.readFileSync(cfgPath, 'utf8').split('\n');
  const block = findHostBlock(lines, name);
  const updated = { user: null, host: null, port: null, identity: null };
  let changed = false;

  for (let i = block.start; i < block.end; i++) {
    const m = lines[i].trim().match(/^(\S+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === 'hostname' && host) { lines[i] = `  HostName ${host}`; updated.host = host; changed = true; }
    else if (key === 'user' && user) { lines[i] = `  User ${user}`; updated.user = user; changed = true; }
    else if (key === 'port' && port) { lines[i] = `  Port ${port}`; updated.port = port; changed = true; }
    else if (key === 'identityfile' && identity) { lines[i] = `  IdentityFile ${identity.replace(/^~/, os.homedir())}`; updated.identity = identity; changed = true; }
  }

  // append missing fields at the end of the block
  const append = [];
  if (host && updated.host === null) append.push(`  HostName ${host}`);
  if (user && updated.user === null) append.push(`  User ${user}`);
  if (port && updated.port === null) append.push(`  Port ${port}`);
  if (identity && updated.identity === null) append.push(`  IdentityFile ${identity.replace(/^~/, os.homedir())}`);
  if (append.length) {
    lines.splice(block.end, 0, ...append);
    changed = true;
  }

  if (!changed) {
    console.error(`${c.yellow}Nothing to update for ${name}${c.reset}`);
    process.exit(1);
  }
  fs.writeFileSync(cfgPath, lines.join('\n'));
  console.log(`${c.green}Updated ${name}${c.reset}`);
}

function editInEditor(name) {
  const cfgPath = sshConfigPath();
  requireHost(name, cfgPath);
  const editor = process.env.EDITOR || 'vi';
  const child = spawn(editor, [cfgPath], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
}

function connect(name) {
  const child = spawn('ssh', [name], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (e) => {
    console.error(`Failed to launch ssh: ${e.message}`);
    process.exit(1);
  });
}

// ---------- Interactive list ----------
function renderList(hosts, selected, filter, connectedName) {
  const lines = [];
  lines.push('');
  lines.push(`${c.bold}${c.cyan}sshpick${c.reset} ${c.dim}- pick a host, hit Enter${c.reset}`);
  lines.push('');
  const shown = hosts.filter(
    (h) =>
      !filter ||
      h.host.toLowerCase().includes(filter) ||
      (h.hostname || '').toLowerCase().includes(filter) ||
      (h.user || '').toLowerCase().includes(filter)
  );
  if (shown.length === 0) {
    lines.push(`  ${c.yellow}No matching hosts.${c.reset}`);
  }
  shown.forEach((h, i) => {
    const isSel = i === selected;
    const cur = isSel ? `${c.cyan}> ` : '  ';
    const name = isSel ? `${c.bold}${c.cyan}${h.host}${c.reset}` : h.host;
    const meta = [];
    if (h.user) meta.push(h.user);
    if (h.hostname && h.hostname !== h.host) meta.push(h.hostname);
    if (h.port && h.port !== '22') meta.push(`:${h.port}`);
    if (h.identity) meta.push(`key: ${path.basename(h.identity)}`);
    if (connectedName === h.host) meta.push(`${c.green}connected${c.reset}`);
    const metaStr = meta.length ? ` ${c.dim}${meta.join('  ')}${c.reset}` : '';
    lines.push(`${cur}${name}${metaStr}`);
  });
  lines.push('');
  if (filter) lines.push(`${c.dim}  filter: "${filter}" (backspace to edit, esc to clear)${c.reset}`);
  else lines.push(`${c.dim}  up/down or j/k  |  type to filter  |  enter connect  |  e edit config  |  q quit${c.reset}`);
  return { text: lines.join('\n'), shown };
}

async function main() {
  const args = process.argv.slice(2);
  const cfgPath = sshConfigPath();

  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  // sshpick add ... - save a host to config
  if (args[0] === 'add') {
    const rest = args.slice(1);
    const fromIdx = rest.indexOf('--from');
    if (fromIdx !== -1) {
      const name = rest[0];
      const cmd = rest[fromIdx + 1] || '';
      const parts = cmd.trim().split(/\s+/);
      if (parts[0] === 'ssh') parts.shift();
      const parsed = parseSshArgs(parts);
      if (!name || !parsed.host) {
        console.error(`${c.red}Could not parse target from: ${cmd}${c.reset}`);
        process.exit(1);
      }
      addHost({ name, ...parsed });
      process.exit(0);
    }
    const name = rest[0];
    const parsed = parseSshArgs(rest.slice(1));
    if (!name || !parsed.host) {
      console.error(`${c.red}Usage: sshpick add <name> <user>@<host> [-i key] [-p port]${c.reset}`);
      console.error(`       sshpick add <name> --from "ssh user@host -i key.pem"`);
      process.exit(1);
    }
    addHost({ name, ...parsed });
    process.exit(0);
  }

  // sshpick rm <name>
  if (args[0] === 'rm' || args[0] === 'remove' || args[0] === 'delete') {
    if (!args[1]) {
      console.error(`${c.red}Usage: sshpick rm <name>${c.reset}`);
      process.exit(1);
    }
    removeHost(args[1]);
    process.exit(0);
  }

  // sshpick rename <old> <new>
  if (args[0] === 'rename' || args[0] === 'mv') {
    if (!args[1] || !args[2]) {
      console.error(`${c.red}Usage: sshpick rename <old> <new>${c.reset}`);
      process.exit(1);
    }
    renameHost(args[1], args[2]);
    process.exit(0);
  }

  // sshpick edit <name> [user@host] [-i key] [-p port]
  if (args[0] === 'edit') {
    const rest = args.slice(1);
    if (!rest[0]) {
      console.error(`${c.red}Usage: sshpick edit <name> [user@host] [-i key] [-p port]${c.reset}`);
      process.exit(1);
    }
    if (rest.length === 1) {
      editInEditor(rest[0]); // no field args: open $EDITOR
      return;
    }
    const parsed = parseSshArgs(rest.slice(1));
    if (!parsed.host && !parsed.user && !parsed.port && !parsed.identity) {
      editInEditor(rest[0]);
      return;
    }
    editHostFields(rest[0], parsed);
    process.exit(0);
  }

  const hosts = parseSshConfig(cfgPath);

  if (args.includes('--list')) {
    if (hosts.length === 0) {
      console.log('No hosts found in ' + cfgPath);
      process.exit(0);
    }
    for (const h of hosts) {
      const meta = [h.user, h.hostname && h.hostname !== h.host ? h.hostname : null, h.port && h.port !== '22' ? h.port : null]
        .filter(Boolean)
        .join(' @ ');
      console.log(`  ${h.host}${meta ? '  ' + c.dim + meta + c.reset : ''}`);
    }
    process.exit(0);
  }

  // direct connect - supports config alias, user@host, and ssh flags (-i, -p)
  if (args.length > 0 && !args[0].startsWith('-')) {
    const target = args[0];
    const rest = args.slice(1);
    const known = hosts.find((h) => h.host === target);
    if (known && rest.length === 0) {
      connect(target);
      return;
    } else if (target.includes('@') || rest.length > 0) {
      // ssh-style ad-hoc: pass everything straight to ssh
      const child = spawn('ssh', args, { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code || 0));
      child.on('error', (e) => {
        console.error(`Failed to launch ssh: ${e.message}`);
        process.exit(1);
      });
      return;
    } else {
      console.error(`${c.red}Unknown host "${target}"${c.reset}`);
      console.error(`Add it first: ${c.bold}sshpick add ${target} user@hostname${c.reset}`);
      process.exit(1);
    }
  }

  if (hosts.length === 0) {
    console.error(`${c.red}No hosts found in ${cfgPath}${c.reset}`);
    console.error(`\nAdd one:\n\n  ${c.bold}sshpick add myserver user@1.2.3.4${c.reset}\n  ${c.bold}sshpick add myserver --from "ssh user@1.2.3.4 -i ~/.ssh/key.pem"${c.reset}\n`);
    process.exit(1);
  }

  // ---------- TUI loop ----------
  let filter = '';
  let selected = 0;
  let connectedName = null;
  let launching = false;

  process.stdout.write('\x1b[?25l'); // hide cursor
  process.on('exit', () => process.stdout.write('\x1b[?25h'));

  const draw = () => {
    const { text, shown } = renderList(hosts, selected, filter, connectedName);
    if (selected >= shown.length) selected = Math.max(0, shown.length - 1);
    process.stdout.write('\x1b[2J\x1b[H' + text);
    return shown;
  };

  let shown = draw();

  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  const cleanup = () => {
    process.stdout.write('\x1b[?25h');
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  };

  /** Detach the picker UI completely so nothing we type leaks into ssh */
  const detach = () => {
    launching = true;
    process.stdin.removeAllListeners('keypress');
    if (process.stdin.isTTY) process.stdin.setRawMode(true); // raw keeps node consuming buffered keys
    // discard everything already buffered (e.g. repeated Enters)
    try {
      while (process.stdin.read() !== null) {}
    } catch {}
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.removeAllListeners('readable');
    process.stdin.removeAllListeners('data');
    process.stdin.pause();
    process.stdout.write('\x1b[?25h'); // show cursor again
  };

  process.stdin.on('keypress', (str, key) => {
    if (!key || launching) return;
    if (key.ctrl && key.name === 'c') cleanup();

    if (key.name === 'q' && !filter) cleanup();
    if (key.name === 'escape') {
      if (filter) {
        filter = '';
        selected = 0;
      } else cleanup();
    }

    if (key.name === 'up' || key.name === 'k') {
      selected = (selected - 1 + shown.length) % Math.max(1, shown.length);
    } else if (key.name === 'down' || key.name === 'j') {
      selected = (selected + 1) % Math.max(1, shown.length);
    } else if (key.name === 'backspace') {
      filter = filter.slice(0, -1);
      selected = 0;
    } else if (key.name === 'return') {
      const host = shown[selected];
      if (host) {
        detach();
        process.stdout.write('\x1b[2J\x1b[H');
        connect(host.host);
      }
    } else if (key.name === 'e') {
      // open config in $EDITOR
      process.stdout.write('\x1b[?25h');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const editor = process.env.EDITOR || 'vi';
      const child = spawn(editor, [cfgPath], { stdio: 'inherit' });
      child.on('exit', () => process.exit(0));
      return;
    } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
      filter += str;
      selected = 0;
    }

    shown = draw();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
