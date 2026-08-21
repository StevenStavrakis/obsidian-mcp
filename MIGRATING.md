# Migrating from 1.x to 2.0

Version 2 is an intentional security, CLI, and tool-contract release. Existing v1 startup configurations continue to work during the transition and print their exact replacement to stderr. The server also accepts both 2025-era and `2026-07-28` MCP clients by default.

After changing configuration, fully restart the MCP client or open a new session so it starts the new process and refreshes its cached tool catalog.

## Copy-paste configuration migration

Old v1 configuration:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp", "/absolute/path/to/vault"]
    }
  }
}
```

New v2 configuration:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "npx",
      "args": ["-y", "obsidian-mcp", "serve", "--vault", "notes=/absolute/path/to/vault"]
    }
  }
}
```

For a global install, use `"command": "obsidian-mcp"` and begin `args` with `"serve"`. For multiple vaults, repeat `"--vault", "id=/absolute/path"`. Vault ids are the values agents pass to tools.

## Required changes

1. Install Node.js 22 or 24 LTS.
2. Replace positional vault paths with `serve --vault id=/absolute/path` arguments.
3. Update stored prompts and hard-coded calls to the new prefixed snake_case tool names and fields.
4. Restart the MCP client so it rediscovers tools. Protocol upgrades can happen independently because v2 serves both MCP eras by default.

## Unsupported Node.js

`UNSUPPORTED_NODE_VERSION` means the MCP client launched v2 using Node.js older than 22. Running `node --version` in a terminal is not sufficient if the client has a different PATH.

1. Install Node.js 22 or 24 LTS.
2. Restart the MCP client completely.
3. If the error remains, configure the client with the absolute path to the upgraded `npx` or `obsidian-mcp` executable.
4. Verify the executable from the same environment with `node --version` and `obsidian-mcp --version`.

## V1 positional vault paths

`V1_POSITIONAL_CONFIG_DEPRECATED` is a warning, not a startup failure. The `Detected` section shows how each old path was mapped to a v2 vault id. Copy the JSON argument array from `Fix` into the MCP server's `args` setting, preserving any `npx -y obsidian-mcp` prefix owned by the client configuration.

Do not mix positional paths with `--vault`; `CLI_MIXED_CONFIG_SYNTAX` explains which complete form to use. A positional path is made absolute and `~` is expanded before its replacement is printed.

## Legacy MCP clients

`LEGACY_MCP_PROTOCOL` means the server is working, but the MCP host opened a 2025-era connection. Upgrade the host when it supports MCP `2026-07-28`. Until then, no flag is required.

`STRICT_PROTOCOL_REJECTION` means the configuration contains `--legacy reject` but the client still uses the legacy handshake. Remove that pair or change it to `--legacy serve`, restart the client, and upgrade the client before enabling strict mode again.

## Tool and argument changes

| 1.x                        | 2.0                         |
| -------------------------- | --------------------------- |
| `list-available-vaults`    | `obsidian_list_vaults`      |
| `read-note`                | `obsidian_read_note`        |
| `create-note`              | `obsidian_create_note`      |
| `edit-note`                | `obsidian_edit_note`        |
| `delete-note`              | `obsidian_delete_note`      |
| `move-note`                | `obsidian_move_note`        |
| `create-directory`         | `obsidian_create_directory` |
| `search-vault`             | `obsidian_search_vault`     |
| `add-tags`                 | `obsidian_add_tags`         |
| `remove-tags`              | `obsidian_remove_tags`      |
| `rename-tag`               | `obsidian_rename_tag`       |
| unregistered `manage-tags` | `obsidian_manage_tags`      |

The principal payload changes are:

- Note tools use one vault-relative `path` instead of `filename` plus `folder`.
- `edit-note` no longer accepts `operation: "delete"`; use `obsidian_delete_note`.
- Search uses `scope`, `mode`, `case_sensitive`, `limit`, and cursor fields instead of `path`, `searchType`, and `caseSensitive`. Use `mode: "tag"` rather than a `tag:` query prefix.
- Tag operations use `paths` instead of `files`. Former nested `options` fields are flattened and use snake_case, such as `include_children` and `expected_etags`.
- Rename fields are `old_tag` and `new_tag`. Results now include structured content and machine-readable errors.

Old tool names are not advertised as aliases because translating stale mutation payloads could perform an unintended write. Restarting the client lets an agent see and use the new schemas.

## Vault configuration errors

| Code                       | What to fix                                                      |
| -------------------------- | ---------------------------------------------------------------- |
| `INVALID_VAULT_ID`         | Use a lowercase id beginning with a letter, up to 64 characters. |
| `DUPLICATE_VAULT_ID`       | Give each `--vault` a different id.                              |
| `VAULT_PATH_NOT_ABSOLUTE`  | Replace the path with its full absolute path.                    |
| `VAULT_PATH_NOT_FOUND`     | Correct a missing or misspelled directory.                       |
| `VAULT_PATH_NOT_DIRECTORY` | Select the vault directory, not a file.                          |
| `VAULT_NOT_INITIALIZED`    | Open the directory as a vault in Obsidian to create `.obsidian`. |
| `VAULT_PERMISSION_DENIED`  | Grant the MCP client process read and write permission.          |
| `VAULT_ROOTS_OVERLAP`      | Remove duplicate or nested vault roots.                          |

Run `obsidian-mcp doctor` with the same `--vault` arguments after applying the suggested fix.

## Diagnostic reference

Every startup diagnostic has a stable code and five useful parts: `Problem`, `Detected`, `Fix`, optional `Verify`, and `More help`. Diagnostics go to stderr so MCP stdout remains valid JSON-RPC. Usage errors exit with status 2; environment, configuration, and runtime startup failures exit with status 1.

Common CLI codes include `CLI_UNKNOWN_COMMAND`, `CLI_UNKNOWN_OPTION`, `CLI_MISSING_OPTION_VALUE`, `CLI_INVALID_VAULT_ARGUMENT`, `CLI_VAULT_REQUIRED`, and `CLI_MIXED_CONFIG_SYNTAX`. Typo diagnostics suggest the closest command or option. `STARTUP_FAILED` is reserved for unexpected failures; rerun with `--log-level debug` to include a stack trace.

Do not post logs without reviewing them: diagnostics can contain configured filesystem paths. They never include note contents or credentials intentionally.

### Write-lock recovery

Version 2 publishes `.obsidian-mcp/locks/write` only after its `owner.json` is complete. Empty lock directories left by older releases are repaired automatically. A nonempty lock with missing, malformed, symlinked, or otherwise unexpected ownership data is deliberately not deleted because it cannot be distinguished safely from a live writer.

When this fail-closed check blocks startup, stop every `obsidian-mcp` process using the vault and run the exact rename command printed by `serve` or `doctor` from the vault root. Renaming preserves the questionable directory for inspection. Run `doctor` again before restarting the MCP client. Do not recursively delete the lock directory while an MCP process may still be running.

Lock ownership is intended for ordinary local filesystems. PID checks deliberately treat permission errors, recycled PIDs, container-namespace ambiguity, and other unverifiable identities as potentially live; they time out instead of deleting the lock automatically. Use the printed manual recovery procedure only after confirming that every process using the vault has stopped.

## Recovery changes

Version 2 uses `.obsidian-mcp` for transaction journals and MCP trash. It does not automatically modify or delete legacy `.backup` or `.trash` directories. Those directories are excluded from v2 scans and can be archived or removed manually after verifying their contents.

Version 1.x is deprecated, and its tool API receives no compatibility bridge. Upgrade promptly because its vault-containment implementation can permit access outside configured roots.
