// Draft Cards — the desktop half.
//
// Registers the `::draft-card{id="d_…" v="N"}` transcript directive. The agent's
// `draft_card` tool stores the draft and hands back that line; this file draws
// it as a card: recipients, subject and body, with every revision's changed
// words highlighted, inline editing, and an approval-first Send.
//
// Loaded uncompiled by the Hermes desktop app: plain ESM, no JSX, and only
// `@hermes/plugin-sdk` + `react` imports.

import * as sdk from '@hermes/plugin-sdk'
import * as React from 'react'

const { host, useQuery, queryClient, TRANSCRIPT_DIRECTIVE_AREA, Button, Tip } = sdk
const { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } = sdk
const icons = sdk.icons || {}
const haptic = typeof sdk.haptic === 'function' ? sdk.haptic : () => {}
const h = React.createElement
const { useCallback, useEffect, useMemo, useRef, useState } = React

const PLUGIN_ID = 'draft-cards'
const ID_RE = /^d_[0-9a-f]{8}$/
const FRESH_SECONDS = 90 // only animate highlights for versions this new — never on transcript replay
const APPROVAL_WAIT_MS = 3 * 60 * 1000
const BODY_CLAMP_LINES = 16

/** Set in register(); the directive renders only while the plugin is loaded. */
let CTX = null

// ─────────────────────────────────────────────────────────────── data

const draftKey = id => [PLUGIN_ID, 'draft', id]

function rest(path, opts) {
  if (!CTX) return Promise.reject(new Error('Draft Cards is not loaded'))
  return CTX.rest(path, opts)
}

function errorText(error) {
  const raw = String(error?.message || error || 'Something went wrong')
  // hermesApi errors carry the backend's JSON body; surface its `detail` when present.
  const match = raw.match(/"detail"\s*:\s*"([^"]+)"/)
  return (match ? match[1] : raw).replace(/^Error:\s*/, '').slice(0, 220)
}

function isMissing(error) {
  return /\b(404|not found|no draft)\b/i.test(String(error?.message || ''))
}

function useDraft(id) {
  return useQuery({
    queryKey: draftKey(id),
    queryFn: () => rest(`/drafts/${id}`),
    enabled: ID_RE.test(id),
    staleTime: 4_000,
    refetchOnWindowFocus: true,
    retry: (count, error) => count < 2 && !isMissing(error),
    // Poll only while the agent owes us an answer (approval → sent/failed). The
    // gateway event usually lands first; polling is the fallback for remotes.
    refetchInterval: query => {
      const data = query?.state?.data
      if (!data || data.status !== 'approved') return false
      return Date.now() - data.status_at * 1000 < 10 * 60 * 1000 ? 2_500 : false
    }
  })
}

function publish(record) {
  if (record?.id) queryClient.setQueryData(draftKey(record.id), record)
  return record
}

// ─────────────────────────────────────────────────────────────── diff

// Words, runs of whitespace, and single punctuation marks, so "11 AM." → "2 PM."
// highlights "2 PM" and leaves the full stop alone.
function tokenize(text) {
  return String(text || '').match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu) || []
}

function pushOp(ops, t, s) {
  if (!s) return
  const last = ops[ops.length - 1]
  if (last && last.t === t) last.s += s
  else ops.push({ t, s })
}

/** LCS diff of two token arrays into `ops`. Common prefix/suffix are trimmed
 *  first; a middle larger than `cap` cells degrades to one replacement. */
function lcsInto(ops, a, b, cap) {
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
  }
  if (start) pushOp(ops, 'eq', a.slice(0, start).join(''))
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  const n = midA.length
  const m = midB.length
  if (n * m > cap) {
    pushOp(ops, 'del', midA.join(''))
    pushOp(ops, 'add', midB.join(''))
  } else if (n || m) {
    const width = m + 1
    const table = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] =
          midA[i] === midB[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        pushOp(ops, 'eq', midA[i])
        i++
        j++
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        pushOp(ops, 'del', midA[i++])
      } else {
        pushOp(ops, 'add', midB[j++])
      }
    }
    while (i < n) pushOp(ops, 'del', midA[i++])
    while (j < m) pushOp(ops, 'add', midB[j++])
  }
  if (endA < a.length) pushOp(ops, 'eq', a.slice(endA).join(''))
  return ops
}

const splitLines = text => String(text || '').match(/[^\n]*\n|[^\n]+$/g) || []

/** Word diff → [{ t: 'eq' | 'add' | 'del', s }]. Lines first, then words inside
 *  each changed block, so a long email stays precise and the work stays small. */
function diffText(before, after) {
  const lineOps = lcsInto([], splitLines(before), splitLines(after), 400_000)
  const ops = []
  for (let k = 0; k < lineOps.length; k++) {
    const op = lineOps[k]
    if (op.t === 'eq') {
      pushOp(ops, 'eq', op.s)
      continue
    }
    // A changed block is a del and/or an add of whole lines: refine it word by word.
    let removed = ''
    let added = ''
    while (k < lineOps.length && lineOps[k].t !== 'eq') {
      if (lineOps[k].t === 'del') removed += lineOps[k].s
      else added += lineOps[k].s
      k++
    }
    k--
    for (const piece of lcsInto([], tokenize(removed), tokenize(added), 1_500_000)) pushOp(ops, piece.t, piece.s)
  }
  return smooth(ops)
}

/** Fold the single spaces between two changes into the change, so "push it to"
 *  reads as one highlight instead of three, and order each cluster del → add. */
