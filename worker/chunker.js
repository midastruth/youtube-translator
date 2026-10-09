/**
 * Estimates token count for a text or cue.
 */
export function estimateTokens(text = "") {
  // Conservative estimate: ~1.5 tokens per char for mixed CJK/Latin
  return Math.max(1, Math.ceil(text.length * 1.5));
}

/**
 * Partitions cues into continuous chunks that fit within the model context budget,
 * providing surrounding context without duplicate output.
 *
 * @param {Array} cues - Full list of source cues
 * @param {Object} options - Token budget options
 * @returns {Array} List of block definitions
 */
export function partitionCuesIntoBlocks(
  cues = [],
  {
    contextWindow = 4096,
    reserveOutputTokens = 1024,
    reservePromptTokens = 512,
    maxCuesPerBlock = 10,
  } = {}
) {
  if (!cues || cues.length === 0) return [];

  const availableInputTokens = Math.max(
    500,
    contextWindow - reserveOutputTokens - reservePromptTokens
  );

  const blocks = [];
  let currentBlockCues = [];
  let currentTokens = 0;

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    const cueTokens = estimateTokens(cue.text);

    if (
      currentBlockCues.length > 0 &&
      (currentTokens + cueTokens > availableInputTokens ||
        currentBlockCues.length >= maxCuesPerBlock)
    ) {
      blocks.push({
        blockIndex: blocks.length,
        cues: currentBlockCues,
      });
      currentBlockCues = [];
      currentTokens = 0;
    }

    currentBlockCues.push(cue);
    currentTokens += cueTokens;
  }

  if (currentBlockCues.length > 0) {
    blocks.push({
      blockIndex: blocks.length,
      cues: currentBlockCues,
    });
  }

  // Ensure ALL source cues belong to exactly one publish block (partition completeness)
  let assignedCount = 0;
  for (const b of blocks) {
    assignedCount += b.cues.length;
  }
  if (assignedCount !== cues.length) {
    throw new Error(
      `Partition error: assigned ${assignedCount} cues but expected ${cues.length}`
    );
  }

  // Now attach continuous contextBefore and contextAfter within budget
  return blocks.map((block, idx) => {
    const startIndex = cues.indexOf(block.cues[0]);
    const endIndex = cues.indexOf(block.cues[block.cues.length - 1]);

    const blockTokens = block.cues.reduce((acc, c) => acc + estimateTokens(c.text), 0);
    let remainingBudget = Math.max(0, availableInputTokens - blockTokens);

    // Collect contextBefore
    const contextBefore = [];
    let bIdx = startIndex - 1;
    while (bIdx >= 0 && remainingBudget > 0) {
      const c = cues[bIdx];
      const tok = estimateTokens(c.text);
      if (tok > remainingBudget) break;
      contextBefore.unshift(c);
      remainingBudget -= tok;
      bIdx--;
    }

    // Collect contextAfter
    const contextAfter = [];
    let aIdx = endIndex + 1;
    while (aIdx < cues.length && remainingBudget > 0) {
      const c = cues[aIdx];
      const tok = estimateTokens(c.text);
      if (tok > remainingBudget) break;
      contextAfter.push(c);
      remainingBudget -= tok;
      aIdx++;
    }

    return {
      blockIndex: idx,
      cues: block.cues,
      contextBefore,
      contextAfter,
      totalCuesInBlock: block.cues.length,
      isLastBlock: idx === blocks.length - 1,
    };
  });
}
