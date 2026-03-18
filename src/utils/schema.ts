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
      return {
        type: fullSchema.type || "object",
        properties: fullSchema.properties || {},
        required: fullSchema.required || [],
        ...(fullSchema.anyOf && { anyOf: fullSchema.anyOf }),
        ...(fullSchema.oneOf && { oneOf: fullSchema.oneOf })
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
