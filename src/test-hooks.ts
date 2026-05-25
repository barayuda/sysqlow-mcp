import { spawn } from "child_process";
import { initDatabase, client } from "./db";

console.log("=== STARTING SYSQLOW-MCP AUTOMATED HOOKS E2E TEST ===");

async function run() {
  // 1. Reset database to ensure we verify fresh ingestion
  await initDatabase();
  console.log("\n🧹 Cleaning old Project Context records...");
  await client.execute({
    sql: "DELETE FROM technical_knowledge WHERE category = 'Project Context'",
    args: []
  });

  // 2. Spawn the MCP server in standard stdio attached mode
  console.log("🚀 Spawning MCP server process...");
  const serverProc = spawn("bun", ["run", "src/index.ts"], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio" // Force stdio
    }
  });

  // Keep track of JSON-RPC messaging
  let initializedSent = false;

  serverProc.stderr.on("data", (data) => {
    // Print server logs (error channel is used for console logs by FastMCP in stdio mode)
    const logStr = data.toString().trim();
    if (logStr.length > 0) {
      console.log(`[Server Log] ${logStr}`);
    }
  });

  // Handle standard input/output streams
  serverProc.stdout.on("data", async (data) => {
    const chunk = data.toString().trim();
    const lines = chunk.split("\n");

    for (const line of lines) {
      if (line.trim().length === 0) continue;
      
      try {
        const msg = JSON.parse(line);
        // console.log(`[Client Received]`, msg);

        // A. Handle Server's response to our initialize request
        if (msg.id === 1 && msg.result && !initializedSent) {
          console.log("✔ Received initialize response from server. Sending initialized notification...");
          
          const initializedNotif = {
            jsonrpc: "2.0",
            method: "notifications/initialized"
          };
          serverProc.stdin.write(JSON.stringify(initializedNotif) + "\n");
          initializedSent = true;
        }

        // B. Handle Server's request to list roots
        if (msg.method === "roots/list") {
          console.log(`✔ Server requested roots/list (ID: ${msg.id}). Replying with workspace roots...`);
          
          const rootsResponse = {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              roots: [
                {
                  uri: `file://${process.cwd()}`,
                  name: "sysqlow-mcp-e2e-test"
                }
              ]
            }
          };
          serverProc.stdin.write(JSON.stringify(rootsResponse) + "\n");
        }
      } catch (err) {
        // Not JSON, ignore
      }
    }
  });

  // 3. Initiate the MCP Handshake by writing the initialize request
  console.log("🤝 Initiating MCP Handshake...");
  const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: {
          listChanged: true
        }
      },
      clientInfo: {
        name: "SysQlow-Test-Client",
        version: "1.0.0"
      }
    }
  };

  serverProc.stdin.write(JSON.stringify(initRequest) + "\n");

  // 4. Wait for the handshake, root query, and background learnCodebase to complete using dynamic polling (up to 45s)
  console.log("⏳ Waiting for automated scanning and Turso replica syncing to complete (polling every 2s)...");
  
  let success = false;
  let dbRes: any = null;
  const startTime = Date.now();
  const maxWaitMs = 45000;
  
  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    
    try {
      dbRes = await client.execute({
        sql: "SELECT topic, category FROM technical_knowledge WHERE category = 'Project Context'",
        args: []
      });
      
      if (dbRes.rows.length > 0) {
        success = true;
        break;
      }
    } catch (_) {
      // Ignore database locks/conflicts during simultaneous writes
    }
  }

  // 5. Query database to verify rows were automatically created by the hooks
  console.log("\n🔎 Querying database for newly ingested Project Context...");
  
  console.log(`\n📊 Verification Summary:`);
  console.log(`  Found ${dbRes?.rows.length || 0} 'Project Context' rows.`);
  
  if (dbRes && dbRes.rows.length > 0) {
    for (const r of dbRes.rows) {
      console.log(`    - Topic: "${r.topic}"`);
    }
  }

  // 6. Tear down the server process
  console.log("\n⏹️  Stopping MCP server process...");
  serverProc.kill("SIGTERM");

  if (success) {
    console.log("\n🎉 SUCCESS: Automated ready hook triggered and learned the codebase perfectly!");
    process.exit(0);
  } else {
    console.log("\n❌ FAILURE: No project context was ingested automatically.");
    process.exit(1);
  }
}

run().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
