import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";

const Header: FC = () => (
  <div class="hdr">
    <div class="brand">
      <a
        href="/"
        style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;"
      >
        <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
        GitFlare
      </a>
    </div>
  </div>
);

/** A styled 404 page rendered through the normal layout, with a way back. */
export const NotFound: FC<{
  title: string;
  detail: string;
  backHref?: string;
  backLabel?: string;
}> = ({ title, detail, backHref, backLabel }) => (
  <Layout title={title}>
    <div class="wrap">
      <Header />
      <h1>{title}</h1>
      <div class="empty" style="margin-top: 24px;">
        <div>{detail}</div>
        <div style="margin-top: 16px;">
          <a href={backHref ?? "/"}>{backLabel ?? "← Back to mirrors"}</a>
        </div>
      </div>
    </div>
  </Layout>
);

/** A styled 500 page — surfaces the underlying message instead of bare text. */
export const ErrorView: FC<{ detail: string; backHref?: string }> = ({
  detail,
  backHref,
}) => (
  <Layout title="Error">
    <div class="wrap">
      <Header />
      <h1>Something went wrong</h1>
      <div class="card" style="margin-top: 24px;">
        <span class="pill err">error</span>
        <pre style="margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--muted);">
          {detail}
        </pre>
        <div style="margin-top: 16px;">
          <a href={backHref ?? "/"}>← Back to mirrors</a>
        </div>
      </div>
    </div>
  </Layout>
);
