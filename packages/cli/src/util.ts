export const orange = (s: string): string =>
  `\x1b[38;2;243;128;32m${s}\x1b[0m`;

export function parseGithubUrl(input: string): { owner: string; repo: string } {
  // Accepts: github.com/owner/repo, https://github.com/owner/repo, owner/repo, git@github.com:owner/repo.git
  const cleaned = input
    .replace(/^https?:\/\//, "")
    .replace(/^git@github\.com:/, "github.com/")
    .replace(/\.git$/, "")
    .replace(/^github\.com\//, "");
  const parts = cleaned.split("/");
  if (parts.length < 2) {
    throw new Error(`Could not parse GitHub URL: ${input}`);
  }
  return { owner: parts[0]!, repo: parts[1]! };
}

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

export function artifactsRepoNameFor(owner: string, repo: string): string {
  // Artifacts repo names must be alphanumeric + dashes. Map "/" to "--".
  return `${owner}--${repo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}
