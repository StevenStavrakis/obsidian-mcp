import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath } from "../../utils/path.js";
import { fileExists, safeReadFile } from "../../utils/files.js";
import {
  validateTag,
  parseNote,
  stringifyNote,
  removeTagsFromFrontmatter,
  removeInlineTags
} from "../../utils/tags.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault containing the notes"),
  files: z.array(z.string())
    .min(1, "At least one file must be specified")
    .refine(
      files => files.every(f => f.endsWith('.md')),
      "All files must have .md extension"
    )
    .describe("Array of note filenames to process (must have .md extension)"),
  tags: z.array(z.string())
    .min(1, "At least one tag must be specified")
    .refine(
      tags => tags.every(tag => /^[a-zA-Z0-9\/]+$/.test(tag)),
      "Tags must contain only letters, numbers, and forward slashes. Do not include the # symbol. Examples: 'project', 'work/active', 'tasks/2024/q1'"
    )
    .describe("Array of tags to remove (without # symbol). Example: ['project', 'work/active']"),
  options: z.object({
    location: z.enum(['frontmatter', 'content', 'both'])
      .default('both')
      .describe("Where to remove tags from (default: both)"),
    normalize: z.boolean()
      .default(true)
      .describe("Whether to normalize tag format (e.g., ProjectActive -> project-active) (default: true)"),
    preserveChildren: z.boolean()
      .default(false)
      .describe("Whether to preserve child tags when removing parent tags (default: false)"),
    patterns: z.array(z.string())
      .default([])
      .describe("Tag patterns to match for removal (supports * wildcard) (default: [])")
  }).default({
    location: 'both',
    normalize: true,
    preserveChildren: false,
    patterns: []
  })
});

interface RemoveTagsReport {
  success: string[];
  errors: { file: string; error: string }[];
  details: {
    [filename: string]: {
      removedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
      preservedTags: Array<{
        tag: string;
        location: 'frontmatter' | 'content';
        line?: number;
        context?: string;
      }>;
    };
  };
}

type RemoveTagsInput = z.infer<typeof schema>;

