import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:tls";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { process, root } from "./lib/paths.js";
import { run } from "./lib/spawn.js";
import {
  createCompatibilityFixture,
  probeCompatibilityFixture,
} from "../tests/mail/compatibility-fixture.mjs";

// Failure inventory: prerequisite, certificate, protocol and cleanup failures
// must leave redacted evidence. Bridge runs even when Docker is unavailable.
const bridgeOnly = process.argv.includes("--bridge-only");
const reportDirectory = join(root, "artifacts/mail-integration");
const report = {
  schemaVersion: 1,
  commit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  worktreeDirty:
    execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
    }).trim().length > 0,
  mode: bridgeOnly ? "bridge-only" : "full",
  startedAt: new Date().toISOString(),
  fixtureVersions: { greenmail: "2.1.11", compatibility: "6" },
  commands: [],
  results: [],
  status: "running",
};
let temporary;
let environment;
let stage = "openssl-prerequisite";
let greenmailStarted = false;
const fixtures = [];
const compose = join(root, "tests/mail/docker-compose.yml");
const project = "postal-snap-mail-test";
async function recordedRun(command, args, options) {
  report.commands.push({
    command,
    args: args.map((arg) =>
      temporary
        ? arg.replaceAll(temporary, "<temporary>").replaceAll(root, "<repo>")
        : arg.replaceAll(root, "<repo>"),
    ),
  });
  return run(
    command,
    args,
    command === "openssl" && args[0] !== "version"
      ? { stdio: "ignore", ...options }
      : options,
  );
}
async function protocolTest(name, env) {
  await recordedRun(
    "cargo",
    [
      "test",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      `mail::tests::${name}`,
      "--",
      "--ignored",
      "--exact",
      "--nocapture",
    ],
    { env },
  );
}

