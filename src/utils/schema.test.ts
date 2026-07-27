import { describe, expect, it } from "bun:test";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createSchemaHandler } from "./schema.js";

describe("createSchemaHandler", () => {
  it("publishes root discriminated-union properties without weakening runtime validation", () => {
    const schema = z.discriminatedUnion("operation", [
      z.object({
        vault: z.string(),
        filename: z.string(),
        folder: z.string().optional(),
        operation: z.literal("delete"),
        content: z.undefined(),
        unused: z.undefined()
      }).strict(),
      z.object({
        vault: z.string(),
        filename: z.string(),
        folder: z.string().optional(),
        operation: z.enum(["append", "prepend", "replace"]),
        content: z.string().min(1),
        unused: z.undefined()
      }).strict()
    ]);
    const handler = createSchemaHandler(schema);

    expect(Object.keys(handler.jsonSchema.properties)).toEqual([
      "vault",
      "filename",
      "folder",
      "operation",
      "content"
    ]);
    expect(handler.jsonSchema.required).toEqual(["vault", "filename", "operation"]);
    expect(handler.jsonSchema.properties.operation.enum).toEqual([
      "delete",
      "append",
      "prepend",
      "replace"
    ]);
    expect(handler.jsonSchema.properties.content).toEqual({
      type: "string",
      minLength: 1
    });
    expect(handler.jsonSchema.anyOf).toHaveLength(2);
    expect(handler.jsonSchema.anyOf?.[0].properties?.operation).toEqual({
      type: "string",
      const: "delete"
    });
    expect(handler.jsonSchema.anyOf?.[0].properties?.content).toEqual({ not: {} });
    expect(handler.jsonSchema.anyOf?.[1].required).toContain("content");

    expect(handler.parse({ vault: "notes", filename: "todo.md", operation: "delete" })).toEqual({
      vault: "notes",
      filename: "todo.md",
      operation: "delete"
    });
    expect(handler.parse({
      vault: "notes",
      filename: "todo.md",
      operation: "append",
      content: "next"
    })).toEqual({
      vault: "notes",
      filename: "todo.md",
      operation: "append",
      content: "next"
    });
    expect(() => handler.parse({
      vault: "notes",
      filename: "todo.md",
      operation: "append"
    })).toThrow(McpError);
    expect(() => handler.parse({
      vault: "notes",
      filename: "todo.md",
      operation: "delete",
      content: "not allowed"
    })).toThrow(McpError);
  });

  it("preserves ordinary object schemas", () => {
    const handler = createSchemaHandler(z.object({
      vault: z.string(),
      limit: z.number().optional()
    }));

    expect(handler.jsonSchema).toEqual({
      type: "object",
      properties: {
        vault: { type: "string" },
        limit: { type: "number" }
      },
      required: ["vault"]
    });
  });
});