function smooth(ops) {
  const out = []
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k]
    const prev = out[out.length - 1]
    const next = ops[k + 1]
    if (op.t === 'eq' && /^[ \t]+$/.test(op.s) && prev && prev.t !== 'eq' && next && next.t !== 'eq') {
      // Belongs to both sides of the edit.
      const lastAdd = [...out].reverse().find(o => o.t === 'add')
      const lastDel = [...out].reverse().find(o => o.t === 'del')
      if (lastAdd) lastAdd.s += op.s
      if (lastDel) lastDel.s += op.s
      continue
    }
    if (prev && prev.t === op.t) {
      prev.s += op.s
      continue
    }
    // A cluster interleaved add/del/add → merge into one del + one add.
    if (op.t !== 'eq' && prev && prev.t !== 'eq') {
      const pair = out[out.length - 2]
      if (pair && pair.t === op.t) {
        pair.s += op.s
        continue
      }
    }
    out.push({ ...op })
  }
  // Emit deletions before insertions inside a cluster.
  for (let k = 1; k < out.length; k++) {
    if (out[k].t === 'del' && out[k - 1].t === 'add') {
      const tmp = out[k]
      out[k] = out[k - 1]
      out[k - 1] = tmp
    }
  }
  return slide(out)
}

/** An insertion like ". Bring the flows" before an unchanged "." is the same edit
 *  as " Bring the flows." — slide it right so the highlight starts on a word. */
function slide(ops) {
  for (let k = 1; k < ops.length - 1; k++) {
    const op = ops[k]
    const prev = ops[k - 1]
    const next = ops[k + 1]
    if (op.t === 'eq' || prev.t !== 'eq' || next.t !== 'eq') continue
    let guard = 0
    while (op.s && next.s && op.s[0] === next.s[0] && /[^\s\p{L}\p{N}]/u.test(op.s[0]) && guard++ < 8) {
      prev.s += op.s[0]
      op.s = op.s.slice(1) + op.s[0]
      next.s = next.s.slice(1)
    }
  }
  return ops.filter(op => op.s)
}

function countChanges(ops) {
  let count = 0
  let inChange = false
  for (const op of ops) {
    if (op.t === 'eq') inChange = false
    else if (!inChange) {
      inChange = true
      count++
    }
  }
  return count
}

function diffList(before = [], after = []) {
  const prev = new Set(before.map(s => s.toLowerCase()))
  const next = new Set(after.map(s => s.toLowerCase()))
  return [
    ...after.map(s => ({ s, t: prev.has(s.toLowerCase()) ? 'eq' : 'add' })),
    ...before.filter(s => !next.has(s.toLowerCase())).map(s => ({ s, t: 'del' }))
  ]
}

// ─────────────────────────────────────────────────────────────── formatting

function parseAddress(raw) {
  const text = String(raw || '').trim()
  const match = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (match && match[1].trim()) return { name: match[1].trim(), address: match[2].trim() }
  if (match) return { name: '', address: match[2].trim() }
  return { name: '', address: text }
}

function addressOnly(raw) {
  return parseAddress(raw).address
}

