import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { createSchemaHandler } from "../src/utils/schema.js";

// ---- Helpers ----
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string, detail?: any) {
  if (condition) {
    console.log(`  PASS: ${message}`);
    passed++;
  } else {
    console.error(`  FAIL: ${message}`);
    if (detail !== undefined) console.error("    Got:", JSON.stringify(detail, null, 2));
    failed++;
  }
}

function getSchemaAlternatives(schema: any): any[] {
  if (Array.isArray(schema?.anyOf)) return schema.anyOf;
  if (Array.isArray(schema?.oneOf)) return schema.oneOf;
  return schema ? [schema] : [];
}

// ---- Test 1: zodToJsonSchema produces correct output for simple schemas ----
console.log("\n=== Test 1: Simple z.object() ===");
{
  const schema = z.object({
    name: z.string().describe("The name"),
    age: z.number().optional(),
  });
  const result = zodToJsonSchema(schema) as Record<string, any>;
  console.log("  Output:", JSON.stringify(result, null, 2));

  assert(result.type === "object", "type is 'object'");
  assert(!!result.properties?.name, "has 'name' property");
  assert(result.properties?.name?.type === "string", "name is string");
  assert(!!result.properties?.age, "has 'age' property");
}

// ---- Test 2: zodToJsonSchema for discriminated union ----
console.log("\n=== Test 2: z.discriminatedUnion() ===");
{
  const variantA = z.object({
    type: z.literal("a"),
    value: z.string(),
  });
  const variantB = z.object({
    type: z.literal("b"),
    count: z.number(),
  });
  const union = z.discriminatedUnion("type", [variantA, variantB]);
  const result = zodToJsonSchema(union) as Record<string, any>;
  console.log("  Output:", JSON.stringify(result, null, 2));

  const hasAnyOf = Array.isArray(result.anyOf);
  const hasOneOf = Array.isArray(result.oneOf);
  assert(hasAnyOf || hasOneOf, "has anyOf or oneOf");

  if (hasAnyOf || hasOneOf) {
    const variants = result.anyOf || result.oneOf;
    assert(variants.length === 2, "has 2 variants");

    // Check if variants are inline or $ref
    const firstVariant = variants[0];
    const isInline = !!firstVariant.properties;
    const isRef = !!firstVariant.$ref;
    console.log(`  Variant format: ${isInline ? "inline" : isRef ? "$ref" : "unknown"}`);
    console.log("  First variant:", JSON.stringify(firstVariant));
  }
}

// ---- Test 3: Real edit-note schema (matches the actual tool) ----
console.log("\n=== Test 3: edit-note discriminated union ===");
{
  const deleteSchema = z.object({
    vault: z.string().min(1).describe("Vault name"),
    filename: z.string().min(1).describe("Filename"),
    folder: z.string().optional().describe("Folder"),
    operation: z.literal("delete").describe("Delete operation"),
    content: z.undefined().describe("No content"),
  }).strict();

  const editSchema = z.object({
    vault: z.string().min(1).describe("Vault name"),
    filename: z.string().min(1).describe("Filename"),
    folder: z.string().optional().describe("Folder"),
    operation: z
      .enum(["append", "prepend", "replace"])
      .describe("Edit op")
      .refine((op) => ["append", "prepend", "replace"].includes(op)),
    content: z.string().min(1).describe("Content"),
  }).strict();

  const schema = z.discriminatedUnion("operation", [deleteSchema, editSchema]);
  const result = zodToJsonSchema(schema) as Record<string, any>;
  console.log("  Output:", JSON.stringify(result, null, 2));
  console.log("  Top-level keys:", Object.keys(result));

  // Check what we actually got — this tells us what we need to handle
  assert(Object.keys(result).length > 1, "result is not empty (more than just $schema)");
}

