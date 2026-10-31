/** Local model fixtures must be explicitly trusted, just like deployment providers. */
export function trustModelEndpoint(url: string): () => void {
  const previous = process.env.OPENAI_BASE_URL;
  process.env.OPENAI_BASE_URL = url;
  return () => {
    if (previous === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous;
  };
}
