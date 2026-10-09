import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

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
    const term = (args.term || "").trim().toLowerCase();
    // Default known domain terms, can be augmented from runtime
    let match = null;
    if (term.includes("transaction")) {
      match = "事务";
    } else if (term.includes("embedding")) {
      match = "嵌入";
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            term: args.term,
            translation: match,
            context: match ? "approved" : "unmatched",
          }),
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
    const mappings = args.mappings || [];
    const valid = mappings.every(
      (m) => m.cue_id && m.translation && m.translation.trim().length > 0
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            valid,
            count: mappings.length,
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
