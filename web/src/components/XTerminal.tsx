import { useEffect, useRef, useImperativeHandle, forwardRef, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export interface XTerminalHandle {
  focus: () => void
  fit: () => void
  send: (data: string) => void
  getSelection: () => string
}

interface Props {
  wsUrl: string
  onClose?: () => void
  className?: string
  style?: React.CSSProperties
  fontSize?: number
}

const XTerminal = forwardRef<XTerminalHandle, Props>(({ wsUrl, onClose, className, style, fontSize = 13 }, ref) => {
  const divRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const menuDivRef = useRef<HTMLDivElement | null>(null)

  const sendToWs = useCallback((data: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(data))
    }
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => termRef.current?.focus(),
    fit: () => fitRef.current?.fit(),
    send: sendToWs,
    getSelection: () => termRef.current?.getSelection() ?? '',
  }))

  useEffect(() => {
    if (!divRef.current) return

    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#c9d1d9',
        cursorAccent: '#0d1117',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#79c0ff',
        magenta: '#bc8cff',
        cyan: '#56d364',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#87d7ff',
        brightWhite: '#ffffff',
        selectionBackground: '#3b4261',
        selectionForeground: '#ffffff',
      },
      fontFamily: '"JetBrains Mono","Fira Code","Cascadia Code",ui-monospace,monospace',
      fontSize,
      lineHeight: 1.6,
      cursorBlink: true,
      cursorStyle: 'block',
      allowTransparency: true,
      scrollback: 5000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(divRef.current)
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    const cols = term.cols
    const rows = term.rows
    const wsBase = wsUrl.startsWith('ws') ? wsUrl : wsUrl.replace(/^http/, 'ws')
    const sep = wsBase.includes('?') ? '&' : '?'
    const fullUrl = `${wsBase}${sep}cols=${cols}&rows=${rows}`

    const ws = new WebSocket(fullUrl)
    wsRef.current = ws
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => term.focus()

    ws.onmessage = e => {
      if (e.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(e.data))
      } else {
        term.write(e.data as string)
      }
    }

    ws.onclose = () => {
      term.writeln('\r\n\x1b[90m[connection closed]\x1b[0m')
      onClose?.()
    }

    ws.onerror = () => {
      term.writeln('\r\n\x1b[31m[connection error]\x1b[0m')
    }

    term.onData(data => {
      if (ws.readyState === WebSocket.OPEN) ws.send(new TextEncoder().encode(data))
    })

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`resize:${cols}:${rows}`)
      }
    })

    // Ctrl+Shift+C → copy; Ctrl+Shift+V → paste; intercept before xterm sees them.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true

      if (e.ctrlKey && e.shiftKey && e.code === 'KeyC') {
        const sel = term.getSelection()
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {})
        }
        e.preventDefault()
        return false
      }

      if (e.ctrlKey && e.shiftKey && e.code === 'KeyV') {
        navigator.clipboard.readText().then(text => {
          if (text && ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(text))
          }
        }).catch(() => {})
        e.preventDefault()
        return false
      }

      return true
    })

    // Right-click context menu
    const container = divRef.current
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      // Remove existing menu
      menuDivRef.current?.remove()

      const menu = document.createElement('div')
      menu.className =
        'fixed z-[9999] bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 text-xs min-w-[130px] select-none'
      menu.style.left = `${Math.min(e.clientX, window.innerWidth - 140)}px`
      menu.style.top = `${Math.min(e.clientY, window.innerHeight - 100)}px`

      const sel = term.getSelection()

      const addItem = (label: string, shortcut: string, action: () => void, disabled = false) => {
        const btn = document.createElement('button')
        btn.style.cssText =
          'display:flex;align-items:center;justify-content:space-between;width:100%;text-align:left;padding:6px 12px;color:' +
          (disabled ? '#6b7280' : '#e5e7eb') + ';cursor:' + (disabled ? 'default' : 'pointer') + ';gap:16px;'
        btn.innerHTML = `<span>${label}</span><span style="color:#6b7280;font-family:monospace;font-size:10px">${shortcut}</span>`
        if (!disabled) {
          btn.onmouseover = () => { btn.style.background = '#374151' }
          btn.onmouseleave = () => { btn.style.background = '' }
          btn.onclick = () => { action(); cleanup() }
        }
        menu.appendChild(btn)
      }

      addItem('Copy', 'Ctrl+Shift+C', () => {
        if (sel) navigator.clipboard.writeText(sel).catch(() => {})
      }, !sel)

      addItem('Paste', 'Ctrl+Shift+V', () => {
        navigator.clipboard.readText().then(text => {
          if (text && ws.readyState === WebSocket.OPEN) {
            ws.send(new TextEncoder().encode(text))
          }
        }).catch(() => {})
      })

      if (sel) {
        const sep = document.createElement('div')
        sep.style.cssText = 'border-top:1px solid #374151;margin:4px 0'
        menu.appendChild(sep)
        addItem('Clear selection', '', () => term.clearSelection())
      }

      const cleanup = () => {
        menu.remove()
        menuDivRef.current = null
        document.removeEventListener('click', cleanup, true)
        document.removeEventListener('contextmenu', cleanup, true)
        document.removeEventListener('keydown', cleanup, true)
      }

      menuDivRef.current = menu
      document.body.appendChild(menu)

      // Close on any outside interaction
      setTimeout(() => {
        document.addEventListener('click', cleanup, { once: true, capture: true })
        document.addEventListener('contextmenu', cleanup, { once: true, capture: true })
        document.addEventListener('keydown', cleanup, { once: true, capture: true })
      }, 10)
    }

    container?.addEventListener('contextmenu', handleContextMenu)

    const obs = new ResizeObserver(() => fitAddon.fit())
    obs.observe(divRef.current)

    return () => {
      obs.disconnect()
      ws.close()
      term.dispose()
      container?.removeEventListener('contextmenu', handleContextMenu)
      menuDivRef.current?.remove()
      termRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [wsUrl])

  // Update font size without reconnecting.
  useEffect(() => {
    const term = termRef.current
    const fit = fitRef.current
    if (term && fit) {
      term.options.fontSize = fontSize
      fit.fit()
    }
  }, [fontSize])

  return (
    <div ref={divRef} className={className} style={{ ...style, overflow: 'hidden' }} />
  )
})

XTerminal.displayName = 'XTerminal'
export default XTerminal
