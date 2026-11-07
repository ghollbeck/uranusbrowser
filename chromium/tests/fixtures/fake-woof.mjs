// A stand-in for OpenWhisper's llm_mlx_server.py: the same JSON-line protocol, no model.
// Prompts steer it: "HANG" never answers, "FAIL" answers with an error, "ENV" echoes the environment's names.
import readline from 'node:readline';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
process.stderr.write('[woof] loaded (fake) with a secret-looking line: sk-should-never-be-kept\n');
out({ status: 'ready', model: 'fake' });
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.cmd === 'quit') process.exit(0);
  const prompt = (request.messages ?? []).map((m) => m.content).join('\n');
  if (prompt.includes('HANG')) return;
  if (prompt.includes('FAIL')) return out({ id: request.id, error: 'boom with transcript text: private words' });
  if (prompt.includes('ENV')) return out({ id: request.id, text: JSON.stringify(Object.keys(process.env).sort()), finish_reason: 'stop', completion_tokens: 1, duration_ms: 1 });
  // Structured requests are answered by the shape asked for: the grounded selection (ids only) or a title.
  const props = request.json_schema?.properties ?? {};
  const structured = props.overview ? { overview: [1], decisions: [1], action_items: [], open_questions: [] } : props.title ? { title: 'Monday release' } : {};
  const answer = request.json_schema ? JSON.stringify(structured) : 'plain answer';
  out({ id: request.id, text: answer, finish_reason: 'stop', completion_tokens: 3, duration_ms: 5 });
});