async function removeTags(
  vaultPath: string,
  params: Omit<RemoveTagsInput, 'vault'>
): Promise<RemoveTagsReport> {
  const results: RemoveTagsReport = {
    success: [],
    errors: [],
    details: {}
  };

  for (const filename of params.files) {
    const fullPath = path.join(vaultPath, filename);
    
    try {
      // Validate path is within vault
      await validateVaultPath(vaultPath, fullPath);
      
      // Check if file exists
      if (!await fileExists(fullPath)) {
        results.errors.push({
          file: filename,
          error: "File not found"
        });
        continue;
      }

      // Read file content
      const content = await safeReadFile(fullPath);
      if (!content) {
        results.errors.push({
          file: filename,
          error: "Failed to read file"
        });
        continue;
      }

      // Parse the note
      const parsed = parseNote(content);
      let modified = false;
      results.details[filename] = {
        removedTags: [],
        preservedTags: []
      };

      // Handle frontmatter tags
      if (params.options.location !== 'content') {
        const { frontmatter: updatedFrontmatter, report } = removeTagsFromFrontmatter(
          parsed.frontmatter,
          params.tags,
          {
            normalize: params.options.normalize,
            preserveChildren: params.options.preserveChildren,
            patterns: params.options.patterns
          }
        );
        
        results.details[filename].removedTags.push(...report.removed);
        results.details[filename].preservedTags.push(...report.preserved);
        
        if (JSON.stringify(parsed.frontmatter) !== JSON.stringify(updatedFrontmatter)) {
          parsed.frontmatter = updatedFrontmatter;
          modified = true;
        }
      }

      // Handle inline tags
      if (params.options.location !== 'frontmatter') {
        const { content: newContent, report } = removeInlineTags(
          parsed.content,
          params.tags,
          {
            normalize: params.options.normalize,
            preserveChildren: params.options.preserveChildren,
            patterns: params.options.patterns
          }
        );
        
        results.details[filename].removedTags.push(...report.removed);
        results.details[filename].preservedTags.push(...report.preserved);
        
        if (parsed.content !== newContent) {
          parsed.content = newContent;
          modified = true;
        }
      }

      // Save changes if modified
      if (modified) {
        const updatedContent = stringifyNote(parsed);
        await fs.writeFile(fullPath, updatedContent);
        results.success.push(filename);
      }
    } catch (error) {
      results.errors.push({
        file: filename,
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  return results;
}

export function createRemoveTagsTool(vaults: Map<string, string>) {
  return createTool<RemoveTagsInput>({
    name: "remove-tags",
    description: `Remove tags from notes in frontmatter and/or content.

Examples:
- Simple: { "files": ["note.md"], "tags": ["project", "status"] }
- With hierarchy: { "files": ["note.md"], "tags": ["work/active", "priority/high"] }
- With options: { "files": ["note.md"], "tags": ["status"], "options": { "location": "frontmatter" } }
- Pattern matching: { "files": ["note.md"], "options": { "patterns": ["status/*"] } }
- INCORRECT: { "tags": ["#project"] } (don't include # symbol)`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const results = await removeTags(vaultPath, {
        files: args.files,
        tags: args.tags,
        options: args.options
      });
        
      // Format detailed response message
      let message = '';
      
      // Add success summary
      if (results.success.length > 0) {
        message += `Successfully processed tags in: ${results.success.join(', ')}\n\n`;
      }
      
      // Add detailed changes for each file
      for (const [filename, details] of Object.entries(results.details)) {
        if (details.removedTags.length > 0 || details.preservedTags.length > 0) {
          message += `Changes in ${filename}:\n`;
          
          if (details.removedTags.length > 0) {
            message += '  Removed tags:\n';
            const byLocation = details.removedTags.reduce((acc, change) => {
              if (!acc[change.location]) acc[change.location] = new Map();
              const key = change.line ? `${change.location} (line ${change.line})` : change.location;
              const locationMap = acc[change.location];
              if (locationMap) {
                if (!locationMap.has(key)) {
                  locationMap.set(key, new Set());
                }
                const tagSet = locationMap.get(key);
                if (tagSet) {
                  tagSet.add(change.tag);
                }
              }
              return acc;
            }, {} as Record<string, Map<string, Set<string>>>);
            
            for (const [location, locationMap] of Object.entries(byLocation)) {
              for (const [key, tags] of locationMap.entries()) {
                message += `    ${key}: ${Array.from(tags).join(', ')}\n`;
              }
            }
          }
          
          if (details.preservedTags.length > 0) {
            message += '  Preserved tags:\n';
            const byLocation = details.preservedTags.reduce((acc, change) => {
              if (!acc[change.location]) acc[change.location] = new Map();
              const key = change.line ? `${change.location} (line ${change.line})` : change.location;
              const locationMap = acc[change.location];
              if (locationMap) {
                if (!locationMap.has(key)) {
                  locationMap.set(key, new Set());
                }
                const tagSet = locationMap.get(key);
                if (tagSet) {
                  tagSet.add(change.tag);
                }
              }
              return acc;
            }, {} as Record<string, Map<string, Set<string>>>);
            
            for (const [location, locationMap] of Object.entries(byLocation)) {
              for (const [key, tags] of locationMap.entries()) {
                message += `    ${key}: ${Array.from(tags).join(', ')}\n`;
              }
            }
          }
          
          message += '\n';
        }
      }
      
      // Add errors if any
      if (results.errors.length > 0) {
        message += 'Errors:\n';
        results.errors.forEach(error => {
          message += `  ${error.file}: ${error.error}\n`;
        });
      }

      return {
        content: [{
          type: "text",
          text: message.trim()
        }]
      };
    }
  }, vaults);
}