function timeLabel(seconds) {
  if (!seconds) return ''
  const date = new Date(seconds * 1000)
  const sameDay = new Date().toDateString() === date.toDateString()
  return sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function kindLabel(record) {
  const noun = record.platform || (record.kind === 'email' ? 'Email' : 'Message')
  // Once it went out, it isn't a draft any more.
  return record.status === 'sent' || record.status === 'saved' ? noun : `${noun} draft`
}

function plainText(record, fields) {
  const lines = []
  if (fields.subject) lines.push(`Subject: ${fields.subject}`)
  if (fields.to?.length) lines.push(`To: ${fields.to.join(', ')}`)
  if (fields.cc?.length) lines.push(`Cc: ${fields.cc.join(', ')}`)
  if (lines.length) lines.push('')
  lines.push(fields.body || '')
  return lines.join('\n')
}

function mailtoUrl(fields) {
  const params = []
  const add = (key, value) => value && params.push(`${key}=${encodeURIComponent(value)}`)
  add('cc', (fields.cc || []).map(addressOnly).join(','))
  add('bcc', (fields.bcc || []).map(addressOnly).join(','))
  add('subject', fields.subject)
  add('body', (fields.body || '').slice(0, 8000))
  const to = (fields.to || []).map(addressOnly).map(encodeURIComponent).join(',')
  return `mailto:${to}${params.length ? `?${params.join('&')}` : ''}`
}

function approvalPrompt(record, version) {
  const f = version.fields
  const to = (f.to || []).map(addressOnly).join(', ')
  const what = f.subject ? `"${f.subject}"` : 'the message'
  const target = to ? ` to ${to}` : ''
  return `Approved: send ${what}${target}. (Draft ${record.id}, version ${version.v}, approved on the draft card.)`
}

function savePrompt(record, version) {
  const where = record.platform ? `${record.platform} drafts` : 'drafts folder'
  return `Save draft ${record.id} (version ${version.v}) to my ${where}. Don't send it.`
}

// ─────────────────────────────────────────────────────────────── icons

function Icon({ name, className, size = 14 }) {
  const Glyph = icons[name]
  if (!Glyph) return null
  return h(Glyph, { 'aria-hidden': true, className: cx('hdc-icon', className), size, stroke: 1.75 })
}

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

// ─────────────────────────────────────────────────────────────── pieces

function DiffText({ ops, showRemoved }) {
  let index = 0
  return ops.map((op, k) => {
    if (op.t === 'eq') return op.s
    if (op.t === 'del') {
      if (!showRemoved) return null
      // Removed text stays inline: a deleted paragraph break must not open an empty struck line.
      const struck = op.s.replace(/\s+/g, ' ').trim()
      if (!struck) return null
      return h('del', { className: 'hdc-del', key: k }, struck)
    }
    // Leading/trailing whitespace stays outside the highlight so marks hug words.
    const lead = op.s.match(/^\s*/)[0]
    const trail = op.s.slice(lead.length).match(/\s*$/)[0]
    const core = op.s.slice(lead.length, op.s.length - trail.length)
    if (!core) return op.s
    const i = Math.min(index++, 14)
    return h(React.Fragment, { key: k }, lead, h('ins', { className: 'hdc-ins', style: { '--i': i } }, core), trail)
  })
}

function Recipient({ value, t }) {
  const { name, address } = parseAddress(value)
  const content = name
    ? [h('span', { className: 'hdc-name', key: 'n' }, name), h('span', { className: 'hdc-addr', key: 'a' }, ` ${address}`)]
    : h('span', { className: 'hdc-name' }, address)
  if (t === 'add') return h('ins', { className: 'hdc-ins hdc-chip' }, content)
  if (t === 'del') return h('del', { className: 'hdc-del hdc-chip' }, content)
  return h('span', { className: 'hdc-chip' }, content)
}

function RecipientRow({ label, items, showRemoved }) {
  const visible = items.filter(item => showRemoved || item.t !== 'del')
  if (!visible.length) return null
  return h(
    'div',
    { className: 'hdc-row' },
    h('span', { className: 'hdc-label' }, label),
    h(
      'span',
      { className: 'hdc-value' },
      visible.map((item, k) =>
        h(
          React.Fragment,
          { key: `${item.s}-${k}` },
          k > 0 ? h('span', { className: 'hdc-sep' }, ', ') : null,
          h(Recipient, { value: item.s, t: item.t })
        )
      )
    )
  )
}

function StatusLine({ tone, icon, spin, children }) {
  return h(
    'div',
    { className: 'hdc-status', 'data-tone': tone, role: 'status' },
    icon ? h(Icon, { name: icon, className: spin ? 'hdc-spin' : undefined }) : h('span', { className: 'hdc-dot', 'aria-hidden': true }),
    h('span', { className: 'hdc-status-text' }, children)
  )
}

function ActionButton({ children, className, ...props }) {
  return h(Button, { size: 'xs', type: 'button', className: cx('hdc-press', className), ...props }, children)
}

function IconAction({ label, icon, onClick, disabled }) {
  const button = h(
    Button,
    { size: 'icon-xs', variant: 'ghost', type: 'button', 'aria-label': label, className: 'hdc-press', onClick, disabled },
    h(Icon, { name: icon })
  )
  return Tip ? h(Tip, { label }, button) : button
}

function MoreMenu({ items }) {
  if (!DropdownMenu) {
    return h(IconAction, { label: items[0].label, icon: items[0].icon, onClick: items[0].onSelect })
  }
  return h(
    DropdownMenu,
    null,
    h(
      DropdownMenuTrigger,
      { asChild: true },
      h(
        Button,
        { size: 'icon-xs', variant: 'ghost', type: 'button', 'aria-label': 'More actions', className: 'hdc-press' },
        h(Icon, { name: 'MoreHorizontal' })
      )
    ),
    h(
      DropdownMenuContent,
      { align: 'end', sideOffset: 6, className: 'hdc-menu' },
      items.map((item, k) =>
        item === 'sep'
          ? h(DropdownMenuSeparator, { key: `sep-${k}` })
          : h(
              DropdownMenuItem,
              { key: item.label, onSelect: item.onSelect, disabled: item.disabled, className: item.danger ? 'hdc-danger' : undefined },
              h(Icon, { name: item.icon }),
              item.label
            )
      )
    )
  )
}

function Skeleton() {
  return h(
    'div',
    { className: 'hdc-card hdc-skeleton', 'aria-busy': 'true', 'aria-label': 'Loading draft' },
    h('div', { className: 'hdc-bar', style: { width: '28%' } }),
    h('div', { className: 'hdc-bar hdc-bar-lg', style: { width: '62%' } }),
    h('div', { className: 'hdc-bar', style: { width: '44%' } }),
    h('div', { className: 'hdc-rule' }),
    h('div', { className: 'hdc-bar', style: { width: '92%' } }),
    h('div', { className: 'hdc-bar', style: { width: '86%' } }),
    h('div', { className: 'hdc-bar', style: { width: '54%' } })
  )
}

function Notice({ children, icon = 'Mail' }) {
  return h('div', { className: 'hdc-card hdc-notice' }, h(Icon, { name: icon }), h('span', null, children))
}

// ─────────────────────────────────────────────────────────────── editor

function splitList(text) {
  return String(text || '')
    .split(/[,;\n]/)
    .map(s => s.trim())
    .filter(Boolean)
}

function Editor({ record, fields, onCancel, onSave, saving, error }) {
  const isEmail = record.kind === 'email'
  const [draft, setDraft] = useState(() => ({
    subject: fields.subject || '',
    to: (fields.to || []).join(', '),
    cc: (fields.cc || []).join(', '),
    bcc: (fields.bcc || []).join(', '),
    body: fields.body || ''
  }))
  const bodyRef = useRef(null)
  useEffect(() => {
    const el = bodyRef.current
    if (el) {
      el.focus({ preventScroll: true })
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }, [])
  const set = key => event => setDraft(current => ({ ...current, [key]: event.target.value }))
  const save = () =>
    onSave({
      subject: draft.subject,
      to: splitList(draft.to),
      cc: splitList(draft.cc),
      bcc: splitList(draft.bcc),
      body: draft.body
    })
  const onKeyDown = event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) {
      event.preventDefault()
      event.stopPropagation()
      save()
    }
  }
  const field = (label, key, placeholder) =>
    h(
      'label',
      { className: 'hdc-row hdc-edit-row' },
      h('span', { className: 'hdc-label' }, label),
      h('input', {
        className: 'hdc-input',
        value: draft[key],
        onChange: set(key),
        placeholder,
        spellCheck: false,
        autoComplete: 'off'
      })
    )
  return h(
    'div',
    { className: 'hdc-editor', onKeyDown },
    isEmail
      ? h('input', {
          className: 'hdc-input hdc-subject',
          value: draft.subject,
          onChange: set('subject'),
          placeholder: 'Subject',
          'aria-label': 'Subject'
        })
      : null,
    h(
      'div',
      { className: 'hdc-fields' },
      fields.from
        ? h(
            'div',
            { className: 'hdc-row hdc-edit-row' },
            h('span', { className: 'hdc-label' }, 'From'),
            h('span', { className: 'hdc-value hdc-readonly' }, fields.from)
          )
        : null,
      field('To', 'to', isEmail ? 'name@example.com' : '#channel or person'),
      isEmail ? field('Cc', 'cc', 'Optional') : null,
      isEmail ? field('Bcc', 'bcc', 'Optional') : null
    ),
    h('div', { className: 'hdc-rule' }),
    h('textarea', {
      ref: bodyRef,
      className: 'hdc-input hdc-body hdc-body-input',
      value: draft.body,
      onChange: set('body'),
      'aria-label': 'Message',
      rows: 4
    }),
    error ? h('div', { className: 'hdc-inline-error', role: 'alert' }, error) : null,
    h(
      'div',
      { className: 'hdc-foot' },
      h('span', { className: 'hdc-hint' }, h('kbd', null, '⌘↵'), ' to save · ', h('kbd', null, 'esc'), ' to cancel'),
      h(
        'div',
        { className: 'hdc-actions' },
        h(ActionButton, { variant: 'text', onClick: onCancel, disabled: saving }, 'Cancel'),
        h(ActionButton, { onClick: save, disabled: saving || !draft.body.trim() }, saving ? h(Icon, { name: 'Loader2', className: 'hdc-spin' }) : 'Save changes')
      )
    )
  )
}

