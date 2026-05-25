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
      background-color: #080c14;
      background-image: 
        radial-gradient(at 0% 0%, rgba(16, 185, 129, 0.05) 0px, transparent 50%),
        radial-gradient(at 100% 100%, rgba(59, 130, 246, 0.05) 0px, transparent 50%);
      font-family: 'Inter', sans-serif;
    }

    /* Glassmorphism utility styles */
    .glass-panel {
      background: rgba(13, 20, 35, 0.5);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(255, 255, 255, 0.06);
    }

    .glass-input {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
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
<body class="text-slate-100 min-h-screen overflow-hidden flex flex-col font-sans">

  <!-- Header -->
  <header class="glass-panel border-b px-6 py-4 flex items-center justify-between z-20">
    <div class="flex items-center space-x-3">
      <div class="w-9 h-9 rounded-xl bg-gradient-to-tr from-brand-500 to-blue-500 flex items-center justify-center font-outfit font-bold text-xl text-white shadow-lg neon-glow">
        S
      </div>
      <div>
        <h1 class="font-outfit font-bold text-lg tracking-wide leading-tight">System Query Flow</h1>
        <p class="text-xs text-slate-400 font-medium">SysQlow-MCP • Knowledge Graph Dashboard</p>
      </div>
    </div>
    <div class="flex items-center space-x-4">
      <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
        <span class="w-1.5 h-1.5 rounded-full bg-emerald-500 mr-2 animate-pulse"></span>
        Container SSE Port 50741 Active
      </span>
      <button onclick="refreshData()" class="px-3.5 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 transition text-sm font-medium flex items-center space-x-2">
        <svg class="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.253 8H18"></path></svg>
        <span>Refresh</span>
      </button>
    </div>
  </header>

  <!-- Main Grid -->
  <main class="flex-1 flex overflow-hidden p-6 gap-6 relative">
    
    <!-- Left: Graph Panel -->
    <section class="flex-1 flex flex-col glass-panel rounded-2xl overflow-hidden relative neon-glow">
      <div class="px-5 py-4 border-b border-white/5 flex items-center justify-between">
        <div class="flex items-center space-x-2.5">
          <span class="text-brand-500">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7"></path></svg>
          </span>
          <h2 class="font-outfit font-semibold text-base">Knowledge Graph Relations</h2>
        </div>
        <div class="flex items-center space-x-4 text-xs text-slate-400">
          <span class="flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500 mr-1.5"></span> Validated</span>
          <span class="flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-amber-500 mr-1.5"></span> Outdated / Pending</span>
          <span class="flex items-center"><span class="w-2.5 h-2.5 rounded-full bg-blue-500 mr-1.5"></span> Project Context</span>
        </div>
      </div>
      
      <!-- Graph Canvas Container -->
      <div id="mynetwork" class="flex-1 w-full h-full cursor-grab active:cursor-grabbing"></div>
      
      <!-- Legend/Control Overlay -->
      <div class="absolute bottom-4 left-4 p-3 rounded-lg glass-panel text-[11px] text-slate-400 max-w-xs space-y-1">
        <p class="font-bold text-slate-200">Interactive Controls:</p>
        <p>• Drag nodes to manually arrange</p>
        <p>• Scroll to zoom in/out</p>
        <p>• Click any node to open details & trigger Sentinel</p>
      </div>
    </section>

    <!-- Right: Administrative Pane (Logs & Env Stacked) -->
    <section class="w-[450px] flex flex-col gap-6 overflow-hidden">
      
      <!-- Top: Live MCP Logs Terminal -->
      <article class="flex-1 flex flex-col glass-panel rounded-2xl overflow-hidden max-h-[50%]">
        <div class="px-5 py-3 border-b border-white/5 flex items-center justify-between">
          <div class="flex items-center space-x-2">
            <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            <h3 class="font-outfit font-semibold text-sm">Real-time MCP Log Terminal</h3>
          </div>
          <button onclick="fetchLogs()" class="text-xs text-slate-400 hover:text-white transition">Clear & Poll</button>
        </div>
        <!-- Terminal Body -->
        <div id="terminal" class="flex-1 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto bg-[#05080f] text-slate-300 space-y-1">
          <div class="text-slate-500">[System] Initializing terminal buffer...</div>
        </div>
      </article>

      <!-- Bottom: Env Configurations -->
      <article class="flex-1 flex flex-col glass-panel rounded-2xl overflow-hidden max-h-[50%]">
        <div class="px-5 py-3 border-b border-white/5">
          <h3 class="font-outfit font-semibold text-sm">Container Environment Variables</h3>
        </div>
        <!-- Variables List -->
        <div id="env-list" class="flex-1 overflow-y-auto p-4 space-y-2 text-xs">
          <div class="text-slate-500 text-center py-4">Loading active env variables...</div>
        </div>
      </article>

    </section>

    <!-- Sliding Sidebar Details Panel -->
    <section id="sidebar" class="absolute top-0 right-0 h-full w-[480px] glass-panel border-l shadow-2xl z-30 transform translate-x-full transition-transform duration-300 flex flex-col">
      <!-- Sidebar Header -->
      <div class="p-6 border-b border-white/5 flex items-center justify-between">
        <h2 id="side-topic" class="font-outfit font-bold text-base text-slate-100 pr-4 truncate">Snippet Details</h2>
        <button onclick="closeSidebar()" class="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition">
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
        </button>
      </div>

      <!-- Sidebar Content Body -->
      <div class="flex-1 overflow-y-auto p-6 space-y-6">
        
        <!-- Metadata Badges Grid -->
        <div class="grid grid-cols-2 gap-4 text-xs">
          <div class="p-3.5 rounded-xl bg-white/5 border border-white/5">
            <span class="text-slate-400 block mb-0.5">Category</span>
            <span id="side-category" class="font-semibold text-slate-200">None</span>
          </div>
          <div class="p-3.5 rounded-xl bg-white/5 border border-white/5">
            <span class="text-slate-400 block mb-0.5">Validation Rating</span>
            <span id="side-confidence" class="font-semibold text-slate-200">0 / 10</span>
          </div>
          <div class="p-3.5 rounded-xl bg-white/5 border border-white/5 col-span-2">
            <span class="text-slate-400 block mb-0.5">Validation Status</span>
            <div class="flex items-center space-x-2 mt-1">
              <span id="side-status-indicator" class="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
              <span id="side-status-text" class="font-bold uppercase tracking-wider text-[10px]">Unvalidated</span>
            </div>
          </div>
        </div>

        <!-- Code/Content Snippet -->
        <div class="space-y-2">
          <span class="text-xs text-slate-400 block font-medium">Stored Knowledge Snippet</span>
          <pre id="side-content" class="p-4 rounded-xl bg-[#05080f] border border-white/5 font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap max-h-[300px] text-slate-200"></pre>
        </div>

        <!-- Validation Controls -->
        <div class="p-5 rounded-2xl bg-brand-500/5 border border-brand-500/10 space-y-4">
          <div>
            <h4 class="text-xs font-semibold text-slate-200">Sentinel Validation Controls</h4>
            <p class="text-[11px] text-slate-400 mt-1 leading-normal">Cross-references this stored snippet against the latest live web documentation using Gemini API.</p>
          </div>
          <button id="validate-btn" onclick="runValidation()" class="w-full py-2.5 px-4 bg-brand-500 hover:bg-brand-600 active:bg-brand-700 transition rounded-xl font-semibold text-xs flex items-center justify-center space-x-2 text-white">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
            <span>Trigger Sentinel Audit</span>
          </button>
        </div>

        <!-- Live Audit Report Container (Hidden until validate) -->
        <div id="report-container" class="hidden space-y-3 p-4 rounded-xl bg-white/5 border border-white/5">
          <h4 class="text-xs font-bold text-slate-200">Validation Report Output</h4>
          <div class="text-[11px] space-y-2 leading-relaxed">
            <p id="report-source" class="text-brand-500 truncate"></p>
            <p id="report-reasoning" class="text-slate-400"></p>
            <div id="report-diff-box" class="hidden">
              <span class="text-slate-400 block mb-1">Suggested Update Diff:</span>
              <pre id="report-diff" class="p-3 rounded-lg bg-black text-red-400 font-mono text-[10px] leading-relaxed overflow-x-auto whitespace-pre-wrap border border-white/5"></pre>
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

    // A. Main Initialization
    document.addEventListener("DOMContentLoaded", () => {
      refreshData();
      fetchLogs();
      fetchEnv();
      
      // Auto-poll logs every 4 seconds
      setInterval(fetchLogs, 4000);
    });

    // B. Fetch Graph Data
    async function refreshData() {
      try {
        const res = await fetch("/api/graph");
        const data = await res.json();
        
        // Structure nodes for Vis.js
        const visNodes = data.nodes.map(n => {
          let color = "#f59e0b"; // Outdated / Pending (Amber)
          if (n.category === "Project Context") {
            color = "#3b82f6"; // Blue
          } else if (n.validated === 1 || n.validated === true) {
            color = "#10b981"; // Green (validated)
          }

          return {
            id: n.id,
            label: n.label,
            color: {
              background: color,
              border: "#1e293b",
              highlight: {
                background: color,
                border: "#f8fafc"
              }
            },
            font: {
              color: "#f8fafc",
              face: "Inter"
            },
            shape: "box",
            margin: 12,
            borderWidth: 1.5,
            borderWidthSelected: 2,
            shadow: {
              enabled: true,
              color: "rgba(0,0,0,0.5)",
              size: 5
            },
            // Custom payload for details pane
            payload: n
          };
        });

        // Structure edges
        const visEdges = data.edges.map(e => {
          const isCategory = e.label === "Same Category";
          return {
            from: e.from,
            to: e.to,
            arrows: e.arrows || undefined,
            dashes: isCategory,
            color: {
              color: isCategory ? "rgba(255,255,255,0.08)" : "rgba(16, 185, 129, 0.4)",
              highlight: "#10b981"
            },
            label: isCategory ? "" : e.label,
            font: {
              color: "rgba(255,255,255,0.4)",
              size: 8,
              face: "Inter"
            },
            smooth: {
              enabled: true,
              type: "cubicBezier"
            }
          };
        });

        // Load Vis.js network
        const container = document.getElementById("mynetwork");
        const networkData = {
          nodes: new vis.DataSet(visNodes),
          edges: new vis.DataSet(visEdges)
        };
        const options = {
          physics: {
            stabilization: true,
            barnesHut: {
              gravitationalConstant: -2000,
              centralGravity: 0.3,
              springLength: 120
            }
          },
          interaction: {
            hover: true,
            zoomView: true
          }
        };
        
        network = new vis.Network(container, networkData, options);

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
            document.getElementById("report-diff").innerText = rep.suggested_diff;
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
              <span class="font-mono text-slate-400 font-semibold truncate pr-4 text-[10px]">${key}</span>
              <span class="font-mono text-[10px] text-slate-200 truncate bg-slate-900 px-2 py-1 rounded max-w-[200px]" title="${val}">${val}</span>
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
