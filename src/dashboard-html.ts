export const dashboardHtml = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SysQlow - System Query Flow Knowledge Graph</title>
  
  <!-- Inter & Outfit Fonts -->
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700&family=Fira+Code:wght@400;500&display=swap" rel="stylesheet">
  
  <!-- Tailwind CSS v3 CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  
  <!-- Vis.js Network CDN -->
  <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>

  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'sans-serif'],
            outfit: ['Outfit', 'sans-serif'],
            mono: ['Fira Code', 'monospace'],
          },
          colors: {
            brand: {
              50: '#f0fbf8',
              100: '#dcf6ed',
              500: '#10b981', // Neon Emerald
              600: '#059669',
              900: '#064e3b',
            },
            bgDark: '#0b0f19',
          }
        }
      }
    }
  </script>

  <style>
    body {
      font-family: 'Inter', sans-serif;
      transition: background-color 0.3s ease, color 0.3s ease;
    }

    html.dark body {
      background-color: #080c14;
      background-image: 
        radial-gradient(at 0% 0%, rgba(16, 185, 129, 0.05) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.05) 0px, transparent 50%);
    }

    html:not(.dark) body {
      background-color: #f8fafc;
      background-image: 
        radial-gradient(at 0% 0%, rgba(16, 185, 129, 0.05) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.03) 0px, transparent 50%);
    }

    /* Glassmorphism utility styles */
    html.dark .glass-panel {
      background: rgba(13, 20, 35, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    html:not(.dark) .glass-panel {
      background: rgba(248, 250, 252, 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(15, 23, 42, 0.08);
      box-shadow: 0 4px 30px rgba(0, 0, 0, 0.03);
    }

    html.dark .glass-input {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }

    html:not(.dark) .glass-input {
      background: rgba(15, 23, 42, 0.02);
      border: 1px solid rgba(15, 23, 42, 0.08);
    }

    .glass-input:focus {
      border-color: rgba(16, 185, 129, 0.5);
      box-shadow: 0 0 10px rgba(16, 185, 129, 0.15);
      outline: none;
    }

    /* Custom Scrollbar styling */
    ::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    ::-webkit-scrollbar-track {
      background: rgba(255, 255, 255, 0.01);
    }
    ::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.08);
      border-radius: 4px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.15);
    }

    /* Glowing borders */
    .neon-glow {
      box-shadow: 0 0 20px rgba(16, 185, 129, 0.1);
    }

    /* Spinner animation */
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .animate-spin-custom {
      animation: spin 1s linear infinite;
    }
  </style>
