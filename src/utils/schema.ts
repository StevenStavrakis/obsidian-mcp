import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => cloneValue(item)) as T;
  }

  if (isPlainObject(value)) {
    const cloned: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) {
      cloned[key] = cloneValue(item);
    }
    return cloned as T;
  }

  return value;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }

  return value === undefined ? "undefined" : JSON.stringify(value);
}

function normalizeEnumSchema(schema: Record<string, any>): Record<string, any> {
  const normalized = cloneValue(schema);
  if ("const" in normalized && normalized.enum === undefined) {
    normalized.enum = [normalized.const];
    delete normalized.const;
  }
  return normalized;
}

function splitSchemaMetadata(schema: Record<string, any>): {
  comparable: Record<string, any>;
  metadata: Record<string, any>;
} {
  const comparable = cloneValue(schema);
  const metadata: Record<string, any> = {};

  for (const key of ["description", "markdownDescription", "title"]) {
    if (key in comparable) {
      metadata[key] = comparable[key];
      delete comparable[key];
    }
  }

  return { comparable, metadata };
}

function mergeEnumSchemas(
  existing: Record<string, any>,
  incoming: Record<string, any>
): Record<string, any> | undefined {
  const normalizedExisting = normalizeEnumSchema(existing);
  const normalizedIncoming = normalizeEnumSchema(incoming);

  if (!Array.isArray(normalizedExisting.enum) || !Array.isArray(normalizedIncoming.enum)) {
    return undefined;
  }

  const { enum: existingEnum, ...existingRest } = normalizedExisting;
  const { enum: incomingEnum, ...incomingRest } = normalizedIncoming;
  const existingParts = splitSchemaMetadata(existingRest);
  const incomingParts = splitSchemaMetadata(incomingRest);

  if (stableSerialize(existingParts.comparable) !== stableSerialize(incomingParts.comparable)) {
    return undefined;
  }

  const merged: Record<string, any> = {
    ...existingParts.comparable,
    enum: [...new Set([...existingEnum, ...incomingEnum])]
  };

  for (const key of ["description", "markdownDescription", "title"]) {
    if (existingParts.metadata[key] && existingParts.metadata[key] === incomingParts.metadata[key]) {
      merged[key] = existingParts.metadata[key];
    }
  }

  return merged;
}

function mergeSchemaAlternatives(existing: any, incoming: any): any {
  const collectAlternatives = (schema: any): any[] => {
    if (isPlainObject(schema) && Array.isArray(schema.anyOf) && Object.keys(schema).length === 1) {
      return schema.anyOf.map(option => cloneValue(option));
    }
    return [cloneValue(schema)];
  };

  const seen = new Set<string>();
  const merged = [...collectAlternatives(existing), ...collectAlternatives(incoming)].filter(schema => {
    const signature = stableSerialize(schema);
    if (seen.has(signature)) {
      return false;
    }
    seen.add(signature);
    return true;
  });

  return merged.length === 1 ? merged[0] : { anyOf: merged };
}

function mergePropertySchemas(existing: any, incoming: any): any {
  const normalizedExisting = isPlainObject(existing) ? normalizeEnumSchema(existing) : cloneValue(existing);
  const normalizedIncoming = isPlainObject(incoming) ? normalizeEnumSchema(incoming) : cloneValue(incoming);

  if (stableSerialize(normalizedExisting) === stableSerialize(normalizedIncoming)) {
    return normalizedExisting;
  }

  if (isPlainObject(normalizedExisting) && isPlainObject(normalizedIncoming)) {
    const mergedEnum = mergeEnumSchemas(normalizedExisting, normalizedIncoming);
    if (mergedEnum) {
      return mergedEnum;
    }
  }

  // Fall back to property-level anyOf when variants disagree on shape.
  return mergeSchemaAlternatives(normalizedExisting, normalizedIncoming);
}

function convertZodToJsonSchema(schema: z.ZodTypeAny): Record<string, any> {
  return (zodToJsonSchema as any)(schema);
}

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
export function createSchemaHandler<T>(schema: z.ZodSchema<T>): {
  jsonSchema: Record<string, any>;
  parse: (input: unknown) => T;
} {
  return {
    // Convert to JSON Schema for MCP interface
    jsonSchema: (() => {
      const fullSchema = convertZodToJsonSchema(schema as z.ZodTypeAny);

      // Handle discriminated unions (anyOf/oneOf) by flattening variants
      const variants = fullSchema.anyOf || fullSchema.oneOf;
      if (Array.isArray(variants)) {
        const mergedProperties: Record<string, any> = {};
        const requiredSets: Set<string>[] = [];

        for (const variant of variants) {
          if (variant.properties) {
            for (const [key, value] of Object.entries(variant.properties)) {
              if (mergedProperties[key]) {
                mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value);
              } else {
                mergedProperties[key] = isPlainObject(value)
                  ? normalizeEnumSchema(value)
                  : cloneValue(value);
              }
            }
          }
          requiredSets.push(new Set(variant.required || []));
        }

        // Required = intersection of all variants' required fields
        const required = requiredSets.length > 0
          ? [...requiredSets[0]].filter(field => requiredSets.every(s => s.has(field)))
          : [];

        return {
          // Keep the original union for validators while exposing a flat view for clients
          // that only inspect top-level object properties.
          ...fullSchema,
          type: fullSchema.type || "object",
          properties: mergedProperties,
          required
        };
      }

      // Standard flat schema
      return {
        ...fullSchema,
        type: fullSchema.type || "object",
        properties: fullSchema.properties || {},
        required: fullSchema.required || []
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