// ─────────────────────────────────────────────────────────────── the card

function DraftCard({ attrs, streaming }) {
  const id = String(attrs?.id || '')
  const cardNo = Number.parseInt(String(attrs?.v || '1'), 10)
  const valid = ID_RE.test(id) && Number.isInteger(cardNo) && cardNo > 0 && cardNo < 1000
  const query = useDraft(valid ? id : '')

  if (!valid) return h(Notice, { icon: 'AlertCircle' }, 'This draft card link is malformed.')
  if (query.isPending) return h(Skeleton)
  if (query.isError) {
    return h(
      Notice,
      { icon: 'AlertCircle' },
      isMissing(query.error)
        ? 'This draft isn’t available here. It may belong to another profile, or the Draft Cards backend is off.'
        : `Couldn’t load this draft: ${errorText(query.error)}`
    )
  }
  const record = query.data
  const mine = record.versions.filter(v => v.card === cardNo)
  if (!mine.length) return h(Notice, { icon: 'AlertCircle' }, 'This version of the draft no longer exists.')
  return h(CardBody, { record, cardNo, version: mine[mine.length - 1], streaming })
}

function CardBody({ record, cardNo, version }) {
  const latest = record.versions[record.versions.length - 1]
  const isCurrent = version.v === latest.v
  const superseded = record.latest_card > cardNo && !isCurrent
  const previous = record.versions.find(v => v.v === version.v - 1) || null
  const fields = version.fields
  const isEmail = record.kind === 'email'

  // Animate only a version that was just written, once per mount.
  const fresh = useRef(Date.now() / 1000 - version.created_at < FRESH_SECONDS).current
  const [showRemoved, setShowRemoved] = useState(false)
  const [expanded, setExpanded] = useState(false) // superseded/discarded peek
  const [clampOpen, setClampOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(null) // 'send' | 'edit' | 'state'
  const [error, setError] = useState(null)

  const diff = useMemo(() => {
    if (!previous) return null
    const body = diffText(previous.fields.body, fields.body)
    const subject = diffText(previous.fields.subject, fields.subject)
    const to = diffList(previous.fields.to, fields.to)
    const cc = diffList(previous.fields.cc, fields.cc)
    const bcc = diffList(previous.fields.bcc, fields.bcc)
    const listChanges = [...to, ...cc, ...bcc].filter(x => x.t !== 'eq').length
    const changes = countChanges(body) + countChanges(subject) + listChanges
    const removed = [body, subject].some(ops => ops.some(o => o.t === 'del')) || [...to, ...cc, ...bcc].some(x => x.t === 'del')
    return { body, subject, to, cc, bcc, changes, removed }
  }, [previous, fields])

  const status = isCurrent ? record.status : 'superseded'
  const approvedAt = record.status_at * 1000
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (status !== 'approved') return undefined
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [status])
  const waitedTooLong = status === 'approved' && now - approvedAt > APPROVAL_WAIT_MS

  const lines = (fields.body || '').split('\n').length
  const longBody = lines > BODY_CLAMP_LINES || (fields.body || '').length > 1400

  const run = useCallback(async (kind, fn) => {
    setBusy(kind)
    setError(null)
    try {
      return await fn()
    } catch (err) {
      setError(errorText(err))
      return null
    } finally {
      setBusy(null)
    }
  }, [])

  const copy = useCallback(async () => {
    const ok = await (CTX?.os?.writeClipboard?.(plainText(record, fields)) ?? Promise.resolve(false))
    host.notify({ kind: ok ? 'success' : 'error', message: ok ? 'Draft copied' : 'Couldn’t reach the clipboard' })
  }, [record, fields])

  const openInMail = useCallback(async () => {
    const ok = await (CTX?.os?.openExternal?.(mailtoUrl(fields)) ?? Promise.resolve(false))
    if (!ok) host.notify({ kind: 'error', message: 'No mail app answered the mailto: link' })
  }, [fields])

  const tellAgent = useCallback(
    async text => {
      const sid = record.session_id || null
      if (sid && host.composer?.submit?.(sid, text)) return true
      // No visible composer for that chat: stage the message instead of guessing a target.
      const staged = await host.composer?.insertText?.(null, text, { mode: 'block' })
      host.notify({
        kind: staged ? 'info' : 'error',
        message: staged ? 'Press Enter to hand the approval to Hermes' : 'Open the chat this draft came from to send it'
      })
      return false
    },
    [record.session_id]
  )

  const send = () =>
    run('send', async () => {
      haptic('submit')
      const next = publish(await rest(`/drafts/${record.id}/approve`, { method: 'POST', body: { version: version.v } }))
      await tellAgent(approvalPrompt(next, version))
    })

  const saveToDrafts = () => run('state', () => tellAgent(savePrompt(record, version)))

  const setState = status =>
    run('state', async () => {
      publish(await rest(`/drafts/${record.id}/state`, { method: 'POST', body: { status } }))
    })

  const saveEdits = changed =>
    run('edit', async () => {
      const next = publish(
        await rest(`/drafts/${record.id}/edit`, {
          method: 'POST',
          body: { base_version: latest.v, card: cardNo, fields: changed }
        })
      )
      if (next) setEditing(false)
    })

  // ── collapsed rows: superseded and discarded ──────────────────────────────
  const collapsed = (status === 'superseded' || status === 'discarded') && !expanded
  const label = kindLabel(record)
  const header = h(
    'div',
    { className: 'hdc-head' },
    h(Icon, { name: isEmail ? 'Mail' : 'MessageSquareText', className: 'hdc-kind-icon' }),
    h('span', { className: 'hdc-kind' }, label),
    record.versions.length > 1 ? h('span', { className: 'hdc-version' }, `v${cardNo}`) : null,
    diff && diff.changes > 0 && !editing && status !== 'superseded'
      ? h(
          'button',
          {
            type: 'button',
            className: 'hdc-pill hdc-press',
            'aria-pressed': showRemoved,
            disabled: !diff.removed,
            onClick: () => setShowRemoved(v => !v),
            title: diff.removed ? (showRemoved ? 'Hide removed text' : 'Show removed text') : undefined
          },
          `${version.author === 'user' ? 'Edited by you' : 'Revised'} · ${diff.changes} ${diff.changes === 1 ? 'change' : 'changes'}`,
          diff.removed ? h(Icon, { name: showRemoved ? 'EyeOff' : 'Eye', size: 12 }) : null
        )
      : null,
    h('span', { className: 'hdc-spacer' }),
    editing ? h('span', { className: 'hdc-editing' }, 'Editing') : null
  )

  if (collapsed) {
    const summary = fields.subject || (fields.body || '').split('\n')[0]
    return h(
      'div',
      { className: 'hdc-card hdc-collapsed', 'data-status': status },
      h(
        'button',
        { type: 'button', className: 'hdc-collapsed-row', onClick: () => setExpanded(true), 'aria-expanded': false },
        h(Icon, { name: isEmail ? 'Mail' : 'MessageSquareText', className: 'hdc-kind-icon' }),
        h('span', { className: 'hdc-kind' }, record.versions.length > 1 ? `${label} · v${cardNo}` : label),
        h('span', { className: 'hdc-collapsed-subject' }, summary),
        h('span', { className: 'hdc-collapsed-meta' }, status === 'discarded' ? 'Discarded' : 'Revised below'),
        h(Icon, { name: 'ChevronDown', className: 'hdc-caret' })
      ),
      status === 'discarded'
        ? h(ActionButton, { variant: 'text', className: 'hdc-undo', onClick: () => setState('draft'), disabled: !!busy }, 'Undo')
        : null
    )
  }

  // ── footer by status ──────────────────────────────────────────────────────
  let footer
  if (editing) {
    footer = null // the editor renders its own
  } else if (status === 'superseded') {
    footer = h(
      'div',
      { className: 'hdc-foot' },
      h(StatusLine, { tone: 'muted', icon: 'CornerDownLeft' }, 'A newer version is below'),
      h('div', { className: 'hdc-actions' }, h(ActionButton, { variant: 'text', onClick: () => setExpanded(false) }, 'Collapse'))
    )
  } else if (status === 'approved') {
    footer = h(
      'div',
      { className: 'hdc-foot' },
      h(
        StatusLine,
        { tone: 'accent', icon: 'Loader2', spin: true },
        waitedTooLong ? 'Approved. Hermes hasn’t confirmed sending yet' : 'Approved. Hermes is sending it'
      ),
      h(
        'div',
        { className: 'hdc-actions' },
        h(ActionButton, { variant: 'text', onClick: () => setState('draft'), disabled: !!busy }, 'Cancel')
      )
    )
  } else if (status === 'sent' || status === 'saved') {
    const verb = status === 'sent' ? 'Sent' : 'Saved to drafts'
    const detail = record.status_detail ? ` ${record.status_detail.replace(/^\s*(sent|saved)\s*/i, '')}` : ''
    footer = h(
      'div',
      { className: 'hdc-foot hdc-done' },
      h(StatusLine, { tone: 'success', icon: 'CheckCircle2' }, `${verb}${detail} · ${timeLabel(record.status_at)}`),
      h('div', { className: 'hdc-actions' }, h(IconAction, { label: 'Copy text', icon: 'Copy', onClick: copy }))
    )
  } else {
    const failed = status === 'failed'
    const discarded = status === 'discarded'
    const menu = [
      { label: 'Copy text', icon: 'Copy', onSelect: copy },
      isEmail ? { label: 'Open in Mail', icon: 'ExternalLink', onSelect: openInMail } : null,
      isEmail ? { label: 'Save to drafts', icon: 'Mail', onSelect: saveToDrafts, disabled: !!busy } : null,
      'sep',
      discarded
        ? { label: 'Restore draft', icon: 'CornerDownLeft', onSelect: () => setState('draft') }
        : { label: 'Discard draft', icon: 'Trash2', onSelect: () => setState('discarded'), danger: true }
    ].filter(Boolean)
    footer = h(
      'div',
      { className: 'hdc-foot' },
      failed
        ? h(StatusLine, { tone: 'danger', icon: 'AlertCircle' }, record.status_detail ? `Couldn’t send: ${record.status_detail}` : 'Couldn’t send')
        : discarded
          ? h(StatusLine, { tone: 'muted' }, 'Discarded')
          : h(StatusLine, { tone: 'pending' }, 'Needs your approval'),
      h(
        'div',
        { className: 'hdc-actions' },
        h(MoreMenu, { items: menu }),
        h(ActionButton, { variant: 'ghost', onClick: () => setEditing(true), disabled: !!busy || discarded }, h(Icon, { name: 'Pencil' }), 'Edit'),
        h(
          ActionButton,
          { className: 'hdc-send', onClick: send, disabled: !!busy || discarded, 'data-busy': busy === 'send' || undefined },
          h('span', { className: 'hdc-send-label' }, failed ? 'Try again' : 'Send', h(Icon, { name: 'Send', size: 12 })),
          h('span', { className: 'hdc-send-spinner', 'aria-hidden': true }, h(Icon, { name: 'Loader2', className: 'hdc-spin' }))
        )
      )
    )
  }

  // ── body ──────────────────────────────────────────────────────────────────
  const showDiff = diff && !editing && status !== 'superseded'
  const bodyContent = showDiff ? h(DiffText, { ops: diff.body, showRemoved }) : fields.body
  const subjectContent = showDiff ? h(DiffText, { ops: diff.subject, showRemoved }) : fields.subject
  const list = (key, label) => {
    const items = showDiff ? diff[key] : (fields[key] || []).map(s => ({ s, t: 'eq' }))
    return h(RecipientRow, { label, items, showRemoved, key })
  }

  return h(
    'section',
    {
      className: 'hdc-card',
      'data-status': status,
      'data-fresh': fresh || undefined,
      'aria-label': `${label}${fields.subject ? `: ${fields.subject}` : ''}`
    },
    header,
    editing
      ? h(Editor, {
          record,
          fields,
          saving: busy === 'edit',
          error,
          onCancel: () => {
            setEditing(false)
            setError(null)
          },
          onSave: saveEdits
        })
      : h(
          React.Fragment,
          null,
          isEmail && fields.subject ? h('div', { className: 'hdc-subject' }, subjectContent) : null,
          h(
            'div',
            { className: 'hdc-fields' },
            fields.from ? h(RecipientRow, { label: 'From', items: [{ s: fields.from, t: 'eq' }], showRemoved }) : null,
            list('to', 'To'),
            isEmail ? list('cc', 'Cc') : null,
            isEmail ? list('bcc', 'Bcc') : null
          ),
          h('div', { className: 'hdc-rule' }),
          h(
            'div',
            { className: 'hdc-body', 'data-clamped': (longBody && !clampOpen) || undefined },
            bodyContent
          ),
          longBody
            ? h(
                'button',
                { type: 'button', className: 'hdc-more', onClick: () => setClampOpen(v => !v) },
                clampOpen ? 'Show less' : 'Show full draft'
              )
            : null,
          error ? h('div', { className: 'hdc-inline-error', role: 'alert' }, error) : null,
          footer
        )
  )
}