</head>
<body class="text-slate-800 dark:text-slate-100 h-screen overflow-hidden flex flex-col font-sans">

  <!-- Header -->
  <header class="glass-panel border-b border-slate-500/10 dark:border-white/5 px-6 py-4 flex items-center justify-between z-20">
    <div class="flex items-center space-x-3">
      <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-500 to-blue-500 flex items-center justify-center font-outfit font-bold text-xl text-white shadow-lg neon-glow">
        S
      </div>
      <div>
        <h1 class="font-outfit font-bold text-lg tracking-wide leading-tight text-slate-800 dark:text-slate-100">System Query Flow</h1>
        <p class="text-xs text-slate-500 dark:text-slate-400 font-medium">SysQlow-MCP • Knowledge Graph Dashboard</p>
      </div>
    </div>
    <div class="flex items-center space-x-4">
      <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2 animate-pulse"></span>
        Container SSE Port 50741 Active
      </span>
      
      <!-- Theme Selection Segmented Toggle -->
      <div class="flex items-center bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10 rounded-xl p-0.5 space-x-0.5">
        <button id="theme-btn-light" onclick="setTheme('light')" class="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white transition" title="Light Mode">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-12.728l.707.707m12.728 12.728l.707-.707M12 8a4 4 0 100 8 4 4 0 000-8z"></path></svg>
        </button>
        <button id="theme-btn-dark" onclick="setTheme('dark')" class="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white transition" title="Dark Mode">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path></svg>
        </button>
        <button id="theme-btn-system" onclick="setTheme('system')" class="p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white transition" title="System Mode">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
        </button>
      </div>

      <label class="flex items-center space-x-2 text-xs font-medium text-slate-600 dark:text-slate-300">
        <span class="uppercase tracking-wide text-[10px] text-slate-500 dark:text-slate-400">Project</span>
        <select id="projectFilter" onchange="applyProjectIdFilter()" class="px-2 py-1 rounded-lg bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10 hover:bg-slate-500/10 dark:hover:bg-white/10 transition text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-brand-500">
          <option value="all">All</option>
          <option value="generic">Generic only</option>
        </select>
      </label>

      <button onclick="refreshData()" class="px-3.5 py-1.5 rounded-lg bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10 hover:bg-slate-500/10 dark:hover:bg-white/10 transition text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center space-x-2">
        <svg class="w-4 h-4 text-slate-500 dark:text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18"></path></svg>
        <span>Refresh</span>
      </button>
    </div>
  </header>

  <!-- Main Grid -->
  <main class="flex-1 flex overflow-hidden p-6 gap-6 relative">
    
    <!-- Left: Graph Panel -->
    <section class="flex-1 flex flex-col glass-panel rounded-2xl overflow-hidden relative neon-glow">
      <div class="px-5 py-4 border-b border-slate-500/10 dark:border-white/5 flex items-center justify-between">
        <div class="flex items-center space-x-2.5">
          <span class="text-brand-500">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path></svg>
          </span>
          <h2 class="font-outfit font-semibold text-base text-slate-800 dark:text-slate-100">Knowledge Graph Relations</h2>
        </div>
      </div>
      
      <!-- Graph Canvas Container -->
      <div id="mynetwork" class="flex-1 w-full h-full cursor-grab active:cursor-grabbing"></div>
      
      <!-- Stabilizing Layout Indicator Overlay -->
      <div id="graph-loader" class="absolute top-4 right-4 px-3.5 py-2 rounded-xl glass-panel text-[10px] text-slate-500 dark:text-slate-400 flex items-center space-x-2.5 transition-opacity duration-300 opacity-0 pointer-events-none neon-glow z-10">
        <svg class="w-3.5 h-3.5 animate-spin-custom text-brand-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>
        <span class="font-semibold tracking-wide uppercase">Stabilizing Layout...</span>
      </div>

      <!-- Legend/Floating Control Overlay -->
      <div class="absolute bottom-4 left-4 p-4 rounded-2xl glass-panel text-[11px] text-slate-500 dark:text-slate-400 w-64 space-y-4 shadow-xl neon-glow z-10">
        <!-- Live Graph Statistics -->
        <div>
          <p class="font-outfit font-bold text-slate-700 dark:text-slate-200 text-xs mb-2 tracking-wide uppercase">Graph Analytics</p>
          <div class="grid grid-cols-2 gap-2 text-[10px] font-semibold">
            <div class="p-2 rounded-xl bg-emerald-500/10 dark:bg-emerald-500/15 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 flex items-center justify-between">
              <span>Validated</span>
              <span id="stat-validated" class="font-bold text-xs">0</span>
            </div>
            <div class="p-2 rounded-xl bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-between">
              <span>Pending</span>
              <span id="stat-pending" class="font-bold text-xs">0</span>
            </div>
            <div class="p-2 rounded-xl bg-blue-500/10 dark:bg-blue-500/15 border border-blue-500/20 text-blue-600 dark:text-blue-400 flex items-center justify-between col-span-2">
              <span class="flex items-center"><span class="w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 animate-pulse"></span>Project Context</span>
              <span id="stat-context" class="font-bold text-xs">0</span>
            </div>
          </div>
        </div>

        <!-- Project Filters (Option D) -->
        <div id="project-filters-container" class="pt-3 border-t border-slate-500/10 dark:border-white/5 hidden">
          <p class="font-outfit font-bold text-slate-700 dark:text-slate-200 text-xs mb-2 tracking-wide uppercase">Project Filters</p>
          <div id="project-checkboxes" class="space-y-1.5 max-h-32 overflow-y-auto pr-1"></div>
        </div>

        <!-- Layout Controls -->
        <div class="pt-3 border-t border-slate-500/10 dark:border-white/5 space-y-2.5">
          <div class="flex items-center justify-between text-[10px] text-slate-600 dark:text-slate-400 font-medium">
            <span>Freeze Node Layout</span>
            <button id="physics-toggle-btn" onclick="togglePhysics()" class="relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-slate-300 dark:bg-slate-750 transition-colors duration-200 ease-in-out focus:outline-none" role="switch" aria-checked="false">
              <span id="physics-toggle-dot" class="pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out translate-x-0"></span>
            </button>
          </div>
          
          <button onclick="centerGraph()" class="w-full py-2 px-3 rounded-lg bg-brand-500/15 border border-brand-500/30 hover:bg-brand-500/25 active:bg-brand-500/35 transition text-brand-500 dark:text-brand-400 font-bold flex items-center justify-center space-x-1.5 text-[10px]">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"></path></svg>
            <span>Recenter & Fit View</span>
          </button>
        </div>
      </div>
    </section>

    <!-- Right: Administrative Pane (Logs & Env Stacked) -->
    <section class="w-[380px] flex flex-col gap-6 overflow-hidden">
      
      <!-- Top: Live MCP Logs Terminal -->
      <article class="flex-1 min-h-0 flex flex-col glass-panel rounded-2xl overflow-hidden">
        <div class="px-5 py-3 border-b border-slate-500/10 dark:border-white/5 flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            <h3 class="font-outfit font-semibold text-sm text-slate-800 dark:text-slate-100">Real-time MCP Log Terminal</h3>
          </div>
          <button onclick="fetchLogs()" class="text-xs text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white transition">Clear & Poll</button>
        </div>
        <!-- Terminal Body -->
        <div id="terminal" class="flex-1 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto bg-[#05080f] text-slate-300 space-y-1">
          <div class="text-slate-500">[System] Initializing terminal buffer...</div>
        </div>
      </article>

      <!-- Bottom: Env Configurations -->
      <article class="flex-1 min-h-0 flex flex-col glass-panel rounded-2xl overflow-hidden">
        <div class="px-5 py-3 border-b border-slate-500/10 dark:border-white/5">
          <h3 class="font-outfit font-semibold text-sm text-slate-800 dark:text-slate-100">Container Environment Variables</h3>
        </div>
        <!-- Variables List -->
        <div id="env-list" class="flex-1 overflow-y-auto p-4 space-y-2 text-xs">
          <div class="text-slate-500 text-center py-4">Loading active env variables...</div>
        </div>
      </article>

    </section>

    <!-- Sliding Sidebar Details Panel -->
    <section id="sidebar" class="absolute top-0 right-0 h-full w-[480px] glass-panel border-l border-slate-500/10 dark:border-white/5 shadow-2xl z-30 transform translate-x-full transition-transform duration-300 flex flex-col">
      <!-- Sidebar Header -->
      <div class="p-6 border-b border-slate-500/10 dark:border-white/5 flex items-center justify-between">
        <h2 id="side-topic" class="font-outfit font-bold text-base text-slate-800 dark:text-slate-100 pr-4 truncate">Snippet Details</h2>
        <button onclick="closeSidebar()" class="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white p-1 rounded-lg hover:bg-slate-500/10 dark:hover:bg-white/5 transition">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>

      <!-- Sidebar Content Body -->
      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        
        <!-- Metadata Badges Grid -->
        <div class="grid grid-cols-2 gap-4 text-xs">
          <div class="p-3.5 rounded-xl bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10">
            <span class="text-slate-500 dark:text-slate-400 block mb-0.5">Category</span>
            <span id="side-category" class="font-semibold text-slate-700 dark:text-slate-200">None</span>
          </div>
          <div class="p-3.5 rounded-xl bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10">
            <span class="text-slate-500 dark:text-slate-400 block mb-0.5">Validation Rating</span>
            <span id="side-confidence" class="font-semibold text-slate-700 dark:text-slate-200">0 / 10</span>
          </div>
          <div class="p-3.5 rounded-xl bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10 col-span-2">
            <span class="text-slate-500 dark:text-slate-400 block mb-0.5">Validation Status</span>
            <div class="flex items-center space-x-2 mt-1">
              <span id="side-status-indicator" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
              <span id="side-status-text" class="font-bold uppercase tracking-wider text-[10px] text-slate-700 dark:text-slate-200">Unvalidated</span>
            </div>
          </div>
        </div>

        <!-- Code/Content Snippet -->
        <div class="space-y-2">
          <span class="text-xs text-slate-500 dark:text-slate-400 block font-medium">Stored Knowledge Snippet</span>
          <pre id="side-content" class="p-4 rounded-xl bg-[#05080f] border border-slate-500/10 dark:border-white/5 font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap max-h-[300px] text-slate-200"></pre>
        </div>

        <!-- Validation Controls -->
        <div class="p-5 rounded-2xl bg-brand-500/5 border border-brand-500/10 space-y-4">
          <div>
            <h4 class="text-xs font-semibold text-slate-800 dark:text-slate-200">Sentinel Validation Controls</h4>
            <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-normal">Cross-references this stored snippet against the latest live web documentation using Gemini API.</p>
          </div>
          <button id="validate-btn" onclick="runValidation()" class="w-full py-2.5 px-4 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 transition rounded-xl font-semibold text-xs flex items-center justify-center space-x-2 text-white">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
            <span>Trigger Sentinel Audit</span>
          </button>
        </div>

        <!-- Live Audit Report Container (Hidden until validate) -->
        <div id="report-container" class="hidden space-y-3 p-4 rounded-xl bg-slate-500/5 dark:bg-white/5 border border-slate-500/10 dark:border-white/10">
          <h4 class="text-xs font-bold text-slate-800 dark:text-slate-200">Validation Report Output</h4>
          <div class="text-[11px] space-y-2 leading-relaxed">
            <p id="report-source" class="text-brand-500 truncate"></p>
            <p id="report-reasoning" class="text-slate-600 dark:text-slate-400"></p>
            <div id="report-diff-box" class="hidden">
              <span class="text-slate-500 dark:text-slate-400 block mb-1">Suggested Update Diff:</span>
              <div id="report-diff" class="p-3 rounded-lg bg-[#05080f] font-mono text-[10px] leading-relaxed overflow-x-auto border border-slate-500/10 dark:border-white/5 space-y-0.5"></div>
            </div>
          </div>
        </div>

      </div>
    </section>

  </main>

  <!-- Vis.js Initialization & API Core Script -->
  <script type="text/javascript">
    let network = null;
    let selectedNodeId = null;
    let nodesDataSet = null;
    let edgesDataSet = null;
    let nodesView = null;
    let edgesView = null;
    let activeProjectFilters = new Set();
    let discoveredProjects = new Set();
    let discoveredProjectIds = new Set();
    let selectedProjectId = "all";

    function applyProjectIdFilter() {
      const sel = document.getElementById("projectFilter");
      selectedProjectId = sel ? sel.value : "all";
      if (nodesView) nodesView.refresh();
      if (edgesView) edgesView.refresh();
    }

    // Theme Switcher core logic
    function setTheme(theme) {
      localStorage.setItem('theme', theme);
      
      const root = document.documentElement;
      let isDark = theme === 'dark';
      
      if (theme === 'system') {
        isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      }
      
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
      
      // Highlight the selected segment tab with premium active styles
      ['light', 'dark', 'system'].forEach(t => {
        const btn = document.getElementById(\`theme-btn-\${t}\`);
        if (t === theme) {
          btn.className = "p-1.5 rounded-lg bg-brand-500/10 dark:bg-brand-500/20 text-brand-500 border border-brand-500/30 transition shadow-sm scale-105";
        } else {
          btn.className = "p-1.5 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-white border border-transparent transition";
        }
      });

      // Redraw the graph so edge and text labels pick up the theme-appropriate contrast colors
      if (network) {
        refreshData();
      }
    }

    // A. Main Initialization
    document.addEventListener("DOMContentLoaded", () => {
      const savedTheme = localStorage.getItem('theme') || 'system';
      setTheme(savedTheme);
      
      // Live system preference change listener
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (localStorage.getItem('theme') === 'system') {
          setTheme('system');
        }
      });

      refreshData();
      fetchLogs();
      fetchEnv();
      
      // Auto-poll logs every 4 seconds
      setInterval(fetchLogs, 4000);
    });

    let physicsEnabled = true;

    function togglePhysics() {
      physicsEnabled = !physicsEnabled;
      
      const btn = document.getElementById("physics-toggle-btn");
      const dot = document.getElementById("physics-toggle-dot");
      
      if (physicsEnabled) {
        btn.className = "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-brand-500 transition-colors duration-200 ease-in-out focus:outline-none";
        dot.className = "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out translate-x-4";
        if (network) {
          network.setOptions({ physics: { enabled: true } });
        }
      } else {
        btn.className = "relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent bg-slate-300 dark:bg-slate-700 transition-colors duration-200 ease-in-out focus:outline-none";
        dot.className = "pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out translate-x-0";
        if (network) {
          network.setOptions({ physics: { enabled: false } });
        }
      }
    }

    function toggleProjectFilter(project) {
      if (activeProjectFilters.has(project)) {
        activeProjectFilters.delete(project);
      } else {
        activeProjectFilters.add(project);
      }
      
      // Update checkbox visual states
      const checkbox = document.querySelector(\`input[value="\${project}"]\`);
      if (checkbox) {
        checkbox.checked = activeProjectFilters.has(project);
      }

      if (nodesView) {
        nodesView.refresh();
      }
      if (edgesView) {
        edgesView.refresh();
      }
    }

    function formatDiff(diffText) {
      if (!diffText) return "";
      
      const lines = diffText.split("\\n");
      return lines.map(line => {
        let bgClass = "";
        let textClass = "text-slate-350 dark:text-slate-300";
        
        if (line.startsWith("+") && !line.startsWith("+++")) {
          bgClass = "bg-emerald-500/10 dark:bg-emerald-500/20 border-l-2 border-emerald-500 pl-1.5";
          textClass = "text-emerald-600 dark:text-emerald-400 font-medium";
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          bgClass = "bg-rose-500/10 dark:bg-rose-500/20 border-l-2 border-rose-500 pl-1.5";
          textClass = "text-rose-600 dark:text-rose-400 font-medium";
        } else if (line.startsWith("@@")) {
          bgClass = "bg-blue-500/5 dark:bg-blue-500/10 pl-1.5";
          textClass = "text-blue-500 dark:text-blue-400 font-semibold";
        } else if (line.startsWith("---") || line.startsWith("+++")) {
          bgClass = "bg-slate-500/5 dark:bg-white/5 pl-1.5";
          textClass = "text-slate-500 dark:text-slate-400 font-semibold";
        } else {
          bgClass = "pl-2";
        }
        
        const escapedLine = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
          
        return \`<div class="\${bgClass} \${textClass} py-0.5 min-h-[1.5rem]">\${escapedLine}</div>\`;
      }).join("");
    }

    // B. Fetch Graph Data
    async function refreshData() {
      try {
        const res = await fetch("/api/graph");
        const data = await res.json();
        
        const isDark = document.documentElement.classList.contains("dark");
        const nodeTextColor = isDark ? "#ffffff" : "#0f172a";
        
        let validatedCount = 0;
        let pendingCount = 0;
        let contextCount = 0;

        // Structure nodes for Vis.js
        const visNodes = data.nodes.map(n => {
          let colorBg = "rgba(245, 158, 11, 0.12)"; // Outdated / Pending (Amber)
          let colorBorder = "rgba(245, 158, 11, 0.5)";
          let highlightBorder = "#f59e0b";
          let labelPrefix = "⚠️  ";
          
          if (n.category === "Project Context") {
            colorBg = "rgba(59, 130, 246, 0.12)"; // Blue
            colorBorder = "rgba(59, 130, 246, 0.5)";
            highlightBorder = "#3b82f6";
            labelPrefix = "🧠  ";
            contextCount++;
          } else if (n.validated === 1 || n.validated === true) {
            colorBg = "rgba(16, 185, 129, 0.12)"; // Green (validated)
            colorBorder = "rgba(16, 185, 129, 0.5)";
            highlightBorder = "#10b981";
            labelPrefix = "✅  ";
            validatedCount++;
          } else {
            pendingCount++;
          }

          return {
            id: n.id,
            label: labelPrefix + n.label,
            color: {
              background: isDark ? colorBg : "rgba(255, 255, 255, 0.95)",
              border: colorBorder,
              highlight: {
                background: isDark ? colorBg.replace("0.12", "0.22") : "rgba(255, 255, 255, 0.98)",
                border: highlightBorder
              },
              hover: {
                background: isDark ? colorBg.replace("0.12", "0.22") : "rgba(255, 255, 255, 0.98)",
                border: highlightBorder
              }
            },
            font: {
              color: nodeTextColor,
              face: "Outfit",
              size: 13,
              bold: {
                color: nodeTextColor,
                size: 13,
                vadjust: 0
              }
            },
            shape: "box",
            margin: { top: 12, bottom: 12, left: 16, right: 16 },
            borderWidth: 1.5,
            borderWidthSelected: 2.5,
            shadow: {
              enabled: true,
              color: isDark ? "rgba(0,0,0,0.4)" : "rgba(15, 23, 42, 0.08)",
              size: 8,
              x: 0,
              y: 4
            },
            // Custom payload for details pane
            payload: n
          };
        });

        // Update live graph metrics
        document.getElementById("stat-validated").innerText = validatedCount;
        document.getElementById("stat-pending").innerText = pendingCount;
        document.getElementById("stat-context").innerText = contextCount;

        // Dynamic edge colors matching the light/dark background contrast
        const categoryEdgeColor = isDark ? "rgba(255,255,255,0.08)" : "rgba(15, 23, 42, 0.08)";
        const mentionsEdgeColor = isDark ? "rgba(16, 185, 129, 0.4)" : "rgba(16, 185, 129, 0.6)";
        const labelFontColor = isDark ? "rgba(255,255,255,0.4)" : "rgba(15, 23, 42, 0.5)";

        // Structure edges
        const visEdges = data.edges.map(e => {
          const isCategory = e.label === "Same Category";
          return {
            from: e.from,
            to: e.to,
            arrows: isCategory ? undefined : { to: { enabled: true, scaleFactor: 0.8 } },
            dashes: isCategory,
            width: isCategory ? 1 : 2,
            color: {
              color: isCategory ? categoryEdgeColor : mentionsEdgeColor,
              highlight: "#10b981",
              hover: "#a855f7"
            },
            label: isCategory ? "" : e.label,
            font: {
              color: labelFontColor,
              size: 8,
              face: "Inter"
            },
            smooth: {
              enabled: true,
              type: "cubicBezier"
            }
          };
        });

        // Option D: Project Filters parsing
        const projects = new Set();
        data.nodes.forEach(n => {
          const labelStr = n.label || "";
          const parts = labelStr.split(":");
          if (parts.length > 1) {
            projects.add(parts[0].trim());
          }
        });

        // Initialize active filters on first load or when new projects are discovered
        let hasNewProjects = false;
        projects.forEach(p => {
          if (!discoveredProjects.has(p)) {
            discoveredProjects.add(p);
            activeProjectFilters.add(p);
            hasNewProjects = true;
          }
        });

        // Clean up project filters that no longer exist
        activeProjectFilters.forEach(p => {
          if (!projects.has(p)) {
            activeProjectFilters.delete(p);
            discoveredProjects.delete(p);
            hasNewProjects = true;
          }
        });

        // Task 19: populate the <select id="projectFilter"> from node.project_id.
        const projectIdsSeen = new Set();
        data.nodes.forEach(n => {
          if (n.project_id) projectIdsSeen.add(n.project_id);
        });
        const sel = document.getElementById("projectFilter");
        if (sel) {
          let needsRebuild = false;
          projectIdsSeen.forEach(pid => {
            if (!discoveredProjectIds.has(pid)) {
              discoveredProjectIds.add(pid);
              needsRebuild = true;
            }
          });
          discoveredProjectIds.forEach(pid => {
            if (!projectIdsSeen.has(pid)) {
              discoveredProjectIds.delete(pid);
              needsRebuild = true;
            }
          });
          if (needsRebuild) {
            const prior = selectedProjectId;
            sel.innerHTML = "";
            const allOpt = document.createElement("option");
            allOpt.value = "all";
            allOpt.textContent = "All";
            sel.appendChild(allOpt);
            const genericOpt = document.createElement("option");
            genericOpt.value = "generic";
            genericOpt.textContent = "Generic only";
            sel.appendChild(genericOpt);
            Array.from(discoveredProjectIds).sort().forEach(pid => {
              const opt = document.createElement("option");
              opt.value = pid;
              opt.textContent = String(pid).slice(0, 8) + "…";
              sel.appendChild(opt);
            });
            // Restore prior selection if still valid, else reset to "all".
            if (prior === "all" || prior === "generic" || discoveredProjectIds.has(prior)) {
              sel.value = prior;
            } else {
              sel.value = "all";
              selectedProjectId = "all";
            }
          }
        }

        // Render project checkboxes if there are projects
        const filterContainer = document.getElementById("project-filters-container");
        const checkboxList = document.getElementById("project-checkboxes");
        if (projects.size > 0) {
          filterContainer.classList.remove("hidden");
          if (hasNewProjects || checkboxList.innerHTML === "") {
            checkboxList.innerHTML = Array.from(projects).sort().map(proj => {
              const isChecked = activeProjectFilters.has(proj) ? "checked" : "";
              return \`
                <label class="flex items-center space-x-2 text-[10px] text-slate-655 dark:text-slate-400 cursor-pointer font-medium hover:text-slate-800 dark:hover:text-white transition">
                  <input type="checkbox" value="\${proj}" \${isChecked} onchange="toggleProjectFilter('\${proj}')" class="rounded border-slate-500/20 text-brand-500 focus:ring-brand-500">
                  <span class="truncate">\${proj}</span>
                </label>
              \`;
            }).join("");
          }
        } else {
          filterContainer.classList.add("hidden");
          checkboxList.innerHTML = "";
        }

        // Load Vis.js network using DataView for real-time filter reactivity
        const container = document.getElementById("mynetwork");
        nodesDataSet = new vis.DataSet(visNodes);
        edgesDataSet = new vis.DataSet(visEdges);

        nodesView = new vis.DataView(nodesDataSet, {
          filter: function(item) {
            // Project-ID dropdown filter (Task 19): composes with label-prefix filter below.
            const pid = item.payload ? item.payload.project_id : null;
            if (selectedProjectId === "generic") {
              if (pid != null) return false;
            } else if (selectedProjectId !== "all") {
              // Show the selected project's nodes AND generic (project_id == null) nodes.
              if (pid != null && pid !== selectedProjectId) return false;
            }

            const labelStr = item.payload.label || "";
            const parts = labelStr.split(":");
            if (parts.length > 1) {
              const prefix = parts[0].trim();
              return activeProjectFilters.has(prefix);
            }
            return true;
          }
        });

        edgesView = new vis.DataView(edgesDataSet, {
          filter: function(item) {
            return nodesView.get(item.from) !== null && nodesView.get(item.to) !== null;
          }
        });

        const networkData = {
          nodes: nodesView,
          edges: edgesView
        };
        const options = {
          physics: {
            enabled: physicsEnabled,
            stabilization: {
              enabled: true,
              iterations: 150
            },
            barnesHut: {
              gravitationalConstant: -3500,
              centralGravity: 0.08,
              springLength: 180
            }
          },
          interaction: {
            hover: true,
            zoomView: true
          }
        };
        
        network = new vis.Network(container, networkData, options);

        // Physics layout loader states & auto-centering
        network.on("startStabilizing", () => {
          document.getElementById("graph-loader").classList.remove("opacity-0", "pointer-events-none");
        });
        
        network.on("stabilizationIterationsDone", () => {
          document.getElementById("graph-loader").classList.add("opacity-0", "pointer-events-none");
        });
        
        network.once("stabilized", () => {
          document.getElementById("graph-loader").classList.add("opacity-0", "pointer-events-none");
          centerGraph();
        });

        // Bind node click listener
        network.on("click", (params) => {
          if (params.nodes.length > 0) {
            const clickedNodeId = params.nodes[0];
            const clickedNode = visNodes.find(n => n.id === clickedNodeId);
            if (clickedNode) {
              openSidebar(clickedNode.payload);
            }
          }
        });

      } catch (err) {
        console.error("Failed to load graph data:", err);
      }
    }

    // Centering helper with premium animated transition
    function centerGraph() {
      if (network) {
        network.fit({
          animation: {
            duration: 800,
            easingFunction: "easeInOutQuad"
          }
        });
      }
    }

    // C. Sidebar Panel Logic
    function openSidebar(payload) {
      selectedNodeId = payload.id;
      
      document.getElementById("side-topic").innerText = payload.label;
      document.getElementById("side-category").innerText = payload.category || "None";
      document.getElementById("side-confidence").innerText = (payload.confidence || 0) + " / 10";
      document.getElementById("side-content").innerText = payload.content;

      // Status indicator style
      const indicator = document.getElementById("side-status-indicator");
      const statusText = document.getElementById("side-status-text");
      
      if (payload.category === "Project Context") {
        indicator.className = "w-2.5 h-2.5 rounded-full bg-blue-500";
        statusText.innerText = "PROJECT CONTEXT";
        statusText.className = "font-bold uppercase tracking-wider text-[10px] text-blue-400";
      } else if (payload.validated === 1 || payload.validated === true) {
        indicator.className = "w-2.5 h-2.5 rounded-full bg-emerald-500";
        statusText.innerText = "VALIDATED";
        statusText.className = "font-bold uppercase tracking-wider text-[10px] text-emerald-400";
      } else {
        indicator.className = "w-2.5 h-2.5 rounded-full bg-amber-500";
        statusText.innerText = "OUTDATED / PENDING";
        statusText.className = "font-bold uppercase tracking-wider text-[10px] text-amber-400";
      }

      // Hide audit output container initially
      document.getElementById("report-container").classList.add("hidden");

      // Slide-in
      const sidebar = document.getElementById("sidebar");
      sidebar.classList.remove("translate-x-full");
    }

    function closeSidebar() {
      selectedNodeId = null;
      const sidebar = document.getElementById("sidebar");
      sidebar.classList.add("translate-x-full");
    }

    // D. Trigger Sentinel Audit
    async function runValidation() {
      if (!selectedNodeId) return;

      const btn = document.getElementById("validate-btn");
      const originalText = btn.innerHTML;
      
      // Update UI button state to Spinner
      btn.disabled = true;
      btn.innerHTML = \`<svg class="w-4 h-4 animate-spin-custom" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> <span>Auditing Live Docs...</span>\`;

      try {
        const res = await fetch(\`/api/validate/\${selectedNodeId}\`, { method: "POST" });
        const data = await res.json();
        
        if (data.status === "success") {
          const rep = data.report;
          
          // Display Report Output
          document.getElementById("report-source").innerHTML = \`<a href="\${rep.source_url}" target="_blank" class="hover:underline">🔗 Reference: \${rep.source_url || "N/A"}</a>\`;
          document.getElementById("report-reasoning").innerText = rep.reasoning;
          
          const diffBox = document.getElementById("report-diff-box");
          if (rep.suggested_diff) {
            document.getElementById("report-diff").innerHTML = formatDiff(rep.suggested_diff);
            diffBox.classList.remove("hidden");
          } else {
            diffBox.classList.add("hidden");
          }

          document.getElementById("report-container").classList.remove("hidden");

          // Refresh main graph nodes to reflect new validation state immediately
          refreshData();
        } else {
          alert("Audit failed: " + data.message);
        }
      } catch (err) {
        alert("Audit failed: " + err.message);
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
      }
    }

    // E. Fetch Real-time MCP Logs
    async function fetchLogs() {
      try {
        const res = await fetch("/api/logs");
        const data = await res.json();
        
        const term = document.getElementById("terminal");
        
        if (data.logs.length === 0) {
          term.innerHTML = '<div class="text-slate-500">[System] No log entries recorded yet.</div>';
          return;
        }

        term.innerHTML = data.logs.map(line => {
          let color = "text-slate-300";
          if (line.includes("[ERROR]")) {
            color = "text-red-400";
          } else if (line.includes("[SysQlow Auto-Hook]") || line.includes("SUCCESS")) {
            color = "text-brand-500 font-bold";
          }
          return \`<div class="\${color}">\${line}</div>\`;
        }).join("");

        // Keep scroll at bottom
        term.scrollTop = term.scrollHeight;

      } catch (err) {
        console.error("Failed to read log stream:", err);
      }
    }

    // F. Fetch Masked Environment Configurations
    async function fetchEnv() {
      try {
        const res = await fetch("/api/env");
        const data = await res.json();
        
        const container = document.getElementById("env-list");
        
        const items = Object.entries(data.env).map(([key, val]) => {
          return \`
            <div class="p-2.5 rounded-xl bg-white/5 border border-white/5 flex items-center justify-between">
              <span class="font-mono text-slate-400 font-semibold truncate pr-4 text-[10px]">\${key}</span>
              <span class="font-mono text-[10px] text-slate-200 truncate bg-slate-900 px-2 py-1 rounded max-w-[200px]" title="\${val}">\${val}</span>
            </div>
          \`;
        }).join("");
 
        container.innerHTML = \`<div class="grid grid-cols-1 gap-2">\${items}</div>\`;

      } catch (err) {
        console.error("Failed to read env configuration:", err);
      }
    }
  </script>
</body>
</html>`;
