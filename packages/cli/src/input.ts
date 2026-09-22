import { createInterface } from "node:readline";
import { CliError } from "./api.js";

/** `--key value` / `--flag` / 位置引数 を素朴に分ける */
export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = argv[index + 1];
    if (inline !== undefined) flags[name!] = inline;
    else if (next !== undefined && !next.startsWith("--")) {
      flags[name!] = next;
      index += 1;
    } else flags[name!] = true;
  }
  return { positional, flags };
}

export function flagString(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireFlag(flags: Record<string, string | true>, name: string, hint: string): string {
  const value = flagString(flags, name);
  if (!value) throw new CliError(`--${name} を指定してください（${hint}）`);
  return value;
}

/**
 * 秘密の値を安全に受け取る。引数には渡さず、`--<name>-stdin`（標準入力）か `--<name>-env VAR`（環境変数）だけ。
 * どちらも無ければ、端末で非表示入力する。
 */
export async function readSecret(flags: Record<string, string | true>, name: string, label: string): Promise<string> {
  const envName = flagString(flags, `${name}-env`);
  if (envName) {
    const value = process.env[envName]?.trim();
    if (!value) throw new CliError(`環境変数 ${envName} が空です`);
    return value;
  }
  if (flags[`${name}-stdin`] === true || !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks).toString("utf8").trim();
    if (!value) throw new CliError("標準入力から値を読めませんでした（例: `echo \"$TOKEN\" | agent-studio connect notion --secret-stdin`）");
    return value;
  }
  return promptHidden(`${label}（入力は表示されません）: `);
}

export function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer.trim());
  }));
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const output = process.stdout;
    let muted = false;
    const original = (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text: string) => {
      if (!muted) original.call(rl, text);
    };
    rl.question(question, (answer) => {
      output.write("\n");
      rl.close();
      if (!answer.trim()) reject(new CliError("値が空です"));
      else resolve(answer.trim());
    });
    muted = true;
  });
}
