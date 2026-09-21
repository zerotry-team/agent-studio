import { z } from "zod";
import { inputSchemaSchema, toolRiskSchema } from "./tools.js";
import { toolNameSchema } from "./common.js";

export const adapterDescriptorSchema = z.object({
  version: z.literal(1),
  connector: z.object({
    key: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    display_name: z.string().min(1).max(100),
    description: z.string().min(1).max(1000),
  }).strict(),
  tools: z.array(z.object({
    name: toolNameSchema,
    description: z.string().min(1).max(1000),
    risk: toolRiskSchema,
    input_schema: inputSchemaSchema,
    output_schema: z.unknown(),
  }).strict()).min(1).max(100),
  execution: z.object({
    kind: z.enum(["http", "mcp"]),
    health_endpoint: z.string().startsWith("/").max(500),
  }).strict(),
  network: z.object({
    outbound_domains: z.array(z.string().min(1).max(253)).max(100),
    private_network_required: z.boolean(),
  }).strict(),
  required_connections: z.array(z.object({
    kind: z.string().regex(/^[a-z0-9_:-]+$/),
    description: z.string().min(1).max(500),
  }).strict()).max(50),
  source: z.object({
    repository: z.string().min(1).max(300),
    merge_commit: z.string().regex(/^[0-9a-f]{40,64}$/),
    build_context: z.string().min(1).max(500),
  }).strict(),
}).strict();
export type AdapterDescriptor = z.infer<typeof adapterDescriptorSchema>;