// ─────────────────────────────────────────────────────────────── styles

const CSS = String.raw`
.hdc-card {
  --hdc-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --hdc-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --hdc-hl: color-mix(in srgb, var(--ui-accent) 20%, transparent);
  --hdc-hl-ink: var(--ui-text-primary);
  --hdc-muted: var(--ui-text-tertiary);
  --hdc-rule: color-mix(in srgb, var(--ui-stroke-secondary) 55%, transparent);
  box-sizing: border-box;
  width: min(100%, 35rem);
  margin: 0.375rem 0;
  padding: 0.75rem 0.875rem 0.625rem;
  border-radius: 1.5rem;
  background: var(--ui-widget-surface-background, var(--ui-bg-editor));
  color: var(--ui-text-primary);
  font-size: var(--conversation-text-font-size, 0.875rem);
  line-height: 1.5;
  text-align: left;
}
/* On dark surfaces a translucent accent sinks into the card; give it more body. */
:where(.dark) .hdc-card { --hdc-hl: color-mix(in srgb, var(--ui-accent) 36%, transparent); }
.hdc-card[data-fresh] { animation: hdc-enter 260ms var(--hdc-ease-out) both; }
@keyframes hdc-enter { from { opacity: 0; transform: translateY(6px) scale(0.985); } }

.hdc-icon { flex: none; }
.hdc-head { display: flex; align-items: center; gap: 0.4rem; min-height: 1.25rem; font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--hdc-muted); }
.hdc-kind-icon { color: var(--hdc-muted); }
.hdc-kind { font-weight: 500; white-space: nowrap; }
.hdc-version { font-variant-numeric: tabular-nums; opacity: 0.8; }
.hdc-spacer { flex: 1; }
.hdc-editing { color: var(--ui-text-secondary); }
.hdc-pill {
  display: inline-flex; align-items: center; gap: 0.3rem;
  margin-left: 0.15rem; padding: 0.05rem 0.5rem; border: 0; border-radius: 999px;
  background: color-mix(in srgb, var(--ui-accent) 13%, transparent);
  color: color-mix(in srgb, var(--ui-accent) 55%, var(--ui-text-primary));
  font: inherit; font-weight: 500; cursor: pointer;
  transition: background-color 150ms ease, transform 160ms var(--hdc-ease-out);
}
.hdc-pill:disabled { cursor: default; }
.hdc-pill[aria-pressed='true'] { background: color-mix(in srgb, var(--ui-accent) 22%, transparent); }
@media (hover: hover) and (pointer: fine) {
  .hdc-pill:not(:disabled):hover { background: color-mix(in srgb, var(--ui-accent) 20%, transparent); }
}

.hdc-subject {
  display: block; width: 100%; box-sizing: border-box;
  margin-top: 0.5rem; font-size: 1.0625em; line-height: 1.35; font-weight: 600; letter-spacing: -0.005em;
  color: var(--ui-text-primary); text-wrap: pretty;
}
.hdc-fields { display: grid; grid-template-columns: minmax(2.25rem, max-content) 1fr; column-gap: 0.75rem; row-gap: 0.125rem; margin-top: 0.5rem; font-size: var(--conversation-tool-font-size, 0.75rem); }
.hdc-row { display: contents; }
.hdc-label { color: var(--hdc-muted); line-height: 1.25rem; }
.hdc-value { min-width: 0; line-height: 1.25rem; color: var(--ui-text-secondary); overflow-wrap: anywhere; }
.hdc-name { color: var(--ui-text-secondary); }
.hdc-addr { color: var(--hdc-muted); }
.hdc-sep { color: var(--hdc-muted); }
.hdc-chip { text-decoration: none; }
.hdc-rule { height: 1px; margin: 0.625rem 0; background: var(--hdc-rule); }

.hdc-body { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ui-text-primary); line-height: 1.6; text-wrap: pretty; }
.hdc-body[data-clamped] {
  max-height: calc(1.6em * ${BODY_CLAMP_LINES}); overflow: hidden;
  -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
  mask-image: linear-gradient(to bottom, #000 70%, transparent);
}
.hdc-more { margin-top: 0.25rem; padding: 0; border: 0; background: none; font: inherit; font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--ui-text-secondary); cursor: pointer; text-underline-offset: 3px; }
@media (hover: hover) and (pointer: fine) { .hdc-more:hover { color: var(--ui-text-primary); text-decoration: underline; } }

/* What changed: a highlighter mark that hugs the words, sweeping in left to right. */
.hdc-ins {
  color: var(--hdc-hl-ink); text-decoration: none;
  background-image: linear-gradient(var(--hdc-hl), var(--hdc-hl));
  background-repeat: no-repeat; background-size: 100% 100%;
  border-radius: 0.3em; padding: 0.05em 0.16em; margin: 0 -0.16em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.hdc-card[data-fresh] .hdc-ins { animation: hdc-sweep 380ms var(--hdc-ease-out) both; animation-delay: calc(200ms + var(--i, 0) * 45ms); }
@keyframes hdc-sweep { from { background-size: 0% 100%; } }
.hdc-del {
  color: var(--ui-diff-remove-foreground, var(--hdc-muted));
  background: var(--ui-diff-remove-background, transparent);
  text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 55%, transparent);
  border-radius: 0.3em; padding: 0.05em 0.12em; margin: 0 0.22em 0 0.14em;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
}
.hdc-chip.hdc-ins { padding: 0 0.2em; }
.hdc-chip.hdc-del { margin-right: 0; }

.hdc-foot { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; min-height: 1.75rem; }
.hdc-actions { display: flex; align-items: center; gap: 0.25rem; margin-left: auto; }
.hdc-status { display: flex; align-items: center; gap: 0.4rem; min-width: 0; font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--hdc-muted); }
.hdc-status-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hdc-dot { width: 0.375rem; height: 0.375rem; border-radius: 999px; background: currentColor; flex: none; }
.hdc-status[data-tone='pending'] .hdc-dot { background: var(--ui-yellow, var(--ui-accent)); }
/* Icons and the dot share one 14px lead box, so status text always starts on the same x. */
.hdc-status > .hdc-icon, .hdc-status > .hdc-dot { margin-inline: 0; }
.hdc-status > .hdc-dot { margin-inline: 0.25rem; }
.hdc-status[data-tone='accent'] { color: var(--ui-text-secondary); }
.hdc-status[data-tone='success'] { color: var(--ui-text-secondary); }
.hdc-status[data-tone='success'] .hdc-icon { color: var(--ui-green); }
.hdc-status[data-tone='danger'] { color: var(--ui-red); }
.hdc-done .hdc-icon { animation: hdc-pop 320ms var(--hdc-ease-out) both; }
@keyframes hdc-pop { from { opacity: 0; transform: scale(0.6); } }
.hdc-spin { animation: hdc-rotate 700ms linear infinite; }
@keyframes hdc-rotate { to { transform: rotate(360deg); } }

.hdc-press { transition-property: transform, background-color, color, opacity, box-shadow; transition-duration: 160ms; transition-timing-function: var(--hdc-ease-out); }
.hdc-press:active:not(:disabled) { transform: scale(0.97); }

/* Send morphs into a spinner in place: the label blurs out, the spinner blurs in. */
.hdc-send { position: relative; }
.hdc-send-label, .hdc-send-spinner { display: inline-flex; align-items: center; gap: 0.3rem; transition: opacity 160ms ease, filter 160ms ease; }
.hdc-send-spinner { position: absolute; inset: 0; justify-content: center; opacity: 0; filter: blur(2px); }
.hdc-send[data-busy] .hdc-send-label { opacity: 0; filter: blur(2px); }
.hdc-send[data-busy] .hdc-send-spinner { opacity: 1; filter: none; }

.hdc-inline-error { margin-top: 0.5rem; font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--ui-red); }
.hdc-menu .hdc-icon { margin-right: 0.15rem; color: var(--hdc-muted); }
.hdc-danger { color: var(--ui-red); }
.hdc-danger .hdc-icon { color: currentColor; }

/* Inline editing: same typography as the read view, so nothing jumps. */
.hdc-editor { display: block; }
.hdc-input {
  display: block; width: 100%; box-sizing: border-box; margin: 0; padding: 0.125rem 0.375rem; margin-inline: -0.375rem; width: calc(100% + 0.75rem);
  border: 0; border-radius: 0.5rem; outline: none; background: transparent;
  font: inherit; color: inherit; letter-spacing: inherit;
  transition: background-color 150ms ease, box-shadow 150ms ease;
}
.hdc-input::placeholder { color: var(--hdc-muted); opacity: 0.7; }
@media (hover: hover) and (pointer: fine) { .hdc-input:hover { background: var(--ui-control-hover-background, color-mix(in srgb, var(--ui-text-primary) 5%, transparent)); } }
.hdc-input:focus { background: color-mix(in srgb, var(--ui-text-primary) 4%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--ui-accent) 60%, transparent); }
.hdc-input.hdc-subject { font-size: 1.0625em; font-weight: 600; line-height: 1.35; padding-block: 0.125rem; margin-top: 0.375rem; }
.hdc-edit-row .hdc-label { cursor: text; padding-block: 0.125rem; }
.hdc-edit-row .hdc-input { color: var(--ui-text-secondary); line-height: 1.25rem; }
.hdc-edit-row .hdc-readonly { padding-block: 0.125rem; }
.hdc-body-input { field-sizing: content; min-height: 6.5em; max-height: 28em; resize: none; white-space: pre-wrap; line-height: 1.6; padding-block: 0.25rem; }
.hdc-hint { font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--hdc-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hdc-hint kbd { font: inherit; padding: 0 0.25rem; border-radius: 0.25rem; background: color-mix(in srgb, var(--ui-text-primary) 7%, transparent); }

/* Collapsed rows: superseded versions and discarded drafts. */
.hdc-collapsed { display: flex; align-items: center; gap: 0.25rem; padding: 0.375rem 0.5rem 0.375rem 0.875rem; border-radius: 1.25rem; }
.hdc-collapsed-row { display: flex; align-items: center; gap: 0.45rem; min-width: 0; flex: 1; padding: 0.125rem 0; border: 0; background: none; color: var(--hdc-muted); font: inherit; font-size: var(--conversation-tool-font-size, 0.75rem); cursor: pointer; text-align: left; }
.hdc-collapsed-subject { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ui-text-secondary); }
.hdc-collapsed-meta { white-space: nowrap; }
.hdc-caret { transition: transform 160ms var(--hdc-ease-out); }
@media (hover: hover) and (pointer: fine) {
  .hdc-collapsed-row:hover .hdc-collapsed-subject { color: var(--ui-text-primary); }
  .hdc-collapsed-row:hover .hdc-caret { transform: translateY(1px); }
}
.hdc-collapsed[data-status='discarded'] .hdc-collapsed-subject { text-decoration: line-through; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); }

.hdc-notice { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 0.875rem; border-radius: 1.25rem; font-size: var(--conversation-tool-font-size, 0.75rem); color: var(--hdc-muted); }

.hdc-skeleton { display: grid; gap: 0.5rem; }
.hdc-bar { height: 0.625rem; border-radius: 999px; background: color-mix(in srgb, var(--ui-text-primary) 7%, transparent); animation: hdc-breathe 1.4s ease-in-out infinite; }
.hdc-bar-lg { height: 0.875rem; }
.hdc-skeleton .hdc-rule { margin: 0.25rem 0; }
@keyframes hdc-breathe { 50% { opacity: 0.55; } }

@media (prefers-reduced-motion: reduce) {
  .hdc-card[data-fresh] { animation: hdc-fade 200ms ease both; }
  .hdc-card[data-fresh] .hdc-ins { animation: hdc-fade 200ms ease both; animation-delay: 120ms; }
  .hdc-done .hdc-icon { animation: none; }
  .hdc-press:active:not(:disabled) { transform: none; }
  .hdc-spin { animation-duration: 1.4s; }
  .hdc-bar { animation: none; }
}
@keyframes hdc-fade { from { opacity: 0; } }
`

// ─────────────────────────────────────────────────────────────── plugin

export default {
  id: PLUGIN_ID,
  name: 'Draft Cards',
  description: 'Email and message drafts as reviewable cards in chat: highlighted revisions, inline editing, approval-first Send.',
  register(ctx) {
    CTX = ctx
    ctx.onDispose(() => {
      if (CTX === ctx) CTX = null
    })

    const style = document.createElement('style')
    style.setAttribute('data-hermes-plugin', PLUGIN_ID)
    style.textContent = CSS
    document.head.appendChild(style)
    ctx.onDispose(() => style.remove())

    ctx.onEvent(`plugin.${PLUGIN_ID}.draft.updated`, event => {
      const id = event?.payload?.id
      if (typeof id === 'string' && ID_RE.test(id)) queryClient.invalidateQueries({ queryKey: draftKey(id) })
    })

    ctx.register({
      id: 'draft-card',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      data: {
        name: 'draft-card',
        render: ({ attrs, streaming }) => h(DraftCard, { attrs, streaming })
      }
    })
  }
}

// Exposed for the preview harness and tests; not part of the plugin contract.
export const __test__ = { diffText, countChanges, diffList, tokenize, parseAddress, mailtoUrl, approvalPrompt }
