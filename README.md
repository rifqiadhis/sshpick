# @rifqiadhi/sshpick

Stop typing ssh commands by hand. sshpick reads your `~/.ssh/config`, lists your servers, and connects you in one keystroke. Zero dependencies, single file.

> npm package: [@rifqiadhi/sshpick](https://www.npmjs.com/package/@rifqiadhi/sshpick) | `npm install -g @rifqiadhi/sshpick`

## Install

```bash
git clone https://github.com/rifqiadhis/sshpick.git
cd sshpick
npm link
```

Or from npm:

```bash
npm install -g @rifqiadhi/sshpick
```

Or run directly:

```bash
node bin/sshpick.js
```

## Usage

```bash
sshpick                          # interactive picker
sshpick <host>                   # connect to a saved host
sshpick <user>@<host> [-i key]   # ad-hoc connect, passed straight to ssh
sshpick add <name> ...           # save a host to ~/.ssh/config
sshpick edit <name> [user@host] [-i key] [-p port]   # update a saved host
sshpick rm <name>                # remove a saved host
sshpick rename <old> <new>       # rename a saved host
sshpick --list                   # list saved hosts
```

### Editing and removing hosts

```bash
# change fields in place (only the given ones are updated)
sshpick edit my-vps adi@203.0.113.10 -p 2222
sshpick edit my-vps -i ~/.ssh/new_key.pem

# or edit the config in $EDITOR
sshpick edit my-vps

# rename the alias
sshpick rename my-vps web-prod

# remove it
sshpick rm my-vps
```

### Adding hosts

Feed it the ssh command you normally type:

```bash
sshpick add my-vps --from "ssh adi@203.0.113.10 -i ~/.ssh/id_ed25519"

# or directly
sshpick add my-vps adi@203.0.113.10 -i ~/.ssh/id_ed25519
sshpick add db-server root@10.0.0.5 -p 2222
```

This appends a standard block to `~/.ssh/config`:

```
Host my-vps
  HostName 203.0.113.10
  User adi
  IdentityFile /home/you/.ssh/id_ed25519
```

So plain `ssh my-vps` keeps working too.

### Connecting

```bash
sshpick                                # pick from the list
sshpick my-vps                         # connect to a saved host
sshpick adi@203.0.113.10 -i ~/.ssh/id_ed25519   # one-off
```

### Picker keys

| Key | Action |
|---|---|
| up/down or `j`/`k` | navigate |
| typing | filter hosts |
| `Enter` | connect |
| `e` | open `~/.ssh/config` in `$EDITOR` |
| `esc` / `q` | quit |

## Notes

- Reads `HostName`, `User`, `Port`, `IdentityFile` from `~/.ssh/config`, including `Include` directives.
- Saved hosts are plain ssh config entries, so they work with the `ssh` command as usual.
- Keystrokes typed while the picker is open are flushed before the connection starts, so nothing leaks into the remote session.

## Config

Set `SSHPICK_CONFIG=/path/to/config` to use a different ssh config file.

## License

MIT