try {
  await recordedRun("openssl", ["version"]);
  temporary = await mkdtemp(join(tmpdir(), "postal-snap-mail-test-"));
  const key = join(temporary, "server.key");
  const certificate = join(temporary, "server.pem");
  const store = join(temporary, "server.p12");
  environment = {
    ...process.env,
    POSTAL_SNAP_GREENMAIL_P12: store,
    POSTAL_SNAP_MAIL_TEST_CA_CERT: certificate,
  };
  stage = "certificate-generation";
  await recordedRun("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    certificate,
    "-days",
    "2",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "extendedKeyUsage=serverAuth",
  ]);

  const expired = join(temporary, "expired.pem");
  const expiredRequest = join(temporary, "expired.csr");
  const authorityConfig = join(temporary, "expiry-ca.cnf");
  await writeFile(join(temporary, "expiry-index.txt"), "");
  await writeFile(join(temporary, "expiry-serial.txt"), "01\n");
  const configPath = (value) => `"${value.replaceAll("\\", "/")}"`;
  await writeFile(
    authorityConfig,
    `[ca]\ndefault_ca=fixture_ca\n[fixture_ca]\ndatabase=${configPath(join(temporary, "expiry-index.txt"))}\nserial=${configPath(join(temporary, "expiry-serial.txt"))}\nnew_certs_dir=${configPath(temporary)}\ncertificate=${configPath(certificate)}\nprivate_key=${configPath(key)}\ndefault_md=sha256\npolicy=fixture_policy\nx509_extensions=fixture_ext\n[fixture_policy]\ncommonName=supplied\n[fixture_ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  await recordedRun("openssl", [
    "req",
    "-new",
    "-key",
    key,
    "-out",
    expiredRequest,
    "-subj",
    "/CN=localhost",
  ]);
  await recordedRun("openssl", [
    "ca",
    "-batch",
    "-config",
    authorityConfig,
    "-in",
    expiredRequest,
    "-out",
    expired,
    "-startdate",
    "20200101000000Z",
    "-enddate",
    "20200102000000Z",
    "-notext",
  ]);
  environment.POSTAL_SNAP_BRIDGE_EXPIRED_CERT = expired;
  environment.POSTAL_SNAP_BRIDGE_PRIVATE_KEY = key;

  stage = "bridge-fixture-start";
  for (const name of [
    "TLS",
    "STARTTLS",
    "MISMATCH",
    "WRONG_HOST",
    "NO_STARTTLS",
  ]) {
    let certificatePath = certificate;
    let keyPath = key;
    if (["MISMATCH", "WRONG_HOST"].includes(name)) {
      certificatePath = join(temporary, `${name}.pem`);
      keyPath = join(temporary, `${name}.key`);
      const csr = join(temporary, `${name}.csr`);
      const extensions = join(temporary, `${name}.ext`);
      const san =
        name === "MISMATCH"
          ? "DNS:localhost,IP:127.0.0.1"
          : "DNS:wrong.example.test";
      await writeFile(
        extensions,
        `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
      );
      await recordedRun("openssl", [
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        csr,
        "-subj",
        "/CN=localhost",
      ]);
      await recordedRun("openssl", [
        "x509",
        "-req",
        "-in",
        csr,
        "-CA",
        certificate,
        "-CAkey",
        key,
        "-CAcreateserial",
        "-out",
        certificatePath,
        "-days",
        "2",
        "-extfile",
        extensions,
      ]);
    }
    const fixture = await createCompatibilityFixture({
      certificatePath,
      keyPath,
      tlsMode: name.includes("STARTTLS") ? "startTls" : "tls",
      capabilities:
        name === "STARTTLS"
          ? ["IMAP4rev1", "QRESYNC", "CONDSTORE"]
          : ["IMAP4rev1"],
      advertiseStartTls: name !== "NO_STARTTLS",
      rejectStartTls: name === "NO_STARTTLS",
      allowRestartCommand: name === "STARTTLS",
    });
    fixtures.push({ name, fixture });
    const ports = await fixture.start();
    environment[`POSTAL_SNAP_BRIDGE_IMAP_${name}`] = String(ports.imap);
    environment[`POSTAL_SNAP_BRIDGE_SMTP_${name}`] = String(ports.smtp);
  }
  stage = "bridge-recovery-fixture-start";
  const recoveryFixture = await createCompatibilityFixture({
    certificatePath: certificate,
    keyPath: key,
    tlsMode: "tls",
    capabilities: ["IMAP4rev1", "UIDPLUS"],
    allowRestartCommand: true,
    folderNames: [
      "INBOX",
      "Archive",
      "Archive/受信",
      "Drafts",
      "Projects",
      "Projects/日本語",
      "&ZeVnLIqe-",
    ],
    messages: {
      INBOX: [
        {
          uid: 1,
          messageId: "<uid-generation@example.test>",
          subject: "Before reconnect",
          subjectAfterRestart: "After reconnect",
          body: "UID generation fixture",
        },
      ],
      "Projects/日本語": [
        {
          uid: 1,
          messageId: "<nested-project@example.test>",
          subject: "Project fixture",
          body: "Nested Unicode fixture",
        },
      ],
      "&ZeVnLIqe-": [
        {
          uid: 1,
          messageId: "<recovery-ampersand@example.test>",
          subject: "Literal ampersand fixture",
          body: "The modified UTF-7 escape must remain a literal folder name.",
        },
      ],
    },
    uidValidityOnRestart: 2,
    interruptMoveAfterCopy: true,
    interruptAppendAfterCommit: true,
  });
  fixtures.push({ name: "RECOVERY", fixture: recoveryFixture });
  const recoveryPorts = await recoveryFixture.start();
  environment.POSTAL_SNAP_BRIDGE_IMAP_RECOVERY = String(recoveryPorts.imap);
  environment.POSTAL_SNAP_BRIDGE_SMTP_RECOVERY = String(recoveryPorts.smtp);
  stage = "bridge-utf8-fixture-start";
  const utf8Fixture = await createCompatibilityFixture({
    certificatePath: certificate,
    keyPath: key,
    tlsMode: "tls",
    capabilities: ["IMAP4rev1", "UIDPLUS", "UTF8=ACCEPT"],
    rejectEnable: false,
    folderNames: ["INBOX", "Projects", "Projects/日本語", "&ZeVnLIqe-"],
    messages: {
      "Projects/日本語": [
        {
          uid: 1,
          messageId: "<utf8-project@example.test>",
          subject: "UTF8 fixture",
          body: "UTF8=ACCEPT fixture body",
        },
      ],
      "&ZeVnLIqe-": [
        {
          uid: 1,
          messageId: "<utf8-ampersand@example.test>",
          subject: "Literal ampersand fixture",
          body: "The modified UTF-7 escape must remain a literal folder name.",
        },
      ],
    },
  });
  fixtures.push({ name: "UTF8", fixture: utf8Fixture });
  const utf8Ports = await utf8Fixture.start();
  environment.POSTAL_SNAP_BRIDGE_IMAP_UTF8 = String(utf8Ports.imap);
  environment.POSTAL_SNAP_BRIDGE_SMTP_UTF8 = String(utf8Ports.smtp);
  stage = "bridge-protocol-integration";
  await protocolTest("bridge_tls_protocol_integration", environment);
  stage = "bridge-recovery-protocol-integration";
  await protocolTest("bridge_recovery_protocol_integration", environment);
  for (const { name, fixture } of fixtures) {
    const counters = fixture.results();
    if (name === "UTF8") {
      assert.ok(
        counters.authenticated > 0,
        "UTF8=ACCEPT fixture was not used.",
      );
      assert.equal(
        counters.utf8AcceptRequested,
        0,
        "The client must not enable UTF8=ACCEPT until its parser supports RFC 6855 responses.",
      );
      assert.equal(
        counters.utf8AcceptEnabled,
        0,
        "The client must use modified UTF-7 while UTF8=ACCEPT remains disabled.",
      );
      report.results.push({
        name: "bridge-utf8",
        status: "passed",
        counters,
      });
      continue;
    }
    if (name === "RECOVERY") {
      assert.equal(
        counters.restarts,
        1,
        "UIDVALIDITY reconnect fixture did not restart.",
      );
      assert.equal(
        counters.interruptedMoves,
        1,
        "ambiguous move fixture was not exercised.",
      );
      assert.equal(
        counters.interruptedAppends,
        1,
        "ambiguous draft fixture was not exercised.",
      );
      assert.equal(
        counters.copiedMessages,
        2,
        "move replay copied a duplicate.",
      );
      assert.equal(
        counters.appendedMessages,
        1,
        "draft replay appended a duplicate.",
      );
      report.results.push({
        name: "bridge-recovery",
        status: "passed",
        counters,
      });
      continue;
    }
    const positive = ["TLS", "STARTTLS"].includes(name);
    assert.equal(
      counters.messagesAccepted,
      positive ? 1 : 0,
      "Unexpected fixture delivery count.",
    );
    assert.equal(counters.restartFailed, false, "Fixture restart failed.");
    if (positive)
      assert.equal(
        counters.rejectedAuthentication,
        2,
        "Authentication rejection coverage missing.",
      );
    else
      assert.equal(
        counters.authenticated,
        0,
        "Credentials reached a rejected TLS endpoint.",
      );
    if (name === "STARTTLS")
      assert.equal(
        counters.restarts,
        1,
        "Controlled restart coverage missing.",
      );
    report.results.push({
      name: `bridge-${name.toLowerCase()}`,
      status: "passed",
      counters,
    });
  }
  report.results.push({
    name: "bridge-expired-certificate-import",
    status: "passed",
  });
  report.results.push({ name: "bridge-private-key-import", status: "passed" });
  report.results.push({
    name: "bridge-pool-capability-fallback",
    status: "passed",
  });
  report.results.push({
    name: "bridge-protocol-integration",
    status: "passed",
  });

  if (process.env.POSTAL_SNAP_COMPAT_FIXTURE_PROBE === "1") {
    stage = "compatibility-fixture-probe";
    report.commands.push({
      command: "probeCompatibilityFixture",
      args: ["<temporary>/server.pem", "<temporary>/server.key"],
    });
    report.results.push(
      ...(await probeCompatibilityFixture({
        certificatePath: certificate,
        keyPath: key,
      })),
    );
  }

  if (bridgeOnly) {
    report.results.push({
      name: "greenmail-protocol-integration",
      status: "skipped",
      reason: "Bridge-only mode excludes GreenMail.",
    });
    report.results.push({
      name: "greenmail-protocol-integration-history",
      status: "skipped",
      reason: "Bridge-only mode excludes GreenMail.",
    });
  } else {
    stage = "docker-prerequisite";
    await recordedRun("docker", ["compose", "version"]);
    stage = "greenmail-certificate-store";
    await recordedRun("openssl", [
      "pkcs12",
      "-export",
      "-in",
      certificate,
      "-inkey",
      key,
      "-out",
      store,
      "-name",
      "postal-snap-greenmail",
      "-passout",
      "pass:changeit",
    ]);
    await chmod(store, 0o644);
    stage = "greenmail-start";
    greenmailStarted = true;
    await recordedRun(
      "docker",
      ["compose", "-p", project, "-f", compose, "up", "-d"],
      { env: environment },
    );
    const certificateBytes = await readFile(certificate);
    await Promise.all([
      waitForPort(3465, certificateBytes),
      waitForPort(3993, certificateBytes),
    ]);
    stage = "greenmail-protocol-integration";
    await protocolTest("greenmail_protocol_integration", {
      ...environment,
      POSTAL_SNAP_MAIL_INTEGRATION: "1",
    });
    report.results.push({
      name: "greenmail-protocol-integration",
      status: "passed",
    });
    stage = "greenmail-protocol-integration-history";
    await protocolTest("greenmail_protocol_integration_history", {
      ...environment,
      POSTAL_SNAP_MAIL_INTEGRATION: "1",
    });
    report.results.push({
      name: "greenmail-protocol-integration-history",
      status: "passed",
    });
  }
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.results.push({
    name: stage,
    status: "failed",
    reason:
      "Command or fixture check failed; raw errors are excluded from this report.",
  });
  throw error;
} finally {
  // Preserve counters even when the native process fails midway.
  for (const { name, fixture } of fixtures) {
    if (
      !report.results.some(
        (result) => result.name === `bridge-${name.toLowerCase()}`,
      )
    ) {
      report.results.push({
        name: `bridge-${name.toLowerCase()}`,
        status: "incomplete",
        counters: fixture.results(),
      });
    }
    await fixture.stop().catch(() => {
      report.results.push({ name: "bridge-fixture-cleanup", status: "failed" });
      report.status = "failed";
      process.exitCode = 1;
    });
  }
  if (greenmailStarted)
    await recordedRun(
      "docker",
      ["compose", "-p", project, "-f", compose, "down", "--volumes"],
      { env: environment },
    ).catch(() => {
      report.results.push({ name: "greenmail-cleanup", status: "failed" });
      report.status = "failed";
      process.exitCode = 1;
    });
  if (temporary)
    await rm(temporary, { recursive: true, force: true }).catch(
      () => undefined,
    );
  report.finishedAt = new Date().toISOString();
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, "results.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}

async function waitForPort(port, ca) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await portIsReady(port, ca)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`GreenMail secure endpoint ${port} did not become ready.`);
}

function portIsReady(port, ca) {
  return new Promise((resolve) => {
    const socket = connect({
      host: "127.0.0.1",
      port,
      ca,
      servername: "localhost",
      rejectUnauthorized: true,
    });
    let greeting = "";
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(500);
    socket.on("data", (chunk) => {
      greeting += chunk.toString();
      if (greeting.length > 4096) return finish(false);
      if (greeting.includes("\r\n"))
        finish(
          port === 3993 ? /^\* OK\b/i.test(greeting) : /^220\b/.test(greeting),
        );
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
  });
}
