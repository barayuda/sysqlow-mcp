import { spawn } from "child_process";
import { initDatabase, client } from "./db";

type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string; data?: any };
};

console.log("=== STARTING SYSQLOW-MCP WORKFLOW INTEGRATION TEST ===");

async function run() {
  await initDatabase();

  const uniqueSuffix = Date.now();
  const testTopic = `Workflow Integration Topic ${uniqueSuffix}`;
  const testQuery = `integration-${uniqueSuffix}`;
  const initialContent = `Initial workflow content for ${testQuery}`;
  const updatedContent = `Updated workflow content for ${testQuery}`;

  await client.execute({
    sql: "DELETE FROM technical_knowledge WHERE topic = ?",
    args: [testTopic],
  });

  const proc = spawn("bun", ["run", "src/index.ts"], {
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: JsonRpcMessage) => void; reject: (err: Error) => void }>();

  const send = (msg: JsonRpcMessage) => {
    proc.stdin.write(JSON.stringify(msg) + "\n");
  };

  const request = (method: string, params: any) => {
    const id = nextId++;
    const message: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<JsonRpcMessage>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send(message);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout waiting for response to ${method} (${id})`));
        }
      }, 120000);
    });
  };

  const parseWorkflowPayload = (rpcResponse: JsonRpcMessage): any => {
    const text = rpcResponse.result?.content?.find?.((c: any) => c?.type === "text")?.text;
    if (!text) {
      return rpcResponse.result;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  proc.stdout.on("data", (chunk) => {
    const lines = chunk
      .toString()
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean);

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const msg = parsed as JsonRpcMessage;

      if (msg.method === "roots/list" && msg.id) {
        send({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            roots: [
              {
                uri: `file://${process.cwd()}`,
                name: "sysqlow-mcp-workflow-test",
              },
            ],
          },
        });
        continue;
      }

      if (typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) {
          p.reject(new Error(`RPC ${msg.id} error: ${msg.error.message}`));
        } else {
          p.resolve(msg);
        }
      }
    }
  });

  proc.stderr.on("data", (chunk) => {
    const message = chunk.toString().trim();
    if (message) {
      console.log(`[Server Log] ${message}`);
    }
  });

  try {
    console.log("\n[1/7] Initializing MCP session...");
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        roots: { listChanged: true },
      },
      clientInfo: {
        name: "SysQlow-Workflow-Integration-Test",
        version: "1.0.0",
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    console.log("✔ MCP initialize handshake complete");

    console.log("\n[2/6] Calling knowledge_workflow intent=save...");
    const saveResp = await request("tools/call", {
      name: "knowledge_workflow",
      arguments: {
        intent: "save",
        topic: testTopic,
        content: initialContent,
        category: "api",
      },
    });
    const savePayload = parseWorkflowPayload(saveResp);
    if (!savePayload || savePayload.status !== "success") {
      throw new Error(`save intent did not succeed: ${JSON.stringify(savePayload)}`);
    }
    console.log(`✔ save intent success (id: ${savePayload.id})`);

    console.log("\n[3/6] Verifying normalized category in database...");
    const dbSaved = await client.execute({
      sql: "SELECT id, category FROM technical_knowledge WHERE topic = ?",
      args: [testTopic],
    });
    if (dbSaved.rows.length === 0) {
      throw new Error("Saved row was not found in database");
    }
    const savedId = String(dbSaved.rows[0].id);
    const savedCategory = String(dbSaved.rows[0].category || "");
    if (savedCategory !== "Backend") {
      throw new Error(`Expected normalized category Backend, got: ${savedCategory}`);
    }
    console.log("✔ category normalization verified (api -> Backend)");

    console.log("\n[4/6] Calling knowledge_workflow intent=search...");
    const searchResp = await request("tools/call", {
      name: "knowledge_workflow",
      arguments: {
        intent: "search",
        query: testQuery,
        category: "server",
      },
    });
    const searchPayload = parseWorkflowPayload(searchResp);
    if (!searchPayload || searchPayload.status !== "success" || Number(searchPayload.count) < 1) {
      throw new Error(`search intent did not return expected results: ${JSON.stringify(searchPayload)}`);
    }
    console.log(`✔ search intent success (count: ${searchPayload.count})`);

    console.log("\n[5/6] Calling knowledge_workflow intent=apply (without revalidation)...");
    const applyResp = await request("tools/call", {
      name: "knowledge_workflow",
      arguments: {
        intent: "apply",
        id: savedId,
        content: updatedContent,
        revalidateBeforeCommit: false,
      },
    });
    const applyPayload = parseWorkflowPayload(applyResp);
    if (!applyPayload || applyPayload.status !== "success") {
      throw new Error(`apply intent did not succeed: ${JSON.stringify(applyPayload)}`);
    }
    console.log("✔ apply intent success");

    console.log("\n[6/6] Calling knowledge_workflow intent=validate (deterministic input validation path)...");
    const validateResp = await request("tools/call", {
      name: "knowledge_workflow",
      arguments: {
        intent: "validate",
      },
    });
    const validatePayload = parseWorkflowPayload(validateResp);
    const validateText = typeof validatePayload === "string" ? validatePayload : JSON.stringify(validatePayload);
    if (!validateText.includes("For intent=validate, id is required.")) {
      throw new Error(`validate intent did not hit expected deterministic path: ${validateText}`);
    }
    console.log("✔ validate intent input-path executed as expected");

    console.log("\n[7/7] Calling knowledge_workflow intent=list...");
    const listResp = await request("tools/call", {
      name: "knowledge_workflow",
      arguments: {
        intent: "list",
      },
    });
    const listPayload = parseWorkflowPayload(listResp);
    if (!listPayload || listPayload.status !== "success" || Number(listPayload.count) < 1) {
      throw new Error(`list intent did not return expected results: ${JSON.stringify(listPayload)}`);
    }
    console.log(`✔ list intent success (count: ${listPayload.count})`);

    const dbUpdated = await client.execute({
      sql: "SELECT content, is_validated FROM technical_knowledge WHERE id = ?",
      args: [savedId],
    });
    if (dbUpdated.rows.length === 0) {
      throw new Error("Updated row not found after apply");
    }
    const finalContent = String(dbUpdated.rows[0].content || "");
    const finalValidated = Number(dbUpdated.rows[0].is_validated || 0);
    if (finalContent !== updatedContent) {
      throw new Error("Final content mismatch after apply intent");
    }
    if (finalValidated !== 1) {
      throw new Error("Expected is_validated=1 after apply intent");
    }

    console.log("\n🎉 SUCCESS: knowledge_workflow integration test passed");
    process.exit(0);
  } catch (err: any) {
    console.error("\n❌ WORKFLOW TEST FAILED:", err.message);
    process.exit(1);
  } finally {
    for (const [id, p] of pending.entries()) {
      p.reject(new Error(`Terminated before response for request ${id}`));
      pending.delete(id);
    }
    proc.kill("SIGTERM");
  }
}

run().catch((err: any) => {
  console.error("Fatal workflow test error:", err.message);
  process.exit(1);
});
