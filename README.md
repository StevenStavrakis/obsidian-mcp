# Obsidian MCP Server

[![smithery badge](https://smithery.ai/badge/obsidian-mcp)](https://smithery.ai/server/obsidian-mcp)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that enables AI assistants to interact with Obsidian vaults, providing tools for reading, creating, editing and managing notes and tags.

## Warning!!!

This MCP has read and write access (if you allow it). Please. PLEASE backup your Obsidian vault prior to using obsidian-mcp to manage your notes. I recommend using git, but any backup method will work. These tools have been tested, but not thoroughly, and this MCP is in active development.

## Features

- Read and search notes in your vault
- Create new notes and directories
- Edit existing notes
- Move and delete notes
- Manage tags (add, remove, rename)
- Search vault contents

## Requirements

- Node.js 20 or higher (might work on lower, but I haven't tested it)
- An Obsidian vault

## Install

### Installing via Smithery

To install Obsidian for Claude Desktop automatically via [Smithery](https://smithery.ai/server/obsidian-mcp):

```bash
npx -y @smithery/cli install obsidian-mcp --client claude
```

### Installing Manually
Add to your Claude Desktop configuration:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
    "mcpServers": {
        "obsidian": {
            "command": "npx",
            "args": ["-y", "obsidian-mcp", "/path/to/your/vault"]
        }
    }
}
```

Replace `/path/to/your/vault` with the absolute path to your Obsidian vault. For example:

MacOS/Linux:
```json
"/Users/username/Documents/MyVault"
```

Windows:
```json
"C:\\Users\\username\\Documents\\MyVault"
```

Restart Claude for Desktop after saving the configuration. You should see the hammer icon appear, indicating the server is connected.

If you have connection issues, check the logs at:
- MacOS: `~/Library/Logs/Claude/mcp*.log`
- Windows: `%APPDATA%\Claude\logs\mcp*.log`

## Development

```bash
# Clone the repository
git clone https://github.com/StevenStavrakis/obsidian-mcp
cd obsidian-mcp

# Install dependencies
npm install

# Build
npm run build
```
Then add to your Claude Desktop configuration:

```json
{
    "mcpServers": {
        "obsidian": {
            "command": "node",
            "args": ["<absolute-path-to-obsidian-mcp>/build/main.js", "/path/to/your/vault"]
        }
    }
}
```

## Available Tools

- `read-note` - Read the contents of a note
- `create-note` - Create a new note
- `edit-note` - Edit an existing note
- `delete-note` - Delete a note
- `move-note` - Move a note to a different location
- `create-directory` - Create a new directory
- `search-vault` - Search notes in the vault
- `add-tags` - Add tags to a note
- `remove-tags` - Remove tags from a note
- `rename-tag` - Rename a tag across all notes
- `manage-tags` - List and organize tags

## Documentation

Additional documentation can be found in the `docs` directory:
- `creating-tools.md` - Guide for creating new tools
- `tool-examples.md` - Examples of using the available tools

## Security

This server requires access to your Obsidian vault directory. When configuring the server, make sure to:
- Only provide access to your intended vault directory
- Review tool actions before approving them

## Troubleshooting

Common issues:

1. **Server not showing up in Claude Desktop**
   - Verify your configuration file syntax
   - Make sure the vault path is absolute and exists
   - Restart Claude Desktop

2. **Permission errors**
   - Ensure the vault path is readable/writable
   - Check file permissions in your vault

3. **Tool execution failures**
   - Check Claude Desktop logs at:
     - macOS: `~/Library/Logs/Claude/mcp*.log`
     - Windows: `%APPDATA%\Claude\logs\mcp*.log`

## License

MIT
