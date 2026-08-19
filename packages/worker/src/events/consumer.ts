import { lookupByArtifactsName, type Env } from "../env";
import { dispatchPush } from "../pipeline/dispatch";
import { parseArtifactsEvent } from "./artifacts";

interface QueueMessage {
  body: unknown;
  ack(): void;
  retry(): void;
}

interface QueueBatch {
  messages: readonly QueueMessage[];
}

/**
 * Queue consumer for Artifacts `pushed` events (M9). Deliberately thin — the
 * consumer has at-least-once delivery, no ordering, and a 15-minute wall
 * clock — so all it does is: parse → RepoDO `/artifacts-push` (classify +
 * record) → dispatch CI/CD if the RepoDO says so → ack. Reverse pushes and
 * retries live in the RepoDO's alarm, not here.
 */
export async function handleQueue(batch: QueueBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      const event = parseArtifactsEvent(msg.body);
      if (!event) {
        msg.ack(); // not ours (or malformed) — never retry
        continue;
      }
      const entry = lookupByArtifactsName(env, event.source.repoName);
      // A subscription is per-repo, but be defensive: only act on repos this
      // Worker mirrors, in the namespace its remote points at.
      if (!entry || !entry.remote.includes(`/git/${event.source.namespace}/`)) {
        msg.ack();
        continue;
      }
      const stub = env.REPO.get(env.REPO.idFromName(entry.name));
      const resp = await stub.fetch("https://repo-do/artifacts-push", {
        method: "POST",
        body: JSON.stringify({
          githubFullName: entry.githubFullName,
          artifactsRepoName: entry.name,
          remote: entry.remote,
          ref: event.payload.ref,
          before: event.payload.before,
          after: event.payload.after,
        }),
      });
      if (!resp.ok) throw new Error(`RepoDO /artifacts-push → ${resp.status}`);
      const verdict = (await resp.json()) as { own: boolean; dispatch: boolean; reason: string };
      if (verdict.dispatch) {
        await dispatchPush(env, {
          githubFullName: entry.githubFullName,
          artifactsRepoName: entry.name,
          remote: entry.remote,
          ref: event.payload.ref,
          sha: event.payload.after,
          mode: "artifacts-push",
          origin: (env.WORKER_URL ?? "").replace(/\/$/, ""),
        });
      }
      msg.ack();
    } catch (err) {
      console.error("artifacts event: retrying after error:", (err as Error).message);
      msg.retry();
    }
  }
}
