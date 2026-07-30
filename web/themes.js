/**
 * themes.js — AttendanceProcessor v3
 * ====================================
 * Six UI themes. Applied via CSS custom properties on :root.
 * NOTE: localStorage is NOT available in pywebview/GTK WebKit2 —
 * use window._apMem (in-memory) as fallback; Python backend for persistence.
 */

const THEMES = {
  mono: {
    label: 'Mono',
    desc:  'Clean light grey — default, professional',
    preview: { bg: '#F7F7F8', accent: '#2563EB', text: '#0F0F12' },
    vars: {
      '--bg-base':       '#F7F7F8',
      '--bg-surface':    '#FFFFFF',
      '--bg-muted':      '#F0F0F1',
      '--bg-sidebar':    '#F5F5F6',
      '--border':        '#E2E2E4',
      '--border-light':  '#EBEBEC',
      '--text-head':     '#0F0F12',
      '--text-body':     '#2A2A2F',
      '--text-mid':      '#6B6B72',
      '--text-dim':      '#A0A0A6',
      '--text-inv':      '#FFFFFF',
      '--accent':        '#2563EB',
      '--accent-hover':  '#1D4ED8',
      '--accent-bg':     '#EFF6FF',
      '--ok':            '#16A34A',
      '--ok-bg':         '#F0FDF4',
      '--warn':          '#D97706',
      '--warn-bg':       '#FFFBEB',
      '--danger':        '#DC2626',
      '--danger-bg':     '#FEF2F2',
      '--navbar-bg':     '#FFFFFF',
      '--navbar-text':   '#0F0F12',
      '--navbar-text-dim': '#A0A0A6',
      '--panel-hdr-bg':  '#F7F7F8',
      '--diff-bg':       '#FFFBEB',
      '--diff-border':   '#FCD34D',
      '--diff-text':     '#92400E',
    }
  },
  professional: {
    label: 'Professional',
    desc:  'Dark navy with blue accents',
    preview: { bg: '#0f172a', accent: '#3b82f6', text: '#e2e8f0' },
    vars: {
      '--bg-base':       '#0f172a',
      '--bg-surface':    '#1e293b',
      '--bg-muted':      '#162032',
      '--bg-sidebar':    '#1a2640',
      '--border':        '#334155',
      '--border-light':  '#2a3a52',
      '--text-head':     '#f1f5f9',
      '--text-body':     '#e2e8f0',
      '--text-mid':      '#cbd5e1',
      '--text-dim':      '#94a3b8',
      '--text-inv':      '#ffffff',
      '--accent':        '#3b82f6',
      '--accent-hover':  '#60a5fa',
      '--accent-bg':     'rgba(59,130,246,0.15)',
      '--ok':            '#4ade80',
      '--ok-bg':         'rgba(74,222,128,0.1)',
      '--warn':          '#fbbf24',
      '--warn-bg':       'rgba(251,191,36,0.1)',
      '--danger':        '#f87171',
      '--danger-bg':     'rgba(248,113,113,0.1)',
      '--navbar-bg':     '#1e3a8a',
      '--navbar-text':   '#ffffff',
      '--navbar-text-dim': '#cbd5e1',
      '--panel-hdr-bg':  '#162032',
      '--diff-bg':       'rgba(251,191,36,0.1)',
      '--diff-border':   '#fbbf24',
      '--diff-text':     '#fde68a',
    }
  },
  dark: {
    label: 'Dark',
    desc:  'Deep slate dark mode',
    preview: { bg: '#0d1117', accent: '#818cf8', text: '#c9d1d9' },
    vars: {
      '--bg-base':       '#0d1117',
      '--bg-surface':    '#161b22',
      '--bg-muted':      '#1c2128',
      '--bg-sidebar':    '#13181f',
      '--border':        '#30363d',
      '--border-light':  '#21262d',
      '--text-head':     '#f0f6fc',
      '--text-body':     '#c9d1d9',
      '--text-mid':      '#c9d1d9',
      '--text-dim':      '#8b949e',
      '--text-inv':      '#0d1117',
      '--accent':        '#818cf8',
      '--accent-hover':  '#a5b4fc',
      '--accent-bg':     'rgba(129,140,248,0.12)',
      '--ok':            '#3fb950',
      '--ok-bg':         'rgba(63,185,80,0.1)',
      '--warn':          '#e3b341',
      '--warn-bg':       'rgba(227,179,65,0.1)',
      '--danger':        '#f85149',
      '--danger-bg':     'rgba(248,81,73,0.1)',
      '--navbar-bg':     '#161b22',
      '--navbar-text':   '#f0f6fc',
      '--navbar-text-dim': '#8b949e',
      '--panel-hdr-bg':  '#1c2128',
      '--diff-bg':       'rgba(227,179,65,0.08)',
      '--diff-border':   '#e3b341',
      '--diff-text':     '#e3b341',
    }
  },
  light: {
    label: 'Light Blue',
    desc:  'Clean white with blue accents',
    preview: { bg: '#f8fafc', accent: '#1d4ed8', text: '#1e293b' },
    vars: {
      '--bg-base':       '#f8fafc',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#f0f7ff',
      '--bg-sidebar':    '#f8fafc',
      '--border':        '#e2e8f0',
      '--border-light':  '#f1f5f9',
      '--text-head':     '#0f172a',
      '--text-body':     '#1e293b',
      '--text-mid':      '#334155',
      '--text-dim':      '#475569',
      '--text-inv':      '#ffffff',
      '--accent':        '#1d4ed8',
      '--accent-hover':  '#1e40af',
      '--accent-bg':     '#eff6ff',
      '--ok':            '#16a34a',
      '--ok-bg':         '#f0fdf4',
      '--warn':          '#d97706',
      '--warn-bg':       '#fffbeb',
      '--danger':        '#dc2626',
      '--danger-bg':     '#fef2f2',
      '--navbar-bg':     '#1d4ed8',
      '--navbar-text':   '#ffffff',
      '--navbar-text-dim': '#cbd5e1',
      '--panel-hdr-bg':  '#f0f7ff',
      '--diff-bg':       '#fffbeb',
      '--diff-border':   '#fcd34d',
      '--diff-text':     '#92400e',
    }
  },
  minimal: {
    label: 'Minimal',
    desc:  'Pure white, dark header',
    preview: { bg: '#ffffff', accent: '#111827', text: '#111827' },
    vars: {
      '--bg-base':       '#ffffff',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#f9fafb',
      '--bg-sidebar':    '#f3f4f6',
      '--border':        '#e5e7eb',
      '--border-light':  '#f3f4f6',
      '--text-head':     '#111827',
      '--text-body':     '#374151',
      '--text-mid':      '#4b5563',
      '--text-dim':      '#6b7280',
      '--text-inv':      '#f9fafb',
      '--accent':        '#111827',
      '--accent-hover':  '#374151',
      '--accent-bg':     '#f3f4f6',
      '--ok':            '#16a34a',
      '--ok-bg':         '#f0fdf4',
      '--warn':          '#d97706',
      '--warn-bg':       '#fffbeb',
      '--danger':        '#dc2626',
      '--danger-bg':     '#fef2f2',
      '--navbar-bg':     '#1f2937',
      '--navbar-text':   '#f9fafb',
      '--navbar-text-dim': '#9ca3af',
      '--panel-hdr-bg':  '#f9fafb',
      '--diff-bg':       '#fffbeb',
      '--diff-border':   '#d97706',
      '--diff-text':     '#92400e',
    }
  },

  apple: {
    label: 'Apple Minimal',
    desc:  'Glassmorphism, rounded corners, blur',
    preview: { bg: '#f5f5f7', accent: '#0066cc', text: '#1d1d1f' },
    vars: {
      '--bg-base':       '#f5f5f7',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#e8e8ed',
      '--bg-sidebar':    '#f5f5f7',
      '--border':        '#d2d2d7',
      '--border-light':  '#e5e5ea',
      '--text-head':     '#1d1d1f',
      '--text-body':     '#333336',
      '--text-mid':      '#86868b',
      '--text-dim':      '#98989d',
      '--text-inv':      '#ffffff',
      '--accent':        '#0066cc',
      '--accent-hover':  '#004c99',
      '--accent-bg':     '#e5f0fa',
      '--ok':            '#34c759',
      '--ok-bg':         '#eaf9ed',
      '--warn':          '#ff9f0a',
      '--warn-bg':       '#fff5e6',
      '--danger':        '#ff3b30',
      '--danger-bg':     '#ffebe9',
      '--navbar-bg':     'rgba(255, 255, 255, 0.7)',
      '--navbar-text':   '#1d1d1f',
      '--navbar-text-dim': '#86868b',
      '--panel-hdr-bg':  '#f5f5f7',
      '--diff-bg':       '#fff5e6',
      '--diff-border':   '#ff9f0a',
      '--diff-text':     '#995c00',
    }
  },
  accessible: {
    label: 'Accessible',
    desc:  'High-contrast black/yellow — WCAG AA',
    preview: { bg: '#ffffff', accent: '#d97706', text: '#000000' },
    vars: {
      '--bg-base':       '#ffffff',
      '--bg-surface':    '#ffffff',
      '--bg-muted':      '#fef9c3',
      '--bg-sidebar':    '#fefce8',
      '--border':        '#000000',
      '--border-light':  '#6b7280',
      '--text-head':     '#000000',
      '--text-body':     '#000000',
      '--text-mid':      '#1c1917',
      '--text-dim':      '#374151',
      '--text-inv':      '#ffffff',
      '--accent':        '#d97706',
      '--accent-hover':  '#b45309',
      '--accent-bg':     '#fef9c3',
      '--ok':            '#166534',
      '--ok-bg':         '#dcfce7',
      '--warn':          '#92400e',
      '--warn-bg':       '#fef9c3',
      '--danger':        '#7f1d1d',
      '--danger-bg':     '#fee2e2',
      '--navbar-bg':     '#000000',
      '--navbar-text':   '#ffffff',
      '--navbar-text-dim': '#cccccc',
      '--panel-hdr-bg':  '#fef9c3',
      '--diff-bg':       '#fef9c3',
      '--diff-border':   '#d97706',
      '--diff-text':     '#78350f',
    }
  },
};

