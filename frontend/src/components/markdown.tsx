// DOINg.MCP — dependency-free Markdown + safe-HTML renderer for the chat.
// Renders to React elements (no dangerouslySetInnerHTML), so model output —
// which may echo database values — can never inject scripts. Supports GFM
// tables, fenced code, lists, headings, blockquotes, inline styles & links,
// plus a whitelisted subset of raw HTML (tables, lists, emphasis…).
import { createElement } from 'react'
import type { ReactNode } from 'react'

const CLS = {
  a: 'text-brand-600 underline underline-offset-2 hover:text-brand-700 dark:text-brand-400',
  code: 'rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] text-brand-700 dark:bg-zinc-800 dark:text-brand-300',
  pre: 'my-1.5 overflow-auto rounded-lg bg-zinc-900 p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100',
  table: 'my-1.5 w-full border-collapse overflow-hidden rounded-md text-[11px]',
  th: 'border border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-semibold dark:border-zinc-700 dark:bg-zinc-800',
  td: 'border border-zinc-200 px-2 py-1 align-top dark:border-zinc-700',
  ul: 'my-1 list-disc space-y-0.5 pl-5',
  ol: 'my-1 list-decimal space-y-0.5 pl-5',
  quote: 'my-1.5 border-l-2 border-zinc-300 pl-3 italic text-zinc-500 dark:border-zinc-600 dark:text-zinc-400',
  h: 'mt-2 mb-1 font-semibold',
  hr: 'my-2 border-zinc-200 dark:border-zinc-700',
}

