// DOINg.MCP — sober, reusable UI primitives (zero dependency beyond lucide).
import {
  AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, X, XCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react'
import type { ComponentProps, ReactNode } from 'react'

export function cls(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------- Boutons

interface ButtonProps extends ComponentProps<'button'> {
  variant?: 'primary' | 'outline' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  icon?: LucideIcon
  busy?: boolean
}

const BTN_VARIANTS: Record<string, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-400 shadow-sm',
  outline: 'border border-zinc-300 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800',
  ghost: 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:bg-red-400 shadow-sm',
}

export function Button({ variant = 'primary', size = 'md', icon: Icon, busy, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      className={cls(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3.5 py-2 text-sm',
        BTN_VARIANTS[variant], className,
      )}
      disabled={disabled || busy}
      {...rest}
    >
      {busy ? <Loader2 size={size === 'sm' ? 13 : 15} className="animate-spin" />
        : Icon ? <Icon size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  )
}

// ---------------------------------------------------------------- Surfaces

export function Card({ title, subtitle, actions, children, className }: {
  title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={cls('rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900', className)}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-3 border-b border-zinc-100 px-4 py-3 dark:border-zinc-800">
          <div>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{title}</h3>
            {subtitle && <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  )
}

const BADGE_TONES: Record<string, string> = {
  gray: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  brand: 'bg-brand-100 text-brand-800 dark:bg-brand-900/40 dark:text-brand-300',
}

export function Badge({ tone = 'gray', children, className }: { tone?: string; children: ReactNode; className?: string }) {
  return (
    <span className={cls('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', BADGE_TONES[tone] ?? BADGE_TONES.gray, className)}>
      {children}
    </span>
  )
}

export function StatusDot({ status }: { status: 'ok' | 'error' | 'unknown' }) {
  const color = status === 'ok' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-zinc-400'
  return <span className={cls('inline-block h-2 w-2 rounded-full', color)} />
}

export function EmptyState({ icon: Icon, title, desc, action }: {
  icon: LucideIcon; title: string; desc?: string; action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-6 py-10 text-center dark:border-zinc-700">
      <Icon size={28} className="text-zinc-400" />
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      {desc && <p className="max-w-md text-xs text-zinc-500 dark:text-zinc-400">{desc}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- Formulaires

export function Field({ label, hint, children, className }: {
  label: string; hint?: string; children: ReactNode; className?: string
}) {
  return (
    <label className={cls('block', className)}>
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</span>}
    </label>
  )
}

const INPUT_CLS = 'w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder-zinc-400 outline-none transition-colors focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100'

export function Input(props: ComponentProps<'input'>) {
  const { className, ...rest } = props
  return <input className={cls(INPUT_CLS, className)} {...rest} />
}

export function Textarea(props: ComponentProps<'textarea'>) {
  const { className, ...rest } = props
  return <textarea className={cls(INPUT_CLS, 'resize-y', className)} {...rest} />
}

export function Select(props: ComponentProps<'select'>) {
  const { className, ...rest } = props
  return <select className={cls(INPUT_CLS, 'pr-8', className)} {...rest} />
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300"
    >
      <span className={cls('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-zinc-300 dark:bg-zinc-700')}>
        <span className={cls('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  )
}

// ---------------------------------------------------------------- Modale

export function Modal({ open, onClose, title, children, footer, wide }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/50 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div
        className={cls('flex max-h-[88vh] w-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900', wide ? 'max-w-4xl' : 'max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-100 px-5 py-3.5 dark:border-zinc-800">
          <h3 className="text-sm font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-zinc-100 px-5 py-3 dark:border-zinc-800">{footer}</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Code

export function CodeBlock({ code, filename, maxHeight = 'max-h-96' }: { code: string; filename?: string; maxHeight?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-700 dark:bg-zinc-800">
        <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{filename ?? 'code'}</span>
        <button onClick={copy} className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
          {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={cls('overflow-auto bg-white p-3 font-mono text-[11.5px] leading-relaxed text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200', maxHeight)}>
        {code}
      </pre>
    </div>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-brand-500" />
}

// ---------------------------------------------------------------- Toasts

type ToastTone = 'info' | 'success' | 'error' | 'warn'
interface Toast { id: number; message: string; tone: ToastTone }
interface ToastApi { push: (message: string, tone?: ToastTone) => void }

const ToastContext = createContext<ToastApi>({ push: () => undefined })
export const useToast = () => useContext(ToastContext)

const TOAST_ICONS: Record<ToastTone, LucideIcon> = {
  info: Info, success: CheckCircle2, error: XCircle, warn: AlertTriangle,
}
const TOAST_COLORS: Record<ToastTone, string> = {
  info: 'border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300',
  success: 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300',
  error: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
  warn: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)
  const push = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = ++counter.current
    setToasts((prev) => [...prev.slice(-4), { id, message, tone }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), tone === 'error' ? 7000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2">
        {toasts.map((toast) => {
          const Icon = TOAST_ICONS[toast.tone]
          return (
            <div
              key={toast.id}
              className={cls('pointer-events-auto flex items-start gap-2 rounded-lg border bg-white px-3 py-2.5 text-xs shadow-lg dark:bg-zinc-900', TOAST_COLORS[toast.tone])}
            >
              <Icon size={14} className="mt-0.5 shrink-0" />
              <span className="text-zinc-700 dark:text-zinc-200">{toast.message}</span>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

// ---------------------------------------------------------------- Confirmation

interface ConfirmOptions { title: string; message: string; confirmLabel?: string }
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn>(() => Promise.resolve(false))
export const useConfirm = () => useContext(ConfirmContext)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)
  const confirm = useCallback<ConfirmFn>((opts) => new Promise((resolve) => setState({ ...opts, resolve })), [])
  const close = (value: boolean) => {
    state?.resolve(value)
    setState(null)
  }
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Modal
        open={state !== null}
        onClose={() => close(false)}
        title={state?.title ?? ''}
        footer={
          <>
            <Button variant="outline" onClick={() => close(false)}>Cancel</Button>
            <Button variant="danger" onClick={() => close(true)}>{state?.confirmLabel ?? 'Delete'}</Button>
          </>
        }
      >
        <p className="text-sm text-zinc-600 dark:text-zinc-300">{state?.message}</p>
      </Modal>
    </ConfirmContext.Provider>
  )
}

// ---------------------------------------------------------------- Helpers async

export function useBusy(): [string | null, (key: string, fn: () => Promise<void>) => void] {
  const [busy, setBusy] = useState<string | null>(null)
  const toast = useToast()
  const run = useCallback((key: string, fn: () => Promise<void>) => {
    setBusy(key)
    fn()
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        toast.push(message, 'error')
      })
      .finally(() => setBusy(null))
  }, [toast])
  return [busy, run]
}
