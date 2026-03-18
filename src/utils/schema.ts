import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

/**
 * Converts a JSON Schema object to a Zod schema
 */
function jsonSchemaToZod(schema: {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}): z.ZodSchema {
  const requiredFields = new Set(schema.required || []);
  const properties: Record<string, z.ZodTypeAny> = {};
  
  for (const [key, value] of Object.entries(schema.properties)) {
    let fieldSchema: z.ZodTypeAny;
    
    switch (value.type) {
      case 'string':
        fieldSchema = value.enum ? z.enum(value.enum) : z.string();
        break;
      case 'number':
        fieldSchema = z.number();
        break;
      case 'boolean':
        fieldSchema = z.boolean();
        break;
      case 'array':
        if (value.items.type === 'string') {
          fieldSchema = z.array(z.string());
        } else {
          fieldSchema = z.array(z.unknown());
        }
        break;
      case 'object':
        if (value.properties) {
          fieldSchema = jsonSchemaToZod(value);
        } else {
          fieldSchema = z.record(z.unknown());
        }
        break;
      default:
        fieldSchema = z.unknown();
    }

    // Add description if present
    if (value.description) {
      fieldSchema = fieldSchema.describe(value.description);
    }

    // Make field optional if it's not required
    properties[key] = requiredFields.has(key) ? fieldSchema : fieldSchema.optional();
  }
  
  return z.object(properties);
}

/**
 * Creates a tool schema handler from an existing JSON Schema
 */
export function createSchemaHandlerFromJson<T = any>(jsonSchema: {
  type: string;
  properties: Record<string, any>;
  required?: string[];
}) {
  const zodSchema = jsonSchemaToZod(jsonSchema);
  return createSchemaHandler(zodSchema);
}

/**
 * Flattens anyOf/oneOf union variants into a single merged object schema.
 * Required because the Claude API does not support anyOf/oneOf at the top level
 * of a tool input_schema. Properties are unioned across variants; a property is
 * marked required only if it appears in every variant's required list.
 */
function flattenUnionSchema(variants: any[]): { type: string; properties: Record<string, any>; required: string[] } {
  const allProperties: Record<string, any> = {};
  let requiredInAll: Set<string> | null = null;

  for (const variant of variants) {
    const props: Record<string, any> = variant.properties || {};
    const required = new Set<string>(variant.required || []);

    for (const [key, value] of Object.entries(props)) {
      const v = value as any;
      // Skip impossible/undefined fields (z.undefined() → { not: {} })
      const isUndefinedType = v.not !== undefined && Object.keys(v.not).length === 0;
      if (isUndefinedType) continue;

      if (!allProperties[key]) {
        // First time seeing this property — normalise const → enum for easier merging
        allProperties[key] = v.const !== undefined ? { type: "string", enum: [v.const], description: v.description } : { ...v };
      } else {
        // Merge enum/const values from subsequent variants
        const existing = allProperties[key];
        const incomingValues: any[] = v.const !== undefined ? [v.const] : (v.enum ?? []);
        const existingValues: any[] = existing.enum ?? [];
        const merged = [...new Set([...existingValues, ...incomingValues])];
        if (merged.length > 0) {
          allProperties[key] = { ...existing, enum: merged };
          delete allProperties[key].const;
        }
      }
    }

    if (requiredInAll === null) {
      requiredInAll = new Set(required);
    } else {
      for (const r of [...requiredInAll]) {
        if (!required.has(r)) requiredInAll.delete(r);
      }
    }
  }

  return {
    type: "object",
    properties: allProperties,
    required: requiredInAll ? [...requiredInAll] : [],
  };
}

/**
 * Creates a tool schema handler that manages both JSON Schema for MCP and Zod validation
 */
export function createSchemaHandler<T>(schema: z.ZodSchema<T>) {
  return {
    // Convert to JSON Schema for MCP interface
    jsonSchema: (() => {
      const fullSchema = zodToJsonSchema(schema) as {
        type?: string;
        properties?: Record<string, any>;
        required?: string[];
        anyOf?: any[];
        oneOf?: any[];
      };
      const variants = fullSchema.anyOf || fullSchema.oneOf;
      const flat = variants ? flattenUnionSchema(variants) : fullSchema;
      return {
        type: flat.type || "object",
        properties: (flat as any).properties || {},
        required: (flat as any).required || [],
      };
    })(),
    
    // Validate and parse input
    parse: (input: unknown): T => {
      try {
        return schema.parse(input);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
          );
        }
        throw error;
      }
    }
  };
}
