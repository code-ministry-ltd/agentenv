import Markdown from 'react-markdown';

interface SafeLink {
  href: string;
  external: boolean;
}

function safeLink(href: string | undefined): SafeLink | undefined {
  if (href === undefined || href === '') return undefined;
  if (href.startsWith('#')) return { href, external: false };
  try {
    const url = new URL(href);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return { href: url.href, external: true };
    }
  } catch {
    // Relative and malformed URLs are deliberately non-navigable in the local UI.
  }
  return undefined;
}

function safeUrl(url: string, key: string): string {
  if (key === 'src') return '';
  return safeLink(url)?.href ?? '';
}

/** Render untrusted skill Markdown without raw HTML, remote assets, or unsafe URLs. */
export function SafeMarkdown({ source }: { source: string }): React.JSX.Element {
  return (
    <div aria-label="Rendered skill document preview" className="safe-markdown">
      <Markdown
        components={{
          a({ children, href }) {
            const link = safeLink(href);
            return link === undefined ? (
              <span className="unsafe-markdown-link">{children}</span>
            ) : (
              <a
                href={link.href}
                {...(link.external
                  ? { rel: 'noopener noreferrer', target: '_blank' }
                  : {})}
              >
                {children}
              </a>
            );
          },
          img({ alt }) {
            return (
              <span className="markdown-image-placeholder">
                {alt === undefined || alt === '' ? 'Image omitted' : `Image omitted: ${alt}`}
              </span>
            );
          },
        }}
        urlTransform={safeUrl}
      >
        {source}
      </Markdown>
    </div>
  );
}
