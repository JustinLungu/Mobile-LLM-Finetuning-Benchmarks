# spec

Input/output contract shared by every model, platform and test:

- model input: computed facts, memory note, intent, user's reason, recent turns
- model output: `relation`, `assessment`, `decision`, `minutes`, `message`
- memory-note format and size limit
- reason types and the expected behaviour for each

## Files

- [`bench_prompts.json`](bench_prompts.json): the fixed prompts every device runs for speed and memory benchmarks (about 450 tokens each). Draft content, realistic in length and shape.
- [`results.schema.json`](results.schema.json): the format of every benchmark results file, on every platform. Check a file with `uv run eval/validate_results.py <file>`.
- [`results.example.json`](results.example.json): a short example of that format, with invented numbers.
