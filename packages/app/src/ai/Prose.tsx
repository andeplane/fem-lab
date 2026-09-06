import type { ComponentChildren } from 'preact';

/** A small, HTML-free prose renderer. Provider text is always escaped by Preact. */
function inline(text: string): ComponentChildren {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function Prose({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n');
  const blocks: ComponentChildren[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i++]!;
    if (!line.trim()) continue;
    if (/^```/.test(line)) {
      const code: string[] = [];
      while (i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push(<pre><code>{code.join('\n')}</code></pre>);
    } else if (/^#{1,6} /.test(line)) {
      blocks.push(<p class="prose-heading">{inline(line.replace(/^#{1,6} /, ''))}</p>);
    } else if (/^\s*(?:[-*] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const pattern = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
      const items = [line];
      while (i < lines.length && pattern.test(lines[i]!)) items.push(lines[i++]!);
      const children = items.map(item => <li>{inline(item.replace(pattern, ''))}</li>);
      blocks.push(ordered ? <ol>{children}</ol> : <ul>{children}</ul>);
    } else {
      const paragraph = [line];
      while (i < lines.length && lines[i]!.trim() && !/^(?:```|#{1,6} |\s*(?:[-*] |\d+\. ))/.test(lines[i]!)) paragraph.push(lines[i++]!);
      blocks.push(<p>{inline(paragraph.join('\n'))}</p>);
    }
  }
  return <div class={`prose${streaming ? ' streaming' : ''}`}>{blocks}</div>;
}

/** Keep large binary outputs out of the transcript without changing what the model receives. */
export function toolDisplay(value = ''): string {
  const display = value.replace(/data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g, '[image data]');
  return display.slice(0, 12000) + (display.length > 12000 ? '\n… (display truncated)' : '');
}
