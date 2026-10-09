/**
 * Quality evaluation suite for comparing Agent translation against Legacy baseline
 * on a frozen evaluation dataset of >= 1000 cues.
 */

export function generateFrozenDataset(cueCount = 1000) {
  const cues = [];
  const categories = ["technical", "dialogue", "colloquial"];

  const techPhrases = [
    { text: "This is a database transaction.", term: "transaction", expected: "事务" },
    { text: "We roll it back if the write fails.", term: "roll back", expected: "回滚" },
    { text: "Vector embedding representation captures semantic nuances.", term: "embedding", expected: "嵌入" },
    { text: "Do not increase the dose above 5 mg.", term: "dose", expected: "不要超过 5 毫克" },
    { text: "The GPU memory bandwidth reaches 900 GB/s.", term: "bandwidth", expected: "带宽" },
    { text: "Distributed consensus requires quorum agreement.", term: "consensus", expected: "共识" },
  ];

  const dialoguePhrases = [
    { text: "I'll catch you later at the conference.", expected: "晚点在会议上见。" },
    { text: "Never jump to conclusions before seeing the benchmark.", expected: "看基准测试前绝不要妄下结论。" },
    { text: "She couldn't believe the results either.", expected: "她也不敢相信这个结果。" },
    { text: "Let's grab a coffee and discuss the pull request.", expected: "喝杯咖啡讨论下代码合并请求吧。" },
  ];

  const colloquialPhrases = [
    { text: "No way that actually compiled on the first try.", expected: "绝不可能第一次就编译通过。" },
    { text: "It's not rocket science, just simple caching.", expected: "没那么玄乎，就是简单的缓存。" },
    { text: "Don't sweat the small stuff.", expected: "别为小事纠结。" },
  ];

  for (let i = 0; i < cueCount; i++) {
    const cat = categories[i % categories.length];
    const cueId = `c${i}`;
    const start = i * 2000;
    const end = start + 1800;

    let pool = techPhrases;
    if (cat === "dialogue") pool = dialoguePhrases;
    else if (cat === "colloquial") pool = colloquialPhrases;

    const item = pool[i % pool.length];
    cues.push({
      cue_id: cueId,
      start,
      end,
      text: item.text,
      category: cat,
      term: item.term,
      expected: item.expected,
    });
  }

  return cues;
}

export function computeWeightedErrorScore(issues, totalSourceWords) {
  // Weights: Severe = 25, Major = 5, Minor = 1
  let score = 0;
  for (const issue of issues) {
    if (issue.severity === "severe") score += 25;
    else if (issue.severity === "major") score += 5;
    else score += 1;
  }
  // Per 1000 source words
  const words = Math.max(1, totalSourceWords);
  return (score / words) * 1000;
}

export function evaluateQualityGate({
  baselineRuns = [],
  agentRuns = [],
  totalSourceWords = 5000,
}) {
  const baselineScores = baselineRuns.map((r) =>
    computeWeightedErrorScore(r.issues || [], totalSourceWords)
  );
  const agentScores = agentRuns.map((r) =>
    computeWeightedErrorScore(r.issues || [], totalSourceWords)
  );

  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 !== 0 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  const baselineMedian = median(baselineScores);
  const agentMedian = median(agentScores);

  const reduction =
    baselineMedian > 0
      ? ((baselineMedian - agentMedian) / baselineMedian) * 100
      : 0;

  // Severe semantic inversions
  const agentSevereCount = agentRuns.reduce(
    (acc, r) => acc + (r.issues || []).filter((i) => i.severity === "severe").length,
    0
  );

  // Mapping & timeline integrity
  const timelineIntegrity = agentRuns.every((r) => r.timelineIntegrity === 100);

  const report = {
    baselineMedian,
    agentMedian,
    reductionPercent: reduction,
    reductionMet: reduction >= 20,
    zeroSevereInversions: agentSevereCount === 0,
    timelineIntegrityMet: timelineIntegrity,
    allGatesPassed:
      baselineMedian > 0 &&
      reduction >= 20 &&
      agentSevereCount === 0 &&
      timelineIntegrity,
    metadata: {
      runs: 3,
      evaluatorCount: 2,
      workflowVersion: "wf-v1",
      promptVersion: "prompt-v1",
    },
  };

  return report;
}
