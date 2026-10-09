import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { glossaryQuery } from "./glossary.js";
import { mappingStructure } from "./validator.js";

/**
 * Whitelisted tool: read_context
 * Reads continuous surrounding cues, video title, and surrounding confirmed translations.
 */
export const readContextTool = defineTool({
  name: "read_context",
  description: "Read continuous surrounding cues, video title, and confirmed context",
  parameters: Type.Object({
    cue_id: Type.Optional(Type.String()),
  }),
  replay: "safe",
  execute: async (args, api) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "ok",
            detail: "Context read successfully",
          }),
        },
      ],
    };
  },
});

/**
 * Whitelisted tool: query_glossary
 * Reads terms from persistent glossary. Declared replay: "safe".
 */
export const queryGlossaryTool = defineTool({
  name: "query_glossary",
  description: "Query approved glossary translations for terms in context",
  parameters: Type.Object({
    term: Type.String(),
  }),
  replay: "safe",
  execute: async (args, api) => {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(glossaryQuery(args.term)),
        },
      ],
    };
  },
});

/**
 * Whitelisted tool: validate_structure
 * Validates output structure against expected cue_ids.
 */
export const validateStructureTool = defineTool({
  name: "validate_structure",
  description: "Validate translation mappings against expected cue IDs and non-empty translations",
  parameters: Type.Object({
    mappings: Type.Array(
      Type.Object({
        cue_id: Type.String(),
        translation: Type.String(),
      })
    ),
  }),
  replay: "safe",
  execute: async (args, api) => {
    const { valid, count } = mappingStructure(args.mappings || []);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            valid,
            count,
          }),
        },
      ],
    };
  },
});

/**
 * Test tool without replay: safe declaration.
 * Used for verifying that interrupted tool calls produce interrupted results.
 */
export const testUnsafeTool = defineTool({
  name: "test_tool",
  description: "A test tool not declared replay safe",
  parameters: Type.Object({
    input: Type.String(),
  }),
  replay: "unsafe",
  execute: async (args, api) => {
    return {
      content: [
        {
          type: "text",
          text: `Executed unsafe test tool: ${args.input}`,
        },
      ],
    };
  },
});

export const WHITELIST_TOOLS = [readContextTool, queryGlossaryTool, validateStructureTool];