function safeUrl(url: string): string {
  const u = url.trim()
  return /^(https?:|mailto:|#|\/)/i.test(u) ? u : '#'
}

// ---------------------------------------------------------------- Inline

const INLINE: { name: string; re: RegExp }[] = [
  { name: 'code', re: /`([^`]+?)`/ },
  { name: 'bold', re: /\*\*([\s\S]+?)\*\*/ },
  { name: 'boldu', re: /__([\s\S]+?)__/ },
  { name: 'strike', re: /~~([\s\S]+?)~~/ },
  { name: 'italic', re: /\*([^*\n]+?)\*/ },
  { name: 'italicu', re: /(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/ },
  { name: 'link', re: /\[([^\]]+?)\]\(([^)\s]+?)\)/ },
  { name: 'autolink', re: /(https?:\/\/[^\s)]+)/ },
]

function inline(text: string, key: string): ReactNode[] {
  if (!text) return []
  let best: { idx: number; name: string; m: RegExpExecArray } | null = null
  for (const p of INLINE) {
    const m = p.re.exec(text)
    if (m && (best === null || m.index < best.idx)) best = { idx: m.index, name: p.name, m }
  }
  if (!best) return [text]
  const { m, name } = best
  const before = text.slice(0, m.index)
  const after = text.slice(m.index + m[0].length)
  const k = `${key}_${m.index}`
  let node: ReactNode
  if (name === 'code') node = <code key={k} className={CLS.code}>{m[1]}</code>
  else if (name === 'bold' || name === 'boldu') node = <strong key={k}>{inline(m[1], k)}</strong>
  else if (name === 'italic' || name === 'italicu') node = <em key={k}>{inline(m[1], k)}</em>
  else if (name === 'strike') node = <del key={k}>{inline(m[1], k)}</del>
  else if (name === 'link') node = <a key={k} className={CLS.a} href={safeUrl(m[2])} target="_blank" rel="noopener noreferrer">{inline(m[1], k)}</a>
  else node = <a key={k} className={CLS.a} href={safeUrl(m[1])} target="_blank" rel="noopener noreferrer">{m[1]}</a>
  return [...inline(before, `${key}b`), node, ...inline(after, `${key}a`)]
}

// ---------------------------------------------------------------- Safe HTML subset

const HTML_CLS: Record<string, string> = {
  a: CLS.a, code: CLS.code, pre: CLS.pre, table: CLS.table, th: CLS.th, td: CLS.td,
  ul: CLS.ul, ol: CLS.ol, blockquote: CLS.quote, hr: CLS.hr,
  strong: 'font-semibold', b: 'font-semibold', em: 'italic', i: 'italic',
  u: 'underline', s: 'line-through', del: 'line-through', small: 'text-[10px]',
  h1: `${CLS.h} text-sm`, h2: `${CLS.h} text-[13px]`, h3: `${CLS.h} text-xs`,
  h4: `${CLS.h} text-xs`, h5: `${CLS.h} text-xs`, h6: `${CLS.h} text-xs`,
}
const HTML_OK = new Set([
  ...Object.keys(HTML_CLS), 'p', 'br', 'span', 'div', 'thead', 'tbody', 'tr', 'li',
])
const VOID_TAGS = new Set(['br', 'hr'])

function htmlNode(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent
  if (node.nodeType !== Node.ELEMENT_NODE) return null
  const el = node as Element
  const tag = el.tagName.toLowerCase()
  if (tag === 'script' || tag === 'style') return null
  const children = Array.from(el.childNodes).map((c, i) => htmlNode(c, `${key}_${i}`))
  if (!HTML_OK.has(tag)) return <span key={key}>{children}</span>  // unwrap unknown tags
  const props: Record<string, unknown> = { key, className: HTML_CLS[tag] }
  if (VOID_TAGS.has(tag)) return createElement(tag, props)
  if (tag === 'a') {
    props.href = safeUrl(el.getAttribute('href') ?? '')
    props.target = '_blank'
    props.rel = 'noopener noreferrer'
  }
  return createElement(tag, props, children.length ? children : undefined)
}

function renderHtml(html: string, key: string): ReactNode {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return <div key={key}>{Array.from(doc.body.childNodes).map((n, i) => htmlNode(n, `${key}_${i}`))}</div>
}

// ---------------------------------------------------------------- Block parser

const HTML_BLOCK = /^<(table|ul|ol|pre|blockquote|h[1-6]|div|p)\b/i

function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: ReactNode[] = []
  let i = 0
  const key = () => `mdb${out.length}`

  const isDelim = (s: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s) && s.includes('-')

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // Fenced code
    const fence = /^```(\w*)\s*$/.exec(line.trim())
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) buf.push(lines[i++])
      i++  // closing fence
      out.push(<pre key={key()} className={CLS.pre}><code>{buf.join('\n')}</code></pre>)
      continue
    }

    // Raw HTML block (whitelisted on render)
    if (HTML_BLOCK.test(line.trim())) {
      const tag = /^<(\w+)/.exec(line.trim())![1].toLowerCase()
      const openRe = new RegExp(`<${tag}\\b`, 'gi')
      const closeRe = new RegExp(`</${tag}>`, 'gi')
      const buf: string[] = []
      let depth = 0
      do {
        const l = lines[i]
        buf.push(l)
        depth += (l.match(openRe)?.length ?? 0) - (l.match(closeRe)?.length ?? 0)
        i++
      } while (i < lines.length && depth > 0)
      out.push(renderHtml(buf.join('\n'), key()))
      continue
    }

    // Heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      const level = h[1].length
      const size = level <= 1 ? 'text-sm' : level === 2 ? 'text-[13px]' : 'text-xs'
      out.push(createElement(`h${level}`, { key: key(), className: `${CLS.h} ${size}` }, inline(h[2], key())))
      i++
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      out.push(<hr key={key()} className={CLS.hr} />)
      i++
      continue
    }

    // Table
    if (line.includes('|') && i + 1 < lines.length && isDelim(lines[i + 1])) {
      const cells = (s: string) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim())
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]))
      out.push(
        <table key={key()} className={CLS.table}>
          <thead><tr>{header.map((c, j) => <th key={j} className={CLS.th}>{inline(c, `h${j}`)}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{header.map((_, ci) => <td key={ci} className={CLS.td}>{inline(r[ci] ?? '', `c${ri}_${ci}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(<blockquote key={key()} className={CLS.quote}>{inline(buf.join(' '), key())}</blockquote>)
      continue
    }

    // Lists
    const listM = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line)
    if (listM) {
      const ordered = /\d/.test(listM[2])
      const items: ReactNode[] = []
      while (i < lines.length) {
        const im = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i])
        if (!im) break
        items.push(<li key={i}>{inline(im[3], `li${i}`)}</li>)
        i++
      }
      out.push(createElement(ordered ? 'ol' : 'ul', { key: key(), className: ordered ? CLS.ol : CLS.ul }, items))
      continue
    }

    // Paragraph (collect consecutive plain lines; single newlines -> <br>)
    const para: string[] = []
    while (i < lines.length && lines[i].trim()
           && !/^```/.test(lines[i].trim()) && !HTML_BLOCK.test(lines[i].trim())
           && !/^(#{1,6})\s/.test(lines[i]) && !/^>\s?/.test(lines[i])
           && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i])
           && !(lines[i].includes('|') && i + 1 < lines.length && isDelim(lines[i + 1]))) {
      para.push(lines[i++])
    }
    const parts: ReactNode[] = []
    para.forEach((p, idx) => {
      if (idx > 0) parts.push(<br key={`br${idx}`} />)
      parts.push(...inline(p, `p${out.length}_${idx}`))
    })
    out.push(<p key={key()}>{parts}</p>)
  }
  return out
}

export function Markdown({ content }: { content: string }) {
  return <div className="space-y-1 break-words text-xs leading-relaxed">{parseBlocks(content)}</div>
}
