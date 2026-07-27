import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const convertToJsonSchema = zodToJsonSchema as unknown as (
  schema: z.ZodTypeAny
) => unknown;

type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  not?: JsonSchema;
  description?: string;
  minLength?: number;
};

type McpInputSchema = {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

function isImpossibleSchema(schema: JsonSchema): boolean {
  return schema.not !== undefined && Object.keys(schema.not).length === 0;
}

function mergePropertySchemas(schemas: JsonSchema[]): JsonSchema | undefined {
  const usableSchemas = schemas.filter(schema => !isImpossibleSchema(schema));
  const uniqueSchemas = Array.from(
    new Map(usableSchemas.map(schema => [JSON.stringify(schema), schema])).values()
  );

  if (uniqueSchemas.length === 0) {
    return undefined;
  }

  if (uniqueSchemas.length === 1) {
    return uniqueSchemas[0];
  }

  const types = new Set(uniqueSchemas.map(schema => schema.type));
  const enumValues = uniqueSchemas.flatMap(schema => {
    if (schema.const !== undefined) {
      return [schema.const];
    }
    return schema.enum || [];
  });

  const allSchemasHaveEnumeratedValues = uniqueSchemas.every(schema =>
    schema.const !== undefined || (schema.enum?.length || 0) > 0
  );

  if (types.size === 1 && !types.has(undefined) && allSchemasHaveEnumeratedValues) {
    const mergedSchema: JsonSchema = {
      type: uniqueSchemas[0].type,
      enum: Array.from(new Set(enumValues))
    };
    const descriptions = Array.from(new Set(
      uniqueSchemas
        .map(schema => schema.description)
        .filter((description): description is string => description !== undefined)
    ));
    return descriptions.length === 1
      ? { ...mergedSchema, description: descriptions[0] }
      : mergedSchema;
  }

  return { anyOf: uniqueSchemas };
}

// Some MCP clients prune arguments using only top-level properties. Add that
// discovery view without dropping the original composition constraints; the
// original Zod schema below remains the authoritative runtime validator.
function flattenObjectComposition(schema: JsonSchema): McpInputSchema {
  const composition = {
    ...(schema.anyOf ? { anyOf: schema.anyOf } : {}),
    ...(schema.oneOf ? { oneOf: schema.oneOf } : {})
  };

  if (schema.properties) {
    return {
      type: "object",
      properties: schema.properties,
      required: schema.required || [],
      ...composition
    };
  }

  const branches = schema.anyOf || schema.oneOf || [];
  const objectBranches = branches.filter(branch => branch.properties !== undefined);
  const propertyNames = Array.from(
    new Set(objectBranches.flatMap(branch => Object.keys(branch.properties || {})))
  );
  const required = objectBranches.length === 0
    ? []
    : objectBranches
      .map(branch => new Set(branch.required || []))
      .reduce((intersection, branchRequired) =>
        new Set(Array.from(intersection).filter(name => branchRequired.has(name)))
      );

  return {
    type: "object",
    properties: Object.fromEntries(propertyNames.flatMap(name => {
      const mergedSchema = mergePropertySchemas(
        objectBranches
          .map(branch => branch.properties?.[name])
          .filter((property): property is JsonSchema => property !== undefined)
      );
      return mergedSchema ? [[name, mergedSchema]] : [];
    })),
    required: Array.from(required),
    ...composition
  };
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
export function createSchemaHandler<T>(schema: z.ZodSchema<T>) {
  return {
    // Convert to JSON Schema for MCP interface
    jsonSchema: flattenObjectComposition(
      convertToJsonSchema(schema as unknown as z.ZodTypeAny) as JsonSchema
    ),
    
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
