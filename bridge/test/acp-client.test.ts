import assert from "node:assert/strict";
import { once } from "node:events";
import { tmpdir } from "node:os";
import test from "node:test";
import { AcpClient } from "../src/acp-client.ts";

test("ACP shutdown releases inherited pipes after its launcher exits", { timeout: 8_000 }, async () => {
  const source = `
    const {spawn}=require('node:child_process');
    const descendant=spawn(process.execPath,['-e','setTimeout(()=>{},2000)'],
      {windowsHide:true,stdio:['ignore',process.stdout,process.stderr]});
    descendant.unref();
    process.stdin.resume();
    process.stdin.once('end',()=>process.exit(0));
    process.stdout.write('ready\\n');
  `;
  const client = new AcpClient(process.execPath, ["-e", source], tmpdir());
  client.start();
  await once(client.child!.stdout, "data");
  const start = Date.now();
  await client.stop();
  assert.ok(Date.now() - start < 1_500, "shutdown must not wait for the descendant's pipes");
  assert.equal(client.child!.exitCode, 0);
  assert.equal(client.child!.killed, false);
  assert.equal(client.closed, true);
});