// ---- Test 4: zodToJsonSchema with different $refStrategy ----
console.log("\n=== Test 4: $refStrategy options ===");
{
  const variantA = z.object({ type: z.literal("a"), value: z.string() });
  const variantB = z.object({ type: z.literal("b"), count: z.number() });
  const union = z.discriminatedUnion("type", [variantA, variantB]);

  for (const strategy of ["none", "root", "relative", "seen"] as const) {
    try {
      const result = zodToJsonSchema(union, { $refStrategy: strategy }) as Record<string, any>;
      console.log(`  ${strategy}: keys=${Object.keys(result).join(",")}`);
      if (result.anyOf || result.oneOf) {
        const variants = result.anyOf || result.oneOf;
        console.log(`    variants[0] keys: ${Object.keys(variants[0]).join(",")}`);
      }
    } catch (e: any) {
      console.log(`  ${strategy}: ERROR - ${e.message}`);
    }
  }
}

// ---- Test 5: Manual Zod introspection (alternative approach) ----
console.log("\n=== Test 5: Direct Zod introspection ===");
{
  const deleteSchema = z.object({
    vault: z.string(),
    operation: z.literal("delete"),
  });
  const editSchema = z.object({
    vault: z.string(),
    operation: z.enum(["append", "prepend", "replace"]),
    content: z.string(),
  });
  const union = z.discriminatedUnion("operation", [deleteSchema, editSchema]);

  // Inspect the Zod internal structure
  const def = (union as any)._def || (union as any)._zod;
  console.log("  Union def keys:", def ? Object.keys(def) : "no _def");

  if (def?.options) {
    console.log("  Number of options:", def.options.length);
    for (let i = 0; i < def.options.length; i++) {
      const opt = def.options[i];
      const optDef = (opt as any)._def || (opt as any)._zod;
      console.log(`  Option ${i} def keys:`, optDef ? Object.keys(optDef) : "no _def");
      if (optDef?.shape) {
        const shape = typeof optDef.shape === "function" ? optDef.shape() : optDef.shape;
        console.log(`  Option ${i} shape keys:`, Object.keys(shape));
      }
    }
  }

  // Try converting individual variants
  console.log("\n  Converting variants individually:");
  const delResult = zodToJsonSchema(deleteSchema) as Record<string, any>;
  const editResult = zodToJsonSchema(editSchema) as Record<string, any>;
  console.log("  deleteSchema:", JSON.stringify(delResult));
  console.log("  editSchema:", JSON.stringify(editResult));
}

// ---- Test 6: createSchemaHandler with simple schema ----
console.log("\n=== Test 6: createSchemaHandler with simple z.object() ===");
{
  const schema = z.object({
    vault: z.string().describe("Vault name"),
    filename: z.string().describe("Filename"),
  });
  const handler = createSchemaHandler(schema);
  const jsonSchema = handler.jsonSchema;
  console.log("  jsonSchema:", JSON.stringify(jsonSchema, null, 2));

  assert(jsonSchema.type === "object", "type is object");
  assert(!!jsonSchema.properties?.vault, "has vault property");
  assert(!!jsonSchema.properties?.filename, "has filename property");
}

// ---- Test 7: createSchemaHandler with discriminated union ----
console.log("\n=== Test 7: createSchemaHandler with discriminated union ===");
{
  const variantA = z.object({
    type: z.literal("a"),
    value: z.string(),
  });
  const variantB = z.object({
    type: z.literal("b"),
    count: z.number(),
  });
  const union = z.discriminatedUnion("type", [variantA, variantB]);
  const handler = createSchemaHandler(union);
  const jsonSchema = handler.jsonSchema;
  console.log("  jsonSchema:", JSON.stringify(jsonSchema, null, 2));

  assert(jsonSchema.type === "object", "type is object");
  assert(!!jsonSchema.properties?.type, "has 'type' property");
  assert(Array.isArray(jsonSchema.anyOf) && jsonSchema.anyOf.length === 2, "keeps anyOf variants");
  assert(
    Array.isArray(jsonSchema.properties?.type?.enum) &&
    jsonSchema.properties.type.enum.includes("a") &&
    jsonSchema.properties.type.enum.includes("b"),
    "type enum has both 'a' and 'b'",
    jsonSchema.properties?.type
  );
}

