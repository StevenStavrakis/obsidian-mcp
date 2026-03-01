import { z } from "zod";
import { SearchResult, SearchOperationResult, SearchOptions } from "../../types.js";
import { promises as fs } from "fs";
import path from "path";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateVaultPath, safeJoinPath, normalizePath } from "../../utils/path.js";
import { getAllMarkdownFiles } from "../../utils/files.js";
import { handleFsError } from "../../utils/errors.js";
import { extractTags, normalizeTag, matchesTagPattern } from "../../utils/tags.js";
import { createToolResponse, formatSearchResult } from "../../utils/responses.js";
import { createTool } from "../../utils/tool-factory.js";

// Input validation schema with descriptions
const schema = z.object({
  vault: z.string()
    .min(1, "Vault name cannot be empty")
    .describe("Name of the vault to search in"),
  query: z.string()
    .min(1, "Search query cannot be empty")
    .describe("Search query (required). For text search use the term directly, for tag search use tag: prefix"),
  path: z.string()
    .optional()
    .describe("Optional subfolder path within the vault to limit search scope"),
  caseSensitive: z.boolean()
    .optional()
    .default(false)
    .describe("Whether to perform case-sensitive search (default: false)"),
  searchType: z.enum(['content', 'filename', 'both'])
    .optional()
    .default('content')
    .describe("Type of search to perform (default: content)")
}).strict();

type SearchVaultInput = z.infer<typeof schema>;

// Helper functions
function isTagSearch(query: string): boolean {
  return query.startsWith('tag:');
}

function normalizeTagQuery(query: string): string {
  // Remove 'tag:' prefix
  return normalizeTag(query.slice(4));
}

async function searchFilenames(
  vaultPath: string,
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  try {
    // Use safeJoinPath for path safety
    const searchDir = options.path ? await safeJoinPath(vaultPath, options.path) : vaultPath;
    const files = await getAllMarkdownFiles(vaultPath, searchDir);
    const results: SearchResult[] = [];
    const searchQuery = options.caseSensitive ? query : query.toLowerCase();

    for (const file of files) {
      const relativePath = path.relative(vaultPath, file);
      const searchTarget = options.caseSensitive ? relativePath : relativePath.toLowerCase();

      if (searchTarget.includes(searchQuery)) {
        results.push({
          file: relativePath,
          matches: [{
            line: 0, // We use 0 to indicate this is a filename match
            text: `Filename match: ${relativePath}`
          }]
        });
      }
    }

    return results;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw handleFsError(error, 'search filenames');
  }
}

async function searchContent(
  vaultPath: string,
  query: string,
  options: SearchOptions
): Promise<SearchResult[]> {
  try {
    // Use safeJoinPath for path safety
    const searchDir = options.path ? await safeJoinPath(vaultPath, options.path) : vaultPath;
    const files = await getAllMarkdownFiles(vaultPath, searchDir);
    const results: SearchResult[] = [];
    const isTagSearchQuery = isTagSearch(query);
    const normalizedTagQuery = isTagSearchQuery ? normalizeTagQuery(query) : '';

    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n");
        const matches: SearchResult["matches"] = [];

        if (isTagSearchQuery) {
          // For tag searches, extract all tags from the content
          const fileTags = extractTags(content);

          lines.forEach((line, index) => {
            // Look for tag matches in each line
            const lineTags = extractTags(line);
            const hasMatchingTag = lineTags.some(tag => {
              const normalizedTag = normalizeTag(tag);
              return normalizedTag === normalizedTagQuery || matchesTagPattern(normalizedTagQuery, normalizedTag);
            });

            if (hasMatchingTag) {
              matches.push({
                line: index + 1,
                text: line.trim()
              });
            }
          });
        } else {
          // Regular text search
          const searchQuery = options.caseSensitive ? query : query.toLowerCase();

          lines.forEach((line, index) => {
            const searchLine = options.caseSensitive ? line : line.toLowerCase();
            if (searchLine.includes(searchQuery)) {
              matches.push({
                line: index + 1,
                text: line.trim()
              });
            }
          });
        }

        if (matches.length > 0) {
          results.push({
            file: path.relative(vaultPath, file),
            matches
          });
        }
      } catch (err) {
        console.error(`Error reading file ${file}:`, err);
        // Continue with other files
      }
    }

    return results;
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw handleFsError(error, 'search content');
  }
}

async function searchVault(
  vaultPath: string,
  query: string,
  options: SearchOptions
): Promise<SearchOperationResult> {
  try {
    // Normalize vault path upfront
    const normalizedVaultPath = normalizePath(vaultPath);
    let results: SearchResult[] = [];
    let errors: string[] = [];

    if (options.searchType === 'filename' || options.searchType === 'both') {
      try {
        const filenameResults = await searchFilenames(normalizedVaultPath, query, options);
        results = results.concat(filenameResults);
      } catch (error) {
        if (error instanceof McpError) {
          errors.push(`Filename search error: ${error.message}`);
        } else {
          errors.push(`Filename search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (options.searchType === 'content' || options.searchType === 'both') {
      try {
        const contentResults = await searchContent(normalizedVaultPath, query, options);
        results = results.concat(contentResults);
      } catch (error) {
        if (error instanceof McpError) {
          errors.push(`Content search error: ${error.message}`);
        } else {
          errors.push(`Content search failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const totalMatches = results.reduce((sum, result) => sum + (result.matches?.length ?? 0), 0);

    // If we have some results but also errors, we'll return partial results with a warning
    if (results.length > 0 && errors.length > 0) {
      return {
        success: true,
        message: `Search completed with warnings:\n${errors.join('\n')}`,
        results,
        totalMatches,
        matchedFiles: results.length
      };
    }

    // If we have no results and errors, throw an error
    if (results.length === 0 && errors.length > 0) {
      throw new McpError(
        ErrorCode.InternalError,
        `Search failed:\n${errors.join('\n')}`
      );
    }

    return {
      success: true,
      message: "Search completed successfully",
      results,
      totalMatches,
      matchedFiles: results.length
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw handleFsError(error, 'search vault');
  }
}

export const createSearchVaultTool = (vaults: Map<string, string>) => {
  return createTool<SearchVaultInput>({
    name: "search-vault",
    description: `Search for specific content within vault notes (NOT for listing available vaults - use the list-vaults prompt for that).

This tool searches through note contents and filenames for specific text or tags:
- Content search: { "vault": "vault1", "query": "hello world", "searchType": "content" }
- Filename search: { "vault": "vault2", "query": "meeting-notes", "searchType": "filename" }
- Search both: { "vault": "vault1", "query": "project", "searchType": "both" }
- Tag search: { "vault": "vault2", "query": "tag:status/active" }
- Search in subfolder: { "vault": "vault1", "query": "hello", "path": "journal/2024" }

Note: To get a list of available vaults, use the list-vaults prompt instead of this search tool.`,
    schema,
    handler: async (args, vaultPath, _vaultName) => {
      const options: SearchOptions = {
        path: args.path,
        caseSensitive: args.caseSensitive,
        searchType: args.searchType
      };
      const result = await searchVault(vaultPath, args.query, options);
      return createToolResponse(formatSearchResult(result));
    }
  }, vaults);
}