const DEFAULT_THEME = 'mono';

/** Apply theme variables to :root — safe, no localStorage. */
function applyTheme(name) {
  var theme = THEMES[name] || THEMES[DEFAULT_THEME];
  var root  = document.documentElement;
  var vars  = theme.vars;
  for (var k in vars) {
    if (vars.hasOwnProperty(k)) root.style.setProperty(k, vars[k]);
  }
  root.setAttribute('data-theme', name);
  // Persist to in-memory map (actual persistence is via Python backend)
  if (window._apMem) window._apMem['ap_theme'] = name;
}

function loadSavedTheme(name) {
  // name comes from Python backend (passed after API loads);
  // on first render use default — no localStorage needed
  applyTheme(name || DEFAULT_THEME);
}

function buildThemeGrid() {
  var grid = document.getElementById('theme-grid');
  if (!grid) return;
  grid.innerHTML = '';
  var current = (window._apMem && window._apMem['ap_theme']) || DEFAULT_THEME;
  for (var name in THEMES) {
    if (!THEMES.hasOwnProperty(name)) continue;
    (function(n) {
      var theme  = THEMES[n];
      var active = n === current;
      var btn    = document.createElement('button');
      btn.className = 'theme-card' + (active ? ' active' : '');
      btn.dataset.theme = n;
      btn.innerHTML =
        '<div class="theme-preview" style="background:' + theme.preview.bg + ';border:1px solid #ccc">' +
          '<div style="background:' + theme.preview.accent + ';width:100%;height:6px;border-radius:2px 2px 0 0"></div>' +
          '<div style="padding:4px;display:flex;gap:3px">' +
            '<div style="flex:1;height:8px;background:' + theme.preview.accent + ';opacity:.3;border-radius:2px"></div>' +
            '<div style="flex:2;height:8px;background:' + theme.preview.text  + ';opacity:.15;border-radius:2px"></div>' +
          '</div>' +
          '<div style="padding:2px 4px;font-size:9px;color:' + theme.preview.text + ';opacity:.6;font-family:monospace">Aa</div>' +
        '</div>' +
        '<div class="theme-label">' + theme.label + '</div>' +
        '<div class="theme-desc">'  + theme.desc  + '</div>';
      btn.addEventListener('click', function() {
        grid.querySelectorAll('.theme-card').forEach(function(c){ c.classList.remove('active'); });
        btn.classList.add('active');
        applyTheme(n);
        if (window._apMem) window._apMem['ap_theme'] = n;
        // Persist via backend
        if (window.pywebview && window.pywebview.api) {
          window.pywebview.api.save_settings({ ap_theme: n });
        }
      });
      grid.appendChild(btn);
    })(name);
  }
}

// Apply default theme immediately — no localStorage needed
applyTheme(DEFAULT_THEME);
