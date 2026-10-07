window.__ModuleLoader__.load({
  id: 'dsh-minimal-first-turn',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var STATE_ENDPOINT = '/minimal-first-turn/state'
    // DSH's document base owns reverse-proxy mounts; host route keys stay absolute.
    var STATE_ROUTE = STATE_ENDPOINT.slice(1)
    var CSS = `
.dmft-toggle{display:inline-flex;align-items:center;gap:7px;min-height:28px;color:var(--dsw-alias-label-secondary,#5f6b76);font-family:inherit;font-size:12px;line-height:1;white-space:nowrap}
.dmft-label{font-weight:600}
.dmft-switch{position:relative;width:32px;height:18px;border:1px solid var(--dsw-alias-border-l2,#c5c9d3);border-radius:999px;background:var(--dsw-alias-bg-layer-3,#d8dce5);padding:0;cursor:pointer;transition:background .15s ease,border-color .15s ease;flex:0 0 auto}
.dmft-switch::after{content:'';position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.22);transition:transform .15s ease}
.dmft-switch[data-enabled='true']{background:#188455;border-color:#188455}
.dmft-switch[data-enabled='true']::after{transform:translateX(14px)}
.dmft-switch:focus-visible{outline:2px solid #2b75d6;outline-offset:2px}
.dmft-switch:disabled{cursor:default;opacity:.6}
.dmft-switch[aria-busy='true']{cursor:wait}
.dmft-error{color:var(--dsw-alias-label-danger,#b42318);white-space:normal;line-height:1.3}
.dmft-retry{font:inherit;color:inherit;background:none;border:1px solid currentColor;border-radius:4px;padding:3px 5px;cursor:pointer}
`

    function injectCss(css) {
      if (typeof document === 'undefined') return function () {}
      if (document.querySelector('style[data-dsh-minimal-first-turn]') !== null) return function () {}
      var style = document.createElement('style')
      style.setAttribute('data-dsh-minimal-first-turn', 'toggle')
      style.textContent = css
      document.head.appendChild(style)
      return function () { style.remove() }
    }

    async function request(options) {
      var response = await fetch(STATE_ROUTE, options)
      if (!response.ok) throw new Error('minimal-first-turn state request failed')
      var body = await response.json()
      if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
        throw new Error('Invalid minimal-first-turn state response')
      }
      return body
    }

    function MinimalFirstTurnToggle() {
      var state = React.useState({ enabled: null, status: 'loading', error: '' })
      var view = state[0]
      var setView = state[1]
      var lifecycleRef = React.useRef(null)

      function loadState(lifecycle) {
        if (!lifecycle || !lifecycle.active || lifecycle.busy) return
        lifecycle.busy = true
        lifecycle.enabled = null
        setView({ enabled: null, status: 'loading', error: '' })
        request({ method: 'GET', cache: 'no-store' }).then(function (body) {
          if (!lifecycle.active) return
          lifecycle.busy = false
          lifecycle.enabled = body.enabled
          setView({ enabled: body.enabled, status: 'ready', error: '' })
        }, function () {
          if (!lifecycle.active) return
          lifecycle.busy = false
          setView({ enabled: null, status: 'error', error: '无法读取首轮精简状态，请重试。' })
        })
      }

      React.useEffect(function () {
        // Each effect lifetime owns its requests, including Strict Mode replays.
        var lifecycle = { active: true, busy: false, enabled: null }
        lifecycleRef.current = lifecycle
        loadState(lifecycle)
        return function () { lifecycle.active = false }
      }, [])

      function toggle() {
        var lifecycle = lifecycleRef.current
        if (!lifecycle || !lifecycle.active || lifecycle.busy || lifecycle.enabled === null) return
        var next = !lifecycle.enabled
        // A ref locks synchronously, before React commits the disabled button.
        lifecycle.busy = true
        setView({ enabled: lifecycle.enabled, status: 'saving', error: '' })
        request({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        }).then(function (body) {
          if (!lifecycle.active) return
          lifecycle.busy = false
          lifecycle.enabled = body.enabled
          setView({ enabled: body.enabled, status: 'ready', error: '' })
        }, function () {
          if (!lifecycle.active) return
          lifecycle.busy = false
          // A failed response does not prove the server rejected the write.
          // Read the authoritative state again before allowing another toggle.
          lifecycle.enabled = null
          setView({ enabled: null, status: 'error', error: '保存失败，请重试以确认当前状态。' })
        })
      }

      var known = view.enabled !== null
      var busy = view.status === 'loading' || view.status === 'saving'
      var status = view.status === 'loading' ? '加载中…' : view.status === 'saving' ? '保存中…' : ''
      return React.createElement('div', {
        className: 'dmft-toggle',
        title: '让新会话的第一轮使用精简 prompt 与工具',
      },
        React.createElement('span', { className: 'dmft-label' }, '首轮精简'),
        React.createElement('button', {
          className: 'dmft-switch',
          type: 'button',
          role: known ? 'switch' : undefined,
          'aria-checked': known ? view.enabled : undefined,
          'aria-label': known ? '首轮精简' : '首轮精简（状态未知）',
          'aria-busy': busy,
          'data-enabled': known ? String(view.enabled) : undefined,
          disabled: view.status !== 'ready',
          onClick: toggle,
        }),
        React.createElement('span', { role: 'status', 'aria-live': 'polite' }, status),
        view.error ? React.createElement('span', { className: 'dmft-error', role: 'alert' }, view.error) : null,
        view.error ? React.createElement('button', {
          className: 'dmft-retry',
          type: 'button',
          'aria-label': '重新读取首轮精简状态',
          onClick: function () { loadState(lifecycleRef.current) },
        }, '重试') : null)
    }

    var plugin = {
      name: 'dsh-minimal-first-turn-client',
      apply: function (ctx) {
        ctx.inject(['slots'], function (scope) {
          scope.effect(function () { return injectCss(CSS) })
          scope.effect(function () {
            return scope.slots.inject('conversation.input.left', function () {
              return scope.slots.register(
                { name: 'conversation.input.left', id: 'dsh-minimal-first-turn', order: 40, label: '首轮精简' },
                function () { return React.createElement(MinimalFirstTurnToggle) },
              )
            })
          })
        })
      },
    }

    exports.apply = plugin.apply
    return module.exports
  },
})
