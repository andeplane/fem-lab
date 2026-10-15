import katex from 'katex';
import 'katex/dist/katex.min.css';

/** Only KaTeX's own output becomes HTML. Prose and code remain escaped Preact text. */
function inline(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\$[^$\n]+\$)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{inline(part.slice(2, -2))}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={i}>{inline(part.slice(1, -1))}</em>;
    if (part.startsWith('$') && part.endsWith('$')) return <span key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(1, -1), { throwOnError: false }) }} />;
    return part;
  });
}

/** The shared theory vocabulary: paragraphs, bullet lists, inline styling and TeX. */
export function TheoryText({ text }: { text: string }) {
  return <div class="theory-copy">
    {text.split(/(\$\$[\s\S]*?\$\$)/g).flatMap((part, i) => {
      if (part.startsWith('$$') && part.endsWith('$$')) {
        return [<div key={i} dangerouslySetInnerHTML={{ __html: katex.renderToString(part.slice(2, -2), { displayMode: true, throwOnError: false }) }} />];
      }
      return part.trim().split(/\n\s*\n/).flatMap((paragraph, j) => {
        if (!paragraph) return [];
        // Consecutive list items form one list, even when prose shares the same paragraph.
        const groups: { list: boolean; lines: string[] }[] = [];
        for (const line of paragraph.split('\n')) {
          const list = line.startsWith('- ');
          const last = groups.at(-1);
          if (last?.list === list) last.lines.push(line);
          else groups.push({ list, lines: [line] });
        }
        return groups.map(({ list, lines }, k) => list
          ? <ul key={`${i}-${j}-${k}`}>{lines.map((line, n) => <li key={n}>{inline(line.slice(2))}</li>)}</ul>
          : <p key={`${i}-${j}-${k}`}>{inline(lines.join(' '))}</p>);
      });
    })}
  </div>;
}