// ---- Test 8: createSchemaHandler with REAL edit-note schema ----
console.log("\n=== Test 8: createSchemaHandler with real edit-note schema ===");
{
  const deleteSchema = z.object({
    vault: z.string().min(1).describe("Vault name"),
    filename: z.string().min(1).describe("Filename"),
    folder: z.string().optional().describe("Folder"),
    operation: z.literal("delete").describe("Delete operation"),
    content: z.undefined().describe("No content for delete"),
  }).strict();

  const editSchema = z.object({
    vault: z.string().min(1).describe("Vault name"),
    filename: z.string().min(1).describe("Filename"),
    folder: z.string().optional().describe("Folder"),
    operation: z.enum(["append", "prepend", "replace"])
      .describe("Edit op")
      .refine((op) => ["append", "prepend", "replace"].includes(op)),
    content: z.string().min(1).describe("Content"),
  }).strict();

  const schema = z.discriminatedUnion("operation", [deleteSchema, editSchema]);
  const handler = createSchemaHandler(schema);
  const jsonSchema = handler.jsonSchema;
  console.log("  jsonSchema:", JSON.stringify(jsonSchema, null, 2));

  // Critical assertions
  assert(jsonSchema.type === "object", "type is object", jsonSchema.type);
  assert(!!jsonSchema.properties?.vault, "has vault property");
  assert(!!jsonSchema.properties?.filename, "has filename property");
  assert(!!jsonSchema.properties?.operation, "has operation property");
  assert(Array.isArray(jsonSchema.anyOf) && jsonSchema.anyOf.length === 2, "keeps anyOf variants", jsonSchema.anyOf);

  const opEnum = jsonSchema.properties?.operation?.enum;
  assert(
    Array.isArray(opEnum) && opEnum.length === 4,
    "operation enum has 4 values",
    opEnum
  );
  assert(
    Array.isArray(opEnum) &&
    opEnum.includes("delete") &&
    opEnum.includes("append") &&
    opEnum.includes("prepend") &&
    opEnum.includes("replace"),
    "operation enum contains all 4 operations",
    opEnum
  );

  const contentSchema = jsonSchema.properties?.content;
  assert(!!contentSchema, "has content property");
  const contentAlternatives = getSchemaAlternatives(contentSchema);
  assert(
    contentAlternatives.some((variant) => variant?.type === "string"),
    "content schema allows string for edit operations",
    contentSchema
  );
  assert(
    contentAlternatives.some((variant) => variant?.not && Object.keys(variant.not).length === 0),
    "content schema preserves delete-only branch",
    contentSchema
  );

  // Required should be intersection: vault, filename, operation (content is not required in delete)
  const req = jsonSchema.required || [];
  assert(req.includes("vault"), "vault is required", req);
  assert(req.includes("filename"), "filename is required", req);
  assert(req.includes("operation"), "operation is required", req);
  assert(!req.includes("content"), "content is NOT required (optional in delete variant)", req);

  // Test parse with append
  console.log("\n  Testing parse...");
  try {
    const result = handler.parse({
      vault: "test",
      filename: "test.md",
      operation: "append",
      content: "hello world",
    });
    console.log("  PASS: parse append succeeded");
    passed++;
  } catch (e: any) {
    console.error("  FAIL: parse append failed:", e.message);
    failed++;
  }

  // Test parse with delete
  try {
    const result = handler.parse({
      vault: "test",
      filename: "test.md",
      operation: "delete",
    });
    console.log("  PASS: parse delete succeeded");
    passed++;
  } catch (e: any) {
    console.error("  FAIL: parse delete failed:", e.message);
    failed++;
  }
}

// ---- Test 9: Shared field with conflicting types across variants ----
console.log("\n=== Test 9: shared field with conflicting types ===");
{
  const variantA = z.object({
    type: z.literal("a"),
    payload: z.string(),
  });
  const variantB = z.object({
    type: z.literal("b"),
    payload: z.number(),
  });

  const handler = createSchemaHandler(z.discriminatedUnion("type", [variantA, variantB]));
  const payloadSchema = handler.jsonSchema.properties?.payload;
  const payloadAlternatives = getSchemaAlternatives(payloadSchema);

  assert(!!payloadSchema, "has payload property");
  assert(
    payloadAlternatives.some((variant) => variant?.type === "string"),
    "payload schema keeps string variant",
    payloadSchema
  );
  assert(
    payloadAlternatives.some((variant) => variant?.type === "number"),
    "payload schema keeps number variant",
    payloadSchema
  );
}

// ---- Summary ----
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
